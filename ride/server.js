// ─── Service Ride (orchestrateur) ────────────────────────────────────────────
// Responsabilité : le cycle de vie d'une course. C'est l'ORCHESTRATEUR de la saga
// RideNow : il coordonne les autres services par REST, il ne lit jamais leurs bases.
// Possède sa base (rides.db).
//
// Cycle de vie : ASSIGNED → ACCEPTED → STARTED → COMPLETED
//                (CANCELLED possible depuis tout état non terminal)
// À COMPLETED, ride orchestre le paiement (authorize + capture) et libère le chauffeur.

import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const PORT = process.env.PORT || 3000;
const SVC = 'ride';
const PRICING_URL = process.env.PRICING_URL || 'http://pricing:3000';
const USERS_URL = process.env.USERS_URL || 'http://users:3000';
const PAYMENT_URL = process.env.PAYMENT_URL || 'http://payment:3000';
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(msg) {
  console.log(`[${SVC}] ${msg}`);
}

// ─── Appel inter-service avec timeout ────────────────────────────────────────
// Robustesse : on ne reste jamais bloqué indéfiniment sur un service aval.
async function callJson(method, url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('upstream_timeout');
      e.cause = { url, timeoutMs: CALL_TIMEOUT_MS };
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Variante avec 1 retry sur défaillance transitoire (timeout ou 5xx).
// Utilisée pour pricing et payment : un hoquet passager ne doit pas tuer la saga.
async function callJsonRetry(method, url, body, { retries = 1, backoffMs = 300 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await callJson(method, url, body);
      if (r.status >= 500 && attempt < retries) {
        log(`  retry (${attempt + 1}/${retries}) sur ${url} — reçu ${r.status}`);
        await sleep(backoffMs);
        continue;
      }
      return r;
    } catch (err) {
      last = err;
      if (attempt < retries) {
        log(`  retry (${attempt + 1}/${retries}) sur ${url} — ${err.message}`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  throw last;
}

// ─── Base locale ─────────────────────────────────────────────────────────────
fs.mkdirSync('/app/data', { recursive: true });
const db = new Database('/app/data/rides.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rides (
    id           TEXT PRIMARY KEY,
    passenger_id TEXT NOT NULL,
    driver_id    TEXT,
    from_zone    TEXT NOT NULL,
    to_zone      TEXT NOT NULL,
    amount       INTEGER,
    status       TEXT NOT NULL,          -- ASSIGNED | ACCEPTED | STARTED | COMPLETED | CANCELLED
    payment_id   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
`);

// Transitions autorisées : la machine à états de la course.
const NEXT = {
  ASSIGNED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['STARTED', 'CANCELLED'],
  STARTED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const toRide = (row) =>
  row && {
    id: row.id,
    passengerId: row.passenger_id,
    driverId: row.driver_id,
    from: row.from_zone,
    to: row.to_zone,
    amount: row.amount,
    status: row.status,
    paymentId: row.payment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const getRide = (id) => db.prepare('SELECT * FROM rides WHERE id = ?').get(id);
const touch = (id, fields) => {
  const sets = Object.keys(fields)
    .map((k) => `${k} = @${k}`)
    .join(', ');
  db.prepare(`UPDATE rides SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...fields,
    id,
    updated_at: new Date().toISOString(),
  });
};

// Libère un chauffeur (action de compensation). Best-effort : on logue mais on
// ne fait pas échouer la course si la libération rate.
async function releaseDriver(driverId) {
  if (!driverId) return;
  try {
    await callJson('PATCH', `${USERS_URL}/drivers/${driverId}/availability`, { available: true });
    log(`  → users PATCH /drivers/${driverId}/availability {available:true} (libéré)`);
  } catch (err) {
    log(`  ⚠ libération du chauffeur ${driverId} échouée : ${err.message}`);
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ service: SVC, status: 'up' }));

// ─── POST /rides ─────────────────────────────────────────────────────────────
// Stimulus principal. Body : { passengerId, from, to }
// Orchestration : pricing (prix) → users (chauffeur dispo) → users (réserve) → INSERT.
app.post('/rides', async (req, res) => {
  const { passengerId, from, to } = req.body ?? {};
  if (!passengerId || !from || !to) {
    return res.status(400).json({ error: 'passengerId_from_to_required' });
  }
  log(`POST /rides passenger=${passengerId} from=${from} to=${to}`);

  // Invariant métier : un passager ne peut avoir qu'UNE course active à la fois.
  // Le service ride possède les courses, c'est donc lui qui garde cette règle.
  const actives = db
    .prepare(
      "SELECT COUNT(*) AS c FROM rides WHERE passenger_id = ? AND status NOT IN ('COMPLETED','CANCELLED')"
    )
    .get(passengerId).c;
  if (actives > 0) {
    log(`  refus : ${passengerId} a déjà une course active`);
    return res.status(409).json({ error: 'passenger_has_active_ride', passengerId });
  }

  try {
    const price = await callJsonRetry('GET', `${PRICING_URL}/price?from=${from}&to=${to}`);
    if (price.status === 422) return res.status(422).json({ error: 'unknown_zones', from, to });
    if (!price.ok) return res.status(502).json({ error: 'pricing_unavailable', detail: price.body });
    const amount = price.body.amount;
    log(`  → pricing /price?from=${from}&to=${to} => ${amount}`);

    const drivers = await callJson('GET', `${USERS_URL}/drivers?available=true`);
    if (!drivers.ok) return res.status(502).json({ error: 'users_unavailable', detail: drivers.body });
    if (!Array.isArray(drivers.body) || drivers.body.length === 0) {
      log('  → users: aucun chauffeur disponible');
      return res.status(503).json({ error: 'no_driver_available' });
    }
    const driver = drivers.body[0];
    log(`  → users /drivers?available=true => ${driver.id}`);

    const reserve = await callJson('PATCH', `${USERS_URL}/drivers/${driver.id}/availability`, {
      available: false,
    });
    if (!reserve.ok) return res.status(502).json({ error: 'driver_reservation_failed', detail: reserve.body });
    log(`  → users PATCH /drivers/${driver.id}/availability {available:false}`);

    const now = new Date().toISOString();
    const id = `r_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO rides (id, passenger_id, driver_id, from_zone, to_zone, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ASSIGNED', ?, ?)`
    ).run(id, passengerId, driver.id, from, to, amount, now, now);

    log(`  ride ${id} ASSIGNED driver=${driver.id} amount=${amount}`);
    res.status(201).json(toRide(getRide(id)));
  } catch (err) {
    if (err.message === 'upstream_timeout') {
      log(`  → timeout sur ${err.cause?.url}`);
      return res.status(504).json({ error: 'upstream_timeout', detail: err.cause });
    }
    log(`  → erreur orchestration : ${err.message}`);
    res.status(500).json({ error: 'orchestration_error', detail: err.message });
  }
});

