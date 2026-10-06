# CI/CD — GitHub Actions + Vercel

Pipeline di produzione per Kidville Web.

- **CI** (gate di qualità) → **GitHub Actions**
- **CD** (deploy) → **Vercel** (auto: Preview su ogni PR, Produzione al merge su `main`)
- **Migrazioni DB** → **integrazione GitHub di Supabase** («Deploy to production»): applica al merge i file di
  `supabase/migrations/**`, modello additivo. `migrate.yml` **non applica niente**: è solo una verifica a mano
  (`supabase db push --dry-run`), disarmata il 2026-10-05
- **Funzioni** → Vercel, regione **`dub1`** (Dublino, la stessa del database): vedi «Regione delle funzioni»
- **Cron** → **pg_cron dentro Supabase** (non Vercel Cron): schedulazioni in `supabase/migrations/*_cron.sql`

```
PR ──► GitHub Actions (CI)                    Vercel
       ├ quality: eslint + tsc + vitest        └► Preview Deployment (URL per PR)
       └ e2e: Playwright su Supabase CI
       branch protection: merge BLOCCATO finché CI non è verde
                    │
   merge su main ───┼──► Vercel: deploy PRODUZIONE (auto), funzioni in dub1
                    └──► Supabase (integrazione GitHub): applica supabase/migrations/** del merge
```

`migrate.yml` non fa parte di questo flusso: si lancia **a mano** e fa solo un dry-run (vedi sotto).

Solo codice verde arriva su `main`, quindi Vercel non pubblica mai una regressione.

---

## Prerequisito (una tantum): baseline dello storico migrazioni — ✅ FATTO

Fatto a luglio 2026 (la prima version del registro è `20260704120000_baseline`): il registro
`supabase_migrations.schema_migrations` è allineato ai file. La procedura qui sotto resta come storia, e come
ricetta se un giorno si dovesse rifare.

Lo storico era **disallineato**: i primi ~50 file di `supabase/migrations/` sono stati
applicati a mano (script `apply_*.mjs`, via `exec_sql`) e **non** sono nella tabella
di tracking `supabase_migrations.schema_migrations`; i più recenti sì, ma con versioni
non corrispondenti ai nomi dei file locali. Senza baseline, `supabase db push`
ri-applicherebbe i vecchi file → errori `already exists`.

**Il DB di produzione è già nello stato finale.** Il baseline dichiara alla CLI che
tutti i file locali sono già applicati, così da lì in poi `db push` esegue solo i nuovi.

Procedura (da fare con `supabase login` + accesso al progetto prod, verificando ad ogni passo):

1. `supabase link --project-ref <PROD_REF>`
2. Confronta file locali ↔ tracking remoto: `supabase migration list`
3. Marca come applicate le migrazioni presenti in locale ma non tracciate:
   `supabase migration repair --status applied <version> …`
   (e `--status reverted` per eventuali righe remote che non corrispondono ad alcun file locale)
4. **Verifica**: `supabase db push --dry-run` deve dire **«Remote database is up to date.»** (è la frase che
   stampa la CLI 2.x, letta nei log dei giri riusciti).

Quel dry-run pulito («Remote database is up to date») è esattamente ciò che `migrate.yml` fa oggi, a mano,
quando serve sapere se il database è allineato ai file del repo.

---

## Setup GitHub

### Secrets (Settings → Secrets and variables → Actions)

| Secret | Cosa | Dove si usa |
|---|---|---|
| `CI_SUPABASE_URL` | URL del **progetto Supabase CI dedicato** (non prod) | job `e2e` |
| `CI_SUPABASE_ANON_KEY` | anon key del progetto CI | job `e2e` |
| `CI_SUPABASE_SERVICE_ROLE_KEY` | service-role del progetto CI (usata dal seed) | job `e2e` |
| `PROD_SUPABASE_DB_URL` | connection string del DB **di produzione** | `migrate.yml` (solo `--dry-run`, dietro `environment: production`) |
| `CI_SUPABASE_DB_URL` | connection string (**Session pooler**, porta 5432) del DB del **progetto CI** | `migrate-ci.yml` |

