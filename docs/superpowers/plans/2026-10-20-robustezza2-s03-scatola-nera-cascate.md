# Sessione 3 — Scatola nera su cascate, anagrafiche e protocollo — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** ogni riga portata via in cascata da `utenti`, `alunni` e `avvisi`, ogni modifica di un'anagrafica e ogni eliminazione o modifica del registro di protocollo resta recuperabile per 90 giorni nella scatola nera, e l'oblio la toglie anche da lì.

**Architettura:**
- **Due migrazioni, nessuno schema nuovo.** La prima (`*_scatola_nera_cascate_anagrafiche.sql`) riusa i due trigger che ci sono già (`scatola_nera.registra()` per le eliminazioni, `scatola_nera.registra_modifica()` per le modifiche) su nove figlie in cascata e cinque anagrafiche, insegna a `registra()` l'interruttore `scatola_nera.senza_storico`, lo fa accendere alle due bonifiche che cancellano copie storiche apposta, e allarga l'oblio alle righe che nominano la persona solo attraverso una conversazione. La seconda (`*_scatola_nera_protocollo.sql`) mette `protocolli` e `protocolli_allegati` sotto gli stessi trigger e fa restituire a `protocollo_elimina` anche le versioni dei documenti rettificati.
- **T4, «copia silenziosa».** La rettifica copia il documento di prima in `<sede>/<anno>/<numero>-versioni/` **prima** di caricare il nuovo; se la copia non riesce, la rettifica non parte. Nessun `logScrittura` e nessuna riga di log nuova sul successo: le decisioni #6 e #26 restano.
- **Avvisi.** La cancellazione conta le risposte dei genitori prima di portarle via e lo scrive nel log di successo che c'è già.

**Tecnologie:** Postgres 17 su Supabase (trigger a livello di istruzione con tabelle di transizione, PL/pgSQL, `SECURITY DEFINER` con `search_path` vuoto), PGlite (`@electric-sql/pglite`) per provare le migrazioni lette dal disco, Next 16 App Router (route avvolte in `withRoute`), `@supabase/storage-js` (`copy`), vitest.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, Sessione 3 (righe 358-402), con T4 alla riga 53 e le regole comuni della §5 (righe 133-197). I numeri di riga sono quelli del 20/10: se la specifica è cambiata, le sezioni si trovano per titolo (`grep -n "^### Sessione 3\|^## 5"`).

---

## Mappa dei file

| File | Ruolo | Righe lette |
|---|---|---|
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` | **Modifica, solo nel primo commit.** Fotografia delle migrazioni rigenerata dalla produzione dalla chiusura della sessione rilasciata per ultima (Compito 1, Passo 4) | intero, con la procedura in `__tests__/architecture/migrazioni-complete.test.ts:44-57` |
| `supabase/migrations/<version>_scatola_nera_cascate_anagrafiche.sql` | **Crea.** Interruttore in `registra()`, nove figlie, cinque tabelle nello storico delle modifiche (più `storico_versione` fra le colonne ignorate), bonifiche con l'interruttore, oblio che segue le conversazioni | nuovo |
| `supabase/migrations/<version>_scatola_nera_protocollo.sql` | **Crea.** `protocolli` e `protocolli_allegati` nella scatola (eliminazioni, modifiche, TRUNCATE vietato); `protocollo_elimina` che restituisce anche le versioni | nuovo |
| `supabase/migrations/20261009171012_scatola_nera_registro_eliminazioni.sql` | Sola lettura: `soggetti_di` 143-154, `registra()` 160-184, ciclo 200-232 (come la specifica), REVOKE 395-403 | 1-420 |
| `supabase/migrations/20261019215733_scatola_nera_modifiche.sql` | Sola lettura: `registra_modifica()` 107-142, ciclo 144-167 (marcatori 149/155), involucro della retention 174-183, `scatola_nera_dimentica` 248-280, permessi 352-362 | 1-365 |
| `supabase/migrations/20261015183000_storici_stampe_rettifiche.sql` | Sola lettura: `storici_revisioni` 184-202, `storici_bonifica_chat` 437-449 | 184-222, 436-452 |
| `supabase/migrations/20261019223123_battiti_app_log_che_contano.sql` | Sola lettura: `storici_oblio_alunno` 156-178; modello della sezione ROLLBACK 37-39 | 1-200 |
| `supabase/migrations/20261010223849_eliminazioni_in_ordine.sql` | Sola lettura: `protocollo_elimina` 238-268 | 236-270 |
| `__tests__/lib/scatola-nera-cascate-sql.test.ts` | **Crea.** PGlite: le tre migrazioni della scatola lette dal disco | nuovo |
| `__tests__/lib/scatola-nera-protocollo-sql.test.ts` | **Crea.** PGlite: protocollo nella scatola, versioni restituite | nuovo |
| `__tests__/lib/protocollo-elimina-sql.test.ts` | **Modifica 52-56.** Lo schema minimo prende `scuola_id`, `anno`, `numero` | 1-120 |
| `src/lib/protocolli/store.ts` | **Modifica 92-99.** `pathDefinitivi` prende `prefissoVersioni` e `versione`; nuova `istanteVersione` | 80-104 |
| `__tests__/lib/protocolli-store.test.ts` | **Modifica 3-9 e dopo 57.** Due casi | 1-71 |
| `src/app/api/admin/protocolli/rettifica/route.ts` | **Modifica 8-16** (import) **e 176-179** (copia prima del caricamento) | 1-246 |
| `__tests__/api/protocolli-rettifica-versioni.test.ts` | **Crea.** Route con lo Storage finto | nuovo |
| `src/app/api/admin/protocolli/route.ts` | **Non cambia.** Il DELETE (443-468) toglie già dal bucket ogni percorso che la funzione restituisce | 419-476 |
| `src/app/api/avvisi/[id]/route.ts` | **Modifica 826-827** (conteggio prima della cancellazione) **e 884-890** (log di successo) | 1-40, 680-700, 788-897 |
| `__tests__/api/avvisi-orfani-cancellazione.test.ts` | **Modifica 51-71, 128-138, 185-202** e due casi dopo 265 | 1-275 |
| `src/lib/gdpr/scatola-nera.ts` | **Non cambia.** Chiama `scatola_nera_dimentica` per ultima e logga già `scatola-nera-dimenticata`; la regola nuova vive nella funzione SQL | 1-72 |
| `src/app/privacy/page.tsx` | **Modifica 826-854.** La voce «copie tecniche di sicurezza» | 818-860 |
| `src/lib/legal/versioni.ts` | **Modifica 252-268.** Commento e `VERSIONE_PRIVACY` | 225-269 |
| `__tests__/architecture/pagine-legali.test.ts` | **Modifica dopo 419.** Impronta della versione nuova | 380-455, 536-575 |
| `docs/runbook-ripristino.md` | **Modifica 83-87 e 117-122.** Scenari A0 e A0-bis | 80-150 |
| `PRD REGISTRO ELETTRONICO.md` | **Modifica.** Changelog in cima (prima della riga 1) e punto 6 della scatola nera (riga 866) | 1-60, 846-866 |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | **Modifica la riga `^\| 3 \|`** della tabella di stato, trovata per contenuto e portata a «in revisione» (Compiti 13 e 14) | 21-42 |

---

## Passo 0 — misura prima

Tutto in **sola lettura**: strumento MCP `execute_sql` sul progetto di produzione, solo `SELECT`. Le righe che si leggono qui sono conteggi, nomi di tabelle e corpi di funzioni: niente di tutto questo va in chat se non è un numero. I numeri finiscono nel file delle misure `${TMPDIR:-/tmp}/s03-misure.env` (fuori dal repository) e da lì nel PRD (Compito 13).

### Compito 1 — Apertura: prerequisiti, worktree, chiusura della precedente

**File:**
- Nel primo commit, solo i file che tocca la chiusura della sessione rilasciata per ultima (Passo 4): di solito `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la specifica, il PRD, e quelli che la sua sezione «Per la sessione dopo» nomina.

- [ ] **Passo 1: prerequisiti (§5, «Apertura di una sessione: i prerequisiti»)**

La colonna «Dopo» della riga `^| 3 |` della tabella di stato dice `2`: la sessione 2 deve essere **in produzione**. Si verificano due fatti, mai il testo dello «Stato» (che la sessione 2 lascia a «in revisione» e porta a «in produzione» solo la sessione che la chiude).

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md && echo specifica-presente
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s02-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
git -C /Users/lerri/kidville-web ls-tree --name-only origin/main supabase/migrations/ | grep "_via_exec_sql\.sql$"
```

Atteso: `specifica-presente`; **una** riga con numero e data della PR della sessione 2; **un** file `supabase/migrations/<14 cifre>_via_exec_sql.sql`. Con le 14 cifre di quel file, in sola lettura sul database di produzione:

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('{le 14 cifre}');
```

Atteso: **una** riga. Poi nessuna PR `robustezza2/` aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: **nessuna riga**. Se uno solo di questi controlli non dà l'atteso, **fermati** e avvisa il titolare: la sessione 3 insegna alla scatola nera a rispettare `scatola_nera.senza_storico`, ed è sicuro solo quando nessun ruolo dell'app può più accenderlo con `exec_sql` (§3, «2 → 3»).

- [ ] **Passo 2: worktree e ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s03-scatola-nera-cascate /Users/lerri/kidville-web-s03-scatola-nera origin/main
cd /Users/lerri/kidville-web-s03-scatola-nera && git status -sb | head -3
```

Atteso: `## robustezza2/s03-scatola-nera-cascate...origin/main`, albero pulito. Da qui in poi ogni comando gira in `/Users/lerri/kidville-web-s03-scatola-nera`; mai nel checkout principale, dove lavorano altre sessioni.

- [ ] **Passo 3: `.env.local` e dipendenze**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s03-scatola-nera/.env.local
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 4: chiusura della sessione rilasciata per ultima (§5, «… la chiusura della precedente»), primo commit, prima di ogni codice**

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: il numero e il ramo della sessione `robustezza2/` mergiata più di recente (con l'ordine della §3, di solito `robustezza2/s02-sql-arbitrario-e-freno`). Non si presume quale sia: si chiude quella che il comando stampa.

1. Apri il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md`, e leggi per intero la sua sezione finale «Per la sessione dopo». Si fa quello che c'è scritto, non quello che si presume.
2. Se quella sessione aveva migrazioni (la sua sezione lo dice), rigenera la fotografia delle migrazioni applicate. Stampa la query:

   ```bash
   SCRATCH=$(mktemp -d)
   node __tests__/fixtures/migrazioni-fotografia.mjs --sql
   ```

   Eseguila sul database di produzione con lo strumento `execute_sql` (sola lettura: `select version, name from supabase_migrations.schema_migrations order by version`), salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

   ```bash
   node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
   npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
   ```

   Atteso: `migrazioni-complete` verde, con le migrazioni di quella sessione nella fotografia con la version del file. `soglia-fotografia` è rosso sulla prova «2 · nessuna chiave è già applicata» solo se quella sessione aveva voci in `MIGRAZIONI_ATTESE_AL_MERGE`, finché non le togli come dice la sua sezione: è il segnale previsto.
3. Fai le altre voci della sezione nell'ordine in cui sono scritte: le altre fotografie che nomina (ciascuna col suo comando), le voci tolte dalle liste, le prove che chiede di fare nella tua sessione, la riga di stato a «in produzione», lo Stato della voce nel PRD, la misura «dopo» se è già matura.
4. Verifica, e committa **solo se c'è qualcosa da committare** (un commit vuoto fallisce con «nothing to commit»):

   ```bash
   CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
   git status --short
   ```

   Atteso: tutto verde. Con `git status --short` vuoto non si committa e si passa al Passo 5. Altrimenti si aggiungono **per nome** i file che `git status --short` elenca e che la sezione ha chiesto di toccare (per la sessione 2, per esempio: `__tests__/fixtures/migrazioni-applicate-snapshot.json`, `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, `"PRD REGISTRO ELETTRONICO.md"`, `CLAUDE.md`, `docs/storia-permessi-e-conferme.md`), poi:

   ```bash
   git diff --cached --name-only
   git commit -m "$(cat <<'EOF'
   Chiusura della sessione rilasciata per ultima: fotografie, stato in produzione, PRD

   Apre la sessione 3 della seconda serie di robustezza: eseguita la sezione
   «Per la sessione dopo» del piano della sessione chiusa.

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   EOF
   )"
   ```

   Atteso: `git diff --cached --name-only` elenca solo i file della chiusura.

- [ ] **Passo 5: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: tutti i file verdi tranne, al massimo, `offline-html-nativo` al primo giro (in un worktree nuovo la shell nativa non è sincronizzata); col secondo comando `1 passed`. Leggi la riga `Test Files`, non il codice d'uscita di una pipe. Se è rosso un altro lock di fotografia (`fk-scuola-id`, `rls-per-sede`, …), rigenera quella fotografia con il generatore che il suo messaggio d'errore nomina, sempre dalla produzione e con il comando scritto nel commento di testa del generatore, e committala **da sola**, aggiungendo per nome il file della fotografia e con un messaggio che dice quale fotografia e perché era rossa. Se non è rosso niente, in questo passo non si committa.

---

### Compito 2 — Le misure «prima»

**File:** nessuno nel repository. Il file delle misure è `${TMPDIR:-/tmp}/s03-misure.env`, una riga `CHIAVE=valore` per numero.

- [ ] **Passo 1: il conteggio delle domande d'iscrizione (§5)**

```sql
SELECT count(*) FROM enrollment_submissions;
```

Scrivi nel file delle misure `ISCRIZIONI=` col numero letto e `ISCRIZIONI_ALLE=` con l'output di `date -u '+%Y-%m-%d %H:%M'`. Non si copia da nessun documento: si conta.

- [ ] **Passo 2: i trigger della scatola, oggi**

```sql
SELECT tgname, count(*) AS n
  FROM pg_trigger
 WHERE tgname IN ('scatola_nera_eliminazioni', 'scatola_nera_no_truncate', 'scatola_nera_modifiche')
 GROUP BY 1 ORDER BY 1;
```

