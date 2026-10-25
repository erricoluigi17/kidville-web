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
applicati a mano (script `apply_*.mjs`, via `exec_sql`: funzione e script sono stati rimossi il
2026-10-25, e da allora le migrazioni le applica solo l'integrazione GitHub di Supabase al merge, con la
version del file) e **non** sono nella tabella
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
  `auth`. I segreti dei cron (`app.cron_secret` e i cinque URL) stanno nel **Vault**, che il dump non copia: dopo un
  ripristino si rimettono con `vault.create_secret`, un nome alla volta (vedi «Cron di produzione» e lo scenario E del
  runbook).
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
  **Ogni notte alle 02:23 UTC** lo lancia il **monitor esterno** (Worker di Cloudflare, cron puntuale) con
  `modalita=completo` e `origine=cloudflare`: il giro si chiama «Backup notturno completo (da Cloudflare)». Lo
  `schedule` di GitHub (stessa ora, ma arriva fra le 07:00 e le 09:35) resta come **riserva**: il job `guardia` lo
  annulla da sé se un backup completo è riuscito nelle ultime 20 ore, e il giro risulta «cancelled».
  Per fermarlo: `gh workflow disable backup-notturno.yml`. Il Worker legge lo stato `disabled_manually` e **non** lo
  riaccende; riattiva soltanto `disabled_inactivity`, lo spegnimento automatico di GitHub dopo 60 giorni senza attività.
- **Se fallisce** il job `avviso` apre una segnalazione nel repository (etichetta `backup-notturno`, corpo
  pubblico: solo il link al giro) e manda un'email ai `SENTINELLA_DESTINATARI`.
  Se il workflow **non parte**, il Worker manda subito l'email «Backup notturno NON partito» (il secondo canale:
  Resend, senza passare da GitHub); dopo 30 ore senza un giro automatico riuscito il campanello apre `[backup-vecchio]`.
- **Come si ripristina** e cosa serve (chiave age, password crypt, token di lettura, segreti dei cron da
  rimettere nel Vault): `docs/runbook-ripristino.md`.
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

### Monitor esterno — Worker di Cloudflare (`monitor-esterno/`), dal 19/10/2026

I cron di GitHub **non sono affidabili**: misurato il 09/10/2026, il campanello programmato «ogni 15 minuti» è partito 12
volte in due giorni e mezzo, una ogni 3,5–7,5 ore. Un sito fermo poteva restare senza allarme per ore.

**Scelta del titolare (19/10):** niente account nuovi (Better Stack), si usa l'account **Cloudflare** che c'è già (lo
stesso di R2). Un Worker, `kidville-monitor-esterno`, gira con il **cron di Cloudflare** (puntuale) ogni 5 minuti:

1. legge **`https://app.kidville.it/api/health/vivo`**, due tentativi a 20 secondi, 10 secondi di tempo massimo;
2. se il vivo **non** risponde 200, fa partire **subito** `campanello.yml` (`workflow_dispatch`, input
   `origine=cloudflare`), che ricontrolla con i suoi tre tentativi, apre la segnalazione e manda l'email;
3. ogni quarto d'ora (:00, :15, :30, :45) lo fa partire **comunque**: è il **battito** che dà al campanello il ritmo che
   il suo `cron` non rispetta.
4. alle **02:23 UTC** (secondo cron) fa partire `backup-notturno.yml`; se GitHub rifiuta, manda l'email «Backup
   notturno NON partito». Se il sito è giù **e** il campanello non parte, manda l'email «Sito giù e campanello NON
   partito», una per ora. È il **secondo canale**: quando è GitHub a rifiutare, l'allarme del campanello non parte.

Il Worker non duplica l'allarme (segnalazione, email, chiusura da sola restano del campanello): lo fa **suonare in
tempo**. Non ha un indirizzo pubblico (`workers_dev = false`) e non legge dati delle famiglie.

**Chi sorveglia il sorvegliante.** I giri partiti da Cloudflare hanno il titolo «Campanello (da Cloudflare)». Ogni giro
del campanello che **non** parte da lì (il `cron` di GitHub, un giro a mano) guarda quando è arrivato l'ultimo battito:
oltre **90 minuti** (sei battiti mancati) apre `monitor-esterno-muto`. Il Worker spento, il token scaduto o Cloudflare
fermo diventano un allarme, non un silenzio.