> Il progetto CI è un secondo progetto Supabase (gratis sul free tier). La E2E ci semina
> la scuola dedicata `e2e00000-*` in modo idempotente. **Mai** usare il progetto di produzione.

> `migrate-ci.yml` si lancia **solo a mano** (`workflow_dispatch`) e applica **solo i file
> elencati nel suo input**, non tutto lo storico: il progetto CI non ha
> `supabase_migrations.schema_migrations`, quindi `supabase db push` proverebbe a riapplicare
> tutte le migrazioni dall'inizio e morirebbe con «already exists» a metà. Prima di eseguire
> qualunque istruzione verifica di essere collegato al progetto giusto — confrontando il
> project ref con quello di `CI_SUPABASE_URL` e misurando che il database non contenga sedi
> reali. ⚠️ **Non basta cercare la sede `e2e00000-…`**: misurato il 2026-08-10, la produzione
> ne contiene una anche lei.

### Branch protection (Settings → Branches → `main`)

- Require a pull request before merging
- Require status checks to pass → seleziona **`Lint · Typecheck · Unit`** e **`E2E (Playwright)`**
- (consigliato) Require branches to be up to date before merging

### Environment `production` (Settings → Environments)

- Crea l'environment `production`
- Abilita **Required reviewers** (te stesso) → ogni lancio di `migrate.yml` (a mano, solo `--dry-run`) attende la
  tua approvazione prima di collegarsi al DB di produzione. Il lock
  `__tests__/architecture/migrate-yml-non-applica-da-solo.test.ts` pretende che il segreto di produzione stia
  sempre in un job con `environment: production`.

### Environment `backup` (Settings → Environments)

Serve a `backup-notturno.yml`, che gira di notte **senza persone**: quindi **nessun revisore**, ma
**Deployment branches = solo `main`**. Un branch con un workflow modificato (anche da un agente) non può
leggere questi segreti. Creato il 2026-10-05 (fase 2 della roadmap di robustezza). I segreti sono **di
ambiente**: si impostano con `gh secret set NOME --env backup` (campo nascosto, mai in chat).

| Secret (ambiente `backup`) | Cosa | Chi lo crea |
|---|---|---|
| `BACKUP_R2_ACCOUNT_ID` | id dell'account Cloudflare (serve a costruire l'endpoint `https://<id>.eu.r2.cloudflarestorage.com`) | titolare |
| `BACKUP_R2_KEY_ID` / `BACKUP_R2_KEY_SECRET` | token R2 `backup-scrittura` (Object Read & Write, **solo** sul bucket `kidville-backup`) | titolare |
| `BACKUP_SUPABASE_S3_KEY_ID` / `BACKUP_SUPABASE_S3_KEY_SECRET` | chiave S3 di Supabase Storage (Storage → S3). ⚠️ dà pieni poteri su **tutti** i bucket: non esistono chiavi di sola lettura | titolare |
| `BACKUP_CRYPT_PASSWORD` / `BACKUP_CRYPT_SALT` | password e salt di `rclone crypt` per i nomi e i contenuti dei file. **Da tenere anche offline**: senza, lo specchio non si decifra più | titolare |
| `BACKUP_DB_URL` | stringa **Session pooler** (porta 5432) con l'utente `backup_lettura.<ref>`: solo lettura | titolare, dopo la migrazione del ruolo |

Non è un segreto: la **chiave pubblica age** sta scritta in `backup-notturno.yml` (la privata sta offline dal
titolare, in due posti, e non entra mai in GitHub né nel repo). Il job `avviso` usa invece i segreti di
repository `RESEND_API_KEY` e `SENTINELLA_DESTINATARI` (gli stessi di `sentinella-play.yml`).

---

## Setup Vercel

