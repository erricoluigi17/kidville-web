# Sessione 2 — Via `exec_sql` e freno sulle istruzioni distruttive — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** nessun ruolo dell'app può più far eseguire SQL qualsiasi al database (e quindi accendere `registri.manutenzione`, `scatola_nera.manutenzione`, `scatola_nera.senza_storico`), e un agente non può più lanciare da solo un'istruzione distruttiva sul database di produzione.

**Architettura:** una migrazione toglie `public.exec_sql(text)` e un lock nuovo impedisce che torni; escono dal repo le sei route sigillate e i sei file che la chiamavano o la ricreavano, e i lock che li elencavano vengono allineati. Un hook `PreToolUse` in Python, `.claude/hooks/supabase_sql_freno.py`, legge la query degli strumenti SQL di Supabase e risponde `deny` (mai `ask`) alle istruzioni distruttive e a ogni `apply_migration`; le istruzioni per gli agenti dicono che la migrazione la applica l'integrazione al merge e che il merge lo fa il titolare.

**Tecnologie:** Python 3 (solo libreria standard) per il freno · hook `PreToolUse` di Claude Code · Vitest con `node:child_process` · migrazione SQL Postgres/Supabase · `gh`.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 2 — Via `exec_sql` e freno sulle istruzioni distruttive» (con le regole comuni della §5 — in particolare «La tabella di stato», «Apertura di una sessione: i prerequisiti» e «… la chiusura della precedente» —, il formato della §6 e il divieto 18 della §8).

---

## Convenzioni di questo piano

Alcuni valori esistono solo il giorno in cui si esegue. Nel piano compaiono come **gettoni** fra due chiocciole, e chi esegue li sostituisce col valore vero **nel momento in cui scrive quel testo**:

| Gettone | Valore | Da dove viene |
|---|---|---|
| `@GIORNO@` | data UTC, forma `AAAA-MM-GG` | `date -u +%F` il giorno in cui si scrive il testo |
| `@VERSIONE@` | le 14 cifre della migrazione | `date -u +%Y%m%d%H%M%S` al Compito 6, passo 3 (mai un orario tondo) |
| `@N_ISCRIZIONI@`, `@ORA_CONTEGGIO@` | conteggio e ora UTC | Passo 0, misura 0.1 |
| `@TRACK_FUNCTIONS@`, `@CHIAMATE_FUNZIONE@` | impostazione e numero | Passo 0, misura 0.4 |
| `@CHIAMATE_STATEMENTS@` | righe per ruolo | Passo 0, misura 0.5 |
| `@PR@` | numero della PR della sessione | «Rilascio», passo 3 |
| `@AGGIUNTE_FRENO@` | le risposte del titolare alle aggiunte A-D, forma `A sì, B sì, C sì, D no` | Compito 1, passo 5 |

Prima di ogni commit: `git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'` → **nessuna riga**. Un gettone rimasto in un file committato è un difetto.

Le misure del Passo 0 si annotano, man mano, in `/tmp/kidville-s02-misure.txt` (fuori dal repo; solo numeri, date, codici e nomi di tabelle o funzioni).

---

## Mappa dei file

Percorsi e righe letti il 20/10 nel worktree `/Users/lerri/kidville-web-analisi-2026-10-20` (stesso commit di `origin/main`, `4c6df438`).

| File | Azione | Ruolo |
|---|---|---|
| `.claude/hooks/supabase_sql_freno.py` | Crea | il freno: legge la query, risponde `deny` o tace |
| `__tests__/architecture/freno-sql-distruttivo.test.ts` | Crea | prova lo script vero (casi fermati e lasciati passare), la registrazione e le istruzioni degli agenti |
| `__tests__/architecture/niente-sql-arbitrario.test.ts` | Crea | lock: nessuna chiamata a `exec_sql`/`/pg/query` in `src/`, `scripts/`, radice; nessuna funzione SECURITY DEFINER con un argomento SQL nelle migrazioni dopo il baseline |
| `supabase/migrations/@VERSIONE@_via_exec_sql.sql` | Crea | `DROP FUNCTION IF EXISTS public.exec_sql(text)` |
| `.claude/hooks/supabase_sql_gate.sh` (65 righe) | Elimina | il gate vecchio, mai più registrato dal 2026-09-03; rispondeva `allow`/`ask` |
| `.claude/settings.json:157-169` | Modifica | `hooks.PreToolUse`: oggi solo `ExitPlanMode`; si aggiunge la voce del freno |
| `src/app/api/admin/apply-migration/route.ts` (88) | Elimina | `rpc('exec_sql')` riga 37 |
| `src/app/api/admin/apply-enrollment-migration/route.ts` (254) | Elimina | `fetch` a `/rest/v1/rpc/exec_sql` (29, 61) e `/pg/query` (75, 189); **ricrea** `exec_sql` (funzione alle righe 45-90, `CREATE OR REPLACE` alla 48) |
| `src/app/api/admin/apply-forms-migration/route.ts` (100) | Elimina | `rpc('exec_sql')` riga 71 |
| `src/app/api/admin/apply-fase4-migration/route.ts` (144) | Elimina | `rpc('exec_sql')` riga 109 |
| `src/app/api/admin/apply-mensa-multi-menu-migration/route.ts` (167) | Elimina | `rpc('exec_sql')` riga 131 |
| `src/app/api/admin/setup-registro/route.ts` (181) | Elimina | sette `rpc('exec_sql')` (51-156) |
| `scripts/apply_pagamenti_migrations.mjs` (77) | Elimina | `rpc('exec_sql')` riga 56 |
| `scripts/apply_settings_hub_migration.mjs` (66) | Elimina | `rpc('exec_sql')` riga 41 |
| `scripts/apply_segreteria_migrations.mjs` (69) | Elimina | `rpc('exec_sql')` righe 47, 58 |
| `scripts/apply-enrollment-migration.mjs` (106) | Elimina | ricrea `exec_sql` via `DATABASE_URL` (riga 19) |
| `scripts/backfill_presenze_scuola.mjs` (100) | Elimina | `rpc('exec_sql')` riga 83 (backfill applicato il 2026-07-03, `docs/acceptance.md:38-41`) |
| `seed_sql.mjs` (8, radice) | Elimina | `rpc('exec_sql')` riga 5 |
| `__tests__/architecture/supabase-client-strumentato.test.ts:110-117` | Modifica | togliere la deroga `FETCH_VERSO_SUPABASE` della route cancellata (il lock la pretende tolta: «deroga su un file che non esiste più») |
| `__tests__/lib/logging-tetto.test.ts:275-278, 293-300` | Modifica | togliere la voce `FETCH_SENZA_TETTO` della route cancellata; aggiornare il commento |
| `__tests__/architecture/isolamento-sede-coverage.test.ts:1119, 1121-1124, 2527-2530, 2822-2825, 3196-3200` | Modifica | togliere 5 voci `AMMESSE`; numeri 363 → 357, 566 → 555, 112 → 107 con il commento datato |
| `__tests__/api/admin-guasti-db-non-diventano-valori.test.ts:113, 243-250` | Modifica | togliere l'import di `setup-registro` e il suo caso |
| `__tests__/architecture/errori-con-codice.test.ts:212-216, 406-411` | Modifica | tetti `MAX_FILE` 270 → 264, `MAX_OCCORRENZE` 1361 → 1350 con il paragrafo 🔻 |
| `docs/superpowers/errori-senza-codice-allowlist.json:19-20, 26-45, 334-337` | Modifica | togliere le 6 voci (11 occorrenze), `totale_occorrenze` 1361 → 1350, `aggiornato` |
| `__tests__/architecture/residuo-odt-assente.test.ts:78-85` | Modifica | solo commento: le route `apply-*` non ci sono più |
| `__tests__/architecture/security-definer-revoke-lock.test.ts:54-57` | Modifica | solo commento; la voce `exec_sql` di `AMMESSE` (riga 62) **resta**: il baseline la crea ancora |
| `.claude/commands/ship-cycle.md:171-172, 322, 347-350` | Modifica | migrazione dall'integrazione al merge; merge del titolare |
| `.claude/agents/esecutore-opus.md:38-42` | Modifica | idem |
| `.claude/rules/migrazioni.md:11-12, 17-18, 44` | Modifica | idem; `supabase db query` solo in sola lettura |
| `README.md:48` | Modifica | le migrazioni non passano più da `scripts/apply_*.mjs` ed `exec_sql` |
| `docs/env.md:97` | Modifica | `DATABASE_URL`: chi la usa davvero oggi |
| `AGENTS.md:99-100` | Modifica | le due eccezioni all'autonomia |
| `CLAUDE.md:99-102` | Modifica | riquadro datato del freno nella sezione «Permessi» |
| `docs/storia-permessi-e-conferme.md` (dopo la riga 387) | Modifica | riquadro datato |
| `PRD REGISTRO ELETTRONICO.md:1` | Modifica | voce di changelog in cima |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | Modifica | la riga `^\| 2 \|` della tabella di stato (riga 26 il 20/10) a «in revisione» nella PR di questa sessione (Rilascio, passo 4); «in produzione» lo scrive la sessione dopo |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` | Modifica | solo nel primo commit, se la chiusura della sessione precedente lo chiede (Compito 1, passo 3); quella con la migrazione di questa sessione la rigenera la sessione dopo («Per la sessione dopo») |

**Non si toccano, e perché:**
- `src/lib/security/seal.ts` (47 righe): è la funzione generica `sealDangerous`, **non ha voci per route**; non c'è niente da togliere.
- `__tests__/api/seal-fail-closed.test.ts:10`: racconta il guasto del 2026-07-31 al passato.
- `supabase/migrations/20260704120000_baseline.sql`: è storia; la funzione la toglie la migrazione nuova.
- `PRD REGISTRO ELETTRONICO.md:10`, `docs/piano-app-100.md`, `docs/audit/*`, `docs/acceptance.md`, i piani vecchi: documenti datati.
- I quattro `scripts/apply_*.mjs` che **non** usano `exec_sql` ma `DATABASE_URL` (`apply_annotazione_numerica.mjs`, `apply_primaria_migrations.mjs`, `apply_primaria_fase2_migrations.mjs`, `apply_usa_pannolino.mjs`) e `scripts/apply-baseline-ci.sh` (lo usa la CI): fuori perimetro, vedi sotto.

## Fuori perimetro, scritto e non sottinteso

- **SQL lanciato da `Bash`**: `psql`, `supabase db query --linked`, `supabase db push --linked`, uno script che parla a Postgres con `DATABASE_URL`. Il freno vede solo gli strumenti MCP del suo `matcher`.
- **Gli altri strumenti MCP di Supabase** (rami, edge function): non eseguono SQL dato dall'agente e restano fuori.
- **Un freno che non parte**: se `python3` manca o l'hook supera il timeout, Claude Code tratta l'errore come non bloccante e la chiamata **passa**. L'opzione che lo impedirebbe (`"onFailure": "block"`) chiede una CLI più nuova della 2.1.259 installata: non si usa.

---

## Passo 0 — misura «prima»

In **sola lettura**, prima del Compito 1. Le query si lanciano con lo strumento MCP `execute_sql` (il freno non è ancora registrato, e comunque le letture passano). Ogni risultato va in `/tmp/kidville-s02-misure.txt` con data e ora UTC (`date -u '+%F %T'`).

- [ ] **0.1 — Conteggio delle iscrizioni (§5, prima di ogni migrazione)**

```sql
SELECT count(*) AS domande,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc
  FROM enrollment_submissions;
```

Diventa `@N_ISCRIZIONI@` e `@ORA_CONTEGGIO@`. Non si confronta con nessun numero scritto altrove.

- [ ] **0.2 — La funzione c'è?**

```sql
SELECT to_regprocedure('public.exec_sql(text)') IS NOT NULL AS esiste;
```

- [ ] **0.3 — Il corpo e i permessi veri (§5: i corpi si prendono dalla produzione)**

```sql
SELECT pg_get_functiondef(p.oid) AS definizione,
       p.proacl::text            AS permessi,
       r.rolname                 AS proprietario,
       p.prosecdef               AS security_definer
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
 WHERE p.oid = to_regprocedure('public.exec_sql(text)');
```

Si confronta con `supabase/migrations/20260704120000_baseline.sql:272-282` (funzione) e `:7808-7809` (permessi).

- [ ] **0.4 — Le chiamate in `pg_stat_user_functions` (la misura chiesta dalla specifica)**

```sql
SELECT current_setting('track_functions') AS track_functions,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS statistiche_dal,
       (SELECT calls FROM pg_stat_user_functions
         WHERE funcid = to_regprocedure('public.exec_sql(text)')::oid) AS chiamate;
```

⚠️ Se `track_functions` vale `none`, `pg_stat_user_functions` è **cieca**: `chiamate` vuoto non vuol dire zero. Si scrive «cieca» in `@CHIAMATE_FUNZIONE@`, mai `0`, e valgono la 0.5 e la 0.12.

- [ ] **0.5 — Chi la chiama, per ruolo, in `pg_stat_statements`**

```sql
SELECT r.rolname AS ruolo, sum(s.calls)::bigint AS chiamate
  FROM extensions.pg_stat_statements s
  JOIN pg_roles r ON r.oid = s.userid
 WHERE s.query ILIKE '%exec_sql%'
   AND s.query NOT ILIKE '%pg_stat_statements%'
 GROUP BY r.rolname
 ORDER BY 2 DESC;
```

Solo ruolo e conteggio, **mai il testo della query** (potrebbe contenere dati). Se risponde `42P01`, l'estensione non è in `extensions`: si scrive «non disponibile».

- [ ] **0.6 — Nessun cron la usa**

```sql
SELECT count(*) AS cron_con_exec_sql FROM cron.job WHERE command ILIKE '%exec_sql%';
```

- [ ] **0.7 — Nessuna funzione o vista la nomina**

```sql
SELECT p.oid::regprocedure::text AS funzione
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.prosrc ILIKE '%exec_sql%'
   AND p.oid <> coalesce(to_regprocedure('public.exec_sql(text)')::oid, 0::oid);

SELECT count(*) AS viste_con_exec_sql FROM pg_views WHERE definition ILIKE '%exec_sql%';
```

- [ ] **0.8 — È l'unica porta per SQL qualsiasi?**

```sql
SELECT p.oid::regprocedure::text AS funzione
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prosecdef
   AND p.proargnames && ARRAY['sql', 'query', 'istruzione']::text[];
```

- [ ] **0.9 — Chi può eseguirla**

```sql
SELECT r.rolname AS ruolo
  FROM pg_roles r
 WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')
   AND has_function_privilege(r.oid, to_regprocedure('public.exec_sql(text)'), 'EXECUTE');
```

- [ ] **0.10 — La fotografia delle migrazioni è aggiornata?**

```sql
SELECT max(version) AS ultima_version FROM supabase_migrations.schema_migrations;
```

e in locale:

```bash
jq -r '.migrazioni | map(.version) | max' /Users/lerri/kidville-web-analisi-2026-10-20/__tests__/fixtures/migrazioni-applicate-snapshot.json
```

Atteso il 20/10: `20261019223123` in tutti e due.

- [ ] **0.11 — Le sei route in `app_log`, ultimi 30 giorni**

```sql
SELECT route, count(*) AS righe, sum(occorrenze) AS occorrenze
  FROM app_log
 WHERE creato_il > now() - interval '30 days'
   AND (route LIKE '/api/admin/apply-%' OR route = '/api/admin/setup-registro')
 GROUP BY route
 ORDER BY route;
```

- [ ] **0.12 — Chiamate HTTP a `/rest/v1/rpc/exec_sql`**

Con lo strumento MCP dei log (servizio `api`): il numero di richieste il cui percorso contiene `/rest/v1/rpc/exec_sql`, con lo stato HTTP, nella finestra che lo strumento restituisce. Si annota anche la finestra (da quando a quando, UTC).

- [ ] **0.13 — La risposta di PostgREST con la chiave pubblicabile**

URL del progetto e chiave **pubblicabile** si leggono con gli strumenti MCP `get_project_url` e `get_publishable_keys` (la chiave pubblicabile non è un segreto, ma non si scrive in nessun file). Il corpo è innocuo anche se la funzione rispondesse.

```bash
URL_PROGETTO='…valore di get_project_url…'
CHIAVE_PUBBLICABILE='…valore di get_publishable_keys…'
curl -sS -X POST "$URL_PROGETTO/rest/v1/rpc/exec_sql" \
  -H "apikey: $CHIAVE_PUBBLICABILE" -H 'Content-Type: application/json' \
  -d '{"sql":"select 1"}' -w '\nHTTP %{http_code}\n'
```

Atteso prima della migrazione: `HTTP 401` con codice `42501` (la funzione c'è, `anon` non può eseguirla). Si annotano stato e codice, non il resto del corpo.

- [ ] **0.14 — Advisor di sicurezza**

Strumento MCP `get_advisors`, tipo `security`: numero di voci `ERROR` e di voci `WARN`.

- [ ] **0.15 — Il Mac che farà girare il freno**

```bash
claude --version
python3 --version
```

Atteso: CLI `2.1.259` o più nuova; Python ≥ 3.8 (il 20/10: 3.9.6).

### Soglie che cambiano il piano

| Misura | Esito | Cosa cambia |
|---|---|---|
| 0.2 | `false` | La funzione non c'è già più. La migrazione si fa lo stesso (`IF EXISTS`, storia del repo allineata); nel PRD si scrive «già assente al @GIORNO@». |
| 0.3 | corpo o permessi diversi dal baseline | Il blocco ROLLBACK della migrazione riporta la definizione **della produzione** (Compito 6, passo 3, variante B), non il rimando al baseline. |
| 0.4 / 0.5 / 0.12 | chiamate da ruoli diversi da `postgres` | Qualcuno la chiama da fuori dal repo. Non ferma il piano (è l'effetto voluto, §7 «Rischio»), ma va nel corpo della PR in grassetto, perché il titolare lo sappia **prima** di fare il merge. |
| 0.6 | > 0 | **STOP.** Un cron si romperebbe al merge: si chiede al titolare prima di andare avanti. |
| 0.7 | almeno una funzione, o viste > 0 | **STOP.** Idem: si chiede al titolare. |
| 0.8 | più di una riga (`exec_sql(text)`) | **STOP.** Esiste un'altra porta per SQL qualsiasi e l'obiettivo non sarebbe raggiunto: il titolare decide se allargare la sessione. |
| 0.9 | compare `anon` o `authenticated` | D1 è peggio di come è stato misurato il 20/10: lo si dice **subito** al titolare; il piano prosegue (la migrazione chiude la porta). |
| 0.10 | produzione > fotografia | La chiusura del Compito 1, passo 3, la rigenera comunque se la sessione chiusa aveva migrazioni. Se dopo la chiusura la differenza resta, si rigenera lì, con gli stessi comandi e nello stesso primo commit, e il PRD dice quale version non era fotografata. |
| 0.14 | `ERROR` > 0 | Si annota: il «dopo» non deve averne di più. Non ferma il piano. |
| 0.15 | `python3` assente o < 3.8 | **STOP.** Il freno non partirebbe e la chiamata passerebbe. |

---

## Compiti

### Compito 1: apertura — prerequisiti, worktree, chiusura della precedente, aggiunte al freno

**File:**
- Nessun file del prodotto. Nel primo commit, i file che tocca la chiusura della sessione rilasciata per ultima (passo 3): fotografie, `__tests__/architecture/soglia-fotografia.ts`, la specifica, il PRD.

- [ ] **Passo 1: prerequisiti (§5, «Apertura di una sessione: i prerequisiti»)**

La sessione 2 non ha sessioni nella colonna «Dopo» (riga `^| 2 |` della tabella di stato): resta solo il controllo delle PR aperte. Si verificano fatti, mai il testo dello «Stato».

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: **nessuna riga**. Se ne esce una, un'altra sessione della serie è in revisione o non è chiusa: **fermati** e avvisa il titolare (una sessione alla volta, §5).

- [ ] **Passo 2: worktree nuovo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s02-sql-arbitrario-e-freno /Users/lerri/kidville-web-s02 origin/main
cd /Users/lerri/kidville-web-s02
npm ci
```

Atteso: worktree creato sul ramo nuovo, `npm ci` senza errori. Da qui in poi **ogni comando gira in `/Users/lerri/kidville-web-s02`**, mai in `/Users/lerri/kidville-web` (altre sessioni lo usano).

- [ ] **Passo 3: chiusura della sessione rilasciata per ultima (§5, «… la chiusura della precedente»), primo commit, prima di ogni codice**

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: un numero di PR e un ramo, quello della sessione `robustezza2/` mergiata più di recente (con l'ordine della §3, di solito `robustezza2/s01-iscrizioni`). Se stampa `null null`, nessuna sessione `robustezza2/` è ancora rilasciata: il passo si salta e non si committa niente.

1. Apri il piano di quella sessione, `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md` (per esempio, per `robustezza2/s01-iscrizioni`: `docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md`), e leggi per intero la sua sezione finale «Per la sessione dopo». Si fa quello che c'è scritto, non quello che si presume.
2. Se quella sessione aveva migrazioni (la sua sezione lo dice), rigenera la fotografia delle migrazioni applicate. Stampa la query:

   ```bash
   SCRATCH=$(mktemp -d)
   node __tests__/fixtures/migrazioni-fotografia.mjs --sql
   ```

   Eseguila sul database di produzione con lo strumento `execute_sql` (sola lettura: legge solo `supabase_migrations.schema_migrations`), salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

   ```bash
   node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
   npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
   ```

   Atteso: `migrazioni-complete` verde. `soglia-fotografia` è rosso sulla prova «2 · nessuna chiave è già applicata» finché non togli da `MIGRAZIONI_ATTESE_AL_MERGE` le voci che la sezione elenca: è il segnale previsto.
3. Fai le altre voci della sezione nell'ordine in cui sono scritte: le altre fotografie che nomina (ciascuna col suo comando), le voci tolte dalle liste, la riga di stato a «in produzione», lo Stato della voce nel PRD, la misura «dopo» se è già matura.
4. Verifica e committa, solo se c'è qualcosa da committare:

   ```bash
   CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
   git status --short
   ```

   Atteso: tutto verde. Con `git status --short` vuoto non si committa. Altrimenti:

   ```bash
   git add __tests__/fixtures __tests__/architecture docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
   git status --short
   git commit -m "$(cat <<'EOF'
   Chiusura della sessione rilasciata per ultima: fotografie, stato in produzione, PRD

   Eseguita la sezione «Per la sessione dopo» del suo piano.

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   EOF
   )"
   ```

   Se il secondo `git status --short` mostra file non aggiunti che la sezione nomina, aggiungili per nome prima del commit.

Dopo questo passo, la misura 0.10 del Passo 0 deve dare lo stesso valore in produzione e nella fotografia: se no, vedi la sua soglia.

- [ ] **Passo 4: gate di partenza**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
CI=1 npx vitest run 2>&1 | tail -6
```

Atteso: tutto verde. `CI=1` serve perché in un worktree nuovo il lock `offline-html-nativo` è rosso finché non c'è `cap sync` (§5). Se qualcosa è rosso **prima** di toccare il codice, lo si annota in `/tmp/kidville-s02-misure.txt` col nome del test: non è un difetto di questa sessione e non si corregge qui. Mai `npm run e2e` né `e2e:seed` in locale.

- [ ] **Passo 5: le aggiunte al freno — mostrale al titolare e aspetta il sì**

La specifica (§7, Sessione 2, «Cosa si tocca, parte 2») elenca quattro cose che il freno ferma **in più** rispetto alla decisione T3, «come aggiunta da confermare col titolare all'apertura della sessione». Prima del Compito 2 si mostrano al titolare, una per una, con l'esempio, e si aspetta la risposta. Nessun codice del freno si scrive prima della risposta.

Messaggio al titolare (testo da mandare così):

> Il freno della sessione 2 ferma `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP` e ogni `apply_migration`, come deciso il 20/10 (T3). La specifica chiede la tua conferma su quattro aggiunte. Per ognuna mi serve un sì o un no:
> **A.** `set_config(…)` o `SET` degli interruttori `registri.manutenzione`, `scatola_nera.manutenzione`, `scatola_nera.senza_storico` (esempio: `SET LOCAL registri.manutenzione = 'on'`). Senza, un agente può spegnere i registri in sola aggiunta o lo storico prima di un `UPDATE … WHERE` che il freno lascia passare.
> **B.** `session_replication_role` (esempio: `SET session_replication_role = replica`, che spegne tutti i trigger della sessione, scatola nera compresa).
> **C.** `DISABLE TRIGGER` (esempio: `ALTER TABLE public.alunni DISABLE TRIGGER ALL`).
> **D.** «In dubbio si ferma»: un'istruzione che il freno non sa leggere (una stringa o un commento non chiuso, per esempio `SELECT 'non chiusa`) viene fermata invece di passare.

Scrivi le quattro risposte, con giorno e ora UTC, in `/tmp/kidville-s02-misure.txt`: diventano il gettone `@AGGIUNTE_FRENO@` (forma `A sì, B sì, C sì, D no`), che va nel PRD (sezione «PRD») e nella colonna «Note» della riga 2 della tabella di stato (Rilascio, passo 4). Senza una risposta esplicita a una voce, quella voce resta **fuori** (vale come «no»): la specifica la chiede confermata, non presunta.

**Per ogni «no»** si tolgono dal codice del freno la voce e il suo caso di test, prima di scrivere il Compito 2. Ecco dove stanno:

| Aggiunta | Nello script `.claude/hooks/supabase_sql_freno.py` (Compito 2, passo 3) | Nel test `__tests__/architecture/freno-sql-distruttivo.test.ts` (Compito 2, passo 1) |
|---|---|---|
| **A.** interruttori di registri e scatola nera | nella costante `INTERRUTTORI`, l'alternativa `(?:REGISTRI\|SCATOLA_NERA)\"?\s*\.\s*\"?(?:MANUTENZIONE\|SENZA_STORICO)` (seconda riga della costante); nella docstring di testa, i nomi `registri.manutenzione`, `scatola_nera.manutenzione`, `scatola_nera.senza_storico` | in `FERMATE`, i casi `'spegne lo storico prima di un UPDATE … WHERE'` e `'accende la manutenzione dei registri'`. Il caso `"lettura dell'interruttore, non scrittura"` di `PASSANO` può restare: passa comunque |
| **B.** `session_replication_role` | in `INTERRUTTORI`, l'alternativa `\|SESSION_REPLICATION_ROLE` (terza riga della costante); nella docstring, il nome `session_replication_role` | in `FERMATE`, il caso `'spegne i trigger della sessione'` |
| **C.** `DISABLE TRIGGER` | in `INTERRUTTORI`, l'ultima riga, `r"\|\bDISABLE\s+TRIGGER\b"`; nella docstring, le parole `DISABLE TRIGGER` | in `FERMATE`, il caso `'spegne i trigger di una tabella'` |
| **D.** in dubbio si ferma (istruzione illeggibile) | in `main()`, il ramo `except NonLeggibile as errore:` che chiama `nega(…, "non-leggibile", strumento)`: diventa il blocco qui sotto; nella docstring, «stringa o commento non chiuso» esce da «ciò che non sa leggere» | la costante `ILLEGGIBILI` e il blocco `it.each(ILLEGGIBILI)('in dubbio si ferma: %s', …)` |

Con un «no» ad **A** o a **B** la costante si ricompone con le alternative rimaste. I tre casi possibili:

```python
# A no, B sì (C come deciso: con C sì resta l'ultima riga, con C no si toglie):
INTERRUTTORI = re.compile(
    r"(?:SET_CONFIG\s*\(\s*'|\bSET\s+(?:LOCAL\s+|SESSION\s+)?)\"?SESSION_REPLICATION_ROLE\b"
    r"|\bDISABLE\s+TRIGGER\b"
)

# A sì, B no (C come sopra):
INTERRUTTORI = re.compile(
    r"(?:SET_CONFIG\s*\(\s*'|\bSET\s+(?:LOCAL\s+|SESSION\s+)?)\"?"
    r"(?:REGISTRI|SCATOLA_NERA)\"?\s*\.\s*\"?(?:MANUTENZIONE|SENZA_STORICO)\b"
    r"|\bDISABLE\s+TRIGGER\b"
)

# A no, B no, C sì:
INTERRUTTORI = re.compile(r"\bDISABLE\s+TRIGGER\b")
```

Con **A, B e C tutti «no»** si toglie la costante `INTERRUTTORI` con il suo commento, e in `classifica()` le due righe `if INTERRUTTORI.search(testo):` e `trovate.append("interruttore della scatola nera, dei registri o dei trigger")`; la prima riga di `classifica()` diventa `codice, _ = separa(sql)`. Anche la frase «e agli interruttori della scatola nera» esce dal commento di testa del test, dalla voce del PRD (sezione «PRD») e dal riquadro di `CLAUDE.md` (Compito 8, passo 1).

Con un «no» a **D**, il ramo di `main()` diventa:

```python
    except NonLeggibile:
        # Decisione del titolare all'apertura della sessione 2 (voce del PRD): un'istruzione che il
        # freno non sa leggere non si ferma; resta la riga nel registro, decide la modalità di permesso.
        annota(f"esito=non-leggibile\tstrumento={strumento}")
        sys.exit(0)
```

I casi di input rotto (`'input che non è JSON'`, `'query assente'`, `'query vuota'`, …) e l'errore interno **non** sono istruzioni illeggibili: senza una query non c'è niente da classificare, e restano fermati anche con un «no» a D, salvo che il titolare dica esplicitamente il contrario.

Dopo le risposte, il Compito 2 si scrive con il codice del piano **meno** le voci tolte: nella sua prova rossa e verde i numeri di casi cambiano di conseguenza.

---

### Compito 2: il freno — lo script e i suoi casi

**File:**
- Crea: `.claude/hooks/supabase_sql_freno.py`
- Test: `__tests__/architecture/freno-sql-distruttivo.test.ts`

**Prima di scrivere:** applica le risposte del titolare del Compito 1, passo 5. Il codice qui sotto è quello con **tutte e quattro** le aggiunte (A, B, C, D) confermate; per ogni «no» si tolgono la voce e il suo caso di test indicati nella tabella di quel passo. Nessuna aggiunta entra senza un sì.

**Perché Python e non la ripresa del `.sh`:** `supabase_sql_gate.sh` decideva `allow`/`ask` (qui serve `deny`, §8.18), cercava le parole chiave anche dentro stringhe e commenti, e gira su bash 3.2 e `sed` BSD. Gli altri due hook del repo sono Python; Python legge stringhe, commenti, `$$` e parentesi con un lettore vero e si prova con `child_process` come `scripts/verifica-shell-nativa.py` in `__tests__/architecture/plugin-capacitor-registrati.test.ts:282`. Il `.sh` si elimina al Compito 3.

- [ ] **Passo 1: scrivere il test (rosso)**

Crea `__tests__/architecture/freno-sql-distruttivo.test.ts`:

```ts
// @vitest-environment node
/**
 * IL FRENO SULLE ISTRUZIONI DISTRUTTIVE — `.claude/hooks/supabase_sql_freno.py`.
 *
 * Robustezza, seconda serie, sessione 2 (decisione T3 del titolare, 20/10/2026). Il freno è un
 * hook `PreToolUse` sugli strumenti SQL di Supabase: risponde `deny` a ogni `apply_migration` e,
 * su `execute_sql`, a `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP` e agli
 * interruttori della scatola nera; lascia passare letture, `INSERT`, `UPDATE … WHERE`, `CREATE`.
 *
 * Si prova lo SCRIPT VERO, con l'input che Claude Code gli passa su stdin, un caso per riga. Le
 * due metà contano uguale: un caso fermato che passa è un buco; un caso lasciato passare che viene
 * fermato è il falso positivo che, alla terza lettura bloccata, fa spegnere il freno.
 *
 * Quello che questi test NON provano: che Claude Code carichi davvero l'hook e ne rispetti il
 * `deny` anche in `bypassPermissions`. Quello si prova solo in una sessione nuova, dopo il riavvio
 * (piano della sessione 2, «Rilascio»): una configurazione mai vista passare non è configurata.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RADICE = path.resolve(__dirname, '..', '..')
const FRENO = path.join(RADICE, '.claude', 'hooks', 'supabase_sql_freno.py')

let progetto = ''
beforeAll(() => {
  progetto = fs.mkdtempSync(path.join(os.tmpdir(), 'freno-sql-'))
  fs.mkdirSync(path.join(progetto, '.claude'))
})
afterAll(() => {
  fs.rmSync(progetto, { recursive: true, force: true })
})

type Esito = { uscita: number | null; decisione: string | null; motivo: string; stderr: string }

/**
 * Lancia il freno vero con `ingresso` su stdin. L'ambiente è COSTRUITO, non ereditato: se chi
 * lancia i test avesse esportato `KIDVILLE_FRENO_SQL_SPENTO=1`, ogni caso «fermato» uscirebbe
 * senza decisione. Niente `LANG`: il freno deve reggere anche senza locale.
 */
