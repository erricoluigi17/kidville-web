# Sessione 1 — Iscrizioni: documenti mai persi, stati vincolati — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** la conservazione delle iscrizioni non può togliere un documento ancora citato da un'anagrafica o dal fascicolo, una domanda già esaminata non si può respingere, gli stati di domande e alunni sono vincolati dal database, e una traccia d'audit persa accende la salute.

**Architettura:** un modulo nuovo (`src/lib/iscrizioni/percorsi-citati.ts`) dice quali allegati di una domanda sono ancora nominati da `alunni`, `parents` o `student_documents`. Il giro mensile lo interroga prima di toccare il bucket, lascia al loro posto i file citati e, se non riesce a saperlo, non tocca niente. Il rifiuto mette lo stato `pending` dentro l'`UPDATE` stesso e risponde `409` con un codice quando non trova righe. Una migrazione aggiunge due `CHECK` (`NOT VALID`, poi `VALIDATE`) solo se il conteggio delle righe fuori elenco è zero. `/api/health` riceve un decimo controllo, `audit-docente`.

**Tecnologie:** Next.js (App Router, route handler), Supabase (PostgREST, Postgres, Storage), vitest, il finto Supabase del repo (`__tests__/fixtures/finto-supabase.ts`).

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 1 — Iscrizioni: documenti mai persi, stati vincolati» (righe 255-289 della versione del 20/10), con la guardia del 31/10 della §3, «Scadenze» (righe 97-106), e le regole comuni della §5, in particolare «La tabella di stato», «Apertura di una sessione: i prerequisiti» e «… la chiusura della precedente».

---

## 🔴 Prima di tutto: la guardia del 31/10

Il giro `iscrizioni-retention` parte **l'1/11 alle 04:41 UTC** (`41 4 1 * *`). Questa sessione deve essere in produzione entro il **31/10**: è lavoro da una o due giornate.

Se il 31/10 la PR non è ancora in produzione, quel giorno si esegue questa lettura sul database di produzione:

```sql
select count(*) from enrollment_submissions
where imported_at is not null and status in ('pending','rejected');
```

Il risultato atteso è **0**. Se è maggiore di 0, il titolare spegne il giro dell'1/11 dal pannello di pg_cron **prima delle 04:41 UTC**. Il nome esatto del job si ricava dalla query 0.7 qui sotto. Spegnerlo è una scrittura in produzione: la fa il titolare, non chi esegue.

Una sessione alla volta (§5): in questa giornata non parte nessun'altra sessione della seconda serie.

---

## Mappa dei file

| File | Azione | Ruolo |
|---|---|---|
| `src/lib/iscrizioni/stati.ts` | Crea | La lista unica degli stati di una domanda (`STATI_DOMANDA`, `STATO_DOMANDA_IN_ATTESA`). Prima era una costante privata della route, e un file di route non può esportarla. |
| `src/lib/iscrizioni/percorsi-citati.ts` | Crea | `percorsiCitati()`: quali allegati sono ancora nominati da `alunni.documento_path`, `parents.documento_path`, `student_documents.storage_path` / `.file_url`. Legge a blocchi di 25. Se una lettura fallisce restituisce `verificato: false`. |
| `src/app/api/gdpr/retention-iscrizioni/route.ts` | Modifica | Legge le citazioni dopo l'interruttore e prima di «PRIMA I FILE». Un file citato non si toglie dal bucket. Una lettura fallita dà `500 citazioni-non-lette`. Battito e risposta portano il numero dei file citati. |
| `src/app/api/admin/iscrizioni/route.ts` | Modifica | Importa `STATI_DOMANDA` e cancella la sua copia (360-361). Il rifiuto (879-893) vale solo da `pending`: se non trova righe risponde `409 DOMANDA_GIA_ESAMINATA` e scrive un `warn`. |
| `src/lib/ui/esito-fetch.ts` | Modifica | Il codice `DOMANDA_GIA_ESAMINATA` in `CODICI_ERRORE`. |
| `messages/it/shared.json`, `messages/en/shared.json` | Modifica | Le due traduzioni di `erroreDomandaGiaEsaminata`. |
| `supabase/migrations/<version>_iscrizioni_stati_vincolati.sql` | Crea | Due `CHECK`: `enrollment_submissions_status_ammesso` e `alunni_stato_ammesso`. Hanno guardie per la CI, il conteggio delle righe fuori elenco e una riga in `app_log`. La `<version>` si genera con `date -u` (Compito 6). |
| `src/lib/health/controlli.ts` | Modifica | `controlloAuditDocente()`, aggiunto a `eseguiSalute` e alla testata. |
| `__tests__/lib/iscrizioni/stati.test.ts` | Crea | Prova la lista unica e controlla che la route non ne tenga una copia. |
| `__tests__/lib/iscrizioni/percorsi-citati.test.ts` | Crea | `percorsiCitati` sul finto Supabase: le quattro sorgenti, i blocchi, la lettura fallita. |
| `__tests__/api/retention-iscrizioni-documenti-citati.test.ts` | Crea | Il giro con una domanda importata `rejected`/`pending` che cita un documento: il documento resta. |
| `__tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts` | Crea | Il rifiuto di una domanda approvata o già respinta dà 409; da `pending` dà 200. |
| `__tests__/architecture/stati-vincolati-in-sql.test.ts` | Crea | Lock: i valori dei due `CHECK` coincidono con `STATI_DOMANDA` e `STATI_TENDINA`, e ciascuno è convalidato. |
| `__tests__/lib/health/audit-docente.test.ts` | Crea | Il controllo con numeri letterali: una sola riga basta per `degradato`. |
| `__tests__/api/health.test.ts` | Modifica | Aggiunge `audit-docente` all'elenco dei controlli (163-173) e un caso `degraded` dopo il test che finisce a 182. |
| `__tests__/architecture/cestino-fascicolo-ogni-lettura-dichiara.test.ts` | Modifica | Una lettura dichiarata nuova di `student_documents`: aggiorna `COPERTE_ATTESE` (268-287) e `SOGLIA_VISTE` (299). |
| `__tests__/architecture/soglia-fotografia.ts` | Modifica | Dichiara la migrazione in `MIGRAZIONI_ATTESE_AL_MERGE` (riga 251 del 20/10, `export const MIGRAZIONI_ATTESE_AL_MERGE`); la toglie la sessione dopo, nel suo primo commit (sezione «Per la sessione dopo»). |
| `PRD REGISTRO ELETTRONICO.md` | Modifica | Voce di changelog in cima, con i conteggi del Passo 0 e l'ora UTC. |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | Modifica | Nella PR di questa sessione, la riga `^\| 1 \|` della tabella di stato passa a «in revisione» (Compito 9, Passo 5). «In produzione» lo scrive la sessione dopo. |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json`, `__tests__/fixtures/fk-utenti-snapshot.json` | Nessuna, qui | Le rigenera dalla produzione la sessione dopo, nel suo primo commit (sezione «Per la sessione dopo»). |

---

## Passo 0 — misura prima

Tutte le query sono **in sola lettura** e girano sul database di produzione, con lo strumento `execute_sql` della sessione che esegue. Restituiscono solo conteggi e nomi di stato, mai righe. Prima di proseguire, scrivi ogni risultato con data e ora UTC nelle note della sessione. Finiranno nel PRD (Compito 8) e nella descrizione della PR (Compito 9).

- [ ] **0.1 — Ora e conteggio delle domande** (regola della §5: si conta prima di ogni migrazione)

```sql
select now() at time zone 'utc' as adesso_utc, count(*) as domande from enrollment_submissions;
```

Non c'è una soglia. Il numero va nel PRD con l'ora: non si copia da nessun documento.

- [ ] **0.2 — Stati delle domande**

```sql
select status, count(*) from enrollment_submissions group by 1 order by 1;
```

Il 20/10 c'erano 3 stati. **Soglia:** ogni valore deve stare in `('approved', 'pending', 'rejected')`.
- Se c'è un valore in più, la parte `enrollment_submissions` della migrazione non aggiungerebbe il vincolo (vedi la guardia nel Compito 6). Chi esegue si **ferma** e porta al titolare il valore e il suo conteggio, senza le righe. Le strade sono due: correggere quelle righe (è una scrittura in produzione, quindi l'istruzione si mostra prima) oppure aggiungere lo stato a `STATI_DOMANDA` con una decisione scritta. I Compiti 2-5 e 7 non dipendono da questa scelta e vanno avanti.

- [ ] **0.3 — Stati degli alunni**

```sql
select coalesce(stato, '<null>') as stato, count(*) from alunni group by 1 order by 1;
```

Il 20/10 c'erano 2 stati. **Soglia:** ogni valore deve stare in `('iscritto', 'ritirato', 'sospeso')`. `<null>` è ammesso: un `CHECK` con `IN` lascia passare il NULL, e il codice lo legge come `iscritto`.
- Se c'è un valore in più (per esempio uno stato mai classificato), vale la stessa regola del punto 0.2. In più, uno stato nuovo va classificato in `src/lib/alunni/stato.ts` (`STATI_TENDINA`, `LATO_DEL_CONFINE`) **prima** di entrare nel `CHECK`, altrimenti il lock `stati-alunno-anche-in-sql` e il lock nuovo diventano incoerenti. Quel lavoro non rientra in questa sessione: la parte `alunni` esce dalla migrazione, che tiene solo quella delle domande, e il PRD lo registra.

- [ ] **0.4 — La guardia del 31/10 (§3)**

```sql
select count(*) from enrollment_submissions
where imported_at is not null and status in ('pending','rejected');
```

**Soglia:** 0. Se il risultato è maggiore di 0, si avvisa subito il titolare. Il codice di questa sessione protegge i documenti, ma finché non è in produzione vale la guardia scritta in testa al piano.

- [ ] **0.5 — Quante domande toccherebbe davvero il giro dell'1/11**

```sql
select count(*) from enrollment_submissions
where status in ('pending','rejected')
  and created_at < now() - interval '24 months'
  and raccolta_senza_informativa = false;
```

Risultato di sola informazione, da tenere per il Rilascio:
- **0**: l'1/11 il giro batte con `n_domande: 0` e `n_file_citati: 0`;
- **fra 1 e 50**: il giro lavora davvero, e `n_file_citati` può essere maggiore di 0;
- **più di 50**: scatta l'interruttore (`409`, nessuna cancellazione) e il battito `info` non arriva. Va detto al titolare prima dell'1/11.

- [ ] **0.6 — Domande in attesa o respinte i cui allegati sono già citati altrove**

È il caso D9 contato per percorso e non per `imported_at`. Un import che fallisce all'ultimo `UPDATE` (route delle iscrizioni, riga 2148) lascia la domanda `pending` con `imported_at` NULL, ma le anagrafiche sono già state create con lo stesso file.

```sql
with allegati as (
  select e.id, trim(x.elemento->>'documento_path') as percorso
  from enrollment_submissions e
  cross join lateral jsonb_array_elements(
    (case when jsonb_typeof(e.data->'children') = 'array' then e.data->'children' else '[]'::jsonb end)
    || (case when jsonb_typeof(e.data->'adults') = 'array' then e.data->'adults' else '[]'::jsonb end)
  ) as x(elemento)
  where e.status in ('pending','rejected')
)
select count(distinct a.id) as domande, count(distinct a.percorso) as allegati
from allegati a
where coalesce(a.percorso, '') <> ''
  and (exists (select 1 from alunni al where al.documento_path = a.percorso)
    or exists (select 1 from parents p where p.documento_path = a.percorso)
    or exists (select 1 from student_documents d where d.storage_path = a.percorso or d.file_url = a.percorso));
```

Non c'è una soglia, ma il numero dice quanto conta la correzione. Un valore maggiore di 0 con 0.4 a zero è la prova che la guardia della §3 non vede tutto: va scritto nel PRD.

- [ ] **0.7 — Il job da spegnere in emergenza, e i nomi dei vincoli liberi**

```sql
select jobid, jobname, schedule, active from cron.job where jobname ilike '%iscrizion%';
select conname from pg_constraint
where conname in ('enrollment_submissions_status_ammesso', 'alunni_stato_ammesso');
```

**Atteso:** un job attivo con `schedule = '41 4 1 * *'`, e **nessuna riga** per i vincoli. Se un vincolo con quel nome esiste già, ci si ferma: la migrazione lo salterebbe in silenzio, e bisogna capire chi l'ha creato.

- [ ] **0.8 — Dove sta l'esito di una traccia d'audit persa, e quante ce ne sono**

Prima di scrivere il controllo `audit-docente` si conferma la colonna, come chiede la specifica. Nel codice tre punti scrivono `esito: 'audit-non-registrato'`: `logScrittura` (evento `audit`, `src/lib/audit/scrittura.ts:131,144`), l'accesso al fascicolo (evento `fascicolo`, `src/lib/primaria/fascicolo-rbac.ts:177`) e la firma elettronica (evento `fea`, `src/lib/fea/audit.ts:60`). Le query li guardano tutti e tre.

```sql
select evento, contesto->'campi'->>'esito' as esito, sorgente, ambiente,
       count(*) as righe, sum(occorrenze) as occorrenze, max(visto_l_ultima) as ultima
from app_log
where evento in ('audit', 'fascicolo', 'fea') and livello = 'error'
  and visto_l_ultima > now() - interval '30 days'
group by 1, 2, 3, 4 order by 5 desc limit 20;

select count(distinct giorno) as giorni,
       count(*) filter (where visto_l_ultima > now() - interval '24 hours') as ultime_24h
from app_log
where livello = 'error' and sorgente = 'server'
  and contesto->'campi'->>'esito' = 'audit-non-registrato';
```

Il codice dice che l'esito sta in `contesto.campi.esito`: lo scrive `rigaEvento` in `src/lib/logging/logger.ts:699-734`, e `controlloBattitoCron` lo legge così. Il valore di `ambiente` in produzione dovrebbe essere `production`. **Soglie:**
- se la prima query ha righe `error` di quei tre eventi con `esito` NULL ma la chiave c'è in `contesto->>'esito'`, nel Compito 7 il filtro diventa `contesto->>esito` e il test si adegua;
- se `ultime_24h` è maggiore di 0, dopo il rilascio il controllo va **subito** a `degradato` e il campanello apre `salute:audit-docente` alla seconda lettura. Va detto al titolare prima del merge;
- se `giorni` è maggiore di 3 su 30, le tracce perse sono croniche e un controllo sempre rosso finirebbe spento. Chi esegue si ferma sul Compito 7 e porta il numero al titolare. Gli altri compiti proseguono.

---

## Compiti

Tutti i comandi partono da `/Users/lerri/kidville-web-s01-iscrizioni` (il worktree del Compito 1), salvo dove è scritto altro.

### Compito 1 — Apertura: prerequisiti, worktree, chiusura della precedente

