# Sessione 8 — Correggere i cron e l'igiene del database — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** niente più timeout finti di pg_net, niente chiamate a vuoto ogni minuto a `/api/admin/storici/cron`, tabelle di servizio con un tetto (`cron.job_run_details` a 14 giorni, `app_log` con gli errori a 90 giorni per T7), sessioni `idle in transaction` chiuse dopo 60 s per i tre ruoli dell'API, e due corse di concorrenza chiuse (promemoria e sincronizzazione delle fatture).

**Architettura:**
- **Quattro migrazioni.** `*_cron_timeout_uguale_max_duration.sql` ridefinisce, a partire dai corpi letti in produzione, le funzioni che chiamano `public.cron_http_post` (l'involucro della sessione 6) cambiando nella chiamata **solo** l'argomento nominato `timeout_milliseconds`, che diventa il `maxDuration` della route (aggiunto in fondo alla chiamata dove mancava e valeva il default di 5000 ms); la genera uno script fuori dal repository col modulo `scripts/cron-esiti/timeout.mjs`, lo stesso che usa il lock `cron-max-duration`, esteso al lato SQL con la tabella funzione → job → route (il percorso non è nella chiamata: l'URL lo legge dal Vault la funzione chiamante). `*_storici_tick_solo_con_lavoro.sql` fa chiamare il server a `storici_tick` solo quando `storici_generazioni` ha una riga che la route prenderebbe. `*_igiene_cron_log_ruoli.sql` porta `app_log_purge` a due tempi (T7), aggiunge il job `cron-storico-purge` e imposta `idle_in_transaction_session_timeout = 60s` su `service_role`, `authenticated`, `anon` con una guardia che scrive in `app_log` invece di fermare l'integrazione. `*_promemoria_e_sync_senza_doppioni.sql` aggiunge `notifiche.chiave_dedup` con un indice unico **non parziale** e la tabella `cron_prese` con due RPC per la presa con scadenza.
- **Codice.** `scripts/cron-esiti/timeout.mjs` (nuovo) legge il job e il timeout della chiamata all'involucro e lo riscrive, fermandosi su ogni forma che non conosce. `enqueueNotifiche` impara la chiave di deduplica (upsert `ON CONFLICT (chiave_dedup) DO NOTHING`, con ripiego dichiarato sul DB non migrato); i promemoria dei moduli e dei documenti la passano. La sincronizzazione delle fatture prende la presa `fattura-sync` prima del giro e la rilascia in un `finally` (`src/lib/cron/presa.ts`, nuovo).
- **Informativa.** La voce «log tecnici» dice i 90 giorni delle righe d'errore: versione nuova, impronta depositata.

**Tecnologie:** Postgres 17 su Supabase (PL/pgSQL, `SECURITY DEFINER`, pg_cron, pg_net, `ALTER ROLE … SET`), PostgREST (upsert con `onConflict` + `ignoreDuplicates`, RPC), Next 16 App Router (route avvolte in `withRoute`), PGlite (`@electric-sql/pglite`) per provare le migrazioni lette dal disco, vitest, Node 24 per lo script che genera la prima migrazione.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 8 — Correggere i cron e l'igiene del database» (righe 567-605 il 20/10), con la decisione T7 nella tabella della §2 (riga 56), la riga di stato `| 8 |` della §1 (colonna «Dopo»: 6, 7) e le regole comuni della §5 (righe 133-208), in particolare «Codice che regge il momento del merge», «La tabella di stato», «Apertura di una sessione: i prerequisiti» e «… la chiusura della precedente».

---

## Mappa dei file

| File | Ruolo | Righe lette |
|---|---|---|
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` (e le altre fotografie che nomina la sezione «Per la sessione dopo» della sessione rilasciata per ultima) | **Modifica.** Rigenerate dalla produzione nel primo commit (Compito 1, chiusura della precedente) | procedura in `__tests__/fixtures/migrazioni-fotografia.mjs` (commento di testa) |
| `__tests__/architecture/soglia-fotografia.ts` | **Modifica** la costante `MIGRAZIONI_ATTESE_AL_MERGE` (riga 251 il 20/10): nel Compito 1 si tolgono le voci che la sessione precedente nomina; nel Compito 6 si dichiara la migrazione dei doppioni | 225-300, 350-415 |
| `__tests__/architecture/cron-max-duration.test.ts` | **Modifica.** Due `import` dopo la riga 3 e un blocco in fondo: tabella `CHIAMANTI_CRON` (funzione → job → route) e `timeout_milliseconds` = `maxDuration` × 1000. Le righe 1-87 restano come sono. **Lo allarga anche la sessione 9** (Compito 11 del suo piano: `maxDuration` su 20 route lunghe, `ROUTE_LUNGHE`), che parte dal lock **come la 8 l'ha lasciato**: la 8 viene prima, la 9 riparte da `main` dopo il rilascio della 8. Per questo la 8 non tocca le righe che la 9 sostituisce per contenuto (2, 5-19, 49-58), non importa `existsSync` (la 9 lo aggiunge alla riga 2) e non usa i nomi `durataDichiarata`, `fuoriMisura`, `ROUTE_LUNGHE`, `IMPORT_PESANTE` | 1-87 |
| `scripts/cron-esiti/timeout.mjs` | **Crea.** `chiamataAllInvolucro`, `conTimeout`, `TIMEOUT_PREDEFINITO_MS`: legge job e timeout della chiamata all'involucro, riscrive il solo `timeout_milliseconds`. Lo usano il lock e lo script che genera la migrazione | nuovo |
| `scripts/cron-esiti/involucro.mjs` (sessione 6) | Sola lettura: `mascheraSql`, `corpoDi`, `corpoOVuoto`, `contaChiamate`, `ultimeDefinizioni`, `INVOLUCRO`, `NON_SI_AVVOLGONO`, `ASSENTI_IN_PRODUZIONE` | piano della sessione 6, Compito 2 (righe 699-1000) |
| `supabase/migrations/<version>_cron_esiti_osservati.sql` (sessione 6) | Sola lettura: `cron_chiamate`, `cron_ultimo_esito`, firma di `cron_http_post`, `storici_tick` avvolta (per il ritorno indietro) | piano della sessione 6, righe 1645-1754 |
| `supabase/migrations/<version>_cron_timeout_uguale_max_duration.sql` | **Crea** (generata). `timeout_milliseconds` nella chiamata a `cron_http_post` = `maxDuration` della route | nuovo |
| `supabase/migrations/<version>_storici_tick_solo_con_lavoro.sql` | **Crea.** `storici_tick` filtrato sulla coda, Vault letto solo con lavoro, eccezioni in `app_log` | nuovo |
| `supabase/migrations/<version>_igiene_cron_log_ruoli.sql` | **Crea.** `app_log_purge` (T7), `cron_storico_purge` + job, timeout dei ruoli | nuovo |
| `supabase/migrations/<version>_promemoria_e_sync_senza_doppioni.sql` | **Crea.** `notifiche.chiave_dedup` + indice unico, `cron_prese`, `cron_presa_prendi`, `cron_presa_rilascia` | nuovo |
| `__tests__/lib/storici-tick-solo-con-lavoro-sql.test.ts` | **Crea.** PGlite | nuovo |
| `__tests__/lib/igiene-cron-log-ruoli-sql.test.ts` | **Crea.** PGlite | nuovo |
| `__tests__/lib/promemoria-sync-senza-doppioni-sql.test.ts` | **Crea.** PGlite | nuovo |
| `src/lib/push/enqueue.ts` | **Modifica 26-41** (parametro), **78-88** (righe), **98-115** (scrittura con la chiave) | 1-148 |
| `src/lib/notifiche/triggers.ts` | **Modifica 23-46** (parametro) **e 198-212** (passaggio all'enqueue) | 1-60, 185-225 |
| `src/app/api/notifiche/promemoria/route.ts` | **Modifica 242-252 e 375-385.** Chiave per i moduli e per i documenti; le letture di deduplica (224-237, 349-359) restano | 140-150, 218-256, 340-390 |
| `__tests__/lib/push-enqueue-chiave-dedup.test.ts` | **Crea.** | nuovo |
| `__tests__/lib/notifiche-chiave-dedup.test.ts` | **Crea.** | nuovo |
| `__tests__/architecture/onconflict-arbitro.test.ts` | **Modifica** l'array `SENZA_ARBITRO_ATTESO` (righe 86-130 il 20/10): voce `notifiche`/`chiave_dedup`, **permanente** (l'indice tratta i NULL come distinti per scelta, e il lock non sa che la chiave non è mai NULL: vedi il Compito 7, Passo 6) | 86-130, 225-300, 314-530 |
| `src/lib/cron/presa.ts` | **Crea.** `prendiPresaCron`, `rilasciaPresaCron`, `DURATA_PRESA_CRON_S` | nuovo |
| `__tests__/lib/cron-presa.test.ts` | **Crea.** | nuovo |
| `src/app/api/pagamenti/fattura/sync/route.ts` | **Modifica 27** (import), **257-258** (il giro diventa `giroSync`), **286** (client riusato), **1111-1117** (POST nuovo con la presa) | 1-30, 215-300, 1040-1117 |
| `__tests__/api/fattura-sync-presa.test.ts` | **Crea.** | nuovo |
| `__tests__/api/fattura-sync.test.ts`, `fattura-sync-notifiche.test.ts`, `fattura-sync-destinatari-sede.test.ts`, `cron-battito.test.ts` | **Modifica.** Una riga di `vi.mock('@/lib/cron/presa', …)` ciascuno | 1-100; 45-66; 20-40; 95-145 e 620-670 |
| `src/lib/health/controlli.ts` | **Modifica** in fondo all'array `JOB_CRON_NON_SORVEGLIATI` (righe 380-435 il 20/10; ancora: la `]` seguita dal commento `/** La finestra più larga: …`): `cron-storico-purge` | 150-200, 380-440 |
| `__tests__/architecture/informativa-conservazione-dichiarata.test.ts` | **Modifica 350-354.** `app-log-purge` e `cron-storico-purge` in `BATTITI_DA_LEGGERE` | 340-460, 505-560 |
| `src/app/privacy/page.tsx` | **Modifica 855-858.** Voce «log tecnici» | 850-862 |
| `src/lib/legal/versioni.ts` | **Modifica 250-269.** Commento e `VERSIONE_PRIVACY` | 250-272 |
| `__tests__/architecture/pagine-legali.test.ts` | **Modifica dopo la riga della versione in vigore** (oggi 419). Impronta nuova | 405-425, 555-570 |
| `src/lib/storici/generazioni.ts` | Sola lettura: `DURATA_LEASE_MS` 36, `riprendiGenerazioni` e `pulisciGenerazioniScadute` 154-182 | 30-40, 150-185 |
| `src/app/api/admin/storici/cron/route.ts` | **Non cambia** | 1-23 |
| `supabase/migrations/20260713090000_app_log.sql` | Sola lettura: colonne 60-112, `app_log_purge` 226-251 (come dice la specifica), job 252-262 | 60-112, 226-268 |
| `supabase/migrations/20261019223123_battiti_app_log_che_contano.sql` | Sola lettura: `storici_tick` del 19/10 207-244 (controllo negativo), modello ROLLBACK 37-39 | 1-60, 200-244 |
| `supabase/migrations/20261010230945_code_robuste_prese_con_scadenza.sql` | Sola lettura: modello della presa con scadenza | 1-76 |
| `supabase/migrations/20260911113000_fattura_sync_timeout_pg_net.sql` | Sola lettura: timeout finti e lotti di pg_net | 1-60 |
| `PRD REGISTRO ELETTRONICO.md` | **Modifica.** Changelog in cima (prima della riga 1) | 1-30 |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | **Modifica** la riga della sessione 8 nella tabella di stato (la 32 il 20/10; si trova per contenuto, Compito 10, Passo 2), più la riga che la sezione «Per la sessione dopo» della precedente porta a «in produzione» (Compito 1) | 21-43, 133-245, 567-605 |

---

## Passo 0 — misura prima

Tutto in **sola lettura**: strumento MCP `execute_sql` sul progetto di produzione, solo `SELECT` (e `SHOW`). Le risposte sono conteggi, nomi di job, di tabelle e di funzioni, corpi di funzioni: nessun dato personale. I numeri vanno nel file delle misure `${TMPDIR:-/tmp}/s08-misure.env` (fuori dal repository, una riga `CHIAVE=valore` per numero) e da lì nel PRD (Compito 10).

Le query di questo piano usano le tabelle e l'involucro della sessione 6 con i nomi e la forma del suo piano (`docs/superpowers/plans/2026-10-20-robustezza2-s06-esiti-cron.md`, migrazione `*_cron_esiti_osservati.sql`, righe 1645-1754 del piano):
- `public.cron_chiamate(id, job, richiesta_id, percorso, timeout_ms integer, inviata_il timestamptz, esito, codice_http, codice_errore, errore, verificata_il)`, con `esito` fra `in-attesa`, `ok`, `errore-http`, `errore-rete`, `timeout`, `esito-ignoto`; `percorso` è il percorso dell'URL senza query string, ricavato dall'involucro; le righe verificate restano 14 giorni;
- `public.cron_ultimo_esito(job PK, attivo, pianificazione, http, ultimo_runid, ultima_esecuzione_il, ultima_esecuzione_stato, ultima_chiamata_il, ultima_chiamata_esito, ultimo_codice_http, ultimo_ok_il, ultimo_errore_il, aggiornato_il)`;
- `public.cron_http_post(job text, url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{"Content-Type": "application/json"}', timeout_milliseconds integer DEFAULT 5000) RETURNS bigint`: gli argomenti e i default di `net.http_post` col job davanti. Non legge configurazione né Vault (l'URL lo legge dal Vault la funzione chiamante, che lo passa) e scrive in `app_log` solo se non riesce a scrivere in `cron_chiamate`.

La sessione 6 ha trasformato ogni `net.http_post(` in `public.cron_http_post('<job>', ` lasciando **invariati** gli argomenti di prima (URL dal Vault, header, corpi e timeout, quasi sempre per nome: `url := v_url`, `timeout_milliseconds := 120000`, o con `=>`). Quindi, in questo piano: il **job** è il primo letterale dopo `cron_http_post(`; il **timeout** è l'argomento nominato `timeout_milliseconds` **dentro quella chiamata**, e se manca vale il default 5000; il **percorso** non è nella chiamata, e la route di ogni funzione la dice la tabella `CHIAMANTI_CRON` del lock (Compito 3). Il Passo 2 del Compito 2 verifica tabelle, colonne e firma: se non tornano, la sessione si ferma lì.

### Compito 1 — Prerequisiti, worktree, ramo e chiusura della sessione rilasciata per ultima

**File** (solo quelli che nomina la sezione «Per la sessione dopo» della sessione rilasciata per ultima, Passo 4):
- Modifica: `__tests__/fixtures/migrazioni-applicate-snapshot.json` e le altre fotografie di `__tests__/fixtures/` che quella sezione nomina
- Modifica: `__tests__/architecture/soglia-fotografia.ts` (costante `MIGRAZIONI_ATTESE_AL_MERGE`) e ogni altro lock che quella sezione nomina
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga di stato di quella sessione) e `PRD REGISTRO ELETTRONICO.md` (lo Stato della sua voce, i suoi numeri «dopo»)

- [ ] **Passo 1: i prerequisiti — colonna «Dopo» della riga 8: sessioni 6 e 7**

Per ciascuna si verificano due fatti (PR mergiata, migrazioni applicate), **mai** il testo dello «Stato» della tabella, che lo chiude la sessione successiva. Le PR:

```bash
git -C /Users/lerri/kidville-web fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s06-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s07-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: una riga per comando, `<numero> <data del merge>`. Poi le migrazioni che quelle due PR hanno portato (la 6 aveva `*_cron_esiti_osservati.sql`, la 7 `*_salute_rpc_sola_lettura.sql`; fa fede l'elenco dei file della PR):

```bash
for s in s06 s07; do
  n=$(gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/$s-" --json number,headRefName --jq '[.[] | select(.headRefName | endswith("-esito") | not)][0].number')
  echo "$s #$n"
  gh pr view "$n" --repo erricoluigi17/kidville-web --json files --jq '.files[].path | select(startswith("supabase/migrations/")) | ltrimstr("supabase/migrations/")'
done
```

Atteso: per ciascuna, il numero della PR e almeno un file il cui nome comincia con quattordici cifre (la version). Con lo strumento MCP `execute_sql`, **sola lettura**, mettendo nella lista le version stampate:

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE version IN ('<version del file della 6>', '<version del file della 7>')
 ORDER BY version;
```

Atteso: una riga per ogni file stampato sopra, con la stessa version. Infine nessuna PR della serie aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: nessuna riga. Se un controllo fallisce (una PR non mergiata, una version assente dal registro, una PR della serie aperta), **fermati**: la riga 8 vuole la 6 e la 7 in produzione (§1, colonna «Dopo»), e la §5 vuole una sessione alla volta.

- [ ] **Passo 2: worktree e ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s08-cron-e-igiene /Users/lerri/kidville-web-s08-cron-e-igiene origin/main
cd /Users/lerri/kidville-web-s08-cron-e-igiene && git status -sb | head -3
```

Atteso: `## robustezza2/s08-cron-e-igiene...origin/main`, albero pulito. Da qui ogni comando gira in `/Users/lerri/kidville-web-s08-cron-e-igiene`, mai nel checkout principale.

- [ ] **Passo 3: `.env.local` e dipendenze**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s08-cron-e-igiene/.env.local
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 4: la chiusura della sessione rilasciata per ultima (§5, la «PR-B»)**

Si chiude la sessione `robustezza2/` mergiata più di recente, **qualunque numero abbia** (con l'ordine 1→14 è di solito la 7, ma non si presume: la 9 dipende solo dalla 7 e può essere uscita prima di questa):

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga `<numero> robustezza2/sNN-<nome>`. Il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-sNN-<nome>.md` (il nome del ramo senza `robustezza2/`). Se la sua riga di stato su `origin/main` dice già «in produzione» (`git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep "^| NN |"`, con il numero della sessione senza lo zero davanti), la chiusura l'ha già fatta un ramo `-esito`: salta al Passo 5.

Altrimenti apri quel piano con `Read`, vai alla sua sezione finale «Per la sessione dopo» (subito prima di «Autorevisione») e fai **tutto** quello che elenca, nell'ordine in cui lo elenca: fotografie rigenerate dalla produzione, voci tolte da `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste, riga di stato a «in produzione» col commit di `main`, Stato della sua voce nel PRD, misure «dopo» già mature (le altre restano lì, con la loro data). Non si indovina e non si aggiunge niente che quella sezione non dica.

La fotografia delle migrazioni si rigenera **sempre** quando quella sessione aveva migrazioni (`gh pr view <numero> --repo erricoluigi17/kidville-web --json files --jq '.files[].path | select(startswith("supabase/migrations/"))'` ne stampa almeno una). I comandi completi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa con `execute_sql` (sola lettura), salva la risposta JSON, così com'è, in `${TMPDIR:-/tmp}/s08-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/s08-migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  2 passed` dopo che hai tolto da `MIGRAZIONI_ATTESE_AL_MERGE` le voci che quella sezione nomina (il test «2 · nessuna chiave è già applicata» resta rosso finché ci sono). Le altre fotografie che la sezione nomina (indici unici, policy, chiavi esterne, bucket…) si rigenerano **prima** di togliere le voci: senza, le guardie `toccaUnUnico` e `toccaLaRls` di `soglia-fotografia.ts` segnalano la migrazione come posteriore alla fotografia. Nel commento sopra la costante, sotto il blocco della sessione chiusa, aggiungi la riga `// SVUOTATA il <data UTC> (PR-B dopo il merge di #<numero>, <commit di main>): applicata dall'integrazione; fotografie rigenerate dalla produzione.`, come le voci precedenti; il commit di `main` lo dà `gh pr view <numero> --repo erricoluigi17/kidville-web --json mergeCommit --jq '.mergeCommit.oid[0:8]'`.

- [ ] **Passo 5: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: tutti i file verdi tranne, al massimo, `offline-html-nativo` al primo giro (in un worktree nuovo la shell nativa non è sincronizzata); col secondo comando `1 passed`. Se è rosso un altro lock di fotografia (`onconflict-arbitro`, `rls-per-sede`, `fk-scuola-id`, …), rigenera quella fotografia con il generatore che il suo messaggio d'errore nomina, sempre dalla produzione. Leggi la riga `Test Files`, non il codice d'uscita di una pipe.

- [ ] **Passo 6: commit (il primo della sessione: la chiusura della precedente)**

```bash
git add __tests__/fixtures/ __tests__/architecture/ "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git status --short
```

Atteso: solo file in stage (prima colonna `M` o `A`), tutti nominati dalla sezione «Per la sessione dopo» del Passo 4. Se quella sezione ha chiesto di cambiare un file fuori da queste cartelle (per esempio `src/lib/health/controlli.ts`, per portare un job da `JOB_CRON_NON_SORVEGLIATI` a `JOB_CRON`), aggiungilo per nome con `git add <percorso>`. Se il Passo 4 è stato saltato e non c'è niente in stage, non si fa nessun commit: si passa al Compito 2.

```bash
git commit -m "$(cat <<'EOF'
Chiusura della sessione rilasciata per ultima (PR-B): fotografie e stato

Apre la sessione 8 della seconda serie di robustezza: esegue la sezione «Per la
sessione dopo» del piano della sessione mergiata più di recente (fotografie
rigenerate dalla produzione, voci tolte dalle liste d'attesa, riga di stato e PRD).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git status --short
```

Atteso: l'ultimo comando non stampa niente.

---

### Compito 2 — Le misure «prima»

**File:** nessuno nel repository. File delle misure: `${TMPDIR:-/tmp}/s08-misure.env`. Gli altri file di questo Compito stanno nella stessa cartella e si chiamano `s08-*`.

- [ ] **Passo 1: le domande d'iscrizione (§5)**

```sql
SELECT count(*) FROM enrollment_submissions;
```

Scrivi `ISCRIZIONI=` col numero e `ISCRIZIONI_ALLE=` con l'output di `date -u '+%Y-%m-%d %H:%M'`. Si conta, non si copia.

- [ ] **Passo 2: l'involucro e le tabelle della sessione 6**

```sql
SELECT table_name,
       string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS colonne
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('cron_chiamate', 'cron_ultimo_esito')
 GROUP BY 1 ORDER BY 1;

SELECT pg_get_constraintdef(c.oid) AS vincolo
  FROM pg_constraint c
 WHERE c.conrelid = to_regclass('public.cron_chiamate') AND c.contype = 'c';

SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'cron_http_post') AS involucri,
       to_regprocedure('public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer)') IS NOT NULL AS firma_giusta,
       pg_get_function_arguments(to_regprocedure('public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer)')) AS argomenti,
       pg_get_function_result(to_regprocedure('public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer)')) AS restituisce;
```

Atteso:
- `cron_chiamate`: `id:bigint, job:text, richiesta_id:bigint, percorso:text, timeout_ms:integer, inviata_il:timestamp with time zone, esito:text, codice_http:integer, codice_errore:text, errore:text, verificata_il:timestamp with time zone`;
- `cron_ultimo_esito`: fra le altre, `job:text` e `ultimo_runid:bigint`;
- un vincolo `CHECK` su `esito` che contiene `'timeout'`;
- `involucri = 1`, `firma_giusta = true`, `argomenti` = `job text, url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000`, `restituisce = bigint`.

**Soglia che cambia il piano.** Se manca una delle due tabelle o una delle colonne elencate, se il vincolo non ammette `'timeout'`, se l'involucro non è uno solo con quella firma o se il default di `timeout_milliseconds` non è 5000, **fermati**: la sessione 6 in produzione non è quella del suo piano, e i Compiti 3, 4 e 5 sono scritti su quella. I nomi non si adattano a mano.

- [ ] **Passo 3: chi chiama il server, e con quale timeout**

```sql
SELECT p.proname AS funzione,
       p.prosrc ~ 'net\.http_post\s*\(' AS diretta,
       (SELECT count(*) FROM regexp_matches(p.prosrc, 'cron_http_post\s*\(', 'g')) AS chiamate,
       substring(p.prosrc from 'cron_http_post\s*\(\s*''([a-z0-9-]+)''') AS job,
       p.prosrc ~ 'timeout_milliseconds\s*(:=|=>)' AS timeout_nominato,
       coalesce(substring(p.prosrc from 'timeout_milliseconds\s*(?::=|=>)\s*(\d+)')::int, 5000) AS timeout_ms
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname NOT IN ('cron_http_post', 'cron_esiti')
   AND (p.prosrc ~ 'cron_http_post\s*\(' OR p.prosrc ~ 'net\.http_post\s*\(')
 ORDER BY 1;
```

Salva il risultato in `${TMPDIR:-/tmp}/s08-chiamanti.tsv` (una riga per funzione, colonne nell'ordine della query). `timeout_ms` è il valore di `timeout_milliseconds`, o 5000 dove l'argomento manca. È una lettura veloce sul corpo intero: la lettura esatta, **dentro** la chiamata all'involucro, la fa il modulo del Compito 3, e il lock la rifà. Scrivi `CHIAMANTI_N=` col numero di righe e `TIMEOUT_PRIMA=` con l'oggetto JSON `{"funzione": timeout_ms, …}` delle righe con `diretta = false` (servirà al ritorno indietro); salvalo anche in `${TMPDIR:-/tmp}/s08-timeout-prima.json`.

Poi il percorso che ogni job chiama davvero, registrato dall'involucro (le righe verificate restano 14 giorni):

```sql
SELECT c.job,
       string_agg(DISTINCT c.percorso, ', ') AS percorsi,
       count(*) AS chiamate,
       min(c.timeout_ms) AS timeout_min,
       max(c.timeout_ms) AS timeout_max
  FROM public.cron_chiamate c
 GROUP BY 1 ORDER BY 1;
```

Salva il risultato in `${TMPDIR:-/tmp}/s08-percorsi.tsv`.

**Soglia che cambia il piano.**
- Ogni riga della prima query con `diretta = false`, `chiamate = 1` e `job` non nullo, salvo le funzioni che la sessione 6 ha escluso con la loro ragione (`NON_SI_AVVOLGONO` in `scripts/cron-esiti/involucro.mjs`: oggi `genera_solleciti`, che resta con `diretta = true` e `chiamate = 0`). Una chiamata diretta fuori da quell'elenco, o due chiamate all'involucro nella stessa funzione, vuol dire che la sessione 6 non è completa: **fermati**.
- Il 20/10 il rapporto contava 20 funzioni (16 a 5000 ms, una delle quali solo in produzione, e 4 fra 120 e 300 s). Nel repo, prima della sessione 6, sono 19 (15 senza `timeout_milliseconds`, cioè a 5000 ms; `fatture_sdi_sync_tick`, `fatture_coda_tick_http`, `storici_tick` a 300000; `iscrizioni_retention_http` a 120000). La funzione in più è quella che esisteva solo in produzione, e dopo la sessione 6 è definita anche nella sua migrazione: annota il suo nome, il suo job e il percorso registrato per quel job (seconda query), entrano nella tabella del Compito 3.
- Per ogni job della seconda query, `percorsi` è **uno** solo e corrisponde a un file `src/app<percorso>/route.ts` del repo; `timeout_min` e `timeout_max` sono uguali al `timeout_ms` della sua funzione nella prima query. Un percorso senza route, due percorsi per lo stesso job o un timeout registrato diverso da quello letto nel corpo sono un guasto da capire prima di toccare il timeout: **fermati**. I job senza righe in `cron_chiamate` (un mensile che non ha girato dal rilascio della sessione 6) tengono la route che `CHIAMANTI_CRON` ha preso dal repo: scrivili in `SENZA_PERCORSO=` nel file delle misure.

- [ ] **Passo 4: i corpi da cui partire, presi dalla produzione**

```sql
SELECT p.proname AS funzione,
       format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS firma,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_esegue,
       pg_get_functiondef(p.oid) AS definizione
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname <> 'cron_http_post'
   AND (p.prosrc ~ 'cron_http_post\s*\(' OR p.prosrc ~ 'net\.http_post\s*\(')
 ORDER BY 1;
```

Salva l'array JSON delle righe, così com'è, in `${TMPDIR:-/tmp}/s08-chiamanti.json` (con lo strumento di scrittura dei file, senza ritoccarlo). Poi:

```sql
SELECT p.proname AS funzione, pg_get_functiondef(p.oid) AS definizione
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('storici_tick', 'app_log_purge', 'cron_http_post')
 ORDER BY 1;
```

Salvalo in `${TMPDIR:-/tmp}/s08-altre-funzioni.json` e controlla:

```bash
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const d = Object.fromEntries(r.map((x) => [x.funzione, x.definizione]))
const purge = d.app_log_purge ?? "", tick = d.storici_tick ?? "", inv = d.cron_http_post ?? ""
console.log("purge come il repo:", /interval .30 days./.test(purge) && /LIMIT 10000/.test(purge) && !/error/i.test(purge))
console.log("tick con involucro:", /public\.cron_http_post\s*\(/.test(tick),
  "· job:", (/cron_http_post\s*\(\s*\x27([a-z0-9-]+)\x27/.exec(tick) ?? [])[1],
  "· timeout:", (/timeout_milliseconds\s*(?::=|=>)\s*(\d+)/.exec(tick) ?? [])[1] ?? "5000 (predefinito)",
  "· vault:", /cron_config\s*\(/.test(tick))
console.log("tick con la regola di uscita:", /alunno_uscita_consolidata/.test(tick), "· già filtrato:", /storici_generazioni/.test(tick))
console.log("involucro registra in cron_chiamate:", /insert\s+into\s+public\.cron_chiamate/i.test(inv))
' "${TMPDIR:-/tmp}/s08-altre-funzioni.json"
```

Atteso: `purge come il repo: true`; `tick con involucro: true · job: storici-stampe · timeout: 300000 · vault: true`; `tick con la regola di uscita: true · già filtrato: false`; `involucro registra in cron_chiamate: true`. **Soglia:** se la purge di produzione non è quella del repo, **fermati** (qualcuno l'ha cambiata a mano: il Compito 5 riporterebbe in vita una versione vecchia). Se `timeout` non è 300000 o `vault` è `false`, la `storici_tick` di produzione non è quella del 19/10 avvolta dalla sessione 6, su cui è scritto il Compito 4: **fermati**. Se il job dell'involucro in `storici_tick` non è `storici-stampe`, usa quello letto qui al posto di `storici-stampe` (migrazione e test del Compito 4) e nella tabella del Compito 3. Se il corpo di produzione di `storici_tick` contiene qualcosa che il corpo del Compito 4 non ha (oltre alla chiamata a `cron_http_post` e alla lettura di URL e segreto dal Vault, che il Compito 4 tiene), riportalo nel corpo nuovo prima del Passo 3 del Compito 4.

Infine il file della sessione 6 che contiene l'involucro e la `storici_tick` avvolta (serve al ritorno indietro):

```bash
ls supabase/migrations/*_cron_esiti_osservati.sql
```

Atteso: un file solo. Scrivi `S06_FILE=` col suo nome, senza la cartella.

- [ ] **Passo 5: timeout e chiamate a storici, al giorno**

```sql
SELECT date_trunc('day', c.inviata_il) AS giorno,
       count(*) FILTER (WHERE c.esito = 'timeout') AS timeout,
       count(*) FILTER (WHERE c.percorso = '/api/admin/storici/cron') AS chiamate_storici,
       count(*) AS chiamate
  FROM public.cron_chiamate c
 WHERE c.inviata_il > now() - interval '7 days'
 GROUP BY 1 ORDER BY 1;

SELECT c.job,
       count(*) FILTER (WHERE c.esito = 'timeout') AS timeout_7g,
       count(*) AS chiamate_7g,
       max(c.timeout_ms) AS timeout_ms
  FROM public.cron_chiamate c
 WHERE c.inviata_il > now() - interval '7 days'
 GROUP BY 1 ORDER BY 2 DESC;

SELECT count(*) AS lavori_di_stampa_24h
  FROM public.storici_generazioni
 WHERE creato_il > now() - interval '24 hours';
```

Scrivi `TIMEOUT_GIORNO=` (media dei giorni completi, righe con `esito = 'timeout'`), `GIORNI_TIMEOUT=` (quanti giorni completi), `STORICI_CHIAMATE_GIORNO=` (media dei giorni completi), `STAMPE_24H=`. La specifica attende ~108 timeout e ~1.440 chiamate a storici al giorno. **Soglia:** se `cron_chiamate` ha meno di un giorno completo, la misura «prima» non c'è ancora: aspetta 24 ore dal rilascio della sessione 6. Se i timeout sono 0, il Compito 3 non ha un difetto da correggere: chiedi al titolare se procedere solo con l'allineamento al `maxDuration`.

- [ ] **Passo 6: quanto aspetta una richiesta, per job (il rischio dei 300 s)**

```sql
SELECT extversion FROM pg_extension WHERE extname = 'pg_net';

SELECT c.job, count(*) AS n,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM r.created - c.inviata_il)) AS p50_s,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.created - c.inviata_il)) AS p95_s
  FROM public.cron_chiamate c
  JOIN net._http_response r ON r.id = c.richiesta_id AND r.created >= c.inviata_il - interval '1 minute'
 WHERE c.inviata_il > now() - interval '6 hours'
 GROUP BY 1 ORDER BY 1;
```

La condizione su `r.created` è la stessa del lettore della sessione 6: un numero di richiesta ripreso dopo un riavvio di pg_net non si attribuisce a una chiamata vecchia. Scrivi `PG_NET=` con la versione e salva la tabella in `${TMPDIR:-/tmp}/s08-latenze-prima.txt`. È la base del confronto «dopo»: il worker di pg_net lavora a lotti (`20260911113000_fattura_sync_timeout_pg_net.sql`), e con timeout di 300 s una route lenta può ritardare le richieste degli altri job dello stesso giro.

- [ ] **Passo 7: lo storico dei job**

```sql
SELECT count(*) AS righe,
       pg_size_pretty(pg_total_relation_size('cron.job_run_details')) AS dimensione,
       min(start_time) AS la_piu_vecchia,
       count(*) FILTER (WHERE start_time > now() - interval '24 hours') AS ultime_24h
  FROM cron.job_run_details;

SELECT j.jobname, count(*) AS righe_24h
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE d.start_time > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 2 DESC;

SELECT count(*) FILTER (WHERE j.active) AS job_attivi,
       count(e.job) FILTER (WHERE j.active) AS attivi_con_riga,
       count(*) FILTER (WHERE j.active AND e.ultimo_runid IS NOT NULL) AS attivi_con_ultimo_esito,
       string_agg(j.jobname, ', ' ORDER BY j.jobname)
         FILTER (WHERE j.active AND e.ultimo_runid IS NULL) AS senza_ultimo_esito
  FROM cron.job j
  LEFT JOIN public.cron_ultimo_esito e ON e.job = j.jobname;

SELECT DISTINCT pg_get_userbyid(p.proowner) AS proprietario
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('storici_tick', 'cron_http_post', 'app_log_purge');
```

Scrivi `JRD_RIGHE=`, `JRD_DIMENSIONE=`, `JRD_24H=`, `JRD_ATTESE=` (= `JRD_24H` × 14), `JOB_ATTIVI=` (= `job_attivi`), `ULTIMO_ESITO_RIGHE=` (= `attivi_con_ultimo_esito`), `SENZA_ULTIMO_ESITO=` (= `senza_ultimo_esito`, oppure `nessuno` se è nullo), `PROPRIETARIO=`. Il 20/10 le righe erano 93.577. Poi, con il proprietario letto:

```sql
SELECT has_table_privilege('<PROPRIETARIO>', 'cron.job_run_details', 'DELETE') AS puo_cancellare,
       has_table_privilege('<PROPRIETARIO>', 'cron.job', 'SELECT') AS puo_leggere_i_job;
```

**Soglia.**
- `attivi_con_riga` deve essere uguale a `job_attivi` (la specifica ne conta 30): il lettore della sessione 6 crea la riga di ogni job a ogni giro. Se è minore, `cron-esiti` non gira: **fermati**.
- L'ultimo giro di un job è al sicuro in `cron_ultimo_esito` solo quando `ultimo_runid` è valorizzato: per un mensile che non ha girato dopo il rilascio della sessione 6 resta nullo fino al giro dopo (il lettore guarda solo le ultime esecuzioni di `cron.job_run_details`). I job elencati in `senza_ultimo_esito` tengono il loro storico oltre i 14 giorni: la funzione del Compito 5 non li tocca. Scrivili nel PRD.
- `puo_cancellare = false` ⇒ il job del Compito 5 non può fare il suo lavoro: **fermati** e chiedi al titolare (la documentazione di Supabase indica proprio questa pulizia, eseguita da `postgres`).

- [ ] **Passo 8: chi resta `idle in transaction`, sei letture**

Esegui questa query **sei volte, a dieci minuti l'una dall'altra** (si può lavorare ai Compiti 3 e 4 nel frattempo; il Compito 5 non si committa prima della sesta lettura):

```sql
SELECT now() AT TIME ZONE 'UTC' AS letto_alle,
       usename, application_name, backend_type,
       count(*) AS sessioni,
       max(now() - state_change) AS piu_lunga
  FROM pg_stat_activity
 WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
 GROUP BY 1, 2, 3, 4
 ORDER BY piu_lunga DESC;
SHOW idle_in_transaction_session_timeout;
```

Salva le sei uscite in `${TMPDIR:-/tmp}/s08-idle-prima.txt`; scrivi `IDLE_MAX=` (la più lunga delle sei letture) e `IDLE_CHI=` (`usename` e `application_name` di quella sessione). Il `SHOW` dà il valore della sessione che legge, cioè quello del database (il 20/10 era `0`): **non** è il valore dei tre ruoli dell'API, che sono `NOLOGIN` e tengono le loro impostazioni in `pg_roles.rolconfig` (Passo 9, e la prova del Rilascio, Passo 6).

**Soglia che cambia il piano.**
- `service_role`, `authenticated` e `anon` sono `NOLOGIN`: in `pg_stat_activity` non compaiono mai. PostgREST si collega come `authenticator` e applica le impostazioni del ruolo impersonato dentro ogni transazione. Se una sessione di `authenticator` resta `idle in transaction` **più di 30 s** in una delle letture, i 60 s potrebbero interrompere una transazione legittima: **fermati** e chiedi al titolare.
- Se le sessioni lunghe sono di `postgres`, `supabase_admin`, `backup_lettura` o di un processo interno, l'`ALTER ROLE` del Compito 5 **non le tocca**: si fa lo stesso (la specifica lo chiede e protegge le connessioni dell'API), ma il PRD lo dice con «osservato» e «causa probabile» separati, e la scelta su quei ruoli resta al titolare (Decisioni, in fondo).

- [ ] **Passo 9: può il proprietario delle migrazioni cambiare i tre ruoli?**

```sql
SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcanlogin, r.rolconfig
  FROM pg_roles r
 WHERE r.rolname IN ('service_role', 'authenticated', 'anon', 'authenticator', 'postgres', 'backup_lettura', '<PROPRIETARIO>')
 ORDER BY 1;

SELECT m.roleid::regrole AS ruolo, m.member::regrole AS membro, m.admin_option
  FROM pg_auth_members m
 WHERE m.roleid IN ('service_role'::regrole, 'authenticated'::regrole, 'anon'::regrole)
 ORDER BY 1, 2;

SELECT current_setting('server_version') AS versione,
       current_setting('supautils.reserved_roles', true) AS ruoli_riservati,
       current_setting('supautils.privileged_role', true) AS ruolo_privilegiato;
```

Scrivi `PUO_ALTER_ROLE=` con `si` se il proprietario è superuser, oppure ha `rolcreaterole` e `admin_option = true` sui tre ruoli (Postgres 16 e successivi), oppure è il ruolo privilegiato di supautils; `no` se nessuna delle tre; `incerto` altrimenti. Salva `rolconfig` dei sei ruoli in `${TMPDIR:-/tmp}/s08-ruoli-prima.txt`. Non si prova a scrivere: la guardia del Compito 5 copre il `no` e l'`incerto` con una riga `error` in `app_log` e la migrazione prosegue.

- [ ] **Passo 10: quanto pesa `app_log`, e quanto peserà con T7**

```sql
SELECT pg_total_relation_size('public.app_log') AS byte,
       pg_size_pretty(pg_total_relation_size('public.app_log')) AS dimensione,
       count(*) AS righe,
       count(*) FILTER (WHERE livello = 'error') AS errori,
       count(*) FILTER (WHERE livello = 'warn') AS avvisi,
       count(*) FILTER (WHERE livello = 'info') AS info,
       min(creato_il) AS la_piu_vecchia,
       round(count(*) FILTER (WHERE livello = 'error')::numeric
             / greatest(extract(epoch FROM now() - min(creato_il)) / 86400, 1)::numeric, 1) AS errori_al_giorno,
       round(pg_total_relation_size('public.app_log')::numeric / greatest(count(*), 1)) AS byte_per_riga
  FROM public.app_log;
```

Scrivi `APP_LOG_PRIMA_MB=` (byte / 1048576, una cifra decimale), `APP_LOG_RIGHE=`, `ERRORI_GIORNO=`, `BYTE_RIGA=`, e calcola:

```bash
source "${TMPDIR:-/tmp}/s08-misure.env"
CRESCITA_MB=$(echo "scale=1; $ERRORI_GIORNO * 60 * $BYTE_RIGA / 1048576" | bc)
APP_LOG_SOGLIA_MB=$(echo "scale=1; m = $APP_LOG_PRIMA_MB + 2 * $CRESCITA_MB; if (m > 100) 100 else m" | bc)
echo "CRESCITA_MB=$CRESCITA_MB" >> "${TMPDIR:-/tmp}/s08-misure.env"
echo "APP_LOG_SOGLIA_MB=$APP_LOG_SOGLIA_MB" >> "${TMPDIR:-/tmp}/s08-misure.env"
echo "$CRESCITA_MB $APP_LOG_SOGLIA_MB"
```

`CRESCITA_MB` è la stima prudente di quanto crescerà `app_log` tenendo gli errori 60 giorni in più (byte medi per riga con indici e TOAST). **Soglia:** oltre **50 MB**, **fermati**: decide il titolare se T7 resta a 90 giorni. `APP_LOG_SOGLIA_MB` è la soglia del ritorno indietro (Rilascio, Passo 10).

- [ ] **Passo 11: i promemoria doppi già in tabella, e il peso di `notifiche`**

```sql
SELECT 'modulo_promemoria' AS tipo, count(*) AS gruppi_doppi, coalesce(sum(n - 1), 0) AS righe_in_piu
  FROM (SELECT entita_id, utente_id, (creato_il AT TIME ZONE 'UTC')::date AS giorno, count(*) AS n
          FROM public.notifiche WHERE tipo = 'modulo_promemoria'
         GROUP BY 1, 2, 3 HAVING count(*) > 1) d
UNION ALL
SELECT 'documenti_scadenza', count(*), coalesce(sum(n - 1), 0)
  FROM (SELECT entita_id, utente_id, count(*) AS n
          FROM public.notifiche WHERE tipo = 'documenti_scadenza'
         GROUP BY 1, 2 HAVING count(*) > 1) d;

SELECT count(*) AS righe,
       pg_size_pretty(pg_total_relation_size('public.notifiche')) AS dimensione,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'notifiche' AND column_name = 'chiave_dedup') AS colonna_gia_presente
  FROM public.notifiche;

SELECT to_regclass('public.cron_prese') AS cron_prese_gia_presente;
```

Scrivi `DOPPI_MODULI=`, `DOPPI_DOCUMENTI=` (righe in più), `NOTIFICHE_RIGHE=`, `NOTIFICHE_DIMENSIONE=`. I doppi già presenti **restano** e non bloccano niente: l'indice del Compito 6 sta su una colonna nuova, vuota. Un indice unico sulle colonne di oggi (tipo, entità, utente) è impossibile per i moduli: il promemoria ogni N giorni è un doppione legittimo, ed è il motivo della colonna nuova. **Soglia:** `notifiche` oltre 2.000.000 di righe o 1 GB ⇒ la costruzione dell'indice blocca le scritture troppo a lungo: **fermati** e chiedi al titolare. `colonna_gia_presente = 1` o `cron_prese_gia_presente` non nullo ⇒ qualcuno ha già toccato lo schema: **fermati**.

- [ ] **Passo 12: dove sta oggi `app-log-purge` nella salute**

```bash
grep -n "nome: 'app-log-purge'" src/lib/health/controlli.ts
grep -n "^export const JOB_CRON\b\|^export const JOB_CRON_NON_SORVEGLIATI" src/lib/health/controlli.ts
```

Atteso: `app-log-purge` dentro `JOB_CRON_NON_SORVEGLIATI`. Se la sessione 7 l'ha spostato in `JOB_CRON`, il Compito 5 non lo tocca comunque; `cron-storico-purge` va in `JOB_CRON_NON_SORVEGLIATI` in ogni caso, perché il lock `cron-sorvegliato-e-applicato` vieta in `JOB_CRON` un job la cui migrazione non è ancora applicata.

---

## Migrazione

Quattro file, in quest'ordine, ciascuno con la version presa da `date -u +%Y%m%d%H%M%S` **nel momento in cui lo si crea** (mai un orario tondo, mai nel futuro). Ogni intestazione ha PERCHÉ, COSA CAMBIA, DB DELLA CI, COME SI VERIFICA e ROLLBACK, sul modello di `20261019223123_battiti_app_log_che_contano.sql:37-39`. Il ROLLBACK diventa una migrazione nuova **solo** dentro una PR di revert. Nessuna migrazione aggiunge un vincolo `CHECK` o una FK: `NOT VALID` non serve. Il database della CI **non** è migrato dalla CI (il workflow `DB migrate (CI)` è solo manuale): il codice regge l'assenza di colonna, indice e RPC (Compiti 7 e 8).

### Compito 3 — Il timeout di pg_net è il `maxDuration` della route

**File:**
- Modifica: `__tests__/architecture/cron-max-duration.test.ts` (due `import` dopo la riga 3, un blocco in fondo; le righe 1-87 non cambiano, vedi la mappa dei file per la sessione 9)
- Crea: `scripts/cron-esiti/timeout.mjs`
- Crea: `supabase/migrations/<version>_cron_timeout_uguale_max_duration.sql` (generata)
- Crea, fuori dal repository: `${TMPDIR:-/tmp}/s08-genera-timeout.mjs`

- [ ] **Passo 1: il lato SQL del lock (test rosso)**

In `__tests__/architecture/cron-max-duration.test.ts` aggiungi, dopo la riga 3 (`import { join, relative } from 'node:path'`), **senza toccare** la riga 2 (la sessione 9 la sostituisce per contenuto):

```ts
import {
  ASSENTI_IN_PRODUZIONE, INVOLUCRO, NON_SI_AVVOLGONO, contaChiamate, corpoDi, corpoOVuoto, ultimeDefinizioni,
} from '../../scripts/cron-esiti/involucro.mjs'
import { TIMEOUT_PREDEFINITO_MS, chiamataAllInvolucro, conTimeout } from '../../scripts/cron-esiti/timeout.mjs'
```

e in fondo al file:

```ts
// ═════════════════════════════════════════════════════════════════════════════
// IL LATO SQL: IL TIMEOUT DI pg_net È IL maxDuration DELLA ROUTE
// (sessione 8 della seconda serie di robustezza — S1, «timeout finti»).
//
// pg_net chiude il lato client dopo `timeout_milliseconds` (5000 se non lo si passa), ma la route
// su Vercel prosegue e finisce: in `net._http_response` resta «Timeout of 5000 ms reached» al
// posto dell'esito vero. Il 20/10 erano 27 in circa 6 ore. Il timeout giusto è la vita massima
// della route che il giro chiama, in millisecondi: si smette di aspettare quando la piattaforma
// stessa non può più rispondere, non prima (stessa scelta di
// `20260911113000_fattura_sync_timeout_pg_net.sql`).
//
// Dalla sessione 6 ogni funzione chiama `public.cron_http_post('<job>', url := …, …)`: gli
// argomenti di `net.http_post`, per nome, col job davanti. Il timeout è l'argomento
// `timeout_milliseconds` DENTRO quella chiamata (5000 se manca); il percorso non c'è, perché
// l'URL lo legge dal Vault la funzione stessa. Per questo `CHIAMANTI_CRON` è l'unico posto che
// dice quale funzione SQL chiama quale route. Una voce per riga, in questa forma esatta: lo
// script che genera la migrazione la legge così. Lettura e riscrittura della chiamata stanno in
// `scripts/cron-esiti/timeout.mjs`, lo stesso modulo che usa lo script.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `timeoutDecisoMs`: un timeout scelto dal titolare al posto del `maxDuration` della route. Oggi
 * solo `video_runner_kick`, che non è un job ma un trigger a ogni caricamento video: a 300 s ogni
 * caricamento terrebbe un posto di pg_net finché il runner lavora (specifica, §7, sessione 8).
 */
type Chiamante = { funzione: string; job: string; route: string; timeoutDecisoMs?: number }

const CHIAMANTI_CRON: readonly Chiamante[] = [
  { funzione: 'notifiche_dispatch_tick', job: 'notifiche-dispatch', route: 'src/app/api/push/dispatch/route.ts' },
  { funzione: 'notifiche_promemoria_tick', job: 'notifiche-promemoria', route: 'src/app/api/notifiche/promemoria/route.ts' },
  { funzione: 'mensa_check_allergie_giornaliero', job: 'mensa-check-allergie', route: 'src/app/api/mensa/allergie-check/route.ts' },
  { funzione: 'fatture_sdi_sync_tick', job: 'fatture-sdi-sync', route: 'src/app/api/pagamenti/fattura/sync/route.ts' },
  { funzione: 'fatture_coda_tick_http', job: 'fatture-coda-tick', route: 'src/app/api/pagamenti/fattura/coda/giro/route.ts' },
  { funzione: 'pagamenti_solleciti_tick', job: 'pagamenti-solleciti-run', route: 'src/app/api/pagamenti/solleciti/run/route.ts' },
  { funzione: 'news_tick', job: 'news-tick', route: 'src/app/api/news/cron/run/route.ts' },
  { funzione: 'news_digest_tick', job: 'news-digest', route: 'src/app/api/news/cron/run/route.ts' },
  { funzione: 'iscrizioni_retention_http', job: 'iscrizioni-retention', route: 'src/app/api/gdpr/retention-iscrizioni/route.ts' },
  { funzione: 'iscrizioni_import_invio_http', job: 'iscrizioni-import-invio', route: 'src/app/api/iscrizione/import-massivo/route.ts' },
  { funzione: 'candidature_retention_http', job: 'candidature-retention', route: 'src/app/api/gdpr/retention-candidature/route.ts' },
  { funzione: 'retention_personale_http', job: 'retention-personale', route: 'src/app/api/gdpr/retention-personale/route.ts' },
  { funzione: 'scadenze_documenti_personale_http', job: 'scadenze-documenti-personale', route: 'src/app/api/notifiche/scadenze-documenti/route.ts' },
  { funzione: 'galleria_retention_http', job: 'galleria-retention', route: 'src/app/api/gdpr/retention-galleria/route.ts' },
  { funzione: 'video_retention_http', job: 'video-retention', route: 'src/app/api/gdpr/retention-video/route.ts' },
  { funzione: 'video_runner_tick_http', job: 'video-runner-tick', route: 'src/app/api/video/runner/route.ts' },
  { funzione: 'video_runner_kick', job: 'video-runner-kick', route: 'src/app/api/video/runner/route.ts', timeoutDecisoMs: 5000 },
  { funzione: 'cestino_registro_retention_http', job: 'cestino-registro-retention', route: 'src/app/api/gdpr/retention-cestino-registro/route.ts' },
  { funzione: 'storici_tick', job: 'storici-stampe', route: 'src/app/api/admin/storici/cron/route.ts' },
]

/** Le funzioni contate nel repo il 2026-10-20 (15 a 5000 ms, 4 con il timeout esplicito). */
const MINIMO_CHIAMANTI = 19
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
/** Escluse dalla sessione 6, ciascuna con la sua ragione: chiamano ancora `net.http_post` da sole. */
const ESCLUSE_DALLA_S06: Record<string, string> = { ...NON_SI_AVVOLGONO, ...ASSENTI_IN_PRODUZIONE }

function esisteFile(percorso: string): boolean {
  return statSync(join(RADICE, percorso), { throwIfNoEntry: false })?.isFile() ?? false
}

function maxDurationMs(route: string): number | null {
  if (!esisteFile(route)) return null
  const m = DICHIARAZIONE.exec(senzaCommenti(readFileSync(join(RADICE, route), 'utf8')))
  return m ? Number(m[1]) * 1000 : null
}

/**
 * `null` = in regola; altrimenti la violazione, in parole. `corpo` è il corpo della funzione (fra
 * `AS $tag$` e la sua chiusura). Job e timeout li legge `chiamataAllInvolucro`, che si ferma con un
 * messaggio su ogni forma che non conosce: quel messaggio è la violazione.
 */
function violazioneSql(c: Chiamante, corpo: string): string | null {
  let chiamata: { job: string; timeoutMs: number; nominato: boolean }
  try {
    chiamata = chiamataAllInvolucro(corpo)
  } catch (e) {
    return (e as Error).message
  }
  if (chiamata.job !== c.job) return `job '${chiamata.job}', la tabella dice '${c.job}'`
  if (c.timeoutDecisoMs !== undefined) {
    return chiamata.timeoutMs === c.timeoutDecisoMs
      ? null
      : `timeout ${chiamata.timeoutMs} ms, il titolare ha deciso ${c.timeoutDecisoMs} ms per ${c.funzione}`
  }
  const atteso = maxDurationMs(c.route)
  if (atteso === null) return `${c.route} non esiste o non dichiara maxDuration`
  if (chiamata.timeoutMs !== atteso) {
    const come = chiamata.nominato ? '' : ' (predefinito: manca `timeout_milliseconds`)'
    return `timeout ${chiamata.timeoutMs} ms${come}, il maxDuration di ${c.route} vale ${atteso} ms`
  }
  return null
}

describe('lock — il timeout di pg_net è il maxDuration della route (sessione 8, seconda serie)', () => {
  const ultime = ultimeDefinizioni(MIGRAZIONI)
  const corpo = (funzione: string): string => corpoOVuoto(ultime.get(funzione)?.definizione ?? '')

  it(`la tabella ha almeno ${MINIMO_CHIAMANTI} voci, e ogni voce ha la sua definizione e la sua route`, () => {
    expect(CHIAMANTI_CRON.length).toBeGreaterThanOrEqual(MINIMO_CHIAMANTI)
    const mancanti = CHIAMANTI_CRON.filter((c) => !ultime.has(c.funzione)).map((c) => c.funzione)
    expect(mancanti, `nessuna migrazione definisce: ${mancanti.join(', ')}`).toEqual([])
    const senzaRoute = CHIAMANTI_CRON.filter((c) => !esisteFile(c.route)).map((c) => c.route)
    expect(senzaRoute, `route che non esistono: ${senzaRoute.join(', ')}`).toEqual([])
  })

  it('ogni funzione che chiama il server è nella tabella (salvo le escluse dalla sessione 6)', () => {
    const note = new Set(CHIAMANTI_CRON.map((c) => c.funzione))
    const fuori = [...ultime.keys()]
      .filter((nome) => nome !== INVOLUCRO && !Object.hasOwn(ESCLUSE_DALLA_S06, nome))
      .filter((nome) => {
        const { dirette, avvolte } = contaChiamate(corpo(nome))
        return dirette + avvolte > 0
      })
      .filter((nome) => !note.has(nome))
    expect(
      fuori,
      `Chiamano il server ma non sono in CHIAMANTI_CRON: ${fuori.join(', ')}. Aggiungi la voce con la ` +
        'route che chiamano: senza, nessuno controlla il loro timeout.',
    ).toEqual([])
  })

  it('ogni chiamante passa a cron_http_post il maxDuration della sua route', () => {
    const fuori = CHIAMANTI_CRON.flatMap((c) => {
      const d = ultime.get(c.funzione)
      if (!d) return []
      const v = violazioneSql(c, corpoOVuoto(d.definizione))
      return v === null ? [] : [`${c.funzione} (${d.file}): ${v}`]
    })
    expect(fuori, fuori.join('\n')).toEqual([])
  })

  it('il criterio morde: default 5000, valore sbagliato, chiamata diretta, job sbagliato, timeout non letterale o per posizione', () => {
    const c: Chiamante = { funzione: 'x', job: 'storici-stampe', route: 'src/app/api/admin/storici/cron/route.ts' }
    const giusta = "PERFORM public.cron_http_post('storici-stampe', url := v_url, headers := v_h, timeout_milliseconds := 300000);"
    expect(violazioneSql(c, giusta)).toBeNull()
    expect(violazioneSql(c, giusta.replace(':= 300000', '=> 300000'))).toBeNull()
    expect(violazioneSql(c, giusta.replace('300000', '5000'))).toMatch(/^timeout 5000 ms, il maxDuration/)
    expect(violazioneSql(c, "PERFORM public.cron_http_post('storici-stampe', url := v_url, headers := v_h);"))
      .toMatch(/^timeout 5000 ms \(predefinito/)
    expect(violazioneSql(c, 'PERFORM net.http_post(url := v_url);')).toMatch(/direttamente/)
    expect(violazioneSql(c, giusta.replace("'storici-stampe'", "'altro'"))).toMatch(/job 'altro'/)
    expect(violazioneSql(c, giusta.replace('300000', 'v_ms'))).toMatch(/non è un numero letterale/)
    expect(violazioneSql(c, "PERFORM public.cron_http_post('storici-stampe', v_url, '{}'::jsonb, '{}'::jsonb, v_h, 300000);"))
      .toMatch(/per posizione/)
    expect(violazioneSql(c, `${giusta}\n${giusta}`)).toMatch(/trovate 2/)
    // Conta solo il timeout DENTRO la chiamata: non quello di un commento né quello di un'altra istruzione.
    expect(violazioneSql(c, "-- timeout_milliseconds := 300000\nPERFORM public.cron_http_post('storici-stampe', url := v_url);"))
      .toMatch(/^timeout 5000 ms \(predefinito/)
    expect(violazioneSql(c, "PERFORM public.cron_http_post('storici-stampe', url := v_url);\nPERFORM altra(timeout_milliseconds := 300000);"))
      .toMatch(/^timeout 5000 ms \(predefinito/)
    expect(TIMEOUT_PREDEFINITO_MS).toBe(5000)
  })

  it('conTimeout cambia una cosa sola: il numero, o l’argomento aggiunto in fondo alla chiamata', () => {
    const def = (chiamata: string): string =>
      `CREATE OR REPLACE FUNCTION public.x()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  ${chiamata}\nEND;\n$function$\n`
    const conValore = "PERFORM public.cron_http_post('a', url:=v_url, body:='{}'::jsonb, timeout_milliseconds:=120000);"
    expect(conTimeout(def(conValore), 300000)).toBe(def(conValore.replace(':=120000', ':=300000')))
    const senza = "PERFORM public.cron_http_post('a',\n    url := v_url,\n    body := '{}'::jsonb -- corpo vuoto\n  );"
    const dopo = conTimeout(def(senza), 300000)
    expect(dopo).toBe(def(senza.replace("'{}'::jsonb -- corpo", "'{}'::jsonb, timeout_milliseconds := 300000 -- corpo")))
    expect(chiamataAllInvolucro(corpoDi(dopo).corpo)).toMatchObject({ job: 'a', timeoutMs: 300000, nominato: true })
    const freccia = "PERFORM public.cron_http_post('a', url => v_url);"
    expect(conTimeout(def(freccia), 300000)).toBe(def(freccia.replace('v_url)', 'v_url, timeout_milliseconds => 300000)')))
    expect(() => conTimeout(def('PERFORM net.http_post(url := v_url);'), 300000)).toThrow('direttamente')
  })
})
```

Poi allinea la tabella a quello che il Passo 3 del Compito 2 ha letto: la colonna `job` prende il primo letterale della chiamata all'involucro (colonna `job` di `${TMPDIR:-/tmp}/s08-chiamanti.tsv`); la colonna `route` è quella del repo e deve essere `src/app<percorso>/route.ts` del percorso che l'involucro ha registrato per quel job (`${TMPDIR:-/tmp}/s08-percorsi.tsv`); la funzione che esisteva solo in produzione entra con una voce sua, nella stessa forma, con la route del suo percorso registrato.

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/architecture/cron-max-duration.test.ts 2>&1 | tail -30
```

Atteso: `FAIL` con `Failed to load url ../../scripts/cron-esiti/timeout.mjs` (o `Cannot find module`): il modulo non esiste ancora.

- [ ] **Passo 3: il modulo che legge e riscrive il timeout**

Crea `scripts/cron-esiti/timeout.mjs`:

```js
/**
 * Il timeout delle chiamate all'involucro dei cron — sessione 8 della seconda serie di robustezza.
 *
 * Dalla sessione 6 ogni funzione dei cron chiama il server con
 * `public.cron_http_post('<job>', url := …, headers := …, body := …[, timeout_milliseconds := N])`:
 * gli argomenti di `net.http_post`, quasi sempre per nome, col nome del job davanti
 * (`scripts/cron-esiti/involucro.mjs`). Qui:
 *  · il job è il primo argomento, un letterale fra apici;
 *  · il timeout è l'argomento nominato `timeout_milliseconds` DENTRO quella chiamata (`:=` o `=>`),
 *    e se manca vale il default dell'involucro, 5000 ms;
 *  · il percorso della route NON si legge: l'URL arriva dal Vault. Quale route chiama ogni funzione
 *    lo dice `CHIAMANTI_CRON` nel lock `__tests__/architecture/cron-max-duration.test.ts`.
 *
 * `conTimeout` cambia UNA cosa: il numero di `timeout_milliseconds`, o l'argomento aggiunto in fondo
 * alla chiamata se non c'era. Lo usano il lock e lo script che genera la migrazione, così ciò che il
 * lock controlla e ciò che lo script scrive non possono divergere. Su ogni forma che non conosce si
 * ferma con un messaggio: non indovina.
 */
import { contaChiamate, corpoDi, mascheraSql } from './involucro.mjs'

/** Il default di `timeout_milliseconds` in `public.cron_http_post`, lo stesso di `net.http_post`. */
export const TIMEOUT_PREDEFINITO_MS = 5000

const APRE = /\bpublic\s*\.\s*cron_http_post\s*\(/i
const JOB = /^\s*'([a-z0-9][a-z0-9-]*)'\s*,/
const NOMINATO = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(:=|=>)/
const NUMERO = /^(\s*)(\d+)\s*$/
/** `timeout_milliseconds` è il sesto argomento dell'involucro: il job, poi i cinque di `net.http_post`. */
const POSIZIONE_TIMEOUT = 6

/**
 * L'unica chiamata all'involucro nel corpo di una funzione: il job, il timeout che vale e dove si
 * trova. `corpo` è il testo fra `AS $tag$` e la sua chiusura; commenti e stringhe non contano.
 */
export function chiamataAllInvolucro(corpo) {
  const { dirette, avvolte } = contaChiamate(corpo)
  if (dirette > 0) throw new Error('chiama ancora `net.http_post` direttamente: passa da `cron_http_post`')
  if (avvolte !== 1) throw new Error(`attesa UNA chiamata a \`public.cron_http_post\`, trovate ${avvolte}`)
  // Due maschere della stessa lunghezza del corpo: senza stringhe né commenti per parentesi e virgole,
  // senza i soli commenti per leggere i valori e la fine dell'ultimo argomento.
  const codice = mascheraSql(corpo)
  const soloCodice = mascheraSql(corpo, { stringhe: false })
  const m = APRE.exec(codice)
  const da = m.index + m[0].length
  const virgole = []
  let profondita = 0
  let a = -1
  for (let i = da; i < codice.length && a < 0; i++) {
    if (codice[i] === '(') profondita++
    else if (codice[i] === ')') {
      if (profondita === 0) a = i
      else profondita--
    } else if (codice[i] === ',' && profondita === 0) virgole.push(i)
  }
  if (a < 0) throw new Error('la chiamata a `cron_http_post` non si chiude')
  const job = JOB.exec(corpo.slice(da, a))
  if (!job) throw new Error('il primo argomento di `cron_http_post` non è il nome del job fra apici')
  const inizi = [da, ...virgole.map((v) => v + 1)]
  const fini = [...virgole, a]
  let posizionali = 0
  let freccia = ':='
  let timeout = null
  for (let k = 0; k < inizi.length; k++) {
    const n = NOMINATO.exec(codice.slice(inizi[k], fini[k]))
    if (!n) {
      posizionali++
      continue
    }
    if (n[2] === '=>') freccia = '=>'
    if (n[1].toLowerCase() !== 'timeout_milliseconds') continue
    const inizioValore = inizi[k] + n[0].length
    const valore = soloCodice.slice(inizioValore, fini[k])
    const v = NUMERO.exec(valore)
    if (!v) throw new Error(`timeout_milliseconds non è un numero letterale: «${valore.trim()}»`)
    const daNumero = inizioValore + v[1].length
    timeout = { da: daNumero, a: daNumero + v[2].length, ms: Number(v[2]) }
  }
  if (posizionali >= POSIZIONE_TIMEOUT) {
    throw new Error('timeout passato per posizione: si passa per nome, `timeout_milliseconds := <ms>`')
  }
  let fineCodice = a
  while (fineCodice > da && /\s/.test(soloCodice[fineCodice - 1])) fineCodice--
  return {
    job: job[1],
    timeoutMs: timeout ? timeout.ms : TIMEOUT_PREDEFINITO_MS,
    nominato: timeout !== null,
    timeout,
    freccia,
    fineCodice,
  }
}

/**
 * La definizione con `timeout_milliseconds` a `ms` nella chiamata all'involucro: si cambia il numero
 * se c'è, si aggiunge l'argomento in fondo alla chiamata (prima di un eventuale commento) se manca.
 * Nient'altro cambia.
 */
export function conTimeout(definizione, ms) {
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`timeout non valido: ${ms}`)
  const { testata, tag, corpo, coda } = corpoDi(definizione)
  const c = chiamataAllInvolucro(corpo)
  const nuovo = c.timeout
    ? corpo.slice(0, c.timeout.da) + String(ms) + corpo.slice(c.timeout.a)
    : corpo.slice(0, c.fineCodice) + `, timeout_milliseconds ${c.freccia} ${ms}` + corpo.slice(c.fineCodice)
  return testata + nuovo + tag + coda
}
```

```bash
npx eslint scripts/cron-esiti/timeout.mjs __tests__/architecture/cron-max-duration.test.ts
npx vitest run __tests__/architecture/cron-max-duration.test.ts 2>&1 | tail -30
```

Atteso: `eslint` senza uscita. `ogni chiamante passa a cron_http_post il maxDuration della sua route` **rosso**, con una riga per ciascuna funzione senza `timeout_milliseconds` (`timeout 5000 ms (predefinito: manca …)`) e per `iscrizioni_retention_http` (`timeout 120000 ms`): 16 righe se la sessione 6 ha lasciato i timeout di prima, come chiede la specifica, 17 se la funzione che esisteva solo in produzione è a 5000. Gli altri quattro test del blocco nuovo verdi, compresi «il criterio morde» e «conTimeout», e verdi i tre del blocco di prima. Se è rosso «ogni funzione che chiama il server è nella tabella», manca una voce: aggiungila e rilancia.

- [ ] **Passo 4: lo script che genera la migrazione (fuori dal repository)**

```bash
cat > "${TMPDIR:-/tmp}/s08-genera-timeout.mjs" <<'EOF'
// Sessione 8 della seconda serie di robustezza. Fuori dal repository: si cancella a fine sessione.
// Uso: node s08-genera-timeout.mjs <definizioni.json> <radice-del-repo> [obiettivi.json]
// Senza obiettivi.json (il terzo argomento dello script) `timeout_milliseconds` nella chiamata a
// cron_http_post diventa il maxDuration della route (letta da CHIAMANTI_CRON nel lock). Con
// obiettivi.json ({"funzione": ms}) diventa quello: è la strada del ritorno indietro. La chiamata la leggono e la riscrivono
// `chiamataAllInvolucro` e `conTimeout` di scripts/cron-esiti/timeout.mjs, gli stessi del lock.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [fileDefinizioni, radice, fileObiettivi] = process.argv.slice(2)
if (!fileDefinizioni || !radice) {
  console.error('uso: node s08-genera-timeout.mjs <definizioni.json> <radice> [obiettivi.json]')
  process.exit(2)
}
const modulo = (percorso) => import(pathToFileURL(join(radice, percorso)).href)
const { NON_SI_AVVOLGONO, corpoDi } = await modulo('scripts/cron-esiti/involucro.mjs')
const { chiamataAllInvolucro, conTimeout } = await modulo('scripts/cron-esiti/timeout.mjs')

const righe = JSON.parse(readFileSync(fileDefinizioni, 'utf8'))
const obiettivi = fileObiettivi ? JSON.parse(readFileSync(fileObiettivi, 'utf8')) : null
const lock = readFileSync(join(radice, '__tests__/architecture/cron-max-duration.test.ts'), 'utf8')
const tabella = new Map(
  [...lock.matchAll(/\{ funzione: '([a-z0-9_]+)', job: '([^']+)', route: '([^']+)'(?:, timeoutDecisoMs: (\d+))? \}/g)]
    .map((m) => [m[1], { job: m[2], route: m[3], deciso: m[4] ? Number(m[4]) : null }]),
)
if (tabella.size < 19) { console.error(`CHIAMANTI_CRON ha ${tabella.size} voci lette: ne servono almeno 19`); process.exit(1) }

const ferma = (funzione, perche) => { console.error(`${funzione}: ${perche}`); process.exit(1) }
let sql = ''
const invariate = []
const escluse = []
for (const r of righe) {
  if (Object.hasOwn(NON_SI_AVVOLGONO, r.funzione)) { escluse.push(r.funzione); continue }
  const voce = tabella.get(r.funzione)
  if (!voce) ferma(r.funzione, 'non è in CHIAMANTI_CRON')
  let chiamata
  try {
    chiamata = chiamataAllInvolucro(corpoDi(r.definizione).corpo)
  } catch (e) {
    ferma(r.funzione, e.message)
  }
  if (chiamata.job !== voce.job) ferma(r.funzione, `l'involucro dice job '${chiamata.job}', CHIAMANTI_CRON '${voce.job}'`)
  let atteso
  if (voce.deciso !== null) {
    atteso = voce.deciso
  } else if (obiettivi) {
    if (!(r.funzione in obiettivi)) ferma(r.funzione, `manca in ${fileObiettivi}`)
    atteso = Number(obiettivi[r.funzione])
  } else {
    const m = /^export const maxDuration\s*=\s*(\d+)\s*;?\s*$/m.exec(readFileSync(join(radice, voce.route), 'utf8'))
    if (!m) ferma(r.funzione, `${voce.route}: maxDuration non dichiarato`)
    atteso = Number(m[1]) * 1000
  }
  if (chiamata.timeoutMs === atteso) { invariate.push(r.funzione); continue }
  const nuova = conTimeout(r.definizione, atteso)
  const prima = chiamata.nominato ? `${chiamata.timeoutMs}` : `${chiamata.timeoutMs} (predefinito, argomento aggiunto)`
  sql += `-- ${r.funzione} → ${voce.route}: timeout_milliseconds ${prima} → ${atteso} ms\n`
  sql += `${nuova.trimEnd()};\n`
  sql += `REVOKE ALL ON FUNCTION ${r.firma} FROM PUBLIC, anon, authenticated;\n`
  if (r.service_role_esegue) sql += `GRANT EXECUTE ON FUNCTION ${r.firma} TO service_role;\n`
  sql += '\n'
}
process.stdout.write(sql)
console.error(`già al valore, non ridefinite: ${invariate.join(', ') || 'nessuna'}`)
console.error(`escluse dalla sessione 6 (NON_SI_AVVOLGONO), non toccate: ${escluse.join(', ') || 'nessuna'}`)
EOF
node "${TMPDIR:-/tmp}/s08-genera-timeout.mjs" "${TMPDIR:-/tmp}/s08-chiamanti.json" . > "${TMPDIR:-/tmp}/s08-timeout.sql"
grep -c "^REVOKE ALL ON FUNCTION" "${TMPDIR:-/tmp}/s08-timeout.sql"
diff <(grep -v "^--" "${TMPDIR:-/tmp}/s08-timeout.sql" | grep -c "timeout_milliseconds") <(grep -c "^REVOKE ALL ON FUNCTION" "${TMPDIR:-/tmp}/s08-timeout.sql") && echo "un timeout_milliseconds per funzione"
```

Atteso sullo standard error: `già al valore, non ridefinite: fatture_coda_tick_http, fatture_sdi_sync_tick, storici_tick` (più eventuali altre già a 300000) e `escluse dalla sessione 6 (NON_SI_AVVOLGONO), non toccate: genera_solleciti` (o `nessuna`, se in produzione non c'è più); il conteggio dei `REVOKE` uguale alle righe rosse del Passo 3; l'ultima riga `un timeout_milliseconds per funzione`. Ogni funzione ridefinita differisce dalla sua definizione di produzione **solo** nel numero dopo `timeout_milliseconds`, o per `, timeout_milliseconds := 300000` aggiunto in fondo alla chiamata. Se lo script esce con un errore, leggilo: dice quale funzione e perché (chiamata diretta, due chiamate, timeout non letterale o per posizione, job diverso dalla tabella), e la correzione si fa nella tabella o si discute col titolare, mai nello script né nel corpo.

- [ ] **Passo 5: la migrazione, con la sua intestazione**

```bash
V_A=$(date -u +%Y%m%d%H%M%S)
F_A="supabase/migrations/${V_A}_cron_timeout_uguale_max_duration.sql"
cat > "$F_A" <<'EOF'
-- Sessione 8 della seconda serie di robustezza — il timeout di pg_net è il maxDuration della route.
--
-- PERCHÉ. pg_net chiude il lato client dopo `timeout_milliseconds`, e la sessione 6 ha avvolto le
-- chiamate lasciando a ciascuna il timeout che aveva con `net.http_post`: il predefinito di
-- 5000 ms (argomento assente) per la maggior parte, 120000 per `iscrizioni_retention_http`. Le
-- route dichiarano `maxDuration = 300`: ogni giro che lavora più di 5 s lascia in `cron_chiamate`
-- un `esito = 'timeout'` al posto dell'esito vero (27 in circa 6 ore il 20/10; S1 del rapporto
-- `docs/analisi-robustezza-2026-10-20.md`). Stessa scelta di 20260911113000 per la sync SDI.
--
-- COSA CAMBIA. Solo l'argomento nominato `timeout_milliseconds` della chiamata a
-- `public.cron_http_post` nelle funzioni qui sotto: dove c'era, cambia il numero; dove mancava
-- (valeva il predefinito 5000), si aggiunge `, timeout_milliseconds := <ms>` in fondo alla
-- chiamata. Il valore è il `maxDuration` della route in millisecondi. Job, URL, header, corpo e
-- tutto il resto del corpo restano identici. Corpi presi da `pg_get_functiondef` in produzione
-- (Compito 2 del piano della sessione 8), non dal repo; riscritti da `conTimeout` di
-- `scripts/cron-esiti/timeout.mjs` e controllati dal lock
-- `__tests__/architecture/cron-max-duration.test.ts` (tabella CHIAMANTI_CRON). Restano fuori le
-- funzioni già al valore giusto e quelle che la sessione 6 non avvolge (`NON_SI_AVVOLGONO`).
--
-- RISCHIO. Il worker di pg_net lavora a lotti: una richiesta che aspetta a lungo può ritardare le
-- altre dello stesso giro. Si misura la latenza per job prima e dopo (piano, Rilascio).
--
-- DB DELLA CI: nessuna guardia serve. Sono CREATE OR REPLACE di funzioni plpgsql: `cron_http_post`
-- si risolve quando girano, e senza pg_cron non girano.
--
-- COME SI VERIFICA
--   SELECT p.proname,
--          coalesce(substring(p.prosrc from 'timeout_milliseconds\s*(?::=|=>)\s*(\d+)'),
--                   '5000 (predefinito)') AS timeout_ms
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.prosrc ~ 'cron_http_post\s*\('
--      AND p.proname NOT IN ('cron_http_post', 'cron_esiti')
--    ORDER BY 1;
--   Atteso: 300000 per tutte; nessun «5000 (predefinito)».
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   Lo stesso script del piano con il file dei timeout di prima (`TIMEOUT_PRIMA` nel changelog
--   del PRD della sessione 8), applicato ai corpi letti in produzione il giorno del revert.

