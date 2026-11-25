// ─── Gateway ─────────────────────────────────────────────────────────────────
// Porte d'entrée unique (nord-sud). Il proxifie /api/* vers le bon service et
// journalise chaque appel. Il ne détient AUCUNE donnée et ne contient aucune
// logique métier — c'est un simple routeur, volontairement transparent.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 8080;
const SVC = 'gateway';
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS || 5000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg) {
  console.log(`[${SVC}] ${msg}`);
}

// Table de routage : préfixe public → service cible. L'ordre compte (plus
// spécifique d'abord n'est pas nécessaire ici, les préfixes sont disjoints).
const TARGETS = {
  USERS: process.env.USERS_URL || 'http://users:3000',
  PRICING: process.env.PRICING_URL || 'http://pricing:3000',
  RIDE: process.env.RIDE_URL || 'http://ride:3000',
  PAYMENT: process.env.PAYMENT_URL || 'http://payment:3000',
};

const ROUTES = [
  { prefix: '/api/drivers', target: TARGETS.USERS },
  { prefix: '/api/passengers', target: TARGETS.USERS },
  { prefix: '/api/price', target: TARGETS.PRICING },
  { prefix: '/api/rides', target: TARGETS.RIDE },
  { prefix: '/api/payments', target: TARGETS.PAYMENT },
];

const app = express();

// Corps brut : on transmet les octets tels quels, sans interpréter le JSON.
app.use('/api', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const original = req.originalUrl; // inclut la query string
  const route = ROUTES.find((r) => original.startsWith(r.prefix));

  if (!route) {
    log(`${req.method} ${original} => 404 (aucune route)`);
    return res.status(404).json({ error: 'no_route', path: original });
  }

  // On retire le préfixe /api pour obtenir le chemin côté service.
  const downstreamPath = original.replace(/^\/api/, '');
  const targetUrl = route.target + downstreamPath;

  const hasBody = req.body && req.body.length > 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: hasBody
        ? { 'content-type': req.headers['content-type'] || 'application/json' }
        : undefined,
      body: hasBody ? req.body : undefined,
      signal: ctrl.signal,
    });

    log(`${req.method} ${original} -> ${targetUrl} (${upstream.status})`);

    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    res.status(upstream.status);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    if (err.name === 'AbortError') {
      log(`${req.method} ${original} -> ${targetUrl} TIMEOUT`);
      return res.status(504).json({ error: 'gateway_timeout', target: targetUrl });
    }
    log(`${req.method} ${original} -> ${targetUrl} ERREUR ${err.message}`);
    res.status(502).json({ error: 'bad_gateway', target: targetUrl, detail: err.message });
  } finally {
    clearTimeout(timer);
  }
});

app.get('/health', (_req, res) => res.json({ service: SVC, status: 'up' }));

// UI de déclenchement (étape 2). À l'étape 1, une page d'accueil minimale.
app.use('/', express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => log(`à l'écoute sur :${PORT}`));