**File:** nessuno, salvo quelli che tocca la chiusura del Passo 6 (solo se c'è una sessione da chiudere).

- [ ] **Passo 1: prerequisiti (§5, «Apertura di una sessione: i prerequisiti»)**

La sessione 1 non ha sessioni nella colonna «Dopo» (riga `^| 1 |` della tabella di stato): resta solo il controllo delle PR aperte. Si verificano fatti, non il testo dello «Stato».

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: **nessuna riga**. Se ne esce una, un'altra sessione della serie è in revisione o non è chiusa: **fermati** e avvisa il titolare (una sessione alla volta, §5).

- [ ] **Passo 2: la specifica e questo piano sono su `main`?**

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md && echo presente
```

Atteso: `presente`. Se manca, la PR #254 (solo documenti) non è ancora in `main`: **fermati** e chiedi al titolare di mergiarla prima di partire. Altrimenti il ramo nuovo non avrebbe né la specifica da aggiornare nella PR né l'ultima voce del PRD, e i due rami andrebbero in conflitto sulla prima riga del PRD.

- [ ] **Passo 3: crea il worktree e il ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s01-iscrizioni /Users/lerri/kidville-web-s01-iscrizioni origin/main
cd /Users/lerri/kidville-web-s01-iscrizioni && git status -sb | head -3
```

Atteso: `## robustezza2/s01-iscrizioni...origin/main`, con l'albero pulito.

- [ ] **Passo 4: `.env.local`**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s01-iscrizioni/.env.local
```

- [ ] **Passo 5: dipendenze**

```bash
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 6: chiusura della sessione rilasciata per ultima (§5, «… la chiusura della precedente»), prima di ogni codice**

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso per la sessione 1, che è la prima della serie: `null null`, cioè nessuna sessione `robustezza2/` ancora rilasciata. In quel caso **il passo si salta** e non si committa niente.

Se invece stampa un numero e un ramo (per esempio una sessione senza dipendenze, come la 11, rilasciata prima di questa), quella sessione si chiude qui, nel **primo commit** di questo ramo:

1. Apri il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md`, e leggi per intero la sua sezione finale «Per la sessione dopo». Si fa quello che c'è scritto, non quello che si presume.
2. Se quella sessione aveva migrazioni, rigenera la fotografia delle migrazioni applicate. Stampa la query:

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
4. Verifica e committa solo se c'è qualcosa da committare:

   ```bash
   npx vitest run __tests__/architecture 2>&1 | tail -10
   git status --short
   ```

   Atteso: tutto verde (salvo `offline-html-nativo`, vedi il Passo 7). Con `git status --short` vuoto non si committa. Altrimenti:

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

- [ ] **Passo 7: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
```

Atteso: tutti i file verdi tranne, al massimo, `__tests__/architecture/offline-html-nativo.test.ts`, che in un worktree nuovo è rosso perché la shell nativa non è sincronizzata. Si rilancia così:

```bash
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed (1)`. Leggi la riga `Test Files` del riepilogo, non il codice d'uscita di una pipe. Qualunque altro rosso va capito prima di toccare codice.

Non c'è niente da committare in questo passo.

---

### Compito 2 — Gli stati della domanda in un modulo solo

**File:**
- Crea: `src/lib/iscrizioni/stati.ts`
- Modifica: `src/app/api/admin/iscrizioni/route.ts:1-8` (import) e `:360-361` (la costante da togliere)
- Test: `__tests__/lib/iscrizioni/stati.test.ts`

- [ ] **Passo 1: il test rosso**

Crea `__tests__/lib/iscrizioni/stati.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATI_DOMANDA, STATO_DOMANDA_IN_ATTESA } from '@/lib/iscrizioni/stati'

/**
 * Gli stati di una domanda d'iscrizione vivono in UN posto. Dalla sessione 1 della seconda
 * serie di robustezza la stessa lista è anche un CHECK in SQL
 * (`enrollment_submissions_status_ammesso`): il lock `stati-vincolati-in-sql` confronta il
 * vincolo con questa costante, e una copia privata nella route sarebbe una terza lista che
 * nessuno confronta.
 */
describe("gli stati di una domanda d'iscrizione", () => {
    it('sono tre, con i nomi che stanno in tabella', () => {
        expect([...STATI_DOMANDA]).toEqual(['pending', 'approved', 'rejected'])
        expect(STATO_DOMANDA_IN_ATTESA).toBe('pending')
    })

    it('la route delle iscrizioni non ne tiene una copia sua', () => {
        const route = readFileSync(join(process.cwd(), 'src/app/api/admin/iscrizioni/route.ts'), 'utf8')
        expect(route).not.toMatch(/const\s+STATI_DOMANDA\s*=/)
        expect(route).toMatch(/from '@\/lib\/iscrizioni\/stati'/)
    })
})
```

- [ ] **Passo 2: verifica che fallisca**

```bash
npx vitest run __tests__/lib/iscrizioni/stati.test.ts 2>&1 | tail -15
```

Atteso: FAIL, con `Failed to resolve import "@/lib/iscrizioni/stati"`.

- [ ] **Passo 3: il codice minimo**

Crea `src/lib/iscrizioni/stati.ts`:

```ts
/**
 * GLI STATI DI UNA DOMANDA D'ISCRIZIONE — `enrollment_submissions.status`.
 *
 * Erano una costante privata di `src/app/api/admin/iscrizioni/route.ts`. Un file di route di
 * Next può esportare solo i nomi che Next conosce (`GET`, `POST`, `maxDuration`…), quindi
 * nessun test e nessun lock poteva leggerla. Dalla sessione 1 della seconda serie di
 * robustezza la stessa lista è anche un CHECK in SQL (`enrollment_submissions_status_ammesso`):
 * `__tests__/architecture/stati-vincolati-in-sql.test.ts` tiene uguali le due copie.
 */
export const STATI_DOMANDA = ['pending', 'approved', 'rejected'] as const

export type StatoDellaDomanda = (typeof STATI_DOMANDA)[number]

/**
 * L'unico stato da cui una domanda si può ancora respingere. Una domanda approvata è già
 * un'anagrafica, con il documento copiato in `alunni`/`parents`. Respingerla la rimetterebbe
 * nel giro di conservazione, che la cancellerebbe con i suoi allegati (D9 del rapporto del
 * 2026-10-20).
 */
export const STATO_DOMANDA_IN_ATTESA: StatoDellaDomanda = 'pending'
```

In `src/app/api/admin/iscrizioni/route.ts` aggiungi, subito dopo la riga 5 (`import { STATO_ISCRITTO } from '@/lib/alunni/stato'`):

```ts
import { STATI_DOMANDA } from '@/lib/iscrizioni/stati'
```

e cancella le righe 360-361:

```ts
/** I tre stati di una domanda, come stanno in `enrollment_submissions.status`. */
const STATI_DOMANDA = ['pending', 'approved', 'rejected'] as const
```

Gli usi alle righe 424 (`z.enum(STATI_DOMANDA)`) e 739 (`STATI_DOMANDA.map(…)`) restano come sono.

- [ ] **Passo 4: verifica che passi**

```bash
npx vitest run __tests__/lib/iscrizioni/stati.test.ts 2>&1 | tail -5
npx eslint src/lib/iscrizioni/stati.ts src/app/api/admin/iscrizioni/route.ts __tests__/lib/iscrizioni/stati.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `2 passed`; eslint senza output; tsc senza errori.

- [ ] **Passo 5: commit**

```bash
git add src/lib/iscrizioni/stati.ts src/app/api/admin/iscrizioni/route.ts __tests__/lib/iscrizioni/stati.test.ts
git commit -m "$(cat <<'EOF'
Iscrizioni: gli stati della domanda in un modulo solo

STATI_DOMANDA esce dalla route (un file di route non può esportarla) e va in
src/lib/iscrizioni/stati.ts, da cui la leggeranno il rifiuto e il lock sul CHECK.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 3 — Chi cita ancora un allegato: `percorsiCitati`

**File:**
- Crea: `src/lib/iscrizioni/percorsi-citati.ts`
- Modifica: `__tests__/architecture/cestino-fascicolo-ogni-lettura-dichiara.test.ts:268-287` (`COPERTE_ATTESE`) e `:299` (`SOGLIA_VISTE`)
- Test: `__tests__/lib/iscrizioni/percorsi-citati.test.ts`

Il modello è `documentoCondiviso` (`src/lib/alunni/elimina-definitivo.ts:509-556`): quando la lettura fallisce la risposta è «non lo so», e il guasto si scrive. Qui le letture sono a blocchi e non percorso per percorso, perché un giro tratta fino a 200 domande. Il modello dei blocchi è `aBlocchi` (`src/lib/db/blocchi.ts`).

Il lock `cestino-fascicolo-ogni-lettura-dichiara` pretende che ogni `from('student_documents')` di `src/` dichiari cosa fa del cestino. Questa lettura deve vedere **anche** il cestino: un documento eliminato si può ripristinare per `GIORNI_CESTINO_REGISTRO` giorni (7, `src/lib/primaria/cestino-registro.ts:25`), e se il file sparisse il «Ripristina» restituirebbe un documento senza file. Si usa quindi `fascicoloAncheNelCestino` con un motivo di almeno 60 caratteri.

- [ ] **Passo 1: il test rosso**

Crea `__tests__/lib/iscrizioni/percorsi-citati.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../../fixtures/finto-supabase'

const h = vi.hoisted(() => ({
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

import { percorsiCitati, PERCORSI_PER_QUERY } from '@/lib/iscrizioni/percorsi-citati'

/**
 * CHI CITA ANCORA UN ALLEGATO (robustezza 2, sessione 1 — D9).
 *
 * L'import copia il percorso del documento dalla domanda all'anagrafica: lo stesso file per
 * due righe. Il database è il finto del repo, che applica davvero `.in()`. Ogni «citato» ha il
 * suo gemello «non citato», e ogni lettura che può fallire ha il suo caso.
 */

const OP = 'test-percorsi-citati'
/** Percorsi inventati nella forma di `src/app/api/iscrizione/upload/route.ts:103`. */
const doc = (n: number) => `iscrizioni/prova-finta/${String(n).padStart(8, '0')}-documento-finto.pdf`

function dbVuoto(): DBFinto {
    return { alunni: [], parents: [], student_documents: [] }
}

async function chiedi(d: DBFinto, percorsi: string[], errori: Record<string, ErrorePostgrest> = {}) {
    const lette: string[] = []
    const esito = await percorsiCitati(
        creaFintoSupabase(d, lette, { errori }) as unknown as SupabaseClient,
        percorsi,
        OP,
    )
    return { esito, lette }
}

const citati = (esito: Awaited<ReturnType<typeof percorsiCitati>>) =>
    esito.verificato ? [...esito.citati].sort() : null

beforeEach(() => {
    h.eventi = []
})

describe('percorsiCitati — chi nomina ancora un allegato', () => {
    it('nessun percorso ⇒ verificato, zero letture', async () => {
        const { esito, lette } = await chiedi(dbVuoto(), [])
        expect(esito).toEqual({ verificato: true, citati: new Set() })
        expect(lette).toEqual([])
    })

    it("il documento copiato in un alunno è citato; quello che nessuno nomina no", async () => {
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-1', documento_path: doc(1) }]
        const { esito } = await chiedi(d, [doc(1), doc(2)])
        expect(citati(esito)).toEqual([doc(1)])
    })

    it('il documento copiato in un genitore è citato', async () => {
        const d = dbVuoto()
        d.parents = [{ id: 'genitore-finto-1', documento_path: doc(2) }]
        const { esito } = await chiedi(d, [doc(1), doc(2)])
        expect(citati(esito)).toEqual([doc(2)])
    })

    it('il fascicolo cita, su storage_path o su file_url, anche dal CESTINO', async () => {
        const d = dbVuoto()
        d.student_documents = [
            { id: 'fascicolo-finto-1', storage_path: doc(3), file_url: null, eliminato_il: null },
            { id: 'fascicolo-finto-2', storage_path: null, file_url: doc(4), eliminato_il: '2026-10-01T00:00:00.000Z' },
        ]
        const { esito } = await chiedi(d, [doc(3), doc(4), doc(5)])
        expect(citati(esito)).toEqual([doc(3), doc(4)])
    })

    it('il percorso chiesto con spazi ai bordi si confronta senza', async () => {
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-1', documento_path: doc(1) }]
        const { esito } = await chiedi(d, [`  ${doc(1)} `])
        expect(citati(esito)).toEqual([doc(1)])
    })

    it(`a blocchi di ${PERCORSI_PER_QUERY}: una citazione nell'ULTIMO blocco si trova`, async () => {
        const percorsi = Array.from({ length: 2 * PERCORSI_PER_QUERY + 1 }, (_, i) => doc(100 + i))
        const ultimo = percorsi[percorsi.length - 1]
        const d = dbVuoto()
        d.alunni = [{ id: 'alunno-finto-ultimo', documento_path: ultimo }]
        const { esito, lette } = await chiedi(d, percorsi)
        expect(citati(esito)).toEqual([ultimo])
        expect(lette.filter((t) => t === 'alunni')).toHaveLength(3)
    })
})

describe('percorsiCitati — «non lo so» non è «nessuno»', () => {
    for (const tabella of ['alunni', 'parents', 'student_documents'] as const) {
        it(`lettura fallita su ${tabella} ⇒ NON verificato, e un error che lo dice`, async () => {
            const { esito } = await chiedi(dbVuoto(), [doc(1)], {
                [`${tabella}:select`]: { code: '57014', message: 'canceling statement due to statement timeout' },
            })
            expect(esito).toEqual({ verificato: false })
            const errore = h.eventi.find((e) => e.livello === 'error')
            expect(errore?.campi).toMatchObject({
                operazione: OP,
                esito: 'citazioni-non-lette',
                entita_tipo: tabella,
                n_file: 1,
            })
        })
    }
})
```

- [ ] **Passo 2: verifica che fallisca**

```bash
npx vitest run __tests__/lib/iscrizioni/percorsi-citati.test.ts 2>&1 | tail -15
```

Atteso: FAIL, con `Failed to resolve import "@/lib/iscrizioni/percorsi-citati"`.

- [ ] **Passo 3: il codice minimo**

Crea `src/lib/iscrizioni/percorsi-citati.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { aBlocchi } from '@/lib/db/blocchi'
import { fascicoloAncheNelCestino } from '@/lib/primaria/cestino-fascicolo'

/**
 * GLI ALLEGATI DI UNA DOMANDA CHE QUALCUN ALTRO NOMINA ANCORA — robustezza 2, sessione 1 (D9).
 *
 * L'import di una domanda copia il percorso del documento d'identità nell'anagrafica
 * (`alunni.documento_path`, `parents.documento_path`): domanda e anagrafica puntano allo STESSO
 * file di `form_attachments`. Misurato il 20/10: 243 alunni su 243 con un documento hanno lo
 * stesso file della loro domanda. Chi toglie gli allegati di una domanda deve quindi chiedere
 * prima se un'anagrafica, o un documento del fascicolo, li nomina ancora.
 *
 * «NON LO SO» NON È «NESSUNO». Una lettura fallita restituisce `verificato: false` e chi chiama
 * non toglie niente. È lo stesso verso di `documentoCondiviso` (`src/lib/alunni/elimina-definitivo.ts`)
 * e di `percorsiCitatiDaAltriPost` (`src/lib/news/permanenza-consenso.ts`).
 *
 * A BLOCCHI. `.in()` finisce nell'URL: 25 percorsi di un centinaio di caratteri stanno larghi nei
 * limiti di una richiesta. Una risposta per blocco resta lontana dalle 1000 righe di PostgREST,
 * perché ogni percorso nasce con un uuid suo (`src/app/api/iscrizione/upload/route.ts:103`) e lo
 * nominano poche righe.
 *
 * SOLO `select` e `in`. Niente `order`, `limit` o `eq`: i test della conservazione che usano un
 * doppio piatto contano proprio quelle chiamate, e qui non servono.
 */

export const PERCORSI_PER_QUERY = 25

export type EsitoCitazioni =
    | { verificato: true; citati: ReadonlySet<string> }
    | { verificato: false }

type Lettura = PromiseLike<{ data: unknown; error: unknown }>

interface Sorgente {
    tabella: 'alunni' | 'parents' | 'student_documents'
    colonna: 'documento_path' | 'storage_path' | 'file_url'
    leggi: (supabase: SupabaseClient, blocco: string[]) => Lettura
}

const MOTIVO_FASCICOLO =
    'la conservazione delle domande non toglie dal bucket un file che un documento del fascicolo nomina ancora, anche dal cestino: il Ripristina restituirebbe un documento senza file'

function leggiFascicolo(supabase: SupabaseClient, colonna: 'storage_path' | 'file_url', blocco: string[]): Lettura {
    return fascicoloAncheNelCestino(
        supabase.from('student_documents').select(colonna).in(colonna, blocco),
        MOTIVO_FASCICOLO,
    )
}

const SORGENTI: readonly Sorgente[] = [
    {
        tabella: 'alunni',
        colonna: 'documento_path',
        leggi: (s, b) => s.from('alunni').select('documento_path').in('documento_path', b),
    },
    {
        tabella: 'parents',
        colonna: 'documento_path',
        leggi: (s, b) => s.from('parents').select('documento_path').in('documento_path', b),
    },
    { tabella: 'student_documents', colonna: 'storage_path', leggi: (s, b) => leggiFascicolo(s, 'storage_path', b) },
    { tabella: 'student_documents', colonna: 'file_url', leggi: (s, b) => leggiFascicolo(s, 'file_url', b) },
]

