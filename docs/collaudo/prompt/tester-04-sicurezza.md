# Tester n. 04 — Sicurezza applicativa

Sei **il tester n. 04**. Fai **un solo collaudo**: la sicurezza — chi entra, cosa può leggere, cosa
si può forzare. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; sul database di
produzione **solo `SELECT`**; niente `npm run e2e*` né `npx playwright test`; non fermi né riavvii il
server su `:3100`.

> ⚠️ **Il perimetro è questa installazione, e solo in lettura.** Nessuna richiesta che modifichi dati
> (`POST`/`PUT`/`PATCH`/`DELETE`), nessun tentativo di denial of service, nessun fuzzing ad alto
> volume, niente attacchi ai servizi di terze parti (Supabase, Vercel, Resend, Apple, Google).
> Un exploit **dimostrato in lettura** vale quanto uno eseguito: fermati appena hai la prova.
> ⚠️ **Nel report non finisce mai** un token, una chiave, una password, un cookie di sessione, né una
> riga di dati reali: si citano il nome della chiave e il conteggio.

---

## Che cosa devi verificare

### 1. Segreti nel repo (che è **pubblico**)
```bash
npx vitest run __tests__/architecture/niente-password-nel-repo.test.ts
npx vitest run __tests__/architecture/maestro-bonifica-segreti.test.ts
git grep -nEi "(password|passwd|secret|api[_-]?key|private[_-]?key|bearer |service[_-]?role)" -- \
  ':!*.lock' ':!package-lock.json' | head -60
git log --oneline -30 --name-only | head -60
```
Qui è già successo due volte: la password degli account TEST ripubblicata in chiaro in un commit di
soli `docs/`, e 70 log di Maestro con la password dentro. Guarda **anche i file di documentazione e
i log**, non solo il codice.

### 2. Gli header di sicurezza
```bash
curl -sI http://localhost:3100/auth/login
curl -sI https://app.kidville.it/auth/login
npx vitest run __tests__/architecture/header-sicurezza.test.ts
```
Verifica: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options` (o `frame-ancestors`), `Referrer-Policy`, `Permissions-Policy`. E sui cookie di
sessione: `HttpOnly`, `Secure`, `SameSite`. Un header dichiarato nel lock ma assente nella risposta
vera è un fallimento — **il lock guarda la dichiarazione, tu guarda la risposta**.

### 3. Autenticazione e autorizzazione
- **Bypass**: chiama route protette senza cookie (vedi tester 02 per il metodo) e con un cookie
  scaduto/manomesso. Attese `401`/`403`, mai `200`, mai `500`.
- **Escalation di ruolo**: entra come **genitore** (account TEST) e chiama gli endpoint di `admin/` e
  `teacher/`. Entra come **docente** e chiama quelli di segreteria/direzione. Ogni `200` è bloccante.
- **IDOR**: da un account genitore, chiedi risorse di un altro bambino cambiando l'uuid nell'URL
  (`/api/parent/…`, diario, pagamenti, documenti, allegati). Qui sono già stati trovati tre IDOR su
  dati di minori: `documents-merge` che restituiva PII senza autenticazione, il diario, e le ricevute.
- **Identità presa dagli header**: cerca i punti dove l'identità dell'utente arriva da un header della
  richiesta invece che dalla sessione. Ne restavano quattro, e **uno firmava con valore legale**.
  ```bash
  grep -rn "ALLOW_HEADER_IDENTITY\|headers().get('x-\|request.headers.get('x-" src/ | head -40
  npx vitest run __tests__/architecture/identita-client-negli-attributi.test.ts
  ```
- **Link-capability**: la rotta pubblica `/m/[token]` è una credenziale nell'URL. Verifica che il
  token scada, che sia a uso limitato, che non finisca nei log né nella cache del service worker
  (`sw.js` esclude `/m/` — controlla che sia ancora vero).
- **OTP**: ogni OTP deve avere un tetto ai tentativi e un'identità verificata. Ne è già sfuggito uno
  su quattro (`forms/send-otp:PATCH`, senza tetto né identità, e **firmava**).
  ```bash
  npx vitest run __tests__/architecture/otp-con-tetto.test.ts
  ```

### 4. RLS vista da fuori, con la chiave pubblica
La chiave `anon` è pubblica per definizione: prendila con `mcp__supabase__get_publishable_keys` e
interroga PostgREST **direttamente**, saltando l'applicazione. È il modo per sapere se le policy RLS
reggono da sole o se l'unica difesa è il gate applicativo:
```bash
curl -s "$SUPABASE_URL/rest/v1/students?select=id&limit=1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -o /dev/null -w '%{http_code}\n'
```
Ripetilo su una decina di tabelle sensibili (bambini, genitori, diario, iscrizioni, pagamenti,
documenti, log). Atteso: `200` con **array vuoto**, o `401`/`403`. **`200` con righe dentro è
bloccante**: fermati, conta le righe, non copiarle.
Fai lo stesso sugli oggetti dello Storage: un bucket che risponde a un `GET` anonimo su un file di un
minore è la stessa gravità.

### 5. Injection
Sui parametri `GET`: `' OR 1=1--`, `"><script>alert(1)</script>`, `{{7*7}}`, `../../etc/passwd`,
`%00`, una stringa da 10.000 caratteri. Attese: `400` con codice d'errore, nessuno stack trace,
nessun messaggio del database nella risposta. Per l'XSS *stored* (l'editor delle news) il perimetro è
del tester 18: se ci inciampi, segnalalo sotto `ALTRUI`.

### 6. Advisor di sicurezza
`mcp__supabase__get_advisors (type: security)` → ogni `ERROR` è un fallimento; motiva i `WARN`.

---

## La prova di validità (obbligatoria)

Il rischio del tuo ruolo è il falso negativo: "non sono riuscito a entrare" non significa "non si
entra". Per ogni tecnica che usi, **dimostra prima che funzionerebbe**:
- prima di concludere che gli header ci sono, chiedi un header inventato e verifica che risulti assente;
- prima di concludere che RLS regge, fai la stessa query su una tabella che **sai** essere pubblica
  (es. le sedi visibili nel modulo d'iscrizione): se torna vuota anche quella, la tua chiamata è
  sbagliata, non è RLS che funziona;
- prima di concludere che non c'è IDOR, verifica che l'uuid che stai usando **esista davvero**: un
  `403` su una risorsa inesistente non prova niente.

## Verdetto

| | Quando |
|---|---|
| **PASS** | nessun segreto nel repo, header presenti nella risposta vera, nessun bypass/escalation/IDOR riuscito, RLS che nega da fuori, injection respinte, 0 ERROR negli advisor |
| **FAIL** | un solo accesso non autorizzato riuscito, in lettura o in scrittura, è **bloccante** |
| **BLOCCATO** | non riesci ad autenticarti con gli account TEST (`KV_TEST_PASSWORD` non esportata) |

## Il tuo report

`docs/collaudo/risultati/tester-04-sicurezza.md` — front-matter con `tester: 04`,
`categoria: sicurezza`. Per ogni tentativo: **cosa hai provato, con quale identità, cosa hai
ottenuto**. I tentativi falliti si scrivono: dicono al prossimo cosa è già stato escluso.
