# Sessione 7 — La salute vede tutto, senza falsi «giù» — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** `/api/health` sorveglia ogni job di `pg_cron`, lo Storage, le email, le push e l'allineamento delle migrazioni, e non risponde più `503` per lentezza: ogni controllo nuovo arriva al più a `degradato`, e `schema-atteso` lento diventa `degradato`. **Eccezione voluta dalla specifica:** `db-lettura` e `auth` restano `giu` anche oltre il tetto di 2 s, perché sono i due controlli di `eseguiVivo`, cioè di `/api/health/vivo`, che risponde 200 su `degradato`: se il loro timeout scendesse a `degradato`, un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe più.

**Architettura:** cinque controlli nuovi (`cron-esiti`, `storage`, `email`, `push`, `migrazioni`) entrano in `eseguiSalute` accanto a quelli di oggi. La decisione «sì o no» sta in moduli puri senza I/O (`valutazione.ts`, `cron-esiti.ts`, `fornitori.ts`, `migrazioni.ts`), provati con numeri letterali; i controlli in `controlli.ts` fanno solo la lettura. Due RPC di sola lettura (`salute_cron_esiti`, `salute_migrazioni`) portano a PostgREST nomi, cadenze, esiti e date dei job (dalla tabella `cron_ultimo_esito` della sessione 6) e la versione più alta di `supabase_migrations`; la versione del repo la fissa `next.config.ts` alla build. Lo schema si legge in parallelo con una `GET`, il tetto per IP torna in memoria e un lock vieta ai controlli nuovi di dire `giu`.

**Tecnologie:** Next.js 16 (route handler Node, chiave `env` di `next.config.ts`) · TypeScript · `@supabase/supabase-js` (PostgREST, Storage) · SQL Postgres/plpgsql · Vitest con il finto client `__tests__/fixtures/finto-supabase.ts` e PGlite (`@electric-sql/pglite`) · `gh`.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 7» (righe 523-565 del 20/10; si trova con `grep -n '^### Sessione 7'`). Valgono le regole comuni della §5 (`## 5. Regole comuni`, riga 133), le misure di controllo della §5 (`### Misure di controllo`, righe 199-208), il formato della §6 (riga 212, con «Apertura e chiusura» e la sezione «Per la sessione dopo») e i divieti della §8 (riga 808). La riga di questa sessione nella tabella di stato si trova con `grep -n '^| 7 |'` (il 20/10 era la 31).

---

## Convenzioni di questo piano

Alcuni valori esistono solo il giorno in cui si esegue. Nel piano compaiono fra graffe, e chi esegue li sostituisce col valore vero **nel momento in cui scrive quel testo**:

| Gettone | Valore | Da dove viene |
|---|---|---|
| `{OGGI}` | data UTC, forma `AAAA-MM-GG` | `date -u +%F` il giorno in cui si scrive il testo |
| `{VERSIONE}` | le 14 cifre della migrazione | `date -u +%Y%m%d%H%M%S` al Compito 6, Passo 3 (mai un orario tondo, mai nel futuro) |
| `{N_ISCRIZIONI}`, `{ORA_CONTEGGIO}` | conteggio e ora UTC | Passo 0.1, rifatto il giorno della PR |
| `{N_JOB_ATTIVI}` | job attivi in `cron.job` | Passo 0.2 |
| `{ORA_PRIMA}`, `{P50_PRIMA}`, `{P95_PRIMA}` | ora UTC e millisecondi | Passo 0.4 |
| `{NOMI_AGGIUNTI}` | le variabili che entrano in `config` | Passo 0.5 |
| `{SOGLIA_RIFIUTI}` | soglia dei rifiuti per fornitore (3 salvo misura) | Passo 0.6 |
| `{PR}`, `{SHA_MERGE}` | numero della PR e commit di merge | «Rilascio», R3 e R6 |
| `{ORA_DOPO}`, `{P50_DOPO}`, `{P95_DOPO}` | ora UTC e millisecondi | «Rilascio», R8 |
| `{DATA_7G}` | giorno del deploy + 7 | «Rilascio», R11 (giorno del deploy di R7) |

Le misure si annotano man mano in `${TMPDIR:-/tmp}/kidville-s07/misure.txt`, fuori dal repo, con data e ora UTC (`date -u '+%F %T'`): solo numeri, codici HTTP, codici d'errore, nomi di job, di tabelle, di bucket e di variabili. Dopo il rilascio si copiano in un commento della PR (R9 e R10 del «Rilascio»), che resta.

Prima di ogni commit:

```bash
git diff --cached --name-only | xargs grep -nE '\{(OGGI|VERSIONE|N_ISCRIZIONI|ORA_[A-Z]+|N_JOB_ATTIVI|P(50|95)_[A-Z]+|NOMI_AGGIUNTI|SOGLIA_RIFIUTI|PR|SHA_MERGE|DATA_7G)\}'
```

Atteso: **nessuna riga**. Un gettone rimasto in un file committato è un difetto.

**Dati di minori, repository pubblico.** Nessuna query di questo piano legge righe con dati personali: si contano. Da `tetto_frequenza` (le chiavi contengono un IP) si legge **solo** un conteggio; da `app_log` livelli, codici HTTP, occorrenze e date; da `storage.objects` conteggi e somme per bucket, mai un nome di file.

---

## Scelte e scostamenti dalla specifica (letti nel codice il 20/10, commit `4c6df438`)

1. **«`JOB_CRON` assorbe quasi tutto `JOB_CRON_NON_SORVEGLIATI`».** Alla lettera non si può per i mensili: `controlloBattitoCron` legge il battito in `app_log`, che conserva 30 giorni, e il commento di `src/lib/health/controlli.ts:389-396` ha misurato 25 ore al mese di allarme falso su un lavoro sano. Quindi: i mensili e i lavori di sola SQL li sorveglia il controllo nuovo `cron-esiti`, che legge `cron_ultimo_esito` (una riga per job che non scade); in `JOB_CRON` entrano solo i due job con un battito in `app_log` e una cadenza sorvegliabile, `fascicolo-audit-ip-retention` (26 h) e `cron-esiti` della sessione 6 (40 min), ciascuno solo dopo il suo primo battito `ok` (Passo 0.7, la regola già scritta). `JOB_CRON_NON_SORVEGLIATI` resta, con le ragioni riscritte.
2. **`schema-atteso`** (righe 677-702): da un ciclo in serie con `select('id', { head: true, count: 'exact' })` a `Promise.all` con una `GET … ?select=id&limit=1`, senza conteggio. Leggendo il codice è emerso un punto cieco che la specifica non dice: con la postgrest-js del repo (2.112 il 20/10) una `HEAD` che risponde 404 **senza corpo** esce come `status 204` senza `error`, perché non c'è un corpo da cui leggere `PGRST205`. Il controllo di oggi non vedrebbe la tabella assente per cui esiste. Lo prova il test del Compito 3, con un client vero di supabase-js e un `fetch` finto. In più, su tetto di tempo o eccezione `schema-atteso` dirà `degradato` invece di `giu`; una tabella **assente** o **illeggibile** resta `giu`.
3. **`storage`:** una `list` con limite 1 su un prefisso che non esiste (`salute-sonda-inesistente`) del bucket privato `fatture`. Prova che l'API dello Storage risponde, che arriva al suo database e che il bucket c'è; non restituisce il nome di nessun file. Bucket confermato al Passo 0.8.
4. **`email` e `push`** leggono `app_log` (eventi `email` e `push`, `contesto->campi->>provider`) e non chiamano mai Resend, FCM o i servizi push. Regola: `degradato` se nelle ultime 24 h i rifiuti sono almeno `{SOGLIA_RIFIUTI}` (3 salvo misura) **e** più degli invii riusciti; nessun invio è `ok` (una domenica non è un guasto). Riuscito = riga `info` con stato 2xx che non sia il gettone OAuth di FCM (`operazione: oauth-token`, `src/lib/push/native-push.ts`: un gettone ottenuto non consegna niente, e fino a 24 righe riuscite al giorno coprirebbero 20 push respinte); rifiuto = riga `error`, gettone compreso. Non contano le righe `warn` (rifiuto transitorio che FCM ritenta, esito illeggibile: `src/lib/push/native-push.ts`, `gravita`) né le `info` non 2xx (token di un'app disinstallata, abbonamento web scaduto 404/410). Le `occorrenze` di `app_log` sono **per giorno** (chiave `(fingerprint, giorno)`, `supabase/migrations/20260713090000_app_log.sql:28-42`): una riga vista nelle ultime 24 h porta il conteggio del suo giorno intero, quindi la finestra vera va da 24 a 48 h, uguale per riusciti e rifiuti.
5. **«`push` (configurazione + battito)».** Configurazione = i due canali con le stesse condizioni di `fcmConfigured()` (`src/lib/push/native-push.ts`) e `vapidConfigured()` (`src/lib/push/web-push.ts`). Il battito del dispatcher è già `push-dispatch` dentro `cron-battito` (finestra 20 min): non si duplica. Un canale non configurato lo dice `config` (se le sue variabili entrano in `VARIABILI_CRITICHE`, Passo 0.5); `push` scrive «non configurato (vedi config)» e resta `ok`, così la stessa assenza non apre due segnalazioni.
6. **`migrazioni`** e il momento del merge. La migrazione di questa sessione e il deploy partono insieme, e il DB della CI non è migrato (§5). (a) Per qualche minuto le RPC nuove rispondono `PGRST202`: `ok` («non ancora installata») fino a 30 minuti dopo l'istante della build (`KV_BUILD_IL`), poi `degradato`. (b) A ogni rilascio futuro con una migrazione il repo è avanti sul database: `ok` («in attesa dell'integrazione») per 30 minuti, poi `degradato`. (c) Database avanti sul repo (deploy in corso, Instant Rollback): `ok`. Limite dichiarato: una migrazione applicata due volte a mano lascia due righe in `schema_migrations` (lezione già pagata) e maschera il conteggio; la versione più alta vede comunque un file nuovo non applicato. I 30 minuti sono una scelta, non una misura: tre giri di `cron-esiti` e margine per l'integrazione.
7. **`config`** guarda anche `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_APP_URL`, `ANTHROPIC_API_KEY`, **ognuna solo se** il Passo 0.5 la trova in Production e in Preview (una variabile assente per scelta accenderebbe un allarme permanente). Restano fuori, con la ragione: `NEXT_PUBLIC_SUPABASE_ANON_KEY` (se manca l'app esplode al primo clic: `src/instrumentation.ts:21-22`), `OTP_TICKET_SECRET` (ripiega su `SUPABASE_SERVICE_ROLE_KEY`: `src/lib/auth/otp-ticket.ts:21`, `src/lib/allegati/sigillo.ts:59`), `VAPID_SUBJECT` (ha un ripiego scritto: `src/lib/push/web-push.ts:50`), `ARUBA_USERNAME` (ripiego in banca dati, già scritto), `SIDI_*` (integrazione che la salute non sorveglia: decisione del titolare), `ALLOW_HEADER_IDENTITY`, `PARENT_READS_USE_SESSION`, `KV_LOG_LEVEL`, `NEXT_PUBLIC_CARICAMENTI_NATIVI` (interruttori, non configurazione).
8. **Il tetto per IP in memoria** (`src/lib/health/porta.ts:79`): `rateLimit` diventa `rateLimitLocale`, un export nuovo di `src/lib/security/rate-limit.ts` che usa lo stesso ramo `consumaLocale` già usato come ripiego. Cosa si perde: su Vercel girano più istanze (Fluid Compute) e ognuna ha il suo contatore, quindi il tetto vero è N × 30 al minuto per IP; un avvio a freddo riparte da zero. Perché va bene qui: le letture della salute sono leggere (server → database p50 10 ms il 20/10, fotografia della specifica) e la salute smette di **scrivere** su Postgres a ogni richiesta (`rpc('tetto_frequenza_consuma')`) mentre deve dire se Postgres sta bene. Le rotte che scrivono tengono il contatore condiviso.
9. **Il contratto con la sessione 6.** Le colonne di `cron_ultimo_esito` vengono dal piano della 6 (`docs/superpowers/plans/2026-10-20-robustezza2-s06-esiti-cron.md`, migrazione del suo Compito 4 e punto 7 della sua sezione «Per la sessione dopo», che le elenca come fatti da verificare in produzione): `job` (chiave, `coalesce(jobname, 'jobid-' || jobid)`), `attivo`, `pianificazione`, `http`, `ultimo_runid`, `ultima_esecuzione_il`, `ultima_esecuzione_stato`, `ultima_chiamata_il`, `ultima_chiamata_esito` (`ok`, `errore-http` per un codice ≥ 400, `errore-rete`, `timeout`, `esito-ignoto`; mai `in-attesa`, perché si aggiorna solo da chiamate chiuse), `ultimo_codice_http`, `ultimo_ok_il`, `ultimo_errore_il`, `aggiornato_il`. Tre comportamenti della 6 contano qui: `http` diventa `true` alla prima chiamata e non torna `false`; per un job HTTP `ultimo_ok_il` cambia **solo** quando il job chiama il server; `ultima_esecuzione_stato`/`_il` vengono da `cron.job_run_details` anche per i job HTTP. La RPC ne legge sette. Il Passo 0.2-0.3 e il test PGlite del Compito 6 le confrontano con la produzione e con il file della 6: se sono diverse cambia **solo** la `SELECT` della RPC, mai il contratto verso TypeScript (`job, cadenza, esito, visto_il, vivo_il`).
10. **«30 job nel corpo»:** il dettaglio di `cron-esiti` comincia con `{N_JOB_ATTIVI} job attivi`, letto da `cron.job` (`active`), e nel «Rilascio» deve coincidere con `SELECT count(*) FROM cron.job WHERE active` (30 il 20/10 per la specifica; 31 con `cron-esiti` della 6). Il corpo nomina solo i job da guardare, non tutti.
11. **Nessuna riga in `app_log` dalla migrazione:** crea due funzioni e non scrive niente; la regola «scritture in `app_log` delle migrazioni con `ON CONFLICT`» qui non si applica.
12. **«Mai conteggi» in `__tests__/architecture/gate-coverage.test.ts:517`.** Il corpo di `/api/health` porta già numeri (`5 tabelle presenti`, le soglie di `tasso-errore`); da oggi anche job attivi, invii riusciti e rifiutati, migrazioni. Sono numeri d'esercizio, mai di alunni o di famiglie: la prosa si aggiorna (Compito 11).
13. **Realtime:** nessuna sonda (aprire un socket a ogni lettura costerebbe più di ciò che misura); lo misura la sessione 12. Si scrive nella testata di `controlli.ts`.
14. **Il commento del pool di Auth:** la specifica dice `controlli.ts:647`; «fisso a 10» sta proprio alla riga 647, il commento va dalla 645 alla 658. Il «15 %, 13 connessioni su Small» viene dalla specifica, non da una misura di questo piano: il Passo 0.11 rilegge l'advisor.
15. **Doppio allarme possibile.** Una route di un job che si ferma fa dire `degradato` sia a `cron-battito` sia a `cron-esiti`; il campanello apre una segnalazione per controllo (`scripts/campanello/valuta.mjs:93-99`), quindi due. Si accetta: dicono due cose diverse («la route non ha finito il giro», «pg_cron non ha avuto un esito buono»).
16. **Preview.** Se una PR porta una migrazione e la Preview legge il database di produzione, `migrazioni` della Preview diventa `degradato` dopo 30 minuti. È vero, e nessuno sorveglia le Preview (`campanello` legge solo `https://app.kidville.it`).
17. **Un job HTTP che chiama il server solo quando ha lavoro.** Dopo la sessione 8, `storici_tick` (job `storici-stampe`) chiama `/api/admin/storici/cron` solo se ci sono stampe in coda (piano della 8, Compito 4); per la 6 `ultimo_ok_il` di un job HTTP si aggiorna solo dalle chiamate. Con il solo `ultimo_ok_il`, una coda vuota per due ore farebbe dire `degradato` a un job sano. Quindi `vivo_il` prende anche l'ultima esecuzione SQL `succeeded` di un job HTTP, **purché** la sua ultima chiamata non sia finita in `errore-http` o `errore-rete`: la funzione SQL che gira e decide di non chiamare è viva; quella la cui ultima chiamata è stata respinta non lo è, finché una chiamata nuova non va bene. Un `timeout` **non** si esclude: per la regola di questo modulo un timeout del client vuol dire vivo (la route può aver finito lo stesso), e il `CASE` del timeout già lo conta come vivo; escluderlo non scoprirebbe niente in più e lascerebbe un allarme falso permanente su un job che, dopo un timeout, resta senza lavoro. Provato dai due test PGlite del Compito 6 (`describe('vivo_il di un job HTTP che chiama solo quando ha lavoro')`).
18. **L'eccezione di `db-lettura` e `auth`** (specifica, Sessione 7, «Eccezione all'obiettivo, voluta»). Restano `giu` anche quando superano il tetto di 2 s: sono i due controlli di `eseguiVivo` (`src/lib/health/controlli.ts`, si cerca `export async function eseguiVivo`), cioè di `/api/health/vivo`, che risponde 200 su `degradato`. Se il loro timeout scendesse a `degradato`, un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe più. Il «niente 503 per lentezza» vale per tutti gli altri controlli. Lo dicono la testata di `valutazione.ts`, quella di `controlli.ts`, il lock `salute-controlli-nuovi-mai-giu` (`MISURE_CHE_POSSONO_DIRE_GIU`) e la «Prova» del Rilascio, che conta a parte i `503` di questi due.

---

## Mappa dei file

Percorsi e righe letti il 20/10 nel worktree `/Users/lerri/kidville-web-analisi-2026-10-20` (stesso commit di `origin/main`, `4c6df438`). Le sessioni 1-6 sposteranno le righe: chi esegue cerca il testo citato, non il numero.

| File | Azione | Ruolo |
|---|---|---|
| `src/lib/health/valutazione.ts` | Crea | tipo `EsitoSenzaGiu` (`ok`/`degradato`), `Valutazione`, la tolleranza del merge `TOLLERANZA_MERGE_MS` e `inAttesaDellIntegrazione` |
| `src/lib/health/cron-esiti.ts` | Crea | puro: finestra di ogni cadenza di `pg_cron`, lettura delle righe della RPC, decisione |
| `src/lib/health/fornitori.ts` | Crea | puro: conteggio degli esiti di un fornitore da `app_log`, soglia, dettaglio |
| `src/lib/health/migrazioni.ts` | Crea | puro: versione del repo dai nomi dei file, lettura della RPC, decisione |
| `supabase/migrations/{VERSIONE}_salute_rpc_sola_lettura.sql` | Crea | `salute_cron_esiti()` e `salute_migrazioni()`, SECURITY DEFINER, solo `service_role` |
| `src/lib/health/controlli.ts` (1450 righe) | Modifica | import (1-3); testata (32-58); commento della sonda (129-146); `JOB_CRON` (178-358); `JOB_CRON_NON_SORVEGLIATI` (360-436); `VARIABILI_CRITICHE` (512-534); commento del pool di Auth (645-658); `controlloSchema` (677-702); `valoriCritici` (992-1002); cinque controlli nuovi prima del riquadro «Aggregazione» (1365); `eseguiSalute` (1418-1439) |
| `src/lib/health/porta.ts` (148 righe) | Modifica | import (5); testata (26-28); tetto per IP (50-53, 79) |
| `src/lib/security/rate-limit.ts` | Modifica | testata (106); export `rateLimitLocale` dopo `rateLimit` (405-413) |
| `src/instrumentation.ts` | Modifica | elenco e testata di `variabiliCritiche()` (18-55) |
| `next.config.ts` (156 righe) | Modifica | import (1-3); versione delle migrazioni dopo `VERSIONE_BUNDLE` (26); `env` (115) |
| `__tests__/api/health.test.ts` | Modifica | finti `rpc` e `storage` (25-30); `montaDb` (109-114); `beforeEach` (135-144); elenco dei controlli (163-173); casi nuovi |
| `__tests__/architecture/gate-coverage.test.ts` | Modifica | voci `health:GET` (517) e `health/vivo:GET` (521) |
| `__tests__/lib/rate-limit-locale.test.ts` | Crea | tetto in memoria: 30 sì, la 31ª no, finestra che scorre, nessun client |
| `__tests__/lib/health/schema-atteso.test.ts` | Crea | client vero di supabase-js con `fetch` finto: `GET`, parallelo, nessun `count` |
| `__tests__/lib/health/cron-esiti.test.ts` | Crea | finestre letterali, decisione, lettura delle righe |
| `__tests__/lib/health/fornitori.test.ts` | Crea | conteggio e soglia con numeri letterali |
| `__tests__/lib/health/migrazioni.test.ts` | Crea | versione del repo, lettura, tolleranza al secondo, decisione |
| `__tests__/lib/health/controlli-nuovi.test.ts` | Crea | i cinque controlli con il finto client: ogni «no» con numeri letterali |
| `__tests__/lib/salute-rpc-sql.test.ts` | Crea | PGlite: le due RPC, i permessi, la guardia, le colonne della sessione 6 |
| `__tests__/architecture/cadenze-cron-leggibili.test.ts` | Crea | lock: ogni `cron.schedule` del repo ha una finestra |
| `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts` | Crea | lock: nessun controllo nuovo dice `giu` |
| `__tests__/architecture/migrazioni-versione-in-build.test.ts` | Crea | lock: `next.config.ts` porta l'ultima versione del repo |
| `PRD REGISTRO ELETTRONICO.md` | Modifica | voce di changelog in cima |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | Modifica | riga 7 della tabella di stato (`grep -n '^| 7 |'`), a «in revisione» nella PR (Compito 12); «in produzione» lo scrive la sessione dopo. Nel primo commit, la riga della sessione chiusa (Compito 1, Passo 4) |
| `__tests__/fixtures/*-snapshot.json`, `__tests__/architecture/soglia-fotografia.ts`, `PRD REGISTRO ELETTRONICO.md` | Modifica | solo nel primo commit (Compito 1, Passo 4): la chiusura della sessione rilasciata per ultima, con quello che elenca la sua sezione «Per la sessione dopo» |

**Non si toccano, e perché:**
- `src/app/api/health/route.ts`, `vivo/route.ts`, `qualita/route.ts`: passano già da `rispondiConSalute` con `creaClient: () => createAdminClient()`; il lock `isolamento-sede-coverage` li riconosce da quella riga (`__tests__/architecture/isolamento-sede-coverage.test.ts:2500-2506`).
- `scripts/campanello/*.mjs`: `valutaSalute` (`valuta.mjs:82-100`) apre una segnalazione per ogni controllo non `ok` il cui nome rispetta `/^[a-z0-9-]+$/`; i cinque nomi nuovi la rispettano. `dopo-deploy.mjs` si ferma solo su `down` o regione sbagliata: i controlli nuovi non possono fermarlo.
- `__tests__/api/health-livelli.test.ts:169-174`: chiama la salute 30 volte e controlla solo il 200 del vivo. Con i finti senza RPC i controlli nuovi diranno `degradato` (eccezione presa da `misura`), mai un'eccezione non gestita.
- `__tests__/architecture/security-definer-revoke-lock.test.ts`: la migrazione scrive il `REVOKE … FROM PUBLIC, anon, authenticated` dopo ogni funzione.
- `__tests__/architecture/soglia-fotografia.ts`: la migrazione non contiene le parole che le guardie riconoscono (vedi «Migrazione»), quindi non va dichiarata in `MIGRAZIONI_ATTESE_AL_MERGE`.

---

## Passo 0 — misura prima

In **sola lettura**, prima del Compito 1; le misure 0.1 e 0.9 si rifanno il giorno della PR. Le query SQL si lanciano con lo strumento MCP `execute_sql` (dopo la sessione 2 il freno lascia passare le letture), quelle dei log con `query_logs`. Chi ha scritto questo piano non ha accesso alla produzione: **nessun numero qui sotto è un risultato**, i valori del 20/10 citati vengono dalla specifica.

- [ ] **0.1 — Conteggio delle iscrizioni (§5, prima di ogni migrazione) e sessione 6 in produzione**

```sql
SELECT count(*) AS domande,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ora_utc
  FROM enrollment_submissions;

SELECT to_regclass('public.cron_ultimo_esito') AS ultimo_esito,
       to_regclass('public.cron_chiamate')     AS chiamate,
       (SELECT count(*) FROM cron.job WHERE jobname = 'cron-esiti' AND active) AS job_cron_esiti;
```

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s06-esiti-cron" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

`domande` → `{N_ISCRIZIONI}`, `ora_utc` → `{ORA_CONTEGGIO}`. Atteso: due nomi di tabella non nulli, `job_cron_esiti` = 1, una riga dalla `gh`.

- [ ] **0.2 — Le colonne di `cron_ultimo_esito` e i job attivi**

```sql
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'cron_ultimo_esito'
 ORDER BY ordinal_position;

SELECT count(*) AS job, count(*) FILTER (WHERE active) AS attivi FROM cron.job;

SELECT count(*) AS righe,
       count(*) FILTER (WHERE ultimo_ok_il IS NOT NULL) AS con_ok,
       count(*) FILTER (WHERE http) AS http
  FROM public.cron_ultimo_esito;
```

`attivi` → `{N_JOB_ATTIVI}`. Atteso: fra le colonne `job text`, `http boolean`, `ultima_esecuzione_il`, `ultima_chiamata_il`, `ultimo_ok_il` (`timestamp with time zone`), `ultima_esecuzione_stato`, `ultima_chiamata_esito` (`text`).