/**
 * Quali di questi percorsi sono ancora nominati da un'anagrafica o dal fascicolo.
 *
 * @param percorsi i percorsi degli allegati, nel bucket `form_attachments`.
 * @param op       l'operazione che chiede, per il log (la costante `JOB` della route).
 */
export async function percorsiCitati(
    supabase: SupabaseClient,
    percorsi: readonly string[],
    op: string,
): Promise<EsitoCitazioni> {
    const cercati = [
        ...new Set(percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p !== '')),
    ]
    const citati = new Set<string>()
    if (cercati.length === 0) return { verificato: true, citati }
    const cercatiInsieme = new Set(cercati)

    for (const sorgente of SORGENTI) {
        for (const blocco of aBlocchi(cercati, PERCORSI_PER_QUERY)) {
            const { data, error } = await sorgente.leggi(supabase, blocco)
            // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo un guasto di
            // lettura diventerebbe «nessuno lo cita», e il file uscirebbe proprio quando se ne
            // sa di meno.
            if (error || !Array.isArray(data)) {
                logEvento(
                    'gdpr',
                    'error',
                    {
                        operazione: op,
                        esito: 'citazioni-non-lette',
                        entita_tipo: sorgente.tabella,
                        n_file: cercati.length,
                        msg: `${op}: non si è potuto sapere se ${sorgente.tabella}.${sorgente.colonna} nomina ancora questi allegati, quindi non si toglie niente`,
                    },
                    error ?? new Error('risposta senza righe'),
                )
                return { verificato: false }
            }
            for (const riga of data as Record<string, unknown>[]) {
                const valore = riga?.[sorgente.colonna]
                if (typeof valore === 'string' && cercatiInsieme.has(valore.trim())) citati.add(valore.trim())
            }
        }
    }
    return { verificato: true, citati }
}
```

In `__tests__/architecture/cestino-fascicolo-ogni-lettura-dichiara.test.ts` aggiungi la voce in fondo a `COPERTE_ATTESE`, dopo la riga di `retention-cestino-registro` (287):

```ts
  // `fascicoloAncheNelCestino` (robustezza 2, sessione 1): la conservazione delle domande
  // d'iscrizione chiede se un documento del fascicolo, vivo o nel cestino, nomina ancora un
  // allegato prima di toglierlo dal bucket. Un letterale solo, chiamato per due colonne.
  'src/lib/iscrizioni/percorsi-citati.ts': 1,
```

e alza `SOGLIA_VISTE` da 28 a 29 (riga 299). Nel commento sopra la costante aggiungi la riga che dice cosa è cambiato:

```ts
 * 2026-10 · 29: la lettura dichiarata di `src/lib/iscrizioni/percorsi-citati.ts` (robustezza 2,
 * sessione 1). Alzata, non abbassata.
 */
const SOGLIA_VISTE = 29
```

- [ ] **Passo 4: verifica che passi**

```bash
npx vitest run __tests__/lib/iscrizioni/percorsi-citati.test.ts __tests__/architecture/cestino-fascicolo-ogni-lettura-dichiara.test.ts 2>&1 | tail -6
npx eslint src/lib/iscrizioni/percorsi-citati.ts __tests__/lib/iscrizioni/percorsi-citati.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: entrambi i file verdi (9 test nel primo); eslint e tsc senza output.

- [ ] **Passo 5: commit**

```bash
git add src/lib/iscrizioni/percorsi-citati.ts __tests__/lib/iscrizioni/percorsi-citati.test.ts __tests__/architecture/cestino-fascicolo-ogni-lettura-dichiara.test.ts
git commit -m "$(cat <<'EOF'
Iscrizioni: chi cita ancora un allegato (alunni, genitori, fascicolo)

percorsiCitati() legge a blocchi di 25 le quattro colonne che possono nominare un
allegato di una domanda. Una lettura fallita vale «non lo so» e lo scrive in un
error. Il fascicolo si legge anche dal cestino (fascicoloAncheNelCestino).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — La conservazione non toglie un documento citato

**File:**
- Modifica: `src/app/api/gdpr/retention-iscrizioni/route.ts:1-9` (import), `:298-301` (le citazioni prima dei file), `:366-380` (battito), `:415-421` (risposta)
- Test: `__tests__/api/retention-iscrizioni-documenti-citati.test.ts`

**Una scelta diversa dalla lettera della specifica.** La specifica dice che un percorso citato «finisce fra gli incerti». In `rimozione-verificata` però gli incerti sono **bloccanti**: la domanda resterebbe trattenuta e il giro risponderebbe `500 domande-trattenute` **ogni mese**, all'infinito. Il battito sarebbe un `error` e non l'`ok` che la Prova della stessa specifica pretende. Per questo un percorso citato **esce dall'elenco dei file da togliere**, mentre la riga della domanda scaduta si chiude lo stesso: il file ormai appartiene all'anagrafica e segue la sua conservazione. Il conteggio va nel battito come `n_file_citati`. Se la lettura delle citazioni fallisce non si tocca niente, né file né righe.

I tre test della conservazione già esistenti (`retention-iscrizioni-file-prima`, `-interruttore`, `-senza-informativa`) usano un doppio piatto. Lì `from()` di qualunque tabella restituisce le righe delle domande, che non hanno `documento_path`, `storage_path` né `file_url`, quindi nessuna citazione: restano verdi. `percorsiCitati` non chiama `order`, `limit` né `eq`, e i conteggi che quei test controllano (`h.limiti`, `h.ordini`, `h.filtriEq`) non cambiano.

- [ ] **Passo 1: il test rosso**

Crea `__tests__/api/retention-iscrizioni-documenti-citati.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * D9 (rapporto di robustezza del 2026-10-20): la conservazione delle iscrizioni cancellava i
 * documenti di una domanda IMPORTATA e poi respinta, o rimasta in attesa, anche se l'import li
 * aveva copiati nell'anagrafica del bambino e del genitore. Stesso file, due righe: uscendo
 * dalla domanda usciva anche dall'anagrafica.
 *
 * Il database è il finto del repo, che applica davvero i filtri e la DELETE. Lo Storage è
 * sostituito: qui conta QUALI percorsi la route chiede di togliere, non come lo Storage
 * risponde. Quello lo provano `retention-iscrizioni-file-prima.test.ts` e
 * `__tests__/lib/storage`.
 */

const CRON_SECRET = 'segreto-di-prova-non-usato-altrove'

const h = vi.hoisted(() => ({
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message: string }>,
    /** I percorsi che la route ha chiesto di togliere dal bucket, chiamata per chiamata. */
    rimossi: [] as string[][],
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))

vi.mock('@/lib/supabase/server-client', async () => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    return {
        createAdminClient: async () =>
            creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori as Record<string, ErrorePostgrest> }),
    }
})

vi.mock('@/lib/storage/rimozione-verificata', async (orig) => {
    const m = await orig<typeof import('@/lib/storage/rimozione-verificata')>()
    return {
        ...m,
        rimuoviEVerifica: async (_s: unknown, _bucket: string, percorsi: string[]) => {
            h.rimossi.push([...percorsi])
            return { rimossi: [...percorsi], giaAssenti: [], ancoraPresenti: [], incerti: [], erroreRimozione: false }
        },
    }
})

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

/** Oltre i 24 mesi da qualunque data in cui questo test girerà. */
const VECCHIA = '2024-01-15T08:00:00.000Z'
const DOC_MINORE = 'iscrizioni/prova-finta/11111111-1111-4111-8111-111111111111-documento-minore.pdf'
const DOC_ADULTO = 'iscrizioni/prova-finta/22222222-2222-4222-8222-222222222222-documento-adulto.pdf'

/** Una domanda scaduta, già importata e poi respinta, oppure rimasta in attesa: il caso D9. */
function domanda(id: string, status: 'pending' | 'rejected') {
    return {
        id,
        status,
        created_at: VECCHIA,
        imported_at: VECCHIA,
        raccolta_senza_informativa: false,
        data: { children: [{ documento_path: DOC_MINORE }], adults: [{ documento_path: DOC_ADULTO }] },
    }
}

function dbIniziale(): Record<string, Record<string, unknown>[]> {
    return {
        enrollment_submissions: [domanda('domanda-finta-1', 'rejected')],
        alunni: [],
        parents: [],
        student_documents: [],
    }
}

const chiama = () =>
    POST(
        new Request('http://localhost/api/gdpr/retention-iscrizioni', {
            method: 'POST',
            headers: { 'x-cron-secret': CRON_SECRET },
        }),
    )

const tuttiRimossi = () => h.rimossi.flat()
const battito = () => h.eventi.find((e) => e.livello === 'info' && e.campi.esito === 'retention-iscrizioni')

beforeEach(() => {
    vi.clearAllMocks()
    h.db = dbIniziale()
    h.errori = {}
    h.rimossi = []
    h.eventi = []
    process.env.CRON_SECRET = CRON_SECRET
})

describe("retention iscrizioni · un allegato citato da un'anagrafica non esce", () => {
    it('CONTROLLO POSITIVO: nessuno cita gli allegati ⇒ escono tutti e due e la domanda si chiude', async () => {
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 2, file_citati: 0 })
        expect(tuttiRimossi().sort()).toEqual([DOC_ADULTO, DOC_MINORE].sort())
        expect(h.db.enrollment_submissions).toEqual([])
        expect(battito()?.campi).toMatchObject({ n_domande: 1, n_file: 2, n_file_citati: 0 })
    })

    it("domanda importata e poi RESPINTA, documento copiato nell'alunno ⇒ il documento RESTA", async () => {
        h.db.alunni = [{ id: 'alunno-finto-1', documento_path: DOC_MINORE }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 1, file_citati: 1 })
        expect(tuttiRimossi()).not.toContain(DOC_MINORE)
        expect(tuttiRimossi()).toContain(DOC_ADULTO)
        expect(h.db.enrollment_submissions, "la riga scaduta si chiude: il file ora è dell'anagrafica").toEqual([])
        expect(battito()?.campi).toMatchObject({ n_domande: 1, n_file: 1, n_file_citati: 1 })
    })

    it('domanda rimasta IN ATTESA, documento copiato nel genitore ⇒ il documento RESTA', async () => {
        h.db.enrollment_submissions = [domanda('domanda-finta-2', 'pending')]
        h.db.parents = [{ id: 'genitore-finto-1', documento_path: DOC_ADULTO }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(tuttiRimossi()).not.toContain(DOC_ADULTO)
        expect(tuttiRimossi()).toContain(DOC_MINORE)
    })

    it('un documento del fascicolo NEL CESTINO lo nomina ancora ⇒ resta', async () => {
        h.db.student_documents = [
            { id: 'fascicolo-finto-1', storage_path: DOC_MINORE, file_url: null, eliminato_il: VECCHIA },
        ]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(tuttiRimossi()).not.toContain(DOC_MINORE)
    })

    it('tutti e due citati ⇒ nessuna chiamata allo Storage, e la domanda si chiude', async () => {
        h.db.alunni = [{ id: 'alunno-finto-1', documento_path: DOC_MINORE }]
        h.db.parents = [{ id: 'genitore-finto-1', documento_path: DOC_ADULTO }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 0, file_citati: 2 })
        expect(h.rimossi).toEqual([])
        expect(h.db.enrollment_submissions).toEqual([])
    })
})

describe('retention iscrizioni · «non so chi lo cita» non è «nessuno»', () => {
    it('lettura delle citazioni fallita ⇒ 500, nessun file, nessuna riga, nessun battito', async () => {
        h.errori = { 'parents:select': { code: '57014', message: 'canceling statement due to statement timeout' } }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'citazioni-non-lette', domande: 0 })
        expect(h.rimossi).toEqual([])
        expect(h.db.enrollment_submissions).toHaveLength(1)
        const errore = h.eventi.find((e) => e.evento === 'cron' && e.livello === 'error')
        expect(errore?.campi).toMatchObject({ esito: 'citazioni-non-lette', n_domande: 1, n_file: 2 })
        expect(battito(), 'nessun battito «fatto» su un giro che non ha fatto niente').toBeUndefined()
    })
})
```

- [ ] **Passo 2: verifica che fallisca**

```bash
npx vitest run __tests__/api/retention-iscrizioni-documenti-citati.test.ts 2>&1 | tail -20
```

Atteso: FAIL in 6 test su 6. Il controllo positivo non trova `file_citati`; i tre casi «resta» trovano il documento citato fra i rimossi; «tutti e due citati» vede una chiamata allo Storage; la lettura fallita risponde 200.

- [ ] **Passo 3: il codice minimo**

In `src/app/api/gdpr/retention-iscrizioni/route.ts`, dopo la riga 6 (`import { rimuoviEVerifica, … } from '@/lib/storage/rimozione-verificata'`):

```ts
import { percorsiCitati } from '@/lib/iscrizioni/percorsi-citati'
```

Sostituisci le righe 298-301:

```ts
        // La domanda resta legata ai SUOI allegati fino alla fine: è ciò che permette
        // di trattenere una riga sola invece dell'intero lotto.
        const perDomanda = righe.map((r) => ({ id: r.id, percorsi: percorsiAllegati(r) }))
        const tuttiIPercorsi = [...new Set(perDomanda.flatMap((d) => d.percorsi))]
```

con:

```ts
        // La domanda resta legata ai SUOI allegati fino alla fine: è ciò che permette
        // di trattenere una riga sola invece dell'intero lotto.
        const perDomanda = righe.map((r) => ({ id: r.id, percorsi: percorsiAllegati(r) }))
        const percorsiDelleDomande = [...new Set(perDomanda.flatMap((d) => d.percorsi))]

        // ── I DOCUMENTI CHE QUALCUN ALTRO NOMINA ANCORA ── (robustezza 2, sessione 1 — D9)
        // L'import copia il percorso del documento d'identità dalla domanda all'anagrafica
        // (`alunni.documento_path`, `parents.documento_path`): è LO STESSO file. Una domanda
        // importata e poi respinta, o rimasta in attesa, uscirebbe di qui portandosi via il
        // documento di un bambino iscritto. Un percorso citato NON si toglie dal bucket; la riga
        // della domanda si chiude lo stesso, perché quel file ora appartiene all'anagrafica e
        // segue la conservazione di lei. Non va fra gli «incerti»: lì tratterrebbe la domanda per
        // sempre, e il giro risponderebbe 500 ogni mese.
        // Se le citazioni non si leggono, non si tocca niente: né file né righe.
        const citazioni = await percorsiCitati(supabase, percorsiDelleDomande, JOB)
        if (!citazioni.verificato) {
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'citazioni-non-lette',
                canale,
                n_domande: righe.length,
                n_file: percorsiDelleDomande.length,
                ms: Date.now() - t0,
                msg: `${JOB}: non si è potuto sapere se gli allegati sono citati da un'anagrafica o dal fascicolo: nessun file e nessuna riga toccati`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    motivo: 'citazioni-non-lette',
                    domande: 0,
                    domande_trattenute: righe.length,
                    file: 0,
                },
                { status: 500 },
            )
        }
        const tuttiIPercorsi = percorsiDelleDomande.filter((p) => !citazioni.citati.has(p))
```

Nel battito (righe 366-380) aggiungi `n_file_citati` dopo `n_file_bloccanti`, e sostituisci la riga `msg`:

```ts
            n_file_bloccanti: daNonToccare.size,
            n_file_citati: citazioni.citati.size,
            mesi: MESI_CONSERVAZIONE,
            forzata,
            lotto_pieno: forzata && lette.length >= TETTO_LOTTO,
            ms: Date.now() - t0,
            msg:
                `${JOB}: ${domandeCancellate} domande e ${esito.rimossi.length} allegati oltre i ${MESI_CONSERVAZIONE} mesi; ` +
                `${citazioni.citati.size} allegati lasciati perché citati da un'anagrafica o dal fascicolo`,
```

Nella risposta finale (righe 415-421):

```ts
        return NextResponse.json({
            ok: true,
            domande: domandeCancellate,
            file: esito.rimossi.length,
            file_gia_assenti: esito.giaAssenti.length,
            file_citati: citazioni.citati.size,
            mesi: MESI_CONSERVAZIONE,
        })
