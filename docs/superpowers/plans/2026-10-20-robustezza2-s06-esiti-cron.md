# Sessione 6 — Esiti dei cron: si osserva, non si cambia — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** sapere l'esito vero di ogni job di `pg_cron` — HTTP o solo SQL — e trovarlo in `app_log` col nome del job, senza cambiare niente di quello che i job fanno: stesse route, stessi corpi, stessi header, **stesso timeout di ciascuna funzione**.

**Architettura:** un modulo Node senza dipendenze, `scripts/cron-esiti/involucro.mjs`, prende i corpi delle funzioni **dalla produzione** (`pg_get_functiondef`, Passo 0.6) e in ciascuno sostituisce l'unica chiamata `net.http_post(` con `public.cron_http_post('<job>', `, senza toccare un altro carattere: URL, corpo, header e timeout restano quelli di oggi. Una migrazione crea `cron_chiamate` e `cron_ultimo_esito`, l'involucro `cron_http_post` (SECURITY DEFINER: manda la richiesta come prima e poi ne registra il numero, e se la registrazione fallisce la richiesta parte lo stesso) e il lettore `cron_esiti()`, pianificato ogni 10 minuti, che chiude le chiamate leggendo `net._http_response`, aggiorna l'ultimo esito di ogni job da `cron.job_run_details` e scrive in `app_log`. Un test PGlite con `net` e `cron` finti prova la migrazione e l'equivalenza prima/dopo di ogni funzione ridefinita; il lock `cron-http-esito-osservato` passa da «solo `iscrizioni_retention_http`» a «tutte le funzioni che chiamano il server».

**Tecnologie:** SQL Postgres/Supabase (plpgsql, `pg_net`, `pg_cron`, Vault) · Node 24 ESM con la sola libreria standard · Vitest con PGlite (`@electric-sql/pglite`) · `gh`.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, Sessione 6 (con le regole comuni della §5, il formato della §6 e i divieti 4, 8, 11 e 18 della §8).

---

## Convenzioni di questo piano

Alcuni valori esistono solo il giorno in cui si esegue. Nel piano compaiono come **gettoni** fra due chiocciole, e chi esegue li sostituisce col valore vero **nel momento in cui scrive quel testo**:

| Gettone | Valore | Da dove viene |
|---|---|---|
| `@GIORNO@` | data UTC, forma `AAAA-MM-GG` | `date -u +%F` il giorno in cui si scrive il testo |
| `@VERSIONE@` | le 14 cifre della migrazione | `date -u +%Y%m%d%H%M%S` al Compito 4, passo 3 (mai un orario tondo, mai nel futuro) |
| `@N_ISCRIZIONI@`, `@ORA_CONTEGGIO@` | conteggio e ora UTC | Passo 0, misura 0.1 |
| `@N_JOB@`, `@N_JOB_ATTIVI@` | job in `cron.job`, di cui attivi | Passo 0, misura 0.4 |
| `@RISPOSTE_6H@`, `@TIMEOUT_6H@`, `@ERRORI_6H@` | righe di `net._http_response`, di cui scadute, di cui in errore | Passo 0, misura 0.7 |
| `@DIVERSE@` | nomi delle funzioni il cui corpo in produzione è diverso dal repo, oppure `nessuna` | Compito 3, passo 2 |
| `@FUNZIONE_ASSENTE@`, `@FILE_ASSENTE@` | funzione del repo che in produzione non chiama il server, e il file della sua ultima definizione | Compito 3, passo 3 (solo se ce n'è una) |
| `@N_AVVOLTE@` | funzioni ridefinite dalla migrazione | Compito 5, passo 3 |
| `@PR@` | numero della PR di questa sessione | «Rilascio», passo 3 |
| `@ORA_VERIFICA@` | ora UTC del `SELECT` di conferma | «Rilascio», passo 9 (finisce solo nel commento della PR) |

Prima di ogni commit: `git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'` → **nessuna riga**, salvo dove il passo dice quale gettone resta. Un gettone rimasto in un file committato è un difetto.

Le misure del Passo 0 si annotano, man mano, in `/tmp/kidville-s06-misure.txt` (fuori dal repo; solo numeri, date, codici HTTP, codici d'errore e nomi di job, tabelle e funzioni). Le definizioni delle funzioni vanno in `/tmp/kidville-s06-definizioni-*.json`, anch'esse fuori dal repo fino al Compito 5, dove entrano nella migrazione **dopo** il controllo dei segreti.

**Dati di minori, repository pubblico.** Nessuna query di questo piano legge righe di tabelle con dati personali: si contano. Dai job si legge il **nome**, mai il testo di `command` (può contenere un URL o un'intestazione); da `net._http_response` si legge il codice e al massimo 40 caratteri di `error_msg`, mai `content` né `headers`.

---

## Mappa dei file

Percorsi e righe letti il 20/10 nel worktree `/Users/lerri/kidville-web-analisi-2026-10-20` (stesso commit di `origin/main`, `4c6df438`).

| File | Azione | Ruolo |
|---|---|---|
| `scripts/cron-esiti/involucro.mjs` | Crea | trasformazione di testo: corpo di `pg_get_functiondef` → corpo che passa dall'involucro; confronto col repo; migrazione inversa |
| `__tests__/lib/cron-esiti-involucro.test.ts` | Crea | casi del modulo, più il giro andata e ritorno su ogni funzione vera del repo |
| `supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql` | Crea | tabelle, involucro, funzioni ridefinite (generate), lettore, job `cron-esiti` |
| `__tests__/db/cron-esiti.test.ts` | Crea | PGlite con `net` e `cron` finti: la migrazione gira, classifica, registra, e ogni funzione ridefinita fa la stessa chiamata di prima |
| `__tests__/architecture/cron-http-esito-osservato.test.ts` (157 righe) | Riscrive | storia (righe 5-46) conservata e allungata; il perimetro «solo iscrizioni» (38-45) diventa «tutte»; `corpo()` (66-78) oggi legge solo i corpi `$$` |
| `src/lib/health/controlli.ts:415-436` | Modifica | voce `cron-esiti` in fondo a `export const JOB_CRON_NON_SORVEGLIATI`, dopo la voce `nome: 'fascicolo-audit-ip-retention'` e prima della `]` che chiude l'elenco (righe 415-436 il 20/10; la sessione 1 può averle spostate: si cerca il testo) |
| `__tests__/architecture/soglia-fotografia.ts:251` | Modifica | voce della migrazione in `MIGRAZIONI_ATTESE_AL_MERGE` (tocca una PRIMARY KEY e la RLS); la riga si cerca col testo `export const MIGRAZIONI_ATTESE_AL_MERGE`; la voce la toglie la sessione dopo («Per la sessione dopo») |
| `PRD REGISTRO ELETTRONICO.md:1` | Modifica | voce di changelog in cima |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | Modifica | riga 6 della tabella di stato (`grep -n "^| 6 |"`), a «in revisione» nella PR di questa sessione; «in produzione» lo scrive la sessione dopo |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` (e le altre che nomina la sessione chiusa) | Modifica | solo nel primo commit (Compito 1, passo 4): la chiusura della sessione rilasciata per ultima. Le fotografie che cambiano per **questa** migrazione (migrazioni, indici unici, policy) le rigenera la sessione dopo |

**Non si toccano, e perché:**
- `__tests__/architecture/cron-sorvegliato-e-applicato.test.ts`: la sua regex `installano` (righe 86-89) prende `cron.schedule('cron-esiti'` e pretende il nome in `JOB_CRON` o in `JOB_CRON_NON_SORVEGLIATI` con una ragione di più di 30 caratteri (158-170), mai in entrambe (172-181). Lo soddisfa il Compito 4, passo 5, nello stesso commit della migrazione. Nell'intestazione della migrazione **non** si scrivono le parole che la sua `MARCATA_NON_APPLICATA` cerca (`NON APPLICATA`, `NON ANCORA APPLICATA`).
- `__tests__/architecture/stati-alunno-anche-in-sql.test.ts:107-118, 176-188`: legge l'**ultima** definizione di `storici_tick` (con qualunque `$tag$`) e pretende `alunno_uscita_consolidata`. Dopo la migrazione l'ultima definizione è quella generata dalla produzione: se il lock diventa rosso, il corpo di produzione è diverso dal repo e lo dice già il Compito 3.
- `__tests__/architecture/security-definer-revoke-lock.test.ts`: pretende un `REVOKE … FROM PUBLIC, anon, authenticated` **dopo** ogni `CREATE … SECURITY DEFINER` dello stesso file e non annullato da un `GRANT` a quei ruoli. Il generatore lo scrive dopo ogni funzione; non si aggiunge niente alle sue deroghe.
- `__tests__/api/gdpr-retention-cestino-registro.test.ts:883-904`: legge il file fisso `20260924220100_cestino_registro_cron.sql`, che non cambia.
- Le migrazioni vecchie (`20260712220000_cron_config_vault.sql` e le altre della tabella del Compito 3): sono storia; le funzioni le ridefinisce la migrazione nuova.
- `src/app/api/**`: nessuna route cambia. È la regola della sessione: si osserva, non si cambia.

## Fuori perimetro, scritto e non sottinteso

- **Cambiare un timeout, una pianificazione o una route.** È la sessione 8, che parte dalla misura «dopo» di questa (D3: timeout per job, chiamate a `/api/admin/storici/cron`).
- **Portare `cron-esiti` sotto sorveglianza in `JOB_CRON`** e far leggere `cron_ultimo_esito` alla salute: sessione 7, dopo il primo battito.
- **`genera_solleciti()`** (baseline `20260704120000_baseline.sql:575-644`): deprecata dal 2026-07-10, SECURITY INVOKER, nessun job la chiama. Non si avvolge: avvolgerla chiederebbe di aprire l'involucro a `service_role`.
- **Chiamate a `pg_net` fuori dallo schema `public`** e `net.http_get`/`net.http_delete`: il Passo 0.5 le conta; se esistono restano come sono e figurano come «orfane attese» nella misura D2.
- **Spostare `pg_net` fuori da `public`** (§8, divieto 8): non si fa.
- **Leggere o conservare il corpo delle risposte.** Si conserva il solo codice d'errore in maiuscolo (per esempio `CRON_NON_AUTORIZZATO`), mai il testo.

---

## Passo 0 — misura prima

In **sola lettura**, prima del Compito 1 e di nuovo, per le misure 0.1, 0.6b e 0.7, il giorno della PR. Le query si lanciano con lo strumento MCP `execute_sql` (dopo la sessione 2 il freno lascia passare le letture). Ogni risultato va in `/tmp/kidville-s06-misure.txt` con data e ora UTC (`date -u '+%F %T'`). Chi scrive questo piano non ha accesso alla produzione: **nessun numero qui sotto è un risultato**, i valori del 20/10 citati sono quelli della specifica.

- [ ] **0.1 — Conteggio delle iscrizioni (§5, prima di ogni migrazione) e sessione 2 applicata**

```sql
SELECT count(*) AS domande,
       to_regprocedure('public.exec_sql(text)') IS NULL AS sessione_2_applicata,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc
  FROM enrollment_submissions;
```

`domande` → `@N_ISCRIZIONI@`, `ora_utc` → `@ORA_CONTEGGIO@`. `sessione_2_applicata` deve essere `true` (§3: la 6 dipende dalla 2).

- [ ] **0.2 — `pg_net` e `pg_cron`: versioni, vita delle risposte, colonne**

```sql
SELECT e.extname, e.extversion, n.nspname AS schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname IN ('pg_net', 'pg_cron');

SELECT current_setting('pg_net.ttl', true) AS ttl,
       current_setting('pg_net.batch_size', true) AS batch_size;

SELECT table_name,
       string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS colonne
  FROM information_schema.columns
 WHERE table_schema = 'net' AND table_name IN ('_http_response', 'http_request_queue')
 GROUP BY table_name;
```

Atteso: `pg_net` nello schema `public` (divieto 8: resta lì; le funzioni stanno comunque nello schema `net`), `ttl` = `6 hours`; `_http_response` con `id`, `status_code`, `content_type`, `headers`, `content`, `timed_out`, `error_msg`, `created`; `http_request_queue` con `id`.

- [ ] **0.3 — La firma vera di `net.http_post`**

```sql
SELECT p.oid::regprocedure AS firma,
       pg_get_function_arguments(p.oid) AS argomenti,
       pg_get_function_result(p.oid) AS risultato,
       pg_get_userbyid(p.proowner) AS proprietario,
       has_function_privilege('postgres', p.oid, 'EXECUTE') AS postgres,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'net' AND p.proname = 'http_post';
```

Atteso: **una** riga, `risultato` = `bigint`, `argomenti` = `url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000`, `postgres` = `true`. L'involucro ripete **questi** nomi e **questi** default dopo il suo primo argomento: è ciò che rende la sostituzione testuale esatta anche per le chiamate con argomenti per nome (`url := v_url, …`).

- [ ] **0.4 — I job di `pg_cron` (nomi, mai il testo del comando)**

```sql
SELECT jobid, jobname, schedule, active, username,
       command ~* 'net\s*\.\s*http_' AS chiama_net_direttamente,
       command ~* '(bearer|apikey|authorization|service_role|secret)' AS cita_credenziali,
       substring(lower(command) FROM '(?:public\.)?([a-z_][a-z0-9_]*)\s*\(') AS prima_chiamata
  FROM cron.job ORDER BY jobname;

SELECT count(*) AS job, count(*) FILTER (WHERE active) AS attivi FROM cron.job;
```

`job` → `@N_JOB@`, `attivi` → `@N_JOB_ATTIVI@`. La specifica il 20/10 dice 30 job; il numero che conta è questo. `chiama_net_direttamente` deve essere `false` per **tutti**: un job che chiama `pg_net` senza passare da una funzione non lo può avvolgere una ridefinizione. `cita_credenziali` si annota e basta (il comando non si legge).

- [ ] **0.5 — Chi altro chiama `pg_net`**

```sql
SELECT n.nspname AS schema, count(*) AS funzioni
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosrc ~* 'net\s*\.\s*http_(post|get|delete)\s*\(' AND n.nspname <> 'net'
 GROUP BY 1 ORDER BY 1;

SELECT p.proname,
       p.prosrc ~* 'net\s*\.\s*http_get' AS usa_get,
       p.prosrc ~* 'net\s*\.\s*http_delete' AS usa_delete
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc ~* 'net\s*\.\s*http_(get|delete)';

SELECT count(*) AS webhook
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'supabase_functions' AND NOT t.tgisinternal;
```

Atteso: solo `public` nella prima; nessuna riga nella seconda; `webhook` = 0. Il totale delle funzioni fuori da `public` più i webhook è il numero di «orfane attese» della misura D2.

- [ ] **0.6 — Le definizioni delle funzioni che chiamano il server (la fonte della migrazione)**

```sql
SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.proname), '[]'::jsonb) AS righe FROM (
  SELECT p.proname,
         pg_get_functiondef(p.oid) AS definizione,
         md5(pg_get_functiondef(p.oid)) AS impronta,
         oidvectortypes(p.proargtypes) AS tipi,
         pg_get_userbyid(p.proowner) AS proprietario,
         p.prosecdef AS security_definer,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
         coalesce((SELECT jsonb_agg(j.jobname ORDER BY j.jobname) FROM cron.job j
                    WHERE j.command ~* ('\m(public\.)?' || p.proname || '\s*\(')),
                  '[]'::jsonb) AS job
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.prosrc ~* '(net\s*\.\s*http_post|cron_http_post)'
   ORDER BY p.proname
) r;
```

Il valore di `righe` (un array JSON) si salva **com'è** in `/tmp/kidville-s06-definizioni-1.json`. Se la risposta è troppo grande per un colpo solo, si aggiunge `LIMIT 7 OFFSET 0` (poi `OFFSET 7`, `14`, `21`) dentro la sottoquery e si salvano `-1.json`, `-2.json`, … : il modulo del Compito 2 li unisce e controlla che nessun nome compaia due volte. L'`impronta` serve a scoprire un errore di trascrizione: il modulo ricalcola l'md5 della `definizione` e si ferma se non torna. Si annotano nel file delle misure il numero di righe e, per ciascuna, `proname`, `job`, `security_definer`, `anon`, `authenticated`, `service_role` (niente corpi).

- [ ] **0.6b — Impronte di controllo (si rifà il giorno della PR e prima del merge)**

```sql
SELECT p.proname, md5(pg_get_functiondef(p.oid)) AS impronta
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND p.prosrc ~* '(net\s*\.\s*http_post|cron_http_post)'
 ORDER BY 1;
```

Atteso: stessi nomi e stesse impronte del file di 0.6. Se una cambia, qualcuno ha ridefinito la funzione dopo la misura: si rifà 0.6 e si rigenera la migrazione (Compito 5, passi 1-4) **prima** di chiedere il merge.

- [ ] **0.7 — Le risposte del server delle ultime ~6 ore (il «prima» della specifica: 27 senza risposta il 20/10)**

```sql
SELECT count(*) AS risposte,
       count(*) FILTER (WHERE coalesce(timed_out, false)
                           OR coalesce(error_msg, '') ILIKE 'Timeout of %') AS scadute,
       count(*) FILTER (WHERE status_code >= 400) AS http_400_e_oltre,
       count(*) FILTER (WHERE status_code IS NULL
                          AND NOT coalesce(timed_out, false)
                          AND coalesce(error_msg, '') NOT ILIKE 'Timeout of %') AS rete,
       min(created) AS prima, max(created) AS ultima,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc
  FROM net._http_response;

SELECT status_code, coalesce(timed_out, false) AS scaduta,
       left(error_msg, 40) AS errore, count(*) AS righe
  FROM net._http_response
 GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

`risposte` → `@RISPOSTE_6H@`, `scadute` → `@TIMEOUT_6H@`, `http_400_e_oltre + rete` → `@ERRORI_6H@` (la specifica: errore = 4xx, 5xx o rete; un 3xx non conta, e il lettore lo chiude come `ok`). Oggi queste righe non hanno un nome di job: è proprio ciò che la sessione aggiunge.

- [ ] **0.8 — Le esecuzioni di `pg_cron`**

```sql
SELECT count(*) AS righe, min(runid) AS primo, max(runid) AS ultimo,
       count(*) FILTER (WHERE start_time > now() - interval '10 minutes') AS ultimi_10_minuti
  FROM cron.job_run_details;

SELECT j.jobname, count(*) AS fallite_7_giorni
  FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
 WHERE d.status = 'failed' AND d.start_time > now() - interval '7 days'
 GROUP BY 1 ORDER BY 2 DESC;
```

La specifica dice 93.577 righe al 20/10 (la sessione 8 le pota). `ultimi_10_minuti` dice quante esecuzioni il lettore deve scorrere a ogni giro.

- [ ] **0.9 — `app_log`: cosa c'è oggi e che i nomi nuovi siano liberi**

```sql
SELECT livello, count(*) AS righe, sum(occorrenze) AS occorrenze
  FROM app_log
 WHERE evento = 'cron' AND visto_l_ultima > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1;

SELECT count(*) AS righe_error_15_minuti, count(DISTINCT fingerprint) AS impronte_error_15_minuti
  FROM app_log
 WHERE livello = 'error' AND sorgente = 'server' AND visto_l_ultima > now() - interval '15 minutes';

SELECT fingerprint, count(*) AS righe
  FROM app_log
 WHERE fingerprint LIKE 'cron-http:%' OR fingerprint LIKE 'cron-http-timeout:%'
    OR fingerprint LIKE 'cron-sql:%' OR fingerprint LIKE 'cron-esiti:%'
    OR fingerprint = 'cron:cron-esiti'
 GROUP BY 1;
```

Atteso: la terza senza righe. La seconda dice quanto margine resta sotto le soglie del controllo `tasso-errore` (`src/lib/health/controlli.ts`, 5 impronte o 25 occorrenze in 15 minuti).

- [ ] **0.10 — La fotografia delle migrazioni è al passo con la produzione**

```sql
SELECT max(version) AS ultima FROM supabase_migrations.schema_migrations;
```

```bash
jq -r '.migrazioni | map(.version) | max' __tests__/fixtures/migrazioni-applicate-snapshot.json
```

Atteso: lo stesso numero. Se la produzione è avanti, la fotografia si rigenera comunque nel Compito 1, passo 4 (la chiusura della sessione precedente), anche se quella sessione non aveva migrazioni.

- [ ] **0.11 — I nomi nuovi sono liberi**

```sql
SELECT to_regclass('public.cron_chiamate') AS chiamate,
       to_regclass('public.cron_ultimo_esito') AS ultimo_esito,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('cron_http_post', 'cron_esiti')) AS funzioni,
       (SELECT count(*) FROM cron.job WHERE jobname = 'cron-esiti') AS job;
```

Atteso: `NULL`, `NULL`, `0`, `0`.

### Soglie che cambiano il piano

| Misura | Esito | Cosa cambia |
|---|---|---|
| 0.1 | `sessione_2_applicata` = `false` | **STOP**: la sessione 2 non è in produzione (§3) |
| 0.2 | `ttl` sotto i 30 minuti | **STOP**: un giro ogni 10 minuti perderebbe esiti; si chiede al titolare |
| 0.2 | `ttl` diverso da `6 hours` | `v_vita_risposte` del lettore (Compito 4) prende il valore misurato |
| 0.2 | manca `timed_out` o `created` | si adatta il lettore e il suo stub prima di scriverli; si annota nella PR |
| 0.3 | più di una riga, risultato non `bigint`, `postgres` senza EXECUTE | **STOP** |
| 0.3 | argomenti diversi da quelli attesi | l'elenco misurato si copia **identico** nell'involucro, nello stub del test e nelle firme del Compito 4 |
| 0.4 | un job con `chiama_net_direttamente` | **STOP**: quel job non passa da una funzione; serve una decisione del titolare |
| 0.5 | funzioni fuori da `public`, o webhook | dichiarate fuori perimetro nella PR; contano come orfane attese in D2 |
| 0.6 | meno di 16 o più di 24 righe, o un nome ripetuto | **STOP**: il perimetro non è quello letto nel repo (20 funzioni) |
| 0.6 | l'impronta non torna | si risalva il JSON; mai correggere a mano una definizione |
| 0.7 | `@ERRORI_6H@` più di 6 | **STOP e domanda al titolare**: dal primo giro del lettore ogni job in errore diventa un'impronta `error`, e oltre 5 impronte in 15 minuti la salute degrada |
| 0.7 | `@ERRORI_6H@` da 1 a 6 | si scrive in grassetto in cima alla PR |
| 0.8 | `ultimi_10_minuti` sopra 400 | la finestra del lettore (`v_finestra_run`, 5000) si alza a 20 volte quel numero |
| 0.8 | fallimenti negli ultimi 7 giorni | diventeranno righe `cron-sql:<job>`: elenco dei job in grassetto nella PR |
| 0.9 | impronte con i prefissi nuovi già presenti | **STOP**: qualcuno usa già quei nomi |
| 0.10 | produzione avanti rispetto alla fotografia | Compito 1, passo 4: la fotografia delle migrazioni si rigenera in ogni caso |
| 0.11 | un nome occupato | **STOP** |

---

## Compiti

### Compito 1: prerequisiti, worktree e chiusura della sessione precedente

**File:**
- Nessun file del prodotto. Nel primo commit (passo 4) i file che elenca la sezione «Per la sessione dopo» della sessione rilasciata per ultima: di solito `__tests__/fixtures/migrazioni-applicate-snapshot.json` (e le altre fotografie che nomina), `__tests__/architecture/soglia-fotografia.ts`, la riga di quella sessione nella tabella di stato della specifica e la sua voce nel PRD.

- [ ] **Passo 1: i prerequisiti — la sessione 2 è mergiata e la sua migrazione è applicata; nessun'altra sessione aperta (§5)**

La colonna «Dopo» della riga 6 dice `2`. Si verificano due **fatti**, mai il testo dello «Stato» della tabella (quello lo chiude la sessione dopo, e può essere ancora «in revisione»):

```bash
cd /Users/lerri/kidville-web
git fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s02-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
git ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep '_via_exec_sql\.sql$' | cut -c1-14
```

Atteso: **una riga** dalla `gh` (numero e istante del merge della sessione 2) e **una** version di 14 cifre, quella della migrazione della sessione 2 (`<V2>`). Poi, in sola lettura con `execute_sql`, con quella version al posto di `<V2>`:

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('<V2>');
```

Atteso: **una riga**. È la stessa cosa che la misura 0.1 guarda da un altro lato (`sessione_2_applicata` = `true`). Poi nessuna PR della serie ancora aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: **nessuna riga**. Se uno di questi controlli fallisce: **fermati** (§3: la 6 dipende dalla 2; §5: una sessione alla volta).

- [ ] **Passo 2: la specifica è in `main` (PR #254)**

```bash
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md \
  | grep -n '^| 6 |'
```

Atteso: una riga, la 6 della tabella di stato, con Stato `da fare`. Se `git show` risponde `does not exist`, la PR #254 non è in `main`: **STOP**.

- [ ] **Passo 3: worktree nuovo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s06-esiti-cron /Users/lerri/kidville-web-s06 origin/main
cd /Users/lerri/kidville-web-s06
npm ci
```

Atteso: worktree creato sul ramo `robustezza2/s06-esiti-cron` (il nome del file del piano senza la data: la sessione dopo lo usa per ritrovare questo piano), `npm ci` senza errori. Da qui in poi **ogni comando gira in `/Users/lerri/kidville-web-s06`**, mai in `/Users/lerri/kidville-web` (altre sessioni lo usano). Se il build del passo 5 chiede `.env.local`, non lo si copia (è in `deny`): lo si chiede al titolare.

- [ ] **Passo 4: la chiusura della sessione rilasciata per ultima (primo commit, prima di ogni codice)**

Si trova la sessione della serie mergiata più di recente, qualunque numero abbia:

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga, `<numero> robustezza2/<nome>`. Si apre il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome>.md` (il nome del ramo senza `robustezza2/`), e si legge **per intero** la sua sezione finale «Per la sessione dopo». Si fa quello che elenca, e solo quello: fotografie rigenerate dalla produzione, voci tolte da `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste che nomina, la sua riga di stato a «in produzione» col commit di `main`, lo Stato della sua voce nel PRD, la misura «dopo» se è già matura (una misura non ancora matura resta scritta come tale, con il giorno da cui lo è). Non si indovina: se la sezione manca, o chiede una cosa che non torna con la produzione, ci si ferma e si chiede al titolare. Se la `gh` non stampa niente (nessuna sessione della serie rilasciata), il passo si salta: per la 6 non può succedere, perché il passo 1 ha trovato la 2.

La fotografia delle migrazioni si rigenera **sempre** quando la sessione chiusa aveva migrazioni, e anche quando la misura 0.10 ha trovato la produzione avanti:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

La query stampata si esegue con `execute_sql` (sola lettura, una tabella di sistema), la risposta JSON va in `/tmp/kidville-s06-foto-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < /tmp/kidville-s06-foto-migrazioni.json
jq -r '.migrazioni | map(.version) | max' __tests__/fixtures/migrazioni-applicate-snapshot.json
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -6
```

Atteso: la version più alta è quella della misura 0.10; `Test Files  2 passed`. Le altre fotografie (indici unici, policy, chiavi esterne, bucket, tabelle per sede) si rigenerano **solo** se la sezione della sessione chiusa le nomina, ciascuna col comando che dà lì, e col suo lock lanciato subito dopo. Commit, con i file che la sezione ha toccato:

```bash
git add __tests__/fixtures/ __tests__/architecture/soglia-fotografia.ts \
  docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git status --short
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: chiusura della sessione rilasciata per ultima (fotografie, stato, PRD)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: `git status --short` senza righe ` M` o `??` fuori dal commit (se la sezione chiusa ha toccato un altro file, lo si aggiunge e si rilancia); il `grep` senza righe. Nel messaggio del commit, al posto di «la sessione rilasciata per ultima», il nome del suo ramo.

- [ ] **Passo 5: gate di partenza**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
CI=1 npx vitest run 2>&1 | tail -6
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
```

Atteso: tutto verde. `CI=1` serve perché in un worktree nuovo il lock `offline-html-nativo` è rosso finché non c'è `cap sync` (§5); l'heap a 8192 perché il build locale va in OOM con quello di serie. Un lock di fotografia rosso (`onconflict-arbitro`, `rls-per-sede`, `tracce-docente-dichiarate`, …) vuol dire che la chiusura del passo 4 non ha rigenerato una fotografia che serviva: la si rigenera con il generatore che il messaggio d'errore nomina, sempre dalla produzione, e la si aggiunge al commit del passo 4 (`git commit --amend`, finché non c'è stato un push). Ogni altro rosso **prima** di toccare il codice si annota in `/tmp/kidville-s06-misure.txt` col nome del test e non si corregge qui. Mai `npm run e2e` né `e2e:seed` in locale.

---

### Compito 2: l'involucro come trasformazione di testo

Il cuore del rischio della sessione («un corpo copiato dal repo invece che dalla produzione») si chiude qui: la migrazione non la scrive una persona, la scrive questo modulo partendo da `pg_get_functiondef`, e il modulo cambia **una** cosa sola per funzione. Tutto ciò che può andare storto si ferma con un messaggio, mai in silenzio.

**File:**
- Crea: `scripts/cron-esiti/involucro.mjs`
- Test: `__tests__/lib/cron-esiti-involucro.test.ts`

- [ ] **Passo 1: scrivi il test che fallisce**

Crea `__tests__/lib/cron-esiti-involucro.test.ts`:

```ts
// @vitest-environment node
/**
 * Il modulo che riscrive le funzioni dei cron (sessione 6 della seconda serie di robustezza).
 *
 * Le definizioni vengono dalla PRODUZIONE (`pg_get_functiondef`), non dal repo: il modulo
 * sostituisce l'unica chiamata `net.http_post(` con `public.cron_http_post('<job>', ` e non
 * tocca un altro carattere. Questi casi provano che lo fa, che sa tornare indietro, e che si
 * ferma — con un messaggio — su tutto quello che non sa trattare.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ASSENTI_IN_PRODUZIONE, FUNZIONI_HTTP_AL_20_10, INVOLUCRO, LETTORE, NON_SI_AVVOLGONO,
  avvolgi, confronta, contaChiamate, corpoDi, corpoOVuoto, etichetta, genera, impronteDelRepo,
  inversa, leggiRighe, mascheraSql, md5, minimoAvvolte, normalizza, sospetti, svolgi,
  ultimeDefinizioni, ultimeDefinizioniDa,
} from '../../scripts/cron-esiti/involucro.mjs'

const TICK = `CREATE OR REPLACE FUNCTION public.prova_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_url text;
BEGIN
  -- una volta qui c'era net.http_post( con un altro indirizzo
  RAISE LOG 'si chiama net.http_post(';
  v_url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app.news_url');
  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
END;
$function$
`

type Riga = {
  proname: string; definizione: string; impronta: string; tipi: string; proprietario: string
  security_definer: boolean; anon: boolean; authenticated: boolean; service_role: boolean; job: string[]
}
function riga(p: Partial<Riga> & { proname: string; definizione: string }): Riga {
  const r = {
    tipi: '', proprietario: 'postgres', security_definer: true, anon: false,
    authenticated: false, service_role: false, job: [] as string[], ...p,
  }
  return { ...r, impronta: md5(r.definizione) }
}
const rinomina = (def: string, nome: string) => def.replace('public.prova_tick()', `public.${nome}()`)
const una = riga({ proname: 'prova_tick', definizione: TICK, job: ['news-tick'] })

describe('mascheraSql', () => {
  it('spegne commenti (anche annidati) e stringhe, e tiene lunghezza e a capo', () => {
    const sql = "SELECT 'a;b' -- c;d\n/* e /* f; */ g; */ ;"
    const m = mascheraSql(sql)
    expect(m).toHaveLength(sql.length)
    expect(m.split('\n')).toHaveLength(2)
    expect(m.indexOf(';')).toBe(sql.lastIndexOf(';'))
  })
  it('dollar quoting con e senza etichetta; `$1` e `a$b` non aprono niente', () => {
    const m = mascheraSql('SELECT $x$ ; $x$, $$ ; $$, $1, a$b ;')
    expect(m.match(/;/g)).toHaveLength(1)
  })
  it('apici raddoppiati e stringhe E con la barra rovesciata', () => {
    const m = mascheraSql("SELECT E'a\\';b', 'c'';d' ;")
    expect(m.match(/;/g)).toHaveLength(1)
  })
  it('con `stringhe: false` spegne solo i commenti', () => {
    expect(mascheraSql("SELECT 'x' -- y", { stringhe: false })).toBe("SELECT 'x'     ")
    expect(normalizza("a  -- b\n   c")).toBe('a c')
  })
})