- [ ] **0.3 — Che cosa vogliono dire le date (nomi, stati e minuti, nient'altro)**

```sql
SELECT u.job, j.schedule, j.active, u.http,
       u.ultima_chiamata_esito, u.ultima_esecuzione_stato,
       round(extract(epoch FROM now() - u.ultimo_ok_il) / 60)         AS min_da_ok,
       round(extract(epoch FROM now() - u.ultima_chiamata_il) / 60)   AS min_da_chiamata,
       round(extract(epoch FROM now() - u.ultima_esecuzione_il) / 60) AS min_da_esecuzione,
       round(extract(epoch FROM now() - u.aggiornato_il) / 60)        AS min_da_scrittura
  FROM public.cron_ultimo_esito AS u
  LEFT JOIN cron.job AS j ON j.jobname = u.job
 ORDER BY u.job;

SELECT ultima_chiamata_esito, count(*) FROM public.cron_ultimo_esito GROUP BY 1 ORDER BY 1;
SELECT ultima_esecuzione_stato, count(*) FROM public.cron_ultimo_esito GROUP BY 1 ORDER BY 1;
```

Atteso: per un giornaliero (`notifiche-promemoria`, `0 6 * * *`) `min_da_ok` è il tempo dall'ultima corsa delle 06:00 UTC, **non** quello dall'ultima scrittura (`min_da_scrittura`, al più ~10); valori di `ultima_chiamata_esito` dentro `in-attesa`, `ok`, `errore-http`, `errore-rete`, `timeout`, `esito-ignoto`; di `ultima_esecuzione_stato` dentro `succeeded`, `failed`, `running`, `starting`, `sending`, `connecting`.

- [ ] **0.4 — Le 30 richieste a `/api/health` (il «prima»: p50 346 ms, p95 434 ms il 20/10)**

Trenta richieste lasciano trenta tracce: **non di più**, nessun ritentativo.

```bash
DIR="${TMPDIR:-/tmp}/kidville-s07"; mkdir -p "$DIR"
date -u '+%F %T' > "$DIR/prima-ora.txt"
for i in $(seq -w 1 30); do
  curl -s -o "$DIR/prima-$i.json" -w '%{http_code} %{time_starttransfer}\n' https://app.kidville.it/api/health
done > "$DIR/prima.txt"
cut -d' ' -f1 "$DIR/prima.txt" | sort | uniq -c
cut -d' ' -f2 "$DIR/prima.txt" | sort -n | sed -n '15p;29p'
jq -r '.stato, (.controlli[] | "\(.nome) \(.esito) \(.ms)")' "$DIR/prima-30.json"
```

Atteso: `30 200`; poi due tempi in secondi, la 15ª e la 29ª misura ordinate (rango più vicino): ×1000 → `{P50_PRIMA}` e `{P95_PRIMA}`; `{ORA_PRIMA}` da `prima-ora.txt`. L'ultima riga dice lo stato e il tempo di ogni controllo di oggi.

- [ ] **0.5 — I nomi delle variabili su Vercel (mai i valori)**

```bash
for amb in production preview; do
  echo "== $amb"
  vercel env ls "$amb" 2>&1 | awk '{print $1}' \
    | grep -E '^(FCM_PROJECT_ID|FCM_CLIENT_EMAIL|FCM_PRIVATE_KEY|NEXT_PUBLIC_VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY|NEXT_PUBLIC_APP_URL|ANTHROPIC_API_KEY|KV_[A-Z_]+)$' | sort -u
done
```

Atteso: i sette nomi in tutti e due gli ambienti; nessun nome `KV_MIGRAZIONE_REPO`, `KV_MIGRAZIONI_REPO_NUMERO`, `KV_BUILD_IL`. `{NOMI_AGGIUNTI}` = i nomi presenti in **entrambi**.

- [ ] **0.6 — Email e push degli ultimi 14 giorni, e il costo della lettura**

```sql
SELECT giorno, evento, contesto->'campi'->>'provider' AS provider,
       coalesce(sum(occorrenze) FILTER (WHERE livello = 'info' AND stato_http BETWEEN 200 AND 299
                                         AND coalesce(contesto->'campi'->>'operazione', '') <> 'oauth-token'), 0) AS riusciti,
       coalesce(sum(occorrenze) FILTER (WHERE livello = 'error'), 0) AS rifiuti,
       coalesce(sum(occorrenze) FILTER (WHERE livello = 'warn'), 0)  AS transitori
  FROM app_log
 WHERE evento IN ('email', 'push') AND sorgente = 'server' AND ambiente = 'production'
   AND giorno >= current_date - 14
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

EXPLAIN (ANALYZE, BUFFERS)
SELECT livello, stato_http, occorrenze, visto_l_ultima, contesto->'campi'->>'operazione' AS operazione
  FROM app_log
 WHERE evento = 'email' AND sorgente = 'server' AND ambiente = 'production'
   AND contesto->'campi'->>'provider' = 'resend'
   AND visto_l_ultima >= now() - interval '24 hours'
 LIMIT 500;
```

`EXPLAIN ANALYZE` esegue la `SELECT`: è una lettura. Atteso: provider `resend`, `fcm`, `web-push`; per ogni giorno e provider la regola del punto 4 delle «Scelte» (rifiuti ≥ 3 **e** rifiuti > riusciti, sommando la riga del giorno e quella del giorno prima) **non** scatta in un giorno senza un guasto noto; `Execution Time` sotto i 50 ms.

- [ ] **0.7 — Il primo battito dei due job che entrano in `JOB_CRON`**

```sql
SELECT contesto->'campi'->>'operazione' AS job, contesto->'campi'->>'esito' AS esito, livello,
       count(*) AS righe, max(visto_l_ultima) AS ultimo
  FROM app_log
 WHERE evento = 'cron' AND ambiente = 'production'
   AND contesto->'campi'->>'operazione' IN ('fascicolo-audit-ip-retention', 'cron-esiti')
   AND visto_l_ultima > now() - interval '3 days'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

SELECT jobname, schedule, active FROM cron.job
 WHERE jobname IN ('fascicolo-audit-ip-retention', 'cron-esiti') ORDER BY 1;
```

Atteso: per ciascuno una riga `esito = ok`, `livello = info`, con `ultimo` dentro la finestra (26 h e 40 min); pianificazioni `29 4 * * *` e `4,14,24,34,44,54 * * * *`.

- [ ] **0.8 — Il bucket della sonda e le dimensioni (anche per T2)**

```sql
SELECT id, public FROM storage.buckets WHERE id = 'fatture';

SELECT count(*) AS oggetti_col_prefisso
  FROM storage.objects
 WHERE bucket_id = 'fatture' AND name LIKE 'salute-sonda-inesistente%';

SELECT bucket_id, count(*) AS oggetti, sum((metadata->>'size')::bigint) AS byte,
       pg_size_pretty(sum((metadata->>'size')::bigint)) AS dimensione
  FROM storage.objects GROUP BY 1 ORDER BY 3 DESC NULLS LAST;

SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
       (SELECT pg_size_pretty(sum((metadata->>'size')::bigint)) FROM storage.objects) AS storage;
```

Atteso: `fatture` con `public = false`; `oggetti_col_prefisso` = 0. Si annotano oggetti e byte per bucket e la somma di `gallery` + `video_originals` (T2: 13,2 GB il 20/10, si ridecide sopra 20 GB). La terza query è la «query 4» della specifica, divisa per bucket: quella di `docs/roadmap-robustezza.md:522-526` dà solo il totale.

- [ ] **0.9 — Migrazioni: produzione e repo**

```sql
SELECT max(version) AS ultima, count(*) AS numero FROM supabase_migrations.schema_migrations;
```

```bash
cd /Users/lerri/kidville-web && git fetch origin main
git ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{14}_.+\.sql$' | sort | tail -1
git ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep -cE '^[0-9]{14}_.+\.sql$'
```

Atteso: stessa versione più alta, stesso numero (231 file e 231 righe il 20/10, prima delle sessioni 1-6).

- [ ] **0.10 — Quante volte la salute ha detto «giù» negli ultimi 7 giorni**

```sql
SELECT count(*) AS righe, coalesce(sum(occorrenze), 0) AS occorrenze
  FROM app_log
 WHERE ambiente = 'production' AND visto_l_ultima > now() - interval '7 days'
   AND (
         (evento = 'config' AND livello = 'error'
          AND contesto->'campi'->>'operazione' = 'health' AND contesto->'campi'->>'esito' = 'down')
      OR (contesto->'campi'->>'operazione' = 'health:GET' AND stato_http >= 500)
       );
```

```bash
gh issue list --repo erricoluigi17/kidville-web --state all --search "Salute: in:title" --limit 50 \
  --json number,state,createdAt,title --jq '.[] | "\(.number) \(.state) \(.createdAt) \(.title)"'
jq -r '.controlli[] | select(.esito != "ok") | "\(.nome) \(.esito) \(.dettaglio)"' "${TMPDIR:-/tmp}/kidville-s07/prima-30.json"
```

La «Prova» della specifica conta i `503` **per lentezza**, e a parte quelli di `db-lettura` e `auth` (l'eccezione voluta: sono i controlli di `eseguiVivo`). La porta scrive nel `messaggio` `health: down — nome(esito): dettaglio | …`, e un tetto scaduto ha il dettaglio `oltre il tetto di <n> ms`; il «prima» si separa così, con la stessa query che la sessione dopo rifà sul «dopo» (sezione «Per la sessione dopo», punto 5):

```sql
WITH giu AS (
  SELECT a.id, a.occorrenze, m[1] AS controllo, btrim(coalesce(m[2], '')) AS dettaglio
    FROM app_log AS a
    CROSS JOIN LATERAL regexp_matches(a.messaggio, '([a-z0-9-]+)\(giu\)(?::\s*([^|]*))?', 'g') AS m
   WHERE a.ambiente = 'production' AND a.visto_l_ultima > now() - interval '7 days'
     AND a.evento = 'config' AND a.livello = 'error'
     AND a.contesto->'campi'->>'operazione' = 'health' AND a.contesto->'campi'->>'esito' = 'down'
)
SELECT CASE WHEN controllo IN ('db-lettura', 'auth') THEN 'vivo, a parte'
            WHEN dettaglio LIKE 'oltre il tetto%' THEN 'lentezza'
            ELSE 'guasto' END AS tipo,
       controllo, left(dettaglio, 60) AS dettaglio,
       count(DISTINCT id) AS righe, sum(occorrenze) AS occorrenze
  FROM giu
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

Atteso: i numeri del «prima» per la prova dei 7 giorni, divisi in `lentezza` (quelli che questa sessione toglie), `vivo, a parte` e `guasto`; la `jq` senza righe (nessun controllo già non `ok`).

- [ ] **0.11 — Il pool di Auth e il contatore che si toglie**

Strumento MCP `get_advisors`, tipo `performance`, poi `security`. Atteso: nessun avviso `auth_db_connections_absolute` (dal 19/10 il pool è in percentuale).

```sql
SELECT count(*) AS chiavi_salute FROM public.tetto_frequenza WHERE chiave LIKE 'health%';
```

Solo il conteggio: le chiavi contengono un IP. Dopo il rilascio le chiavi `health…` smettono di crescere e scadono da sole.

### Soglie che cambiano il piano

| Misura | Esito | Cosa cambia |
|---|---|---|
| 0.1 | la sessione 6 non è in produzione, o una delle due tabelle manca | **STOP** (§3: 6 → 7) |
| 0.2 | mancano `ultimo_ok_il`, `ultima_chiamata_il`, `ultima_esecuzione_il`, `http`, `ultima_chiamata_esito` o `ultima_esecuzione_stato` | si riscrive **solo** la `SELECT` della RPC (Compito 6) sui nomi veri, e la tabella finta del test PGlite con lei; il contratto verso TypeScript non cambia |
| 0.3 | `min_da_ok` uguale a `min_da_scrittura` per tutti i job | **STOP**: `ultimo_ok_il` è l'istante della scrittura, non della corsa, e ogni job sembrerebbe vivo. La correzione è della sessione 6 |
| 0.3 | un valore di esito fuori dagli elenchi | si aggiunge al `CASE` della RPC e al test PGlite |
| 0.4 | una risposta non 200 | si annota; se è `503`, **STOP** e domanda al titolare prima di toccare la salute |
| 0.5 | un nome assente in uno dei due ambienti | quel nome **non** entra in `VARIABILI_CRITICHE` (Compito 4) e si scrive nella PR |
| 0.5 | un nome `KV_…` di questo piano già definito | **STOP**: la chiave `env` di `next.config.ts` lo coprirebbe |
| 0.6 | la regola scatta in un giorno senza guasto noto | `SOGLIA_RIFIUTI_FORNITORE` = il massimo dei rifiuti di quei giorni + 1 → `{SOGLIA_RIFIUTI}`; si aggiornano i numeri dei test del Compito 9 e si scrive nella PR |
| 0.6 | `Execution Time` sopra 50 ms | **STOP**: serve un indice, che non è di questa sessione |
| 0.7 | nessun battito `ok` di un job | quel job resta in `JOB_CRON_NON_SORVEGLIATI` con la sua voce di oggi (Compito 7, Passo 1) |
| 0.8 | `fatture` assente o pubblico, o prefisso con oggetti | si sceglie un altro bucket privato con meno oggetti dalla terza query e si cambia `BUCKET_SONDA_STORAGE` (Compito 8) |
| 0.9 | repo e produzione diversi | **STOP**: `migrazioni` nascerebbe `degradato`; si chiede al titolare quale delle due ha ragione |
| 0.10 | controlli già non `ok` | si annotano nella PR: non li causa questa sessione |
| 0.11 | `auth_db_connections_absolute` presente | il commento del pool (Compito 11) dice ciò che dice l'advisor, con la data |

---

## Migrazione

Una sola: `supabase/migrations/{VERSIONE}_salute_rpc_sola_lettura.sql`, scritta al Compito 6. Due funzioni di **sola lettura**, `STABLE`, `SECURITY DEFINER` con `search_path` vuoto, eseguibili solo da `service_role`. Nessuna tabella, nessuna colonna, nessuna riga in `app_log`. La applica l'integrazione Supabase al merge.

**Guardie per la CI e per il momento del merge.** Il corpo è plpgsql: le tabelle di `cron` e di `supabase_migrations` si cercano **a runtime** con `to_regclass`, quindi la migrazione si applica anche sul DB della CI, dove `cron_ultimo_esito` può mancare; chiamata lì, la funzione alza un'eccezione (`P0001`) che il controllo traduce in `degradato`. Il codice TypeScript regge `PGRST202` e `42883` (funzione non ancora nella cache di PostgREST, o non ancora creata) solo su queste due chiamate, per 30 minuti dopo la build, con una riga `info` che dice perché (§5). `NOT VALID` non serve: nessun vincolo.

**Parole che le guardie delle fotografie riconoscono** (`__tests__/architecture/soglia-fotografia.ts:283, 299, 359-362`): il file non contiene `unique`, `primary key`, `references utenti`, `add constraint`, `drop constraint`, `policy`, `row level security`, `drop table`, nemmeno nei commenti.

**ROLLBACK** (nell'intestazione, solo come commento): `DROP FUNCTION IF EXISTS` delle due funzioni, dentro una PR di revert e mai a mano. Vedi «Ritorno indietro».

---

## Compiti

Ogni compito finisce con un commit suo, che si legge e si prova da solo; per spegnere un controllo solo, senza revert, vedi il terzo punto del «Ritorno indietro». Da qui ogni comando gira in `/Users/lerri/kidville-web-s07-salute-completa`, mai nel checkout principale, e ogni lettura di un file si fa con `Read` (le regole di `.claude/rules/` si attivano lì).

### Compito 1 — Prerequisiti, worktree e chiusura della sessione precedente

**File:**
- Nessun file del prodotto. Nel primo commit (Passo 4) i file che elenca la sezione «Per la sessione dopo» della sessione rilasciata per ultima: di solito `__tests__/fixtures/migrazioni-applicate-snapshot.json` (e le altre fotografie che nomina), `__tests__/architecture/soglia-fotografia.ts` (costante `MIGRAZIONI_ATTESE_AL_MERGE`), la riga di quella sessione nella tabella di stato della specifica e la sua voce nel PRD.

- [ ] **Passo 1: i prerequisiti — la sessione 6 è mergiata e la sua migrazione è applicata; nessun'altra sessione aperta (§5)**

La colonna «Dopo» della riga 7 dice `6`. Si verificano due **fatti**, mai il testo dello «Stato» della tabella (quello lo chiude la sessione dopo, e può essere ancora «in revisione»):

```bash
git -C /Users/lerri/kidville-web fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s06-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
git -C /Users/lerri/kidville-web ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep '_cron_esiti_osservati\.sql$' | cut -c1-14
```

Atteso: **una riga** dalla `gh` (numero e istante del merge della sessione 6) e **una** version di 14 cifre, quella della migrazione della sessione 6 (`<V6>`). Poi, in sola lettura con `execute_sql`, con quella version al posto di `<V6>`:

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('<V6>');
```

Atteso: **una riga**. Poi nessuna PR della serie ancora aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n '^| 7 |'
```

Atteso: **nessuna riga** dalla `gh`; dalla specifica una riga, la 7, con Stato `da fare`. Se uno di questi controlli fallisce: **fermati** (§3: la 7 dipende dalla 6; §5: una sessione alla volta).

- [ ] **Passo 2: worktree e ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s07-salute-completa /Users/lerri/kidville-web-s07-salute-completa origin/main
cd /Users/lerri/kidville-web-s07-salute-completa && git status -sb | head -3
```

Atteso: `## robustezza2/s07-salute-completa...origin/main`, albero pulito. Il nome del ramo è quello del file del piano senza la data: la sessione dopo lo usa per ritrovare questo piano.

- [ ] **Passo 3: `.env.local` e dipendenze**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s07-salute-completa/.env.local
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 4: la chiusura della sessione rilasciata per ultima (primo commit, prima di ogni codice)**

Si trova la sessione della serie mergiata più di recente, qualunque numero abbia:

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga, `<numero> robustezza2/<nome>`. Si apre il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome>.md` (il nome del ramo senza `robustezza2/`), e si legge **per intero** la sua sezione finale «Per la sessione dopo». Si fa quello che elenca, e solo quello: fotografie rigenerate dalla produzione, voci tolte da `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste che nomina, la sua riga di stato a «in produzione» col commit di `main`, lo Stato della sua voce nel PRD, la misura «dopo» se è già matura (una misura non ancora matura resta scritta come tale, con il giorno da cui lo è). Non si indovina: se la sezione manca, o chiede una cosa che non torna con la produzione, ci si ferma e si chiede al titolare. Se la `gh` non stampa niente il passo si salta: per la 7 non può succedere, perché il Passo 1 ha trovato la 6. Quando la sessione chiusa è la 6, la sua sezione elenca anche i fatti su `cron_ultimo_esito`, sul job `cron-esiti` e sul battito che questo piano legge (punto 7): si verificano lì, e se uno non torna vale la soglia 0.2/0.3 del Passo 0.

La fotografia delle migrazioni si rigenera **sempre** quando la sessione chiusa aveva migrazioni:

```bash
mkdir -p "${TMPDIR:-/tmp}/kidville-s07"
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

La query stampata si esegue con `execute_sql` (sola lettura, una tabella di sistema), la risposta JSON va in `${TMPDIR:-/tmp}/kidville-s07/migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/kidville-s07/migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  3 passed`. Se `soglia-fotografia.test.ts` è rosso sul test «2 · nessuna chiave è già applicata», `MIGRAZIONI_ATTESE_AL_MERGE` contiene ancora una voce che la sezione della sessione chiusa dice di togliere: la si toglie col commento «SVUOTATA» che quella sezione dà. Le altre fotografie (indici unici, policy, chiavi esterne, bucket, tabelle per sede) si rigenerano **solo** se la sezione della sessione chiusa le nomina, ciascuna col comando che dà lì, e col suo lock lanciato subito dopo. Commit, con i file che la sezione ha toccato:

```bash
git add __tests__/fixtures/ __tests__/architecture/soglia-fotografia.ts \
  docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git status --short
git diff --cached --name-only | xargs grep -nE '\{(OGGI|VERSIONE|N_ISCRIZIONI|ORA_[A-Z]+|N_JOB_ATTIVI|P(50|95)_[A-Z]+|NOMI_AGGIUNTI|SOGLIA_RIFIUTI|PR|SHA_MERGE|DATA_7G)\}'
git commit -m "Robustezza2 s07: chiusura della sessione rilasciata per ultima (fotografie, stato, PRD)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Atteso: `git status --short` senza righe ` M` o `??` fuori dal commit (se la sezione chiusa ha toccato un altro file, lo si aggiunge e si rilancia); il `grep` senza righe. Nel messaggio del commit, al posto di «la sessione rilasciata per ultima», il nome del suo ramo.

- [ ] **Passo 5: gate di partenza**

```bash
CI=1 npx vitest run 2>&1 | tail -15
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
```

Atteso: la riga `Test Files` senza `failed` (al più `offline-html-nativo` al primo giro: in un worktree nuovo la shell nativa non è sincronizzata; il secondo comando dà `1 passed`); la build finisce con l'elenco delle route. Se è rosso un altro lock di fotografia (`onconflict-arbitro`, `rls-per-sede`, `fk-scuola-id`, …), la chiusura del Passo 4 non ha rigenerato una fotografia che serviva: la si rigenera con il generatore che il suo messaggio d'errore nomina, sempre dalla produzione, e la si aggiunge al commit del Passo 4 (`git commit --amend`, finché non c'è stato un push). Si legge la riga `Test Files`, non il codice d'uscita di una pipe.

---

### Compito 2 — Il tetto per IP torna in memoria

**File:**
- Modifica: `src/lib/security/rate-limit.ts` (testata, riga 106; export nuovo dopo `rateLimit`, righe 405-413)
- Modifica: `src/lib/health/porta.ts:5`, `:26-28`, `:50-53`, `:79`
- Modifica: `__tests__/api/health.test.ts` (finti `rpc` e `storage`, `montaDb`, `beforeEach`, un caso nuovo)
- Crea: `__tests__/lib/rate-limit-locale.test.ts`

- [ ] **Passo 1: il test del contatore in memoria**

Crea `__tests__/lib/rate-limit-locale.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Se il contatore in memoria aprisse il client service role, questa spia lo vedrebbe.
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

import { rateLimitLocale, resetRateLimit } from '@/lib/security/rate-limit'

/**
 * IL TETTO PER ISTANZA, SENZA DATABASE (sessione 7 della seconda serie di robustezza).
 *
 * Lo usa solo la porta dei tre endpoint di salute (`src/lib/health/porta.ts`): una salute che
 * scrive su Postgres a ogni richiesta misura il database dopo averlo caricato. Qui si prova che
 * conta, che la finestra scorre al millisecondo e che non tocca mai il client.
 */

const T0 = 1_760_000_000_000
const TETTO = { limit: 30, windowMs: 60_000 }

beforeEach(() => {
    vi.clearAllMocks()
    resetRateLimit()
})

describe('rateLimitLocale', () => {
    it('lascia passare 30 colpi nello stesso minuto e ferma il 31°, con l’attesa giusta', () => {
        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0)).toEqual({ ok: true, remaining: 29, retryAfterMs: 0 })
        for (let i = 1; i < 30; i++) expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + i).ok).toBe(true)

        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 30)).toEqual({
            ok: false,
            remaining: 0,
            retryAfterMs: 59_970,
        })
    })

    it('la finestra scorre: a 59.999 ms dal primo colpo è ancora piena, a 60.000 no', () => {
        for (let i = 0; i < 30; i++) rateLimitLocale('health:203.0.113.9', TETTO, T0 + i)

        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 59_999).ok).toBe(false)
        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 60_000).ok).toBe(true)
    })

    it('chiavi diverse hanno contatori diversi', () => {
        for (let i = 0; i < 30; i++) rateLimitLocale('health:203.0.113.9', TETTO, T0 + i)

        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 31).ok).toBe(false)
        expect(rateLimitLocale('health:198.51.100.7', TETTO, T0 + 31).ok).toBe(true)
        expect(rateLimitLocale('health-vivo:203.0.113.9', TETTO, T0 + 31).ok).toBe(true)
    })

    it('non apre mai il client del database', () => {
        for (let i = 0; i < 40; i++) rateLimitLocale('health:203.0.113.9', TETTO, T0 + i)

        expect(supa.createAdminClient).not.toHaveBeenCalled()
    })
})
```

- [ ] **Passo 2: i finti di `health.test.ts` e il caso «la salute non scrive»**

In `__tests__/api/health.test.ts`, sotto la riga `const auth = vi.hoisted(() => ({ getUserById: vi.fn() }))`, aggiungi:

```ts

// Le RPC che la salute chiama (e quella del tetto condiviso, che NON deve chiamare) e lo Storage.
const rpc = vi.hoisted(() => ({ tetto: vi.fn(), cronEsiti: vi.fn(), migrazioni: vi.fn() }))
const storage = vi.hoisted(() => ({ from: vi.fn(), list: vi.fn() }))
```

Sostituisci la funzione `montaDb`:

```ts
function montaDb(db: DBFinto, errori: Record<string, ErrorePostgrest> = {}): void {
    const finto = creaFintoSupabase(db, [], { errori })
    supa.createAdminClient.mockResolvedValue(
        Object.assign(finto, { auth: { admin: { getUserById: auth.getUserById } } }),
    )
}
```

con:

```ts
function montaDb(db: DBFinto, errori: Record<string, ErrorePostgrest> = {}): void {
    const finto = creaFintoSupabase(db, [], {
        errori,
        rpc: {
            // Il contatore CONDIVISO del tetto: dal Compito 2 della sessione 7 la salute non lo
            // chiama più. È qui perché, se tornasse a chiamarlo, il test lo vedrebbe.
            tetto_frequenza_consuma: rpc.tetto,
            salute_cron_esiti: rpc.cronEsiti,
            salute_migrazioni: rpc.migrazioni,
        },
    })
    supa.createAdminClient.mockResolvedValue(
        Object.assign(finto, {
            auth: { admin: { getUserById: auth.getUserById } },
            storage: { from: storage.from },
        }),
    )
}
```

Nel `beforeEach`, dopo la riga `montaDb(dbSano())`, aggiungi:

```ts
    rpc.tetto.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'funzione finta assente' } })
    rpc.cronEsiti.mockResolvedValue({
        data: [{ job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', visto_il: fa(MIN), vivo_il: fa(MIN) }],
        error: null,
    })
    rpc.migrazioni.mockResolvedValue({ data: [{ ultima: '20261020000000', numero: 232 }], error: null })
    storage.from.mockReturnValue({ list: storage.list })
    storage.list.mockResolvedValue({ data: [], error: null })
    // Le tre chiavi che `next.config.ts` fissa alla build (Compito 10): in un test non c'è build.
    vi.stubEnv('KV_MIGRAZIONE_REPO', '20261020000000')
    vi.stubEnv('KV_MIGRAZIONI_REPO_NUMERO', '232')
    vi.stubEnv('KV_BUILD_IL', new Date().toISOString())
```

Subito dopo il test `'IP diversi hanno tetti diversi'`, aggiungi:

```ts
    it('il tetto per IP sta in memoria: la salute non scrive sul database che misura', async () => {
        const req = () =>
            new Request('https://app.kidville.it/api/health', { headers: { 'x-forwarded-for': '203.0.113.20' } })
        for (let i = 0; i < 30; i++) expect((await GET(req())).status).toBe(200)
        expect((await GET(req())).status).toBe(429)

        // Fino alla sessione 7 ogni richiesta faceva `rpc('tetto_frequenza_consuma')`, cioè una
        // SCRITTURA su Postgres prima di misurarlo.
        expect(rpc.tetto).not.toHaveBeenCalled()
    })
```

- [ ] **Passo 3: lancia i test, rossi**

```bash
npx vitest run __tests__/lib/rate-limit-locale.test.ts __tests__/api/health.test.ts 2>&1 | tail -15
```

Atteso: `rate-limit-locale.test.ts` rosso su tutti e quattro (`rateLimitLocale is not a function`); in `health.test.ts` rosso **solo** «il tetto per IP sta in memoria» (`expected "spy" to not be called at all, but actually been called 31 times`). Tutti gli altri verdi: i finti nuovi non cambiano niente di ciò che la salute fa oggi.

- [ ] **Passo 4: `rateLimitLocale`**

In `src/lib/security/rate-limit.ts`, subito dopo la `}` che chiude `export async function rateLimit(` (riga 413), aggiungi:

```ts

/**
 * Il tetto PER ISTANZA, senza database: lo stesso conteggio che `rateLimit` usa come ripiego.
 *
 * Ha un solo chiamante, `src/lib/health/porta.ts` (i tre endpoint di salute): una salute che
 * scrive sul database a ogni richiesta misura il database dopo averlo caricato. Su più istanze il
 * tetto effettivo è N × `limit` — vedi la testata della porta. Una rotta che SCRIVE usa
 * `rateLimit`, il contatore condiviso.
 */
export function rateLimitLocale(
  key: string,
  opts: RateLimitOptions,
  now: number = Date.now(),
): RateLimitResult {
  return consumaLocale(key, opts, now);
}
```

Nella testata dello stesso file sostituisci la riga:

```
 *     GET  /api/health                        (per-IP, vedi la route)
```

con:

```
 *     GET  /api/health                        (per-IP IN MEMORIA: rateLimitLocale, lib/health/porta.ts)
```

- [ ] **Passo 5: la porta usa il contatore in memoria**

In `src/lib/health/porta.ts` sostituisci la riga 5:

```ts
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
```

con:

```ts
import { rateLimitLocale, clientIp } from '@/lib/security/rate-limit'
```

Sostituisci le righe 26-28:

```ts
 *  2. c'è un TETTO PER IP, distinto per endpoint. Non è formalità: ogni chiamata fa da una a
 *     otto query. Senza tetto sarebbe un amplificatore di carico verso il database puntabile da
 *     chiunque — un endpoint di salute che diventa la causa del guasto.
```

con:

```ts
 *  2. c'è un TETTO PER IP, distinto per endpoint. Non è formalità: ogni chiamata fa una lettura
 *     per controllo, e alcuni controlli più d'una. Senza tetto sarebbe un amplificatore di carico
 *     verso il database puntabile da chiunque — un endpoint di salute che diventa la causa del
 *     guasto.
```

Sostituisci le righe 50-53:

```ts
/** Un monitor serio interroga ogni 30-60 secondi (2 al minuto): il tetto è quindici volte il
 *  bisogno legittimo, e non inciampa mai un uso reale nemmeno con quattro monitor sullo stesso
 *  URL. Il contatore è per istanza (vedi `@/lib/security/rate-limit`): il tetto effettivo è N × 30. */
const TETTO_PER_IP = { limit: 30, windowMs: 60_000 }
```

con:

```ts
/**
 * IL TETTO PER IP STA IN MEMORIA, UN CONTATORE PER ISTANZA (sessione 7 della seconda serie di
 * robustezza, {OGGI}).
 *
 * Un monitor serio interroga ogni 30-60 secondi (2 al minuto): 30 al minuto è quindici volte il
 * bisogno legittimo, e non inciampa mai un uso reale nemmeno con quattro monitor sullo stesso URL.
 *
 * Fino al {OGGI} il contatore era quello condiviso di `rateLimit`, cioè una SCRITTURA su Postgres
 * (`rpc('tetto_frequenza_consuma')`) a ogni richiesta: l'endpoint che deve dire se il database sta
 * bene scriveva sul database prima di misurarlo, e un database in affanno rallentava anche la
 * risposta che doveva dirlo. Ora `rateLimitLocale` conta in memoria e la salute non scrive niente.
 *
 * Cosa si perde, detto e non nascosto: su Vercel la funzione gira su più istanze (Fluid Compute)
 * e ognuna ha il suo contatore, quindi il tetto vero è N × 30 al minuto per IP; un avvio a freddo
 * riparte da zero. Va bene QUI perché ciò che il tetto protegge è leggero — letture brevi, server →
 * database p50 10 ms il 20/10 — e N × 30 letture al minuto restano lontane da ciò che il database
 * regge. Le rotte che SCRIVONO tengono il contatore condiviso: per loro N × il tetto sarebbe
 * un'altra cosa.
 */
const TETTO_PER_IP = { limit: 30, windowMs: 60_000 }
```

Sostituisci la riga 79:

```ts
        const tetto = await rateLimit(`${opz.nome}:${ip}`, TETTO_PER_IP)
```

con:

```ts
        const tetto = rateLimitLocale(`${opz.nome}:${ip}`, TETTO_PER_IP)
```

- [ ] **Passo 6: lancia i test, verdi**

```bash
npx vitest run __tests__/lib/rate-limit-locale.test.ts __tests__/lib/rate-limit.test.ts __tests__/lib/rate-limit-condiviso.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts 2>&1 | tail -10
npx eslint src/lib/security/rate-limit.ts src/lib/health/porta.ts __tests__/lib/rate-limit-locale.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  5 passed` (si legge la riga, non il codice d'uscita della pipe); eslint e tsc senza righe. `rate-limit.test.ts` e `rate-limit-condiviso.test.ts` provano che il contatore condiviso delle altre rotte non è cambiato.

- [ ] **Passo 7: commit**

```bash
git add src/lib/security/rate-limit.ts src/lib/health/porta.ts __tests__/lib/rate-limit-locale.test.ts __tests__/api/health.test.ts
git commit -m "Salute: il tetto per IP in memoria, la salute non scrive più sul database che misura" -m "rateLimitLocale (stesso conteggio del ripiego di rateLimit) per i tre endpoint di salute; su più istanze il tetto vero è N × 30 al minuto, scritto nella testata della porta. Sessione 7 della seconda serie di robustezza." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 3 — `schema-atteso`: una `GET` per tabella, in parallelo, senza conteggio

**File:**
- Crea: `__tests__/lib/health/schema-atteso.test.ts`
- Modifica: `src/lib/health/controlli.ts:129-146` (commento della sonda), `:677-702` (`controlloSchema`)

- [ ] **Passo 1: il test con il client vero**

Crea `__tests__/lib/health/schema-atteso.test.ts`:

```ts
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { controlloSchema, TABELLE_ATTESE } from '@/lib/health/controlli'

/**
 * `schema-atteso` PROVATO CON IL CLIENT VERO DI supabase-js, CON UN `fetch` FINTO.
 *
 * Il finto client dei test (`__tests__/fixtures/finto-supabase.ts`) restituisce l'errore che gli si
 * dice di restituire, qualunque sia la forma della richiesta: non può vedere che una HEAD senza
 * corpo perde il `PGRST205`. Qui si usa la libreria vera, e il `fetch` risponde come PostgREST:
 * 404 con il corpo JSON a una GET, 404 senza corpo a una HEAD (una HEAD un corpo non ce l'ha).
 */

interface Chiamata {
    verbo: string
    url: URL
    prefer: string | null
}

interface Risposta {
    stato: number
    corpo?: unknown
}

const RIGA = [{ id: '00000000-0000-4000-8000-000000000001' }]

function tabellaDi(c: Chiamata): string {
    return c.url.pathname.replace('/rest/v1/', '')
}

function client(risposta: (c: Chiamata) => Risposta | Promise<Risposta>, chiamate: Chiamata[] = []): SupabaseClient {
    const fetchFinto = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const c: Chiamata = {
            verbo: (init?.method ?? 'GET').toUpperCase(),
            url: new URL(input instanceof Request ? input.url : String(input)),
            prefer: new Headers(init?.headers).get('Prefer'),
        }
        chiamate.push(c)
        const r = await risposta(c)
        const conCorpo = c.verbo !== 'HEAD' && r.corpo !== undefined
        return new Response(conCorpo ? JSON.stringify(r.corpo) : null, {
            status: r.stato,
            headers: conCorpo ? { 'Content-Type': 'application/json' } : {},
        })
    }
    // `accessToken` tiene fuori auth-js (sessioni, lock, timer): qui si prova solo PostgREST.
    return createClient('https://finto.supabase.co', 'chiave-fittizia', {
        accessToken: async () => 'gettone-finto',
        global: { fetch: fetchFinto },
    })
}

afterEach(() => {
    vi.useRealTimers()
})

describe('schema-atteso con il client vero', () => {
    it('una tabella assente si vede: PostgREST risponde 404 PGRST205 e lo stato è giu', async () => {
        const c = client((ch) =>
            tabellaDi(ch) === 'avvisi'
                ? { stato: 404, corpo: { code: 'PGRST205', message: 'Could not find the table', details: null, hint: null } }
                : { stato: 200, corpo: RIGA },
        )

        const esito = await controlloSchema(c)

        expect(esito).toMatchObject({ nome: 'schema-atteso', esito: 'giu', dettaglio: 'tabelle assenti: avvisi' })
    })

    it('una GET per tabella, con `select=id` e `limit=1`, senza conteggio', async () => {
        const chiamate: Chiamata[] = []
        const c = client(() => ({ stato: 200, corpo: RIGA }), chiamate)

        const esito = await controlloSchema(c)

        expect(esito).toMatchObject({ esito: 'ok', dettaglio: '5 tabelle presenti' })
        expect(chiamate.map(tabellaDi).sort()).toEqual([...TABELLE_ATTESE].sort())
        for (const ch of chiamate) {
            expect(ch.verbo).toBe('GET')
            expect(ch.url.searchParams.get('select')).toBe('id')
            expect(ch.url.searchParams.get('limit')).toBe('1')
            expect(ch.prefer ?? '').not.toContain('count=')
        }
    })

    it('cinque letture da 1,5 s stanno sotto il tetto di 2 s: girano in parallelo', async () => {
        vi.useFakeTimers()
        const c = client(() => new Promise<Risposta>((r) => setTimeout(() => r({ stato: 200, corpo: RIGA }), 1_500)))

        const promessa = controlloSchema(c)
        await vi.advanceTimersByTimeAsync(1_500)

        expect(await promessa).toMatchObject({ esito: 'ok', dettaglio: '5 tabelle presenti' })
    })

    it('un database che non risponde è degradato, non giù: lentezza non è assenza', async () => {
        vi.useFakeTimers()
        const c = client(() => new Promise<Risposta>(() => undefined))

        const promessa = controlloSchema(c)
        await vi.advanceTimersByTimeAsync(2_000)

        expect(await promessa).toMatchObject({ esito: 'degradato', dettaglio: 'oltre il tetto di 2000 ms' })
    })

    it('una tabella illeggibile resta giu, con il solo codice', async () => {
        const c = client((ch) =>
            tabellaDi(ch) === 'pagamenti'
                ? { stato: 500, corpo: { code: 'XX000', message: 'dettaglio interno da non rilanciare', details: null, hint: null } }
                : { stato: 200, corpo: RIGA },
        )

        const esito = await controlloSchema(c)

        expect(esito).toMatchObject({ esito: 'giu', dettaglio: 'tabelle illeggibili: pagamenti:XX000' })
    })
})
```

- [ ] **Passo 2: rendi esportata la funzione e guarda il test fallire per la ragione giusta**

In `src/lib/health/controlli.ts` sostituisci `async function controlloSchema(supabase: SupabaseClient): Promise<Controllo> {` con `export async function controlloSchema(supabase: SupabaseClient): Promise<Controllo> {` (solo la parola `export`). Poi:

```bash
npx vitest run __tests__/lib/health/schema-atteso.test.ts 2>&1 | tail -25
```

Atteso: 5 rossi, ed è la prova del punto cieco: (1) `esito: 'ok'` invece di `giu` — la HEAD riceve un 404 senza corpo e postgrest-js lo rende `status 204` senza errore; (2) verbo `HEAD` e `Prefer: count=exact`; (3) e (4) `giu` con «oltre il tetto di 2000 ms» (in serie, e con l'esito di guasto `giu`); (5) `pagamenti:sconosciuto` invece di `pagamenti:XX000`.

- [ ] **Passo 3: il controllo nuovo**

Sostituisci la funzione intera: va dalla riga `export async function controlloSchema(supabase: SupabaseClient): Promise<Controllo> {` (resa esportata al Passo 2) alla `}` che chiude il suo `misura('schema-atteso', 'giu', …)`, cioè la funzione mostrata qui sotto (righe 677-702 il 20/10; le sessioni 1 e 6 toccano lo stesso file, quindi si cerca il testo, non il numero):

```ts
export async function controlloSchema(supabase: SupabaseClient): Promise<Controllo> {
    return misura('schema-atteso', 'giu', async () => {
        const assenti: string[] = []
        const illeggibili: string[] = []
        for (const tabella of TABELLE_ATTESE) {
            const { error } = await supabase
                .from(tabella)
                .select('id', { head: true, count: 'exact' })
                .limit(1)
            if (!error) continue
            // Si distingue «la tabella non c'è» da «la tabella c'è ma la query è caduta».
            // Sono due incidenti diversi che si riparano in due posti diversi: una
            // migrazione da applicare contro un database in affanno. Un controllo che li
            // fondesse manderebbe chi risponde all'allarme a cercare nel posto sbagliato.
            if (CODICI_TABELLA_ASSENTE.has(codiceDi(error))) assenti.push(tabella)
            else illeggibili.push(`${tabella}:${codiceDi(error)}`)
        }
        if (assenti.length > 0) {
            return { esito: 'giu', dettaglio: `tabelle assenti: ${assenti.join(',')}` }
        }
        if (illeggibili.length > 0) {
            return { esito: 'giu', dettaglio: `tabelle illeggibili: ${illeggibili.join(' ')}` }
        }
        return { esito: 'ok', dettaglio: `${TABELLE_ATTESE.length} tabelle presenti` }
    })
}
```

con:

```ts
/**
 * Le cinque letture girano IN PARALLELO. In serie, cinque letture da 500 ms facevano 2,5 s e il
 * tetto di 2 s diceva «giù» a un database soltanto lento. Per la stessa ragione lo scadere del
 * tetto, o un'eccezione, è `degradato` (sessione 7 della seconda serie): lentezza non è assenza.
 * Una tabella ASSENTE o ILLEGGIBILE resta `giu`: senza di lei le route che la leggono cadono.
 */
export async function controlloSchema(supabase: SupabaseClient): Promise<Controllo> {
    return misura('schema-atteso', 'degradato', async () => {
        const letture = await Promise.all(
            TABELLE_ATTESE.map(async (tabella) => {
                // PostgREST NON lancia: ritorna `{ data, error }` (AGENTS, regola 7).
                const { error } = await supabase.from(tabella).select('id').limit(1)
                return { tabella, error }
            }),
        )
        const assenti: string[] = []
        const illeggibili: string[] = []
        for (const { tabella, error } of letture) {
            if (!error) continue
            // Si distingue «la tabella non c'è» da «la tabella c'è ma la query è caduta».
            // Sono due incidenti diversi che si riparano in due posti diversi: una
            // migrazione da applicare contro un database in affanno. Un controllo che li
            // fondesse manderebbe chi risponde all'allarme a cercare nel posto sbagliato.
            const codice = codiceDi(error)
            if (CODICI_TABELLA_ASSENTE.has(codice)) assenti.push(tabella)
            else illeggibili.push(`${tabella}:${codice}`)
        }
        if (assenti.length > 0) {
            return { esito: 'giu', dettaglio: `tabelle assenti: ${assenti.join(',')}` }
        }
        if (illeggibili.length > 0) {
            return { esito: 'giu', dettaglio: `tabelle illeggibili: ${illeggibili.join(' ')}` }
        }
        return { esito: 'ok', dettaglio: `${TABELLE_ATTESE.length} tabelle presenti` }
    })
}
```

E sostituisci il commento delle righe 129-146 (da `/**` con «PERCHÉ NON `to_regclass()`» fino a `*/` sopra `const CODICI_TABELLA_ASSENTE`) con:

```ts
/**
 * PERCHÉ NON `to_regclass()`, che sarebbe la via ovvia.
 *
 * `to_regclass()` è SQL: da PostgREST si raggiunge solo con una funzione RPC, e una RPC nuova
 * arriva con una migrazione — un controllo che nasce cieco finché qualcuno non la applica, il che
 * è un modo notevole di fallire proprio nel compito di accorgersi che qualcosa non è stato
 * applicato.
 *
 * La sonda da PostgREST è anche PIÙ FORTE, e questa è la vera ragione: misura la vista che
 * l'APPLICAZIONE ha dello schema, non quella del superuser. Una tabella che c'è nel catalogo ma
 * non nella schema cache di PostgREST, per il codice di questo repo NON esiste — risponde
 * `PGRST205`, che è esattamente ciò che produce una migrazione mancante.
 *
 * ⚠️ UNA `GET`, NON UNA `HEAD` (sessione 7 della seconda serie, {OGGI}). Fino ad allora la sonda
 * era `select('id', { head: true, count: 'exact' })`. Una HEAD non ha corpo, e postgrest-js (2.112)
 * rende un 404 SENZA corpo come `status 204` con `error: null`: il `PGRST205` sta nel corpo che la
 * HEAD non porta, quindi il controllo non avrebbe visto la tabella assente per cui esiste. Lo
 * prova `__tests__/lib/health/schema-atteso.test.ts`, con il client vero e un `fetch` finto. Il
 * `count: 'exact'` faceva in più contare le righe di cinque tabelle a ogni richiesta, per niente.
 * Ora: una `GET ?select=id&limit=1` per tabella, tutte e cinque in parallelo. Torna al più un uuid
 * per tabella, che il controllo non legge e non rilancia.
 */
```

- [ ] **Passo 4: lancia i test, verdi**

```bash
npx vitest run __tests__/lib/health/schema-atteso.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts 2>&1 | tail -10
npx eslint src/lib/health/controlli.ts __tests__/lib/health/schema-atteso.test.ts --max-warnings 0
```

Atteso: `Test Files  3 passed`; il test esistente «una tabella dello schema atteso assente porta lo stato a down» resta verde (assente = `giu`); eslint senza righe.

- [ ] **Passo 5: commit**

```bash
git add src/lib/health/controlli.ts __tests__/lib/health/schema-atteso.test.ts
git commit -m "Salute: lo schema si legge con una GET in parallelo, e la lentezza non è più «giù»" -m "La HEAD con count:'exact' non vedeva una tabella assente (404 senza corpo → 204 senza errore in postgrest-js); ora cinque GET select=id limit=1 in parallelo. Tetto o eccezione → degradato; tabella assente o illeggibile → giu come prima." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 4 — `config` guarda tutte le variabili critiche

**File:**
- Modifica: `src/lib/health/controlli.ts` (`VARIABILI_CRITICHE`, righe 512-534; `valoriCritici`, righe 992-1002)
- Modifica: `src/instrumentation.ts` (testata di `variabiliCritiche`, righe 47-67; elenco, righe 69-84)
- Modifica: `__tests__/api/health.test.ts` (un caso nuovo)

I nomi che entrano sono `{NOMI_AGGIUNTI}`: quelli dei sette — `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_APP_URL`, `ANTHROPIC_API_KEY` — che il Passo 0.5 ha trovato **in Production e in Preview**. Il codice qui sotto li ha tutti e sette: un nome escluso dal Passo 0.5 si toglie dalle quattro liste (test, `VARIABILI_CRITICHE`, `valoriCritici`, `variabiliCritiche`) e il commento dice perché.

- [ ] **Passo 1: il test**

In `__tests__/api/health.test.ts`, subito dopo il test `"una variabile impostata a stringa vuota è assente: `''` non configura niente"`, aggiungi:

```ts
    it('config guarda anche i canali push, il link dell’app e la traduzione; gli interruttori no', () => {
        // Sessione 7 della seconda serie: «controlloConfig guarda tutte le variabili critiche».
        // Critiche = la loro assenza è un guasto SILENZIOSO (vedi la testata di VARIABILI_CRITICHE).
        for (const nome of [
            'FCM_PROJECT_ID',
            'FCM_CLIENT_EMAIL',
            'FCM_PRIVATE_KEY',
            'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
            'VAPID_PRIVATE_KEY',
            'NEXT_PUBLIC_APP_URL',
            'ANTHROPIC_API_KEY',
        ]) {
            expect(VARIABILI_CRITICHE, `${nome} manca dalle variabili critiche`).toContain(nome)
        }
        // Fuori, ciascuna con la sua ragione scritta accanto all'elenco.
        for (const nome of [
            'NEXT_PUBLIC_SUPABASE_ANON_KEY',
            'OTP_TICKET_SECRET',
            'VAPID_SUBJECT',
            'ARUBA_USERNAME',
            'SIDI_USERNAME',
            'SIDI_PASSWORD',
            'ALLOW_HEADER_IDENTITY',
            'PARENT_READS_USE_SESSION',
            'KV_LOG_LEVEL',
            'NEXT_PUBLIC_CARICAMENTI_NATIVI',
        ]) {
            expect(VARIABILI_CRITICHE, `${nome} non è una variabile critica: vedi il commento`).not.toContain(nome)
        }
    })
```

- [ ] **Passo 2: lancia il test, rosso**

```bash
npx vitest run __tests__/api/health.test.ts -t "config guarda anche" 2>&1 | tail -8
```

Atteso: 1 rosso, `FCM_PROJECT_ID manca dalle variabili critiche`.

- [ ] **Passo 3: le variabili**

In `src/lib/health/controlli.ts`, dentro `VARIABILI_CRITICHE`, sostituisci la riga finale `    'ARUBA_PASSWORD',` (quella subito prima di `] as const`) con:

```ts
    'ARUBA_PASSWORD',
    // Dal {OGGI} (sessione 7 della seconda serie di robustezza) i canali push, il link dell'app e
    // la traduzione. Senza le tre FCM nessuna notifica arriva ai telefoni (`fcmConfigured()` in
    // `src/lib/push/native-push.ts`), senza le due VAPID nessuna ai browser (`vapidConfigured()`
    // in `src/lib/push/web-push.ts`): il dispatcher le rimanda in silenzio, e `code-arretrate` lo
    // vede solo dopo 30 minuti. Senza `NEXT_PUBLIC_APP_URL` il link di accesso nelle email delle
    // credenziali diventa relativo (`/auth/login`), cioè inutilizzabile fuori dall'app. Senza
    // `ANTHROPIC_API_KEY` la traduzione della chat si spegne (`src/lib/translate/claude.ts`).
    // Sono qui perché il {OGGI} erano definite in Production E in Preview (`vercel env ls`, solo i
    // nomi): una variabile assente per scelta accenderebbe un allarme che suona da solo.
    //
    // FUORI, e perché — stesso criterio: la loro assenza non è un guasto silenzioso.
    //  · `NEXT_PUBLIC_SUPABASE_ANON_KEY`: se manca l'app esplode al primo clic (`instrumentation.ts`).
    //  · `OTP_TICKET_SECRET`: ripiega su `SUPABASE_SERVICE_ROLE_KEY` (`src/lib/auth/otp-ticket.ts:21`,
    //    `src/lib/allegati/sigillo.ts:59`), che è già qui.
    //  · `VAPID_SUBJECT`: ha un ripiego scritto (`src/lib/push/web-push.ts:50`).
    //  · `SIDI_*`: come `ARUBA_USERNAME`, la configurazione sta prima in banca dati
    //    (`src/lib/sidi/client.ts:50`); il SIDI la salute non lo sorveglia.
    //  · `ALLOW_HEADER_IDENTITY`, `PARENT_READS_USE_SESSION`, `KV_LOG_LEVEL`,
    //    `NEXT_PUBLIC_CARICAMENTI_NATIVI`: interruttori, la loro assenza è un valore.
    'FCM_PROJECT_ID',
    'FCM_CLIENT_EMAIL',
    'FCM_PRIVATE_KEY',
    'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'NEXT_PUBLIC_APP_URL',
    'ANTHROPIC_API_KEY',
```

In `valoriCritici()` sostituisci la riga `        ARUBA_PASSWORD: process.env.ARUBA_PASSWORD,` con:

```ts
        ARUBA_PASSWORD: process.env.ARUBA_PASSWORD,
        // Accesso STATICO, uno per uno: le `NEXT_PUBLIC_*` il bundler le sostituisce solo così.
        FCM_PROJECT_ID: process.env.FCM_PROJECT_ID,
        FCM_CLIENT_EMAIL: process.env.FCM_CLIENT_EMAIL,
        FCM_PRIVATE_KEY: process.env.FCM_PRIVATE_KEY,
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
        NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
```

In `src/instrumentation.ts`, dentro `variabiliCritiche()`, sostituisci la riga `        ['ARUBA_PASSWORD', process.env.ARUBA_PASSWORD],` con:

```ts
        ['ARUBA_PASSWORD', process.env.ARUBA_PASSWORD],
        // Dal {OGGI} (sessione 7 della seconda serie): canali push, link dell'app, traduzione.
        // La ragione di ciascuna, e di chi resta fuori, sta accanto alla copia in
        // `src/lib/health/controlli.ts` (`VARIABILI_CRITICHE`).
        ['FCM_PROJECT_ID', process.env.FCM_PROJECT_ID],
        ['FCM_CLIENT_EMAIL', process.env.FCM_CLIENT_EMAIL],
        ['FCM_PRIVATE_KEY', process.env.FCM_PRIVATE_KEY],
        ['NEXT_PUBLIC_VAPID_PUBLIC_KEY', process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY],
        ['VAPID_PRIVATE_KEY', process.env.VAPID_PRIVATE_KEY],
        ['NEXT_PUBLIC_APP_URL', process.env.NEXT_PUBLIC_APP_URL],
        ['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY],
```

e nella testata della funzione, dopo il punto di `LOG_HASH_SALT` (la riga che finisce con «per cui quell'hash esiste.»), aggiungi:

```ts
 *  · FCM_* (tre) e le due VAPID → le notifiche non arrivano, e il dispatcher le rimanda in
 *    silenzio;
 *  · NEXT_PUBLIC_APP_URL        → il link nelle email delle credenziali diventa relativo;
 *  · ANTHROPIC_API_KEY          → la traduzione della chat si spegne.
```

- [ ] **Passo 4: lancia i test, verdi**

```bash
npx vitest run __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts 2>&1 | tail -8
npx eslint src/lib/health/controlli.ts src/instrumentation.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  2 passed`. Il `it.each` di `VARIABILI_CRITICHE` ora prova anche le sette nuove una per una, il dettaglio dice `14 variabili presenti` e il lock «coincide con quello del preflight di instrumentation.ts» confronta le due copie. `tsc` senza righe: `valoriCritici` è un `Record` su tutti i nomi, e un nome dimenticato lì è un errore di tipo.

- [ ] **Passo 5: commit**

```bash
git add src/lib/health/controlli.ts src/instrumentation.ts __tests__/api/health.test.ts
git commit -m "Salute: config guarda anche push, link dell'app e traduzione" -m "Sette variabili in più in VARIABILI_CRITICHE e nel preflight d'avvio, solo quelle definite in Production e in Preview; quelle lasciate fuori hanno la ragione scritta accanto." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 5 — Le finestre dei cron e la decisione, senza I/O

**File:**
- Crea: `src/lib/health/valutazione.ts`
- Crea: `src/lib/health/cron-esiti.ts`
- Crea: `__tests__/lib/health/cron-esiti.test.ts`
- Crea: `__tests__/architecture/cadenze-cron-leggibili.test.ts`

- [ ] **Passo 1: i test della decisione**

Crea `__tests__/lib/health/cron-esiti.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
    MINUTI_CRON_ESITI_FERMO,
    finestraDaCadenza,
    finestraDaIntervallo,
    leggiRigheCronEsiti,
    valutaCronEsiti,
    type RigaCronEsito,
} from '@/lib/health/cron-esiti'

/**
 * GLI ESITI DEI CRON, LA DECISIONE (sessione 7 della seconda serie di robustezza).
 * Numeri letterali: se qualcuno allarga una finestra o cambia la regola, questi test lo vedono.
 */

const MIN = 60_000
const ORA = 60 * MIN
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')

function riga(
    job: string,
    cadenza: string,
    esito: RigaCronEsito['esito'],
    vistoFaMin: number | null,
    vivoFaMin: number | null,
): RigaCronEsito {
    return {
        job,
        cadenza,
        esito,
        vistoIl: vistoFaMin === null ? null : ADESSO - vistoFaMin * MIN,
        vivoIl: vivoFaMin === null ? null : ADESSO - vivoFaMin * MIN,
    }
}

const OGNI_MINUTO = riga('storici-stampe', '* * * * *', 'ok', 1, 1)

describe('finestraDaCadenza — quanto silenzio è ancora normale', () => {
    it.each([
        ['* * * * *', 31],
        ['*/5 * * * *', 35],
        ['*/10 * * * *', 40],
        ['1,6,11,16,21,26,31,36,41,46,51,56 * * * *', 35],
        ['3,13,23,33,43,53 * * * *', 40],
        ['7,12,17,22,27,37,42,47,52,57 * * * *', 40],
        ['4,14,24,34,44,54 * * * *', 40],
        ['*/30 * * * *', 120],
        ['2,32 * * * *', 120],
        ['27 * * * *', 180],
        ['0 6 * * *', 1560],
        ['10,20,30,40,50 8 * * *', 1520],
        ['17 4 * * 0', 10200],
        ['11 5 * * 1', 10200],
        ['35 4 1 * *', 44760],
        ['30 seconds', 30.5],
    ])('«%s» → %s minuti', (cadenza, minuti) => {
        expect(finestraDaCadenza(cadenza)).toBe(minuti * MIN)
    })

    it.each([
        ['0 0 1 1 *', 'un mese preciso'],
        ['0 9 * * 1-5', 'un intervallo di giorni della settimana'],
        ['0 8 31 * *', 'un giorno che non tutti i mesi hanno'],
        ['0 8 1 * 1', 'giorno del mese E della settimana'],
        ['@daily', 'una scorciatoia'],
        ['61 * * * *', 'un minuto che non esiste'],
        ['0 25 * * *', 'un’ora che non esiste'],
        ['*/0 * * * *', 'un passo nullo'],
        ['0 6 * *', 'quattro campi'],
        ['', 'niente'],
    ])('«%s» (%s) → nessuna finestra', (cadenza) => {
        expect(finestraDaCadenza(cadenza)).toBeNull()
    })

    it('finestraDaIntervallo: la cadenza più il triplo, con un margine fra 30 minuti e 2 ore', () => {
        expect(finestraDaIntervallo(1)).toBe(31 * MIN)
        expect(finestraDaIntervallo(10)).toBe(40 * MIN)
        expect(finestraDaIntervallo(15)).toBe(60 * MIN)
        expect(finestraDaIntervallo(40)).toBe(160 * MIN)
        expect(finestraDaIntervallo(1440)).toBe(1560 * MIN)
    })
})

describe('valutaCronEsiti — la regola', () => {
    it('nessun job letto: degradato, perché un cron.job vuoto non è «tutto bene»', () => {
        expect(valutaCronEsiti([], ADESSO)).toEqual({ esito: 'degradato', dettaglio: 'nessun job attivo letto da cron.job' })
    })

    it('nessuna data in nessuna riga: cron-esiti non ha mai scritto', () => {
        expect(valutaCronEsiti([riga('a', '* * * * *', null, null, null), riga('b', '0 6 * * *', null, null, null)], ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; nessun esito registrato: cron-esiti non ha mai scritto',
        })
    })

    it('la data più fresca ha più di 30 minuti: cron-esiti è fermo, e lo dice', () => {
        expect(MINUTI_CRON_ESITI_FERMO).toBe(30)
        expect(
            valutaCronEsiti([riga('storici-stampe', '* * * * *', 'ok', 31, 31), riga('notifiche-promemoria', '0 6 * * *', 'ok', 240, 240)], ADESSO),
        ).toEqual({ esito: 'degradato', dettaglio: '2 job attivi; cron-esiti fermo da 31 min' })
    })

    it('trenta minuti esatti non sono ancora «fermo»', () => {
        expect(valutaCronEsiti([riga('storici-stampe', '* * * * *', 'ok', 30, 30)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '1 job attivi',
        })
    })

    it('tutti dentro la finestra, mensili compresi: ok, con il numero dei job attivi', () => {
        const mensile = riga('notifiche-retention', '35 4 1 * *', 'ok', 27 * 24 * 60, 27 * 24 * 60)
        expect(valutaCronEsiti([OGNI_MINUTO, riga('notifiche-promemoria', '0 6 * * *', 'ok', 240, 240), mensile], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '3 job attivi',
        })
    })

    it('un giornaliero: 1560 minuti senza esito buono sono ancora dentro, 1561 no', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('notifiche-promemoria', '0 6 * * *', 'fallito', 240, 1560)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; ultimo esito fallito, ancora nella finestra: notifiche-promemoria',
        })
        expect(valutaCronEsiti([OGNI_MINUTO, riga('notifiche-promemoria', '0 6 * * *', 'fallito', 240, 1561)], ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: notifiche-promemoria',
        })
    })

    it('un timeout del client con la route viva conta come vivo, e si dice', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('push-dispatch', '*/5 * * * *', 'timeout', 2, 2)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; timeout del client, vivi: push-dispatch',
        })
    })

    it('un job nuovo, mai partito, è «in attesa», non un allarme', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('nuovo', '0 6 * * *', null, null, null)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; in attesa del primo esito: nuovo',
        })
    })

    it('un job partito e MAI riuscito è un allarme subito', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('mai-ok', '*/10 * * * *', 'fallito', 3, null)], ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: mai-ok',
        })
    })

    it('una cadenza che non si sa leggere si dice, senza allarme', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('strano', '0 9 * * 1-5', 'ok', 3, 3)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; cadenza non letta: strano',
        })
    })

    it('il dettaglio completo, nell’ordine: prima ciò che suona, poi ciò che si annota', () => {
        expect(
            valutaCronEsiti(
                [
                    OGNI_MINUTO,
                    riga('notifiche-promemoria', '0 6 * * *', 'fallito', 240, 27 * 60),
                    riga('fattura-sync', '*/30 * * * *', 'fallito', 5, 50),
                    riga('push-dispatch', '*/5 * * * *', 'timeout', 2, 2),
                    riga('nuovo', '0 6 * * *', null, null, null),
                    riga('strano', '0 9 * * 1-5', 'ok', 3, 3),
                ],
                ADESSO,
            ),
        ).toEqual({
            esito: 'degradato',
            dettaglio:
                '6 job attivi; senza un esito buono entro la finestra: notifiche-promemoria; ' +
                'ultimo esito fallito, ancora nella finestra: fattura-sync; timeout del client, vivi: push-dispatch; ' +
                'in attesa del primo esito: nuovo; cadenza non letta: strano',
        })
    })
})