EOF
cat "${TMPDIR:-/tmp}/s08-timeout.sql" >> "$F_A"
grep -niE "\bunique\b|primary key|\bpolicy\b|row level security|drop table|add constraint|references" "$F_A" | head
```

Atteso: nessuna riga dall'ultimo `grep` (la migrazione non tocca nessuna delle fotografie). Se ne compare una, è nel corpo di una funzione copiata dalla produzione: aggiungi il file a `MIGRAZIONI_ATTESE_AL_MERGE` con la stessa forma del Compito 6.

- [ ] **Passo 6: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/architecture/cron-max-duration.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/app-log-battiti-con-conflitto.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/lib/cron-esiti-involucro.test.ts __tests__/db/cron-esiti.test.ts 2>&1 | tail -6
npx vitest run __tests__/architecture/cron- 2>&1 | tail -6
```

Atteso: `Test Files  6 passed` e poi tutti i lock `cron-*` verdi, compresi quelli della sessione 6. Nessuno di loro fissa i timeout: `cron-http-esito-osservato` chiede per `iscrizioni_retention_http` un `timeout_milliseconds` letterale **maggiore di 5000** (300000 lo è) e conta una chiamata avvolta e zero dirette per funzione (la riscrittura non ne aggiunge né ne toglie); `__tests__/db/cron-esiti.test.ts` legge solo la migrazione della sessione 6. Se uno di questi diventa rosso, la riscrittura ha toccato altro oltre al numero: fermati, confronta la funzione rossa con la sua definizione in `s08-chiamanti.json` e non correggere il lock della sessione 6.