```

`citazioni` resta ristretto al ramo `verificato: true` dopo il `return` (unione discriminata, `const`): `citazioni.citati` compila anche nel battito e nella risposta.

- [ ] **Passo 4: verifica che passi, insieme ai test già esistenti**

```bash
npx vitest run __tests__/api/retention-iscrizioni-documenti-citati.test.ts __tests__/api/retention-iscrizioni-file-prima.test.ts __tests__/api/retention-iscrizioni-interruttore.test.ts __tests__/api/retention-iscrizioni-senza-informativa.test.ts 2>&1 | tail -8
npx eslint src/app/api/gdpr/retention-iscrizioni/route.ts __tests__/api/retention-iscrizioni-documenti-citati.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: 4 file verdi; eslint e tsc senza output. Se `retention-iscrizioni-interruttore` diventa rosso su `h.limiti` o `h.ordini`, vuol dire che `percorsiCitati` chiama `limit` o `order`: si toglie la chiamata, non si tocca il test.

- [ ] **Passo 5: commit**

```bash
git add src/app/api/gdpr/retention-iscrizioni/route.ts __tests__/api/retention-iscrizioni-documenti-citati.test.ts
git commit -m "$(cat <<'EOF'
Conservazione iscrizioni: un documento citato da un'anagrafica non esce (D9)

Prima di togliere gli allegati il giro chiede chi li nomina ancora (alunni,
genitori, fascicolo anche nel cestino). Un file citato resta, la riga scaduta si
chiude; il battito porta n_file_citati. Se le citazioni non si leggono: 500
citazioni-non-lette, nessun file e nessuna riga toccati.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — Il rifiuto vale solo da `pending`

**File:**
- Modifica: `src/app/api/admin/iscrizioni/route.ts` (l'import aggiunto nel Compito 2, e il ramo `reject` alle righe 879-893; dopo il Compito 2 le righe sono scese di due, cerca `if (action === 'reject') {`)
- Modifica: `src/lib/ui/esito-fetch.ts:516` (dopo `DOMANDA_NON_APRIBILE`)
- Modifica: `messages/it/shared.json:754`, `messages/en/shared.json:754`
- Test: `__tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts`

Il filtro sullo stato va **dentro** l'`UPDATE` e non in un controllo prima. Fra la lettura della domanda (riga 830) e la scrittura, un'altra segreteria può averla importata, e solo Postgres sa dire «zero righe» nello stesso istante in cui scrive. `.single()` diventa `.maybeSingle()`: con zero righe `.single()` darebbe PGRST116, cioè un 500 al posto del 409.

Il conteggio delle risposte senza codice di questo file (allowlist: 10) non cambia. La risposta nuova ha il suo codice, e il `500` con `error.message` resta com'è.

- [ ] **Passo 1: il test rosso**

Crea `__tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// D9, seconda metà: il rifiuto non guardava lo stato precedente. Un clic su «Rifiuta» su una
// domanda GIÀ APPROVATA la rimetteva fra le `rejected`, con `imported_at` valorizzato, e da lì
// il giro di conservazione l'avrebbe cancellata con i suoi allegati, che sono anche i
// documenti dell'anagrafica. Qui si prova che il rifiuto vale solo da `pending`, e che lo
// stabilisce l'UPDATE stesso.

const ID = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c'

const h = vi.hoisted(() => ({
    /** La riga della domanda, mutata DAVVERO dall'UPDATE se i filtri combaciano. */
    riga: {} as Record<string, unknown>,
    filtriUpdate: [] as { colonna: string; valore: unknown }[],
    logScrittura: vi.fn(),
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn().mockResolvedValue({ user: { id: 'segreteria-finta', role: 'segreteria', scuola_id: 'sede-finta' } }),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/email/send', () => ({
    sendEmail: async () => true,
    sendEmailDetailed: async () => ({ ok: true, error: null }),
    credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/auth/parent-identity', () => ({
    ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
    resolveScuoleAttive: async () => ['sede-finta'],
    resolveScuolaScrittura: async () => ({ scuolaId: 'sede-finta' }),
    scuoleDiUtente: async () => ['sede-finta'],
}))
vi.mock('@/lib/logging/logger', async (orig) => {
    const m = await orig<typeof import('@/lib/logging/logger')>()
    return {
        ...m,
        logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
            h.eventi.push({ evento, livello, campi })
        },
    }
})

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
        from(table: string) {
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = () => b
            b.in = () => b
            b.limit = () => b
            b.order = async () => ({ data: [], error: null })
            b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
            b.maybeSingle = async () =>
                table === 'enrollment_submissions' ? { data: { ...h.riga }, error: null } : { data: null, error: null }
            b.single = async () => ({ data: null, error: null })
            b.update = (patch: Record<string, unknown>) => {
                const filtri: Record<string, unknown> = {}
                const u: Record<string, unknown> = {}
                u.eq = (colonna: string, valore: unknown) => {
                    filtri[colonna] = valore
                    h.filtriUpdate.push({ colonna, valore })
                    return u
                }
                u.select = () => u
                // Come Postgres: l'UPDATE tocca la riga solo se TUTTI i filtri combaciano.
                const esegui = () => {
                    if (!Object.entries(filtri).every(([c, v]) => h.riga[c] === v)) return null
                    Object.assign(h.riga, patch)
                    return { ...h.riga }
                }
                u.maybeSingle = async () => ({ data: esegui(), error: null })
                u.single = async () => {
                    const riga = esegui()
                    return riga
                        ? { data: riga, error: null }
                        : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
                }
                return u
            }
            return b
        },
    }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

const rifiuta = () =>
    PATCH(
        new Request('http://localhost/api/admin/iscrizioni', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: ID, action: 'reject' }),
        }) as never,
    )

function domandaIn(status: string): Record<string, unknown> {
    return {
        id: ID,
        scuola_id: 'sede-finta',
        status,
        imported_at: status === 'approved' ? '2026-09-01T08:00:00.000Z' : null,
        consents_log: [],
        data: { children: [], adults: [] },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    h.filtriUpdate = []
    h.eventi = []
})

describe('rifiuto di una domanda — solo da «in attesa»', () => {
    it('una domanda GIÀ APPROVATA ⇒ 409 con codice, e resta approvata', async () => {
        h.riga = domandaIn('approved')
        const res = await rifiuta()
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'DOMANDA_GIA_ESAMINATA' })
        expect(h.riga.status).toBe('approved')
        expect(h.logScrittura).not.toHaveBeenCalled()
        expect(h.eventi.find((e) => e.campi.esito === 'rifiuto-domanda-non-in-attesa')).toMatchObject({
            evento: 'iscrizione',
            livello: 'warn',
            campi: { entita_id: ID },
        })
    })

    it('il doppio clic: una domanda già respinta ⇒ 409, e nessuna seconda traccia', async () => {
        h.riga = domandaIn('rejected')
        const res = await rifiuta()
        expect(res.status).toBe(409)
        expect(h.logScrittura).not.toHaveBeenCalled()
    })

    it("CONTROLLO POSITIVO: una domanda in attesa si respinge, e l'UPDATE porta il filtro sullo stato", async () => {
        h.riga = domandaIn('pending')
        const res = await rifiuta()
        expect(res.status).toBe(200)
        expect(h.riga.status).toBe('rejected')
        expect(h.filtriUpdate).toContainEqual({ colonna: 'status', valore: 'pending' })
        expect(h.logScrittura).toHaveBeenCalledTimes(1)
    })

    it('il codice è dichiarato', () => {
        expect(CODICI_ERRORE.DOMANDA_GIA_ESAMINATA).toBe('erroreDomandaGiaEsaminata')
    })
})
```

- [ ] **Passo 2: verifica che fallisca**

```bash
npx vitest run __tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts 2>&1 | tail -20
```

Atteso: FAIL in tutti e 4. «Già approvata» riceve 200 e la riga diventa `rejected`; «già respinta» riceve 200; «il codice è dichiarato» trova `undefined`; nel controllo positivo la risposta è già 200 e la riga diventa `rejected`, ma nell'`UPDATE` manca il filtro `status = 'pending'`.

- [ ] **Passo 3: il codice minimo**

Nell'import aggiunto nel Compito 2:

```ts
import { STATI_DOMANDA, STATO_DOMANDA_IN_ATTESA } from '@/lib/iscrizioni/stati'
```

Nel ramo `reject` sostituisci questo blocco:

```ts
    if (action === 'reject') {
      const { data, error } = await supabase
        .from('enrollment_submissions')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
```

con:

```ts
    if (action === 'reject') {
      // ── SOLO DA «IN ATTESA» (robustezza 2, sessione 1 — D9) ──────────────────
      // Una domanda approvata è già un'anagrafica, con il documento copiato in `alunni` e
      // `parents`. Respingerla la rimetteva nel giro di conservazione, che l'avrebbe
      // cancellata con quei file. Il filtro sullo stato sta DENTRO l'UPDATE: fra la lettura
      // qui sopra e la scrittura un'altra segreteria può averla importata, e solo Postgres
      // sa dire «zero righe» nello stesso istante in cui scrive. `.maybeSingle()` perché
      // zero righe è una risposta, non un guasto.
      const { data, error } = await supabase
        .from('enrollment_submissions')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', STATO_DOMANDA_IN_ATTESA)
        .select()
        .maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data) {
        logEvento('iscrizione', 'warn', {
          operazione: 'admin/iscrizioni:PATCH',
          esito: 'rifiuto-domanda-non-in-attesa',
          azione: 'reject',
          entita_tipo: 'enrollment_submissions',
          entita_id: id,
          msg: 'rifiuto non applicato: la domanda non è più in attesa (già approvata o già respinta)',
        })
        return NextResponse.json(
          { error: "La domanda è già stata esaminata: aggiorna l'elenco per vedere il suo stato.", codice: 'DOMANDA_GIA_ESAMINATA' },
          { status: 409 },
        )
      }
```

Il resto del ramo (`logScrittura`, la notifica al genitore, `return NextResponse.json(data)`) non cambia.

In `src/lib/ui/esito-fetch.ts`, subito dopo `DOMANDA_NON_APRIBILE: 'erroreDomandaNonApribile',` (riga 516):

```ts
    /**
     * 409 — respingere una domanda d'iscrizione che non è più in attesa
     * (`PATCH /api/admin/iscrizioni`, `action: 'reject'`). Già approvata, quindi già
     * un'anagrafica, o già respinta (il doppio clic). Il filtro sta dentro l'UPDATE, quindi
     * vale anche quando un'altra segreteria l'ha importata un istante prima.
     */
    DOMANDA_GIA_ESAMINATA: 'erroreDomandaGiaEsaminata',
```

In `messages/it/shared.json` la riga 754 diventa:

```json
  "erroreScritturaFallita": "Il salvataggio non è riuscito. Ricarica la pagina per vedere cosa risulta registrato, poi riprova.",
  "erroreDomandaGiaEsaminata": "Questa domanda è già stata esaminata: aggiorna l’elenco per vedere il suo stato."
}
```

In `messages/en/shared.json` la riga 754 diventa:

```json
  "erroreScritturaFallita": "Saving failed. Reload the page to see what was recorded, then try again.",
  "erroreDomandaGiaEsaminata": "This application has already been reviewed: refresh the list to see its current status."
}
```

- [ ] **Passo 4: verifica che passi**

```bash
npx vitest run __tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts __tests__/api/iscrizioni-import-scope-sede.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -8
npx eslint src/app/api/admin/iscrizioni/route.ts src/lib/ui/esito-fetch.ts __tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: 3 file verdi. `errori-con-codice` resta verde: il codice è dichiarato e tradotto, e il numero di risposte senza codice del file è sempre 10. eslint e tsc senza output.

- [ ] **Passo 5: commit**

```bash
git add src/app/api/admin/iscrizioni/route.ts src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json __tests__/api/iscrizioni-rifiuto-solo-in-attesa.test.ts
git commit -m "$(cat <<'EOF'
Iscrizioni: si respinge solo una domanda in attesa (409 DOMANDA_GIA_ESAMINATA)

Il filtro status = 'pending' sta dentro l'UPDATE: una domanda già approvata (già
anagrafica) o già respinta non cambia, la risposta è 409 con codice tradotto e un
warn rifiuto-domanda-non-in-attesa.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — Migrazione: gli stati vincolati in SQL

**File:**
- Crea: `supabase/migrations/<version>_iscrizioni_stati_vincolati.sql` (la `<version>` la genera il Passo 3)
- Modifica: `__tests__/architecture/soglia-fotografia.ts:237-251` (`MIGRAZIONI_ATTESE_AL_MERGE`)
- Test: `__tests__/architecture/stati-vincolati-in-sql.test.ts`

**Prima di cominciare:** rileggi i risultati di 0.2, 0.3 e 0.7. Se 0.2 e 0.3 rientrano negli elenchi e 0.7 non ha vincoli, si procede con la migrazione intera. Se 0.3 non rientra, la migrazione perde il blocco `alunni` e il lock la riga `alunni_stato_ammesso` (vedi Passo 0.3). Se 0.2 non rientra, ci si ferma.

I valori dei due `CHECK` vengono da due fonti, e devono coincidere:

| vincolo | dal Passo 0 | dal codice e dai lock |
|---|---|---|
| `enrollment_submissions_status_ammesso` | 0.2 | `STATI_DOMANDA` (`src/lib/iscrizioni/stati.ts`) |
| `alunni_stato_ammesso` | 0.3 | `STATI_TENDINA` (`src/lib/alunni/stato.ts:96`), che contiene `STATI_NON_PIU_ISCRITTO`, la lista confrontata dal lock `stati-alunno-anche-in-sql` |

Se il codice dice tre stati e la produzione ne usa due (il 20/10 per gli alunni era così), il `CHECK` prende i tre del codice: `sospeso` lo produce la tendina. Se la produzione ne usa uno che il codice non conosce, vale la regola del Passo 0.3. Il `CHECK` non si allarga in silenzio.

- [ ] **Passo 1: il lock rosso**

Crea `__tests__/architecture/stati-vincolati-in-sql.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATI_DOMANDA } from '@/lib/iscrizioni/stati'
import { STATI_NON_PIU_ISCRITTO, STATI_TENDINA } from '@/lib/alunni/stato'

// =============================================================================
// GLI STATI SONO UNA REGOLA IN DUE LINGUAGGI — robustezza 2, sessione 1 (D11).
//
// Dal <data della migrazione> `enrollment_submissions.status` e `alunni.stato` hanno un
// CHECK. In TypeScript le stesse liste sono `STATI_DOMANDA` e `STATI_TENDINA`. L'SQL non può
// importare un modulo TS, e due copie che nessuno confronta divergono:
//  · uno stato aggiunto al codice e non al CHECK fa fallire la scrittura in produzione
//    (23514) proprio sulla schermata che lo usa;
//  · uno stato aggiunto al CHECK e non al codice non si può più scegliere, e nessuno
//    se ne accorge.
// Si legge l'ULTIMO `ADD CONSTRAINT <nome> CHECK (<colonna> IN (…))` delle migrazioni,
// senza i commenti: la testata della migrazione cita i valori per spiegarli, e un lock che
// li leggesse lì direbbe «allineato» leggendo una spiegazione.
// =============================================================================

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

type File = { nome: string; sql: string }

function migrazioni(): File[] {
    return readdirSync(CARTELLA)
        .filter((n) => n.endsWith('.sql'))
        .sort()
        .map((nome) => ({ nome, sql: readFileSync(join(CARTELLA, nome), 'utf8') }))
}

function senzaCommenti(sql: string): string {
    return sql
        .split('\n')
        .map((riga) => riga.replace(/--.*$/, ''))
        .join('\n')
}

