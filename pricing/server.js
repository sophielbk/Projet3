// ─── Service Pricing ─────────────────────────────────────────────────────────
// Responsabilité unique : donner le prix fixe d'un trajet (zone_départ → zone_arrivée).
// Possède sa base (pricing.db) : une grille tarifaire par paire de zones.

import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const PORT = process.env.PORT || 3000;
const SVC = 'pricing';
const CURRENCY = 'CAD';

function log(msg) {
  console.log(`[${SVC}] ${msg}`);
}

// ─── Base locale ─────────────────────────────────────────────────────────────
fs.mkdirSync('/app/data', { recursive: true });
const db = new Database('/app/data/pricing.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS zone_prices (
    from_zone TEXT NOT NULL,
    to_zone   TEXT NOT NULL,
    amount    INTEGER NOT NULL,          -- en cents
    PRIMARY KEY (from_zone, to_zone)
  );
`);

// Seed : grille complète pour les zones A, B, C, D (tous les couples ordonnés),
// pour qu'un trajet entre deux zones connues résolve toujours.
// Prix = 800 cents (même zone) sinon 1000 + 500 * distance entre les zones.
const seeded = db.prepare('SELECT COUNT(*) AS c FROM zone_prices').get().c;
if (seeded === 0) {
  const zones = ['A', 'B', 'C', 'D'];
  const stmt = db.prepare(
    'INSERT INTO zone_prices (from_zone, to_zone, amount) VALUES (?, ?, ?)'
  );
  const tx = db.transaction(() => {
    zones.forEach((from, i) =>
      zones.forEach((to, j) => {
        const amount = i === j ? 800 : 1000 + 500 * Math.abs(i - j);
        stmt.run(from, to, amount);
      })
    );
  });
  tx();
  log(`seed zone_prices: ${zones.length * zones.length} couples`);
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ service: SVC, status: 'up' }));

// GET /price?from=A&to=B  →  { from, to, amount, currency }
app.get('/price', (req, res) => {
  const from = String(req.query.from ?? '').toUpperCase();
  const to = String(req.query.to ?? '').toUpperCase();

  if (!from || !to) {
    return res.status(400).json({ error: 'from_and_to_required' });
  }

  const row = db
    .prepare('SELECT amount FROM zone_prices WHERE from_zone = ? AND to_zone = ?')
    .get(from, to);

  if (!row) {
    // Zone inconnue ou couple non tarifé → entité non traitable.
    log(`GET /price?from=${from}&to=${to} => 422 (zones inconnues)`);
    return res.status(422).json({ error: 'unknown_zones', from, to });
  }

  log(`GET /price?from=${from}&to=${to} => ${row.amount} ${CURRENCY}cents`);
  res.json({ from, to, amount: row.amount, currency: CURRENCY });
});

app.listen(PORT, () => log(`à l'écoute sur :${PORT}`));