- [ ] **Passo 7: commit**

```bash
git add scripts/cron-esiti/timeout.mjs __tests__/architecture/cron-max-duration.test.ts supabase/migrations/*_cron_timeout_uguale_max_duration.sql
git commit -m "$(cat <<'EOF'
Cron: il timeout di pg_net è il maxDuration della route (sessione 8)

Nella chiamata a cron_http_post l'argomento nominato timeout_milliseconds diventa
il maxDuration della route (300000 ms): valore cambiato dove c'era, argomento
aggiunto dove valeva il predefinito di 5000. Niente più esito 'timeout' in
cron_chiamate mentre la route prosegue. Corpi presi dalla produzione; il lock
cron-max-duration controlla anche il lato SQL con la tabella funzione → job →
route, leggendo la chiamata con scripts/cron-esiti/timeout.mjs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — `storici_tick` chiama il server solo se c'è lavoro

**File:**
- Test: `__tests__/lib/storici-tick-solo-con-lavoro-sql.test.ts`
- Crea: `supabase/migrations/<version>_storici_tick_solo_con_lavoro.sql`

- [ ] **Passo 1: il test (rosso)**

Crea `__tests__/lib/storici-tick-solo-con-lavoro-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * STORICI_TICK · IL SERVER SI CHIAMA SOLO SE LA CODA HA LAVORO (sessione 8, seconda serie).
 *
 * Il job `storici-stampe` gira ogni minuto e ogni minuto chiamava `/api/admin/storici/cron`:
 * ~1.440 chiamate al giorno per una coda quasi sempre vuota. Da qui la chiamata parte solo se
 * `storici_generazioni` ha una riga che la route prenderebbe (stessa condizione di
 * `riprendiGenerazioni` e `pulisciGenerazioniScadute`, `src/lib/storici/generazioni.ts`).
 *
 * Schema MINIMO: solo le colonne che la funzione legge. `cron_http_post` è finto ma ha la firma
 * vera della sessione 6 — `(job, url, body, params, headers, timeout_milliseconds)`, con gli stessi
 * nomi e gli stessi predefiniti — e registra job, percorso (ricavato dall'URL come fa l'involucro
 * vero), timeout e segreto invece di chiamare. `cron_config` è il Vault finto: URL e segreto si
 * leggono da lì, solo quando c'è lavoro. In fondo, il controllo negativo: la funzione del 19/10,
 * letta dal suo file, chiama anche a coda vuota. Se non lo facesse, questo test non misurerebbe
 * niente.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_storici_tick_solo_con_lavoro.sql')

/** La funzione del 19/10, che chiamava il server ogni minuto. */
function tickDel19(): string {
  const testo = readFileSync(join(CARTELLA, '20261019223123_battiti_app_log_che_contano.sql'), 'utf8')
  const inizio = testo.indexOf('CREATE OR REPLACE FUNCTION public.storici_tick()')
  const fine = testo.indexOf('end $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error('storici_tick del 19/10 non trovata')
  return testo.slice(inizio, fine + 'end $$;'.length)
}

let db: PGlite

async function schema(): Promise<void> {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creato_il timestamptz NOT NULL DEFAULT now(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE TABLE public.alunni (id uuid PRIMARY KEY, stato text, stato_cambiato_il timestamptz);
    CREATE FUNCTION public.alunno_uscita_consolidata(text, timestamptz) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS 'SELECT false';
    CREATE TABLE public.storici_revisioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid,
      modulo text NOT NULL,
      giorno_competenza date NOT NULL,
      contenuto jsonb NOT NULL
    );
    CREATE TABLE public.storici_generazioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stato text NOT NULL,
      preso_il timestamptz,
      creato_il timestamptz NOT NULL DEFAULT now(),
      scade_il timestamptz NOT NULL DEFAULT now() + interval '24 hours'
    );

    -- L'involucro finto della sessione 6, con la sua firma vera: registra la chiamata invece di
    -- farla. Il percorso si ricava dall'URL come nell'involucro vero (senza query né frammento).
    CREATE TABLE public.chiamate_finte (job text, percorso text, timeout_ms integer, segreto text);
    CREATE TABLE public.guasto_finto (attivo boolean);
    CREATE FUNCTION public.cron_http_post(
      job text,
      url text,
      body jsonb DEFAULT '{}'::jsonb,
      params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds integer DEFAULT 5000
    ) RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.guasto_finto) THEN
        RAISE EXCEPTION 'pg_net finto: coda piena' USING ERRCODE = 'XX000';
      END IF;
      INSERT INTO public.chiamate_finte VALUES (
        cron_http_post.job,
        substring(cron_http_post.url FROM '^https?://[^/]+(/[^?#]*)'),
        cron_http_post.timeout_milliseconds,
        cron_http_post.headers->>'x-cron-secret'
      );
      RETURN 1;
    END $$;

    -- Per il controllo negativo: la funzione del 19/10 chiamava net.http_post direttamente.
    CREATE SCHEMA net;
    CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
    RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.chiamate_finte VALUES ('net-diretto', url, timeout_milliseconds, headers->>'x-cron-secret');
      RETURN 1;
    END $$;
    CREATE FUNCTION public.cron_config(k text) RETURNS text LANGUAGE sql AS $$
      SELECT CASE k WHEN 'app.push_dispatch_url' THEN 'https://esempio.test/api/push/dispatch'
                    WHEN 'app.cron_secret' THEN 'segreto-finto' END
    $$;
  `)
}

async function tick(): Promise<void> {
  await db.exec('SELECT public.storici_tick()')
}

async function chiamate(): Promise<{ job: string; percorso: string; timeout_ms: number }[]> {
  return (await db.query<{ job: string; percorso: string; timeout_ms: number }>(
    'SELECT job, percorso, timeout_ms FROM public.chiamate_finte',
  )).rows
}

/** Un lavoro di stampa: presa di `presoSecondiFa` secondi fa (null = mai presa), scadenza fra `scadeFraSecondi`. */
async function lavoro(stato: string, presoSecondiFa: number | null, scadeFraSecondi: number): Promise<void> {
  await db.query(
    `INSERT INTO public.storici_generazioni (stato, preso_il, scade_il)
     VALUES ($1,
             CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(secs => $2::int) END,
             now() + make_interval(secs => $3::int))`,
    [stato, presoSecondiFa, scadeFraSecondi],
  )
}

const ATTESA = [{ job: 'storici-stampe', percorso: '/api/admin/storici/cron', timeout_ms: 300000 }]

beforeAll(async () => {
  db = new PGlite()
  await schema()
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`TRUNCATE public.chiamate_finte, public.guasto_finto, public.storici_generazioni,
                          public.storici_revisioni, public.app_log`)
})

describe('storici_tick chiama il server solo se la coda ha lavoro', () => {
  it('coda vuota: nessuna chiamata, e la conservazione delle copie gira lo stesso', async () => {
    await db.query(
      `INSERT INTO public.storici_revisioni (modulo, giorno_competenza, contenuto)
       VALUES ('presenze', current_date - 400, '{"giustificazione_testo":"motivo finto","note_appello":"nota finta"}')`,
    )
    await tick()
    expect(await chiamate()).toEqual([])
    const { rows } = await db.query<{ g: string | null; n: string | null }>(
      `SELECT contenuto->>'giustificazione_testo' AS g, contenuto->>'note_appello' AS n FROM public.storici_revisioni`,
    )
    expect(rows).toEqual([{ g: null, n: null }])
  })

  it('un lavoro in coda mai preso: una chiamata, col timeout della route', async () => {
    await lavoro('in_coda', null, 3600)
    await tick()
    expect(await chiamate()).toEqual(ATTESA)
  })

  it('la chiamata porta il segreto letto dal Vault', async () => {
    await lavoro('in_coda', null, 3600)
    await tick()
    const { rows } = await db.query<{ segreto: string | null }>('SELECT segreto FROM public.chiamate_finte')
    expect(rows).toEqual([{ segreto: 'segreto-finto' }])
  })

  it('configurazione mancante: niente a coda vuota; con lavoro, nessuna chiamata e una riga error', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(`CREATE OR REPLACE FUNCTION public.cron_config(k text) RETURNS text
                       LANGUAGE sql AS 'SELECT NULL::text'`)
      const configurazione = async () => (await db.query<{ livello: string; campi: Record<string, unknown> }>(
        `SELECT livello, contesto->'campi' AS campi FROM public.app_log
          WHERE fingerprint = 'storici-cron-config-assente'`,
      )).rows
      await tick()
      expect(await configurazione()).toEqual([])
      await lavoro('in_coda', null, 3600)
      await tick()
      expect(await chiamate()).toEqual([])
      expect(await configurazione()).toEqual([{
        livello: 'error',
        campi: { operazione: 'storici-stampe', esito: 'configurazione-assente' },
      }])
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('un lavoro in corso con la presa viva: nessuna chiamata (un altro giro ci sta lavorando)', async () => {
    await lavoro('in_corso', 10, 3600)
    await tick()
    expect(await chiamate()).toEqual([])
  })

  it('un lavoro in corso con la presa scaduta da più di 330 s: una chiamata', async () => {
    await lavoro('in_corso', 400, 3600)
    await tick()
    expect(await chiamate()).toEqual(ATTESA)
  })

  it('un lavoro scaduto da pulire: una chiamata', async () => {
    await lavoro('completato', null, -60)
    await tick()
    expect(await chiamate()).toEqual(ATTESA)
  })

  it('un lavoro completato e non scaduto, o scaduto ma in pulizia: nessuna chiamata', async () => {
    await lavoro('completato', null, 3600)
    await lavoro('completato', 10, -60)
    await tick()
    expect(await chiamate()).toEqual([])
  })

  it('la chiamata che fallisce non ferma il giro, e conta in app_log', async () => {
    await db.exec('INSERT INTO public.guasto_finto VALUES (true)')
    await lavoro('in_coda', null, 3600)
    await tick()
    await tick()
    const { rows } = await db.query<{ livello: string; occorrenze: number; campi: Record<string, unknown> }>(
      `SELECT livello, occorrenze, contesto->'campi' AS campi FROM public.app_log
        WHERE fingerprint = 'cron:storici-stampe:chiamata-fallita'`,
    )
    expect(rows).toEqual([{
      livello: 'error',
      occorrenze: 2,
      campi: { operazione: 'storici-stampe', esito: 'chiamata-fallita', sqlstate: 'XX000' },
    }])
  })

  it('i 330 secondi del SQL sono la presa della coda in `generazioni.ts`', () => {
    const ts = readFileSync(join(process.cwd(), 'src/lib/storici/generazioni.ts'), 'utf8')
    const ms = Number(/const DURATA_LEASE_MS = ([\d_]+)/.exec(ts)![1].replace(/_/g, ''))
    const s = Number(/interval '(\d+) seconds'/.exec(NUOVA)![1])
    expect(s * 1000).toBe(ms)
  })

  it('CONTROLLO NEGATIVO: la funzione del 19/10 chiamava il server anche a coda vuota', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(tickDel19())
      await tick()
      expect((await chiamate()).map((c) => c.job)).toEqual(['net-diretto'])
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/storici-tick-solo-con-lavoro-sql.test.ts 2>&1 | tail -8
```