// Liste de toutes les courses (plus récentes d'abord) — permet à l'UI de
// retrouver les courses en cours, y compris après un rafraîchissement.
app.get('/rides', (_req, res) => {
  const rows = db.prepare('SELECT * FROM rides ORDER BY created_at DESC').all();
  res.json(rows.map(toRide));
});

app.get('/rides/:id', (req, res) => {
  const row = getRide(req.params.id);
  if (!row) return res.status(404).json({ error: 'ride_not_found', id: req.params.id });
  res.json(toRide(row));
});

// ─── PATCH /rides/:id/status ─────────────────────────────────────────────────
// Body : { status: 'ACCEPTED' | 'STARTED' | 'COMPLETED' | 'CANCELLED' }
// Valide la transition. COMPLETED déclenche le paiement + libère le chauffeur.
app.patch('/rides/:id/status', async (req, res) => {
  const row = getRide(req.params.id);
  if (!row) return res.status(404).json({ error: 'ride_not_found', id: req.params.id });

  const target = String(req.body?.status ?? '').toUpperCase();
  const allowed = NEXT[row.status] ?? [];
  if (!allowed.includes(target)) {
    return res.status(409).json({
      error: 'invalid_transition',
      from: row.status,
      to: target,
      allowed,
    });
  }

  log(`PATCH /rides/${row.id}/status ${row.status} → ${target}`);

  try {
    if (target === 'COMPLETED') {
      // Orchestration du paiement en deux temps.
      const auth = await callJsonRetry('POST', `${PAYMENT_URL}/payments/authorize`, {
        rideId: row.id,
        amount: row.amount,
      });
      if (!auth.ok) return res.status(502).json({ error: 'payment_authorize_failed', detail: auth.body });
      log(`  → payment /authorize ride=${row.id} amount=${row.amount} => ${auth.body.paymentId} AUTHORIZED`);

      const cap = await callJsonRetry('POST', `${PAYMENT_URL}/payments/capture`, {
        paymentId: auth.body.paymentId,
      });
      if (!cap.ok) return res.status(502).json({ error: 'payment_capture_failed', detail: cap.body });
      log(`  → payment /capture ${auth.body.paymentId} => CAPTURED`);

      await releaseDriver(row.driver_id);
      touch(row.id, { status: 'COMPLETED', payment_id: auth.body.paymentId });
      log(`  ride ${row.id} COMPLETED payment=${auth.body.paymentId}`);
    } else if (target === 'CANCELLED') {
      await releaseDriver(row.driver_id); // compensation
      touch(row.id, { status: 'CANCELLED' });
      log(`  ride ${row.id} CANCELLED`);
    } else {
      // ACCEPTED / STARTED : simple transition d'état.
      touch(row.id, { status: target });
      log(`  ride ${row.id} ${target}`);
    }
    res.json(toRide(getRide(row.id)));
  } catch (err) {
    if (err.message === 'upstream_timeout') {
      return res.status(504).json({ error: 'upstream_timeout', detail: err.cause });
    }
    log(`  → erreur transition : ${err.message}`);
    res.status(500).json({ error: 'transition_error', detail: err.message });
  }
});

app.listen(PORT, () => log(`à l'écoute sur :${PORT}`));