**I segreti** sono tre, nei segreti del Worker (mai nel repository, che è pubblico): `GITHUB_TOKEN_CAMPANELLO`, un
token GitHub **a grana fine** limitato a `kidville-web` e al solo permesso **Actions: read and write**, più
`RESEND_API_KEY` e `SENTINELLA_DESTINATARI`, gli stessi del campanello. Li mette il titolare:
`pbpaste | npx wrangler@4.148.0 secret put <NOME>`. Se mancano quelli di Resend, il Worker lo scrive in
`console.error` e va avanti. Il token scade: la data è scritta qui sotto e in `00 CONTESTO/04_scadenze.md` del brain.
Alla scadenza si genera un token nuovo con gli stessi limiti e lo si rimette con
`pbpaste | npx wrangler@4.148.0 secret put GITHUB_TOKEN_CAMPANELLO`.

- **Acceso il 20/10/2026**: primo battito «Campanello (da Cloudflare)» alle 11:00:13 UTC, riuscito.
- **Token in uso**: «campanello cloudflare», creato il **20/10/2026**, **scade il 20/10/2027**. GitHub gli aggiunge da
  solo *Metadata: read-only*, obbligatorio per ogni token a grana fine. Il primo segnale della scadenza è
  `monitor-esterno-muto`, con `401 Bad credentials` nei log del Worker.
- **Il sottodominio `workers.dev`** (`kidville`, creato il 20/10/2026). Il cron di Cloudflare lo pretende sull'account
  anche se il Worker non lo usa (`workers_dev = false`): senza, `wrangler deploy` carica lo script e poi fallisce sui
  cron con l'errore **10063**. Aprire la pagina «Workers & Pages» della dashboard, come suggerisce il messaggio, non
  l'aveva creato. Si crea una volta per account con l'API
  (`PUT /accounts/<id>/workers/subdomain`, corpo `{"subdomain":"kidville"}`, con l'accesso di `wrangler login`).
  Il Worker resta comunque senza indirizzo pubblico.

| Cosa | Comando (dalla cartella `monitor-esterno/`) |
|---|---|
| pubblicare / aggiornare | `npx wrangler@4.148.0 deploy` |
| leggere i giri | `npx wrangler@4.148.0 tail` (oppure il pannello: Workers → `kidville-monitor-esterno` → Logs) |
| spegnere | `npx wrangler@4.148.0 delete` (poi il campanello aprirà `monitor-esterno-muto`, ed è giusto) |
| mettere i segreti dell'email (lo fa il titolare) | `pbpaste \| npx wrangler@4.148.0 secret put RESEND_API_KEY`, poi lo stesso per `SENTINELLA_DESTINATARI` |
| provare l'email del secondo canale | in locale, vedi «Prova del secondo canale» qui sotto |

Si prova con `__tests__/lib/monitor-esterno.test.ts` (fetch finto, numeri letterali). Il monitor lancia il backup ma
non ne guarda l'esito: l'età dell'ultimo giro riuscito la guarda `campanello.yml`.

**Prova del secondo canale (in locale, la fa il titolare).** Dopo le 03:00 UTC, perché la chiave d'idempotenza è
una per giorno UTC e la prova non deve consumare quella della notte. Nella cartella `monitor-esterno/` il titolare
crea `.dev.vars` (ignorato da git) con tre righe: `GITHUB_TOKEN_CAMPANELLO=finto-per-la-prova`, `RESEND_API_KEY=` e
`SENTINELLA_DESTINATARI=` con i valori del campanello. Poi:
```bash
git check-ignore -q .dev.vars && echo "ignorato: ok"
npx wrangler@4.148.0 dev --test-scheduled
# in un secondo terminale:
curl -s "http://localhost:8787/__scheduled?cron=23+2+*+*+*"
# dopo: Ctrl-C su wrangler dev, poi
rm .dev.vars
```
Atteso nei log di `wrangler dev`: `monitor-backup: esito=fallito … HTTP 401 {"message":"Bad credentials"…}` e
`monitor-email: esito=accettata chiave=kidville-backup-non-partito-<oggi> HTTP 200`; l'email arriva ai destinatari.

### `campanello.yml` — ogni ~15 minuti (il battito di Cloudflare), con il `cron` di GitHub come rinforzo

Guarda quattro cose; se una non va **apre una segnalazione** nel repository (etichetta `campanello`, titolo
`[chiave] testo`, corpo pubblico: solo ciò che gli endpoint di salute già espongono) e **manda un'email** (Resend, ai
`SENTINELLA_DESTINATARI`); quando il problema rientra **chiude la segnalazione da sola**.