describe('leggiRigheCronEsiti — la risposta della RPC', () => {
    it('legge le righe e converte le date', () => {
        expect(
            leggiRigheCronEsiti([
                { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', visto_il: '2026-10-20T09:59:00+00:00', vivo_il: '2026-10-20T09:59:00+00:00' },
                { job: 'nuovo', cadenza: '0 6 * * *', esito: null, visto_il: null, vivo_il: null },
            ]),
        ).toEqual([
            { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', vistoIl: ADESSO - MIN, vivoIl: ADESSO - MIN },
            { job: 'nuovo', cadenza: '0 6 * * *', esito: null, vistoIl: null, vivoIl: null },
        ])
    })

    it.each([
        ['non un elenco', { job: 'x' }],
        ['un job vuoto', [{ job: '', cadenza: '* * * * *', esito: 'ok', visto_il: null, vivo_il: null }]],
        ['un esito sconosciuto', [{ job: 'x', cadenza: '* * * * *', esito: 'succeeded', visto_il: null, vivo_il: null }]],
        ['una data illeggibile', [{ job: 'x', cadenza: '* * * * *', esito: 'ok', visto_il: 'ieri', vivo_il: null }]],
        ['una cadenza che non è testo', [{ job: 'x', cadenza: 5, esito: 'ok', visto_il: null, vivo_il: null }]],
        ['una riga nulla', [null]],
    ])('%s → illeggibile', (_caso, data) => {
        expect(leggiRigheCronEsiti(data)).toBeNull()
    })
})
```

Crea `__tests__/architecture/cadenze-cron-leggibili.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { finestraDaCadenza } from '@/lib/health/cron-esiti'

/**
 * LOCK · OGNI CADENZA DI `pg_cron` SCRITTA NEL REPO HA UNA FINESTRA.
 *
 * Il controllo `cron-esiti` di `/api/health` (sessione 7 della seconda serie) giudica ogni job
 * attivo con la finestra della sua cadenza (`finestraDaCadenza`). Una cadenza che quella funzione
 * non sa leggere finisce nel dettaglio come «cadenza non letta» e il job resta SENZA sorveglianza:
 * un allarme che non può suonare. Se questo lock è rosso, o si insegna la forma nuova a
 * `finestraDaCadenza` (con il suo test di numeri letterali), o si sceglie una cadenza che sa già
 * leggere. Il 20/10 le cadenze nel repo erano 31, tutte leggibili.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

const CADENZE = readdirSync(CARTELLA)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((file) =>
        [...readFileSync(join(CARTELLA, file), 'utf8').matchAll(/cron\.schedule\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/gi)].map(
            (m) => ({ file, job: m[1], cadenza: m[2] }),
        ),
    )

describe('lock · le cadenze dei cron si leggono', () => {
    it('le trova (senza, questo lock sarebbe verde sul vuoto)', () => {
        expect(CADENZE.length).toBeGreaterThanOrEqual(31)
    })

    it('🔴 ogni cadenza ha una finestra', () => {
        const illeggibili = CADENZE.filter((c) => finestraDaCadenza(c.cadenza) === null).map(
            (c) => `${c.job} «${c.cadenza}» (${c.file})`,
        )
        expect(
            illeggibili,
            `Queste cadenze non hanno una finestra in finestraDaCadenza (src/lib/health/cron-esiti.ts): ` +
                `il controllo cron-esiti non potrebbe mai dire che il job è fermo.\n${illeggibili.join('\n')}`,
        ).toEqual([])
    })
})
```

- [ ] **Passo 2: lancia i test, rossi**

```bash
npx vitest run __tests__/lib/health/cron-esiti.test.ts __tests__/architecture/cadenze-cron-leggibili.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  2 failed`, `Failed to resolve import "@/lib/health/cron-esiti"`.

- [ ] **Passo 3: `valutazione.ts`**

Crea `src/lib/health/valutazione.ts`:

```ts
/**
 * LE REGOLE COMUNI DEI CONTROLLI DELLA SESSIONE 7 (seconda serie di robustezza).
 *
 * Due regole, scritte in un posto solo perché valgono per cinque controlli (`cron-esiti`,
 * `storage`, `email`, `push`, `migrazioni`):
 *
 *  1. MAI `giu`. Un controllo nuovo dice al più `degradato` (HTTP 200): «qualcosa che nessuno
 *     vedrebbe è rotto». Il `503` resta di `db-lettura`, `auth` e `schema-atteso`, cioè di ciò
 *     senza cui nessuno entra; per `schema-atteso` solo se una tabella manca o non si legge, mai per
 *     lentezza. `db-lettura` e `auth` restano `giu` anche oltre il tetto di 2 s, ed è un'eccezione
 *     voluta (specifica, Sessione 7): sono i due controlli di `eseguiVivo`, cioè di
 *     `/api/health/vivo`, che risponde 200 su `degradato`; se il loro timeout scendesse a
 *     `degradato`, un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe
 *     più. Il tipo qui sotto non contiene `giu`, e il lock
 *     `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts` vieta di aggiungerlo.
 *  2. LA TOLLERANZA DEL MERGE. Una migrazione e il deploy che la usa partono insieme: per qualche
 *     minuto il codice nuovo chiede una funzione che PostgREST non conosce ancora (`PGRST202`),
 *     oppure il repo dichiara una migrazione che il database non ha ancora. Per
 *     `TOLLERANZA_MERGE_MS` dopo la build quella differenza è attesa e si dice `ok`, con il
 *     motivo nel dettaglio; dopo, è un'integrazione che non ha applicato, e si dice `degradato`.
 *     Fuori da una build (test, script) l'istante non c'è e non scade niente.
 *
 * I 30 minuti sono una SCELTA, non una misura: tre giri di `cron-esiti` (ogni 10 minuti) e margine
 * per l'integrazione Supabase, che applica le migrazioni al merge.
 */

export type EsitoSenzaGiu = 'ok' | 'degradato'

export interface Valutazione {
    esito: EsitoSenzaGiu
    dettaglio: string
}

export const TOLLERANZA_MERGE_MS = 30 * 60_000

/** Vero se una differenza fra repo e database è ancora attesa: build ignota o di al più 30 minuti fa. */
export function inAttesaDellIntegrazione(buildIl: number | null, adesso: number): boolean {
    return buildIl === null || adesso - buildIl <= TOLLERANZA_MERGE_MS
}
```

- [ ] **Passo 4: `cron-esiti.ts`**

Crea `src/lib/health/cron-esiti.ts`:

```ts
import type { Valutazione } from './valutazione'

/**
 * GLI ESITI DEI CRON, LETTI DA `pg_cron` E NON DAL BATTITO (sessione 7 della seconda serie).
 *
 * `cron-battito` guarda il battito che una route o una funzione scrive in `app_log`: vede solo i
 * job che lo scrivono, e non può guardare i mensili (`app_log` conserva 30 giorni, vedi
 * `JOB_CRON_NON_SORVEGLIATI`). La sessione 6 ha dato a ogni job una riga che non scade,
 * `cron_ultimo_esito`, aggiornata ogni 10 minuti dalla funzione `cron_esiti`; la RPC
 * `salute_cron_esiti` la porta qui con il nome e la cadenza di ogni job ATTIVO di `cron.job`.
 * Questo modulo decide, e non fa I/O.
 *
 * LA REGOLA. Un job è un allarme quando non ha avuto un esito BUONO dentro la finestra della sua
 * cadenza. Un fallimento solo, con un esito buono recente, si dice e non suona: un allarme che
 * suona per un giro andato storto viene spento. Un timeout del client di pg_net vale come vivo (la
 * route può aver finito lo stesso: è la riga `cron-http-timeout:<job>` della sessione 6). Un job HTTP
 * che chiama il server solo quando ha lavoro (dopo la sessione 8, `storici-stampe`) è vivo anche
 * quando la sua funzione SQL riesce senza chiamare, purché l'ultima chiamata non sia stata respinta:
 * lo decide la RPC, che lo mette in `vivo_il`. Un job
 * che non è mai partito è «in attesa»: `cron.job` non dice quando un job è nato, quindi non si può
 * distinguere un job di ieri da uno che non parte da un mese — si scrive, non si indovina.
 *
 * LA FINESTRA. Per un job frequente: la cadenza più il triplo, con un margine fra 30 minuti e 2 ore
 * (`finestraDaIntervallo`). Per un giornaliero 24 ore + 2, per un settimanale 7 giorni + 2 ore, per
 * un mensile 31 giorni + 2 ore. Una cadenza che non si sa leggere non ha finestra e finisce nel
 * dettaglio («cadenza non letta»): il lock `__tests__/architecture/cadenze-cron-leggibili.test.ts`
 * pretende che ogni `cron.schedule` del repo ne abbia una.
 */

const MIN = 60_000
const ORA = 60 * MIN
const GIORNO = 24 * ORA

export type EsitoCron = 'ok' | 'fallito' | 'timeout'

export interface RigaCronEsito {
    job: string
    cadenza: string
    /** L'esito dell'ultimo giro; `null` = nessun giro registrato, o chiamata ancora in attesa. */
    esito: EsitoCron | null
    /** Quando è avvenuto l'ultimo giro (ms). */
    vistoIl: number | null
    /** L'ultima volta che il job era VIVO (ms): ultimo successo; per un job HTTP anche l'ultimo timeout
     *  del client e l'ultima esecuzione SQL riuscita, se l'ultima chiamata non è stata respinta. */
    vivoIl: number | null
}

/** Oltre quanti minuti senza nessuna data nuova `cron-esiti` (il job della sessione 6) è fermo:
 *  tre giri da 10 minuti. Con un job che gira ogni minuto, una data più vecchia vuol dire che
 *  nessuno aggiorna più `cron_ultimo_esito`. */
export const MINUTI_CRON_ESITI_FERMO = 30

const ESITI_CRON: ReadonlySet<string> = new Set(['ok', 'fallito', 'timeout'])
const RE_PARTE = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/

/** La finestra di un job che gira ogni `minuti`: la cadenza più il triplo, margine fra 30 e 120. */
export function finestraDaIntervallo(minuti: number): number {
    return (minuti + Math.min(120, Math.max(30, 3 * minuti))) * MIN
}

/** I valori di un campo della cadenza (`*`, `5`, `1-5`, `*\/10`, `3-59/10`, separati da virgole). */
function espandi(campo: string, minimo: number, massimo: number): number[] | null {
    const valori = new Set<number>()
    for (const parte of campo.split(',')) {
        const m = RE_PARTE.exec(parte)
        if (!m) return null
        let da = minimo
        let a = massimo
        if (m[1] !== '*') {
            const estremi = m[1].split('-').map(Number)
            da = estremi[0]
            if (estremi.length === 2) a = estremi[1]
            else if (m[2] === undefined) a = estremi[0]
        }
        const passo = m[2] === undefined ? 1 : Number(m[2])
        if (passo < 1 || da < minimo || a > massimo || da > a) return null
        for (let v = da; v <= a; v += passo) valori.add(v)
    }
    return [...valori]
}

/** La finestra di una cadenza di `pg_cron` in millisecondi, o `null` se non si sa leggere. */
export function finestraDaCadenza(cadenza: string): number | null {
    const testo = cadenza.trim()
    const secondi = /^(\d+) seconds$/.exec(testo)
    if (secondi) {
        const n = Number(secondi[1])
        return n >= 1 && n <= 59 ? finestraDaIntervallo(n / 60) : null
    }
    const campi = testo.split(/\s+/)
    if (campi.length !== 5) return null
    const [minuti, ore, giornoMese, mese, giornoSettimana] = campi
    if (mese !== '*') return null
    if (giornoMese !== '*' && giornoSettimana !== '*') return null
    const valoriMinuti = espandi(minuti, 0, 59)
    const valoriOre = espandi(ore, 0, 23)
    if (valoriMinuti === null || valoriOre === null) return null
    if (giornoSettimana !== '*') return /^[0-7]$/.test(giornoSettimana) ? 7 * GIORNO + 2 * ORA : null
    if (giornoMese !== '*') {
        const giorno = /^\d+$/.test(giornoMese) ? Number(giornoMese) : 0
        return giorno >= 1 && giorno <= 28 ? 31 * GIORNO + 2 * ORA : null
    }
    // Ogni giorno: il salto più lungo fra due istanti consecutivi, giro della mezzanotte compreso.
    const istanti = [...new Set(valoriOre.flatMap((h) => valoriMinuti.map((m) => h * 60 + m)))].sort((x, y) => x - y)
    let salto = 0
    istanti.forEach((t, i) => {
        const prossimo = i + 1 < istanti.length ? istanti[i + 1] : istanti[0] + 24 * 60
        salto = Math.max(salto, prossimo - t)
    })
    return finestraDaIntervallo(salto)
}

/** Un istante ISO in millisecondi; `null` se assente; `undefined` se c'è ma non si legge. */
function istante(valore: unknown): number | null | undefined {
    if (valore === null || valore === undefined) return null
    if (typeof valore !== 'string') return undefined
    const t = Date.parse(valore)
    return Number.isNaN(t) ? undefined : t
}

/** Le righe di `salute_cron_esiti`, o `null` se una sola non ha la forma attesa. */
export function leggiRigheCronEsiti(data: unknown): RigaCronEsito[] | null {
    if (!Array.isArray(data)) return null
    const righe: RigaCronEsito[] = []
    for (const grezza of data) {
        if (grezza === null || typeof grezza !== 'object') return null
        const r = grezza as Record<string, unknown>
        if (typeof r.job !== 'string' || r.job === '') return null
        if (typeof r.cadenza !== 'string') return null
        const esito = r.esito ?? null
        if (esito !== null && (typeof esito !== 'string' || !ESITI_CRON.has(esito))) return null
        const vistoIl = istante(r.visto_il)
        const vivoIl = istante(r.vivo_il)
        if (vistoIl === undefined || vivoIl === undefined) return null
        righe.push({ job: r.job, cadenza: r.cadenza, esito: esito as EsitoCron | null, vistoIl, vivoIl })
    }
    return righe
}

/** La decisione. Il dettaglio porta solo nomi di job e numeri. */
export function valutaCronEsiti(righe: readonly RigaCronEsito[], adesso: number): Valutazione {
    const n = righe.length
    if (n === 0) return { esito: 'degradato', dettaglio: 'nessun job attivo letto da cron.job' }

    const date = righe.flatMap((r) => [r.vistoIl, r.vivoIl]).filter((t): t is number => t !== null)
    if (date.length === 0) {
        return { esito: 'degradato', dettaglio: `${n} job attivi; nessun esito registrato: cron-esiti non ha mai scritto` }
    }
    const silenzio = adesso - Math.max(...date)
    if (silenzio > MINUTI_CRON_ESITI_FERMO * MIN) {
        return { esito: 'degradato', dettaglio: `${n} job attivi; cron-esiti fermo da ${Math.floor(silenzio / MIN)} min` }
    }

    const senzaEsitoBuono: string[] = []
    const falliti: string[] = []
    const timeout: string[] = []
    const inAttesa: string[] = []
    const senzaCadenza: string[] = []
    for (const r of righe) {
        const finestra = finestraDaCadenza(r.cadenza)
        if (finestra === null) {
            senzaCadenza.push(r.job)
            continue
        }
        if (r.vivoIl === null && r.esito === null) {
            inAttesa.push(r.job)
            continue
        }
        if (r.vivoIl === null || adesso - r.vivoIl > finestra) {
            senzaEsitoBuono.push(r.job)
            continue
        }
        if (r.esito === 'fallito') falliti.push(r.job)
        else if (r.esito === 'timeout') timeout.push(r.job)
    }

    const parti = [`${n} job attivi`]
    if (senzaEsitoBuono.length > 0) parti.push(`senza un esito buono entro la finestra: ${senzaEsitoBuono.join(',')}`)
    if (falliti.length > 0) parti.push(`ultimo esito fallito, ancora nella finestra: ${falliti.join(',')}`)
    if (timeout.length > 0) parti.push(`timeout del client, vivi: ${timeout.join(',')}`)
    if (inAttesa.length > 0) parti.push(`in attesa del primo esito: ${inAttesa.join(',')}`)
    if (senzaCadenza.length > 0) parti.push(`cadenza non letta: ${senzaCadenza.join(',')}`)
    return { esito: senzaEsitoBuono.length > 0 ? 'degradato' : 'ok', dettaglio: parti.join('; ') }
}
```

- [ ] **Passo 5: lancia i test, verdi**

```bash
npx vitest run __tests__/lib/health/cron-esiti.test.ts __tests__/architecture/cadenze-cron-leggibili.test.ts 2>&1 | tail -8
npx eslint src/lib/health/valutazione.ts src/lib/health/cron-esiti.ts __tests__/lib/health/cron-esiti.test.ts __tests__/architecture/cadenze-cron-leggibili.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  2 passed`; eslint e tsc senza righe. Se il lock delle cadenze è rosso, la riga nomina job, cadenza e file: si insegna la forma a `finestraDaCadenza` con un caso letterale in più nel primo `it.each`, mai togliendo il lock.

- [ ] **Passo 6: commit**

```bash
git add src/lib/health/valutazione.ts src/lib/health/cron-esiti.ts __tests__/lib/health/cron-esiti.test.ts __tests__/architecture/cadenze-cron-leggibili.test.ts
git commit -m "Salute: le finestre di ogni cadenza di pg_cron e la regola degli esiti, senza I/O" -m "Un job è un allarme solo se non ha un esito buono dentro la finestra della sua cadenza; mensili compresi. Lock: ogni cron.schedule del repo ha una finestra." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 6 — La migrazione: due RPC di sola lettura

**File:**
- Crea: `supabase/migrations/{VERSIONE}_salute_rpc_sola_lettura.sql`
- Crea: `__tests__/lib/salute-rpc-sql.test.ts`

- [ ] **Passo 1: il test su un Postgres vero (PGlite)**

Crea `__tests__/lib/salute-rpc-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { leggiRigheCronEsiti, valutaCronEsiti } from '@/lib/health/cron-esiti'

/**
 * LE DUE RPC DELLA SALUTE (sessione 7 della seconda serie) PROVATE SU UN POSTGRES VERO.
 *
 * `cron.job` e `supabase_migrations.schema_migrations` sono finte (PGlite non ha pg_cron) ma con le
 * colonne vere; `cron_ultimo_esito` NON è finta: il `CREATE TABLE` si prende dal file della
 * migrazione della sessione 6. Se la 6 cambia una colonna che la RPC legge, questo test diventa
 * rosso qui e non in produzione.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

function migrazione(suffisso: string): string {
    const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
    if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
    return readFileSync(join(CARTELLA, file), 'utf8')
}

const MIGRAZIONE = migrazione('_salute_rpc_sola_lettura.sql')

const TABELLA_DELLA_SESSIONE_6 = (() => {
    const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.cron_ultimo_esito\s*\([\s\S]*?\n\);/i.exec(
        migrazione('_cron_esiti_osservati.sql'),
    )
    if (!m) throw new Error('CREATE TABLE public.cron_ultimo_esito non trovato nella migrazione della sessione 6')
    return m[0]
})()

const RUOLI = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
`

async function codiceErrore(db: PGlite, sql: string): Promise<string | null> {
    try {
        await db.exec(sql)
        return null
    } catch (e) {
        return (e as { code?: string }).code ?? 'errore'
    }
}

let db: PGlite

beforeAll(async () => {
    db = new PGlite()
    await db.exec(RUOLI)
    await db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (
        jobid    bigserial PRIMARY KEY,
        schedule text NOT NULL,
        command  text NOT NULL,
        jobname  text,
        active   boolean NOT NULL DEFAULT true
      );
      CREATE SCHEMA supabase_migrations;
      CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL, name text);
    `)
    await db.exec(TABELLA_DELLA_SESSIONE_6)
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
    await db.exec(`
      INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
        (1, '*/10 * * * *', 'select 1', 'job-ok-http', true),
        (2, '*/10 * * * *', 'select 1', 'job-500', true),
        (3, '*/10 * * * *', 'select 1', 'job-rete', true),
        (4, '*/10 * * * *', 'select 1', 'job-timeout', true),
        (5, '*/10 * * * *', 'select 1', 'job-attesa', true),
        (6, '0 6 * * *', 'select 1', 'job-sql-ok', true),
        (7, '0 6 * * *', 'select 1', 'job-sql-ko', true),
        (8, '0 6 * * *', 'select 1', 'job-nuovo', true),
        (9, '0 6 * * *', 'select 1', 'job-spento', false),
        (99, '35 4 1 * *', 'select 1', NULL, true);
      INSERT INTO public.cron_ultimo_esito
        (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
      VALUES
        ('job-ok-http', true,  '2026-10-20 09:55+00', 'ok',          '2026-10-20 09:55+00', 'succeeded', '2026-10-20 09:55+00'),
        ('job-500',     true,  '2026-10-20 09:57+00', 'errore-http', '2026-10-20 09:57+00', 'succeeded', '2026-10-20 09:20+00'),
        ('job-rete',    true,  '2026-10-20 09:56+00', 'errore-rete', '2026-10-20 09:56+00', 'succeeded', NULL),
        ('job-timeout', true,  '2026-10-20 09:58+00', 'timeout',     '2026-10-20 09:58+00', 'succeeded', '2026-10-20 08:20+00'),
        ('job-attesa',  true,  '2026-10-20 09:59+00', 'in-attesa',   '2026-10-20 09:59+00', 'succeeded', '2026-10-20 09:49+00'),
        ('job-sql-ok',  false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('job-sql-ko',  false, NULL, NULL, '2026-10-20 06:00+00', 'failed',    '2026-10-19 06:00+00'),
        ('job-spento',  false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('jobid-99',    false, NULL, NULL, '2026-10-01 04:35+00', 'succeeded', '2026-10-01 04:35+00');
    `)
})

afterAll(async () => {
    await db.close()
})

describe('salute_cron_esiti', () => {
    it('un job attivo per riga, con la chiave della sessione 6; per un job HTTP conta la chiamata, per uno SQL il giro', async () => {
        const { rows } = await db.query(`
          SELECT job, cadenza, esito,
                 to_char(visto_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS visto,
                 to_char(vivo_il  AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti()
           ORDER BY job COLLATE "C"`)
        expect(rows).toEqual([
            { job: 'job-500', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:57', vivo: '10-20 09:20' },
            // La chiamata delle 09:59 non ha ancora un esito, ma la funzione SQL che l'ha mandata è riuscita: vivo.
            { job: 'job-attesa', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: '10-20 09:59' },
            { job: 'job-nuovo', cadenza: '0 6 * * *', esito: null, visto: null, vivo: null },
            { job: 'job-ok-http', cadenza: '*/10 * * * *', esito: 'ok', visto: '10-20 09:55', vivo: '10-20 09:55' },
            { job: 'job-rete', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:56', vivo: null },
            { job: 'job-sql-ko', cadenza: '0 6 * * *', esito: 'fallito', visto: '10-20 06:00', vivo: '10-19 06:00' },
            { job: 'job-sql-ok', cadenza: '0 6 * * *', esito: 'ok', visto: '10-20 06:00', vivo: '10-20 06:00' },
            { job: 'job-timeout', cadenza: '*/10 * * * *', esito: 'timeout', visto: '10-20 09:58', vivo: '10-20 09:58' },
            { job: 'jobid-99', cadenza: '35 4 1 * *', esito: 'ok', visto: '10-01 04:35', vivo: '10-01 04:35' },
        ])
    })
})

describe('vivo_il di un job HTTP che chiama solo quando ha lavoro', () => {
    // Dopo la sessione 8 `storici_tick` (job `storici-stampe`, ogni minuto) chiama
    // /api/admin/storici/cron solo se c'è una stampa in coda: con la coda vuota la funzione SQL gira
    // e riesce, e nessuna chiamata parte. Per la sessione 6 `ultimo_ok_il` di un job HTTP cambia solo
    // con le chiamate, e `http` non torna mai false: senza l'ultima esecuzione SQL riuscita in
    // `vivo_il`, due ore di coda vuota sarebbero un allarme. `cron-esiti` (sola SQL, 09:54) è il
    // testimone della freschezza: senza, la salute direbbe «cron-esiti fermo» per la ragione sbagliata.
    const ADESSO = Date.parse('2026-10-20T10:00:00Z')

    async function banco(ultimaChiamataEsito: 'ok' | 'errore-http' | 'timeout'): Promise<PGlite> {
        const b = new PGlite()
        await b.exec(RUOLI)
        await b.exec(`
          CREATE SCHEMA cron;
          CREATE TABLE cron.job (
            jobid    bigserial PRIMARY KEY,
            schedule text NOT NULL,
            command  text NOT NULL,
            jobname  text,
            active   boolean NOT NULL DEFAULT true
          );
        `)
        await b.exec(TABELLA_DELLA_SESSIONE_6)
        await b.exec(MIGRAZIONE)
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
            (1, '* * * * *', 'select 1', 'storici-stampe', true),
            (2, '4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true);
        `)
        await b.query(
            `INSERT INTO public.cron_ultimo_esito
               (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
             VALUES
               ('storici-stampe', true, '2026-10-20 07:58+00', $1, '2026-10-20 09:59+00', 'succeeded', '2026-10-20 07:50+00'),
               ('cron-esiti', false, NULL, NULL, '2026-10-20 09:54+00', 'succeeded', '2026-10-20 09:54+00')`,
            [ultimaChiamataEsito],
        )
        return b
    }

    /** La riga di `storici-stampe` come la leggono le persone: minuti UTC. */
    async function storici(b: PGlite): Promise<unknown[]> {
        const { rows } = await b.query(`
          SELECT job, esito,
                 to_char(visto_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS visto,
                 to_char(vivo_il  AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti() WHERE job = 'storici-stampe'`)
        return rows
    }

    /** Le righe come le porta PostgREST (istanti in testo ISO), passate alla decisione vera. */
    async function decisione(b: PGlite) {
        const { rows } = await b.query(`
          SELECT job, cadenza, esito,
                 to_json(visto_il) #>> '{}' AS visto_il,
                 to_json(vivo_il)  #>> '{}' AS vivo_il
            FROM public.salute_cron_esiti()
           ORDER BY job COLLATE "C"`)
        const righe = leggiRigheCronEsiti(rows)
        expect(righe).not.toBeNull()
        return valutaCronEsiti(righe ?? [], ADESSO)
    }

    it('coda vuota da due ore, la funzione SQL riesce ogni minuto: vivo all’ultima esecuzione, e la salute dice ok', async () => {
        const b = await banco('ok')
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ok', visto: '10-20 07:58', vivo: '10-20 09:59' }])
        expect(await decisione(b)).toEqual({ esito: 'ok', dettaglio: '2 job attivi' })
        await b.close()
    })

    it('l’ultima chiamata è stata respinta (errore-http): le esecuzioni SQL riuscite non la coprono, e la salute dice degradato', async () => {
        const b = await banco('errore-http')
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'fallito', visto: '10-20 07:58', vivo: '10-20 07:50' }])
        expect(await decisione(b)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('un timeout del client resta vivo, come vuole la regola del modulo: le esecuzioni SQL riuscite dopo lo coprono', async () => {
        const b = await banco('timeout')
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'timeout', visto: '10-20 07:58', vivo: '10-20 09:59' }])
        expect(await decisione(b)).toEqual({ esito: 'ok', dettaglio: '2 job attivi; timeout del client, vivi: storici-stampe' })
        await b.close()
    })
})

describe('salute_migrazioni', () => {
    it('la versione più alta e il numero delle righe; una riga doppia cambia il numero, non la versione', async () => {
        await db.exec(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
          ('20261001000000', 'a'), ('20261020000000', 'c'), ('20261010000000', 'b')`)
        expect((await db.query('SELECT * FROM public.salute_migrazioni()')).rows).toEqual([
            { ultima: '20261020000000', numero: 3 },
        ])

        await db.exec(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261010000000', 'b')`)
        expect((await db.query('SELECT * FROM public.salute_migrazioni()')).rows).toEqual([
            { ultima: '20261020000000', numero: 4 },
        ])
    })
})

describe('le due funzioni', () => {
    it('le chiama solo service_role', async () => {
        const { rows } = await db.query(`
          SELECT r AS ruolo,
                 has_function_privilege(r, 'public.salute_cron_esiti()', 'EXECUTE') AS cron,
                 has_function_privilege(r, 'public.salute_migrazioni()', 'EXECUTE') AS migrazioni
            FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
           ORDER BY r`)
        expect(rows).toEqual([
            { ruolo: 'anon', cron: false, migrazioni: false },
            { ruolo: 'authenticated', cron: false, migrazioni: false },
            { ruolo: 'service_role', cron: true, migrazioni: true },
        ])
    })

    it('SECURITY DEFINER, STABLE, con search_path vuoto', async () => {
        const { rows } = await db.query<{ proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(`
          SELECT proname, prosecdef, provolatile, proconfig
            FROM pg_proc WHERE proname IN ('salute_cron_esiti', 'salute_migrazioni') ORDER BY proname`)
        expect(rows.map((r) => [r.proname, r.prosecdef, r.provolatile])).toEqual([
            ['salute_cron_esiti', true, 's'],
            ['salute_migrazioni', true, 's'],
        ])
        for (const r of rows) expect(r.proconfig?.[0]).toMatch(/^search_path=(""|)$/)
    })

    it('senza le tabelle di pg_cron e di supabase_migrations la migrazione si applica e la chiamata alza P0001', async () => {
        // È il database della CI: la migrazione deve passare, e la salute deve vedere il guasto.
        const vuoto = new PGlite()
        await vuoto.exec(RUOLI)
        await vuoto.exec(MIGRAZIONE)
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_migrazioni()')).toBe('P0001')
        await vuoto.close()
    })
})
```

- [ ] **Passo 2: lancia il test, rosso**

```bash
npx vitest run __tests__/lib/salute-rpc-sql.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 failed`, `migrazione *_salute_rpc_sola_lettura.sql non trovata`.

- [ ] **Passo 3: la migrazione**

```bash
date -u +%Y%m%d%H%M%S
```

L'output è `{VERSIONE}`. Crea `supabase/migrations/{VERSIONE}_salute_rpc_sola_lettura.sql`:

```sql
-- =============================================================================
-- LE DUE LETTURE DELLA SALUTE — {OGGI}
--
-- Sessione 7 della seconda serie di robustezza («la salute vede tutto, senza falsi giù»).
-- Due funzioni di SOLA LETTURA per `/api/health`, eseguibili solo da service_role:
--
--   · salute_cron_esiti() — per ogni job ATTIVO di cron.job: il nome (coalesce(jobname,
--     'jobid-' || jobid), la stessa chiave della sessione 6), la cadenza, l'esito dell'ultimo giro
--     ('ok', 'fallito', 'timeout' o NULL), l'istante dell'ultimo giro e l'ultimo istante in cui il
--     job era VIVO (ultimo successo; per un job HTTP anche l'ultimo timeout del client, perché la
--     route può aver finito lo stesso, e l'ultima esecuzione SQL riuscita se l'ultima chiamata non
--     è stata respinta, perché un job che chiama solo quando ha lavoro può non chiamare per ore).
--     Legge public.cron_ultimo_esito, scritta ogni 10 minuti dalla funzione cron_esiti() della
--     sessione 6: per un job HTTP l'esito è quello della chiamata al server, per uno SQL il giro.
--   · salute_migrazioni() — max(version) e count(*) di supabase_migrations.schema_migrations: il
--     controllo `migrazioni` li confronta con l'ultima migrazione del repo, fissata alla build.
--
-- Nessuna tabella, nessuna colonna, nessuna riga scritta, nemmeno in app_log. Nomi di job, cadenze
-- e date: mai dati di persone. Il corpo è plpgsql e cerca le tabelle A RUNTIME (to_regclass): la
-- migrazione si applica anche dove pg_cron non c'è (il database della CI), e lì la chiamata alza
-- un'eccezione (P0001) che il controllo traduce in `degradato`.
--
-- ─── COME SI VERIFICA ───────────────────────────────────────────
--   SELECT count(*) FROM public.salute_cron_esiti();   -- uguale a: SELECT count(*) FROM cron.job WHERE active
--   SELECT * FROM public.salute_migrazioni();          -- ultima = la version di questo file
--   has_function_privilege di anon e authenticated: false; di service_role: true.
--   Nel repo: __tests__/lib/salute-rpc-sql.test.ts (PGlite, migrazione applicata due volte).
--
-- ─── ROLLBACK ──────────────────────────────────────────────
--   Solo dentro una PR di revert, mai a mano (schema_migrations resterebbe disallineato, e il
--   controllo `migrazioni` lo direbbe): una migrazione nuova con
--     DROP FUNCTION IF EXISTS public.salute_cron_esiti();
--     DROP FUNCTION IF EXISTS public.salute_migrazioni();
--     NOTIFY pgrst, 'reload schema';
--   Lasciarle in piedi è innocuo: leggono e basta, e solo service_role può chiamarle.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.salute_cron_esiti()
RETURNS TABLE (job text, cadenza text, esito text, visto_il timestamptz, vivo_il timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF to_regclass('cron.job') IS NULL OR to_regclass('public.cron_ultimo_esito') IS NULL THEN
    RAISE EXCEPTION 'salute_cron_esiti: cron.job o public.cron_ultimo_esito assente';
  END IF;

  RETURN QUERY
  SELECT coalesce(j.jobname::text, 'jobid-' || j.jobid::text),
         j.schedule::text,
         (CASE
            WHEN u.job IS NULL THEN NULL
            WHEN u.http AND u.ultima_chiamata_esito = 'timeout' THEN 'timeout'
            WHEN u.http AND u.ultima_chiamata_esito IN ('errore-http', 'errore-rete') THEN 'fallito'
            WHEN u.http AND u.ultima_chiamata_esito = 'ok' THEN 'ok'
            WHEN NOT u.http AND u.ultima_esecuzione_stato = 'failed' THEN 'fallito'
            WHEN NOT u.http AND u.ultima_esecuzione_stato = 'succeeded' THEN 'ok'
            ELSE NULL
          END)::text,
         CASE WHEN u.http THEN u.ultima_chiamata_il ELSE u.ultima_esecuzione_il END,
         -- Vivo: l'ultimo successo; per un job HTTP anche l'ultimo timeout del client (la route può
         -- aver finito lo stesso) e l'ultima esecuzione SQL riuscita, purché la sua ultima chiamata
         -- non sia stata respinta: dopo la sessione 8 `storici_tick` chiama il server solo se c'è
         -- lavoro, e per la sessione 6 `ultimo_ok_il` di un job HTTP cambia solo con le chiamate.
         GREATEST(u.ultimo_ok_il,
                  CASE WHEN u.http AND u.ultima_chiamata_esito = 'timeout' THEN u.ultima_chiamata_il END,
                  CASE WHEN u.http AND u.ultima_esecuzione_stato = 'succeeded'
                            AND coalesce(u.ultima_chiamata_esito, 'ok') NOT IN ('errore-http', 'errore-rete')
                       THEN u.ultima_esecuzione_il END)
    FROM cron.job AS j
    LEFT JOIN public.cron_ultimo_esito AS u
      ON u.job = coalesce(j.jobname::text, 'jobid-' || j.jobid::text)
   WHERE j.active
   ORDER BY 1;
END;
$$;

COMMENT ON FUNCTION public.salute_cron_esiti() IS
  'Sola lettura per /api/health (controllo cron-esiti): un job attivo di cron.job per riga, con cadenza, esito dell''ultimo giro, istante dell''ultimo giro e ultimo istante da vivo, da cron_ultimo_esito (sessione 6). Solo service_role. Sessione 7 della seconda serie di robustezza.';

CREATE OR REPLACE FUNCTION public.salute_migrazioni()
RETURNS TABLE (ultima text, numero integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'salute_migrazioni: supabase_migrations.schema_migrations assente';
  END IF;

  RETURN QUERY
  SELECT max(m.version)::text, count(*)::integer
    FROM supabase_migrations.schema_migrations AS m;
END;
$$;

COMMENT ON FUNCTION public.salute_migrazioni() IS
  'Sola lettura per /api/health (controllo migrazioni): la version più alta e il numero delle righe di supabase_migrations.schema_migrations. Solo service_role. Sessione 7 della seconda serie di robustezza.';

REVOKE ALL ON FUNCTION public.salute_cron_esiti() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salute_migrazioni() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salute_cron_esiti() TO service_role;
GRANT EXECUTE ON FUNCTION public.salute_migrazioni() TO service_role;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Passo 4: lancia il test e le guardie delle migrazioni, verdi**

```bash
npx vitest run __tests__/lib/salute-rpc-sql.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -10
grep -inE 'unique|primary key|references (public\.)?utenti|(add|drop) constraint|policy|row level security|drop table' supabase/migrations/*_salute_rpc_sola_lettura.sql
```

Atteso: `Test Files  4 passed` (`migrazioni-complete` tollera la migrazione nuova «in coda», dopo l'ultima della fotografia); il `grep` senza righe. Se una guardia di `soglia-fotografia` la vede comunque, si dichiara in `MIGRAZIONI_ATTESE_AL_MERGE` con la ragione, come le voci del 19/10.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_salute_rpc_sola_lettura.sql __tests__/lib/salute-rpc-sql.test.ts
git commit -m "Salute: due RPC di sola lettura, esiti dei cron e versione delle migrazioni" -m "salute_cron_esiti() legge cron.job e cron_ultimo_esito (sessione 6), salute_migrazioni() max(version) e count(*); SECURITY DEFINER, search_path vuoto, solo service_role; P0001 dove le tabelle mancano. Provate su PGlite con il CREATE TABLE vero della sessione 6." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 7 — Il controllo `cron-esiti`, e due job in più sotto `cron-battito`

**File:**
- Modifica: `src/lib/health/controlli.ts` (import, righe 1-3; tabella di `JOB_CRON`, righe 156-177; fondo di `JOB_CRON`, prima della `]` della riga 358; testata e voci di `JOB_CRON_NON_SORVEGLIATI`, righe 360-436; sezione nuova prima del riquadro «Aggregazione»; `eseguiSalute`)
- Crea: `__tests__/lib/health/controlli-nuovi.test.ts`
- Modifica: `__tests__/api/health.test.ts` (elenco del caso sano, un caso nuovo)

- [ ] **Passo 1: quali job entrano in `JOB_CRON`**

```bash
grep -c "'cron:cron-esiti'" supabase/migrations/*_cron_esiti_osservati.sql
grep -c "'cron:fascicolo-audit-ip-retention'" supabase/migrations/20261004215133_fascicolo_audit_ip_retention.sql
grep -n "cron-esiti\|fascicolo-audit-ip-retention" ${TMPDIR:-/tmp}/kidville-s07/misure.txt
```

Atteso: due numeri maggiori di zero (il test «i job sorvegliati esistono davvero» di `health.test.ts` pretende `'cron:<nome>'` in una migrazione) e, dal Passo 0.7, un battito `ok` per ciascuno dentro la sua finestra. Un job senza battito `ok` **resta** in `JOB_CRON_NON_SORVEGLIATI` con la sua voce di oggi: nel Passo 4 salta la sua riga in `JOB_CRON` e lascia la sua voce dov'è.

- [ ] **Passo 2: i test**

Crea `__tests__/lib/health/controlli-nuovi.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
    creaFintoSupabase,
    type DBFinto,
    type ErrorePostgrest,
    type RispostaRpc,
    type Riga,
} from '../../fixtures/finto-supabase'
import { controlloCronEsiti } from '@/lib/health/controlli'
import { logEvento } from '@/lib/logging/logger'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * I CONTROLLI DELLA SESSIONE 7 (seconda serie di robustezza), UNO PER UNO, CON IL FINTO CLIENT.
 *
 * Per ognuno il caso sano e ogni «no» con numeri letterali. Mai `giu`: lo pretende anche il lock
 * `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts`.
 */

const MIN = 60_000
const ORA = 60 * MIN
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')

function fa(ms: number): string {
    return new Date(ADESSO - ms).toISOString()
}

interface Montaggio {
    db?: DBFinto
    errori?: Record<string, ErrorePostgrest>
    rpc?: Record<string, (args: Riga) => RispostaRpc | Promise<RispostaRpc>>
    storage?: unknown
}

function client({ db = {}, errori = {}, rpc = {}, storage }: Montaggio = {}): SupabaseClient {
    const finto = creaFintoSupabase(db, [], { errori, rpc })
    return (storage === undefined ? finto : Object.assign(finto, { storage })) as SupabaseClient
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('cron-esiti', () => {
    const SANO = [
        { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', visto_il: fa(MIN), vivo_il: fa(MIN) },
        { job: 'notifiche-retention', cadenza: '35 4 1 * *', esito: 'ok', visto_il: fa(19 * 24 * ORA), vivo_il: fa(19 * 24 * ORA) },
    ]

    it('tutti dentro la finestra: ok, con il numero dei job attivi', async () => {
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: SANO, error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ nome: 'cron-esiti', esito: 'ok', dettaglio: '2 job attivi' })
    })

    it('un mensile senza esito buono da 32 giorni: degradato, e il job è nominato', async () => {
        const righe = [SANO[0], { ...SANO[1], esito: 'fallito', visto_il: fa(2 * ORA), vivo_il: fa(32 * 24 * ORA) }]
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: righe, error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: notifiche-retention',
        })
    })

    it('la RPC non ancora nella cache di PostgREST, 10 minuti dopo la build: ok, e lo dice', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(10 * MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'ok',
            dettaglio: 'salute_cron_esiti non ancora installata (PGRST202)',
        })
        // §5 della specifica: chi regge una RPC nuova lo dice con una riga `info`, e perché.
        // `rpc` non è in EVENTI_PERSISTITI: la riga va nei log di Vercel, non in app_log.
        expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
            'rpc',
            'info',
            expect.objectContaining({ operazione: 'health:salute_cron_esiti', esito: 'rpc-non-ancora-installata' }),
        )
    })

    it('42883 (Postgres: «undefined function») è la stessa assenza vista dal database', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(5 * MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: '42883', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'ok',
            dettaglio: 'salute_cron_esiti non ancora installata (42883)',
        })
    })

    it('PGRST203 (due funzioni con lo stesso nome) NON è un’assenza: degradato subito', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'PGRST203', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'lettura esiti dei cron PGRST203' })
    })

    it('la stessa assenza 31 minuti dopo la build: degradato', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(31 * MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: 'salute_cron_esiti assente da oltre 30 min dalla build (PGRST202)',
        })
    })

    it('le tabelle di pg_cron o della sessione 6 assenti (P0001): degradato subito, anche appena dopo la build', async () => {
        vi.stubEnv('KV_BUILD_IL', fa(MIN))
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: null, error: { code: 'P0001', message: 'x' } }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({ esito: 'degradato', dettaglio: 'lettura esiti dei cron P0001' })
    })

    it('una risposta che non ha la forma attesa: degradato', async () => {
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: { job: 'x' }, error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: 'risposta di salute_cron_esiti illeggibile',
        })
    })

    it('nessun job attivo letto: degradato', async () => {
        const c = client({ rpc: { salute_cron_esiti: () => ({ data: [], error: null }) } })

        expect(await controlloCronEsiti(c, ADESSO)).toMatchObject({
            esito: 'degradato',
            dettaglio: 'nessun job attivo letto da cron.job',
        })
    })
})
```

In `__tests__/api/health.test.ts`, nell'elenco del test `'con tutto sano risponde 200 e stato ok, e ogni controllo è ok'`, aggiungi `'cron-esiti',` subito dopo `'cron-battito',`. Poi, subito dopo quel test, aggiungi:

```ts
    it('cron-esiti: un job senza esito buono dentro la finestra porta a degraded, mai a down, e lo nomina', async () => {
        rpc.cronEsiti.mockResolvedValue({
            data: [
                { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', visto_il: fa(MIN), vivo_il: fa(MIN) },
                { job: 'notifiche-retention', cadenza: '35 4 1 * *', esito: 'fallito', visto_il: fa(2 * ORA), vivo_il: fa(32 * 24 * ORA) },
            ],
            error: null,
        })

        const { stato, corpo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(controllo(corpo, 'cron-esiti')).toMatchObject({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: notifiche-retention',
        })
    })
```

- [ ] **Passo 3: lancia i test, rossi**

```bash
npx vitest run __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts 2>&1 | tail -12
```

Atteso: `controlli-nuovi.test.ts` rosso (`controlloCronEsiti is not a function`); in `health.test.ts` rossi il caso sano (manca `cron-esiti` dall'elenco) e il caso nuovo (`controllo "cron-esiti" assente dalla risposta`).

- [ ] **Passo 4: il codice**

In `src/lib/health/controlli.ts`, sotto la riga `import { versioneDeploy } from '@/lib/versione/deploy'`, aggiungi:

```ts
import { leggiRigheCronEsiti, valutaCronEsiti } from '@/lib/health/cron-esiti'
import { inAttesaDellIntegrazione, type Valutazione } from '@/lib/health/valutazione'
import { logEvento } from '@/lib/logging/logger'
```

Subito **prima** del riquadro

```ts
/* ════════════════════════════════════════════════════════════════════════════
 * Aggregazione
 * ════════════════════════════════════════════════════════════════════════════ */
```

aggiungi:

```ts
/* ════════════════════════════════════════════════════════════════════════════
 * 10. I controlli della sessione 7 (seconda serie di robustezza): al più `degradato`, MAI `giu`
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * L'istante della build, fissato da `next.config.ts` (`KV_BUILD_IL`). `null` fuori da una build
 * (test, script): allora nessuna tolleranza scade, perché non c'è un'integrazione da aspettare.
 * Accesso STATICO: la chiave `env` di `next.config.ts` sostituisce solo questa forma.
 */
function buildIlMs(): number | null {
    const grezzo = process.env.KV_BUILD_IL
    if (!grezzo) return null
    const t = Date.parse(grezzo)
    return Number.isNaN(t) ? null : t
}

/**
 * LA RPC DELLA SALUTE NON C'È — i due modi in cui succede, sul modello di `RPC_ASSENTE` di
 * `src/app/api/avvisi/[id]/risposte/route.ts`: `PGRST202` (PostgREST non la trova nella cache dello
 * schema) e `42883` (Postgres: «undefined function»). Insieme LOCALE a queste due chiamate, come
 * vuole il §5 della specifica: `CODICI_TABELLA_ASSENTE` parla di tabelle, e
 * `src/lib/db/tolleranza-schema.ts` non si allarga. `PGRST203` (due funzioni con lo stesso nome)
 * resta fuori: è uno schema rotto, non uno schema in arrivo.
 */
const RPC_SALUTE_ASSENTE = new Set(['PGRST202', '42883'])

/**
 * Una RPC che il database non conosce ancora. Succede per qualche minuto a ogni rilascio che ne
 * porta una: la migrazione e il deploy partono insieme, e la cache dello schema arriva dopo. Per 30
 * minuti dalla build è attesa (`ok`, il dettaglio lo dice e una riga `info` spiega perché); dopo,
 * l'integrazione non l'ha applicata (`degradato`, e la porta lo scrive a livello `warn`). Vedi
 * `@/lib/health/valutazione`. L'evento `rpc` non è persistito: la riga va nei log di Vercel e non
 * aggiunge niente ad `app_log` a ogni giro del campanello.
 */
function rpcNonInstallata(nome: string, codice: string, adesso: number): Valutazione {
    if (!inAttesaDellIntegrazione(buildIlMs(), adesso)) {
        return { esito: 'degradato', dettaglio: `${nome} assente da oltre 30 min dalla build (${codice})` }
    }
    logEvento('rpc', 'info', {
        operazione: `health:${nome}`,
        esito: 'rpc-non-ancora-installata',
        msg: `${nome} non ancora installata (${codice}): migrazione e deploy partono insieme, tollerata fino a 30 min dalla build`,
    })
    return { esito: 'ok', dettaglio: `${nome} non ancora installata (${codice})` }
}

/**
 * `cron-esiti` — ogni job ATTIVO di `pg_cron` ha avuto un esito buono dentro la finestra della sua
 * cadenza, mensili compresi. La decisione sta in `@/lib/health/cron-esiti`; qui solo la lettura.
 * Escono nomi di job, numeri e codici. Un'eccezione della funzione SQL (`P0001`: mancano le tabelle
 * di pg_cron o della sessione 6) è `degradato` subito: non è un rilascio in corso, è una
 * sorveglianza che non c'è.
 */
export async function controlloCronEsiti(supabase: SupabaseClient, adesso: number): Promise<Controllo> {
    return misura('cron-esiti', 'degradato', async () => {
        const { data, error } = await supabase.rpc('salute_cron_esiti')
        if (error) {
            const codice = codiceDi(error)
            if (RPC_SALUTE_ASSENTE.has(codice)) return rpcNonInstallata('salute_cron_esiti', codice, adesso)
            return { esito: 'degradato', dettaglio: `lettura esiti dei cron ${codice}` }
        }
        const righe = leggiRigheCronEsiti(data)
        if (righe === null) return { esito: 'degradato', dettaglio: 'risposta di salute_cron_esiti illeggibile' }
        return valutaCronEsiti(righe, adesso)
    })
}

```

In `eseguiSalute`, sostituisci la riga `        Promise.resolve(controlloRegione()),` con:

```ts
        Promise.resolve(controlloRegione()),
        controlloCronEsiti(supabase, adesso),
```

Nella tabella del commento sopra `JOB_CRON`, dopo la riga di `fatture-coda-tick`, aggiungi:

```ts
 *   fascicolo-audit-ip-retention  (stesso nome)  29 4 ogni gg  26 h   (dal {OGGI})
 *   cron-esiti            cron-esiti          ogni 10 min      40 min  (dal {OGGI})
 *
 * Dal {OGGI} (sessione 7 della seconda serie) i job hanno DUE guardie: questa (`cron-battito`, il
 * battito che la route o la funzione scrive in `app_log`) e `cron-esiti` (l'esito che pg_cron e
 * pg_net hanno registrato, letto da `cron_ultimo_esito`), che copre TUTTI i job attivi, mensili
 * compresi. Le due possono suonare insieme per lo stesso job, e dicono cose diverse: «la route non
 * ha finito il giro» e «pg_cron non ha avuto un esito buono».
```

In fondo a `JOB_CRON`, dopo la riga `    { nome: 'fatture-coda-tick', finestraMs: 30 * MIN },` e prima della `]`, aggiungi (solo le righe dei job che il Passo 1 ha confermato):

```ts
    // Notturno di sola SQL (`29 4 * * *`, `fascicolo_audit_ip_retention_tick`): azzera `ip` e
    // `user_agent` del registro degli accessi ai dati dei bambini dopo un anno. Battito
    // `cron:fascicolo-audit-ip-retention`; primo `ok` visto in produzione prima del {OGGI}
    // (misura della sessione 7). Finestra di 26 ore come gli altri giornalieri.
    { nome: 'fascicolo-audit-ip-retention', finestraMs: 26 * ORA },
    // Ogni 10 minuti (`4,14,24,34,44,54 * * * *`, funzione `cron_esiti` della sessione 6): legge
    // gli esiti di tutti gli altri job. Se si ferma, il controllo `cron-esiti` diventa cieco (e lo
    // dice: «cron-esiti fermo da N min»); il suo battito qui è la seconda guardia. 40 minuti =
    // `finestraDaIntervallo(10)` in `@/lib/health/cron-esiti`.
    { nome: 'cron-esiti', finestraMs: 40 * MIN },
```

Nel commento sopra `JOB_CRON_NON_SORVEGLIATI` sostituisci le due righe:

```ts
 * Questi job si seguono con una query su `app_log` (il battito c'è e si legge), non con un
 * endpoint interrogato ogni minuto.
```

con:

```ts
 * Questi job NON sono ciechi: dal {OGGI} (sessione 7 della seconda serie) li sorveglia il controllo
 * `cron-esiti`, che legge `cron_ultimo_esito` — una riga per job che NON scade, scritta ogni 10
 * minuti dalla funzione `cron_esiti` della sessione 6 — con la finestra della cadenza di ciascuno
 * (`finestraDaCadenza` in `@/lib/health/cron-esiti`: per un mensile 31 giorni + 2 ore). Restano
 * fuori da `JOB_CRON` perché `cron-battito` legge il battito in `app_log`, e per loro quel battito
 * o non c'è o sparisce prima del successivo.
```

e sostituisci l'elenco intero, da `export const JOB_CRON_NON_SORVEGLIATI: readonly { nome: string; perche: string }[] = [` fino alla sua `]` (con il commento e la voce di `fascicolo-audit-ip-retention` e quella di `cron-esiti` scritta dalla sessione 6), con:

```ts
export const JOB_CRON_NON_SORVEGLIATI: readonly { nome: string; perche: string }[] = [
    {
        nome: 'notifiche-retention',
        perche:
            'MENSILE (`35 4 1 * *`): la finestra necessaria (~32 giorni) supera la conservazione ' +
            'di app_log (30 giorni), quindi il battito precedente sparisce prima che arrivi il ' +
            'successivo e l’allarme suonerebbe ogni mese su un lavoro sano. Lo sorveglia ' +
            '`cron-esiti` (cron_ultimo_esito) con la finestra della sua cadenza.',
    },
    {
        nome: 'iscrizioni-retention',
        perche:
            'MENSILE (`41 4 1 * *`), stessa ragione del gemello; e il suo battito non dichiara ' +
            '`esito: ok`. Lo sorveglia `cron-esiti` (cron_ultimo_esito) con la finestra della sua cadenza.',
    },
    {
        nome: 'news-digest',
        perche:
            'MENSILE (`0 8 1 * *`): stessa ragione dei due sopra — la finestra necessaria ' +
            '(~32 giorni) supera i 30 di conservazione di app_log, quindi il battito precedente ' +
            'sparisce prima che arrivi il successivo. ⚠️ Fino al 2026-08-20 questo lavoro non era ' +
            'in NESSUNA delle due liste, che è lo stato peggiore: «lasciato fuori apposta» e ' +
            '«dimenticato» diventano indistinguibili, ed è proprio ciò che le due costanti ' +
            'esistono per separare. Spedisce una comunicazione istituzionale a TUTTE le famiglie, ' +
            'quindi vale la pena guardarlo: si segue con una query su app_log su ' +
            '`operazione: digest`, dove ora compaiono anche gli esiti `rimandata-quota` ' +
            '(tetto email raggiunto, edizione lasciata in coda) e `digest-arretrate`. ' +
            'Diventa sorvegliabile da qui il giorno in cui la cadenza passa a giornaliera: ' +
            'allora entra in `JOB_CRON` con `finestraMs: 26 * ORA` come tutti gli altri. ' +
            'Il 20/10 era SPENTO in cron.job: `cron-esiti` legge i soli job attivi, e lo ' +
            'riprende da solo il giorno in cui torna attivo.',
    },
    {
        nome: 'app-log-purge',
        perche:
            'Job di sola SQL, non passa da una route HTTP: qui sarebbe sempre rosso. Vale anche ' +
            'per consensi-retention, audit-docente-retention e app-log-bonifica-pii. Li sorveglia ' +
            'tutti `cron-esiti` (cron_ultimo_esito) con la finestra della loro cadenza.',
    },
]
```

Se il Passo 1 ha lasciato fuori `fascicolo-audit-ip-retention` o `cron-esiti`, rimetti in fondo all'elenco la sua voce di oggi (commento compreso), com'era.

- [ ] **Passo 5: lancia i test e i lock dei cron, verdi**

```bash
npx vitest run __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts __tests__/architecture/informativa-conservazione-dichiarata.test.ts __tests__/architecture/fascicolo-audit-ip-retention.test.ts 2>&1 | tail -10
npx eslint src/lib/health/controlli.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  6 passed`. `dbSano()` in `health.test.ts` deriva i battiti da `JOB_CRON`, quindi i due job nuovi hanno il loro battito senza toccare il fixture; «i job sorvegliati esistono davvero» trova `'cron:cron-esiti'` e `'cron:fascicolo-audit-ip-retention'` nelle migrazioni; `cron-sorvegliato-e-applicato` trova le due migrazioni nella fotografia (Compito 1). Se `cron-sorvegliato-e-applicato` è rosso su `cron-esiti`, la fotografia delle migrazioni non contiene ancora la migrazione della sessione 6: la chiusura del Compito 1, Passo 4 non l'ha rigenerata dalla produzione. Si torna lì, la si rigenera e la si aggiunge al commit di chiusura.

- [ ] **Passo 6: commit**

```bash
git add src/lib/health/controlli.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts
git commit -m "Salute: cron-esiti sorveglia ogni job attivo di pg_cron, mensili compresi" -m "Legge salute_cron_esiti (cron_ultimo_esito della sessione 6); al più degradato. fascicolo-audit-ip-retention e cron-esiti entrano in JOB_CRON dopo il primo battito; JOB_CRON_NON_SORVEGLIATI dice chi li sorveglia ora." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 8 — Il controllo `storage`

**File:**
- Modifica: `src/lib/health/controlli.ts` (sezione 10, dopo `controlloCronEsiti`; `eseguiSalute`)
- Modifica: `__tests__/lib/health/controlli-nuovi.test.ts`
- Modifica: `__tests__/api/health.test.ts` (elenco del caso sano, un caso nuovo)

- [ ] **Passo 1: i test**

In `__tests__/lib/health/controlli-nuovi.test.ts` sostituisci la riga

```ts
import { controlloCronEsiti } from '@/lib/health/controlli'
```

con

```ts
import { controlloCronEsiti, controlloStorage } from '@/lib/health/controlli'
```

e aggiungi in fondo al file:

```ts
describe('storage', () => {
    function fintoStorage(list: ReturnType<typeof vi.fn>) {
        const from = vi.fn(() => ({ list }))
        return { from, list, storage: { from } }
    }

    it('il bucket privato risponde: ok, e la sonda non chiede nomi di file', async () => {
        const s = fintoStorage(vi.fn().mockResolvedValue({ data: [], error: null }))

        expect(await controlloStorage(client({ storage: s.storage }))).toMatchObject({
            nome: 'storage',
            esito: 'ok',
            dettaglio: 'bucket fatture leggibile',
        })
        expect(s.from).toHaveBeenCalledWith('fatture')
        expect(s.list).toHaveBeenCalledWith('salute-sonda-inesistente', { limit: 1 })
    })

    it.each([
        ['un 503', Object.assign(new Error('x'), { name: 'StorageApiError', status: 503 }), 'storage fatture: 503 StorageApiError'],
        [
            'un bucket sparito',
            Object.assign(new Error('x'), { name: 'StorageApiError', status: 400, code: 'NoSuchBucket' }),
            'storage fatture: 400 NoSuchBucket',
        ],
        [
            'un errore senza stato',
            Object.assign(new Error('x'), { name: 'StorageUnknownError' }),
            'storage fatture: senza-stato StorageUnknownError',
        ],
    ])('%s: degradato, con stato e codice e senza il messaggio', async (_caso, error, dettaglio) => {
        const s = fintoStorage(vi.fn().mockResolvedValue({ data: null, error }))

        expect(await controlloStorage(client({ storage: s.storage }))).toMatchObject({ esito: 'degradato', dettaglio })
    })

    it('una list che lancia: degradato, con il nome dell’eccezione', async () => {
        const s = fintoStorage(vi.fn().mockRejectedValue(new TypeError('fetch failed')))

        expect(await controlloStorage(client({ storage: s.storage }))).toMatchObject({
            esito: 'degradato',
            dettaglio: 'eccezione TypeError',
        })
    })
})
```

In `__tests__/api/health.test.ts`, nell'elenco del caso sano, aggiungi `'storage',` subito dopo `'schema-atteso',`. Poi, dopo il caso di `cron-esiti` del Compito 7, aggiungi:

```ts
    it('storage: un 503 dello Storage porta a degraded, mai a down, e il messaggio del fornitore non esce', async () => {
        storage.list.mockResolvedValue({
            data: null,
            error: Object.assign(new Error('messaggio-del-fornitore-da-non-rilanciare'), {
                name: 'StorageApiError',
                status: 503,
            }),
        })

        const { stato, corpo, grezzo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(controllo(corpo, 'storage')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'storage fatture: 503 StorageApiError',
        })
        expect(grezzo).not.toContain('messaggio-del-fornitore-da-non-rilanciare')
        expect(storage.from).toHaveBeenCalledWith('fatture')
        expect(storage.list).toHaveBeenCalledWith('salute-sonda-inesistente', { limit: 1 })
        // La porta scrive il guasto in `app_log` (evento `config`, livello `warn` per `/api/health`).
        expect(log.logEvento).toHaveBeenCalledWith(
            'config',
            'warn',
            expect.objectContaining({
                msg: expect.stringContaining('storage(degradato): storage fatture: 503 StorageApiError'),
            }),
        )
    })
```

- [ ] **Passo 2: lancia i test, rossi**

```bash
npx vitest run __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts 2>&1 | tail -12
```

Atteso: `controlloStorage is not a function`; in `health.test.ts` il caso sano (manca `storage`) e il caso nuovo (`controllo "storage" assente dalla risposta`).

- [ ] **Passo 3: il codice**

In `src/lib/health/controlli.ts`, subito dopo la `}` che chiude `controlloCronEsiti`, aggiungi:

```ts
/**
 * Il bucket e il prefisso della sonda di `storage`. Un bucket PRIVATO (le fatture) e un prefisso che
 * non esiste: la `list` prova che l'API dello Storage risponde, che arriva al suo database e che il
 * bucket c'è, e non restituisce il nome di nessun file. Scelti al Passo 0.8 del piano della sessione
 * 7: se il bucket cambia, si cambia qui e nei due test.
 */
export const BUCKET_SONDA_STORAGE = 'fatture'
export const PREFISSO_SONDA_STORAGE = 'salute-sonda-inesistente'

/**
 * `storage` — lo Storage di Supabase risponde. È un servizio a parte dal database dell'app: può
 * cadere con `db-lettura` verde, e allora le foto della galleria, i documenti e le fatture non si
 * aprono più senza che nessun controllo lo veda. Escono lo stato HTTP e il codice dello Storage, mai
 * il messaggio (può citare un percorso). Una `list` che lancia (rete) la prende `misura`.
 */
export async function controlloStorage(supabase: SupabaseClient): Promise<Controllo> {
    return misura('storage', 'degradato', async () => {
        const { error } = await supabase.storage.from(BUCKET_SONDA_STORAGE).list(PREFISSO_SONDA_STORAGE, { limit: 1 })
        if (error) {
            const stato = (error as { status?: unknown }).status
            return {
                esito: 'degradato',
                dettaglio: `storage ${BUCKET_SONDA_STORAGE}: ${typeof stato === 'number' ? stato : 'senza-stato'} ${codiceDi(error)}`,
            }
        }
        return { esito: 'ok', dettaglio: `bucket ${BUCKET_SONDA_STORAGE} leggibile` }
    })
}
```

In `eseguiSalute`, sotto la riga `        controlloCronEsiti(supabase, adesso),` aggiungi:

```ts
        controlloStorage(supabase),
```

- [ ] **Passo 4: lancia i test, verdi**

```bash
npx vitest run __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts __tests__/architecture/errori-postgrest-guardati.test.ts 2>&1 | tail -8
npx eslint src/lib/health/controlli.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  4 passed`; eslint e tsc senza righe. Se il nome di quel lock non c'è (`ls __tests__/architecture | grep -i postgrest`), si lancia quello che `ls` mostra.

- [ ] **Passo 5: commit**

```bash
git add src/lib/health/controlli.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts
git commit -m "Salute: il controllo storage, una list su un prefisso che non esiste del bucket privato" -m "Al più degradato; nel dettaglio stato e codice dello Storage, mai il messaggio né nomi di file." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 9 — I controlli `email` e `push`, letti da `app_log`

**File:**
- Crea: `src/lib/health/fornitori.ts`
- Crea: `__tests__/lib/health/fornitori.test.ts`
- Modifica: `src/lib/health/controlli.ts` (import; sezione 10, dopo `controlloStorage`; `eseguiSalute`)
- Modifica: `__tests__/lib/health/controlli-nuovi.test.ts`
- Modifica: `__tests__/api/health.test.ts` (elenco del caso sano)

La soglia è `{SOGLIA_RIFIUTI}` (Passo 0.6; 3 se la misura non l'ha cambiata). Se è diversa da 3, nei due test qui sotto cambiano le righe marcate `// soglia`: il caso che scatta usa `{SOGLIA_RIFIUTI}` rifiuti e quello che non scatta `{SOGLIA_RIFIUTI} − 1`.

- [ ] **Passo 1: i test della regola**

Crea `__tests__/lib/health/fornitori.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
    FINESTRA_FORNITORI_MS,
    SOGLIA_RIFIUTI_FORNITORE,
    contaEsitiFornitore,
    fornitoreInAffanno,
    valutaFornitore,
    type RigaEsitoFornitore,
} from '@/lib/health/fornitori'

/**
 * EMAIL E PUSH: LA REGOLA, CON NUMERI LETTERALI (sessione 7 della seconda serie di robustezza).
 * `degradato` solo se i rifiuti sono almeno la soglia E più degli invii riusciti.
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')

function r(livello: string, stato: number | null, occorrenze: unknown, faMs: number, operazione: string | null = 'emails'): RigaEsitoFornitore {
    return { livello, stato_http: stato, occorrenze, visto_l_ultima: new Date(ADESSO - faMs).toISOString(), operazione }
}

describe('le costanti', () => {
    it('24 ore e 3 rifiuti', () => {
        expect(FINESTRA_FORNITORI_MS).toBe(86_400_000)
        expect(SOGLIA_RIFIUTI_FORNITORE).toBe(3) // soglia
    })
})

describe('contaEsitiFornitore', () => {
    it('riuscito = info 2xx; rifiuto = error; tutto il resto non conta', () => {
        expect(
            contaEsitiFornitore([
                r('info', 200, 4, 30 * MIN),
                r('info', 202, 5, 5 * MIN),
                r('error', 403, 3, 10 * MIN),
                r('error', null, 2, 20 * MIN), // rete: nessuno stato, ma è un rifiuto
                r('warn', 429, 7, MIN), // transitorio, ritentato
                r('info', 404, 6, MIN), // token di un'app disinstallata
                r('info', 302, 1, MIN),
                r('info', 200, 50, MIN, 'oauth-token'), // un gettone ottenuto non consegna niente
            ]),
        ).toEqual({ riusciti: 9, rifiuti: 5, ultimoRiuscito: ADESSO - 5 * MIN })
    })

    it('occorrenze assenti, zero o negative contano come una riga', () => {
        expect(contaEsitiFornitore([r('error', 500, null, MIN), r('error', 500, 0, MIN), r('error', 500, -4, MIN)])).toEqual({
            riusciti: 0,
            rifiuti: 3,
            ultimoRiuscito: null,
        })
    })
})

describe('fornitoreInAffanno', () => {
    it.each([
        [0, 0, false],
        [0, 2, false], // soglia
        [0, 3, true], // soglia
        [3, 3, false],
        [3, 4, true],
        [6, 6, false],
        [5, 6, true],
        [40, 2, false],
        [100, 99, false],
    ])('%i riusciti e %i rifiutati → %s', (riusciti, rifiuti, atteso) => {
        expect(fornitoreInAffanno({ riusciti, rifiuti, ultimoRiuscito: null })).toBe(atteso)
    })
})

describe('valutaFornitore', () => {
    it('nessun invio: ok (una domenica non è un guasto)', () => {
        expect(valutaFornitore('resend', { riusciti: 0, rifiuti: 0, ultimoRiuscito: null }, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: 'resend: nessun invio nelle ultime 24 h',
        })
    })

    it('solo rifiuti: degradato', () => {
        expect(valutaFornitore('resend', { riusciti: 0, rifiuti: 3, ultimoRiuscito: null }, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: 'resend nelle ultime 24 h: 0 riusciti, 3 rifiutati, nessuno riuscito',
        })
    })

    it('più rifiuti che riusciti: degradato, con i minuti dall’ultimo riuscito (per difetto)', () => {
        expect(valutaFornitore('fcm', { riusciti: 5, rifiuti: 6, ultimoRiuscito: ADESSO - 125 * MIN - 59_999 }, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: 'fcm nelle ultime 24 h: 5 riusciti, 6 rifiutati, ultimo riuscito 125 min fa',
        })
    })

    it('qualche rifiuto in mezzo a tanti invii: ok, e il dettaglio lo dice', () => {
        expect(valutaFornitore('web-push', { riusciti: 40, rifiuti: 2, ultimoRiuscito: ADESSO - 2 * MIN }, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: 'web-push nelle ultime 24 h: 40 riusciti, 2 rifiutati, ultimo riuscito 2 min fa',
        })
    })
})
```

- [ ] **Passo 2: i test dei controlli**

In `__tests__/lib/health/controlli-nuovi.test.ts` sostituisci la riga

```ts
import { controlloCronEsiti, controlloStorage } from '@/lib/health/controlli'
```

con

```ts
import { controlloCronEsiti, controlloEmail, controlloPush, controlloStorage } from '@/lib/health/controlli'
import { fcmConfigured } from '@/lib/push/native-push'
import { vapidConfigured } from '@/lib/push/web-push'
```

e aggiungi in fondo al file:

```ts
/** Una riga di `app_log` come la scrive `externalFetch`; `operazione` in cima è la colonna che la
 *  `select` ottiene con l'alias `operazione:contesto->campi->>operazione`. */
function esito(
    evento: string,
    provider: string,
    livello: string,
    stato: number | null,
    occorrenze: number,
    faMs: number,
    extra: Riga = {},
): Riga {
    return {
        evento,
        livello,
        sorgente: 'server',
        ambiente: 'production',
        stato_http: stato,
        occorrenze,
        visto_l_ultima: fa(faMs),
        operazione: 'invio',
        contesto: { campi: { provider, operazione: 'invio' } },
        ...extra,
    }
}

describe('email', () => {
    // Righe che la lettura deve ignorare, ciascuna da 50: se una entrasse nel conteggio,
    // ogni caso qui sotto cambierebbe esito.
    const RUMORE: Riga[] = [
        esito('email', 'resend', 'warn', 429, 50, 10 * MIN),
        esito('email', 'fcm', 'error', 500, 50, 10 * MIN),
        esito('email', 'resend', 'error', 403, 50, 25 * ORA),
        esito('email', 'resend', 'error', 403, 50, 10 * MIN, { ambiente: 'preview' }),
        esito('email', 'resend', 'error', 403, 50, 10 * MIN, { sorgente: 'client' }),
        esito('push', 'resend', 'error', 403, 50, 10 * MIN),
    ]

    it.each([
        { riusciti: 0, rifiuti: 3, atteso: 'degradato' }, // soglia
        { riusciti: 0, rifiuti: 2, atteso: 'ok' }, // soglia
        { riusciti: 5, rifiuti: 6, atteso: 'degradato' },
        { riusciti: 6, rifiuti: 6, atteso: 'ok' },
        { riusciti: 40, rifiuti: 2, atteso: 'ok' },
    ])('$riusciti riusciti e $rifiuti rifiutati nelle ultime 24 h → $atteso', async ({ riusciti, rifiuti, atteso }) => {
        const app_log = [...RUMORE]
        if (riusciti > 0) app_log.push(esito('email', 'resend', 'info', 200, riusciti, 10 * MIN))
        if (rifiuti > 0) app_log.push(esito('email', 'resend', 'error', 403, rifiuti, 20 * MIN))

        expect(await controlloEmail(client({ db: { app_log } }), ADESSO, 'production')).toMatchObject({
            nome: 'email',
            esito: atteso,
            dettaglio: `resend nelle ultime 24 h: ${riusciti} riusciti, ${rifiuti} rifiutati, ${
                riusciti > 0 ? 'ultimo riuscito 10 min fa' : 'nessuno riuscito'
            }`,
        })
    })

    it('nessun invio: ok', async () => {
        expect(await controlloEmail(client({ db: { app_log: [...RUMORE] } }), ADESSO, 'production')).toMatchObject({
            esito: 'ok',
            dettaglio: 'resend: nessun invio nelle ultime 24 h',
        })
    })

    it('app_log illeggibile: degradato, con il codice', async () => {
        const c = client({ db: { app_log: [] }, errori: { app_log: { code: '57014', message: 'x' } } })

        expect(await controlloEmail(c, ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'lettura esiti resend 57014',
        })
    })
})

describe('push', () => {
    function configuraTutto(): void {
        for (const nome of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
            vi.stubEnv(nome, 'valore-di-prova')
        }
    }

    it('FCM respinto e web-push sano: degradato, e il dettaglio dice quale', async () => {
        configuraTutto()
        const app_log = [
            esito('push', 'fcm', 'error', 403, 4, 30 * MIN),
            esito('push', 'fcm', 'warn', 503, 100, 5 * MIN),
            esito('push', 'fcm', 'info', 200, 50, 5 * MIN, {
                operazione: 'oauth-token',
                contesto: { campi: { provider: 'fcm', operazione: 'oauth-token' } },
            }),
            esito('push', 'web-push', 'info', 201, 3, 5 * MIN),
            esito('push', 'web-push', 'info', 410, 30, 5 * MIN),
        ]

        expect(await controlloPush(client({ db: { app_log } }), ADESSO, 'production')).toMatchObject({
            nome: 'push',
            esito: 'degradato',
            dettaglio:
                'fcm nelle ultime 24 h: 0 riusciti, 4 rifiutati, nessuno riuscito; ' +
                'web-push nelle ultime 24 h: 3 riusciti, 0 rifiutati, ultimo riuscito 5 min fa',
        })
    })

    it('FCM non configurato: lo dice, non lo legge, e resta ok (lo segnala già config)', async () => {
        configuraTutto()
        vi.stubEnv('FCM_PRIVATE_KEY', '')

        expect(await controlloPush(client({ db: { app_log: [] } }), ADESSO, 'production')).toMatchObject({
            esito: 'ok',
            dettaglio: 'fcm non configurato (vedi config); web-push: nessun invio nelle ultime 24 h',
        })
    })

    it('app_log illeggibile: degradato, per ogni canale', async () => {
        configuraTutto()
        const c = client({ db: { app_log: [] }, errori: { app_log: { code: '57014', message: 'x' } } })

        expect(await controlloPush(c, ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'lettura esiti fcm 57014; lettura esiti web-push 57014',
        })
    })

    it.each([
        { fcm: true, vapid: true },
        { fcm: false, vapid: true },
        { fcm: true, vapid: false },
        { fcm: false, vapid: false },
    ])('la stessa regola di fcmConfigured() e vapidConfigured(): fcm $fcm, vapid $vapid', async ({ fcm, vapid }) => {
        configuraTutto()
        if (!fcm) vi.stubEnv('FCM_CLIENT_EMAIL', '')
        if (!vapid) vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '')

        const { dettaglio } = await controlloPush(client({ db: { app_log: [] } }), ADESSO, 'production')

        expect(fcmConfigured()).toBe(fcm)
        expect(vapidConfigured()).toBe(vapid)
        expect(dettaglio?.includes('fcm non configurato')).toBe(!fcm)
        expect(dettaglio?.includes('web-push non configurato')).toBe(!vapid)
    })
})
```

In `__tests__/api/health.test.ts`, nell'elenco del caso sano, aggiungi `'email',` subito dopo `'db-lettura',` e `'push',` subito dopo `'email',`. Il caso sano resta `ok` così com'è: il fixture non ha righe `email` né `push` («nessun invio»), e i canali risultano configurati se i loro nomi sono in `VARIABILI_CRITICHE` (il `beforeEach` le valorizza tutte), «non configurato» altrimenti; tutte e due le strade sono `ok`.

- [ ] **Passo 3: lancia i test, rossi**

```bash
npx vitest run __tests__/lib/health/fornitori.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts 2>&1 | tail -12
```

Atteso: `Failed to resolve import "@/lib/health/fornitori"`; `controlloEmail is not a function`; in `health.test.ts` il caso sano (mancano `email` e `push`).

- [ ] **Passo 4: `fornitori.ts`**

Crea `src/lib/health/fornitori.ts`:

```ts
import type { Valutazione } from './valutazione'

/**
 * EMAIL E PUSH, LETTI DA `app_log` E MAI DAI FORNITORI (sessione 7 della seconda serie).
 *
 * Per mesi nessuna email di credenziali è arrivata, e nessun controllo lo diceva (AGENTS.md,
 * «Logging obbligatorio»). Oggi ogni chiamata a Resend, FCM e web-push passa da `externalFetch`, che
 * scrive in `app_log` il successo (`info`) e il rifiuto (`error`) con il `provider`: questo modulo
 * li conta, e la salute non chiama nessun fornitore (un campanello che interroga ogni minuto
 * spenderebbe la quota di Resend per sapere se c'è).
 *
 * LA REGOLA. `degradato` se nelle ultime 24 h i rifiuti sono almeno `SOGLIA_RIFIUTI_FORNITORE` E
 * più degli invii riusciti. Nessun invio è `ok`: una domenica non è un guasto. Riuscito = riga
 * `info` con stato 2xx che non sia una chiamata che non consegna niente (`OPERAZIONI_NON_INVII`);
 * rifiuto = riga `error`. Le righe `warn` (rifiuto transitorio che il chiamante ritenta, esito
 * illeggibile) e le `info` non 2xx (token di un'app disinstallata, abbonamento web scaduto) non
 * contano né da una parte né dall'altra.
 *
 * IL LIMITE DICHIARATO. `occorrenze` è contata PER GIORNO (chiave `(fingerprint, giorno)` di
 * `app_log`): una riga vista nelle ultime 24 h porta il conteggio del suo giorno intero. La
 * finestra vera va quindi da 24 a 48 h, uguale per riusciti e rifiuti.
 */

const MIN = 60_000

export const FINESTRA_FORNITORI_MS = 24 * 60 * MIN

/** Il numero di rifiuti sotto cui non si suona mai: due email respinte in un giorno sono un
 *  indirizzo sbagliato, non un fornitore rotto. Misurata al Passo 0.6 del piano della sessione 7. */
export const SOGLIA_RIFIUTI_FORNITORE = 3

/** Le chiamate che riescono senza consegnare niente: il gettone OAuth di FCM
 *  (`src/lib/push/native-push.ts`). Contarle fra i riusciti coprirebbe le push respinte. */
const OPERAZIONI_NON_INVII: ReadonlySet<string> = new Set(['oauth-token'])

/** Una riga come la restituisce la `select` di `controlloEmail`/`controlloPush`. */
export interface RigaEsitoFornitore {
    livello: unknown
    stato_http: unknown
    occorrenze: unknown
    visto_l_ultima: unknown
    operazione: unknown
}

export interface ConteggioFornitore {
    riusciti: number
    rifiuti: number
    /** L'ultima riga riuscita (ms), `null` se nessuna. */
    ultimoRiuscito: number | null
}

function occorrenzeDi(valore: unknown): number {
    return typeof valore === 'number' && Number.isFinite(valore) && valore >= 1 ? Math.floor(valore) : 1
}

export function contaEsitiFornitore(righe: readonly RigaEsitoFornitore[]): ConteggioFornitore {
    let riusciti = 0
    let rifiuti = 0
    let ultimoRiuscito: number | null = null
    for (const r of righe) {
        const n = occorrenzeDi(r.occorrenze)
        if (r.livello === 'error') {
            rifiuti += n
            continue
        }
        const stato = r.stato_http
        if (r.livello !== 'info' || typeof stato !== 'number' || stato < 200 || stato > 299) continue
        if (typeof r.operazione === 'string' && OPERAZIONI_NON_INVII.has(r.operazione)) continue
        riusciti += n
        const t = typeof r.visto_l_ultima === 'string' ? Date.parse(r.visto_l_ultima) : Number.NaN
        if (!Number.isNaN(t) && (ultimoRiuscito === null || t > ultimoRiuscito)) ultimoRiuscito = t
    }
    return { riusciti, rifiuti, ultimoRiuscito }
}

export function fornitoreInAffanno(c: ConteggioFornitore): boolean {
    return c.rifiuti >= SOGLIA_RIFIUTI_FORNITORE && c.rifiuti > c.riusciti
}

/** La decisione per un fornitore. Il dettaglio porta il nome del fornitore e numeri, nient'altro. */
export function valutaFornitore(nome: string, c: ConteggioFornitore, adesso: number): Valutazione {
    if (c.riusciti === 0 && c.rifiuti === 0) {
        return { esito: 'ok', dettaglio: `${nome}: nessun invio nelle ultime 24 h` }
    }
    const ultimo =
        c.ultimoRiuscito === null ? 'nessuno riuscito' : `ultimo riuscito ${Math.floor((adesso - c.ultimoRiuscito) / MIN)} min fa`
    return {
        esito: fornitoreInAffanno(c) ? 'degradato' : 'ok',
        dettaglio: `${nome} nelle ultime 24 h: ${c.riusciti} riusciti, ${c.rifiuti} rifiutati, ${ultimo}`,
    }
}
```

- [ ] **Passo 5: i due controlli**

In `src/lib/health/controlli.ts`, sotto l'import di `@/lib/health/cron-esiti`, aggiungi:

```ts
import {
    FINESTRA_FORNITORI_MS,
    contaEsitiFornitore,
    valutaFornitore,
    type RigaEsitoFornitore,
} from '@/lib/health/fornitori'
```

Subito dopo la `}` che chiude `controlloStorage`, aggiungi:

```ts
/** Quante righe di `app_log` legge al più ogni fornitore. Le righe sono già aggregate per giorno e
 *  per impronta (`occorrenze`): in 24 h sono decine, e 500 è un tetto, non una stima. */
const RIGHE_MAX_FORNITORE = 500

/**
 * Gli esiti di un fornitore nelle ultime 24 h, da `app_log`. `operazione` arriva come colonna con
 * un alias sul JSON, così la risposta non porta il resto di `contesto`.
 */
async function leggiEsitiFornitore(
    supabase: SupabaseClient,
    evento: 'email' | 'push',
    provider: string,
    adesso: number,
    ambiente: string,
): Promise<{ righe: RigaEsitoFornitore[] } | { codice: string }> {
    const { data, error } = await supabase
        .from('app_log')
        .select('livello, stato_http, occorrenze, visto_l_ultima, operazione:contesto->campi->>operazione')
        .eq('evento', evento)
        .eq('sorgente', 'server')
        .eq('ambiente', ambiente)
        .eq('contesto->campi->>provider', provider)
        .gte('visto_l_ultima', new Date(adesso - FINESTRA_FORNITORI_MS).toISOString())
        .limit(RIGHE_MAX_FORNITORE)
    if (error) return { codice: codiceDi(error) }
    return { righe: (data ?? []) as RigaEsitoFornitore[] }
}

/**
 * `email` — Resend non respinge più di quanto consegna. Letto da `app_log` (evento `email`,
 * `provider: resend`): la salute non chiama MAI Resend. La regola sta in `@/lib/health/fornitori`.
 */
export async function controlloEmail(supabase: SupabaseClient, adesso: number, ambiente: string): Promise<Controllo> {
    return misura('email', 'degradato', async () => {
        const letti = await leggiEsitiFornitore(supabase, 'email', 'resend', adesso, ambiente)
        if ('codice' in letti) return { esito: 'degradato', dettaglio: `lettura esiti resend ${letti.codice}` }
        return valutaFornitore('resend', contaEsitiFornitore(letti.righe), adesso)
    })
}

/**
 * I canali push e se sono configurati, con le STESSE condizioni di `fcmConfigured()`
 * (`src/lib/push/native-push.ts`) e `vapidConfigured()` (`src/lib/push/web-push.ts`). Non si
 * importano: quei moduli si portano dietro la firma RS256 e la libreria `web-push`, che la salute
 * non deve caricare. Le due regole le confronta `__tests__/lib/health/controlli-nuovi.test.ts` su
 * quattro combinazioni. Accesso statico a `process.env`.
 */
function canaliPush(): { provider: 'fcm' | 'web-push'; configurato: boolean }[] {
    return [
        {
            provider: 'fcm',
            configurato: Boolean(process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY),
        },
        {
            provider: 'web-push',
            configurato: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
        },
    ]
}

/**
 * `push` — per ogni canale configurato, FCM e web-push non respingono più di quanto consegnano
 * (evento `push`, letto da `app_log`). Un canale non configurato lo dice `config`; qui si scrive e
 * resta `ok`, così la stessa assenza non apre due segnalazioni. Il battito del dispatcher è già
 * `push-dispatch` in `cron-battito`.
 */
export async function controlloPush(supabase: SupabaseClient, adesso: number, ambiente: string): Promise<Controllo> {
    return misura('push', 'degradato', async () => {
        const valutazioni = await Promise.all(
            canaliPush().map(async ({ provider, configurato }): Promise<Valutazione> => {
                if (!configurato) return { esito: 'ok', dettaglio: `${provider} non configurato (vedi config)` }
                const letti = await leggiEsitiFornitore(supabase, 'push', provider, adesso, ambiente)
                if ('codice' in letti) return { esito: 'degradato', dettaglio: `lettura esiti ${provider} ${letti.codice}` }
                return valutaFornitore(provider, contaEsitiFornitore(letti.righe), adesso)
            }),
        )
        return {
            esito: valutazioni.some((v) => v.esito === 'degradato') ? 'degradato' : 'ok',
            dettaglio: valutazioni.map((v) => v.dettaglio).join('; '),
        }
    })
}
```

In `eseguiSalute`, sotto la riga `        controlloStorage(supabase),` aggiungi:

```ts
        controlloEmail(supabase, adesso, opzioni.ambiente),
        controlloPush(supabase, adesso, opzioni.ambiente),
```

- [ ] **Passo 6: lancia i test, verdi**

```bash
npx vitest run __tests__/lib/health/fornitori.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts 2>&1 | tail -8
npx eslint src/lib/health/fornitori.ts src/lib/health/controlli.ts __tests__/lib/health/fornitori.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  4 passed`; eslint e tsc senza righe.

- [ ] **Passo 7: commit**

```bash
git add src/lib/health/fornitori.ts src/lib/health/controlli.ts __tests__/lib/health/fornitori.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts
git commit -m "Salute: email e push letti da app_log, senza chiamare Resend né FCM" -m "Degradato se nelle ultime 24 h i rifiuti sono almeno 3 e più dei riusciti; nessun invio è ok; il gettone OAuth di FCM non conta come invio." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 10 — Il controllo `migrazioni`: la versione del repo fissata alla build

**File:**
- Crea: `src/lib/health/migrazioni.ts`
- Crea: `__tests__/lib/health/migrazioni.test.ts`
- Crea: `__tests__/architecture/migrazioni-versione-in-build.test.ts`
- Modifica: `next.config.ts` (import, righe 1-3; dopo `VERSIONE_BUNDLE`, riga 26; `env`, riga 115)
- Modifica: `src/lib/health/controlli.ts` (import; sezione 10, dopo `controlloPush`; `eseguiSalute`)
- Modifica: `__tests__/lib/health/controlli-nuovi.test.ts`
- Modifica: `__tests__/api/health.test.ts` (elenco del caso sano)

- [ ] **Passo 1: i test della decisione**

Crea `__tests__/lib/health/migrazioni.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { leggiStatoMigrazioniDb, statoMigrazioniRepo, valutaMigrazioni } from '@/lib/health/migrazioni'
import { TOLLERANZA_MERGE_MS, inAttesaDellIntegrazione } from '@/lib/health/valutazione'

/**
 * LE MIGRAZIONI DEL REPO CONTRO QUELLE DEL DATABASE (sessione 7 della seconda serie di robustezza).
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')
const REPO = { ultima: '20261020091500', numero: 233 }
const COPPIA = 'repo 20261020091500 (233), database 20261019223123 (232)'

describe('statoMigrazioniRepo', () => {
    it('la versione più alta e il numero dei soli file di migrazione', () => {
        expect(
            statoMigrazioniRepo([
                '20261001000000_a.sql',
                '20261020091500_c.sql',
                '20261010000000_b.sql',
                'README.md',
                '2026_x.sql',
                '.gitkeep',
            ]),
        ).toEqual({ ultima: '20261020091500', numero: 3 })
    })

    it('nessun file di migrazione: null', () => {
        expect(statoMigrazioniRepo([])).toBeNull()
        expect(statoMigrazioniRepo(['README.md'])).toBeNull()
    })
})

describe('leggiStatoMigrazioniDb', () => {
    it('la riga della RPC, in un elenco o da sola', () => {
        expect(leggiStatoMigrazioniDb([{ ultima: '20261020091500', numero: 233 }])).toEqual(REPO)
        expect(leggiStatoMigrazioniDb({ ultima: '20261020091500', numero: 233 })).toEqual(REPO)
    })

    it.each([
        ['un elenco vuoto', []],
        ['null', null],
        ['una versione corta', [{ ultima: '2026102009', numero: 233 }]],
        ['una tabella vuota', [{ ultima: null, numero: 0 }]],
        ['un numero in testo', [{ ultima: '20261020091500', numero: '233' }]],
        ['un numero negativo', [{ ultima: '20261020091500', numero: -1 }]],
    ])('%s → illeggibile', (_caso, data) => {
        expect(leggiStatoMigrazioniDb(data)).toBeNull()
    })
})

describe('la tolleranza del merge', () => {
    it('30 minuti dalla build, al secondo; fuori da una build non scade', () => {
        expect(TOLLERANZA_MERGE_MS).toBe(1_800_000)
        expect(inAttesaDellIntegrazione(ADESSO - 30 * MIN + 1000, ADESSO)).toBe(true)
        expect(inAttesaDellIntegrazione(ADESSO - 30 * MIN, ADESSO)).toBe(true)
        expect(inAttesaDellIntegrazione(ADESSO - 30 * MIN - 1000, ADESSO)).toBe(false)
        expect(inAttesaDellIntegrazione(null, ADESSO)).toBe(true)
    })
})

describe('valutaMigrazioni', () => {
    const DB_INDIETRO = { ultima: '20261019223123', numero: 232 }

    it('uguali: ok, con il numero e l’ultima', () => {
        expect(valutaMigrazioni(REPO, REPO, ADESSO - 120 * MIN, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '233 migrazioni, ultima 20261020091500',
        })
    })

    it('repo avanti 29 minuti dopo la build: ok, l’integrazione sta applicando', () => {
        expect(valutaMigrazioni(REPO, DB_INDIETRO, ADESSO - 29 * MIN, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: `in attesa dell'integrazione: ${COPPIA}`,
        })
    })

    it('repo avanti 31 minuti dopo la build: degradato', () => {
        expect(valutaMigrazioni(REPO, DB_INDIETRO, ADESSO - 31 * MIN, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: `migrazioni del repo non applicate da oltre 30 min dalla build: ${COPPIA}`,
        })
    })

    it('stessa ultima versione ma una in mezzo mancante: degradato (lo vede il numero)', () => {
        expect(valutaMigrazioni(REPO, { ultima: '20261020091500', numero: 232 }, ADESSO - 120 * MIN, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio:
                'migrazioni del repo non applicate da oltre 30 min dalla build: repo 20261020091500 (233), database 20261020091500 (232)',
        })
    })

    it('database avanti (deploy in corso, Instant Rollback): ok', () => {
        expect(valutaMigrazioni(REPO, { ultima: '20261021080000', numero: 234 }, ADESSO - 120 * MIN, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio:
                'database avanti sul repo (deploy in corso o ritorno indietro): repo 20261020091500 (233), database 20261021080000 (234)',
        })
    })

    it('una riga doppia in schema_migrations: ok come «database avanti» (limite dichiarato)', () => {
        expect(valutaMigrazioni(REPO, { ultima: '20261020091500', numero: 234 }, ADESSO - 120 * MIN, ADESSO)).toMatchObject({
            esito: 'ok',
        })
    })

    it('fuori da una build (istante ignoto): la differenza resta «in attesa»', () => {
        expect(valutaMigrazioni(REPO, DB_INDIETRO, null, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: `in attesa dell'integrazione: ${COPPIA}`,
        })
    })
})
```

Crea `__tests__/architecture/migrazioni-versione-in-build.test.ts`:

```ts
// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NextConfig } from 'next'
import config from '../../next.config'

/**
 * LOCK · LA BUILD FISSA LA VERSIONE DELLE MIGRAZIONI DEL REPO.
 *
 * Il controllo `migrazioni` di `/api/health` (sessione 7 della seconda serie) confronta l'ultima
 * migrazione del repo con `max(version)` del database. La versione del repo la fissa
 * `next.config.ts` alla build (chiave `env`): a runtime su Vercel la cartella
 * `supabase/migrations` non c'è. Next sostituisce SOLO la forma statica `process.env.NOME`: una
 * lettura dinamica (`process.env[nome]`) resterebbe `undefined` in produzione, e il controllo
 * direbbe per sempre «versione del repo non fissata alla build».
 */

const RADICE = process.cwd()
const NOMI = readdirSync(join(RADICE, 'supabase', 'migrations'))
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
const CONTROLLI = readFileSync(join(RADICE, 'src', 'lib', 'health', 'controlli.ts'), 'utf8')
const ENV = (config as NextConfig).env ?? {}

describe('lock · la versione delle migrazioni è fissata alla build', () => {
    it('KV_MIGRAZIONE_REPO è la versione più alta della cartella, KV_MIGRAZIONI_REPO_NUMERO il numero dei file', () => {
        expect(NOMI.length).toBeGreaterThanOrEqual(232)
        expect(ENV.KV_MIGRAZIONE_REPO).toBe(NOMI[NOMI.length - 1].slice(0, 14))
        expect(ENV.KV_MIGRAZIONI_REPO_NUMERO).toBe(String(NOMI.length))
    })

    it('KV_BUILD_IL è un istante leggibile', () => {
        expect(Number.isNaN(Date.parse(ENV.KV_BUILD_IL ?? ''))).toBe(false)
    })

    it('controlli.ts legge le tre chiavi nella sola forma che Next sostituisce', () => {
        for (const chiave of ['KV_MIGRAZIONE_REPO', 'KV_MIGRAZIONI_REPO_NUMERO', 'KV_BUILD_IL']) {
            expect(CONTROLLI, `process.env.${chiave} assente da src/lib/health/controlli.ts`).toContain(`process.env.${chiave}`)
        }
        expect(CONTROLLI).not.toMatch(/process\.env\[\s*['"`]KV_/)
        expect(CONTROLLI).not.toMatch(/\{[^}]*\bKV_[A-Z_]+[^}]*\}\s*=\s*process\.env/)
    })
})
```

In `__tests__/lib/health/controlli-nuovi.test.ts` sostituisci la riga

```ts
import { controlloCronEsiti, controlloEmail, controlloPush, controlloStorage } from '@/lib/health/controlli'
```

con

```ts
import {
    controlloCronEsiti,
    controlloEmail,
    controlloMigrazioni,
    controlloPush,
    controlloStorage,
} from '@/lib/health/controlli'
```

e aggiungi in fondo al file:

```ts
describe('migrazioni', () => {
    function fissaBuild(ultima: string, numero: string, buildFaMs: number): void {
        vi.stubEnv('KV_MIGRAZIONE_REPO', ultima)
        vi.stubEnv('KV_MIGRAZIONI_REPO_NUMERO', numero)
        vi.stubEnv('KV_BUILD_IL', fa(buildFaMs))
    }

    it('in locale, fuori da una build: ok, e non chiede niente al database', async () => {
        vi.stubEnv('KV_MIGRAZIONE_REPO', '')
        vi.stubEnv('KV_MIGRAZIONI_REPO_NUMERO', '')
        const salute_migrazioni = vi.fn()

        expect(await controlloMigrazioni(client({ rpc: { salute_migrazioni } }), ADESSO, 'locale')).toMatchObject({
            nome: 'migrazioni',
            esito: 'ok',
            dettaglio: 'versione del repo non fissata (fuori dalla build)',
        })
        expect(salute_migrazioni).not.toHaveBeenCalled()
    })

    it('in produzione senza la versione della build: degradato', async () => {
        vi.stubEnv('KV_MIGRAZIONE_REPO', '')
        vi.stubEnv('KV_MIGRAZIONI_REPO_NUMERO', '')

        expect(await controlloMigrazioni(client(), ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'versione del repo non fissata alla build',
        })
    })

    it('uguali: ok', async () => {
        fissaBuild('20261020091500', '233', 120 * MIN)
        const c = client({ rpc: { salute_migrazioni: () => ({ data: [{ ultima: '20261020091500', numero: 233 }], error: null }) } })

        expect(await controlloMigrazioni(c, ADESSO, 'production')).toMatchObject({
            esito: 'ok',
            dettaglio: '233 migrazioni, ultima 20261020091500',
        })
    })

    it('la RPC non ancora installata 10 minuti dopo la build: ok; 31 minuti dopo: degradato', async () => {
        const c = client({ rpc: { salute_migrazioni: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } })

        fissaBuild('20261020091500', '233', 10 * MIN)
        expect(await controlloMigrazioni(c, ADESSO, 'production')).toMatchObject({
            esito: 'ok',
            dettaglio: 'salute_migrazioni non ancora installata (PGRST202)',
        })

        fissaBuild('20261020091500', '233', 31 * MIN)
        expect(await controlloMigrazioni(c, ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio: 'salute_migrazioni assente da oltre 30 min dalla build (PGRST202)',
        })
    })

    it('il repo avanti 31 minuti dopo la build: degradato', async () => {
        fissaBuild('20261020091500', '233', 31 * MIN)
        const c = client({ rpc: { salute_migrazioni: () => ({ data: [{ ultima: '20261019223123', numero: 232 }], error: null }) } })

        expect(await controlloMigrazioni(c, ADESSO, 'production')).toMatchObject({
            esito: 'degradato',
            dettaglio:
                'migrazioni del repo non applicate da oltre 30 min dalla build: repo 20261020091500 (233), database 20261019223123 (232)',
        })
    })

    it('un altro errore della RPC, o una risposta illeggibile: degradato', async () => {
        fissaBuild('20261020091500', '233', MIN)

        expect(
            await controlloMigrazioni(
                client({ rpc: { salute_migrazioni: () => ({ data: null, error: { code: 'XX000', message: 'x' } }) } }),
                ADESSO,
                'production',
            ),
        ).toMatchObject({ esito: 'degradato', dettaglio: 'lettura delle migrazioni XX000' })

        expect(
            await controlloMigrazioni(
                client({ rpc: { salute_migrazioni: () => ({ data: [{ ultima: null, numero: 0 }], error: null }) } }),
                ADESSO,
                'production',
            ),
        ).toMatchObject({ esito: 'degradato', dettaglio: 'risposta di salute_migrazioni illeggibile' })
    })
})
```

In `__tests__/api/health.test.ts`, nell'elenco del caso sano, aggiungi `'migrazioni',` subito dopo `'email',` (l'elenco è in ordine alfabetico: `…'db-lettura', 'email', 'migrazioni', 'push', 'regione'…`). Il `beforeEach` del Compito 2 fissa già `KV_MIGRAZIONE_REPO`/`KV_MIGRAZIONI_REPO_NUMERO` uguali alla risposta di `rpc.migrazioni`.

- [ ] **Passo 2: lancia i test, rossi**

```bash
npx vitest run __tests__/lib/health/migrazioni.test.ts __tests__/architecture/migrazioni-versione-in-build.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts 2>&1 | tail -12
```

Atteso: `Failed to resolve import "@/lib/health/migrazioni"`; il lock rosso su `KV_MIGRAZIONE_REPO` (`expected undefined to be '…'`); `controlloMigrazioni is not a function`; il caso sano senza `migrazioni`.

- [ ] **Passo 3: `migrazioni.ts`**

Crea `src/lib/health/migrazioni.ts` (import **relativi**: lo importa anche `next.config.ts`, che non risolve `@/`):

```ts
import { inAttesaDellIntegrazione, type Valutazione } from './valutazione'

/**
 * LE MIGRAZIONI DEL REPO CONTRO QUELLE DEL DATABASE (sessione 7 della seconda serie).
 *
 * Le migrazioni le applica l'integrazione Supabase al merge: se non lo fa (un file con la versione
 * sbagliata, un conflitto, l'integrazione spenta), il codice nuovo gira su uno schema vecchio e se ne
 * accorge solo chi trova un errore. Il repo dice quale dovrebbe essere l'ultima versione; il
 * database (`salute_migrazioni()`) quale è. La versione del repo la fissa `next.config.ts` alla
 * build con `statoMigrazioniRepo`, perché a runtime la cartella non c'è.
 *
 * Il numero serve per la migrazione in mezzo: una versione vecchia aggiunta tardi non cambia
 * `max(version)`. Limite dichiarato: una migrazione applicata due volte a mano lascia due righe e
 * il conteggio del database va avanti; la versione più alta vede comunque un file nuovo non
 * applicato.
 */

export interface StatoMigrazioni {
    /** La versione più alta (14 cifre). */
    ultima: string
    numero: number
}

const RE_FILE = /^(\d{14})_.+\.sql$/
const RE_VERSIONE = /^\d{14}$/

/** Dai nomi dei file di `supabase/migrations`: la versione più alta e quanti sono. */
export function statoMigrazioniRepo(nomi: readonly string[]): StatoMigrazioni | null {
    const versioni = nomi.map((n) => RE_FILE.exec(n)?.[1]).filter((v): v is string => v !== undefined)
    if (versioni.length === 0) return null
    return { ultima: versioni.reduce((a, b) => (b > a ? b : a)), numero: versioni.length }
}

/** La risposta di `salute_migrazioni()`, o `null` se non ha la forma attesa. */
export function leggiStatoMigrazioniDb(data: unknown): StatoMigrazioni | null {
    const grezzo: unknown = Array.isArray(data) ? data[0] : data
    if (grezzo === null || typeof grezzo !== 'object') return null
    const { ultima, numero } = grezzo as Record<string, unknown>
    if (typeof ultima !== 'string' || !RE_VERSIONE.test(ultima)) return null
    if (typeof numero !== 'number' || !Number.isInteger(numero) || numero < 0) return null
    return { ultima, numero }
}

/** La decisione. Il dettaglio porta versioni e numeri, nient'altro. */
export function valutaMigrazioni(
    repo: StatoMigrazioni,
    db: StatoMigrazioni,
    buildIl: number | null,
    adesso: number,
): Valutazione {
    if (repo.ultima === db.ultima && repo.numero === db.numero) {
        return { esito: 'ok', dettaglio: `${repo.numero} migrazioni, ultima ${repo.ultima}` }
    }
    const coppia = `repo ${repo.ultima} (${repo.numero}), database ${db.ultima} (${db.numero})`
    const repoAvanti = repo.ultima > db.ultima || repo.numero > db.numero
    if (!repoAvanti) {
        return { esito: 'ok', dettaglio: `database avanti sul repo (deploy in corso o ritorno indietro): ${coppia}` }
    }
    return inAttesaDellIntegrazione(buildIl, adesso)
        ? { esito: 'ok', dettaglio: `in attesa dell'integrazione: ${coppia}` }
        : { esito: 'degradato', dettaglio: `migrazioni del repo non applicate da oltre 30 min dalla build: ${coppia}` }
}
```

- [ ] **Passo 4: `next.config.ts`**

Sostituisci la riga 3

```ts
import { shaNormalizzato } from "./src/lib/versione/deploy";
```

con

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { statoMigrazioniRepo } from "./src/lib/health/migrazioni";
import { shaNormalizzato } from "./src/lib/versione/deploy";
```

Subito dopo la riga `const VERSIONE_BUNDLE = shaNormalizzato(process.env.VERCEL_GIT_COMMIT_SHA) ?? "";` aggiungi:

```ts

/**
 * ─── LE MIGRAZIONI DEL REPO E L'ISTANTE DELLA BUILD, COTTI IN BUILD ──────────
 *
 * Il controllo `migrazioni` di `/api/health` (sessione 7 della seconda serie di robustezza)
 * confronta l'ultima migrazione del repo con quella del database. A runtime su Vercel la cartella
 * `supabase/migrations` non c'è: la si legge QUI, alla build, e la chiave `env` la sostituisce nel
 * codice del server come `VERSIONE_BUNDLE`. `KV_BUILD_IL` è l'istante della build: per 30 minuti
 * da lì una migrazione non ancora applicata è attesa (l'integrazione Supabase la applica al merge,
 * mentre il deploy parte), dopo è un guasto.
 *
 * Una cartella illeggibile non ferma la build: il controllo lo dirà (`degradato`, «versione del
 * repo non fissata alla build») e qui resta una riga d'errore nel log della build. Il lock è
 * `__tests__/architecture/migrazioni-versione-in-build.test.ts`.
 */
function migrazioniDelRepo(): ReturnType<typeof statoMigrazioniRepo> {
  try {
    return statoMigrazioniRepo(readdirSync(join(process.cwd(), "supabase", "migrations")));
  } catch (err) {
    console.error(
      "[next.config] supabase/migrations illeggibile: il controllo `migrazioni` di /api/health resterà senza versione del repo",
      err,
    );
    return null;
  }
}
const MIGRAZIONI_REPO = migrazioniDelRepo();
```

Sostituisci la riga 115

```ts
  env: { NEXT_PUBLIC_VERSIONE_BUNDLE: VERSIONE_BUNDLE },
```

con

```ts
  env: {
    NEXT_PUBLIC_VERSIONE_BUNDLE: VERSIONE_BUNDLE,
    KV_MIGRAZIONE_REPO: MIGRAZIONI_REPO?.ultima ?? "",
    KV_MIGRAZIONI_REPO_NUMERO: MIGRAZIONI_REPO ? String(MIGRAZIONI_REPO.numero) : "",
    KV_BUILD_IL: new Date().toISOString(),
  },
```

- [ ] **Passo 5: il controllo**

In `src/lib/health/controlli.ts`, sotto l'import di `@/lib/health/fornitori`, aggiungi:

```ts
import { leggiStatoMigrazioniDb, valutaMigrazioni, type StatoMigrazioni } from '@/lib/health/migrazioni'
```

Subito dopo la `}` che chiude `controlloPush`, aggiungi:

```ts
/**
 * La versione del repo fissata alla build da `next.config.ts`; `null` fuori da una build o se la
 * cartella non si è letta. Accesso STATICO a `process.env.KV_…`: la chiave `env` di Next sostituisce
 * solo questa forma (lock `__tests__/architecture/migrazioni-versione-in-build.test.ts`).
 */
function migrazioniDellaBuild(): StatoMigrazioni | null {
    const ultima = process.env.KV_MIGRAZIONE_REPO
    const numero = Number(process.env.KV_MIGRAZIONI_REPO_NUMERO)
    if (!ultima || !/^\d{14}$/.test(ultima) || !Number.isInteger(numero) || numero <= 0) return null
    return { ultima, numero }
}

/**
 * `migrazioni` — il database ha applicato le migrazioni del repo. In locale senza build (`next dev`
 * le ha, un test no) non c'è niente da confrontare ed è `ok`; altrove una build senza versione è un
 * guasto della build. La decisione sta in `@/lib/health/migrazioni`.
 */
export async function controlloMigrazioni(supabase: SupabaseClient, adesso: number, ambiente: string): Promise<Controllo> {
    return misura('migrazioni', 'degradato', async () => {
        const repo = migrazioniDellaBuild()
        if (repo === null) {
            return ambiente === 'locale'
                ? { esito: 'ok', dettaglio: 'versione del repo non fissata (fuori dalla build)' }
                : { esito: 'degradato', dettaglio: 'versione del repo non fissata alla build' }
        }
        const { data, error } = await supabase.rpc('salute_migrazioni')
        if (error) {
            const codice = codiceDi(error)
            if (RPC_SALUTE_ASSENTE.has(codice)) return rpcNonInstallata('salute_migrazioni', codice, adesso)
            return { esito: 'degradato', dettaglio: `lettura delle migrazioni ${codice}` }
        }
        const db = leggiStatoMigrazioniDb(data)
        if (db === null) return { esito: 'degradato', dettaglio: 'risposta di salute_migrazioni illeggibile' }
        return valutaMigrazioni(repo, db, buildIlMs(), adesso)
    })
}
```

In `eseguiSalute`, sotto la riga `        controlloPush(supabase, adesso, opzioni.ambiente),` aggiungi:

```ts
        controlloMigrazioni(supabase, adesso, opzioni.ambiente),
```

- [ ] **Passo 6: lancia i test, verdi, e prova la sostituzione nella build**

```bash
npx vitest run __tests__/lib/health/migrazioni.test.ts __tests__/architecture/migrazioni-versione-in-build.test.ts __tests__/architecture/header-sicurezza.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts 2>&1 | tail -8
npx eslint next.config.ts src/lib/health/migrazioni.ts src/lib/health/controlli.ts __tests__/lib/health/migrazioni.test.ts __tests__/architecture/migrazioni-versione-in-build.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -5
ULTIMA=$(ls supabase/migrations | grep -E '^[0-9]{14}_.+\.sql$' | sort | tail -1 | cut -c1-14); echo "$ULTIMA"
grep -rl "$ULTIMA" .next/server | head -3
```

Atteso: `Test Files  6 passed`; eslint e tsc senza righe; build ok; l'ultimo `grep` stampa almeno un file di `.next/server` (la versione è stata sostituita nel codice del server). Se non stampa niente, `controlli.ts` legge la chiave in una forma che Next non sostituisce: il lock deve diventare rosso, e va capito perché non lo è prima di andare avanti.

- [ ] **Passo 7: commit**

```bash
git add src/lib/health/migrazioni.ts next.config.ts src/lib/health/controlli.ts __tests__/lib/health/migrazioni.test.ts __tests__/architecture/migrazioni-versione-in-build.test.ts __tests__/lib/health/controlli-nuovi.test.ts __tests__/api/health.test.ts
git commit -m "Salute: il controllo migrazioni, l'ultima del repo fissata alla build contro max(version) del database" -m "Repo avanti: ok per 30 minuti dalla build, poi degradato. Database avanti: ok. Lock: next.config.ts porta la versione e controlli.ts la legge in forma statica." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 11 — Il lock «mai `giu`», i commenti e il perimetro dichiarato

**File:**
- Crea: `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts`
- Modifica: `src/lib/health/controlli.ts` (testata, righe 32-58; commento del pool di Auth, righe 645-648; testata di `eseguiSalute`)
- Modifica: `__tests__/architecture/gate-coverage.test.ts:517`, `:521`
- Modifica: `__tests__/api/health.test.ts` (un caso nuovo)

- [ ] **Passo 1: il lock**

Crea `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
    controlloCronEsiti,
    controlloEmail,
    controlloMigrazioni,
    controlloPush,
    controlloStorage,
    type Controllo,
} from '@/lib/health/controlli'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * LOCK · I CONTROLLI NUOVI DELLA SALUTE NON DICONO MAI `giu`.
 *
 * `/api/health` risponde 503 quando un controllo dice `giu`, e un 503 sveglia qualcuno: il
 * campanello lo tratta come «il sito non serve i genitori». La sessione 7 della seconda serie ha
 * aggiunto cinque controlli (`cron-esiti`, `storage`, `email`, `push`, `migrazioni`) che vedono
 * cose che nessun genitore vede subito: al più `degradato` (200). Il `503` resta di `db-lettura` e
 * `auth` (il vivo) e di `schema-atteso` quando una tabella manca o non si legge — mai per la
 * lentezza, che dal 2026-10 è `degradato` anche per lo schema.
 *
 * L'ECCEZIONE, VOLUTA (specifica della seconda serie, Sessione 7): `db-lettura` e `auth` restano
 * `giu` anche quando superano il tetto di 2 s. Sono i due controlli di `eseguiVivo`, cioè di
 * `/api/health/vivo`, che risponde 200 su `degradato`: se il loro timeout scendesse a `degradato`,
 * un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe più. Per
 * questo `MISURE_CHE_POSSONO_DIRE_GIU` li elenca, e nessun altro.
 *
 * Tre prove: nel sorgente (ogni `misura` fuori dal vivo ha `degradato` come esito sul guasto; il
 * letterale `'giu'` sta solo dentro le dichiarazioni elencate qui sotto), nei quattro moduli puri
 * (nessun `giu`), e ESEGUENDO i cinque controlli con un client che non risponde e con uno che lancia.
 */

const RADICE = process.cwd()
const leggi = (percorso: string): string => readFileSync(join(RADICE, percorso), 'utf8')
const CONTROLLI = leggi('src/lib/health/controlli.ts')

/** Le misure che possono dire `giu` quando il tetto scade o lanciano: i due controlli di
 *  `eseguiVivo`, e basta. Un loro timeout a `degradato` farebbe rispondere 200 a `/api/health/vivo`
 *  con il database appeso, e il Worker `monitor-esterno` non suonerebbe più. */
const MISURE_CHE_POSSONO_DIRE_GIU = new Set(['db-lettura', 'auth'])

/** Le dichiarazioni di `controlli.ts` dentro cui il letterale `'giu'` può comparire. */
const DICHIARAZIONI_CON_GIU = new Set(['EsitoControllo', 'controlloDbLettura', 'controlloAuth', 'controlloSchema', 'aggrega'])

const MODULI_SENZA_GIU = [
    'src/lib/health/valutazione.ts',
    'src/lib/health/cron-esiti.ts',
    'src/lib/health/fornitori.ts',
    'src/lib/health/migrazioni.ts',
]

const RE_DICHIARAZIONE = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|type\s+(\w+)|const\s+(\w+)|interface\s+(\w+))/

/** Il sorgente senza commenti, con le righe al loro posto (un commento può citare `giu`). */
function senzaCommenti(sorgente: string): string {
    return sorgente
        .replace(/\/\*[\s\S]*?\*\//g, (blocco) => blocco.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('lock · nel sorgente', () => {
    it('ogni misura fuori dal vivo ha `degradato` come esito sul guasto', () => {
        const misure = [...CONTROLLI.matchAll(/misura\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z]+)'/g)].map((m) => ({
            nome: m[1],
            suGuasto: m[2],
        }))
        // 9 misure prima della sessione 7, 14 dopo: sotto, la regex non vede più niente.
        expect(misure.length).toBeGreaterThanOrEqual(14)
        expect(misure.filter((m) => !MISURE_CHE_POSSONO_DIRE_GIU.has(m.nome) && m.suGuasto !== 'degradato')).toEqual([])
    })

    it("il letterale 'giu' compare solo nel tipo, nel vivo, nello schema e nell'aggregazione", () => {
        const dove = new Set<string>()
        let corrente = '(testa del file)'
        for (const riga of senzaCommenti(CONTROLLI).split('\n')) {
            const m = RE_DICHIARAZIONE.exec(riga)
            if (m) corrente = m[1] ?? m[2] ?? m[3] ?? m[4] ?? corrente
            if (riga.includes("'giu'")) dove.add(corrente)
        }
        expect(dove.has('aggrega'), 'la scansione non vede più `aggrega`: è diventata cieca').toBe(true)
        expect([...dove].filter((d) => !DICHIARAZIONI_CON_GIU.has(d))).toEqual([])
    })

    it.each(MODULI_SENZA_GIU)('%s non contiene giu', (percorso) => {
        expect(leggi(percorso)).not.toMatch(/['"]giu['"]/)
    })
})

/** Un client che non risponde mai: ogni accesso restituisce sé stesso, e un `await` resta appeso. */
const appeso: object = new Proxy(() => undefined, {
    get: (_bersaglio, chiave) => (chiave === 'then' ? () => undefined : appeso),
    apply: () => appeso,
})

/** Un client che lancia al primo accesso. */
const esplode: object = new Proxy(() => undefined, {
    get: () => {
        throw new Error('client rotto')
    },
})

function tuttiECinque(client: object, adesso: number): Promise<Controllo[]> {
    const s = client as unknown as SupabaseClient
    return Promise.all([
        controlloCronEsiti(s, adesso),
        controlloStorage(s),
        controlloEmail(s, adesso, 'production'),
        controlloPush(s, adesso, 'production'),
        controlloMigrazioni(s, adesso, 'production'),
    ])
}

describe('lock · eseguiti', () => {
    beforeEach(() => {
        // Tutti i canali configurati e la versione della build fissata: ogni controllo arriva al client.
        for (const nome of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
            vi.stubEnv(nome, 'valore-di-prova')
        }
        vi.stubEnv('KV_MIGRAZIONE_REPO', '20261020091500')
        vi.stubEnv('KV_MIGRAZIONI_REPO_NUMERO', '233')
        vi.stubEnv('KV_BUILD_IL', new Date().toISOString())
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllEnvs()
    })

    it('un client che non risponde: tutti e cinque degradato al tetto dei 2 s, nessuno giu', async () => {
        vi.useFakeTimers()
        const promessa = tuttiECinque(appeso, Date.now())
        await vi.advanceTimersByTimeAsync(2000)

        expect((await promessa).map((c) => [c.nome, c.esito, c.dettaglio])).toEqual([
            ['cron-esiti', 'degradato', 'oltre il tetto di 2000 ms'],
            ['storage', 'degradato', 'oltre il tetto di 2000 ms'],
            ['email', 'degradato', 'oltre il tetto di 2000 ms'],
            ['push', 'degradato', 'oltre il tetto di 2000 ms'],
            ['migrazioni', 'degradato', 'oltre il tetto di 2000 ms'],
        ])
    })

    it('un client che lancia: tutti e cinque degradato, con il nome dell’eccezione', async () => {
        expect((await tuttiECinque(esplode, Date.now())).map((c) => [c.nome, c.esito, c.dettaglio])).toEqual([
            ['cron-esiti', 'degradato', 'eccezione Error'],
            ['storage', 'degradato', 'eccezione Error'],
            ['email', 'degradato', 'eccezione Error'],
            ['push', 'degradato', 'eccezione Error'],
            ['migrazioni', 'degradato', 'eccezione Error'],
        ])
    })
})
```

In `__tests__/api/health.test.ts`, dopo il caso di `storage` del Compito 8, aggiungi:

```ts
    it('i cinque controlli nuovi rotti tutti insieme: 200 e degraded, mai 503', async () => {
        for (const nome of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
            vi.stubEnv(nome, 'valore-di-prova')
        }
        const rifiuti = (evento: string, provider: string) => ({
            id: `rifiuto-${evento}-${provider}`,
            evento,
            livello: 'error',
            sorgente: 'server',
            ambiente: 'production',
            stato_http: 403,
            occorrenze: 5,
            creato_il: fa(10 * MIN),
            visto_l_ultima: fa(10 * MIN),
            operazione: 'invio',
            contesto: { campi: { provider, operazione: 'invio' } },
        })
        const sano = dbSano()
        montaDb({
            ...sano,
            app_log: [...sano.app_log, rifiuti('email', 'resend'), rifiuti('push', 'fcm'), rifiuti('push', 'web-push')],
        })
        rpc.cronEsiti.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'x' } })
        rpc.migrazioni.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'x' } })
        storage.list.mockRejectedValue(new TypeError('fetch failed'))

        const { stato, header, corpo } = await chiama()

        expect(stato).toBe(200)
        expect(header).toBe('degraded')
        expect(corpo.stato).toBe('degraded')
        for (const nome of ['cron-esiti', 'storage', 'email', 'push', 'migrazioni']) {
            expect(controllo(corpo, nome).esito, nome).toBe('degradato')
        }
        expect(corpo.controlli.filter((c) => c.esito === 'giu')).toEqual([])
    })
