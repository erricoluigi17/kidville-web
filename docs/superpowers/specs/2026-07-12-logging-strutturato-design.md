# Logging strutturato pervasivo — Design

**Data:** 2026-07-12
**Branch:** `feat/logging-strutturato`
**Stato:** design approvato, pronto per il piano di implementazione

---

## 1. Contesto e problema

Il debug di Kidville Web oggi è cieco. La ricognizione del repo lo dimostra con i numeri:

- **431 `console.*`** sparsi in `src/` (389 sono `console.error` dentro un `catch`), **zero infrastruttura**: nessuna dipendenza di logging, nessun formato comune, nessuna regola `no-console`. I soli prefissi esistenti (`[auth][header-fallback]`, `[PUSH]`, `[audit_scritture_docente]`) sono embrionali e incoerenti.
- **Lato client il buco è totale**: ~455 `fetch()` scritti a mano in ~140 file, senza wrapper, con il pattern dominante `.catch(() => {})`. Gli errori di rete **spariscono senza lasciare traccia**. Non esiste nessun error boundary, nessun `error.tsx`, nessun `window.onerror`.
- **73 scritture DB fire-and-forget** il cui `catch` **non scatta mai**: PostgREST non lancia, ritorna `{ error }`. Un insert rifiutato da un vincolo o dalla RLS è oggi totalmente invisibile — compresa la **cancellazione GDPR** (`src/app/api/admin/gdpr/erase/route.ts:92`).
- **I 5 endpoint cron** sono chiamati da pg_net in fire-and-forget con `EXCEPTION WHEN OTHERS THEN null`. Se il secret è sbagliato o il job non è schedulato, **il server non riceve nulla, quindi non logga nulla, quindi tutto sembra a posto**.

Il costo di questa cecità è già stato pagato. Per mesi **nessuna email di credenziali è mai arrivata a un destinatario reale**: il dominio non era verificato sul provider, che rispondeva `403`, ma `src/lib/email/send.ts:37` loggava **solo lo status senza il corpo**, e il ramo "chiave assente" stampava un rassicurante `console.log` di livello *info*. Il sistema non mentiva per malizia: non aveva modo di dire la verità.

**Obiettivo:** rendere osservabile ogni superficie che può fallire, in modo che un bug segnalato dall'utente sia diagnosticabile **senza riprodurlo**, leggendo i log.

**Consumatore unico dei log: Claude**, via MCP Vercel (`get_runtime_logs`) per il debug a caldo e via SQL su Supabase per la memoria lunga.

---

## 2. Decisioni prese (vincoli del design)

| # | Decisione | Motivazione |
|---|---|---|
| D1 | Log completi: una riga per richiesta API + errori con stack + query DB + gate auth + cron + push + client | massima visibilità |
| D2 | **Payload solo sugli errori** (`status >= 400` o eccezione) | sul percorso felice il payload non aggiunge nulla e moltiplica per 20 la superficie di dati personali e il volume |
| D3 | **Redazione a lista bianca**: passa in chiaro solo ciò che è esplicitamente permesso | "campo sensibile" è indecidibile a runtime: `descrizione` compare 113 volte e vale tanto "Merenda" quanto una diagnosi clinica |
| D4 | Flusso completo su console → Vercel Runtime Logs (**Pro: retention 1 giorno**) | debug a caldo, costo zero |
| D5 | Su tabella `app_log`: warn + error **+ i successi di una allowlist di eventi critici** (email, push, cron, fattura, pagamento) | con soli errori, "nessun log" non distingue "tutto ok" da "non è mai partito nulla" — che è esattamente com'è andata con le email |
| D6 | Retention DB 30 giorni | oltre la retention di Vercel, sotto il limite di ragionevolezza GDPR |
| D7 | Approccio **ibrido a lotti**: Fase 1 infrastruttura, Fase 2 rollout su 239 route con test-lock incrementale | precedente in casa: la copertura zod è stata fatta in 14 lotti |
| D8 | Nessuna dipendenza esterna (no pino/winston/Sentry/OTel) | `console` + Vercel + Supabase coprono il bisogno; OTel è tracing e richiede un backend |