- **Il vivo**, tre tentativi a 15 secondi: uno scatto isolato non sveglia nessuno. Incidente `app-giu`.
- **La salute**, due letture a 45 secondi: conta solo ciò che c'è in entrambe. Un incidente per controllo
  (`salute:<nome>`): un cron muto e una variabile sparita svegliano persone diverse.
- **Il backup**: l'ultimo giro **automatico** riuscito di `backup-notturno.yml`; oltre **30 ore** (o nessuno) →
  `backup-vecchio`. È l'unico modo di accorgersi che il backup **non è partito**: GitHub avvisa solo di un giro che
  parte e fallisce. Perché 30 e non 26: il primo giro programmato (06/10) è partito alle 09:08 UTC invece che alle
  02:23, **6 ore e 45 minuti di ritardo**; con 26 ore sarebbe suonato per un ritardo di due ore.
  Quali giri contano: lo `schedule` e il lancio delle 02:23 del monitor esterno («Backup notturno completo (da
  Cloudflare)»). Un giro lanciato a mano no, nemmeno se completo: la copia che conta è quella che parte da sola.
  Perché da GitHub e non dall'app: GitHub è l'unico che sa la
  verità, ha già un token, e chiederlo da Vercel (indirizzi condivisi) sarebbe a 60 richieste l'ora.
- **Il monitor esterno**: un giro partito da Cloudflare è la prova che il monitor è vivo; gli altri guardano l'ultimo
  battito, e oltre **90 minuti** (o nessuno) → `monitor-esterno-muto`. Vedi la sezione qui sopra.
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
| `[backup-vecchio]` | l'ultimo giro **automatico** riuscito del backup (lo `schedule` o «Backup notturno completo (da Cloudflare)») è più vecchio di 30 ore, o non c'è | i giri di `backup-notturno.yml` (`gh run list --workflow backup-notturno.yml`) e `docs/runbook-ripristino.md`. Un giro **manuale** `completo` fa il backup ma non spegne l'allarme: aspetta il primo giro automatico |
| `[monitor-esterno-muto]` | da oltre 90 minuti non arriva un giro del campanello partito da Cloudflare | il Worker `kidville-monitor-esterno` nel pannello di Cloudflare (Logs): un `401 Bad credentials` vuol dire token GitHub scaduto (vedi «Monitor esterno»); un Worker sparito si ripubblica con `npx wrangler@4.148.0 deploy` |
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

## Bordo pubblico: cache della CDN, firewall, errori, login, build (sessione 13)

Le porte anonime dell'app sono le voci di `PUBBLICHE` in `__tests__/architecture/gate-coverage.test.ts` (23 il
20/10, 23 il 25/10). Sono il modulo d'iscrizione (`/api/iscrizione/*`), i moduli pubblici (`/api/public/*`,
`/api/forms/submit`), la salute (`/api/health*`) e poche altre. Qui sotto:
- come si legge la cache della CDN;
- le regole del firewall di Vercel (da creare dopo il merge: **non sono attive**);
- cosa risponde una porta anonima quando qualcosa si rompe;
- come si contano i login falliti, e i limiti di Auth;
- la build.

Le misure del 25/10/2026 sono quelle del Passo 0 del piano
(`docs/superpowers/plans/2026-10-20-robustezza2-s13-bordo-pubblico.md`), prese in sola lettura. Mai un IP, mai un
JA4, mai un nome: solo conteggi, codici, percorsi e famiglie di user agent.

### Cache della CDN (S8)

- **Chi la chiede.** `src/lib/security/cache-pubblica.ts` (`intestazioniCachePubblica`), usata da:
  - `/api/iscrizione/sedi`: 10 minuti (più 1 ora servita stantia mentre si rinnova);
  - `/api/iscrizione/model`: 5 minuti (più 10 minuti);
  - `/api/anagrafiche/comuni`: 24 ore (più 7 giorni).

  Solo sulla risposta buona, e solo senza il cookie di sessione `sb-*-auth-token` (anche spezzato in `.0`, `.1`, …).
  Con il cookie la risposta è `private`. Il cookie della protezione delle anteprime (`_vercel_jwt`) non è una sessione.