describe('corpoDi', () => {
  it.each(['$$', '$function$', '$_$'])('separa testata, corpo e coda con %s', (tag) => {
    const def = `CREATE FUNCTION public.f() RETURNS void AS ${tag}SELECT 1;${tag} LANGUAGE sql\n`
    const p = corpoDi(def)
    expect(p.tag).toBe(tag)
    expect(p.corpo).toBe('SELECT 1;')
    expect(p.testata + p.corpo + p.tag + p.coda).toBe(def)
  })
  it('senza `AS $tag$`, o con il corpo mai chiuso, si ferma', () => {
    expect(() => corpoDi("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'"))
      .toThrow('definizione senza corpo «AS $tag$»')
    expect(() => corpoDi('CREATE FUNCTION f() AS $$ SELECT 1')).toThrow('corpo aperto da $$ e mai chiuso')
    expect(corpoOVuoto("CREATE FUNCTION f() AS 'x'")).toBe('')
  })
})

describe('contaChiamate, avvolgi, svolgi', () => {
  it('conta solo il codice: il commento e la stringa non contano', () => {
    expect(contaChiamate(corpoDi(TICK).corpo)).toEqual({ dirette: 1, avvolte: 0 })
  })
  it('avvolgi cambia una cosa sola: la chiamata, con l’etichetta del job', () => {
    const dopo = avvolgi(TICK, 'news-tick')
    expect(dopo).toBe(TICK.replace('PERFORM net.http_post(', "PERFORM public.cron_http_post('news-tick', "))
    expect(contaChiamate(corpoDi(dopo).corpo)).toEqual({ dirette: 0, avvolte: 1 })
  })
  it('svolgi è l’inversa esatta', () => {
    expect(svolgi(avvolgi(TICK, 'news-tick'))).toEqual({ definizione: TICK, job: 'news-tick' })
  })
  it('si ferma su etichetta non valida, corpo già avvolto, zero o due chiamate, forma non canonica', () => {
    expect(() => avvolgi(TICK, 'News_Tick')).toThrow('etichetta non valida')
    expect(() => avvolgi(avvolgi(TICK, 'a'), 'a')).toThrow("il corpo passa già dall'involucro")
    expect(() => avvolgi(TICK.replace('PERFORM net.http_post(', 'PERFORM net.http_get('), 'a'))
      .toThrow('attesa UNA chiamata a net.http_post nel codice, trovate 0')
    expect(() => avvolgi(TICK.replace('END;', 'PERFORM net.http_post(url := v_url);\nEND;'), 'a'))
      .toThrow('attesa UNA chiamata a net.http_post nel codice, trovate 2')
    expect(() => avvolgi(TICK.replace('PERFORM net.http_post(', 'PERFORM net . http_post ('), 'a'))
      .toThrow('forma non canonica')
    expect(() => svolgi(TICK)).toThrow("attese UNA chiamata all'involucro e nessuna diretta, trovate 0 e 1")
  })
})

describe('etichetta', () => {
  it('il nome del job; senza job il nome della funzione; mai due job', () => {
    expect(etichetta({ proname: 'news_tick', job: ['news-tick'] })).toBe('news-tick')
    expect(etichetta({ proname: 'video_runner_kick', job: [] })).toBe('video-runner-kick')
    expect(() => etichetta({ proname: 'x_tick', job: ['a', 'b'] })).toThrow('la chiamano 2 job (a, b)')
  })
})

