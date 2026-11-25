# RideNow — Architecture microservices (MGL7361, Projet 3)

Preuve de concept d'une plateforme de covoiturage minimaliste décomposée en
**microservices autonomes**, communiquant **uniquement par REST/JSON**, chacun
possédant **sa propre base** (aucune base partagée).

> **État : Étape 2 — complète.** Cycle de vie de bout en bout + paiement + UI React.

## Services

| Service   | Port hôte | Base          | Rôle |
|-----------|-----------|---------------|------|
| gateway   | **8080**  | —             | Porte d'entrée unique : sert l'UI React, proxifie `/api/*`, journalise chaque appel |
| users     | 3011      | `users.db`    | Passagers, chauffeurs, disponibilité |
| pricing   | 3012      | `pricing.db`  | Prix fixe par zones |
| ride      | 3013      | `rides.db`    | **Orchestrateur** du cycle de vie d'une course |
| payment   | 3014      | `payments.db` | Paiement simulé (authorize / capture) |

Chaque service possède un **volume nommé** distinct : la persistance est locale
et isolée. Les services ne lisent jamais la base d'un autre — seulement son API REST.

## Prérequis

Docker + Docker Compose. Rien d'autre (ni Node, ni base locale à installer ;
l'UI React est compilée dans l'image du gateway au `build`).

## Lancer

```bash
docker compose up --build
```

Puis ouvrir **http://localhost:8080**.

Pour repartir de bases fraîches :

```bash
docker compose down -v      # -v supprime les volumes (donc les données)
docker compose up --build
```

## Scénario nominal — via l'UI

Garde la fenêtre `docker compose up` visible : chaque saut inter-service s'affiche
dans les logs pendant que tu cliques.

1. **Demander une course** (passager `p1`, de `A` vers `B`) → la course apparaît
   en `ASSIGNED`, avec un chauffeur attribué et le prix calculé par `pricing`.
   Dans le panneau **Chauffeurs**, celui qui vient d'être pris passe « en course ».
2. **Accepter** → `ACCEPTED`, puis **Démarrer** → `STARTED`.
3. **Terminer (payer)** → `ride` orchestre `payment` (authorize + capture), libère
   le chauffeur, et la course passe `COMPLETED` avec un identifiant de paiement.

La cascade visible dans les logs `ride` :

```
[ride] POST /rides passenger=p1 from=A to=B
[ride]   → pricing /price?from=A&to=B => 1500
[ride]   → users /drivers?available=true => d1
[ride]   → users PATCH /drivers/d1/availability {available:false}
[ride]   ride r_xxxxxxxx ASSIGNED driver=d1 amount=1500
[ride] PATCH /rides/r_xxxxxxxx/status STARTED → COMPLETED
[ride]   → payment /authorize ride=r_xxxxxxxx amount=1500 => pay_xxxx AUTHORIZED
[ride]   → payment /capture pay_xxxx => CAPTURED
[ride]   → users PATCH /drivers/d1/availability {available:true} (libéré)
[ride]   ride r_xxxxxxxx COMPLETED payment=pay_xxxx
```

## Scénario nominal — via API REST (équivalent, sans UI)

```bash
# 1. Créer la course
curl -s -X POST http://localhost:8080/api/rides \
  -H "content-type: application/json" \
  -d '{"passengerId":"p1","from":"A","to":"B"}'

# 2. Faire avancer le statut (reprendre l'id retourné)
curl -s -X PATCH http://localhost:8080/api/rides/<id>/status -H "content-type: application/json" -d '{"status":"ACCEPTED"}'
curl -s -X PATCH http://localhost:8080/api/rides/<id>/status -H "content-type: application/json" -d '{"status":"STARTED"}'
curl -s -X PATCH http://localhost:8080/api/rides/<id>/status -H "content-type: application/json" -d '{"status":"COMPLETED"}'

# 3. Observer
curl -s http://localhost:8080/api/rides/<id>
curl -s http://localhost:8080/api/drivers?available=true
```

## Cas d'erreur (robustesse de base)

- Zones inconnues → **422** `unknown_zones`
- Plus aucun chauffeur disponible → **503** `no_driver_available`
- Transition illégale (ex. `ASSIGNED → COMPLETED`) → **409** `invalid_transition`
- Service aval muet au-delà du délai → **504** `upstream_timeout` (timeout 3 s + 1 retry sur `pricing`/`payment`)

## Contrats d'API (résumé)

| Service | Endpoint | Entrée → Sortie |
|---------|----------|-----------------|
| users   | `GET /drivers?available=true` | → liste de chauffeurs |
| users   | `PATCH /drivers/{id}/availability` | `{available}` → chauffeur |
| pricing | `GET /price?from=A&to=B` | → `{amount}` (cents) |
| ride    | `POST /rides` | `{passengerId, from, to}` → course `ASSIGNED` |
| ride    | `GET /rides/{id}` | → course |
| ride    | `PATCH /rides/{id}/status` | `{status}` → course |
| payment | `POST /payments/authorize` | `{rideId, amount}` → `{paymentId, AUTHORIZED}` |
| payment | `POST /payments/capture` | `{paymentId}` → `{CAPTURED}` |

## Machine à états de la course

```
ASSIGNED → ACCEPTED → STARTED → COMPLETED
    └──────────┴──────────┴────→ CANCELLED   (libère le chauffeur = compensation)
```