---

## 3. Architettura

### 3.1 Formato: marker atomico + logfmt (non JSON puro)

Vercel **non parsa né indicizza** il JSON dentro il messaggio: sul contenuto è disponibile solo la ricerca full-text, e il tool MCP restituisce **max 100 righe per chiamata**. Un logger da 10 righe per richiesta *acceca* invece di aiutare.

```
KV_OK  rid=k3f9a2 uid=8f3ac1 ruolo=docente rt=/api/primaria/valutazioni ms=142
KV_ERR rid=k3f9a2 uid=8f3ac1 op=valutazioni.upsert code=PGRST204 msg="column ... does not exist"
Error: column valutazioni.x does not exist
    at ...
```

Regole del formato:

- **Marker alfanumerico singolo** (`KV_OK`, `KV_ERR`, `KV_CLIENT_ERR`, `KV_EXT`, `KV_CRON`, `KV_CFG`): è l'unica àncora che sopravvive con certezza alla tokenizzazione full-text. Un marker con punteggiatura (`evt=req.err`) non è garantito.
- **1–2 righe per richiesta.** Non si loggano `method`/`path`/`status`: Vercel li conosce già come metadati di piattaforma. Si logga solo ciò che Vercel **non** sa: utente, ruolo, sede, durata, codice errore del provider, esito.
- **Gli errori si emettono due volte**: la riga `KV_ERR` (per la ricerca) **e** l'`Error` nativo (per lo stack e per il raggruppamento di `get_runtime_errors`, che raggruppa per *error name*). **Mai `JSON.stringify(err)`**: su un `Error` nativo restituisce `{}` — bug già presente in `src/app/api/attendance/daily/route.ts:71`.
- **Solo `console.log` e `console.error`.** `console.warn` **non** produce il livello `warning` nelle funzioni non-streaming: produce `error`, e inquinerebbe il filtro.
- Cap di ~3,5 KB per riga.

### 3.2 I punti d'innesto

| # | Innesto | File | Copertura |
|---|---|---|---|
| 1 | `withRoute()` | wrapper sugli export delle 239 route | riga per richiesta: utente, ruolo, durata, status, eccezioni non gestite |
| 2 | **`global.fetch` sui client Supabase** | `src/lib/supabase/server-client.ts` — **tutti** i factory | ogni query DB, RPC, Storage, **Auth**; rende visibili le 73 scritture i cui errori oggi svaniscono |
| 3 | Contesto di richiesta | `src/lib/logging/context.ts` (AsyncLocalStorage) | correla ogni riga della stessa richiesta |
| 4 | `src/instrumentation.ts` | **nuovo, in `src/`** | errori non gestiti di pagine, Server Component, Server Action, middleware |
| 5 | `src/instrumentation-client.ts` | **nuovo** | `window.onerror`, `unhandledrejection`, patch di `fetch` — **prima dell'hydration** |
| 6 | `src/app/error.tsx` + `src/app/global-error.tsx` | **nuovi** | crash di rendering; **loggano da sé** (obbligatorio, vedi §4.3) |
| 7 | `externalFetch()` | `src/lib/logging/external.ts` (nuovo) | Resend, FCM, web-push, Aruba/SDI: risposte **col corpo dell'errore** |
| 8 | `POST /api/logs` | **nuova route** | ingestion degli errori client (browser + WebView nativa) |
| 9 | `payload` in ALS | `src/lib/validation/http.ts` (`parseBody`/`parseQuery`/`parseData`) | payload già validato e redatto, disponibile al wrapper **senza toccare il body** |
| 10 | tabella `app_log` + purge | nuova migrazione | memoria lunga, 30 giorni |

### 3.3 Perché `global.fetch` e non un Proxy sul client Supabase