describe('sospetti', () => {
  it('trova segreti e dati personali, non i nomi delle chiavi del Vault', () => {
    expect(sospetti(TICK)).toEqual([])
    expect(sospetti(`'Bearer ${'k'.repeat(24)}'`)).toContain('un token dopo «Bearer»')
    expect(sospetti(['eyJ' + 'a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)].join('.'))).toContain('un JWT')
    expect(sospetti('sb_secret_' + 'x'.repeat(12))).toContain('una chiave Supabase')
    expect(sospetti('re_' + 'y'.repeat(20))).toContain('una chiave di un fornitore')
    expect(sospetti('prova@example.invalid')).toContain('un indirizzo email')
    expect(sospetti('AAAAAA00A00A000A')).toContain('un codice fiscale')
  })
})

describe('leggiRighe', () => {
  it('unisce più file, ricontrolla l’impronta e i tipi', () => {
    const due = riga({ proname: 'altra_tick', definizione: rinomina(TICK, 'altra_tick') })
    expect(leggiRighe([JSON.stringify([una]), JSON.stringify([due])]).map((r: Riga) => r.proname))
      .toEqual(['prova_tick', 'altra_tick'])
    expect(() => leggiRighe([JSON.stringify([una]), JSON.stringify([una])])).toThrow('compare due volte')
    expect(() => leggiRighe([JSON.stringify([{ ...una, impronta: md5('altro') }])])).toThrow("l'impronta non torna")
    expect(() => leggiRighe(['{}'])).toThrow('array')
    expect(() => leggiRighe([JSON.stringify([{ ...una, job: 'news-tick' }])])).toThrow('job')
  })
})

describe('genera', () => {
  it('ridefinisce, revoca, e ridà EXECUTE a service_role solo a chi lo aveva', () => {
    const conGrant = riga({ proname: 'altra_tick', definizione: rinomina(TICK, 'altra_tick'), service_role: true })
    const { sql, saltate } = genera([una, conGrant])
    expect(saltate).toEqual([])
    expect(sql.indexOf('-- altra_tick')).toBeLessThan(sql.indexOf('-- prova_tick'))
    expect(sql).toContain("public.cron_http_post('news-tick', ")
    expect(sql).toContain("public.cron_http_post('altra-tick', ")
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.prova_tick() FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.altra_tick() TO service_role;')
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTION public.prova_tick()')
    expect(sql).toContain(`impronta ${una.impronta}`)
  })
  it('salta chi cita net.http_post solo in commenti o stringhe, e genera_solleciti con la sua ragione', () => {
    const soloCommento = riga({
      proname: 'commento_tick',
      definizione: rinomina(TICK, 'commento_tick').replace('PERFORM net.http_post(', 'PERFORM net.http_get('),
    })
    const vecchia = riga({ proname: 'genera_solleciti', definizione: rinomina(TICK, 'genera_solleciti'), security_definer: false })
    const { sql, saltate } = genera([una, soloCommento, vecchia])
    expect(saltate).toEqual([
      'commento_tick: cita net.http_post solo in commenti o stringhe',
      `genera_solleciti: ${NON_SI_AVVOLGONO.genera_solleciti}`,
    ])
    expect(sql).not.toContain('commento_tick')
    expect(sql).not.toContain('genera_solleciti')
  })
  it.each([
    ['un proprietario diverso da postgres', { proprietario: 'supabase_admin' }, 'proprietario'],
    ['SECURITY INVOKER', { security_definer: false }, 'SECURITY INVOKER'],
    ['EXECUTE ad anon', { anon: true }, 'anon o authenticated'],
    ['EXECUTE ad authenticated', { authenticated: true }, 'anon o authenticated'],
    ['due job sulla stessa funzione', { job: ['a', 'b'] }, 'non sarebbe univoca'],
  ])('si ferma con %s', (_caso, cambio, messaggio) => {
    expect(() => genera([{ ...una, ...cambio }])).toThrow(messaggio)
  })
  it('si ferma su un segreto nel corpo, su un involucro già esistente, su un corpo già avvolto', () => {
    const conToken = TICK.replace("'Content-Type', 'application/json'", `'Authorization', 'Bearer ${'k'.repeat(24)}'`)
    expect(() => genera([riga({ proname: 'prova_tick', definizione: conToken })])).toThrow('il repository è pubblico')
    expect(() => genera([riga({ proname: INVOLUCRO, definizione: rinomina(TICK, INVOLUCRO) })])).toThrow('esiste già in produzione')
    expect(() => genera([riga({ proname: 'prova_tick', definizione: avvolgi(TICK, 'x') })])).toThrow("passa già dall'involucro")
  })
})

describe('inversa', () => {
  it('rimette le definizioni di prima coi loro permessi, poi spegne il job e toglie funzioni e tabelle', () => {
    const migrazione =
      'CREATE TABLE IF NOT EXISTS public.cron_chiamate (id bigint);\n' +
      'CREATE OR REPLACE FUNCTION public.cron_http_post(job text) RETURNS bigint LANGUAGE sql AS $f$ SELECT 1::bigint $f$;\n' +
      genera([una]).sql
    const inv = inversa(migrazione)
    expect(inv).toContain(TICK.trimEnd() + ';')
    expect(inv).toContain('REVOKE ALL ON FUNCTION public.prova_tick() FROM PUBLIC, anon, authenticated;')
    expect(inv).not.toContain('cron_http_post(job text)')
    const pos = (s: string) => inv.indexOf(s)
    expect(pos('public.prova_tick()')).toBeLessThan(pos('cron.unschedule'))
    expect(pos('cron.unschedule')).toBeLessThan(pos('DROP FUNCTION IF EXISTS public.cron_esiti()'))
    expect(pos('DROP FUNCTION IF EXISTS public.cron_http_post(')).toBeLessThan(pos('DROP TABLE IF EXISTS public.cron_ultimo_esito'))
    expect(inv).toMatch(/^-- distruttiva approvata: .{15,}$/m)
    expect(inv.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true)
    expect(() => inversa('SELECT 1;')).toThrow('nessuna funzione avvolta')
  })
})

describe('ultimeDefinizioniDa e confronta', () => {
  it('vince l’ultima definizione, un DROP la toglie, un commento non definisce niente', () => {
    const m = ultimeDefinizioniDa([
      { nome: '1.sql', sql: 'CREATE FUNCTION public.a() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\nCREATE FUNCTION b() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;' },
      { nome: '2.sql', sql: '-- CREATE OR REPLACE FUNCTION public.a() finta\ncreate or replace function public.a() RETURNS int AS $x$ SELECT 2; $x$ LANGUAGE sql;\nDROP FUNCTION IF EXISTS public.b();' },
    ])
    expect([...m.keys()]).toEqual(['a'])
    expect(m.get('a')).toEqual({ file: '2.sql', definizione: 'create or replace function public.a() RETURNS int AS $x$ SELECT 2; $x$ LANGUAGE sql' })
  })
  it('cinque esiti, in ordine di nome', () => {
    const repo = new Map([
      ['uguale', { file: 'r1.sql', definizione: rinomina(TICK, 'uguale') }],
      ['spazi', { file: 'r2.sql', definizione: rinomina(TICK, 'spazi').replace('  RAISE LOG', '      RAISE LOG').replace('altro indirizzo', 'indirizzo vecchio') }],
      ['diversa', { file: 'r3.sql', definizione: rinomina(TICK, 'diversa').replace("'app.news_url'", "'app.altro_url'") }],
      ['nel_repo', { file: 'r4.sql', definizione: rinomina(TICK, 'nel_repo') }],
    ])
    const righe = ['uguale', 'spazi', 'diversa', 'solo_prod'].map((n) => riga({ proname: n, definizione: rinomina(TICK, n) }))
    expect(confronta(righe, repo)).toEqual([
      { funzione: 'diversa', esito: 'diverso', file: 'r3.sql' },
      { funzione: 'nel_repo', esito: 'solo-nel-repo', file: 'r4.sql' },
      { funzione: 'solo_prod', esito: 'solo-in-produzione', file: '' },
      { funzione: 'spazi', esito: 'uguale-a-meno-di-commenti-e-spazi', file: 'r2.sql' },
      { funzione: 'uguale', esito: 'identico', file: 'r1.sql' },
    ])
  })
})

describe('sulle funzioni vere del repo', () => {
  const repo = ultimeDefinizioni(join(process.cwd(), 'supabase/migrations'))

  it('legge i DROP: exec_sql non c’è più (sessione 2)', () => {
    expect(repo.has('exec_sql')).toBe(false)
  })

  it('il minimo da avvolgere è 20 meno le esclusioni dichiarate, e ogni esclusione è vera', () => {
    expect(minimoAvvolte()).toBe(
      FUNZIONI_HTTP_AL_20_10 - Object.keys(NON_SI_AVVOLGONO).length - Object.keys(ASSENTI_IN_PRODUZIONE).length,
    )
    for (const [nome, ragione] of Object.entries({ ...NON_SI_AVVOLGONO, ...ASSENTI_IN_PRODUZIONE })) {
      expect(String(ragione).length, nome).toBeGreaterThan(30)
      const def = repo.get(nome)
      expect(def, `${nome} non è più nel repo: togli la voce`).toBeDefined()
      expect(contaChiamate(corpoOVuoto(def!.definizione)).dirette, nome).toBe(1)
    }
  })

  it('avvolgere e svolgere restituisce ogni definizione carattere per carattere', () => {
    let provate = 0
    for (const [nome, { definizione }] of repo) {
      if (nome === INVOLUCRO || nome === LETTORE || nome in NON_SI_AVVOLGONO) continue
      const { dirette, avvolte } = contaChiamate(corpoOVuoto(definizione))
      if (dirette + avvolte === 0) continue
      const prima = avvolte === 1 && dirette === 0 ? svolgi(definizione).definizione : definizione
      const job = nome.replace(/_/g, '-')
      expect(svolgi(avvolgi(prima, job)), nome).toEqual({ definizione: prima, job })
      provate++
    }
    expect(provate).toBeGreaterThanOrEqual(minimoAvvolte())
  })

  it('impronte: una riga «nome<TAB>md5 del corpo» per funzione, in ordine', () => {
    const righe = impronteDelRepo(repo)
    expect(righe.length).toBeGreaterThanOrEqual(minimoAvvolte())
    for (const r of righe) expect(r).toMatch(/^[a-z_][a-z0-9_]*\t[0-9a-f]{32}$/)
    expect([...righe].sort()).toEqual(righe)
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire**

```bash
npx vitest run __tests__/lib/cron-esiti-involucro.test.ts 2>&1 | tail -8
```

Atteso: FAIL, `Failed to load url ../../scripts/cron-esiti/involucro.mjs` (o `Cannot find module`). Il file non esiste ancora.

- [ ] **Passo 3: scrivi il modulo**

Crea `scripts/cron-esiti/involucro.mjs`:

```js
/**
 * Involucro dei cron — sessione 6 della seconda serie di robustezza.
 *
 * Le funzioni che i job di pg_cron usano per chiamare il server mandano la richiesta con
 * `net.http_post(…)` e buttano via il numero che pg_net restituisce: la risposta arriva dopo, in
 * `net._http_response`, e nessuno sa più di quale job fosse. Questo modulo riscrive ciascuna di
 * quelle funzioni cambiando UNA cosa sola: `net.http_post(` diventa
 * `public.cron_http_post('<job>', `. L'involucro ha gli stessi argomenti e gli stessi default di
 * `net.http_post` dopo il nome del job, quindi URL, corpo, header e timeout restano quelli di oggi.
 *
 * La fonte è la PRODUZIONE (`pg_get_functiondef`, misura 0.6 del piano), mai il repo: il rischio
 * della sessione è proprio un corpo copiato dal repo che in produzione era diverso.
 *
 * Uso (dalla radice del repo):
 *   node scripts/cron-esiti/involucro.mjs confronta /tmp/kidville-s06-definizioni-*.json
 *   node scripts/cron-esiti/involucro.mjs genera    /tmp/kidville-s06-definizioni-*.json > blocco.sql
 *   node scripts/cron-esiti/involucro.mjs inversa   supabase/migrations/<version>_cron_esiti_osservati.sql
 *   node scripts/cron-esiti/involucro.mjs impronte
 * Ogni caso che non sa trattare lo FERMA con un messaggio (uscita 1): non indovina mai.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const INVOLUCRO = 'cron_http_post'
export const LETTORE = 'cron_esiti'

/** Funzioni del repo che chiamano `net.http_post` nella loro ultima definizione, contate il 2026-10-20. */
export const FUNZIONI_HTTP_AL_20_10 = 20

/** Funzioni che chiamano il server e che di proposito NON si avvolgono, con la ragione. */
export const NON_SI_AVVOLGONO = Object.freeze({
  genera_solleciti:
    'DEPRECATA dal 2026-07-10 (20260710140000_contabilita_solleciti.sql), nessun job la chiama e nessun codice la usa; ' +
    "è SECURITY INVOKER, quindi avvolgerla chiederebbe di dare a service_role l'esecuzione dell'involucro: " +
    'una porta in più verso pg_net per una funzione che non gira mai.',
})

/** Funzioni che nel repo chiamano il server e in produzione no (Compito 3): non si ridefiniscono. */
export const ASSENTI_IN_PRODUZIONE = Object.freeze({})

/** Quante funzioni la migrazione deve ridefinire almeno. */
export function minimoAvvolte() {
  return FUNZIONI_HTTP_AL_20_10 - Object.keys(NON_SI_AVVOLGONO).length - Object.keys(ASSENTI_IN_PRODUZIONE).length
}

const DIRETTA = 'net.http_post('
const AVVOLTA = 'public.cron_http_post('
const ETICHETTA = /^[a-z0-9][a-z0-9-]*$/
const QUALSIASI_DIRETTA = /\bnet\s*\.\s*http_post\s*\(/gi
const QUALSIASI_AVVOLTA = /\bpublic\s*\.\s*cron_http_post\s*\(/gi
const PRIMA_DIRETTA = /\bnet\s*\.\s*http_post\s*\(/i
const PRIMA_AVVOLTA = /\bpublic\s*\.\s*cron_http_post\s*\(/i
const APRE_CORPO = /\bAS\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i
const TAG_DOLLARO = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y
const CREA = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi
const TOGLIE = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\(|;|,)/gi
const CREA_IN_TESTA = /\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi
const PERMESSI_DOPO = /^\s*((?:(?:REVOKE|GRANT)\b[^;]*;\s*)*)/i

export const md5 = (testo) => createHash('md5').update(testo, 'utf8').digest('hex')

const ordina = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Lo stesso testo con commenti (`--`, `/* *\/` anche annidati) e — se `stringhe` — stringhe fra
 * apici e corpi `$tag$…$tag$` sostituiti da spazi. Lunghezza e a capo restano: un indice nel testo
 * mascherato vale anche nell'originale.
 */
export function mascheraSql(sql, { stringhe = true } = {}) {
  const out = sql.split('')
  const spegni = (da, a) => {
    for (let k = da; k < a; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      const fine = sql.indexOf('\n', i)
      const a = fine === -1 ? sql.length : fine
      spegni(i, a)
      i = a
      continue
    }
    if (c === '/' && d === '*') {
      let profondita = 1
      let k = i + 2
      while (k < sql.length && profondita > 0) {
        if (sql[k] === '/' && sql[k + 1] === '*') { profondita++; k += 2 }
        else if (sql[k] === '*' && sql[k + 1] === '/') { profondita--; k += 2 }
        else k++
      }
      spegni(i, k)
      i = k
      continue
    }
    if (c === "'") {
      const conBarra = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]))
      let k = i + 1
      while (k < sql.length) {
        if (conBarra && sql[k] === '\\') { k += 2; continue }
        if (sql[k] === "'") {
          if (sql[k + 1] === "'") { k += 2; continue }
          break
        }
        k++
      }
      const a = Math.min(k + 1, sql.length)
      if (stringhe) spegni(i, a)
      i = a
      continue
    }
    if (c === '$' && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))) {
      TAG_DOLLARO.lastIndex = i
      const m = TAG_DOLLARO.exec(sql)
      if (m) {
        const fine = sql.indexOf(m[0], i + m[0].length)
        const a = fine === -1 ? sql.length : fine + m[0].length
        if (stringhe) spegni(i, a)
        i = a
        continue
      }
    }
    i++
  }
  return out.join('')
}

/** Commenti e spazi non contano, le stringhe sì. */
export const normalizza = (corpo) => mascheraSql(corpo, { stringhe: false }).replace(/\s+/g, ' ').trim()

/** Testata fino a `AS $tag$` compreso, corpo, tag di chiusura, coda. */
export function corpoDi(def) {
  const m = APRE_CORPO.exec(mascheraSql(def, { stringhe: false }))
  if (!m) throw new Error('definizione senza corpo «AS $tag$»')
  const tag = m[1]
  const inizio = m.index + m[0].length
  const fine = def.indexOf(tag, inizio)
  if (fine === -1) throw new Error(`corpo aperto da ${tag} e mai chiuso`)
  return { testata: def.slice(0, inizio), tag, corpo: def.slice(inizio, fine), coda: def.slice(fine + tag.length) }
}

/** Il corpo, o '' per una funzione scritta fra apici (non chiama il server: non c'è niente da cercare). */
export function corpoOVuoto(def) {
  return APRE_CORPO.test(mascheraSql(def, { stringhe: false })) ? corpoDi(def).corpo : ''
}

/** Chiamate dirette e avvolte nel CODICE del corpo: commenti e stringhe non contano. */
export function contaChiamate(corpo) {
  const codice = mascheraSql(corpo)
  return {
    dirette: (codice.match(QUALSIASI_DIRETTA) ?? []).length,
    avvolte: (codice.match(QUALSIASI_AVVOLTA) ?? []).length,
  }
}

export function avvolgi(def, job) {
  if (!ETICHETTA.test(job)) throw new Error(`etichetta non valida «${job}»`)
  const { testata, tag, corpo, coda } = corpoDi(def)
  const { dirette, avvolte } = contaChiamate(corpo)
  if (avvolte > 0) throw new Error("il corpo passa già dall'involucro")
  if (dirette !== 1) throw new Error(`attesa UNA chiamata a net.http_post nel codice, trovate ${dirette}`)
  const m = PRIMA_DIRETTA.exec(mascheraSql(corpo))
  const trovata = corpo.slice(m.index, m.index + m[0].length)
  if (trovata !== DIRETTA) throw new Error(`forma non canonica «${trovata}»: si avvolge solo «${DIRETTA}»`)
  return testata + corpo.slice(0, m.index) + `${AVVOLTA}'${job}', ` + corpo.slice(m.index + DIRETTA.length) + tag + coda
}

export function svolgi(def) {
  const { testata, tag, corpo, coda } = corpoDi(def)
  const { dirette, avvolte } = contaChiamate(corpo)
  if (avvolte !== 1 || dirette !== 0) {
    throw new Error(`attese UNA chiamata all'involucro e nessuna diretta, trovate ${avvolte} e ${dirette}`)
  }
  const m = PRIMA_AVVOLTA.exec(mascheraSql(corpo))
  const resto = corpo.slice(m.index)
  const e = /^public\.cron_http_post\('([a-z0-9][a-z0-9-]*)', /.exec(resto)
  if (!e) throw new Error("forma non canonica: si svolge solo «public.cron_http_post('<job>', »")
  return { definizione: testata + corpo.slice(0, m.index) + DIRETTA + resto.slice(e[0].length) + tag + coda, job: e[1] }
}

/** Il nome del job che chiama la funzione; senza job (trigger, route) il nome della funzione. */
export function etichetta({ proname, job }) {
  if (job.length === 1) return job[0]
  if (job.length === 0) return proname.replace(/_/g, '-')
  throw new Error(`${proname}: la chiamano ${job.length} job (${job.join(', ')}), l'etichetta non sarebbe univoca`)
}

const SOSPETTI = [
  ['un token dopo «Bearer»', /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['un JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['una chiave Supabase', /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/],
  ['una chiave di un fornitore', /\b(?:sk|rk|re)_(?:live_|test_)?[A-Za-z0-9]{16,}/],
  ['un indirizzo email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['un codice fiscale', /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/i],
]

/** Cosa, nel testo, non può finire in un repository pubblico. */
export const sospetti = (testo) => SOSPETTI.filter(([, re]) => re.test(testo)).map(([nome]) => nome)

const CAMPI_TESTO = ['proname', 'definizione', 'impronta', 'tipi', 'proprietario']
const CAMPI_SI_NO = ['security_definer', 'anon', 'authenticated', 'service_role']

/** Le righe della misura 0.6, da uno o più file JSON, controllate campo per campo. */
export function leggiRighe(testi) {
  const righe = []
  const visti = new Set()
  testi.forEach((testo, i) => {
    const dati = JSON.parse(testo)
    if (!Array.isArray(dati)) throw new Error(`il file ${i + 1} non contiene un array JSON (si salva il valore di «righe», misura 0.6)`)
    for (const r of dati) {
      const nome = typeof r?.proname === 'string' ? r.proname : '(senza nome)'
      for (const c of CAMPI_TESTO) if (typeof r[c] !== 'string') throw new Error(`${nome}: «${c}» deve essere un testo`)
      for (const c of CAMPI_SI_NO) if (typeof r[c] !== 'boolean') throw new Error(`${nome}: «${c}» deve essere vero o falso`)
      if (!Array.isArray(r.job) || r.job.some((j) => typeof j !== 'string')) throw new Error(`${nome}: «job» deve essere un array di testi`)
      if (visti.has(nome)) throw new Error(`${nome}: compare due volte (i file della misura 0.6 si sovrappongono?)`)
      if (md5(r.definizione) !== r.impronta) throw new Error(`${nome}: l'impronta non torna — definizione trascritta male, si risalva il JSON`)
      visti.add(nome)
      righe.push(r)
    }
  })
  return righe
}

/** Il blocco SQL che ridefinisce le funzioni, e l'elenco motivato di quelle saltate. */
export function genera(righe) {
  const blocchi = []
  const saltate = []
  for (const r of [...righe].sort((a, b) => ordina(a.proname, b.proname))) {
    const nome = r.proname
    if (nome === INVOLUCRO || nome === LETTORE) throw new Error(`${nome}: esiste già in produzione — STOP (misura 0.11)`)
    const { dirette, avvolte } = contaChiamate(corpoOVuoto(r.definizione))
    if (avvolte > 0) throw new Error(`${nome}: il corpo passa già dall'involucro — STOP`)
    if (dirette === 0) { saltate.push(`${nome}: cita net.http_post solo in commenti o stringhe`); continue }
    if (Object.hasOwn(NON_SI_AVVOLGONO, nome)) { saltate.push(`${nome}: ${NON_SI_AVVOLGONO[nome]}`); continue }
    if (r.proprietario !== 'postgres') throw new Error(`${nome}: proprietario «${r.proprietario}», atteso postgres — STOP`)
    if (!r.security_definer) throw new Error(`${nome}: è SECURITY INVOKER, e l'involucro non è eseguibile da chi la chiama — STOP`)
    if (r.anon || r.authenticated) throw new Error(`${nome}: in produzione è eseguibile da anon o authenticated — STOP`)
    const trovati = sospetti(r.definizione)
    if (trovati.length > 0) throw new Error(`${nome}: possibile ${trovati.join(', ')} nel corpo — il repository è pubblico: STOP`)
    const job = etichetta(r)
    const firma = `public.${nome}(${r.tipi})`
    blocchi.push(
      [
        `-- ${nome} · etichetta «${job}» · pg_get_functiondef, impronta ${r.impronta}`,
        avvolgi(r.definizione.trimEnd(), job) + ';',
        '',
        `REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC, anon, authenticated;`,
        ...(r.service_role ? [`GRANT EXECUTE ON FUNCTION ${firma} TO service_role;`] : []),
      ].join('\n'),
    )
  }
  return { sql: blocchi.join('\n\n') + (blocchi.length > 0 ? '\n' : ''), saltate }
}

/** Ultima definizione di ogni funzione di `public`, file per file e nell'ordine del file. */
export function ultimeDefinizioniDa(file) {
  const mappa = new Map()
  for (const { nome, sql } of file) {
    const codice = mascheraSql(sql)
    const eventi = [
      ...[...codice.matchAll(CREA)].map((m) => ({ crea: true, funzione: m[1].toLowerCase(), da: m.index })),
      ...[...codice.matchAll(TOGLIE)].map((m) => ({ crea: false, funzione: m[1].toLowerCase(), da: m.index })),
    ].sort((a, b) => a.da - b.da)
    for (const e of eventi) {
      if (!e.crea) { mappa.delete(e.funzione); continue }
      const fine = codice.indexOf(';', e.da)
      mappa.set(e.funzione, { file: nome, definizione: sql.slice(e.da, fine === -1 ? sql.length : fine).trim() })
    }
  }
  return mappa
}

export function ultimeDefinizioni(cartella) {
  const file = readdirSync(cartella)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((nome) => ({ nome, sql: readFileSync(join(cartella, nome), 'utf8') }))
  return ultimeDefinizioniDa(file)
}

/** Produzione contro repo, funzione per funzione. */
export function confronta(righe, repo) {
  const esiti = []
  const inProduzione = new Set()
  for (const r of righe) {
    inProduzione.add(r.proname)
    const nelRepo = repo.get(r.proname)
    if (!nelRepo) { esiti.push({ funzione: r.proname, esito: 'solo-in-produzione', file: '' }); continue }
    const a = corpoOVuoto(r.definizione)
    const b = corpoOVuoto(nelRepo.definizione)
    const esito = a === b ? 'identico' : normalizza(a) === normalizza(b) ? 'uguale-a-meno-di-commenti-e-spazi' : 'diverso'
    esiti.push({ funzione: r.proname, esito, file: nelRepo.file })
  }
  for (const [nome, { file, definizione }] of repo) {
    if (inProduzione.has(nome) || nome === INVOLUCRO || nome === LETTORE) continue
    const { dirette, avvolte } = contaChiamate(corpoOVuoto(definizione))
    if (dirette + avvolte > 0) esiti.push({ funzione: nome, esito: 'solo-nel-repo', file })
  }
  return esiti.sort((x, y) => ordina(x.funzione, y.funzione))
}

/** «nome<TAB>md5 del corpo» per le funzioni del repo che nominano il server: si confronta con md5(prosrc). */
export function impronteDelRepo(repo) {
  const righe = []
  for (const [nome, { definizione }] of repo) {
    const corpo = corpoOVuoto(definizione)
    if (/(net\s*\.\s*http_post|cron_http_post)/i.test(corpo)) righe.push(`${nome}\t${md5(corpo)}`)
  }
  return righe.sort(ordina)
}

/** La migrazione inversa: definizioni di prima coi loro permessi, poi job, funzioni e tabelle via. */
export function inversa(migrazione) {
  const codice = mascheraSql(migrazione)
  const pezzi = []
  for (const m of codice.matchAll(CREA_IN_TESTA)) {
    const nome = m[1].toLowerCase()
    if (nome === INVOLUCRO || nome === LETTORE) continue
    const fine = codice.indexOf(';', m.index)
    const permessi = PERMESSI_DOPO.exec(codice.slice(fine + 1))[0].length
    pezzi.push(
      `${svolgi(migrazione.slice(m.index, fine).trimEnd()).definizione};\n\n` +
        migrazione.slice(fine + 1, fine + 1 + permessi).trim(),
    )
  }
  if (pezzi.length === 0) throw new Error('nessuna funzione avvolta nel file: è la migrazione della sessione 6?')
  return [
    '-- Migrazione inversa della sessione 6 (seconda serie di robustezza), generata con',
    '-- `node scripts/cron-esiti/involucro.mjs inversa`: rimette le funzioni come erano in produzione',
    '-- prima del merge, coi loro permessi; poi spegne il lettore e toglie involucro e registri.',
    '',
    pezzi.join('\n\n'),
    '',
    'DO $$',
    'BEGIN',
    "  IF to_regnamespace('cron') IS NOT NULL THEN",
    "    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-esiti';",
    '  END IF;',
    'END',
    '$$;',
    '',
    'DROP FUNCTION IF EXISTS public.cron_esiti();',
    'DROP FUNCTION IF EXISTS public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer);',
    '',
    '-- distruttiva approvata: si tolgono i due registri degli esiti dei cron creati dalla sessione 6, su richiesta del titolare',
    'DROP TABLE IF EXISTS public.cron_ultimo_esito;',
    'DROP TABLE IF EXISTS public.cron_chiamate;',
    '',
    "NOTIFY pgrst, 'reload schema';",
    '',
  ].join('\n')
}

function principale(argomenti) {
  const [comando, ...resto] = argomenti
  const cartella = join(process.cwd(), 'supabase/migrations')
  if (comando === 'genera' || comando === 'confronta') {
    if (resto.length === 0) throw new Error(`uso: node scripts/cron-esiti/involucro.mjs ${comando} <definizioni-1.json> [altri file]`)
    const righe = leggiRighe(resto.map((f) => readFileSync(f, 'utf8')))
    if (comando === 'confronta') {
      for (const e of confronta(righe, ultimeDefinizioni(cartella))) process.stdout.write(`${e.funzione}\t${e.esito}\t${e.file}\n`)
      return
    }
    const { sql, saltate } = genera(righe)
    for (const s of saltate) process.stderr.write(`saltata — ${s}\n`)
    process.stderr.write(`ridefinite: ${righe.length - saltate.length}\n`)
    process.stdout.write(sql)
    return
  }
  if (comando === 'inversa' && resto.length === 1) {
    process.stdout.write(inversa(readFileSync(resto[0], 'utf8')))
    return
  }
  if (comando === 'impronte') {
    process.stdout.write(impronteDelRepo(ultimeDefinizioni(cartella)).join('\n') + '\n')
    return
  }
  throw new Error('uso: node scripts/cron-esiti/involucro.mjs confronta|genera <json…> · inversa <migrazione.sql> · impronte')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    principale(process.argv.slice(2))
  } catch (errore) {
    process.stderr.write(`involucro: ${errore instanceof Error ? errore.message : String(errore)}\n`)
    process.exitCode = 1
  }
}
```

- [ ] **Passo 4: lancia il test e guardalo passare**

```bash
npx vitest run __tests__/lib/cron-esiti-involucro.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 passed`, nessun `failed`. Se il caso «avvolgere e svolgere … carattere per carattere» fallisce su una funzione vera, il messaggio porta il nome: o la sua chiamata non è nella forma canonica, o ne ha due. **Non** si allarga il modulo per farla passare: si annota il nome in `/tmp/kidville-s06-misure.txt` e ci si ferma a chiedere al titolare, perché la stessa forma arriverà dalla produzione.

- [ ] **Passo 5: lint e tipi dei due file**

```bash
npx eslint scripts/cron-esiti/involucro.mjs __tests__/lib/cron-esiti-involucro.test.ts --max-warnings 0
npx tsc --noEmit
```

Atteso: nessuna uscita (il `tsconfig.json` ha `allowJs`, come per gli altri `scripts/*.mjs` importati dai test).

- [ ] **Passo 6: commit**

```bash
git add scripts/cron-esiti/involucro.mjs __tests__/lib/cron-esiti-involucro.test.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: involucro dei cron come trasformazione di testo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 3: produzione contro repo, funzione per funzione

La specifica dà il rischio della sessione: un corpo copiato dal repo invece che dalla produzione. Prima di generare qualunque cosa si guarda **dove** i due sono diversi, e si decide con una regola scritta, non caso per caso.

**File:**
- Modifica (solo se il passo 3 lo chiede): `scripts/cron-esiti/involucro.mjs` (costante `ASSENTI_IN_PRODUZIONE`)

- [ ] **Passo 1: il confronto**

```bash
node scripts/cron-esiti/involucro.mjs confronta /tmp/kidville-s06-definizioni-*.json | tee -a /tmp/kidville-s06-misure.txt
```

Atteso: una riga per funzione, `nome<TAB>esito<TAB>file`. Gli esiti possibili e cosa fanno:

| Esito | Cosa vuol dire | Cosa si fa |
|---|---|---|
| `identico` | stesso corpo, carattere per carattere | niente |
| `uguale-a-meno-di-commenti-e-spazi` | cambiano solo commenti o spazi | niente: la migrazione usa comunque il testo della produzione |
| `diverso` | il codice è diverso | passo 2 |
| `solo-in-produzione` | la funzione chiama il server ma nel repo non c'è (la specifica ne aspetta una) | niente: la genera il Compito 5, ed entra nel repo con la migrazione; il nome va nella voce del PRD |
| `solo-nel-repo` | nel repo chiama il server, in produzione no (o non esiste) | passo 3 |

- [ ] **Passo 2: per ogni `diverso`, la differenza e la regola**

Per ciascun nome (qui `FUNZIONE`), i due corpi in due file fuori dal repo, e la differenza:

```bash
FUNZIONE=nome_della_funzione
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { corpoOVuoto, leggiRighe, ultimeDefinizioni } from "./scripts/cron-esiti/involucro.mjs"
const [nome, ...file] = process.argv.slice(1)
const prod = leggiRighe(file.map((f) => readFileSync(f, "utf8"))).find((r) => r.proname === nome)
const repo = ultimeDefinizioni(join(process.cwd(), "supabase/migrations")).get(nome)
writeFileSync("/tmp/kidville-s06-prod.sql", corpoOVuoto(prod.definizione))
writeFileSync("/tmp/kidville-s06-repo.sql", corpoOVuoto(repo.definizione))
' "$FUNZIONE" /tmp/kidville-s06-definizioni-*.json
diff -u /tmp/kidville-s06-repo.sql /tmp/kidville-s06-prod.sql | head -80
```

Regola:
1. Si prende il numero di 14 cifre del file del repo (terza colonna del passo 1) e si chiede alla produzione se quella migrazione è stata applicata:

   ```sql
   SELECT count(*) AS applicata FROM supabase_migrations.schema_migrations WHERE version = '<14 cifre del file>';
   ```

2. `applicata` = 0 → **STOP**: nel repo c'è una migrazione mai applicata, e generare dalla produzione cancellerebbe quel cambiamento. Si chiede al titolare.
3. `applicata` = 1 → qualcuno ha cambiato la funzione in produzione dopo la migrazione. **Vince la produzione**: la migrazione la ridefinisce partendo dal corpo vero, e così il repo torna a dire il vero. Il nome entra in `@DIVERSE@` (si scrive nell'intestazione della migrazione e nella voce del PRD); la differenza si riassume in una riga nel file delle misure (quali righe, senza copiare segreti).

Se non ci sono `diverso`, `@DIVERSE@` vale `nessuna`.

- [ ] **Passo 3: solo se c'è un `solo-nel-repo` — la funzione si dichiara e non si tocca**

Ridefinirla dalla versione del repo cambierebbe il comportamento in produzione, che è esattamente ciò che la sessione non fa. In `scripts/cron-esiti/involucro.mjs` la costante diventa (una voce per funzione, coi valori veri al posto dei gettoni):

```js
export const ASSENTI_IN_PRODUZIONE = Object.freeze({
  '@FUNZIONE_ASSENTE@':
    'Nel repo chiama il server (ultima definizione in @FILE_ASSENTE@); in produzione, al @GIORNO@, non esiste o non lo chiama più ' +
    '(misura 0.6): ridefinirla cambierebbe il comportamento. Si allinea il repo con una sessione a parte, su decisione del titolare.',
})
```

```bash
npx vitest run __tests__/lib/cron-esiti-involucro.test.ts 2>&1 | tail -6
git add scripts/cron-esiti/involucro.mjs
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: funzioni del repo assenti in produzione dichiarate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: `Test Files  1 passed` (il caso «ogni esclusione è vera» controlla che la funzione dichiarata esista nel repo e chiami ancora il server direttamente); il `grep` senza righe.

- [ ] **Passo 4: annota il riepilogo**

Nel file delle misure: quante funzioni per esito, i nomi in `@DIVERSE@`, quelli `solo-in-produzione` e quelli dichiarati al passo 3.

---

### Compito 4: tabelle, involucro e lettore (la migrazione senza le funzioni generate)

**File:**
- Crea: `supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql`
- Crea: `__tests__/db/cron-esiti.test.ts`
- Modifica: `__tests__/architecture/soglia-fotografia.ts:251`

- [ ] **Passo 1: scrivi il test che fallisce**

Crea `__tests__/db/cron-esiti.test.ts`:

```ts
// @vitest-environment node
/**
 * La migrazione della sessione 6 (esiti dei cron), eseguita su PGlite dal FILE VERO della
 * cartella delle migrazioni, con `net` e `cron` finti che hanno le firme vere (misura 0.3).
 *
 * Cosa prova:
 *  · la migrazione gira anche dove pg_net e pg_cron non ci sono (il DB della CI);
 *  · l'involucro passa a pg_net gli stessi argomenti, ne conserva il numero, e se il registro non
 *    si scrive la richiesta parte lo stesso (la registrazione non può fermare un job);
 *  · il lettore classifica le risposte, scrive in app_log col nome del job, non conta due volte,
 *    non copia mai il corpo di una risposta, e se si guasta lascia una traccia;
 *  · `cron_ultimo_esito` ha una riga per job, HTTP o solo SQL, anche per quelli spenti.
 * Il Compito 5 aggiunge l'equivalenza prima/dopo di ogni funzione ridefinita.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_cron_esiti_osservati.sql'))
const MIGRAZIONE = FILE.length === 1 ? readFileSync(join(CARTELLA, FILE[0]), 'utf8') : ''
const URL_FINTO = 'https://kidville.invalid/api/finto'

const aperti: PGlite[] = []
afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close()
})

async function nuovoDatabase(opzioni: { net?: boolean; cron?: boolean } = {}): Promise<PGlite> {
  const { net = true, cron = false } = opzioni
  const db = new PGlite()
  aperti.push(db)
  await db.exec(`
    -- Le funzioni generate dalla produzione possono nominare tabelle che qui non esistono: come in
    -- produzione, il corpo si risolve quando la funzione gira, non quando nasce.
    SET check_function_bodies = off;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    -- app_log: le colonne che la migrazione scrive, più la chiave della deduplica.
    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creato_il timestamptz NOT NULL DEFAULT now(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      codice text,
      route text,
      stato_http int,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    -- Il Vault finto: le funzioni dei cron leggono URL e segreto da cron_config.
    CREATE TABLE public.vault_finto (nome text PRIMARY KEY, valore text);
    INSERT INTO public.vault_finto (nome, valore) VALUES
      ('app.cron_secret', 'segreto-di-prova'),
      ('app.push_dispatch_url', '${URL_FINTO}'),
      ('app.notifiche_promemoria_url', '${URL_FINTO}'),
      ('app.mensa_allergie_url', '${URL_FINTO}'),
      ('app.fattura_sync_url', '${URL_FINTO}'),
      ('app.retention_iscrizioni_url', '${URL_FINTO}');
    CREATE SCHEMA vault;
    CREATE VIEW vault.decrypted_secrets AS SELECT nome AS name, valore AS decrypted_secret FROM public.vault_finto;
    CREATE FUNCTION public.cron_config(p_nome text) RETURNS text
    LANGUAGE sql AS $$ SELECT valore FROM public.vault_finto WHERE nome = p_nome $$;
  `)
  if (net) {
    await db.exec(`
      CREATE SCHEMA net;
      CREATE TABLE net.chiamate (
        n bigserial PRIMARY KEY, url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int
      );
      CREATE FUNCTION net.http_post(
        url text,
        body jsonb DEFAULT '{}'::jsonb,
        params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint
      LANGUAGE sql AS $$
        INSERT INTO net.chiamate (url, body, params, headers, timeout_milliseconds)
        VALUES ($1, $2, $3, $4, $5) RETURNING n
      $$;
      CREATE TABLE net._http_response (
        id bigint, status_code integer, content_type text, headers jsonb, content text,
        timed_out boolean, error_msg text, created timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE net.http_request_queue (id bigint PRIMARY KEY);
    `)
  }
  if (cron) {
    await db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (
        jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE cron.job_run_details (
        runid bigserial PRIMARY KEY, jobid bigint, status text, return_message text,
        start_time timestamptz DEFAULT now(), end_time timestamptz
      );
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES ($1, $2, $3) RETURNING jobid $$;
      CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean
      LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid = $1 RETURNING true $$;
    `)
  }
  return db
}

async function righe<T = Record<string, unknown>>(db: PGlite, sql: string, parametri: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, parametri)).rows
}

/** L'errore che l'istruzione solleva, o null se passa. */
async function erroreDi(promessa: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await promessa
    return null
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { code: err.code, message: String(err.message ?? e) }
  }
}

type Risposta = { status_code?: number; timed_out?: boolean; error_msg?: string; content?: string }

/** Una chiamata passata dall'involucro e, se `risposta` non è null, la riga che pg_net scriverebbe. */
async function chiamata(db: PGlite, job: string, risposta: Risposta | null): Promise<number> {
  const [{ id }] = await righe<{ id: number }>(db, 'SELECT public.cron_http_post($1, $2) AS id', [job, `${URL_FINTO}/${job}`])
  if (risposta) {
    await db.query(
      'INSERT INTO net._http_response (id, status_code, timed_out, error_msg, content) VALUES ($1, $2, $3, $4, $5)',
      [id, risposta.status_code ?? null, risposta.timed_out ?? false, risposta.error_msg ?? null, risposta.content ?? null],
    )
  }
  return Number(id)
}

const esitoDelLettore = async (db: PGlite) =>
  (await righe<{ esito: Record<string, unknown> }>(db, 'SELECT public.cron_esiti() AS esito'))[0].esito

describe('la migrazione della sessione 6', () => {
  it('esiste, ed è una sola', () => {
    expect(FILE).toHaveLength(1)
  })

  it('gira senza pg_net e senza pg_cron (il DB della CI), e il lettore lascia comunque il battito', async () => {
    const db = await nuovoDatabase({ net: false, cron: false })
    await db.exec(MIGRAZIONE)
    expect(await esitoDelLettore(db)).toMatchObject({ operazione: 'cron-esiti', esito: 'ok', net: false, cron: false, chiuse: 0 })
    expect(await righe(db, "SELECT livello, evento, occorrenze FROM app_log WHERE fingerprint = 'cron:cron-esiti'"))
      .toEqual([{ livello: 'info', evento: 'cron', occorrenze: 1 }])
  })

  it('installa un solo job cron-esiti, 4 minuti dopo ogni decina, anche se rieseguita', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE)
    expect(await righe(db, "SELECT schedule, command FROM cron.job WHERE jobname = 'cron-esiti'"))
      .toEqual([{ schedule: '4,14,24,34,44,54 * * * *', command: 'SELECT public.cron_esiti();' }])
  })
})

describe('l’involucro cron_http_post', () => {
  it('ha gli argomenti di net.http_post dopo il nome del job (misura 0.3)', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    expect(await righe(db, "SELECT pg_get_function_arguments('public.cron_http_post'::regproc) AS a")).toEqual([{
      a: `job text, url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000`,
    }])
  })

  it('passa a pg_net gli stessi argomenti e conserva il numero della richiesta', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.query(`SELECT public.cron_http_post('news-tick',
      url := '${URL_FINTO}/news/cron?giro=1', headers := '{"x-cron-secret": "s"}'::jsonb,
      body := '{"a": 1}'::jsonb, timeout_milliseconds := 120000)`)
    expect(await righe(db, 'SELECT url, body, params, headers, timeout_milliseconds FROM net.chiamate')).toEqual([{
      url: `${URL_FINTO}/news/cron?giro=1`, body: { a: 1 }, params: {}, headers: { 'x-cron-secret': 's' }, timeout_milliseconds: 120000,
    }])
    expect(await righe(db, `SELECT job, percorso, timeout_ms, esito,
        richiesta_id = (SELECT max(n) FROM net.chiamate) AS stessa_richiesta FROM public.cron_chiamate`))
      .toEqual([{ job: 'news-tick', percorso: '/api/finto/news/cron', timeout_ms: 120000, esito: 'in-attesa', stessa_richiesta: true }])
    await db.query(`SELECT public.cron_http_post('x', '${URL_FINTO}/y')`)
    expect(await righe(db, 'SELECT body, params, headers, timeout_milliseconds FROM net.chiamate ORDER BY n DESC LIMIT 1'))
      .toEqual([{ body: {}, params: {}, headers: { 'Content-Type': 'application/json' }, timeout_milliseconds: 5000 }])
  })

  it('se il registro non si scrive la richiesta parte lo stesso, e resta un error in app_log', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.exec("ALTER TABLE public.cron_chiamate ADD CONSTRAINT guasto_di_prova CHECK (job <> 'rotto')")
    await db.query(`SELECT public.cron_http_post('rotto', '${URL_FINTO}/z')`)
    expect(await righe(db, 'SELECT count(*)::int AS n FROM net.chiamate')).toEqual([{ n: 1 }])
    expect(await righe(db, 'SELECT count(*)::int AS n FROM public.cron_chiamate')).toEqual([{ n: 0 }])
    expect(await righe(db, `SELECT livello, evento, codice, contesto->'campi'->>'job' AS job
        FROM app_log WHERE fingerprint = 'cron-http:registro-non-scritto'`))
      .toEqual([{ livello: 'error', evento: 'cron', codice: '23514', job: 'rotto' }])
  })

  it('un errore di pg_net arriva a chi chiama, come prima, e non lascia righe', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.exec(`CREATE OR REPLACE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'coda piena' USING ERRCODE = '53400'; END $$`)
    expect((await erroreDi(db.query(`SELECT public.cron_http_post('x', '${URL_FINTO}/y')`)))?.code).toBe('53400')
    expect(await righe(db, 'SELECT count(*)::int AS n FROM public.cron_chiamate')).toEqual([{ n: 0 }])
  })
})