/** L'ultimo `ADD CONSTRAINT <vincolo> CHECK (<colonna> IN (…))`, con il file che lo contiene. */
function ultimoCheck(file: File[], vincolo: string): { nome: string; colonna: string; valori: string[]; sql: string } | null {
    const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${vincolo}\\s+CHECK\\s*\\(\\s*(\\w+)\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i')
    let trovato: { nome: string; colonna: string; valori: string[]; sql: string } | null = null
    for (const f of file) {
        const sql = senzaCommenti(f.sql)
        const m = re.exec(sql)
        if (!m) continue
        const valori = m[2]
            .split(',')
            .map((v) => v.trim().replace(/^'|'$/g, ''))
            .filter((v) => v !== '')
        trovato = { nome: f.nome, colonna: m[1], valori, sql }
    }
    return trovato
}

const VINCOLI = [
    { vincolo: 'enrollment_submissions_status_ammesso', colonna: 'status', attesi: [...STATI_DOMANDA], fonte: 'STATI_DOMANDA (src/lib/iscrizioni/stati.ts)' },
    { vincolo: 'alunni_stato_ammesso', colonna: 'stato', attesi: [...STATI_TENDINA], fonte: 'STATI_TENDINA (src/lib/alunni/stato.ts)' },
] as const

describe('lock architettura · gli stati vincolati in SQL dicono quello che dice TypeScript', () => {
    for (const { vincolo, colonna, attesi, fonte } of VINCOLI) {
        it(`${vincolo}: esiste, sulla colonna ${colonna}, con i valori di ${fonte}`, () => {
            const c = ultimoCheck(migrazioni(), vincolo)
            expect(c, `nessuna migrazione aggiunge ${vincolo}`).not.toBeNull()
            expect(c!.colonna).toBe(colonna)
            expect(
                [...c!.valori].sort(),
                `Il CHECK ${vincolo} (${c!.nome}) e ${fonte} sono divergenti: chi ne sposta uno sposti ` +
                    "anche l'altro, con una migrazione.",
            ).toEqual([...attesi].sort())
        })

        it(`${vincolo}: è convalidato nello stesso file in cui nasce`, () => {
            const c = ultimoCheck(migrazioni(), vincolo)
            expect(c).not.toBeNull()
            expect(c!.sql).toMatch(new RegExp(`VALIDATE\\s+CONSTRAINT\\s+${vincolo}\\b`, 'i'))
        })
    }

    it("ogni stato che l'automa tratta come «non più iscritto» è ammesso dal CHECK degli alunni", () => {
        const c = ultimoCheck(migrazioni(), 'alunni_stato_ammesso')
        expect(c).not.toBeNull()
        for (const s of STATI_NON_PIU_ISCRITTO) expect(c!.valori).toContain(s)
    })

    it('CONTROLLO POSITIVO: il lettore vede un CHECK vero e ignora uno scritto in un commento', () => {
        const vero = ultimoCheck(
            [{ nome: 'a.sql', sql: "ALTER TABLE t\n  ADD CONSTRAINT v_ammesso\n  CHECK (c IN ('x', 'y')) NOT VALID;" }],
            'v_ammesso',
        )
        expect(vero).toMatchObject({ colonna: 'c', valori: ['x', 'y'] })
        const commentato = ultimoCheck(
            [{ nome: 'b.sql', sql: "-- ALTER TABLE t ADD CONSTRAINT v_ammesso CHECK (c IN ('z'));" }],
            'v_ammesso',
        )
        expect(commentato).toBeNull()
    })
})
```

Nel commento di testata, `<data della migrazione>` diventa la data del Passo 3 (`date -u +%Y-%m-%d`).

- [ ] **Passo 2: verifica che fallisca**

```bash
npx vitest run __tests__/architecture/stati-vincolati-in-sql.test.ts 2>&1 | tail -15
```

Atteso: FAIL in 5 test su 6, con `nessuna migrazione aggiunge enrollment_submissions_status_ammesso` / `alunni_stato_ammesso`. Il controllo positivo passa.

- [ ] **Passo 3: genera il nome della migrazione**

La version è l'istante UTC in cui crei il file: al merge sarà già passata, mai futura.

```bash
VERSION=$(date -u +%Y%m%d%H%M%S)
FILE="supabase/migrations/${VERSION}_iscrizioni_stati_vincolati.sql"
echo "$VERSION $FILE"
```

Atteso: 14 cifre e il percorso. **Annota la version**: serve nel Passo 5, nel PRD e nella PR.

- [ ] **Passo 4: scrivi la migrazione**

```bash
cat > "$FILE" <<'SQL'
-- =============================================================================
-- STATI VINCOLATI: `enrollment_submissions.status` e `alunni.stato`
--
-- Seconda serie della roadmap di robustezza, sessione 1 (D11 del rapporto del 2026-10-20).
-- Le due colonne erano testo libero. Lo stato di una domanda lo decideva solo il codice
-- (`STATI_DOMANDA`, src/lib/iscrizioni/stati.ts), quello di un alunno solo la tendina
-- (`STATI_TENDINA`, src/lib/alunni/stato.ts). La migrazione 20260812194517 aveva scelto di
-- non vincolare `alunni.stato`. Oggi i valori sono misurati (Passo 0 del piano
-- docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md), e un valore fuori elenco
-- è un guasto, non una variante.
--
-- ─── COME È FATTA ─────────────────────────────────────────────────────────────
--  Per ciascuna tabella, dentro un blocco che non fa fallire l'integrazione:
--   1. se la tabella manca (database E2E della CI) non fa niente;
--   2. se il vincolo c'è già non fa niente: la migrazione si può rieseguire;
--   3. CONTA le righe fuori elenco. Se ce n'è anche una sola, il vincolo NON si aggiunge,
--      nemmeno NOT VALID: varrebbe comunque al prossimo UPDATE di quella riga e fermerebbe
--      una segreteria a metà lavoro. In app_log resta un `error` con il conteggio;
--   4. altrimenti ADD CONSTRAINT … NOT VALID e subito VALIDATE, e in app_log un `info`.
--  Il NULL in `alunni.stato` resta ammesso: il codice lo legge come «iscritto», e un CHECK
--  con IN lascia passare il NULL.
--
-- ─── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select conname, convalidated from pg_constraint
--    where conname in ('enrollment_submissions_status_ammesso', 'alunni_stato_ammesso');
--   → due righe, convalidated = true.
--   select livello, contesto->'campi'->>'esito', contesto->'campi'->>'n' from app_log
--    where fingerprint like 'migrazione-stati-vincolati-%' order by visto_l_ultima desc;
--   → due righe `info` `vincolo-convalidato`. Una riga `error` `vincolo-non-aggiunto`
--     vuol dire righe fuori elenco, e il loro numero è in `n`.
--   Nel repo lo tiene il lock __tests__/architecture/stati-vincolati-in-sql.test.ts.
--
-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
--   alter table public.enrollment_submissions drop constraint if exists enrollment_submissions_status_ammesso;
--   alter table public.alunni drop constraint if exists alunni_stato_ammesso;
--   Nessun dato cambia, in un verso o nell'altro: un CHECK non scrive righe.
-- =============================================================================

DO $$
DECLARE
  fuori bigint;
BEGIN
  IF to_regclass('public.enrollment_submissions') IS NULL THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.enrollment_submissions'::regclass
       AND conname = 'enrollment_submissions_status_ammesso'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO fuori
    FROM public.enrollment_submissions
   WHERE status NOT IN ('pending', 'approved', 'rejected');

  IF fuori > 0 THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      VALUES ('error', 'migrazione', 'server',
              'CHECK su enrollment_submissions.status NON aggiunto: righe fuori elenco',
              'migrazione-stati-vincolati-domande',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-non-aggiunto',
                'entita_tipo', 'enrollment_submissions', 'n', fuori)))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    EXCEPTION WHEN others THEN
      RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
    END;
    RAISE WARNING 'iscrizioni_stati_vincolati: % righe di enrollment_submissions fuori elenco, vincolo non aggiunto', fuori;
    RETURN;
  END IF;

  ALTER TABLE public.enrollment_submissions
    ADD CONSTRAINT enrollment_submissions_status_ammesso
    CHECK (status IN ('pending', 'approved', 'rejected')) NOT VALID;
  ALTER TABLE public.enrollment_submissions
    VALIDATE CONSTRAINT enrollment_submissions_status_ammesso;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'migrazione', 'server',
            'CHECK su enrollment_submissions.status aggiunto e convalidato',
            'migrazione-stati-vincolati-domande',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-convalidato',
              'entita_tipo', 'enrollment_submissions', 'n', 0)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN others THEN
    RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
  END;
END $$;

DO $$
DECLARE
  fuori bigint;
BEGIN
  IF to_regclass('public.alunni') IS NULL THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.alunni'::regclass
       AND conname = 'alunni_stato_ammesso'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO fuori
    FROM public.alunni
   WHERE stato IS NOT NULL AND stato NOT IN ('iscritto', 'ritirato', 'sospeso');

  IF fuori > 0 THEN
    BEGIN
      INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      VALUES ('error', 'migrazione', 'server',
              'CHECK su alunni.stato NON aggiunto: righe fuori elenco',
              'migrazione-stati-vincolati-alunni',
              jsonb_build_object('campi', jsonb_build_object(
                'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-non-aggiunto',
                'entita_tipo', 'alunni', 'n', fuori)))
      ON CONFLICT (fingerprint, giorno) DO UPDATE
        SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    EXCEPTION WHEN others THEN
      RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
    END;
    RAISE WARNING 'iscrizioni_stati_vincolati: % righe di alunni fuori elenco, vincolo non aggiunto', fuori;
    RETURN;
  END IF;

  ALTER TABLE public.alunni
    ADD CONSTRAINT alunni_stato_ammesso
    CHECK (stato IN ('iscritto', 'ritirato', 'sospeso')) NOT VALID;
  ALTER TABLE public.alunni
    VALIDATE CONSTRAINT alunni_stato_ammesso;

  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'migrazione', 'server',
            'CHECK su alunni.stato aggiunto e convalidato',
            'migrazione-stati-vincolati-alunni',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'iscrizioni_stati_vincolati', 'esito', 'vincolo-convalidato',
              'entita_tipo', 'alunni', 'n', 0)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN others THEN
    RAISE LOG 'iscrizioni_stati_vincolati: logging non riuscito [%]', SQLSTATE;
  END;
END $$;

NOTIFY pgrst, 'reload schema';
SQL
wc -l "$FILE"
```

Atteso: il file esiste, con circa 145 righe.

- [ ] **Passo 5: dichiara la migrazione attesa al merge**

`toccaLeFkUtenti` (`__tests__/architecture/soglia-fotografia.ts:297-300`) scatta su `add constraint`, quindi la guardia delle FK verso `utenti` (`tracce-docente-dichiarate.test.ts`) direbbe «rigenera la fotografia» per una migrazione che non tocca nessuna FK. Come per la fase 12 (`20261019220315_…`), la si dichiara in `MIGRAZIONI_ATTESE_AL_MERGE`. La toglie la «PR-B» nel senso della §5: il primo commit della sessione che apre dopo il rilascio, con la sezione «Per la sessione dopo» di questo piano. Non c'è una PR separata.

La ragione deve contenere le parole `integrazione` e `PR-B` e superare i 30 caratteri: lo pretende la prova «4 · ogni voce porta la sua ragione per esteso, con l'integrazione e la PR-B» di `__tests__/architecture/soglia-fotografia.test.ts`.

In `__tests__/architecture/soglia-fotografia.ts`, sostituisci la riga 251 del 20/10, cioè questo testo (cercalo per contenuto: se una sessione chiusa nel Compito 1 ha già scritto lì una voce sua e poi l'ha tolta, la costante è di nuovo `{}`):

```ts
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {}
```

con il blocco che segue. Le 14 cifre all'inizio della chiave sono la `$VERSION` del Passo 3: scrivile per intero.

```ts
//
// 2026-10 · ROBUSTEZZA 2, SESSIONE 1 «iscrizioni: documenti mai persi, stati vincolati»:
// `<VERSION>_iscrizioni_stati_vincolati.sql` aggiunge due CHECK (`enrollment_submissions.status`,
// `alunni.stato`) con `ADD CONSTRAINT`, e la guardia delle FK verso `utenti` la vede per quelle
// parole: nessuna FK, nessuna policy, nessun indice unico cambia. Si toglie con la PR-B, cioè il
// primo commit della sessione che apre dopo il rilascio, rigenerando le fotografie dalla produzione.
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {
    '<VERSION>_iscrizioni_stati_vincolati.sql':
        'due CHECK con ADD CONSTRAINT sugli stati di enrollment_submissions e alunni, nessuna FK verso utenti: ' +
        'la applica l’integrazione al merge; la toglie la PR-B (primo commit della sessione dopo).',
}
```

Per non scrivere a mano le 14 cifre, puoi applicarle con un solo comando subito dopo aver incollato il blocco:

```bash
sed -i '' "s/<VERSION>_iscrizioni_stati_vincolati/${VERSION}_iscrizioni_stati_vincolati/g" __tests__/architecture/soglia-fotografia.ts
grep -n "iscrizioni_stati_vincolati" __tests__/architecture/soglia-fotografia.ts
```

Atteso: due righe con la version piena, nessuna `<VERSION>`.

- [ ] **Passo 6: verifica che passi, insieme alle guardie delle migrazioni**

```bash
npx vitest run __tests__/architecture/stati-vincolati-in-sql.test.ts __tests__/architecture/stati-alunno-anche-in-sql.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/app-log-battiti-con-conflitto.test.ts 2>&1 | tail -12
```

Atteso: 8 file verdi. Prova del contrario, da fare una volta: commenta la voce in `MIGRAZIONI_ATTESE_AL_MERGE`, rilancia `tracce-docente-dichiarate.test.ts` e verifica che sia **rosso** con il nome del file nuovo, poi ripristina la voce. Se resta verde anche senza la voce, la guardia non vede la migrazione, e questo va capito prima di proseguire.

- [ ] **Passo 7: commit**

```bash
git add "$FILE" __tests__/architecture/stati-vincolati-in-sql.test.ts __tests__/architecture/soglia-fotografia.ts
git commit -m "$(cat <<'EOF'
Migrazione: CHECK sugli stati di enrollment_submissions e alunni (D11)

NOT VALID e subito VALIDATE, solo se il conteggio delle righe fuori elenco è zero;
altrimenti nessun vincolo e un error in app_log con il numero. Guardie per il DB
E2E della CI. Lock stati-vincolati-in-sql: i valori coincidono con STATI_DOMANDA e
STATI_TENDINA. Dichiarata in MIGRAZIONI_ATTESE_AL_MERGE fino alla PR-B (primo
commit della sessione dopo).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — T6: il controllo `audit-docente`

**File:**
- Modifica: `src/lib/health/controlli.ts:42` (testata), `:1365` (subito dopo la chiusura di `controlloCodeArretrate`, prima del riquadro «Aggregazione»), `:1432-1435` (`eseguiSalute`)
- Modifica: `__tests__/api/health.test.ts:163-173` (elenco) e `:182` (caso nuovo)
- Test: `__tests__/lib/health/audit-docente.test.ts`

`logScrittura` (`src/lib/audit/scrittura.ts:109-148`) non blocca mai la scrittura che racconta. Se la riga d'audit non entra, registra `logEvento('audit', 'error', { operazione: 'logScrittura', entita_tipo, azione, esito: 'audit-non-registrato' }, err)`, sia sul `{ error }` di PostgREST (123-135) sia nel `catch` (136-148). Lo stesso `esito` lo scrivono altri due registri d'audit che non bloccano: l'accesso al fascicolo della primaria (evento `fascicolo`, `src/lib/primaria/fascicolo-rbac.ts:173-180`, cioè proprio le docenti) e la firma elettronica (evento `fea`, `src/lib/fea/audit.ts:52-63`). Il controllo li conta tutti e tre: filtra su `livello = 'error'` e sull'esito, non sull'evento, così un quarto registro che usa lo stesso esito entra da solo. Un test lo tiene fermo (vedi sotto).

Il logger mette i campi in `contesto.campi` (`rigaEvento`, `src/lib/logging/logger.ts:699-734`), e `esito` passa in chiaro (`src/lib/logging/redact.ts:250-256`). Il filtro è quindi `contesto->campi->>esito`, lo stesso percorso che `src/lib/media/video/catena.ts:53` usa già in produzione per `operazione`. Il Passo 0.8 lo conferma sui dati veri. `app_log` deduplica per (fingerprint, giorno): le righe `error` di un giorno sono poche centinaia al massimo, e l'indice `app_log_livello_idx (livello, visto_l_ultima)` le copre.

Una sola riga persa non supera le soglie di `tasso-errore` (`SOGLIA_IMPRONTE_ERRORE = 5`, `SOGLIA_OCCORRENZE_ERRORE = 25` in 15 minuti, `controlli.ts:926-965`): oggi nessuno la vede. Il controllo nuovo va a `degradato`, mai a `giu`, alla prima occorrenza nelle ultime 24 ore. Il campanello (`scripts/campanello/valuta.mjs:75-97`) apre `salute:audit-docente` se resta così per due letture di fila. Il nome rispetta `/^[a-z0-9-]+$/`.