Il Proxy è una trappola: `PostgrestQueryBuilder.select()/insert()/update()/delete()` **non ritornano `this`**, ritornano un oggetto nuovo (`new PostgrestFilterBuilder`) — il Proxy applicato a `.from()` **muore al primo `.select()`**. E `.storage`/`.auth` ritornano Promise vere, non thenable: servirebbe un secondo meccanismo.

`{ global: { fetch } }` è invece l'**opzione ufficiale e tipizzata** di supabase-js, e `@supabase/ssr` la preserva (fa `{ ...options?.global, headers: {...} }`). Un solo punto di intercettazione copre **REST + RPC + Storage + Auth + Functions**.

**Va applicato a tutti i factory**, non solo a `createAdminClient()`: `createClient()` (session) è quello usato da `resolveIdentity()` — cioè **dal gate di autenticazione stesso**. Strumentare solo l'admin client significherebbe non vedere mai le query che rompono i login.

**Invariante:** una risposta PostgREST con `!res.ok` produce **sempre** `level: 'error'`, anche se il codice applicativo la ignora. È questo che rende visibili le 73 scritture fire-and-forget.

### 3.4 Contesto di richiesta (AsyncLocalStorage)

- Istanza `AsyncLocalStorage` a livello di modulo, store **per-catena** creato **solo** con `als.run(ctx, handler)`. **Mai `enterWith()`**, mai variabili di modulo per utente/ruolo: su Fluid Compute più invocazioni condividono il processo e contaminerebbero il contesto.
- Il modulo importa `node:async_hooks` → deve avere `import 'server-only'` e **non** essere importato dal middleware (bundle Edge) né da codice client.
- Lo store è **mutabile**: il wrapper lo crea con `{ requestId, path }`, i gate (`requireStaff`/`requireDocente`) vi scrivono `userId`/`ruolo`, `parseBody` vi deposita il payload redatto.
- Il `requestId` arriva dal middleware via header `x-request-id` (il middleware è un'invocazione **separata**: nessuna catena async lo collega alla route). Il valore in ingresso dal client è spoofabile → il middleware lo **sovrascrive sempre**. Fallback nel wrapper: `crypto.randomUUID()`.
- **Cap del buffer** eventi (100), poi flush o drop con contatore: un import da 5.000 record non deve tenere tutto in RAM.

### 3.5 `withRoute()` — solo osservabilità

```ts
export const GET = withRoute('tasks:GET', async (request: Request) => { ... })
```

- **Non assorbe né i gate né zod**: se `requireStaff`/`CRON_SECRET`/l'import di zod sparissero dal sorgente della route, si romperebbero insieme il lock `__tests__/api/zod-coverage.test.ts` (in CI) e `scripts/audit-route-gates.mjs`.
- **Non legge mai il body**: le route fanno `await request.json()` dentro `parseBody`, e un doppio consumo dello stream romperebbe tutto. Clonarlo sarebbe peggio: sulle 12 route multipart significherebbe duplicare in RAM uno ZIP o una foto da 20 MB → esaurimento memoria della lambda. Il payload arriva dall'ALS (innesto 9).
- **Non usa API solo-`NextRequest`** (`nextUrl`, `cookies`, `ip`): i ~90 test API passano una `Request` nuda. Usa `new URL(req.url)` e `req.headers`.
- **Rilancia sempre** le eccezioni dopo averle loggate: inghiottirle cambierebbe la semantica e romperebbe i test che asseriscono i 500 espliciti delle route.
- Preserva la firma esatta dell'handler: `tsconfig.json` include `.next/types/**` e il validator generato vincola gli export.

### 3.6 Client

Il punto d'installazione **non** è un provider React: `useEffect` di un componente padre viene eseguito **dopo** quelli dei figli, quindi si perderebbero proprio le fetch del primo caricamento. Si usa **`src/instrumentation-client.ts`** (convenzione ufficiale Next, gira dopo il caricamento del documento e **prima dell'hydration**, una volta sola — quindi immune a StrictMode, che in questo progetto è attivo).