Atteso: `scatola_nera_eliminazioni` 42, `scatola_nera_modifiche` 13, `scatola_nera_no_truncate` 42. Scrivi `E0=` (eliminazioni) e `M0=` (modifiche). **Soglia:** se non sono 42 e 13, i numeri «dopo» (Rilascio, Passo 6, e sezione «Per la sessione dopo», punto 4) diventano `E0 + 12` e `M0 + 7` (dieci figlie più le due tabelle del protocollo: `conversazioni_sospensioni` è entrata come decima il 25/10, decisione dell'assistente in assenza del titolare), e la differenza va spiegata nel PRD prima di andare avanti (una sessione intermedia ha toccato la scatola).

- [ ] **Passo 3: le figlie in cascata, esatte**

```sql
SELECT c.confrelid::regclass AS padre,
       c.conrelid::regclass  AS figlia,
       c.conname,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.conrelid AND t.tgname = 'scatola_nera_eliminazioni') AS gia_in_scatola
  FROM pg_constraint c
 WHERE c.contype = 'f'
   AND c.confdeltype = 'c'
   AND c.confrelid IN ('public.utenti'::regclass, 'public.alunni'::regclass, 'public.avvisi'::regclass,
                       'public.chat_threads'::regclass, 'public.note_disciplinari'::regclass,
                       'public.parents'::regclass)
 ORDER BY 1, 2;
```

**Soglia che cambia il piano.** Ogni figlia con `gia_in_scatola = false` deve stare in una delle due colonne qui sotto. Se ne compare una che non sta in nessuna delle due e ha valore legale o umano (registri, firme, risposte, testi delle famiglie), **fermati**: scrivila nella colonna «Note» della riga `^| 3 |` della tabella di stato e chiedi al titolare se entra nell'elenco del Compito 4. Se una delle nove della colonna «dentro» **non** è in cascata da nessuno di quei padri, resta dentro lo stesso (la cancella anche una route), ma va detto nel PRD.

| Dentro (Compito 4) | Fuori, con il motivo scritto nell'intestazione della migrazione |
|---|---|
| `chat_messages`, `chat_threads`, `avvisi`, `avvisi_risposte`, `nota_ricezioni`, `alunni_classi_storico`, `storici_collegamenti`, `storici_revisioni`, `fascicolo_accessi_audit` | `notifiche`, `push_subscriptions` (effimere) · `anagrafica_personale`, `galleria_media_v2`, `candidature_insegnanti` (retention per legge, già fuori dalla fase 4) · `utenti_scuole`, `utenti_sezioni`, `utenti_sezioni_materie` (configurazione d'accesso) · `mensa_prenotazioni`, `mensa_alternative`, `divise_ordini`, `armadietto_richieste`, `task_interni` (operative) · `storici_generazioni` (lavori di stampa che scadono da soli) · `registro_destinatari` (figlia di `alunni`, non nell'elenco della §7: decide il titolare) |

- [ ] **Passo 4: le tabelle dello storico delle modifiche hanno `id`?**

```sql
SELECT t.table_name,
       bool_or(c.column_name = 'id')               AS ha_id,
       bool_or(c.column_name = 'storico_versione') AS ha_storico_versione
  FROM information_schema.tables t
  JOIN information_schema.columns c USING (table_schema, table_name)
 WHERE t.table_schema = 'public'
   AND t.table_name IN ('alunni', 'parents', 'utenti', 'note_disciplinari', 'certificati_medici',
                        'protocolli', 'protocolli_allegati')
 GROUP BY 1 ORDER BY 1;
```

Atteso: sette righe, `ha_id = true` ovunque; `ha_storico_versione = true` su `note_disciplinari`. **Soglia:** una tabella senza `id` **non** entra nello storico delle modifiche (`registra_modifica` unisce le due tabelle di transizione su `id`, e `riga_id` è `NOT NULL`): toglila dall'elenco del Compito 5 o del Compito 8 e scrivilo nel PRD.

- [ ] **Passo 5: volumi, dimensioni e crescita stimata**

```sql
WITH finestra AS (
  SELECT COALESCE(d.stats_reset, pg_postmaster_start_time()) AS dal,
         GREATEST(EXTRACT(EPOCH FROM now() - COALESCE(d.stats_reset, pg_postmaster_start_time())) / 86400, 1)::numeric AS giorni
    FROM pg_stat_database d
   WHERE d.datname = current_database()
), nuove(tabella, copia_eliminazioni, copia_modifiche) AS (
  VALUES ('chat_messages', true, false), ('chat_threads', true, false), ('avvisi', true, false),
         ('avvisi_risposte', true, false), ('nota_ricezioni', true, false),
         ('alunni_classi_storico', true, false), ('storici_collegamenti', true, false),
         ('storici_revisioni', true, false), ('fascicolo_accessi_audit', true, false),
         ('alunni', false, true), ('parents', false, true), ('utenti', false, true),
         ('note_disciplinari', false, true), ('certificati_medici', false, true),
         ('protocolli', true, true), ('protocolli_allegati', true, true),
         ('registro_destinatari', true, false)
), stima AS (
  SELECT n.tabella, s.n_live_tup, s.n_tup_del, s.n_tup_upd,
         pg_total_relation_size(s.relid) AS byte, f.giorni, f.dal,
         ((CASE WHEN n.copia_eliminazioni THEN s.n_tup_del ELSE 0 END)
          + (CASE WHEN n.copia_modifiche THEN s.n_tup_upd ELSE 0 END)) / f.giorni * 90
          * (pg_total_relation_size(s.relid)::numeric / GREATEST(s.n_live_tup, 1)) / 1048576 AS mb_90
    FROM nuove n
    JOIN pg_stat_user_tables s ON s.schemaname = 'public' AND s.relname = n.tabella
   CROSS JOIN finestra f
)
SELECT tabella, n_live_tup, n_tup_del, n_tup_upd, pg_size_pretty(byte) AS dimensione,
       round(giorni, 1) AS giorni_osservati, dal,
       round(mb_90, 2) AS mb_in_90_giorni,
       round(sum(mb_90) FILTER (WHERE tabella <> 'registro_destinatari') OVER (), 2) AS mb_totali_in_90_giorni
  FROM stima
 ORDER BY mb_90 DESC;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database,
       pg_size_pretty(pg_total_relation_size('scatola_nera.eliminazioni')) AS eliminazioni,
       pg_size_pretty(pg_total_relation_size('scatola_nera.modifiche'))    AS modifiche,
       (SELECT count(*) FROM scatola_nera.eliminazioni) AS righe_eliminazioni,
       (SELECT count(*) FROM scatola_nera.modifiche)    AS righe_modifiche;
```

La stima è **prudente**: i byte medi per riga contano anche indici e TOAST, e `n_tup_upd` conta anche gli UPDATE che `registra_modifica` non copia (solo `updated_at`). `registro_destinatari` è nella lista per dare il numero al titolare, ma non entra nel totale. Scrivi `CRESCITA_MB=` (il totale), `GIORNI=`, `DAL=`, `DB_PRIMA=` e `SCATOLA_PRIMA=` (le due dimensioni).

**Soglia che cambia il piano** (sul totale, contro i 491 MB del database al 20/10):
- **fino a 50 MB in 90 giorni:** si procede con gli elenchi del piano;
- **fra 50 e 150 MB:** si toglie dall'elenco (Compito 4 o Compito 5) la tabella con `mb_in_90_giorni` più alto, una alla volta, finché il totale scende sotto i 50; ogni tabella tolta va nel PRD e nella colonna «Note» della riga `^| 3 |`, con il suo numero;
- **oltre 150 MB:** **fermati.** Riga `^| 3 |` della tabella di stato in «bloccata: crescita stimata N MB in 90 giorni»; decide il titolare.

- [ ] **Passo 6: i corpi delle funzioni che si ridefiniscono, presi dalla produzione**

```sql
SELECT p.oid::regprocedure AS funzione,
       md5(pg_get_functiondef(p.oid)) AS impronta,
       pg_get_functiondef(p.oid) AS corpo
  FROM pg_proc p
 WHERE p.oid IN ('scatola_nera.registra()'::regprocedure,
                 'scatola_nera.registra_modifica()'::regprocedure,
                 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure,
                 'public.storici_bonifica_chat()'::regprocedure,
                 'public.storici_oblio_alunno()'::regprocedure,
                 'public.protocollo_elimina(uuid)'::regprocedure)
 ORDER BY 1;
```

Atteso: sei righe. Salva i sei corpi in `${TMPDIR:-/tmp}/s03-funzioni-prima.sql` (servono anche al Ritorno indietro). Confrontali, istruzione per istruzione, con i file di riferimento:

| Funzione | File di riferimento |
|---|---|
| `scatola_nera.registra()` | `20261009171012_scatola_nera_registro_eliminazioni.sql:160-184` |
| `scatola_nera.registra_modifica()` | `20261019215733_scatola_nera_modifiche.sql:107-142` |
| `public.scatola_nera_dimentica` | `20261019215733_scatola_nera_modifiche.sql:248-280` |
| `public.storici_bonifica_chat()` | `20261015183000_storici_stampe_rettifiche.sql:437-446` |
| `public.storici_oblio_alunno()` | `20261019223123_battiti_app_log_che_contano.sql:157-176` |
| `public.protocollo_elimina(uuid)` | `20261010223849_eliminazioni_in_ordine.sql:238-264` |

**Soglia:** se una sola funzione fa in produzione qualcosa che il file non fa (un ramo in più, una tabella in più, un altro `search_path`), i Compiti 3-8 applicano **la stessa aggiunta** al corpo di produzione invece di usare il corpo scritto qui, e la differenza va nel PRD. Differenze di sola forma (maiuscole, a capo, il `SET search_path TO` che `pg_get_functiondef` riscrive) non contano.

- [ ] **Passo 7: chi altro cancella dalle tabelle che entrano nella scatola**

```sql
SELECT n.nspname, p.proname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'scatola_nera')
   AND p.prosrc ~* 'delete\s+from\s+(public\.)?(chat_messages|chat_threads|avvisi|avvisi_risposte|nota_ricezioni|alunni_classi_storico|storici_collegamenti|storici_revisioni|fascicolo_accessi_audit|protocolli|protocolli_allegati)\M'
 ORDER BY 1, 2;

SELECT jobname, schedule
  FROM cron.job
 WHERE command ~* '(chat_messages|chat_threads|avvisi|nota_ricezioni|alunni_classi_storico|storici_collegamenti|storici_revisioni|fascicolo_accessi_audit|protocolli)'
 ORDER BY 1;
```

Atteso (dal codice del repository): tre funzioni, `protocollo_elimina`, `storici_bonifica_chat`, `storici_oblio_alunno`; nessun job. **Soglia:** una funzione in più che è una **pulizia** (retention, bonifica, riscrittura in blocco) va avvolta con l'interruttore, con lo stesso schema delle due bonifiche del Compito 6 e un test PGlite suo, prima del merge; una funzione in più che è una cancellazione **voluta da una persona** resta com'è, perché quella copia è proprio ciò che la scatola serve a tenere.

Le query qui sopra vedono solo il database. **Cancellano anche quattro route dell'app, via PostgREST**, e un trigger a livello di istruzione le copia tutte allo stesso modo (cercate il 20/10 con `grep -rn "\.delete()" src` sulle undici tabelle):

| Dove | Tabella | Che cosa toglie | Chi lo decide |
|---|---|---|---|
| `src/app/api/admin/storici/appartenenze/route.ts:56` | `alunni_classi_storico` | una riga, per `id` | una persona, riga per riga (resta com'è) |
| `src/app/api/avvisi/[id]/route.ts:830` | `avvisi` (e in cascata `avvisi_risposte`) | un avviso | una persona (Compito 11) |
| `src/app/api/primaria/note/route.ts:636` (e `:628`, ramo storico, con `applicaRettificaStorica`) | `nota_ricezioni` | le prese visione di una nota modificata | una persona: è la ricevuta che la §7 vuole tenere (D7) |
| `src/lib/alunni/libera-spazio.ts:432-437` (route `src/app/api/admin/students/libera-spazio/route.ts`) | `chat_messages` | **tutti** i messaggi senza allegato delle conversazioni di un bambino ritirato | una persona, ma è una **pulizia in blocco**: il suo scopo è togliere i dati |

Le prime tre restano come sono. La quarta no: con `chat_messages` nella scatola, ogni «libera spazio» lascia una copia di ogni messaggio tolto per 90 giorni (`scatola_nera.eliminazioni`, e l'oblio la toglie se richiesto), cioè lo spazio si libera solo dopo 90 giorni e i testi delle famiglie restano nel database per quel tempo. Non la si avvolge con l'interruttore in questa sessione: PostgREST non può accendere `scatola_nera.senza_storico` nella transazione della `DELETE`, servirebbe una funzione SQL nuova che oggi non c'è. Si contano le righe in gioco:

```sql
-- Quanti messaggi toglierebbe «libera spazio» oggi, se la segreteria lo usasse su tutti i ritirati che non l'hanno ancora avuto
-- (STATI_NON_PIU_ISCRITTO in src/lib/alunni/stato.ts:136 vale solo 'ritirato' al 20/10).
SELECT count(*)                    AS messaggi_da_liberare,
       count(DISTINCT t.student_id) AS alunni_ritirati_con_messaggi
  FROM public.chat_messages m
  JOIN public.chat_threads  t ON t.id = m.thread_id
  JOIN public.alunni        a ON a.id = t.student_id
 WHERE a.stato = 'ritirato'
   AND a.spazio_liberato_il IS NULL
   AND m.attachment_url IS NULL;

-- Quante volte è stata usata finora, e quante negli ultimi 90 giorni (il ritmo).
SELECT count(*) FILTER (WHERE spazio_liberato_il IS NOT NULL)                         AS alunni_gia_liberati,
       count(*) FILTER (WHERE spazio_liberato_il >= now() - interval '90 days')       AS liberati_ultimi_90_giorni
  FROM public.alunni;
```

Scrivi `LIBERA_SPAZIO_MESSAGGI=`, `LIBERA_SPAZIO_ALUNNI=`, `LIBERA_SPAZIO_USATA=` e `LIBERA_SPAZIO_90G=` nel file delle misure. Sono numeri, non righe: nessun testo di messaggio si legge. **Prima del Compito 4** porta i quattro numeri al titolare con la domanda della sezione «Decisioni che restano al titolare» («`chat_messages` e «libera spazio»») e scrivi la risposta nel file delle misure come `LIBERA_SPAZIO_DECISIONE=accetta` oppure `LIBERA_SPAZIO_DECISIONE=escludi`:
- **accetta:** si procede con gli elenchi del piano; il numero e la decisione vanno nel PRD (Compito 13) e nella colonna «Note» della riga `^| 3 |`;
- **escludi:** **fermati prima del Compito 4.** Togliere `chat_messages` cambia gli elenchi e i test dei Compiti 4 e 7 (e l'oblio che segue le conversazioni); farlo bene vuol dire un piano corretto, non una modifica a mano durante l'esecuzione. Scrivi nella colonna «Note» della riga `^| 3 |` «ferma: `chat_messages` e «libera spazio» da riprogettare» e avvisa il titolare;
- **nessuna risposta:** vale come **escludi**, cioè ci si ferma.

- [ ] **Passo 8: quante modifiche di oggi sono solo un «tocco»**

```sql
SELECT tabella,
       count(*) FILTER (WHERE cambiate <@ ARRAY['storico_versione', 'updated_at', 'aggiornato_il']::text[]) AS solo_tocco,
       count(*) AS tutte
  FROM scatola_nera.modifiche
 GROUP BY 1 ORDER BY 1;
```

Serve a dire nel PRD quante righe di oggi sono rumore (`valutazioni` toccata da `valutazione_obiettivi`, per esempio). Non cambia il piano: `storico_versione` entra comunque fra le colonne ignorate, perché con `note_disciplinari` nello storico ogni presa visione firmata da un genitore toccherebbe la nota e ne copierebbe il testo intero.

- [ ] **Passo 9: lo Storage del protocollo e i trigger delle due tabelle**

```sql
SELECT count(*) AS oggetti,
       count(*) FILTER (WHERE name LIKE '%-versioni/%') AS versioni,
       pg_size_pretty(COALESCE(sum((metadata ->> 'size')::bigint), 0)) AS dimensione
  FROM storage.objects
 WHERE bucket_id = 'protocollo';

SELECT c.relname, g.tgname, pg_get_triggerdef(g.oid) AS definizione
  FROM pg_trigger g
  JOIN pg_class c ON c.oid = g.tgrelid
 WHERE c.relname IN ('protocolli', 'protocolli_allegati') AND NOT g.tgisinternal
 ORDER BY 1, 2;
```

Atteso: `versioni = 0`; fra i trigger ci sono `trg_worm_protocolli` e `trg_worm_protocolli_allegati`, nessun `scatola_nera_*`. Scrivi `VERSIONI_PRIMA=` e `STORAGE_PROTOCOLLO_PRIMA=`. **Soglia:** se esiste già un trigger `scatola_nera_*` su una delle due tabelle, qualcuno ha toccato la decisione #6 fuori da questa sessione: fermati e chiedi al titolare.

- [ ] **Passo 10: il proprietario di `protocollo_elimina` può leggere `storage.objects`?**

La funzione è `SECURITY DEFINER`: legge lo Storage con i diritti di chi la possiede. Se quel ruolo non vede le righe del bucket, le versioni non verrebbero restituite e resterebbero nel bucket **in silenzio** dopo un'eliminazione.

```sql
SELECT r.rolname AS proprietario,
       r.rolbypassrls AS salta_rls,
       has_table_privilege(r.oid, 'storage.objects', 'SELECT') AS legge_storage,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) AS storage_con_rls
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
 WHERE p.oid = 'public.protocollo_elimina(uuid)'::regprocedure;
```

Atteso: `legge_storage = true` e, se `storage_con_rls = true`, anche `salta_rls = true`. **Soglia:** se una delle due manca, il blocco che legge `storage.objects` nel Compito 8 **non** si scrive così: fermati, scrivilo nella colonna «Note» della riga `^| 3 |` della tabella di stato e chiedi al titolare se le versioni si elencano invece dalla route con `storage.list(prefissoVersioni)` prima della `rpc`.

- [ ] **Passo 11: controlla il file delle misure**

```bash
cat "${TMPDIR:-/tmp}/s03-misure.env"
```

Atteso: le chiavi `ISCRIZIONI`, `ISCRIZIONI_ALLE`, `E0`, `M0`, `CRESCITA_MB`, `GIORNI`, `DAL`, `DB_PRIMA`, `SCATOLA_PRIMA`, `LIBERA_SPAZIO_MESSAGGI`, `LIBERA_SPAZIO_ALUNNI`, `LIBERA_SPAZIO_USATA`, `LIBERA_SPAZIO_90G`, `LIBERA_SPAZIO_DECISIONE` (che vale `accetta`: con `escludi` ci si è fermati al Passo 7), `VERSIONI_PRIMA`, `STORAGE_PROTOCOLLO_PRIMA`, solo numeri, date e dimensioni. Nessun commit.

---

## Migrazione

Due file, entrambi nominati con `date -u +%Y%m%d%H%M%S` **nel momento in cui si creano**, dopo la fotografia del Compito 1: una version posteriore alla fotografia e mai nel futuro (lock `migrazioni-complete` e `soglia-fotografia`). Regole che valgono per entrambi:

- **Guardie per la CI.** Il database della CI non ha `pg_cron` né `storage.objects`, e può non avere una tabella: ogni ciclo salta con `to_regclass(...) IS NULL`, e la lettura dello Storage sta dietro `to_regclass('storage.objects')`.
- **`NOT VALID`:** non serve. Nessun vincolo nuovo, nessuna colonna, nessuna tabella.
- **Niente parole che le guardie delle fotografie leggono come cambio di schema** (`policy`, `primary key`, `unique`, `add constraint`, `drop table`, `references`) fuori dai commenti: le due migrazioni toccano solo trigger e funzioni.
- **Ogni funzione `SECURITY DEFINER` ridefinita ha il suo `REVOKE ALL … FROM PUBLIC, anon, authenticated`** nello stesso file (lock `security-definer-revoke-lock`).
- **Nessun `DELETE` fuori dai corpi di funzione** (lock `migrazioni-distruttive-approvate`) e **nessun `DELETE FROM storage.objects`** (lock `storage-delete-vietata-in-sql`).
- **Codice che regge il momento del merge (§5):** l'app non chiama nessuna RPC nuova e nessuna colonna nuova. La rettifica usa solo lo Storage; il DELETE del protocollo riceve semplicemente più percorsi. Niente da proteggere con `CODICI_NON_INSTALLATO`.
- **ROLLBACK** nell'intestazione, sul modello di `20261019223123_battiti_app_log_che_contano.sql:37-39`.

### Compito 3 — Prima migrazione: l'interruttore in `registra()`

**File:**
- Crea: `supabase/migrations/<version>_scatola_nera_cascate_anagrafiche.sql`
- Test: `__tests__/lib/scatola-nera-cascate-sql.test.ts`

- [ ] **Passo 1: scrivi il test (rosso)**

Crea `__tests__/lib/scatola-nera-cascate-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * SCATOLA NERA SU CASCATE E ANAGRAFICHE (robustezza, seconda serie, sessione 3) · PROVATA SU UN
 * POSTGRES VERO.
 *
 * Le tre migrazioni della scatola sono LETTE DAL DISCO e applicate in ordine: le eliminazioni
 * (fase 4), le modifiche (fase 12) e quella di questa sessione, DUE volte (idempotenza). Lo schema
 * è un MINIMO con i nomi veri e le FK in CASCADE che contano: utenti → conversazioni e avvisi,
 * alunni → conversazioni, storico classi, copie storiche, registro accessi, note → prese visione,
 * avvisi → risposte. Un finto client direbbe «sì» a tutto. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
  if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, file), 'utf8')
}
const ELIMINAZIONI = migrazione('_scatola_nera_registro_eliminazioni.sql')
const MODIFICHE = migrazione('_scatola_nera_modifiche.sql')
const CASCATE = migrazione('_scatola_nera_cascate_anagrafiche.sql')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = '10000000-0000-4000-8000-000000000001'
const ALTRO_ALUNNO = '10000000-0000-4000-8000-000000000002'
const GENITORE = '20000000-0000-4000-8000-000000000001'
const ALTRO_GENITORE = '20000000-0000-4000-8000-000000000002'
const DOCENTE = '30000000-0000-4000-8000-000000000001'
const THREAD = '40000000-0000-4000-8000-000000000001'
const ALTRO_THREAD = '40000000-0000-4000-8000-000000000002'
const MSG_GENITORE = '50000000-0000-4000-8000-000000000001'
const MSG_DOCENTE = '50000000-0000-4000-8000-000000000002'
const MSG_ALTRO = '50000000-0000-4000-8000-000000000003'
const AVVISO = '60000000-0000-4000-8000-000000000001'
const NOTA = '70000000-0000-4000-8000-000000000001'
const CERTIFICATO = '80000000-0000-4000-8000-000000000001'

/** Le tabelle da svuotare fra un caso e l'altro (con i trigger spenti). */
const TABELLE = [
  'notifiche', 'fascicolo_accessi_audit', 'alunni_classi_storico', 'storici_collegamenti',
  'storici_revisioni', 'storici_generazioni', 'nota_ricezioni', 'note_disciplinari',
  'certificati_medici', 'avvisi_risposte', 'avvisi', 'chat_messages', 'chat_threads',
  'alunni', 'parents', 'utenti', 'schools', 'app_log',
]

let db: PGlite

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function codiceErrore(sql: string): Promise<string | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'errore'
  }
}

/** Le copie nella scatola delle eliminazioni, contate per tabella. */
async function perTabella(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ tabella: string; n: number }>(
    'SELECT tabella, count(*)::int AS n FROM scatola_nera.eliminazioni GROUP BY tabella ORDER BY tabella')
  return Object.fromEntries(rows.map((r) => [r.tabella, r.n]))
}

async function semina(): Promise<void> {
  await db.exec(`
    INSERT INTO public.schools VALUES ('${SEDE}', 'Sede di prova');
    INSERT INTO public.utenti (id, nome, cognome) VALUES ('${DOCENTE}', 'Docente', 'DiProva');
    INSERT INTO public.parents (id, nome) VALUES ('${GENITORE}', 'Adulta'), ('${ALTRO_GENITORE}', 'Altra');
    INSERT INTO public.alunni (id, scuola_id, nome) VALUES
      ('${ALUNNO}', '${SEDE}', 'Bimbo'), ('${ALTRO_ALUNNO}', '${SEDE}', 'Altro');
    INSERT INTO public.chat_threads VALUES
      ('${THREAD}', '${DOCENTE}', '${GENITORE}', '${ALUNNO}'),
      ('${ALTRO_THREAD}', '${DOCENTE}', '${ALTRO_GENITORE}', '${ALTRO_ALUNNO}');
    INSERT INTO public.chat_messages (id, thread_id, sender_id, content) VALUES
      ('${MSG_GENITORE}', '${THREAD}', '${GENITORE}', 'testo di prova'),
      ('${MSG_DOCENTE}', '${THREAD}', '${DOCENTE}', 'risposta di prova'),
      ('${MSG_ALTRO}', '${ALTRO_THREAD}', '${DOCENTE}', 'altro testo di prova');
    INSERT INTO public.storici_revisioni (alunno_id, modulo, entita_id) VALUES
      (NULL, 'chat', '${MSG_DOCENTE}'), ('${ALUNNO}', 'registro', '${NOTA}');
    INSERT INTO public.storici_collegamenti (alunno_id) VALUES ('${ALUNNO}');
    INSERT INTO public.storici_generazioni (alunni_ids) VALUES (ARRAY['${ALUNNO}']::uuid[]);
    INSERT INTO public.alunni_classi_storico (alunno_id) VALUES ('${ALUNNO}');
    INSERT INTO public.fascicolo_accessi_audit (alunno_id, user_id) VALUES ('${ALUNNO}', '${DOCENTE}');
    INSERT INTO public.avvisi VALUES ('${AVVISO}', '${DOCENTE}', 'Avviso di prova');
    INSERT INTO public.avvisi_risposte (avviso_id, parent_id, alunno_id) VALUES
      ('${AVVISO}', '${GENITORE}', '${ALUNNO}'),
      ('${AVVISO}', '${ALTRO_GENITORE}', '${ALTRO_ALUNNO}'),
      ('${AVVISO}', '${GENITORE}', '${ALUNNO}');
    INSERT INTO public.note_disciplinari (id, alunno_id, testo) VALUES ('${NOTA}', '${ALUNNO}', 'nota di prova');
    INSERT INTO public.nota_ricezioni (nota_id, alunno_id, genitore_id) VALUES ('${NOTA}', '${ALUNNO}', '${GENITORE}');
    INSERT INTO public.certificati_medici VALUES ('${CERTIFICATO}', '${ALUNNO}', 'valido');
    INSERT INTO public.notifiche (utente_id) VALUES ('${DOCENTE}');
  `)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL, evento text NOT NULL, sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL, fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1, visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE TABLE public.schools (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY, nome text, cognome text, updated_at timestamptz);
    CREATE TABLE public.parents (id uuid PRIMARY KEY, nome text, updated_at timestamptz);
    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY, scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
      nome text, anonimizzato_il timestamptz, updated_at timestamptz
    );
    CREATE TABLE public.chat_threads (
      id uuid PRIMARY KEY,
      teacher_id uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
      parent_id uuid NOT NULL,
      student_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE
    );
    CREATE TABLE public.chat_messages (
      id uuid PRIMARY KEY,
      thread_id uuid NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
      sender_id uuid NOT NULL, content text NOT NULL,
      rettifica_staff text, rettifica_staff_il timestamptz, rettifica_staff_da uuid,
      rettifica_versione int NOT NULL DEFAULT 0
    );
    CREATE TABLE public.avvisi (
      id uuid PRIMARY KEY, author_id uuid REFERENCES public.utenti(id) ON DELETE CASCADE, titolo text
    );
    CREATE TABLE public.avvisi_risposte (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      avviso_id uuid NOT NULL REFERENCES public.avvisi(id) ON DELETE CASCADE,
      parent_id uuid, alunno_id uuid
    );
    CREATE TABLE public.note_disciplinari (
      id uuid PRIMARY KEY, alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      testo text, storico_versione int NOT NULL DEFAULT 1, updated_at timestamptz
    );
    CREATE TABLE public.nota_ricezioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nota_id uuid NOT NULL REFERENCES public.note_disciplinari(id) ON DELETE CASCADE,
      alunno_id uuid NOT NULL, genitore_id uuid NOT NULL
    );
    CREATE TABLE public.certificati_medici (
      id uuid PRIMARY KEY, alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      stato text
    );
    CREATE TABLE public.alunni_classi_storico (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE, section_id uuid
    );
    CREATE TABLE public.storici_collegamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE
    );
    CREATE TABLE public.storici_revisioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE,
      modulo text NOT NULL, entita_id uuid NOT NULL, contenuto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE public.storici_generazioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunni_ids uuid[] NOT NULL DEFAULT '{}',
      scade_il timestamptz NOT NULL DEFAULT now() + interval '1 day'
    );
    CREATE TABLE public.fascicolo_accessi_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE, user_id uuid
    );
    -- Effimera: deve restare fuori dalla scatola.
    CREATE TABLE public.notifiche (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      utente_id uuid REFERENCES public.utenti(id) ON DELETE CASCADE
    );
  `)
  await db.exec(ELIMINAZIONI)
  await db.exec(MODIFICHE)
  await db.exec(CASCATE)
  await db.exec(CASCATE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  // `replica` spegne TUTTI i trigger, compresi quelli della scatola e delle cascate: si svuota
  // ogni tabella senza lasciare copie, e la scatola stessa senza passare dalla manutenzione.
  await db.exec(`
    SET session_replication_role = replica;
    ${TABELLE.map((t) => `DELETE FROM public.${t};`).join('\n    ')}
    DELETE FROM scatola_nera.eliminazioni;
    DELETE FROM scatola_nera.modifiche;
    DELETE FROM scatola_nera.oblii;
    SET session_replication_role = DEFAULT;
  `)
  await semina()
})

describe('registra() — l’interruttore `scatola_nera.senza_storico`', () => {
  it('acceso nella transazione: la DELETE avviene e NON lascia copia', async () => {
    await db.exec(`
      BEGIN;
      SELECT set_config('scatola_nera.senza_storico', 'on', true);
      DELETE FROM public.certificati_medici WHERE id = '${CERTIFICATO}';
      COMMIT;
    `)
    expect(await numero('SELECT count(*) FROM public.certificati_medici')).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
  })

  it('CONTROLLO POSITIVO: dopo il COMMIT l’interruttore è spento e la DELETE dopo lascia la copia', async () => {
    await db.exec(`
      BEGIN;
      SELECT set_config('scatola_nera.senza_storico', 'on', true);
      DELETE FROM public.certificati_medici WHERE id = '${CERTIFICATO}';
      COMMIT;
    `)
    await db.exec(`DELETE FROM public.parents WHERE id = '${ALTRO_GENITORE}'`)
    expect(await perTabella()).toEqual({ parents: 1 })
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts 2>&1 | tail -8
```

Atteso: FAIL, `Error: migrazione *_scatola_nera_cascate_anagrafiche.sql non trovata`.

- [ ] **Passo 3: crea la migrazione con la sola intestazione, e guarda il rosso vero**

```bash
MIG_A="supabase/migrations/$(date -u +%Y%m%d%H%M%S)_scatola_nera_cascate_anagrafiche.sql"
echo "$MIG_A"
```

Scrivi in `$MIG_A` l'intestazione intera (resta la stessa fino al Rilascio):

```sql
-- =============================================================================
-- SCATOLA NERA SU CASCATE E ANAGRAFICHE — robustezza, seconda serie, sessione 3
--
-- Problema D4 del rapporto del 20/10 (`docs/analisi-robustezza-2026-10-20.md:486-515`):
-- cancellare un utente, un alunno o un avviso porta via in CASCADE tabelle che la scatola
-- nera della fase 4 non vede, e lo storico delle modifiche della fase 12 non copre le
-- anagrafiche. D7, in parte: la modifica di una nota cancella le prese visione dei genitori
-- (`nota_ricezioni`), fuori dalla scatola.
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `scatola_nera.registra()` rispetta `scatola_nera.senza_storico`, come fa già
--    `registra_modifica()`: una pulizia in blocco DICHIARATA non lascia copie.
--  · Nove figlie in cascata entrano nella scatola delle eliminazioni, con lo stesso
--    trigger e lo stesso divieto di TRUNCATE della fase 4: chat_messages, chat_threads,
--    avvisi, avvisi_risposte, nota_ricezioni, alunni_classi_storico,
--    storici_collegamenti, storici_revisioni, fascicolo_accessi_audit.
--  · Lo storico delle modifiche si allarga ad alunni, parents, utenti,
--    note_disciplinari, certificati_medici. Un UPDATE che cambia SOLO `storico_versione`
--    non si copia, come già `updated_at`: è il «tocco» con cui storici_versione_aggregato
--    segna la nota quando un genitore firma la presa visione, e copierebbe ogni volta il
--    testo intero della nota.
--  · Le due bonifiche che cancellano copie storiche PER PROTEGGERE un dato
--    (`storici_bonifica_chat`, `storici_oblio_alunno`) accendono l'interruttore per le sole
--    proprie DELETE e lo rimettono com'era: una copia di 90 giorni disferebbe la bonifica.
--  · L'oblio (`public.scatola_nera_dimentica`) toglie anche ciò che nomina la persona solo
--    attraverso una conversazione: i messaggi delle sue conversazioni (che la nominano per
--    `thread_id`) e le revisioni di quei messaggi (per `entita_id`), con le conversazioni
--    cancellate (in scatola) o ancora vive. `soggetti_di` legge solo `id` e `*_id`.
--
-- ─── COSA RESTA FUORI, E PERCHÉ ──────────────────────────────────────────────
--  · notifiche, push_subscriptions: effimere (campanella, iscrizioni ai push), con la
--    propria conservazione già dichiarata;
--  · anagrafica_personale, galleria_media_v2, candidature_insegnanti: una retention le
--    svuota per legge, come deciso in fase 4;
--  · utenti_scuole, utenti_sezioni, utenti_sezioni_materie: configurazione d'accesso, si
--    rifà dalla segreteria;
--  · mensa_prenotazioni, mensa_alternative, divise_ordini, armadietto_richieste,
--    task_interni: operative; il valore contabile sta in tabelle già coperte;
--  · storici_generazioni: lavori di stampa che scadono da soli;
--  · registro_destinatari: figlia di alunni non elencata nella specifica (§7); la misura
--    del Passo 0 è nel PRD e la decisione è del titolare;
--  · il registro di protocollo ha la sua migrazione (`*_scatola_nera_protocollo.sql`).
--
-- ─── CORPI DI PARTENZA ───────────────────────────────────────────────────────
-- Le cinque funzioni ridefinite partono da `pg_get_functiondef` letta in produzione il
-- giorno di questa migrazione (Passo 0 del piano
-- `docs/superpowers/plans/2026-10-20-robustezza2-s03-scatola-nera-cascate.md`), uguale ai
-- file 20261009171012, 20261019215733, 20261015183000, 20261019223123. Cambia solo ciò che
-- è scritto sopra.
--
-- ─── FAIL-CLOSED ─────────────────────────────────────────────────────────────
-- Invariato: se la copia non si scrive, fallisce la DELETE o l'UPDATE.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger where tgname = 'scatola_nera_eliminazioni';   -- 42 + 10 = 52
--   select count(*) from pg_trigger where tgname = 'scatola_nera_modifiche';      -- 13 + 5 = 18
--   select prosrc ~ 'senza_storico' from pg_proc
--    where oid = 'scatola_nera.registra()'::regprocedure;                            -- true
--   select prosrc ~ 'v_collegati' from pg_proc
--    where oid = 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure;    -- true
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     foreach t in array array['chat_messages','chat_threads','avvisi','avvisi_risposte',
--         'nota_ricezioni','alunni_classi_storico','storici_collegamenti','storici_revisioni',
--         'fascicolo_accessi_audit'] loop
--       execute format('drop trigger if exists scatola_nera_eliminazioni on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_no_truncate on public.%I', t);
--     end loop;
--     foreach t in array array['alunni','parents','utenti','note_disciplinari','certificati_medici'] loop
--       execute format('drop trigger if exists scatola_nera_modifiche on public.%I', t);
--     end loop; end $$;
--   Rieseguire le definizioni di prima: scatola_nera.registra() da
--   20261009171012_scatola_nera_registro_eliminazioni.sql; scatola_nera.registra_modifica() e
--   public.scatola_nera_dimentica da 20261019215733_scatola_nera_modifiche.sql;
--   public.storici_bonifica_chat da 20261015183000_storici_stampe_rettifiche.sql;
--   public.storici_oblio_alunno da 20261019223123_battiti_app_log_che_contano.sql (oppure i
--   corpi di produzione salvati nel Passo 0). Le righe già copiate restano finché non
--   scadono: sono la copia.
-- =============================================================================
```

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts 2>&1 | tail -12
```

Atteso: FAIL in `acceso nella transazione…`, `expected 1 to be 0`: senza l'interruttore la copia c'è.

È la prima volta che `20261019215733_scatola_nera_modifiche.sql` gira su PGlite (nessun test l'aveva ancora applicata). Se il rosso è invece un errore SQL che nasce dentro quella migrazione, manca qualcosa allo **schema del test** (un ruolo, una tabella che una funzione `LANGUAGE sql` legge alla creazione): si aggiunge lì, nel `beforeAll`, e **mai** si tocca la migrazione già applicata in produzione.

- [ ] **Passo 4: aggiungi in fondo a `$MIG_A` la prima sezione**

```sql
-- ── 1. L'interruttore anche sulle eliminazioni ────────────────────────────────
CREATE OR REPLACE FUNCTION scatola_nera.registra()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ruolo   text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user::text);
  v_utente  uuid;
  v_origine text;
BEGIN
  IF current_setting('scatola_nera.senza_storico', true) = 'on' THEN
    RETURN NULL; -- una pulizia in blocco dichiarata (bonifica, oblio): nessuna copia, di proposito
  END IF;
  BEGIN
    v_utente := NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_utente := NULL; -- claims assenti o non JSON (pg_cron, pannello): nessun utente, non un errore
  END;
  v_origine := left(COALESCE(NULLIF(current_setting('request.path', true), ''),
                             NULLIF(current_setting('application_name', true), ''),
                             'sconosciuta'), 200);

  INSERT INTO scatola_nera.eliminazioni (tabella, riga, soggetti, ruolo, utente, origine)
  SELECT TG_TABLE_NAME, r.riga, scatola_nera.soggetti_di(r.riga), v_ruolo, v_utente, v_origine
    FROM (SELECT to_jsonb(v) AS riga FROM vecchie v) r;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION scatola_nera.registra() FROM PUBLIC, anon, authenticated;
```

- [ ] **Passo 5: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts __tests__/lib/scatola-nera-sql.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  2 passed`. Il secondo file prova che la fase 4 non è cambiata.

- [ ] **Passo 6: commit**

```bash
git add supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql __tests__/lib/scatola-nera-cascate-sql.test.ts
git commit -m "$(cat <<'EOF'
Scatola nera: registra() rispetta l'interruttore senza_storico

Prima sezione della migrazione della sessione 3: una pulizia in blocco dichiarata
non lascia copie nella scatola delle eliminazioni, come già in quella delle
modifiche. Provato su PGlite con le tre migrazioni lette dal disco.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — Le nove figlie in cascata nella scatola delle eliminazioni

**File:**
- Modifica: `supabase/migrations/<version>_scatola_nera_cascate_anagrafiche.sql` (in fondo)
- Test: `__tests__/lib/scatola-nera-cascate-sql.test.ts` (in fondo)

- [ ] **Passo 1: aggiungi i casi in fondo al file di test**

```ts
describe('le figlie in cascata entrano nella scatola delle eliminazioni', () => {
  it('cancellare un alunno: conversazioni e messaggi, prese visione, storico classi, copie storiche, registro accessi — nella stessa transazione', async () => {
    await db.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`)
    expect(await perTabella()).toEqual({
      alunni: 1,
      alunni_classi_storico: 1,
      certificati_medici: 1,
      chat_messages: 2,
      chat_threads: 1,
      fascicolo_accessi_audit: 1,
      nota_ricezioni: 1,
      note_disciplinari: 1,
      storici_collegamenti: 1,
      storici_revisioni: 1,
    })
    expect(await numero('SELECT count(DISTINCT transazione) FROM scatola_nera.eliminazioni')).toBe(1)
    // Controllo positivo: la conversazione dell'altro alunno è viva e non è in scatola.
    expect(await numero(`SELECT count(*) FROM public.chat_threads WHERE id = '${ALTRO_THREAD}'`)).toBe(1)
  })

  it('cancellare un avviso porta via le risposte dei genitori: tutte in scatola', async () => {
    await db.exec(`DELETE FROM public.avvisi WHERE id = '${AVVISO}'`)
    expect(await perTabella()).toEqual({ avvisi: 1, avvisi_risposte: 3 })
  })

  it('cancellare una docente: avvisi, risposte, conversazioni e messaggi in scatola; le notifiche no (effimere)', async () => {
    await db.exec(`DELETE FROM public.utenti WHERE id = '${DOCENTE}'`)
    expect(await perTabella()).toEqual({
      avvisi: 1, avvisi_risposte: 3, chat_messages: 3, chat_threads: 2, utenti: 1,
    })
    // Controllo positivo: la notifica è stata cancellata davvero, solo senza copia.
    expect(await numero('SELECT count(*) FROM public.notifiche')).toBe(0)
  })

  it('i trigger: eliminazioni e TRUNCATE vietato sulle nove figlie', async () => {
    const nove = `ARRAY['chat_messages','chat_threads','avvisi','avvisi_risposte','nota_ricezioni',
      'alunni_classi_storico','storici_collegamenti','storici_revisioni','fascicolo_accessi_audit']`
    expect(await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'scatola_nera_eliminazioni' AND c.relname = ANY(${nove})`)).toBe(9)
    expect(await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'scatola_nera_no_truncate' AND c.relname = ANY(${nove})`)).toBe(9)
    expect(await codiceErrore('TRUNCATE public.chat_messages')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM public.chat_messages')).toBe(3)
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts 2>&1 | tail -15
```

Atteso: 4 FAIL nel `describe` nuovo; nel primo la scatola contiene solo `alunni`, `certificati_medici`, `note_disciplinari` (le tabelle della fase 4).

- [ ] **Passo 3: aggiungi in fondo a `$MIG_A` la seconda sezione**

```sql
-- ── 2. Le figlie in cascata ───────────────────────────────────────────────────
-- Lo stesso ciclo della fase 4 (20261009171012_scatola_nera_registro_eliminazioni.sql:200-232),
-- sulle figlie che contano. Il motivo di chi resta fuori è nell'intestazione.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- figlie-in-cascata:inizio
    'chat_messages', 'chat_threads',
    'avvisi', 'avvisi_risposte',
    'nota_ricezioni',
    'alunni_classi_storico',
    'storici_collegamenti', 'storici_revisioni',
    'fascicolo_accessi_audit'
    -- figlie-in-cascata:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera, cascate: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_eliminazioni ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_eliminazioni AFTER DELETE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_no_truncate ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_no_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_truncate()', t);
  END LOOP;
END $$;
```

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  2 passed`.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql __tests__/lib/scatola-nera-cascate-sql.test.ts
git commit -m "$(cat <<'EOF'
Scatola nera: le nove figlie in cascata di utenti, alunni e avvisi

Messaggi e conversazioni della chat, avvisi e risposte dei genitori, prese visione
delle note, storico delle classi, copie storiche e registro degli accessi al
fascicolo restano 90 giorni in scatola_nera.eliminazioni, con il TRUNCATE vietato.
Le tabelle effimere restano fuori, con il motivo nell'intestazione.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — Le anagrafiche nello storico delle modifiche

**File:**
- Modifica: `supabase/migrations/<version>_scatola_nera_cascate_anagrafiche.sql` (in fondo)
- Test: `__tests__/lib/scatola-nera-cascate-sql.test.ts` (in fondo)

- [ ] **Passo 1: aggiungi i casi in fondo al file di test**

```ts
describe('lo storico delle modifiche copre anagrafiche, note e certificati', () => {
  it('ogni anagrafica modificata lascia la riga com’era', async () => {
    await db.exec(`
      UPDATE public.alunni SET nome = 'Bimbo corretto' WHERE id = '${ALUNNO}';
      UPDATE public.parents SET nome = 'Adulta corretta' WHERE id = '${GENITORE}';
      UPDATE public.utenti SET cognome = 'Corretto' WHERE id = '${DOCENTE}';
      UPDATE public.note_disciplinari SET testo = 'nota corretta' WHERE id = '${NOTA}';
      UPDATE public.certificati_medici SET stato = 'scaduto' WHERE id = '${CERTIFICATO}';
    `)
    const { rows } = await db.query<{ tabella: string; riga_id: string; cambiate: string[] }>(
      'SELECT tabella, riga_id, cambiate FROM scatola_nera.modifiche ORDER BY tabella')
    expect(rows).toEqual([
      { tabella: 'alunni', riga_id: ALUNNO, cambiate: ['nome'] },
      { tabella: 'certificati_medici', riga_id: CERTIFICATO, cambiate: ['stato'] },
      { tabella: 'note_disciplinari', riga_id: NOTA, cambiate: ['testo'] },
      { tabella: 'parents', riga_id: GENITORE, cambiate: ['nome'] },
      { tabella: 'utenti', riga_id: DOCENTE, cambiate: ['cognome'] },
    ])
    // La versione di prima, intera: è quella che il ripristino rimette.
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE prima ->> 'nome' = 'Bimbo'`)).toBe(1)
  })

  it('il «tocco» che cambia solo storico_versione non si copia; una modifica vera sì', async () => {
    await db.exec(`UPDATE public.note_disciplinari SET storico_versione = storico_versione + 1 WHERE id = '${NOTA}'`)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
    await db.exec(`UPDATE public.note_disciplinari
                      SET testo = 'nota corretta', storico_versione = storico_versione + 1
                    WHERE id = '${NOTA}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'note_disciplinari'`)).toBe(1)
  })

  it('i trigger delle modifiche sulle cinque tabelle nuove', async () => {
    expect(await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'scatola_nera_modifiche'
        AND c.relname = ANY(ARRAY['alunni','parents','utenti','note_disciplinari','certificati_medici'])`)).toBe(5)
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts 2>&1 | tail -15
```

Atteso: 3 FAIL nel `describe` nuovo (`scatola_nera.modifiche` vuota, trigger 0). Il secondo caso fallisce sulla seconda attesa, non sulla prima.

- [ ] **Passo 3: aggiungi in fondo a `$MIG_A` la terza sezione**

```sql
-- ── 3. Le anagrafiche nello storico delle modifiche ───────────────────────────
-- Corpo di 20261019215733_scatola_nera_modifiche.sql:107-142 con UNA sola differenza:
-- `storico_versione` entra fra le colonne che da sole non fanno una modifica.
CREATE OR REPLACE FUNCTION scatola_nera.registra_modifica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ruolo   text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user::text);
  v_utente  uuid;
  v_origine text;
BEGIN
  IF current_setting('scatola_nera.senza_storico', true) = 'on' THEN
    RETURN NULL; -- retention, o una riscrittura in blocco dichiarata: nessuna copia, di proposito
  END IF;
  BEGIN
    v_utente := NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_utente := NULL; -- claims assenti o non JSON (pg_cron, pannello): nessun utente, non un errore
  END;
  v_origine := left(COALESCE(NULLIF(current_setting('request.path', true), ''),
                             NULLIF(current_setting('application_name', true), ''),
                             'sconosciuta'), 200);

  INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, soggetti, ruolo, utente, origine)
  SELECT TG_TABLE_NAME, o.r ->> 'id', o.r, d.cambiate, scatola_nera.soggetti_di(o.r), v_ruolo, v_utente, v_origine
    FROM (SELECT to_jsonb(v) AS r FROM vecchie v) o
    JOIN (SELECT to_jsonb(n) AS r FROM nuove n) nn ON nn.r -> 'id' = o.r -> 'id'
    CROSS JOIN LATERAL (
      SELECT array_agg(k ORDER BY k) AS cambiate
        FROM jsonb_object_keys(o.r || nn.r) AS k
       WHERE (o.r -> k) IS DISTINCT FROM (nn.r -> k)
    ) d
   WHERE d.cambiate IS NOT NULL
     AND NOT (d.cambiate <@ ARRAY['storico_versione', 'updated_at', 'aggiornato_il']::text[]);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION scatola_nera.registra_modifica() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- anagrafiche-storico:inizio
    'alunni', 'parents', 'utenti',
    'note_disciplinari', 'certificati_medici'
    -- anagrafiche-storico:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera, storico: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_modifiche ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_modifiche AFTER UPDATE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie NEW TABLE AS nuove '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra_modifica()', t);
  END LOOP;
END $$;
```

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  2 passed`.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql __tests__/lib/scatola-nera-cascate-sql.test.ts
git commit -m "$(cat <<'EOF'
Scatola nera: lo storico delle modifiche copre anagrafiche, note e certificati

alunni, parents, utenti, note_disciplinari e certificati_medici lasciano la riga
com'era per 90 giorni. Un UPDATE che cambia solo storico_versione (il tocco di una
presa visione firmata) non si copia, come già updated_at.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — Le bonifiche accendono l'interruttore nella propria transazione

**File:**
- Modifica: `supabase/migrations/<version>_scatola_nera_cascate_anagrafiche.sql` (in fondo)
- Test: `__tests__/lib/scatola-nera-cascate-sql.test.ts` (in fondo)

- [ ] **Passo 1: aggiungi i casi in fondo al file di test**

```ts
describe('le bonifiche accendono l’interruttore nella propria transazione', () => {
  beforeAll(async () => {
    // In produzione i due trigger esistono dal 15/10 (20261015183000_storici_stampe_rettifiche.sql:222
    // e :449); qui li crea il test, sulle funzioni ridefinite dalla migrazione della sessione 3.
    await db.exec(`
      CREATE OR REPLACE TRIGGER storici_oblio_alunno AFTER UPDATE OF anonimizzato_il ON public.alunni
        FOR EACH ROW EXECUTE FUNCTION public.storici_oblio_alunno();
      CREATE OR REPLACE TRIGGER storici_bonifica_chat BEFORE UPDATE OF content ON public.chat_messages
        FOR EACH ROW EXECUTE FUNCTION public.storici_bonifica_chat();
    `)
  })

  it('anonimizzare un alunno toglie revisioni e collegamenti SENZA copiarli', async () => {
    await db.exec(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM public.storici_revisioni WHERE alunno_id = '${ALUNNO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.storici_collegamenti WHERE alunno_id = '${ALUNNO}'`)).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
    // Il battito resta quello di prima, con ON CONFLICT.
    expect(await numero(`SELECT count(*) FROM public.app_log WHERE fingerprint = 'storici-oblio-alunno'`)).toBe(1)
  })

  it('CONTROLLO POSITIVO: nella stessa transazione, dopo la bonifica, una DELETE torna a lasciare la copia', async () => {
    await db.exec(`
      BEGIN;
      UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${ALUNNO}';
      DELETE FROM public.fascicolo_accessi_audit WHERE alunno_id = '${ALUNNO}';
      COMMIT;
    `)
    expect(await perTabella()).toEqual({ fascicolo_accessi_audit: 1 })
  })

  it('correggere il testo di un messaggio toglie la sua revisione senza copiarla', async () => {
    await db.exec(`UPDATE public.chat_messages SET content = 'testo corretto' WHERE id = '${MSG_DOCENTE}'`)
    expect(await numero(`SELECT count(*) FROM public.storici_revisioni WHERE entita_id = '${MSG_DOCENTE}'`)).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
    expect(await numero(`SELECT rettifica_versione FROM public.chat_messages WHERE id = '${MSG_DOCENTE}'`)).toBe(1)
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts 2>&1 | tail -15
```

Atteso: FAIL nel `beforeAll` del `describe` nuovo, `function public.storici_oblio_alunno() does not exist`: le funzioni le crea la sezione che manca.

- [ ] **Passo 3: aggiungi in fondo a `$MIG_A` la quarta sezione**

Se nel Passo 6 del Compito 2 i corpi di produzione erano diversi da quelli qui sotto, parti da quelli e aggiungi solo le tre righe dell'interruttore intorno alle `delete`.

```sql
-- ── 4. Le bonifiche accendono l'interruttore per le sole proprie DELETE ────────
-- Una bonifica cancella una copia storica APPOSTA (il testo di prima di un messaggio
-- corretto, le copie di un alunno anonimizzato): copiarla 90 giorni in scatola la
-- disferebbe. L'interruttore si accende per le due DELETE e torna com'era subito dopo:
-- chi è nella stessa transazione non perde lo storico di quello che fa dopo.

-- Corpo di 20261015183000_storici_stampe_rettifiche.sql:437-446, più l'interruttore.
create or replace function public.storici_bonifica_chat() returns trigger
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_prima text;
begin
  if new.content is distinct from old.content then
    new.rettifica_staff:=null; new.rettifica_staff_il:=null; new.rettifica_staff_da:=null;
    new.rettifica_versione:=old.rettifica_versione+1;
    v_prima := current_setting('scatola_nera.senza_storico', true);
    perform set_config('scatola_nera.senza_storico', 'on', true);
    delete from public.storici_revisioni where modulo='chat' and entita_id=new.id;
    perform set_config('scatola_nera.senza_storico', coalesce(v_prima, 'off'), true);
  end if;
  return new;
end $$;
revoke all on function public.storici_bonifica_chat() from public, anon, authenticated;
grant execute on function public.storici_bonifica_chat() to service_role;

-- Corpo di 20261019223123_battiti_app_log_che_contano.sql:157-176, più l'interruttore.
CREATE OR REPLACE FUNCTION public.storici_oblio_alunno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare v_prima text;
begin
  if new.anonimizzato_il is not null and old.anonimizzato_il is null then
    v_prima := current_setting('scatola_nera.senza_storico', true);
    perform set_config('scatola_nera.senza_storico', 'on', true);
    delete from public.storici_revisioni where alunno_id=new.id;
    delete from public.storici_collegamenti where alunno_id=new.id;
    perform set_config('scatola_nera.senza_storico', coalesce(v_prima, 'off'), true);
    update public.storici_generazioni set scade_il=least(scade_il,now()) where alunni_ids @> array[new.id];
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('info','gdpr','server','Copie storiche del minore invalidate','storici-oblio-alunno',jsonb_build_object('alunno_id',new.id))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    exception when others then raise log 'storici: logging oblio non riuscito [%]',SQLSTATE; end;
  end if;
  return new;
end $$;
REVOKE ALL ON FUNCTION public.storici_oblio_alunno() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_oblio_alunno() TO service_role;
```

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts __tests__/architecture/app-log-battiti-con-conflitto.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  3 passed`. Il lock dei battiti vede la `on conflict` nel corpo ridefinito.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql __tests__/lib/scatola-nera-cascate-sql.test.ts
git commit -m "$(cat <<'EOF'
Scatola nera: le bonifiche delle copie storiche non lasciano copie

storici_bonifica_chat e storici_oblio_alunno accendono senza_storico per le sole
proprie DELETE e lo rimettono com'era: il testo di prima di un messaggio corretto e
le copie di un alunno anonimizzato se ne vanno davvero. Battito invariato.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — L'oblio segue le conversazioni

**File:**
- Modifica: `supabase/migrations/<version>_scatola_nera_cascate_anagrafiche.sql` (in fondo)
- Test: `__tests__/lib/scatola-nera-cascate-sql.test.ts` (in fondo)

- [ ] **Passo 1: aggiungi i casi in fondo al file di test**

```ts
describe('l’oblio segue le conversazioni: chi nomina la persona solo per thread_id', () => {
  it('oblio del genitore: se ne vanno anche il messaggio della docente nella sua conversazione e la sua revisione', async () => {
    await db.exec(`
      DELETE FROM public.storici_revisioni WHERE entita_id = '${MSG_DOCENTE}';
      DELETE FROM public.chat_threads WHERE id IN ('${THREAD}', '${ALTRO_THREAD}');
    `)
    expect(await perTabella()).toEqual({ chat_messages: 3, chat_threads: 2, storici_revisioni: 1 })
    // La regola dei soli `id` e `*_id` ne troverebbe 2 su 4: la conversazione e il messaggio del genitore.
    expect(await numero(
      `SELECT count(*) FROM scatola_nera.eliminazioni WHERE soggetti && ARRAY['${GENITORE}']::uuid[]`)).toBe(2)

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${GENITORE}']::uuid[], 'genitore', 'prova') AS n`)
    expect(rows[0].n).toBe(4)
    // Controllo positivo: l'altra conversazione e il suo messaggio restano.
    expect(await perTabella()).toEqual({ chat_messages: 1, chat_threads: 1 })
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${MSG_ALTRO}'`)).toBe(1)
    expect(await numero(`SELECT righe_dimenticate FROM scatola_nera.oblii WHERE soggetto = '${GENITORE}'`)).toBe(4)
  })

  it('oblio dell’alunno con la conversazione ANCORA VIVA: se ne va la copia del messaggio cancellato della docente', async () => {
    await db.exec(`DELETE FROM public.chat_messages WHERE id IN ('${MSG_DOCENTE}', '${MSG_ALTRO}')`)
    expect(await perTabella()).toEqual({ chat_messages: 2 })

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'alunno', 'prova') AS n`)
    expect(rows[0].n).toBe(1)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${MSG_DOCENTE}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${MSG_ALTRO}'`)).toBe(1)
  })

  it('le modifiche: l’oblio toglie ancora le versioni di prima che nominano la persona', async () => {
    await db.exec(`UPDATE public.parents SET nome = 'Adulta corretta' WHERE id = '${GENITORE}'`)
    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${GENITORE}']::uuid[], 'genitore', 'prova') AS n`)
    expect(rows[0].n).toBe(1)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
  })

  it('solo il servizio chiama l’oblio', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('authenticated', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS anon,
             has_function_privilege('service_role', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS servizio`)
    expect(rows[0]).toEqual({ auth: false, anon: false, servizio: true })
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts 2>&1 | tail -15
```

Atteso: FAIL nei primi due casi (`expected 2 to be 4`, `expected 0 to be 1`): l'oblio della fase 12 guarda solo i `soggetti`. Gli ultimi due passano già e restano come guardia.

- [ ] **Passo 3: aggiungi in fondo a `$MIG_A` la quinta sezione**

```sql
-- ── 5. L'oblio segue le conversazioni ─────────────────────────────────────────
-- Corpo di 20261019215733_scatola_nera_modifiche.sql:248-280, più la regola delle
-- conversazioni. Un messaggio nomina la persona solo per `thread_id`, e la revisione di
-- un messaggio solo per `entita_id`: `soggetti_di` (solo `id` e `*_id`) li vede come uuid
-- qualunque. Le conversazioni della persona si cercano sia fra le copie (cancellate) sia
-- fra le vive; la tabella viva si legge con EXECUTE dietro `to_regclass`.
CREATE OR REPLACE FUNCTION public.scatola_nera_dimentica(p_soggetti uuid[], p_tipo text, p_canale text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_righe     int := 0;
  v_modifiche int := 0;
  v_thread    uuid[] := '{}';
  v_messaggi  uuid[] := '{}';
  v_vivi      uuid[] := '{}';
  v_collegati uuid[] := '{}';
  v_s         uuid;
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('alunno', 'genitore', 'personale', 'altro') THEN
    RAISE EXCEPTION 'scatola_nera_dimentica: tipo % non ammesso', p_tipo USING ERRCODE = '22023';
  END IF;
  IF p_soggetti IS NULL OR cardinality(p_soggetti) = 0 THEN
    RETURN 0;
  END IF;

  -- Le conversazioni che nominano la persona: le copie e le vive.
  SELECT COALESCE(array_agg(DISTINCT (e.riga ->> 'id')::uuid), '{}')
    INTO v_thread
    FROM scatola_nera.eliminazioni e
   WHERE e.tabella = 'chat_threads' AND e.soggetti && p_soggetti;
  IF to_regclass('public.chat_threads') IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(array_agg(t.id), ''{}''::uuid[]) FROM public.chat_threads t '
            'WHERE t.parent_id = ANY ($1) OR t.student_id = ANY ($1) OR t.teacher_id = ANY ($1)'
       INTO v_vivi USING p_soggetti;
    v_thread := v_thread || v_vivi;
  END IF;

  -- I messaggi di quelle conversazioni: le loro revisioni li nominano in `entita_id`.
  SELECT COALESCE(array_agg(DISTINCT (e.riga ->> 'id')::uuid), '{}')
    INTO v_messaggi
    FROM scatola_nera.eliminazioni e
   WHERE e.tabella = 'chat_messages' AND e.soggetti && v_thread;
  IF to_regclass('public.chat_messages') IS NOT NULL AND cardinality(v_thread) > 0 THEN
    EXECUTE 'SELECT COALESCE(array_agg(m.id), ''{}''::uuid[]) FROM public.chat_messages m '
            'WHERE m.thread_id = ANY ($1)'
       INTO v_vivi USING v_thread;
    v_messaggi := v_messaggi || v_vivi;
  END IF;
  v_collegati := v_thread || v_messaggi;

  PERFORM set_config('scatola_nera.manutenzione', 'on', true);
  DELETE FROM scatola_nera.eliminazioni
   WHERE soggetti && p_soggetti
      OR (tabella IN ('chat_messages', 'storici_revisioni') AND soggetti && v_collegati);
  GET DIAGNOSTICS v_righe = ROW_COUNT;
  DELETE FROM scatola_nera.modifiche WHERE soggetti && p_soggetti;
  GET DIAGNOSTICS v_modifiche = ROW_COUNT;
  PERFORM set_config('scatola_nera.manutenzione', 'off', true);

  FOREACH v_s IN ARRAY p_soggetti LOOP
    IF v_s IS NOT NULL THEN
      INSERT INTO scatola_nera.oblii (soggetto, tipo, canale, righe_dimenticate)
      VALUES (v_s, p_tipo, left(p_canale, 200), v_righe + v_modifiche);
    END IF;
  END LOOP;
  RETURN v_righe + v_modifiche;
END $$;
REVOKE ALL ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) TO service_role;

COMMENT ON FUNCTION public.scatola_nera_dimentica(uuid[], text, text) IS
  'Oblio nella scatola nera: toglie da scatola_nera.eliminazioni e da scatola_nera.modifiche le righe che nominano uno di questi uuid (in id o in una colonna *_id), più i messaggi e le revisioni di messaggi delle conversazioni che lo nominano, e scrive un oblio per uuid in scatola_nera.oblii (mai dati). Restituisce le righe tolte. Solo service_role.';

NOTIFY pgrst, 'reload schema';
```

- [ ] **Passo 4: eseguilo e guardalo passare, con i test dell'oblio applicativo**

```bash
npx vitest run __tests__/lib/scatola-nera-cascate-sql.test.ts __tests__/lib/scatola-nera-sql.test.ts __tests__/lib/gdpr-oblio-scatola-nera-alunno.test.ts __tests__/lib/gdpr-oblio-account.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  4 passed`. `src/lib/gdpr/scatola-nera.ts` non cambia: chiama già la funzione per ultima, e la firma è la stessa.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql __tests__/lib/scatola-nera-cascate-sql.test.ts
git commit -m "$(cat <<'EOF'
Scatola nera: l'oblio segue le conversazioni

scatola_nera_dimentica toglie anche i messaggi delle conversazioni che nominano la
persona (che la nominano solo per thread_id) e le revisioni di quei messaggi (per
entita_id), con le conversazioni cancellate o ancora vive. Firma invariata.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8 — Seconda migrazione: il registro di protocollo nella scatola nera (T4)

**File:**
- Crea: `supabase/migrations/<version>_scatola_nera_protocollo.sql`
- Modifica: `__tests__/lib/protocollo-elimina-sql.test.ts:52-56`
- Test: `__tests__/lib/scatola-nera-protocollo-sql.test.ts`

- [ ] **Passo 1: lo schema del test che c'è già prende le tre colonne del percorso**

In `__tests__/lib/protocollo-elimina-sql.test.ts` sostituisci:

```ts
    CREATE TABLE public.protocolli (
      id uuid PRIMARY KEY,
      file_originale text,
      file_timbrato text
    );
```

con:

```ts
    -- scuola_id, anno e numero dalla sessione 3 della seconda serie: la funzione ne ricava il
    -- prefisso delle versioni. Qui restano NULL e lo Storage non c'è: si provano i soli percorsi
    -- della registrazione, come nel database della CI.
    CREATE TABLE public.protocolli (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      anno int,
      numero int,
      file_originale text,
      file_timbrato text
    );
```

```bash
npx vitest run __tests__/lib/protocollo-elimina-sql.test.ts 2>&1 | tail -4
```

Atteso: `Test Files  1 passed` (la definizione in vigore è ancora quella del 10/10, che le colonne nuove non le legge).

- [ ] **Passo 2: scrivi il test nuovo (rosso)**

Crea `__tests__/lib/scatola-nera-protocollo-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * T4 · IL REGISTRO DI PROTOCOLLO NELLA SCATOLA NERA («copia silenziosa», robustezza seconda serie,
 * sessione 3), PROVATO SU UN POSTGRES VERO.
 *
 * Le decisioni #6 e #26 del registro («nessuna traccia applicativa») restano: qui non c'è nessun
 * log. Una registrazione eliminata e i suoi allegati restano 90 giorni in
 * `scatola_nera.eliminazioni`, una registrazione rettificata lascia la versione di prima in
 * `scatola_nera.modifiche`, e `protocollo_elimina` restituisce anche i documenti sostituiti dalle
 * rettifiche, che la route toglie dal bucket con l'API dello Storage. Lo Storage è ridotto alle due
 * colonne che la funzione legge. Le WORM del registro non servono qui: le prova
 * `protocollo-elimina-sql.test.ts`. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
  if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, file), 'utf8')
}
const ELIMINAZIONI = migrazione('_scatola_nera_registro_eliminazioni.sql')
const MODIFICHE = migrazione('_scatola_nera_modifiche.sql')
const PROTOCOLLO = migrazione('_scatola_nera_protocollo.sql')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const PROT = 'b0000000-0000-4000-8000-000000000001'
const ALTRO = 'b0000000-0000-4000-8000-000000000002'
/** Lo stesso formato di `istanteVersione` (`src/lib/protocolli/store.ts`): UTC, 17 cifre. */
const ISTANTE = '20261021103015123'

let db: PGlite

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function codiceErrore(sql: string): Promise<string | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'errore'
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL, evento text NOT NULL, sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL, fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1, visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE SCHEMA storage;
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL
    );

    CREATE TABLE public.protocolli (
      id uuid PRIMARY KEY, scuola_id uuid NOT NULL, anno int NOT NULL, numero int NOT NULL,
      oggetto text, file_originale text, file_timbrato text
    );
    -- Il freno della fase 7: RESTRICT al posto di CASCADE.
    CREATE TABLE public.protocolli_allegati (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      protocollo_id uuid NOT NULL REFERENCES public.protocolli(id) ON DELETE RESTRICT,
      path text NOT NULL
    );
  `)
  await db.exec(ELIMINAZIONI)
  await db.exec(MODIFICHE)
  await db.exec(PROTOCOLLO)
  await db.exec(PROTOCOLLO) // idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    SET session_replication_role = replica;
    DELETE FROM public.protocolli_allegati;
    DELETE FROM public.protocolli;
    DELETE FROM storage.objects;
    DELETE FROM scatola_nera.eliminazioni;
    DELETE FROM scatola_nera.modifiche;
    DELETE FROM public.app_log;
    SET session_replication_role = DEFAULT;

    INSERT INTO public.protocolli (id, scuola_id, anno, numero, oggetto, file_originale, file_timbrato) VALUES
      ('${PROT}', '${SEDE}', 2026, 1, 'Oggetto di prova',
       '${SEDE}/2026/0000001-originale.pdf', '${SEDE}/2026/0000001-timbrato.pdf'),
      ('${ALTRO}', '${SEDE}', 2026, 10, 'Altro oggetto', '${SEDE}/2026/0000010-originale.pdf', NULL);
    INSERT INTO public.protocolli_allegati (protocollo_id, path) VALUES
      ('${PROT}', '${SEDE}/2026/0000001-allegati/1-a.pdf'),
      ('${PROT}', '${SEDE}/2026/0000001-allegati/2-b.pdf'),
      ('${ALTRO}', '${SEDE}/2026/0000010-allegati/1-c.pdf');
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('protocollo', '${SEDE}/2026/0000001-versioni/${ISTANTE}-0000001-originale.pdf'),
      ('protocollo', '${SEDE}/2026/0000010-versioni/${ISTANTE}-0000010-originale.pdf'),
      ('altro_bucket', '${SEDE}/2026/0000001-versioni/${ISTANTE}-0000001-originale.pdf');
  `)
})

describe('protocollo nella scatola nera — eliminazioni', () => {
  it('eliminare una registrazione: registrazione e allegati restano in scatola, nella stessa transazione', async () => {
    await db.query(`SELECT public.protocollo_elimina('${PROT}')`)
    const { rows } = await db.query<{ tabella: string; n: number }>(
      'SELECT tabella, count(*)::int AS n FROM scatola_nera.eliminazioni GROUP BY 1 ORDER BY 1')
    expect(rows).toEqual([
      { tabella: 'protocolli', n: 1 },
      { tabella: 'protocolli_allegati', n: 2 },
    ])
    expect(await numero('SELECT count(DISTINCT transazione) FROM scatola_nera.eliminazioni')).toBe(1)
    // Controllo positivo: l'altra registrazione è viva, con il suo allegato.
    expect(await numero(`SELECT count(*) FROM public.protocolli WHERE id = '${ALTRO}'`)).toBe(1)
    expect(await numero('SELECT count(*) FROM public.protocolli_allegati')).toBe(1)
  })

  it('restituisce anche le versioni dei documenti rettificati: solo quelle della registrazione, solo nel bucket del protocollo', async () => {
    const { rows } = await db.query<{ p: string[] }>(`SELECT public.protocollo_elimina('${PROT}') AS p`)
    expect([...rows[0].p].sort()).toEqual([
      `${SEDE}/2026/0000001-allegati/1-a.pdf`,
      `${SEDE}/2026/0000001-allegati/2-b.pdf`,
      `${SEDE}/2026/0000001-originale.pdf`,
      `${SEDE}/2026/0000001-timbrato.pdf`,
      `${SEDE}/2026/0000001-versioni/${ISTANTE}-0000001-originale.pdf`,
    ].sort())
    // La funzione LEGGE lo Storage e non lo tocca: i file li toglie la route con l'API.
    expect(await numero('SELECT count(*) FROM storage.objects')).toBe(3)
  })

  it('TRUNCATE vietato sulle due tabelle del registro', async () => {
    expect(await codiceErrore('TRUNCATE public.protocolli_allegati')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM public.protocolli_allegati')).toBe(3)
  })
})

describe('protocollo nella scatola nera — modifiche e permessi', () => {
  it('una rettifica lascia la registrazione com’era', async () => {
    await db.exec(`UPDATE public.protocolli SET oggetto = 'Oggetto corretto' WHERE id = '${PROT}'`)
    const { rows } = await db.query<{ tabella: string; cambiate: string[]; prima: Record<string, unknown> }>(
      'SELECT tabella, cambiate, prima FROM scatola_nera.modifiche')
    expect(rows).toHaveLength(1)
    expect(rows[0].tabella).toBe('protocolli')
    expect(rows[0].cambiate).toEqual(['oggetto'])
    expect(rows[0].prima.oggetto).toBe('Oggetto di prova')
  })

  it('i trigger: due di eliminazione, due di TRUNCATE vietato, due di modifica', async () => {
    for (const nome of ['scatola_nera_eliminazioni', 'scatola_nera_no_truncate', 'scatola_nera_modifiche']) {
      expect(
        await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
          WHERE g.tgname = '${nome}' AND c.relname IN ('protocolli', 'protocolli_allegati')`),
        nome,
      ).toBe(2)
    }
  })

  it('solo il servizio chiama protocollo_elimina', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('authenticated', 'public.protocollo_elimina(uuid)', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'public.protocollo_elimina(uuid)', 'EXECUTE') AS anon,
             has_function_privilege('service_role', 'public.protocollo_elimina(uuid)', 'EXECUTE') AS servizio`)
    expect(rows[0]).toEqual({ auth: false, anon: false, servizio: true })
  })
})
```

```bash
npx vitest run __tests__/lib/scatola-nera-protocollo-sql.test.ts 2>&1 | tail -6
```

Atteso: FAIL, `Error: migrazione *_scatola_nera_protocollo.sql non trovata`.

- [ ] **Passo 3: crea la migrazione con la sola intestazione, e guarda il rosso vero**

```bash
MIG_B="supabase/migrations/$(date -u +%Y%m%d%H%M%S)_scatola_nera_protocollo.sql"
echo "$MIG_B"
```

La version deve essere posteriore a quella di `$MIG_A` (`ls supabase/migrations | tail -3`). Scrivi in `$MIG_B`:

```sql
-- =============================================================================
-- IL REGISTRO DI PROTOCOLLO NELLA SCATOLA NERA — «copia silenziosa» (T4)
-- robustezza, seconda serie, sessione 3
--
-- Problema D6 del rapporto del 20/10 (`docs/analisi-robustezza-2026-10-20.md:539-552`): una
-- registrazione eliminata per errore si recuperava solo dal dump della notte, e una rettifica
-- sovrascriveva il documento. Decisione T4 del titolare (20/10): copia silenziosa. Le decisioni
-- #6 e #26 del registro (`docs/superpowers/specs/2026-07-12-registro-protocolli-design.md:19,39`,
-- «nessuna traccia applicativa») RESTANO: nessun logScrittura, nessun log, nessun badge. La
-- copia sta solo nel database (qui) e nello Storage (la rettifica, nel codice).
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `protocolli` e `protocolli_allegati` sotto gli stessi trigger della scatola: copia di
--    ogni riga eliminata (90 giorni), copia della riga com'era a ogni modifica (90 giorni),
--    TRUNCATE vietato. Il trigger delle modifiche su `protocolli_allegati` non scatterà mai
--    (il WORM rifiuta ogni UPDATE degli allegati): c'è perché la decisione dice «entrambe».
--  · `protocollo_elimina` restituisce anche i documenti sostituiti dalle rettifiche, che stanno
--    in `<sede>/<anno>/<numero a 7 cifre>-versioni/` nel bucket `protocollo`
--    (`pathDefinitivi(...).prefissoVersioni` in `src/lib/protocolli/store.ts`): decisione #2,
--    eliminazione totale, file compresi. La funzione LEGGE `storage.objects` e basta; i file li
--    toglie la route con l'API dello Storage (lock `storage-delete-vietata-in-sql`).
--
-- ─── IL DATABASE DELLA CI ────────────────────────────────────────────────────
-- Non ha `storage.objects`: la funzione restituisce i soli percorsi della registrazione.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger g join pg_class c on c.oid = g.tgrelid
--    where c.relname in ('protocolli','protocolli_allegati') and g.tgname like 'scatola_nera_%';  -- 6
--   select prosrc ~ '-versioni/' from pg_proc where oid = 'public.protocollo_elimina(uuid)'::regprocedure; -- true
--   select has_function_privilege('authenticated', 'public.protocollo_elimina(uuid)', 'EXECUTE');      -- false
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     foreach t in array array['protocolli','protocolli_allegati'] loop
--       execute format('drop trigger if exists scatola_nera_eliminazioni on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_no_truncate on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_modifiche on public.%I', t);
--     end loop; end $$;
--   Rieseguire public.protocollo_elimina da 20261010223849_eliminazioni_in_ordine.sql:238-268
--   (oppure il corpo di produzione salvato nel Passo 0). Le versioni già nel bucket restano:
--   le elenca la query del «Ritorno indietro» del piano della sessione 3.
-- =============================================================================
```

```bash
npx vitest run __tests__/lib/scatola-nera-protocollo-sql.test.ts 2>&1 | tail -12
```

Atteso: FAIL in tutti i casi tranne il TRUNCATE assente (`function public.protocollo_elimina(unknown) does not exist`, trigger 0).

- [ ] **Passo 4: aggiungi in fondo a `$MIG_B` il corpo**

Se il corpo di produzione di `protocollo_elimina` letto nel Passo 6 del Compito 2 era diverso da `20261010223849_eliminazioni_in_ordine.sql:238-264`, parti da quello e applica le stesse due aggiunte (il prefisso nella prima lettura, il blocco che legge lo Storage).

```sql
-- ── 1. Le due tabelle del registro sotto i trigger della scatola ──────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- tabelle-protocollo:inizio
    'protocolli', 'protocolli_allegati'
    -- tabelle-protocollo:fine
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'scatola nera, protocollo: public.% assente, saltata', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_eliminazioni ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_eliminazioni AFTER DELETE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_no_truncate ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_no_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.vieta_truncate()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_modifiche ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER scatola_nera_modifiche AFTER UPDATE ON public.%I '
      'REFERENCING OLD TABLE AS vecchie NEW TABLE AS nuove '
      'FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra_modifica()', t);
  END LOOP;
END $$;

-- ── 2. protocollo_elimina restituisce anche le versioni ───────────────────────
-- Corpo di 20261010223849_eliminazioni_in_ordine.sql:238-264 con due aggiunte: il prefisso
-- delle versioni letto insieme ai percorsi, e il blocco che legge `storage.objects`.
create or replace function public.protocollo_elimina(p_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paths    text[];
  v_prefisso text;
begin
  select array_remove(
           array[p.file_originale, p.file_timbrato]
           || coalesce(array_agg(a.path) filter (where a.path is not null), '{}'::text[]),
           null),
         p.scuola_id::text || '/' || p.anno::text || '/' || lpad(p.numero::text, 7, '0') || '-versioni/'
    into v_paths, v_prefisso
    from public.protocolli p
    left join public.protocolli_allegati a on a.protocollo_id = p.id
   where p.id = p_id
   group by p.id, p.file_originale, p.file_timbrato, p.scuola_id, p.anno, p.numero;

  if v_paths is null then
    return array[]::text[];
  end if;

  -- T4: i documenti sostituiti da una rettifica se ne vanno con la registrazione. Qui si
  -- LEGGE soltanto: i file li toglie la route con l'API dello Storage.
  if v_prefisso is not null and to_regclass('storage.objects') is not null then
    v_paths := v_paths || coalesce(
      (select array_agg(o.name order by o.name)
         from storage.objects o
        where o.bucket_id = 'protocollo'
          and left(o.name, length(v_prefisso)) = v_prefisso),
      '{}'::text[]);
  end if;

  perform set_config('app.protocollo_admin_delete', 'on', true);
  delete from public.protocolli_allegati where protocollo_id = p_id;
  delete from public.protocolli where id = p_id;
  return v_paths;
end $$;

REVOKE ALL ON FUNCTION public.protocollo_elimina(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protocollo_elimina(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Passo 5: eseguilo e guardalo passare, con i lock che leggono le migrazioni**

```bash
npx vitest run __tests__/lib/scatola-nera-protocollo-sql.test.ts __tests__/lib/protocollo-elimina-sql.test.ts __tests__/architecture/storage-delete-vietata-in-sql.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  6 passed`. `protocollo-elimina-sql.test.ts` ora prova la definizione di `$MIG_B` (è l'ultima che la riscrive) senza Storage: stessi percorsi di prima.

- [ ] **Passo 6: commit**

```bash
git add supabase/migrations/*_scatola_nera_protocollo.sql __tests__/lib/scatola-nera-protocollo-sql.test.ts __tests__/lib/protocollo-elimina-sql.test.ts
git commit -m "$(cat <<'EOF'
Protocollo nella scatola nera: copia silenziosa (T4)

protocolli e protocolli_allegati restano 90 giorni in scatola quando si eliminano o si
modificano; protocollo_elimina restituisce anche i documenti sostituiti dalle
rettifiche, che la route toglie dal bucket. Nessun log: le decisioni #6 e #26 restano.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Codice dell'app e informativa

### Compito 9 — I percorsi delle versioni del protocollo

**File:**
- Modifica: `src/lib/protocolli/store.ts:92-99`
- Test: `__tests__/lib/protocolli-store.test.ts:3-9` e dopo la riga 57

- [ ] **Passo 1: scrivi i casi (rossi)**

In `__tests__/lib/protocolli-store.test.ts` aggiungi `istanteVersione,` all'elenco importato da `@/lib/protocolli/store` (righe 3-9), e subito dopo la chiusura del caso `it('definitivi: scuola/anno/numero a 7 cifre', …)` aggiungi:

```ts
  it('versioni: accanto alla registrazione, istante e nome del file di prima', () => {
    const percorsi = pathDefinitivi('11111111-2222-3333-4444-555555555555', 2026, 42)
    expect(percorsi.prefissoVersioni).toBe('11111111-2222-3333-4444-555555555555/2026/0000042-versioni/')
    expect(
      percorsi.versione('20261021103015123', '11111111-2222-3333-4444-555555555555/2026/0000042-originale.pdf')
    ).toBe('11111111-2222-3333-4444-555555555555/2026/0000042-versioni/20261021103015123-0000042-originale.pdf')
    // Lo stesso prefisso che `protocollo_elimina` ricava in SQL: scuola/anno/numero a 7 cifre + '-versioni/'.
    expect(percorsi.versione('x', 'y.pdf').startsWith(percorsi.prefissoVersioni)).toBe(true)
  })
  it('istanteVersione: UTC al millesimo, 17 cifre, ordinabile come testo', () => {
    expect(istanteVersione(new Date('2026-10-21T10:30:15.123Z'))).toBe('20261021103015123')
    expect(
      istanteVersione(new Date('2026-10-21T10:30:15.124Z')) > istanteVersione(new Date('2026-10-21T10:30:15.123Z'))
    ).toBe(true)
  })
```

```bash
npx vitest run __tests__/lib/protocolli-store.test.ts 2>&1 | tail -8
```

Atteso: FAIL, `istanteVersione is not a function` e `expected undefined to be '…-versioni/'`.

- [ ] **Passo 2: il codice**

In `src/lib/protocolli/store.ts` sostituisci le righe 92-99 con:

```ts
export function pathDefinitivi(scuolaId: string, anno: number, numero: number) {
  const base = `${scuolaId}/${anno}/${String(numero).padStart(7, '0')}`
  return {
    originale: (ext: string) => `${base}-originale.${ext}`,
    timbrato: `${base}-timbrato.pdf`,
    allegato: (ordine: number, nome: string) => `${base}-allegati/${ordine}-${slugNomeFile(nome)}`,
    /**
     * T4 (robustezza, seconda serie, sessione 3): il documento sostituito da una rettifica non
     * si sovrascrive senza copia. Resta qui, accanto alla registrazione, e se ne va con lei:
     * `protocollo_elimina` restituisce anche gli oggetti sotto questo prefisso, ricavato in SQL
     * allo stesso modo (scuola/anno/numero a 7 cifre + `-versioni/`).
     */
    prefissoVersioni: `${base}-versioni/`,
    versione: (istante: string, percorsoAttuale: string) =>
      `${base}-versioni/${istante}-${percorsoAttuale.slice(percorsoAttuale.lastIndexOf('/') + 1)}`,
  }
}