describe('il lettore cron_esiti', () => {
  it('classifica ok, errore HTTP, timeout, rete; lascia aperte quelle in volo; non conta due volte', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'news-tick', { status_code: 200 })
    await chiamata(db, 'storici-stampe', { status_code: 500, content: '{"errore":"x","codice":"STORICI_GUASTO"}' })
    await chiamata(db, 'storici-stampe', { status_code: 401, content: 'Il nome di un bambino che non deve uscire' })
    await chiamata(db, 'fatture-coda-tick', { timed_out: true, error_msg: 'Timeout of 300000 ms reached' })
    await chiamata(db, 'mensa-check-allergie', { error_msg: "Couldn't resolve host name" })
    const inVolo = await chiamata(db, 'video-runner-tick', null)

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 5, ignote: 0 })
    expect(await righe(db, 'SELECT job, esito, codice_http, codice_errore FROM public.cron_chiamate ORDER BY id')).toEqual([
      { job: 'news-tick', esito: 'ok', codice_http: 200, codice_errore: null },
      { job: 'storici-stampe', esito: 'errore-http', codice_http: 500, codice_errore: 'STORICI_GUASTO' },
      { job: 'storici-stampe', esito: 'errore-http', codice_http: 401, codice_errore: null },
      { job: 'fatture-coda-tick', esito: 'timeout', codice_http: null, codice_errore: null },
      { job: 'mensa-check-allergie', esito: 'errore-rete', codice_http: null, codice_errore: null },
      { job: 'video-runner-tick', esito: 'in-attesa', codice_http: null, codice_errore: null },
    ])
    expect(await righe(db, `SELECT fingerprint, livello, evento, codice, route, stato_http, occorrenze
        FROM app_log WHERE fingerprint <> 'cron:cron-esiti' ORDER BY fingerprint COLLATE "C"`)).toEqual([
      { fingerprint: 'cron-http-timeout:fatture-coda-tick', livello: 'info', evento: 'cron', codice: 'TIMEOUT_PG_NET', route: '/api/finto/fatture-coda-tick', stato_http: null, occorrenze: 1 },
      { fingerprint: 'cron-http:mensa-check-allergie', livello: 'error', evento: 'cron', codice: 'ERRORE_RETE', route: '/api/finto/mensa-check-allergie', stato_http: null, occorrenze: 1 },
      { fingerprint: 'cron-http:storici-stampe', livello: 'error', evento: 'cron', codice: 'STORICI_GUASTO', route: '/api/finto/storici-stampe', stato_http: 500, occorrenze: 2 },
    ])
    const tutto = JSON.stringify([await righe(db, 'SELECT * FROM app_log'), await righe(db, 'SELECT * FROM public.cron_chiamate')])
    expect(tutto).not.toContain('bambino')

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 0 })
    expect(await righe(db, "SELECT occorrenze FROM app_log WHERE fingerprint = 'cron-http:storici-stampe'")).toEqual([{ occorrenze: 2 }])
    expect(await righe(db, "SELECT occorrenze FROM app_log WHERE fingerprint = 'cron:cron-esiti'")).toEqual([{ occorrenze: 2 }])

    await db.query('INSERT INTO net._http_response (id, status_code) VALUES ($1, 202)', [inVolo])
    expect(await esitoDelLettore(db)).toMatchObject({ chiuse: 1 })
    expect(await righe(db, "SELECT esito FROM public.cron_chiamate WHERE job = 'video-runner-tick'")).toEqual([{ esito: 'ok' }])
  })

  it('un 3xx non è un errore (la specifica: 4xx, 5xx, rete); un 400 sì', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'news-tick', { status_code: 302, content: '{"codice":"NON_DEVE_ESSERE_LETTO"}' })
    await chiamata(db, 'news-digest', { status_code: 400, content: '{"codice":"RICHIESTA_NON_VALIDA"}' })

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 2 })
    expect(await righe(db, 'SELECT job, esito, codice_http, codice_errore FROM public.cron_chiamate ORDER BY id')).toEqual([
      { job: 'news-tick', esito: 'ok', codice_http: 302, codice_errore: null },
      { job: 'news-digest', esito: 'errore-http', codice_http: 400, codice_errore: 'RICHIESTA_NON_VALIDA' },
    ])
    expect(await righe(db, `SELECT fingerprint, livello, codice, stato_http FROM app_log
        WHERE fingerprint LIKE 'cron-http%' ORDER BY fingerprint COLLATE "C"`)).toEqual([
      { fingerprint: 'cron-http:news-digest', livello: 'error', codice: 'RICHIESTA_NON_VALIDA', stato_http: 400 },
    ])
  })

  it('dopo la vita delle risposte e senza risposta: esito-ignoto, salvo se è ancora in coda', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'news-tick', null)
    const inCoda = await chiamata(db, 'news-digest', null)
    await db.query('INSERT INTO net.http_request_queue (id) VALUES ($1)', [inCoda])
    await db.exec("UPDATE public.cron_chiamate SET inviata_il = now() - interval '7 hours'")
    expect(await esitoDelLettore(db)).toMatchObject({ ignote: 1 })
    expect(await righe(db, 'SELECT job, esito FROM public.cron_chiamate ORDER BY id'))
      .toEqual([{ job: 'news-tick', esito: 'esito-ignoto' }, { job: 'news-digest', esito: 'in-attesa' }])
    expect(await righe(db, "SELECT livello, codice, occorrenze FROM app_log WHERE fingerprint = 'cron-esiti:esiti-persi'"))
      .toEqual([{ livello: 'warn', codice: 'ESITO_IGNOTO', occorrenze: 1 }])
  })

  it('cron_ultimo_esito: una riga per job, SQL e HTTP, attivi e spenti; un fallimento SQL nuovo diventa un error', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(`INSERT INTO cron.job (jobname, schedule, command, active) VALUES
      ('app-log-purge', '17 3 * * *', 'SELECT 1', true),
      ('news-tick', '*/10 * * * *', 'SELECT public.news_tick()', true),
      ('news-digest', '0 7 * * *', 'SELECT public.news_digest_tick()', false)`)
    await db.exec(MIGRAZIONE)
    await db.exec(`
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT jobid, 'failed', now() - interval '2 minutes', now() - interval '119 seconds' FROM cron.job WHERE jobname = 'app-log-purge';
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT jobid, 'succeeded', now() - interval '1 minute', now() - interval '59 seconds'
        FROM cron.job WHERE jobname IN ('app-log-purge', 'news-tick');
    `)
    await chiamata(db, 'news-tick', { status_code: 200 })
    await esitoDelLettore(db)
    expect(await righe(db, `SELECT job, attivo, http, ultima_esecuzione_stato,
        ultimo_ok_il IS NOT NULL AS ok, ultimo_errore_il IS NOT NULL AS errore, ultima_chiamata_esito
        FROM public.cron_ultimo_esito ORDER BY job COLLATE "C"`)).toEqual([
      { job: 'app-log-purge', attivo: true, http: false, ultima_esecuzione_stato: 'succeeded', ok: true, errore: true, ultima_chiamata_esito: null },
      { job: 'cron-esiti', attivo: true, http: false, ultima_esecuzione_stato: null, ok: false, errore: false, ultima_chiamata_esito: null },
      { job: 'news-digest', attivo: false, http: false, ultima_esecuzione_stato: null, ok: false, errore: false, ultima_chiamata_esito: null },
      { job: 'news-tick', attivo: true, http: true, ultima_esecuzione_stato: 'succeeded', ok: true, errore: false, ultima_chiamata_esito: 'ok' },
    ])
    // Il fallimento visto al primo giro IN ASSOLUTO (cron_ultimo_esito ancora vuota) è storia di
    // prima dell'installazione: non diventa un error.
    expect(await righe(db, "SELECT count(*)::int AS n FROM app_log WHERE fingerprint LIKE 'cron-sql:%'")).toEqual([{ n: 0 }])

    await db.exec(`INSERT INTO cron.job_run_details (jobid, status, return_message, start_time, end_time)
      SELECT jobid, 'failed', 'ERROR: testo che non deve uscire', now(), now() FROM cron.job WHERE jobname = 'app-log-purge'`)
    await esitoDelLettore(db)
    expect(await righe(db, "SELECT livello, evento, codice, occorrenze FROM app_log WHERE fingerprint = 'cron-sql:app-log-purge'"))
      .toEqual([{ livello: 'error', evento: 'cron', codice: 'CRON_ESECUZIONE_FALLITA', occorrenze: 1 }])
    expect(await righe(db, "SELECT ultima_esecuzione_stato FROM public.cron_ultimo_esito WHERE job = 'app-log-purge'"))
      .toEqual([{ ultima_esecuzione_stato: 'failed' }])
    expect(JSON.stringify(await righe(db, 'SELECT * FROM app_log'))).not.toContain('non deve uscire')

    await db.exec("DELETE FROM cron.job WHERE jobname = 'news-tick'")
    await esitoDelLettore(db)
    expect(await righe(db, "SELECT attivo FROM public.cron_ultimo_esito WHERE job = 'news-tick'")).toEqual([{ attivo: false }])
  })

  it('un mensile mai visto dal lettore: la sua prima corsa fallita dopo l’installazione è un error; il primo giro in assoluto non scrive', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(`INSERT INTO cron.job (jobname, schedule, command) VALUES
      ('news-tick', '*/10 * * * *', 'SELECT public.news_tick()'),
      ('notifiche-retention', '35 4 1 * *', 'SELECT public.notifiche_retention_tick()')`)
    // Storia di prima dell'installazione: il mensile è fallito un mese fa, e dopo sono passate più
    // esecuzioni di quante il lettore ne scorra (v_finestra_run = 5000): quel giro non si vede, e il
    // suo ultimo_runid resta nullo anche dopo il primo giro.
    await db.exec(`
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT jobid, 'failed', now() - interval '30 days', now() - interval '30 days'
        FROM cron.job WHERE jobname = 'notifiche-retention';
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT j.jobid, 'succeeded', now() - interval '1 minute', now() - interval '1 minute'
        FROM cron.job AS j CROSS JOIN generate_series(1, 5001) WHERE j.jobname = 'news-tick';
    `)
    await db.exec(MIGRAZIONE)

    // Il primo giro in assoluto: cron_ultimo_esito era vuota. Si popola, e niente diventa un error.
    expect(await righe(db, 'SELECT count(*)::int AS n FROM public.cron_ultimo_esito')).toEqual([{ n: 0 }])
    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', primo_giro: true, fallite: 0 })
    expect(await righe(db, `SELECT job, ultimo_runid IS NULL AS mai_visto
        FROM public.cron_ultimo_esito ORDER BY job COLLATE "C"`)).toEqual([
      { job: 'cron-esiti', mai_visto: true },
      { job: 'news-tick', mai_visto: false },
      { job: 'notifiche-retention', mai_visto: true },
    ])
    expect(await righe(db, "SELECT count(*)::int AS n FROM app_log WHERE fingerprint LIKE 'cron-sql:%'")).toEqual([{ n: 0 }])

    // La prima corsa del mensile dopo l'installazione fallisce. Il suo ultimo_runid era nullo, ma la
    // tabella era già popolata: è un error, e conta una volta sola (il fallimento di un mese fa no).
    await db.exec(`INSERT INTO cron.job_run_details (jobid, status, return_message, start_time, end_time)
      SELECT jobid, 'failed', 'ERROR: testo che non deve uscire', now(), now()
        FROM cron.job WHERE jobname = 'notifiche-retention'`)
    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', primo_giro: false, fallite: 1 })
    expect(await righe(db, `SELECT livello, evento, codice, occorrenze, contesto->'campi'->>'job' AS job
        FROM app_log WHERE fingerprint = 'cron-sql:notifiche-retention'`))
      .toEqual([{ livello: 'error', evento: 'cron', codice: 'CRON_ESECUZIONE_FALLITA', occorrenze: 1, job: 'notifiche-retention' }])
    expect(await righe(db, `SELECT ultima_esecuzione_stato, ultimo_runid IS NULL AS mai_visto
        FROM public.cron_ultimo_esito WHERE job = 'notifiche-retention'`))
      .toEqual([{ ultima_esecuzione_stato: 'failed', mai_visto: false }])
    expect(JSON.stringify(await righe(db, 'SELECT * FROM app_log'))).not.toContain('non deve uscire')
  })

  it('se si guasta lascia cron-esiti:fallito; se non può scrivere neanche quello, l’errore esce', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.exec('ALTER TABLE public.cron_chiamate RENAME TO cron_chiamate_altrove')
    expect(await esitoDelLettore(db)).toEqual({ operazione: 'cron-esiti', esito: 'fallito', sqlstate: '42P01' })
    expect(await righe(db, "SELECT livello, codice FROM app_log WHERE fingerprint = 'cron-esiti:fallito'"))
      .toEqual([{ livello: 'error', codice: '42P01' }])
    expect(await righe(db, "SELECT count(*)::int AS n FROM app_log WHERE fingerprint = 'cron:cron-esiti'")).toEqual([{ n: 0 }])
    await db.exec('ALTER TABLE public.app_log RENAME TO app_log_altrove')
    expect((await erroreDi(db.query('SELECT public.cron_esiti()')))?.code).toBe('42P01')
  })

  it('involucro e lettore: SECURITY DEFINER, search_path fisso, nessun ruolo client; tabelle chiuse', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    expect(await righe(db, `SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS config,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
        FROM pg_proc p WHERE p.proname IN ('cron_http_post', 'cron_esiti') ORDER BY 1`)).toEqual([
      { proname: 'cron_esiti', prosecdef: true, config: 'search_path=public, pg_temp', anon: false, authenticated: false, service_role: false },
      { proname: 'cron_http_post', prosecdef: true, config: 'search_path=public, pg_temp', anon: false, authenticated: false, service_role: false },
    ])
    expect(await righe(db, `SELECT c.relname, c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'SELECT') AS anon,
        has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated,
        has_table_privilege('service_role', c.oid, 'SELECT') AS service_select,
        has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert
        FROM pg_class c WHERE c.relname IN ('cron_chiamate', 'cron_ultimo_esito') ORDER BY 1`)).toEqual([
      { relname: 'cron_chiamate', relrowsecurity: true, anon: false, authenticated: false, service_select: true, service_insert: false },
      { relname: 'cron_ultimo_esito', relrowsecurity: true, anon: false, authenticated: false, service_select: true, service_insert: false },
    ])
  })
})
```

- [ ] **Passo 2: lancialo e guardalo fallire**

```bash
npx vitest run __tests__/db/cron-esiti.test.ts 2>&1 | tail -10
```

Atteso: FAIL. `esiste, ed è una sola` rosso con `expected [] to have a length of 1`; gli altri rossi perché `MIGRAZIONE` è vuota (`function public.cron_esiti() does not exist`, codice `42883`).

- [ ] **Passo 3: scrivi la migrazione (senza le funzioni generate)**

```bash
V=$(date -u +%Y%m%d%H%M%S); echo "$V"
jq -r '.migrazioni | map(.version) | max' __tests__/fixtures/migrazioni-applicate-snapshot.json
```

`V` è `@VERSIONE@`: deve essere **più grande** del secondo numero (il lock `migrazioni-complete` rifiuta una version più vecchia dell'ultima applicata). Crea `supabase/migrations/${V}_cron_esiti_osservati.sql` con questo contenuto, sostituendo i gettoni dell'intestazione (`@DIVERSE@` col valore del Compito 3; `@N_ISCRIZIONI@` e `@ORA_CONTEGGIO@` con la misura 0.1; `@VERSIONE@` con `V`). Se la misura 0.2 ha trovato un `ttl` diverso da `6 hours`, `v_vita_risposte` prende quel valore; se la 0.8 ha chiesto una finestra più larga, `v_finestra_run` pure.

```sql
-- =============================================================================
-- Sessione 6 della seconda serie di robustezza — esiti dei cron: si osserva, non si cambia
-- Specifica: docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md, §7, Sessione 6.
--
-- PERCHÉ
-- Le funzioni dei job di pg_cron chiamano il server con net.http_post e buttano via il numero
-- della richiesta. La risposta arriva dopo in net._http_response, che la tiene circa 6 ore, e
-- nessuno sa più di quale job fosse: il 20/10 c'erano 27 chiamate senza risposta e nessun nome.
--
-- COSA FA
--  · cron_chiamate: una riga per chiamata — job, numero della richiesta, esito, codice HTTP.
--  · cron_ultimo_esito: una riga per job di cron.job, HTTP o solo SQL; non scade, quindi copre
--    anche i mensili.
--  · cron_http_post(job, url, body, params, headers, timeout_milliseconds): manda la richiesta
--    con net.http_post e gli stessi argomenti, POI ne registra il numero. Se la registrazione
--    fallisce la richiesta è già partita: lo dice app_log, e il job va avanti come prima.
--  · Le funzioni che chiamano il server, ridefinite dai corpi della PRODUZIONE
--    (pg_get_functiondef, misura 0.6 del piano) con una sola differenza: net.http_post( diventa
--    public.cron_http_post('<job>', . URL, header, corpi e timeout restano quelli di ciascuna.
--    Corpi trovati diversi dal repo, e qui riallineati alla produzione: @DIVERSE@.
--  · cron_esiti(), job cron-esiti ai minuti 4, 14, … 54: chiude le chiamate leggendo
--    net._http_response, aggiorna cron_ultimo_esito da cron.job e cron.job_run_details, e scrive
--    in app_log: error cron-http:<job> (4xx, 5xx, rete; un 3xx è ok), info cron-http-timeout:<job>
--    (timeout del client pg_net, che non ferma la route), error cron-sql:<job> (esecuzione
--    fallita, a partire dal secondo giro del lettore: al primo giro in assoluto, con
--    cron_ultimo_esito ancora vuota, i fallimenti sono storia di prima dell'installazione; dal
--    secondo vale anche per un job mai visto, come un mensile fuori dalle ultime 5000 esecuzioni),
--    warn cron-esiti:esiti-persi, error cron-esiti:fallito e il battito info cron:cron-esiti.
--    Mai il corpo di una risposta: solo il suo codice in maiuscolo.
--
-- Domande d'iscrizione contate prima della migrazione: @N_ISCRIZIONI@ alle @ORA_CONTEGGIO@ UTC.
--
-- ─── DB DELLA CI E PGLITE ───
-- pg_net e pg_cron possono mancare: il lettore li cerca con to_regclass e salta ciò che non c'è;
-- il job si installa solo se lo schema cron esiste. Nessuna riga di dati esistente viene toccata.
--
-- ─── IDEMPOTENTE ───
-- CREATE … IF NOT EXISTS, CREATE OR REPLACE; il job si toglie prima di rimetterlo.
--
-- ─── COME SI VERIFICA ───
--   SELECT count(*) FROM public.cron_ultimo_esito;                 -- una riga per job di cron.job
--   SELECT job, esito, count(*) FROM public.cron_chiamate GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT fingerprint, livello, occorrenze FROM public.app_log
--    WHERE fingerprint LIKE 'cron-http%' OR fingerprint LIKE 'cron-sql:%'
--       OR fingerprint LIKE 'cron-esiti:%' OR fingerprint = 'cron:cron-esiti'
--    ORDER BY visto_l_ultima DESC LIMIT 20;
--
-- ─── ROLLBACK ───
-- Fermata subito (la esegue il titolare dall'editor SQL):  SELECT cron.unschedule('cron-esiti');
-- Completo: una migrazione NUOVA, dentro una PR di revert, generata da
--   node scripts/cron-esiti/involucro.mjs inversa supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql
-- che rimette le definizioni di prima coi loro permessi e toglie job, funzioni e tabelle.
-- =============================================================================

-- == I DUE REGISTRI ==

CREATE TABLE IF NOT EXISTS public.cron_chiamate (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job           text NOT NULL,
  richiesta_id  bigint NOT NULL,
  percorso      text,
  timeout_ms    integer,
  inviata_il    timestamptz NOT NULL DEFAULT now(),
  esito         text NOT NULL DEFAULT 'in-attesa'
                CHECK (esito IN ('in-attesa', 'ok', 'errore-http', 'errore-rete', 'timeout', 'esito-ignoto')),
  codice_http   integer,
  codice_errore text,
  errore        text,
  verificata_il timestamptz
);

CREATE INDEX IF NOT EXISTS cron_chiamate_aperte_idx ON public.cron_chiamate (richiesta_id) WHERE verificata_il IS NULL;
CREATE INDEX IF NOT EXISTS cron_chiamate_job_idx ON public.cron_chiamate (job, inviata_il DESC);
CREATE INDEX IF NOT EXISTS cron_chiamate_verificata_idx ON public.cron_chiamate (verificata_il);

ALTER TABLE public.cron_chiamate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_chiamate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cron_chiamate TO service_role;

COMMENT ON TABLE public.cron_chiamate IS
  'Una riga per ogni chiamata al server fatta da una funzione dei cron attraverso cron_http_post: job, numero della richiesta di pg_net, percorso (mai la query string), timeout, e l''esito che cron_esiti() legge da net._http_response. Si scrive solo da cron_http_post e cron_esiti (SECURITY DEFINER); service_role legge. Le righe verificate si tengono 14 giorni. Sessione 6 della seconda serie di robustezza.';

CREATE TABLE IF NOT EXISTS public.cron_ultimo_esito (
  job                     text PRIMARY KEY,
  attivo                  boolean NOT NULL DEFAULT true,
  pianificazione          text,
  http                    boolean NOT NULL DEFAULT false,
  ultimo_runid            bigint,
  ultima_esecuzione_il    timestamptz,
  ultima_esecuzione_stato text,
  ultima_chiamata_il      timestamptz,
  ultima_chiamata_esito   text,
  ultimo_codice_http      integer,
  ultimo_ok_il            timestamptz,
  ultimo_errore_il        timestamptz,
  aggiornato_il           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_ultimo_esito ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cron_ultimo_esito FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cron_ultimo_esito TO service_role;

COMMENT ON TABLE public.cron_ultimo_esito IS
  'Una riga per job di cron.job (anche spento: attivo=false), aggiornata da cron_esiti() ogni 10 minuti: ultima esecuzione da cron.job_run_details, ultima chiamata al server da cron_chiamate, ultimo successo e ultimo errore. Non scade: copre anche i job mensili. Per un job HTTP il successo è la risposta del server, non l''esecuzione del job (che dice solo «richiesta accodata»).';

-- == L'INVOLUCRO ==

CREATE OR REPLACE FUNCTION public.cron_http_post(
  job text,
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_richiesta bigint;
  v_stato     text;
BEGIN
  -- La richiesta parte PRIMA e FUORI da ogni blocco d'eccezione: un errore di pg_net arriva a chi
  -- chiama esattamente come arrivava prima dell'involucro.
  v_richiesta := net.http_post(
    url                  => cron_http_post.url,
    body                 => cron_http_post.body,
    params               => cron_http_post.params,
    headers              => cron_http_post.headers,
    timeout_milliseconds => cron_http_post.timeout_milliseconds
  );

  -- La registrazione non può fermare il job: se fallisce, lo dice app_log.
  BEGIN
    INSERT INTO public.cron_chiamate (job, richiesta_id, percorso, timeout_ms)
    VALUES (cron_http_post.job, v_richiesta,
            substring(cron_http_post.url FROM '^https?://[^/]+(/[^?#]*)'),
            cron_http_post.timeout_milliseconds);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_stato = RETURNED_SQLSTATE;
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, contesto)
      VALUES ('error', 'cron', 'server',
              'chiamata di un cron partita ma non registrata in cron_chiamate: il suo esito non si saprà',
              v_stato, 'cron-http:registro-non-scritto',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'cron-http-post', 'job', cron_http_post.job,
                'esito', 'registro-non-scritto', 'richiesta_id', v_richiesta)))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(),
            contesto = excluded.contesto, codice = excluded.codice;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'cron_http_post: né cron_chiamate né app_log scritti (job %, sqlstate %)', cron_http_post.job, v_stato;
    END;
  END;

  RETURN v_richiesta;
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer) IS
  'net.http_post con il nome del job davanti: manda la stessa richiesta con gli stessi argomenti e default, poi registra il numero in cron_chiamate. La chiamano solo le funzioni dei cron (SECURITY DEFINER, proprietario postgres); nessun ruolo client la esegue. Sessione 6 della seconda serie di robustezza.';

-- == LE FUNZIONI CHE CHIAMANO IL SERVER (generate, Passo 0.6) ==

-- == IL LETTORE ==

CREATE OR REPLACE FUNCTION public.cron_esiti()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vita_risposte constant interval := interval '6 hours';   -- pg_net.ttl, misura 0.2
  v_tieni         constant interval := interval '14 days';   -- righe verificate di cron_chiamate
  v_finestra_run  constant bigint   := 5000;                 -- esecuzioni lette al massimo, misura 0.8
  v_adesso     timestamptz := now();
  v_ha_net     boolean := to_regclass('net._http_response') IS NOT NULL;
  v_ha_coda    boolean := to_regclass('net.http_request_queue') IS NOT NULL;
  v_ha_cron    boolean := to_regclass('cron.job') IS NOT NULL AND to_regclass('cron.job_run_details') IS NOT NULL;
  v_chiuse     integer := 0;
  v_ignote     integer := 0;
  v_esecuzioni integer := 0;
  v_fallite    integer := 0;
  v_cancellate integer := 0;
  v_primo_giro boolean;
  v_da         bigint;
  v_stato      text;
  v_esito      jsonb;
BEGIN
  -- 0. Il primo giro IN ASSOLUTO: cron_ultimo_esito è ancora vuota. Si guarda qui, prima del passo 4
  --    che la riempie, e non job per job: un job mensile o settimanale che non ha girato nelle
  --    ultime v_finestra_run esecuzioni resta con ultimo_runid nullo anche dopo il primo giro, e la
  --    sua prima corsa fallita dopo l'installazione deve diventare un error (passo 6).
  v_primo_giro := NOT EXISTS (SELECT 1 FROM public.cron_ultimo_esito);

  -- 1. Chiude le chiamate che hanno una risposta. Il corpo non si copia: solo un codice in maiuscolo.
  --    Errore HTTP = 4xx o 5xx (la specifica: «4xx/5xx/rete»); un 3xx si chiude come ok.
  IF v_ha_net THEN
    UPDATE public.cron_chiamate AS c
       SET esito = CASE
                     WHEN coalesce(r.timed_out, false) OR coalesce(r.error_msg, '') ILIKE 'Timeout of %' THEN 'timeout'
                     WHEN r.status_code IS NULL THEN 'errore-rete'
                     WHEN r.status_code >= 400 THEN 'errore-http'
                     ELSE 'ok'
                   END,
           codice_http   = r.status_code,
           codice_errore = CASE WHEN r.status_code >= 400
                                THEN substring(left(r.content, 2000) FROM '[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}') END,
           errore        = left(r.error_msg, 200),
           verificata_il = v_adesso
      FROM net._http_response AS r
     WHERE c.verificata_il IS NULL
       AND r.id = c.richiesta_id
       AND r.created >= c.inviata_il - interval '1 minute';
    GET DIAGNOSTICS v_chiuse = ROW_COUNT;
  END IF;

  -- 2. Senza risposta oltre la vita delle risposte (e non più in coda): l'esito non si saprà più.
  IF v_ha_coda THEN
    UPDATE public.cron_chiamate AS c
       SET esito = 'esito-ignoto', verificata_il = v_adesso
     WHERE c.verificata_il IS NULL
       AND c.inviata_il < v_adesso - v_vita_risposte
       AND NOT EXISTS (SELECT 1 FROM net.http_request_queue AS q WHERE q.id = c.richiesta_id);
  ELSE
    UPDATE public.cron_chiamate AS c
       SET esito = 'esito-ignoto', verificata_il = v_adesso
     WHERE c.verificata_il IS NULL
       AND c.inviata_il < v_adesso - v_vita_risposte;
  END IF;
  GET DIAGNOSTICS v_ignote = ROW_COUNT;

  IF v_ignote > 0 THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, occorrenze, contesto)
    VALUES ('warn', 'cron', 'server',
            format('%s chiamate dei cron senza risposta dopo %s: pg_net le ha già dimenticate', v_ignote, v_vita_risposte),
            'ESITO_IGNOTO', 'cron-esiti:esiti-persi', v_ignote,
            jsonb_build_object('campi', jsonb_build_object('operazione', 'cron-esiti', 'esito', 'esiti-persi', 'n', v_ignote)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(), contesto = excluded.contesto;
  END IF;

  -- 3. In app_log, una riga per job: gli errori (HTTP e rete) e, a parte, i timeout del client.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, route, stato_http, fingerprint, occorrenze, contesto)
  SELECT 'error', 'cron', 'server',
         format('il server non ha risposto bene a %s chiamate del job %s', count(*), c.job),
         coalesce(min(c.codice_errore),
                  CASE WHEN max(c.codice_http) IS NULL THEN 'ERRORE_RETE' ELSE 'HTTP_' || max(c.codice_http) END),
         min(c.percorso), max(c.codice_http), 'cron-http:' || c.job, count(*)::int,
         jsonb_build_object('campi', jsonb_build_object(
           'operazione', 'cron-esiti', 'job', c.job, 'esito', 'errore', 'n', count(*),
           'n_rete', count(*) FILTER (WHERE c.esito = 'errore-rete'), 'codice_http', max(c.codice_http)))
    FROM public.cron_chiamate AS c
   WHERE c.verificata_il = v_adesso AND c.esito IN ('errore-http', 'errore-rete')
   GROUP BY c.job
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(),
        contesto = excluded.contesto, codice = excluded.codice, stato_http = excluded.stato_http;

  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, route, fingerprint, occorrenze, contesto)
  SELECT 'info', 'cron', 'server',
         format('%s chiamate del job %s scadute nel client pg_net: la route può aver finito lo stesso', count(*), c.job),
         'TIMEOUT_PG_NET', min(c.percorso), 'cron-http-timeout:' || c.job, count(*)::int,
         jsonb_build_object('campi', jsonb_build_object(
           'operazione', 'cron-esiti', 'job', c.job, 'esito', 'timeout', 'n', count(*), 'timeout_ms', max(c.timeout_ms)))
    FROM public.cron_chiamate AS c
   WHERE c.verificata_il = v_adesso AND c.esito = 'timeout'
   GROUP BY c.job
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(), contesto = excluded.contesto;

  -- 4. Una riga per job di cron.job, anche spento; chi sparisce da cron.job resta, spento.
  IF v_ha_cron THEN
    INSERT INTO public.cron_ultimo_esito AS u (job, attivo, pianificazione, http, aggiornato_il)
    SELECT DISTINCT ON (k.job) k.job, k.active, k.schedule,
           EXISTS (SELECT 1 FROM public.cron_chiamate AS c WHERE c.job = k.job), v_adesso
      FROM (SELECT coalesce(j.jobname, 'jobid-' || j.jobid) AS job, j.jobid, j.active, j.schedule FROM cron.job AS j) AS k
     ORDER BY k.job, k.jobid DESC
    ON CONFLICT (job) DO UPDATE
      SET attivo = excluded.attivo, pianificazione = excluded.pianificazione,
          http = u.http OR excluded.http, aggiornato_il = excluded.aggiornato_il;

    UPDATE public.cron_ultimo_esito AS u
       SET attivo = false, aggiornato_il = v_adesso
     WHERE u.attivo
       AND NOT EXISTS (SELECT 1 FROM cron.job AS j WHERE coalesce(j.jobname, 'jobid-' || j.jobid) = u.job);
  END IF;

  -- 5. Le chiamate chiuse in questo giro aggiornano l'ultimo esito HTTP del loro job.
  UPDATE public.cron_ultimo_esito AS u
     SET http = true,
         ultima_chiamata_il    = CASE WHEN u.ultima_chiamata_il IS NULL OR s.ultima_il >= u.ultima_chiamata_il
                                      THEN s.ultima_il ELSE u.ultima_chiamata_il END,
         ultima_chiamata_esito = CASE WHEN u.ultima_chiamata_il IS NULL OR s.ultima_il >= u.ultima_chiamata_il
                                      THEN s.ultimo_esito ELSE u.ultima_chiamata_esito END,
         ultimo_codice_http    = CASE WHEN u.ultima_chiamata_il IS NULL OR s.ultima_il >= u.ultima_chiamata_il
                                      THEN s.ultimo_codice ELSE u.ultimo_codice_http END,
         ultimo_ok_il          = greatest(u.ultimo_ok_il, s.ok_il),
         ultimo_errore_il      = greatest(u.ultimo_errore_il, s.errore_il),
         aggiornato_il         = v_adesso
    FROM (
      SELECT DISTINCT ON (c.job) c.job,
             c.inviata_il AS ultima_il, c.esito AS ultimo_esito, c.codice_http AS ultimo_codice,
             max(c.inviata_il) FILTER (WHERE c.esito = 'ok') OVER (PARTITION BY c.job) AS ok_il,
             max(c.inviata_il) FILTER (WHERE c.esito IN ('errore-http', 'errore-rete')) OVER (PARTITION BY c.job) AS errore_il
        FROM public.cron_chiamate AS c
       WHERE c.verificata_il = v_adesso
       ORDER BY c.job, c.inviata_il DESC, c.id DESC
    ) AS s
   WHERE u.job = s.job;

  -- 6. Le esecuzioni nuove di ogni job. Dal secondo giro in poi ogni fallimento nuovo è un error,
  --    anche di un job che il lettore non aveva mai visto (ultimo_runid nullo: un mensile fuori
  --    dalla finestra al primo giro); quelli trovati al primo giro in assoluto (v_primo_giro, passo
  --    0) sono storia di prima dell'installazione.
  IF v_ha_cron THEN
    SELECT greatest(
             (SELECT min(u.ultimo_runid) FROM public.cron_ultimo_esito AS u
               WHERE u.attivo AND u.ultimo_runid IS NOT NULL),
             (SELECT max(d.runid) FROM cron.job_run_details AS d) - v_finestra_run)
      INTO v_da;

    WITH nuove AS (
      SELECT coalesce(j.jobname, 'jobid-' || j.jobid) AS job, d.runid, d.status,
             coalesce(d.end_time, d.start_time) AS il
        FROM cron.job_run_details AS d
        JOIN cron.job AS j ON j.jobid = d.jobid
       WHERE d.runid > coalesce(v_da, 0)
         AND d.status IN ('succeeded', 'failed')
    ), per_job AS (
      SELECT n.job,
             max(n.runid) AS ultimo_runid,
             (array_agg(n.status ORDER BY n.runid DESC))[1] AS ultimo_stato,
             (array_agg(n.il ORDER BY n.runid DESC))[1] AS ultimo_il,
             max(n.il) FILTER (WHERE n.status = 'succeeded') AS ok_il,
             max(n.il) FILTER (WHERE n.status = 'failed') AS errore_il,
             count(*) AS esecuzioni,
             count(*) FILTER (WHERE n.status = 'failed') AS fallite
        FROM nuove AS n
        JOIN public.cron_ultimo_esito AS u ON u.job = n.job
       WHERE n.runid > coalesce(u.ultimo_runid, 0)
       GROUP BY n.job
    ), aggiornate AS (
      UPDATE public.cron_ultimo_esito AS u
         SET ultimo_runid            = p.ultimo_runid,
             ultima_esecuzione_il    = p.ultimo_il,
             ultima_esecuzione_stato = p.ultimo_stato,
             ultimo_ok_il            = CASE WHEN u.http THEN u.ultimo_ok_il ELSE greatest(u.ultimo_ok_il, p.ok_il) END,
             ultimo_errore_il        = greatest(u.ultimo_errore_il, p.errore_il),
             aggiornato_il           = v_adesso
        FROM per_job AS p
       WHERE u.job = p.job
      RETURNING p.job, p.esecuzioni, p.fallite, p.ultimo_runid
    ), segnalate AS (
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, occorrenze, contesto)
      SELECT 'error', 'cron', 'server',
             format('%s esecuzioni fallite del job %s', a.fallite, a.job),
             'CRON_ESECUZIONE_FALLITA', 'cron-sql:' || a.job, a.fallite::int,
             jsonb_build_object('campi', jsonb_build_object(
               'operazione', 'cron-esiti', 'job', a.job, 'esito', 'esecuzione-fallita',
               'n', a.fallite, 'runid', a.ultimo_runid))
        FROM aggiornate AS a
       WHERE a.fallite > 0 AND NOT v_primo_giro
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + excluded.occorrenze, visto_l_ultima = now(), contesto = excluded.contesto
      RETURNING 1
    )
    SELECT coalesce(sum(a.esecuzioni), 0)::int,
           CASE WHEN v_primo_giro THEN 0 ELSE coalesce(sum(a.fallite), 0)::int END
      INTO v_esecuzioni, v_fallite
      FROM aggiornate AS a;
  END IF;

  -- 7. Le chiamate verificate da più di 14 giorni escono: il riassunto resta in cron_ultimo_esito.
  DELETE FROM public.cron_chiamate AS c
   WHERE c.verificata_il IS NOT NULL AND c.verificata_il < v_adesso - v_tieni;
  GET DIAGNOSTICS v_cancellate = ROW_COUNT;

  -- 8. Il battito, nella forma che controlloBattitoCron sa leggere (campi.operazione, campi.esito).
  v_esito := jsonb_build_object(
    'operazione', 'cron-esiti', 'esito', 'ok', 'chiuse', v_chiuse, 'ignote', v_ignote,
    'esecuzioni', v_esecuzioni, 'fallite', v_fallite, 'cancellate', v_cancellate,
    'primo_giro', v_primo_giro, 'net', v_ha_net, 'cron', v_ha_cron);
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('info', 'cron', 'server',
          format('esiti dei cron: %s chiamate chiuse, %s senza esito, %s esecuzioni lette', v_chiuse, v_ignote, v_esecuzioni),
          'cron:cron-esiti', jsonb_build_object('campi', v_esito))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;

  RETURN v_esito;
