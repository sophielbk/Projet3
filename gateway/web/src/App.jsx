import { useEffect, useState } from 'react';

const ZONES = ['A', 'B', 'C', 'D'];
const PASSENGERS = ['p1', 'p2'];

// Transitions proposées à l'utilisateur selon l'état courant de la course.
const ACTIONS = {
  ASSIGNED: [
    { label: 'Accepter', status: 'ACCEPTED' },
    { label: 'Annuler', status: 'CANCELLED', ghost: true },
  ],
  ACCEPTED: [
    { label: 'Démarrer', status: 'STARTED' },
    { label: 'Annuler', status: 'CANCELLED', ghost: true },
  ],
  STARTED: [
    { label: 'Terminer (payer)', status: 'COMPLETED' },
    { label: 'Annuler', status: 'CANCELLED', ghost: true },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

const TERMINAL = new Set(['COMPLETED', 'CANCELLED']);
const money = (cents) => (cents == null ? '—' : `${(cents / 100).toFixed(2)} $`);

// Messages d'erreur lisibles (le back renvoie des codes ; on les traduit ici).
const ERR_FR = {
  passenger_has_active_ride: 'Ce passager a déjà une course en cours — terminez-la d’abord.',
  no_driver_available: 'Aucun chauffeur disponible pour le moment.',
  unknown_zones: 'Trajet non tarifé (zones inconnues).',
  invalid_transition: 'Action non autorisée dans cet état.',
};
const frErr = (e) => ERR_FR[e?.data?.error] || e?.data?.error || e?.message || 'Erreur inconnue';

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Réponse non-JSON : presque toujours le signe qu'on ne parle pas au gateway
    // (mauvais port, une autre app répond, cache navigateur sur l'ancienne URL…).
    throw new Error(`réponse non-JSON depuis /api${path} — le gateway répond-il bien sur ce port ?`);
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { data });
  return data;
}

export default function App() {
  const [passenger, setPassenger] = useState('p1');
  const [from, setFrom] = useState('A');
  const [to, setTo] = useState('B');
  const [rides, setRides] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // On recharge toujours l'état réel depuis les services (source de vérité).
  const refresh = async () => {
    try {
      const [r, d] = await Promise.all([api('GET', '/rides'), api('GET', '/drivers')]);
      setRides(r);
      setDrivers(d);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const createRide = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/rides', { passengerId: passenger, from, to });
    } catch (e) {
      setError(frErr(e));
    } finally {
      await refresh(); // la liste et les chauffeurs reflètent toujours la réalité
      setBusy(false);
    }
  };

  const advance = async (id, status) => {
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/rides/${id}/status`, { status });
    } catch (e) {
      setError(frErr(e));
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const active = rides.filter((r) => !TERMINAL.has(r.status));
  const done = rides.filter((r) => TERMINAL.has(r.status));

  return (
    <div className="wrap">
      <header>
        <h1>RideNow</h1>
        <span className="tag">Architecture microservices · MGL7361 — Projet 3</span>
      </header>

      <div className="grid">
        {/* ─── Demande de course ─── */}
        <section className="card">
          <h2>Demander une course</h2>
          <div className="row">
            <label>
              Passager
              <select value={passenger} onChange={(e) => setPassenger(e.target.value)}>
                {PASSENGERS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              De
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </label>
            <label>
              Vers
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary" onClick={createRide} disabled={busy}>
            {busy ? '…' : 'Demander une course'}
          </button>
          {error && <p className="error">⚠ {error}</p>}
        </section>

        {/* ─── Chauffeurs (effet observable) ─── */}
        <section className="card">
          <h2>Chauffeurs</h2>
          <ul className="drivers">
            {drivers.map((d) => (
              <li key={d.id}>
                <span className={`dot ${d.available ? 'on' : 'off'}`} />
                {d.id} · {d.name}
                <span className="muted">{d.available ? 'disponible' : 'en course'}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ─── Courses actives (plusieurs en parallèle) ─── */}
      <h2 className="section-title">Courses en cours ({active.length})</h2>
      {active.length === 0 && <p className="muted">Aucune course active.</p>}
      {active.map((ride) => (
        <RideCard key={ride.id} ride={ride} busy={busy} onAdvance={advance} />
      ))}

      {/* ─── Historique (terminées / annulées) ─── */}
      {done.length > 0 && (
        <>
          <h2 className="section-title">Historique ({done.length})</h2>
          {done.map((ride) => (
            <RideCard key={ride.id} ride={ride} busy={busy} onAdvance={advance} />
          ))}
        </>
      )}
    </div>
  );
}

function RideCard({ ride, busy, onAdvance }) {
  return (
    <section className="card ride">
      <div className="ride-head">
        <h2>
          Course {ride.id} <span className="muted">· passager {ride.passengerId}</span>
        </h2>
        <span className={`badge ${ride.status}`}>{ride.status}</span>
      </div>
      <dl>
        <div>
          <dt>Trajet</dt>
          <dd>
            {ride.from} → {ride.to}
          </dd>
        </div>
        <div>
          <dt>Chauffeur</dt>
          <dd>{ride.driverId || '—'}</dd>
        </div>
        <div>
          <dt>Prix</dt>
          <dd>{money(ride.amount)}</dd>
        </div>
        <div>
          <dt>Paiement</dt>
          <dd>{ride.paymentId || '—'}</dd>
        </div>
      </dl>
      <div className="actions">
        {(ACTIONS[ride.status] || []).map((a) => (
          <button
            key={a.status}
            className={a.ghost ? 'ghost' : 'primary'}
            onClick={() => onAdvance(ride.id, a.status)}
            disabled={busy}
          >
            {a.label}
          </button>
        ))}
        {ride.status === 'COMPLETED' && <span className="done">✓ Terminée et encaissée</span>}
        {ride.status === 'CANCELLED' && <span className="muted">Annulée · chauffeur libéré</span>}
      </div>
    </section>
  );
}