1. Collega il repo GitHub al progetto Vercel (Preview attive di default).
2. **Production Branch** = `main`. L'auto-deploy resta **attivo** (modello scelto).
3. **Environment Variables** (scope Production) — sono i secret *runtime* dell'app, vivono su Vercel, non su GitHub:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   - `CRON_SECRET`, `ALLOW_HEADER_IDENTITY`
   - Integrazioni gated (se/quando disponibili): `SIDI_*`, `ARUBA_*`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`
     — senza credenziali l'app **degrada in modo pulito** (vedi README).

---

## Regione delle funzioni: `dub1`

`vercel.json` dichiara `"regions": ["dub1"]` alla radice. Dublino è la regione AWS `eu-west-1`, dove sta il
progetto Supabase: il server e il database parlano nella stessa zona (p50 13 ms a domanda) invece di attraversare
l'Atlantico (p50 103 ms dalle funzioni di `iad1`, Washington, misurato il 2026-10-05).

- **Perché nel file e non nel pannello del progetto.** La regione scritta in `vercel.json` appartiene al
  deployment, e un Instant Rollback la ripristina. L'impostazione «Function Region» del pannello è del progetto:
  un rollback non la tocca.
- **Cosa la difende.** Il lock `__tests__/architecture/vercel-json-funzioni-nella-regione-del-db.test.ts`.
  Serve perché `next build` non legge `vercel.json`: eslint, tsc, vitest e build non si accorgerebbero della
  riga persa, e il sito continuerebbe a funzionare, solo più lento di 90 ms a ogni domanda al database.
- **Come si verifica che Vercel l'abbia applicata** (il lock prova il file, non il deploy):
  - il campo `regions` del deployment: `vercel api "/v13/deployments/<id>?teamId=<team>"` deve dare `["dub1"]`;
  - l'intestazione `x-vercel-id` di una risposta: `curl -sI https://app.kidville.it/api/health` deve contenere
    `::dub1::`;
  - i log di Supabase (`edge_logs`): le richieste del server, cioè con `x_client_info` che finisce in
    `createServerClient`, devono arrivare dal colo `DUB`.
- **Chi ha una pagina aperta.** Con la Skew Protection a 12 ore, un client che ha caricato il deployment vecchio
  continua a essere servito da quello per al massimo 12 ore: la quota `dub1` si completa dopo, e la misura
  definitiva si prende a +12 ore dal deploy.
- **Regole del file.** Resta JSON stretto, senza commenti: un `vercel.json` che il parser rifiuta blocca ogni
  deploy. Un pattern in `functions` che non corrisponde a nessun file fa fallire la build (il lock lo vede).
  Un fornitore che filtrasse per indirizzo IP non sarebbe toccato dal cambio: il progetto non ha IP d'uscita fissi.

---

## Backup notturno esterno (Cloudflare R2, UE)

Roadmap di robustezza, fase 2 (problemi D1 e D2). **Supabase resta il database dell'app**: R2 riceve solo copie
cifrate, che l'app non legge mai. Il workflow è `.github/workflows/backup-notturno.yml`; la logica sta in
`scripts/backup/` (`dump-cifrato.sh`, `specchio-storage.sh`), provata offline da
`__tests__/lib/backup-*.test.ts` e sorvegliata da `__tests__/architecture/backup-notturno-sicuro.test.ts`.