function freno(ingresso: unknown, ambiente: Record<string, string> = {}): Esito {
  const esito = spawnSync('python3', [FRENO], {
    input: typeof ingresso === 'string' ? ingresso : JSON.stringify(ingresso),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: progetto, ...ambiente },
    timeout: 10_000,
  })
  const testo = (esito.stdout ?? '').trim()
  if (!testo) return { uscita: esito.status, decisione: null, motivo: '', stderr: esito.stderr ?? '' }
  const json = JSON.parse(testo) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string }
  }
  expect(json.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  return {
    uscita: esito.status,
    decisione: json.hookSpecificOutput.permissionDecision,
    motivo: json.hookSpecificOutput.permissionDecisionReason,
    stderr: esito.stderr ?? '',
  }
}

/** L'input che Claude Code passa a un hook `PreToolUse` per uno strumento SQL. */
function sql(query: string, strumento = 'mcp__supabase__execute_sql') {
  return {
    session_id: 'prova-freno',
    hook_event_name: 'PreToolUse',
    tool_name: strumento,
    tool_input: { project_id: 'progetto-finto', query },
    cwd: RADICE,
    permission_mode: 'bypassPermissions',
  }
}

const UUID = '11111111-1111-4111-8111-111111111111'

/** [perché, query, parola che il motivo del rifiuto deve contenere] */
const FERMATE: ReadonlyArray<readonly [string, string, string]> = [
  ['DELETE con WHERE', 'DELETE FROM public.app_log WHERE id = 1', 'DELETE'],
  ['delete minuscolo', 'delete from app_log', 'DELETE'],
  ['maiuscole a caso', 'DeLeTe FrOm public.app_log', 'DELETE'],
  ['DROP TABLE', 'DROP TABLE public.prova_freno', 'DROP'],
  ['DROP FUNCTION minuscolo', 'drop function if exists public.exec_sql(text)', 'DROP'],
  ['TRUNCATE', 'TRUNCATE public.app_log', 'TRUNCATE'],
  ['UPDATE senza WHERE', "UPDATE public.alunni SET stato = 'ritirato'", 'UPDATE senza WHERE'],
  ['UPDATE ONLY con alias, senza WHERE', "UPDATE ONLY public.alunni AS a SET stato = 'ritirato'", 'UPDATE senza WHERE'],
  ['WHERE solo nella sottoquery', 'UPDATE public.alunni SET stato = (SELECT stato FROM public.alunni WHERE id = 1)', 'UPDATE senza WHERE'],
  ['UPDATE senza WHERE dentro una CTE', "WITH u AS (UPDATE public.alunni SET stato = 'x' RETURNING id) SELECT count(*) FROM u WHERE true", 'UPDATE senza WHERE'],
  ['ALTER … DROP COLUMN', 'ALTER TABLE public.alunni DROP COLUMN note', 'ALTER … DROP'],
  ['ALTER … DROP NOT NULL, minuscolo', 'alter table public.alunni alter column note drop not null', 'ALTER … DROP'],
  ['seconda di due istruzioni', 'SELECT 1; DELETE FROM public.app_log', 'DELETE'],
  ['dopo commenti di riga e di blocco', '/* lettura */ SELECT 1;\n-- poi\nDROP TABLE public.prova_freno', 'DROP'],
  ['DELETE in fondo a una CTE', 'WITH vecchi AS (SELECT id FROM public.app_log) DELETE FROM public.app_log WHERE id IN (SELECT id FROM vecchi)', 'DELETE'],
  ['dentro un blocco DO', 'DO $$ BEGIN DELETE FROM public.app_log; END $$', 'DELETE'],
  ['dentro il corpo di una funzione creata a mano', 'CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.app_log $$', 'DELETE'],
  ['EXPLAIN ANALYZE esegue davvero', 'EXPLAIN ANALYZE DELETE FROM public.app_log', 'DELETE'],
  ['EXPLAIN di un DELETE', 'EXPLAIN DELETE FROM public.app_log WHERE false', 'DELETE'],
  ['spegne lo storico prima di un UPDATE … WHERE', `SELECT set_config('scatola_nera.senza_storico', 'on', true); UPDATE public.alunni SET stato = 'x' WHERE id = '${UUID}'`, 'interruttore'],
  ['accende la manutenzione dei registri', "SET LOCAL registri.manutenzione = 'on'", 'interruttore'],
  ['spegne i trigger della sessione', 'SET session_replication_role = replica', 'interruttore'],
  ['spegne i trigger di una tabella', 'ALTER TABLE public.alunni DISABLE TRIGGER ALL', 'interruttore'],
]

/** [perché, query] — il freno non sa dove finisce l'istruzione: in dubbio si ferma. */
const ILLEGGIBILI: ReadonlyArray<readonly [string, string]> = [
  ['stringa non chiusa', "SELECT 'non chiusa"],
  ['un apice dentro $$ che si mangerebbe il resto', "SELECT $$'$$; DELETE FROM public.app_log"],
  ['commento di blocco non chiuso', 'SELECT 1 /* DELETE FROM public.app_log'],
]