- **Patch di `window.fetch`**, idempotente e fail-open. Esclude (pass-through puro, nessuna misura): header `rsc` / `next-action` / `next-router-state-tree` / `next-router-prefetch` / `next-router-segment-prefetch` / `next-hmr-refresh`; query `_rsc` (verificata con `searchParams.has('_rsc')` — **non** `includes('_rsc=')`, perché il parametro può comparire senza `=`); il sink stesso; schemi non-http.
- **Mai `response.clone()`** su ciò che non si consuma: farebbe un tee dello stream e bufferizzerebbe in memoria (il payload RSC è streaming).
- **Nessun body loggato.** Il patch vede anche `POST /auth/v1/token`: loggare i body significherebbe scrivere password e JWT dei genitori.
- **Flush con `navigator.sendBeacon`**, che **non passa da `fetch`**: il loop diventa impossibile *per costruzione*, non per convenzione.
- **Coda persistita su IndexedDB** (`src/lib/offline/db.ts` esiste già), cap 20 eventi, drop dei più vecchi. `syncEngine` (25 `console.*`) gira **offline**: i suoi errori sono di Dexie/IndexedDB, invisibili al patch di `fetch` e alle boundary React. Senza coda persistita, i bug del percorso offline — che sono proprio quelli che servono — non arriverebbero mai.
- App nativa: l'origin è quello di produzione (`CAP_SERVER_URL`), il sink va chiamato con URL assoluto.

### 3.7 Tabella `app_log`

Convenzioni della casa (colonne in italiano, `creato_il timestamptz`, `jsonb`, `CREATE TABLE IF NOT EXISTS`), con **una differenza deliberata sulla RLS**.