- **Il database.** `pg_dump` 17 (formato custom) degli schemi `public`, `auth`, `storage`, `cron`,
  `supabase_migrations`, con l'utente di sola lettura `backup_lettura`, nella stessa istantanea in cui si
  contano le righe di ogni tabella. Il flusso passa per `age` (chiave pubblica) e **non tocca mai il disco in
  chiaro**. Accanto al dump, un `manifest.jsonl.age` cifrato (versioni, estensioni, conteggi per tabella, impronta).
  Dati esclusi (la struttura c'è sempre): `public.app_log`, `cron.job_run_details` e i token di sessione di
  `auth`. Le impostazioni **del database** (`app.cron_secret` e simili) non sono nel dump: i loro nomi sono nel
  manifest, i valori vanno rimessi a mano dopo un ripristino.
- **I file.** `rclone sync` incrementale da Supabase Storage (protocollo S3) verso un remote `crypt`: contenuti e
  nomi dei file cifrati; nomi di cartella in chiaro (sono solo uuid e parole fisse) perché i lock lavorano per
  prefisso. Ciò che sparisce dalla sorgente finisce nel **cestino** del giorno, mai nel nulla.
- **Cosa NON è nel backup, per scelta del titolare (2026-10-06): foto e video della galleria.** Sono i bucket
  `gallery` e `video_originals` (circa 7,7 GB su 15): non si copiano, per non pagare spazio. È scritto in
  `ESCLUDI_BUCKET` nel workflow e un lock (`backup-notturno-sicuro`) pretende che l'elenco sia **esattamente**
  questo e che non contenga mai un bucket insostituibile (iscrizioni, protocollo, 104/PEI, fatture, pagelle,
  personale, `video_build`). **Conseguenza accettata:** se la galleria o i video originali vengono persi o
  cancellati su Supabase, non si possono recuperare. I bucket `chat-allegati` e `form_attachments` (scansioni dei
  documenti delle iscrizioni) restano nel backup.
- **Regole su R2** (si impostano dal pannello, **dopo** i giri di prova: con un lock attivo il bucket non si
  svuota più). R2 non ha versioning né Object Lock S3: la protezione sono nomi con data + bucket lock, e il lock
  vince sul lifecycle (documentazione Cloudflare), quindi la scadenza GDPR è automatica.

| Prefisso | Contenuto | Lock | Lifecycle |
|---|---|---|---|
| `db/giornalieri/` | dump e manifest del giorno | 30 giorni | cancella a 31 g |
| `db/mensili/` | copia del primo giro del mese | 365 giorni | cancella a 366 g |
| `storage/corrente/` | specchio cifrato dei file | **nessuno** (rclone deve poter cancellare) | — |
| `storage/cestino/` | file spariti da Supabase, una cartella per giorno | 30 giorni | cancella a 31 g |
| `prove/` | solo giri di prova | nessuno | cancella a 2 g |

- **Come si lancia.** `gh workflow run backup-notturno.yml -f modalita=prova` (dump vero su `prove/`, specchio su
  tre file sintetici: prova anche il cestino e la cifratura) e poi `-f modalita=completo`.
  `-f simula_guasto=true` fa fallire apposta il giro per vedere arrivare l'allarme (segnalazione + email).
  Lo `schedule` è armato dal 06/10 (PR #193): **ogni notte alle 02:23 UTC**, in modalità `completo`, dopo che
  un giro `prova`, uno `completo`, le regole di lock su R2 e la prova dell'allarme erano riusciti da `main`.
  Per fermarlo: `gh workflow disable backup-notturno.yml`.
- **Se fallisce** il job `avviso` apre una segnalazione nel repository (etichetta `backup-notturno`, corpo
  pubblico: solo il link al giro) e manda un'email ai `SENTINELLA_DESTINATARI`. Se il workflow non parte affatto non
  c'è nessun allarme: lo copre la fase 3 (heartbeat esterno).
- **Come si ripristina** e cosa serve (chiave age, password crypt, token di lettura, impostazioni del database da
  rimettere): `docs/runbook-ripristino.md`.
- **GDPR.** Cloudflare (R2) e GitHub (il runner che esegue il dump, che lo cifra appena esce da `pg_dump`) sono
  responsabili del trattamento da dichiarare nel registro dei trattamenti. Le copie scadono da sole: 30 giorni
  (giornaliere e cestino) e 12 mesi (mensili). Un oblio si compie al più tardi alla scadenza; dopo un
  ripristino gli oblii avvenuti dopo la data del backup vanno **riapplicati**.
- **Costo.** Senza galleria e video: circa 7,4 GB di file + i dump (circa 2 GB per 30 giornalieri e 12 mensili) = circa
  9-10 GB, cioè dentro i 10 GB gratuiti di R2 (**0 $** o pochi centesimi). Con tutto sarebbero 17-18 GB, circa 0,15 $/mese.
  Uscita dati gratuita; GitHub Actions è gratuito sui repository pubblici.

---

## Campanello e verifica dopo il deploy

Roadmap di robustezza, fase 3 (S2). Fino al 2026-10-06 nessuno interrogava `/api/health`: se il sito si fermava lo
scopriva un genitore; e `/api/health` era `degraded` da due giorni per **2 alunni** col testo della classe diverso dal
nome della sezione — un allarme sempre acceso vale come uno spento.

### I tre livelli di salute (tutti pubblici, senza cache, con un tetto per IP ciascuno)

| URL | Cosa dice | HTTP | Per chi |
|---|---|---|---|
| `/api/health/vivo` | database e **login** (GoTrue): «il sito serve i genitori?» | 200 oppure **503** | il **campanello**: è l'unico da sorvegliare |
| `/api/health` | il vivo + schema, battito dei cron, errori del server, configurazione, coda fatture, regione | 200 (`ok` o `degraded`) oppure 503 | chi indaga; il workflow `campanello.yml` |
| `/api/health/qualita` | qualità dei dati (oggi: alunni col testo classe diverso dalla sezione) | **sempre 200** | chi sistema i dati; non accende nessun allarme |

Il corpo porta anche `regione` (la funzione gira in `dub1`?) e `versione` (sha del commit del deploy: il repository è
pubblico). Tre correzioni fatte nello stesso lavoro:

- **7 su 6**: `config` dichiarava 7 variabili e ne controllava 6 (`ARUBA_PASSWORD` mai guardata). Ora il tipo di
  `valoriCritici()` è un `Record` su tutta la tupla `VARIABILI_CRITICHE`: dimenticarne una è un errore di `tsc`.
- **`tasso-errore` sul solo server, impronte E occorrenze.** Gli errori del browser (`sorgente = 'client'`, scritti da
  `/api/logs`, che è anonimo) erano 1.258 righe contro 154 del server in 7 giorni e li fabbrica chiunque. Soglie
  tarate sulle misure del 06/10 (676 finestre da 15 minuti, solo server): impronte massimo 5 (soglia 5), somma delle
  occorrenze massimo 11 (soglia 25). La somma di `occorrenze` è un **tetto superiore** (è cumulativa per impronta e
  giorno): è l'errore nella direzione giusta. Il guasto storico di Resend («403 domain not verified») è **una**
  impronta ripetuta: con la sola conta delle impronte restava invisibile.
- **Il controllo `auth`** chiede a GoTrue di cercare l'utente nullo (`00000000-…`): un 404 `user_not_found` è la
  risposta di un Auth vivo che ha letto il suo database. Non legge nessun utente vero, e un 4xx dell'auth è `info`
  (non persistito), quindi un monitor che interroga ogni minuto non riempie `app_log`.

**Dove NON si traccia la regione:** non in `app_log`. Avrebbe richiesto una chiave nuova in `CHIAVI_IN_CHIARO`
(`src/lib/logging/redact.ts`), cioè un campo in più nel canale **anonimo** di `/api/logs`. La regione si legge da
`/api/health` (`regione`, controllo `regione`) e da `x-vercel-id`; la verifica dopo il deploy la controlla a ogni
rilascio.

### Collegare un monitor esterno (il campanello vero) — 5 minuti, account del titolare

I cron di GitHub ritardano di 10-30 minuti: il workflow qui sotto è un **rinforzo**, non il campanello definitivo.
Con Better Stack (gratis: 10 sonde ogni 3 minuti; avvisi via email, SMS e app) o UptimeRobot (gratis: 50 sonde ogni
5 minuti):

1. nuova sonda HTTP su **`https://app.kidville.it/api/health/vivo`**, ogni 1–3 minuti;
2. «allarma se» il codice non è 200 **o** la pagina non contiene `"stato":"ok"`; tempo massimo 10 secondi;
3. conferma dopo 2 controlli falliti di fila (un singolo scatto di rete non deve svegliare nessuno);
4. **non** puntare il monitor su `/api/health` (può essere `degraded` per un cron muto: è un avviso, non un guasto) né
   su `/api/health/qualita`.

Il monitor non vede il backup: quello lo guarda `campanello.yml`.

### `campanello.yml` — ogni ~15 minuti, senza account nuovi

Guarda tre cose; se una non va **apre una segnalazione** nel repository (etichetta `campanello`, titolo
`[chiave] testo`, corpo pubblico: solo ciò che gli endpoint di salute già espongono) e **manda un'email** (Resend, ai
`SENTINELLA_DESTINATARI`); quando il problema rientra **chiude la segnalazione da sola**.

- **Il vivo**, tre tentativi a 15 secondi: uno scatto isolato non sveglia nessuno. Incidente `app-giu`.
- **La salute**, due letture a 45 secondi: conta solo ciò che c'è in entrambe. Un incidente per controllo
  (`salute:<nome>`): un cron muto e una variabile sparita svegliano persone diverse.
- **Il backup**: l'ultimo giro **automatico** riuscito di `backup-notturno.yml`; oltre **30 ore** (o nessuno) →
  `backup-vecchio`. È l'unico modo di accorgersi che il backup **non è partito**: GitHub avvisa solo di un giro che
  parte e fallisce. Perché 30 e non 26: il primo giro programmato (06/10) è partito alle 09:08 UTC invece che alle
  02:23, **6 ore e 45 minuti di ritardo**; con 26 ore sarebbe suonato per un ritardo di due ore. Perché solo
  `schedule`: un giro lanciato a mano può essere in modalità `prova` (scrive sotto `prove/` e non è un backup) e
  dall'API dei giri non si distingue da `completo`. Perché da GitHub e non dall'app: GitHub è l'unico che sa la
  verità, ha già un token, e chiederlo da Vercel (indirizzi condivisi) sarebbe a 60 richieste l'ora.
- **Una segnalazione si chiude solo se la sua chiave è stata misurata in quel giro**: con il sito giù la salute non si
  legge, e le segnalazioni `salute:*` restano aperte (non è «rientrato», è «non l'ho guardato»). Lo stesso per il backup
  quando l'API dei giri non risponde.
- **Promemoria**: un incidente ancora aperto dopo 24 ore riceve un commento (non un'email).
- **Se l'email non può partire il giro fallisce** (e GitHub manda la sua email di «workflow fallito»): la segnalazione
  c'è comunque. Un allarme che non sa a chi scrivere è peggio di nessun allarme.

Si prova con `gh workflow run campanello.yml -f simula_guasto=true`: apre una segnalazione `[prova]` e manda l'email
marcata PROVA, senza guardare il sito; il giro normale successivo la chiude da solo. Si spegne con
`gh workflow disable campanello.yml`. Segreti (già impostati nel repository, gli stessi della sentinella Play e
dell'allarme del backup): `RESEND_API_KEY` e `SENTINELLA_DESTINATARI`.

### Quando suona: cosa fare

| Segnalazione | Cosa vuol dire | Cosa guardare |
|---|---|---|
| `[app-giu]` | database o login non rispondono (o il sito non risponde) | `curl -s https://app.kidville.it/api/health/vivo` dice QUALE controllo è caduto (`db-lettura` o `auth`). Se è comparso dopo un rilascio: **Instant Rollback** di Vercel. Altrimenti stato di Supabase e log di Auth |
| `[salute:cron-battito]` | un job non ha lasciato il suo battito nella finestra | il nome del job è nel testo; `cron.job_run_details` su Supabase e `app_log` (`evento = 'cron'`) |
| `[salute:config]` | una variabile d'ambiente critica manca o è vuota | il nome è nel testo (mai il valore): si rimette su Vercel e si rifà il deploy |
| `[salute:tasso-errore]` | troppi errori **del server** (impronte o occorrenze) negli ultimi 15 minuti | `app_log` con `livello = 'error'` e `sorgente = 'server'`, per `fingerprint` |
| `[salute:coda-fatture]` | voci ferme da oltre 24 ore o coda sospesa | pagina della coda fatture; log dei giri `fatture-coda-tick` |
| `[salute:regione]` | la funzione gira fuori da `dub1` | `vercel.json` (`regions`) e il deploy: Instant Rollback se è nuovo |
| `[salute:schema-atteso]` / `[salute:auth]` | una tabella manca / Auth non risponde | migrazione non applicata (integrazione Supabase) / stato di Auth |
| `[backup-vecchio]` | l'ultimo giro **automatico** del backup è più vecchio di 30 ore, o non c'è | i giri di `backup-notturno.yml` (`gh run list --workflow backup-notturno.yml`) e `docs/runbook-ripristino.md`. Un giro **manuale** `completo` fa il backup ma non spegne l'allarme: aspetta il primo giro automatico |
| `[deploy:<sha>]` | il rilascio non passa la verifica (versione, vivo, regione, salute `down`) | il testo dice cosa; Instant Rollback se il sito è rotto |
| `[prova]` | è la prova dell'allarme (`simula_guasto`): non è successo niente | si chiude da sola al giro successivo |

### `dopo-deploy.yml` — a ogni rilascio in produzione

Sull'evento `deployment_status` (`success`, ambiente `Production`) guarda `app.kidville.it`: che serva **il rilascio
appena fatto** (`versione` = sha del deploy, attesa fino a 10 minuti; se nel frattempo è andato in produzione un
rilascio più nuovo si ferma senza allarmare), che il vivo risponda, che la funzione giri in **`dub1`** (nel corpo e in
`x-vercel-id`) e che la salute non sia `down`. `degraded` è solo una nota: non l'ha causato il deploy. Se qualcosa non
va apre una segnalazione `[deploy:<sha>]`, manda l'email e fa fallire il giro; un rilascio buono chiude le segnalazioni
`deploy:*` precedenti.

Si testa il **dominio di produzione**, non l'URL del deploy: gli URL `*.vercel.app` stanno dietro il login di Vercel
(302 a `vercel.com/sso-api`) e una Preview non si può leggere senza un token di bypass. Il workflow esegue sempre gli
script di `main` (checkout esplicito di `default_branch`, non del commit del deployment).

Il lock `__tests__/architecture/campanello-workflow.test.ts` vieta `pull_request`/`push`, i permessi di scrittura sul
codice, i segreti fuori da `NOME: ${{ secrets.X }}` e ogni `${{ … }}` dentro un comando.

---

## Cron di produzione (pg_cron, dentro Supabase)

Le schedulazioni **non** usano Vercel Cron: girano in Postgres (`pg_cron` + `pg_net`) e
chiamano gli endpoint applicativi via `net.http_post`. Per attivarle in produzione,
imposta una tantum i GUC sul DB prod (ruolo con privilegi):

```sql
ALTER DATABASE postgres SET app.push_dispatch_url   = 'https://<dominio-prod>/api/push/dispatch';
ALTER DATABASE postgres SET app.mensa_allergie_url  = 'https://<dominio-prod>/api/mensa/allergie-check';
ALTER DATABASE postgres SET app.cron_secret         = '<CRON_SECRET, uguale a quello su Vercel>';
```

e assicurati che le migrazioni `*_cron.sql` siano applicate in prod (idempotenti):
`notifiche-dispatch` (5'), `mensa-check-allergie` (07:00), `genera-rette-mensili` (1° del mese 06:00),
`genera-solleciti` (ogni 6h), `cestino-registro-retention` (05:29 UTC: purga a 7 giorni — la costante
`GIORNI_CESTINO_REGISTRO` — del cestino di allegati del registro e fascicolo, via
`POST /api/gdpr/retention-cestino-registro`).

---

## Funzionamento quotidiano

1. Apri una PR → parte la CI; Vercel crea una Preview.
2. CI verde → puoi fare merge (la protection lo impedisce se rossa).
3. Merge su `main` → Vercel pubblica in produzione; se la PR toccava `supabase/migrations/**`, l'integrazione
   GitHub di Supabase le applica al merge, registrando la version del **file**. **Non si riapplicano a mano**:
   il registro avrebbe due righe con lo stesso nome. Per sapere se il database è allineato ai file si lancia a
   mano il workflow «DB migrate (prod)»: esegue solo `supabase db push --dry-run`, e non applica niente.

### Rollback

Deploy di produzione andato male → **Vercel → Deployments → Instant Rollback** al deploy precedente
(un click), oppure `vercel rollback <id-del-deployment>`. Le migrazioni, essendo additive, non vanno annullate
per un rollback del solo codice.

- Il rollback riporta anche la **regione delle funzioni**, perché `regions` sta nel `vercel.json` del deployment.
- È **temporaneo**: il prossimo deploy riparte da `main`. Per tornare davvero indietro serve un `git revert`
  del commit, altrimenti il deploy successivo rimette le funzioni dove stavano.
- Dopo un rollback si controlla `vercel rollback status` e che i nuovi deploy risultino ancora assegnati al
  dominio di produzione.
