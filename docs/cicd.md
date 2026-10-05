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