Atteso: `FAIL` con `migrazione *_storici_tick_solo_con_lavoro.sql non trovata`.

- [ ] **Passo 3: la migrazione**

Crea `supabase/migrations/$(date -u +%Y%m%d%H%M%S)_storici_tick_solo_con_lavoro.sql` (stampa il nome con `echo` e crealo con lo strumento di scrittura):

```sql
-- Sessione 8 della seconda serie di robustezza — `storici_tick` chiama il server solo se c'è lavoro.
--
-- PERCHÉ. Il job `storici-stampe` gira ogni minuto (`* * * * *`,
-- 20261015183000_storici_stampe_rettifiche.sql:497) e ogni minuto chiamava
-- `/api/admin/storici/cron`: ~1.440 chiamate al giorno (S1 del rapporto del 20/10) per una coda
-- quasi sempre vuota, ciascuna con un posto nel lotto di pg_net.
--
-- COSA CAMBIA.
--   · Il server si chiama solo se `storici_generazioni` ha una riga che la route prenderebbe: la
--     stessa condizione di `riprendiGenerazioni` e `pulisciGenerazioniScadute`
--     (`src/lib/storici/generazioni.ts:154-182`): presa libera o più vecchia di 330 s
--     (`DURATA_LEASE_MS`), e lavoro in coda o in corso, oppure scaduto da pulire.
--   · La conservazione delle copie storiche (l'UPDATE su `storici_revisioni`) resta ogni minuto,
--     identica, in un blocco suo: se fallisce non porta via la chiamata, e viceversa.
--   · URL e segreto si leggono dal Vault (`cron_config`: `app.push_dispatch_url`, ripiego
--     `app.notifiche_promemoria_url`, `app.cron_secret`) DOPO il filtro, solo quando c'è lavoro:
--     prima si leggevano nel `declare`, ogni minuto. Le chiavi sono le stesse.
--   · Configurazione mancante: stessa riga `error` di prima (`storici-cron-config-assente`), ora
--     con i campi `operazione` ed `esito` e solo quando c'è un lavoro che non può partire.
--   · La chiamata è quella della sessione 6, identica: `public.cron_http_post('storici-stampe',
--     url := …, headers := …, body := …, timeout_milliseconds := 300000)`.
--   · L'`exception when others` della chiamata scrive in `app_log` (`error`, ON CONFLICT) invece
--     del solo `raise warning`, che finiva nei log del server e basta; lo stesso per la
--     conservazione.
--   Corpo di partenza: `pg_get_functiondef` in produzione (Compito 2 del piano), cioè la versione
--   della sessione 6 che passa da `cron_http_post`.
--
-- DB DELLA CI: nessuna guardia serve. È una CREATE OR REPLACE di una funzione plpgsql: tabelle,
-- `cron_config` e `cron_http_post` si risolvono quando gira, e sulla CI non gira (niente pg_cron).
--
-- COME SI VERIFICA
--   SELECT p.prosrc ~ 'storici_generazioni' AS filtrata FROM pg_proc p WHERE p.proname = 'storici_tick';
--   SELECT count(*) FROM public.cron_chiamate
--    WHERE job = 'storici-stampe' AND percorso = '/api/admin/storici/cron'
--      AND inviata_il > now() - interval '24 hours';
--   Atteso: true; qualche decina al giorno invece di ~1.440.
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   La definizione di `storici_tick` della sessione 6, copiata dal suo file di migrazione
--   (piano della sessione 8, «Ritorno indietro»).

CREATE OR REPLACE FUNCTION public.storici_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare base text; segreto text; origine text;
begin
  -- 1. Conservazione delle copie storiche: invariata, ogni minuto, senza server.
  begin
    update public.storici_revisioni r set contenuto=
      case when jsonb_typeof(r.contenuto->'riga')='object' then
        jsonb_set(r.contenuto,'{riga}',(r.contenuto->'riga')||jsonb_build_object('giustificazione_testo',null,'note_appello',null))
      else r.contenuto||jsonb_build_object('giustificazione_testo',null,'note_appello',null) end
      where r.modulo in ('presenze','giustifiche-presenza')
        and (r.giorno_competenza < (now() at time zone 'Europe/Rome')::date-interval '12 months'
          or exists(select 1 from public.alunni a where a.id=r.alunno_id and public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)))
        and (r.contenuto->>'giustificazione_testo' is not null or r.contenuto->>'note_appello' is not null
          or r.contenuto#>>'{riga,giustificazione_testo}' is not null or r.contenuto#>>'{riga,note_appello}' is not null);
  exception when others then
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','storici: conservazione delle copie non riuscita',
             'cron:storici-stampe:conservazione-fallita',
             jsonb_build_object('campi', jsonb_build_object(
               'operazione','storici-stampe','esito','conservazione-fallita','sqlstate',SQLSTATE)))
      on conflict (fingerprint, giorno) do update set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise warning 'storici: conservazione fallita, log non scritto [%]', SQLSTATE;
    end;
  end;

  -- 2. Il server solo se la coda ha lavoro: presa libera o scaduta (330 s = DURATA_LEASE_MS), e
  --    un lavoro da riprendere o da pulire.
  if not exists (
    select 1 from public.storici_generazioni g
     where (g.preso_il is null or g.preso_il < now() - interval '330 seconds')
       and (g.scade_il <= now() or g.stato in ('in_coda','in_corso'))
  ) then
    return;
  end if;

  -- 3. Solo ora, con un lavoro da fare, la configurazione dal Vault e la chiamata.
  begin
    base := public.cron_config('app.push_dispatch_url');
    segreto := public.cron_config('app.cron_secret');
    if coalesce(base,'')='' then base := public.cron_config('app.notifiche_promemoria_url'); end if;
    origine := substring(base from '^https?://[^/]+');
    if coalesce(origine,'')='' or coalesce(segreto,'')='' then
      begin
        insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
        values('error','cron','server','Configurazione cron storici mancante','storici-cron-config-assente',
               jsonb_build_object('campi', jsonb_build_object(
                 'operazione','storici-stampe','esito','configurazione-assente')))
        on conflict (fingerprint, giorno) do update set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      exception when others then raise warning 'storici: configurazione cron mancante, log non scritto [%]', SQLSTATE;
      end;
      return;
    end if;
    perform public.cron_http_post('storici-stampe', url:=origine||'/api/admin/storici/cron',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',segreto),body:='{}'::jsonb,timeout_milliseconds:=300000);
  exception when others then
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','storici: chiamata del giro non riuscita',
             'cron:storici-stampe:chiamata-fallita',
             jsonb_build_object('campi', jsonb_build_object(
               'operazione','storici-stampe','esito','chiamata-fallita','sqlstate',SQLSTATE)))
      on conflict (fingerprint, giorno) do update set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise warning 'storici: chiamata fallita, log non scritto [%]', SQLSTATE;
    end;
  end;
end $function$;
REVOKE ALL ON FUNCTION public.storici_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_tick() TO service_role;
```

La riga della chiamata è quella della sessione 6 copiata parola per parola (la `net.http_post` del 19/10 con `net.http_post(` → `public.cron_http_post('storici-stampe', `): confrontala con la definizione di `storici_tick` letta nel Passo 4 del Compito 2 (`s08-chiamanti.json`), e devono coincidere carattere per carattere, chiavi del Vault comprese. Se il corpo di produzione ha qualcosa in più (oltre all'involucro), o chiavi del Vault diverse, riportalo qui prima di andare avanti e scrivilo nel corpo della PR.

- [ ] **Passo 4: eseguilo e guardalo passare, con i lock che leggono `storici_tick`**

```bash
npx vitest run __tests__/lib/storici-tick-solo-con-lavoro-sql.test.ts __tests__/architecture/stati-alunno-anche-in-sql.test.ts __tests__/architecture/cron-max-duration.test.ts __tests__/architecture/cron-http-esito-osservato.test.ts __tests__/architecture/app-log-battiti-con-conflitto.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  6 passed`. `cron-max-duration` legge ora la `storici_tick` di questa migrazione: una chiamata, job `storici-stampe`, `timeout_milliseconds := 300000`; `cron-http-esito-osservato` (sessione 6) la trova avvolta, con zero chiamate dirette.

- [ ] **Passo 5: commit**

```bash
git add __tests__/lib/storici-tick-solo-con-lavoro-sql.test.ts supabase/migrations/*_storici_tick_solo_con_lavoro.sql
git commit -m "$(cat <<'EOF'
Storici: il cron chiama il server solo se la coda ha lavoro (sessione 8)

storici_tick gira ogni minuto ma chiama /api/admin/storici/cron solo quando
storici_generazioni ha un lavoro da riprendere o da pulire (stessa condizione della
route, presa di 330 s). URL e segreto si leggono dal Vault solo in quel caso; la
configurazione mancante resta un error in app_log, ora con i campi. Le eccezioni
scrivono in app_log con ON CONFLICT.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — Igiene: `app_log` (T7), storico dei job, timeout dei ruoli

**File:**
- Test: `__tests__/lib/igiene-cron-log-ruoli-sql.test.ts`
- Modifica: `__tests__/architecture/informativa-conservazione-dichiarata.test.ts:350-354`
- Crea: `supabase/migrations/<version>_igiene_cron_log_ruoli.sql`
- Modifica: `src/lib/health/controlli.ts` (in fondo a `JOB_CRON_NON_SORVEGLIATI`)

- [ ] **Passo 1: il test PGlite (rosso)**

Crea `__tests__/lib/igiene-cron-log-ruoli-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { senzaCommenti } from '../architecture/soglia-fotografia'

/**
 * IGIENE DEL DATABASE (sessione 8 della seconda serie di robustezza).
 *
 *  · T7: in `app_log` le righe `error` restano 90 giorni, `info` e `warn` 30 come prima.
 *  · `cron.job_run_details` tiene 14 giorni, ma solo per i job il cui ultimo giro è già al sicuro
 *    in `cron_ultimo_esito` (sessione 6), cioè con `ultimo_runid` valorizzato. Il lettore
 *    `cron_esiti()` lo valorizza solo dentro la sua finestra di 5000 esecuzioni: un mensile ha la
 *    riga ma `ultimo_runid` nullo finché non rigira, e non perde la sua ultima esecuzione.
 *  · `idle_in_transaction_session_timeout = 60s` su service_role, authenticated, anon; se chi
 *    applica la migrazione non può, una riga `error` in app_log e la migrazione prosegue.
 *
 * Il file della migrazione è LETTO DAL DISCO e applicato DUE volte. `cron` è uno schema finto con
 * le sole colonne che la funzione legge. Controllo negativo: la purge del 13/07 toglieva anche
 * l'errore di 31 giorni. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_igiene_cron_log_ruoli.sql')

function bloccoTimeoutRuoli(): string {
  const inizio = NUOVA.indexOf('-- inizio: timeout-ruoli')
  const fine = NUOVA.indexOf('-- fine: timeout-ruoli')
  if (inizio < 0 || fine < 0) throw new Error('marcatori timeout-ruoli non trovati')
  return NUOVA.slice(inizio, fine)
}

function purgeDel1307(): string {
  const testo = readFileSync(join(CARTELLA, '20260713090000_app_log.sql'), 'utf8')
  const inizio = testo.indexOf('CREATE OR REPLACE FUNCTION public.app_log_purge()')
  const fine = testo.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error('app_log_purge del 13/07 non trovata')
  return testo.slice(inizio, fine + 'END $$;'.length)
}

const TRE_RUOLI = ['anon', 'authenticated', 'service_role']
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE backup_lettura NOLOGIN;
    ALTER ROLE backup_lettura SET statement_timeout = '30min';
    ALTER ROLE backup_lettura SET idle_in_transaction_session_timeout = '30min';

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creato_il timestamptz NOT NULL DEFAULT now(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text NOT NULL);
    CREATE TABLE cron.job_run_details (
      runid bigserial PRIMARY KEY, jobid bigint NOT NULL, status text,
      start_time timestamptz, end_time timestamptz
    );
    -- Solo le due colonne di `cron_ultimo_esito` (sessione 6) che la funzione legge.
    CREATE TABLE public.cron_ultimo_esito (job text PRIMARY KEY, ultimo_runid bigint);
  `)
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.app_log;
    DELETE FROM cron.job_run_details;
    DELETE FROM cron.job;
    DELETE FROM public.cron_ultimo_esito;
  `)
})

async function riga(fingerprint: string, livello: string, giorniFa: number): Promise<void> {
  await db.query(
    `INSERT INTO public.app_log (creato_il, giorno, livello, evento, messaggio, fingerprint)
     VALUES (now() - make_interval(days => $3::int), (now() - make_interval(days => $3::int))::date,
             $2, 'prova', 'riga di prova', $1)`,
    [fingerprint, livello, giorniFa],
  )
}

async function campiDel(fingerprint: string) {
  return (await db.query<{ livello: string; occorrenze: number; campi: Record<string, unknown> }>(
    `SELECT livello, occorrenze, contesto->'campi' AS campi FROM public.app_log WHERE fingerprint = $1`,
    [fingerprint],
  )).rows
}

describe('T7 — app_log tiene gli errori 90 giorni', () => {
  it('error 90 giorni; info e warn 30 come prima; battito con i conteggi', async () => {
    await riga('info-29', 'info', 29)
    await riga('info-31', 'info', 31)
    await riga('warn-31', 'warn', 31)
    await riga('error-31', 'error', 31)
    await riga('error-89', 'error', 89)
    await riga('error-91', 'error', 91)
    const { rows } = await db.query<{ n: number }>('SELECT public.app_log_purge() AS n')
    expect(rows[0].n).toBe(3)
    const restano = (await db.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM public.app_log WHERE evento = 'prova' ORDER BY 1`,
    )).rows.map((r) => r.fingerprint)
    expect(restano).toEqual(['error-31', 'error-89', 'info-29'])
    expect(await campiDel('cron:app-log-purge')).toEqual([{
      livello: 'info', occorrenze: 1,
      campi: { operazione: 'app-log-purge', esito: 'ok', n_righe: 3, n_errori: 1 },
    }])
  })

  it('due giri nello stesso giorno: una riga di battito con occorrenze 2', async () => {
    await db.query('SELECT public.app_log_purge()')
    await db.query('SELECT public.app_log_purge()')
    expect((await campiDel('cron:app-log-purge'))[0].occorrenze).toBe(2)
  })

  it('CONTROLLO NEGATIVO: la purge del 13/07 toglieva anche l’errore di 31 giorni', async () => {
    await riga('error-31', 'error', 31)
    await db.exec('BEGIN')
    try {
      await db.exec(purgeDel1307())
      await db.query('SELECT public.app_log_purge()')
      expect((await db.query(`SELECT 1 FROM public.app_log WHERE fingerprint = 'error-31'`)).rows).toEqual([])
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})

describe('cron.job_run_details tiene 14 giorni', () => {
  it('cancella oltre i 14 giorni solo per i job con l’ultimo giro al sicuro, e per i job tolti', async () => {
    // 1: ultimo giro in cron_ultimo_esito (ultimo_runid) → si pulisce.
    // 2: riga in cron_ultimo_esito ma ultimo_runid nullo (il mensile fuori finestra) → si trattiene.
    // 3: nessuna riga in cron_ultimo_esito → si trattiene.
    // 99: job non più in cron.job → si pulisce.
    await db.exec(`
      INSERT INTO cron.job VALUES (1, 'storici-stampe'), (2, 'news-digest'), (3, 'iscrizioni-retention');
      INSERT INTO public.cron_ultimo_esito VALUES ('storici-stampe', 2), ('news-digest', NULL);
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time) VALUES
        (1,  'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (1,  'succeeded', now() - interval '10 days', now() - interval '10 days'),
        (2,  'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (3,  'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (99, 'succeeded', now() - interval '20 days', now() - interval '20 days');
    `)
    const { rows } = await db.query<{ n: number }>('SELECT public.cron_storico_purge() AS n')
    expect(rows[0].n).toBe(2)
    const restano = (await db.query<{ jobid: number; giorni: number }>(
      `SELECT jobid::int AS jobid, extract(day FROM now() - start_time)::int AS giorni
         FROM cron.job_run_details ORDER BY 1, 2`,
    )).rows
    expect(restano).toEqual([{ jobid: 1, giorni: 10 }, { jobid: 2, giorni: 20 }, { jobid: 3, giorni: 20 }])
    expect(await campiDel('cron:cron-storico-purge')).toEqual([{
      livello: 'info', occorrenze: 1,
      campi: { operazione: 'cron-storico-purge', esito: 'ok', n_righe: 2, n_job_trattenuti: 2 },
    }])
  })

  it('senza cron_ultimo_esito non cancella niente, e lo dice a livello error', async () => {
    await db.exec(`
      INSERT INTO cron.job VALUES (1, 'storici-stampe');
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
        VALUES (1, 'succeeded', now() - interval '20 days', now() - interval '20 days');
    `)
    await db.exec('BEGIN')
    try {
      await db.exec('DROP TABLE public.cron_ultimo_esito')
      expect((await db.query<{ n: number }>('SELECT public.cron_storico_purge() AS n')).rows[0].n).toBe(0)
      expect((await db.query('SELECT 1 FROM cron.job_run_details')).rows).toHaveLength(1)
      expect((await campiDel('cron:cron-storico-purge:tabelle-assenti'))[0]).toMatchObject({
        livello: 'error', campi: { operazione: 'cron-storico-purge', esito: 'tabelle-assenti' },
      })
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})

describe('idle_in_transaction_session_timeout sui tre ruoli dell’API', () => {
  async function config() {
    return (await db.query<{ rolname: string; rolconfig: string[] | null }>(
      `SELECT rolname, rolconfig FROM pg_roles
        WHERE rolname IN ('anon', 'authenticated', 'service_role', 'backup_lettura', current_user)
        ORDER BY 1`,
    )).rows
  }

  it('60 s sui tre ruoli; il ruolo del backup e chi applica la migrazione non si toccano', async () => {
    const righe = await config()
    for (const r of TRE_RUOLI) {
      expect(righe.find((x) => x.rolname === r)?.rolconfig).toEqual(['idle_in_transaction_session_timeout=60s'])
    }
    expect(righe.find((x) => x.rolname === 'backup_lettura')?.rolconfig)
      .toEqual(['statement_timeout=30min', 'idle_in_transaction_session_timeout=30min'])
    const io = (await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u
    expect(righe.find((x) => x.rolname === io)?.rolconfig ?? null).toBeNull()
  })

  it('se chi applica la migrazione non può (42501), lo scrive in app_log e prosegue', async () => {
    await db.exec(`
      ALTER ROLE anon RESET idle_in_transaction_session_timeout;
      ALTER ROLE authenticated RESET idle_in_transaction_session_timeout;
      ALTER ROLE service_role RESET idle_in_transaction_session_timeout;
      DROP ROLE IF EXISTS migratore_finto;
      CREATE ROLE migratore_finto NOLOGIN;
      GRANT USAGE ON SCHEMA public TO migratore_finto;
      GRANT SELECT, INSERT, UPDATE ON public.app_log TO migratore_finto;
    `)
    await db.exec('SET ROLE migratore_finto')
    try {
      await db.exec(bloccoTimeoutRuoli())
    } finally {
      await db.exec('RESET ROLE')
    }
    const righe = await config()
    for (const r of TRE_RUOLI) expect(righe.find((x) => x.rolname === r)?.rolconfig ?? null).toBeNull()
    const log = (await db.query<{ fingerprint: string; livello: string; sqlstate: string }>(
      `SELECT fingerprint, livello, contesto->'campi'->>'sqlstate' AS sqlstate FROM public.app_log
        WHERE fingerprint LIKE 'migrazione:idle-timeout-non-applicato:%' ORDER BY 1`,
    )).rows
    expect(log).toEqual(TRE_RUOLI.map((r) => ({
      fingerprint: `migrazione:idle-timeout-non-applicato:${r}`, livello: 'error', sqlstate: '42501',
    })))
    await db.exec(bloccoTimeoutRuoli()) // di nuovo come superuser: lo stato che il resto del file si aspetta
  })

  it('mai ALTER DATABASE, mai postgres né il ruolo del backup', () => {
    const istruzioni = senzaCommenti(NUOVA)
    expect(istruzioni).not.toMatch(/alter\s+database/i)
    expect(istruzioni).not.toMatch(/'postgres'|"postgres"|\bbackup_lettura\b/i)
    expect(istruzioni).toContain("ARRAY['service_role', 'authenticated', 'anon']")
  })
})
```

In `__tests__/architecture/informativa-conservazione-dichiarata.test.ts` sostituisci:

```ts
  { job: 'fascicolo-audit-ip-retention', funzione: 'fascicolo_audit_ip_retention_tick' },
]
```

con:

```ts
  { job: 'fascicolo-audit-ip-retention', funzione: 'fascicolo_audit_ip_retention_tick' },
  // Sessione 8 della seconda serie: due lavori di sola SQL che da qui battono nella forma che
  // `controlloBattitoCron` sa leggere.
  { job: 'app-log-purge', funzione: 'app_log_purge' },
  { job: 'cron-storico-purge', funzione: 'cron_storico_purge' },
]
```

- [ ] **Passo 2: eseguili e guardali fallire**

```bash
npx vitest run __tests__/lib/igiene-cron-log-ruoli-sql.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts 2>&1 | tail -12
```

Atteso: il primo `FAIL` con `migrazione *_igiene_cron_log_ruoli.sql non trovata`; il secondo rosso su `app-log-purge scrive un contesto della forma…` (la purge del 13/07 non ha battito) e su `cron-storico-purge` (nessuna migrazione definisce `public.cron_storico_purge()`).

- [ ] **Passo 3: la migrazione**

Crea `supabase/migrations/$(date -u +%Y%m%d%H%M%S)_igiene_cron_log_ruoli.sql`:

```sql
-- Sessione 8 della seconda serie di robustezza — igiene: app_log (T7), storico dei job, timeout dei ruoli.
--
-- PERCHÉ (D11 e S12 del rapporto del 20/10). `cron.job_run_details` non ha un tetto (93.577 righe il
-- 20/10, e cresce di una riga per job a ogni giro); `idle_in_transaction_session_timeout` vale 0;
-- `app_log` cancella gli errori dopo 30 giorni, e un guasto che torna dopo un mese non si riconosce.
--
-- COSA CAMBIA.
--   1. `app_log_purge`: le righe `error` restano 90 giorni (decisione T7 del titolare, 20/10); `info`
--      e `warn` 30, come prima. Corpo di partenza: `pg_get_functiondef` in produzione, uguale a
--      `20260713090000_app_log.sql:226-248` (Passo 0). Battito `cron:app-log-purge` nella forma che
--      `controlloBattitoCron` legge. Il job `app-log-purge` (03:30 UTC) non cambia.
--   2. `cron_storico_purge` + job `cron-storico-purge` (03:41 UTC, lontano dal backup delle 02:23 e
--      dalla purge delle 03:30): `cron.job_run_details` tiene 14 giorni, ma solo per i job il cui
--      ultimo giro è già in `cron_ultimo_esito` (sessione 6) con `ultimo_runid` valorizzato, e per i
--      job che non esistono più. Il lettore `cron_esiti()` valorizza `ultimo_runid` solo dentro la
--      sua finestra di 5000 esecuzioni: un mensile ha la riga ma `ultimo_runid` nullo finché non
--      rigira, e resta trattenuto. Senza `cron_ultimo_esito` non cancella niente e scrive un
--      `error`. Battito `cron:cron-storico-purge`.
--   3. `idle_in_transaction_session_timeout = 60s` sui tre ruoli dell'API (`service_role`,
--      `authenticated`, `anon`), fra i marcatori `timeout-ruoli`. Non ALTER DATABASE (su questo
--      progetto dà 42501); non `postgres`; non il ruolo del backup, che ha i suoi 30 minuti
--      (20261005212210_ruolo_backup_lettura.sql:39-40). Se il ruolo che applica la migrazione non
--      può, una riga `error` per ruolo in `app_log` e la migrazione prosegue. PostgREST applica le
--      impostazioni del ruolo impersonato dentro ogni transazione: da qui il `reload config`.
--
-- DB DELLA CI: niente pg_cron (il blocco del job lo salta e lo dice con un NOTICE); `cron_ultimo_esito`
-- forse assente (la funzione lo dice e non cancella); l'ALTER ROLE ha la sua guardia.
--
-- COME SI VERIFICA
--   SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('service_role','authenticated','anon');
--     (`SHOW` come service_role non serve: i tre ruoli sono NOLOGIN, l'impostazione vive in rolconfig)
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('app-log-purge','cron-storico-purge');
--   SELECT fingerprint, livello, contesto->'campi' FROM public.app_log
--    WHERE fingerprint IN ('cron:app-log-purge','cron:cron-storico-purge')
--       OR fingerprint LIKE 'migrazione:idle-timeout-non-applicato:%';
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   ALTER ROLE service_role RESET idle_in_transaction_session_timeout; (e authenticated, anon)
--   NOTIFY pgrst, 'reload config';
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-storico-purge';
--   app_log_purge: la definizione di 20260713090000_app_log.sql:226-251 (30 giorni per tutti).

-- ── 1. app_log_purge (T7) ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.app_log_purge()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lotto  int;
  v_altri  int := 0;
  v_errori int := 0;
BEGIN
  -- info e warn: 30 giorni, come dal 2026-07-13.
  LOOP
    DELETE FROM public.app_log
     WHERE id IN (
       SELECT id FROM public.app_log
        WHERE livello <> 'error' AND creato_il < now() - interval '30 days'
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_altri := v_altri + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;
  -- error: 90 giorni (T7). Un guasto che torna dopo un mese si riconosce solo se la prima volta c'è ancora.
  LOOP
    DELETE FROM public.app_log
     WHERE id IN (
       SELECT id FROM public.app_log
        WHERE livello = 'error' AND creato_il < now() - interval '90 days'
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_errori := v_errori + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'app_log: pulizia notturna completata', 'cron:app-log-purge',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'app-log-purge', 'esito', 'ok',
              'n_righe', v_altri + v_errori, 'n_errori', v_errori)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'app_log_purge: battito non scritto [%]', SQLSTATE;
  END;
  RETURN v_altri + v_errori;
END $$;
REVOKE ALL ON FUNCTION public.app_log_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_purge() TO service_role;

-- ── 2. cron_storico_purge + job ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cron_storico_purge()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lotto      int;
  v_totale     int := 0;
  v_trattenuti int := 0;
BEGIN
  -- Senza `cron_ultimo_esito` (sessione 6) la pulizia toglierebbe l'unica traccia dell'ultimo giro dei
  -- job mensili: non si cancella niente, e lo si dice.
  IF to_regclass('public.cron_ultimo_esito') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      VALUES ('error', 'cron', 'server', 'cron_storico_purge: tabelle mancanti, nessuna pulizia',
              'cron:cron-storico-purge:tabelle-assenti',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'cron-storico-purge', 'esito', 'tabelle-assenti')))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'cron_storico_purge: log non scritto [%]', SQLSTATE;
    END;
    RETURN 0;
  END IF;

  -- Al sicuro = riga in `cron_ultimo_esito` CON `ultimo_runid`: la sola riga non basta, perché il
  -- lettore della sessione 6 la crea anche per un job che non ha ancora visto girare.
  SELECT count(*) INTO v_trattenuti
    FROM cron.job j
   WHERE NOT EXISTS (SELECT 1 FROM public.cron_ultimo_esito e
                      WHERE e.job = j.jobname AND e.ultimo_runid IS NOT NULL);

  LOOP
    DELETE FROM cron.job_run_details d
     WHERE d.runid IN (
       SELECT x.runid FROM cron.job_run_details x
        WHERE coalesce(x.end_time, x.start_time) < now() - interval '14 days'
          AND (NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobid = x.jobid)
               OR EXISTS (SELECT 1 FROM cron.job j JOIN public.cron_ultimo_esito e ON e.job = j.jobname
                           WHERE j.jobid = x.jobid AND e.ultimo_runid IS NOT NULL))
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_totale := v_totale + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'cron_storico_purge: pulizia completata', 'cron:cron-storico-purge',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'cron-storico-purge', 'esito', 'ok',
              'n_righe', v_totale, 'n_job_trattenuti', v_trattenuti)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_storico_purge: battito non scritto [%]', SQLSTATE;
  END;
  RETURN v_totale;
END $$;
REVOKE ALL ON FUNCTION public.cron_storico_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_storico_purge() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'cron-storico-purge: pg_cron assente, job non programmato';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-storico-purge';
  PERFORM cron.schedule('cron-storico-purge', '41 3 * * *', $cron$ SELECT public.cron_storico_purge(); $cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron-storico-purge: job non programmato [%]', SQLSTATE;
END $$;

-- ── 3. Timeout dei ruoli dell'API ────────────────────────────────────────────────────────────────
-- inizio: timeout-ruoli
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN CONTINUE; END IF;
    BEGIN
      EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
        VALUES ('error', 'migrazione', 'server',
                'idle_in_transaction_session_timeout non applicato a un ruolo dell''API',
                'migrazione:idle-timeout-non-applicato:' || r,
                jsonb_build_object('campi', jsonb_build_object(
                  'operazione', 'timeout-ruoli', 'esito', 'non-applicato', 'ruolo', r, 'sqlstate', SQLSTATE)))
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'timeout-ruoli: % non applicato e non registrato [%]', r, SQLSTATE;
      END;
    END;
  END LOOP;
END $$;
-- fine: timeout-ruoli

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
```

In `src/lib/health/controlli.ts` sostituisci:

```ts
]

/** La finestra più larga: quanto indietro serve leggere `app_log` per coprirle tutte. */
```

con:

```ts
    // `cron-storico-purge` (`41 3 * * *`, funzione SQL `cron_storico_purge`, sessione 8 della
    // seconda serie): tiene 14 giorni di `cron.job_run_details`. È giornaliero e il suo battito ha la
    // forma che `controlloBattitoCron` legge (`BATTITI_DA_LEGGERE`): il suo posto è `JOB_CRON`, con
    // `finestraMs: 26 * ORA`. Sta qui per un vincolo di SEQUENZA: la migrazione la applica
    // l'integrazione al merge, e fino ad allora `cron-sorvegliato-e-applicato` vieta di sorvegliarla.
    {
        nome: 'cron-storico-purge',
        perche:
            'IN ATTESA DEL PRIMO BATTITO: la migrazione che lo installa la applica l’integrazione ' +
            'Supabase al merge della PR della sessione 8 della seconda serie. Dopo il primo battito ' +
            '`ok` in app_log (impronta `cron:cron-storico-purge`) e la fotografia delle migrazioni ' +
            'rigenerata, passa in `JOB_CRON` con `finestraMs: 26 * ORA`.',
    },
]