- **Cosa manda** (dalla prova 1, commit `9a8b5426`, che entra con la PR della sessione 13).
  - Senza sessione: `Cache-Control: public, max-age=N, s-maxage=N, stale-while-revalidate=M`,
    `Vercel-CDN-Cache-Control: max-age=N, stale-while-revalidate=M` e `Vary: Cookie`.
  - Con sessione: `Cache-Control: private, max-age=N, stale-while-revalidate=M` e `Vary: Cookie`, e nessuna
    intestazione per una CDN.
- **Chi controlla la strada con sessione.** Solo `__tests__/lib/cache-pubblica.test.ts`. I test delle tre route
  restano verdi se sulla strada con sessione compare `Vercel-CDN-Cache-Control`, `CDN-Cache-Control` o
  `Surrogate-Control` (tre mutazioni provate il 25/10: rosso solo quel file). Chi cambia la funzione lancia quel test.
- **Come si legge.** Due richieste di fila, e `x-vercel-cache` della seconda. `s-maxage` non arriva al client
  (lo consuma la CDN): che manchi non prova niente.
  ```bash
  for i in 1 2; do
    curl -s -o /dev/null -A 'kidville-misura' -D - https://app.kidville.it/api/iscrizione/sedi \
      | grep -iE '^(x-vercel-cache|cache-control|vary|age):'
    sleep 2
  done
  ```
  - Atteso: `x-vercel-cache: HIT`, con `age` > 0, alla seconda.
  - Mai più di qualche richiesta: il 20/10 la 24ª di fila di un client di prova ha preso una sfida `403`.
  - Mai `vercel curl`: crea da solo un token di bypass della protezione.
  - La cache è per regione e per deployment: dopo ogni deploy la prima richiesta è un `MISS`.
- **Prima:** il 20/10, `MISS` 23 su 23 alle 12:34 UTC e 2 su 2 alle 13:19. Il 25/10/2026 alle 10:43:02–10:43:07 UTC
  (Passo 0.2, 2 richieste, senza la prova 1): `MISS` e `MISS`, `age: 0`, con `cache-control: public, max-age=600` e
  `vary: Cookie`. S8 non si era risolto da sé.
