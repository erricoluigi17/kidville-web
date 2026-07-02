# Audit `x-cron-secret` — route service-to-service (M1.9)

Ricognizione delle chiamate cron→API nel DB (grep `pg_net|pg_cron|cron.schedule` nelle
migrazioni) e verifica che ogni endpoint bersaglio validi l'header `x-cron-secret`
contro `CRON_SECRET`.

## Chiamanti (pg_cron + pg_net nelle migrazioni)

| Migrazione | Setting URL | Endpoint bersaglio | Header inviato |
|---|---|---|---|
| `20260606_pagamenti_automations.sql` (+`20260606b` schedule) | `app.push_dispatch_url` | `POST /api/push/dispatch` | `x-cron-secret` ✔ |
| `20260733_notifiche_dispatch_function.sql` (+`20260733b` schedule) | `app.push_dispatch_url` | `POST /api/push/dispatch` | `x-cron-secret` ✔ |
| `20260611b_mensa_cron.sql` | `app.mensa_allergie_url` | `POST /api/mensa/allergie-check` | `x-cron-secret` ✔ |
| `20260741_aruba_fatturazione.sql` | `app.fattura_sync_url` | `POST /api/pagamenti/fattura/sync` | `x-cron-secret` ✔ |

(`20260503_registro_primaria_schema.sql` cita pg_cron solo in un commento: nessuna chiamata.)

## Endpoint bersaglio — verifica gate

| Route | Gate | Esito |
|---|---|---|
| `POST /api/push/dispatch` | `x-cron-secret === CRON_SECRET`, altrimenti 401 | ✔ già presente |
| `POST /api/pagamenti/fattura/sync` | idem (pattern push/dispatch) | ✔ già presente |
| `POST /api/mensa/allergie-check` | secret valido OPPURE `requireStaff` (invocazione manuale) | ✔ già presente |

**Nessuna route service-to-service scoperta.** Regression-lock in
`__tests__/api/cron-secret.test.ts` (401 senza header / secret errato per tutte e tre;
per allergie-check un secret errato non bypassa il gate staff).

Nota: con `CRON_SECRET` non configurato, il confronto `secret !== process.env.CRON_SECRET`
fallisce per qualunque header → gli endpoint restano chiusi (fail-closed).