/** La finestra più larga: quanto indietro serve leggere `app_log` per coprirle tutte. */
```

- [ ] **Passo 4: eseguili e guardali passare**

```bash
npx vitest run __tests__/lib/igiene-cron-log-ruoli-sql.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts __tests__/architecture/app-log-battiti-con-conflitto.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  6 passed`. Le `DELETE` della migrazione stanno nei corpi delle funzioni, e il comando di `cron.schedule` chiama solo la funzione: il lock delle migrazioni distruttive non chiede la riga di approvazione.

- [ ] **Passo 5: commit (dopo la sesta lettura del Passo 8 del Compito 2)**

Prima del commit rileggi `${TMPDIR:-/tmp}/s08-idle-prima.txt`: se la soglia del Passo 8 è scattata, il Compito si ferma qui e decide il titolare.

```bash
git add __tests__/lib/igiene-cron-log-ruoli-sql.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts supabase/migrations/*_igiene_cron_log_ruoli.sql src/lib/health/controlli.ts
git commit -m "$(cat <<'EOF'
Igiene del database: errori di app_log 90 giorni, storico dei job 14, timeout dei ruoli (sessione 8)

app_log_purge tiene le righe error 90 giorni (T7) e lascia un battito; il job
cron-storico-purge tiene 14 giorni di cron.job_run_details per i job con l'ultimo
giro già in cron_ultimo_esito (ultimo_runid valorizzato); idle_in_transaction_session_timeout = 60s su
service_role, authenticated e anon, con una riga error in app_log se non si può.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — Promemoria e sincronizzazione senza doppioni: lo schema

**File:**
- Test: `__tests__/lib/promemoria-sync-senza-doppioni-sql.test.ts`
- Crea: `supabase/migrations/<version>_promemoria_e_sync_senza_doppioni.sql`
- Modifica: `__tests__/architecture/soglia-fotografia.ts:251`

- [ ] **Passo 1: il test PGlite (rosso)**

Crea `__tests__/lib/promemoria-sync-senza-doppioni-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * DUE CORSE CHIUSE (D12 del rapporto del 20/10, sessione 8 della seconda serie).
 *
 *  · Promemoria: la deduplica era «leggi, poi inserisci». Ora `notifiche.chiave_dedup` ha un indice
 *    UNICO e NON PARZIALE (PostgREST non sa usare un indice parziale come arbitro: 42P10), e la
 *    scrittura è `ON CONFLICT (chiave_dedup) DO NOTHING`.
 *  · Sincronizzazione delle fatture: una presa con scadenza per giro (`cron_prese`), sul modello di
 *    `20261010230945_code_robuste_prese_con_scadenza.sql`.
 *
 * Due giri davvero CONCORRENTI non si provano in PGlite (una connessione sola): qui si prova la
 * regola che li separa, cioè l'arbitro e l'aggiornamento condizionato sul tempo del database.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_promemoria_e_sync_senza_doppioni.sql')

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AVVISO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ESTRANEO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TABLE public.notifiche (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      utente_id uuid NOT NULL,
      tipo text NOT NULL,
      entita_id uuid,
      creato_il timestamptz NOT NULL DEFAULT now()
    );
  `)
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('DELETE FROM public.notifiche; DELETE FROM public.cron_prese;')
})

async function accoda(chiave: string | null): Promise<void> {
  await db.query(
    `INSERT INTO public.notifiche (utente_id, tipo, entita_id, chiave_dedup)
     VALUES ($1, 'modulo_promemoria', $2, $3)
     ON CONFLICT (chiave_dedup) DO NOTHING`,
    [U1, AVVISO, chiave],
  )
}

async function righe(): Promise<number> {
  return Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.notifiche')).rows[0].n)
}

describe('promemoria: una riga per chiave', () => {
  it('l’indice è UNICO e NON parziale', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'notifiche_chiave_dedup_key'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/UNIQUE/)
    expect(rows[0].indexdef).not.toMatch(/WHERE/i)
  })

  it('due giri con la stessa chiave lasciano una riga', async () => {
    const chiave = `modulo_promemoria:${AVVISO}:${U1}:2026-10-21`
    await accoda(chiave)
    await accoda(chiave)
    expect(await righe()).toBe(1)
  })

  it('le notifiche senza chiave non si toccano', async () => {
    await accoda(null)
    await accoda(null)
    expect(await righe()).toBe(2)
  })
})

describe('sincronizzazione: presa con scadenza per giro', () => {
  const prendi = async (job = 'fattura-sync'): Promise<string | null> =>
    (await db.query<{ t: string | null }>('SELECT public.cron_presa_prendi($1, 330) AS t', [job])).rows[0].t
  const rilascia = async (token: string): Promise<boolean> =>
    (await db.query<{ ok: boolean }>(`SELECT public.cron_presa_rilascia('fattura-sync', $1) AS ok`, [token])).rows[0].ok

  it('una sola alla volta; si rilascia solo col proprio token; scade da sola', async () => {
    const prima = await prendi()
    expect(prima).toMatch(/^[0-9a-f-]{36}$/)
    expect(await prendi()).toBeNull()
    expect(await rilascia(ESTRANEO)).toBe(false)
    expect(await prendi()).toBeNull()
    expect(await rilascia(prima!)).toBe(true)
    const seconda = await prendi()
    expect(seconda).not.toBeNull()
    expect(seconda).not.toBe(prima)
    // Un giro morto a metà non rilascia: la presa scade da sola.
    await db.exec(`UPDATE public.cron_prese SET presa_scade_il = now() - interval '1 second' WHERE job = 'fattura-sync'`)
    expect(await prendi()).not.toBeNull()
  })

  it('un giro mai visto nasce alla prima presa', async () => {
    expect(await prendi('altro-giro')).not.toBeNull()
  })

  it('argomenti assurdi: 22023', async () => {
    await expect(db.query(`SELECT public.cron_presa_prendi('fattura-sync', 0)`)).rejects.toMatchObject({ code: '22023' })
    await expect(db.query(`SELECT public.cron_presa_prendi('fattura-sync', 3600)`)).rejects.toMatchObject({ code: '22023' })
  })

  it('solo service_role: RLS accesa, niente ad anon e authenticated', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('authenticated', 'public.cron_presa_prendi(text, integer)', 'EXECUTE') AS auth_prendi,
             has_function_privilege('anon', 'public.cron_presa_rilascia(text, uuid)', 'EXECUTE') AS anon_rilascia,
             has_function_privilege('service_role', 'public.cron_presa_prendi(text, integer)', 'EXECUTE') AS sr_prendi,
             has_table_privilege('authenticated', 'public.cron_prese', 'SELECT') AS auth_legge,
             (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cron_prese'::regclass) AS rls`)
    expect(rows[0]).toEqual({ auth_prendi: false, anon_rilascia: false, sr_prendi: true, auth_legge: false, rls: true })
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/promemoria-sync-senza-doppioni-sql.test.ts 2>&1 | tail -8
```

Atteso: `FAIL` con `migrazione *_promemoria_e_sync_senza_doppioni.sql non trovata`.

- [ ] **Passo 3: la migrazione**

Crea `supabase/migrations/$(date -u +%Y%m%d%H%M%S)_promemoria_e_sync_senza_doppioni.sql`:

```sql
-- Sessione 8 della seconda serie di robustezza — promemoria e sincronizzazione delle fatture senza doppioni.
--
-- PERCHÉ (D12 del rapporto del 20/10).
--   · I promemoria (`src/app/api/notifiche/promemoria/route.ts:224-237, 349-359`) leggono «già
--     mandato?» e poi inseriscono: due giri concorrenti mandano due volte.
--   · La sincronizzazione SDI (`src/app/api/pagamenti/fattura/sync/route.ts`) non ha un freno contro
--     un secondo giro sovrapposto. Il rapporto suggeriva `pg_advisory_xact_lock`, che con PostgREST
--     dura una sola chiamata e non copre un giro HTTP di minuti: si usa una presa con scadenza, sul
--     modello di `20261010230945_code_robuste_prese_con_scadenza.sql`.
--
-- COSA CAMBIA.
--   · `notifiche.chiave_dedup` (testo, NULL per tutte le notifiche di oggi) con l'indice UNICO e NON
--     PARZIALE `notifiche_chiave_dedup_key`: è l'arbitro di `ON CONFLICT (chiave_dedup) DO NOTHING`
--     (PostgREST non sa usare un indice parziale: 42P10). I NULL non vanno mai in conflitto. Un
--     indice sulle colonne di oggi è impossibile: un promemoria ogni N giorni è un doppione legittimo.
--     La chiave contiene solo tipo, uuid e date: mai nomi.
--   · `cron_prese` (una riga per giro, RLS senza policy, solo service_role) con `cron_presa_prendi`
--     (restituisce il token, o NULL se un altro giro la tiene) e `cron_presa_rilascia`. Il tempo è
--     quello del database, non dell'app.
--
-- DB DELLA CI: non migrato. `enqueueNotifiche` ripiega sull'insert senza chiave su 42703/PGRST204
-- (colonna assente) o 42P10 (nessun arbitro), la sincronizzazione parte senza presa su
-- PGRST202/42883 (RPC assente): lo dicono entrambe con una riga `info` (§5 della specifica, «Codice
-- che regge il momento del merge»). In produzione, dopo il merge, quelle righe non compaiono più.
--
-- COME SI VERIFICA
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'notifiche_chiave_dedup_key';
--   SELECT job, presa_scade_il IS NULL AS libera FROM public.cron_prese;
--   SELECT has_function_privilege('authenticated', 'public.cron_presa_prendi(text, integer)', 'EXECUTE');
--
-- ROLLBACK (solo dentro una PR di revert, come migrazione nuova)
--   Il codice di prima non scrive `chiave_dedup` e non chiama le due RPC: colonna, indice, tabella e
--   funzioni restano, innocui. Toglierli è una scelta del titolare e richiede la riga
--   «-- distruttiva approvata:» (lock `migrazioni-distruttive-approvate`).

-- ── Promemoria ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notifiche ADD COLUMN IF NOT EXISTS chiave_dedup text;
COMMENT ON COLUMN public.notifiche.chiave_dedup IS
  'Sessione 8 della seconda serie di robustezza: al massimo una notifica per chiave (arbitro di ON CONFLICT DO NOTHING). Solo tipo, uuid e date. NULL = nessuna deduplica.';
CREATE UNIQUE INDEX IF NOT EXISTS notifiche_chiave_dedup_key ON public.notifiche (chiave_dedup);

-- ── Presa con scadenza dei giri del cron ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cron_prese (
  job            text PRIMARY KEY,
  presa_il       timestamptz,
  presa_scade_il timestamptz,
  presa_token    uuid
);
ALTER TABLE public.cron_prese ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_prese FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cron_prese TO service_role;
INSERT INTO public.cron_prese (job) VALUES ('fattura-sync') ON CONFLICT (job) DO NOTHING;

CREATE OR REPLACE FUNCTION public.cron_presa_prendi(p_job text, p_durata_s integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_preso uuid;
BEGIN
  IF p_job IS NULL OR p_job = '' OR p_durata_s IS NULL OR p_durata_s < 1 OR p_durata_s > 900 THEN
    RAISE EXCEPTION 'cron_presa_prendi: argomenti non validi' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.cron_prese (job) VALUES (p_job) ON CONFLICT (job) DO NOTHING;
  -- Due giri insieme: il secondo UPDATE aspetta il primo, rilegge la riga e non la trova più libera.
  UPDATE public.cron_prese
     SET presa_il = now(),
         presa_scade_il = now() + make_interval(secs => p_durata_s),
         presa_token = v_token
   WHERE job = p_job AND (presa_scade_il IS NULL OR presa_scade_il < now())
  RETURNING presa_token INTO v_preso;
  RETURN v_preso;
END $$;
REVOKE ALL ON FUNCTION public.cron_presa_prendi(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_presa_prendi(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cron_presa_rilascia(p_job text, p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.cron_prese
     SET presa_scade_il = NULL, presa_token = NULL
   WHERE job = p_job AND presa_token = p_token;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.cron_presa_rilascia(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_presa_rilascia(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
```

In `__tests__/architecture/soglia-fotografia.ts` sostituisci:

```ts
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {}
```

con (il nome del file è quello creato al Passo 3, `ls supabase/migrations/*_promemoria_e_sync_senza_doppioni.sql`):

```ts
//
// 2026-10-?? · SESSIONE 8 della seconda serie «cron e igiene»: `<version>_promemoria_e_sync_senza_doppioni.sql`
// aggiunge `notifiche.chiave_dedup` con l'indice UNICO `notifiche_chiave_dedup_key` (arbitro
// dell'upsert dei promemoria) e crea `cron_prese` (PRIMARY KEY, RLS senza policy, solo
// service_role). Le guardie degli indici unici e della RLS la vedono per `unique`, `primary key` e
// `row level security`. Cambieranno davvero la fotografia degli indici unici (`notifiche_chiave_dedup_key`
// e la chiave primaria di `cron_prese`), quella della RLS (`cron_prese` entra in `tabelle_rls_attiva`;
// nessuna policy nuova) e quella delle migrazioni. Si toglie nella chiusura della precedente fatta
// dalla sessione che apre dopo (sezione «Per la sessione dopo» del piano della sessione 8), dopo
// aver rigenerato quelle tre fotografie dalla produzione.
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {
  '<version>_promemoria_e_sync_senza_doppioni.sql':
    'Sessione 8 della seconda serie: indice unico su notifiche.chiave_dedup e tabella cron_prese. ' +
    'La applica l’integrazione Supabase al merge; la voce si toglie nella chiusura della precedente ' +
    'fatta dalla sessione che apre dopo, rigenerando dalla produzione le fotografie delle ' +
    'migrazioni, degli indici unici e della RLS.',
}
```

Al posto di `<version>` e di `2026-10-??` scrivi la version del file e la data UTC di oggi. Se il Passo 5 del Compito 3 ha già dichiarato in questa costante `*_cron_timeout_uguale_max_duration.sql`, l'oggetto non è più `{}`: aggiungi la voce qui sopra dentro le graffe esistenti, dopo quella del Compito 3, e il blocco di commento sotto il suo.

- [ ] **Passo 4: eseguili e guardali passare**

```bash
npx vitest run __tests__/lib/promemoria-sync-senza-doppioni-sql.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  6 passed`.

- [ ] **Passo 5: commit**

```bash
git add __tests__/lib/promemoria-sync-senza-doppioni-sql.test.ts supabase/migrations/*_promemoria_e_sync_senza_doppioni.sql __tests__/architecture/soglia-fotografia.ts
git commit -m "$(cat <<'EOF'
Promemoria e sync: chiave di deduplica e presa con scadenza (sessione 8, schema)

notifiche.chiave_dedup con indice unico non parziale, arbitro di ON CONFLICT DO
NOTHING; cron_prese con cron_presa_prendi/cron_presa_rilascia per un giro alla volta
della sincronizzazione SDI. Dichiarata in MIGRAZIONI_ATTESE_AL_MERGE fino alla chiusura
fatta dalla sessione che apre dopo.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Codice dell'app e informativa

### Compito 7 — La chiave di deduplica dall'accodamento ai promemoria

**File:**
- Test: `__tests__/lib/push-enqueue-chiave-dedup.test.ts`, `__tests__/lib/notifiche-chiave-dedup.test.ts`
- Modifica: `src/lib/push/enqueue.ts:26-41`, `:78-88`, `:98-115`
- Modifica: `src/lib/notifiche/triggers.ts:23-46`, `:198-212`
- Modifica: `src/app/api/notifiche/promemoria/route.ts:242-252`, `:375-385`
- Modifica: `__tests__/architecture/onconflict-arbitro.test.ts` (`SENZA_ARBITRO_ATTESO`)

- [ ] **Passo 1: i test (rossi)**

Crea `__tests__/lib/push-enqueue-chiave-dedup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { enqueueNotifiche } from '@/lib/push/enqueue'

/**
 * LA CHIAVE DI DEDUPLICA (sessione 8 della seconda serie, D12). Chi la passa chiede «al massimo una
 * riga per chiave»: la scrittura è un upsert con `ignoreDuplicates` (ON CONFLICT DO NOTHING) e
 * l'arbitro è l'indice unico `notifiche_chiave_dedup_key`. Sul DB non migrato si ripiega
 * sull'insert di sempre, e lo si dice.
 */

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const U2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const AVVISO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const chiave = (uid: string) => `modulo_promemoria:${AVVISO}:${uid}:2026-10-21`

function finto(risposte: { upsert?: unknown[]; insert?: unknown[] }) {
  const upsert = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ error: null }))
  const insert = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ error: null }))
  for (const r of risposte.upsert ?? []) upsert.mockResolvedValueOnce(r)
  for (const r of risposte.insert ?? []) insert.mockResolvedValueOnce(r)
  return { client: { from: () => ({ upsert, insert }) } as unknown as SupabaseClient, upsert, insert }
}

describe('enqueueNotifiche — chiave di deduplica', () => {
  beforeEach(() => vi.clearAllMocks())

  it('con la chiave: upsert ON CONFLICT (chiave_dedup) DO NOTHING, una chiave per destinatario', async () => {
    const { client, upsert, insert } = finto({})
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1, U2], tipo: 'modulo_promemoria', titolo: 't', entitaId: AVVISO, chiaveDedup: chiave,
    })).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
    const [righe, opzioni] = upsert.mock.calls[0] as [Array<{ chiave_dedup: string }>, unknown]
    expect(opzioni).toEqual({ onConflict: 'chiave_dedup', ignoreDuplicates: true })
    expect(righe.map((r) => r.chiave_dedup)).toEqual([chiave(U1), chiave(U2)])
  })

  it('senza la chiave: l’insert di sempre, senza la colonna', async () => {
    const { client, upsert, insert } = finto({})
    expect(await enqueueNotifiche(client, { utenteIds: [U1], tipo: 'diario', titolo: 't' })).toBe(true)
    expect(upsert).not.toHaveBeenCalled()
    expect((insert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0]).not.toHaveProperty('chiave_dedup')
  })

  // §5 della specifica: schema nuovo non ancora installato (DB della CI, finestra del merge) = riga
  // `info` che dice perché, solo su questa chiamata. I codici: 42703/PGRST204 colonna assente
  // (`colonnaNuovaAssente`), 42P10 colonna presente ma nessun indice che faccia da arbitro.
  it.each(['42P10', 'PGRST204', '42703'])('DB senza colonna o senza arbitro (%s): ripiega sull’insert e lo dice a livello info', async (code) => {
    const { client, upsert, insert } = finto({ upsert: [{ error: { code, message: 'chiave_dedup' } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0]).not.toHaveProperty('chiave_dedup')
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'info', expect.objectContaining({ esito: 'chiave-dedup-assente' }), expect.objectContaining({ code }),
    )
    expect(h.logEvento).not.toHaveBeenCalledWith('notifica', 'warn', expect.anything(), expect.anything())
  })

  it('un errore vero non ripiega: resta un inserimento fallito, a livello error', async () => {
    const { client, insert } = finto({ upsert: [{ error: { code: '23503', message: 'fk' } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'error', expect.objectContaining({ esito: 'insert-fallito' }), expect.objectContaining({ code: '23503' }),
    )
  })
})
```

Crea `__tests__/lib/notifiche-chiave-dedup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ enqueue: vi.fn(async (..._a: unknown[]) => true) }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))

import { notificaEvento } from '@/lib/notifiche/triggers'

/** La chiave arriva intatta dalla route alla coda (sessione 8 della seconda serie, D12). */

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

describe('la chiave di deduplica arriva fino alla coda', () => {
  beforeEach(() => vi.clearAllMocks())

  it('notificaEvento la passa a enqueueNotifiche così com’è', async () => {
    const chiave = (uid: string) => `documenti_scadenza:${DOC}:${uid}`
    await notificaEvento({} as never, {
      tipo: 'documenti_scadenza', utenteIds: [U1], titolo: 't', entitaTipo: 'documento', entitaId: DOC,
      bufferMin: 0, chiaveDedup: chiave,
    })
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0][1]).toMatchObject({ utenteIds: [U1], chiaveDedup: chiave })
  })

  it('senza chiave non ne inventa una', async () => {
    await notificaEvento({} as never, { tipo: 'diario', utenteIds: [U1], titolo: 't' })
    expect((h.enqueue.mock.calls[0][1] as { chiaveDedup?: unknown }).chiaveDedup).toBeUndefined()
  })

  it('i promemoria dei moduli e dei documenti chiedono una riga sola per chiave', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/notifiche/promemoria/route.ts'), 'utf8')
    expect(route).toMatch(/chiaveDedup:\s*\(uid\)\s*=>\s*`modulo_promemoria:\$\{avviso\.id\}:\$\{uid\}:\$\{oggi\}`/)
    expect(route).toMatch(/chiaveDedup:\s*\(uid\)\s*=>\s*`documenti_scadenza:\$\{doc\.id\}:\$\{uid\}`/)
  })
})
```

- [ ] **Passo 2: eseguili e guardali fallire**

```bash
npx vitest run __tests__/lib/push-enqueue-chiave-dedup.test.ts __tests__/lib/notifiche-chiave-dedup.test.ts 2>&1 | tail -15
```

Atteso: rossi `con la chiave: upsert…` (si chiama `insert`), `DB senza colonna…` (tre casi), `notificaEvento la passa…` e `i promemoria…`. `tsc` segnalerebbe anche `chiaveDedup` sconosciuto: vitest non lo blocca.

- [ ] **Passo 3: `enqueueNotifiche`**

In `src/lib/push/enqueue.ts` sostituisci:

```ts
  operazione?: ContestoNotificaOperazione
  destinatario?: 'genitore' | 'personale'
}
```

con:

```ts
  operazione?: ContestoNotificaOperazione
  destinatario?: 'genitore' | 'personale'
  /**
   * Chiave di deduplica per destinatario (sessione 8 della seconda serie di robustezza, D12). Con la
   * chiave, al massimo UNA riga per chiave: l'indice unico `notifiche_chiave_dedup_key` fa da arbitro
   * e un secondo giro concorrente non scrive niente. Solo tipo, uuid e date: mai nomi.
   */
  chiaveDedup?: (utenteId: string) => string
}
```

Sostituisci:

```ts
    entita_id: params.entitaId ?? null,
    invio_programmato_il: programmato,
  }))
```

con:

```ts
    entita_id: params.entitaId ?? null,
    invio_programmato_il: programmato,
    ...(params.chiaveDedup ? { chiave_dedup: params.chiaveDedup(uid) } : {}),
  }))
```

Sostituisci:

```ts
  try {
    let { error } = await supabase.from('notifiche').insert(rows)
```

con:

```ts
  // LA CHIAVE DI DEDUPLICA. Chi la passa chiede «al massimo una riga per chiave»: si scrive con
  // ON CONFLICT (chiave_dedup) DO NOTHING (`ignoreDuplicates`), e due giri concorrenti dello stesso
  // promemoria lasciano UNA notifica. Senza chiave, l'insert di sempre.
  const scrivi = (righe: Record<string, unknown>[]) =>
    'chiave_dedup' in righe[0]
      ? supabase.from('notifiche').upsert(righe, { onConflict: 'chiave_dedup', ignoreDuplicates: true })
      : supabase.from('notifiche').insert(righe)

  try {
    let { error } = await scrivi(rows)
    // Il DB della CI non è migrato: lì mancano la colonna (PGRST204/42703) o l'indice che fa da
    // arbitro (42P10). Si ripiega sull'insert senza chiave e lo si DICE, a livello `info` come vuole
    // la §5 della specifica per uno schema nuovo non ancora installato. In produzione questa riga
    // vorrebbe dire che la migrazione della sessione 8 non è applicata: lo segnala il controllo
    // `migrazioni` di /api/health (sessione 7), non questo log.
    if (error && 'chiave_dedup' in rows[0] && (colonnaNuovaAssente(error) || error.code === '42P10')) {
      logEvento('notifica', 'info', {
        operazione: 'enqueueNotifiche', esito: 'chiave-dedup-assente', tipo: params.tipo, n: rows.length,
      }, error)
      rows = rows.map((r) => { const senza = { ...r }; delete senza.chiave_dedup; return senza })
      error = (await scrivi(rows)).error
    }
```

E dentro il ciclo dei metadati sostituisci:

```ts
      const precedente = await supabase.from('notifiche').insert(rows)
```

con:

```ts
      const precedente = await scrivi(rows)
```

- [ ] **Passo 4: `notificaEvento`**

In `src/lib/notifiche/triggers.ts` sostituisci:

```ts
  operazione?: ContestoNotificaOperazione
  destinatario?: 'genitore' | 'personale'
}
```

con:

```ts
  operazione?: ContestoNotificaOperazione
  destinatario?: 'genitore' | 'personale'
  /** Chiave di deduplica per destinatario: vedi `EnqueueNotificheParams.chiaveDedup`. */
  chiaveDedup?: (utenteId: string) => string
}
```

e sostituisci:

```ts
      operazione: params.operazione,
      destinatario: params.destinatario,
    })
  } catch (err) {
```

con:

```ts
      operazione: params.operazione,
      destinatario: params.destinatario,
      chiaveDedup: params.chiaveDedup,
    })
  } catch (err) {
```

- [ ] **Passo 5: i promemoria**

In `src/app/api/notifiche/promemoria/route.ts` sostituisci:

```ts
          entitaTipo: 'avviso',
          entitaId: avviso.id,
          bufferMin: 0,
        })
        esiti.moduli += destinatari.length