- [ ] **Passo 1: i test rossi**

Crea `__tests__/lib/health/audit-docente.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../../fixtures/finto-supabase'
import { controlloAuditDocente, FINESTRA_AUDIT_MS, ESITO_AUDIT_NON_REGISTRATO } from '@/lib/health/controlli'

/**
 * T6 — UNA traccia d'audit persa deve bastare.
 *
 * `logScrittura` non blocca la scrittura che racconta, ed è giusto: ma una riga persa sta
 * sotto ogni soglia di `tasso-errore`, e nessuno la vede. Questi test usano numeri letterali:
 * 1 riga, 23 e 25 ore, 3 occorrenze. Ogni caso «degradato» ha il suo gemello «ok».
 */

const MIN = 60_000
const ORA = 60 * MIN
const ADESSO = Date.parse('2026-10-21T10:00:00.000Z')
const fa = (ms: number) => new Date(ADESSO - ms).toISOString()

/** Una riga come la lascia `logScrittura` quando la traccia d'audit non entra. */
function auditPerso(quandoMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: `log-audit-${quandoMs}`,
        evento: 'audit',
        livello: 'error',
        sorgente: 'server',
        ambiente: 'production',
        occorrenze: 1,
        creato_il: fa(quandoMs),
        visto_l_ultima: fa(quandoMs),
        contesto: { campi: { operazione: 'logScrittura', entita_tipo: 'presenze', azione: 'insert', esito: 'audit-non-registrato' } },
        ...extra,
    }
}

async function sonda(app_log: Record<string, unknown>[], errori: Record<string, ErrorePostgrest> = {}) {
    const d: DBFinto = { app_log }
    return controlloAuditDocente(creaFintoSupabase(d, [], { errori }) as unknown as SupabaseClient, ADESSO, 'production')
}

describe('audit-docente — una sola traccia persa basta', () => {
    it('nessuna riga ⇒ ok', async () => {
        const c = await sonda([])
        expect(c).toMatchObject({ nome: 'audit-docente', esito: 'ok' })
    })

    it("UNA riga di un'ora fa ⇒ degradato, e il dettaglio dice 1", async () => {
        const c = await sonda([auditPerso(1 * ORA)])
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 1 (1 impronte)")
    })

    it('la stessa impronta con 3 occorrenze ⇒ degradato, e il dettaglio dice 3', async () => {
        const c = await sonda([auditPerso(1 * ORA, { occorrenze: 3 })])
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 3 (1 impronte)")
    })

    it('23 ore fa ⇒ degradato; 25 ore fa ⇒ ok (i gemelli sulla finestra)', async () => {
        expect((await sonda([auditPerso(23 * ORA)])).esito).toBe('degradato')
        expect((await sonda([auditPerso(25 * ORA)])).esito).toBe('ok')
    })

    it('una riga del BROWSER non conta: `/api/logs` è anonimo', async () => {
        expect((await sonda([auditPerso(1 * ORA, { sorgente: 'client' })])).esito).toBe('ok')
    })

    it("una riga di un altro ambiente non conta", async () => {
        expect((await sonda([auditPerso(1 * ORA, { ambiente: 'preview' })])).esito).toBe('ok')
    })

    it('un altro esito non conta, nemmeno a livello error', async () => {
        const battito = {
            ...auditPerso(1 * ORA),
            evento: 'cron',
            livello: 'info',
            contesto: { campi: { operazione: 'push-dispatch', esito: 'ok' } },
        }
        const guasto = {
            ...auditPerso(1 * ORA),
            id: 'log-altro-errore',
            evento: 'route',
            contesto: { campi: { operazione: 'admin/students:PATCH', esito: 'lettura-fallita' } },
        }
        expect((await sonda([battito, guasto])).esito).toBe('ok')
    })

    it("conta anche gli altri registri d'audit: l'accesso al fascicolo e la firma elettronica", async () => {
        const fascicolo = auditPerso(1 * ORA, {
            id: 'log-fascicolo-perso',
            evento: 'fascicolo',
            contesto: { campi: { operazione: 'logAccessoFascicolo', azione: 'lettura', esito: 'audit-non-registrato' } },
        })
        const fea = auditPerso(2 * ORA, {
            id: 'log-fea-perso',
            evento: 'fea',
            contesto: { campi: { operazione: 'logFeaEvent', esito: 'audit-non-registrato' } },
        })
        const c = await sonda([fascicolo, fea])
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toBe("tracce d'audit non registrate nelle ultime 24 h: 2 (2 impronte)")
    })

    it('lettura fallita ⇒ degradato con il codice, MAI giu', async () => {
        const c = await sonda([], { app_log: { code: '57014', message: 'canceling statement due to statement timeout' } })
        expect(c.esito).toBe('degradato')
        expect(c.dettaglio).toContain('57014')
    })

    it('colonna assente (database non migrato) ⇒ ok con la nota', async () => {
        const c = await sonda([], { app_log: { code: '42703', message: 'column does not exist' } })
        expect(c.esito).toBe('ok')
        expect(c.dettaglio).toContain('42703')
    })

    it("le costanti: 24 ore, e l'esito è proprio quello che scrivono i tre registri d'audit", () => {
        expect(FINESTRA_AUDIT_MS).toBe(24 * ORA)
        expect(ESITO_AUDIT_NON_REGISTRATO).toBe('audit-non-registrato')
        const leggi = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
        const conta = (f: string) => (leggi(f).match(/esito:\s*'audit-non-registrato'/g) ?? []).length
        expect(conta('src/lib/audit/scrittura.ts')).toBe(2)
        expect(conta('src/lib/primaria/fascicolo-rbac.ts')).toBe(1)
        expect(conta('src/lib/fea/audit.ts')).toBe(1)
    })

    it("chi scrive 'audit-non-registrato' in src/ è uno dei tre registri noti, e lo scrive a livello error", () => {
        // Un registro nuovo che usa lo stesso esito entra nel controllo da solo (il filtro non
        // guarda l'evento), ma solo se lo scrive a livello `error`. Questo test lo fa sapere a
        // chi lo aggiunge: rosso finché il file non è in questo elenco, dopo averlo verificato.
        const NOTI = ['src/lib/audit/scrittura.ts', 'src/lib/fea/audit.ts', 'src/lib/primaria/fascicolo-rbac.ts']
        const trovati: string[] = []
        const visita = (cartella: string) => {
            for (const voce of readdirSync(join(process.cwd(), cartella), { withFileTypes: true })) {
                const rel = `${cartella}/${voce.name}`
                if (voce.isDirectory()) visita(rel)
                else if (/\.(ts|tsx)$/.test(voce.name) && /'audit-non-registrato'/.test(readFileSync(join(process.cwd(), rel), 'utf8'))) {
                    trovati.push(rel)
                }
            }
        }
        visita('src')
        expect(trovati.filter((f) => f !== 'src/lib/health/controlli.ts').sort()).toEqual(NOTI)
    })
})
```

In `__tests__/api/health.test.ts` l'elenco delle righe 163-173 diventa:

```ts
        expect(corpo.controlli.map((c) => c.nome).sort()).toEqual([
            'audit-docente',
            'auth',
            'coda-fatture',
            'code-arretrate',
            'config',
            'cron-battito',
            'db-lettura',
            'regione',
            'schema-atteso',
            'tasso-errore',
        ])
```

(`'audit-docente'` va **prima** di `'auth'`: `d` viene prima di `t`.)

Subito dopo la chiusura del test «con tutto sano risponde 200…» (riga 182, `    })`) aggiungi:

```ts

    it("UNA traccia d'audit persa porta la salute a degraded con `audit-docente`, e `tasso-errore` resta ok", async () => {
        const db = dbSano()
        db.app_log.push({
            id: 'log-audit-perso',
            evento: 'audit',
            livello: 'error',
            sorgente: 'server',
            ambiente: 'production',
            occorrenze: 1,
            creato_il: fa(5 * MIN),
            visto_l_ultima: fa(5 * MIN),
            contesto: {
                campi: { operazione: 'logScrittura', entita_tipo: 'presenze', azione: 'insert', esito: 'audit-non-registrato' },
            },
        })
        montaDb(db)

        const { stato, header, corpo } = await chiama()

        // È un avviso, non un'interruzione: 200, come per un cron fermo.
        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(header).toBe('degraded')
        expect(controllo(corpo, 'audit-docente').esito).toBe('degradato')
        // Ecco perché serve un controllo suo: una riga sola sta sotto le soglie del tasso.
        expect(controllo(corpo, 'tasso-errore').esito).toBe('ok')
    })
```

- [ ] **Passo 2: verifica che falliscano**

```bash
npx vitest run __tests__/lib/health/audit-docente.test.ts __tests__/api/health.test.ts 2>&1 | tail -20
```

Atteso: FAIL. In `audit-docente.test.ts` `controlloAuditDocente is not a function` e le costanti `undefined`. In `health.test.ts` l'elenco senza `audit-docente` e il caso nuovo (`controllo "audit-docente" assente dalla risposta`).

- [ ] **Passo 3: il codice minimo**

In `src/lib/health/controlli.ts`, nella testata, dopo la riga 42 (`È QUALITÀ DEI DATI, non salute…`):

```ts
 * 10. `audit-docente` — nessuna traccia d'audit persa nelle ultime 24 ore (`audit-non-registrato`
 *                      di scritture, fascicolo e firma; robustezza 2, sessione 1).
```

Subito dopo la chiusura di `controlloCodeArretrate` (riga 1365), prima del riquadro «Aggregazione»:

```ts

/**
 * LA TRACCIA D'AUDIT PERSA (seconda serie della robustezza, sessione 1 — T6).
 *
 * `logScrittura` (`src/lib/audit/scrittura.ts`) non blocca mai la scrittura che racconta: se la
 * riga d'audit non entra, la scrittura resta, e in `app_log` finisce un `error` con
 * `esito: 'audit-non-registrato'`. È giusto per chi lavora, ma chi sorveglia non lo vede: UNA
 * riga persa sta sotto le soglie di `tasso-errore` (5 impronte, 25 occorrenze in 15 minuti).
 * Questo controllo va a `degradato` alla PRIMA occorrenza nelle ultime 24 ore, e il campanello
 * apre `salute:audit-docente` alla seconda lettura di fila.
 *
 * TRE REGISTRI, UN ESITO. Lo stesso `audit-non-registrato` lo scrivono l'accesso al fascicolo
 * della primaria (`src/lib/primaria/fascicolo-rbac.ts`, evento `fascicolo`) e la firma
 * elettronica (`src/lib/fea/audit.ts`, evento `fea`). Il filtro non guarda l'evento: guarda il
 * livello `error` e l'esito, così un registro nuovo con lo stesso esito entra da solo.
 * `__tests__/lib/health/audit-docente.test.ts` elenca chi lo scrive oggi.
 *
 * DOVE STA L'ESITO. Il logger scrive i campi dell'evento in `contesto.campi` (`rigaEvento`,
 * `src/lib/logging/logger.ts`), quindi il filtro è `contesto->campi->>esito`. Si contano solo
 * le righe del SERVER (le righe `client` le scrive chiunque, via `/api/logs`) e solo
 * dell'ambiente corrente. Si filtra su `visto_l_ultima`: `app_log` deduplica per giorno.
 *
 * Il nome dice «docente» perché è lì che la traccia conta di più (registro, voti, presenze,
 * fascicolo), ma i tre registri servono tutto il personale, e il controllo li conta tutti.
 *
 * `degradato` e mai `giu`: una traccia persa non impedisce a nessuno di aprire l'app. Una
 * lettura fallita dà `degradato` con il codice; colonna o tabella assente dà `ok` con la nota,
 * come per le code. Escono solo conteggi e codici, perché la rotta è pubblica.
 */
export const FINESTRA_AUDIT_MS = 24 * ORA

/** L'esito con cui i registri d'audit segnalano una traccia che non è entrata. */
export const ESITO_AUDIT_NON_REGISTRATO = 'audit-non-registrato'

/** Un tetto alle righe lette: ne basta una per decidere, e la somma serve solo al dettaglio. */
const RIGHE_MAX_AUDIT = 50

export async function controlloAuditDocente(
    supabase: SupabaseClient,
    adesso: number,
    ambiente: string,
): Promise<Controllo> {
    return misura('audit-docente', 'degradato', async () => {
        const da = new Date(adesso - FINESTRA_AUDIT_MS).toISOString()
        const { data, count, error } = await supabase
            .from('app_log')
            .select('occorrenze', { count: 'exact' })
            .eq('livello', 'error')
            .eq('sorgente', 'server')
            .eq('ambiente', ambiente)
            .eq('contesto->campi->>esito', ESITO_AUDIT_NON_REGISTRATO)
            .gte('visto_l_ultima', da)
            .limit(RIGHE_MAX_AUDIT)
        if (error) {
            // PostgREST non lancia (regola 7): una lettura caduta non è «nessuna traccia persa».
            const codice = codiceDi(error)
            if (CODICI_NON_INSTALLATO.has(codice)) {
                return { esito: 'ok', dettaglio: `app_log non leggibile su questo database (${codice})` }
            }
            return { esito: 'degradato', dettaglio: `lettura app_log ${codice}` }
        }
        const righe = (data ?? []) as { occorrenze?: unknown }[]
        const n = count ?? righe.length
        const ore = FINESTRA_AUDIT_MS / ORA
        if (n === 0) return { esito: 'ok', dettaglio: `nessuna traccia d'audit persa nelle ultime ${ore} h` }
        const occorrenze = righe.reduce(
            (somma, r) => somma + (typeof r.occorrenze === 'number' && r.occorrenze > 0 ? r.occorrenze : 1),
            0,
        )
        return {
            esito: 'degradato',
            dettaglio: `tracce d'audit non registrate nelle ultime ${ore} h: ${occorrenze} (${n} impronte)`,
        }
    })
}
```

In `eseguiSalute` (righe 1432-1435) aggiungi la riga dopo `controlloCodeArretrate`:

```ts
        controlloCodaFatture(supabase, adesso),
        controlloCodeArretrate(supabase, adesso),
        controlloAuditDocente(supabase, adesso, opzioni.ambiente),
        Promise.resolve(controlloRegione()),
```

- [ ] **Passo 4: verifica che passino**

```bash
npx vitest run __tests__/lib/health/audit-docente.test.ts __tests__/api/health.test.ts __tests__/api/health-livelli.test.ts __tests__/lib/health/code-arretrate.test.ts 2>&1 | tail -8
npx eslint src/lib/health/controlli.ts __tests__/lib/health/audit-docente.test.ts __tests__/api/health.test.ts --max-warnings 0
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: 4 file verdi; `health-livelli` resta com'era, perché il livello «vivo» ha solo `auth` e `db-lettura`. eslint e tsc senza output.

- [ ] **Passo 5: commit**