/** L'istante di una versione, in UTC al millesimo: `YYYYMMDDHHMMSSmmm` (17 cifre, ordinabile). */
export function istanteVersione(quando: Date): string {
  return quando.toISOString().replace(/[-:.TZ]/g, '')
}
```

- [ ] **Passo 3: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/protocolli-store.test.ts 2>&1 | tail -4
```

Atteso: `Test Files  1 passed`.

- [ ] **Passo 4: commit**

```bash
git add src/lib/protocolli/store.ts __tests__/lib/protocolli-store.test.ts
git commit -m "$(cat <<'EOF'
Protocollo: i percorsi delle versioni dei documenti rettificati

pathDefinitivi prende prefissoVersioni e versione; istanteVersione dà l'istante UTC
a 17 cifre. Lo stesso prefisso che protocollo_elimina ricava in SQL.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 10 — La rettifica conserva il documento di prima

**File:**
- Modifica: `src/app/api/admin/protocolli/rettifica/route.ts:8-16` e `:176-179`
- Test: `__tests__/api/protocolli-rettifica-versioni.test.ts`

- [ ] **Passo 1: scrivi il test (rosso)**

Crea `__tests__/api/protocolli-rettifica-versioni.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// T4 (robustezza, seconda serie, sessione 3): la rettifica che SOSTITUISCE il documento copia
// quello di prima in `<sede>/<anno>/<numero>-versioni/` PRIMA di sovrascriverlo. Se la copia non
// riesce, la rettifica non parte e niente è cambiato. Nessun logScrittura e nessuna riga di log
// nuova sul successo: le decisioni #6 e #26 restano. Solo dati finti.

