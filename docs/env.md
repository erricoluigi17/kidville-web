# Variabili d'ambiente — Kidville Web

Riferimento completo delle variabili lette dal codice (`process.env.*`).
File locale: `.env.local` (gitignorato — `.env*` in `.gitignore`). In
produzione vanno impostate nell'ambiente di hosting.

Le variabili `NEXT_PUBLIC_*` sono esposte al client (bundle browser): mai
metterci segreti.

## Core — Supabase (obbligatorie)

| Variabile | Dove | Descrizione |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client+server | URL del progetto Supabase. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client+server | Chiave anon (RLS attiva); usata dal browser-client e dal middleware per la sessione. |
| `SUPABASE_SERVICE_ROLE_KEY` | solo server | Chiave service-role per `createAdminClient()` (l'enforcement è applicativo nei gate). **Segreto.** |

## Identità e sicurezza (M1/M4)

| Variabile | Default | Descrizione |
|---|---|---|
| `ALLOW_HEADER_IDENTITY` | assente = `true` | **Sigillo M4.** A `false` l'identità è SOLO da sessione Supabase (cookie): l'header `x-user-id` / query `?userId=` senza sessione → 401. Il valore diverso da sessione è comunque sempre ignorato (anti-spoof). Impostare `false` (fatto in M4.6); il default permissivo esiste solo per retro-compatibilità di rollout P0. |
| `PARENT_READS_USE_SESSION` | assente | Flag di rollout P0 (S8/S9) per le letture genitore via sessione/RLS. |
| `OTP_TICKET_SECRET` | derivato in dev | Segreto HMAC per i ticket OTP (FES stateless). Dal 2026-08-01 firma anche i **sigilli di rimozione degli allegati** (`src/lib/allegati/sigillo.ts`): la prova che il file da togliere dal bucket è quello appena caricato da chi lo chiede. Ripiega su `SUPABASE_SERVICE_ROLE_KEY`; se mancano entrambe, la rimozione dell'allegato di una bozza abbandonata non si offre affatto (fail-closed, riga `config`/`error`) e i file abbandonati tornano ad accumularsi in silenzio. In produzione impostarlo esplicitamente. **Segreto.** |
| `CRON_SECRET` | — | Bearer condiviso per gli endpoint service-to-service (es. `/api/push/dispatch` dal cron). **Segreto.** |
| `NODE_ENV` | gestita da Next | In `production` attiva `sealDangerous` sugli endpoint di debug/seed. |

## Osservabilità / log

| Variabile | Dove | Descrizione |
|---|---|---|
| `LOG_HASH_SALT` | solo server | **Salt della pseudonimizzazione nei log.** `hashCorrelabile()` (`src/lib/logging/redact.ts`) trasforma nome, cognome, e-mail e codice fiscale in un `#xxxxxxxx` stabile: serve a dire «è sempre lo stesso genitore» senza dire chi. **Assente → fail-closed**: nessun hash debole, ogni identità esce come `[redatto]` e la correlazione fra le righe della stessa persona è persa (la privacy resta salva, la diagnostica no). Non si genera a runtime — un salt casuale per processo spezzerebbe la correlazione fra invocazioni diverse — e non si cambia senza motivo: cambiandolo, le righe già scritte diventano non correlabili con quelle nuove. Stesso valore su tutti gli ambienti dello stesso deploy; si genera con `openssl rand -hex 32`. È fra le variabili del **preflight critico** (`src/instrumentation.ts`): se manca, ogni cold start scrive in `app_log` una riga `evento=config`, `codice=config_mancante`, livello `error` in produzione. **Segreto.** |
| `KV_LOG_LEVEL` | solo server | A `silent` spegne il logger su **entrambi** i canali: riga su console e persistenza su `app_log` (`SILENZIOSO` in `src/lib/logging/logger.ts`). Serve agli script e alle esecuzioni non interattive — `.env.local` punta al DB di **produzione**, e un'esecuzione di servizio non deve lasciarci righe di log. Sotto `vitest` il silenzio è già automatico (variabile `VITEST`). Assente → i log si scrivono normalmente. |

`LOG_HASH_SALT` **su Vercel c'è**, in tutti e tre gli ambienti (Development, Preview,
Production): verificato il 2026-08-01 con `vercel env ls`, che elenca solo i nomi, e confermato
dai dati — le righe di `app_log` scritte da un deploy (cioè con `app_versione` valorizzata)
riportano `config … esito=ok`, e in produzione nomi ed e-mail escono come `#xxxxxxxx`. Sulla
macchina di **sviluppo** invece di norma manca, ed è il motivo per cui in locale si legge
`[redatto]` dove in produzione c'è un hash: chi confronta i due ambienti se lo ricordi.
Attenzione a un falso allarme già capitato (collaudo del 2026-07-31): le righe
`error … variabile d'ambiente critica mancante: LOG_HASH_SALT` con `ambiente=production` e
**`app_versione` nullo** non vengono da un deploy, ma da un `next build` su una macchina di
sviluppo, quando l'ambiente si deduceva da `VERCEL_ENV ?? NODE_ENV` (corretto in
`src/lib/logging/ambiente.ts`: ora una macchina di sviluppo si dichiara `locale`).