```bash
git add src/lib/health/controlli.ts __tests__/lib/health/audit-docente.test.ts __tests__/api/health.test.ts
git commit -m "$(cat <<'EOF'
Salute: controllo audit-docente, degradato alla prima traccia d'audit persa (T6)

Una riga audit-non-registrato del server nelle ultime 24 h porta /api/health a
degraded (mai down): sta sotto le soglie di tasso-errore e nessuno la vedeva. Il
campanello apre salute:audit-docente alla seconda lettura.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Migrazione

**Nome:** `supabase/migrations/<version>_iscrizioni_stati_vincolati.sql`. La version si genera con `date -u +%Y%m%d%H%M%S` nel Compito 6, Passo 3. Il testo completo sta nel Passo 4.

**Cosa fa:** due blocchi `DO`, uno per tabella. Ciascuno ha una guardia per la tabella assente (database E2E della CI) e una per il vincolo già presente. Poi conta le righe fuori elenco: con zero righe esegue `ADD CONSTRAINT … NOT VALID` e subito `VALIDATE`; altrimenti non aggiunge niente e scrive un `error` in `app_log`. Chiude con `NOTIFY pgrst, 'reload schema'`.

**Perché un conteggio e non solo `NOT VALID`.** Un `CHECK NOT VALID` non controlla le righe vecchie, ma vale per **ogni** `UPDATE` successivo, anche su quelle righe. Una riga con uno stato sporco diventerebbe immodificabile, e se ne accorgerebbe una segreteria a metà lavoro, con un `500`. Il conteggio rende impossibile che `VALIDATE` fallisca al merge: è il «Rischio» della specifica. Dentro la stessa migrazione, che è una transazione, `NOT VALID` seguito da `VALIDATE` non accorcia il blocco della tabella. Le due tabelle sono piccole (i conteggi veri vengono dai Passi 0.1 e 0.3), e la differenza non si misura.

**Chi la applica:** l'integrazione GitHub di Supabase al merge in `main`, con la version del file. Non va riapplicata a mano: farebbe due righe nel registro. La CI delle PR non migra il database E2E, e `migrate-ci.yml` è solo manuale. Nessun codice dipende dall'esistenza dei vincoli, quindi l'E2E resta uguale.

**Verifica dopo il merge:** vedi il Compito 9, Passo 7.

**Fotografie:** la migrazione resta dichiarata in `MIGRAZIONI_ATTESE_AL_MERGE` finché la sessione dopo non la toglie nel suo primo commit (sezione «Per la sessione dopo»). Al merge cambia davvero solo la fotografia delle migrazioni. Quella delle FK verso `utenti` si rigenera con lo stesso contenuto, solo perché la sua guardia riconosce `ADD CONSTRAINT`. Le altre non guardano questi `CHECK` (la fotografia delle tabelle non guarda i `CHECK`; quella di `fk-scuola-id` guarda i vincoli di `alunni` solo se nominano `fiscal`) e non si toccano.

---

## Log

| Dove | Evento · livello | `esito` | Campi (solo conteggi, uuid, nomi di tabella) | Quando |
|---|---|---|---|---|
| `src/lib/iscrizioni/percorsi-citati.ts` | `gdpr` · `error` | `citazioni-non-lette` | `operazione`, `entita_tipo` (la tabella), `n_file`, errore PostgREST completo | una lettura delle citazioni fallisce |
| `src/app/api/gdpr/retention-iscrizioni/route.ts` | `cron` · `error` | `citazioni-non-lette` | `canale`, `n_domande`, `n_file`, `ms` | il giro si ferma senza toccare niente (`500`) |
| idem, battito esistente | `cron` · `info` | `retention-iscrizioni` | **più** `n_file_citati` | sempre, anche con zero: «nessun file citato» va scritto |
| `src/app/api/admin/iscrizioni/route.ts` | `iscrizione` · `warn` | `rifiuto-domanda-non-in-attesa` | `azione`, `entita_tipo`, `entita_id` (uuid della domanda) | rifiuto respinto con `409` |
| migrazione | `app_log` · `info` / `error` | `vincolo-convalidato` / `vincolo-non-aggiunto` | `operazione`, `entita_tipo`, `n` (righe fuori elenco) | al merge, una riga per tabella (`fingerprint` `migrazione-stati-vincolati-domande` e `-alunni`) |
| `/api/health` | nessuna riga nuova | — | il controllo `audit-docente` nella risposta; lo stato `degraded` lo registra già la route (`config` · `warn`) | ogni lettura |

Il successo del rifiuto resta tracciato da `logScrittura` (il registro d'audit), come prima. Nessun campo nuovo entra nella lista bianca della redazione: `n_file_citati` è un numero, `entita_tipo` e `azione` ci sono già.

---

## PRD

### Compito 8 — Voce di changelog nel PRD

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md:1` (la voce nuova va **in cima**, sopra la prima `## `)

- [ ] **Passo 1: il conteggio del giorno** (regola della §5: il numero si rifà, non si copia)

```sql
select now() at time zone 'utc' as adesso_utc, count(*) as domande from enrollment_submissions;
```

- [ ] **Passo 2: scrivi la voce**

Inserisci in cima al PRD il blocco qui sotto. I valori fra parentesi graffe sono quelli **misurati**: il Passo 0, il Passo 1 di questo compito e la version del Compito 6.

```markdown
## 🛡️ Changelog — Robustezza 2, sessione 1: i documenti delle iscrizioni non si perdono, gli stati sono vincolati — {data UTC} (branch `robustezza2/s01-iscrizioni`)

**Stato:** 🟡 in revisione, in attesa del merge a mano del titolare. Specifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` §7, sessione 1; piano: `docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md`. Scadenza: in produzione entro il 31/10, prima del giro dell'1/11 alle 04:41 UTC.

- **Domande d'iscrizione oggi:** {conteggio} alle {ora} UTC. Stati delle domande: {valori e conteggi del Passo 0.2}. Stati degli alunni: {valori e conteggi del Passo 0.3}. Guardia del 31/10: {Passo 0.4}. Domande in attesa o respinte con allegati già citati da un'anagrafica o dal fascicolo: {Passo 0.6}.
- **D9 — la conservazione non toglie più un documento citato.** `src/lib/iscrizioni/percorsi-citati.ts` legge a blocchi di 25 `alunni.documento_path`, `parents.documento_path` e `student_documents.storage_path`/`.file_url`, quest'ultimo anche dal cestino. Il giro `iscrizioni-retention` lascia nel bucket i file citati, chiude comunque la riga scaduta e li conta in `n_file_citati`. Se non riesce a leggere le citazioni non tocca niente e risponde `500 citazioni-non-lette`.
- **D9 — si respinge solo una domanda in attesa.** Il filtro `status = 'pending'` sta dentro l'`UPDATE`: su una domanda già approvata o già respinta la risposta è `409 DOMANDA_GIA_ESAMINATA`, tradotta in italiano e in inglese.
- **D11 — stati vincolati.** Migrazione `{version}_iscrizioni_stati_vincolati.sql`: `CHECK` `enrollment_submissions_status_ammesso` (pending, approved, rejected) e `alunni_stato_ammesso` (iscritto, ritirato, sospeso; NULL ammesso), `NOT VALID` e poi `VALIDATE`, aggiunti solo se il conteggio delle righe fuori elenco è zero. Lock `__tests__/architecture/stati-vincolati-in-sql.test.ts`. `STATI_DOMANDA` esce dalla route e va in `src/lib/iscrizioni/stati.ts`.
- **T6 — audit docente con allarme.** `/api/health` ha un decimo controllo, `audit-docente`: `degradato` (mai `giu`) alla prima riga `audit-non-registrato` del server nelle ultime 24 ore. Il campanello apre `salute:audit-docente`.
- **Logging.** `citazioni-non-lette` (`gdpr` e `cron`, `error`); `n_file_citati` nel battito `info` del giro; `rifiuto-domanda-non-in-attesa` (`iscrizione`, `warn`); in `app_log` la migrazione scrive `vincolo-convalidato` oppure `vincolo-non-aggiunto` con il conteggio.
- **Da fare dopo il merge (nel primo commit della sessione che apre dopo, dalla sezione «Per la sessione dopo» del piano):** fotografie delle migrazioni e delle FK verso `utenti` rigenerate, `MIGRAZIONI_ATTESE_AL_MERGE` svuotata, riga 1 della tabella di stato a «in produzione», misura «dopo». Dall'1/11 dopo le 04:41 UTC, lettura del battito del giro, scritta dalla prima PR che tocca la specifica dopo quel giorno.
```

- [ ] **Passo 3: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: robustezza 2, sessione 1 (documenti delle iscrizioni, stati vincolati, audit)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 9 — Gate, PR, merge del titolare, verifica

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (la riga **Stato** della voce del Compito 8)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga che `grep -n "^| 1 |"` trova; riga 25 il 20/10)

- [ ] **Passo 1: gate completo**

```bash
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
npx vitest run 2>&1 | tail -15
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso: eslint e tsc senza output. Vitest: tutti i file verdi; se l'unico rosso è `offline-html-nativo`, rilancialo con `CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts`. Build: `✓ Compiled` e nessun `Error`. La build senza heap a 8192 MB va in OOM su questa macchina. Leggi le righe di riepilogo, non il codice d'uscita di una pipe.

- [ ] **Passo 2: log presenti sul codice toccato**

```bash
grep -n "citazioni-non-lette\|n_file_citati" src/app/api/gdpr/retention-iscrizioni/route.ts src/lib/iscrizioni/percorsi-citati.ts
grep -n "rifiuto-domanda-non-in-attesa" src/app/api/admin/iscrizioni/route.ts
grep -n "vincolo-convalidato\|vincolo-non-aggiunto" supabase/migrations/*_iscrizioni_stati_vincolati.sql | head -4
```

Atteso: almeno una riga per ciascuno.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s01-iscrizioni
gh pr create --base main --head robustezza2/s01-iscrizioni \
  --title "Robustezza 2, sessione 1: documenti delle iscrizioni mai persi, stati vincolati, audit con allarme" \
  --body "$(cat <<'EOF'
## Cosa cambia
- **D9 — conservazione.** Il giro `iscrizioni-retention` (1° del mese, 04:41 UTC) non toglie più un allegato che `alunni`, `parents` o `student_documents` (anche nel cestino) nominano ancora. La riga scaduta si chiude e il file resta. Se non riesce a leggere le citazioni non tocca niente: `500 citazioni-non-lette`. Il battito porta `n_file_citati`.
- **D9 — rifiuto.** Il filtro `status = 'pending'` sta dentro l'`UPDATE`: su una domanda già approvata o già respinta la risposta è `409 DOMANDA_GIA_ESAMINATA`.
- **D11 — migrazione** `supabase/migrations/<version>_iscrizioni_stati_vincolati.sql`: `CHECK` su `enrollment_submissions.status` e `alunni.stato`, `NOT VALID` e poi `VALIDATE`, solo se il conteggio delle righe fuori elenco è zero (altrimenti una riga `error` in `app_log`).
- **T6 — `/api/health`.** Controllo nuovo, `audit-docente`: `degradato` alla prima traccia d'audit persa nelle ultime 24 ore.

## Misure (sola lettura, prima del merge)
- Domande d'iscrizione: {conteggio} alle {ora} UTC.
- Stati delle domande / degli alunni: {Passo 0.2} / {Passo 0.3}.
- Guardia del 31/10: {Passo 0.4}. Domande che il giro dell'1/11 toccherebbe: {Passo 0.5}.
- Tracce d'audit perse nelle ultime 24 ore: {Passo 0.8}.

## Migrazione
La applica l'integrazione al merge. È dichiarata in `MIGRAZIONI_ATTESE_AL_MERGE`; la sessione che apre dopo, nel suo primo commit, rigenera le fotografie dalla produzione e toglie la voce (sezione «Per la sessione dopo» del piano).

## Merge
A mano, dal titolare. Niente auto-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Prima di lanciarlo, sostituisci nel corpo `<version>` e i valori fra graffe con quelli misurati. Annota il numero della PR stampato da `gh`.

- [ ] **Passo 4: CI verde su tutti i job**

```bash
gh pr checks {numero PR} --watch
```

Atteso: ogni job `pass`. Un job `cancelled` del gruppo E2E non è rosso: succede quando più PR partono di fila. Si rilancia con `gh run rerun {id del run} --failed`, una PR alla volta. «CI verde» vuol dire **tutti** i job.

- [ ] **Passo 5: la riga di stato «in revisione» e lo stato nel PRD, nella PR stessa**

La riga della tabella di stato si trova per contenuto, mai per numero:

```bash
grep -n "^| 1 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: **una** riga. Sostituiscila con questa, lasciando la colonna «Note» com'era:

```markdown
| 1 | Iscrizioni: documenti mai persi, stati vincolati | D9, D11 (CHECK, audit docente) | — | in revisione | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md` | **entro il 31/10** (giro dell'1/11, 04:41 UTC). T6 |
```

Lo Stato si scrive «in revisione», con queste parole. «In produzione», il commit di `main` e la misura «dopo» per questa riga li scrive **solo** la sessione che apre dopo (§5, «La tabella di stato»), con la sezione «Per la sessione dopo» di questo piano.

Nella voce del Compito 8, la riga **Stato** del PRD diventa `🟡 in revisione (PR #{numero}), CI verde, in attesa del merge a mano del titolare.`

```bash
grep -c "^| 1 | .* | in revisione | #" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
Specifica e PRD: sessione 1 di robustezza 2 in revisione

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Atteso: il `grep -c` stampa `1`. Poi aspetta di nuovo la CI (Passo 4).

- [ ] **Passo 6: merge — lo fa il titolare, a mano**

Avvisa il titolare con il link della PR, i numeri del Passo 0 e, se `ultime_24h` del Passo 0.8 era maggiore di 0, l'avviso che `audit-docente` sarà subito `degradato`. **Mai** auto-merge, **mai** `gh pr merge` da chi esegue.

- [ ] **Passo 7: `SELECT` di verifica dopo il merge**

Sola lettura, sul database di produzione, qualche minuto dopo il merge:

```sql
select version, name from supabase_migrations.schema_migrations order by version desc limit 3;

select conname, convalidated, pg_get_constraintdef(oid) as definizione
from pg_constraint
where conname in ('enrollment_submissions_status_ammesso', 'alunni_stato_ammesso')
order by 1;

select livello, contesto->'campi'->>'esito' as esito, contesto->'campi'->>'entita_tipo' as tabella,
       contesto->'campi'->>'n' as n, visto_l_ultima
from app_log
where fingerprint in ('migrazione-stati-vincolati-domande', 'migrazione-stati-vincolati-alunni')
order by visto_l_ultima desc;
```

Atteso:
- la version del file in cima al registro, **una** riga;
- **due** vincoli, `convalidated = true`, con i valori del Compito 6;
- **due** righe `info` `vincolo-convalidato`.

Se manca un vincolo e c'è una riga `error` `vincolo-non-aggiunto`, le righe fuori elenco sono comparse fra il Passo 0 e il merge. Il numero è in `n`: si porta al titolare e si decide con le regole dei Passi 0.2 e 0.3. La migrazione non si riapplica a mano.

- [ ] **Passo 8: la salute vede il controllo nuovo (verifica a caldo)**

Apri `/api/health` (o leggi l'ultima risposta del monitor Cloudflare) e verifica che `audit-docente` compaia fra i controlli, `ok` oppure `degradato` come previsto dal Passo 0.8. Non si scrive niente nel repo: specifica, PRD e misura «dopo» li aggiorna la sessione che apre dopo, con la sezione «Per la sessione dopo». Se `audit-docente` manca dalla risposta, il deploy non è quello del merge: si avvisa il titolare.

- [ ] **Passo 9: pulizia del ramo della sessione**

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s01-iscrizioni
git -C /Users/lerri/kidville-web branch -D robustezza2/s01-iscrizioni
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s01-iscrizioni
```

