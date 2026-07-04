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
| `OTP_TICKET_SECRET` | derivato in dev | Segreto HMAC per i ticket OTP (FES stateless). In produzione impostarlo esplicitamente. **Segreto.** |
| `CRON_SECRET` | — | Bearer condiviso per gli endpoint service-to-service (es. `/api/push/dispatch` dal cron). **Segreto.** |
| `NODE_ENV` | gestita da Next | In `production` attiva `sealDangerous` sugli endpoint di debug/seed. |

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

La suite E2E (`npm run e2e`) legge `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
da `.env.local` per il seed idempotente (scuola dedicata `e2e00000-*`);
dettagli in `docs/e2e.md`.

## Note operative

- Le route con dipendenze d'ambiente usano `src/lib/security/require-env.ts`
  (fail esplicito a runtime, non a import-time).
- Verifica del sigillo identità (M4.6):
  `curl -s -o /dev/null -w '%{http_code}' -H 'x-user-id: <uuid>' http://localhost:3000/api/me` → `401`.
- Con `ALLOW_HEADER_IDENTITY=false` il login reale (email+password Supabase)
  resta l'unico ingresso: sessione via cookie, refresh nel middleware.