```

con:

```ts
          entitaTipo: 'avviso',
          entitaId: avviso.id,
          bufferMin: 0,
          // La lettura qui sopra resta la deduplica «negli ultimi N giorni»; la chiave chiude la
          // corsa fra due giri dello STESSO giorno (sessione 8, D12): l'indice unico lascia passare
          // il primo e scarta il secondo.
          chiaveDedup: (uid) => `modulo_promemoria:${avviso.id}:${uid}:${oggi}`,
        })
        esiti.moduli += destinatari.length
```

e sostituisci:

```ts
            entitaTipo: 'documento',
            entitaId: doc.id,
            bufferMin: 0,
          })
          esiti.documenti += 1
```

con:

```ts
            entitaTipo: 'documento',
            entitaId: doc.id,
            bufferMin: 0,
            // Un avviso per documento e per persona, una volta sola (sessione 8, D12).
            chiaveDedup: (uid) => `documenti_scadenza:${doc.id}:${uid}`,
          })
          esiti.documenti += 1
```

- [ ] **Passo 6: il lock degli arbitri sa perché questo arbitro non gli somiglia**

Il lock riconosce un arbitro solo se l'indice non ha colonne nullable o è `NULLS NOT DISTINCT` (funzione `arbitra`, e la prova «nessuna chiave si appoggia a un indice che tratta i NULL come distinti»). `notifiche.chiave_dedup` è nullable **per scelta** (è NULL per tutte le notifiche senza deduplica) e l'indice **non** può essere `NULLS NOT DISTINCT`: la seconda notifica senza chiave fallirebbe con `23505`. Quindi, anche dopo che la fotografia degli indici sarà rigenerata dalla produzione, il lock leggerà `notifiche_chiave_dedup_key` come «arbitro che tratta i NULL come distinti»: senza una voce in `SENZA_ARBITRO_ATTESO` diventerebbe rosso proprio allora. La voce è **permanente**, non un'attesa della fotografia: prima della rigenerazione l'indice non c'è nella fotografia, dopo c'è ma `arbitra` lo scarta, e in entrambi i casi la prova «le eccezioni dichiarate sono ancora eccezioni» resta verde (cade solo se un giorno l'indice diventasse `NULLS NOT DISTINCT` o la colonna `NOT NULL`, cioè se la ragione scritta qui smettesse di essere vera).

In `__tests__/architecture/onconflict-arbitro.test.ts`, in fondo all'array `SENZA_ARBITRO_ATTESO` (subito dopo la voce `daily_routines`, che finisce con `'QUESTA VOCE SI TOGLIE QUANDO QUEL CODICE MORTO SPARISCE, non quando la tabella viene creata.',` e `},`), prima della `]` che chiude l'array, aggiungi:

```ts
  {
    tabella: 'notifiche',
    chiave: 'chiave_dedup',
    perche:
      'Arbitro VOLUTO con i NULL distinti, non un difetto (sessione 8 della seconda serie di ' +
      'robustezza, D12). L’indice `notifiche_chiave_dedup_key` è UNICO e NON PARZIALE (PostgREST non ' +
      'sa usare un indice parziale come arbitro: 42P10) su una colonna che resta NULL per tutte le ' +
      'notifiche senza deduplica; per questo NON è `NULLS NOT DISTINCT`, che farebbe fallire con ' +
      '23505 la seconda notifica senza chiave. Il lock lo legge come «indice che tratta i NULL come ' +
      'distinti», ma il ramo dei duplicati silenziosi qui non esiste: `enqueueNotifiche` scrive con ' +
      '`onConflict: chiave_dedup` SOLO quando ogni riga porta la chiave (`chiaveDedup(uid)` è sempre ' +
      'un testo non vuoto), e le righe senza chiave passano dall’insert. Fino alla migrazione ' +
      '`*_promemoria_e_sync_senza_doppioni.sql` (la applica l’integrazione al merge) l’indice non ' +
      'c’è proprio, e `enqueueNotifiche` ripiega sull’insert dicendolo con `chiave-dedup-assente`. ' +
      'La voce si toglie solo se l’upsert su `chiave_dedup` sparisce da `src/`, o se la colonna ' +
      'diventa NOT NULL.',
  },
```

Nello stesso file, nel commento sopra l'array, sostituisci la riga:

```ts
 * ⚠️ LE DUE VOCI NON SONO LA STESSA COSA, e la lista sarebbe fuorviante se lo lasciasse credere:
```

con:

```ts
 * ⚠️ LE VOCI NON SONO LA STESSA COSA, e la lista sarebbe fuorviante se lo lasciasse credere
 * (`notifiche`/`chiave_dedup`, sessione 8 della seconda serie, è un arbitro voluto con i NULL
 * distinti: la sua ragione sta nel suo `perche`):
```

Se la riga da sostituire non c'è più (una sessione precedente ha già riscritto quel commento), lascia il commento com'è: la ragione della voce sta comunque nel suo `perche`.

- [ ] **Passo 7: eseguili e guardali passare**

```bash
npx vitest run __tests__/lib/push-enqueue-chiave-dedup.test.ts __tests__/lib/notifiche-chiave-dedup.test.ts __tests__/lib/push-enqueue.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/api/avvisi-promemoria-adesioni.test.ts __tests__/api/cron-battito.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  6 passed`; `tsc` senza output.

- [ ] **Passo 8: commit**

```bash
git add src/lib/push/enqueue.ts src/lib/notifiche/triggers.ts src/app/api/notifiche/promemoria/route.ts __tests__/lib/push-enqueue-chiave-dedup.test.ts __tests__/lib/notifiche-chiave-dedup.test.ts __tests__/architecture/onconflict-arbitro.test.ts
git commit -m "$(cat <<'EOF'
Promemoria: una notifica per chiave anche con due giri insieme (sessione 8, D12)

enqueueNotifiche accetta chiaveDedup e scrive con upsert ON CONFLICT (chiave_dedup)
DO NOTHING; sul DB non migrato ripiega sull'insert e lo dice (chiave-dedup-assente).
I promemoria dei moduli (per giorno) e dei documenti (per documento) passano la chiave.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8 — Un giro di sincronizzazione alla volta

**File:**
- Crea: `src/lib/cron/presa.ts`
- Test: `__tests__/lib/cron-presa.test.ts`, `__tests__/api/fattura-sync-presa.test.ts`
- Modifica: `src/app/api/pagamenti/fattura/sync/route.ts:27`, `:257-258`, `:286`, `:1111-1117`
- Modifica: `__tests__/api/fattura-sync.test.ts:22`, `__tests__/api/fattura-sync-notifiche.test.ts:62`, `__tests__/api/fattura-sync-destinatari-sede.test.ts:28`, `__tests__/api/cron-battito.test.ts:141`

- [ ] **Passo 1: i test (rossi)**

Crea `__tests__/lib/cron-presa.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import { DURATA_PRESA_CRON_S, prendiPresaCron, rilasciaPresaCron } from '@/lib/cron/presa'

/** La presa con scadenza dei giri del cron (sessione 8 della seconda serie, D12). */

const TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function finto(esito: { data?: unknown; error?: { code?: string; message?: string } } | Error) {
  const rpc = vi.fn(async (..._a: unknown[]) => {
    if (esito instanceof Error) throw esito
    return { data: esito.data ?? null, error: esito.error ?? null }
  })
  return { db: { rpc } as unknown as SupabaseClient, rpc }
}

describe('presa con scadenza dei giri del cron', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dura più della vita massima della route che protegge', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/pagamenti/fattura/sync/route.ts'), 'utf8')
    const vita = Number(/^export const maxDuration\s*=\s*(\d+)/m.exec(route)![1])
    expect(DURATA_PRESA_CRON_S).toBeGreaterThan(vita)
  })

  it('presa ottenuta: il token, chiesto per DURATA_PRESA_CRON_S secondi, e nessuna riga di log', async () => {
    const { db, rpc } = finto({ data: TOKEN })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'presa', token: TOKEN })
    expect(rpc).toHaveBeenCalledWith('cron_presa_prendi', { p_job: 'fattura-sync', p_durata_s: DURATA_PRESA_CRON_S })
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('null: un altro giro tiene la presa → «altrui», riga info', async () => {
    const { db } = finto({ data: null })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'altrui' })
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'info', { operazione: 'fattura-sync', esito: 'presa-altrui' })
  })

  // §5 della specifica: una RPC nuova non ancora installata (DB della CI, finestra del merge) regge
  // PGRST202/42883 solo su questa chiamata, con una riga `info` che dice perché.
  it.each(['PGRST202', '42883'])('RPC assente (%s, DB non migrato): il giro parte senza presa, riga info', async (code) => {
    const { db } = finto({ error: { code, message: 'cron_presa_prendi' } })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'presa', token: null })
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'info', { operazione: 'fattura-sync', esito: 'presa-senza-rpc' }, expect.objectContaining({ code }),
    )
    expect(h.logEvento).toHaveBeenCalledTimes(1)
  })

  it('altro errore: «guasto», riga error con il corpo dell’errore', async () => {
    const { db } = finto({ error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-riuscita' }, expect.objectContaining({ code: '57014' }),
    )
  })

  it('eccezione di trasporto: «guasto», riga error', async () => {
    const guasto = new Error('fetch failed')
    const { db } = finto(guasto)
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-eseguita' }, guasto)
  })

  it('rilascio senza token: nessuna chiamata', async () => {
    const { db, rpc } = finto({ data: true })
    await rilasciaPresaCron(db, 'fattura-sync', null)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rilascio col token: chiama cron_presa_rilascia; una presa già scaduta lo dice', async () => {
    const { db, rpc } = finto({ data: false })
    await rilasciaPresaCron(db, 'fattura-sync', TOKEN)
    expect(rpc).toHaveBeenCalledWith('cron_presa_rilascia', { p_job: 'fattura-sync', p_token: TOKEN })
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'warn', { operazione: 'fattura-sync', esito: 'presa-gia-scaduta' })
  })

  it('rilascio fallito: riga error, e non lancia', async () => {
    const { db } = finto({ error: { code: '08006', message: 'connessione persa' } })
    await expect(rilasciaPresaCron(db, 'fattura-sync', TOKEN)).resolves.toBeUndefined()
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-rilasciata' }, expect.objectContaining({ code: '08006' }),
    )
  })
})
```

Crea `__tests__/api/fattura-sync-presa.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * POST /api/pagamenti/fattura/sync — UN GIRO ALLA VOLTA (sessione 8 della seconda serie, D12).
 * Il segreto si guarda prima della presa; con la presa d'altri il giro non parte; la presa si
 * rilascia anche quando il giro fallisce. Il finto database lancia alla prima lettura: basta a
 * sapere se il giro è partito.
 */

const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const h = vi.hoisted(() => ({
  prendi: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ esito: 'presa', token: null })),
  rilascia: vi.fn(async (..._a: unknown[]) => undefined),
  from: vi.fn((..._a: unknown[]): unknown => { throw new Error('lettura finta fallita') }),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaGetByFilename: vi.fn() }
})
vi.mock('@/lib/cron/presa', () => ({ prendiPresaCron: h.prendi, rilasciaPresaCron: h.rilascia }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({ from: h.from }) }))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'

function req(secret?: string) {
  return new Request('http://localhost/api/pagamenti/fattura/sync', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('POST /api/pagamenti/fattura/sync — presa con scadenza sul giro', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('senza segreto: 401, e la presa non si tocca', async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(h.prendi).not.toHaveBeenCalled()
  })

  it('presa d’altri: 200 «saltato», nessuna lettura, nessun rilascio', async () => {
    h.prendi.mockResolvedValueOnce({ esito: 'altrui' })
    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { saltato: 'presa-altrui' } })
    expect(h.from).not.toHaveBeenCalled()
    expect(h.rilascia).not.toHaveBeenCalled()
  })

  it('presa guasta: 503, nessuna lettura', async () => {
    h.prendi.mockResolvedValueOnce({ esito: 'guasto' })
    const res = await POST(req('topsecret'))
    expect(res.status).toBe(503)
    expect(h.from).not.toHaveBeenCalled()
  })

  it('presa ottenuta: il giro parte, e la presa si rilascia anche se il giro fallisce', async () => {
    h.prendi.mockResolvedValueOnce({ esito: 'presa', token: TOKEN })
    const res = await POST(req('topsecret'))
    expect(res.status).toBe(500)
    expect(h.from).toHaveBeenCalledWith('fatture_emesse')
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(h.rilascia).toHaveBeenCalledTimes(1)
    expect(h.rilascia.mock.calls[0].slice(1)).toEqual(['fattura-sync', TOKEN])
  })
})
```

- [ ] **Passo 2: eseguili e guardali fallire**

```bash
npx vitest run __tests__/lib/cron-presa.test.ts __tests__/api/fattura-sync-presa.test.ts 2>&1 | tail -12
```

Atteso: il primo `FAIL` perché `@/lib/cron/presa` non esiste; il secondo rosso su «presa d'altri» e «presa guasta» (la route non chiede la presa: legge subito) e su «presa ottenuta» (nessun rilascio).

- [ ] **Passo 3: `src/lib/cron/presa.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// PRESA CON SCADENZA SUI GIRI DEL CRON (sessione 8 della seconda serie di robustezza, D12).
//
// Un giro che dura minuti (la sincronizzazione SDI: 185-242 s misurati l'11/09) non deve partire
// due volte insieme: due giri leggono le stesse fatture «in volo», le chiedono due volte ad Aruba
// e mandano due volte la stessa notifica di scarto. `pg_advisory_xact_lock` con PostgREST dura una
// chiamata sola, non un giro HTTP: qui la presa è una riga in `cron_prese` con una scadenza, presa
// e rilasciata da due RPC (`cron_presa_prendi`, `cron_presa_rilascia`), con il tempo del database.
//
// Un giro che muore a metà (Vercel lo taglia a `maxDuration`) non rilascia: la presa scade da sola
// dopo DURATA_PRESA_CRON_S, che per questo è PIÙ LUNGA della vita massima della route.
// =============================================================================

/** 330 s: più dei 300 di `maxDuration`, come la presa della coda delle stampe storiche. */
export const DURATA_PRESA_CRON_S = 330

/**
 * PostgREST non trova la funzione (PGRST202) o Postgres non la conosce (42883): DB non migrato (la
 * CI, o la finestra del merge). Insieme LOCALE a questa chiamata, sul modello di `RPC_ASSENTE` in
 * `src/app/api/avvisi/[id]/risposte/route.ts` (§5 della specifica): `src/lib/db/tolleranza-schema.ts`
 * non si allarga, perché fuori da questa finestra una RPC che manca è schema a metà.
 */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])

export type EsitoPresaCron =
  | { esito: 'presa'; token: string | null }
  | { esito: 'altrui' }
  | { esito: 'guasto' }

/**
 * `presa` col token da rilasciare (null sul DB non migrato: il giro parte senza freno, come prima,
 * e lo si dice); `altrui` se un altro giro la tiene; `guasto` se non si è potuto sapere.
 */
export async function prendiPresaCron(db: SupabaseClient, job: string): Promise<EsitoPresaCron> {
  try {
    const { data, error } = await db.rpc('cron_presa_prendi', { p_job: job, p_durata_s: DURATA_PRESA_CRON_S })
    if (error) {
      if (RPC_ASSENTE.has(error.code ?? '')) {
        // `info`, non `warn`: è lo schema di prima, atteso sul DB della CI e per i pochi minuti fra
        // deploy e migrazione (§5). Se in produzione la RPC mancasse davvero, lo dice il controllo
        // `migrazioni` di /api/health (sessione 7).
        logEvento('cron', 'info', { operazione: job, esito: 'presa-senza-rpc' }, error)
        return { esito: 'presa', token: null }
      }
      logEvento('cron', 'error', { operazione: job, esito: 'presa-non-riuscita' }, error)
      return { esito: 'guasto' }
    }
    if (typeof data !== 'string' || data === '') {
      logEvento('cron', 'info', { operazione: job, esito: 'presa-altrui' })
      return { esito: 'altrui' }
    }
    return { esito: 'presa', token: data }
  } catch (err) {
    logEvento('cron', 'error', { operazione: job, esito: 'presa-non-eseguita' }, err)
    return { esito: 'guasto' }
  }
}

/** Non lancia mai: un rilascio fallito si logga, e la presa scade da sola. */
export async function rilasciaPresaCron(db: SupabaseClient, job: string, token: string | null): Promise<void> {
  if (!token) return
  try {
    const { data, error } = await db.rpc('cron_presa_rilascia', { p_job: job, p_token: token })
    if (error) {
      logEvento('cron', 'error', { operazione: job, esito: 'presa-non-rilasciata' }, error)
      return
    }
    if (data !== true) logEvento('cron', 'warn', { operazione: job, esito: 'presa-gia-scaduta' })
  } catch (err) {
    logEvento('cron', 'error', { operazione: job, esito: 'presa-non-rilasciata' }, err)
  }
}
```

- [ ] **Passo 4: la route della sincronizzazione**

In `src/app/api/pagamenti/fattura/sync/route.ts`:

Sostituisci:

```ts
import { segretoCronValido } from '@/lib/security/segreto-cron'
```

con:

```ts
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { prendiPresaCron, rilasciaPresaCron } from '@/lib/cron/presa'
```

Sostituisci:

```ts
export const POST = withRoute('pagamenti/fattura/sync:POST', async (request: Request) => {
  const t0 = Date.now()
```

con:

```ts
/**
 * IL GIRO, com'era fino alla sessione 8. Il POST qui sotto lo avvolge con la presa con scadenza;
 * `clientGiaCreato` è il client con cui il POST ha preso la presa, riusato invece di crearne un
 * secondo. Chiamato senza (segreto mancante o sbagliato) risponde 401 con i suoi log di sempre.
 */
async function giroSync(
  request: Request,
  clientGiaCreato?: Awaited<ReturnType<typeof createAdminClient>>,
): Promise<Response> {
  const t0 = Date.now()
```

Sostituisci:

```ts
    const supabase = await createAdminClient()
    const { data: pendenti, error: errPendenti } = await supabase
```

con:

```ts
    const supabase = clientGiaCreato ?? (await createAdminClient())
    const { data: pendenti, error: errPendenti } = await supabase
```

Sostituisci:

```ts
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
```

con:

```ts
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

/**
 * UN GIRO ALLA VOLTA (sessione 8 della seconda serie di robustezza, D12). Due giri insieme
 * leggerebbero le stesse fatture «in volo» e manderebbero due volte la stessa notifica di scarto.
 * La presa `fattura-sync` scade da sola dopo `DURATA_PRESA_CRON_S` (più di `maxDuration`): un giro
 * tagliato da Vercel non blocca il successivo.
 */
export const POST = withRoute('pagamenti/fattura/sync:POST', async (request: Request) => {
  // Il segreto si guarda PRIMA della presa: un POST anonimo non deve poter occupare il giro.
  // `giroSync` lo riguarda e risponde 401 con i suoi log, invariati.
  if (!segretoCronValido(request.headers.get('x-cron-secret'))) return giroSync(request)
  const t0 = Date.now()
  let db: Awaited<ReturnType<typeof createAdminClient>>
  try {
    db = await createAdminClient()
  } catch (err) {
    // Stessa riga del `catch` di `giroSync`: il fallimento totale resta un battito «cron»
    // (DIFETTO 3 di `__tests__/api/cron-battito.test.ts`), non un «unhandled».
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
  const presa = await prendiPresaCron(db, JOB)
  if (presa.esito === 'altrui') {
    return NextResponse.json({ success: true, data: { saltato: 'presa-altrui' } })
  }
  if (presa.esito === 'guasto') {
    return NextResponse.json({ error: 'Service Unavailable' }, { status: 503 })
  }
  try {
    return await giroSync(request, db)
  } finally {
    await rilasciaPresaCron(db, JOB, presa.token)
  }
})
```

- [ ] **Passo 5: i test che chiamano la route con un finto senza `rpc`**

In `__tests__/api/fattura-sync.test.ts` e in `__tests__/api/fattura-sync-notifiche.test.ts` sostituisci:

```ts
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
```

con:

```ts
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
// La presa con scadenza (sessione 8) ha i suoi test: qui il giro la ottiene sempre, senza token.
vi.mock('@/lib/cron/presa', () => ({
  prendiPresaCron: async () => ({ esito: 'presa', token: null }),
  rilasciaPresaCron: async () => undefined,
}))
```

In `__tests__/api/fattura-sync-destinatari-sede.test.ts` sostituisci:

```ts
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => enqueueNotifiche(...a) }))
```

con:

```ts
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => enqueueNotifiche(...a) }))
// La presa con scadenza (sessione 8) ha i suoi test: qui il giro la ottiene sempre, senza token.
vi.mock('@/lib/cron/presa', () => ({
  prendiPresaCron: async () => ({ esito: 'presa', token: null }),
  rilasciaPresaCron: async () => undefined,
}))
```

In `__tests__/api/cron-battito.test.ts` sostituisci:

```ts
vi.mock('@/lib/notifiche/triggers', () => notifiche)
```

con:

```ts
vi.mock('@/lib/notifiche/triggers', () => notifiche)
// La presa con scadenza di `fattura/sync` (sessione 8) ha i suoi test: qui il giro la ottiene sempre.
vi.mock('@/lib/cron/presa', () => ({
  prendiPresaCron: async () => ({ esito: 'presa', token: null }),
  rilasciaPresaCron: async () => undefined,
}))
```

- [ ] **Passo 6: eseguili e guardali passare**