- **Ramo R.** L'anteprima non si poteva misurare: il link di condivisione lo crea solo il titolare, assente il 25/10
  (le variabili del database nell'ambiente Preview ci sono). Scelta dell'assistente in assenza del titolare, da
  confermare: nessun link chiesto. Entra la sola prova 1 (`Vercel-CDN-Cache-Control`); la misura si fa in produzione su
  `/api/iscrizione/sedi`, con 2 richieste, dopo il merge. Se la prova 1 non basta, S8 resta aperto e la prova 2 (piano,
  Compito 14, ramo B) la decide il titolare, col motivo dei Runtime Logs davanti. Esito: da completare con la misura di
  produzione dopo il merge.
- **Dopo il deploy:** in attesa. Le righe `x-vercel-cache` di `/api/iscrizione/sedi` (nel ramo R l'unica rotta
  misurata), con data e ora UTC, le scrive la chiusura della sessione 13.

### Firewall di Vercel (T8)

**Non attive.** Cinque regole da creare dopo il merge della sessione 13, tutte in modalità «log», e solo con
l'approvazione esplicita del titolare, in chat. Il 25/10/2026 non ne esiste nessuna: le pubblica il titolare dal
pannello, oppure una sessione col suo sì. In «log» la regola conta e non blocca niente. Chiave del limite: l'IP.
Finestra: 60 secondi.

| Nome | Condizione | Azione | Soglia |
|---|---|---|---|
| `s13-salute-monitor` | percorso che inizia con `/api/health` **e** user agent `kidville-monitor-esterno`, **oppure** percorso che inizia con `/api/health` **e** user agent `kidville-campanello` | bypass, **prima** di tutte | nessuna |
| `s13-iscrizione-limite` | percorso che inizia con `/api/iscrizione` | limite di frequenza, «log» | 60 / 60 s |
| `s13-forms-limite` | percorso che inizia con `/api/forms` | limite di frequenza, «log» | 120 / 60 s |
| `s13-public-limite` | percorso che inizia con `/api/public` | limite di frequenza, «log» | 60 / 60 s |
| `s13-salute-limite` | percorso che inizia con `/api/health` | limite di frequenza, «log» | 30 / 60 s |

- **Perché le soglie sono queste.**
  - `/api/health` ha già un tetto per istanza di 30/60 s per IP (`TETTO_PER_IP` in `src/lib/health/porta.ts`).
  - `/api/forms` serve anche la segreteria, che da un ufficio esce con un solo IP.
  - Il volume delle 24 ore dal 24/10 10:00 al 25/10 11:00 UTC (Passo 0.6; 45.788 richieste lasciate passare in
    tutto):
    - `/api/iscrizione/sedi` 147, l'unico percorso del prefisso `/api/iscrizione` fra le prime 100 voci;
    - `/api/health*` 512;
    - `/api/forms*` e `/api/public*`: nessun loro percorso fra le prime 100 voci, e la 100ª ne ha 60. Quindi ogni
      percorso sotto quei prefissi ha al più 60 richieste in 24 ore; la somma per prefisso non è stata letta.
- **L'eccezione del monitor.**
  - Copre il Worker `monitor-esterno` (user agent `kidville-monitor-esterno`, `monitor-esterno/worker.mjs`) e il
    campanello (`kidville-campanello`, `scripts/campanello/lettura.mjs`), che leggono `/api/health/vivo` e
    `/api/health`.
  - Il 25/10 (24 ore, Passo 0.5): `/api/health` 108 richieste, tutte del campanello; `/api/health/vivo` 404, di cui
    290 del monitor esterno e 110 del campanello; `/api/health/qualita` nessuna. Nessun altro chiamante automatico
    sopra una richiesta al minuto.
  - Un user agent si può falsificare: l'eccezione vale solo sui percorsi `/api/health*`, che hanno comunque il
    tetto per istanza.
- **L'app nativa non ha un user agent suo.** `capacitor.config.ts` non usa `appendUserAgent`. In una WebView Android
  l'user agent contiene `; wv)`; in iOS manca `Safari/`. È così che la si riconosce nel registro.
- **Prima:** nelle 24 ore fino al 25/10 11:00 UTC (Passo 0.3), 1 sfida (`challenge`), sul percorso `/`, famiglia
  «Chrome su Windows»; 1 `deny`.
- **Come si creano** (dopo il merge; si preparano senza pubblicare, poi si pubblicano solo dopo un sì esplicito del
  titolare). La CLI è fissata a `npx vercel@64.7.0`: quella installata non ha `firewall traffic`. Un'opzione che la
  CLI rifiuta si sostituisce con quella del suo aiuto (`firewall rules add --help`). Lo stesso si può fare dal pannello
  (Firewall → Rules).
  ```bash
  V='npx vercel@64.7.0 --cwd /Users/lerri/kidville-web'
  eval "$V firewall rules add 's13-salute-monitor' \
    --condition '{\"type\":\"path\",\"op\":\"pre\",\"value\":\"/api/health\"}' \
    --condition '{\"type\":\"user_agent\",\"op\":\"eq\",\"value\":\"kidville-monitor-esterno\"}' \
    --or \
    --condition '{\"type\":\"path\",\"op\":\"pre\",\"value\":\"/api/health\"}' \
    --condition '{\"type\":\"user_agent\",\"op\":\"eq\",\"value\":\"kidville-campanello\"}' \
    --action bypass --description 'Sessione 13: monitor esterno e campanello fuori dai limiti di /api/health' --yes"
  for coppia in 'iscrizione:/api/iscrizione:60' 'forms:/api/forms:120' 'public:/api/public:60' 'salute:/api/health:30'; do
    nome="${coppia%%:*}"; resto="${coppia#*:}"; percorso="${resto%%:*}"; soglia="${resto##*:}"
    eval "$V firewall rules add 's13-$nome-limite' \
      --condition '{\"type\":\"path\",\"op\":\"pre\",\"value\":\"$percorso\"}' \
      --action rate_limit --rate-limit-window 60 --rate-limit-requests $soglia \
      --rate-limit-keys ip --rate-limit-action log \
      --description 'Sessione 13: limite in log per 7 giorni' --yes"
  done
  eval "$V firewall rules reorder 's13-salute-monitor' --first --yes"
  eval "$V firewall diff"
  ```
  - Atteso: `firewall diff` mostra 5 regole nuove, `s13-salute-monitor` in cima, tutte le `-limite` con azione `log`.
  - Al titolare si mostrano l'uscita di `firewall diff` e la tabella qui sopra. Solo dopo il suo sì, in chat:
    `npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall publish --yes`, poi `… firewall rules list --expand`
    (si annotano gli id e l'ora UTC: da lì partono i 7 giorni).
  - Senza un sì: `npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall discard --yes`, e niente issue delle
    letture.
- **Come si leggono.** Il registro sul piano Pro tiene solo le ultime 24 ore, quindi si legge ogni giorno:
  ```bash
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules list --json
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic inspect rule <id della regola> --since 24h --group-by user-agent
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic inspect rule <id della regola> --since 24h --group-by asn
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic list --since 24h --action challenge --dimension path
  ```
  Si scrivono conteggi, famiglie di user agent e nomi di ASN. Mai un IP, mai un JA4. `traffic list` mostra al più
  100 voci (`--top` arriva a 100).
- **Quando si passa dal «log» al blocco.** Mai prima di 7 letture, e solo su decisione del titolare con i numeri
  davanti (specifica, §8, punto 17). Per ogni regola:
  - 0 eventi in 7 giorni: resta in «log», non c'è niente da fermare;
  - eventi solo da client non-browser o da reti di datacenter, nessuno con l'user agent dell'app nativa: si
    propone il passaggio a 429 (`rate_limit`), non a `deny`;
  - anche un solo evento dall'app nativa o da un browser mobile: si alza la soglia e si fanno altri 7 giorni
    di «log».
- **Letture:** in attesa. Le regole, se il titolare dice sì, si pubblicano dopo il merge, e da lì partono 7 letture
  giornaliere in un'issue: numero dell'issue, giorni, tabella e decisione li scrive la chiusura della sessione 13.
- **Come si spengono.** Dal pannello (Firewall → Rules → l'interruttore della regola), oppure:
  ```bash
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules disable "<nome>" --yes
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall publish --yes
  ```
  Se `disable` non compare nell'aiuto, si usa `rules edit … --disabled`. Una regola passata a 429 che ferma l'app
  nativa si riporta a «log» nello stesso modo, subito, prima di capire perché.

### Errori sulle porte anonime (S10)

- Una porta anonima non risponde mai con il testo di un errore. Le risposte possibili:
  - un guasto del database: `rispostaGuastoDb` / `rispostaGuastoGiaRegistrato` (`src/lib/db/guasto.ts`),
    `LETTURA_FALLITA` o `SCRITTURA_FALLITA`;
  - un'eccezione: `rispostaErroreInterno` / `rispostaErroreInternoGiaRegistrato`
    (`src/lib/api/errore-interno.ts`), 500 `ERRORE_INTERNO`.

  L'errore intero sta nel log, sotto la sua `operazione`: per esempio `iscrizione:POST` o `forms/submit:POST`. Le
  varianti «già registrato» danno la stessa risposta senza una seconda riga, quando l'ha già scritta chi chiama con
  un `esito` più preciso. I codici sono in `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`), tradotti in
  `messages/it/shared.json` e `messages/en/shared.json`.
- Il lock `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts` legge le porte da `PUBBLICHE` e vieta
  `.message` nelle loro risposte. Non vede una destrutturazione (`const { message } = err`), un `message` passato da
  una funzione definita fuori dal handler, un oggetto d'errore intero nel corpo.
- Il 20/10 le risposte con `.message` sulle porte anonime erano 9, in 4 handler; dopo la sessione 13 sono 0.
- Le route autenticate non sono coperte. Con lo stesso lettore, contate il 25/10: 319 risposte con `.message` sul
  `main` del 20/10 (`4c6df438`, 210 handler), 317 alla base del lotto 2, **313** dopo la sessione 13 (206 handler in
  135 file), che toglie quelle di `notes` (GET e POST), `parent/competenze:GET` e `admin/competenze/download:GET`.
  Si sistemano quando una sessione tocca il loro file.

### Login falliti (T9) e limiti di Auth (S11a)

- Il login chiama Auth dal browser (`signInWithPassword` in `src/app/auth/login/page.tsx`). Niente Turnstile
  (specifica, §8, punto 17), e il login non si sposta sul server (punto 12).
- Questa è la ricetta per contare i tentativi falliti a ogni misura. Strumento: `query_logs` di Supabase (o il
  Logs Explorer). Finestra: 24 ore di un giorno feriale; per più giorni si ripete un giorno alla volta.
  1. Le chiavi esistono? Una volta per fonte (`edge_logs`, poi `auth_logs`):
     ```sql
     select distinct arrayJoin(mapKeys(log_attributes)) as chiave
     from logs where source = 'edge_logs' order by chiave limit 300
     ```
  2. I login con password, per esito:
     ```sql
     select toString(log_attributes['response.status_code']) as stato, count(*) as n,
            uniq(toString(log_attributes['request.headers.cf_connecting_ip'])) as ip_distinti
     from logs where source = 'edge_logs'
       and toString(log_attributes['request.path']) = '/auth/v1/token'
       and toString(log_attributes['request.search']) like '%grant_type=password%'
     group by stato order by n desc
     ```
     - `200` sono i riusciti, `400` le credenziali sbagliate, `429` il limite di Auth scattato.
     - `ip_distinti` è un conteggio: gli indirizzi non escono dalla query.
  3. Il riscontro sui log di Auth:
     ```sql
     select toString(log_attributes['error_code']) as codice, count(*) as n
     from logs where source = 'auth_logs' and toString(log_attributes['path']) = '/token'
     group by codice order by n desc
     ```
- Se una chiave ha un altro nome, si usa quello che esiste. Passo 0.7 della sessione 13, 25/10/2026: nessuna
  differenza. In `edge_logs` ci sono `request.path`, `request.search`, `response.status_code`,
  `request.headers.cf_connecting_ip`, `request.headers.x_client_info`, `response.origin_time`, `request.cf.colo`; in
  `auth_logs` ci sono `path` ed `error_code`.
- **I limiti di Auth in produzione.** Non sono nel repository: `supabase/config.toml` vale solo per il Supabase
  locale. Li legge il titolare in Supabase → Authentication → Rate Limits. Il 25/10/2026 non sono stati letti (il
  titolare era assente): la colonna «Produzione» resta n.d. finché non li scrive lui.

  | Limite | Finestra | Locale (`config.toml`) | Produzione |
  |---|---|---|---|
  | `email_sent` | 1 h | 2 | n.d. — li legge il titolare |
  | `sms_sent` | 1 h | 30 | n.d. — li legge il titolare |
  | `anonymous_users` | 1 h per IP | 30 | n.d. — li legge il titolare |
  | `token_refresh` | 5 min per IP | 150 | n.d. — li legge il titolare |
  | `sign_in_sign_ups` | 5 min per IP | 30 | n.d. — li legge il titolare |
  | `token_verifications` | 5 min per IP | 30 | n.d. — li legge il titolare |

  Si rileggono a ogni misura di controllo. Un valore letto o cambiato si scrive qui, con la data.

### Build (S12)

- `npm run build` passa a Node `--max-old-space-size=6144`, lo stesso valore di `.github/workflows/ci.yml`.
- Chi ha bisogno di più memoria lancia `NODE_OPTIONS=--max-old-space-size=8192 npm run build`: l'opzione di chi
  lancia viene dopo, e vince.
- Il lock `__tests__/architecture/build-heap-come-in-ci.test.ts` tiene allineati i due valori.

---

## Cron di produzione (pg_cron, dentro Supabase)

Le schedulazioni **non** usano Vercel Cron: girano in Postgres (`pg_cron` + `pg_net`) e chiamano gli endpoint
applicativi via `net.http_post`. Indirizzi e segreto li leggono con `public.cron_config('<nome>')`, che guarda
**prima il Vault** di Supabase e poi le impostazioni del database. In produzione stanno nel **Vault**:
`ALTER DATABASE … SET` su Supabase è negato (`42501`), e la vecchia ricetta con i GUC non funziona più.

Su un progetto nuovo si rimettono dal SQL editor, una riga per nome, con il valore scritto solo lì:

```sql
select vault.create_secret('<valore>', '<nome>');
```

L'elenco dei sei nomi e dei loro valori è nello scenario E di `docs/runbook-ripristino.md` (passo 6). Si controlla
senza leggere i valori con `select name from vault.secrets order by name;`.

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