## Email / OTP

| Variabile | Descrizione |
|---|---|
| `RESEND_API_KEY` | API key Resend per l'invio email reale; assente → fallback console (dev). **Segreto.** |
| `OTP_FROM_EMAIL` | Mittente delle email OTP (default dev). |

## Push (VAPID)

| Variabile | Descrizione |
|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Chiave pubblica VAPID (client, subscribe). |
| `VAPID_PRIVATE_KEY` | Chiave privata VAPID (server, invio). **Segreto.** |
| `VAPID_SUBJECT` | Subject VAPID (es. `mailto:info@kidville.it`). |

## App native / Push nativa (Capacitor, M10 — vedi `docs/mobile.md`)

| Variabile | Dove | Descrizione |
|---|---|---|
| `CAP_SERVER_URL` | build Capacitor | URL che la WebView nativa carica (`server.url`). Dev: `http://<ip-locale>:3000`; store: URL HTTPS pubblico del deploy. Assente → la shell usa il fallback locale `mobile/www`. |
| `FCM_PROJECT_ID` | solo server | Project id Firebase per l'invio push nativa (FCM HTTP v1). Assente → `sendNativePush` degrada con `fcm_non_configurato`. **Segreto/gated.** |
| `FCM_CLIENT_EMAIL` | solo server | Email del service-account Firebase. **Segreto/gated.** |
| `FCM_PRIVATE_KEY` | solo server | Chiave privata del service-account (PEM; `\n` accettati). **Segreto/gated.** |

APNs (iOS) è configurato dentro Firebase (APNs Auth Key nella console): l'invio
a iOS passa da FCM, quindi lato server bastano le `FCM_*`.

## Integrazioni esterne (gated: assenti → degrado pulito, mai crash)

| Variabile | Descrizione |
|---|---|
| `ARUBA_USERNAME` / `ARUBA_PASSWORD` | Credenziali Aruba Fatturazione (SDI, P3.1). Assenti → fatturazione in modalità locale/simulata. **Segreti.** |
| `SIDI_USERNAME` / `SIDI_PASSWORD` / `SIDI_CODICE_MECCANOGRAFICO` | Credenziali SIDI/Piattaforma Unica (P5). Assenti → export/sync disattivati con messaggio esplicito. **Segreti.** |
| `ANTHROPIC_API_KEY` | Traduzione messaggi chat via Claude. Assente → traduzione disabilitata. **Segreto.** |
| `NEXT_PUBLIC_CF_API_KEY` | API esterna di verifica codice fiscale (client). Assente → verifica locale. |

## Varie

| Variabile | Descrizione |
|---|---|
| `NEXT_PUBLIC_APP_URL` | URL pubblico dell'app (link nelle email/QR). |

## Script di manutenzione ed E2E (fuori dall'app)