/** [perché, query] — nessuna decisione: decide la modalità di permesso, come senza freno. */
const PASSANO: ReadonlyArray<readonly [string, string]> = [
  ['il conteggio delle iscrizioni', 'SELECT count(*) FROM enrollment_submissions'],
  ['select minuscolo con WHERE', "select id from public.alunni where stato = 'iscritto' limit 1"],
  ['INSERT', 'INSERT INTO public.prova_freno (n) VALUES (1)'],
  ['INSERT … ON CONFLICT DO UPDATE', 'INSERT INTO public.prova_freno (id, n) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET n = excluded.n'],
  ['UPDATE con WHERE', `UPDATE public.alunni SET stato = 'ritirato' WHERE id = '${UUID}'`],
  ['UPDATE con alias, FROM e WHERE', 'UPDATE public.prova_freno p SET n = q.n FROM public.prova_freno q WHERE p.id = q.id'],
  ['CREATE TABLE con ON DELETE CASCADE e ON UPDATE SET NULL', 'CREATE TABLE public.prova_freno (id uuid PRIMARY KEY, alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE ON UPDATE SET NULL)'],
  ['CREATE INDEX', 'CREATE INDEX IF NOT EXISTS prova_freno_n ON public.prova_freno (n)'],
  ['CREATE TRIGGER su UPDATE OR DELETE', 'CREATE TRIGGER t AFTER UPDATE OR DELETE ON public.prova_freno FOR EACH ROW EXECUTE FUNCTION public.f()'],
  ['EXPLAIN di una lettura', 'EXPLAIN SELECT * FROM public.app_log WHERE id = 1'],
  ['GRANT con DELETE e TRUNCATE fra i privilegi', 'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.prova_freno TO service_role'],
  ['SELECT … FOR UPDATE', 'SELECT id FROM public.alunni FOR UPDATE SKIP LOCKED'],
  ['parole distruttive dentro una stringa', "SELECT 'DELETE FROM alunni; DROP TABLE x' AS testo"],
  ['parola distruttiva in un commento di riga', '-- DELETE FROM public.app_log\nSELECT 1'],
  ['parola distruttiva in un commento di blocco', '/* DROP TABLE public.app_log */ SELECT 1'],
  ['colonne che cominciano come una parola distruttiva', 'SELECT deleted_at, dropped, truncated FROM public.prova_freno'],
  ['identificatore fra virgolette', 'SELECT "delete" FROM public.prova_freno'],
  ["lettura dell'interruttore, non scrittura", "SELECT current_setting('scatola_nera.manutenzione', true)"],
  ['più letture nella stessa stringa', 'SELECT 1; SELECT 2;'],
]

describe('freno SQL — le istruzioni distruttive si fermano', () => {
  it.each(FERMATE)('ferma: %s', (perche, query, categoria) => {
    const e = freno(sql(query))
    expect(e.decisione, perche).toBe('deny')
    expect(e.motivo, perche).toContain(categoria)
    // Il rifiuto dice cosa fare: mostrare l'istruzione al titolare, non cercare un'altra via.
    expect(e.motivo).toContain('titolare')
    expect(e.motivo).toContain('editor SQL')
    expect(e.uscita).toBe(0)
    expect(e.stderr).toBe('')
  })

  it.each(ILLEGGIBILI)('in dubbio si ferma: %s', (perche, query) => {
    const e = freno(sql(query))
    expect(e.decisione, perche).toBe('deny')
    expect(e.motivo).toContain('In dubbio si ferma')
    expect(e.uscita).toBe(0)
  })

  it('apply_migration è fermato SEMPRE, anche con una lettura dentro', () => {
    for (const strumento of ['mcp__supabase__apply_migration', 'mcp__claude_ai_Supabase__apply_migration']) {
      const e = freno({
        ...sql('SELECT 1', strumento),
        tool_input: { project_id: 'progetto-finto', name: 'prova', query: 'SELECT 1' },
      })
      expect(e.decisione, strumento).toBe('deny')
      expect(e.motivo).toContain('integrazione')
      expect(e.motivo).toContain('titolare')
    }
  })

  it('il connettore claude.ai è frenato come quello del progetto', () => {
    expect(freno(sql('DELETE FROM public.app_log', 'mcp__claude_ai_Supabase__execute_sql')).decisione).toBe('deny')
  })
})

describe('freno SQL — tutto il resto passa, senza decisione', () => {
  it.each(PASSANO)('lascia passare: %s', (perche, query) => {
    const e = freno(sql(query))
    expect(e.decisione, `${perche} → ${e.motivo}`).toBeNull()
    expect(e.uscita).toBe(0)
    expect(e.stderr).toBe('')
  })

  it('uno strumento che non è SQL non lo riguarda', () => {
    const e = freno(sql('DROP TABLE x', 'mcp__supabase__list_tables'))
    expect(e.decisione).toBeNull()
    expect(e.uscita).toBe(0)
  })
})