```bash
npx vitest run __tests__/lib/cron-presa.test.ts __tests__/api/fattura-sync-presa.test.ts __tests__/api/fattura-sync.test.ts __tests__/api/fattura-sync-notifiche.test.ts __tests__/api/fattura-sync-destinatari-sede.test.ts __tests__/api/cron-battito.test.ts __tests__/api/cron-secret.test.ts __tests__/architecture/cron-max-duration.test.ts __tests__/architecture/logging-coverage.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  9 passed`; `tsc` senza output. In `cron-battito.test.ts` il caso «DIFETTO 3» di `fattura/sync` passa grazie al `catch` del POST nuovo (una sola `logErrore`, `evento: 'cron'`, `stato: 500`, l'errore vero come secondo argomento).

- [ ] **Passo 7: commit**

```bash
git add src/lib/cron/presa.ts src/app/api/pagamenti/fattura/sync/route.ts __tests__/lib/cron-presa.test.ts __tests__/api/fattura-sync-presa.test.ts __tests__/api/fattura-sync.test.ts __tests__/api/fattura-sync-notifiche.test.ts __tests__/api/fattura-sync-destinatari-sede.test.ts __tests__/api/cron-battito.test.ts
git commit -m "$(cat <<'EOF'
Sync SDI: un giro alla volta con una presa con scadenza (sessione 8, D12)

Il POST prende la presa fattura-sync (330 s, più del maxDuration) prima del giro e la
rilascia in un finally; con la presa d'altri risponde 200 «saltato», con un guasto 503.
Sul DB non migrato (PGRST202) il giro parte senza presa e lo dice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 9 — L'informativa dice i 90 giorni degli errori

**File:**
- Modifica: `src/app/privacy/page.tsx:855-858`
- Modifica: `src/lib/legal/versioni.ts:250-269`
- Test: `__tests__/architecture/pagine-legali.test.ts` (voce nuova dopo quella della versione in vigore)

- [ ] **Passo 1: il testo**

In `src/app/privacy/page.tsx` sostituisci:

```tsx
              <li>
                <strong>log tecnici di accesso e di utilizzo</strong>: <strong>30 giorni</strong>,
                dopodiché sono cancellati automaticamente;
              </li>
```

con:

```tsx
              <li>
                <strong>log tecnici di accesso e di utilizzo</strong>: <strong>30 giorni</strong>;
                le righe che registrano un errore <strong>90 giorni</strong>, per riconoscere un
                guasto che si ripresenta. Dopodiché sono cancellati automaticamente;
              </li>
```

«Automaticamente» c'era e resta vero: lo fa `app-log-purge`, installato da `20260713090000_app_log.sql` e applicato da luglio (lock `informativa-conservazione-dichiarata`, `AUTOMI_DICHIARATI`).

- [ ] **Passo 2: il lock dell'impronta diventa rosso, e dà l'impronta nuova**

```bash
PRIMA=$(sed -n "s/^export const VERSIONE_PRIVACY = '\([0-9-]*\)'$/\1/p" src/lib/legal/versioni.ts)
IMPRONTA=$(npx vitest run __tests__/architecture/pagine-legali.test.ts 2>&1 | grep -o 'impronta attuale: [0-9a-f]\{64\}' | head -1 | cut -d' ' -f3)
V=$(date -u +%F)
echo "$PRIMA $V $IMPRONTA"
grep -c "'$V'" __tests__/architecture/pagine-legali.test.ts
```

Atteso: la versione in vigore, la data di oggi, 64 caratteri esadecimali, e `0`. **Se l'ultimo numero non è `0`** o `PRIMA` è uguale a `V`, oggi esiste già una versione dell'informativa: fermati e chiedi al titolare, perché una versione già citata in `consents_log` non si riscrive.

- [ ] **Passo 3: alza la versione e deposita l'impronta**

In `src/lib/legal/versioni.ts`, prima di `/** Versione corrente dei Termini di servizio. */`, aggiungi:

```ts
// Sessione 8 della seconda serie di robustezza — SOLO l'informativa privacy. La voce «log tecnici di
// accesso e di utilizzo» dice che le righe che registrano un ERRORE restano novanta giorni (decisione
// T7 del titolare, 20/10); le altre restano trenta, come prima. Sostanziale: un trattamento che
// allunga la vita di un dato, e che il documento non diceva. I log sono redatti a lista bianca
// (nomi, email e codici fiscali come hash correlabile; testo libero e dati sanitari tolti).
// «Automaticamente» c'era già e resta vero: lo fa `app-log-purge`, applicato dal 2026-07-13.
// È testo legale: il titolare lo rilegge.
// I TERMINI DI SERVIZIO NON SONO STATI TOCCATI: `VERSIONE_TERMINI` resta al 2026-07-31.

```

Poi:

```bash
sed -i '' "s/^export const VERSIONE_PRIVACY = '.*'$/export const VERSIONE_PRIVACY = '$V'/" src/lib/legal/versioni.ts
grep -n "^export const VERSIONE_PRIVACY" src/lib/legal/versioni.ts
awk -v prima="$PRIMA" -v v="$V" -v imp="$IMPRONTA" '
  { print }
  !fatto && index($0, "'\''" prima "'\'': '\''") {
    print "        // " v " — sessione 8 della seconda serie: i «log tecnici» tengono le righe di ERRORE"
    print "        // novanta giorni (T7); le altre restano trenta. La '\''" prima "'\'' resta dov'\''è."
    print "        '\''" v "'\'': '\''" imp "'\'',"
    fatto = 1
  }
' __tests__/architecture/pagine-legali.test.ts > "${TMPDIR:-/tmp}/pagine-legali.ts" \
  && mv "${TMPDIR:-/tmp}/pagine-legali.ts" __tests__/architecture/pagine-legali.test.ts
grep -n "'$V'" __tests__/architecture/pagine-legali.test.ts
```

Atteso: `export const VERSIONE_PRIVACY = '` seguito dalla data di oggi; una riga con la chiave di oggi e l'impronta, subito dopo quella della versione di prima.

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/architecture/pagine-legali.test.ts __tests__/architecture/informativa- 2>&1 | tail -5
```

Atteso: `Test Files  3 passed` (`pagine-legali`, `informativa-conservazione-dichiarata`, `informativa-oscuramento-registri-tecnici`).

- [ ] **Passo 5: commit**

```bash
git add src/app/privacy/page.tsx src/lib/legal/versioni.ts __tests__/architecture/pagine-legali.test.ts
git commit -m "$(cat <<'EOF'
Informativa: le righe d'errore dei log tecnici restano 90 giorni (T7)

La voce «log tecnici di accesso e di utilizzo» dice i 90 giorni delle righe d'errore;
le altre restano 30. Versione nuova, impronta depositata. Da rileggere da parte del
titolare.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Log

| Dove | Chiamata | Livello | `esito` | Campi | Nuovo? |
|---|---|---|---|---|---|
| `enqueueNotifiche` | `logEvento('notifica', …)` | `info` (§5: schema nuovo non ancora installato) | `chiave-dedup-assente` | `tipo`, `n` + l'errore intero (codice 42P10/PGRST204/42703) | sì |
| `enqueueNotifiche` | `logEvento('notifica', …)` | `error` | `insert-fallito` / `insert-non-eseguito` | invariati; ora anche dopo un upsert fallito | invariato |
| `prendiPresaCron` | `logEvento('cron', …)` | `info` | `presa-altrui` | `operazione` (il job) | sì |
| `prendiPresaCron` | `logEvento('cron', …)` | `info` (§5: RPC nuova non ancora installata) | `presa-senza-rpc` | `operazione` + l'errore (PGRST202/42883) | sì |
| `prendiPresaCron` | `logEvento('cron', …)` | `error` | `presa-non-riuscita` / `presa-non-eseguita` | `operazione` + l'errore | sì |
| `rilasciaPresaCron` | `logEvento('cron', …)` | `error` / `warn` | `presa-non-rilasciata` / `presa-gia-scaduta` | `operazione` (+ l'errore) | sì |
| `pagamenti/fattura/sync:POST` | `logErrore` | `error`, `stato: 500` | — | `evento: 'cron'`, l'errore vero | stessa riga del `catch` del giro, ora anche prima della presa |
| `storici_tick()` (SQL) | `app_log`, impronte `cron:storici-stampe:chiamata-fallita` e `:conservazione-fallita` | `error` | `chiamata-fallita` / `conservazione-fallita` | `operazione`, `sqlstate`, con ON CONFLICT | sì (prima solo `raise warning`) |
| `storici_tick()` (SQL) | `app_log`, impronta `storici-cron-config-assente` | `error` | `configurazione-assente` | `operazione`, con ON CONFLICT | stessa riga di prima (impronta invariata); ora con i campi, e solo quando c'è un lavoro che non può partire |
| `app_log_purge()` (SQL) | `app_log`, impronta `cron:app-log-purge` | `info` | `ok` | `operazione`, `n_righe`, `n_errori` | sì: il battito che prima non c'era |
| `cron_storico_purge()` (SQL) | `app_log`, impronte `cron:cron-storico-purge` e `:tabelle-assenti` | `info` / `error` | `ok` / `tabelle-assenti` | `operazione`, `n_righe`, `n_job_trattenuti` | sì |
| migrazione dell'igiene | `app_log`, impronta `migrazione:idle-timeout-non-applicato:<ruolo>` | `error` | `non-applicato` | `operazione: timeout-ruoli`, `ruolo`, `sqlstate` | sì |

**Successo e fallimento.** I giri del cron loggano già l'avvio e la chiusura (`avviato`, `ok`, `ok-parziale`); i due lavori SQL nuovi o toccati hanno ora il loro battito di successo, nella forma che `controlloBattitoCron` legge (lock `informativa-conservazione-dichiarata`, `BATTITI_DA_LEGGERE`). Configurazione mancante (tabelle assenti, ruolo non modificabile, migrazione non applicata) = `error`. L'unica eccezione è quella della §5 della specifica, «Codice che regge il momento del merge»: colonna, indice o RPC **nuovi** di questa sessione, che mancano per costruzione sul DB della CI e nei minuti fra deploy e migrazione, si reggono solo su quella chiamata con una riga `info` che nomina l'esito (`chiave-dedup-assente`, `presa-senza-rpc`). Se in produzione mancassero davvero dopo il merge, lo segnala il controllo `migrazioni` di `/api/health` (sessione 7), che confronta l'ultima version del repo con quella applicata.

**Mai dati personali.** Le chiavi di deduplica contengono tipo, uuid e date; non finiscono nei log. I campi nuovi sono numeri, codici, nomi di job e di ruoli.

---

## PRD

### Compito 10 — PRD e tabella di stato

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (prima della riga 1)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md:32`

I valori fra parentesi graffe sono **misure**, non scelte: vengono da `${TMPDIR:-/tmp}/s08-misure.env` (Compito 2), dai nomi dei file di migrazione (`ls supabase/migrations/*_cron_timeout_uguale_max_duration.sql supabase/migrations/*_storici_tick_solo_con_lavoro.sql supabase/migrations/*_igiene_cron_log_ruoli.sql supabase/migrations/*_promemoria_e_sync_senza_doppioni.sql`) e dalla versione `{V}` dell'informativa (Compito 9).

- [ ] **Passo 1: la voce di changelog in cima al PRD**

```markdown
## 🛡️ Changelog — Robustezza, seconda serie, sessione 8: cron senza timeout finti, storici solo con lavoro, igiene del database — {data UTC di oggi} (branch `robustezza2/s08-cron-e-igiene`)

**Stato:** 🟡 in revisione. Le quattro migrazioni le applica l'integrazione al merge, una riga ciascuna con la version del file. «In produzione», il commit di `main` e i numeri «dopo» li scrive la sessione che apre dopo, nella sua chiusura della precedente.

**Misura «prima»** ({ISCRIZIONI_ALLE} UTC, sola lettura): `enrollment_submissions` = **{ISCRIZIONI}** righe. Timeout del client pg_net: **{TIMEOUT_GIORNO}** al giorno (media di {GIORNI_TIMEOUT} giorni, `cron_chiamate`, `esito = 'timeout'`); chiamate a `/api/admin/storici/cron`: **{STORICI_CHIAMATE_GIORNO}** al giorno, per {STAMPE_24H} stampe richieste in 24 ore; `cron.job_run_details`: **{JRD_RIGHE}** righe ({JRD_DIMENSIONE}), {JRD_24H} nelle ultime 24 ore; job attivi con l'ultimo giro in `cron_ultimo_esito` (`ultimo_runid` valorizzato): {ULTIMO_ESITO_RIGHE} su {JOB_ATTIVI}; trattenuti oltre i 14 giorni finché non rigirano: {SENZA_ULTIMO_ESITO}; `idle in transaction` più lunga in sei letture: {IDLE_MAX} ({IDLE_CHI}); `ALTER ROLE` possibile per chi applica le migrazioni: {PUO_ALTER_ROLE}; `app_log`: {APP_LOG_PRIMA_MB} MB, {APP_LOG_RIGHE} righe, {ERRORI_GIORNO} errori al giorno, crescita stimata con T7 **{CRESCITA_MB} MB**; promemoria doppi già in tabella: {DOPPI_MODULI} (moduli), {DOPPI_DOCUMENTI} (documenti); `notifiche`: {NOTIFICHE_RIGHE} righe; pg_net {PG_NET}. Timeout di prima, per il ritorno indietro: `{TIMEOUT_PRIMA}`.

- **Timeout = `maxDuration`** (`{version A}_cron_timeout_uguale_max_duration.sql`, `scripts/cron-esiti/timeout.mjs`). Nella chiamata a `cron_http_post` delle funzioni del cron l'argomento nominato `timeout_milliseconds` diventa il `maxDuration` della route in millisecondi (300000): valore cambiato dove c'era (120000 di `iscrizioni_retention_http`), argomento aggiunto dove valeva il predefinito di 5000. Niente più `esito = 'timeout'` in `cron_chiamate` mentre la route prosegue (S1). Corpi presi dalla produzione; il lock `cron-max-duration` controlla anche il lato SQL con la tabella funzione → job → route, leggendo la chiamata con lo stesso modulo che l'ha riscritta.
- **Storici solo con lavoro** (`{version B}_storici_tick_solo_con_lavoro.sql`). `storici_tick` gira ogni minuto ma chiama il server solo se `storici_generazioni` ha un lavoro da riprendere o da pulire (presa di 330 s, come la route); URL e segreto si leggono dal Vault solo in quel caso; le eccezioni scrivono in `app_log`.
- **Igiene** (`{version C}_igiene_cron_log_ruoli.sql`). `app_log` tiene le righe `error` 90 giorni (T7), le altre 30, con un battito `cron:app-log-purge`; il job `cron-storico-purge` (03:41 UTC) tiene 14 giorni di `cron.job_run_details` per i job il cui ultimo giro è in `cron_ultimo_esito` (`ultimo_runid` valorizzato), e trattiene gli altri; `idle_in_transaction_session_timeout = 60s` su `service_role`, `authenticated`, `anon` (non `postgres`, non `backup_lettura`, non `ALTER DATABASE`). Osservato: le sessioni `idle in transaction` più lunghe erano di {IDLE_CHI}; causa probabile e ruoli che i 60 s non toccano: vedi le decisioni del titolare nel piano.
- **Promemoria e sync senza doppioni** (`{version D}_promemoria_e_sync_senza_doppioni.sql`, `enqueue.ts`, `triggers.ts`, `promemoria/route.ts`, `cron/presa.ts`, `fattura/sync/route.ts`). `notifiche.chiave_dedup` con indice unico non parziale: i promemoria dei moduli (una chiave per avviso, persona e giorno) e dei documenti (per documento e persona) si scrivono con `ON CONFLICT DO NOTHING`. La sincronizzazione SDI prende la presa `fattura-sync` (330 s) e la rilascia in un `finally` (D12). Sul DB non migrato entrambe ripiegano e lo dicono (`chiave-dedup-assente`, `presa-senza-rpc`).
- **Informativa** alla versione `{V}`: la voce «log tecnici» dice i 90 giorni delle righe d'errore. Da rileggere da parte del titolare.

**Prove.** PGlite `storici-tick-solo-con-lavoro-sql.test.ts`, `igiene-cron-log-ruoli-sql.test.ts`, `promemoria-sync-senza-doppioni-sql.test.ts` (migrazioni lette dal disco, applicate due volte, con i controlli negativi sulle funzioni di prima); `cron-presa.test.ts`, `fattura-sync-presa.test.ts`, `push-enqueue-chiave-dedup.test.ts`, `notifiche-chiave-dedup.test.ts`; lock `cron-max-duration` (lato SQL, con `scripts/cron-esiti/timeout.mjs` e i suoi esempi «il criterio morde» e `conTimeout`), `informativa-conservazione-dichiarata` (due battiti in più), impronta dell'informativa.

**Da fare dopo il merge.** Le `SELECT` del Rilascio e, dopo un'ora, `/api/health` senza `storici-stampe` fra i job senza esito buono; la misura «dopo» a +24 ore (timeout a 0, chiamate a storici, latenza per job) e dopo la prima notte (`cron.job_run_details` intorno a {JRD_ATTESE} righe); `app_log` sotto {APP_LOG_SOGLIA_MB} MB a +7 giorni; a +90 giorni la riga `error` più vecchia fra 80 e 90 giorni. La chiusura la fa la sessione che apre dopo, seguendo la sezione «Per la sessione dopo» del piano `docs/superpowers/plans/2026-10-20-robustezza2-s08-cron-e-igiene.md`: fotografie delle migrazioni, degli indici unici e della RLS rigenerate, voce di `MIGRAZIONI_ATTESE_AL_MERGE` tolta (quella di `SENZA_ARBITRO_ATTESO` resta: è permanente), riga di stato e questa voce a «in produzione»; `cron-storico-purge` in `JOB_CRON` solo dopo il primo battito e col sì del titolare.

```

- [ ] **Passo 2: la tabella di stato della specifica**

```bash
grep -n "^| 8 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola (il 20/10 era la 32). La riga si trova così, **mai** con `sed -n` su un numero. Sostituiscila (testo del 20/10; se la colonna «Note» ha già altro, per esempio una decisione del titolare, tienilo e aggiungi dopo):

```markdown
| 8 | Correggere i cron e l'igiene del database | S1 (comportamento), D11 (igiene), D12, S12 (`app_log`) | 6, 7 | da fare | — | `s08-cron-e-igiene` | T7 |
```

con:

```markdown
| 8 | Correggere i cron e l'igiene del database | S1 (comportamento), D11 (igiene), D12, S12 (`app_log`) | 6, 7 | in revisione | — | `docs/superpowers/plans/2026-10-20-robustezza2-s08-cron-e-igiene.md` | T7; prima: {TIMEOUT_GIORNO} timeout/giorno, {STORICI_CHIAMATE_GIORNO} chiamate storici/giorno, {JRD_RIGHE} righe in job_run_details, app_log {APP_LOG_PRIMA_MB} MB ({ISCRIZIONI_ALLE} UTC) |
```

Il numero della PR (colonna «PR», oggi `—`) si scrive al Compito 11, Passo 3. «In produzione» per questa riga **non** si scrive mai in questa PR: lo scrive la sessione che apre dopo.

- [ ] **Passo 3: nessuna parentesi graffa rimasta, nessun dato personale**

```bash
head -30 "PRD REGISTRO ELETTRONICO.md" | grep -n "{[A-Z][A-Z0-9_]*}\|{data UTC\|{version"
grep -n "^| 8 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n "{[A-Z][A-Z0-9_]*}"
```

Atteso: nessuna riga. Nel PRD ci sono solo numeri, dimensioni, nomi di job, di tabelle e di file.

- [ ] **Passo 4: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
PRD e tabella di stato: sessione 8, cron e igiene del database

Changelog con la misura «prima» (domande d'iscrizione contate, timeout al giorno,
chiamate a storici, righe di job_run_details, idle in transaction, app_log e crescita
stimata con T7), riga 8 della specifica «in revisione».

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 11 — Gate, PR, CI, merge del titolare, verifica

**File:** nessuno nuovo. Dopo il merge non si apre nessun ramo di soli documenti: le letture dei Passi 6-10 si fanno in sola lettura e si annotano in `${TMPDIR:-/tmp}/s08-misure.env`; i numeri «dopo», «in produzione» e il commit di `main` li scrive nella specifica e nel PRD la sessione che apre dopo, con il suo primo commit, seguendo la sezione «Per la sessione dopo» in fondo a questo piano (che ripete le `SELECT` e dice da quando ciascuna è matura).

- [ ] **Passo 1: il gate intero**

```bash
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
CI=1 npx vitest run 2>&1 | tail -8
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
```

Atteso: ESLint senza righe d'errore; `tsc` senza output; `Test Files … passed` senza `failed`; la build termina con l'elenco delle route. Leggi i riepiloghi, non il codice d'uscita di una pipe. **Mai** `npm run e2e` in locale: l'E2E gira in CI.

- [ ] **Passo 2: mostra le migrazioni prima di proporle**

```bash
git diff origin/main --stat | tail -40
wc -l supabase/migrations/*_cron_timeout_uguale_max_duration.sql supabase/migrations/*_storici_tick_solo_con_lavoro.sql supabase/migrations/*_igiene_cron_log_ruoli.sql supabase/migrations/*_promemoria_e_sync_senza_doppioni.sql
```

Le quattro migrazioni si applicano in produzione al merge, senza nessuno davanti: nel corpo della PR vanno **mostrate** (le sezioni COSA CAMBIA, COME SI VERIFICA e ROLLBACK delle quattro intestazioni). Mostrare non è chiedere.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s08-cron-e-igiene
gh pr create --base main --head robustezza2/s08-cron-e-igiene \
  --title "Robustezza 2, sessione 8: cron senza timeout finti, storici solo con lavoro, igiene del database" \
  --body "$(cat <<'EOF'
## Cosa cambia
- Nella chiamata a `cron_http_post` delle funzioni del cron, l'argomento nominato `timeout_milliseconds` diventa il `maxDuration` della route (300000 ms): valore cambiato dove c'era, argomento aggiunto dove valeva il predefinito di 5000. Niente più `esito = 'timeout'` finti in `cron_chiamate` (S1). Lock `cron-max-duration` esteso al lato SQL con la tabella funzione → job → route; la chiamata la leggono e la riscrivono le stesse funzioni di `scripts/cron-esiti/timeout.mjs`.
- `storici_tick` chiama `/api/admin/storici/cron` solo se la coda delle stampe ha lavoro, e solo allora legge URL e segreto dal Vault; le eccezioni scrivono in `app_log`.
- `app_log` tiene le righe `error` 90 giorni (T7); il job `cron-storico-purge` tiene 14 giorni di `cron.job_run_details`; `idle_in_transaction_session_timeout = 60s` su `service_role`, `authenticated`, `anon`, con una riga `error` in `app_log` se non si può.
- Promemoria: chiave di deduplica con indice unico e `ON CONFLICT DO NOTHING`. Sync SDI: un giro alla volta con una presa con scadenza (D12).
- Informativa a una versione nuova («log tecnici»: errori 90 giorni), da rileggere da parte del titolare.

## Migrazioni (le applica l'integrazione al merge)
- `*_cron_timeout_uguale_max_duration.sql` — CREATE OR REPLACE delle funzioni del cron dai corpi di produzione; cambia solo `timeout_milliseconds` nella chiamata a `cron_http_post` (il numero, o l'argomento aggiunto in fondo).
- `*_storici_tick_solo_con_lavoro.sql` — CREATE OR REPLACE di `storici_tick`.
- `*_igiene_cron_log_ruoli.sql` — `app_log_purge`, `cron_storico_purge` + job `cron-storico-purge`, `ALTER ROLE … SET idle_in_transaction_session_timeout` sui tre ruoli dell'API (guardia: se non si può, riga `error` e la migrazione prosegue).
- `*_promemoria_e_sync_senza_doppioni.sql` — colonna `notifiche.chiave_dedup` con indice unico non parziale; tabella `cron_prese` con due RPC solo per `service_role`.
- Rollback nell'intestazione di ciascuna; si applica solo dentro una PR di revert.

## Misura «prima»
Nel changelog del PRD: domande d'iscrizione contate, timeout al giorno, chiamate a storici, righe di `job_run_details`, `idle in transaction`, `app_log` e crescita stimata.

## Merge
A mano, dal titolare, dopo la CI verde su tutti i job.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Atteso: l'URL della PR. Trova la riga con `grep -n "^| 8 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, sostituisci in quella riga `| in revisione | — |` con `| in revisione | #<numero> |`, fai un commit sul ramo (`Tabella di stato: sessione 8 in revisione, PR #<numero>`) e ripeti il push. Lo Stato resta «in revisione».

- [ ] **Passo 4: la CI, tutti i job**

```bash
gh pr checks --watch 2>&1 | tail -20
```

Atteso: ogni job `pass`. Un E2E `cancelled` non è rosso: si rilancia (`gh run rerun <id> --failed`), una PR alla volta. La CI non applica le migrazioni al suo database: l'E2E gira con il codice nuovo sullo schema di prima, cioè proprio sui ripieghi (`chiave-dedup-assente`, `presa-senza-rpc`).

- [ ] **Passo 5: il merge è del titolare**

Non si usa l'auto-merge. Si scrive al titolare che la PR è verde e pronta, con il riepilogo delle quattro migrazioni, e si aspetta che la mergi lui.

- [ ] **Passo 6: dopo il merge e il deploy, le `SELECT` di conferma (sola lettura)**

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE name IN ('cron_timeout_uguale_max_duration', 'storici_tick_solo_con_lavoro',
                'igiene_cron_log_ruoli', 'promemoria_e_sync_senza_doppioni')
 ORDER BY version;

SELECT p.proname,
       substring(p.prosrc from 'cron_http_post\s*\(\s*''([a-z0-9-]+)''') AS job,
       p.prosrc ~ 'timeout_milliseconds\s*(:=|=>)' AS nominato,
       coalesce(substring(p.prosrc from 'timeout_milliseconds\s*(?::=|=>)\s*(\d+)')::int, 5000) AS timeout_ms
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc ~ 'cron_http_post\s*\('
   AND p.proname NOT IN ('cron_http_post', 'cron_esiti')
 ORDER BY 1;

SELECT p.prosrc ~ 'storici_generazioni' AS storici_filtrata FROM pg_proc p WHERE p.proname = 'storici_tick';
SELECT p.prosrc ~ '90 days' AS purge_t7 FROM pg_proc p WHERE p.proname = 'app_log_purge';
SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('app-log-purge', 'cron-storico-purge') ORDER BY 1;
SELECT rolname, rolconfig FROM pg_roles
 WHERE rolname IN ('service_role', 'authenticated', 'anon', 'authenticator', 'postgres', 'backup_lettura') ORDER BY 1;
SELECT fingerprint, livello, contesto->'campi' AS campi FROM public.app_log
 WHERE fingerprint LIKE 'migrazione:idle-timeout-non-applicato:%';
SELECT indexdef FROM pg_indexes WHERE indexname = 'notifiche_chiave_dedup_key';
SELECT job, presa_scade_il IS NULL AS libera FROM public.cron_prese;
SELECT has_function_privilege('authenticated', 'public.cron_presa_prendi(text, integer)', 'EXECUTE') AS authenticated_esegue;
```

Atteso: quattro migrazioni con la version dei file; tutte le funzioni con `nominato = true` e `timeout_ms = 300000`, e ciascuna col `job` della sua voce in `CHIAMANTI_CRON`; `storici_filtrata = true`; `purge_t7 = true`; due job attivi; `rolconfig` dei tre ruoli con `idle_in_transaction_session_timeout=60s`, `postgres` e `backup_lettura` come al Passo 9 del Compito 2 (`${TMPDIR:-/tmp}/s08-ruoli-prima.txt`); nessuna riga `migrazione:idle-timeout-non-applicato:*` (se ce n'è, l'`ALTER ROLE` non è passato: il resto della migrazione sì, e la decisione va al titolare); l'indice `CREATE UNIQUE INDEX … (chiave_dedup)` senza `WHERE`; `fattura-sync` libera; `authenticated_esegue = false`. Se una migrazione manca o ha un'altra version, **fermati** e leggi `schema_migrations` prima di toccare qualunque cosa.

La prova dei 60 s è `pg_roles.rolconfig`, qui sopra, come dice la specifica (§7, Sessione 8, «Prova»): i tre ruoli sono `NOLOGIN` e un `SET ROLE` non applica le impostazioni del ruolo (valgono all'accesso, o dentro le transazioni di PostgREST), quindi un `show idle_in_transaction_session_timeout` non prova niente e **non** si usa.

- [ ] **Passo 7: dopo un'ora, `/api/health` non dà `storici-stampe` per morto**

Da qui in poi `storici_tick` chiama il server solo quando c'è lavoro: con la coda vuota, in `cron_ultimo_esito` l'ultima chiamata HTTP di `storici-stampe` può avere ore. La sessione 7 ha scritto la regola di `vivo_il` del controllo `cron-esiti` proprio per questo caso (`storici_tick` chiama il server solo quando c'è lavoro). Si verifica con **una** richiesta, almeno un'ora dopo il deploy:

```bash
date -u '+%F %T'
curl -s -o "${TMPDIR:-/tmp}/s08-salute-dopo.json" -w '%{http_code}\n' https://app.kidville.it/api/health
jq -r '.controlli[] | select(.nome == "cron-esiti") | "\(.esito) \(.dettaglio // "")"' "${TMPDIR:-/tmp}/s08-salute-dopo.json"
jq -r '.controlli[] | select(.nome == "cron-esiti") | .dettaglio // ""' "${TMPDIR:-/tmp}/s08-salute-dopo.json" | grep -c "storici-stampe"
```

Atteso: `200`; `cron-esiti` con un dettaglio che comincia con `N job attivi`; l'ultimo comando stampa `0`, cioè `storici-stampe` non compare fra i job «senza un esito buono entro la finestra». Scrivi `SALUTE_STORICI_DOPO=0` e l'ora UTC nel file delle misure. Se stampa `1`, il controllo della sessione 7 sta dando per morto un job che lavora come deve: **fermati** e scrivilo al titolare con il dettaglio intero. Non si corregge la regola del controllo dentro questa sessione e non si torna indietro sul Compito 4 (il filtro è giusto: è il controllo che non lo conosce); il caso va nella colonna «Note» della riga 8, con un commit sul ramo se la PR è ancora aperta, altrimenti lo scrive la sessione che apre dopo (sezione «Per la sessione dopo»).

- [ ] **Passo 8: la misura «dopo», a +24 ore dal deploy, con data e ora UTC**

```sql
SELECT now() AT TIME ZONE 'UTC' AS misurato_alle;

SELECT date_trunc('day', c.inviata_il) AS giorno,
       count(*) FILTER (WHERE c.esito = 'timeout') AS timeout,
       count(*) FILTER (WHERE c.percorso = '/api/admin/storici/cron') AS chiamate_storici,
       count(*) AS chiamate
  FROM public.cron_chiamate c
 WHERE c.inviata_il > now() - interval '48 hours'
 GROUP BY 1 ORDER BY 1;

SELECT c.job, min(c.timeout_ms) AS timeout_min, max(c.timeout_ms) AS timeout_max
  FROM public.cron_chiamate c
 WHERE c.inviata_il > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1;

SELECT c.job, count(*) AS n,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM r.created - c.inviata_il)) AS p50_s,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.created - c.inviata_il)) AS p95_s
  FROM public.cron_chiamate c
  JOIN net._http_response r ON r.id = c.richiesta_id AND r.created >= c.inviata_il - interval '1 minute'
 WHERE c.inviata_il > now() - interval '6 hours'
 GROUP BY 1 ORDER BY 1;

SELECT count(*) FROM enrollment_submissions;
```

Atteso: `timeout` a **0** nelle ultime 24 ore (da {TIMEOUT_GIORNO}); `chiamate_storici` da {STORICI_CHIAMATE_GIORNO} a qualche decina (dell'ordine delle stampe richieste); `timeout_min` e `timeout_max` a 300000 per ogni job (è il timeout che l'involucro ha davvero registrato, non quello letto nel corpo); la latenza p95 di ogni job vicina a quella di `${TMPDIR:-/tmp}/s08-latenze-prima.txt`. **Soglia di ritorno indietro:** un job veloce (dispatch delle notifiche, news, coda delle fatture) con p95 oltre 30 s che prima non c'era vuol dire che le richieste lunghe ritardano le altre nel lotto di pg_net: si apre la PR di revert del solo Compito 3 (Ritorno indietro) e si scrive nella tabella di stato. Un timeout rimasto vuol dire una route che dura oltre 300 s: è un guasto vero di quella route, da nominare nel PRD.

- [ ] **Passo 9: dopo la prima notte (03:30 e 03:41 UTC)**

```sql
SELECT count(*) AS righe, pg_size_pretty(pg_total_relation_size('cron.job_run_details')) AS dimensione,
       min(start_time) AS la_piu_vecchia
  FROM cron.job_run_details;
SELECT fingerprint, livello, occorrenze, contesto->'campi' AS campi, visto_l_ultima
  FROM public.app_log
 WHERE fingerprint IN ('cron:app-log-purge', 'cron:cron-storico-purge', 'cron:cron-storico-purge:tabelle-assenti')
    OR fingerprint LIKE 'cron:storici-stampe:%'
 ORDER BY visto_l_ultima DESC;
SELECT count(*) FILTER (WHERE chiave_dedup IS NOT NULL) AS con_chiave FROM public.notifiche;
```

Atteso: `cron.job_run_details` intorno a {JRD_ATTESE} righe (± 15 %) e la più vecchia a 14 giorni, salvo i job senza ultimo esito elencati nel PRD; i due battiti `ok` di oggi; nessuna riga `cron:storici-stampe:*`; `con_chiave` > 0 dopo il primo giro dei promemoria (06:00 UTC).

- [ ] **Passo 10: `app_log`, a +7 giorni e a +90 giorni**

```sql
SELECT pg_total_relation_size('public.app_log') / 1048576.0 AS mb,
       count(*) FILTER (WHERE livello = 'error') AS errori,
       now() - min(creato_il) FILTER (WHERE livello = 'error') AS errore_piu_vecchio
  FROM public.app_log;
```

Atteso a +7 giorni: `mb` sotto `APP_LOG_SOGLIA_MB` ({APP_LOG_SOGLIA_MB}); a +90 giorni: l'errore più vecchio fra 80 e 90 giorni. Nessuna delle due si scrive in un ramo apposta: le date da cui maturano stanno nella sezione «Per la sessione dopo», e le scrive la prima PR che tocca la specifica dopo quei giorni. **Soglia di ritorno indietro:** `mb` oltre {APP_LOG_SOGLIA_MB} ⇒ si torna a 30 giorni con la PR di revert della sola purge, e lo si dice al titolare.

- [ ] **Passo 11: pulizia del ramo e del worktree di questa sessione (AGENTS.md, punto 3)**

Dopo il rilascio riuscito:

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s08-cron-e-igiene
git -C /Users/lerri/kidville-web branch -D robustezza2/s08-cron-e-igiene
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s08-cron-e-igiene
rm -f "${TMPDIR:-/tmp}"/s08-genera-timeout.mjs "${TMPDIR:-/tmp}"/s08-timeout.sql
```

I file `s08-misure.env`, `s08-timeout-prima.json` e `s08-chiamanti.json` restano finché la sessione che apre dopo non ha scritto i numeri «dopo»; i rami di altre sessioni con una PR aperta non si toccano. Nessun ramo di soli documenti dopo il rilascio: la sessione che apre dopo chiude questa con la sezione «Per la sessione dopo», nel suo primo commit.

---

## Ritorno indietro

**Codice.** Instant Rollback di Vercel al deploy di prima (lo fa il titolare dal pannello), poi una PR di revert del commit di merge. Tornando indietro col solo codice: i promemoria tornano all'insert senza chiave (la colonna resta, vuota); la sincronizzazione torna senza presa; nessun dato si perde.

**Database.** Mai a mano. Una PR di revert aggiunge **una migrazione nuova** (version con `date -u +%Y%m%d%H%M%S`) costruita così.

1. **Timeout di prima.** Rileggi in produzione i corpi attuali con la query del Passo 4 del Compito 2 e salvali in `${TMPDIR:-/tmp}/s08-revert-chiamanti.json`; ricrea `${TMPDIR:-/tmp}/s08-timeout-prima.json` dalla riga «Timeout di prima» del changelog del PRD (se il file non c'è più); poi, con lo script del Passo 4 del Compito 3 (ricrealo dal piano se è stato cancellato). Va eseguito **prima** del `git revert`, sull'albero che ha ancora `scripts/cron-esiti/timeout.mjs` e la tabella `CHIAMANTI_CRON` del lock: il revert li toglie entrambi.

```bash
test -f scripts/cron-esiti/timeout.mjs && grep -c "^const CHIAMANTI_CRON" __tests__/architecture/cron-max-duration.test.ts
node "${TMPDIR:-/tmp}/s08-genera-timeout.mjs" "${TMPDIR:-/tmp}/s08-revert-chiamanti.json" . "${TMPDIR:-/tmp}/s08-timeout-prima.json" > "${TMPDIR:-/tmp}/s08-revert-timeout.sql"
```

Atteso: `1` dalla prima riga, e lo stesso standard error del Passo 4 del Compito 3. Le funzioni che prima della sessione 8 non avevano `timeout_milliseconds` (valeva il predefinito) tornano con `timeout_milliseconds := 5000` scritto: stesso comportamento, un argomento in più nel testo. `iscrizioni_retention_http` torna a 120000.

2. **`storici_tick` della sessione 6**, dal suo file (`S06_FILE` nel file delle misure, o `ls supabase/migrations/*_cron_esiti_osservati.sql`, senza la cartella):

```bash
node -e '
const t = require("fs").readFileSync(process.argv[1], "utf8")
const i = t.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.storici_tick\s*\(/i)
if (i < 0) throw new Error("storici_tick non trovata")
const a = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(t.slice(i))
const f = t.indexOf(a[1], i + a.index + a[0].length)
process.stdout.write(t.slice(i, f + a[1].length) + ";\nREVOKE ALL ON FUNCTION public.storici_tick() FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.storici_tick() TO service_role;\n")
' "supabase/migrations/$S06_FILE" > "${TMPDIR:-/tmp}/s08-revert-storici.sql"
```

3. **Ruoli, job, purge**, scritti così:

```sql
-- REVERT della sessione 8 della seconda serie (solo dentro una PR di revert).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    BEGIN
      EXECUTE format('ALTER ROLE %I RESET idle_in_transaction_session_timeout', r);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'revert: % non ripristinato [%]', r, SQLSTATE;
    END;
  END LOOP;
END $$;
NOTIFY pgrst, 'reload config';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-storico-purge';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'revert: cron-storico-purge non tolto [%]', SQLSTATE;
END $$;

CREATE OR REPLACE FUNCTION public.app_log_purge()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lotto  int;
  v_totale int := 0;
BEGIN
  LOOP
    DELETE FROM public.app_log
     WHERE id IN (
       SELECT id FROM public.app_log
        WHERE creato_il < now() - interval '30 days'
        LIMIT 10000
     );
    GET DIAGNOSTICS v_lotto = ROW_COUNT;
    v_totale := v_totale + v_lotto;
    EXIT WHEN v_lotto = 0;
  END LOOP;
  RETURN v_totale;
END $$;
REVOKE ALL ON FUNCTION public.app_log_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_log_purge() TO service_role;
```

La migrazione di revert è la concatenazione di `s08-revert-timeout.sql`, `s08-revert-storici.sql` e di questo blocco. Va provata su PGlite con lo schema dei test dei Compiti 4 e 5 (dopo il revert: rolconfig dei tre ruoli vuoto, la purge toglie l'errore di 31 giorni, `storici_tick` chiama a coda vuota) prima di aprire la PR. Il lock `cron-max-duration` diventerà rosso sul timeout: nella stessa PR di revert si torna alla sua versione di prima (`git revert` del commit del Compito 3 lo fa da sé, e toglie anche `scripts/cron-esiti/timeout.mjs`). Se nel frattempo la sessione 9 ha già allargato il lock (Compito 11 del suo piano: `ROUTE_LUNGHE`, `durataDichiarata`, `fuoriMisura`, `existsSync` alla riga 2), il revert può andare in conflitto su quel file: si tolgono a mano **solo** i due `import` dopo la riga 3 e il blocco `CHIAMANTI_CRON` … `violazioneSql` con il suo `describe`, e tutto ciò che ha aggiunto la sessione 9 resta.

**Revert parziali.** La soglia sulla latenza (Rilascio, Passo 8) torna indietro dal solo punto 1; quella su `app_log` (Passo 10) dal solo `app_log_purge`. Si scrive nella tabella di stato quale parte è tornata indietro e perché.

**Cosa resta, e perché va bene.** `notifiche.chiave_dedup` con il suo indice, `cron_prese` e le due RPC, `cron_storico_purge` (senza job) restano: senza il codice nuovo nessuno li usa. Toglierli è una scelta del titolare e richiede la riga `-- distruttiva approvata:`. Le righe di `cron.job_run_details` già tolte non tornano: erano lo storico operativo dei giri, e l'ultimo esito di ogni job sta in `cron_ultimo_esito`. Gli errori di `app_log` fra 30 e 90 giorni li toglie la purge di prima alla prima notte dopo il revert. **Informativa:** la versione nuova resta finché il revert non dura oltre 90 giorni; dopo, una versione successiva torna a dire 30 giorni per tutto.

---

## Per la sessione dopo

La esegue, nel suo **primo commit**, la sessione `robustezza2/` che apre dopo il rilascio della 8, qualunque numero abbia (§5, «la chiusura della precedente»). Chi la esegue non ha letto questo piano: qui c'è tutto quello che serve. Ogni lettura sul database è in **sola lettura** (strumento MCP `execute_sql`, solo `SELECT`); le risposte JSON vanno in `${TMPDIR:-/tmp}`, mai nel repository. Si lavora nel worktree della sessione che apre.

**0. Numero della PR, commit di `main`, giorno zero.**

```bash
N8=$(gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s08-" --json number,headRefName --jq '[.[] | select(.headRefName | endswith("-esito") | not)][0].number')
echo "#$N8 $(gh pr view "$N8" --repo erricoluigi17/kidville-web --json mergeCommit,mergedAt --jq '"\(.mergeCommit.oid[0:8]) \(.mergedAt)"')"
ls supabase/migrations/ | grep -E '_(cron_timeout_uguale_max_duration|storici_tick_solo_con_lavoro|igiene_cron_log_ruoli|promemoria_e_sync_senza_doppioni)\.sql$'
```

Atteso: `#<numero> <otto caratteri del commit> <data e ora del merge>` e i quattro file della sessione 8. La data del merge è il **giorno zero** delle maturazioni qui sotto.

**1. Fotografie da rigenerare dalla produzione, in quest'ordine, prima di togliere qualunque voce.** La sessione 8 ha quattro migrazioni. Tre (`*_cron_timeout_uguale_max_duration.sql`, `*_storici_tick_solo_con_lavoro.sql`, `*_igiene_cron_log_ruoli.sql`) ridefiniscono funzioni, un job e le impostazioni di tre ruoli; la quarta, `*_promemoria_e_sync_senza_doppioni.sql`, aggiunge l'indice unico `notifiche_chiave_dedup_key` e la tabella `cron_prese` (chiave primaria `cron_prese_pkey`, RLS accesa, nessuna policy). Cambiano quindi tre fotografie; le chiavi esterne (`fk-utenti-fotografia.mjs`, `fk-sede-fotografia.mjs`), le tabelle per sede (`cron_prese` non ha `scuola_id`), i bucket e lo schema delle candidature **non** cambiano e non si rigenerano per la 8.

a. Migrazioni:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query stampata con `execute_sql`, salva la risposta così com'è in `${TMPDIR:-/tmp}/chiusura-s08-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/chiusura-s08-migrazioni.json"
grep -cE '"name": "(cron_timeout_uguale_max_duration|storici_tick_solo_con_lavoro|igiene_cron_log_ruoli|promemoria_e_sync_senza_doppioni)"' __tests__/fixtures/migrazioni-applicate-snapshot.json
```

Atteso: `4`. Se è meno, una migrazione della 8 non è applicata: **fermati** e leggi `supabase_migrations.schema_migrations` prima di toccare altro.

b. Indici unici:

```bash
node __tests__/fixtures/indici-unici-fotografia.mjs --sql
```

Esegui la query stampata con `execute_sql`, salva la risposta in `${TMPDIR:-/tmp}/chiusura-s08-indici.json`, poi:

```bash
node __tests__/fixtures/indici-unici-fotografia.mjs < "${TMPDIR:-/tmp}/chiusura-s08-indici.json"
grep -cE '"indice": "(notifiche_chiave_dedup_key|cron_prese_pkey)"' __tests__/fixtures/indici-unici-snapshot.json
```

Atteso: `2`.

c. Policy e RLS:

```bash
node scripts/rls-fotografia.mjs --sql
```

Esegui la query stampata con `execute_sql`, salva la risposta in `${TMPDIR:-/tmp}/chiusura-s08-rls.json`, poi:

```bash
node scripts/rls-fotografia.mjs < "${TMPDIR:-/tmp}/chiusura-s08-rls.json"
grep -c '"cron_prese"' __tests__/fixtures/pg-policies-snapshot.json
```

Atteso: `1` (`cron_prese` in `tabelle_rls_attiva`; nessuna policy nuova, perché la tabella si legge solo da `service_role`).

**2. Voci da togliere, e una che resta.**
- In `__tests__/architecture/soglia-fotografia.ts`, costante `MIGRAZIONI_ATTESE_AL_MERGE`: togli la voce con chiave `'<version>_promemoria_e_sync_senza_doppioni.sql'` (la version è quella del file stampato al punto 0) e, se c'è, la voce `'<version>_cron_timeout_uguale_max_duration.sql'` (il Compito 3 la aggiunge solo se un corpo di funzione preso dalla produzione conteneva una parola delle guardie). Se non restano altre voci, l'oggetto torna `{}`. Sotto il blocco di commento che comincia con `· SESSIONE 8 della seconda serie «cron e igiene»` aggiungi la riga `// SVUOTATA il <data UTC> (PR-B dopo il merge di #<N8>, <commit>): applicata dall'integrazione; fotografie delle migrazioni, degli indici unici e della RLS rigenerate dalla produzione.` Solo **dopo** i punti 1a, 1b e 1c: tolta prima, le guardie `toccaUnUnico` e `toccaLaRls` vedono la migrazione posteriore alle fotografie vecchie.
- In `__tests__/architecture/onconflict-arbitro.test.ts`, la voce `{ tabella: 'notifiche', chiave: 'chiave_dedup', … }` di `SENZA_ARBITRO_ATTESO` **resta**: è permanente. L'indice è unico e non parziale su una colonna nullable, senza `NULLS NOT DISTINCT` per scelta, e la funzione `arbitra` del lock non lo riconoscerà mai come arbitro; tolta la voce, la prova «nessuna chiave si appoggia a un indice che tratta i NULL come distinti» diventa rossa. Dopo il punto 1b la prova «le eccezioni dichiarate sono ancora eccezioni» deve restare verde: se è rossa, l'indice in produzione non è quello della migrazione (è diventato `NULLS NOT DISTINCT`, o la colonna `NOT NULL`): **fermati**.
- Verifica:

```bash
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  5 passed`.

**3. Riga di stato.** `grep -n "^| 8 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (una riga). In quella riga: Stato da `in revisione` a `in produzione`; la colonna «PR» tiene `#<N8>`; nella colonna «Note», dopo quello che c'è, aggiungi: punto e virgola, «in produzione dal» con la data del merge e, fra parentesi, il commit di `main`; poi «dopo», con data e ora UTC della lettura fra parentesi, e i numeri maturi del punto 4 (per esempio: `; in produzione dal 2026-11-05 (1a2b3c4d); dopo (2026-11-06 09:10 UTC): 0 timeout/giorno, 37 chiamate storici/giorno`, con i valori veri).

**4. Misure «dopo», in sola lettura, e da quando sono mature.** Si scrivono solo quelle mature il giorno della chiusura; le altre restano qui con la loro data, e le scrive la prima PR che tocca la specifica dopo quel giorno (§5). I numeri «prima» per il confronto stanno nella voce della sessione 8 del PRD (punto 5).

| Misura | Matura dal | Atteso |
|---|---|---|
| `rolconfig` dei tre ruoli | giorno zero | `idle_in_transaction_session_timeout=60s` su `service_role`, `authenticated`, `anon` |
| `/api/health`, una richiesta | giorno zero + 1 h | `storici-stampe` assente dall'elenco «senza un esito buono entro la finestra» del controllo `cron-esiti` |
| timeout di pg_net e chiamate a storici al giorno, latenza per job | giorno zero + 24 h (un giorno intero dopo il deploy) | timeout 0 (prima: ~108 al giorno); chiamate a `/api/admin/storici/cron` dell'ordine delle stampe richieste (prima: ~1.440); p95 dei job veloci sotto 30 s |
| `cron.job_run_details` | dopo le 03:41 UTC del giorno dopo il giorno zero | righe intorno a 14 volte quelle di un giorno (±15 %), la più vecchia a 14 giorni salvo i job trattenuti elencati nel PRD |
| `notifiche` con chiave | dopo le 06:00 UTC del giorno dopo il giorno zero | `con_chiave` > 0 |
| peso di `app_log` | giorno zero + 7 giorni | sotto la soglia `APP_LOG_SOGLIA_MB` scritta nel PRD della sessione 8 |
| errore più vecchio di `app_log` | giorno zero + 90 giorni | fra 80 e 90 giorni |

```sql
SELECT now() AT TIME ZONE 'UTC' AS misurato_alle;

SELECT rolname, rolconfig FROM pg_roles
 WHERE rolname IN ('service_role', 'authenticated', 'anon') ORDER BY 1;

SELECT date_trunc('day', c.inviata_il) AS giorno,
       count(*) FILTER (WHERE c.esito = 'timeout') AS timeout,
       count(*) FILTER (WHERE c.percorso = '/api/admin/storici/cron') AS chiamate_storici,
       count(*) AS chiamate
  FROM public.cron_chiamate c
 WHERE c.inviata_il > now() - interval '7 days'
 GROUP BY 1 ORDER BY 1;

SELECT c.job, count(*) AS n,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.created - c.inviata_il)) AS p95_s
  FROM public.cron_chiamate c
  JOIN net._http_response r ON r.id = c.richiesta_id AND r.created >= c.inviata_il - interval '1 minute'
 WHERE c.inviata_il > now() - interval '6 hours'
 GROUP BY 1 ORDER BY 1;

SELECT count(*) AS righe,
       pg_size_pretty(pg_total_relation_size('cron.job_run_details')) AS dimensione,
       min(start_time) AS la_piu_vecchia,
       count(*) FILTER (WHERE start_time > now() - interval '24 hours') AS ultime_24h
  FROM cron.job_run_details;

SELECT count(*) FILTER (WHERE chiave_dedup IS NOT NULL) AS con_chiave FROM public.notifiche;

SELECT round(pg_total_relation_size('public.app_log') / 1048576.0, 1) AS mb,
       count(*) FILTER (WHERE livello = 'error') AS errori,
       now() - min(creato_il) FILTER (WHERE livello = 'error') AS errore_piu_vecchio
  FROM public.app_log;
```

Per `/api/health`, una sola richiesta:

```bash
curl -s -o "${TMPDIR:-/tmp}/chiusura-s08-salute.json" -w '%{http_code}\n' https://app.kidville.it/api/health
jq -r '.controlli[] | select(.nome == "cron-esiti") | .dettaglio // ""' "${TMPDIR:-/tmp}/chiusura-s08-salute.json" | grep -c "storici-stampe"
```

Atteso: `200` e `0`. Un numero che non torna non si corregge: si scrive com'è, con «osservato» e «causa probabile» separati, e lo si dice al titolare. Una soglia di ritorno indietro superata (p95 di un job veloce oltre 30 s; `app_log` oltre `APP_LOG_SOGLIA_MB`) apre la PR di revert della parte che la riguarda, come dice la parte «Ritorno indietro» del piano della sessione 8.

**5. PRD.** `grep -n "Robustezza, seconda serie, sessione 8" "PRD REGISTRO ELETTRONICO.md"` trova la voce. Sostituisci la sua riga che comincia con `**Stato:** 🟡 in revisione.` con:

```markdown
**Stato:** ✅ in produzione dal <data del merge> (PR #<N8>, commit <commit>): le quattro migrazioni applicate dall'integrazione, una riga ciascuna con la version del file.
```

e aggiungi subito sotto:

```markdown
**Misura «dopo»** (<data e ora UTC>, sola lettura): <i numeri maturi del punto 4>; maturano più tardi: <quelli che mancano, ciascuno con la sua data>.
```

Al posto dei segni `<…>` vanno i valori letti. Controllo (la voce della 8 sta in cima al PRD, sopra le voci più vecchie, alcune delle quali contengono `<data>` di proposito):

```bash
L=$(grep -n "Robustezza, seconda serie, sessione 8" "PRD REGISTRO ELETTRONICO.md" | head -1 | cut -d: -f1)
sed -n "${L},$((L + 15))p" "PRD REGISTRO ELETTRONICO.md" | grep -c "<data\|<N8>\|<commit>\|<i numeri\|<quelli"
grep "^| 8 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -c "<"
```

Atteso: `0` e `0`.

**6. Solo a certe condizioni.**
- `cron-storico-purge` (e `app-log-purge`, se è ancora in `JOB_CRON_NON_SORVEGLIATI`) da `JOB_CRON_NON_SORVEGLIATI` a `JOB_CRON` in `src/lib/health/controlli.ts`, come `{ nome: 'cron-storico-purge', finestraMs: 26 * ORA },` (e lo stesso per `app-log-purge`), **solo** dopo il loro primo battito `ok` e **solo col sì del titolare**. Il battito si legge così:

```sql
SELECT fingerprint, livello, occorrenze, visto_l_ultima, contesto->'campi' AS campi
  FROM public.app_log
 WHERE fingerprint IN ('cron:cron-storico-purge', 'cron:app-log-purge');
```

  Atteso: due righe `info` con `esito` `ok` nei campi, `visto_l_ultima` nelle ultime 26 ore. Senza battito o senza il sì, le due voci restano dove sono e il PRD lo dice («in attesa del battito» o «in attesa del titolare»). Se si spostano: si tolgono le loro voci da `JOB_CRON_NON_SORVEGLIATI`, si aggiungono a `JOB_CRON`, si lanciano `npx vitest run __tests__/architecture/cron-sorvegliato-e-applicato.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts __tests__/api/health.test.ts` (atteso: tutti verdi) e `src/lib/health/controlli.ts` entra nel commit di chiusura.
- Se il Rilascio della 8 (Passo 7) ha trovato `storici-stampe` fra i job «senza un esito buono» di `cron-esiti`, e la colonna «Note» della riga 8 non lo dice già, lo si scrive lì, con la data; la correzione della regola del controllo è una decisione del titolare, non della chiusura.
- Se una parte della 8 è tornata indietro con una PR di revert, la riga 8 dice quale e perché, e le misure di quella parte non si scrivono.

---

## Autorevisione

| Specifica (§7, Sessione 8, e T7) | Compito |
|---|---|
| Misura prima: timeout al giorno in `cron_chiamate` (`esito = 'timeout'`, ~108) | 2 (Passo 5) |
| Misura prima: chiamate al giorno a `/api/admin/storici/cron` (~1.440) | 2 (Passo 5) |
| Misura prima: righe di `cron.job_run_details` (93.577 il 20/10) | 2 (Passo 7) |
| Misura prima: durata massima di `idle in transaction` su più letture | 2 (Passo 8) |
| Timeout dell'involucro = `maxDuration` della route, lock `cron-max-duration` | 3 |
| `storici_tick` non chiama il server senza lavoro; l'`exception` scrive in `app_log` | 4 |
| Un job tiene 14 giorni di `cron.job_run_details` (con `cron_ultimo_esito.ultimo_runid` a coprire i mensili) | 5, e 2 (Passo 7) |
| `ALTER ROLE service_role, authenticated, anon SET idle_in_transaction_session_timeout = '60s'`; non `ALTER DATABASE`, non `postgres`, non il backup | 5 (test statico e guardia), 2 (Passo 9) |
| Promemoria: indice unico e `on conflict do nothing` | 6, 7 |
| Sync delle fatture: presa con scadenza sul modello di `20261010230945` | 6, 8 |
| T7: `app_log_purge` tiene gli `error` 90 giorni, gli altri come oggi; corpo dalla produzione | 2 (Passo 4), 5 |
| Rischio: i 60 s interrompono una transazione legittima | 2 (Passo 8, soglia sulle sessioni di `authenticator`) |
| Rischio: timeout lunghi tengono aperte più richieste pg_net | 2 (Passo 6), 11 (Passo 8, soglia), Ritorno indietro (revert parziale) |
| Rischio: `app_log` cresce (misurarla prima e dopo) | 2 (Passo 10), 11 (Passo 10) |
| Indietro: timeout a 5000, `ALTER ROLE … RESET`, job nuovi tolti, purge come prima | Ritorno indietro |
| Prova: timeout a 0, storici a qualche decina, `job_run_details` stabile, i 60 s, la riga `error` più vecchia fra 80 e 90 giorni | 11 (Passi 6-10) |
| §5: prerequisiti verificati sui fatti (PR mergiate di 6 e 7, version in `schema_migrations`, nessuna PR della serie aperta) | 1 (Passo 1) |
| §5: chiusura della sessione rilasciata per ultima, qualunque numero abbia, dal suo «Per la sessione dopo» | 1 (Passi 4 e 6) |
| §5: «Codice che regge il momento del merge» (`info` sui ripieghi, `RPC_ASSENTE` locale) | 7, 8, Log |
| §5: worktree da `main`, corpi dalla produzione, ROLLBACK, conteggio di `enrollment_submissions`, gate, merge a mano, pulizia | 1, 2, 3-6, 10, 11 |
| §5 e §6: Stato «in revisione» nella propria PR; «in produzione» e numeri «dopo» dalla sessione che apre dopo | 10 (Passo 2), 11 (Passo 3), Per la sessione dopo |
| §3, 6 → 7 → 8: il filtro di `storici_tick` non fa suonare il controllo `cron-esiti` della 7 | 11 (Passo 7) |
| L'informativa resta vera (non lo dice la specifica: lo impone la voce «log tecnici», 30 giorni) | 9 |

Nomi usati fra i compiti, controllati: suffissi `_cron_timeout_uguale_max_duration.sql`, `_storici_tick_solo_con_lavoro.sql`, `_igiene_cron_log_ruoli.sql`, `_promemoria_e_sync_senza_doppioni.sql` (Compiti 3-6, 10, 11); `CHIAMANTI_CRON` e la sua forma `{ funzione, job, route }` (Compito 3 e lo script); `scripts/cron-esiti/timeout.mjs` con `TIMEOUT_PREDEFINITO_MS`, `chiamataAllInvolucro`, `conTimeout` (lock, script del Passo 4 del Compito 3, Ritorno indietro); dalla sessione 6, `scripts/cron-esiti/involucro.mjs` con `NON_SI_AVVOLGONO`, `ASSENTI_IN_PRODUZIONE`, `corpoDi`, `contaChiamate`, la firma `cron_http_post(text, text, jsonb, jsonb, jsonb, integer)` e le colonne `cron_chiamate.inviata_il`, `timeout_ms`, `percorso`, `esito`, `richiesta_id`, `cron_ultimo_esito.job`, `ultimo_runid` (Compiti 2-5, Rilascio); file di misura `s08-chiamanti.tsv`, `s08-percorsi.tsv`, `s08-chiamanti.json`, `s08-timeout-prima.json` (Compiti 2, 3, Ritorno indietro); `cron_presa_prendi(text, integer)` / `cron_presa_rilascia(text, uuid)` con `p_job`, `p_durata_s`, `p_token` (Compiti 6 e 8); `prendiPresaCron`, `rilasciaPresaCron`, `DURATA_PRESA_CRON_S`, esiti `presa`/`altrui`/`guasto` (Compito 8); `chiaveDedup` e la colonna `chiave_dedup`, indice `notifiche_chiave_dedup_key` (Compiti 6 e 7); impronte `cron:app-log-purge`, `cron:cron-storico-purge`, `cron:cron-storico-purge:tabelle-assenti`, `cron:storici-stampe:chiamata-fallita`, `cron:storici-stampe:conservazione-fallita`, `storici-cron-config-assente`, `migrazione:idle-timeout-non-applicato:<ruolo>` (Compiti 4, 5, Log, Rilascio); marcatori `timeout-ruoli` (Compito 5).

**Scelte del piano, e come stanno con la specifica di oggi.**
- **Codici tollerati oltre quelli della §5.** La §5 dà `42703`, `42P01`, `PGRST205` a chi *legge* una colonna o una tabella nuova, e `PGRST202`, `42883` a chi chiama una RPC nuova. `enqueueNotifiche` invece *scrive* la colonna nuova con un upsert, e lì PostgREST risponde con codici diversi: `PGRST204` (colonna sconosciuta allo schema cache in un INSERT o UPSERT: è il secondo codice di `colonnaNuovaAssente` in `src/lib/db/colonna-assente.ts`, che tiene anche `42703`) e `42P10` (colonna presente ma nessun indice unico che faccia da arbitro: un DB con la colonna e senza l'indice). Sono tollerati **solo** su quella chiamata, **solo** quando le righe portano la chiave, con una riga `info` (`chiave-dedup-assente`) e il ripiego sull'insert di sempre. `42P01`/`PGRST205` non servono: `notifiche` esiste ovunque. La presa (`prendiPresaCron`) regge i due codici della §5, `PGRST202`/`42883`, con l'insieme locale `RPC_ASSENTE`; `src/lib/db/tolleranza-schema.ts` non si allarga.
- **La voce `notifiche`/`chiave_dedup` in `SENZA_ARBITRO_ATTESO` è permanente.** L'indice è unico, non parziale, su una colonna nullable e senza `NULLS NOT DISTINCT` (che bloccherebbe la seconda notifica senza chiave): la funzione `arbitra` del lock non lo riconosce mai come arbitro, e senza la voce la prova «nessuna chiave si appoggia a un indice che tratta i NULL come distinti» diventerebbe rossa alla rigenerazione della fotografia. Il ramo dei duplicati silenziosi non esiste perché l'upsert parte solo con la chiave valorizzata (Compito 7, Passo 6).
- **Timeout di oggi** (§7, Sessione 6): la specifica dice già «ognuna con il timeout che ha oggi» (5000 ms per la maggior parte, 120000 per `iscrizioni_retention_http`, 300000 per `fatture_sdi_sync_tick`, `fatture_coda_tick_http` e `storici_tick`). Il generatore lascia fuori chi è già al valore, e il lock le controlla tutte.
- Due funzioni chiamano la stessa route con corpi diversi (`news_tick` e `news_digest_tick`, `{"job":"tick"}` e `{"job":"digest"}`); `video_runner_kick` è un trigger, non un job (la specifica lo dice), e resta a 5000 ms con `timeoutDecisoMs`. La tabella del lock le tiene come voci separate.
- `app_log_purge` sta alle righe 226-251 di `20260713090000_app_log.sql`, come dice la specifica.
- La prova dei 60 s è `pg_roles.rolconfig` (Rilascio, Passo 6), come dice la specifica: `show` sui ruoli `NOLOGIN` non prova niente.
- Il rapporto (D12) suggeriva `pg_advisory_xact_lock` per la sync: con PostgREST dura una chiamata, non un giro HTTP. La specifica chiede già la presa con scadenza, che è ciò che il piano fa.

---

## Decisioni che restano al titolare

- **Chi tiene davvero le transazioni aperte.** I tre ruoli dell'API sono `NOLOGIN`: i 60 s valgono dentro le transazioni di PostgREST, e non toccano sessioni di `postgres`, `supabase_admin` o del backup. Se il Passo 8 del Compito 2 trova lì le sessioni lunghe, la scelta di un tetto su quei ruoli (la specifica esclude `postgres` e il backup) è del titolare.
- **I 300 s per tutti.** Se la latenza «dopo» mostra che le richieste lunghe ritardano quelle brevi nel lotto di pg_net, l'alternativa è tenere il `maxDuration` solo per le route lente (sync SDI, coda delle fatture, solleciti) e un valore più basso per le altre, cambiando la regola del lock.
- **`video_runner_kick`.** È chiamata da un trigger, non da un job: con 300 s ogni caricamento video terrebbe un posto di pg_net finché il runner lavora. La specifica lascia la scelta al titolare; il piano la tiene a 5000 ms (`timeoutDecisoMs` in `CHIAMANTI_CRON`, che il generatore rispetta). Se il titolare sceglie il `maxDuration`, si toglie il campo da quella riga del lock prima di generare la migrazione.
- **T7 e la crescita di `app_log`.** Oltre 50 MB stimati (Compito 2, Passo 10) il piano si ferma; sotto, procede e misura.
- **Il testo dell'informativa** (Compito 9) è testo legale, in particolare «per riconoscere un guasto che si ripresenta».
- **I doppi già in `notifiche`** ({DOPPI_MODULI} e {DOPPI_DOCUMENTI} nel PRD) restano: toglierli è una cancellazione su una tabella di famiglie, e non serve all'indice.
- **`app-log-purge` e `cron-storico-purge` in `JOB_CRON`.** Dopo il primo battito, nella chiusura fatta dalla sessione che apre dopo e solo col sì del titolare, si possono sorvegliare con `finestraMs: 26 * ORA`; la ragione di `app-log-purge` («Job di sola SQL … qui sarebbe sempre rosso») da quel momento non è più vera.