const h = vi.hoisted(() => ({
  record: {
    id: '11111111-2222-3333-4444-555555555555',
    scuola_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    anno: 2026,
    numero: 3,
    tipo: 'ingresso',
    data_registrazione: '2026-07-12T08:00:00Z',
    annullata_at: null as string | null,
    file_originale: 'aaaaaaaa-0000-4000-8000-00000000000a/2026/0000003-originale.pdf',
    file_timbrato: 'aaaaaaaa-0000-4000-8000-00000000000a/2026/0000003-timbrato.pdf',
  },
  operazioni: [] as { op: 'copy' | 'upload' | 'remove'; bucket: string; da?: string; a?: string; percorso?: string }[],
  erroreCopia: null as { message: string } | null,
  rpc: vi.fn(),
  logScrittura: vi.fn(),
  errori: [] as { contesto: Record<string, unknown>; err: unknown }[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => ({
    user: { id: 'u-1', role: 'admin', scuola_id: 'aaaaaaaa-0000-4000-8000-00000000000a' },
  })),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/protocolli/timbro', () => ({
  applicaSegnatura: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
  immagineInPdf: vi.fn(async (b: Uint8Array) => b),
}))
vi.mock('@/lib/protocolli/assets', () => ({ logoLightBytes: () => new Uint8Array() }))
vi.mock('@/lib/protocolli/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/protocolli/server')>()),
  scaricaProtocolloBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])),
  denominazioneScuola: vi.fn(async () => 'Sede di prova'),
  eliminaStagingBestEffort: vi.fn(async () => undefined),
  firmaDownload: vi.fn(async () => 'https://firmato.test'),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: (contesto: Record<string, unknown>, err: unknown) => {
    h.errori.push({ contesto, err })
  },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from: (tabella: string) => {
      const esito = () =>
        tabella === 'protocolli'
          ? { data: h.record, error: null }
          : tabella === 'utenti_scuole'
            ? { data: [], error: null }
            : { data: null, error: null }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'or', 'order', 'range', 'limit']) {
        b[m] = () => b
      }
      b.maybeSingle = async () => esito()
      b.single = async () => esito()
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito()).then(ok, ko)
      return b
    },
    rpc: h.rpc,
    storage: {
      from: (bucket: string) => ({
        copy: async (da: string, a: string) => {
          h.operazioni.push({ op: 'copy', bucket, da, a })
          return h.erroreCopia ? { data: null, error: h.erroreCopia } : { data: { path: a }, error: null }
        },
        upload: async (percorso: string) => {
          h.operazioni.push({ op: 'upload', bucket, percorso })
          return { data: { path: percorso }, error: null }
        },
        remove: async (percorsi: string[]) => {
          h.operazioni.push({ op: 'remove', bucket, percorso: percorsi.join(',') })
          return { data: [], error: null }
        },
      }),
    },
  })),
}))