EXCEPTION WHEN OTHERS THEN
  -- Se si guasta, il giro è annullato per intero ma lascia la sua traccia. Se non può scrivere
  -- neanche questa, l'errore esce e lo vede cron.job_run_details.
  GET STACKED DIAGNOSTICS v_stato = RETURNED_SQLSTATE;
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, codice, fingerprint, contesto)
  VALUES ('error', 'cron', 'server', 'il lettore degli esiti dei cron si è fermato: questo giro non ha letto niente',
          v_stato, 'cron-esiti:fallito',
          jsonb_build_object('campi', jsonb_build_object('operazione', 'cron-esiti', 'esito', 'fallito', 'sqlstate', v_stato)))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(),
        contesto = excluded.contesto, codice = excluded.codice;
  RETURN jsonb_build_object('operazione', 'cron-esiti', 'esito', 'fallito', 'sqlstate', v_stato);
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_esiti() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cron_esiti() IS
  'Lettore degli esiti dei cron (job cron-esiti, minuti 4, 14, … 54): chiude le righe di cron_chiamate leggendo net._http_response, aggiorna cron_ultimo_esito da cron.job e cron.job_run_details, scrive in app_log (cron-http:<job>, cron-http-timeout:<job>, cron-sql:<job>, cron-esiti:esiti-persi, cron-esiti:fallito, battito cron:cron-esiti). Senza pg_net o pg_cron salta ciò che manca. Sessione 6 della seconda serie di robustezza.';

-- == IL JOB ==

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE WARNING 'cron-esiti: schema cron assente (DB della CI o PGlite), job non installato';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-esiti';
  PERFORM cron.schedule('cron-esiti', '4,14,24,34,44,54 * * * *', 'SELECT public.cron_esiti();');
END
$$;

NOTIFY pgrst, 'reload schema';
```

Perché i minuti 4, 14, … 54: i job che chiamano il server partono quasi tutti a minuti tondi; quattro minuti dopo, le risposte con timeout fino a 120 s sono già arrivate, e quelle a 300 s si chiudono al giro dopo.

- [ ] **Passo 4: la voce della migrazione fra quelle attese al merge**

La migrazione crea una PRIMARY KEY e accende la RLS: `toccaUnUnico` e `toccaLaRls` di `__tests__/architecture/soglia-fotografia.ts` la vedono, e il lock pretende la sua voce finché le fotografie non sono rigenerate dalla produzione, cosa che fa la sessione dopo nella sua chiusura (sezione «Per la sessione dopo» di questo piano). La riga si cerca per testo, non per numero (il 20/10 era la 251; la sessione 1 tocca lo stesso file):

```bash
grep -n 'export const MIGRAZIONI_ATTESE_AL_MERGE' __tests__/architecture/soglia-fotografia.ts
```

Atteso: una riga che finisce con `= {}` (il Compito 1, passo 4, ha chiuso la sessione precedente). Quella riga diventa (con la version vera al posto di `@VERSIONE@`; i commenti datati sopra la costante restano dove sono):

```ts
// Sessione 6 della seconda serie (@GIORNO@): la migrazione degli esiti dei cron crea due tabelle con
// PRIMARY KEY e RLS accesa. La applica l'integrazione al merge; la voce la toglie la sessione dopo,
// nella chiusura della precedente (piano della sessione 6, «Per la sessione dopo»).
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {
    '@VERSIONE@_cron_esiti_osservati.sql':
        'Sessione 6 della seconda serie: crea `cron_chiamate` e `cron_ultimo_esito` (PRIMARY KEY, RLS accesa ' +
        'senza policy) e ridefinisce le funzioni che chiamano il server. La applica l’integrazione Supabase ' +
        'al merge; la voce la toglie la sessione dopo, rigenerando dalla produzione le fotografie delle ' +
        'migrazioni, degli indici unici e delle policy.',
}
```

Se la riga **non** finisce con `= {}` (una voce di un'altra sessione è rimasta), non la si cancella: la voce di questa sessione si aggiunge alle altre dentro le graffe, e lo si scrive nella PR.

- [ ] **Passo 5: `cron-esiti` dichiarato fuori dalla sorveglianza fino al primo battito**

Il lock `cron-sorvegliato-e-applicato` vede `cron.schedule('cron-esiti'` e pretende il nome in una delle due liste. In `src/lib/health/controlli.ts` si cerca il testo, non il numero di riga (il 20/10 erano la 435 e la 436; la sessione 1 tocca lo stesso file):

```bash
grep -n "export const JOB_CRON_NON_SORVEGLIATI\|nome: 'fascicolo-audit-ip-retention'" src/lib/health/controlli.ts
```

Atteso: due righe. Dopo la `},` che chiude la voce `nome: 'fascicolo-audit-ip-retention'` (la sua `perche` finisce con le parole «passa in JOB_CRON con finestraMs: 26 * ORA») e prima della `]` che chiude `JOB_CRON_NON_SORVEGLIATI`, aggiungi:

```ts
    // `cron-esiti` (minuti 4, 14, … 54, funzione SQL `cron_esiti`): legge gli esiti delle chiamate
    // dei cron e scrive un battito `cron:cron-esiti` a ogni giro. Sta qui per lo stesso vincolo di
    // SEQUENZA di `fascicolo-audit-ip-retention`: la migrazione la applica l'integrazione al merge
    // della sessione 6, e un nome in `JOB_CRON` senza il suo lavoro manderebbe `/api/health` in
    // `degradato` dal primo deploy. Lo porta in `JOB_CRON` la sessione 7, dopo il primo battito.
    {
        nome: 'cron-esiti',
        perche:
            'IN ATTESA DEL PRIMO BATTITO: la migrazione che lo installa la applica l’integrazione ' +
            'Supabase al merge della sessione 6. Dopo il primo battito `ok` in app_log (impronta ' +
            '`cron:cron-esiti`) lo porta in `JOB_CRON` la sessione 7.',
    },