- **RLS deny-all, unica policy `service_role`** + `REVOKE ALL ... FROM anon, authenticated` (il baseline concede `GRANT ALL` di default alle nuove tabelle). Il pattern da replicare è quello di `protocolli`, **non** quello di `audit_scritture_docente`/`fea_audit_log`, che hanno `FOR SELECT TO authenticated USING (true)` — cioè **sono leggibili da qualsiasi utente loggato, genitori compresi**.
- Colonne essenziali (nomi in italiano, come tutto lo schema): `id`, `creato_il`, `livello`, `evento`, `messaggio`, `stack`, `route`, `stato_http`, `utente_id` (**senza FK**: il log deve sopravvivere all'oblio GDPR), `utente_ruolo`, `scuola_id`, `request_id`, `piattaforma`, `app_versione`, `ambiente`, `fingerprint`, `occorrenze`, `visto_la_prima`, `visto_l_ultima`, `contesto jsonb`. **Nessun IP grezzo.**
- `evento` è il discriminante trasversale (`route`, `db`, `email`, `push`, `cron`, `config`, `client`, `unhandled`): è la colonna su cui si raggruppa per rispondere a "questa categoria di cose funziona?".
- **Dedup per fingerprint** (`sha256(evento + messaggio + primi 3 frame dello stack)`) con contatore, invece di N righe identiche: il moltiplicatore di volume non sono le 239 route, è il client (WebView su rete mobile: un'ora di rete degradata = decine di migliaia di errori).
- Indici btree su `(creato_il DESC)`, `(livello, creato_il DESC)`, `(utente_id, creato_il DESC)`, `(route, creato_il DESC)`, `(request_id)`.
- **Purge a lotti** (`DELETE ... LIMIT 10000` in ciclo) via pg_cron, già attivo in produzione. La migrazione usa `DO $$ ... EXCEPTION WHEN OTHERS THEN null; END $$;` perché sul DB E2E in CI pg_cron non esiste.
- **Circuit-breaker**: sul DB E2E in CI la tabella non esiste; il primo insert fallisce con `42P01`/`PGRST205`, il breaker si apre e non si ritenta più. Zero rumore, zero E2E rotti. Il breaker si apre **solo** su codici di schema mancante, mai su errori transitori.

### 3.8 `POST /api/logs`

Endpoint **ostile per progetto**: deve accettare anche richieste anonime (gli errori sulla pagina di login sono il caso d'uso principale), quindi:

- rate-limit per `(ip|userId)` con `src/lib/security/rate-limit.ts` (in-memory per istanza: è un limite morbido, non un muro);
- **cap byte del body letto da `content-length` prima di `request.json()`** (413 oltre 64 KB) — altrimenti zod valida solo dopo aver già parsato in memoria;
- validazione zod (`parseBody`), cap del batch a 20 eventi, troncamento server-side (messaggio 1000, stack 4000);
- throttle e dedup lato client (max 1 log identico ogni 60 s, max ~20 per sessione);
- va aggiunto `'logs'` a `GRUPPI_COPERTI` in `__tests__/api/zod-coverage.test.ts`, **nello stesso commit** che crea la route (il lock fallisce se il gruppo è vuoto).

---

## 4. Le invarianti che nascono dai guasti già avvenuti

### 4.1 Il corpo dell'errore del provider si propaga sempre

`src/lib/email/send.ts:37` logga solo lo status; `src/lib/push/native-push.ts:128` **legge il corpo e poi lo butta via** (`return { ok:false, error: 'fcm_http_' + res.status }`). Loggare uno status senza il corpo **è il bug**, non l'assenza di un logger.

`externalFetch()` rende la propagazione un'invariante di codice: su `!res.ok` legge `await res.text()` (cap 500 char) e lo mette nel campo `provider_body`. Il logger **non accetta** di registrare uno status di terze parti senza corpo.

### 4.2 Configurazione mancante = `error`, mai `info`

Un preflight al cold start (`register()` in `src/instrumentation.ts`) emette `KV_CFG level=error` per ogni variabile critica assente (`RESEND_API_KEY`, `OTP_FROM_EMAIL`, `CRON_SECRET`, FCM, VAPID). **Un provider non configurato in produzione è un incidente, non una nota.**

### 4.3 Le error boundary devono loggare da sé

**Controintuitivo e decisivo:** oggi, *senza* `error.tsx`, gli errori React non catturati passano dalla boundary implicita di Next → `reportError()` → **`window.onerror` li vede**. Nel momento in cui si aggiunge `error.tsx`, quegli stessi errori diventano "catturati da una boundary esplicita" e in produzione Next esegue solo `console.error`, **senza** `reportError()`. I due meccanismi **non si sommano: si sottraggono.**

Conseguenza: se ci si affidasse a `window.onerror` come rete unica, dopo il deploy si vedrebbero **meno** errori di prima. Il log dentro `error.tsx` e `global-error.tsx` (con dedup su `digest ?? message`) è **obbligatorio**.

`global-error.tsx` sostituisce il root layout: deve dichiarare i propri `<html>`/`<body>`, importare `globals.css` e le variabili dei font, e non può esportare `metadata`.

### 4.4 Il `digest` è la chiave di correlazione

In produzione il messaggio degli errori Server Component è generico per progetto. Lo stack vero esiste **solo** nel log server di `onRequestError`. Il client manda `{digest}`, il server logga `{digest, stack, routePath}`: si incrociano per `digest`. Gli errori puramente client non hanno digest → il logger client genera una propria chiave.

### 4.5 I cron: si sorveglia l'*assenza*

pg_net chiama i 5 endpoint in fire-and-forget con l'eccezione soppressa. Se il secret è vuoto o il job non è schedulato, **non arriva niente e quindi non si logga niente**. Ogni run scrive un battito persistito (`evento='cron'`, livello info in allowlist, cfr. D5), e la diagnosi è una query sull'assenza:

```sql
select contesto->>'job' as job, max(creato_il) from app_log where evento = 'cron' group by 1;
```

Se un job non compare, non sta girando. Senza questa riga, il silenzio resta ambiguo.

---

## 5. Redazione dei dati personali

**Il default è invertito: tutto è redatto, tranne ciò che è esplicitamente permesso.**

- Passano in chiaro **solo**: uuid, numeri, booleani, date ISO, e le stringhe la cui **chiave** è in una allowlist esplicita (`tipo`, `stato`, `azione`, `ordine`, `periodo`, `anno`, `cadenza`, `livello`, `classe_sezione`, `bucket`, `mime`, …).
- Tutte le altre stringhe → `[redatto:str/N]` (si conserva il tipo e la lunghezza: basta a diagnosticare "il campo mancava", "era vuoto", "era del tipo sbagliato" — che è il 95% dei bug).
- Per `nome`/`cognome`/`email`: **hash stabile troncato** (`sha256(v + SALT).slice(0,8)`) invece del placeholder, così resta possibile **correlare** ("è sempre lo stesso genitore") senza esporre l'identità.
- **L'allowlist è di *chiavi*, mai di valori.** Niente euristiche regex sui valori (codice fiscale, email, IBAN): danno falsi negativi e fanno dormire tranquilli mentre versano dati.

Superfici PII spesso dimenticate, tutte da redigere:

- **la query string** (`?userId=`, ricerche per nome, `?token=` dei link pubblici) — `onRequestError` riceve `request.path` **con la query**: va troncato alla `?`;
- **gli header** — `onRequestError` riceve l'oggetto headers completo, **cookie di sessione inclusi**: solo allowlist (`x-vercel-id`, `user-agent`, `x-kv-user`);
- il body di `/auth/v1/token` (password in chiaro), visibile al `global.fetch` del session client.

Categorie di chiavi presenti in questo dominio, per dimensionare il rischio: dati sanitari di minori (`allergie` ×18, `diagnosi`, `certificato_medico` ×11, `motivo` assenza), **testo libero** (`descrizione` ×113, `note` ×96, `testo` ×55, `contenuto` ×54, `giudizio` ×15), identità (`email` ×156, `codice_fiscale` ×37, `indirizzo` ×39), sicurezza e valore legale (`password` ×34, `token` ×38, **`firma` ×91 — FEA**, `code` = OTP), valutazione (`valutazione` ×20, `voto` ×7).

---

## 6. Le tre regole anti-disastro

1. **Fail-open assoluto.** Qualunque eccezione dentro il logger viene inghiottita. Un `throw` nel wrapper trasformerebbe una 200 in 500 **su tutte le route**. Cause reali: oggetto ciclico, `BigInt` (`JSON.stringify` lancia), `Buffer` da 10 MB, URL malformato. Serializzatore fatto in casa con cycle-guard, cap di profondità e di dimensione.
2. **Guardia di rientranza.** Il client Supabase che scrive su `app_log` è **l'unico senza `fetch` strumentato**, più un flag `inLogger` nell'ALS. Altrimenti un errore di scrittura sui log genera un log di errore che tenta di scrivere sui log → **ricorsione fino all'esaurimento della memoria**.
3. **Silenzio nei test.** Guardia su `process.env.VITEST` letta **al caricamento del modulo** (non `NODE_ENV`, che `__tests__/api/p0-gates.test.ts:64` stubba a `production` a runtime). Il logger **non tocca mai il DB nei test** (in molti test `createAdminClient` non è mockato e `.env.local` punta a **produzione**). Per Playwright: `webServer.env = { KV_LOG_LEVEL: 'silent' }` — 14 spec seriali su `next dev`, già instabili sotto carico.

Rumore da non generare mai: prefetch RSC (Next prefetcha in hover), 401/403 dei gate (frequentissimi a sessione scaduta: si loggano ma **non si persistono**).

---

## 7. Fasi

### Fase 1 — Infrastruttura

`src/lib/logging/` (logger, redazione, contesto, `withRoute`, `externalFetch`, client), `src/instrumentation.ts`, `src/instrumentation-client.ts`, `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/api/logs/route.ts`, migrazione `app_log` + purge, `global.fetch` su `server-client.ts`, `x-request-id` nel middleware, payload in `validation/http.ts`, `externalFetch` su `email/send.ts` + `push/native-push.ts` (i due guasti noti).

### Fase 2 — Rollout `withRoute` a lotti (rischio crescente)

| # | Lotto | Route | Perché qui |
|---|---|---|---|
| 0 | Collaudo: `me`, `educator-sections`, `debug*`, `public/**` | ~6 | sole letture, zero PII: si valida il **formato** e la correlazione |
| 1 | Docente base: `attendance`, `notes`, `tasks`, `avvisi`, `agenda`, `grades` | ~17 | piccole, zod presente, nessun multipart |
| 2 | `parent/**` | ~24 | massima frequenza + **PII pesante**: è il **vero collaudo della redazione**. Se qui compare un valore in chiaro, ci si ferma |
| 3 | `primaria/**` | 25 | giudizi, scrutinio, audit, **FEA**: il wrapper non deve alterare l'ordine delle scritture |
| 4 | Testo libero e media: `chat`, `diary`, `locker`, `mensa`, `gallery`, `notifiche` | 27 | `chat.contenuto` = testo libero puro → redazione totale |
| 5 | `pagamenti` | 23 | soldi, PDF/stream: il rischio è **rompere le Response Blob** |
| 6a/6b/6c | `admin` (letture → scritture → irreversibili: GDPR, credenziali, protocolli, SIDI) | ~96 | il grosso, in ordine di pericolosità |
| 7 | **Multipart** (12 route) | 12 | unica famiglia dove il wrapper cambia comportamento: lotto e test dedicati |
| 8 | **Cron, push, auth** | ~14 | ultimi: qui un errore è **silente** e il gate non è `requireStaff` ma `x-cron-secret` → il wrapper non deve presupporre un utente. Qui si aggancia l'heartbeat |

**Test-lock** (`__tests__/architecture/logging-coverage.test.ts`, clonato da `zod-coverage.test.ts` con la sua lista incrementale `GRUPPI_COPERTI`): non verifica l'*import* di `withRoute` (si aggirerebbe importandolo senza usarlo) ma che **ogni export HTTP sia effettivamente avvolto**, e che non sopravviva nessun `export async function GET`.

### Fase 3 — Igiene (`no-console`)

I 430 `console.*` legacy si azzerano con le **bulk suppressions native di ESLint 9.39** (`--suppress-rule no-console` genera la baseline, `--prune-suppressions` la eroda a ogni lotto). **Non** con il livello `warn`: la CI gira `eslint . --max-warnings 0`. Override per `scripts/**`, `e2e/**` e per il modulo del logger. Attenzione: `src/lib/auth/resolveIdentity.ts` è l'unico file il cui `console.warn` è **asserito da un test** (`__tests__/lib/resolveIdentity.test.ts:99`) — va migrato in coppia con il test.

---

## 8. Collaudo (prima di dire "fatto")

> `.env.local` punta a **produzione**: il collaudo gira su DB e2e/staging o su preview, mai in locale contro prod.

- **A — Redazione (vitest, è il vero lock anti-PII).** Fixture con un campione del dominio (allergie, diagnosi, giudizio, descrizione, contenuto, motivo, codice fiscale, IBAN, password, OTP, firma, indirizzo, telefono, email, nome): **nessun valore deve sopravvivere** a `redact()`. Più un fuzz con chiavi casuali. **Se questo test è rosso, non si prosegue.**
- **B — Fail-open (vitest).** Oggetto ciclico, `BigInt`, `Symbol`, `Buffer` da 10 MB, `undefined`: non lancia, tronca.
- **C — Body non consumato.** Una POST reale con body JSON: `parseBody` riceve ancora il body. Una multipart (`primaria/allegati`): la route funziona e il log **non** contiene il file.
- **D — Correlazione.** Un `throw` temporaneo in una route → due righe con lo **stesso `requestId`** (dal wrapper e da `onRequestError`). Una query su tabella inesistente → riga `error` **con il corpo PostgREST**, non solo lo status.
- **E — IL TEST DEL FALLIMENTO SILENZIOSO** (è il collaudo che giustifica tutto il lavoro). Si riproduce in laboratorio l'incidente delle email:
  1. chiave provider valida + dominio **non verificato** → deve comparire
     `KV_EXT evento=email provider=resend status=403 body="... domain is not verified ..."`
     e la route deve restituire un esito che il chiamante **non può ignorare**;
  2. chiave provider assente → `KV_CFG evento=config livello=error mancante=RESEND_API_KEY`, **non** un `console.log` rassicurante;
  3. `grep -i password` sui log → **zero risultati**;
  4. FCM con token fasullo → riga di errore **col corpo FCM**, non `fcm_http_400`.

  **Se E non è verde, il design ha fallito nell'unico compito per cui è nato.**
- **F — Client e offline.** `setTimeout(() => { throw new Error('kv-test') })` → arriva a `/api/logs`. Poi DevTools **offline** → errore in `syncEngine` → ritorno online → **il log arriva comunque** (coda IndexedDB).
- **G — Anti-loop.** `/api/logs` forzata a 500 → il client si ferma dopo N tentativi. Errore di insert su `app_log` → **nessuna ricorsione**.
- **H — Volume (24 h in preview).** `select livello, evento, count(*) from app_log group by 1,2 order by 3 desc` + `pg_size_pretty(pg_total_relation_size('app_log'))`. Se in cima c'è rumore ricorrente, si taglia **prima** della produzione.
- **I — Gate di progetto** (AGENTS.md): `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run build` · **E2E `teacher-attendance` verde** — è il canarino dell'hydration: `instrumentation-client.ts` e il patch di `fetch` girano prima dell'hydrate, e quel test è l'unica prova che non la rompono.

---

## 9. Fuori perimetro (YAGNI)

- **Proxy sul client Supabase** — sostituito da `global.fetch`.
- **OpenTelemetry / `@vercel/otel`** — è tracing, richiede un backend esterno; durata e status delle richieste li dà già Vercel.
- **Log Drains** ($0.50/GB) — richiede un destinatario esterno da gestire.
- **Payload sulle richieste 2xx** — cfr. D2.
- **Euristiche regex sui valori** — cfr. §5.
- **Livelli di log configurabili da DB** — una query per richiesta. Basta `LOG_LEVEL` da variabile d'ambiente.
- **Doppio punto d'installazione del patch client** (`instrumentation-client.ts` *e* provider React) — se ne tiene **uno solo**, o uno dei due verrà dimenticato.
- **Pagina admin `/admin/log`** — il consumatore dei log è Claude (via MCP). Si potrà aggiungere dopo, se emergerà il bisogno.

---

## 10. Rischi noti e mitigazioni

| Rischio | Mitigazione |
|---|---|
| `instrumentation.ts` messo nella radice invece che in `src/` | è un **no-op silenzioso** (Next scandisce solo `src/` perché l'app dir è `src/app`): nessun errore, nessun warning, semplicemente non logga. Verificare con il collaudo D |
| Il patch `fetch` rompe l'hydration | non renderizza nulla e non fa `setState`: l'incidente storico fu causato da un **boundary Suspense** (`loading.tsx`), non da un side-effect. Il gate resta l'E2E `teacher-attendance` |
| `no-console` blocca la CI al primo lotto | bulk suppressions, mai livello `warn` (`--max-warnings 0`) |
| `next.config.ts` è vuoto: se un domani qualcuno attiva `compiler.removeConsole`, **tutto il logging sparisce in silenzio** | commento-lock nel file + test |
| Retention Vercel = 1 giorno (piano Pro) | è per questo che esiste `app_log`: i log che devono sopravvivere si persistono |