import { POST } from '@/app/api/admin/protocolli/rettifica/route'

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ORIGINALE = `${SEDE}/2026/0000003-originale.pdf`
const TIMBRATO = `${SEDE}/2026/0000003-timbrato.pdf`
const SOSTITUZIONE = {
  id: '11111111-2222-3333-4444-555555555555',
  stagingPath: 'staging/0f0f0f0f-lettera.pdf',
  nomeFile: 'lettera.pdf',
  mime: 'application/pdf',
}

const richiesta = (body: unknown) =>
  new Request('http://localhost/api/admin/protocolli/rettifica', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  h.operazioni = []
  h.erroreCopia = null
  h.errori = []
  h.eventi = []
  h.logScrittura.mockClear()
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({ data: { ...h.record }, error: null })
})

describe('POST /api/admin/protocolli/rettifica — il documento di prima resta in versioni (T4)', () => {
  it('sostituendo il documento, copia l’originale di prima in «-versioni/» PRIMA di caricare il nuovo', async () => {
    const res = await POST(richiesta(SOSTITUZIONE) as never)

    expect(res.status).toBe(200)
    const copie = h.operazioni.filter((o) => o.op === 'copy')
    expect(copie).toHaveLength(1)
    expect(copie[0].bucket).toBe('protocollo')
    expect(copie[0].da).toBe(ORIGINALE)
    expect(copie[0].a).toMatch(new RegExp(`^${SEDE}/2026/0000003-versioni/\\d{17}-0000003-originale\\.pdf$`))
    const copia = h.operazioni.findIndex((o) => o.op === 'copy')
    const primoUpload = h.operazioni.findIndex((o) => o.op === 'upload')
    expect(primoUpload).toBeGreaterThan(copia)
    // Controllo positivo: il documento nuovo è caricato davvero, originale e timbrato.
    expect(h.operazioni.filter((o) => o.op === 'upload').map((o) => o.percorso)).toEqual([ORIGINALE, TIMBRATO])
  })

  it('copia non riuscita → 500, nessun caricamento, nessuna rpc: la rettifica non parte', async () => {
    h.erroreCopia = { message: 'The resource was not found' }
    const res = await POST(richiesta(SOSTITUZIONE) as never)

    expect(res.status).toBe(500)
    expect(h.operazioni.filter((o) => o.op === 'upload')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
    expect((await res.json()).error).toContain('la rettifica non è stata applicata')
    // Il guasto si registra dal catch che c'era già, senza percorsi né numeri della registrazione.
    const riga = h.errori.find((e) => e.contesto.operazione === 'admin/protocolli/rettifica:POST')
    expect(riga).toBeDefined()
    for (const e of h.errori) {
      expect(String((e.err as Error | null)?.message ?? '')).not.toContain('0000003')
    }
  })

  it('rettifica solo testuale: nessuna copia nello Storage (la versione di prima la tiene il database)', async () => {
    const res = await POST(richiesta({ id: SOSTITUZIONE.id, oggetto: 'Oggetto corretto' }) as never)

    expect(res.status).toBe(200)
    expect(h.operazioni.filter((o) => o.op === 'copy')).toHaveLength(0)
  })

  it('decisione #26: nessun logScrittura e nessuna riga «protocolli» sul successo', async () => {
    await POST(richiesta(SOSTITUZIONE) as never)

    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.eventi.filter((e) => e.evento === 'protocolli')).toHaveLength(0)
  })
})
```

```bash
npx vitest run __tests__/api/protocolli-rettifica-versioni.test.ts 2>&1 | tail -10
```

Atteso: FAIL nei primi due casi (`expected [] to have a length of 1`; nel secondo il caricamento parte e la risposta è 200). Gli altri due passano già e restano come guardia.

- [ ] **Passo 2: il codice**

In `src/app/api/admin/protocolli/rettifica/route.ts`, nell'import da `@/lib/protocolli/store` (righe 8-16), aggiungi `istanteVersione,` dopo `estensioneDaMime,`.

Poi sostituisci:

```ts
        const percorsi = pathDefinitivi(record.scuola_id, record.anno, record.numero)
        const nuovoOriginale = percorsi.originale(estensioneDaMime(mime))
        const storage = supabase.storage.from(PROTOCOLLO_BUCKET)
        const upOrig = await storage.upload(nuovoOriginale, bytes, { contentType: mime, upsert: true })
```

con:

```ts
        const percorsi = pathDefinitivi(record.scuola_id, record.anno, record.numero)
        const nuovoOriginale = percorsi.originale(estensioneDaMime(mime))
        const storage = supabase.storage.from(PROTOCOLLO_BUCKET)
        // T4 (robustezza, seconda serie, sessione 3 — «copia silenziosa»): il documento di PRIMA
        // non si sovrascrive senza copia. Si copia accanto alla registrazione (`-versioni/`) PRIMA
        // di caricare il nuovo, e se ne va con lei (`protocollo_elimina`). Se la copia non riesce,
        // la rettifica non parte e niente è cambiato. Nessuna riga di log nuova e nessun
        // logScrittura sul successo: le decisioni #6 e #26 restano. Il fallimento esce dal `catch`
        // che c'era già, con un messaggio fisso: né percorsi né numeri della registrazione.
        // Il timbrato non si copia: si rigenera dall'originale con la stessa segnatura.
        if (record.file_originale) {
          const copia = await storage.copy(
            record.file_originale,
            percorsi.versione(istanteVersione(new Date()), record.file_originale)
          )
          if (copia.error) {
            throw Object.assign(
              new Error('Conservazione della versione precedente non riuscita: la rettifica non è stata applicata', {
                cause: copia.error,
              }),
              { status: 500 }
            )
          }
        }
        const upOrig = await storage.upload(nuovoOriginale, bytes, { contentType: mime, upsert: true })
```

- [ ] **Passo 3: eseguilo e guardalo passare, con i test del protocollo che c'erano**

```bash
npx vitest run __tests__/api/protocolli-rettifica-versioni.test.ts __tests__/api/protocolli-route.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/logging-coverage.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  4 passed`. Nessuna risposta d'errore nuova scritta a mano (`errori-con-codice` conta le `NextResponse.json({ error })`: il messaggio passa da `rispostaErroreProtocollo`, che c'era già).

- [ ] **Passo 4: commit**

```bash
git add src/app/api/admin/protocolli/rettifica/route.ts __tests__/api/protocolli-rettifica-versioni.test.ts
git commit -m "$(cat <<'EOF'
Protocollo: la rettifica conserva il documento di prima (T4)

Prima di caricare il documento nuovo, quello di prima si copia in
<sede>/<anno>/<numero>-versioni/. Se la copia non riesce la rettifica non parte.
Nessun logScrittura e nessun log nuovo sul successo: decisioni #6 e #26.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 11 — La cancellazione di un avviso conta le risposte che porta via