```

- [ ] **Passo 6: i test della migrazione e i lock che la guardano**

```bash
npx vitest run __tests__/db/cron-esiti.test.ts 2>&1 | tail -8
npx vitest run __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts \
  __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts \
  __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/niente-sql-arbitrario.test.ts \
  __tests__/architecture/cron-http-esito-osservato.test.ts __tests__/lib/cron-esiti-involucro.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 passed`, poi `Test Files  8 passed`. In particolare: `security-definer-revoke-lock` trova il `REVOKE … FROM PUBLIC, anon, authenticated, service_role` dopo ciascuna delle due funzioni; `migrazioni-distruttive-approvate` non chiede il marcatore (il `DELETE` sta nel corpo di una funzione, che non gira alla migrazione); `niente-sql-arbitrario` (sessione 2) non trova argomenti `sql`/`query`/`istruzione`; il vecchio `cron-http-esito-osservato` è ancora verde perché `iscrizioni_retention_http` non è ancora ridefinita. Un rosso in PGlite si legge col messaggio e il codice: la correzione va nella migrazione, mai nel test.

- [ ] **Passo 7: commit**

```bash
git add "supabase/migrations/${V}_cron_esiti_osservati.sql" __tests__/db/cron-esiti.test.ts \
  __tests__/architecture/soglia-fotografia.ts src/lib/health/controlli.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: cron_chiamate, cron_ultimo_esito, involucro e lettore degli esiti

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: il `grep` senza righe.

---

### Compito 5: le funzioni passano dall'involucro, coi corpi della produzione

**File:**
- Modifica: `supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql` (il blocco generato sotto il segno `-- == LE FUNZIONI CHE CHIAMANO IL SERVER (generate, Passo 0.6) ==`)
- Modifica: `__tests__/db/cron-esiti.test.ts` (un `describe` in più)
- Riscrive: `__tests__/architecture/cron-http-esito-osservato.test.ts`

- [ ] **Passo 1: il test di equivalenza, che fallisce**

In `__tests__/db/cron-esiti.test.ts`, aggiungi agli import:

```ts
import { NON_SI_AVVOLGONO, corpoDi, inversa, mascheraSql, md5, minimoAvvolte, svolgi } from '../../scripts/cron-esiti/involucro.mjs'
```

e in fondo al file:

```ts
/** Le funzioni che la migrazione ridefinisce, con la definizione di prima (svolta) e l'etichetta. */
function ridefinite(): { nome: string; prima: string; job: string }[] {
  const codice = mascheraSql(MIGRAZIONE)
  const trovate: { nome: string; prima: string; job: string }[] = []
  for (const m of codice.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
    if (m[1] === 'cron_http_post' || m[1] === 'cron_esiti') continue
    const fine = codice.indexOf(';', m.index)
    const { definizione, job } = svolgi(MIGRAZIONE.slice(m.index, fine))
    trovate.push({ nome: m[1], prima: definizione, job })
  }
  return trovate
}

describe('le funzioni ridefinite fanno la stessa chiamata di prima', () => {
  const RIDEFINITE = ridefinite()

  it('sono almeno quelle attese, nessuna è fra le escluse, nessun nome due volte', () => {
    expect(RIDEFINITE.length).toBeGreaterThanOrEqual(minimoAvvolte())
    for (const r of RIDEFINITE) expect(Object.hasOwn(NON_SI_AVVOLGONO, r.nome), r.nome).toBe(false)
    expect(new Set(RIDEFINITE.map((r) => r.nome)).size).toBe(RIDEFINITE.length)
  })

  it('prima e dopo: stesse chiamate a pg_net, stessi errori, stesse righe in app_log', { timeout: 120_000 }, async () => {
    const prima = await nuovoDatabase()
    await prima.exec(RIDEFINITE.map((r) => `${r.prima};`).join('\n\n'))
    const dopo = await nuovoDatabase()
    await dopo.exec(MIGRAZIONE)
    let raggiunte = 0
    for (const r of RIDEFINITE) {
      const esiti: unknown[] = []
      for (const db of [prima, dopo]) {
        await db.exec('DELETE FROM net.chiamate; DELETE FROM public.app_log;')
        const [{ n, trigger }] = await righe<{ n: number; trigger: boolean }>(db,
          `SELECT p.pronargs::int AS n, p.prorettype = 'trigger'::regtype AS trigger
             FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
            WHERE s.nspname = 'public' AND p.proname = $1`, [r.nome])
        if (trigger) { esiti.push('funzione di trigger: non si chiama da sola'); continue }
        const errore = await erroreDi(db.query(`SELECT public.${r.nome}(${Array(n).fill('NULL').join(', ')})`))
        esiti.push({
          errore: errore?.code ?? null,
          chiamate: await righe(db, 'SELECT url, body, params, headers, timeout_milliseconds FROM net.chiamate ORDER BY n'),
          log: await righe(db, 'SELECT fingerprint, livello FROM public.app_log ORDER BY fingerprint COLLATE "C"'),
        })
      }
      expect(esiti[1], r.nome).toEqual(esiti[0])
      if ((await righe(dopo, 'SELECT count(*)::int AS n FROM net.chiamate'))[0].n > 0) {
        raggiunte++
        expect(await righe(dopo,
          'SELECT DISTINCT job FROM public.cron_chiamate WHERE richiesta_id IN (SELECT n FROM net.chiamate)'), r.nome)
          .toEqual([{ job: r.job }])
      }
    }
    // Le cinque più semplici (dispatch, promemoria, allergie, news, digest) leggono il Vault e chiamano:
    // se nemmeno quelle arrivano a pg_net, il banco di prova non sta provando niente.
    expect(raggiunte).toBeGreaterThanOrEqual(5)
  })

  it('la migrazione inversa rimette ogni funzione com’era e toglie job, funzioni e tabelle', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(MIGRAZIONE)
    await db.exec(inversa(MIGRAZIONE))
    for (const r of RIDEFINITE) {
      expect(await righe(db, `SELECT md5(p.prosrc) AS m FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
          WHERE s.nspname = 'public' AND p.proname = $1`, [r.nome]), r.nome).toEqual([{ m: md5(corpoDi(r.prima).corpo) }])
    }
    expect(await righe(db, `SELECT to_regclass('public.cron_chiamate') IS NULL AS a, to_regclass('public.cron_ultimo_esito') IS NULL AS b,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('cron_http_post', 'cron_esiti')) AS f,
        (SELECT count(*)::int FROM cron.job WHERE jobname = 'cron-esiti') AS j`)).toEqual([{ a: true, b: true, f: 0, j: 0 }])
  })
})
```

```bash
npx vitest run __tests__/db/cron-esiti.test.ts 2>&1 | tail -8
```

Atteso: FAIL su «sono almeno quelle attese» (`expected 0 to be greater than or equal to 19`, o il minimo dopo il Compito 3) e su «prima e dopo» (`expected 0 to be greater than or equal to 5`). La migrazione non ridefinisce ancora niente.

- [ ] **Passo 2: il lock riscritto, che fallisce**

Sostituisci **tutto** `__tests__/architecture/cron-http-esito-osservato.test.ts` con:

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    ASSENTI_IN_PRODUZIONE, INVOLUCRO, LETTORE, NON_SI_AVVOLGONO,
    contaChiamate, corpoOVuoto, mascheraSql, minimoAvvolte, ultimeDefinizioni,
} from '../../scripts/cron-esiti/involucro.mjs'
import { JOB_CRON, JOB_CRON_NON_SORVEGLIATI } from '@/lib/health/controlli'

/**
 * LOCK · ogni chiamata dei cron al server deve poter VEDERE il proprio esito.
 *
 * ─── LA STORIA, IN TRE GIORNI ────────────────────────────────────────────────
 *
 * 1° agosto, mattina. La regola dei 24 mesi sulle domande d'iscrizione è una
 * funzione SQL che cancella anche i file. Postgres lo vieta: la funzione fallisce
 * a ogni esecuzione, e fallisce PRIMA di scrivere la riga di log che avrebbe
 * dovuto segnalarlo. «La difesa che doveva accorgersi del guasto stava a valle del
 * guasto» — parole della migrazione che l'ha corretta.
 *
 * 1° agosto, pomeriggio. La correzione avvolge `net.http_post` in un
 * `EXCEPTION WHEN OTHERS` che lascia una riga `error`, e scrive nel commento della
 * funzione che quel lavoro «NON è muto sul fallimento».
 *
 * 2 agosto. Il collaudo misura che quella promessa il meccanismo non poteva
 * mantenerla: `net.http_post` è ASINCRONO — `pg_get_function_result` dice `bigint`,
 * cioè un numero d'ordine — e accoda soltanto. L'esito vero (4xx/5xx, timeout,
 * DNS, host irraggiungibile) lo scrive un altro processo in `net._http_response`,
 * fuori dalla transazione: quel blocco `EXCEPTION` non lo vedrà mai. Misurato lo
 * stesso giorno: 120 risposte in `net._http_response`, **nessuna** funzione del
 * database che le legga.
 *
 * ─── PERCHÉ UN LOCK, E NON SOLO UNA CORREZIONE ──────────────────────────────
 *
 * Perché il difetto non è stato un errore di battitura: è stata la REPLICA DELLA
 * FORMA di una difesa (try/catch + log) senza verificare che il punto di
 * osservazione vedesse il guasto. È una cosa che si rifà, e si rifà proprio
 * quando si va di fretta a correggere. Il gate era verde tutte e tre le volte.
 *
 * Questo lock guarda il MECCANISMO, non le parole: che il numero d'ordine venga
 * conservato, e che qualcuno legga la tabella dove l'esito arriva davvero.
 *
 * ─── PERIMETRO, DICHIARATO ──────────────────────────────────────────────────
 *
 * Fino al 2026-10-20 sorvegliava il solo job della conservazione delle iscrizioni:
 * gli altri lavori via `net.http_post` avevano la stessa cecità, ma girando ogni
 * 5-30 minuti un'esecuzione persa si riassorbiva alla successiva, mentre lì il giro
 * era MENSILE e i dati sanitari, di minori non iscritti. Questo blocco diceva che il
 * giorno in cui si fosse voluta estendere la sorveglianza agli altri, il posto per
 * scriverlo era qui.
 *
 * ─── 2026-10-20: ESTESO A TUTTI ─────────────────────────────────────────────
 *
 * Sessione 6 della seconda serie di robustezza. Ogni funzione che chiama il server
 * passa da `public.cron_http_post('<job>', …)`, che conserva il numero e lo scrive in
 * `cron_chiamate`; `cron_esiti()` legge `net._http_response` e `cron.job_run_details`
 * ogni 10 minuti e scrive l'esito in `app_log` col nome del job. Le funzioni sono
 * state riscritte partendo dai corpi della PRODUZIONE (`pg_get_functiondef`) da
 * `scripts/cron-esiti/involucro.mjs`, che cambia solo la chiamata. Le eccezioni
 * stanno in `NON_SI_AVVOLGONO` e `ASSENTI_IN_PRODUZIONE` dello stesso file, ciascuna
 * con la sua ragione; questo lock pretende che restino vere.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')
const FILE = readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()
const ULTIME = ultimeDefinizioni(MIGRAZIONI)
const ESCLUSE: Record<string, string> = { ...NON_SI_AVVOLGONO, ...ASSENTI_IN_PRODUZIONE }

const definizione = (funzione: string): string => ULTIME.get(funzione)?.definizione ?? ''
/** Il corpo senza commenti; le stringhe restano (servono i nomi delle tabelle e dei job). */
const corpoSenzaCommenti = (funzione: string): string =>
    mascheraSql(corpoOVuoto(definizione(funzione)), { stringhe: false })
const chiamate = (funzione: string) => contaChiamate(corpoOVuoto(definizione(funzione)))

