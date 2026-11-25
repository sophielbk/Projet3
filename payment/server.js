// ─── Service Payment (mock) ──────────────────────────────────────────────────
// Responsabilité unique : simuler l'encaissement d'une course en deux temps
// (autorisation puis capture), comme une vraie passerelle de paiement.
// Possède sa base (payments.db).
//
// NOTE étape 1 : ce service est complet et testable seul (curl). Le service
// `ride` ne l'appellera qu'à l'étape 2, à la fin de la course (COMPLETED).

import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const PORT = process.env.PORT || 3000;
const SVC = 'payment';

function log(msg) {
  console.log(`[${SVC}] ${msg}`);
}

// ─── Base locale ─────────────────────────────────────────────────────────────
fs.mkdirSync('/app/data', { recursive: true });
const db = new Database('/app/data/payments.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id         TEXT PRIMARY KEY,
    ride_id    TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    status     TEXT NOT NULL,            -- AUTHORIZED | CAPTURED
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ service: SVC, status: 'up' }));

const toPayment = (row) =>
  row && {
    paymentId: row.id,
    rideId: row.ride_id,
    amount: row.amount,
    status: row.status,
  };

// POST /payments/authorize  { rideId, amount }  →  { paymentId, status: AUTHORIZED }
app.post('/payments/authorize', (req, res) => {
  const { rideId, amount } = req.body ?? {};
  if (!rideId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'rideId_and_numeric_amount_required' });
  }
  const now = new Date().toISOString();
  const id = `pay_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO payments (id, ride_id, amount, status, created_at, updated_at)
     VALUES (?, ?, ?, 'AUTHORIZED', ?, ?)`
  ).run(id, rideId, amount, now, now);

  log(`POST /payments/authorize ride=${rideId} amount=${amount} => ${id} AUTHORIZED`);
  res.status(201).json(toPayment(db.prepare('SELECT * FROM payments WHERE id = ?').get(id)));
});

// POST /payments/capture  { paymentId }  →  { paymentId, status: CAPTURED }
app.post('/payments/capture', (req, res) => {
  const { paymentId } = req.body ?? {};
  if (!paymentId) return res.status(400).json({ error: 'paymentId_required' });

  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!row) return res.status(404).json({ error: 'payment_not_found', paymentId });
  if (row.status === 'CAPTURED') {
    return res.json(toPayment(row)); // idempotent : déjà capturé
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE payments SET status = 'CAPTURED', updated_at = ? WHERE id = ?").run(now, paymentId);
  log(`POST /payments/capture ${paymentId} => CAPTURED`);
  res.json(toPayment(db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId)));
});

app.get('/payments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'payment_not_found', id: req.params.id });
  res.json(toPayment(row));
});

app.listen(PORT, () => log(`à l'écoute sur :${PORT}`));