**File:**
- Modifica: `src/app/api/avvisi/[id]/route.ts:826-827` e `:884-890`
- Test: `__tests__/api/avvisi-orfani-cancellazione.test.ts:51-71`, `:128-138`, `:185-202`, dopo `:265`

- [ ] **Passo 1: il finto PostgREST impara a contare le risposte**

In `__tests__/api/avvisi-orfani-cancellazione.test.ts`:

nel blocco `vi.hoisted` (righe 51-71), dopo `erroreRemove: null as { message: string } | null,` aggiungi:

```ts
    /** Risposte dei genitori che la cancellazione porta via in CASCADE (il conteggio del log). */
    risposte: 4 as number,
    erroreContaRisposte: null as { code: string; message: string } | null,
```

in `esegui()`, subito prima di `if (tabella === 'utenti') return …` (riga 138), aggiungi:

```ts
                // Il CONTEGGIO delle risposte, prima della cancellazione: `head: true` → solo `count`.
                // Filtrato su `sel === 'id'`: la lettura del PUT (`numero_partecipanti, …`) resta com'era.
                if (tabella === 'avvisi_risposte' && q.sel === 'id') {
                    return h.erroreContaRisposte
                        ? { data: null, count: null, error: h.erroreContaRisposte }
                        : { data: null, count: h.risposte, error: null }
                }
```

nel `beforeEach` (righe 185-202), dopo `h.erroreRemove = null` aggiungi:

```ts
    h.risposte = 4
    h.erroreContaRisposte = null
```

- [ ] **Passo 2: scrivi i casi (rossi)**

Nel primo `describe` (`DELETE /api/avvisi/[id] — le notifiche non restano orfane`), dopo il caso `IL SUCCESSO SI LOGGA, col numero di notifiche ritirate` (riga 265), aggiungi:

```ts
    it('le risposte dei genitori si CONTANO prima di cancellare, e il successo dice quante ne sono andate via', async () => {
        h.risposte = 5
        const res = await AVVISO_DELETE(req(), ctx())

        expect(res.status).toBe(200)
        const conta = h.operazioni.findIndex((o) => o.tabella === 'avvisi_risposte' && o.tipo === 'select')
        const cancella = h.operazioni.findIndex((o) => o.tabella === 'avvisi' && o.tipo === 'delete')
        expect(conta).toBeGreaterThanOrEqual(0)
        expect(conta).toBeLessThan(cancella)
        expect(h.operazioni[conta].filtri).toEqual({ avviso_id: AVVISO_ID })
        const riga = h.eventi.find((e) => e.campi.esito === 'cancellato')
        expect(riga!.campi).toMatchObject({ n_risposte_portate_via: 5 })
    })

    it('conteggio delle risposte fallito → 200, riga error col codice, e il successo dice «non contate» (null), non zero', async () => {
        h.erroreContaRisposte = { code: '57014', message: 'canceling statement due to statement timeout' }
        const res = await AVVISO_DELETE(req(), ctx())

        // Una lettura che non decide niente: l'avviso si cancella lo stesso.
        expect(res.status).toBe(200)
        expect(deleteSu('avvisi')).toHaveLength(1)
        const guasto = h.eventi.find((e) => e.campi.esito === 'risposte-non-contate')
        expect(guasto).toBeDefined()
        expect(guasto!.livello).toBe('error')
        expect(JSON.stringify(guasto!.err)).toContain('57014')
        const riga = h.eventi.find((e) => e.campi.esito === 'cancellato')
        expect(riga!.campi.n_risposte_portate_via).toBeNull()
    })
```

```bash
npx vitest run __tests__/api/avvisi-orfani-cancellazione.test.ts 2>&1 | tail -8
```

Atteso: 2 FAIL (`expected -1 to be greater than or equal to 0`; nel secondo nessuna riga `risposte-non-contate`).

- [ ] **Passo 3: il codice**

In `src/app/api/avvisi/[id]/route.ts` sostituisci:

```ts
        // Prima della cancellazione, perché dopo il dato non c'è più.
        const allegato = await percorsoAllegatoArchiviatoAvviso(supabase, id, 'avvisi/[id]:DELETE');
```

con:

```ts
        // Prima della cancellazione, perché dopo il dato non c'è più.
        const allegato = await percorsoAllegatoArchiviatoAvviso(supabase, id, 'avvisi/[id]:DELETE');

        // LE RISPOSTE DEI GENITORI (adesioni, autorizzazioni) se ne vanno con l'avviso, in
        // CASCADE (`avvisi_risposte_avviso_id_fkey`). Dalla sessione 3 della seconda serie di
        // robustezza restano 90 giorni in `scatola_nera.eliminazioni`; il log di successo dice
        // QUANTE, così chi deve recuperarle sa che c'erano. Si contano prima: dopo non c'è più
        // niente da contare. Un conteggio fallito non ferma la cancellazione (è una lettura che
        // non decide niente): il numero resta `null`, che non è «zero».
        let nRisposte: number | null = null;
        const { count: risposteContate, error: errContaRisposte } = await supabase
            .from('avvisi_risposte')
            .select('id', { count: 'exact', head: true })
            .eq('avviso_id', id);
        if (errContaRisposte) {
            guastoLetturaAccessoria('avvisi', 'avvisi/[id]:DELETE', 'risposte-non-contate', errContaRisposte);
        } else {
            nRisposte = typeof risposteContate === 'number' ? risposteContate : null;
        }
```

e nel log di successo sostituisci:

```ts
            n_notifiche_rimosse: nNotifiche,
            n_allegati_rimossi: nAllegati,
        });
```

con:

```ts
            n_notifiche_rimosse: nNotifiche,
            n_allegati_rimossi: nAllegati,
            n_risposte_portate_via: nRisposte,
        });
```

`guastoLetturaAccessoria` è già importato (riga 35).

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/api/avvisi __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -6
```

Atteso: tutti verdi (`Test Files … passed`). Il primo filtro prende tutti i file `__tests__/api/avvisi-*.test.ts`: tre di loro (`avvisi-modifica-solo-autore`, `avvisi-promemoria-adesioni`, `avvisi-scope-postgrest`) chiamano anche il DELETE con un finto PostgREST loro. Se uno di quei finti non sa rispondere a `.select('id', { count: 'exact', head: true }).eq(…)`, gli si insegna a restituire `{ data: null, count: 0, error: null }` per `avvisi_risposte`: è il test che va allineato, non il conteggio che va tolto.

- [ ] **Passo 5: commit**

```bash
git add 'src/app/api/avvisi/[id]/route.ts' __tests__/api/avvisi-orfani-cancellazione.test.ts
git commit -m "$(cat <<'EOF'
Avvisi: la cancellazione dice quante risposte dei genitori porta via

Le risposte si contano prima della cancellazione (vanno via in cascata e restano 90
giorni nella scatola nera) e il log di successo porta n_risposte_portate_via. Un
conteggio fallito è una riga error risposte-non-contate e un null, mai uno zero.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 12 — L'informativa lo dice

**File:**
- Modifica: `src/app/privacy/page.tsx:826-854`
- Modifica: `src/lib/legal/versioni.ts:252-268`
- Test: `__tests__/architecture/pagine-legali.test.ts` (voce nuova dopo la riga 419)

- [ ] **Passo 1: il testo**

In `src/app/privacy/page.tsx`, nel commento JSX che precede la voce (righe 826-840), dopo la riga `tabelle resta 90 giorni in \`scatola_nera.modifiche\`, con lo stesso oblio.` aggiungi:

```tsx
                Dalla sessione 3 della seconda serie di robustezza la stessa copia tiene anche ciò
                che una cancellazione porta via in cascata (messaggi della chat, risposte agli
                avvisi, prese visione delle note, storico delle classi, copie storiche, registro
                degli accessi al fascicolo) e il registro di protocollo; lo storico delle modifiche
                copre anche anagrafiche, note disciplinari, certificati medici e protocollo. Il
                documento di protocollo sostituito da una rettifica resta accanto alla
                registrazione. Il protocollo non si dimentica: è un registro tenuto per legge.
```

Poi sostituisci la voce (righe 841-854):

```tsx
              <li>
                <strong>copie tecniche di sicurezza</strong>: una registrazione cancellata
                dall&rsquo;archivio della scuola (anagrafica, frequenza, valutazioni, pagamenti)
                resta in una copia tecnica protetta per <strong>novanta giorni</strong>, al solo
                scopo di rimediare a una cancellazione sbagliata, e scaduti quelli è distrutta.
                Lo stesso vale per la versione precedente di una frequenza, di una valutazione o
                di un pagamento modificati, per rimediare a una modifica sbagliata;
                una richiesta di cancellazione (diritto all&rsquo;oblio) la toglie subito anche da
                lì. L&rsquo;intero archivio è inoltre copiato ogni notte, cifrato, su server
                nell&rsquo;Unione europea: le copie giornaliere si conservano{' '}
                <strong>trenta giorni</strong> e una copia al mese <strong>dodici mesi</strong>. Se
                una copia dovesse servire, le cancellazioni chieste dopo la sua data vengono
                riapplicate;
              </li>
```

con:

```tsx
              <li>
                <strong>copie tecniche di sicurezza</strong>: una registrazione cancellata
                dall&rsquo;archivio della scuola (anagrafica, frequenza, valutazioni, pagamenti,
                messaggi della chat, risposte agli avvisi, prese visione delle note, storico delle
                classi, registro degli accessi al fascicolo, registro di protocollo) resta in una
                copia tecnica protetta per <strong>novanta giorni</strong>, al solo scopo di
                rimediare a una cancellazione sbagliata, e scaduti quelli è distrutta.
                Lo stesso vale per la versione precedente di una frequenza, di una valutazione, di
                un pagamento, di un&rsquo;anagrafica, di una nota disciplinare, di un certificato
                medico o di una registrazione di protocollo modificati, per rimediare a una
                modifica sbagliata. Il documento di protocollo sostituito con una rettifica resta
                conservato insieme alla registrazione, e se ne va con lei;
                una richiesta di cancellazione (diritto all&rsquo;oblio) la toglie subito anche da
                lì, salvo il registro di protocollo, che la scuola conserva per obbligo di legge.
                L&rsquo;intero archivio è inoltre copiato ogni notte, cifrato, su server
                nell&rsquo;Unione europea: le copie giornaliere si conservano{' '}
                <strong>trenta giorni</strong> e una copia al mese <strong>dodici mesi</strong>. Se
                una copia dovesse servire, le cancellazioni chieste dopo la sua data vengono
                riapplicate;
              </li>
```

La parola «automaticamente» non c'è, e non deve esserci: la migrazione la applica l'integrazione al merge (lock `informativa-conservazione-dichiarata`).

- [ ] **Passo 2: il lock dell'impronta diventa rosso, e dà l'impronta nuova**

```bash
npx vitest run __tests__/architecture/pagine-legali.test.ts 2>&1 | grep -o 'impronta attuale: [0-9a-f]\{64\}' | head -1
```

Atteso: una riga `impronta attuale: ` seguita da 64 caratteri esadecimali (il test è rosso: le parole non sono più quelle della versione in vigore). Assegnala:

```bash
IMPRONTA=$(npx vitest run __tests__/architecture/pagine-legali.test.ts 2>&1 | grep -o 'impronta attuale: [0-9a-f]\{64\}' | head -1 | cut -d' ' -f3)
V=$(date -u +%F)
echo "$V $IMPRONTA"
grep -c "'$V'" __tests__/architecture/pagine-legali.test.ts
```

Atteso: la data di oggi, l'impronta, e `0`. **Se l'ultimo numero non è `0`**, oggi esiste già una versione dell'informativa (un'altra sessione l'ha alzata): fermati e chiedi al titolare, perché una versione già citata in `consents_log` non si riscrive.

- [ ] **Passo 3: alza la versione e deposita l'impronta**

In `src/lib/legal/versioni.ts`, prima di `/** Versione corrente dei Termini di servizio. */` (riga 264), aggiungi:

```ts
// Sessione 3 della seconda serie di robustezza — SOLO l'informativa privacy. La voce «copie
// tecniche di sicurezza» dice di più perché la copia tiene di più: le righe portate via IN CASCATA
// (messaggi della chat, risposte agli avvisi, prese visione delle note, storico delle classi, copie
// storiche, registro degli accessi al fascicolo) e il registro di protocollo restano novanta giorni
// in `scatola_nera.eliminazioni`; la versione di prima di anagrafiche, note disciplinari,
// certificati medici e protocollo resta novanta giorni in `scatola_nera.modifiche`; il documento
// di protocollo sostituito da una rettifica resta accanto alla registrazione. Sostanziale per la
// stessa ragione del 09/10: trattamenti che allungano la vita di un dato, e che il documento non
// diceva.
//
// ⚠️ Il protocollo NON si dimentica, e la voce lo dice: è un registro tenuto per legge, e l'oblio
// non tocca né la registrazione viva né la sua copia. È testo legale: il titolare lo rilegge.
// ⚠️ Niente «automaticamente», come il 09/10 e il 20/10: la migrazione la applica l'integrazione
// al merge. Le versioni precedenti restano nell'elenco delle impronte.
// I TERMINI DI SERVIZIO NON SONO STATI TOCCATI: `VERSIONE_TERMINI` resta al 2026-07-31.

```

Poi:

```bash
sed -i '' "s/^export const VERSIONE_PRIVACY = '.*'$/export const VERSIONE_PRIVACY = '$V'/" src/lib/legal/versioni.ts
grep -n "^export const VERSIONE_PRIVACY" src/lib/legal/versioni.ts
```

Atteso: `export const VERSIONE_PRIVACY = '` seguito dalla data di oggi.

In `__tests__/architecture/pagine-legali.test.ts`, subito dopo la riga `'2026-10-20': 'f832e6645efa39876f852af8e78b3525ce486d9b917d951187ab4a543c4ffc96',` aggiungi il commento e la voce (la chiave è il valore di `$V`, il valore è quello di `$IMPRONTA`):

```ts
        // Sessione 3 della seconda serie di robustezza — la voce «copie tecniche» dice anche delle
        // CASCATE (chat, risposte agli avvisi, prese visione, storico classi, registro accessi), del
        // registro di protocollo e delle modifiche ad anagrafiche, note e certificati. Le voci
        // precedenti restano dove sono.
```

```bash
awk -v v="$V" -v imp="$IMPRONTA" '
  { print }
  /registro accessi\), del$/ { segnato = 1 }
  segnato && /precedenti restano dove sono\.$/ { print "        '\''" v "'\'': '\''" imp "'\'',"; segnato = 0 }
' __tests__/architecture/pagine-legali.test.ts > "${TMPDIR:-/tmp}/pagine-legali.ts" \
  && mv "${TMPDIR:-/tmp}/pagine-legali.ts" __tests__/architecture/pagine-legali.test.ts
grep -n "'$V'" __tests__/architecture/pagine-legali.test.ts
```

Atteso: una riga con la chiave di oggi e l'impronta.

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/architecture/pagine-legali.test.ts __tests__/architecture/informativa- 2>&1 | tail -5
```

Atteso: `Test Files  3 passed` (`pagine-legali`, `informativa-conservazione-dichiarata`, `informativa-oscuramento-registri-tecnici`).

- [ ] **Passo 5: commit**

```bash
git add src/app/privacy/page.tsx src/lib/legal/versioni.ts __tests__/architecture/pagine-legali.test.ts
git commit -m "$(cat <<'EOF'
Informativa: le copie tecniche tengono anche cascate, anagrafiche e protocollo

La voce «copie tecniche di sicurezza» dice delle righe portate via in cascata, del
registro di protocollo e delle modifiche ad anagrafiche, note e certificati; dice
che il protocollo non si dimentica. Versione nuova, impronta depositata.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Log

| Dove | Chiamata | Livello | `esito` | Campi | Nuovo? |
|---|---|---|---|---|---|
| `avvisi/[id]:DELETE` | `logEvento('avvisi', …)` | `info` | `cancellato` | `avviso`, `n_notifiche_rimosse`, `n_allegati_rimossi`, **`n_risposte_portate_via`** (numero, o `null` se non contate) | campo nuovo su una riga che c'era |
| `avvisi/[id]:DELETE` | `guastoLetturaAccessoria('avvisi', …)` | `error` (`info` solo se allo schema manca la tabella) | **`risposte-non-contate`** | `ripiego: true` e il corpo del guasto (codice Postgres) | sì |
| `admin/protocolli/rettifica:POST` | `logErrore` del `catch` che c'era già | `error`, `stato: 500` | — | messaggio fisso, la `cause` è l'errore dello Storage; nessun percorso, nessun numero | nessuna chiamata nuova: un percorso d'errore nuovo che passa dal `catch` esistente |
| `public.storici_oblio_alunno()` | `app_log`, impronta `storici-oblio-alunno` | `info` | — | `alunno_id` | invariato, con `ON CONFLICT (fingerprint, giorno)` (lock `app-log-battiti-con-conflitto`) |
| `src/lib/gdpr/scatola-nera.ts` | `logEvento('gdpr', …)` | `info` / `error` | `scatola-nera-dimenticata` / `scatola-nera-non-dimenticata` | `righe`: ora conta anche messaggi e revisioni delle conversazioni | invariato |

**Il protocollo, e perché non ha log nuovi.** `AGENTS.md` chiede che ogni modifica porti i suoi log, e che gli eventi critici logghino anche il successo. Le decisioni #6 e #26 del registro dicono «nessuna traccia, nemmeno tecnica» su eliminazione e rettifica, e la decisione T4 del 20/10 le conferma. Le due regole si tengono insieme così:
- **il fallimento si logga sempre** (regole 3 e 6): la copia che non riesce lancia un errore che il `catch` esistente registra con `logErrore`, livello `error`, con l'errore dello Storage come `cause`. Il messaggio è fisso e non porta percorsi né numeri della registrazione, quindi non dice *quale* protocollo, che è ciò che #6 e #26 vietano;
- **il successo non ha una riga di log**, ma ha un testimone che si interroga: l'oggetto sotto `-versioni/` nel bucket e la riga in `scatola_nera.modifiche` o `scatola_nera.eliminazioni`. Le `SELECT` della rettifica di prova (sezione «Per la sessione dopo», punto 6) lo leggono. «Nessun log» qui non è ambiguo, perché il testimone è il dato stesso;
- la rettifica e l'eliminazione del protocollo non sono fra gli eventi critici elencati dalla regola 5 (email, push, cron, fattura, pagamento).

**SQL.** I trigger della scatola non loggano per riga: sono fail-closed, e il loro errore è l'errore della DELETE o dell'UPDATE che li ha fatti scattare. Nessuna migrazione di questa sessione scrive in `app_log`, tranne il battito invariato di `storici_oblio_alunno`.

**Mai dati personali.** I campi nuovi sono un numero e un `esito`; la redazione a lista bianca li lascia passare perché sono numeri.

---

## PRD

### Compito 13 — Runbook, PRD e tabella di stato