describe('lock architettura · ogni chiamata dei cron al server vede il proprio esito', () => {
    it('le fonti sono piene (se cade questa, tutto il resto sta controllando il vuoto)', () => {
        expect(FILE.length, 'nessun file .sql sotto supabase/migrations').toBeGreaterThan(60)
        expect(ULTIME.size, 'lo scanner non trova le funzioni delle migrazioni').toBeGreaterThan(100)
        expect(ULTIME.has(INVOLUCRO), `manca public.${INVOLUCRO}()`).toBe(true)
        expect(ULTIME.has(LETTORE), `manca public.${LETTORE}()`).toBe(true)
    })

    it('nessuna funzione chiama net.http_post da sola: passa dall’involucro, salvo le escluse dichiarate', () => {
        const dirette = [...ULTIME.keys()].filter(
            (nome) => nome !== INVOLUCRO && !Object.hasOwn(ESCLUSE, nome) && chiamate(nome).dirette > 0,
        )
        expect(
            dirette,
            'Queste funzioni chiamano `net.http_post` direttamente e buttano via il numero della ' +
            'richiesta: il loro esito non arriverà a nessuno. Si avvolgono con ' +
            '`node scripts/cron-esiti/involucro.mjs genera`, partendo dal corpo della PRODUZIONE; ' +
            'oppure si dichiarano in `NON_SI_AVVOLGONO`, con la ragione.',
        ).toEqual([])
    })

    it('ogni esclusione è ancora vera e porta una ragione', () => {
        for (const [nome, ragione] of Object.entries(ESCLUSE)) {
            expect(ragione.length, `${nome}: ragione troppo corta`).toBeGreaterThan(30)
            expect(chiamate(nome).dirette, `${nome}: non chiama più net.http_post, si toglie l’esclusione`).toBe(1)
        }
    })

    it('l’involucro conserva il numero, lo registra, ed è chiuso ai ruoli client', () => {
        const corpo = corpoSenzaCommenti(INVOLUCRO)
        expect(/\w+\s*:=\s*net\.http_post\s*\(/i.test(corpo), 'il numero di net.http_post non è raccolto').toBe(true)
        expect(/PERFORM\s+net\.http_post/i.test(corpo), '`PERFORM net.http_post` butta via il numero').toBe(false)
        expect(/INSERT\s+INTO\s+public\.cron_chiamate/i.test(corpo), 'il numero non viene registrato').toBe(true)
        expect(definizione(INVOLUCRO)).toMatch(/SECURITY\s+DEFINER/i)
        expect(definizione(INVOLUCRO)).toMatch(/SET\s+search_path\s+TO\s+'public',\s*'pg_temp'/i)
        const file = readFileSync(join(MIGRAZIONI, ULTIME.get(INVOLUCRO)!.file), 'utf8')
        expect(mascheraSql(file)).toMatch(
            /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.cron_http_post\([^)]*\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
        )
    })

    it('le funzioni avvolte sono almeno quelle attese, e ogni etichetta è di una funzione sola', () => {
        const etichette = new Map<string, string>()
        let avvolte = 0
        for (const nome of ULTIME.keys()) {
            if (nome === INVOLUCRO || chiamate(nome).avvolte === 0) continue
            avvolte++
            const job = /public\.cron_http_post\(\s*'([a-z0-9][a-z0-9-]*)'/i.exec(corpoSenzaCommenti(nome))?.[1]
            expect(job, `${nome}: l’involucro si chiama col nome del job, fra apici, come primo argomento`).toBeTruthy()
            expect(etichette.get(job!), `etichetta «${job}» usata anche da ${etichette.get(job!)}`).toBeUndefined()
            etichette.set(job!, nome)
        }
        expect(avvolte).toBeGreaterThanOrEqual(minimoAvvolte())
    })

    it('la conservazione delle iscrizioni conserva ancora il numero, lo registra, e aspetta più di 5 secondi', () => {
        const nome = 'iscrizioni_retention_http'
        const corpo = corpoSenzaCommenti(nome)
        expect(corpo, `manca ${nome}()`).not.toBe('')
        expect(chiamate(nome)).toEqual({ dirette: 0, avvolte: 1 })
        expect(/PERFORM\s+public\.cron_http_post/i.test(corpo), '`PERFORM` butta via il numero d’ordine').toBe(false)
        expect(
            /(\w+\s*:=\s*public\.cron_http_post\s*\(|SELECT\s+public\.cron_http_post\s*\([\s\S]*?\)\s*INTO\s+\w+)/i.test(corpo),
            'il numero restituito dall’involucro non è raccolto in una variabile',
        ).toBe(true)
        expect(/iscrizioni_retention_esecuzioni/i.test(corpo), 'il numero non viene registrato').toBe(true)
        const t = /timeout_milliseconds\s*(?::=|=>)\s*(\d+)/i.exec(corpo)
        expect(t !== null && Number(t[1]) > 5000, 'timeout di fabbrica (5 s): la route non finisce in cinque secondi').toBe(true)
    })

    it('qualcuno LEGGE net._http_response e cron.job_run_details, e ne scrive l’esito in app_log', () => {
        const corpo = corpoSenzaCommenti(LETTORE)
        expect(corpo).toMatch(/to_regclass\('net\._http_response'\)/)
        expect(corpo).toMatch(/to_regclass\('cron\.job_run_details'\)/)
        expect(corpo).toMatch(/FROM\s+net\._http_response/i)
        expect(corpo).toMatch(/FROM\s+cron\.job_run_details/i)
        expect(corpo).toMatch(/'cron-http:'/)
        expect(corpo).toMatch(/'cron-http-timeout:'/)
        expect(corpo).toMatch(/'cron-esiti:fallito'/)
        expect(corpo).toMatch(/INSERT\s+INTO\s+public\.app_log/i)
    })

    it('la sorveglianza delle iscrizioni si accorge anche del SILENZIO', () => {
        const corpo = corpoSenzaCommenti('iscrizioni_retention_sorveglia')
        expect(corpo, 'manca `iscrizioni_retention_sorveglia()`').not.toBe('')
        expect(/interval\s+'(\d+)\s+days'/i.test(corpo), 'non misura da quanto il lavoro non arriva').toBe(true)
        expect(/app_log/i.test(corpo), 'non lascia traccia in app_log').toBe(true)
    })

    it('il job cron-esiti è installato e dichiarato in una delle due liste della salute', () => {
        const installano = FILE.filter((f) => /cron\.schedule\(\s*'cron-esiti'/.test(readFileSync(join(MIGRAZIONI, f), 'utf8')))
        expect(installano, 'nessuna migrazione installa cron-esiti').not.toEqual([])
        const nomi = [...JOB_CRON, ...JOB_CRON_NON_SORVEGLIATI].map((j) => j.nome)
        expect(nomi).toContain('cron-esiti')
    })

    it('controllo positivo: il contatore vede la chiamata vera e ignora commento e stringa', () => {
        expect(contaChiamate("-- net.http_post(\n RAISE LOG 'net.http_post('; PERFORM net.http_post(url := 'x');"))
            .toEqual({ dirette: 1, avvolte: 0 })
    })
})
```

```bash
npx vitest run __tests__/architecture/cron-http-esito-osservato.test.ts 2>&1 | tail -10
```

Atteso: FAIL su «nessuna funzione chiama net.http_post da sola» (l'elenco delle funzioni del repo), su «almeno quelle attese» e su «la conservazione delle iscrizioni» (`{ dirette: 1, avvolte: 0 }`). Gli altri verdi.

- [ ] **Passo 3: genera il blocco dalla produzione**

```bash
node scripts/cron-esiti/involucro.mjs genera /tmp/kidville-s06-definizioni-*.json > /tmp/kidville-s06-blocco.sql
echo "uscita: $?"
grep -cE '^CREATE OR REPLACE FUNCTION' /tmp/kidville-s06-blocco.sql
grep -nE '@[A-Z_]+@' /tmp/kidville-s06-blocco.sql
```

Atteso: `uscita: 0`; sullo standard error le righe `saltata — genera_solleciti: …` (più eventuali `cita net.http_post solo in commenti o stringhe`) e `ridefinite: N`. N è `@N_AVVOLTE@` e deve essere **≥ `minimoAvvolte()`**; il conteggio del `grep -c` deve dare lo stesso N; l'ultimo `grep` nessuna riga. Se il modulo si ferma (uscita 1), il messaggio dice perché e **non si aggira**: proprietario diverso da `postgres`, SECURITY INVOKER, EXECUTE ad `anon`/`authenticated`, due job sulla stessa funzione, un possibile segreto o dato personale nel corpo, una forma di chiamata non canonica. Ognuno di questi è uno STOP con domanda al titolare; mai una definizione corretta a mano.

- [ ] **Passo 4: il blocco entra nella migrazione, sotto il suo segno**

```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs"
const [file, blocco] = process.argv.slice(1)
const segno = "-- == LE FUNZIONI CHE CHIAMANO IL SERVER (generate, Passo 0.6) ==\n"
const pezzi = readFileSync(file, "utf8").split(segno)
if (pezzi.length !== 2) throw new Error("il segno deve comparire una volta sola, trovato " + (pezzi.length - 1))
writeFileSync(file, pezzi[0] + segno + "\n" + readFileSync(blocco, "utf8") + pezzi[1])
' supabase/migrations/*_cron_esiti_osservati.sql /tmp/kidville-s06-blocco.sql
grep -c '^CREATE OR REPLACE FUNCTION' supabase/migrations/*_cron_esiti_osservati.sql
```

Atteso: N + 2 (le generate, l'involucro e il lettore). Si usa `split`/concatenazione e non `replace`: nella stringa di sostituzione di `replace` la sequenza `$$` diventa `$`, e i corpi delle funzioni ne sono pieni.

- [ ] **Passo 5: tutti i test che guardano la migrazione e le funzioni**

```bash
npx vitest run __tests__/db/cron-esiti.test.ts __tests__/architecture/cron-http-esito-osservato.test.ts \
  __tests__/lib/cron-esiti-involucro.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts \
  __tests__/architecture/stati-alunno-anche-in-sql.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts \
  __tests__/architecture/storage-delete-vietata-in-sql.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts \
  __tests__/architecture/niente-sql-arbitrario.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -10
```

Atteso: `Test Files  10 passed`. Cosa dice un rosso:
- «prima e dopo» con un nome: per quella funzione la chiamata a pg_net, l'errore o le righe in `app_log` cambiano. Si guarda la differenza stampata; la causa sta nell'involucro (argomenti o default diversi dalla misura 0.3), mai nel test;
- `raggiunte` sotto 5: il banco non arriva a pg_net (Vault finto con nomi di chiavi diversi da quelli dei corpi veri). Si leggono i nomi con `grep -o "cron_config('[a-z_.]*')" /tmp/kidville-s06-blocco.sql | sort -u` e si aggiungono a `vault_finto` del test;
- `stati-alunno-anche-in-sql` su `storici_tick`: il corpo della produzione non ha `alunno_uscita_consolidata`. È un `diverso` sfuggito al Compito 3: STOP e domanda al titolare;
- `security-definer-revoke-lock` con un nome: il generatore non ha scritto il `REVOKE` dopo quella funzione. Si corregge il modulo (con un caso nel suo test), si rigenera dal passo 3.

- [ ] **Passo 6: la migrazione inversa si genera e si legge**

```bash
node scripts/cron-esiti/involucro.mjs inversa supabase/migrations/*_cron_esiti_osservati.sql > /tmp/kidville-s06-inversa.sql
grep -c '^CREATE OR REPLACE FUNCTION' /tmp/kidville-s06-inversa.sql
```

Atteso: N. Il file resta fuori dal repo: serve solo se il titolare chiede di tornare indietro («Ritorno indietro»). Il test «la migrazione inversa rimette ogni funzione com'era» del passo 5 l'ha già provata su PGlite.

- [ ] **Passo 7: commit**

```bash
git add supabase/migrations/*_cron_esiti_osservati.sql __tests__/db/cron-esiti.test.ts \
  __tests__/architecture/cron-http-esito-osservato.test.ts
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: le funzioni dei cron passano dall'involucro, coi corpi della produzione

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: il `grep` senza righe.

---

## Migrazione

Una sola, `supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql`, scritta in due tempi: la parte fissa al Compito 4 (registri, involucro, lettore, job), il blocco generato dalla produzione al Compito 5.

- **Nome:** version da `date -u +%Y%m%d%H%M%S` nel momento in cui si scrive il file, mai un orario tondo né una data futura; più grande dell'ultima version della fotografia (lock `migrazioni-complete`).
- **Conteggio prima (§5):** `@N_ISCRIZIONI@` domande alle `@ORA_CONTEGGIO@` UTC (misura 0.1), scritto nell'intestazione e nella voce del PRD. La migrazione non tocca nessuna tabella con dati di minori.
- **Chi la applica:** l'integrazione GitHub di Supabase **al merge**, con la version del file. Mai `apply_migration` (il freno della sessione 2 lo nega), mai `supabase db push` a mano (§8, divieto 4).
- **Cosa cambia in produzione, e cosa no:** nascono due tabelle, due funzioni e un job; le funzioni che chiamano il server cambiano **solo** la chiamata (`net.http_post(` → `public.cron_http_post('<job>', `). Restano uguali URL, header, corpi, timeout di ciascuna (5000 ms per la maggior parte, 120000 per `iscrizioni_retention_http`, 300000 per `fatture_sdi_sync_tick`, `fatture_coda_tick_http` e `storici_tick`, se la misura 0.6 conferma i valori del repo), pianificazioni, route e permessi (il `GRANT … TO service_role` si rimette solo dove la misura 0.6 l'ha trovato).
- **Guardie per la CI e PGlite:** il lettore cerca `net._http_response`, `net.http_request_queue`, `cron.job` e `cron.job_run_details` con `to_regclass` e salta ciò che manca; il job si installa solo se lo schema `cron` esiste (altrimenti un `WARNING`). Se nel DB della CI c'è `pg_cron`, il job gira anche lì: legge i suoi registri e non chiama nessuno. I corpi plpgsql non si risolvono alla creazione: le funzioni generate nascono anche dove mancano le loro tabelle. Se il job `DB migrate (CI)` diventasse rosso su una funzione generata, si legge l'errore e si chiede al titolare: il corpo della produzione non si cambia per farlo passare.
- **`NOT VALID`:** non si applica (nessun vincolo su tabelle esistenti).
- **Scritture in `app_log`:** nessuna al momento della migrazione; le scrivono involucro e lettore quando girano (parte «Log»).
- **Fotografie:** la migrazione crea due PRIMARY KEY e accende la RLS su due tabelle nuove: voce in `MIGRAZIONI_ATTESE_AL_MERGE` (Compito 4, passo 4). La toglie la sessione dopo, nel primo commit, insieme alle fotografie rigenerate dalla produzione (migrazioni, indici unici, policy): sezione «Per la sessione dopo». Nessuna PR di soli documenti dopo il rilascio.
- **Lock distruttive:** nessun marcatore serve. Il solo `DELETE` (pulizia delle chiamate verificate da 14 giorni) sta nel corpo di `cron_esiti()`, che non gira alla migrazione.
- **ROLLBACK:** nell'intestazione: `SELECT cron.unschedule('cron-esiti');` per fermare subito, e la migrazione inversa generata da `node scripts/cron-esiti/involucro.mjs inversa` per tornare indietro del tutto (parte «Ritorno indietro»).

## Log

Nessuna route nuova e nessuna integrazione esterna nuova nel codice dell'app: non servono chiamate nuove a `logOk`/`logErrore`/`logEvento`, e nessun `withRoute` cambia. Il logging di questa sessione **è** il prodotto della sessione, e vive nel database. Ogni riga ha `evento = 'cron'` (il vocabolario di `EVENTI_NOTI` in `src/lib/logging/logger.ts` è chiuso, e `cron` c'è già), `sorgente = 'server'`, un'impronta stabile, e il contesto annidato sotto `campi`:

| Impronta | Livello | Quando | `codice` | `campi` |
|---|---|---|---|---|
| `cron-http:<job>` | `error` | risposte 4xx/5xx o errori di rete chiuse in un giro (un 3xx è `ok`) | il codice in maiuscolo trovato nel corpo (es. `CRON_NON_AUTORIZZATO`), altrimenti `HTTP_<n>` o `ERRORE_RETE` | `operazione`, `job`, `esito: 'errore'`, `n`, `n_rete`, `codice_http` |
| `cron-http-timeout:<job>` | `info` | timeout del client pg_net (la route può aver finito lo stesso) | `TIMEOUT_PG_NET` | `operazione`, `job`, `esito: 'timeout'`, `n`, `timeout_ms` |
| `cron-sql:<job>` | `error` | esecuzioni `failed` in `cron.job_run_details`, dal secondo giro del lettore in poi (al primo giro in assoluto, con `cron_ultimo_esito` vuota, sono storia di prima dell'installazione); vale anche per un job mai visto prima, come un mensile | `CRON_ESECUZIONE_FALLITA` | `operazione`, `job`, `esito: 'esecuzione-fallita'`, `n`, `runid` |
| `cron-esiti:esiti-persi` | `warn` | chiamate senza risposta dopo la vita delle risposte | `ESITO_IGNOTO` | `operazione`, `esito: 'esiti-persi'`, `n` |
| `cron-esiti:fallito` | `error` | il lettore stesso si è guastato (il giro è annullato) | lo SQLSTATE | `operazione`, `esito: 'fallito'`, `sqlstate` |
| `cron-http:registro-non-scritto` | `error` | l'involucro ha mandato la richiesta ma non l'ha registrata | lo SQLSTATE | `operazione: 'cron-http-post'`, `job`, `esito`, `richiesta_id` |
| `cron:cron-esiti` | `info` | **ogni giro riuscito**: il battito (regola 5, il successo si logga) | — | `operazione: 'cron-esiti'`, `esito: 'ok'`, `chiuse`, `ignote`, `esecuzioni`, `fallite`, `cancellate`, `primo_giro`, `net`, `cron` |

- **Mai dati personali (regola 8):** solo nomi di job, conteggi, codici HTTP, codici in maiuscolo, SQLSTATE e il percorso della route senza query string. Né il corpo della risposta, né `return_message` di `cron.job_run_details`, né gli header: due casi del test PGlite lo provano (`not.toContain('bambino')`, `not.toContain('non deve uscire')`).
- **Un guasto non tace (regole 6 e 9):** se il registro non si scrive, l'involucro lascia un `error` e lascia partire la richiesta; se non può scrivere neanche in `app_log`, un `RAISE LOG` nei log di Postgres. Se il lettore si guasta lascia `cron-esiti:fallito`; se non può scrivere neanche quello, l'errore esce e lo registra `cron.job_run_details` come `failed` (misura D6).
- **Effetto sulla salute:** dal primo giro ogni job in errore è un'impronta `error` con `sorgente = 'server'`, e il controllo `tasso-errore` le conta (5 impronte o 25 occorrenze in 15 minuti). Per questo la misura 0.7 ha una soglia, e il numero di errori del «prima» va in grassetto nella PR.
- **Dopo il merge** il primo battito si guarda subito (Rilascio, passo 9); le righe di 24 ore le guarda la query D5 della misura «dopo» (sezione «Per la sessione dopo», punto 4).

## PRD

- [ ] **Passo 1: la voce di changelog in cima a `PRD REGISTRO ELETTRONICO.md`**

Si inserisce **prima** della riga 1, con i gettoni sostituiti dai valori veri (`@PR@` resta fino al passo 4 del Rilascio):

```markdown
## 🛡️ Changelog — Robustezza, seconda serie, sessione 6: esiti dei cron, si osserva e non si cambia — @GIORNO@ (branch `robustezza2/s06-esiti-cron`)

**Stato:** 🟨 in revisione — PR #@PR@, **merge a mano del titolare**. «In produzione» lo scrive la sessione dopo, nella chiusura della precedente. Al merge l'integrazione Supabase applica `supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql`. Domande d'iscrizione contate prima della migrazione: **@N_ISCRIZIONI@** alle @ORA_CONTEGGIO@ UTC.

- **Il problema (S1, osservazione).** Le funzioni dei job di `pg_cron` chiamano il server con `net.http_post` e buttano via il numero della richiesta: l'esito arriva in `net._http_response`, che lo tiene circa 6 ore, senza il nome del job. Misura prima (@GIORNO@): @RISPOSTE_6H@ risposte nelle ultime ~6 h, di cui @TIMEOUT_6H@ scadute e @ERRORI_6H@ in errore (4xx/5xx o rete); @N_JOB@ job in `cron.job`, @N_JOB_ATTIVI@ attivi.
- **Due registri.** `cron_chiamate` (una riga per chiamata: job, numero della richiesta, esito, codice HTTP; si tiene 14 giorni) e `cron_ultimo_esito` (una riga per job di `cron.job`, HTTP o solo SQL, anche spento; non scade, copre i mensili). RLS accesa, nessun ruolo client, `service_role` legge.
- **L'involucro.** `public.cron_http_post(job, url, body, params, headers, timeout_milliseconds)`: gli stessi argomenti e default di `net.http_post`, più il nome del job; manda la richiesta e poi la registra. Se la registrazione fallisce la richiesta è già partita e resta un `error` in `app_log`.
- **@N_AVVOLTE@ funzioni ridefinite dai corpi della produzione** (`pg_get_functiondef`), cambiando solo la chiamata: stessi URL, header, corpi e timeout. Generate da `scripts/cron-esiti/involucro.mjs`, che si ferma su tutto ciò che non sa trattare. Corpi diversi dal repo e riallineati alla produzione: @DIVERSE@. Esclusa `genera_solleciti()` (deprecata, SECURITY INVOKER, nessun job).
- **Il lettore.** `cron_esiti()`, job `cron-esiti` ai minuti 4, 14, … 54: chiude le chiamate da `net._http_response`, aggiorna `cron_ultimo_esito` da `cron.job` e `cron.job_run_details`, e scrive in `app_log` `error` `cron-http:<job>` (4xx/5xx/rete), `info` `cron-http-timeout:<job>`, `error` `cron-sql:<job>`, `warn` `cron-esiti:esiti-persi`, `error` `cron-esiti:fallito` e il battito `cron:cron-esiti`. `cron-esiti` è in `JOB_CRON_NON_SORVEGLIATI` fino al primo battito; lo sorveglia la sessione 7.
- **Lock e test.** `cron-http-esito-osservato` passa da «solo `iscrizioni_retention_http`» a «tutte le funzioni che chiamano il server»; test nuovi `__tests__/lib/cron-esiti-involucro.test.ts` e `__tests__/db/cron-esiti.test.ts` (PGlite: classificazione, registro, guasti, permessi, equivalenza prima/dopo di ogni funzione, migrazione inversa).
- **Fuori perimetro, scritto.** Nessun timeout, pianificazione o route cambia (sessione 8); la salute non legge ancora `cron_ultimo_esito` (sessione 7).
- **Logging.** Nessuna route nuova. Le righe nuove in `app_log` hanno `evento = 'cron'`, impronte stabili per job, solo nomi, conteggi e codici: mai il corpo di una risposta. Il lettore logga anche il successo (battito) e il proprio guasto.
```

Se il Compito 3 ha trovato funzioni `solo-in-produzione` o ne ha dichiarate in `ASSENTI_IN_PRODUZIONE`, una riga in più subito dopo quella delle funzioni ridefinite, coi nomi.

- [ ] **Passo 2: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git diff --cached "PRD REGISTRO ELETTRONICO.md" | grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: PRD — esiti dei cron

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: il `grep` mostra **solo** `@PR@` (si riempie al passo 4 del Rilascio).

## Rilascio

- [ ] **Passo 1: gate completi**

```bash
cd /Users/lerri/kidville-web-s06
npx eslint . --max-warnings 0
npx tsc --noEmit
CI=1 npx vitest run 2>&1 | tail -6
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso: `eslint` e `tsc` senza uscita; `Test Files … passed` senza `failed`; build `✓ Compiled successfully`. Mai `npm run e2e` in locale: gli E2E girano in CI.

- [ ] **Passo 2: misure del giorno della PR**

Si rifanno 0.1 (conteggio, con l'ora), 0.6b (impronte) e 0.7 (risposte delle ultime ~6 h). Se le impronte di 0.6b non sono quelle di 0.6, si rifà 0.6 e si torna al Compito 5, passi 3-7: la migrazione deve partire dai corpi di **oggi**. Se il conteggio è cambiato, si aggiornano intestazione della migrazione e voce del PRD con un commit.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s06-esiti-cron
```

Scrivi `/tmp/kidville-s06-pr.md`, riempito con le misure del Passo 0:

```markdown
## Sessione 6 della seconda serie di robustezza — esiti dei cron: si osserva, non si cambia

Specifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, sessione 6.
Piano: `docs/superpowers/plans/2026-10-20-robustezza2-s06-esiti-cron.md`.

**⚠️ Merge a mano del titolare.** Al merge l'integrazione Supabase applica
`supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql`.

### Misura prima (@GIORNO@, UTC)
- Domande d'iscrizione: @N_ISCRIZIONI@ alle @ORA_CONTEGGIO@.
- `net._http_response`: @RISPOSTE_6H@ risposte, @TIMEOUT_6H@ scadute, @ERRORI_6H@ in errore (4xx/5xx o rete).
- `cron.job`: @N_JOB@ job, @N_JOB_ATTIVI@ attivi.
- Funzioni che chiamano il server, da `pg_proc`: ridefinite @N_AVVOLTE@; diverse dal repo: @DIVERSE@.

### Cosa cambia
- Due registri (`cron_chiamate`, `cron_ultimo_esito`), l'involucro `cron_http_post`, il lettore `cron_esiti()` e il job `cron-esiti` (minuti 4, 14, … 54).
- Le funzioni dei cron cambiano **solo** la chiamata: `net.http_post(` → `public.cron_http_post('<job>', `. Stessi URL, header, corpi e timeout.
- `app_log`: `cron-http:<job>` (error), `cron-http-timeout:<job>` (info), `cron-sql:<job>` (error), `cron-esiti:esiti-persi` (warn), `cron-esiti:fallito` (error), battito `cron:cron-esiti`.

### Fuori perimetro
Timeout, pianificazioni e route (sessione 8); `cron-esiti` sotto sorveglianza e `cron_ultimo_esito` nella salute (sessione 7).

### Dopo il merge
Migrazione in `schema_migrations`; primo battito `cron:cron-esiti` entro 15 minuti. La misura «dopo» a +24 h (D1-D8), le fotografie rigenerate, la voce tolta da `MIGRAZIONI_ATTESE_AL_MERGE` e la riga 6 a «in produzione» li fa la sessione che apre dopo, nel suo primo commit (sezione «Per la sessione dopo» del piano): nessuna PR di soli documenti.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Se `@ERRORI_6H@` è fra 1 e 6, aggiungi in cima, in grassetto: **«Dal primo giro del lettore, @ERRORI_6H@ errori ogni ~6 ore diventano righe `error` in `app_log` col nome del job: la salute li conterà.»** Se la misura 0.8 ha trovato esecuzioni fallite, aggiungi in grassetto l'elenco dei job.

```bash
gh pr create --base main --head robustezza2/s06-esiti-cron \
  --title "Robustezza2 s06: esiti dei cron, si osserva e non si cambia" \
  --body-file /tmp/kidville-s06-pr.md
gh pr view --json number --jq .number
```

Atteso: l'indirizzo della PR e il suo numero, che diventa `@PR@`.

- [ ] **Passo 4: numero della PR nel PRD e nella tabella di stato della specifica**

La riga della sessione si trova per contenuto, mai per numero:

```bash
grep -n '^| 6 |' docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola. Sostituiscila:

```markdown
| 6 | Esiti dei cron: si osserva, non si cambia | S1 (osservazione) | 2 | da fare | — | `s06-esiti-cron` | dà il «prima» alla 8 |
```

con (Stato **«in revisione»**, sempre queste parole; numero della PR; percorso del piano):

```markdown
| 6 | Esiti dei cron: si osserva, non si cambia | S1 (osservazione) | 2 | in revisione | #@PR@ | `docs/superpowers/plans/2026-10-20-robustezza2-s06-esiti-cron.md` | dà il «prima» alla 8 |
```

Mai «in produzione» su questa riga in questa PR: lo scrive la sessione che apre dopo, col commit di `main` (sezione «Per la sessione dopo»).

```bash
PR=$(gh pr view --json number --jq .number); GIORNO=$(date -u +%F)
sed -i '' -e "s/@PR@/${PR}/g" -e "s/@GIORNO@/${GIORNO}/g" "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git diff --cached --name-only | xargs grep -nE '@[A-Z_]+@'
git commit -m "$(cat <<'EOF'
Robustezza2 s06: numero della PR nel PRD e nella tabella di stato

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Passo 5: CI verde su TUTTI i job**

```bash
gh pr checks "$PR" --watch
```

Atteso: ogni job `pass` (`quality`, `e2e`, i job dei test e `DB migrate (CI)`). Un `cancelled` nel gruppo `e2e-ci-db` non è rosso: un'altra PR ha preso il posto in coda; si rilancia con `gh run rerun <id> --failed`, una PR alla volta. Un rosso vero si legge (`gh run view <id> --log-failed | tail -60`) e si corregge con un commit nuovo; un rosso di `DB migrate (CI)` su una funzione generata è uno STOP (parte «Migrazione»).

- [ ] **Passo 6: subito prima di chiedere il merge, le impronte di nuovo**

Si rifà 0.6b. Se un'impronta è cambiata, **non** si chiede il merge: si rifà 0.6 e il Compito 5 dal passo 3, poi CI di nuovo.

- [ ] **Passo 7: il merge lo fa il titolare**

È una regola della specifica decisa il 20/10 (§5): vale anche se `CLAUDE.md` descrive l'autonomia piena. Messaggio al titolare: numero e indirizzo della PR, CI verde su tutti i job, la migrazione che l'integrazione applicherà, le misure del Passo 0 (in grassetto gli errori del «prima»), l'esito di 0.6b. **Mai** `gh pr merge`, mai l'auto-merge: si aspetta.

- [ ] **Passo 8: deploy**

Dopo il merge, il deploy di produzione di Vercel col commit del merge deve risultare `Ready` (strumento MCP di Vercel o `vercel ls --prod`). Cambia solo `src/lib/health/controlli.ts` (un nome in più in una lista): nessuna route cambia comportamento.

- [ ] **Passo 9: `SELECT` di conferma della migrazione (data e ora UTC)**

```sql
SELECT (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '@VERSIONE@') AS righe_storico,
       to_regclass('public.cron_chiamate') IS NOT NULL AS chiamate,
       to_regclass('public.cron_ultimo_esito') IS NOT NULL AS ultimo_esito,
       to_regprocedure('public.cron_esiti()') IS NOT NULL AS lettore,
       (SELECT count(*) FROM cron.job WHERE jobname = 'cron-esiti' AND active) AS job,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc;
```

Atteso: `1`, `true`, `true`, `true`, `1`. `ora_utc` → `@ORA_VERIFICA@`. Se `righe_storico` è 0 dopo dieci minuti, l'integrazione non l'ha applicata: **non** la si applica a mano (§8, divieto 4), lo si dice al titolare con lo stato del controllo dell'integrazione sulla PR.

Entro 15 minuti, il primo battito:

```sql
SELECT occorrenze, visto_l_ultima, contesto->'campi' AS campi
  FROM app_log WHERE fingerprint = 'cron:cron-esiti'
 ORDER BY visto_l_ultima DESC LIMIT 1;
```

Atteso: una riga con `esito` `ok`, `primo_giro` `true` (dal secondo giro `false`), `net` e `cron` `true`. Se compare invece `cron-esiti:fallito`, si legge il suo `codice` (SQLSTATE) e si ferma il job (parte «Ritorno indietro», fermata subito) chiedendolo al titolare.

L'ora della verifica e quella del primo battito vanno in un commento della PR: la sessione dopo le riporta nella riga di stato (sezione «Per la sessione dopo»).

```bash
gh pr comment @PR@ --body "Migrazione applicata dall'integrazione, verificata alle @ORA_VERIFICA@ UTC; primo battito cron:cron-esiti con esito ok alle <ora UTC di visto_l_ultima>."
```

Atteso: l'URL del commento. Al posto di `<ora UTC di visto_l_ultima>` si scrive l'ora letta nella query qui sopra.

- [ ] **Passo 10: a +1 ora, nessuna chiamata persa per strada**

```sql
SELECT job, count(*) AS chiamate, count(*) FILTER (WHERE esito = 'in-attesa') AS in_attesa
  FROM public.cron_chiamate GROUP BY 1 ORDER BY 1;
SELECT count(*) AS registro_non_scritto FROM app_log WHERE fingerprint = 'cron-http:registro-non-scritto';
```

Atteso: i job HTTP che girano ogni 10 minuti o meno compaiono; `registro_non_scritto` = 0.

- [ ] **Passo 11: la misura «dopo» a +24 h — matura dopo questa sessione**

La misura «dopo» (D1-D8) matura 24 ore dopo il merge, quando questa sessione ha già pulito ramo e worktree: la scrive la sessione che apre dopo, nel suo primo commit, con le query della sezione «Per la sessione dopo» (§5: «in produzione», il commit di `main` e la misura «dopo» li scrive la sessione successiva). Se a +24 h chi esegue è ancora qui, può lanciarle e lasciarne i numeri, con giorno, ora UTC e finestra, in un commento della PR (`gh pr comment @PR@ --body-file /tmp/kidville-s06-dopo.md`): **non** li scrive né nella specifica né nel PRD.

- [ ] **Passo 12: pulizia del ramo e del worktree di questa sessione (`AGENTS.md`, punto 3)**

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s06
git -C /Users/lerri/kidville-web branch -D robustezza2/s06-esiti-cron
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s06-esiti-cron
git -C /Users/lerri/kidville-web branch -a | grep 's06'
```

Atteso: l'ultimo comando non stampa niente. Se il ramo remoto non c'è più (cancellato al merge), il terzo dice `remote ref does not exist`: va bene. I rami e i worktree di altre sessioni non si toccano. Dopo il rilascio **non** si apre nessun ramo di soli documenti (niente `robustezza2/s06-pr-b`): fotografie, voce attesa, riga di stato, PRD e misura «dopo» stanno nella sezione «Per la sessione dopo».

## Ritorno indietro

Tre livelli, dal più leggero. Ogni istruzione che scrive in produzione **si mostra al titolare e la esegue lui** dall'editor SQL: mostrare non è chiedere, e il freno della sessione 2 non è un permesso.

- **Fermare il lettore, subito.**

  ```sql
  SELECT cron.unschedule('cron-esiti');
  ```

  Smette di leggere e di scrivere in `app_log`. L'involucro resta: le funzioni dei cron continuano a chiamare il server **come prima** e a registrare le chiamate in `cron_chiamate`, che senza la pulizia cresce di quante chiamate fanno i job in un giorno (la somma di D1). Si riaccende con il `DO` finale della migrazione (il blocco `-- == IL JOB ==`), mostrato al titolare.

- **Codice dell'app.** Cambia solo `src/lib/health/controlli.ts` (un nome in una lista): Instant Rollback di Vercel se serve, poi una PR di revert. Nessun effetto sui dati.

- **Tutto, su richiesta del titolare.** Una PR di revert dal ramo `revert/s06-esiti-cron` (fuori dal prefisso `robustezza2/`, §5: le sessioni dopo cercano le PR con `head:robustezza2/` e la chiusura della precedente cerca un piano con quel nome) che:
  1. **tiene** il file `@VERSIONE@_cron_esiti_osservati.sql` (è applicato: toglierlo fa diventare rosso `migrazioni-complete`);
  2. aggiunge una migrazione **nuova**, con version da `date -u +%Y%m%d%H%M%S`, generata così:

     ```bash
     V=$(date -u +%Y%m%d%H%M%S)
     node scripts/cron-esiti/involucro.mjs inversa supabase/migrations/@VERSIONE@_cron_esiti_osservati.sql \
       > "supabase/migrations/${V}_cron_esiti_ritorno.sql"
     ```

     Rimette le definizioni di prima (le stesse della produzione al momento della misura 0.6), coi loro `REVOKE`/`GRANT`; spegne `cron-esiti`; toglie le due funzioni e, col marcatore `-- distruttiva approvata:` già scritto, le due tabelle. Il test PGlite «la migrazione inversa rimette ogni funzione com'era» l'ha provata;
  3. mette la migrazione nuova in `MIGRAZIONI_ATTESE_AL_MERGE` (un `DROP TABLE` è una modifica della RLS per `toccaLaRls`);
  4. rimette il lock `cron-http-esito-osservato` com'era prima della sessione (`git show <commit del merge>^:__tests__/architecture/cron-http-esito-osservato.test.ts`), e aggiorna la ragione della voce `cron-esiti` in `JOB_CRON_NON_SORVEGLIATI` («SPENTO dal ritorno indietro del <giorno>»): il vecchio file installa ancora il job, e `cron-sorvegliato-e-applicato` continua a pretendere il nome;
  5. va in produzione come ogni altra: CI verde, **merge del titolare**, migrazione applicata dall'integrazione; le fotografie le rigenera la sessione che apre dopo, nella sua chiusura della precedente.

  Riapre S1 (osservazione). `__tests__/db/cron-esiti.test.ts` e il modulo restano: provano un file che esiste ancora.

## Per la sessione dopo

Questa sezione la esegue la sessione che apre dopo il merge di questa, nel suo primo commit (§5, «la chiusura della precedente»): chi la esegue non ha letto il resto del piano, e qui trova tutto. Tutte le query sono **in sola lettura** (`execute_sql`); in produzione non si scrive niente.

- [ ] **1. I dati di questa sessione**

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s06-esiti-cron" --json number,mergedAt,mergeCommit --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid)"'
git ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep '_cron_esiti_osservati\.sql$'
```

Atteso: una riga `<PR6> <istante del merge> <sha>` e un nome di file. `<V6>` sono le prime 14 cifre del nome; `<SHA6>` le prime 8 cifre dello sha; `<MERGE6>` l'istante del merge (UTC). L'ora in cui la migrazione è stata verificata e quella del primo battito stanno nel commento della PR (Rilascio, passo 9):

```bash
gh pr view <PR6> --repo erricoluigi17/kidville-web --json comments --jq '.comments[].body' | grep 'verificata alle'
```

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version = '<V6>';
```

Atteso: una riga. Se manca, ci si **ferma** e lo si dice al titolare: una migrazione non si applica a mano (§8, divieto 4).

- [ ] **2. Le fotografie: tre, dalla produzione**

La migrazione crea due tabelle con PRIMARY KEY (`cron_chiamate`, `cron_ultimo_esito`), con RLS accesa e senza policy, e due funzioni nuove. Non crea chiavi esterne, colonne `scuola_id`, bucket: le altre fotografie non cambiano.

a. Migrazioni (la chiusura la rigenera comunque; qui per intero):

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
# la query stampata si esegue in produzione con execute_sql (sola lettura); la risposta JSON in /tmp/kidville-chiusura-s06-migrazioni.json
node __tests__/fixtures/migrazioni-fotografia.mjs < /tmp/kidville-chiusura-s06-migrazioni.json
npx vitest run __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -5
```

Atteso: `<V6>_cron_esiti_osservati.sql` fra le version della fotografia; `Test Files  1 passed`.

b. Indici unici (le due PRIMARY KEY nuove):

```bash
node __tests__/fixtures/indici-unici-fotografia.mjs --sql
# la query (solo catalogo di sistema) in produzione con execute_sql; la risposta in /tmp/kidville-chiusura-s06-indici.json
node __tests__/fixtures/indici-unici-fotografia.mjs < /tmp/kidville-chiusura-s06-indici.json
npx vitest run __tests__/architecture/onconflict-arbitro.test.ts 2>&1 | tail -5
```

Atteso: `cron_chiamate_pkey` e `cron_ultimo_esito_pkey` nella fotografia; `Test Files  1 passed`.

c. Policy e tabelle con RLS (le due tabelle nuove, RLS accesa senza policy):

```bash
node scripts/rls-fotografia.mjs --sql
# la query in produzione con execute_sql; la risposta in /tmp/kidville-chiusura-s06-rls.json
node scripts/rls-fotografia.mjs < /tmp/kidville-chiusura-s06-rls.json
npx vitest run __tests__/architecture/rls-per-sede.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed`. Se un'altra guardia di fotografia è rossa (`tracce-docente-dichiarate`, `fk-scuola-id`, …), la si rigenera col generatore che il suo messaggio d'errore nomina, sempre dalla produzione.

- [ ] **3. La voce attesa al merge**

```bash
grep -n "'.*_cron_esiti_osservati.sql':" __tests__/architecture/soglia-fotografia.ts
```

Atteso: una riga, dentro `export const MIGRAZIONI_ATTESE_AL_MERGE`. Si toglie la voce `'<V6>_cron_esiti_osservati.sql'` (chiave e testo, fino alla sua virgola); se era l'unica, la costante torna `= {}`. Il commento datato che la precede (`// Sessione 6 della seconda serie (…)`) resta, e sotto gli si aggiunge, come hanno fatto le fasi del 19/10:

```ts
// SVUOTATA il <giorno> (chiusura nel primo commit della sessione seguente, dopo il merge di #<PR6>,
// `<SHA6>`): applicata dall'integrazione, una riga nel registro; fotografie rigenerate dalla
// produzione — migrazioni, indici unici (due PRIMARY KEY nuove) e policy (due tabelle con RLS).
```

```bash
npx vitest run __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed` (la prova «nessuna voce morta» è verde perché le fotografie sono già rigenerate).

- [ ] **4. La misura «dopo» — matura da `<MERGE6>` + 24 h**

Se a quell'istante non sono ancora passate 24 ore dal merge, la misura **non** si scrive: la scrive la prima PR che tocca la specifica dopo quel momento (§5), con queste stesse query. Quando è matura:

```sql
-- D1: per job, nelle ultime 24 h
SELECT job, count(*) AS chiamate,
       count(*) FILTER (WHERE esito = 'ok') AS ok,
       count(*) FILTER (WHERE esito = 'timeout') AS timeout,
       count(*) FILTER (WHERE esito IN ('errore-http', 'errore-rete')) AS errori,
       count(*) FILTER (WHERE esito = 'esito-ignoto') AS ignote,
       count(*) FILTER (WHERE esito = 'in-attesa') AS in_attesa
  FROM public.cron_chiamate WHERE inviata_il > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1;

-- D2: risposte delle ultime 6 h che nessuna riga di cron_chiamate spiega
SELECT count(*) AS orfane
  FROM net._http_response AS r
 WHERE r.created > now() - interval '6 hours'
   AND NOT EXISTS (SELECT 1 FROM public.cron_chiamate AS c
                    WHERE c.richiesta_id = r.id AND r.created >= c.inviata_il - interval '1 minute');

-- D3: il «prima» della sessione 8
SELECT count(*) FILTER (WHERE esito = 'timeout') AS timeout_24h,
       count(*) FILTER (WHERE percorso = '/api/admin/storici/cron') AS storici_24h
  FROM public.cron_chiamate WHERE inviata_il > now() - interval '24 hours';

-- D4: una riga per job
SELECT (SELECT count(*) FROM public.cron_ultimo_esito) AS righe,
       (SELECT count(*) FROM public.cron_ultimo_esito WHERE attivo) AS attive,
       (SELECT count(*) FROM public.cron_ultimo_esito WHERE http) AS http,
       (SELECT count(*) FROM cron.job) AS job;

-- D5: le righe della sessione in app_log
SELECT fingerprint, livello, codice, occorrenze
  FROM app_log
 WHERE visto_l_ultima > now() - interval '24 hours'
   AND (fingerprint LIKE 'cron-http%' OR fingerprint LIKE 'cron-sql:%'
        OR fingerprint LIKE 'cron-esiti:%' OR fingerprint = 'cron:cron-esiti')
 ORDER BY livello, fingerprint;

-- D6: il lettore stesso
SELECT d.status, count(*) AS esecuzioni
  FROM cron.job_run_details AS d JOIN cron.job AS j ON j.jobid = d.jobid
 WHERE j.jobname = 'cron-esiti' AND d.start_time > now() - interval '24 hours'
 GROUP BY 1;

-- D7: la tabella che la sessione 8 pota
SELECT count(*) AS righe FROM cron.job_run_details;

-- D8: le impronte della produzione (si confrontano col repo, sotto)
SELECT p.proname || chr(9) || md5(p.prosrc) AS riga
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND p.prosrc ~* '(net\s*\.\s*http_post|cron_http_post)'
 ORDER BY 1;
```

Le righe di D8 si salvano, una per riga, in `/tmp/kidville-chiusura-s06-impronte-prod.txt`; poi, sull'albero di `main`:

```bash
node scripts/cron-esiti/involucro.mjs impronte > /tmp/kidville-chiusura-s06-impronte-repo.txt
diff <(LC_ALL=C sort /tmp/kidville-chiusura-s06-impronte-prod.txt) <(LC_ALL=C sort /tmp/kidville-chiusura-s06-impronte-repo.txt) && echo UGUALI
```

Atteso:
- **D1** copre ogni job HTTP attivo (la «Prova» della specifica: «`cron_chiamate` copre tutti i job e attribuisce i timeout a un job per nome»); `in_attesa` solo per chiamate degli ultimi minuti;
- **D2** = 0: ogni funzione di `public` che chiama `pg_net` passa dall'involucro. Se non è 0, le orfane possono venire solo da chiamate fuori dall'involucro; si contano le funzioni fuori da `public` e i webhook, che sono il massimo atteso:

  ```sql
  SELECT n.nspname AS schema, count(*) AS funzioni
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosrc ~* 'net\s*\.\s*http_(post|get|delete)\s*\(' AND n.nspname NOT IN ('net', 'public')
   GROUP BY 1 ORDER BY 1;
  SELECT count(*) AS webhook
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'supabase_functions' AND NOT t.tgisinternal;
  ```

  Più orfane di quante ne spieghino queste due query è un difetto da scrivere al titolare;
- **D3**: i due numeri vanno nella riga 6 e nel PRD (la specifica stima ~108 timeout e ~1.440 chiamate al giorno);
- **D4**: `righe` = `job` (con `cron-esiti`): è la «Prova» della specifica, che il 20/10 diceva 30 righe;
- **D5**: il battito con circa 144 occorrenze al giorno; nessun `cron-esiti:fallito`;
- **D6**: solo `succeeded`, circa 144;
- **D8**: `UGUALI`. Una differenza su una funzione **non** ridefinita (`genera_solleciti`, le `ASSENTI_IN_PRODUZIONE`) si annota e basta; su una ridefinita è un difetto: lo si scrive al titolare e si apre una voce nel PRD.

Solo conteggi, nomi di job, codici: nessuna riga di dati personali.

- [ ] **5. La riga 6 della tabella di stato**

```bash
grep -n "^| 6 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga con Stato `in revisione`. Diventa (PR e Piano restano):

```markdown
| 6 | Esiti dei cron: si osserva, non si cambia | S1 (osservazione) | 2 | ✅ in produzione dal <giorno di MERGE6> (commit `<SHA6>`) | #<PR6> | `docs/superpowers/plans/2026-10-20-robustezza2-s06-esiti-cron.md` | dà il «prima» alla 8: <timeout_24h> timeout e <storici_24h> chiamate a `/api/admin/storici/cron` in 24 h (misura del <giorno> <ora> UTC) |
```

Se la misura del punto 4 non è matura, la Nota dice `dà il «prima» alla 8 — misura «dopo» matura dal <MERGE6 + 24 h> UTC`, e i numeri li scrive la prima PR che tocca la specifica dopo quell'istante.

- [ ] **6. Lo Stato nel PRD**

```bash
grep -n "sessione 6: esiti dei cron" "PRD REGISTRO ELETTRONICO.md"
```

Nella voce trovata, la riga che comincia con `**Stato:** 🟨 in revisione` diventa:

```markdown
**Stato:** ✅ in produzione dal <giorno di MERGE6> (commit `<SHA6>`, PR #<PR6>, merge a mano del titolare). Migrazione `<V6>_cron_esiti_osservati.sql` applicata dall'integrazione, verificata alle <ora del commento della PR> UTC. Misura «dopo» (<giorno> <ora> UTC, 24 h): <job con chiamate in D1> job HTTP con chiamate registrate, <timeout_24h> timeout, <storici_24h> chiamate a `/api/admin/storici/cron`, <righe di D4> righe in `cron_ultimo_esito` per <job di D4> job, <orfane di D2> risposte orfane, impronte <UGUALI o i nomi diversi>. Domande d'iscrizione contate prima della migrazione: **<numero della riga di prima>** alle <ora della riga di prima> UTC.
```

L'ultima frase ricopia numero e ora già scritti nella riga di prima: quel conteggio è della sessione 6 e non si rifà. Se la misura non è matura, al posto della frase «Misura «dopo» …» si scrive `Misura «dopo» matura dal <MERGE6 + 24 h> UTC.`

- [ ] **7. Quello che la sessione 7 legge: fatti da verificare in produzione**

La sessione 7 («la salute vede tutto») costruisce il controllo `cron-esiti` di `/api/health` sopra le tabelle di questa. Chi chiude, qualunque numero abbia, verifica che i fatti siano veri **oggi** e scrive nel suo commit «fatti della sessione 6 verificati il <giorno>»; se uno non torna, lo scrive nel PRD della propria sessione e lo dice al titolare prima di proseguire.

```sql
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'cron_ultimo_esito'
 ORDER BY ordinal_position;

SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'cron-esiti';

SELECT ultima_chiamata_esito, count(*) FROM public.cron_ultimo_esito GROUP BY 1 ORDER BY 1;
SELECT ultima_esecuzione_stato, count(*) FROM public.cron_ultimo_esito GROUP BY 1 ORDER BY 1;

SELECT livello, evento, occorrenze,
       to_char(visto_l_ultima AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS ultimo_utc,
       contesto->'campi'->>'operazione' AS operazione,
       contesto->'campi'->>'esito' AS esito
  FROM app_log WHERE fingerprint = 'cron:cron-esiti'
 ORDER BY visto_l_ultima DESC LIMIT 1;

SELECT has_table_privilege('anon', 'public.cron_ultimo_esito', 'SELECT') AS anon,
       has_table_privilege('authenticated', 'public.cron_ultimo_esito', 'SELECT') AS authenticated,
       has_table_privilege('service_role', 'public.cron_ultimo_esito', 'SELECT') AS service_role;
```

Atteso, ed è il contratto su cui la sessione 7 scrive la sua RPC `salute_cron_esiti()`:
- **colonne di `cron_ultimo_esito`**, in quest'ordine: `job text` (chiave), `attivo boolean`, `pianificazione text`, `http boolean`, `ultimo_runid bigint`, `ultima_esecuzione_il timestamptz`, `ultima_esecuzione_stato text`, `ultima_chiamata_il timestamptz`, `ultima_chiamata_esito text`, `ultimo_codice_http integer`, `ultimo_ok_il timestamptz`, `ultimo_errore_il timestamptz`, `aggiornato_il timestamptz`;
- **`job`** è `coalesce(jobname, 'jobid-' || jobid)` di `cron.job`: una riga per job, anche spento (`attivo = false`);
- **`http`** diventa `true` al primo giro in cui il job ha una chiamata chiusa in `cron_chiamate`, e non torna mai `false`;
- **`ultima_chiamata_esito`** vale `ok`, `errore-http` (codice HTTP ≥ 400), `errore-rete`, `timeout` o `esito-ignoto`; si aggiorna solo da chiamate chiuse, quindi mai `in-attesa`; `ultima_chiamata_il` è l'istante d'invio di quella chiamata;
- **`ultima_esecuzione_stato`** e **`ultima_esecuzione_il`** vengono dall'ultima esecuzione `succeeded` o `failed` di `cron.job_run_details`, **anche per i job HTTP** (è la funzione SQL che ha chiamato il server);
- **`ultimo_ok_il`**: per un job HTTP è l'invio dell'ultima chiamata `ok`, e cambia **solo** quando il job chiama il server; per un job di sola SQL è l'ultima esecuzione `succeeded`;
- **job `cron-esiti`**: uno, `4,14,24,34,44,54 * * * *`, attivo;
- **battito** `cron:cron-esiti` in `app_log`: `livello` `info`, `evento` `cron`, `campi.operazione` `cron-esiti`, `campi.esito` `ok`, `ultimo_utc` a meno di 15 minuti da adesso; nei `campi` ci sono anche `chiuse`, `ignote`, `esecuzioni`, `fallite`, `cancellate`, `primo_giro`, `net`, `cron`;
- **permessi**: `false`, `false`, `true`.

La voce `cron-esiti` in `JOB_CRON_NON_SORVEGLIATI` (`src/lib/health/controlli.ts`, si trova con `grep -n "nome: 'cron-esiti'"`) **non** si tocca in questa chiusura: la sposta la sessione 7 nel suo compito sul controllo `cron-esiti`, dopo aver visto il primo battito. Se chi chiude non è la sessione 7, la voce resta dov'è.

## Autorevisione

Riletta contro la §7 (Sessione 6), la §5, la §6 e la §8 della specifica.

| Richiesta della specifica | Dove |
|---|---|
| Obiettivo: l'esito vero di ogni job, HTTP o SQL, a comportamento invariato | Compito 4 (`cron_ultimo_esito` da `cron.job_run_details`, `cron_chiamate` dall'involucro); Compito 5 (tutte le funzioni che chiamano il server); equivalenza prima/dopo nel test PGlite |
| Misura prima: `net._http_response` delle ultime ~6 h con `timed_out` o `status_code >= 400` | Passo 0.7 (conta anche gli errori di rete, a parte) |
| Misura prima: l'elenco delle funzioni che chiamano `net.http_post`, da `pg_proc` | Passo 0.6 (con `pg_get_functiondef`, impronta, job, permessi) e 0.6b |
| Due tabelle `cron_chiamate` e `cron_ultimo_esito` | Compito 4, passo 3 |
| Involucro che conserva il numero della richiesta | Compito 4 (`cron_http_post`), con la firma della misura 0.3 |
| Le funzioni passano dall'involucro con lo stesso timeout, dai corpi di `pg_get_functiondef` | Compiti 2, 3 e 5: il modulo cambia solo la chiamata; il timeout resta quello di ciascuna |
| Job `cron-esiti` ogni 10 minuti su `net._http_response` e `cron.job_run_details`; `error` `cron-http:<job>`, `info` per i timeout | Compito 4 (lettore e job), parte «Log» |
| Rischio: un corpo copiato dal repo invece che dalla produzione | Compito 2 (fonte = produzione, impronta md5), Compito 3 (regola scritta per i `diverso`), Rilascio passi 2 e 6 (0.6b), misura D8 |
| Indietro: migrazione inversa e `cron-esiti` spento | «Ritorno indietro»; `inversa` provata su PGlite (Compito 5) |
| Prova: dopo 24 h `cron_chiamate` copre tutti i job e attribuisce i timeout per nome; `cron_ultimo_esito` ha una riga per job | «Per la sessione dopo», punto 4 (D1, D3, D4), matura da merge + 24 h |
| Note: wrapper e lettore SECURITY DEFINER, `search_path` fisso, `REVOKE`, nessun argomento `sql text` | Compito 4, test «involucro e lettore: SECURITY DEFINER…» e firma; lock `niente-sql-arbitrario` |
| Note: il lettore copre anche i job solo SQL; `net._http_response` vive ~6 h, un giro ogni 10' non perde niente | Compito 4 (passi 4 e 6 del lettore), Passo 0.2 con soglia |
| Note: se `cron-esiti` si guasta lascia una traccia | Compito 4, test «se si guasta lascia `cron-esiti:fallito`…» |
| Note: impronte stabili; PGlite con `net` e `cron` finti; guardie `to_regclass`/`to_regnamespace` | Compito 4 (test e lettore), parte «Log» |
| §5: prerequisiti (PR della 2 mergiata, sue migrazioni applicate, nessuna PR aperta); chiusura della precedente nel primo commit; conteggio delle iscrizioni; migrazione dall'integrazione; version da `date -u`; ROLLBACK nell'intestazione; gettoni; merge del titolare; riga di stato «in revisione» per contenuto; niente ramo di soli documenti | Compito 1 passi 1 e 4; 0.1; «Migrazione»; Compito 4 passo 3; «Convenzioni»; Rilascio passi 4, 7 e 12; «Per la sessione dopo» |
| §6: formato (intestazione, mappa, sei parti fisse, compiti con caselle, «Apertura e chiusura», «Per la sessione dopo») | tutto il documento; Compito 1; sezione «Per la sessione dopo» |
| §8: divieti 4 (niente migrazioni a mano), 8 (`pg_net` resta in `public`), 11 (`cron.job_run_details` non si svuota, i timeout non si allungano) | «Migrazione», «Fuori perimetro», il lettore solo legge `cron.job_run_details` |

**Aggiunte dichiarate, non chieste dalla specifica:**
- righe `error` `cron-sql:<job>` per le esecuzioni fallite dei job (la specifica chiede di leggere `cron.job_run_details`, non dice cosa scrivere): dal secondo giro del lettore in poi, anche per un job che il lettore non aveva mai visto (un mensile); quelle trovate al primo giro in assoluto sono storia di prima dell'installazione e non si scrivono. Il battito porta `primo_giro`;
- la `warn` `cron-esiti:esiti-persi` per le chiamate senza risposta dopo la vita delle risposte;
- `cron_chiamate` tenuta 14 giorni (la specifica non dà un termine);
- nessun corpo di risposta conservato, solo il codice in maiuscolo;
- l'etichetta delle funzioni senza job (per esempio `video_runner_kick`, chiamata da una route) è il nome della funzione coi trattini.

**Dove il piano si scosta dalla specifica, e perché** (da confermare col titolare):
- «le 16 funzioni (15 nel repo, una solo in produzione)»: nel repo, al 20/10, le funzioni che chiamano `net.http_post` nella loro ultima definizione sono **20** (`FUNZIONI_HTTP_AL_20_10`), comprese `genera_solleciti` (deprecata, esclusa) e `video_runner_kick` (nessun job). Il piano ridefinisce quelle che la misura 0.6 trova in produzione, quante che siano fra 16 e 24, e si ferma fuori da quell'intervallo;
- «con lo stesso timeout di oggi (5000 ms)»: nel repo quattro funzioni hanno un timeout esplicito diverso (`iscrizioni_retention_http` 120000; `fatture_sdi_sync_tick`, `fatture_coda_tick_http`, `storici_tick` 300000). Il piano tiene il timeout **di ciascuna**: forzarle tutte a 5000 cambierebbe il comportamento;
- `cron_http_post(job, percorso, timeout)`: la firma è `(job, url, body, params, headers, timeout_milliseconds)`, perché le funzioni leggono l'URL intero dal Vault e mandano header e corpi diversi; con questa firma la sostituzione è una parola sola e i default sono quelli di `net.http_post`. Il percorso si ricava dall'URL e si registra;
- «`cron_ultimo_esito` ha 30 righe»: ha una riga per job di `cron.job`, quindi `@N_JOB@` + 1 con `cron-esiti` (32 se `cron.job` è quello del 20/10 con 31 job; la misura D4 confronta col conteggio vero);
- l'evento in `app_log` è `cron`, non un evento nuovo: il vocabolario di `EVENTI_NOTI` è chiuso.

**Segnaposto:** nessuno; i soli valori assenti sono i gettoni fra chiocciole della tabella «Convenzioni», ciascuno con la misura che lo riempie, e il controllo `grep -nE '@[A-Z_]+@'` prima di ogni commit.

**Nomi coerenti:** `cron_http_post`, `cron_esiti`, `cron_chiamate`, `cron_ultimo_esito`, job `cron-esiti`; esiti `in-attesa`, `ok`, `errore-http`, `errore-rete`, `timeout`, `esito-ignoto`; impronte `cron-http:<job>`, `cron-http-timeout:<job>`, `cron-sql:<job>`, `cron-esiti:esiti-persi`, `cron-esiti:fallito`, `cron-http:registro-non-scritto`, `cron:cron-esiti`; funzioni del modulo `mascheraSql`, `normalizza`, `corpoDi`, `corpoOVuoto`, `contaChiamate`, `avvolgi`, `svolgi`, `etichetta`, `sospetti`, `leggiRighe`, `genera`, `ultimeDefinizioniDa`, `ultimeDefinizioni`, `confronta`, `impronteDelRepo`, `inversa`, `minimoAvvolte` — gli stessi nomi nel modulo (Compito 2), nei test (Compiti 2, 4, 5) e nel lock (Compito 5).
