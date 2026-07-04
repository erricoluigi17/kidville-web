# CI/CD — GitHub Actions + Vercel

Pipeline di produzione per Kidville Web.

- **CI** (gate di qualità) → **GitHub Actions**
- **CD** (deploy) → **Vercel** (auto: Preview su ogni PR, Produzione al merge su `main`)
- **Migrazioni DB** → **GitHub Actions** (`migrate.yml`), modello additivo, dietro approvazione manuale
- **Cron** → **pg_cron dentro Supabase** (non Vercel Cron): schedulazioni in `supabase/migrations/*_cron.sql`

```
PR ──► GitHub Actions (CI)                    Vercel
       ├ quality: eslint + tsc + vitest        └► Preview Deployment (URL per PR)
       └ e2e: Playwright su Supabase CI
       branch protection: merge BLOCCATO finché CI non è verde
                    │
   merge su main ───┼──► Vercel: deploy PRODUZIONE (auto)
                    └──► Actions migrate.yml: supabase db push (approvazione manuale)
```

Solo codice verde arriva su `main`, quindi Vercel non pubblica mai una regressione.

---

## ⚠️ Prerequisito (una tantum): baseline dello storico migrazioni

Lo storico è **disallineato**: i primi ~50 file di `supabase/migrations/` sono stati
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
4. **Verifica**: `supabase db push --dry-run` deve dire **"no pending migrations"**.

Solo dopo che il dry-run è pulito, `migrate.yml` è sicuro da attivare.

---

## Setup GitHub

### Secrets (Settings → Secrets and variables → Actions)

| Secret | Cosa | Dove si usa |
|---|---|---|
| `CI_SUPABASE_URL` | URL del **progetto Supabase CI dedicato** (non prod) | job `e2e` |
| `CI_SUPABASE_ANON_KEY` | anon key del progetto CI | job `e2e` |
| `CI_SUPABASE_SERVICE_ROLE_KEY` | service-role del progetto CI (usata dal seed) | job `e2e` |
| `PROD_SUPABASE_DB_URL` | connection string del DB **di produzione** | `migrate.yml` |

> Il progetto CI è un secondo progetto Supabase (gratis sul free tier). La E2E ci semina
> la scuola dedicata `e2e00000-*` in modo idempotente. **Mai** usare il progetto di produzione.

### Branch protection (Settings → Branches → `main`)

- Require a pull request before merging
- Require status checks to pass → seleziona **`Lint · Typecheck · Unit`** e **`E2E (Playwright)`**
- (consigliato) Require branches to be up to date before merging

### Environment `production` (Settings → Environments)

- Crea l'environment `production`
- Abilita **Required reviewers** (te stesso) → `migrate.yml` attende la tua approvazione
  prima di applicare migrazioni al DB di produzione.

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
`genera-solleciti` (ogni 6h).

---

## Funzionamento quotidiano

1. Apri una PR → parte la CI; Vercel crea una Preview.
2. CI verde → puoi fare merge (la protection lo impedisce se rossa).
3. Merge su `main` → Vercel pubblica in produzione; se la PR toccava `supabase/migrations/**`,
   `migrate.yml` si mette in attesa della tua approvazione, poi applica le migrazioni.

### Rollback

Deploy di produzione andato male → **Vercel → Deployments → Instant Rollback** al deploy precedente
(un click). Le migrazioni, essendo additive, non vanno annullate per un rollback del solo codice.