**File:**
- Modifica: `docs/runbook-ripristino.md`, scenari A0 e A0-bis (righe 83-87 e 117-122 al 20/10: si sostituisce **per contenuto**, col testo d'origine come ancora, Passo 1)
- Modifica: `PRD REGISTRO ELETTRONICO.md` (in cima al file, e il punto 6 della scatola nera, riga 866 al 20/10: per contenuto, Passo 2)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, la riga `^| 3 |` della tabella di stato (per contenuto, Passo 4)

I valori fra parentesi graffe sono **misure**, non scelte: vengono dal file `${TMPDIR:-/tmp}/s03-misure.env` del Compito 2 e dai nomi dei due file di migrazione (`ls supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql supabase/migrations/*_scatola_nera_protocollo.sql`). `{V}` è la versione dell'informativa del Compito 12.

- [ ] **Passo 1: il runbook**

Il runbook lo cambiano anche le sessioni 4 e 5, dopo questa: le righe si spostano, il testo no. Le due sostituzioni si fanno **per contenuto**: prima si controlla che il testo d'origine ci sia, intero e una volta sola.

```bash
grep -c "ogni riga cancellata da una delle \*\*42 tabelle preziose\*\* resta per 90 giorni" docs/runbook-ripristino.md
grep -c "ogni UPDATE su \*\*13 tabelle\*\* lascia in" docs/runbook-ripristino.md
```

Atteso: `1` e `1` (al 20/10 i due paragrafi erano alle righe 83-87 e 117-122). Se uno dei due stampa `0`, quel paragrafo l'ha già cambiato un'altra sessione: **non** si sostituisce a occhio. Rileggi il paragrafo com'è ora (`grep -n "Dal 2026-10-09 (fase 4\|Dal 2026-10-19 (fase 12" docs/runbook-ripristino.md`), applica al testo di oggi le stesse aggiunte (figlie in cascata e protocollo nello scenario A0; 20 tabelle, anagrafiche e protocollo nello scenario A0-bis; i due capoversi «**Il protocollo.**») e scrivi la differenza nel PRD.

In `docs/runbook-ripristino.md` sostituisci il paragrafo dello scenario A0:

```markdown
Dal 2026-10-09 (fase 4 della roadmap) ogni riga cancellata da una delle **42 tabelle preziose** resta per 90 giorni
in `scatola_nera.eliminazioni`, con le righe portate via in CASCADE: anagrafica, presenze, diario, voti e scrutini,
certificati e documenti, pagamenti e incassi, cassa, moduli, sezioni e sedi. L'elenco esatto sta nella migrazione
`*_scatola_nera_registro_eliminazioni.sql`, fra i marcatori `tabelle-preziose`. **Fuori**: le tabelle che una retention
svuota per legge (domande di iscrizione, personale, candidature, galleria, allegati del registro, notifiche), il
protocollo e i registri. Per quelle si passa allo scenario A.
```

con:

```markdown
Dal 2026-10-09 (fase 4 della roadmap) ogni riga cancellata da una delle **tabelle preziose** resta per 90 giorni
in `scatola_nera.eliminazioni`, con le righe portate via in CASCADE: anagrafica, presenze, diario, voti e scrutini,
certificati e documenti, pagamenti e incassi, cassa, moduli, sezioni e sedi (42 tabelle, fra i marcatori
`tabelle-preziose` di `*_scatola_nera_registro_eliminazioni.sql`). Dalla sessione 3 della seconda serie anche le
**figlie in cascata** (messaggi e conversazioni della chat, avvisi e risposte dei genitori, prese visione delle note,
storico delle classi, copie storiche, registro degli accessi al fascicolo: marcatori `figlie-in-cascata` di
`*_scatola_nera_cascate_anagrafiche.sql`) e il **registro di protocollo** con i suoi allegati
(`*_scatola_nera_protocollo.sql`). **Fuori**: le tabelle che una retention svuota per legge (domande di iscrizione,
personale, candidature, galleria, allegati del registro, notifiche) e i registri. Per quelle si passa allo scenario A.

**Il protocollo.** Una registrazione eliminata torna con `scatola_nera.ripristina_transazione` (prima la
registrazione, poi gli allegati: l'ordine lo risolve la funzione; il WORM non vieta l'INSERT). I **file** della
registrazione e le versioni dei documenti rettificati tornano dallo specchio di R2, nella stessa cartella
`<sede>/<anno>/<numero a 7 cifre>`.
```

e sostituisci il paragrafo dello scenario A0-bis:

```markdown
Dal 2026-10-19 (fase 12 della roadmap) ogni UPDATE su **13 tabelle** lascia in `scatola_nera.modifiche` la riga
**com'era prima**, per 90 giorni: valutazioni e obiettivi, presenze e giustifiche didattiche, pagamenti, quote e incassi,
scrutini (giudizi, comportamento, giudizio descrittivo, periodi) e pagelle. L'elenco esatto sta nella migrazione
`*_scatola_nera_modifiche.sql`. Non si copia una modifica che tocca solo `updated_at`/`aggiornato_il`, né la retention
notturna delle giustificazioni (svuota testi per legge: copiarli li terrebbe in vita). **Fuori**: l'anagrafica e
tutto il resto, per cui si passa allo scenario A.
```

con:

```markdown
Dal 2026-10-19 (fase 12 della roadmap) ogni UPDATE su **13 tabelle** lascia in `scatola_nera.modifiche` la riga
**com'era prima**, per 90 giorni: valutazioni e obiettivi, presenze e giustifiche didattiche, pagamenti, quote e incassi,
scrutini (giudizi, comportamento, giudizio descrittivo, periodi) e pagelle (`*_scatola_nera_modifiche.sql`). Dalla
sessione 3 della seconda serie le tabelle sono **20**: anche alunni, genitori (`parents`), utenti, note disciplinari,
certificati medici (`*_scatola_nera_cascate_anagrafiche.sql`, marcatori `anagrafiche-storico`) e il registro di
protocollo con gli allegati (`*_scatola_nera_protocollo.sql`). Non si copia una modifica che tocca solo
`updated_at`/`aggiornato_il`/`storico_versione`, né la retention notturna delle giustificazioni (svuota testi per legge:
copiarli li terrebbe in vita). **Fuori**: tutto il resto, per cui si passa allo scenario A.

**Il protocollo.** Il WORM del registro rifiuta un UPDATE che non passa dalla rettifica: il ripristino di una
registrazione rettificata male si fa nella stessa transazione del suo interruttore, dopo averlo mostrato:
`BEGIN; SELECT set_config('app.protocollo_admin_update', 'on', true); SELECT scatola_nera.ripristina_modifiche(ARRAY[<id>]::bigint[]); COMMIT;`
Il documento di prima sta in `<sede>/<anno>/<numero a 7 cifre>-versioni/<istante>-<nome>`: si rimette al percorso
dell'originale dal pannello dello Storage, e il timbrato si rigenera con una rettifica che ricarica quel documento.
```

Poi si controlla che le due sostituzioni ci siano, e che il testo d'origine non ci sia più:

```bash
grep -c "marcatori \`figlie-in-cascata\`\|le tabelle sono \*\*20\*\*" docs/runbook-ripristino.md
grep -c "42 tabelle preziose\*\* resta per 90 giorni" docs/runbook-ripristino.md
```

Atteso: `2`, poi `0`.

- [ ] **Passo 2: il PRD, il punto 6 della scatola nera**

Il PRD lo cambiano anche le sessioni 1 e 2 (voci in cima): la riga si trova per contenuto, non per numero (era la 866 al 20/10).

```bash
grep -c "il protocollo (Decisione #6: cancellazione «senza traccia»); \`fatture_emesse\`" "PRD REGISTRO ELETTRONICO.md"
```

Atteso: `1`. Con `0`, il punto 6 è già stato riscritto: rileggilo (`grep -n "6. \*\*Fuori, di proposito\*\*" "PRD REGISTRO ELETTRONICO.md"`) e applica la stessa aggiunta al testo di oggi. In `PRD REGISTRO ELETTRONICO.md` sostituisci:

```markdown
il protocollo (Decisione #6: cancellazione «senza traccia»); `fatture_emesse`
```

con:

```markdown
il protocollo fino alla sessione 3 della seconda serie (Decisione #6: cancellazione «senza traccia»; da lì è dentro, in «copia silenziosa», decisione T4); `fatture_emesse`
```

- [ ] **Passo 3: il PRD, la voce di changelog in cima al file (prima della riga 1)**

```markdown
## 🛡️ Changelog — Robustezza, seconda serie, sessione 3: la scatola nera sulle cascate, sulle anagrafiche e sul protocollo — {data UTC di oggi} (branch `robustezza2/s03-scatola-nera-cascate`)

**Stato:** 🟡 in revisione (PR #@PR@), **merge a mano del titolare**. Le due migrazioni le applica l'integrazione al merge, una riga ciascuna con la version del file. «In produzione», il commit di `main` e la misura «dopo» li scrive la sessione che apre dopo (sezione «Per la sessione dopo» del piano `docs/superpowers/plans/2026-10-20-robustezza2-s03-scatola-nera-cascate.md`).

**Misura «prima»** ({ISCRIZIONI_ALLE} UTC, sola lettura): `enrollment_submissions` = **{ISCRIZIONI}** righe. Database {DB_PRIMA}; scatola nera {SCATOLA_PRIMA}. Trigger: {E0} sulle eliminazioni, {M0} sulle modifiche. Crescita stimata della scatola in 90 giorni: **{CRESCITA_MB} MB** (finestra di {GIORNI} giorni dal {DAL}; stima prudente: byte medi per riga con indici e TOAST). Bucket del protocollo: {STORAGE_PROTOCOLLO_PRIMA}, {VERSIONI_PRIMA} versioni.

- **Le cascate** (`{version A}_scatola_nera_cascate_anagrafiche.sql`). Cancellare un utente, un alunno o un avviso portava via in CASCADE tabelle che la scatola nera non vedeva (D4). Ora dieci figlie restano 90 giorni in `scatola_nera.eliminazioni`, con il TRUNCATE vietato: `chat_messages`, `chat_threads`, `conversazioni_sospensioni` (la prova di moderazione che la policy UGC chiede di conservare: trovata dalla misura del Passo 0 fuori dagli elenchi del piano, entrata per decisione dell'assistente in assenza del titolare, da confermare), `avvisi`, `avvisi_risposte`, `nota_ricezioni`, `alunni_classi_storico`, `storici_collegamenti`, `storici_revisioni`, `fascicolo_accessi_audit`. Fuori, col motivo nell'intestazione: notifiche e push (effimere), personale, galleria e candidature (retention per legge), configurazione d'accesso, tabelle operative, lavori di stampa, `registro_destinatari` (decide il titolare).
- **Le anagrafiche.** Lo storico delle modifiche copre anche `alunni`, `parents`, `utenti`, `note_disciplinari`, `certificati_medici`. Un UPDATE che cambia solo `storico_versione` non si copia: è il tocco con cui una presa visione firmata segna la nota.
- **Le pulizie.** `scatola_nera.registra()` rispetta `scatola_nera.senza_storico`; `storici_bonifica_chat` e `storici_oblio_alunno` lo accendono per le sole proprie DELETE, perché una copia di 90 giorni disferebbe la bonifica.
- **L'oblio** toglie anche i messaggi delle conversazioni che nominano la persona (per `thread_id`), le revisioni di quei messaggi (per `entita_id`) e le sospensioni di quelle conversazioni, con le conversazioni cancellate o vive; e le sospensioni che la nominano in `sospesa_da`, `sospesa_verso` o `riaperta_da` (colonne senza `_id`, il `motivo` è testo libero). Anonimizzare una scheda lascia la riga com'era in `scatola_nera.modifiche` finché l'oblio dell'app non chiama `scatola_nera_dimentica`, per ultima.
- **Il protocollo, «copia silenziosa» (T4)** (`{version B}_scatola_nera_protocollo.sql`, `rettifica/route.ts`). `protocolli` e `protocolli_allegati` restano 90 giorni in scatola quando si eliminano o si modificano; la rettifica copia il documento di prima in `<sede>/<anno>/<numero>-versioni/` prima di caricare il nuovo, e se la copia non riesce non parte; `protocollo_elimina` restituisce anche quelle versioni, che la route toglie dal bucket (decisione #2). Le decisioni #6 e #26 restano: nessun `logScrittura`, nessun log sul successo, nessun badge.
- **Avvisi.** La cancellazione conta le risposte dei genitori prima di portarle via: `n_risposte_portate_via` nel log `cancellato`, `risposte-non-contate` (error) se il conteggio fallisce.
- **«Libera spazio» e la chat.** Con `chat_messages` nella scatola, i messaggi senza allegato che «libera spazio» (`src/lib/alunni/libera-spazio.ts`) toglie a un bambino ritirato restano 90 giorni in `scatola_nera.eliminazioni` (l'oblio li toglie se richiesto): lo spazio si libera davvero dopo 90 giorni. Accettato dal titolare all'apertura della sessione. Misura: {LIBERA_SPAZIO_MESSAGGI} messaggi su {LIBERA_SPAZIO_ALUNNI} ritirati ancora da liberare; {LIBERA_SPAZIO_USATA} alunni già liberati, {LIBERA_SPAZIO_90G} negli ultimi 90 giorni.
- **Informativa** alla versione `{V}`: la voce «copie tecniche di sicurezza» dice delle cascate, del protocollo e delle anagrafiche, e che il protocollo non si dimentica (registro tenuto per legge). Da rileggere da parte del titolare.
- **Runbook** (`docs/runbook-ripristino.md`, scenari A0 e A0-bis): elenchi aggiornati, ripristino del protocollo con l'interruttore della rettifica.

**Prove.** PGlite `scatola-nera-cascate-sql.test.ts` (le tre migrazioni della scatola lette dal disco, la terza applicata due volte), `scatola-nera-protocollo-sql.test.ts`, `protocollo-elimina-sql.test.ts` (senza Storage, come la CI); route `protocolli-rettifica-versioni.test.ts` e `avvisi-orfani-cancellazione.test.ts`; `protocolli-store.test.ts`; impronta dell'informativa.

**Dopo il merge** (lo scrive la sessione che apre dopo, con la sezione «Per la sessione dopo» di questo piano): le `SELECT` di conferma (trigger {E0}+12 e {M0}+7, corpi, permessi), la misura «dopo» con data e ora UTC, il conteggio per tabella che matura sette giorni dopo il merge, la rettifica di prova sulla sede di prova solo con il via del titolare.

```

- [ ] **Passo 4: la tabella di stato della specifica**

La riga si trova per contenuto, mai per numero (le sessioni 1 e 2 cambiano la tabella prima di questa):

```bash
grep -n "^| 3 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: **una** riga, che il 20/10 era:

```markdown
| 3 | Scatola nera su cascate, anagrafiche e protocollo | D4, D6, D7 (ricevute delle note) | 2 | da fare | — | `s03-scatola-nera-cascate` | T4; crescita del DB da misurare prima |
```

Sostituiscila con questa (se il Compito 2 ha già scritto qualcosa nella colonna «Note», per esempio una tabella tolta per la crescita, lo si tiene e lo si mette dopo «T4;»):

```markdown
| 3 | Scatola nera su cascate, anagrafiche e protocollo | D4, D6, D7 (ricevute delle note) | 2 | in revisione | #@PR@ | `docs/superpowers/plans/2026-10-20-robustezza2-s03-scatola-nera-cascate.md` | T4; prima: {CRESCITA_MB} MB stimati in 90 giorni su {DB_PRIMA} ({ISCRIZIONI_ALLE} UTC); «libera spazio» nella scatola: accettato |
```

Lo Stato si scrive «in revisione», con queste parole; `@PR@` lo sostituisce il Compito 14, Passo 3, quando la PR esiste. «In produzione», il commit di `main` e la misura «dopo» per questa riga li scrive **solo** la sessione che apre dopo (§5, «La tabella di stato»), con la sezione «Per la sessione dopo» di questo piano.

- [ ] **Passo 5: controlla che non ci siano dati personali né parentesi graffe rimaste**

```bash
head -30 "PRD REGISTRO ELETTRONICO.md" | grep -n "{[A-Z][A-Z0-9_]*}\|{data UTC\|{version"
grep "^| 3 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n "{[A-Z][A-Z0-9_]*}"
grep -c "^| 3 | .* | in revisione | #@PR@ |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: i primi due nessuna riga; il terzo `1` (il solo gettone rimasto è `@PR@`, nel PRD e nella riga di stato, che il Compito 14 sostituisce). Nel PRD ci sono solo numeri, dimensioni, nomi di tabelle e di file.

- [ ] **Passo 6: commit**

```bash
git add docs/runbook-ripristino.md "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
PRD, runbook e tabella di stato: sessione 3, scatola nera su cascate e protocollo

Changelog con la misura «prima» (domande d'iscrizione contate, crescita stimata),
scenari A0 e A0-bis del runbook con le tabelle nuove e il ripristino del protocollo,
riga 3 della tabella di stato in revisione.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 14 — Gate, PR, CI, merge del titolare, verifica

**File:** nessuno nuovo; nel Passo 3, `PRD REGISTRO ELETTRONICO.md` e la riga `^| 3 |` della specifica prendono il numero della PR. Dopo il merge in questa sessione si fanno solo le `SELECT` di conferma (Passo 6); fotografia, riga di stato «in produzione», misura «dopo», conteggio a una settimana e rettifica di prova li fa e li scrive la sessione che apre dopo, nel suo primo commit, con la sezione «Per la sessione dopo» di questo piano. Nessun ramo di soli documenti dopo il rilascio (§5).

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
git diff origin/main --stat
cat supabase/migrations/*_scatola_nera_cascate_anagrafiche.sql supabase/migrations/*_scatola_nera_protocollo.sql | wc -l
```

Le due migrazioni si applicano in produzione al merge, senza nessuno davanti: nel corpo della PR vanno **mostrate** (le sezioni «Cosa fa», «Come si verifica», «Rollback» delle due intestazioni). Mostrare non è chiedere.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s03-scatola-nera-cascate
gh pr create --base main --head robustezza2/s03-scatola-nera-cascate \
  --title "Robustezza 2, sessione 3: scatola nera su cascate, anagrafiche e protocollo" \
  --body "$(cat <<'EOF'
## Cosa cambia
- Nove figlie in cascata di utenti, alunni e avvisi nella scatola delle eliminazioni (D4).
- Alunni, genitori, utenti, note disciplinari e certificati medici nello storico delle modifiche; `storico_versione` da solo non è una modifica.
- `registra()` rispetta `scatola_nera.senza_storico`; le due bonifiche delle copie storiche lo accendono per le proprie DELETE.
- L'oblio toglie anche messaggi e revisioni delle conversazioni che nominano la persona.
- T4, protocollo in «copia silenziosa»: registrazioni e allegati nella scatola, documento rettificato conservato in `-versioni/`, `protocollo_elimina` che restituisce anche le versioni. Decisioni #6 e #26 invariate: nessun log nuovo.
- La cancellazione di un avviso conta le risposte che porta via.
- `chat_messages` nella scatola: i messaggi tolti da «libera spazio» restano 90 giorni (accettato dal titolare all'apertura, numeri nel PRD).
- Informativa a una versione nuova (da rileggere da parte del titolare); runbook A0 e A0-bis.

## Migrazioni (le applica l'integrazione al merge)
- `*_scatola_nera_cascate_anagrafiche.sql` — trigger e funzioni, nessuna tabella, nessuna colonna. Dopo: trigger delle eliminazioni (e del TRUNCATE vietato) +10, delle modifiche +5 (da 42 a 52 e da 13 a 18, se il «prima» del PRD è 42 e 13: misurato il 25/10).
- `*_scatola_nera_protocollo.sql` — trigger su `protocolli` e `protocolli_allegati`, `protocollo_elimina`. Dopo: altri +2 e +2 (54 e 20).
- Rollback nell'intestazione di ciascuna; si applica solo dentro una PR di revert.

## Misura «prima»
Nel changelog del PRD: domande d'iscrizione contate, crescita stimata della scatola, dimensione del database.

## Merge
A mano, dal titolare, dopo la CI verde su tutti i job.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Atteso: l'URL della PR. Il numero va al posto di `@PR@` nella voce del PRD e nella riga `^| 3 |` della tabella di stato, con un commit sul ramo:

```bash
PR=$(gh pr view --json number --jq .number)
sed -i '' -e "s/@PR@/${PR}/g" "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
grep -c "^| 3 | .* | in revisione | #${PR} |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git diff --cached --name-only | xargs grep -n "@PR@"
git commit -m "$(cat <<'EOF'
Robustezza2 s03: numero della PR nel PRD e nella tabella di stato (in revisione)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Atteso: il `grep -c` stampa `1`; il `grep` di `@PR@` non stampa niente. Lo Stato resta «in revisione»: non si scrive «in produzione» in questa PR.

- [ ] **Passo 4: la CI, tutti i job**

```bash
gh pr checks --watch 2>&1 | tail -20
```

Atteso: ogni job `pass`. Un E2E `cancelled` non è rosso: si rilancia (`gh run rerun <id> --failed`), una PR alla volta. `DB migrate (CI)` non gira sulla PR: `.github/workflows/migrate-ci.yml` parte solo a mano (`workflow_dispatch`). Le guardie `to_regclass` servono il giorno in cui il titolare lo lancia su quel database, che non ha `pg_cron` né `storage.objects`.

- [ ] **Passo 5: il merge è del titolare**

Non si usa l'auto-merge. Si scrive al titolare che la PR è verde e pronta, con il riepilogo delle migrazioni, e si aspetta che la mergi lui.

- [ ] **Passo 6: dopo il merge e il deploy, le `SELECT` di conferma (sola lettura)**

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE name IN ('scatola_nera_cascate_anagrafiche', 'scatola_nera_protocollo')
 ORDER BY version;

SELECT tgname, count(*) AS n
  FROM pg_trigger
 WHERE tgname IN ('scatola_nera_eliminazioni', 'scatola_nera_no_truncate', 'scatola_nera_modifiche')
 GROUP BY 1 ORDER BY 1;

SELECT p.oid::regprocedure AS funzione,
       CASE p.proname
         WHEN 'registra'               THEN p.prosrc ~ 'senza_storico'
         WHEN 'registra_modifica'      THEN p.prosrc ~ 'storico_versione'
         WHEN 'scatola_nera_dimentica' THEN p.prosrc ~ 'v_collegati'
         WHEN 'storici_bonifica_chat'  THEN p.prosrc ~ 'senza_storico'
         WHEN 'storici_oblio_alunno'   THEN p.prosrc ~ 'senza_storico'
         WHEN 'protocollo_elimina'     THEN p.prosrc ~ '-versioni/'
       END AS aggiornata,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_esegue
  FROM pg_proc p
 WHERE p.oid IN ('scatola_nera.registra()'::regprocedure,
                 'scatola_nera.registra_modifica()'::regprocedure,
                 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure,
                 'public.storici_bonifica_chat()'::regprocedure,
                 'public.storici_oblio_alunno()'::regprocedure,
                 'public.protocollo_elimina(uuid)'::regprocedure)
 ORDER BY 1;
```

Atteso: due migrazioni con la version dei file; `scatola_nera_eliminazioni` = `scatola_nera_no_truncate` = {E0} + 12 (54 se {E0} era 42), `scatola_nera_modifiche` = {M0} + 7 (20 se {M0} era 13); sei funzioni con `aggiornata = true` e `authenticated_esegue = false`. Se un numero non torna, la migrazione è stata applicata a metà o con un'altra version: **fermati** e leggi `schema_migrations` prima di toccare qualunque cosa.

- [ ] **Passo 7: misura «dopo», conteggio a una settimana e rettifica di prova: non qui**

Non si scrivono in questa sessione: dopo il merge non si apre un ramo di soli documenti (§5). Le `SELECT` della misura «dopo» (matura subito dopo il merge), del conteggio per tabella (matura sette giorni dopo il merge) e la rettifica di prova (solo col sì del titolare) stanno per intero nella sezione «Per la sessione dopo», punti 4, 5 e 6: le esegue e le scrive la sessione che apre dopo, con data e ora UTC.

- [ ] **Passo 8: pulizia dei rami (AGENTS.md, punto 3)**

Dopo il rilascio riuscito:

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s03-scatola-nera
git -C /Users/lerri/kidville-web branch -D robustezza2/s03-scatola-nera-cascate
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s03-scatola-nera-cascate
git -C /Users/lerri/kidville-web branch -a | grep -v "main$" | head
```

Atteso: nessun ramo di lavoro residuo di questa sessione. Se il ramo remoto non c'è più (cancellato al merge), il terzo comando dice `remote ref does not exist`: va bene. La sessione che apre dopo esegue, nel suo primo commit, la sezione «Per la sessione dopo» qui sotto.

---

## Ritorno indietro

**Codice.** Instant Rollback di Vercel al deploy di prima (lo fa il titolare dal pannello), poi una PR di revert del commit di merge. Tornando indietro col solo codice, la rettifica smette di copiare il documento di prima e torna a sovrascriverlo; nessun dato si perde.

**Database.** Mai a mano. Una PR di revert aggiunge **una migrazione nuova** (version con `date -u +%Y%m%d%H%M%S`) con questo contenuto, poi le definizioni di prima delle sei funzioni, copiate dal file `${TMPDIR:-/tmp}/s03-funzioni-prima.sql` del Passo 6 del Compito 2 (o dai file indicati nelle due sezioni ROLLBACK):

```sql
-- REVERT della sessione 3 della seconda serie (solo dentro una PR di revert).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_messages', 'chat_threads', 'avvisi', 'avvisi_risposte', 'nota_ricezioni',
                           'alunni_classi_storico', 'storici_collegamenti', 'storici_revisioni',
                           'fascicolo_accessi_audit', 'protocolli', 'protocolli_allegati'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_eliminazioni ON public.%I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_no_truncate ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['alunni', 'parents', 'utenti', 'note_disciplinari', 'certificati_medici',
                           'protocolli', 'protocolli_allegati'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS scatola_nera_modifiche ON public.%I', t);
  END LOOP;
END $$;
```

Il secondo ciclo toglie **solo** il trigger delle modifiche: `alunni`, `parents`, `utenti`, `note_disciplinari` e `certificati_medici` tengono quello delle eliminazioni, che è della fase 4. Il revert va provato su PGlite con lo stesso schema di `scatola-nera-cascate-sql.test.ts` (dopo il revert: trigger 42 e 13, e l'oblio del genitore restituisce di nuovo 2) prima di aprire la PR.

**Nessun dato si perde.** Le righe già copiate nella scatola restano finché non scadono (90 giorni): sono la copia. Le versioni dei documenti già nel bucket restano; con la `protocollo_elimina` di prima un'eliminazione non le toglierebbe più. Si contano così, e il titolare decide se rimuoverle dal pannello dello Storage:

```sql
SELECT count(*) AS versioni_orfane
  FROM storage.objects o
 WHERE o.bucket_id = 'protocollo'
   AND o.name LIKE '%-versioni/%'
   AND NOT EXISTS (
     SELECT 1 FROM public.protocolli p
      WHERE left(o.name, length(p.scuola_id::text || '/' || p.anno::text || '/' || lpad(p.numero::text, 7, '0') || '-versioni/'))
            = p.scuola_id::text || '/' || p.anno::text || '/' || lpad(p.numero::text, 7, '0') || '-versioni/');
```

**Informativa.** La versione nuova resta: il testo descrive ciò che la scatola ha già copiato e terrà fino alla scadenza. Se il revert dura oltre i 90 giorni, una versione successiva toglie le voci in più.

---

## Per la sessione dopo

Questa sezione la esegue la sessione che apre **dopo** il rilascio della sessione 3, nel suo primo commit, prima di ogni codice (§5, «Apertura di una sessione: la chiusura della precedente»). Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Le query sono in **sola lettura**, con `execute_sql` sul database di produzione, tranne la rettifica di prova del punto 6, che si fa solo col sì del titolare. I comandi partono dalla radice del worktree della sessione che chiude.

**Che cosa ha lasciato la sessione 3.** Due migrazioni, `supabase/migrations/<version A>_scatola_nera_cascate_anagrafiche.sql` e `supabase/migrations/<version B>_scatola_nera_protocollo.sql`: solo trigger e funzioni. Nessuna tabella, colonna, vincolo, indice unico, policy, FK, bucket; nessuna voce in `MIGRAZIONI_ATTESE_AL_MERGE`. Il numero della PR è nella riga `^| 3 |` della tabella di stato (colonna «PR»); i numeri «prima» (trigger, dimensioni, crescita stimata) sono nella voce del PRD «Robustezza, seconda serie, sessione 3».

- [ ] **1. Le due migrazioni sono applicate, una volta sola**

```bash
ls supabase/migrations/ | grep "_scatola_nera_cascate_anagrafiche\.sql$\|_scatola_nera_protocollo\.sql$"
```

Atteso: due file. Le 14 cifre iniziali di ciascuno sono la sua version. Poi, con quei due valori:

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE version IN ('{le 14 cifre del file _scatola_nera_cascate_anagrafiche}', '{le 14 cifre del file _scatola_nera_protocollo}')
 ORDER BY version;
```

Atteso: **due** righe. Con zero o una riga **fermati** e avvisa il titolare: una migrazione non si applica a mano (riapplicarla con un'altra version fa due righe).

- [ ] **2. Fotografia delle migrazioni applicate**

```bash
SCRATCH=$(mktemp -d)
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa (`select version, name from supabase_migrations.schema_migrations order by version`) con `execute_sql`, salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
```

Atteso: due file verdi; nel `git diff` della fotografia compaiono le due version del punto 1.

- [ ] **3. Nessun'altra fotografia, nessuna lista da svuotare: si controlla**

Fuori dai commenti, i due file non contengono `unique`, `primary key`, `references utenti`, `add constraint`/`drop constraint`, `policy`, `row level security`, `drop table`, né la definizione di una colonna `scuola_id`: nessuna delle tre guardie di freschezza (`onconflict-arbitro`, `tracce-docente-dichiarate`, `rls-per-sede`) li riconosce, e la sessione 3 non ha messo voci in `MIGRAZIONI_ATTESE_AL_MERGE`.

```bash
npx vitest run __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/rls-per-sede.test.ts 2>&1 | tail -8
grep -n "_scatola_nera_" __tests__/architecture/soglia-fotografia.ts
```

Atteso: tre file verdi; il `grep` non stampa niente. Se una guardia è rossa e nomina uno dei due file, rigenera la sua fotografia dalla produzione con il generatore che il messaggio d'errore nomina (`node __tests__/fixtures/indici-unici-fotografia.mjs --sql`, `node __tests__/fixtures/fk-utenti-fotografia.mjs --sql` oppure `node scripts/rls-fotografia.mjs --sql`; la query con `execute_sql`; poi lo stesso script con `< "$SCRATCH"/risposta.json`), rilancia il test, e scrivi nel PRD quale fotografia e perché.

- [ ] **4. Conferme e misura «dopo» — matura subito dopo il merge**

```sql
SELECT now() AT TIME ZONE 'UTC' AS misurato_alle;

SELECT tgname, count(*) AS n
  FROM pg_trigger
 WHERE tgname IN ('scatola_nera_eliminazioni', 'scatola_nera_no_truncate', 'scatola_nera_modifiche')
 GROUP BY 1 ORDER BY 1;

SELECT p.oid::regprocedure AS funzione,
       CASE p.proname
         WHEN 'registra'               THEN p.prosrc ~ 'senza_storico'
         WHEN 'registra_modifica'      THEN p.prosrc ~ 'storico_versione'
         WHEN 'scatola_nera_dimentica' THEN p.prosrc ~ 'v_collegati'
         WHEN 'storici_bonifica_chat'  THEN p.prosrc ~ 'senza_storico'
         WHEN 'storici_oblio_alunno'   THEN p.prosrc ~ 'senza_storico'
         WHEN 'protocollo_elimina'     THEN p.prosrc ~ '-versioni/'
       END AS aggiornata,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_esegue
  FROM pg_proc p
 WHERE p.oid IN ('scatola_nera.registra()'::regprocedure,
                 'scatola_nera.registra_modifica()'::regprocedure,
                 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure,
                 'public.storici_bonifica_chat()'::regprocedure,
                 'public.storici_oblio_alunno()'::regprocedure,
                 'public.protocollo_elimina(uuid)'::regprocedure)
 ORDER BY 1;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database,
       pg_size_pretty(pg_total_relation_size('scatola_nera.eliminazioni')) AS eliminazioni,
       pg_size_pretty(pg_total_relation_size('scatola_nera.modifiche'))    AS modifiche;

SELECT count(*) FROM enrollment_submissions;
```

Atteso: i trigger «prima» sono nella voce del PRD della sessione 3 («Trigger: N sulle eliminazioni, M sulle modifiche»); dopo, `scatola_nera_eliminazioni` = `scatola_nera_no_truncate` = N + 12 (54 se N era 42) e `scatola_nera_modifiche` = M + 7 (20 se M era 13). Sei funzioni con `aggiornata = true` e `authenticated_esegue = false`. Se un numero non torna, la migrazione è stata applicata a metà o con un'altra version: **fermati** e avvisa il titolare prima di toccare qualunque cosa. Le dimensioni e il conteggio si scrivono con la data e l'ora UTC della prima riga, accanto a quelle «prima» della voce del PRD.

- [ ] **5. Conteggio per tabella — matura dal settimo giorno dopo il merge**

La data del merge: `gh pr view {numero PR} --repo erricoluigi17/kidville-web --json mergedAt --jq .mergedAt`. Il punto matura **sette giorni dopo** quella data e ora. Se la sessione dopo apre prima, questo punto non si fa ora: nel PRD e nella colonna «Note» della riga `^| 3 |` si scrive «conteggio per tabella: matura dal {data del merge + 7 giorni}», e lo scrive la **prima PR che tocca la specifica dopo quella data**.

```sql
SELECT tabella, count(*) FROM scatola_nera.eliminazioni GROUP BY 1 ORDER BY 1;
SELECT tabella, count(*) FROM scatola_nera.modifiche GROUP BY 1 ORDER BY 1;
SELECT relname, n_tup_del, n_tup_upd
  FROM pg_stat_user_tables
 WHERE schemaname = 'public'
   AND relname IN ('chat_messages', 'chat_threads', 'avvisi', 'avvisi_risposte', 'nota_ricezioni',
                   'alunni_classi_storico', 'storici_collegamenti', 'storici_revisioni',
                   'fascicolo_accessi_audit', 'alunni', 'parents', 'utenti', 'note_disciplinari',
                   'certificati_medici', 'protocolli', 'protocolli_allegati')
 ORDER BY 1;
SELECT pg_size_pretty(pg_database_size(current_database())) AS database,
       pg_size_pretty(pg_total_relation_size('scatola_nera.eliminazioni')
                      + pg_total_relation_size('scatola_nera.modifiche')) AS scatola;
```

Atteso: compaiono tabelle nuove se in quella settimana qualcuno ha cancellato o modificato. **Una tabella assente non è un guasto** se il suo `n_tup_del` (o `n_tup_upd`) non è cresciuto rispetto alla misura del punto 4: si scrivono i due numeri accanto, «osservato» e «causa probabile» separati. La crescita della scatola si confronta con la stima della voce del PRD («Crescita stimata della scatola in 90 giorni: X MB»), riportata a sette giorni (X × 7 / 90): se la supera di più del doppio, lo si scrive nella colonna «Note» della riga `^| 3 |` e lo si dice al titolare.

- [ ] **6. La rettifica di prova — solo con il sì del titolare**

È una scrittura nel registro di protocollo di produzione: si chiede al titolare, e si fa **solo** se dice sì, e solo su una sede di prova esclusa dagli elenchi pubblici. Una registrazione di prova con un PDF finto, una rettifica che sostituisce il documento, poi:

```sql
SELECT count(*) FILTER (WHERE name LIKE '%-versioni/%') AS versioni,
       count(*) AS oggetti
  FROM storage.objects
 WHERE bucket_id = 'protocollo' AND name LIKE '{uuid della sede di prova}/%';
SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'protocolli';
```

Atteso: una versione in più (il documento di prima) accanto al documento nuovo, e una riga in più nelle modifiche. Poi si elimina la registrazione di prova dall'interfaccia e si rilegge: le versioni di quella registrazione tornano a 0 e `scatola_nera.eliminazioni` ha una riga `protocolli` in più. Se il titolare dice no, la prova resta quella dei test PGlite e della route, e lo si scrive nel PRD con queste parole.

- [ ] **7. La riga di stato a «in produzione»**

```bash
grep -n "^| 3 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
gh pr view {numero PR} --repo erricoluigi17/kidville-web --json mergeCommit,mergedAt --jq '"\(.mergeCommit.oid[0:8]) \(.mergedAt)"'
```

Atteso: **una** riga, con «in revisione»; poi lo `{sha corto}` del commit di merge su `main` e la data. Sostituisci la riga trovata con questa, tenendo nella colonna «Note» quello che la sessione 3 ci aveva già scritto (per esempio «libera spazio» accettato, o una tabella tolta per la crescita):

```markdown
| 3 | Scatola nera su cascate, anagrafiche e protocollo | D4, D6, D7 (ricevute delle note) | 2 | in produzione | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s03-scatola-nera-cascate.md` | T4; in produzione il {data UTC del merge}, `main` `{sha corto}`; trigger {eliminazioni}/{modifiche}; dopo del {data e ora UTC}: database {dimensione}, scatola {dimensioni}; conteggio per tabella: {esito del punto 5, oppure «matura dal …»}; rettifica di prova: {fatta, oppure «no del titolare»}; {Note della sessione 3} |
```

- [ ] **8. Lo Stato della voce nel PRD**

```bash
grep -n "sessione 3: la scatola nera sulle cascate" "PRD REGISTRO ELETTRONICO.md"
```

Atteso: **una** riga, il titolo della voce. Nella voce, la riga che comincia con `**Stato:** 🟡 in revisione` diventa:

```markdown
**Stato:** ✅ in produzione dal {data UTC del merge} (PR #{numero PR}, `main` `{sha corto}`). Le due migrazioni le ha applicate l'integrazione al merge, una riga ciascuna con la version del file.
```

e il capoverso che comincia con `**Dopo il merge**` diventa:

```markdown
**Misura «dopo»** ({data e ora UTC}, sola lettura): trigger {eliminazioni} sulle eliminazioni e {modifiche} sulle modifiche; sei funzioni aggiornate, nessuna eseguibile da `authenticated`; database {dimensione}, scatola nera {dimensioni}; `enrollment_submissions` = **{conteggio}** righe. Conteggio per tabella: {esito del punto 5, oppure «matura dal …»}. Rettifica di prova: {esito del punto 6, oppure «non fatta per decisione del titolare: la prova resta quella dei test PGlite e della route»}.
```

Solo numeri, dimensioni, nomi di tabelle e di file: nessun dato personale.

- [ ] **9. Che cosa è cambiato in file che le sessioni dopo toccano (da sapere, niente da fare)**

- `docs/runbook-ripristino.md`: la sessione 3 ha riscritto i paragrafi degli scenari A0 e A0-bis (ora «**tabelle preziose**» senza il «42», «le tabelle sono **20**», due capoversi «**Il protocollo.**»). Rispetto ai numeri del 20/10, ogni riga fra i due scenari ha il numero aumentato di 8, e ogni riga dopo lo scenario A0-bis di 16. Le sessioni 4 e 5 cambiano altre parti dello stesso file: per contenuto, mai per numero di riga.
- `src/app/privacy/page.tsx`, `src/lib/legal/versioni.ts` (`VERSIONE_PRIVACY`) e l'impronta in `__tests__/architecture/pagine-legali.test.ts`: l'informativa è alla versione della sessione 3 (nella voce del PRD, «Informativa alla versione …»). La sessione 8 parte da quella, non dalla versione del 20/10.
- `src/lib/protocolli/store.ts`: `pathDefinitivi` restituisce anche `prefissoVersioni` e `versione`, e c'è `istanteVersione`. La sessione 13 parte da lì.

- [ ] **10. Verifica e file del commit**

```bash
CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
git status --short
```

Atteso: tutto verde. I file da aggiungere **per nome** al primo commit della sessione che chiude: `__tests__/fixtures/migrazioni-applicate-snapshot.json`, `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, `"PRD REGISTRO ELETTRONICO.md"`, più la fotografia del punto 3 solo se è stata rigenerata. Nessun altro file.

---

## Autorevisione

| Specifica (§7, Sessione 3, e T4) | Compito |
|---|---|
| Misura prima: figlie in cascata da `pg_constraint` con `confdeltype='c'`, `n_tup_del`/`n_tup_upd` e dimensioni, crescita sui 491 MB | 2 (Passi 3, 5) |
| Il ciclo delle eliminazioni sulle figlie che contano; le effimere fuori col motivo | 4 (intestazione del Compito 3) |
| Il ciclo delle modifiche allargato ad `alunni`, `parents`, `utenti`, `note_disciplinari`, `certificati_medici` | 5 |
| `registra()` rispetta `senza_storico`; le pulizie in blocco lo accendono nella propria transazione | 3, 6 (e Passo 7 del Compito 2 per le pulizie che il codice non mostra) |
| La cancellazione di un avviso registra quante risposte porta via | 11 |
| L'informativa lo dice | 12 |
| L'oblio toglie anche le copie nuove; la figlia che nomina la persona solo per `thread_id` a parte | 7 |
| T4: `protocolli` e `protocolli_allegati` nella scatola, eliminazioni e modifiche | 8 |
| T4: la rettifica conserva il file precedente in un percorso di versioni | 9, 10 |
| T4: nessun log applicativo nuovo sul protocollo | 10 (test «decisione #26»), sezione Log |
| Rischio: crescita del DB, un INSERT in più per DELETE, oblio incompleto | Compito 2 (soglie), Per la sessione dopo (punti 4-5), Compito 7 |
| Indietro: migrazione inversa con `DROP TRIGGER IF EXISTS` | Ritorno indietro |
| Prova: trigger delle eliminazioni + N (N = 9 + 2), modifiche da 13 a 20, conteggio per tabella entro una settimana, dimensione nella stima, rettifica di prova | 14 (Passo 6, a caldo), Per la sessione dopo (punti 4-6) |
| §5: prerequisiti come fatti (PR della sessione 2 mergiata, sua migrazione applicata, nessuna PR `robustezza2/` aperta), worktree da `main`, corpi dalla produzione, ROLLBACK, conteggio di `enrollment_submissions`, gate, merge a mano | 1, 2, 3, 8, 13, 14 |
| §5: chiusura della sessione rilasciata per ultima nel primo commit (la sua «Per la sessione dopo», fotografia delle migrazioni, niente commit vuoti) | 1 (Passo 4) |
| §5: riga di stato trovata con `grep "^\| 3 \|"`, «in revisione» nella propria PR, «in produzione» solo dalla sessione dopo; nessun ramo di soli documenti dopo il rilascio | 13 (Passo 4), 14 (Passi 3, 7, 8), Per la sessione dopo (punti 7, 8) |
| §6: sezione «Per la sessione dopo» (fotografie col loro comando, liste da svuotare, riga di stato, `SELECT` del «dopo» con quando maturano, PRD) | Per la sessione dopo |
| Sostituzioni per contenuto nei file che altre sessioni cambiano (runbook: sessioni 4 e 5; PRD: sessioni 1 e 2; tabella di stato) | 13 (Passi 1, 2, 4), Per la sessione dopo (punto 9) |
| Pulizie in blocco fuori dal database: «libera spazio» su `chat_messages` via PostgREST | 2 (Passo 7), Decisioni che restano al titolare |

Segnaposto: nessuno. I soli valori da riempire sono le misure fra graffe del Compito 2 (chiavi del file delle misure) e il gettone `@PR@`, sostituito nel Compito 14, Passo 3, con un controllo che non ne resti nessuno.

Nomi usati fra i compiti, controllati: `istanteVersione`, `pathDefinitivi(...).prefissoVersioni` e `.versione(istante, percorsoAttuale)` (Compiti 8, 9, 10); suffissi `_scatola_nera_cascate_anagrafiche.sql` e `_scatola_nera_protocollo.sql` (Compiti 3-8, 13, 14); marcatori `figlie-in-cascata`, `anagrafiche-storico`, `tabelle-protocollo` (Compiti 4, 5, 8, 13); `esito` `risposte-non-contate` e campo `n_risposte_portate_via` (Compito 11, Log, PRD).

---

## Decisioni che restano al titolare

- **`registro_destinatari`.** È una figlia in cascata di `alunni` che il rapporto del 20/10 nomina (D4) e la §7 no. Il Passo 5 del Compito 2 ne dà la crescita stimata; entra con una riga nel ciclo del Compito 4 se il titolare lo chiede.
- **Le versioni del protocollo non scadono.** Restano finché la registrazione esiste, come il documento. Un giro che le facesse scadere lascerebbe un battito in `app_log`, cioè una traccia tecnica che le decisioni #6 e #26 vietano.
- **L'eliminazione di un protocollo toglie subito i file**, mentre la riga resta 90 giorni in scatola: i file tornano solo dallo specchio di R2 (30 giorni). È la decisione #2; la sessione 10 (operazioni a più passi) è il posto per cambiarla.
- **Il testo dell'informativa** (Compito 12) è testo legale, in particolare la frase sul protocollo che non si dimentica.
- **`chat_messages` e «libera spazio».** `src/lib/alunni/libera-spazio.ts:432-437` cancella via PostgREST tutti i messaggi senza allegato delle conversazioni di un bambino ritirato: è una pulizia in blocco che le query del Compito 2, Passo 7, su `pg_proc` e `cron.job` non vedono. Con `chat_messages` nella scatola, ognuno di quei messaggi resta 90 giorni in `scatola_nera.eliminazioni`: lo spazio si libera dopo 90 giorni e i testi delle famiglie restano nel database per quel tempo (l'oblio li toglie se richiesto). **Domanda al titolare, prima del Compito 4, con i numeri del Passo 7: escludere quella pulizia dalla scatola, o accettarlo?** Escluderla vuol dire una funzione SQL che accende `scatola_nera.senza_storico` per la sola `DELETE` di «libera spazio» (PostgREST non può farlo da sé), e un piano corretto prima di eseguire; accettarlo vuol dire procedere con gli elenchi di questo piano.
