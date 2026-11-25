// ─── Service Users (Identity) ────────────────────────────────────────────────
// Responsabilité unique : passagers, chauffeurs et leur disponibilité.
// Possède sa base (users.db) ; aucun autre service n'y accède directement.

import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const PORT = process.env.PORT || 3000;
const SVC = 'users';

// ─── Base locale ─────────────────────────────────────────────────────────────
fs.mkdirSync('/app/data', { recursive: true });
const db = new Database('/app/data/users.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS passengers (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drivers (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 1   -- 0 / 1
  );
`);

// Seed idempotent : on ne peuple que si la table est vide.
const seedIfEmpty = (table, rows, insertSql) => {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  if (n === 0) {
    const stmt = db.prepare(insertSql);
    const tx = db.transaction((items) => items.forEach((r) => stmt.run(r)));
    tx(rows);
    log(`seed ${table}: ${rows.length} lignes`);
  }
};

seedIfEmpty(
  'passengers',
  [
    { id: 'p1', name: 'Passager Alice' },
    { id: 'p2', name: 'Passager Bob' },
  ],
  'INSERT INTO passengers (id, name) VALUES (@id, @name)'
);

seedIfEmpty(
  'drivers',
  [
    { id: 'd1', name: 'Chauffeur Chantal', available: 1 },
    { id: 'd2', name: 'Chauffeur Denis', available: 1 },
    { id: 'd3', name: 'Chauffeur Fatima', available: 1 },
  ],
  'INSERT INTO drivers (id, name, available) VALUES (@id, @name, @available)'
);

// ─── Journalisation simple et lisible ────────────────────────────────────────
function log(msg) {
  console.log(`[${SVC}] ${msg}`);
}

const app = express();
app.use(express.json());

const toDriver = (row) =>
  row && { id: row.id, name: row.name, available: !!row.available };

// Santé (utilisée par les autres services / le gateway).
app.get('/health', (_req, res) => res.json({ service: SVC, status: 'up' }));

// Liste des chauffeurs, filtrable par disponibilité : /drivers?available=true
app.get('/drivers', (req, res) => {
  const { available } = req.query;
  let rows;
  if (available === 'true') {
    rows = db.prepare('SELECT * FROM drivers WHERE available = 1').all();
  } else if (available === 'false') {
    rows = db.prepare('SELECT * FROM drivers WHERE available = 0').all();
  } else {
    rows = db.prepare('SELECT * FROM drivers').all();
  }
  log(`GET /drivers?available=${available ?? ''} => ${rows.length} chauffeur(s)`);
  res.json(rows.map(toDriver));
});

app.get('/drivers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'driver_not_found', id: req.params.id });
  res.json(toDriver(row));
});

// Met à jour la disponibilité d'un chauffeur : PATCH /drivers/:id/availability
// body : { "available": true | false }
app.patch('/drivers/:id/availability', (req, res) => {
  const { available } = req.body ?? {};
  if (typeof available !== 'boolean') {
    return res.status(400).json({ error: 'available_must_be_boolean' });
  }
  const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'driver_not_found', id: req.params.id });

  db.prepare('UPDATE drivers SET available = ? WHERE id = ?').run(available ? 1 : 0, req.params.id);
  log(`PATCH /drivers/${req.params.id}/availability => available=${available}`);
  res.json(toDriver({ ...row, available: available ? 1 : 0 }));
});

app.get('/passengers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM passengers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'passenger_not_found', id: req.params.id });
  res.json(row);
});

app.listen(PORT, () => log(`à l'écoute sur :${PORT}`));