describe('freno SQL — via di fuga, input rotti, registro', () => {
  it('KIDVILLE_FRENO_SQL_SPENTO=1 lo spegne per la sessione', () => {
    const e = freno(sql('DROP TABLE public.prova_freno'), { KIDVILLE_FRENO_SQL_SPENTO: '1' })
    expect(e.decisione).toBeNull()
    expect(e.uscita).toBe(0)
  })

  it.each(['0', 'true', 'si', ''])('solo «1» lo spegne: con %j resta acceso', (valore) => {
    expect(freno(sql('DROP TABLE public.prova_freno'), { KIDVILLE_FRENO_SQL_SPENTO: valore }).decisione).toBe('deny')
  })

  it.each([
    ['input che non è JSON', 'questo non è json'],
    ['JSON che non è un oggetto', '[1, 2, 3]'],
    ['query assente', { ...sql('x'), tool_input: { project_id: 'progetto-finto' } }],
    ['query vuota', sql('   ')],
    ['query che non è una stringa', { ...sql('x'), tool_input: { project_id: 'progetto-finto', query: 42 } }],
  ] as const)('in dubbio si ferma: %s', (titolo, ingresso) => {
    const e = freno(ingresso)
    expect(e.decisione, titolo).toBe('deny')
    expect(e.motivo, titolo).toContain('In dubbio si ferma')
    expect(e.uscita).toBe(0)
  })

  it('il registro annota la decisione, MAI il testo della query', () => {
    freno(sql("DELETE FROM public.app_log WHERE evento = 'MARCATORE_DEL_TEST'"))
    freno(sql("SELECT 'MARCATORE_DEL_TEST' AS prova"))
    const registro = fs.readFileSync(path.join(progetto, '.claude', '.permessi-auto.log'), 'utf8')
    expect(registro).toMatch(/FRENO SQL\tesito=negato\tstrumento=mcp__supabase__execute_sql\tcategoria=DELETE/)
    expect(registro).toMatch(/FRENO SQL\tesito=passato\tstrumento=mcp__supabase__execute_sql/)
    expect(registro).not.toContain('MARCATORE_DEL_TEST')
  })

  it('il freno non approva e non chiede mai: nega, oppure tace', () => {
    const sorgente = fs.readFileSync(FRENO, 'utf8')
    // `ask` passerebbe da auto_allow_permission.py, che lo approva da solo (§8, divieto 18 della
    // specifica); `allow` scavalcherebbe la modalità di permesso. Il freno ha una sola parola.
    expect(sorgente).not.toMatch(/["']ask["']/)
    expect(sorgente).not.toMatch(/["']allow["']/)
    expect(sorgente).toMatch(/["']deny["']/)
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/architecture/freno-sql-distruttivo.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed`; i casi falliscono con `uscita` 2 al posto di 0 e `decisione` `null` al posto di `deny`, perché `python3` risponde `can't open file '…/supabase_sql_freno.py': [Errno 2] No such file or directory`; l'ultimo caso fallisce con `ENOENT`. Controlla che la riga dica `1 failed` e non `0 passed`: `vitest run` su un file che non trova esce 0 senza dirlo.

- [ ] **Passo 3: scrivere il freno**

Crea `.claude/hooks/supabase_sql_freno.py`:

```python
#!/usr/bin/env python3
"""Hook PreToolUse sugli strumenti SQL di Supabase — il FRENO sulle istruzioni distruttive.

Robustezza, seconda serie, sessione 2 (decisione T3 del titolare, 20/10/2026): un agente non
lancia più da solo un'istruzione distruttiva sul database di produzione, dove ci sono le domande
di iscrizione vere, con i dati di minori.

COSA FERMA (risposta ``deny``):
  · ``apply_migration``, SEMPRE: le migrazioni le applica l'integrazione GitHub di Supabase al
    merge della PR, con la version del file; il merge lo fa il titolare;
  · in ``execute_sql``: ``DELETE FROM``, ``DROP`` (anche ``ALTER … DROP``), ``TRUNCATE``,
    ``UPDATE`` senza ``WHERE`` al suo stesso livello, e gli interruttori che spengono la scatola
    nera, i registri o i trigger (``registri.manutenzione``, ``scatola_nera.manutenzione``,
    ``scatola_nera.senza_storico``, ``session_replication_role``, ``DISABLE TRIGGER``);
  · ciò che non sa leggere (input rotto, stringa o commento non chiuso, errore interno).

COSA LASCIA PASSARE (nessun output: decide la modalità di permesso, come senza freno):
  ``SELECT``, ``INSERT`` (anche ``ON CONFLICT … DO UPDATE``), ``UPDATE … WHERE``, ``CREATE``,
  ``EXPLAIN`` di una lettura, ``GRANT``. Il freno non approva mai niente: nega, oppure tace.

PERCHÉ ``deny`` E NON ``ask``: un ``ask`` diventa una richiesta di permesso, e la richiesta di
permesso la approva da solo ``auto_allow_permission.py`` (evento ``PermissionRequest``). Un
``ask`` qui sarebbe un freno dipinto.

PERCHÉ FAIL-CLOSED, al contrario degli altri due hook: quelli, se si rompono, restituiscono la
decisione all'utente; questo, se si rompesse lasciando passare, lascerebbe passare un ``DROP``.
Resta un buco che nessun codice qui dentro può chiudere: se ``python3`` manca o l'hook supera il
timeout, Claude Code tratta l'errore come non bloccante e la chiamata PASSA.

FUORI PERIMETRO: SQL lanciato da ``Bash`` (``psql``, ``supabase db query``, ``supabase db push``,
uno script con ``DATABASE_URL``). Il freno vede solo gli strumenti nel ``matcher`` di
``.claude/settings.json``.

Via di fuga per UNA sessione: ``export KIDVILLE_FRENO_SQL_SPENTO=1`` prima di avviare Claude Code.
Test: ``__tests__/architecture/freno-sql-distruttivo.test.ts``.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import sys

STRUMENTI_SQL = frozenset({
    "mcp__supabase__execute_sql",
    "mcp__claude_ai_Supabase__execute_sql",
})
STRUMENTI_MIGRAZIONE = frozenset({
    "mcp__supabase__apply_migration",
    "mcp__claude_ai_Supabase__apply_migration",
})

MOSTRA_AL_TITOLARE = (
    "Non si esegue da un agente: mostra l'istruzione esatta al titolare, che la esegue "
    "dall'editor SQL del pannello Supabase, se e quando lo decide. Non cercare un'altra via "
    "(psql, supabase db query, uno script con DATABASE_URL): in produzione ci sono dati reali "
    "di minori."
)

MOTIVO_MIGRAZIONE = (
    "Freno SQL: apply_migration è sempre fermato. La migrazione va in un file di "
    "supabase/migrations/ dentro la PR, con la version presa da date -u +%Y%m%d%H%M%S: la "
    "applica l'integrazione GitHub di Supabase al merge, con la version del file, e il merge lo "
    "fa il titolare. Applicarla anche a mano lascerebbe due righe nello storico."
)

# Parole, numeri, la stringa ridotta a '' e ogni altro carattere da solo.
TOKEN = re.compile(r"[A-Z_][A-Z0-9_$]*|\d+(?:\.\d+)?|''|\S")
PAROLA = re.compile(r"[A-Z_][A-Z0-9_$]*")
DELIMITATORE_DOLLARO = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")

# Gli interruttori che spengono la scatola nera, i registri o tutti i trigger. Si cercano anche
# dentro le stringhe, perché è lì che li mette set_config(): in dubbio si ferma.
INTERRUTTORI = re.compile(
    r"(?:SET_CONFIG\s*\(\s*'|\bSET\s+(?:LOCAL\s+|SESSION\s+)?)\"?"
    r"(?:(?:REGISTRI|SCATOLA_NERA)\"?\s*\.\s*\"?(?:MANUTENZIONE|SENZA_STORICO)"
    r"|SESSION_REPLICATION_ROLE)\b"
    r"|\bDISABLE\s+TRIGGER\b"
)

# Parole che dopo UPDATE non possono essere il nome di una tabella: ON UPDATE delle chiavi
# esterne, FOR UPDATE OF, UPDATE OR DELETE dei trigger, ON UPDATE SET NULL.
NON_NOMI = frozenset({"SET", "WHERE", "FROM", "ON", "OF", "OR", "AND", "ONLY", "CASCADE", "RESTRICT", "NO"})


class NonLeggibile(ValueError):
    """Una stringa, un identificatore o un commento non chiuso."""


def registro() -> pathlib.Path:
    radice = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return pathlib.Path(radice) / ".claude" / ".permessi-auto.log"


def annota(campi: str) -> None:
    """Una riga nel registro locale (escluso da git). Mai il testo della query: può contenere dati.

    Il registro non deve mai rompere il freno: un errore di scrittura si ignora qui, ed è l'unico
    punto del file in cui succede.
    """
    try:
        with registro().open("a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}\tFRENO SQL\t{campi}\n")
    except Exception:
        pass


def nega(motivo: str, esito: str, strumento: str, categorie: str = "") -> None:
    annota(f"esito={esito}\tstrumento={strumento}" + (f"\tcategoria={categorie}" if categorie else ""))
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": motivo,
            }
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.exit(0)


def _chiusura(sql: str, i: int, chiude: str, barra: bool, cosa: str) -> int:
    """Indice del carattere che chiude la stringa (o l'identificatore) aperta in ``i``."""
    j, n = i + 1, len(sql)
    while j < n:
        if barra and sql[j] == "\\":
            j += 2
            continue
        if sql[j] == chiude:
            if j + 1 < n and sql[j + 1] == chiude:
                j += 2
                continue
            return j
        j += 1
    raise NonLeggibile(f"{cosa} senza la sua chiusura")


def separa(sql: str) -> tuple[str, str]:
    """Restituisce (codice, testo), tutti e due in maiuscolo.

    codice: senza commenti, ogni stringa ridotta a ``''``, ogni identificatore fra virgolette
            ridotto a ``IDENTIFICATORE`` e i delimitatori ``$tag$`` tolti — il loro contenuto è il
            corpo di una funzione o di un blocco ``DO``, e lì dentro un ``DELETE`` resta un ``DELETE``;
    testo:  senza commenti e basta, per trovare gli interruttori che stanno dentro una stringa.
    """
    codice: list[str] = []
    testo: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        if sql.startswith("--", i):
            fine = sql.find("\n", i)
            i = n if fine < 0 else fine
            codice.append(" ")
            testo.append(" ")
        elif sql.startswith("/*", i):
            profondita, j = 1, i + 2
            while j < n and profondita:
                if sql.startswith("/*", j):
                    profondita, j = profondita + 1, j + 2
                elif sql.startswith("*/", j):
                    profondita, j = profondita - 1, j + 2
                else:
                    j += 1
            if profondita:
                raise NonLeggibile("un commento /* senza la sua chiusura")
            i = j
            codice.append(" ")
            testo.append(" ")
        elif sql[i] == "'":
            prima = sql[i - 2] if i >= 2 else " "
            barra = i >= 1 and sql[i - 1] in "eE" and not (prima.isalnum() or prima == "_")
            j = _chiusura(sql, i, "'", barra, "una stringa")
            codice.append("''")
            testo.append(sql[i : j + 1])
            i = j + 1
        elif sql[i] == '"':
            j = _chiusura(sql, i, '"', False, "un identificatore fra virgolette")
            codice.append(" IDENTIFICATORE ")
            testo.append(sql[i : j + 1])
            i = j + 1
        else:
            dollaro = None
            if sql[i] == "$" and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == "_")):
                dollaro = DELIMITATORE_DOLLARO.match(sql, i)
            if dollaro:
                codice.append(" ")
                testo.append(" ")
                i = dollaro.end()
            else:
                codice.append(sql[i])
                testo.append(sql[i])
                i += 1
    return "".join(codice).upper(), "".join(testo).upper()


def istruzioni(codice: str) -> list[list[tuple[str, int]]]:
    """Le istruzioni separate da ``;``, ognuna come lista di (token, profondità di parentesi)."""
    risultato: list[list[tuple[str, int]]] = []
    for pezzo in codice.split(";"):
        profondita = 0
        con_livello: list[tuple[str, int]] = []
        for t in TOKEN.findall(pezzo):
            if t == ")":
                profondita -= 1
            con_livello.append((t, profondita))
            if t == "(":
                profondita += 1
        if con_livello:
            risultato.append(con_livello)
    return risultato


def _nome(parola: str) -> bool:
    return bool(PAROLA.fullmatch(parola)) and parola not in NON_NOMI


def _set_di_un_update(parole: list[str], i: int) -> int | None:
    """Se ``parole[i]`` è l'UPDATE di ``UPDATE [ONLY] tabella [*] [[AS] alias] SET``, l'indice del
    suo SET; altrimenti None (ON UPDATE, FOR UPDATE, DO UPDATE, GRANT UPDATE, trigger)."""
    if i > 0 and parole[i - 1] == "DO":
        return None
    j = i + 1
    if j < len(parole) and parole[j] == "ONLY":
        j += 1
    if j >= len(parole) or not _nome(parole[j]):
        return None
    j += 1
    while j + 1 < len(parole) and parole[j] == "." and _nome(parole[j + 1]):
        j += 2
    if j < len(parole) and parole[j] == "*":
        j += 1
    if j < len(parole) and parole[j] == "AS":
        j += 1
    if j < len(parole) and _nome(parole[j]):
        j += 1
    return j if j < len(parole) and parole[j] == "SET" else None


def _where_allo_stesso_livello(tok: list[tuple[str, int]], da: int, livello: int) -> bool:
    for parola, profondita in tok[da:]:
        if profondita < livello:
            return False
        if parola == "WHERE" and profondita == livello:
            return True
    return False


def categoria(tok: list[tuple[str, int]]) -> str | None:
    """La categoria distruttiva di un'istruzione, o None."""
    parole = [t for t, _ in tok]
    for i, (parola, profondita) in enumerate(tok):
        dopo = parole[i + 1] if i + 1 < len(parole) else ""
        prima = parole[i - 1] if i > 0 else ""
        if parola == "DELETE" and dopo == "FROM":
            return "DELETE"
        if parola == "DROP":
            return "ALTER … DROP" if parole[0] == "ALTER" else "DROP"
        if parola == "TRUNCATE" and parole[0] not in ("GRANT", "REVOKE") and prima not in ("OR", "BEFORE", "AFTER"):
            return "TRUNCATE"
        if parola == "UPDATE":
            dove = _set_di_un_update(parole, i)
            if dove is not None and not _where_allo_stesso_livello(tok, dove, profondita):
                return "UPDATE senza WHERE"
    return None


def classifica(sql: str) -> list[str]:
    """Le categorie distruttive trovate, in ordine e senza doppioni. Vuota = passa."""
    codice, testo = separa(sql)
    trovate: list[str] = []
    if INTERRUTTORI.search(testo):
        trovate.append("interruttore della scatola nera, dei registri o dei trigger")
    for tok in istruzioni(codice):
        c = categoria(tok)
        if c:
            trovate.append(c)
    return list(dict.fromkeys(trovate))


def main() -> None:
    if os.environ.get("KIDVILLE_FRENO_SQL_SPENTO") == "1":
        annota("esito=spento\tKIDVILLE_FRENO_SQL_SPENTO=1")
        sys.exit(0)

    in_dubbio = " In dubbio si ferma. " + MOSTRA_AL_TITOLARE
    try:
        richiesta = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception as errore:
        nega(f"Freno SQL: l'input dell'hook non si legge ({type(errore).__name__})." + in_dubbio,
             "input-non-leggibile", "?")
        return
    if not isinstance(richiesta, dict):
        nega("Freno SQL: l'input dell'hook non è un oggetto JSON." + in_dubbio, "input-non-leggibile", "?")
        return

    strumento = str(richiesta.get("tool_name") or "")
    if strumento in STRUMENTI_MIGRAZIONE:
        nega(MOTIVO_MIGRAZIONE, "negato", strumento, "apply_migration")
    if strumento not in STRUMENTI_SQL:
        annota(f"esito=ignorato\tstrumento={strumento}")
        sys.exit(0)

    ingresso = richiesta.get("tool_input")
    query = ingresso.get("query") if isinstance(ingresso, dict) else None
    if not isinstance(query, str) or not query.strip():
        nega("Freno SQL: la query non si legge dall'input." + in_dubbio, "query-assente", strumento)
        return

    try:
        trovate = classifica(query)
    except NonLeggibile as errore:
        nega(f"Freno SQL: {errore}, quindi non si sa dove finisce l'istruzione." + in_dubbio,
             "non-leggibile", strumento)
        return

    if trovate:
        nega("Freno SQL: istruzione distruttiva fermata (" + "; ".join(trovate) + "). " + MOSTRA_AL_TITOLARE,
             "negato", strumento, ",".join(trovate))

    annota(f"esito=passato\tstrumento={strumento}")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as errore:  # fail-CLOSED: un freno rotto non lascia passare un DROP
        nega(f"Freno SQL: errore interno dell'hook ({type(errore).__name__}). In dubbio si ferma. "
             + MOSTRA_AL_TITOLARE, "errore-interno", "?")
```

Poi:

```bash
chmod +x .claude/hooks/supabase_sql_freno.py
```

Note di lettura per chi esegue: `json.dump` usa l'`ensure_ascii` predefinito, così l'uscita è ASCII puro anche senza locale; l'ingresso si decodifica da byte UTF-8 per la stessa ragione.

- [ ] **Passo 4: eseguirlo e vederlo verde**

```bash
npx vitest run __tests__/architecture/freno-sql-distruttivo.test.ts 2>&1 | tail -6
printf '%s' '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"DROP TABLE x"}}' \
  | CLAUDE_PROJECT_DIR=/tmp python3 .claude/hooks/supabase_sql_freno.py
printf '%s' '{"tool_name":"mcp__supabase__execute_sql","tool_input":{"query":"SELECT 1"}}' \
  | CLAUDE_PROJECT_DIR=/tmp python3 .claude/hooks/supabase_sql_freno.py; echo "uscita=$?"
```

Atteso: `Test Files  1 passed`; la prima riga a mano stampa un JSON con `"permissionDecision": "deny"` e `(DROP)` nel motivo; la seconda non stampa niente e poi `uscita=0`. Se un caso di `PASSANO` diventa rosso, si corregge il freno, **mai** il caso: è il falso positivo da cui la specifica mette in guardia.

- [ ] **Passo 5: commit**

```bash
git add .claude/hooks/supabase_sql_freno.py __tests__/architecture/freno-sql-distruttivo.test.ts
git commit -m "$(cat <<'EOF'
Robustezza2 s02: il freno sulle istruzioni SQL distruttive (deny, mai ask)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 3: il freno registrato in `.claude/settings.json`, il gate vecchio eliminato

**File:**
- Modifica: `.claude/settings.json:157-169`
- Elimina: `.claude/hooks/supabase_sql_gate.sh`
- Test: `__tests__/architecture/freno-sql-distruttivo.test.ts` (in fondo)

- [ ] **Passo 1: aggiungere il test della registrazione (rosso)**

In fondo a `__tests__/architecture/freno-sql-distruttivo.test.ts`:

```ts
type VoceHook = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }
type Impostazioni = { permissions: { allow: string[] }; hooks: { PreToolUse?: VoceHook[] } }

describe('freno SQL — è registrato, e copre ciò che è in allow', () => {
  const impostazioni = JSON.parse(
    fs.readFileSync(path.join(RADICE, '.claude', 'settings.json'), 'utf8'),
  ) as Impostazioni
  const voce = (impostazioni.hooks.PreToolUse ?? []).find((v) =>
    v.hooks.some((h) => h.command.includes('supabase_sql_freno.py')),
  )
  const coperti = (voce?.matcher ?? '').split('|')

  it('un PreToolUse chiama il freno dal progetto, con un tetto di 10 s', () => {
    expect(voce, 'il freno non è registrato in .claude/settings.json → hooks.PreToolUse').toBeDefined()
    const comando = voce?.hooks.find((h) => h.command.includes('supabase_sql_freno.py'))
    expect(comando?.type).toBe('command')
    expect(comando?.command).toBe('"$CLAUDE_PROJECT_DIR/.claude/hooks/supabase_sql_freno.py"')
    expect(comando?.timeout ?? 60).toBeLessThanOrEqual(10)
  })

  it('il matcher è un elenco di nomi esatti: i quattro strumenti SQL di Supabase', () => {
    // Solo lettere, cifre, `_` e `|`: Claude Code lo legge come elenco di nomi, non come regex.
    expect(voce?.matcher ?? '').toMatch(/^[A-Za-z0-9_|]+$/)
    expect([...coperti].sort()).toEqual([
      'mcp__claude_ai_Supabase__apply_migration',
      'mcp__claude_ai_Supabase__execute_sql',
      'mcp__supabase__apply_migration',
      'mcp__supabase__execute_sql',
    ])
  })

  it('ogni strumento SQL o di migrazione in permissions.allow passa dal freno', () => {
    const inAllow = impostazioni.permissions.allow.filter((p) => /__(execute_sql|apply_migration)$/.test(p))
    expect(inAllow.length).toBeGreaterThanOrEqual(3)
    expect(inAllow.filter((p) => !coperti.includes(p))).toEqual([])
  })

  it('il freno è eseguibile, e il gate vecchio in bash non c’è più', () => {
    expect(fs.statSync(FRENO).mode & 0o111).not.toBe(0)
    expect(fs.existsSync(path.join(RADICE, '.claude', 'hooks', 'supabase_sql_gate.sh'))).toBe(false)
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/architecture/freno-sql-distruttivo.test.ts 2>&1 | tail -15
```

Atteso: falliscono i quattro casi nuovi — «il freno non è registrato in .claude/settings.json», il matcher vuoto, le tre voci di `allow` scoperte, e `supabase_sql_gate.sh` che esiste ancora. I casi del Compito 2 restano verdi.

- [ ] **Passo 3: registrare il freno ed eliminare il gate vecchio**

In `.claude/settings.json` sostituisci:

```json
            "timeout": 10
          }
        ]
      }
    ],
    "PermissionRequest": [
```

con:

```json
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "mcp__supabase__execute_sql|mcp__supabase__apply_migration|mcp__claude_ai_Supabase__execute_sql|mcp__claude_ai_Supabase__apply_migration",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/supabase_sql_freno.py\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PermissionRequest": [
```

Poi:

```bash
git rm .claude/hooks/supabase_sql_gate.sh
python3 -m json.tool .claude/settings.json > /dev/null && echo "settings.json valido"
```

Atteso: `rm '.claude/hooks/supabase_sql_gate.sh'` e `settings.json valido`. Le `allow` e le 22 `deny` non si toccano.

⚠️ Da qui in poi una sessione di Claude Code **avviata** in questo worktree ha il freno acceso: le letture del Passo 0 e del Rilascio passano lo stesso; nessun passo di questo piano usa `apply_migration`.

- [ ] **Passo 4: eseguirlo e vederlo verde**

```bash
npx vitest run __tests__/architecture/freno-sql-distruttivo.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed`.

- [ ] **Passo 5: commit**

```bash
git add .claude/settings.json __tests__/architecture/freno-sql-distruttivo.test.ts
git commit -m "$(cat <<'EOF'
Robustezza2 s02: freno registrato come PreToolUse sui quattro strumenti SQL; via il gate vecchio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4: il lock sul codice e le sei route eliminate

**File:**
- Crea: `__tests__/architecture/niente-sql-arbitrario.test.ts`
- Elimina: le sei cartelle `src/app/api/admin/{apply-migration,apply-enrollment-migration,apply-forms-migration,apply-fase4-migration,apply-mensa-multi-menu-migration,setup-registro}/`
- Modifica: `__tests__/architecture/supabase-client-strumentato.test.ts:110-117`, `__tests__/lib/logging-tetto.test.ts:275-278, 293-300`, `__tests__/architecture/isolamento-sede-coverage.test.ts:1119-1124, 2527-2530, 2822-2825, 3196-3200`, `__tests__/api/admin-guasti-db-non-diventano-valori.test.ts:113, 243-250`, `__tests__/architecture/errori-con-codice.test.ts:212-216, 406-411`, `docs/superpowers/errori-senza-codice-allowlist.json`, `__tests__/architecture/residuo-odt-assente.test.ts:78-85`

- [ ] **Passo 1: scrivere il lock (rosso)**

Crea `__tests__/architecture/niente-sql-arbitrario.test.ts`:

```ts
// @vitest-environment node
/**
 * Lock — DAL CODICE DEL REPO NESSUNO FA ESEGUIRE SQL QUALSIASI AL DATABASE.
 *
 * Robustezza, seconda serie, sessione 2 (problema D1 del rapporto del 20/10/2026). Fino a questa
 * sessione `public.exec_sql(sql text)` — SECURITY DEFINER, proprietario `postgres`, definita solo
 * nel baseline — eseguiva qualunque stringa per chi aveva la chiave di servizio: sei route
 * sigillate, cinque script e un file nella radice la chiamavano o la ricreavano. Con lei si
 * potevano anche accendere `registri.manutenzione`, `scatola_nera.manutenzione` e
 * `scatola_nera.senza_storico`, cioè spegnere i registri in sola aggiunta e la scatola nera.
 *
 * Il lock vieta che torni: la chiamata (`rpc('exec_sql')`, `/rpc/exec_sql`, `/pg/query`) o la
 * ricreazione (`CREATE FUNCTION exec_sql`) in `src/`, in `scripts/` e nei file della radice; e,
 * nelle migrazioni dopo il baseline, una funzione SECURITY DEFINER che prenda un argomento `sql`,
 * `query` o `istruzione` di tipo `text`.
 *
 * Il confine, detto: non vede SQL lanciato da fuori del repo (`psql`, l'editor del pannello) né
 * uno script che parli a Postgres con `DATABASE_URL`, che non passa da PostgREST.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.resolve(__dirname, '..', '..')

/** Le forme in cui il codice del repo chiamava, o ricreava, l'esecutore di SQL arbitrario. */
const CHIAMATE_VIETATE: ReadonlyArray<{ nome: string; re: RegExp }> = [
  { nome: "rpc('exec_sql')", re: /\.rpc\s*\(\s*['"`]exec_sql['"`]/ },
  { nome: '/rpc/exec_sql', re: /\/rpc\/exec_sql\b/ },
  { nome: '/pg/query', re: /\/pg\/query\b/ },
  { nome: 'CREATE FUNCTION exec_sql', re: /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?exec_sql\b/i },
]

function chiamateVietate(sorgente: string): string[] {
  return CHIAMATE_VIETATE.filter(({ re }) => re.test(sorgente)).map(({ nome }) => nome)
}

const ESTENSIONI = /\.(?:ts|tsx|js|jsx|mjs|cjs|sh|py)$/

function sorgentiSotto(cartella: string): string[] {
  const trovati: string[] = []
  for (const voce of fs.readdirSync(cartella, { withFileTypes: true })) {
    if (voce.name === 'node_modules' || voce.name.startsWith('.')) continue
    const percorso = path.join(cartella, voce.name)
    if (voce.isDirectory()) trovati.push(...sorgentiSotto(percorso))
    else if (ESTENSIONI.test(voce.name)) trovati.push(percorso)
  }
  return trovati
}

function colpevoli(file: string[]): string[] {
  return file
    .flatMap((f) => chiamateVietate(fs.readFileSync(f, 'utf8')).map((nome) => `${path.relative(RADICE, f)} → ${nome}`))
    .sort()
}

const PERCHE =
  '`exec_sql` non esiste più (robustezza, seconda serie, sessione 2). Una migrazione va in ' +
  '`supabase/migrations/` e la applica l’integrazione al merge; un dato si cambia con una route ' +
  'che dichiara la sua sede, non con SQL qualsiasi.'

describe('niente SQL arbitrario — il rilevatore', () => {
  it('prende le quattro forme', () => {
    expect(chiamateVietate("const { error } = await supabase.rpc('exec_sql', { sql })")).toEqual(["rpc('exec_sql')"])
    expect(chiamateVietate('await admin.rpc( "exec_sql" , { sql: q })')).toEqual(["rpc('exec_sql')"])
    expect(chiamateVietate('fetch(`${URL}/rest/v1/rpc/exec_sql`, { method: "POST" })')).toEqual(['/rpc/exec_sql'])
    expect(chiamateVietate("await fetch(url + '/pg/query', init)")).toEqual(['/pg/query'])
    expect(chiamateVietate('CREATE OR REPLACE FUNCTION public.exec_sql(sql text)')).toEqual(['CREATE FUNCTION exec_sql'])
  })

  it('non prende ciò che non è una chiamata', () => {
    expect(chiamateVietate("supabase.rpc('exec_sql_log', {})")).toEqual([])
    expect(chiamateVietate('// la funzione exec_sql è stata tolta')).toEqual([])
    expect(chiamateVietate("supabase.rpc('prossimo_numero_fattura')")).toEqual([])
  })
})

describe('niente SQL arbitrario — il codice', () => {
  it('in src/ nessuno chiama né ricrea exec_sql', () => {
    const file = sorgentiSotto(path.join(RADICE, 'src'))
    // Anti-cecità: un percorso sbagliato renderebbe verde un lock che non legge niente.
    expect(file.length, 'il lock non legge più src/').toBeGreaterThan(1000)
    expect(colpevoli(file), PERCHE).toEqual([])
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts 2>&1 | tail -25
```

Atteso: i due test del rilevatore verdi; «in src/ nessuno chiama né ricrea exec_sql» rosso con **otto** righe:

```
src/app/api/admin/apply-enrollment-migration/route.ts → /pg/query
src/app/api/admin/apply-enrollment-migration/route.ts → /rpc/exec_sql
src/app/api/admin/apply-enrollment-migration/route.ts → CREATE FUNCTION exec_sql
src/app/api/admin/apply-fase4-migration/route.ts → rpc('exec_sql')
src/app/api/admin/apply-forms-migration/route.ts → rpc('exec_sql')
src/app/api/admin/apply-mensa-multi-menu-migration/route.ts → rpc('exec_sql')
src/app/api/admin/apply-migration/route.ts → rpc('exec_sql')
src/app/api/admin/setup-registro/route.ts → rpc('exec_sql')
```

- [ ] **Passo 3: eliminare le sei route**

```bash
git rm -r src/app/api/admin/apply-migration src/app/api/admin/apply-enrollment-migration \
  src/app/api/admin/apply-forms-migration src/app/api/admin/apply-fase4-migration \
  src/app/api/admin/apply-mensa-multi-menu-migration src/app/api/admin/setup-registro
grep -rn "apply-migration\|apply-enrollment-migration\|apply-forms-migration\|apply-fase4-migration\|apply-mensa-multi-menu-migration\|setup-registro" src e2e | head
```

Atteso: sei `rm '…/route.ts'`; il `grep` non stampa niente (nessuna pagina, nessun E2E chiama quelle route).

- [ ] **Passo 4: vedere quali lock lo notano**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts \
  __tests__/api/admin-guasti-db-non-diventano-valori.test.ts \
  __tests__/architecture/supabase-client-strumentato.test.ts \
  __tests__/lib/logging-tetto.test.ts \
  __tests__/architecture/isolamento-sede-coverage.test.ts \
  __tests__/architecture/errori-con-codice.test.ts \
  __tests__/architecture/residuo-odt-assente.test.ts 2>&1 | grep -E "FAIL|✓|×|Test Files" | head -40
```

Atteso: `niente-sql-arbitrario` e `residuo-odt-assente` verdi; rossi gli altri cinque, ognuno per la sua ragione:
- `admin-guasti-db-non-diventano-valori`: il file non si carica, `Failed to resolve import "@/app/api/admin/setup-registro/route"`;
- `supabase-client-strumentato`: «deroga su un file che non esiste più: src/app/api/admin/apply-enrollment-migration/route.ts»;
- `logging-tetto`: l'inventario delle `fetch` nude non contiene più `apply-enrollment-migration`, la mappa sì;
- `isolamento-sede-coverage`: i numeri della copertura (`routeConServiceRole` 357, `handlerControllati` 555) e le voci di `AMMESSE` rimaste senza route;
- `errori-con-codice`: sei voci dell'allowlist su file scomparsi.

- [ ] **Passo 5: allineare `admin-guasti-db-non-diventano-valori.test.ts`**

Togli la riga 113:

```ts
import { GET as setupRegistro } from '@/app/api/admin/setup-registro/route'
```

e il caso alle righe 243-250 con la riga vuota che lo precede:

```ts
  it('setup registro: le RLS fallite vanno fra gli errori, non fra i «✅»', async () => {
    h.rpc.exec_sql = { error: { code: '42501', message: 'permesso negato' } }
    const res = await setupRegistro(json('http://localhost/api/admin/setup-registro', 'GET'))
    const corpo = await res.json()
    expect(corpo.success).toBe(false)
    expect(corpo.steps).not.toContain('✅ RLS valutazioni')
    expect(corpo.errors.some((e: string) => e.startsWith('RLS valutazioni:'))).toBe(true)
  })
```

Il meccanismo `h.rpc` del mock (righe 23, 62, 142) resta: è generico.

- [ ] **Passo 6: allineare `supabase-client-strumentato.test.ts`**

Togli la voce alle righe 110-117:

```ts
    ['src/app/api/admin/apply-enrollment-migration/route.ts',
        'DEROGA, ed è debito dichiarato. Sei `fetch` a mano verso `/rest/v1/rpc/exec_sql` e `/pg/query` '
        + 'con la service-role key negli header: nessun tetto, nessuna riga. NON è stata portata al '
        + 'factory per due ragioni concrete: `/pg/query` non ha nessun equivalente in supabase-js (è un '
        + 'endpoint che sull\'hosted non esiste nemmeno, ed è il ramo di ripiego), e la route è '
        + '`sealDangerous`, cioè risponde 404 in produzione — le migrazioni oggi si applicano con lo '
        + 'strumento MCP `apply_migration`. Il rischio residuo è quindi limitato a sviluppo e preview, '
        + 'dove appende la richiesta di chi la invoca. Va rimossa o ricondotta, non condonata.'],
```

- [ ] **Passo 7: allineare `logging-tetto.test.ts`**

Togli la voce alle righe 293-300:

```ts
    ['src/app/api/admin/apply-enrollment-migration/route.ts',
        'DEBITO DICHIARATO, non un falso positivo: sei `fetch` a mano verso `/rest/v1/rpc/exec_sql` '
        + 'e `/pg/query` con la service-role key negli header — nessun tetto, nessuna riga. La '
        + 'ragione per cui non è stata ricondotta al factory sta già scritta per esteso in '
        + '`__tests__/architecture/supabase-client-strumentato.test.ts` (voce `FETCH_VERSO_SUPABASE`): '
        + '`/pg/query` non ha equivalente in supabase-js, e la route è `sealDangerous`, cioè 404 in '
        + 'produzione. Il rischio residuo è sviluppo e preview, dove appende chi la invoca. Va '
        + 'rimossa o ricondotta, non condonata.'],
```

e nel commento sopra la mappa (riga 278) sostituisci:

```ts
 * annullamenti (l'utente chiude la pagina). La prima voce è invece debito vero.
```

con:

```ts
 * annullamenti (l'utente chiude la pagina). L'unica voce di debito vero,
 * `admin/apply-enrollment-migration`, è uscita il @GIORNO@ insieme alla route (robustezza,
 * seconda serie, sessione 2).
```

- [ ] **Passo 8: allineare `isolamento-sede-coverage.test.ts`**

Righe 1119-1124, sostituisci:

```ts
    'admin/setup-registro:GET': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/debug-mensa-auth:GET': 'sealDangerous',
    'admin/apply-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/apply-fase4-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/apply-forms-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
    'admin/apply-mensa-multi-menu-migration:<modulo>': 'sealDangerous (rpc exec_sql: DDL, non dati)',
```

con:

```ts
    'admin/debug-mensa-auth:GET': 'sealDangerous',
    // Fino al @GIORNO@ qui stavano anche `admin/setup-registro:GET` e le quattro
    // `admin/apply-*-migration:<modulo>` (rpc exec_sql): route cancellate insieme alla
    // funzione (robustezza, seconda serie, sessione 2).
```

Righe 2527-2530, sostituisci:

```ts
            // controllate; nessuna voce aggiunta ad AMMESSE.
            routeConServiceRole: 363,
```

con:

```ts
            // controllate; nessuna voce aggiunta ad AMMESSE.
            // 363 → 357 il @GIORNO@ (robustezza, seconda serie, sessione 2): escono le sei
            // route sigillate che chiamavano `exec_sql` (`admin/apply-*` e
            // `admin/setup-registro`). Non è un presidio tolto: sono file che non esistono più.
            routeConServiceRole: 357,
```

Righe 2822-2825, sostituisci:

```ts
            // dichiarate sopra; handlerEsentati resta 112.
            handlerControllati: 566,
```

con:

```ts
            // dichiarate sopra; handlerEsentati resta 112.
            // 566 → 555 il @GIORNO@: gli undici handler di quelle sei route (2+2+2+2+2+1).
            handlerControllati: 555,
```

Righe 3196-3200, sostituisci:

```ts
            // funzione, non da questo lock.
            handlerEsentati: 112,
```

con:

```ts
            // funzione, non da questo lock.
            // 112 → 107 il @GIORNO@: escono le cinque voci `sealDangerous (rpc exec_sql …)`
            // insieme alle loro route. Il numero scende perché il codice non c'è più, non
            // perché un'esenzione sia stata allargata.
            handlerEsentati: 107,
```

I numeri 357, 555 e 107 vengono dalla lettura del 20/10 (sei file che usano la service role, undici `export const … = withRoute(`, cinque voci). **Se il lock ne riporta altri**, si scrive quello che riporta il lock e nel commento si spiega la differenza: mai un numero «aggiustato».

- [ ] **Passo 9: allineare l'allowlist degli errori senza codice e i suoi tetti**

```bash
python3 - <<'PY'
import datetime, json, pathlib
p = pathlib.Path('docs/superpowers/errori-senza-codice-allowlist.json')
d = json.loads(p.read_text(encoding='utf-8'))
via = {f'src/app/api/admin/{r}/route.ts' for r in (
    'apply-enrollment-migration', 'apply-fase4-migration', 'apply-forms-migration',
    'apply-mensa-multi-menu-migration', 'apply-migration', 'setup-registro')}
tolte = [v for v in d['file'] if v['path'] in via]
assert len(tolte) == 6 and sum(v['n'] for v in tolte) == 11, tolte
d['file'] = [v for v in d['file'] if v['path'] not in via]
d['totale_occorrenze'] -= 11
d['aggiornato'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(len(d['file']), d['totale_occorrenze'])
PY
git diff --stat docs/superpowers/errori-senza-codice-allowlist.json
```

Atteso: `264 1350`; il diff tocca solo le 24 righe delle sei voci e le righe di `aggiornato` e `totale_occorrenze`. Se il diff riformatta altro (rientri, a capo), si annulla quel file e si fanno le stesse tre modifiche con lo strumento Edit.

In `__tests__/architecture/errori-con-codice.test.ts`, righe 212-216, sostituisci:

```ts
 * `admin/gdpr/candidates/route.ts` è arrivata a ZERO ed è uscita dall'elenco: vedi il paragrafo
 * gemello su `MAX_OCCORRENZE`.
 */
const MAX_FILE = 270;
```

con:

```ts
 * `admin/gdpr/candidates/route.ts` è arrivata a ZERO ed è uscita dall'elenco: vedi il paragrafo
 * gemello su `MAX_OCCORRENZE`.
 *
 * 🔻 270 → 264 il @GIORNO@, branch `robustezza2/s02-sql-arbitrario-e-freno` (robustezza, seconda
 * serie, sessione 2). Escono SEI voci insieme ai loro file: le route sigillate che chiamavano
 * `exec_sql` (`admin/apply-enrollment-migration`, `admin/apply-fase4-migration`,
 * `admin/apply-forms-migration`, `admin/apply-mensa-multi-menu-migration`, `admin/apply-migration`,
 * `admin/setup-registro`). Debito CANCELLATO col codice, non convertito: vedi il paragrafo gemello
 * su `MAX_OCCORRENZE`.
 */
const MAX_FILE = 264;
```

Righe 406-411, sostituisci:

```ts
 * voce scende da 1 a 0 ed esce dall'elenco; `MAX_FILE` scende di uno insieme a lei.
 */
const MAX_OCCORRENZE = 1361;
```

con:

```ts
 * voce scende da 1 a 0 ed esce dall'elenco; `MAX_FILE` scende di uno insieme a lei.
 *
 * 🔻 1361 → 1350 il @GIORNO@, stesso branch. Le sei route di `exec_sql` portavano 11 risposte
 * senza codice (2 + 2 + 2 + 2 + 2 + 1): escono con i loro file. Nessuna risposta è stata
 * convertita, e nessuna è stata spostata altrove.
 */
const MAX_OCCORRENZE = 1350;
```

- [ ] **Passo 10: il commento di `residuo-odt-assente.test.ts`**

Righe 78-85, sostituisci:

```ts
 * Sotto `src/` restano **13 `CREATE TABLE`** in altre cinque route `apply-*-migration`, e
 * questo lock NON le vieta. Non è una svista: le sei tabelle che nominano (`forms_templates`,
 * `forms_submissions`, `certificati_medici`, `registro_orario`, `mensa_menu_config`,
 * `enrollment_submissions`) **esistono davvero in produzione** — misurato lo stesso giorno,
 * `to_regclass` non-null per tutte e sei. Il loro `CREATE TABLE IF NOT EXISTS` è ridondante,
 * non è una resurrezione. Che quelle route esistano ancora resta un debito, ed è scritto qui
 * perché un confine taciuto è il modo in cui un lock ricomincia a promettere più di quanto
 * misura.
```

con:

```ts
 * Fino al @GIORNO@ sotto `src/` restavano **13 `CREATE TABLE`** in altre cinque route
 * `apply-*-migration`, che questo lock non vietava: le sei tabelle che nominavano esistono davvero
 * in produzione, e il loro `CREATE TABLE IF NOT EXISTS` era ridondante, non una resurrezione.
 * Quelle route non ci sono più (robustezza, seconda serie, sessione 2: chiamavano `exec_sql`, che
 * è stata tolta), e con loro il debito che questo paragrafo dichiarava.
```

- [ ] **Passo 11: eseguire e vedere verde**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts \
  __tests__/api/admin-guasti-db-non-diventano-valori.test.ts \
  __tests__/architecture/supabase-client-strumentato.test.ts \
  __tests__/lib/logging-tetto.test.ts \
  __tests__/architecture/isolamento-sede-coverage.test.ts \
  __tests__/architecture/errori-con-codice.test.ts \
  __tests__/architecture/residuo-odt-assente.test.ts 2>&1 | tail -6
npx tsc --noEmit
CI=1 npx vitest run 2>&1 | tail -6
```

Atteso: `Test Files  7 passed`; `tsc` senza uscita; la suite intera verde. Se un altro lock nomina le route cancellate, lo dice il suo messaggio: si allinea allo stesso modo (voce tolta, numero col commento datato), senza abbassare soglie che non c'entrano.

- [ ] **Passo 12: sostituire `@GIORNO@` e fare il commit**

```bash
GIORNO=$(date -u +%F)
sed -i '' "s/@GIORNO@/${GIORNO}/g" __tests__/lib/logging-tetto.test.ts \
  __tests__/architecture/isolamento-sede-coverage.test.ts \
  __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/residuo-odt-assente.test.ts
git add -A src/app/api/admin __tests__/architecture/niente-sql-arbitrario.test.ts \
  __tests__/api/admin-guasti-db-non-diventano-valori.test.ts \
  __tests__/architecture/supabase-client-strumentato.test.ts __tests__/lib/logging-tetto.test.ts \
  __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts \
  docs/superpowers/errori-senza-codice-allowlist.json __tests__/architecture/residuo-odt-assente.test.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: via le sei route sigillate che chiamavano exec_sql; lock niente-sql-arbitrario

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: il `grep` dei gettoni non stampa niente; commit fatto.

---

### Compito 5: gli script e il file della radice

**File:**
- Elimina: `scripts/apply_pagamenti_migrations.mjs`, `scripts/apply_settings_hub_migration.mjs`, `scripts/apply_segreteria_migrations.mjs`, `scripts/apply-enrollment-migration.mjs`, `scripts/backfill_presenze_scuola.mjs`, `seed_sql.mjs`
- Modifica: `README.md:48`, `docs/env.md:97`
- Test: `__tests__/architecture/niente-sql-arbitrario.test.ts`

- [ ] **Passo 1: estendere il lock a `scripts/` e alla radice (rosso)**

In `__tests__/architecture/niente-sql-arbitrario.test.ts`, dentro `describe('niente SQL arbitrario — il codice', …)`, dopo il primo `it`, aggiungi:

```ts
  it('in scripts/ e nei file della radice nessuno chiama né ricrea exec_sql', () => {
    const script = sorgentiSotto(path.join(RADICE, 'scripts'))
    const radice = fs
      .readdirSync(RADICE, { withFileTypes: true })
      .filter((v) => v.isFile() && ESTENSIONI.test(v.name))
      .map((v) => path.join(RADICE, v.name))
    expect(script.length, 'il lock non legge più scripts/').toBeGreaterThan(50)
    expect(radice.length, 'il lock non legge più la radice').toBeGreaterThan(5)
    expect(colpevoli([...script, ...radice]), PERCHE).toEqual([])
  })
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts 2>&1 | tail -20
```

Atteso: rosso con **sei** righe:

```
scripts/apply-enrollment-migration.mjs → CREATE FUNCTION exec_sql
scripts/apply_pagamenti_migrations.mjs → rpc('exec_sql')
scripts/apply_segreteria_migrations.mjs → rpc('exec_sql')
scripts/apply_settings_hub_migration.mjs → rpc('exec_sql')
scripts/backfill_presenze_scuola.mjs → rpc('exec_sql')
seed_sql.mjs → rpc('exec_sql')
```

- [ ] **Passo 3: eliminarli**

```bash
git rm scripts/apply_pagamenti_migrations.mjs scripts/apply_settings_hub_migration.mjs \
  scripts/apply_segreteria_migrations.mjs scripts/apply-enrollment-migration.mjs \
  scripts/backfill_presenze_scuola.mjs seed_sql.mjs
grep -n "apply_pagamenti_migrations\|apply_settings_hub_migration\|apply_segreteria_migrations\|seed_sql\|backfill_presenze_scuola" package.json .github/workflows/*.yml
```

Atteso: sei `rm '…'`; il `grep` non stampa niente (nessuno script npm e nessun workflow li usa).

- [ ] **Passo 4: le due righe di documentazione che li nominano**

`README.md:48`, sostituisci:

```markdown
- `supabase/migrations/**` — migrazioni SQL (si applicano via `scripts/apply_*.mjs`, RPC `exec_sql`)
```

con:

```markdown
- `supabase/migrations/**` — migrazioni SQL: le applica l'integrazione GitHub di Supabase al merge della PR, con la version del file (`exec_sql` non esiste più dal @GIORNO@)
```

`docs/env.md:97`, sostituisci la riga di `DATABASE_URL`:

```markdown
| `DATABASE_URL` | Connection string Postgres diretta, SOLO per lo script legacy `scripts/apply-enrollment-migration.mjs` (le migrazioni correnti passano da RPC `exec_sql`). **Segreto.** |
```

con:

```markdown
| `DATABASE_URL` | Connection string Postgres diretta. La leggono tre script di fotografia (`scripts/fk-sede-fotografia.mjs`, `scripts/rls-fotografia.mjs`, `scripts/tabelle-sede-fotografia.mjs`) e quattro script storici che applicavano migrazioni a mano (`scripts/apply_annotazione_numerica.mjs`, `scripts/apply_primaria_migrations.mjs`, `scripts/apply_primaria_fase2_migrations.mjs`, `scripts/apply_usa_pannolino.mjs`). È SQL da `Bash`: **il freno sulle istruzioni distruttive non lo vede**. Le migrazioni le applica l'integrazione al merge; `exec_sql` non esiste più dal @GIORNO@. **Segreto.** |
```

- [ ] **Passo 5: eseguire e vedere verde**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed`.

- [ ] **Passo 6: commit**

```bash
GIORNO=$(date -u +%F)
sed -i '' "s/@GIORNO@/${GIORNO}/g" README.md docs/env.md
git add -A scripts seed_sql.mjs README.md docs/env.md __tests__/architecture/niente-sql-arbitrario.test.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: via i cinque script e il file della radice che usavano exec_sql

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6: la migrazione che toglie `exec_sql`

**File:**
- Crea: `supabase/migrations/@VERSIONE@_via_exec_sql.sql`
- Modifica: `__tests__/architecture/niente-sql-arbitrario.test.ts`, `__tests__/architecture/security-definer-revoke-lock.test.ts:54-57`

- [ ] **Passo 1: estendere il lock alle migrazioni (rosso)**

In cima a `__tests__/architecture/niente-sql-arbitrario.test.ts`, sotto `import path from 'node:path'`, aggiungi:

```ts
import { senzaCommenti } from './soglia-fotografia'
```

e in fondo al file:

```ts
const MIGRAZIONI = path.join(RADICE, 'supabase', 'migrations')
const BASELINE = '20260704120000_baseline.sql'

/** Un argomento che porta SQL da eseguire: `sql text`, `query text`, `istruzione text`. */
const ARGOMENTO_SQL = /(?:^|,)\s*(?:IN\s+)?"?(?:sql|query|istruzione)"?\s+text\b/i

/** I nomi delle funzioni SECURITY DEFINER che prendono un argomento SQL. Commenti esclusi. */
function funzioniSqlArbitrario(sql: string): string[] {
  const pulito = senzaCommenti(sql)
  const teste = [...pulito.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([^)]*)\)/gi)]
  return teste.flatMap((m, i) => {
    const inizio = m.index ?? 0
    const fine = i + 1 < teste.length ? (teste[i + 1].index ?? pulito.length) : pulito.length
    const blocco = pulito.slice(inizio, fine)
    return /\bSECURITY\s+DEFINER\b/i.test(blocco) && ARGOMENTO_SQL.test(m[2]) ? [m[1].replace(/"/g, '')] : []
  })
}

const DROP_EXEC_SQL = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.exec_sql\s*\(\s*text\s*\)\s*;/gi

describe('niente SQL arbitrario — le migrazioni', () => {
  const file = fs.readdirSync(MIGRAZIONI).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort()
  const dopoIlBaseline = file.filter((f) => f !== BASELINE)
  const leggi = (f: string) => fs.readFileSync(path.join(MIGRAZIONI, f), 'utf8')

  it('il rilevatore trova exec_sql nel baseline (controllo positivo su SQL vero)', () => {
    expect(funzioniSqlArbitrario(leggi(BASELINE))).toEqual(['public.exec_sql'])
  })

  it('il rilevatore: opzioni prima o dopo il corpo, commenti, INVOKER, nomi innocenti', () => {
    expect(funzioniSqlArbitrario(
      'CREATE OR REPLACE FUNCTION public.esegui(sql text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql; END $$;',
    )).toEqual(['public.esegui'])
    expect(funzioniSqlArbitrario(
      'CREATE FUNCTION public.x(query text) RETURNS void AS $$ BEGIN EXECUTE query; END $$ LANGUAGE plpgsql SECURITY DEFINER;',
    )).toEqual(['public.x'])
    expect(funzioniSqlArbitrario(
      '-- CREATE FUNCTION public.exec_sql(sql text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql; END $$;',
    )).toEqual([])
    expect(funzioniSqlArbitrario(
      'CREATE FUNCTION public.y(sql text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN EXECUTE sql; END $$;',
    )).toEqual([])
    expect(funzioniSqlArbitrario(
      'CREATE FUNCTION public.z(p_testo text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;',
    )).toEqual([])
  })

  it('dopo il baseline nessuna funzione SECURITY DEFINER prende SQL da eseguire', () => {
    expect(dopoIlBaseline.length, 'il lock non legge più le migrazioni').toBeGreaterThan(200)
    const trovate = dopoIlBaseline.flatMap((f) => funzioniSqlArbitrario(leggi(f)).map((n) => `${f} → ${n}`))
    expect(trovate, PERCHE).toEqual([])
  })

  it('una migrazione toglie exec_sql, e nessun’altra la nomina fuori dal suo DROP', () => {
    const conDrop = dopoIlBaseline.filter((f) => (senzaCommenti(leggi(f)).match(DROP_EXEC_SQL) ?? []).length > 0)
    expect(conDrop, 'manca la migrazione che toglie public.exec_sql(text)').toHaveLength(1)
    const altriNomi = dopoIlBaseline.filter((f) => /\bexec_sql\b/i.test(senzaCommenti(leggi(f)).replace(DROP_EXEC_SQL, '')))
    expect(altriNomi, 'exec_sql nominata fuori dal suo DROP: la si sta ricreando o ridando a qualcuno').toEqual([])
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts 2>&1 | tail -15
```

Atteso: verdi i due rilevatori e «nessuna funzione SECURITY DEFINER prende SQL»; rosso solo «una migrazione toglie exec_sql», con «manca la migrazione che toglie public.exec_sql(text)» (lunghezza 0 invece di 1).

- [ ] **Passo 3: scrivere la migrazione**

**Variante A** (la misura 0.3 coincide col baseline):

```bash
VERSIONE=$(date -u +%Y%m%d%H%M%S)
GIORNO=$(date -u +%F)
FILE="supabase/migrations/${VERSIONE}_via_exec_sql.sql"
cat > "$FILE" <<'SQL'
-- =============================================================================
-- VIA `exec_sql`: NESSUN RUOLO DELL'APP FA PIÙ ESEGUIRE SQL QUALSIASI — @GIORNO@
--
-- Robustezza, seconda serie, sessione 2 (problema D1 del rapporto del 20/10/2026; specifica
-- `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7).
--
-- `public.exec_sql(sql text)` era SECURITY DEFINER con proprietario `postgres` ed eseguiva
-- qualunque stringa per chi aveva la chiave di servizio (`POST /rest/v1/rpc/exec_sql`): anche
-- accendere `registri.manutenzione`, `scatola_nera.manutenzione` e `scatola_nera.senza_storico`,
-- cioè spegnere i registri in sola aggiunta e la scatola nera. È definita solo nel baseline.
-- Misurato al passo 0 del piano
-- `docs/superpowers/plans/2026-10-20-robustezza2-s02-sql-arbitrario-e-freno.md`: nessun cron,
-- nessuna funzione e nessuna vista la nomina. Nella stessa PR escono dal repo le sei route
-- sigillate e i sei file che la chiamavano o la ricreavano.
--
-- Effetto voluto: chi la chiama ancora riceve `404 PGRST202`. Il lock
-- `__tests__/architecture/niente-sql-arbitrario.test.ts` impedisce che torni, anche sotto un
-- altro nome, come funzione SECURITY DEFINER con un argomento `sql`/`query`/`istruzione` text.
--
-- Nessuna scrittura in `app_log`: la prova è una lettura del catalogo. Guardie per la CI:
-- nessuna serve. `IF EXISTS` regge il DB E2E della CI, che non è migrato, e nessun codice
-- dell'app la chiama.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select to_regprocedure('public.exec_sql(text)');                   → NULL
--   select count(*) from supabase_migrations.schema_migrations
--    where version = '@VERSIONE@';                                    → 1
--   POST /rest/v1/rpc/exec_sql con la chiave pubblicabile              → 404, PGRST202
--   get_advisors (security)                                            → 0 ERROR
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   Solo su richiesta del titolare, e solo come migrazione NUOVA dentro una PR di revert, con
--   la version presa da `date -u +%Y%m%d%H%M%S` — mai applicata a mano. Riapre il problema D1.
--   Rieseguire la definizione di `20260704120000_baseline.sql`: righe 272-282 (funzione e
--   proprietario) e 7808-7809 (permessi), poi `NOTIFY pgrst, 'reload schema';`. Il @GIORNO@ la
--   definizione della produzione (`pg_get_functiondef`) coincideva con quella del baseline.
-- =============================================================================

DROP FUNCTION IF EXISTS public.exec_sql(text);

NOTIFY pgrst, 'reload schema';
SQL
sed -i '' -e "s/@VERSIONE@/${VERSIONE}/g" -e "s/@GIORNO@/${GIORNO}/g" "$FILE"
grep -c '@VERSIONE@\|@GIORNO@' "$FILE"
echo "$FILE"
```

Atteso: `0` e il percorso del file. Annota `@VERSIONE@` in `/tmp/kidville-s02-misure.txt`.

**Variante B** (la misura 0.3 è diversa dal baseline): stesso comando, ma le ultime quattro righe del blocco ROLLBACK diventano la definizione letta in produzione, riga per riga, con il prefisso `--   ` e i permessi della misura 0.3 tradotti in `REVOKE`/`GRANT`, più la riga `--   NOTIFY pgrst, 'reload schema';`. Dopo la variante B si riesegue tutta la suite (passo 4): un lock delle migrazioni che leggesse anche i commenti lo direbbe lì.

- [ ] **Passo 4: eseguire e vedere verde**

```bash
npx vitest run __tests__/architecture/niente-sql-arbitrario.test.ts \
  __tests__/architecture/migrazioni-complete.test.ts \
  __tests__/architecture/migrazioni-distruttive-approvate.test.ts \
  __tests__/architecture/security-definer-revoke-lock.test.ts \
  __tests__/architecture/migrazioni-senza-sede-cablata.test.ts 2>&1 | tail -6
CI=1 npx vitest run 2>&1 | tail -6
```

Atteso: `Test Files  5 passed`, poi la suite intera verde. `DROP FUNCTION` non è un'istruzione distruttiva per `migrazioni-distruttive-approvate` (riga 158 del suo test: «niente righe perse»), quindi non serve la riga «distruttiva approvata».

- [ ] **Passo 5: il commento di `security-definer-revoke-lock.test.ts`**

Righe 54-57, sostituisci:

```ts
  // ha approfittato — esattamente come questo commento prescrive. Ne restano DUE. Su un progetto Supabase ricostruito da zero
  // con `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO anon, authenticated` attive, nascerebbero
  // aperte. Va sanato con una migrazione dedicata, non allargando questa lista.
```

con:

```ts
  // ha approfittato — esattamente come questo commento prescrive.
  // ✅ `exec_sql` è stata tolta il @GIORNO@ da `@VERSIONE@_via_exec_sql.sql` (robustezza, seconda
  // serie, sessione 2): resta nella lista qui sotto solo perché il baseline la crea ancora, e la
  // migrazione dopo la toglie. Ne resta UNA, `prossimo_numero_fattura`: su un progetto Supabase
  // ricostruito da zero con `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO anon, authenticated`
  // attive, nascerebbe aperta. Va sanata con una migrazione dedicata, non allargando questa lista.
```

La voce `'exec_sql'` alla riga 62 **resta**.

```bash
sed -i '' -e "s/@VERSIONE@/${VERSIONE}/g" -e "s/@GIORNO@/${GIORNO}/g" __tests__/architecture/security-definer-revoke-lock.test.ts
npx vitest run __tests__/architecture/security-definer-revoke-lock.test.ts 2>&1 | tail -4
```

Atteso: `Test Files  1 passed`.

- [ ] **Passo 6: commit**

```bash
git add "$FILE" __tests__/architecture/niente-sql-arbitrario.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: migrazione che toglie public.exec_sql(text); il lock la pretende

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7: le istruzioni degli agenti — migrazione dall'integrazione, merge del titolare

**File:**
- Modifica: `.claude/commands/ship-cycle.md:171-172, 322, 347-350`, `.claude/agents/esecutore-opus.md:38-42`, `.claude/rules/migrazioni.md:11-12, 17-18, 44`
- Test: `__tests__/architecture/freno-sql-distruttivo.test.ts` (in fondo)

- [ ] **Passo 1: il test sulle istruzioni (rosso)**

In fondo a `__tests__/architecture/freno-sql-distruttivo.test.ts`:

```ts
describe('freno SQL — le istruzioni degli agenti non lo aggirano', () => {
  const CARTELLE = ['commands', 'agents', 'rules', 'agenti-ship-cycle'].map((c) => path.join(RADICE, '.claude', c))
  const righe = CARTELLE.filter((c) => fs.existsSync(c)).flatMap((c) =>
    fs
      .readdirSync(c)
      .filter((f) => f.endsWith('.md'))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(c, f), 'utf8')
          .split('\n')
          .map((testo, i) => ({ dove: `${path.relative(RADICE, path.join(c, f))}:${i + 1}`, testo })),
      ),
  )

  it('legge davvero i file degli agenti', () => {
    expect(righe.length).toBeGreaterThan(1000)
  })

  it('nessuna istruzione dice all’agente di fare il merge: lo fa il titolare', () => {
    expect(righe.filter((r) => /gh\s+pr\s+merge/.test(r.testo)).map((r) => r.dove)).toEqual([])
  })

  it('ogni riga che nomina apply_migration dice che lo nega il freno', () => {
    expect(
      righe.filter((r) => r.testo.includes('apply_migration') && !/freno/i.test(r.testo)).map((r) => r.dove),
    ).toEqual([])
  })

  it('supabase db query si nomina solo per leggere', () => {
    expect(
      righe.filter((r) => /supabase db query/.test(r.testo) && !/sola lettura/i.test(r.testo)).map((r) => r.dove),
    ).toEqual([])
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/architecture/freno-sql-distruttivo.test.ts 2>&1 | grep -A8 "FAIL\|AssertionError" | head -40
```

Atteso, tre casi rossi:
- merge: `['.claude/commands/ship-cycle.md:347']`;
- `apply_migration`: `.claude/commands/ship-cycle.md:172`, `.claude/commands/ship-cycle.md:348`, `.claude/agents/esecutore-opus.md:40`, `.claude/rules/migrazioni.md:11`;
- `supabase db query`: `['.claude/rules/migrazioni.md:44']`.

- [ ] **Passo 3: `ship-cycle.md`**

Righe 171-172, sostituisci:

```markdown
- **le migrazioni** al DB dove servono (`supabase/migrations/`, applicate con lo strumento MCP
  `apply_migration`, verificate con `get_advisors` → **0 ERROR**);
```

con:

```markdown
- **le migrazioni** al DB dove servono, come file in `supabase/migrations/` dentro la PR: le applica
  l'integrazione al merge, mai `apply_migration` (lo nega il freno); dopo il merge `get_advisors` → **0 ERROR**;
```

Riga 322, sostituisci:

```markdown
Merge, deploy, migrazioni e `execute_sql` sono in `allow`; `defaultMode` è `acceptEdits`.
```

con:

```markdown
🟥 **Due eccezioni dal @GIORNO@** (specifica della seconda serie di robustezza, approvata dal titolare
il 20/10, decisione T3): **il merge lo fa il titolare** e **la migrazione la applica l'integrazione al
merge**. `apply_migration` e le istruzioni distruttive su `execute_sql` le nega il freno
(`.claude/hooks/supabase_sql_freno.py`); il resto della decisione del 2026-08-03 resta.
```

Righe 347-350, sostituisci:

```markdown
3. **Merge** — `gh pr merge --squash --delete-branch`.
4. **Migrazioni** — applicale al DB di **produzione** con lo strumento MCP `apply_migration`,
   poi `get_advisors` → **0 ERROR**. (È il percorso reale di questo progetto: `migrate.yml`
   resta in attesa del baseline dello storico.)
```

con:

```markdown
3. **Merge — lo fa il titolare.** Con la CI verde su **tutti** i job, fermati e chiedigli il merge
   mostrandogli la PR (`gh pr view <n> --web`). Mai il merge da qui, mai l'auto-merge.
4. **Migrazioni — le applica l'integrazione GitHub di Supabase al merge**, con la version del file.
   A mano no: `apply_migration` lo nega il freno (`.claude/hooks/supabase_sql_freno.py`), e una
   migrazione applicata due volte lascia due righe nello storico. Dopo il merge: una `SELECT` che
   trova la version del file in `supabase_migrations.schema_migrations` e l'oggetto che crea o
   toglie, poi `get_advisors` → **0 ERROR**.
```

- [ ] **Passo 4: `esecutore-opus.md`**

Righe 38-42, sostituisci:

```markdown
2. **Migrazione DB** se il piano la prevede — `supabase/migrations/<YYYYMMDDHHMMSS>_<nome>.sql`,
   timestamp coerente con l'ordine, **additiva** (expand/contract). Si applica al progetto di
   produzione con lo strumento MCP `apply_migration` e si verifica con `get_advisors`
   (**0 ERROR**). Il DB E2E della CI **non è migrato**: il codice deve degradare in modo
   pulito se la colonna nuova non c'è (PostgREST: `PGRST204` su INSERT/UPDATE, `42703` su SELECT).
```

con:

```markdown
2. **Migrazione DB** se il piano la prevede — `supabase/migrations/<YYYYMMDDHHMMSS>_<nome>.sql`,
   timestamp UTC (`date -u +%Y%m%d%H%M%S`), **additiva** (expand/contract). Non la applichi tu:
   la applica l'integrazione al merge della PR, e il merge lo fa il titolare (`apply_migration` lo nega il freno).
   Dopo il merge si verifica con una `SELECT` e con `get_advisors` (**0 ERROR**). Il DB E2E della
   CI **non è migrato**: il codice deve degradare in modo pulito se la colonna nuova non c'è
   (PostgREST: `PGRST204` su INSERT/UPDATE, `42703` su SELECT).
```

- [ ] **Passo 5: `rules/migrazioni.md`**

Righe 11-12, sostituisci:

```markdown
Si applicano con lo strumento MCP **`apply_migration`**, seguito da **`get_advisors`**, che deve
tornare **0 ERROR**. `migrate.yml` resta in attesa del baseline dello storico.
```

con:

```markdown
Le applica l'**integrazione GitHub di Supabase al merge** della PR, con la version del file; il merge
lo fa il titolare. **`apply_migration` lo nega il freno** (`.claude/hooks/supabase_sql_freno.py`). Dopo
il merge: una `SELECT` che la ritrova, poi **`get_advisors`**, che deve tornare **0 ERROR**.
```

Righe 17-18, sostituisci:

```markdown
merge ne nascono **due righe** nello storico, e da lì in poi lo stato divergente si trascina. Decidi
*prima*: o a mano, o dalla PR — mai tutte e due.
```

con:

```markdown
merge ne nascono **due righe** nello storico, e da lì in poi lo stato divergente si trascina. Per
questo, dal @GIORNO@, si applica **solo** dalla PR.
```

Riga 44, sostituisci:

```markdown
- Senza strumento MCP disponibile: `supabase db query --linked`, eseguito dalla radice del repo.
```

con:

```markdown
- Senza strumento MCP, e **solo in sola lettura**: `supabase db query --linked` dalla radice del repo.
  È `Bash`, il freno non lo vede: una scrittura da lì non si lancia, si mostra al titolare.
```

- [ ] **Passo 6: eseguire e vedere verde**

```bash
GIORNO=$(date -u +%F)
sed -i '' "s/@GIORNO@/${GIORNO}/g" .claude/commands/ship-cycle.md .claude/rules/migrazioni.md
npx vitest run __tests__/architecture/freno-sql-distruttivo.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed`.

- [ ] **Passo 7: commit**

```bash
git add .claude/commands/ship-cycle.md .claude/agents/esecutore-opus.md .claude/rules/migrazioni.md \
  __tests__/architecture/freno-sql-distruttivo.test.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: agenti e regole — la migrazione la applica l'integrazione, il merge il titolare

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8: i riquadri datati in `CLAUDE.md`, `AGENTS.md` e nella storia dei permessi

**File:**
- Modifica: `CLAUDE.md:99-102`, `AGENTS.md:99-100`, `docs/storia-permessi-e-conferme.md` (in fondo)

`CLAUDE.md` e `AGENTS.md` si rileggono a ogni turno di ogni sessione: i riquadri restano corti, il racconto va nella storia.

- [ ] **Passo 1: `CLAUDE.md`, sezione «Permessi»**

Dopo il paragrafo che finisce con `` `KIDVILLE_AUTO_PERMESSI_ANCHE_RM=1` (toglie anche quell'ultimo prompt). `` (riga 102) e prima di `⚠️ Il blocco \`autoMode\``, inserisci:

```markdown
🟥 **Il freno sulle istruzioni distruttive — dal @GIORNO@** (robustezza, seconda serie, sessione 2;
decisione T3). Due eccezioni all'autonomia piena: **la migrazione la applica l'integrazione al merge**
e **il merge lo fa il titolare**. L'hook `PreToolUse` `.claude/hooks/supabase_sql_freno.py` risponde
`deny` — mai `ask`, che `auto_allow_permission.py` approverebbe — a ogni `apply_migration` e, su
`execute_sql`, a `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP` e agli
interruttori della scatola nera. Fermato vuol dire **mostrare l'istruzione al titolare**, che la esegue
dall'editor SQL, non cercare un'altra via: SQL da `Bash` (`psql`, `supabase db query`, `DATABASE_URL`)
il freno non lo vede. Via di fuga: `KIDVILLE_FRENO_SQL_SPENTO=1`. Prova in una sessione nuova dopo il
merge: **da fare** (la scrive la sessione dopo, nel suo primo commit).
```

- [ ] **Passo 2: `AGENTS.md`**

Dopo le righe 99-100:

```markdown
🟩 **Stato dal 2026-09-18**: **autonomia piena, i prompt non arrivano più all'utente** — né in
lettura né in scrittura, né sul DB di produzione, né su merge, `git push`, deploy o migrazioni.
```

inserisci:

```markdown
🟥 **Dal @GIORNO@ due eccezioni**: il merge lo fa il titolare, e la migrazione la applica
l'integrazione al merge. Il freno `.claude/hooks/supabase_sql_freno.py` nega `apply_migration` e le
istruzioni distruttive su `execute_sql`: si mostrano al titolare. Dettagli in `CLAUDE.md`.
```

- [ ] **Passo 3: `docs/storia-permessi-e-conferme.md`, riquadro in fondo**

Dopo l'ultima riga del file (`` `.claude/settings.json.bak-20260918-162359`. Poi **riavviare**. ``), aggiungi:

```markdown

### 🟥 APPLICATO IL @GIORNO@ — il freno sulle istruzioni distruttive

**Decisione del titolare** (T3, 20/10, specifica `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`,
§7 sessione 2): *freno sui distruttivi*. Il riquadro del 2026-09-03 qui sopra aveva scritto senza giri
che, tolto `supabase_sql_gate.sh`, un `UPDATE` o un `DROP` sul database delle iscrizioni partiva senza
che nessun essere umano vedesse l'istruzione. Da oggi non parte più da un agente.

| | Prima | Adesso |
|---|---|---|
| `hooks.PreToolUse` | solo `ExitPlanMode` | in più il freno sui quattro strumenti SQL di Supabase (`execute_sql` e `apply_migration`, del progetto e del connettore claude.ai) |
| `supabase_sql_gate.sh` | su disco, non registrato, rispondeva `allow`/`ask` | **eliminato**, sostituito da `supabase_sql_freno.py` |
| `apply_migration` | in `allow`, usato dagli agenti | resta in `allow`, ma il freno lo **nega sempre**: la migrazione la applica l'integrazione al merge |
| merge | lo faceva `/ship-cycle` | lo fa il titolare |
| `public.exec_sql(text)` | in produzione, eseguibile da `service_role` | tolta dalla migrazione `@VERSIONE@_via_exec_sql.sql` |

**Perché `deny` e non `ask`.** Dal 18/09 un `ask` diventa una richiesta di permesso, e la richiesta di
permesso la approva da solo `auto_allow_permission.py`. Un freno che chiede è un freno dipinto (§8,
divieto 18 della specifica).

**Perché Python.** Il gate vecchio cercava le parole chiave anche dentro stringhe e commenti, girava su
bash 3.2 e `sed` BSD e non si poteva provare in automatico. Il freno legge stringhe, commenti, `$$` e
parentesi; i suoi casi stanno in `__tests__/architecture/freno-sql-distruttivo.test.ts`, una riga per
ogni istruzione fermata e per ogni istruzione lasciata passare.

**Cosa NON copre, detto una volta.** SQL lanciato da `Bash` (`psql`, `supabase db query`,
`supabase db push`, gli script con `DATABASE_URL`); gli altri strumenti MCP di Supabase; e il caso in
cui il freno non parte (`python3` assente, timeout): Claude Code lo tratta come errore non bloccante e
la chiamata passa.

**Come si prova** (in una sessione **nuova**, dopo il riavvio): chiedere l'esecuzione di
`EXPLAIN DELETE FROM public.app_log WHERE false` con `execute_sql` → rifiutata con «Freno SQL»;
`SELECT 1 AS prova_freno` → risponde `1`; in `.claude/.permessi-auto.log` una riga
`FRENO SQL	esito=negato` e una `FRENO SQL	esito=passato`. L'istruzione di prova è innocua anche se il
freno non scattasse: `EXPLAIN` senza `ANALYZE` non esegue niente.

**Come si torna indietro**, in ordine di reversibilità: `export KIDVILLE_FRENO_SQL_SPENTO=1` (una
sessione) → togliere la voce del freno da `hooks.PreToolUse` in `.claude/settings.json` (il file resta
su disco). Poi **riavviare**.
```

(Nelle due righe del registro il separatore è un carattere di tabulazione, come nel file vero.)

- [ ] **Passo 4: gettoni e commit**

```bash
GIORNO=$(date -u +%F)
VERSIONE=$(ls supabase/migrations | sed -n 's/^\([0-9]\{14\}\)_via_exec_sql\.sql$/\1/p')
echo "$VERSIONE"
sed -i '' -e "s/@GIORNO@/${GIORNO}/g" -e "s/@VERSIONE@/${VERSIONE}/g" CLAUDE.md AGENTS.md docs/storia-permessi-e-conferme.md
git add CLAUDE.md AGENTS.md docs/storia-permessi-e-conferme.md
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: riquadri datati del freno in CLAUDE.md, AGENTS.md e nella storia dei permessi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: `echo` stampa le 14 cifre della migrazione; il `grep` dei gettoni non stampa niente. `npx vitest run __tests__/architecture/pii-nei-file-tracciati.test.ts` resta verde (nessun valore personale nei testi).

---

## Migrazione

Una sola, `supabase/migrations/@VERSIONE@_via_exec_sql.sql` (Compito 6):

```sql
DROP FUNCTION IF EXISTS public.exec_sql(text);

NOTIFY pgrst, 'reload schema';
```

- **Nome:** version da `date -u +%Y%m%d%H%M%S` nel momento in cui si scrive il file, mai un orario tondo né una data futura: il lock `migrazioni-complete` rifiuta una version più vecchia dell'ultima della fotografia e due file con la stessa version.
- **Chi la applica:** l'integrazione GitHub di Supabase **al merge**, con la version del file. Mai `apply_migration` (il freno lo nega), mai `supabase db push` a mano (§8, divieto 4).
- **Guardie per la CI:** nessuna serve. `IF EXISTS` regge il DB E2E della CI, che non è migrato e dove la funzione resta; nessun codice dell'app la chiama, quindi non ci sono `PGRST202` da reggere nel codice (§5, «codice che regge il momento del merge»).
- **`NOT VALID`:** non si applica (nessun vincolo).
- **Scritture in `app_log`:** nessuna. La verifica è una lettura del catalogo.
- **ROLLBACK:** nell'intestazione, rimando alle righe del baseline (variante A) o definizione della produzione (variante B). Diventa una migrazione nuova solo dentro una PR di revert, su richiesta del titolare.

## Log

- **Nessuna route nuova e nessuna integrazione esterna nuova**: non servono chiamate nuove a `logOk`/`logErrore`/`logEvento`. Le sei route escono con i loro `withRoute` e i loro `logErrore`: non resta un percorso d'errore senza log.
- **Il freno registra ogni decisione** in `.claude/.permessi-auto.log` (locale, escluso da git dalla riga `.claude/*` di `.gitignore`, lo stesso file degli altri due hook), una riga per chiamata:
  `AAAA-MM-GG hh:mm:ss<TAB>FRENO SQL<TAB>esito=<…><TAB>strumento=<…>[<TAB>categoria=<…>]`, con `esito` uno fra `negato`, `passato`, `spento`, `ignorato`, `non-leggibile`, `query-assente`, `input-non-leggibile`, `errore-interno`. Mai il testo della query (lo prova un caso del test). La riga `passato` è il battito: dice che l'hook è agganciato anche quando non ferma niente.
- **Dopo il merge, in produzione**, si guarda (lo fa la sessione che apre dopo: «Per la sessione dopo», punti 3 e 6):
  - `app_log`, 7 giorni dopo il merge: righe che nominano `exec_sql` → **atteso 0**, nessun codice dell'app la chiama;

    ```sql
    SELECT count(*) AS righe FROM app_log
     WHERE creato_il > now() - interval '7 days' AND messaggio ILIKE '%exec_sql%';
    ```

    Se sono più di 0, si leggono `evento`, `route` e `codice` di quelle righe (mai `messaggio`) e si apre un difetto;
  - log dell'API (strumento MCP dei log, servizio `api`): richieste a `/rest/v1/rpc/exec_sql` con stato `404` → è chi la chiamava da fuori, l'effetto voluto: si annota il numero, non si rimedia.

## PRD

- [ ] **Passo 1: la voce di changelog in cima a `PRD REGISTRO ELETTRONICO.md`**

Si inserisce **prima** della riga 1 (oggi la voce dell'analisi del 20/10), con i gettoni sostituiti dai valori veri del Passo 0 (`@PR@` resta fino al passo 4 del Rilascio):

```markdown
## 🛡️ Changelog — Robustezza, seconda serie, sessione 2: via `exec_sql` e freno sulle istruzioni distruttive — @GIORNO@ (branch `robustezza2/s02-sql-arbitrario-e-freno`)

**Stato:** 🟨 in revisione (PR #@PR@), **merge a mano del titolare**. Al merge l'integrazione Supabase applica `supabase/migrations/@VERSIONE@_via_exec_sql.sql`. Domande d'iscrizione contate prima della migrazione: **@N_ISCRIZIONI@** alle @ORA_CONTEGGIO@ UTC.

- **`exec_sql` non esiste più (D1).** `public.exec_sql(sql text)` — SECURITY DEFINER, proprietario `postgres`, definita solo nel baseline — eseguiva qualunque stringa per chi aveva la chiave di servizio, compreso accendere `registri.manutenzione`, `scatola_nera.manutenzione` e `scatola_nera.senza_storico`. La migrazione la toglie con `DROP FUNCTION IF EXISTS`; chi la chiama riceve `404 PGRST202`. Misura prima (@GIORNO@): `track_functions` = @TRACK_FUNCTIONS@; chiamate in `pg_stat_user_functions` = @CHIAMATE_FUNZIONE@; `pg_stat_statements` per ruolo = @CHIAMATE_STATEMENTS@; cron, funzioni e viste che la nominano = 0; altre funzioni SECURITY DEFINER con un argomento SQL = 0.
- **Sei route e sei file in meno.** Escono le route sigillate `admin/apply-migration`, `admin/apply-enrollment-migration` (che la ricreava), `admin/apply-forms-migration`, `admin/apply-fase4-migration`, `admin/apply-mensa-multi-menu-migration`, `admin/setup-registro`, e i file `scripts/apply_pagamenti_migrations.mjs`, `scripts/apply_settings_hub_migration.mjs`, `scripts/apply_segreteria_migrations.mjs`, `scripts/apply-enrollment-migration.mjs`, `scripts/backfill_presenze_scuola.mjs`, `seed_sql.mjs`. Lock nuovo: `__tests__/architecture/niente-sql-arbitrario.test.ts`. Allineati `supabase-client-strumentato`, `logging-tetto`, `isolamento-sede-coverage` (357 / 555 / 107), `errori-con-codice` (264 file, 1350 occorrenze) e la sua allowlist.
- **Il freno (T3).** `.claude/hooks/supabase_sql_freno.py`, hook `PreToolUse` su `execute_sql` e `apply_migration` (anche del connettore claude.ai): risponde `deny` — mai `ask` — a ogni `apply_migration` e a `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP` e agli interruttori della scatola nera; il messaggio dice di mostrare l'istruzione al titolare. Aggiunte alla decisione T3 confermate dal titolare all'apertura della sessione (A interruttori di registri e scatola nera, B `session_replication_role`, C `DISABLE TRIGGER`, D in dubbio si ferma): @AGGIUNTE_FRENO@; quelle con «no» non sono nel freno. Via di fuga `KIDVILLE_FRENO_SQL_SPENTO=1`. Il vecchio `supabase_sql_gate.sh` è eliminato. Test: `__tests__/architecture/freno-sql-distruttivo.test.ts`.
- **Merge e migrazioni.** `ship-cycle`, `esecutore-opus` e la regola delle migrazioni dicono ora: la migrazione la applica l'integrazione al merge, il merge lo fa il titolare.
- **Fuori perimetro, scritto.** SQL da `Bash` (`psql`, `supabase db query`, `supabase db push`, i quattro `scripts/apply_*.mjs` con `DATABASE_URL`) e gli altri strumenti MCP di Supabase.
- **Logging.** Nessuna route nuova. Il freno scrive una riga per decisione in `.claude/.permessi-auto.log` (locale, escluso da git) con `esito`, strumento e categoria — mai il testo della query.
```

- [ ] **Passo 2: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git diff --cached "PRD REGISTRO ELETTRONICO.md" | grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: PRD — via exec_sql e freno sulle istruzioni distruttive

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: il `grep` mostra **solo** `@PR@` (si riempie al passo 4 del Rilascio). Qualunque altro gettone è un valore del Passo 0 non riportato: lo si riporta prima del commit.

## Rilascio

- [ ] **Passo 1: gate completi**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
CI=1 npx vitest run 2>&1 | tail -6
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso: `eslint` e `tsc` senza uscita; `Test Files … passed` senza `failed`; build `✓ Compiled successfully` e nessuna delle sei route nell'elenco delle route stampato. Se il build si ferma per una variabile d'ambiente mancante, non si legge né si copia `.env.local` (è in `deny`): si chiede al titolare di metterlo nel worktree.

- [ ] **Passo 2: push**

```bash
git push -u origin robustezza2/s02-sql-arbitrario-e-freno
```

- [ ] **Passo 3: la PR**

Scrivi `/tmp/kidville-s02-pr.md` con questo corpo, riempito con le misure del Passo 0:

```markdown
## Sessione 2 della seconda serie di robustezza — via `exec_sql` e freno sulle istruzioni distruttive

Specifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, sessione 2.
Piano: `docs/superpowers/plans/2026-10-20-robustezza2-s02-sql-arbitrario-e-freno.md`.

**⚠️ Merge a mano del titolare.** Al merge l'integrazione Supabase applica
`supabase/migrations/@VERSIONE@_via_exec_sql.sql` (`DROP FUNCTION IF EXISTS public.exec_sql(text)`).

### Misura prima (@GIORNO@, UTC)
- domande d'iscrizione: @N_ISCRIZIONI@ alle @ORA_CONTEGGIO@
- `track_functions`: @TRACK_FUNCTIONS@ · chiamate in `pg_stat_user_functions`: @CHIAMATE_FUNZIONE@
- `pg_stat_statements` per ruolo: @CHIAMATE_STATEMENTS@
- cron / funzioni / viste che la nominano: 0 / 0 / 0 · altre SECURITY DEFINER con argomento SQL: 0
- PostgREST con la chiave pubblicabile: stato e codice della misura 0.13
- advisor di sicurezza: ERROR e WARN della misura 0.14

### Cosa cambia
- migrazione che toglie `exec_sql`; lock `niente-sql-arbitrario`;
- via sei route sigillate e sei file che la chiamavano o la ricreavano; lock allineati;
- freno `PreToolUse` (`deny`, mai `ask`) su `execute_sql`/`apply_migration`; via `supabase_sql_gate.sh`;
- istruzioni degli agenti: migrazione dall'integrazione al merge, merge del titolare;
- riquadri datati in `CLAUDE.md`, `AGENTS.md`, `docs/storia-permessi-e-conferme.md`; voce nel PRD.

### Fuori perimetro
SQL da `Bash` (`psql`, `supabase db query`, `supabase db push`, script con `DATABASE_URL`); altri strumenti MCP di Supabase.

### Dopo il merge
`select to_regprocedure('public.exec_sql(text)')` → NULL; version in `schema_migrations`; `POST /rest/v1/rpc/exec_sql` → 404 PGRST202; advisor 0 ERROR; prova del freno in una sessione nuova.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Se le misure 0.4, 0.5 o 0.12 hanno trovato chiamate da ruoli diversi da `postgres`, aggiungi in cima, in grassetto: **«Qualcuno chiama ancora `exec_sql` da fuori dal repo: dopo il merge riceverà 404 PGRST202.»**

```bash
gh pr create --base main --head robustezza2/s02-sql-arbitrario-e-freno \
  --title "Robustezza2 s02: via exec_sql e freno sulle istruzioni distruttive" \
  --body-file /tmp/kidville-s02-pr.md
gh pr view --json number --jq .number
```

Atteso: l'indirizzo della PR e il suo numero, che diventa `@PR@`.

- [ ] **Passo 4: numero della PR nel PRD e riga di stato «in revisione»**

Sostituisci `@PR@` nella voce del PRD. Nella specifica, la riga si trova per contenuto, mai per numero:

```bash
grep -n "^| 2 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: **una** riga, che il 20/10 era:

```markdown
| 2 | Via `exec_sql` e freno sulle istruzioni distruttive | D1, D10 (istruzioni) | — | da fare | — | `s02-sql-arbitrario-e-freno` | T3 |
```

Sostituiscila con questa, scrivendo al posto di `@AGGIUNTE_FRENO@` le risposte del Compito 1, passo 5:

```markdown
| 2 | Via `exec_sql` e freno sulle istruzioni distruttive | D1, D10 (istruzioni) | — | in revisione | #@PR@ | `docs/superpowers/plans/2026-10-20-robustezza2-s02-sql-arbitrario-e-freno.md` | T3; aggiunte al freno: @AGGIUNTE_FRENO@ |
```

Lo Stato si scrive «in revisione», con queste parole. «In produzione», il commit di `main` e la misura «dopo» per questa riga li scrive **solo** la sessione che apre dopo (§5, «La tabella di stato»), con la sezione «Per la sessione dopo» di questo piano.

```bash
PR=$(gh pr view --json number --jq .number); GIORNO=$(date -u +%F)
sed -i '' -e "s/@PR@/${PR}/g" -e "s/@GIORNO@/${GIORNO}/g" "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
grep -c "^| 2 | .* | in revisione | #${PR} |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s02: PR in revisione nel PRD e nella tabella di stato

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Atteso: il `grep -c` stampa `1`; il `grep` dei gettoni non stampa niente.

- [ ] **Passo 5: CI verde su TUTTI i job**

```bash
gh pr checks "$PR" --watch
```

Atteso: ogni job `pass` (`Lint · Typecheck · Unit` ed `E2E (Playwright)`, i due job di `.github/workflows/ci.yml`). `DB migrate (CI)` non gira sulla PR: `.github/workflows/migrate-ci.yml` parte solo a mano (`workflow_dispatch`), quindi il DB della CI resta senza questa migrazione. Un `cancelled` nel gruppo `e2e-ci-db` non è rosso: un'altra PR ha preso il posto in coda; si rilancia con `gh run rerun <id> --failed`, una PR alla volta. Un rosso vero si legge (`gh run view <id> --log-failed | tail -60`) e si corregge con un commit nuovo.

- [ ] **Passo 6: prova anticipata del freno, prima del merge, in una sessione nuova**

Una sessione avviata **adesso** nel worktree carica `.claude/settings.json` col freno:

```bash
cd /Users/lerri/kidville-web-s02
claude -p "Usa lo strumento mcp__supabase__execute_sql per eseguire esattamente questa query, senza cambiarla: EXPLAIN DELETE FROM public.app_log WHERE false. Riporta parola per parola la risposta dello strumento." 2>&1 | tail -8
claude -p "Usa lo strumento mcp__supabase__execute_sql per eseguire esattamente questa query: SELECT 1 AS prova_freno. Riporta il risultato." 2>&1 | tail -5
grep 'FRENO SQL' .claude/.permessi-auto.log | tail -3
```

Atteso: la prima risposta riporta «Freno SQL: istruzione distruttiva fermata (DELETE)»; la seconda riporta `1`; il registro ha una riga `esito=negato … categoria=DELETE` e una `esito=passato`. L'istruzione di prova è innocua anche se il freno non scattasse (`EXPLAIN` senza `ANALYZE` non esegue niente). Se `claude -p` non vede lo strumento MCP, la stessa prova la fa il titolare in una sessione interattiva aperta nel worktree. **Se la prima non viene rifiutata, non si chiede il merge**: si torna al Compito 3.

- [ ] **Passo 7: il merge lo fa il titolare**

Messaggio al titolare: numero e indirizzo della PR, CI verde su tutti i job, la migrazione che l'integrazione applicherà, l'esito della prova anticipata e le misure del Passo 0 (in grassetto se qualcuno chiama ancora `exec_sql`). **Mai** `gh pr merge`, mai l'auto-merge: si aspetta.

- [ ] **Passo 8: deploy**

Dopo il merge: il deploy di produzione di Vercel col commit del merge deve risultare `Ready` (strumento MCP di Vercel o `vercel ls --prod`). Un deploy non guardato non è un deploy.

- [ ] **Passo 9: `SELECT` di conferma della migrazione (data e ora UTC)**

```sql
SELECT to_regprocedure('public.exec_sql(text)') AS funzione,
       (SELECT count(*) FROM supabase_migrations.schema_migrations
         WHERE version = '@VERSIONE@') AS righe_storico,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc;
```

Atteso: `funzione` NULL, `righe_storico` 1. Se `righe_storico` è 0 dopo dieci minuti, l'integrazione non l'ha applicata: **non** la si applica a mano (§8, divieto 4), lo si dice al titolare con lo stato del controllo dell'integrazione sulla PR.

- [ ] **Passo 10: prova di legge del freno, subito dopo il merge (verifica a caldo)**

*Una configurazione mai vista passare non è configurata.* Sull'albero di `main` aggiornato (`/Users/lerri/kidville-web`, se nessun'altra sessione ci lavora, con `git -C /Users/lerri/kidville-web pull --ff-only`; altrimenti in un worktree nuovo da `origin/main`), il titolare apre una sessione **nuova** di Claude Code e chiede, una alla volta:
1. «Esegui con `execute_sql`: `EXPLAIN DELETE FROM public.app_log WHERE false`» → atteso: rifiutata, con «Freno SQL» e l'invito a mostrarla al titolare;
2. «Esegui con `execute_sql`: `SELECT 1 AS prova_freno`» → atteso: `1`.

Poi `grep 'FRENO SQL' .claude/.permessi-auto.log | tail -2` e `claude --version`. Se la prima **non** viene rifiutata, il freno non è agganciato su `main`: si avvisa subito il titolare e si guarda «Ritorno indietro» e il Compito 3. L'esito non si scrive nel repo: la sessione che apre dopo ripete la prova nella sua sessione, che è nuova e posteriore al merge, e la scrive (sezione «Per la sessione dopo», punto 4).

- [ ] **Passo 11: pulizia dei rami (`AGENTS.md`, punto 3)**

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s02
git -C /Users/lerri/kidville-web branch -D robustezza2/s02-sql-arbitrario-e-freno
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s02-sql-arbitrario-e-freno
git -C /Users/lerri/kidville-web branch -a | grep -v main
```

Atteso: l'ultimo comando non stampa rami di lavoro di questa sessione. Se il ramo remoto non c'è più (cancellato al merge), il terzo comando dice `remote ref does not exist`: va bene.

Non si apre nessun ramo di soli documenti dopo il rilascio (§5): fotografia, riga di stato «in produzione», PRD, misura «dopo» ed esito della prova di legge li scrive la sessione che apre dopo, nel suo primo commit, con la sezione «Per la sessione dopo».

## Ritorno indietro

- **Codice (route, script, test):** Instant Rollback di Vercel subito, poi una PR di revert. Le sei route tornerebbero sigillate (404 in produzione): nessun effetto sui dati.
- **Migrazione:** solo su richiesta del titolare, come migrazione **nuova** dentro la PR di revert, con la version da `date -u +%Y%m%d%H%M%S`; il contenuto è quello del blocco ROLLBACK dell'intestazione (righe 272-282 e 7808-7809 del baseline, o la definizione della produzione se si è usata la variante B). Riapre D1. Mai applicata a mano.
- **Freno:** `export KIDVILLE_FRENO_SQL_SPENTO=1` prima di avviare Claude Code (una sessione), oppure togliere la sua voce da `hooks.PreToolUse` in `.claude/settings.json`; poi **riavviare**. Un falso positivo che ferma una lettura non si risolve spegnendo il freno: si aggiunge il caso a `PASSANO` in `__tests__/architecture/freno-sql-distruttivo.test.ts`, lo si vede rosso, si corregge lo script, PR.
- **Istruzioni degli agenti:** revert dei file `.claude/commands/ship-cycle.md`, `.claude/agents/esecutore-opus.md`, `.claude/rules/migrazioni.md` nella stessa PR di revert; il test del Compito 7 va tolto insieme a loro.

## Per la sessione dopo

Questa sezione la esegue la sessione che apre **dopo** il rilascio della sessione 2 (di solito la 3), nel suo primo commit, prima di ogni codice (§5, «Apertura di una sessione: la chiusura della precedente»). Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Le query sono in **sola lettura**, con `execute_sql` sul database di produzione; i comandi partono dalla radice del worktree della sessione che chiude.

**Che cosa ha lasciato la sessione 2.** Una migrazione, `supabase/migrations/<version>_via_exec_sql.sql`, che fa solo `DROP FUNCTION IF EXISTS public.exec_sql(text)`; il freno `.claude/hooks/supabase_sql_freno.py` registrato in `.claude/settings.json`; i riquadri datati in `CLAUDE.md` e in `docs/storia-permessi-e-conferme.md`, con la prova di legge ancora «da fare». Il numero della PR è nella riga `^| 2 |` della tabella di stato (colonna «PR»).

- [ ] **1. La migrazione è applicata, una volta sola**

```bash
ls supabase/migrations/ | grep "_via_exec_sql\.sql$"
```

Le 14 cifre iniziali sono la `<version>`. Poi, con quel valore:

```sql
SELECT to_regprocedure('public.exec_sql(text)') AS funzione,
       (SELECT count(*) FROM supabase_migrations.schema_migrations
         WHERE version = '{le 14 cifre}') AS righe_storico,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc;
```

Atteso: `funzione` NULL, `righe_storico` 1. Con `righe_storico` 0: **fermati** e avvisa il titolare (la migrazione non si applica a mano). Con `funzione` non NULL e `righe_storico` 1: qualcuno ha ricreato `exec_sql` dopo il merge; **fermati** e avvisa il titolare.

- [ ] **2. Fotografia delle migrazioni applicate — cambia davvero (una version in più)**

```bash
SCRATCH=$(mktemp -d)
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query stampata, salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
grep -c "via_exec_sql" __tests__/architecture/soglia-fotografia.ts
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
```

Atteso: il `grep -c` stampa `0` (la sessione 2 **non** ha scritto voci in `MIGRAZIONI_ATTESE_AL_MERGE`), e i due file sono verdi.

**Nessun'altra fotografia** si rigenera per la sessione 2, e **nessuna voce** si toglie da `MIGRAZIONI_ATTESE_AL_MERGE` o da altre liste «fino alla PR-B»: `DROP FUNCTION` non cambia indici unici, policy, FK, colonne `scuola_id`, bucket né `candidature_insegnanti`, e nessuna delle tre guardie di freschezza lo riconosce (nel file non ci sono `unique`, `primary key`, `policy`, `add`/`drop constraint`, `references utenti`, `drop table`). La voce `exec_sql` in `AMMESSE` di `__tests__/architecture/security-definer-revoke-lock.test.ts` **resta per sempre**: il baseline crea ancora la funzione. Non si tocca.

- [ ] **3. Misura «dopo» — matura subito dopo il merge**

```sql
-- 0.7: nessuna funzione e nessuna vista nomina exec_sql (atteso: nessuna riga, poi 0)
SELECT p.oid::regprocedure::text AS funzione
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.prosrc ILIKE '%exec_sql%'
   AND p.oid <> coalesce(to_regprocedure('public.exec_sql(text)')::oid, 0::oid);

SELECT count(*) AS viste_con_exec_sql FROM pg_views WHERE definition ILIKE '%exec_sql%';

-- 0.8: nessun'altra porta per SQL qualsiasi (atteso: nessuna riga)
SELECT p.oid::regprocedure::text AS funzione
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prosecdef
   AND p.proargnames && ARRAY['sql', 'query', 'istruzione']::text[];
```

Poi PostgREST con la chiave **pubblicabile** (URL e chiave dagli strumenti MCP `get_project_url` e `get_publishable_keys`; la chiave non si scrive in nessun file):

```bash
URL_PROGETTO='…valore di get_project_url…'
CHIAVE_PUBBLICABILE='…valore di get_publishable_keys…'
curl -sS -X POST "$URL_PROGETTO/rest/v1/rpc/exec_sql" \
  -H "apikey: $CHIAVE_PUBBLICABILE" -H 'Content-Type: application/json' \
  -d '{"sql":"select 1"}' -w '\nHTTP %{http_code}\n'
```

Atteso: `HTTP 404` con codice `PGRST202` (si annotano stato e codice, non il resto del corpo). Infine gli advisor di sicurezza (strumento MCP `get_advisors`, tipo `security`): atteso `ERROR` = 0, e comunque non più del «prima» scritto nella voce del PRD. Ogni numero con giorno e ora UTC.

- [ ] **4. Prova di legge del freno — nella tua sessione, che è nuova e posteriore al merge**

*Una configurazione mai vista passare non è configurata.* Chiedi, una alla volta, con lo strumento `execute_sql`:
1. `EXPLAIN DELETE FROM public.app_log WHERE false` → atteso: **rifiutata**, con «Freno SQL» e l'invito a mostrarla al titolare (l'istruzione è innocua anche se passasse: `EXPLAIN` senza `ANALYZE` non esegue niente);
2. `SELECT 1 AS prova_freno` → atteso: `1`.

```bash
grep 'FRENO SQL' .claude/.permessi-auto.log | tail -2
claude --version
```

Atteso: una riga `esito=negato … categoria=DELETE` e una `esito=passato`. Se la prima **non** viene rifiutata: **fermati**, avvisa il titolare, e nella colonna «Note» della riga 2 scrivi «freno NON visto fermare il {giorno}»; i due testi qui sotto restano com'erano.

Se la prova riesce:
- in `CLAUDE.md`, nel riquadro che comincia con `🟥 **Il freno sulle istruzioni distruttive — dal`, cerca il testo `**da fare** (la scrive la sessione dopo, nel suo primo commit)` e sostituisci l'intera frase «Prova in una sessione nuova dopo il merge: **da fare** (la scrive la sessione dopo, nel suo primo commit).» (va a capo dopo «dopo il») con `Provato in una sessione nuova il {giorno} (CLI {versione}).`;
- in `docs/storia-permessi-e-conferme.md`, nel riquadro `### 🟥 APPLICATO IL {giorno} — il freno sulle istruzioni distruttive`, dopo il paragrafo che comincia con `**Come si torna indietro**`, aggiungi:

  ```markdown

  **Prova di legge:** {giorno}, {ora} UTC, CLI {versione}, sessione nuova su `main`: `EXPLAIN DELETE FROM public.app_log WHERE false` rifiutata con «Freno SQL»; `SELECT 1 AS prova_freno` → `1`.
  ```

- [ ] **5. La riga di stato a «in produzione»**

```bash
grep -n "^| 2 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Sostituisci la riga trovata con questa, tenendo le risposte del titolare che la riga «in revisione» porta dopo «aggiunte al freno:»:

```markdown
| 2 | Via `exec_sql` e freno sulle istruzioni distruttive | D1, D10 (istruzioni) | — | in produzione | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s02-sql-arbitrario-e-freno.md` | T3; aggiunte al freno: {come prima}; in produzione il {data UTC del merge}, `main` `{sha corto}`; freno provato in sessione nuova il {giorno} (CLI {versione}); misura dopo del {data e ora UTC}: `exec_sql` assente, `404 PGRST202`, advisor {n} ERROR. `app_log` a 7 giorni: matura dal {giorno del merge + 7} |
```

Lo `{sha corto}` è il commit di merge su `main`:

```bash
gh pr view {numero PR} --repo erricoluigi17/kidville-web --json mergeCommit,mergedAt --jq '"\(.mergeCommit.oid[0:8]) \(.mergedAt)"'
```

- [ ] **6. Misura che matura dopo: `app_log` a 7 giorni dal merge — matura dal giorno del merge + 7**

Se la sessione dopo apre prima di quel giorno, questo punto non si fa ora: lo scrive la **prima PR che tocca la specifica dopo quel giorno**, nella colonna «Note» della riga 2 e nel PRD.

```sql
SELECT count(*) AS righe FROM app_log
 WHERE creato_il > now() - interval '7 days' AND messaggio ILIKE '%exec_sql%';
```

Atteso: `0`, nessun codice dell'app la chiama. Se sono più di 0, si leggono `evento`, `route` e `codice` di quelle righe (mai `messaggio`) e si apre un difetto. Con lo strumento MCP dei log (servizio `api`): il numero di richieste a `/rest/v1/rpc/exec_sql` con stato `404`, con la finestra. È chi la chiamava da fuori: l'effetto voluto, si annota e non si rimedia.

- [ ] **7. Lo Stato della voce nel PRD**

La voce si trova con `grep -n "Robustezza, seconda serie, sessione 2:" "PRD REGISTRO ELETTRONICO.md"`. La sua riga **Stato** diventa:

`✅ in produzione dal {giorno del merge} (PR #{numero PR}, merge {sha corto}); migrazione applicata dall'integrazione, verificata alle {ora} UTC; freno provato in sessione nuova il {giorno} (CLI {versione}).`

e in fondo alla voce si aggiunge un punto **Misura dopo ({data e ora UTC})** con i numeri dei punti 3 e 8, e la riga «`app_log` a 7 giorni: matura dal {giorno}» finché il punto 6 non è fatto.

- [ ] **8. I numeri che la sessione 2 lascia ai lock che altre sessioni toccano dopo**

Nessuna azione sui file: sono il punto di partenza per la sessione 13 (`errori-con-codice` e la sua allowlist), la 12 (`isolamento-sede-coverage`) e la 10 (`admin-guasti-db-non-diventano-valori`). Si leggono e si scrivono nel punto **Misura dopo** della voce del PRD, perché chi tocca quei lock dopo li trovi:

```bash
grep -n "^const MAX_FILE\|^const MAX_OCCORRENZE" __tests__/architecture/errori-con-codice.test.ts
jq '{voci: (.file | length), totale_occorrenze}' docs/superpowers/errori-senza-codice-allowlist.json
grep -n "routeConServiceRole:\|handlerControllati:\|handlerEsentati:" __tests__/architecture/isolamento-sede-coverage.test.ts
grep -c "setup-registro" __tests__/api/admin-guasti-db-non-diventano-valori.test.ts
```

Attesi dal piano: `MAX_FILE = 264`, `MAX_OCCORRENZE = 1350`; allowlist con 264 voci e `totale_occorrenze` 1350 (escono 6 voci e 11 occorrenze); `routeConServiceRole: 357`, `handlerControllati: 555`, `handlerEsentati: 107` (escono le 5 voci `sealDangerous (rpc exec_sql …)`); `0` righe `setup-registro` nel test dei guasti. Se il commit della sessione 2 ha scritto numeri diversi (il piano lo permetteva, quando il lock ne riportava altri, con il commento che spiega la differenza), **valgono quelli del grep**: scrivi quelli.

- [ ] **9. Verifica e commit** (dentro il primo commit della sessione che chiude)

```bash
CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
git add __tests__/fixtures/migrazioni-applicate-snapshot.json docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md" CLAUDE.md docs/storia-permessi-e-conferme.md
git status --short
```

Atteso: tutto verde, e i file in stato `M` (`CLAUDE.md` e la storia solo se la prova del punto 4 è riuscita).

## Autorevisione

Riletta contro la §7 (sessione 2), la §5, la §6 e la §8 della specifica.

| Richiesta della specifica | Dove |
|---|---|
| Misura prima: chiamate di `exec_sql` in `pg_stat_user_functions` | Passo 0.4 (con `track_functions`), più 0.5, 0.12 che coprono il caso «cieca» |
| `DROP FUNCTION IF EXISTS public.exec_sql(text)`, definita solo nel baseline, nessun cron | Compito 6; Passo 0.6-0.7 lo misurano invece di assumerlo |
| Via le 6 route sigillate, compresa quella che la ricrea | Compito 4, passo 3; il lock prende anche `CREATE FUNCTION exec_sql` |
| «`src/lib/security/seal.ts` è generico (`sealDangerous`) e non ha voci da togliere» | Confermato: nessuna voce da togliere (Mappa, «Non si toccano») |
| Via i 6 script che la usano (`scripts/apply_pagamenti_migrations.mjs`, `scripts/apply_settings_hub_migration.mjs`, `scripts/apply_segreteria_migrations.mjs`, `scripts/apply-enrollment-migration.mjs`, `scripts/backfill_presenze_scuola.mjs`, `seed_sql.mjs`); gli altri 4 `scripts/apply_*` restano | Compito 5: quelli che usano `exec_sql` sono 4 (3 `apply_*` + `apply-enrollment-migration.mjs`) più `backfill_presenze_scuola.mjs` e `seed_sql.mjs` nella radice; gli altri 4 `apply_*` usano `DATABASE_URL` e restano (fuori perimetro) |
| Lock su `rpc('exec_sql'` in `src/` e `scripts/` e sulle SECURITY DEFINER con `sql text` nelle migrazioni nuove | Compiti 4, 5, 6 (`niente-sql-arbitrario.test.ts`, con controlli anti-cecità e controllo positivo sul baseline) |
| Allineare i 5 test che diventano rossi e `docs/superpowers/errori-senza-codice-allowlist.json`; la voce `exec_sql` di `AMMESSE` in `security-definer-revoke-lock` resta | Compito 4, passi 5-10 (cinque file che la citano o elencano le route, più `errori-con-codice` e la sua allowlist); `security-definer-revoke-lock` al Compito 6 (solo commento) |
| `.claude/commands/ship-cycle.md` (righe 347-350, e le stesse istruzioni alle 171-172 e 322), `esecutore-opus.md`, `rules/migrazioni.md`, `README.md`, `AGENTS.md`, `CLAUDE.md` → integrazione al merge, merge del titolare | Compito 7 (`ship-cycle.md`, `esecutore-opus.md`, `rules/migrazioni.md`), Compito 5, passo 4 (`README.md`, `docs/env.md`), Compito 8 (`AGENTS.md`, `CLAUDE.md`) |
| Freno `PreToolUse` su `execute_sql` e `apply_migration`, risposta `deny` | Compiti 2-3; il matcher copre anche `mcp__claude_ai_Supabase__*`, perché `execute_sql` del connettore è in `allow` (`settings.json:128`) |
| Ferma `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP`, ogni `apply_migration` | `FERMATE` e il caso `apply_migration` nel test del Compito 2 |
| Lascia passare `SELECT`, `INSERT`, `UPDATE … WHERE`, `CREATE`, `EXPLAIN` | `PASSANO` nel test del Compito 2 |
| Messaggio: mostrare l'istruzione al titolare, editor SQL del pannello | `MOSTRA_AL_TITOLARE`, provato in ogni caso fermato |
| Registrazione in `.claude/settings.json`; via di fuga `KIDVILLE_FRENO_SQL_SPENTO=1` | Compito 3; casi della via di fuga al Compito 2 |
| Riquadro datato in `CLAUDE.md` e nella storia | Compito 8 |
| Test con istruzioni letterali, commenti, maiuscole, più istruzioni | Compito 2 |
| Fuori perimetro: `psql` in `Bash` | «Fuori perimetro», riquadri, `rules/migrazioni.md` |
| Prova: `to_regprocedure` NULL, `404 PGRST202`, advisor 0 ERROR, sessione nuova dopo il riavvio | Rilascio, passi 9 e 10 (più la prova anticipata del passo 6); «Per la sessione dopo», punti 1, 3 e 4, dove la prova si scrive |
| §5: un ramo, worktree nuovo, CI su tutti i job, merge a mano, `SELECT` dopo il merge, conteggio delle iscrizioni prima della migrazione | Compito 1; Rilascio 5, 7, 9; Passo 0.1 |
| §5 e §6: prerequisiti (nessuna PR `robustezza2/` aperta) e chiusura della precedente nel primo commit | Compito 1, passi 1 e 3 |
| §5: riga di stato «in revisione» nella propria PR; «in produzione», misura «dopo» e prova di legge li scrive la sessione dopo | Rilascio, passo 4; «Per la sessione dopo», punti 4-7 |
| §6: sezione «Per la sessione dopo» (fotografia col comando, nessuna voce in `MIGRAZIONI_ATTESE_AL_MERGE`, riga di stato, misura «dopo» e quando matura, PRD, numeri lasciati ai lock) | «Per la sessione dopo», punti 1-9 |
| §7: le aggiunte al freno (interruttori, `session_replication_role`, `DISABLE TRIGGER`, in dubbio si ferma) confermate col titolare all'apertura | Compito 1, passo 5, con la tabella di cosa si toglie per ogni «no» |
| §8, divieto 18: mai `ask` | Test «il freno non approva e non chiede mai» |

**Le aggiunte da confermare (§7, «Cosa si tocca, parte 2»):** la specifica di oggi le elenca come «aggiunta da confermare col titolare all'apertura della sessione»: `set_config`/`SET` di `registri.manutenzione` e `scatola_nera.*`, `session_replication_role`, `DISABLE TRIGGER`, e ogni istruzione che il freno non sa leggere. Il piano le scrive tutte nel codice del Compito 2, ma non le dà per approvate: il Compito 1, passo 5, le mostra al titolare e aspetta il sì; per ogni «no» la tabella di quel passo dice quale alternativa di `INTERRUTTORI`, quale ramo di `main()` e quali casi di `FERMATE`/`ILLEGGIBILI` si tolgono. Le risposte vanno nel PRD e nella riga 2 della tabella di stato (`@AGGIUNTE_FRENO@`).

**Segnaposto:** nessuno; i soli gettoni sono i valori misurati o generati il giorno dell'esecuzione, elencati in «Convenzioni», con il controllo `grep` prima di ogni commit.

**Nomi coerenti fra i compiti:** `supabase_sql_freno.py`, `freno-sql-distruttivo.test.ts`, `niente-sql-arbitrario.test.ts`, `@VERSIONE@_via_exec_sql.sql`, `KIDVILLE_FRENO_SQL_SPENTO`, `MOSTRA_AL_TITOLARE`, `chiamateVietate`, `sorgentiSotto`, `colpevoli`, `PERCHE`, `ESTENSIONI`, `funzioniSqlArbitrario`, `DROP_EXEC_SQL` — ognuno definito nel compito che lo crea e usato con lo stesso nome dopo.