```

- [ ] **Passo 2: lancia, verdi da subito**

```bash
npx vitest run __tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts __tests__/api/health.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  2 passed`. Il lock nasce verde perché i Compiti 3-10 hanno già rispettato la regola. Per vederlo mordere, a mano e senza commit: cambia in `controlloStorage` `misura('storage', 'degradato'` in `misura('storage', 'giu'` e rilancia: rosso con `[{ nome: 'storage', suGuasto: 'giu' }]` e, nella parte eseguita, `['storage', 'giu', …]`. Rimetti `'degradato'` e controlla con `git diff --stat src/lib/health/controlli.ts` che non resti niente.

- [ ] **Passo 3: la testata di `controlli.ts`**

L'elenco «LE MISURE, E COSA VEDE CIASCUNA CHE LE ALTRE NON VEDONO» in testa al file il 20/10 finiva con l'elemento 9; la sessione 1 vi aggiunge il 10 (`audit-docente`), e un'altra sessione rilasciata prima di questa può averne aggiunti altri. Si cerca l'ultimo elemento numerato:

```bash
grep -nE '^ \* +[0-9]+\. `' src/lib/health/controlli.ts | tail -3
```

Atteso: l'ultima riga è l'ultimo elemento (il 20/10 l'elemento 9, `sezione-testo-allineato`; dopo la sessione 1 il 10, `audit-docente`). Sia `K` il suo numero. Dopo le righe di quell'elemento (la sua riga numerata e le righe di continuazione che la seguono, fino alla riga ` *` vuota) aggiungi le righe qui sotto, scritte per `K` = 10 (sessione 1 rilasciata): con un altro `K`, i numeri vanno da `K+1` a `K+5`, e la frase «Le misure 11-15» li riporta.

```ts
 * 11. `cron-esiti`   — ogni job ATTIVO di `pg_cron`, mensili e sola SQL compresi, ha avuto un
 *                      esito buono dentro la finestra della sua cadenza ({OGGI}).
 * 12. `storage`      — l'API dello Storage risponde e il bucket privato della sonda c'è.
 * 13. `email`        — Resend non respinge più di quanto consegna (da `app_log`, mai chiamato).
 * 14. `push`         — lo stesso per FCM e web-push, per ogni canale configurato.
 * 15. `migrazioni`   — il database ha applicato le migrazioni del repo fissate alla build.
 *
 * Le misure 11-15 (sessione 7 della seconda serie di robustezza) dicono al più `degradato`, MAI
 * `giu`: il `503` resta di `db-lettura`, `auth` e `schema-atteso`, e per lo schema solo quando una
 * tabella manca o non si legge, non quando è lenta. `db-lettura` e `auth` restano `giu` anche
 * oltre il tetto di 2 s, per scelta: sono i controlli di `eseguiVivo` (`/api/health/vivo`, 200 su
 * `degradato`), e un loro timeout a `degradato` lascerebbe muto il Worker `monitor-esterno` davanti
 * a un database appeso. Lock:
 * `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts`. Il Realtime NON ha una sonda:
 * aprire un socket a ogni lettura costerebbe più di ciò che misura; lo misura la sessione 12.
```

Sostituisci la riga

```ts
 *   `eseguiSalute`  → `/api/health`          vivo + schema, cron, errori, config, coda, regione.
```

con

```ts
 *   `eseguiSalute`  → `/api/health`          vivo + schema, cron (battito ed esiti), errori, config,
 *                                            coda, regione, storage, email, push, migrazioni.
```

- [ ] **Passo 4: il commento del pool di Auth**

Sostituisci le tre righe

```ts
 * IL PUNTO CIECO CHE QUESTO CONTROLLO CHIUDE. Il login passa da GoTrue, che ha il suo pool di
 * connessioni (fisso a 10: advisor `auth_db_connections_absolute`) e può cadere con il database
 * dell'app perfettamente sano: `db-lettura` sarebbe verde e nessun genitore riuscirebbe a entrare.
```

con

```ts
 * IL PUNTO CIECO CHE QUESTO CONTROLLO CHIUDE. Il login passa da GoTrue, che ha il suo pool di
 * connessioni e può cadere con il database dell'app perfettamente sano: `db-lettura` sarebbe verde
 * e nessun genitore riuscirebbe a entrare. Dal 2026-10-19 il pool è una PERCENTUALE, il 15 % delle
 * connessioni del database (13 su un'istanza Small); fino ad allora era fisso a 10, e l'advisor
 * `auth_db_connections_absolute` lo segnalava. Riletto il {OGGI}: l'advisor non c'è più.
```

Se il Passo 0.11 ha trovato l'advisor ancora acceso, l'ultima frase dice invece che cosa dice l'advisor quel giorno, con la data, e il resto resta com'è.

- [ ] **Passo 5: la testata di `eseguiSalute`**

Sostituisci

```ts
 * LA SALUTE — il vivo più tutto ciò che si rompe senza che nessun genitore lo veda subito: schema,
 * cron, errori del server, configurazione, coda delle fatture, code che non si svuotano, regione. NON include la qualità dei
 * dati: vedi `eseguiQualita`.
```

con

```ts
 * LA SALUTE — il vivo più tutto ciò che si rompe senza che nessun genitore lo veda subito: schema,
 * cron (battito ed esiti), errori del server, configurazione, coda delle fatture, code che non si
 * svuotano, regione, Storage, email, push e migrazioni. NON include la qualità dei dati: vedi
 * `eseguiQualita`. I cinque controlli della sessione 7 dicono al più `degradato`.
```

- [ ] **Passo 6: il perimetro dichiarato in `gate-coverage`**

In `__tests__/architecture/gate-coverage.test.ts:517`, nella stringa di `'health:GET'`, sostituisci

```text
Perimetro: tetto per IP + una risposta che non porta dati (nomi di controllo, booleani, ms, al più un codice d'errore — mai messaggi, mai conteggi, mai valori di variabili)
```

con

```text
Perimetro: tetto per IP (in memoria, per istanza: `lib/health/porta.ts`) + una risposta che non porta dati di persone (nomi di controllo, di job, di bucket e di fornitore, codici d'errore, ms e numeri d'esercizio — job attivi, invii riusciti e rifiutati, migrazioni —; mai messaggi, mai conteggi di alunni o di famiglie, mai valori di variabili)
```

Alla riga 521, nella stringa di `'health/vivo:GET'`, sostituisci `due controlli invece di otto` con `due controlli invece di tutti quelli della salute`.

- [ ] **Passo 7: lancia, verdi**

```bash
npx vitest run __tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts 2>&1 | tail -8
npx eslint src/lib/health/controlli.ts __tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  4 passed`; eslint e tsc senza righe.

- [ ] **Passo 8: commit**

```bash
git add __tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts src/lib/health/controlli.ts __tests__/architecture/gate-coverage.test.ts __tests__/api/health.test.ts
git commit -m "Salute: lock, i cinque controlli nuovi non dicono mai giu; commenti e perimetro aggiornati" -m "Il lock legge il sorgente e esegue i controlli con un client appeso e uno che lancia. Il pool di Auth è al 15 % dal 19/10; il Realtime non ha una sonda (sessione 12)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Compito 12 — PRD e tabella di stato

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (voce di changelog in cima)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (riga 7 della tabella di stato, trovata con `grep -n '^| 7 |'`)

- [ ] **Passo 1: la voce del PRD**

Rifai il conteggio del Passo 0.1 (è una lettura) e annota `{N_ISCRIZIONI}` e `{ORA_CONTEGGIO}` del giorno della PR. Poi aggiungi **in cima** a `PRD REGISTRO ELETTRONICO.md` il testo della sezione «PRD» qui sotto, con i segnaposto sostituiti dalle misure.

- [ ] **Passo 2: la riga 7 della tabella di stato**

La riga si trova per contenuto, mai per numero (le sessioni prima ne hanno chiuse altre):

```bash
grep -n '^| 7 |' docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola. Sostituisci la riga

```text
| 7 | La salute vede tutto, senza falsi «giù» | S1 (sorveglianza), S5, D10 (allarme migrazioni) | 6 | da fare | — | `s07-salute-completa` | misura di controllo a fine sessione |
```

con

```text
| 7 | La salute vede tutto, senza falsi «giù» | S1 (sorveglianza), S5, D10 (allarme migrazioni) | 6 | in revisione | — | `docs/superpowers/plans/2026-10-20-robustezza2-s07-salute-completa.md` | prima: 30 richieste {OGGI} {ORA_PRIMA} UTC, p50 {P50_PRIMA} ms, p95 {P95_PRIMA} ms; misura di controllo a fine sessione |
```

Stato **«in revisione»**, sempre queste parole (§5): mai «in produzione» su questa riga in questa PR, lo scrive la sessione che apre dopo (sezione «Per la sessione dopo»). Il numero della PR entra in R4 del «Rilascio», appena esiste.

- [ ] **Passo 3: niente segnaposto, niente segreti**

```bash
grep -nE '\{(OGGI|VERSIONE|N_ISCRIZIONI|ORA_[A-Z]+|N_JOB_ATTIVI|P(50|95)_[A-Z]+|NOMI_AGGIUNTI|SOGLIA_RIFIUTI|SHA_MERGE|DATA_7G)\}' "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md src/lib/health/*.ts
git diff origin/main -U0 | grep -nE "eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}"; echo "righe sospette: fine elenco"
```

Atteso: il primo `grep` senza righe (il PRD e il codice hanno le misure vere; `{PR}` e i numeri del «dopo» arrivano dopo); il secondo niente prima di `righe sospette: fine elenco`.

- [ ] **Passo 4: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "Robustezza 2, sessione 7: PRD e tabella di stato" -m "Voce di changelog con la misura prima e il conteggio delle iscrizioni; riga 7 in revisione." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Log

Ogni percorso nuovo lascia una traccia, e nessuna porta dati di persone.

| Dove | Cosa | Livello e destinazione |
|---|---|---|
| `src/lib/health/porta.ts` (esistente) | ogni risposta di salute non `ok`: `logEvento('config', …)` con `msg` = `nome(esito): dettaglio` per ogni controllo rotto. I cinque controlli nuovi entrano da qui senza codice nuovo: il loro `dettaglio` porta nomi di job, di bucket, di fornitore, codici e numeri | `warn` per `/api/health` (persistito in `app_log`), `error` se `down` |
| `withRoute('health:GET')` (esistente) | la riga d'esito di ogni richiesta: è il battito «la salute è stata chiesta» | `info`, solo log di Vercel |
| `rpcNonInstallata` in `src/lib/health/controlli.ts` (Compito 7) | la RPC della salute non ancora nella cache di PostgREST, dentro i 30 minuti: `logEvento('rpc', 'info', { operazione: 'health:<rpc>', esito: 'rpc-non-ancora-installata', msg })` (§5 della specifica: chi regge una RPC nuova lo dice, e perché) | `info`, evento `rpc` non persistito: log di Vercel, nessuna riga in `app_log` a ogni giro del campanello |
| `next.config.ts` (Compito 10) | `supabase/migrations` illeggibile alla build: `console.error` con l'errore | log della build su Vercel (fuori da `src/`, quindi fuori dalla regola `no-console`) |
| `fetch` strumentato dei client Supabase (esistente) | ogni `!res.ok` dello Storage (`storage`) e delle due RPC (`cron-esiti`, `migrazioni`) | già persistito secondo `livelloDi` in `supabase-fetch.ts` |
| `salute_cron_esiti`, `salute_migrazioni` | nessuna riga: leggono e basta. Il loro guasto lo scrive la porta (sopra) | — |
| battito `cron:cron-esiti` (sessione 6) | entra in `JOB_CRON` (Compito 7): se il job che scrive `cron_ultimo_esito` si ferma, lo dicono sia `cron-battito` sia `cron-esiti` («cron-esiti fermo da N min») | — |

Nessun `console.*` nuovo in `src/`; nessun nome, email, codice fiscale o messaggio di un fornitore nei `dettaglio` (lo provano i test del Compito 8 sul corpo grezzo).

---

## PRD

Il testo da mettere in cima a `PRD REGISTRO ELETTRONICO.md` (Compito 12), con le misure al posto dei segnaposto:

```markdown
## 🛡️ Changelog — Robustezza, seconda serie, sessione 7: la salute vede tutto, senza falsi «giù» — {OGGI} (branch `robustezza2/s07-salute-completa`)

**Stato:** 🟡 in revisione (PR da aprire; merge a mano del titolare). Piano: `docs/superpowers/plans/2026-10-20-robustezza2-s07-salute-completa.md`. Domande d'iscrizione contate alle {ORA_CONTEGGIO} UTC del {OGGI}: **{N_ISCRIZIONI}**.

**Misura prima** ({OGGI}, {ORA_PRIMA} UTC, 30 richieste di fila a `/api/health`): p50 **{P50_PRIMA} ms**, p95 **{P95_PRIMA} ms**. Job attivi in `cron.job`: {N_JOB_ATTIVI}.

- **Cinque controlli nuovi in `/api/health`, tutti al più `degradato` (200), mai `giu` (503).** `cron-esiti` legge con una RPC di sola lettura gli esiti che la sessione 6 registra per ogni job di `pg_cron` e giudica ogni job ATTIVO con la finestra della sua cadenza, mensili e lavori di sola SQL compresi; un job HTTP che chiama il server solo quando ha lavoro (`storici-stampe` dopo la sessione 8) è vivo anche quando la sua funzione SQL riesce senza chiamare, purché l'ultima chiamata non sia stata respinta. `storage` fa una `list` con limite 1 su un prefisso che non esiste del bucket privato `fatture`. `email` e `push` contano in `app_log` gli invii riusciti e respinti di Resend, FCM e web-push nelle ultime 24 h (mai una chiamata ai fornitori): `degradato` se i respinti sono almeno {SOGLIA_RIFIUTI} e più dei riusciti. `migrazioni` confronta l'ultima migrazione del repo, fissata alla build da `next.config.ts`, con `max(version)` del database; per 30 minuti dalla build una differenza è attesa.
- **`schema-atteso` non va più in serie e non conta più.** Una `GET … ?select=id&limit=1` per tabella, in parallelo. La `HEAD` di prima, con la versione di postgrest-js del repo, non vedeva una tabella assente (404 senza corpo letto come 204 senza errore). La lentezza dello schema è `degradato`, non più `giu`: il 503 resta per una tabella che manca o non si legge.
- **Eccezione voluta (specifica, Sessione 7):** `db-lettura` e `auth` restano `giu` anche oltre il tetto di 2 s. Sono i due controlli di `eseguiVivo`, cioè di `/api/health/vivo`, che risponde 200 su `degradato`: se il loro timeout scendesse a `degradato`, un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe più.
- **`JOB_CRON`:** entrano `fascicolo-audit-ip-retention` e `cron-esiti` (dopo il loro primo battito `ok`). I mensili e i lavori di sola SQL restano in `JOB_CRON_NON_SORVEGLIATI` perché il loro battito in `app_log` scade prima del successivo, ma non sono più ciechi: li sorveglia `cron-esiti`.
- **`config`** guarda anche {NOMI_AGGIUNTI}.
- **Il tetto per IP della salute è in memoria** (per istanza): `/api/health` non scrive più su Postgres a ogni richiesta.
- **Migrazione** `{VERSIONE}_salute_rpc_sola_lettura.sql`: `salute_cron_esiti()` e `salute_migrazioni()`, `SECURITY DEFINER`, `STABLE`, `search_path` vuoto, eseguibili solo da `service_role`. Nessuna tabella, nessuna riga scritta.
- **Log:** i guasti dei controlli nuovi passano dalla riga `config` della porta; la RPC non ancora installata lascia una riga `info` (evento `rpc`, non persistito).
- **Prove:** test con numeri letterali per ogni «no» di ogni controllo nuovo; le RPC su PGlite con il `CREATE TABLE` vero della sessione 6; lock `salute-controlli-nuovi-mai-giu`, `cadenze-cron-leggibili`, `migrazioni-versione-in-build`.

**Da fare dopo il merge:** `SELECT` di conferma della migrazione; 30 richieste «dopo» (p95 ≤ 434 ms); 0 risposte `503` per lentezza in 7 giorni (matura 7 giorni dopo il deploy; i `503` di `db-lettura` e `auth` si contano a parte); misura di controllo (query 2 bis con il filtro su `/auth/v1/user`, query 4 per bucket) nella tabella di stato.
```

Dopo il rilascio la sessione che apre dopo, nella sua «chiusura della precedente», cambia **Stato** in «✅ in produzione» con il commit di `main` e aggiunge la misura «dopo» con data e ora UTC (§5 della specifica): sezione «Per la sessione dopo» di questo piano.

---

## Rilascio

- [ ] **R1 — Conteggio** (lettura; §5). Rifai il Passo 0.1 e controlla che `{N_ISCRIZIONI}` nel PRD sia di oggi; se è cambiato, aggiornalo con l'ora nuova e:

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "Robustezza 2, sessione 7: conteggio delle iscrizioni del giorno della PR" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **R2 — I gate, tutti**

```bash
cd /Users/lerri/kidville-web-s07-salute-completa
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
CI=1 npx vitest run 2>&1 | tail -8
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
ULTIMA=$(ls supabase/migrations | grep -E '^[0-9]{14}_.+\.sql$' | sort | tail -1 | cut -c1-14); echo "$ULTIMA"
grep -rl "$ULTIMA" .next/server | head -3
```

Atteso: eslint e tsc senza righe; vitest `Test Files  … passed` senza `failed`; build ok; `$ULTIMA` = `{VERSIONE}` e almeno un file di `.next/server` che la contiene. Un solo rosso ferma il rilascio.

- [ ] **R3 — La PR, con la migrazione mostrata** («mostrare non è chiedere», `CLAUDE.md`)

```bash
cd /Users/lerri/kidville-web-s07-salute-completa
git push -u origin robustezza2/s07-salute-completa
MIG=$(ls supabase/migrations/*_salute_rpc_sola_lettura.sql)
{
  echo "## Sessione 7 della seconda serie di robustezza — la salute vede tutto, senza falsi «giù»"
  echo
  echo "Piano: \`docs/superpowers/plans/2026-10-20-robustezza2-s07-salute-completa.md\`. Specifica: §7, «Sessione 7»."
  echo
  echo "- cinque controlli nuovi (\`cron-esiti\`, \`storage\`, \`email\`, \`push\`, \`migrazioni\`), al più \`degradato\`, mai \`giu\`;"
  echo "- \`schema-atteso\` in parallelo con una GET, senza conteggio (la HEAD non vedeva una tabella assente);"
  echo "- \`JOB_CRON\` + \`fascicolo-audit-ip-retention\`, \`cron-esiti\`; \`config\` + {NOMI_AGGIUNTI};"
  echo "- tetto per IP della salute in memoria; commento del pool di Auth corretto."
  echo
  echo "**Misura prima** ({OGGI} {ORA_PRIMA} UTC): p50 {P50_PRIMA} ms, p95 {P95_PRIMA} ms. Iscrizioni contate alle {ORA_CONTEGGIO} UTC: {N_ISCRIZIONI}."
  echo
  echo "**Merge a mano del titolare** (§5): mai auto-merge. La migrazione la applica l'integrazione Supabase al merge."
  echo
  echo "### La migrazione, per intero"
  echo
  echo '```sql'
  cat "$MIG"
  echo '```'
  echo
  echo "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
} > "${TMPDIR:-/tmp}/kidville-s07/corpo-pr.md"
gh pr create --base main --head robustezza2/s07-salute-completa \
  --title "Robustezza 2, sessione 7: la salute vede tutto, senza falsi «giù»" \
  --body-file "${TMPDIR:-/tmp}/kidville-s07/corpo-pr.md"
```

Atteso: l'URL della PR; il suo numero è `{PR}`.

- [ ] **R4 — Il numero della PR nella tabella di stato**

Nella riga 7 della tabella di stato (`grep -n '^| 7 |' docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`; Stato resta «in revisione») sostituisci la colonna PR `—` con `[#{PR}](https://github.com/erricoluigi17/kidville-web/pull/{PR})`, e nel PRD «PR da aprire» con `PR [#{PR}](https://github.com/erricoluigi17/kidville-web/pull/{PR})`.

```bash
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git commit -m "Robustezza 2, sessione 7: numero della PR nella tabella di stato e nel PRD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

- [ ] **R5 — La CI, tutti i job**

```bash
gh pr checks {PR} --watch --interval 60
```

Atteso: ogni job `pass`. Un job `cancelled` non è rosso (gruppo `e2e-ci-db`: due PR pubblicate di fila si annullano a vicenda): si rilancia con `gh run rerun <id> --failed`, una PR alla volta. `DB migrate (CI)` deve passare: la migrazione non legge `schools.operativa` e si applica anche senza `pg_cron` (il test PGlite lo prova). Un rosso vero si corregge su questo ramo, con un commit nuovo.

- [ ] **R6 — Il merge lo fa il titolare, a mano.** Gli si scrive: PR `{PR}`, CI verde su tutti i job, la migrazione è nel corpo della PR. Nessun `gh pr merge`, nessun auto-merge. Quando ha fatto, `{SHA_MERGE}` è lo sha di `main`:

```bash
git fetch origin main && git rev-parse --short=12 origin/main
```

- [ ] **R7 — Il deploy e la migrazione applicata**

```bash
curl -s https://app.kidville.it/api/versione
```

Atteso: lo sha corto `{SHA_MERGE}`. Poi in sola lettura:

```sql
SELECT version, name FROM supabase_migrations.schema_migrations
 WHERE name LIKE '%salute_rpc_sola_lettura%';

SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
  FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('salute_cron_esiti', 'salute_migrazioni')
 ORDER BY 1;

SELECT (SELECT count(*) FROM public.salute_cron_esiti()) AS righe_rpc,
       (SELECT count(*) FROM cron.job WHERE active) AS job_attivi;

SELECT * FROM public.salute_migrazioni();
```

Atteso: una riga con `version` = `{VERSIONE}`; due funzioni con `prosecdef = true`, `provolatile = s`, `proconfig = {search_path=""}`, `anon` e `authenticated` falsi, `service_role` vero; `righe_rpc` = `job_attivi`; `ultima` = `{VERSIONE}`.

- [ ] **R8 — Il «dopo»: 30 richieste, non di più**

```bash
DIR="${TMPDIR:-/tmp}/kidville-s07"
date -u '+%F %T' > "$DIR/dopo-ora.txt"
for i in $(seq -w 1 30); do
  curl -s -o "$DIR/dopo-$i.json" -w '%{http_code} %{time_starttransfer}\n' https://app.kidville.it/api/health
done > "$DIR/dopo.txt"
cut -d' ' -f1 "$DIR/dopo.txt" | sort | uniq -c
cut -d' ' -f2 "$DIR/dopo.txt" | sort -n | sed -n '15p;29p'
jq -r '.stato, (.controlli[] | "\(.nome) \(.esito) \(.ms) \(.dettaglio // "")")' "$DIR/dopo-30.json"
```

Atteso: `30 200`; la 29ª misura ordinata ×1000 = `{P95_DOPO}` **≤ 434 ms** (la prova della specifica), la 15ª = `{P50_DOPO}`; `{ORA_DOPO}` da `dopo-ora.txt`. Nell'ultima riga i quattordici controlli, `stato` `ok`; `cron-esiti` comincia con `N job attivi` con N uguale a `job_attivi` di R7; `migrazioni` dice `… migrazioni, ultima {VERSIONE}`. Se il deploy ha meno di 30 minuti, `migrazioni` e `cron-esiti` possono dire «non ancora installata»: si aspetta e si rifanno **solo** le ultime due righe sul file già scaricato, non altre richieste.

Se il p95 supera 434 ms non si ripete la misura: si guarda quale controllo ha il `ms` più alto in `dopo-*.json`, e si propone al titolare l'Instant Rollback, oppure la PR piccola che toglie quel controllo da `eseguiSalute` («Ritorno indietro», terzo punto). Se un controllo nuovo è `degradato` su un guasto vero, si scrive nella PR e lo si tratta come un incidente; se è un falso allarme, si propone quella stessa PR piccola prima che il campanello apra la seconda segnalazione.

- [ ] **R9 — Il commento sulla PR**

```bash
cat > "${TMPDIR:-/tmp}/kidville-s07/dopo.md" <<'TESTO'
**Dopo** ({OGGI} {ORA_DOPO} UTC, 30 richieste a `/api/health`): p50 {P50_DOPO} ms, p95 {P95_DOPO} ms (prima: {P50_PRIMA} / {P95_PRIMA}). Migrazione `{VERSIONE}` applicata; `salute_cron_esiti()` = job attivi in `cron.job`.
TESTO
gh pr comment {PR} --body-file "${TMPDIR:-/tmp}/kidville-s07/dopo.md"
```

- [ ] **R10 — La misura di controllo (§5 della specifica), in sola lettura**

(a) **Query 2 bis con il filtro su `/auth/v1/user`**, strumento MCP `query_logs`, la stessa forma della sessione 14 (`docs/superpowers/plans/2026-10-20-robustezza2-s14-identita-condizionale.md`, Passo 0.5). Prima la chiave del percorso, su una finestra di 10 minuti:

```sql
select toString(log_attributes['request.path']) as percorso, count(*) as n
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
group by percorso order by n desc limit 5
```

Se `percorso` esce vuoto su tutte le righe, la chiave non è quella: si rifanno (b) e (c) con `toString(log_attributes['request.url']) like '%/auth/v1/user%'` al posto del filtro sul percorso, e lo si scrive accanto al numero.

(b) Le 24 h, finestra `'{giorno prima}T12:30:00Z'` → `'{giorno}T12:30:00Z'`, **tutti e due feriali**:

```sql
select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
  round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
  round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  and toString(log_attributes['request.path']) = '/auth/v1/user'
group by colo order by n desc limit 8
```

(c) La stessa query sulla punta, `'{giorno}T07:55:00Z'` → `'{giorno}T08:05:00Z'`.

Atteso: chiamate in 24 h (somma di `n`), p50 e p95 in 24 h e in punta, con data e ora UTC. Confronto: il 20/10, 146.787 chiamate, p95 201 ms sulle 24 h; soglia della sessione 14: p95 in punta > 300 ms **oppure** > 200.000 chiamate.

(d) **Query 4**: la terza e la quarta query del Passo 0.8 (oggetti e byte per bucket; dimensione del DB e dello Storage). Si scrive la somma di `gallery` + `video_originals` contro i 20 GB di T2.

I numeri vanno nella colonna «Note» della riga 7 della tabella di stato, con data e ora UTC: li scrive la sessione che apre dopo, nella sua chiusura della precedente, insieme allo stato «in produzione» e al «dopo» (§5; sezione «Per la sessione dopo», punto 4). Fino ad allora stanno nel commento della PR, dove quella sessione li legge:

```bash
gh pr comment {PR} --body "Misura di controllo ({OGGI}): /auth/v1/user 24 h <n> chiamate, p95 <p95> ms; punta 07:55–08:05 p95 <p95 punta> ms. Storage: gallery + video_originals <GB> GB su 20; DB <dimensione>."
```

(i valori fra `<…>` si scrivono dalla misura prima di lanciare il comando).

- [ ] **R11 — Sette giorni dopo: matura dal {DATA_7G}, la scrive chi viene dopo**

La seconda metà della «Prova» («0 risposte `503` per lentezza in 7 giorni») matura il {DATA_7G}, dopo la pulizia di R12. Non si apre un ramo di soli documenti per scriverla (§5): la scrive la prima PR che tocca la specifica dopo quel giorno, con le query della sezione «Per la sessione dopo», punto 5. Qui si scrive solo il giorno, nel commento della PR:

```bash
gh pr comment {PR} --body "La misura dei 7 giorni (0 risposte 503 per lentezza; i 503 di db-lettura e auth a parte) matura il {DATA_7G}, contando dalle {ORA_DOPO} UTC del {OGGI}."
```

Atteso: l'URL del commento.

- [ ] **R12 — Pulizia: solo ciò che è di questa sessione** (`AGENTS.md`, punto 3; §5: i rami di altre sessioni con una PR aperta restano)

```bash
cd /Users/lerri/kidville-web
git worktree remove /Users/lerri/kidville-web-s07-salute-completa
git branch -D robustezza2/s07-salute-completa
git push origin --delete robustezza2/s07-salute-completa
git worktree list && git branch -a | grep -c 's07-salute-completa'
```

Atteso: il worktree non è più in elenco; `0`.

---

## Ritorno indietro

- **Subito:** Instant Rollback di Vercel sul deploy prima di `{SHA_MERGE}`, dal pannello, lo fa il titolare. Il codice vecchio non chiama le due RPC, e lasciarle in piedi è innocuo (leggono e basta, solo `service_role`).
- **Poi:** una PR di revert su un ramo `revert/s07-salute-completa` (fuori dal prefisso `robustezza2/`, §5: le sessioni dopo cercano le PR con `head:robustezza2/` e la chiusura della precedente cerca un piano con quel nome), `git revert {SHA_MERGE}` (le PR di questo repo entrano in `main` come un commit solo, «… (#NNN)»; se `git cat-file -p {SHA_MERGE}` mostra due `parent`, è `git revert -m 1 {SHA_MERGE}`), con la stessa CI e lo stesso merge a mano.
- **Un controllo solo:** i commit dei Compiti 7-10 si appoggiano l'uno all'altro (`RPC_SALUTE_ASSENTE` e `rpcNonInstallata` servono anche a `migrazioni`), quindi un falso allarme non si toglie con il revert di un commit: si apre una PR piccola che toglie la riga di quel controllo da `eseguiSalute`, il suo nome dall'elenco del caso sano di `__tests__/api/health.test.ts` e, nello stesso file, il suo caso di rotta e il suo nome nel caso «i cinque controlli nuovi rotti tutti insieme». La funzione resta, con i suoi test e con il lock del Compito 11 che la esegue; la regola non si abbassa, si corregge in una PR sua.
- **La migrazione:** la sezione «ROLLBACK» della sua intestazione diventa una migrazione nuova (`DROP FUNCTION IF EXISTS` × 2 e `NOTIFY pgrst, 'reload schema'`) **solo** dentro la PR di revert, mai applicata a mano: `schema_migrations` resterebbe disallineato, e il controllo `migrazioni` lo direbbe.
- **Nessun dato da ripristinare:** la sessione non scrive righe. Il revert del Compito 2 rimette il contatore condiviso del tetto per IP in `tetto_frequenza`, che riprende a crescere.

---

## Per la sessione dopo

Questa sezione la esegue la sessione che apre dopo il merge di questa, nel suo primo commit (§5, «la chiusura della precedente»): chi la esegue non ha letto il resto del piano, e qui trova tutto. Tutte le query sono **in sola lettura** (`execute_sql` e `query_logs`); in produzione non si scrive niente.

- [ ] **1. I dati di questa sessione**

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s07-salute-completa" --json number,mergedAt,mergeCommit --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid)"'
git ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | grep '_salute_rpc_sola_lettura\.sql$'
```

Atteso: una riga `<PR7> <istante del merge> <sha>` e un nome di file. `<V7>` sono le prime 14 cifre del nome; `<SHA7>` le prime 8 cifre dello sha; `<MERGE7>` l'istante del merge (UTC). I numeri presi dalla sessione dopo il merge stanno nei commenti della sua PR («Dopo», «Misura di controllo», «La misura dei 7 giorni … matura il …»):

```bash
gh pr view <PR7> --repo erricoluigi17/kidville-web --json comments --jq '.comments[].body'
```

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE version = '<V7>';
SELECT (SELECT count(*) FROM public.salute_cron_esiti()) AS righe_rpc,
       (SELECT count(*) FROM cron.job WHERE active) AS job_attivi;
```

Atteso: una riga; `righe_rpc` = `job_attivi`. Se la version manca, ci si **ferma** e lo si dice al titolare: una migrazione non si applica a mano (§8, divieto 4).

- [ ] **2. Le fotografie: solo quella delle migrazioni**

La migrazione crea due funzioni di sola lettura e niente altro: nessun indice unico, nessuna chiave esterna, nessuna policy, nessuna tabella. Cambia solo la fotografia delle migrazioni.

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
# la query stampata si esegue in produzione con execute_sql (sola lettura); la risposta JSON in /tmp/kidville-chiusura-s07-migrazioni.json
node __tests__/fixtures/migrazioni-fotografia.mjs < /tmp/kidville-chiusura-s07-migrazioni.json
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/migrazioni-versione-in-build.test.ts 2>&1 | tail -5
```

Atteso: `<V7>_salute_rpc_sola_lettura.sql` fra le version della fotografia; `Test Files  2 passed`.

- [ ] **3. Le liste «fino alla chiusura»**

Di solito non c'è niente da togliere: la migrazione non contiene le parole che le guardie delle fotografie riconoscono, e quindi non è in `MIGRAZIONI_ATTESE_AL_MERGE`. Si controlla:

```bash
grep -n "_salute_rpc_sola_lettura.sql'" __tests__/architecture/soglia-fotografia.ts
```

Atteso: **nessuna riga**. Se ce n'è una (il Compito 6 l'ha dovuta dichiarare, e la sua ragione nomina la guardia), si rigenera dalla produzione la fotografia di quella guardia col generatore che il suo messaggio d'errore nomina, si toglie la voce `'<V7>_salute_rpc_sola_lettura.sql'` e sotto il suo commento datato si aggiunge `// SVUOTATA il <giorno> (chiusura nel primo commit della sessione seguente, dopo il merge di #<PR7>, \`<SHA7>\`): applicata dall'integrazione; fotografie rigenerate dalla produzione.` Poi `npx vitest run __tests__/architecture/soglia-fotografia.test.ts` → `Test Files  1 passed`.

**Condizionale, mai in questa chiusura:** se la PR #<PR7> dice che `fascicolo-audit-ip-retention` o `cron-esiti` è rimasto in `JOB_CRON_NON_SORVEGLIATI` perché il suo primo battito `ok` non c'era (Compito 7, Passo 1), lo si sposta in `JOB_CRON` **solo dopo aver visto il battito** con la query qui sotto e **col sì del titolare**, in una PR piccola sua, non nel commit di chiusura:

```sql
SELECT contesto->'campi'->>'operazione' AS job, contesto->'campi'->>'esito' AS esito, livello,
       count(*) AS righe, max(visto_l_ultima) AS ultimo
  FROM app_log
 WHERE evento = 'cron' AND ambiente = 'production'
   AND contesto->'campi'->>'operazione' IN ('fascicolo-audit-ip-retention', 'cron-esiti')
   AND visto_l_ultima > now() - interval '3 days'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

- [ ] **4. La riga 7 della tabella di stato**

La misura «dopo» (30 richieste) e la misura di controllo (§5: query 2 bis su `/auth/v1/user`, query 4 per bucket e dimensioni) sono già mature: le ha prese questa sessione dopo il merge e stanno nei commenti della PR (punto 1). Se uno dei due commenti manca, la misura si rifà con i comandi di «Rilascio», R8 (30 richieste, non di più) o R10 (sola lettura) di questo piano, e si scrive con il suo giorno e la sua ora.

```bash
grep -n "^| 7 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga con Stato `in revisione`. Diventa (PR e Piano restano; la Nota tiene il «prima» che c'è già e aggiunge il resto):

```markdown
| 7 | La salute vede tutto, senza falsi «giù» | S1 (sorveglianza), S5, D10 (allarme migrazioni) | 6 | ✅ in produzione dal <giorno di MERGE7> (commit `<SHA7>`) | <PR come già scritta> | `docs/superpowers/plans/2026-10-20-robustezza2-s07-salute-completa.md` | <il «prima» già scritto>; dopo: 30 richieste <giorno> <ora> UTC, p50 <p50> ms, p95 <p95> ms; misura di controllo (<giorno> <ora> UTC): `/auth/v1/user` <n> chiamate in 24 h, p95 <p95> ms, punta p95 <p95 punta> ms; Storage `gallery` + `video_originals` <GB> GB su 20; DB <dimensione>; 503 per lentezza in 7 giorni: <numero del punto 5, oppure «matura dal <MERGE7 + 7 giorni>»> |
```

- [ ] **5. La misura dei 7 giorni — matura da `<MERGE7>` + 7 giorni**

È la seconda metà della «Prova» della specifica: «0 risposte `503` per lentezza in 7 giorni (un `503` di `db-lettura` o `auth` si conta a parte e si legge)». Se all'istante della chiusura i 7 giorni non sono passati, la misura **non** si scrive: nella riga 7 e nel PRD resta «matura dal <MERGE7 + 7 giorni>», e la scrive la prima PR che tocca la specifica dopo quel giorno, con queste stesse query. La finestra va dal merge all'istante della query, e si scrive con le due date.

Il totale delle risposte `down` della salute e delle risposte 5xx della route:

```sql
SELECT count(*) AS righe, coalesce(sum(occorrenze), 0) AS occorrenze
  FROM app_log
 WHERE ambiente = 'production' AND visto_l_ultima > '<MERGE7>'
   AND (
         (evento = 'config' AND livello = 'error'
          AND contesto->'campi'->>'operazione' = 'health' AND contesto->'campi'->>'esito' = 'down')
      OR (contesto->'campi'->>'operazione' = 'health:GET' AND stato_http >= 500)
       );
```

Da dove vengono i `503`: la porta della salute (`src/lib/health/porta.ts`) scrive nel `messaggio` `health: down — nome(esito): dettaglio | …`, e un controllo che supera il tetto ha il dettaglio `oltre il tetto di <n> ms` (`misura` in `src/lib/health/controlli.ts`). Si separano i tre casi:

```sql
WITH giu AS (
  SELECT a.id, a.occorrenze, m[1] AS controllo, btrim(coalesce(m[2], '')) AS dettaglio
    FROM app_log AS a
    CROSS JOIN LATERAL regexp_matches(a.messaggio, '([a-z0-9-]+)\(giu\)(?::\s*([^|]*))?', 'g') AS m
   WHERE a.ambiente = 'production' AND a.visto_l_ultima > '<MERGE7>'
     AND a.evento = 'config' AND a.livello = 'error'
     AND a.contesto->'campi'->>'operazione' = 'health' AND a.contesto->'campi'->>'esito' = 'down'
)
SELECT CASE WHEN controllo IN ('db-lettura', 'auth') THEN 'vivo, a parte'
            WHEN dettaglio LIKE 'oltre il tetto%' THEN 'lentezza'
            ELSE 'guasto' END AS tipo,
       controllo, left(dettaglio, 60) AS dettaglio,
       count(DISTINCT id) AS righe, sum(occorrenze) AS occorrenze
  FROM giu
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

```bash
gh issue list --repo erricoluigi17/kidville-web --state all --search "Salute: in:title" --limit 50 \
  --json number,state,createdAt,title --jq '.[] | "\(.number) \(.state) \(.createdAt) \(.title)"'
```

Atteso:
- **`lentezza`: nessuna riga.** È la «Prova». Una riga qui è un controllo diverso da `db-lettura` e `auth` che dice ancora `giu` per lentezza: un difetto, da scrivere al titolare e nel PRD, non da nascondere;
- **`vivo, a parte`**: `db-lettura` o `auth` `giu`, con `oltre il tetto …` (database o GoTrue sopra i 2 s: l'eccezione voluta, perché `/api/health/vivo` risponde 200 su `degradato` e il Worker `monitor-esterno` non suonerebbe più) o con un codice d'errore. Si leggono una per una e si scrivono come numero a parte nella riga 7 («503 del vivo: <n>, <dettagli>»);
- **`guasto`**: `schema-atteso` con una tabella assente o illeggibile, o un altro `giu` vero; si leggono e si scrivono;
- le segnalazioni «Salute:» aperte dopo il merge, una per una, col controllo che le ha aperte: un falso allarme di un controllo nuovo si corregge con una PR sua, non abbassando la regola.

Solo nomi di controllo, codici e conteggi: nessun dato personale.

- [ ] **6. Lo Stato nel PRD**

```bash
grep -n "sessione 7: la salute vede tutto" "PRD REGISTRO ELETTRONICO.md"
```

Nella voce trovata, nella riga che comincia con `**Stato:** 🟡 in revisione`, la parte `🟡 in revisione (PR [#<PR7>](…); merge a mano del titolare)` diventa `✅ in produzione dal <giorno di MERGE7> (commit \`<SHA7>\`, PR [#<PR7>](https://github.com/erricoluigi17/kidville-web/pull/<PR7>), merge a mano del titolare)`; il resto della riga (piano, domande d'iscrizione contate) resta. Subito sotto si aggiunge:

```markdown
**Misura dopo** (<giorno> <ora> UTC, 30 richieste a `/api/health`): p50 **<p50> ms**, p95 **<p95> ms**. Migrazione `<V7>_salute_rpc_sola_lettura.sql` applicata dall'integrazione; `salute_cron_esiti()` = <job_attivi> job attivi. 503 per lentezza in 7 giorni: **<numero>** (<data inizio> → <data fine> UTC; 503 del vivo a parte: <n>), oppure: matura dal <MERGE7 + 7 giorni>.
```

- [ ] **7. Cosa sapere per le sessioni che toccano la salute dopo questa**

- **La regola di `email` e `push`** sta in `src/lib/health/fornitori.ts`, non in `controlli.ts`: `contaEsitiFornitore` conta come **rifiuti solo le righe `error`** (il gettone OAuth di FCM compreso) e come riusciti solo le righe `info` con stato 2xx che non siano il gettone (`operazione: oauth-token`, insieme `OPERAZIONI_NON_INVII`); le righe `warn` e le `info` non 2xx non contano. `fornitoreInAffanno` è vero se i rifiuti sono almeno `SOGLIA_RIFIUTI_FORNITORE` (3, salvo la misura 0.6 scritta nella PR) **e** più dei riusciti; la finestra è `FINESTRA_FORNITORI_MS` (24 h, in pratica 24-48 h perché le occorrenze di `app_log` sono per giorno). `controlloEmail` e `controlloPush` in `controlli.ts` leggono soltanto. Chi cambia che cosa è un rifiuto o un invio riuscito (la sessione 9, che toglie i successi finti) cambia `contaEsitiFornitore` e `__tests__/lib/health/fornitori.test.ts`.
- **`RPC_SALUTE_ASSENTE`** (`PGRST202`, `42883`), **`rpcNonInstallata`** e **`buildIlMs`** sono funzioni e costanti **locali** di `src/lib/health/controlli.ts`, non esportate, e valgono solo per le due RPC della salute (§5: un insieme locale per ogni RPC nuova). Una sessione che regge una sua RPC nuova scrive il suo insieme locale, con un nome suo, nel suo file: non importa questi.
- **`vivo_il` di `salute_cron_esiti()`** prende anche l'ultima esecuzione SQL riuscita di un job HTTP la cui ultima chiamata non è stata respinta: un job che chiama il server solo quando ha lavoro (la sessione 8 lo fa con `storici_tick`) non diventa un allarme a coda vuota, e la RPC non va toccata per questo.
- **I controlli nuovi non dicono mai `giu`**: il lock `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts` lo impone, e le sole misure che possono dire `giu` sul tetto o su un'eccezione sono `db-lettura` e `auth` (`MISURE_CHE_POSSONO_DIRE_GIU`). Un controllo nuovo di un'altra sessione entra con `degradato` come esito sul guasto.

---

## Autorevisione

**Copertura della specifica (§7, «Sessione 7»):**

| Specifica | Dove |
|---|---|
| Misura prima: 30 richieste, 30 tracce | Passo 0.4; il «dopo» in R8 con lo stesso ciclo |
| Schema: da un ciclo in serie con `count:'exact'` a `Promise.all` senza conteggio | Compito 3 |
| `cron-esiti` legge una RPC di sola lettura sulle tabelle della 6 | Compiti 5, 6, 7 |
| `JOB_CRON` assorbe quasi tutto `JOB_CRON_NON_SORVEGLIATI`, ogni voce dopo il primo `ok` | Compito 7 (due job entrano dopo il Passo 0.7; i mensili e i SQL li sorveglia `cron-esiti`: Scelte, punto 1) |
| `storage` con una `list` di limite 1 | Compito 8 |
| `email` dagli esiti di Resend in `app_log`, senza chiamare Resend | Compito 9 |
| `push` (configurazione + battito) | Compito 9 (configurazione; il battito è già `push-dispatch`: Scelte, punto 5) |
| `migrazioni`: versione del repo fissata alla build contro `max(version)` da una RPC | Compiti 6, 10 |
| Tutti al più `degradato`, mai `giu` | Compito 11 (lock nel sorgente ed eseguito) |
| Eccezione voluta: `db-lettura` e `auth` restano `giu` oltre i 2 s (sono i controlli di `eseguiVivo`; `/api/health/vivo` risponde 200 su `degradato`; il Worker `monitor-esterno`) | Obiettivo; Scelte, punto 18; testata di `valutazione.ts` (Compito 5); lock e `MISURE_CHE_POSSONO_DIRE_GIU` (Compito 11, Passo 1); testata di `controlli.ts` (Compito 11, Passo 3); PRD |
| `controlloConfig` guarda tutte le variabili critiche | Compito 4 |
| Tetto per IP in memoria (`porta.ts:53,79`) | Compito 2 |
| Commento del pool di Auth (`controlli.ts:647`) | Compito 11, Passo 4 |
| Realtime senza sonda (sessione 12) | Compito 11, Passo 3 |
| Codice che regge il merge: `PGRST202`/`42883` solo su quella chiamata, insieme locale, riga `info` | Compito 7 (`RPC_SALUTE_ASSENTE`, `rpcNonInstallata`) |
| Prova: p95 ≤ 434 ms; 0 `503` per lentezza in 7 giorni, i `503` di `db-lettura` e `auth` contati a parte; job nel corpo = `cron.job` attivi, mai un numero fisso; un test con numeri letterali per ogni «no» | R8; «Per la sessione dopo», punto 5 (matura dopo 7 giorni, tre casi separati dal `messaggio` della porta); R7-R8 (`righe_rpc` = `job_attivi`); Compiti 5, 6 (`vivo_il`), 7-10 |
| Indietro: Instant Rollback e revert; RPC innocue | «Ritorno indietro» |
| A fine sessione: misura di controllo (§5) | R10 (nel commento della PR); nella riga 7 la porta la sessione dopo («Per la sessione dopo», punto 4) |
| §5: conteggio delle iscrizioni prima della migrazione, nel PRD con data e ora | Passo 0.1, Compito 12, R1 |
| §5: merge a mano del titolare, pulizia dei soli rami della sessione, tabella di stato in due tempi | R6, R12, Compito 12 e R4 (Stato «in revisione»); il secondo tempo lo fa la sessione che apre dopo, con la sezione «Per la sessione dopo» |
| §5: prerequisiti (PR della 6 mergiata, sua migrazione applicata, nessuna PR aperta); chiusura della sessione rilasciata per ultima nel primo commit; riferimenti per contenuto; niente rami di soli documenti | Compito 1, Passi 1 e 4; ancore di testo nei Compiti 3, 7, 11; R11 |
| §6: «Apertura e chiusura» e sezione «Per la sessione dopo» | Compito 1; sezione «Per la sessione dopo» |

**Segnaposto:** cercati nel piano i segnaposto vietati dalla consegna, senza risultati. I soli segnaposto sono i nomi fra graffe della tabella «Convenzioni», ciascuno con il passo che lo misura; il controllo prima di ogni commit li cerca nel diff.

**Coerenza dei nomi:** `Valutazione`, `EsitoSenzaGiu`, `TOLLERANZA_MERGE_MS` e `inAttesaDellIntegrazione` (Compito 5) sono gli stessi nei Compiti 7 e 10; `RigaCronEsito`, `finestraDaCadenza`, `leggiRigheCronEsiti`, `valutaCronEsiti` (Compito 5) nel Compito 7 e nel lock delle cadenze; `RPC_SALUTE_ASSENTE`, `rpcNonInstallata` e `buildIlMs` (Compito 7) nel Compito 10; `RigaEsitoFornitore`, `contaEsitiFornitore`, `valutaFornitore`, `FINESTRA_FORNITORI_MS` (Compito 9) solo lì; `StatoMigrazioni`, `statoMigrazioniRepo`, `leggiStatoMigrazioniDb`, `valutaMigrazioni` (Compito 10) in `next.config.ts` e in `controlli.ts`; le colonne `job`, `cadenza`, `esito`, `visto_il`, `vivo_il` e `ultima`, `numero` sono le stesse nella migrazione (Compito 6), nei test PGlite, in `leggiRigheCronEsiti`/`leggiStatoMigrazioniDb` e nei finti di `health.test.ts` (Compito 2); i nomi dei controlli `cron-esiti`, `storage`, `email`, `push`, `migrazioni` sono gli stessi nell'elenco del caso sano, nel lock e nella testata.

**Dubbi rimasti, scritti e non risolti qui:**
- `JOB_CRON` «assorbe» alla lettera solo due job: i mensili non possono stare sotto `cron-battito` (Scelte, punto 1). La specifica va letta con `cron-esiti`.
- Il contratto con `cron_ultimo_esito` viene dal piano della sessione 6 (ricontrollato sul suo `CREATE TABLE` e sulla funzione `cron_esiti`): il test PGlite lo legge dal file vero, quindi un cambiamento della 6 diventa rosso qui.
- Un job attivo per cui la 6 non scrive mai una riga resta «in attesa del primo esito» per sempre, senza allarme: `cron.job` non dice quando è nato. Lo si vede nel dettaglio, non nello stato.
- `cron-battito` e `cron-esiti` possono suonare insieme per lo stesso job (due segnalazioni): accettato (Scelte, punto 15).
- `vivo_il` di un job HTTP prende l'ultima esecuzione SQL riuscita anche dopo un `timeout` (Scelte, punto 17): è la regola «timeout del client = vivo» del modulo. Il prezzo: una route che va sempre in timeout **e** il cui job smette di chiamare resta vivo finché la funzione SQL riesce; se la route va in timeout a ogni giro, il dettaglio lo dice («timeout del client, vivi: …») e la riga `cron-http-timeout:<job>` della sessione 6 lo conta. Escluderlo avrebbe acceso un allarme permanente su un job sano rimasto senza lavoro dopo un timeout.
- La finestra di `email`/`push` va da 24 a 48 h (occorrenze per giorno), uguale per riusciti e rifiuti.
- Una Preview che legge la produzione vede `migrazioni` `degradato` dopo 30 minuti se la sua PR porta una migrazione (Scelte, punto 16).
- `code-arretrate` usa ancora `head: true` sulle sue code: stessa cecità della `HEAD` dello schema, ma lì «assente» vale già `ok`, quindi non cambia l'esito. Non toccato.
- I «13 su Small» del pool di Auth vengono dalla specifica; il Passo 0.11 rilegge l'advisor, non il numero.
- La chiave `request.path` della query 2 bis è quella della sessione 14 e non è verificata da qui: R10 (a) la cerca prima di usarla.