| Variabile | Descrizione |
|---|---|
| `SUPABASE_URL` | Alias server-only dell'URL progetto usato da `scripts/*.mjs` e dalle edge function (fallback: `NEXT_PUBLIC_SUPABASE_URL`). |
| `DATABASE_URL` | Connection string Postgres diretta, SOLO per lo script legacy `scripts/apply-enrollment-migration.mjs` (le migrazioni correnti passano da RPC `exec_sql`). **Segreto.** |
| `KV_SCUOLA_ID` | **Sede su cui gira una campagna di collaudo** (uuid). La leggono `e2e/primaria-360/**` ed `e2e/collaudo-giornata/**` (helper `e2e/lib/scuola-collaudo.mjs`, e la copia TypeScript in `e2e/primaria-360/config/accounts.ts`). **Assente o non-uuid → gli script escono con exit 1**: nessun default. Fino al 2026-07-31 la sede era l'uuid di Giugliano cablato in quattro file, con il commento «unica sede di produzione»; dal 2026-07-29 i plessi sono TRE e un seed che sbaglia sede scrive account e dati di scena nel plesso di famiglie vere, in silenzio. L'uuid si legge da `select id, nome from scuole` — non è un segreto, ma non va scritto in nessun file del repo (lock `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`). L'app non la legge mai. |
| `KV_TEST_PASSWORD` | Password comune degli account TEST `test.*@kidville.test` (**account attivi in PRODUZIONE**: sezioni TEST di Giugliano e, dal 2026-07-31, gli account `test.aversa.*` / `test.cesa.*` che rendono collaudabile l'isolamento fra sedi). La leggono le campagne di collaudo `e2e/primaria-360/**` e `e2e/collaudo-giornata/**` (helper `e2e/lib/test-password.mjs`), i flow Maestro (`export MAESTRO_KV_PASSWORD="$KV_TEST_PASSWORD"`) e **`scripts/seed-test-sedi.mjs --apply`**, che con essa crea/riallinea gli account delle altre sedi. **Assente → gli script escono subito con exit 1** e il messaggio che dice cosa esportare: nessun default, nessuna stringa vuota. **Segreto: non è scritta in nessun file del repo** (ruotata il 2026-07-26, sta nel gestore di credenziali del titolare). L'app non la legge mai. |
| `MAESTRO_TESTS_DIR` | **Solo per provare la bonifica dei log Maestro.** Directory che `.claude/maestro-flows/esegui.sh` ripulisce dai segreti; **default `~/.maestro/tests`**, cioè in uso normale non si imposta mai. Esiste perché il lock `__tests__/architecture/maestro-bonifica-segreti.test.ts` possa **eseguire** la bonifica (`esegui.sh --solo-bonifica`) su una cartella temporanea di canarini finti, senza toccare i log veri del collaudo. Un rimedio che non si può provare è un rimedio di cui si sa solo che esiste: il 2026-08-02 la maschera copriva `MAESTRO_KV_PASSWORD=` (0 occorrenze in chiaro) e non `KV_PASSWORD=` (211 in chiaro), e i lock che leggevano lo script erano tutti verdi. Non è un segreto e non va impostata in produzione. |
| `KV_E2E_PASSWORD` | Password comune dei 4 account del **seed E2E** `*.e2e@kidville.test` (progetto Supabase della CI, sede finta `e2e00000-…`). La leggono `scripts/seed-e2e.mjs` (helper `e2e/lib/e2e-password.mjs`) ed `e2e/fixtures.ts` (copia TypeScript, perché gli spec Playwright non importano `.mjs` del repo). **Assente o vuota → il seed esce con exit 1 e la suite fallisce all'import**: nessun default. **In CI arriva dal secret GitHub `CI_E2E_PASSWORD`** (job `e2e` di `.github/workflows/ci.yml`) — nome diverso dalla variabile per stare nella famiglia `CI_*` degli altri secret del progetto di collaudo. Il seed la **rimposta a ogni esecuzione** (`auth.admin.updateUserById`), quindi per ruotarla basta cambiare il secret e rilanciare la CI. **Segreto: non è scritta in nessun file del repo.** Fino al 2026-07-31 era un letterale in tre file committati, con l'esenzione «tanto è il DB della CI, niente dati reali»: vero del database, falso dell'account — il 2026-07-29 il provisioning di Aversa e Cesa ha collegato `admin.e2e@kidville.test` (ruolo `admin`) a due sedi VERE e quel letterale, in un repository pubblico, è stato per due giorni una credenziale di Direzione valida in produzione. L'app non la legge mai. |

La suite E2E (`npm run e2e`) legge `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
da `.env.local` per il seed idempotente (scuola dedicata `e2e00000-*`) e
`KV_E2E_PASSWORD` dall'ambiente (in CI: secret `CI_E2E_PASSWORD`);
dettagli in `docs/e2e.md`.

## Note operative

- Le route con dipendenze d'ambiente usano `src/lib/security/require-env.ts`
  (fail esplicito a runtime, non a import-time).
- Verifica del sigillo identità (M4.6):
  `curl -s -o /dev/null -w '%{http_code}' -H 'x-user-id: <uuid>' http://localhost:3000/api/me` → `401`.
- Con `ALLOW_HEADER_IDENTITY=false` il login reale (email+password Supabase)
  resta l'unico ingresso: sessione via cookie, refresh nel middleware.