Gli altri rami con una PR aperta (per esempio quello della PR #254, se fosse ancora aperta) **non** si toccano. Non si apre nessun ramo di soli documenti dopo il rilascio: quello che resta da fare sta nella sezione «Per la sessione dopo».

---

## Ritorno indietro

**Il codice** (Compiti 2-5 e 7). Su un ramo nuovo si fa il `git revert` del commit di merge, poi PR, CI e merge del titolare. Prima di annullare il Compito 4 si rilancia la guardia del 31/10 (0.4) e la query 0.6. Senza `percorsiCitati`, un documento citato torna a rischio al primo giro mensile: se una delle due dà più di 0, il titolare spegne il job (0.7) **prima** del merge del revert. Annullare il solo controllo `audit-docente` è innocuo: si toglie la riga da `eseguiSalute` e il test relativo.

**La migrazione.** Si scrive una migrazione inversa, con una version nuova generata nello stesso modo, e passa da una PR. L'integrazione la applica al merge:

```bash
VERSION=$(date -u +%Y%m%d%H%M%S)
cat > "supabase/migrations/${VERSION}_iscrizioni_stati_vincolati_indietro.sql" <<'SQL'
-- =============================================================================
-- RITORNO INDIETRO di `<version>_iscrizioni_stati_vincolati.sql`.
-- Toglie i due CHECK. Nessun dato cambia: un CHECK non scrive righe.
--
-- ─── COME SI VERIFICA ─────────────────────────────────────────────────────────
--   select count(*) from pg_constraint
--    where conname in ('enrollment_submissions_status_ammesso', 'alunni_stato_ammesso');  → 0
--
-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
--   Rieseguire `<version>_iscrizioni_stati_vincolati.sql`.
-- =============================================================================
DO $$ BEGIN
  IF to_regclass('public.enrollment_submissions') IS NOT NULL THEN
    ALTER TABLE public.enrollment_submissions DROP CONSTRAINT IF EXISTS enrollment_submissions_status_ammesso;
  END IF;
  IF to_regclass('public.alunni') IS NOT NULL THEN
    ALTER TABLE public.alunni DROP CONSTRAINT IF EXISTS alunni_stato_ammesso;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
SQL
```

Nei due commenti della testata, `<version>` è la version della migrazione del Compito 6 (la stessa scritta nel PRD): sostituiscila con `sed -i '' "s/<version>/{version del Compito 6}/g"` sul file appena creato.

Nella stessa PR:
- dichiara il file nuovo in `MIGRAZIONI_ATTESE_AL_MERGE`, perché `drop constraint` fa scattare la guardia delle FK, con una ragione che nomini l'integrazione e la PR-B (prova 4 di `soglia-fotografia.test.ts`), per esempio `'toglie i due CHECK degli stati con DROP CONSTRAINT, nessuna FK verso utenti: la applica l’integrazione al merge; la toglie la PR-B (primo commit della sessione dopo).'`;
- togli il lock `__tests__/architecture/stati-vincolati-in-sql.test.ts`, che altrimenti continuerebbe a leggere l'`ADD CONSTRAINT` della migrazione vecchia e a dire «vincolato»;
- aggiungi una voce nel PRD.

Dopo il merge del revert non si apre un ramo di soli documenti: la PR-B è il primo commit della sessione che apre dopo, che applica al file inverso i punti 2, 3 e 4 della sezione «Per la sessione dopo» (fotografia delle migrazioni, voce tolta, fotografia delle FK verso `utenti`). Chi scrive il revert aggiunge alla sezione «Per la sessione dopo» una riga che lo dice, con il nome del file inverso.

**In emergenza.** Se una scrittura legittima in produzione viene rifiutata con `23514`, la strada è la stessa PR, con priorità. Se il titolare chiede di togliere subito un vincolo a mano, l'istruzione si **mostra prima** (CLAUDE.md: mostrare non è chiedere) ed è una sola `ALTER TABLE … DROP CONSTRAINT IF EXISTS …`. La migrazione inversa va comunque nel repo subito dopo, perché il registro e il repo devono restare allineati.

**Le fotografie.** Nessun ritorno indietro proprio: le rigenera la PR-B della migrazione inversa, cioè il primo commit della sessione dopo.

---

## Per la sessione dopo

Questa sezione la esegue la sessione che apre **dopo** il rilascio della sessione 1, nel suo primo commit, prima di ogni codice (§5, «Apertura di una sessione: la chiusura della precedente»). Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Tutte le query sono in **sola lettura**, con `execute_sql` sul database di produzione; i comandi partono dalla radice del worktree della sessione che chiude.

**Che cosa ha lasciato la sessione 1.** Una migrazione, `supabase/migrations/<version>_iscrizioni_stati_vincolati.sql`: due `CHECK` (`enrollment_submissions_status_ammesso` su `enrollment_submissions.status`, `alunni_stato_ammesso` su `alunni.stato`). Nessun indice unico, nessuna policy, nessuna FK, nessuna colonna `scuola_id`, nessun bucket, niente su `candidature_insegnanti`. Il numero della PR è nella riga `^| 1 |` della tabella di stato (colonna «PR»).

- [ ] **1. La migrazione è applicata, una volta sola**

```bash
ls supabase/migrations/ | grep "_iscrizioni_stati_vincolati\.sql$"
```

Le 14 cifre iniziali sono la `<version>`. Poi, con quel valore:

```sql
select version, name from supabase_migrations.schema_migrations where version = '{le 14 cifre}';
select conname, convalidated from pg_constraint
where conname in ('enrollment_submissions_status_ammesso', 'alunni_stato_ammesso') order by 1;
```

Atteso: **una** riga nel registro; **due** vincoli con `convalidated = true`. Zero righe nel registro: **fermati** e avvisa il titolare (la migrazione non si applica a mano). Un solo vincolo: è il caso «vincolo-non-aggiunto» (righe fuori elenco comparse prima del merge); si prosegue, ma va scritto nella colonna «Note» della riga 1 e nel PRD, e si porta al titolare il numero `n` di questa lettura:

```sql
select livello, contesto->'campi'->>'esito' as esito, contesto->'campi'->>'entita_tipo' as tabella,
       contesto->'campi'->>'n' as n
from app_log
where fingerprint in ('migrazione-stati-vincolati-domande', 'migrazione-stati-vincolati-alunni');
```

- [ ] **2. Fotografia delle migrazioni applicate — cambia davvero (una version in più)**

```bash
SCRATCH=$(mktemp -d)
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query stampata, salva la risposta JSON così com'è in `"$SCRATCH"/risposta-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -10
```

Atteso: `migrazioni-complete` verde; `soglia-fotografia` **rosso** sulla prova «2 · nessuna chiave è già applicata», con il nome `<version>_iscrizioni_stati_vincolati.sql`. È il segnale che la voce del punto 3 va tolta.

- [ ] **3. La voce da togliere da `MIGRAZIONI_ATTESE_AL_MERGE`**

In `__tests__/architecture/soglia-fotografia.ts` togli la voce con chiave `'<version>_iscrizioni_stati_vincolati.sql'` (la cerchi con `grep -n "iscrizioni_stati_vincolati" __tests__/architecture/soglia-fotografia.ts`). Se era l'unica, la costante torna:

```ts
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {}
```

Il commento di storia che comincia con `// 2026-10 · ROBUSTEZZA 2, SESSIONE 1` resta, con una riga in più in fondo:

```ts
// SVUOTATA il {data UTC} (PR-B, primo commit della sessione dopo il merge di #{numero PR}, `{sha corto}`):
// applicata dall'integrazione, una riga sola nel registro; fotografie delle migrazioni e delle FK verso
// `utenti` rigenerate dalla produzione — cambia davvero solo quella delle migrazioni.
```

Lo `{sha corto}` è il commit di merge su `main`:

```bash
gh pr view {numero PR} --repo erricoluigi17/kidville-web --json mergeCommit --jq '.mergeCommit.oid[0:8]'
```

Nessun'altra lista «fino alla PR-B» è stata riempita dalla sessione 1.

- [ ] **4. Fotografia delle FK verso `utenti` — stesso contenuto, nuovo istante**

La migrazione non tocca nessuna FK, ma la guardia `tracce-docente-dichiarate` riconosce `ADD CONSTRAINT` (`toccaLeFkUtenti`): tolta la voce del punto 3, segnalerebbe il file come posteriore alla fotografia. Si rigenera:

```bash
node __tests__/fixtures/fk-utenti-fotografia.mjs --sql
```

Esegui la query, salva la risposta in `"$SCRATCH"/risposta-fk-utenti.json`, poi:

```bash
node __tests__/fixtures/fk-utenti-fotografia.mjs < "$SCRATCH"/risposta-fk-utenti.json
npx vitest run __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
```

Atteso: due file verdi, e nel `git diff` della fotografia cambia solo l'istante dello scatto (stessa `sha256`). Se cambia il contenuto, qualcosa ha toccato una FK verso `utenti` fuori da questa sessione: va capito prima del commit.

**Nessun'altra fotografia** si rigenera per la sessione 1: le guardie `onconflict-arbitro` (indici unici) e `rls-per-sede` (policy) non riconoscono il file, che non contiene `unique`, `primary key` né `policy`; la fotografia di `fk-scuola-id` guarda i vincoli di `alunni` solo se nominano `fiscal`; tabelle con `scuola_id`, bucket e schema delle candidature non c'entrano.

- [ ] **5. La riga di stato a «in produzione»**

```bash
grep -n "^| 1 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Sostituisci la riga trovata con:

```markdown
| 1 | Iscrizioni: documenti mai persi, stati vincolati | D9, D11 (CHECK, audit docente) | — | in produzione | #{numero PR} | `docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md` | in produzione il {data UTC del merge}, `main` `{sha corto}`; misura dopo del {data e ora UTC}: {sintesi del punto 6}. Battito dell'1/11: matura dal 01/11 dopo le 04:41 UTC. T6 |
```

- [ ] **6. Misura «dopo» — matura subito dopo il merge**

```sql
select now() at time zone 'utc' as adesso_utc, count(*) as domande from enrollment_submissions;

select status, count(*) from enrollment_submissions group by 1 order by 1;

select coalesce(stato, '<null>') as stato, count(*) from alunni group by 1 order by 1;

select count(*) from enrollment_submissions
where imported_at is not null and status in ('pending','rejected');

with allegati as (
  select e.id, trim(x.elemento->>'documento_path') as percorso
  from enrollment_submissions e
  cross join lateral jsonb_array_elements(
    (case when jsonb_typeof(e.data->'children') = 'array' then e.data->'children' else '[]'::jsonb end)
    || (case when jsonb_typeof(e.data->'adults') = 'array' then e.data->'adults' else '[]'::jsonb end)
  ) as x(elemento)
  where e.status in ('pending','rejected')
)
select count(distinct a.id) as domande, count(distinct a.percorso) as allegati
from allegati a
where coalesce(a.percorso, '') <> ''
  and (exists (select 1 from alunni al where al.documento_path = a.percorso)
    or exists (select 1 from parents p where p.documento_path = a.percorso)
    or exists (select 1 from student_documents d where d.storage_path = a.percorso or d.file_url = a.percorso));
```

Atteso: stati delle domande solo in `approved`, `pending`, `rejected`; stati degli alunni solo in `iscritto`, `ritirato`, `sospeso` (più `<null>`). Le ultime due letture non hanno una soglia: si scrivono e basta. Poi `/api/health`: `audit-docente` compare fra i controlli. Ogni numero va con data e ora UTC.

- [ ] **7. Misura che matura dopo: il battito del giro dell'1/11 — matura dal 01/11/2026 dopo le 04:41 UTC**

Se la sessione dopo apre prima di quell'ora, questo punto non si fa ora: lo scrive la **prima PR che tocca la specifica dopo il 01/11 alle 04:41 UTC**, nella colonna «Note» della riga 1 e nel PRD.

```sql
select livello, visto_l_ultima,
       contesto->'campi'->>'esito' as esito,
       contesto->'campi'->>'n_domande' as n_domande,
       contesto->'campi'->>'n_file' as n_file,
       contesto->'campi'->>'n_file_citati' as n_file_citati
from app_log
where contesto->'campi'->>'operazione' = 'iscrizioni-retention'
  and visto_l_ultima >= '2026-11-01'
order by visto_l_ultima desc limit 5;
```

Atteso: una riga `info` con `esito = 'retention-iscrizioni'` e `n_file_citati` valorizzato (anche `0`), nessuna riga `error`. Il battito di questo giro non dichiara `esito: ok`: l'«ok» della Prova della specifica è questa riga `info`. Con più di 50 domande scadute arriva invece la riga `error` `interruttore`: è previsto (nessuna cancellazione), e va portato al titolare. Una riga `error` `citazioni-non-lette` vuol dire che il giro si è fermato senza toccare niente: anche questa va al titolare.

- [ ] **8. Lo Stato della voce nel PRD**

La voce si trova con `grep -n "Robustezza 2, sessione 1:" "PRD REGISTRO ELETTRONICO.md"`. La sua riga **Stato** diventa:

`✅ in produzione dal {data UTC} (PR #{numero PR}, merge {sha corto}); vincoli convalidati: {2, oppure quale manca, dal punto 1}.`

e in fondo alla voce si aggiunge un punto **Misura dopo ({data e ora UTC})** con i numeri del punto 6, e la riga «battito dell'1/11: matura dal 01/11 dopo le 04:41 UTC» finché il punto 7 non è fatto.

- [ ] **9. Verifica e commit** (dentro il primo commit della sessione che chiude)

```bash
npx vitest run __tests__/architecture 2>&1 | tail -10
git add __tests__/fixtures/migrazioni-applicate-snapshot.json __tests__/fixtures/fk-utenti-snapshot.json __tests__/architecture/soglia-fotografia.ts docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
git status --short
```

Atteso: tutto verde (salvo `offline-html-nativo` in un worktree nuovo, da rilanciare con `CI=1`), e i cinque file in stato `M`.

---

## Autorevisione (fatta alla stesura, da ripetere alla fine)

**Copertura della §7, sessione 1:**

| Richiesta della specifica | Dove |
|---|---|
| Obiettivo: la conservazione non toglie un documento citato | Compiti 3 e 4 |
| Obiettivo: una domanda approvata non si respinge | Compito 5 |
| Misura prima: valori distinti e conteggi di `status` e `stato`; guardia del 31/10 | Passo 0.2, 0.3, 0.4 (più 0.5-0.8) |
| `retention-iscrizioni/route.ts`: citazioni da anagrafiche e fascicolo, nessuna rimozione se la lettura fallisce | Compito 4 (con la deviazione motivata sugli «incerti») |
| `admin/iscrizioni/route.ts`: `.eq('status','pending')`, zero righe → `409` con `codice` | Compito 5 |
| Migrazione `CHECK … NOT VALID` poi `VALIDATE`, valori misurati e coerenti con `stati-alunno-anche-in-sql` | Compito 6 (tabella delle due fonti, lock nuovo, test di coerenza con `STATI_NON_PIU_ISCRITTO`) |
| T6: controllo `audit-docente`, `degradato` mai `giu`, prima occorrenza in 24 h, colonna letta prima | Passo 0.8 e Compito 7 |
| Rischio: un valore imprevisto ferma l'integrazione | Il conteggio nella migrazione: nessun `VALIDATE` può fallire |
| Indietro: `DROP CONSTRAINT` in una migrazione inversa; revert | «Ritorno indietro» |
| Prova: due vincoli convalidati in `pg_constraint` | Compito 9, Passo 7 |
| Prova: domanda importata `pending`/`rejected` che cita un documento → il documento resta | `retention-iscrizioni-documenti-citati.test.ts` |
| Prova: il giro dell'1/11 batte con il conteggio dei citati | «Per la sessione dopo», punto 7 (matura dal 01/11 dopo le 04:41 UTC) |
| Prova: rifiutare una domanda approvata → `409` | `iscrizioni-rifiuto-solo-in-attesa.test.ts` |
| Prova: numeri letterali, un solo `audit-non-registrato` → `degradato` | `audit-docente.test.ts` e il caso nuovo in `health.test.ts` |
| §5: un ramo, ROLLBACK in testata, log con `esito`, PRD, conteggio delle domande con l'ora UTC | Compiti 1, 6, 8 e sezione «Log» |
| §5 e §6: prerequisiti (nessuna PR `robustezza2/` aperta) e chiusura della precedente nel primo commit | Compito 1, Passi 1 e 6 |
| §5: riga di stato «in revisione» nella propria PR, «in produzione» solo dalla sessione dopo | Compito 9, Passo 5; «Per la sessione dopo», punto 5 |
| §6: sezione «Per la sessione dopo» (fotografie col comando, voce di `MIGRAZIONI_ATTESE_AL_MERGE`, riga di stato, misura «dopo» e quando matura, PRD) | «Per la sessione dopo», punti 1-9 |

**Coerenza dei nomi:** `percorsiCitati` / `PERCORSI_PER_QUERY` / `EsitoCitazioni { verificato, citati }` (Compiti 3 e 4); `STATI_DOMANDA` / `STATO_DOMANDA_IN_ATTESA` (Compiti 2, 5, 6); `DOMANDA_GIA_ESAMINATA` / `erroreDomandaGiaEsaminata` (Compito 5); `controlloAuditDocente` / `FINESTRA_AUDIT_MS` / `ESITO_AUDIT_NON_REGISTRATO` (Compito 7); vincoli `enrollment_submissions_status_ammesso` / `alunni_stato_ammesso` (Compiti 6 e 9, Ritorno indietro).

- [ ] **Alla fine dell'esecuzione:** rileggi questa tabella e spunta ogni riga con il commit o la query che la prova. Una riga senza prova vuol dire una sessione non chiusa.
