# Kidville Web

Gestionale scolastico completo (nido/infanzia/primaria) per la scuola Kidville:
tre aree applicative — **genitore** (`/parent`), **docente** (`/teacher`),
**direzione/segreteria** (`/admin`) — su Next.js (App Router) + Supabase
(Postgres, Auth, Storage), con login unico e smistamento per ruolo.

Funzionalità principali: anagrafiche e iscrizioni (wizard pubblico + import),
appello e presenze realtime, diario di sezione (pasti, umore, attività),
registro primaria (valutazioni, scrutini, pagelle, certificato competenze
D.M. 14/2024), modulistica con firma elettronica avanzata (FEA/OTP), pagamenti
e fatturazione elettronica, mensa, agenda condivisa, chat scuola-famiglia,
notifiche push, GDPR (diritto all'oblio), interoperabilità SIDI/Piattaforma
Unica.

## Comandi

```bash
npm run dev        # server di sviluppo (http://localhost:3000)
npm run gate       # tsc --noEmit + vitest run (gate di ogni step)
npm run lint       # eslint (il repo è a ZERO warning: eslint . --max-warnings 0)
npm run test       # vitest in watch
npm run e2e        # suite Playwright end-to-end, autosufficiente (vedi docs/e2e.md)
npm run build      # build di produzione
```

Prerequisiti: Node 20+, un progetto Supabase e le variabili in `.env.local`
(riferimento completo in [docs/env.md](docs/env.md)).

## Integrazioni esterne (gated)

Le integrazioni verso servizi terzi sono **gated**: senza credenziali l'app
degrada in modo pulito e visibile, mai con un crash.

| Integrazione | Senza credenziali | Con credenziali |
|---|---|---|
| **SIDI / Piattaforma Unica** (`SIDI_*`) | Le route di export/sync rispondono **503 con messaggio esplicito** e la UI mostra "Integrazione non configurata". L'egress reale resta comunque subordinato all'accreditamento ministeriale del gestore. | Client SIDI attivo (Fase A, frequentanti, PU, sync indicator). |
| **Aruba Fatturazione / SDI** (`ARUBA_*`) | Fatturazione in modalità **locale/simulata**: le fatture restano generabili e archiviabili, l'invio a SDI è saltato con motivo `credenziali_non_configurate`. | Invio reale a SDI via Aruba (P3.1). La verifica live è a carico del committente con le proprie credenziali. |
| **Resend (email)** (`RESEND_API_KEY`) | **Fallback console**: le email (credenziali, OTP, avvisi) sono loggate server-side; la UI segnala "Email non inviata: comunicare le credenziali manualmente." dove rilevante. | Invio email reale. |
| **Web Push (VAPID)** (`NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`) | `subscribe`/`vapid-public-key` rispondono 503; il dispatcher NON marca le notifiche come inviate (restano in coda). | Push reali agli iscritti. |
| **Claude (traduzione chat)** (`ANTHROPIC_API_KEY`) | Traduzione disabilitata. | Traduzione messaggi nella chat. |

## Struttura e documentazione

- `src/app/(dashboard)/{parent,teacher,admin}` — le tre aree (guardie di ruolo nei layout)
- `src/app/api/**` — ~190 route API con gate auth applicativi + validazione zod colocata
- `src/lib/**` — dominio (auth/scope, FEA, fatturazione, SIDI, push, presenze…)
- `supabase/migrations/**` — migrazioni SQL (si applicano via `scripts/apply_*.mjs`, RPC `exec_sql`)
- `e2e/**` — suite Playwright (31 test; seed idempotente su scuola dedicata)

Riferimenti: [docs/env.md](docs/env.md) (variabili d'ambiente) ·
[docs/e2e.md](docs/e2e.md) (suite E2E) ·
[docs/piano-app-100.md](docs/piano-app-100.md) (piano di completamento M0–M10) ·
[docs/lint-baseline.md](docs/lint-baseline.md) (storico lint fino allo zero) ·
[docs/perf-notes.md](docs/perf-notes.md) (decisioni perf M9) ·
[docs/acceptance.md](docs/acceptance.md) (checklist di accettazione finale).
