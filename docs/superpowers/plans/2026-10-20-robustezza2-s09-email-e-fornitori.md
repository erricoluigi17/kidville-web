# Sessione 9 — Email e fornitori senza successi finti — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** un sollecito conta come inviato solo se almeno un'email è partita davvero; quando non ne parte nessuna la voce resta al giro dopo, e Resend, Anthropic e le route lunghe smettono di poter fallire in silenzio o morire a metà.

**Architettura:**
- **Solleciti.** La presa sulla cadenza (fase 8) resta prima dell'email. Dopo il giro dei destinatari, se **nessuna** email è partita e l'esito è certo, la presa si annulla con un UPDATE condizionato sulla presa stessa (`… where ultimo_sollecito_il = <presa>`): se un altro giro l'ha già ripresa, resta la sua. Se l'esito è **incerto** (scadenza senza risposta, `409` concorrente) la presa resta: meglio slittare di una cadenza che partire due volte. Il registro `solleciti` si scrive anche quando l'invio fallisce, con l'esito per destinatario; i livelli contano solo le righe con almeno un `inviata: true`. Niente push se nessuna email è partita.
- **Resend.** `sendEmailDetailed` impara i ritentativi, **solo su richiesta** (`ritentativi`): al massimo 3 chiamate, su `429` sempre e su `5xx` / rete solo con la chiave d'idempotenza, la **stessa** chiave a ogni tentativo, il `Retry-After` rispettato e un limite calcolato dentro il tetto del giro (240 s). Chi non passa `ritentativi` non vede cambiare niente. Le attese sono in serie: il giro non si parallelizza.
- **Fornitori e route lunghe.** La traduzione passa da `externalFetch` con un tetto di 20 s, un ritentativo e un'attesa massima di 5 s; `news/cron/run` confronta il segreto con `segretoCronValido`; venti route lunghe che non sono del cron dichiarano `maxDuration`, e il lock `cron-max-duration` le pretende.

**Tecnologie:** Next 16 App Router (route avvolte in `withRoute`, `export const maxDuration` letterale), TypeScript, API REST di Resend con l'header `Idempotency-Key`, `@anthropic-ai/sdk` 0.106.0 (`ClientOptions`: `timeout`, `maxRetries`, `fetch`), postgrest-js (`.contains` su `jsonb`), vitest 4 con orologio finto (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`) e `vi.stubGlobal('fetch', …)`.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 9 — Email e fornitori senza successi finti» (righe 607-638), con le regole comuni della §5 (righe 133-208: «Codice che regge il momento del merge», «La tabella di stato (§1), in due tempi», «Apertura di una sessione: i prerequisiti», «Apertura di una sessione: la chiusura della precedente», «Riferimenti al codice»), il formato della §6 (righe 212-245) e la riga della sessione 9 nella tabella di stato della §1 (colonna «Dopo»: 7; si trova con `grep -n "^| 9 |"`, era la 33 il 20/10). Righe lette il 20/10: chi esegue cerca i titoli, non i numeri.

---

## Mappa dei file

| File | Azione | Ruolo |
|---|---|---|
| `src/lib/rete/retry-after.ts` | **Crea** | `msDaRetryAfter`: `Retry-After` in secondi o data HTTP → millisecondi. La cartella esiste già (`cache-promesse.ts`) |
| `__tests__/lib/rete-retry-after.test.ts` | **Crea** | I due formati, il passato, l'illeggibile |
| `src/lib/email/send.ts` | **Modifica** 1-3 (import), 110-111 (`ritentativi` in `SendEmailParams`), 145-146 (`tentativi`, `incerto` in `SendEmailResult`), 169-170 (costanti), 214 (firma), 242-287 (la chiamata, come la dà la specifica), 315, 318-321, 327-342, 344-356, 367-370, dopo 394 (aiutanti) | I ritentativi, l'esito incerto, la riga di chiusura col corpo sanificato. Letto 1-414 |
| `__tests__/lib/email-send-ritentativi.test.ts` | **Crea** | Resend finto (429, 500, 422, 409, rete giù, scadenza), orologio finto |
| `src/lib/pagamenti/solleciti-invio.ts` | **Modifica** 8 (import), 53 (intestazione), 61-67 (`EsitoSollecito`), 92 (filtro e tipi), 151 (livelli recapitati), 358 (nessun indirizzo), 420-485 (il giro dei destinatari), dopo 494 (tre funzioni) | Presa annullata, registro sempre scritto, conteggi. Letto 1-494 |
| `__tests__/api/pagamenti-solleciti-invio.test.ts` | **Modifica** 4-35 (stato finto), 54-107 (database finto con contenimento e annullamento), 127-145 (`beforeEach`), in fondo (casi nuovi) | Letto 1-629 |
| `__tests__/api/solleciti-causale-codice.test.ts` | **Modifica** 134 | Il finto impara `.contains` |
| `src/app/api/pagamenti/solleciti/run/route.ts` | **Modifica** 212-239 | Il battito con `fallite`, `email_inviate`, `email_tentate`, e `ok-parziale` a `warn`. Letto 1-246 |
| `src/lib/storici/adattatori/servizi-contabilita.ts` | **Modifica** dopo 16 e 133-137 | Colonna «Recapitato» nello storico dei solleciti |
| `__tests__/lib/storici-servizi.test.ts` | **Modifica** prima di 526 | Un caso |
| `src/lib/translate/claude.ts` | **Riscrive** (69 righe) | Tetto, un ritentativo, `fetchOsservato` su `externalFetch` |
| `__tests__/lib/translate-claude-fornitore.test.ts` | **Crea** | Lo SDK vero con un `fetch` finto |
| `__tests__/architecture/provider-esterni-osservati.test.ts` | **Modifica** dopo 109 | `anthropic` fra i provider osservati |
| `src/app/api/news/cron/run/route.ts` | **Modifica** 13 e 294 | `segretoCronValido` |
| `__tests__/lib/segreto-cron-tempo-costante.test.ts` | **Modifica** 85-92 | Il debito dichiarato si svuota |
| `__tests__/architecture/cron-max-duration.test.ts` | **Modifica** per contenuto: l'`import` da `node:fs` (riga 2 del 20/10), la fine del commento di testa (5-19), `function violazione(sorgente: string)` (49-58), in fondo dopo l'ultimo blocco | `ROUTE_LUNGHE`, `IMPORT_PESANTE`. Letto 1-87 il 20/10; la sessione 8 lo allarga prima (due `import` dopo la riga 3, `CHIAMANTI_CRON` in fondo) senza toccare queste righe |
| Le venti route lunghe (elenco nel Compito 11) | **Modifica** dopo l'ultimo import | `// <perché>` + `export const maxDuration = N` |
| `PRD REGISTRO ELETTRONICO.md` | **Modifica** in cima (prima della riga 1) | Changelog datato |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | **Modifica** la riga della sessione 9 della tabella di stato (la 33 il 20/10; si trova per contenuto, col `grep -n` del Compito 12, Passo 2, mai col numero), e nel primo commit la riga della sessione chiusa | Tabella di stato: «in revisione» per la propria (Compito 12), «in produzione» per la precedente (Compito 1) |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` e le altre fotografie che nomina il piano chiuso, `__tests__/architecture/soglia-fotografia.ts` (costante `MIGRAZIONI_ATTESE_AL_MERGE`, cercata per nome) | **Modifica**, nel primo commit, quello che la sezione «Per la sessione dopo» della sessione rilasciata per ultima elenca (chiusura della precedente) | Compito 1, Passo 4. Questa sessione non ha migrazioni: dopo di lei non resta niente da fotografare |
| `src/lib/logging/external.ts` | Sola lettura: `OpzioniEsterne` (`gravita`, segnale del chiamante che vince sul tetto), `EsitoEsterno` (`retryAfter`, `codice: 'timeout'`), `tettoMs('resend')` = 10.000 | 60-200, 300-370 |
| `src/lib/push/native-push.ts` | Sola lettura: il modello dei ritentativi (1 s, 3 s, `erroreFcm`) | 440-498 |
| `src/lib/health/controlli.ts` | Sola lettura: `ESITI_BATTITO` comprende `ok-parziale`; il battito si legge a `info` **e** `warn`. Lo cambiano le sessioni 6, 7 e 8: si cerca per nome (`ESITI_BATTITO`), non per riga | 742-860 del 20/10 |
| `src/lib/health/fornitori.ts` | Sola lettura (lo crea la sessione 7): `contaEsitiFornitore` conta come rifiuti le sole righe `error` e ignora le `warn`; è la regola del controllo `email` (Compito 1, Passo 6) | la funzione, per nome |
| `src/app/api/pagamenti/solleciti/route.ts` | **Non cambia.** Il POST manuale passa `automatico: false` (righe 69-75): niente ritentativi dal bottone | 25-90 |

---

## Passo 0 — misura prima

Tutto in **sola lettura**: strumento MCP `execute_sql` sul progetto di produzione, solo `SELECT`; lo strumento Vercel `get_project` solo in lettura. Di quello che si legge qui, in chat e nel PRD vanno **solo numeri, date, uuid e codici**: mai un indirizzo, mai un nome. I numeri finiscono nel file delle misure `${TMPDIR:-/tmp}/s09-misure.env` (fuori dal repository, una riga `CHIAVE=valore` per numero) e da lì nel PRD (Compito 12).

### Compito 1 — Prerequisiti, worktree, ramo, chiusura della sessione rilasciata per ultima e gate di partenza

**File** (solo quelli che nomina la sezione «Per la sessione dopo» della sessione rilasciata per ultima, Passo 4):
- Modifica: `__tests__/fixtures/migrazioni-applicate-snapshot.json` e le altre fotografie di `__tests__/fixtures/` che quella sezione nomina
- Modifica: `__tests__/architecture/soglia-fotografia.ts` (costante `MIGRAZIONI_ATTESE_AL_MERGE`) e ogni altro lock che quella sezione nomina
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga di stato di quella sessione) e `PRD REGISTRO ELETTRONICO.md` (lo Stato della sua voce, i suoi numeri «dopo»)

- [ ] **Passo 1: i prerequisiti — colonna «Dopo» della riga 9: la sessione 7**

Si verificano due fatti (PR mergiata, migrazioni applicate), **mai** il testo dello «Stato» della tabella, che lo chiude la sessione successiva. La PR:

```bash
git -C /Users/lerri/kidville-web fetch origin
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s07-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: una riga, `<numero> <data del merge>`. Poi le migrazioni che quella PR ha portato (il piano della 7 ne ha una, `*_salute_rpc_sola_lettura.sql`; fa fede l'elenco dei file della PR):

```bash
n=$(gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s07-" --json number,headRefName --jq '[.[] | select(.headRefName | endswith("-esito") | not)][0].number')
echo "s07 #$n"
gh pr view "$n" --repo erricoluigi17/kidville-web --json files --jq '.files[].path | select(startswith("supabase/migrations/")) | ltrimstr("supabase/migrations/")'
```

Atteso: il numero della PR e almeno un file il cui nome comincia con quattordici cifre (la version). Con lo strumento MCP `execute_sql`, **sola lettura**, mettendo nella lista le version stampate:

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE version IN ('<version del file della 7>')
 ORDER BY version;
```

Atteso: una riga per ogni file stampato sopra, con la stessa version. Se la PR della 7 non ha file in `supabase/migrations/`, questa `SELECT` si salta. Infine nessuna PR della serie aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: nessuna riga. Se un controllo fallisce (la PR non mergiata, una version assente dal registro, una PR della serie aperta), **fermati**: la riga 9 vuole la 7 in produzione (§1, colonna «Dopo»), e la §5 vuole una sessione alla volta. La 9 non dipende dalla 8: quale sessione sia uscita per ultima lo dice il Passo 4, non questo.

- [ ] **Passo 2: worktree e ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s09-email-e-fornitori /Users/lerri/kidville-web-s09-email-e-fornitori origin/main
cd /Users/lerri/kidville-web-s09-email-e-fornitori && git status -sb | head -3
```

Atteso: `## robustezza2/s09-email-e-fornitori...origin/main`, albero pulito. Da qui in poi **ogni** comando gira in `/Users/lerri/kidville-web-s09-email-e-fornitori`; mai nel checkout principale, dove lavorano altre sessioni.

- [ ] **Passo 3: `.env.local` e dipendenze**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s09-email-e-fornitori/.env.local
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 4: la chiusura della sessione rilasciata per ultima (§5, la «PR-B»)**

Si chiude la sessione `robustezza2/` mergiata più di recente, **qualunque numero abbia** (la 9 dipende solo dalla 7: può essere la 7, la 8 o un'altra; non si presume):

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga `<numero> robustezza2/sNN-<nome>`. Il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-sNN-<nome>.md` (il nome del ramo senza `robustezza2/`). Se la sua riga di stato su `origin/main` dice già «in produzione» (`git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep "^| NN |"`, con il numero della sessione senza lo zero davanti), la chiusura l'ha già fatta un ramo `-esito`: salta al Passo 5.

Altrimenti apri quel piano con `Read`, vai alla sua sezione finale «Per la sessione dopo» (subito prima di «Autorevisione») e fai **tutto** quello che elenca, nell'ordine in cui lo elenca: fotografie rigenerate dalla produzione, voci tolte da `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste, riga di stato a «in produzione» col commit di `main`, Stato della sua voce nel PRD, misure «dopo» già mature (le altre restano lì, con la loro data), le cose condizionali solo alle condizioni che scrive. Non si indovina e non si aggiunge niente che quella sezione non dica.

La fotografia delle migrazioni si rigenera **sempre** quando quella sessione aveva migrazioni (`gh pr view <numero> --repo erricoluigi17/kidville-web --json files --jq '.files[].path | select(startswith("supabase/migrations/"))'` ne stampa almeno una). I comandi completi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa con `execute_sql` (sola lettura), salva la risposta JSON, così com'è, in `${TMPDIR:-/tmp}/s09-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/s09-migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  2 passed` dopo che hai tolto da `MIGRAZIONI_ATTESE_AL_MERGE` le voci che quella sezione nomina (il test «2 · nessuna chiave è già applicata» resta rosso finché ci sono). Le altre fotografie che la sezione nomina (indici unici, policy, chiavi esterne, bucket…) si rigenerano **prima** di togliere le voci: senza, le guardie `toccaUnUnico` e `toccaLaRls` di `soglia-fotografia.ts` segnalano la migrazione come posteriore alla fotografia. Nel commento sopra la costante, sotto il blocco della sessione chiusa, aggiungi la riga `// SVUOTATA il <data UTC> (PR-B dopo il merge di #<numero>, <commit di main>): applicata dall'integrazione; fotografie rigenerate dalla produzione.`, come le voci precedenti; il commit di `main` lo dà `gh pr view <numero> --repo erricoluigi17/kidville-web --json mergeCommit --jq '.mergeCommit.oid[0:8]'`.

- [ ] **Passo 5: le ancore del piano tengono?**

```bash
sed -n 151p src/lib/pagamenti/solleciti-invio.ts | grep -c "from('solleciti').select('pagamento_id, livello')"
sed -n 358p src/lib/pagamenti/solleciti-invio.ts | grep -c "nessun destinatario collegato"
sed -n 420p src/lib/pagamenti/solleciti-invio.ts | grep -c "const giorno = presaIl.slice(0, 10)"
sed -n 485p src/lib/pagamenti/solleciti-invio.ts | grep -c "esiti.push({ pagamento_id: id, ok: true, livello, oggetto, destinatari })"
sed -n 242p src/lib/email/send.ts | grep -c "const esito = await externalFetch("
sed -n 212p src/app/api/pagamenti/solleciti/run/route.ts | grep -c "const esiti = await sollecitaPagamenti"
sed -n 38p src/lib/translate/claude.ts | grep -c "new Anthropic({ apiKey })"
sed -n 294p src/app/api/news/cron/run/route.ts | grep -c "secret !== process.env.CRON_SECRET"
grep -c "segretoCronValido" src/app/api/news/cron/run/route.ts
grep -c "ROUTE_LUNGHE" __tests__/architecture/cron-max-duration.test.ts
grep -c "function violazione(sorgente: string)" __tests__/architecture/cron-max-duration.test.ts
```

Atteso: `1` sulle prime otto righe, `0` sulla nona e sulla decima, `1` sull'ultima. Uno `0` dove si attende `1` vuol dire che il file è cambiato dopo il 20/10 (una sessione rilasciata prima di questa): i compiti sostituiscono per **contenuto**, non per numero di riga, quindi si va avanti cercando il testo citato; la differenza va scritta nella colonna «Note» della riga della sessione 9 (`grep -n "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`). Se la nona riga dà `1` (una sessione precedente ha già portato `news/cron/run` a `segretoCronValido`), il Compito 10 si riduce allo svuotamento del debito, se c'è ancora. Se la decima dà `1`, `ROUTE_LUNGHE` esiste già: nessun piano precedente usa quel nome (quello della sessione 8 lo evita di proposito), quindi è un cambio non previsto: **fermati** e chiedi al titolare prima del Compito 11.

- [ ] **Passo 6: il controllo `email` della sessione 7 conta solo le righe `error`?**

La regola del controllo `email` **non** sta in `src/lib/health/controlli.ts`: `controlloEmail` legge le righe da `app_log` e le passa a `contaEsitiFornitore`, in `src/lib/health/fornitori.ts`.

```bash
grep -n "export function contaEsitiFornitore\|export const SOGLIA_RIFIUTI_FORNITORE\|export function fornitoreInAffanno" src/lib/health/fornitori.ts
grep -n "contaEsitiFornitore" src/lib/health/controlli.ts | head -5
```

Atteso: le tre definizioni in `fornitori.ts`; in `controlli.ts` almeno l'import e una chiamata. Leggi con `Read` la funzione `contaEsitiFornitore` (una ventina di righe). Nella forma che il piano della sessione 7 le dà, conta come **rifiuti** le sole righe a livello `error`, come **riusciti** le righe `info` con uno stato 2xx, e **ignora** le righe `warn`; `fornitoreInAffanno` dà `degradato` solo con rifiuti ≥ `SOGLIA_RIFIUTI_FORNITORE` (3) **e** più rifiuti che riusciti.

Da questa sessione, nel giro automatico, ogni tentativo ritentabile di Resend lascia una riga `email` a livello `warn` (con `campi.tentativo`), anche quando il tentativo dopo riesce, e la chiusura dei ritentativi fermati è **sempre** `error` (Compito 4, 429 compreso). Con quella regola le righe `warn` dei tentativi non spostano il controllo e ogni email che non parte conta un rifiuto: **la soglia è soddisfatta, vai avanti** senza toccare niente. **Soglia per fermarsi:** solo se la funzione che leggi conta le righe `warn`, o tutte le righe con uno stato diverso da 2xx, il controllo diventerebbe `degradato` per email arrivate al secondo tentativo: in quel caso scrivi il caso nella colonna «Note» della riga della sessione 9 e chiedi al titolare se il controllo debba contare le sole righe `error`.

- [ ] **Passo 7: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
```

Atteso: tutti i file verdi tranne, al massimo, `offline-html-nativo` al primo giro (in un worktree nuovo la shell nativa non è sincronizzata); col secondo comando `1 passed`; la build termina con l'elenco delle route. Se è rosso un altro lock di fotografia (`onconflict-arbitro`, `fk-scuola-id`, `rls-per-sede`, …), rigenera quella fotografia con il generatore che il suo messaggio d'errore nomina, sempre dalla produzione, e mettila nel commit del Passo 8. Leggi la riga `Test Files`, non il codice d'uscita di una pipe.

- [ ] **Passo 8: commit (il primo della sessione: la chiusura della precedente)**

```bash
git add __tests__/fixtures/ __tests__/architecture/ "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git status --short
```

Atteso: solo file in stage (prima colonna `M` o `A`), tutti nominati dalla sezione «Per la sessione dopo» del Passo 4 o rigenerati al Passo 7: le fotografie di `__tests__/fixtures/`, `__tests__/architecture/soglia-fotografia.ts` e i lock che quella sezione nomina, la specifica, il PRD. Se quella sezione ha chiesto di cambiare un file fuori da queste cartelle (per esempio `src/lib/health/controlli.ts`, per portare un job da `JOB_CRON_NON_SORVEGLIATI` a `JOB_CRON`), aggiungilo per nome con `git add <percorso>`. Se il Passo 4 è stato saltato e non c'è niente in stage, non si fa nessun commit: si passa al Compito 2.

```bash
git commit -m "$(cat <<'EOF'
Chiusura della sessione rilasciata per ultima (PR-B): fotografie e stato

Apre la sessione 9 della seconda serie di robustezza: esegue la sezione «Per la
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

**File:** nessuno nel repository. Il file delle misure è `${TMPDIR:-/tmp}/s09-misure.env`.

- [ ] **Passo 1: il conteggio delle domande d'iscrizione (§5, `CLAUDE.md`)**

```sql
SELECT now() AT TIME ZONE 'UTC' AS misurato_alle, count(*) AS iscrizioni FROM enrollment_submissions;
```

Scrivi `ISCRIZIONI=` e `ISCRIZIONI_ALLE=` (la data e l'ora UTC lette). Non si copia da nessun documento: si conta.

- [ ] **Passo 2: i tipi delle due colonne su cui il piano scommette**

```sql
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND ((table_name = 'solleciti' AND column_name = 'destinatari')
     OR (table_name = 'pagamenti' AND column_name = 'ultimo_sollecito_il'))
 ORDER BY 1;
```

Atteso: `pagamenti.ultimo_sollecito_il` = `timestamp with time zone`, `solleciti.destinatari` = `jsonb` (come nei file `20260704120000_baseline.sql:2173` e `20260710140000_contabilita_solleciti.sql:21`). **Soglia:** se `destinatari` non è `jsonb`, il filtro `.contains` del Compito 5 risponde `42883` e i livelli ripartirebbero da 1: **fermati**. Se la cadenza non è `timestamptz`, l'annullamento condizionato non distingue due prese dello stesso giorno: **fermati** e scrivilo nella colonna «Note» della riga della sessione 9 (`grep -n "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`).

- [ ] **Passo 3: quando gira il giro automatico**

```sql
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname ILIKE '%sollecit%';
```

Atteso: `pagamenti-solleciti-run`, `0 6 * * *`, attivo (come in migrazione). Scrivi `CRON_SOLLECITI=` con lo schedule. La misura «dopo» del Rilascio si fa dopo la prima accensione successiva al merge, cioè alle 06:00 UTC se lo schedule è quello.

- [ ] **Passo 4: il registro dei solleciti, da sempre**

```sql
SELECT count(*) AS righe,
       count(*) FILTER (WHERE jsonb_typeof(destinatari) <> 'array') AS non_array,
       count(*) FILTER (WHERE CASE WHEN jsonb_typeof(destinatari) = 'array'
                                   THEN EXISTS (SELECT 1 FROM jsonb_array_elements(destinatari) e
                                                 WHERE jsonb_typeof(e) <> 'object' OR NOT (e ? 'inviata'))
                                   ELSE false END) AS senza_inviata,
       count(*) FILTER (WHERE destinatari @> '[{"inviata":true}]') AS recapitate,
       count(*) FILTER (WHERE jsonb_typeof(destinatari) = 'array'
                          AND NOT destinatari @> '[{"inviata":true}]') AS non_recapitate,
       count(*) FILTER (WHERE automatico) AS automatiche,
       min(inviato_il) AS prima, max(inviato_il) AS ultima
  FROM solleciti;
```

Scrivi `REGISTRO_RIGHE=`, `REGISTRO_NON_ARRAY=`, `REGISTRO_SENZA_INVIATA=`, `REGISTRO_RECAPITATE=`, `REGISTRO_NON_RECAPITATE=`. **Soglia:** se `non_array + senza_inviata > 0`, il filtro dei livelli (Compito 5) tratterebbe quelle righe come «mai recapitate» e rimanderebbe un livello già arrivato: **fermati** e chiedi al titolare (sono righe scritte prima della forma `{ id, email, inviata }`).

- [ ] **Passo 5: le voci con la cadenza avanzata e nessun destinatario raggiunto (la misura della specifica)**

```sql
WITH ultimo_giro AS (
  SELECT date_trunc('day', max(inviato_il)) AS giorno FROM solleciti WHERE automatico
)
SELECT u.giorno AS giorno_ultimo_giro,
       count(s.id) AS righe_del_giro,
       count(s.id) FILTER (WHERE NOT s.destinatari @> '[{"inviata":true}]') AS senza_recapito
  FROM ultimo_giro u
  LEFT JOIN solleciti s
    ON s.automatico AND s.inviato_il >= u.giorno AND s.inviato_il < u.giorno + interval '1 day'
 GROUP BY u.giorno;

SELECT count(*) FILTER (WHERE NOT ult.destinatari @> '[{"inviata":true}]') AS aperte_ultimo_non_recapitato,
       count(*) AS aperte_sollecitate
  FROM pagamenti p
  JOIN LATERAL (SELECT s.destinatari FROM solleciti s
                 WHERE s.pagamento_id = p.id ORDER BY s.inviato_il DESC LIMIT 1) ult ON true
 WHERE p.stato IN ('da_pagare', 'parziale', 'scaduto')
   AND p.ultimo_sollecito_il IS NOT NULL;

SELECT count(*) AS prese_senza_registro
  FROM pagamenti p
 WHERE p.ultimo_sollecito_il >= now() - interval '30 days'
   AND NOT EXISTS (SELECT 1 FROM solleciti s
                    WHERE s.pagamento_id = p.id AND s.inviato_il >= p.ultimo_sollecito_il);
```

Scrivi `ULTIMO_GIRO=` (il giorno), `ULTIMO_GIRO_RIGHE=`, `ULTIMO_GIRO_SENZA_RECAPITO=`, `VOCI_SENZA_RECAPITO=` (la prima colonna della seconda query), `PRESE_SENZA_REGISTRO=`. È la misura che la specifica chiede: voci la cui cadenza è avanzata mentre la famiglia non ha ricevuto niente. Le «prese senza registro» sono i giri morti fra la presa e il registro (il prezzo della fase 8): servono a leggere la misura «dopo», non sono un difetto di questa sessione.

- [ ] **Passo 6: quante voci aperte cambieranno livello col filtro dei livelli recapitati**

```sql
WITH livelli AS (
  SELECT pagamento_id,
         max(livello) AS registrato,
         coalesce(max(livello) FILTER (WHERE destinatari @> '[{"inviata":true}]'), 0) AS recapitato
    FROM solleciti
   GROUP BY pagamento_id
)
SELECT count(*) FILTER (WHERE l.registrato > l.recapitato) AS livello_scende,
       count(*) FILTER (WHERE l.registrato > l.recapitato
                          AND p.stato IN ('da_pagare', 'parziale', 'scaduto')) AS livello_scende_aperte
  FROM livelli l
  JOIN pagamenti p ON p.id = l.pagamento_id;
```

Scrivi `LIVELLO_SCENDE=` e `LIVELLO_SCENDE_APERTE=`. Sono le voci in cui un livello è stato registrato senza che nessuna email partisse: dal deploy il prossimo sollecito sarà **quel** livello, di nuovo, e non il successivo. **Soglia:** se `livello_scende_aperte > 50`, dillo al titolare prima di aprire la PR, col numero: è un cambiamento che le famiglie vedono.

- [ ] **Passo 7: gli esiti di Resend negli ultimi 7 giorni**

```sql
SELECT giorno, livello,
       contesto->'campi'->>'esito' AS esito,
       contesto->'campi'->>'stato' AS stato_http,
       codice,
       sum(occorrenze) AS n
  FROM app_log
 WHERE evento = 'email'
   AND giorno >= (now() AT TIME ZONE 'UTC')::date - 7
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY 1, 2, 3, 4, 5;

SELECT coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi'->>'provider' = 'resend' AND livello = 'info'), 0) AS accettate,
       coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi'->>'provider' = 'resend' AND livello <> 'info'), 0) AS rifiutate,
       coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi'->>'provider' = 'resend' AND contesto->'campi'->>'stato' = '429'), 0) AS per_quota
  FROM app_log
 WHERE evento = 'email'
   AND giorno >= (now() AT TIME ZONE 'UTC')::date - 7;
```

Scrivi `EMAIL_7G_OK=`, `EMAIL_7G_KO=`, `EMAIL_7G_429=`, e annota nel file le combinazioni `stato_http`/`codice` con `n > 0` (per esempio `500:3`, `0/timeout:1`). Sono la riga «prima» dei ritentativi: dicono quanti rifiuti erano ritentabili.

- [ ] **Passo 8: la durata dei giri negli ultimi 14 giorni**

```sql
SELECT visto_l_ultima, livello,
       contesto->'campi'->>'esito'     AS esito,
       contesto->'campi'->>'ms'        AS ms,
       contesto->'campi'->>'esaminati' AS esaminati,
       contesto->'campi'->>'inviati'   AS inviati,
       contesto->'campi'->>'rinviati'  AS rinviati
  FROM app_log
 WHERE evento = 'cron'
   AND contesto->'campi'->>'operazione' = 'pagamenti-solleciti'
   AND giorno >= (now() AT TIME ZONE 'UTC')::date - 14
 ORDER BY visto_l_ultima DESC;
```

Scrivi `DURATA_GIRO_MAX_MS=` (il massimo di `ms`). **Soglia:** se supera 200.000, scrivilo nel PRD: i ritentativi aggiungono al più 4 s di attese per destinatario prima del tetto, e un giro già vicino ai 240 s ne rinvierà di più al giorno dopo.

- [ ] **Passo 9: quanti destinatari per sollecito (il margine dei 60 s)**

```sql
SELECT jsonb_array_length(destinatari) AS destinatari, count(*) AS righe
  FROM solleciti
 WHERE jsonb_typeof(destinatari) = 'array'
 GROUP BY 1
 ORDER BY 1;
```

Scrivi `MAX_DESTINATARI=`. **Soglia:** oltre il tetto del giro i ritentativi non partono più, ma ogni destinatario della voce in corso costa ancora fino a 10 s (il tetto di `externalFetch` per Resend): con più di **5** destinatari i 60 s fra il tetto (240 s) e la vita della Function (300 s) non bastano più nel caso peggiore. Se `MAX_DESTINATARI > 5`, **fermati** e chiedi al titolare.

- [ ] **Passo 10: i solleciti senza nessun indirizzo**

```sql
SELECT count(*) AS senza_alcun_indirizzo,
       count(*) FILTER (WHERE inviato_il >= now() - interval '90 days') AS ultimi_90_giorni
  FROM solleciti
 WHERE jsonb_typeof(destinatari) = 'array'
   AND NOT jsonb_path_exists(destinatari, '$[*] ? (@.email != null && @.email != "")');
```

Scrivi `SENZA_INDIRIZZO=` e `SENZA_INDIRIZZO_90G=`.

**Soglia, e decisione del titolare** (§7, sessione 9: «Il Passo 0 conta i casi di oggi; decide il titolare»). Se `ultimi_90_giorni > 0`, **fermati qui e chiedi al titolare prima del Compito 6**. Mostragli il numero (`SENZA_INDIRIZZO_90G`, solo il numero) e i due comportamenti:
- **oggi:** una voce i cui genitori collegati non hanno nessun indirizzo email prende la cadenza, riceve **la sola notifica push** e finisce nel registro come sollecitata, e il livello sale anche se nessuna email è partita;
- **dopo questa sessione:** la stessa voce **non riceve niente**, né email né push; la cadenza non si muove, il registro non si scrive, e in `app_log` resta una riga `warn` `nessun-indirizzo-email`. Finché la segreteria non aggiunge un indirizzo, quella famiglia non riceve solleciti.

La domanda, in una riga: «Per le famiglie senza nessun indirizzo email, il sollecito smette del tutto (comportamento nuovo) o continua ad arrivare la sola push?». Scrivi la risposta, con la data UTC e il numero, nel file delle misure (`DECISIONE_SENZA_INDIRIZZO=si` per il comportamento nuovo, `=no` per la sola push) e nella colonna «Note» della riga della sessione 9 della specifica (`grep -n "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`; la riga si scrive nel commit del Compito 12, Passo 2, che riporta la nota). Se `ultimi_90_giorni = 0`, scrivi `DECISIONE_SENZA_INDIRIZZO=non-serve` e vai avanti: oggi il comportamento nuovo non tocca nessuno, e il numero si porta al titolare al merge (Compito 13, Passo 5).

Il piano è scritto per il **sì**. Con un **no** cambiano solo questi passi, e nient'altro:
- **Compito 6, Passo 1:** il caso «nessun destinatario con un indirizzo ⇒ niente presa, niente email, niente push, niente registro; una riga `warn`» si riscrive così: `h.sequenza` = `['presa']`; `h.sendEmailDetailed` mai chiamato; `h.enqueueNotifiche` chiamato una volta; `registro()` di lunghezza 1, con tutti i destinatari a `inviata: false`; esito `toMatchObject({ ok: true, inviate: 0, tentate: 0, motivo: 'nessun indirizzo email: solo la notifica push' })`; una riga `warn` con `esito: 'solo-push-senza-indirizzo'` e `n_destinatari: 1`; nessuna riga `nessun-indirizzo-email`;
- **Compito 6, Passo 4:** la sostituzione si salta (il blocco `if (!destinatari.some((d) => !!d.email)) { … continue }` non si aggiunge);
- **Compito 6, Passo 5:** nel blocco nuovo la condizione `if (inviate === 0) {` diventa `if (inviate === 0 && tentate > 0) {`; subito prima di `        try {` che precede `await enqueueNotifiche(supabase, {` si aggiunge `if (tentate === 0) logEvento('pagamento', 'warn', { operazione: 'solleciti-invio', esito: 'solo-push-senza-indirizzo', pagamento_id: id, livello_sollecito: livello, n_destinatari: destinatari.length, msg: 'nessun destinatario ha un indirizzo email: parte la sola notifica push' })`; e l'ultimo `esiti.push({ pagamento_id: id, ok: true, livello, oggetto, destinatari, inviate, tentate })` aggiunge `...(tentate === 0 ? { motivo: 'nessun indirizzo email: solo la notifica push' } : {})`;
- **Log:** la riga `nessun-indirizzo-email` della tabella diventa `solo-push-senza-indirizzo` (`pagamento` · `warn`, «nessun destinatario con un indirizzo: parte la sola push»);
- **PRD (Compito 12):** il punto «Solleciti» dice che le voci senza indirizzo continuano a ricevere la sola push, senza salire di livello.

Va detto al titolare, insieme alla domanda, anche l'effetto del Compito 5 su questo caso: col filtro dei livelli recapitati una voce raggiunta solo dalla push **non sale più di livello**, e riceve la stessa push a ogni cadenza finché non ha un indirizzo.

- [ ] **Passo 11: la traduzione negli ultimi 30 giorni**

```sql
SELECT giorno, livello,
       contesto->'campi'->>'esito' AS esito,
       codice,
       sum(occorrenze) AS n
  FROM app_log
 WHERE evento = 'traduzione'
   AND giorno >= (now() AT TIME ZONE 'UTC')::date - 30
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 2, 3, 4;
```

Scrivi `TRADUZIONI_30G_KO=` (la somma delle righe `traduzione-fallita`). I successi non ci sono e non ci saranno: `traduzione` non è in `EVENTI_PERSISTITI`, quindi in tabella finiscono solo `warn` ed `error`.

- [ ] **Passo 12: la vita di default delle Function**

Con lo strumento Vercel `get_project` (sola lettura) sul progetto dell'app (se l'id non è a portata, `list_projects` per trovarlo), leggi `resourceConfig.functionDefaultTimeout` e `resourceConfig.fluid`. Scrivi `DEFAULT_TIMEOUT_S=` e `FLUID=`.

Atteso: 300 s con Fluid. Il Compito 11 scrive `maxDuration = 300` su diciannove route proprio perché è il default di oggi: lo rende esplicito, non lo allunga. **Soglia:** se il default è più basso di 300 o Fluid è spento, quei 300 diventano un allungamento vero (e un costo): **fermati** e chiedi al titolare.

---

## Migrazione

Nessuna: la sessione tocca solo codice e test, e non c'è niente da applicare al merge.

---

## Codice

### Compito 3 — `msDaRetryAfter` in un posto condiviso

**File:**
- Crea: `src/lib/rete/retry-after.ts`
- Test: `__tests__/lib/rete-retry-after.test.ts`

- [ ] **Passo 1: scrivi il test (rosso)**

Crea `__tests__/lib/rete-retry-after.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { msDaRetryAfter } from '@/lib/rete/retry-after'

// Sessione 9 della seconda serie di robustezza. `Retry-After` arriva in due forme (RFC 9110,
// §10.2.3): secondi interi oppure una data HTTP. Lo leggono `send.ts` (Resend) e `claude.ts`
// (Anthropic). L'istante è passato a mano: nessun orologio vero nel test.
const ADESSO = Date.parse('2026-10-21T06:00:00Z')

describe('msDaRetryAfter', () => {
  it('secondi interi, anche con spazi intorno', () => {
    expect(msDaRetryAfter('2', ADESSO)).toBe(2_000)
    expect(msDaRetryAfter('0', ADESSO)).toBe(0)
    expect(msDaRetryAfter(' 30 ', ADESSO)).toBe(30_000)
  })

  it('data HTTP: la distanza da adesso, mai negativa', () => {
    expect(msDaRetryAfter('Wed, 21 Oct 2026 06:00:05 GMT', ADESSO)).toBe(5_000)
    expect(msDaRetryAfter('Wed, 21 Oct 2026 05:59:00 GMT', ADESSO)).toBe(0)
  })

  it('assente, vuoto o illeggibile: undefined, e chi chiama usa la propria scaletta', () => {
    expect(msDaRetryAfter(undefined, ADESSO)).toBeUndefined()
    expect(msDaRetryAfter('', ADESSO)).toBeUndefined()
    expect(msDaRetryAfter('presto', ADESSO)).toBeUndefined()
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/rete-retry-after.test.ts 2>&1 | tail -8
```

Atteso: `FAIL`, con `Failed to resolve import "@/lib/rete/retry-after"`.

- [ ] **Passo 3: il codice**

Crea `src/lib/rete/retry-after.ts`:

```ts
/**
 * `Retry-After` in millisecondi (sessione 9 della seconda serie di robustezza).
 *
 * L'header ha due forme (RFC 9110, §10.2.3): un numero di secondi (`120`) oppure una data HTTP
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Una data già passata vale 0, mai un'attesa negativa.
 * Illeggibile, vuoto o assente → `undefined`: chi chiama usa la propria scaletta.
 *
 * Esiste in un posto solo perché lo leggono due fornitori, Resend (`src/lib/email/send.ts`) e
 * Anthropic (`src/lib/translate/claude.ts`). `native-push.ts` ne ha una copia privata più
 * vecchia, con lo stesso comportamento sui secondi interi e sulle date: resta dov'è.
 *
 * `adesso` è un parametro per i test; in produzione è l'orologio.
 */
export function msDaRetryAfter(valore: string | undefined, adesso: number = Date.now()): number | undefined {
  if (valore === undefined) return undefined
  const v = valore.trim()
  if (v === '') return undefined
  if (/^\d+$/.test(v)) return Number(v) * 1_000
  const quando = Date.parse(v)
  return Number.isFinite(quando) ? Math.max(0, quando - adesso) : undefined
}
```

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/rete-retry-after.test.ts 2>&1 | tail -6
```

Atteso: `Tests  3 passed`.

- [ ] **Passo 5: commit**

```bash
git add src/lib/rete/retry-after.ts __tests__/lib/rete-retry-after.test.ts
git commit -m "$(cat <<'EOF'
Retry-After letto in un posto solo (sessione 9)

msDaRetryAfter: secondi interi o data HTTP, mai negativo, illeggibile = undefined.
La usano Resend e Anthropic nei compiti successivi.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — I ritentativi di `sendEmailDetailed`

**File:**
- Modifica: `src/lib/email/send.ts:1-3`, `:110-111`, `:145-146`, `:169-170`, `:214`, `:242-287`, `:315`, `:318-321`, `:327-342`, `:344-356`, `:367-370`, dopo `:394`
- Test: `__tests__/lib/email-send-ritentativi.test.ts`

- [ ] **Passo 1: scrivi il test (rosso)**

Crea `__tests__/lib/email-send-ritentativi.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * SESSIONE 9 (seconda serie di robustezza) — i ritentativi di `sendEmailDetailed`.
 *
 * Le regole, una per caso:
 *  · senza `ritentativi` niente cambia: una chiamata, l'esito di sempre, nessuna chiave nuova;
 *  · con `ritentativi`: al massimo 3 chiamate, attese 1 s e 3 s (o il `Retry-After`, se è più
 *    lungo e non supera 10 s), la STESSA chiave d'idempotenza a ogni tentativo;
 *  · `429` si ritenta sempre; `5xx` e rete giù / scadenza SOLO con la chiave (senza, un
 *    ritentativo sarebbe un doppione alla famiglia); un `4xx` definitivo mai;
 *  · un ritentativo che finirebbe oltre la `scadenza` del giro non parte;
 *  · la riga che chiude i ritentativi porta il corpo del provider SANIFICATO.
 *
 * Resend finto su `globalThis.fetch` (come `email-send-quota.test.ts`), orologio finto solo su
 * `setTimeout`: nessuna attesa vera. Indirizzi solo su `example.test`.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import { sendEmailDetailed } from '@/lib/email/send'

type Risposta = Response | 'rete-giu' | 'scaduto'

/** Resend finto: risponde in ordine con `risposte` (l'ultima si ripete) e annota le chiavi. */
function resendFinto(risposte: Array<() => Risposta>): (string | undefined)[] {
  const chiavi: (string | undefined)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      chiavi.push((init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'])
      const r = (risposte[chiavi.length - 1] ?? risposte[risposte.length - 1])()
      if (r === 'rete-giu') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
      if (r === 'scaduto') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      return r
    }),
  )
  return chiavi
}

const ok200 = (): Risposta => new Response(JSON.stringify({ id: 'msg-finto-1' }), { status: 200 })
const rifiuto = (status: number, corpo: Record<string, unknown>, headers?: Record<string, string>) => (): Risposta =>
  new Response(JSON.stringify(corpo), { status, headers })
const reteGiu = (): Risposta => 'rete-giu'
const scaduto = (): Risposta => 'scaduto'

async function finché(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('condizione mai verificata')
}

const params = { to: 'genitore.uno@example.test', subject: 'Promemoria', text: 'corpo' }
/** Una chiave come quella dei solleciti: solo uuid, livello e data. */
const CHIAVE = 'sollecito:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1:L1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2:2026-10-21'

const righe = (esito: string) =>
  log.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
/** Le righe che `externalFetch` scrive per ogni tentativo: [livello, tentativo]. */
const tentativi = () =>
  log.logEvento.mock.calls
    .filter((c) => c[0] === 'email' && (c[2] as { provider?: string }).provider === 'resend'
      && (c[2] as { tentativo?: number }).tentativo !== undefined)
    .map((c) => [c[1], (c[2] as { tentativo: number }).tentativo])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubEnv('RESEND_API_KEY', 'chiave-finta')
  log.logEvento.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('sendEmailDetailed — senza `ritentativi` niente cambia', () => {
  it('503: una chiamata, l’esito di sempre (nessuna chiave nuova), riga `error` senza `tentativo`', async () => {
    const chiavi = resendFinto([rifiuto(503, { name: 'application_error', message: 'Servizio non disponibile' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toEqual({ ok: false, error: 'rifiutato dal provider email (503): Servizio non disponibile' })
    expect(chiavi).toHaveLength(1)
    const riga = log.logEvento.mock.calls.filter((c) => c[0] === 'email' && (c[2] as { provider?: string }).provider === 'resend')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect((riga[0][2] as { tentativo?: number }).tentativo).toBeUndefined()
  })

  it('una chiamata SCADUTA senza risposta è `incerto`: Resend potrebbe averla presa', async () => {
    resendFinto([scaduto])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false, incerto: true })
    expect(r.tentativi).toBeUndefined()
  })
})

describe('sendEmailDetailed — con `ritentativi`', () => {
  it('500 poi 200, con la chiave: un ritentativo dopo 1 s ESATTO, con la STESSA chiave', async () => {
    const chiavi = resendFinto([rifiuto(500, { name: 'internal_server_error', message: 'errore temporaneo' }), ok200])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(999)
    expect(chiavi).toHaveLength(1) // non prima di 1 s
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => chiavi.length === 2)

    expect(await p).toEqual({ ok: true, error: null, messageId: 'msg-finto-1', tentativi: 2 })
    expect(chiavi).toEqual([CHIAVE, CHIAVE])
    expect(tentativi()).toEqual([['warn', 1], ['info', 2]])
    const riuscita = righe('riuscita-dopo-ritentativo')
    expect(riuscita).toHaveLength(1)
    expect(riuscita[0][1]).toBe('info')
  })

  it('429 con `Retry-After: 2`, anche senza chiave: aspetta 2 s, non 1', async () => {
    const chiavi = resendFinto([rifiuto(429, { name: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '2' }), ok200])
    const p = sendEmailDetailed({ ...params, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(chiavi).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => chiavi.length === 2)

    expect(await p).toMatchObject({ ok: true, tentativi: 2 })
    expect(chiavi).toEqual([undefined, undefined])
  })

  it('500 tre volte: 1 s, 3 s, poi basta — riga `error` con il corpo SANIFICATO e il codice', async () => {
    const chiavi = resendFinto([rifiuto(500, { name: 'internal_server_error', message: 'Errore temporaneo per genitore.uno@example.test' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(chiavi).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => chiavi.length === 3)

    const r = await p
    expect(r).toMatchObject({ ok: false, tentativi: 3 })
    expect(r.incerto).toBeUndefined()
    expect(chiavi).toEqual([CHIAVE, CHIAVE, CHIAVE])
    expect(tentativi()).toEqual([['warn', 1], ['warn', 2], ['warn', 3]])
    const fine = righe('ritentativi-esauriti')
    expect(fine).toHaveLength(1)
    expect(fine[0][0]).toBe('email')
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ operazione: 'sendEmail', provider: 'resend', stato: 500, tentativi: 3 })
    const err = fine[0][3] as Error & { code?: string }
    expect(err.name).toBe('ResendRitentativiFermati')
    expect(err.code).toBe('500')
    expect(err.message).toContain('[email]')
    expect(err.message).not.toContain('example.test')
  })

  it('rete giù poi 200, con la chiave: si ritenta e riesce', async () => {
    const chiavi = resendFinto([reteGiu, ok200])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2)
    expect(await p).toMatchObject({ ok: true, tentativi: 2 })
  })

  it('SENZA chiave, rete giù o 500 non si ritentano: un doppione costa più di un giorno di ritardo', async () => {
    let chiavi = resendFinto([reteGiu])
    expect(await sendEmailDetailed({ ...params, ritentativi: {} })).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    chiavi = resendFinto([rifiuto(500, { message: 'errore' })])
    expect(await sendEmailDetailed({ ...params, ritentativi: {} })).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
  })

  it('422 (definitivo): una chiamata sola, riga `error`', async () => {
    const chiavi = resendFinto([rifiuto(422, { name: 'validation_error', message: 'Invalid `to` field' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    expect(r).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    expect(tentativi()).toEqual([['error', 1]])
  })

  it('429 con `Retry-After: 60` (oltre 10 s): non si aspetta, rinviabile; il tentativo `warn`, la chiusura `error` col codice 429', async () => {
    const chiavi = resendFinto([rifiuto(429, { message: 'Too many requests' }, { 'retry-after': '60' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    expect(r).toMatchObject({ ok: false, rinviabile: true, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    expect(tentativi()).toEqual([['warn', 1]])
    const fine = righe('retry-after-oltre-il-tetto')
    expect(fine).toHaveLength(1)
    // L'email non partirà in questo giro: è un fallimento, e deve arrivare alla salute
    // (`contaEsitiFornitore` conta le sole righe `error`), anche se la causa è la quota.
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ stato: 429, tentativi: 1, attesa_ms: 60_000 })
    expect((fine[0][3] as { code?: string }).code).toBe('429')
    // La riga di chiusura dice già tutto: niente `quota-esaurita` in più.
    expect(righe('quota-esaurita')).toHaveLength(0)
  })

  it('429 tre volte (`Retry-After: 2`): 2 s, 3 s, poi basta — tentativi `warn`, chiusura `error` col codice 429, rinviabile', async () => {
    const chiavi = resendFinto([rifiuto(429, { name: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '2' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(2_000) // il Retry-After (2 s) vince sulla scaletta (1 s)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000) // la scaletta (3 s) vince sul Retry-After (2 s)
    await finché(() => chiavi.length === 3)

    const r = await p
    expect(r).toMatchObject({ ok: false, rinviabile: true, tentativi: 3 })
    expect(r.incerto).toBeUndefined()
    expect(chiavi).toEqual([CHIAVE, CHIAVE, CHIAVE])
    expect(tentativi()).toEqual([['warn', 1], ['warn', 2], ['warn', 3]])
    const fine = righe('ritentativi-esauriti')
    expect(fine).toHaveLength(1)
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ operazione: 'sendEmail', provider: 'resend', stato: 429, tentativi: 3 })
    const err = fine[0][3] as Error & { code?: string }
    expect(err.name).toBe('ResendRitentativiFermati')
    expect(err.code).toBe('429')
    expect(righe('quota-esaurita')).toHaveLength(0)
  })

  it('il ritentativo che finirebbe oltre la scadenza del giro non parte', async () => {
    const chiavi = resendFinto([rifiuto(500, { message: 'errore' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: { scadenza: Date.now() + 5_000 } })
    expect(r).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    const fine = righe('ritentativo-oltre-la-scadenza')
    expect(fine).toHaveLength(1)
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ stato: 500, tentativi: 1, attesa_ms: 1_000 })
  })

  it('409 concorrente: nessun ritentativo, rinviabile e INCERTO', async () => {
    const chiavi = resendFinto([rifiuto(409, { name: 'concurrent_idempotent_requests', message: 'in corso' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    expect(r).toMatchObject({ ok: false, rinviabile: true, incerto: true, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
  })

  it('tre scadenze di fila: `incerto`, e la riga di chiusura col codice `timeout`', async () => {
    const chiavi = resendFinto([scaduto])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000)
    await finché(() => chiavi.length === 3)
    const r = await p
    expect(r).toMatchObject({ ok: false, incerto: true, tentativi: 3 })
    const fine = righe('ritentativi-esauriti')
    expect(fine).toHaveLength(1)
    expect((fine[0][3] as { code?: string }).code).toBe('timeout')
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/email-send-ritentativi.test.ts 2>&1 | tail -15
```

Atteso: `FAIL`. Il primo caso e il 422 passano già; falliscono gli altri (una chiamata sola dove se ne attendono due o tre, `tentativi` assente, `incerto` assente, nessuna riga di chiusura), e `tsc` segnalerebbe `ritentativi` sconosciuto in `SendEmailParams`.

- [ ] **Passo 3: gli import**

In `src/lib/email/send.ts` sostituisci le righe 1-3:

```ts
import { externalFetch } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'
import { hashCorrelabile } from '@/lib/logging/redact'
```

con:

```ts
import { externalFetch, tettoMs, type EsitoEsterno } from '@/lib/logging/external'
import { logEvento, type Livello, type Valore } from '@/lib/logging/logger'
import { hashCorrelabile } from '@/lib/logging/redact'
import { sanificaMessaggio } from '@/lib/logging/serialize'
import { msDaRetryAfter } from '@/lib/rete/retry-after'
```

- [ ] **Passo 4: il parametro e i campi nuovi dell'esito**

In `SendEmailParams`, sostituisci:

```ts
  chiaveIdempotenza?: string
}
```

con:

```ts
  chiaveIdempotenza?: string
  /**
   * I RITENTATIVI (sessione 9 della seconda serie di robustezza). Assente = una chiamata sola,
   * esattamente come prima: chi non lo passa non vede cambiare niente, nemmeno la forma
   * dell'esito.
   *
   * Presente = fino a `TENTATIVI_EMAIL_MAX` chiamate, aspettando 1 s e poi 3 s (o il
   * `Retry-After` del provider, se è più lungo e non supera `ATTESA_MAX_EMAIL_MS`), e SOLO:
   *  · sul `429`, sempre: il provider non ha preso in carico niente;
   *  · su `5xx` o senza risposta (`stato: 0`: rete giù, DNS, scadenza), SOLO con una
   *    `chiaveIdempotenza` valida: la richiesta potrebbe essere arrivata, e senza la chiave il
   *    ritentativo sarebbe un doppione alla famiglia.
   * Ogni ritentativo usa la STESSA chiave.
   *
   * `scadenza` (epoch ms): un ritentativo parte solo se attesa + tetto della chiamata finiscono
   * prima di lì. Il giro dei solleciti passa il suo tetto (240 s), così i ritentativi non
   * mangiano il margine fra il tetto e la vita della Function.
   */
  ritentativi?: { scadenza?: number }
}
```

In `SendEmailResult`, sostituisci:

```ts
  rinviabile?: boolean
}
```

con:

```ts
  rinviabile?: boolean
  /** Quante chiamate sono state fatte. Solo quando la richiesta porta `ritentativi`. */
  tentativi?: number
  /**
   * «Forse è partita». Vero quando il provider potrebbe aver preso in carico l'email senza che
   * lo sappiamo: un `409 concurrent_idempotent_requests` (la stessa chiave è ancora in corso) o
   * una chiamata scaduta senza risposta che nessun rifiuto definitivo successivo ha smentito.
   * Chi tiene una presa (i solleciti) NON la annulla su un esito incerto: meglio slittare di una
   * cadenza che partire due volte.
   */
  incerto?: boolean
}
```

- [ ] **Passo 5: le costanti**

Sostituisci:

```ts
const IDEMPOTENZA_CHIAVE_RIUSATA = 'invalid_idempotent_request'
```

con:

```ts
const IDEMPOTENZA_CHIAVE_RIUSATA = 'invalid_idempotent_request'

/** Quante chiamate al massimo, ritentativi compresi (sessione 9). */
export const TENTATIVI_EMAIL_MAX = 3
/** Le attese prima del 2° e del 3° tentativo: 1 s, poi 3 s (lo stesso passo di `native-push`). */
export const ATTESE_RITENTATIVO_EMAIL_MS: readonly number[] = [1_000, 3_000]
/** Oltre questa attesa chiesta dal provider non si aspetta: l'esito resta quello del tentativo. */
export const ATTESA_MAX_EMAIL_MS = 10_000

/** Perché i ritentativi si sono fermati prima di un successo: è l'`esito` della riga di chiusura. */
type MotivoFermata = 'ritentativi-esauriti' | 'retry-after-oltre-il-tetto' | 'ritentativo-oltre-la-scadenza'
```

- [ ] **Passo 6: la firma**

Sostituisci:

```ts
export async function sendEmailDetailed({ to, subject, text, html, attachments, replyTo, chiaveIdempotenza }: SendEmailParams): Promise<SendEmailResult> {
```

con:

```ts
export async function sendEmailDetailed({ to, subject, text, html, attachments, replyTo, chiaveIdempotenza, ritentativi }: SendEmailParams): Promise<SendEmailResult> {
```

- [ ] **Passo 7: la chiamata**

Sostituisci le righe 242-287 (da `  const esito = await externalFetch(` alla `  )` che chiude la chiamata, subito prima della riga vuota e di `  if (esito.ok) {`) con:

```ts
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(chiave ? { 'Idempotency-Key': chiave } : {}),
    },
    body: JSON.stringify({
      from: process.env.OTP_FROM_EMAIL ?? DEFAULT_FROM,
      to: destinatariPerIlProvider(to),
      subject,
      text,
      ...(html ? { html } : {}),
      // `?.length` e non la sola presenza: un elenco VUOTO significa «non ho
      // allegati», e mandare `attachments: []` a Resend è dire una cosa diversa
      // dal non dirla. Le due forme si equivalgono oggi; il contratto di un
      // provider esterno non è una cosa su cui si scommette.
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              ...(a.contentType ? { content_type: a.contentType } : {}),
            })),
          }
        : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  }
  const campi: Record<string, Valore> = {
    operazione: 'sendEmail',
    // Hash, mai l'indirizzo. `destinatario` NON è in lista bianca, quindi in `app_log`
    // resta `[redatto:str/9]`: l'hash si legge solo su Vercel. È il prezzo accettato —
    // l'alternativa sarebbe allargare la lista bianca di `redact` a un campo che porta
    // identità, e quella lista difende dati di minori (AGENTS, regola 8).
    destinatario: hashCorrelabile(to),
  }
  // Il battito (successo E rifiuto) lo emette `externalFetch`, una riga per chiamata, con il corpo
  // del provider nella colonna `messaggio`. Con i ritentativi le righe sono una per tentativo e
  // portano `tentativo`; sopra, al massimo una riga di chiusura (vedi `chiamaResend`).
  const { esito, tentativi, fermata, scaduto } = await chiamaResend(init, campi, chiave, ritentativi)
  // Le chiavi nuove dell'esito compaiono SOLO quando servono: chi non passa `ritentativi` riceve
  // l'esito di sempre, chiave per chiave (i test esistenti lo confrontano con `toEqual`).
  const conto = ritentativi === undefined ? {} : { tentativi }
  const dubbio = scaduto ? { incerto: true } : {}
```

- [ ] **Passo 8: gli esiti portano i conteggi**

Sostituisci:

```ts
    return { ok: true, error: null, messageId }
```

con:

```ts
    return { ok: true, error: null, messageId, ...conto }
```

Sostituisci:

```ts
  if (esito.stato === 0) {
    return { ok: false, error: `errore di rete verso il provider email: ${esito.corpo}` }
  }
```

con:

```ts
  if (esito.stato === 0) {
    // `incerto` se la chiamata è SCADUTA: la richiesta può essere arrivata e l'email partita.
    return { ok: false, error: `errore di rete verso il provider email: ${esito.corpo}`, ...conto, ...dubbio }
  }
```

Sostituisci:

```ts
  if (esito.stato === QUOTA_ESAURITA) {
    // Livello `warn` e non `error`: non è un guasto, è il tetto del piano che si
    // è fatto sentire. Ma resta scritto — il giorno in cui il giro delle
    // iscrizioni finisce prima del previsto, questa riga è l'unica che lo spiega.
    logEvento('email', 'warn', {
      operazione: 'sendEmail',
      esito: 'quota-esaurita',
      stato: esito.stato,
      msg: `quota del provider email esaurita (429): l'invio va rinviato, non registrato come fallito`,
    })
    return {
      ok: false,
      rinviabile: true,
      error: `quota del provider email esaurita (429)${dettaglio ? `: ${dettaglio}` : ''}`,
    }
  }
```

con:

```ts
  if (esito.stato === QUOTA_ESAURITA) {
    // Livello `warn` e non `error`: non è un guasto, è il tetto del piano che si
    // è fatto sentire. Ma resta scritto — il giorno in cui il giro delle
    // iscrizioni finisce prima del previsto, questa riga è l'unica che lo spiega.
    // Se i ritentativi si sono fermati su un 429, la loro riga di chiusura l'ha già detto, a
    // `error` (sessione 9): resta `warn` solo il 429 di chi non chiede ritentativi (il bottone).
    if (fermata === null) {
      logEvento('email', 'warn', {
        operazione: 'sendEmail',
        esito: 'quota-esaurita',
        stato: esito.stato,
        msg: `quota del provider email esaurita (429): l'invio va rinviato, non registrato come fallito`,
      })
    }
    return {
      ok: false,
      rinviabile: true,
      error: `quota del provider email esaurita (429)${dettaglio ? `: ${dettaglio}` : ''}`,
      ...conto,
      ...dubbio,
    }
  }
```

Sostituisci:

```ts
      return { ok: false, rinviabile: true, error: `invio già in corso presso il provider (409)${dettaglio ? `: ${dettaglio}` : ''}` }
```

con:

```ts
      // Incerto per definizione: l'altra richiesta con questa chiave può andare a buon fine.
      return { ok: false, rinviabile: true, incerto: true, error: `invio già in corso presso il provider (409)${dettaglio ? `: ${dettaglio}` : ''}`, ...conto }
```

Sostituisci:

```ts
  return {
    ok: false,
    error: `rifiutato dal provider email (${esito.stato})${dettaglio ? `: ${dettaglio}` : ''}`,
  }
}
```

con:

```ts
  return {
    ok: false,
    error: `rifiutato dal provider email (${esito.stato})${dettaglio ? `: ${dettaglio}` : ''}`,
    ...conto,
    ...dubbio,
  }
}
```

- [ ] **Passo 9: i ritentativi**

Subito dopo la funzione `corpoJson` (che finisce con `  return null` e `}`, prima di `/** Invia un'email. Ritorna true…`) aggiungi:

```ts

/**
 * La chiamata a Resend, con i ritentativi quando la richiesta li chiede (sessione 9).
 *
 * Una riga per TENTATIVO la scrive `externalFetch` (con `tentativo` fra i campi, quando i
 * ritentativi ci sono): a `warn` se il rifiuto è ritentabile, a `error` se è definitivo. Sopra,
 * al massimo una riga di chiusura: `riuscita-dopo-ritentativo` (`info`) oppure il motivo per cui
 * ci si è fermati, SEMPRE a `error` (429 compreso), con lo status come `code` e il corpo del
 * provider sanificato nell'Error. I tentativi intermedi restano `warn`: dicono «riprovo», la
 * chiusura dice «questa email in questo giro non parte». È la riga che la salute conta
 * (`contaEsitiFornitore` in `src/lib/health/fornitori.ts` conta come rifiuti le sole `error`):
 * con la chiusura a `warn` una quota esaurita tutto il giorno non arriverebbe mai a un allarme.
 *
 * Le attese sono in serie, una email alla volta: il giro dei solleciti non si parallelizza.
 */
async function chiamaResend(
  init: RequestInit,
  campi: Record<string, Valore>,
  chiave: string | undefined,
  ritentativi: SendEmailParams['ritentativi'],
): Promise<{ esito: EsitoEsterno; tentativi: number; fermata: MotivoFermata | null; scaduto: boolean }> {
  let tentativi = 0
  // «Una chiamata è scaduta senza risposta»: il provider potrebbe averla presa. Lo smentisce
  // solo un successo o un rifiuto 4xx definitivo (stessa chiave ⇒ stesso esito); un 429 o un
  // 5xx successivo non dicono niente sulla chiamata scaduta.
  let scaduto = false
  for (;;) {
    tentativi++
    const esito = await externalFetch('resend', 'https://api.resend.com/emails', init, {
      evento: 'email',
      campi: ritentativi === undefined ? campi : { ...campi, tentativo: tentativi },
      ...(ritentativi === undefined
        ? {}
        : { gravita: (stato: number): Livello => (eRitentabile(stato, chiave) ? 'warn' : 'error') }),
    })
    if (esito.ok || (esito.stato >= 400 && esito.stato < 500 && esito.stato !== QUOTA_ESAURITA)) scaduto = false
    if (!esito.ok && esito.stato === 0 && esito.codice === 'timeout') scaduto = true

    if (esito.ok) {
      if (tentativi > 1) {
        logEvento('email', 'info', {
          operazione: 'sendEmail',
          provider: 'resend',
          esito: 'riuscita-dopo-ritentativo',
          tentativi,
          msg: `email accettata dal provider al tentativo ${tentativi}`,
        })
      }
      return { esito, tentativi, fermata: null, scaduto }
    }
    if (ritentativi === undefined || !eRitentabile(esito.stato, chiave)) {
      return { esito, tentativi, fermata: null, scaduto }
    }

    const attesa = attesaPrimaDelRitentativo(esito.retryAfter, tentativi)
    const fermata = motivoPerFermarsi(tentativi, attesa, ritentativi.scadenza)
    if (fermata !== null) {
      // `error` qualunque sia la causa, 429 compreso: i tentativi sono finiti e l'email in questo
      // giro non parte. Il `code` (lo status, o il codice di rete) dice se era la quota.
      logEvento(
        'email',
        'error',
        {
          operazione: 'sendEmail',
          provider: 'resend',
          esito: fermata,
          ...(esito.stato > 0 ? { stato: esito.stato } : {}),
          tentativi,
          ...(fermata === 'ritentativi-esauriti' ? {} : { attesa_ms: attesa }),
        },
        erroreResend(esito.stato, esito.corpo, esito.codice),
      )
      return { esito, tentativi, fermata, scaduto }
    }
    await attendi(attesa)
  }
}

/**
 * Ritentabile: il `429` sempre (il provider dice «non ho preso niente, riprova»); `5xx` e nessuna
 * risposta (`stato: 0`: rete giù, DNS, scadenza del tetto) solo con una chiave d'idempotenza,
 * perché lì la richiesta potrebbe essere arrivata e solo la chiave rende il ritentativo innocuo.
 */
function eRitentabile(stato: number, chiave: string | undefined): boolean {
  if (stato === QUOTA_ESAURITA) return true
  return chiave !== undefined && (stato === 0 || (stato >= 500 && stato <= 599))
}

/** L'attesa prima del prossimo tentativo: la scaletta, o il `Retry-After` se è più lungo. */
function attesaPrimaDelRitentativo(retryAfter: string | undefined, fatti: number): number {
  const scaletta = ATTESE_RITENTATIVO_EMAIL_MS[Math.min(fatti, ATTESE_RITENTATIVO_EMAIL_MS.length) - 1]
  const chiesta = msDaRetryAfter(retryAfter)
  return chiesta === undefined ? scaletta : Math.max(scaletta, chiesta)
}

/**
 * `null` = si ritenta. Il terzo motivo è il tetto del giro: un ritentativo parte solo se l'attesa
 * e il tetto della chiamata (`tettoMs('resend')`) finiscono prima della scadenza.
 */
function motivoPerFermarsi(fatti: number, attesa: number, scadenza: number | undefined): MotivoFermata | null {
  if (fatti >= TENTATIVI_EMAIL_MAX) return 'ritentativi-esauriti'
  if (attesa > ATTESA_MAX_EMAIL_MS) return 'retry-after-oltre-il-tetto'
  if (scadenza !== undefined && Date.now() + attesa + tettoMs('resend') > scadenza) return 'ritentativo-oltre-la-scadenza'
  return null
}

function attendi(ms: number): Promise<void> {
  return new Promise((risolvi) => setTimeout(risolvi, ms))
}

/**
 * L'ultimo rifiuto come Error VERO, per la riga che chiude i ritentativi: il corpo del provider
 * diventa il messaggio, SANIFICATO (un indirizzo dentro il corpo esce come `[email]`), lo status
 * il `code`. Senza risposta il codice è quello che `externalFetch` ha scritto sulla riga del
 * tentativo (`'timeout'`, `ECONNRESET`…), altrimenti `'nessuna-risposta'`: mai `'0'`, che in
 * `app_log.codice` sembrerebbe uno status. Stesso schema di `erroreFcm` in `native-push.ts`.
 */
function erroreResend(stato: number, corpo: string, codiceRete: string | undefined): Error {
  const err = new Error(sanificaMessaggio(corpo === '' ? `Resend ${stato === 0 ? 'nessuna risposta' : `HTTP ${stato}`}` : corpo))
  err.name = 'ResendRitentativiFermati'
  Object.assign(err, { code: stato === 0 ? (codiceRete ?? 'nessuna-risposta') : String(stato) })
  return err
}
```

- [ ] **Passo 10: i test nuovi e quelli di prima**

```bash
npx vitest run __tests__/lib/email-send-ritentativi.test.ts __tests__/lib/email-send.test.ts __tests__/lib/email-send-quota.test.ts __tests__/lib/email-send-idempotenza.test.ts __tests__/lib/email-send-destinatari.test.ts __tests__/lib/email/send-allegati.test.ts __tests__/lib/logging-external.test.ts __tests__/architecture/provider-esterni-osservati.test.ts 2>&1 | tail -8
npx tsc --noEmit 2>&1 | head -10
```

Atteso: `Test Files  8 passed`; `tsc` senza output. In particolare `email-send-quota` (riga 181, `toStrictEqual` sul successo) resta verde: senza `ritentativi` l'esito non porta chiavi nuove.

- [ ] **Passo 11: commit**

```bash
git add src/lib/email/send.ts __tests__/lib/email-send-ritentativi.test.ts
git commit -m "$(cat <<'EOF'
Resend: fino a 3 tentativi, con la stessa chiave, solo su richiesta (sessione 9)

sendEmailDetailed accetta `ritentativi`: 429 sempre, 5xx e rete solo con la chiave
d'idempotenza, attese 1 s e 3 s o il Retry-After fino a 10 s, mai oltre la scadenza
del giro. Una riga per tentativo (externalFetch, con `tentativo`, `warn` se ritentabile)
e una di chiusura, sempre `error` (429 compreso), col codice e il corpo del provider
sanificato. Esito `incerto` su 409 concorrente o chiamata scaduta.
Senza `ritentativi` niente cambia, nemmeno la forma dell'esito.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — I livelli contano solo i solleciti recapitati

**File:**
- Modifica: `src/lib/pagamenti/solleciti-invio.ts:92` (costante) e `:151` (lettura dei livelli)
- Test: `__tests__/api/pagamenti-solleciti-invio.test.ts:4-35`, `:54-107`, `:127-145`, in fondo; `__tests__/api/solleciti-causale-codice.test.ts:134`

Da questa sessione il registro si scrive anche quando nessuna email parte (Compito 6). Senza questo filtro, una riga non recapitata farebbe salire il livello: alla famiglia arriverebbe il 3° sollecito senza aver mai ricevuto il 2°.

- [ ] **Passo 1: lo stato finto**

In `__tests__/api/pagamenti-solleciti-invio.test.ts`, nel blocco `vi.hoisted`, sostituisci:

```ts
  sendEmailDetailed: vi.fn(async (opts: { to: string; subject: string; text: string; html?: string }) => ({ ok: Boolean(opts), error: null })),
```

con:

```ts
  sendEmailDetailed: vi.fn(async (opts: {
    to: string; subject: string; text: string; html?: string
    chiaveIdempotenza?: string; ritentativi?: { scadenza?: number }
  }): Promise<{ ok: boolean; error: string | null; incerto?: boolean }> => ({ ok: Boolean(opts), error: null })),
```

e sostituisci:

```ts
  sequenza: [] as string[],
  logEvento: vi.fn(),
}))
```

con:

```ts
  sequenza: [] as string[],
  // Sessione 9: la cadenza come la vede il database, l'ultima presa scritta, gli annullamenti
  // (il valore rimesso), il guasto dell'annullamento e i filtri di contenimento sul registro.
  cadenzaInDb: null as string | null,
  ultimaPresa: null as string | null,
  annullamenti: [] as (string | null)[],
  erroreAnnullamento: null as null | { code: string; message: string },
  contenimenti: [] as { table: string; col: string; val: string }[],
  logEvento: vi.fn(),
}))
```

- [ ] **Passo 2: il database finto impara il contenimento e l'annullamento**

Sostituisci l'intero blocco da `vi.mock('@/lib/supabase/server-client', () => ({` (riga 54) alla sua chiusura `}))` (riga 107) con:

```ts
vi.mock('@/lib/supabase/server-client', () => {
  // Il contenimento jsonb di PostgREST (`cs`), ridotto a ciò che il motore usa (sessione 9): il
  // filtro è un elenco di oggetti, e ognuno deve avere nel valore un elemento con le stesse
  // chiavi e gli stessi valori. Una riga senza `destinatari` non contiene niente, come in Postgres.
  const contiene = (valore: unknown, filtro: string): boolean => {
    const attesi = JSON.parse(filtro) as Record<string, unknown>[]
    return Array.isArray(valore) && attesi.every((a) =>
      valore.some((v: unknown) => v !== null && typeof v === 'object'
        && Object.entries(a).every(([k, x]) => (v as Record<string, unknown>)[k] === x)))
  }
  return {
    createAdminClient: async () => ({
      from: (table: string) => {
        const b: Record<string, unknown> = {}
        let aggiornamento: Record<string, unknown> | null = null
        // Sessione 9: il filtro sulla cadenza (`.eq`/`.is` su `ultimo_sollecito_il`) distingue la
        // PRESA dall'ANNULLAMENTO; il contenimento filtra davvero le righe del registro.
        let filtroCadenza: { val: unknown } | null = null
        let contenimento: { col: string; val: string } | null = null
        b.select = () => b
        b.eq = (col: string, val: unknown) => { if (col === 'ultimo_sollecito_il') filtroCadenza = { val }; return b }
        b.in = (col: string, vals: unknown[]) => { h.ins.push({ table, col, n: vals.length }); return b }
        b.is = (col: string, val: unknown) => { if (col === 'ultimo_sollecito_il') filtroCadenza = { val }; return b }
        b.lt = () => b
        b.neq = () => b
        b.contains = (col: string, val: string) => {
          h.contenimenti.push({ table, col, val })
          contenimento = { col, val }
          return b
        }
        b.order = (col: string) => { h.ordini.push({ table, col }); return b }
        b.limit = () => b
        b.maybeSingle = async () => ({ data: table === 'admin_settings' ? h.settingsRow : table === 'scuole' ? { nome: 'Kidville Giugliano' } : null, error: null })
        b.insert = (row: Record<string, unknown>) => {
          h.inserts.push({ table, row })
          if (table === 'solleciti' && h.registroLancia) {
            return { then: (_r: unknown, ko: (e: unknown) => unknown) => ko(new TypeError('fetch failed')) }
          }
          const errore = table === 'solleciti' ? h.erroreRegistro : null
          return { then: (r: (v: unknown) => unknown) => r({ data: null, error: errore }), select: () => ({ single: async () => ({ data: row, error: null }) }) }
        }
        b.update = (row: Record<string, unknown>) => {
          h.updates.push({ table, row })
          aggiornamento = row
          return b
        }
        b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (table === 'pagamenti' && aggiornamento && 'ultimo_sollecito_il' in aggiornamento) {
            const valore = (aggiornamento.ultimo_sollecito_il ?? null) as string | null
            // L'ANNULLAMENTO: condizionato sulla presa che questo giro ha appena scritto.
            if (h.ultimaPresa !== null && filtroCadenza?.val === h.ultimaPresa) {
              h.sequenza.push('annullamento')
              h.annullamenti.push(valore)
              if (h.erroreAnnullamento) return resolve({ data: null, error: h.erroreAnnullamento })
              // Un altro giro ha già ripreso la voce: l'UPDATE condizionato tocca zero righe.
              if (h.cadenzaInDb !== h.ultimaPresa) return resolve({ data: [], error: null })
              h.cadenzaInDb = valore
              return resolve({ data: [{ id: 'x' }], error: null })
            }
            // LA PRESA.
            h.sequenza.push('presa')
            if (h.errorePresa) return resolve({ data: null, error: h.errorePresa })
            if (h.presaVuota) return resolve({ data: [], error: null })
            h.ultimaPresa = valore
            h.cadenzaInDb = valore
            return resolve({ data: [{ id: 'x' }], error: null })
          }
          if (table === 'pagamenti' && !aggiornamento && h.erroreLetturaPagamenti) {
            return resolve({ data: null, error: h.erroreLetturaPagamenti })
          }
          if (table === 'solleciti' && h.livelliLancia && reject) return reject(new TypeError('fetch failed'))
          if (table === 'solleciti' && h.erroreLivelli) return resolve({ data: null, error: h.erroreLivelli })
          const c = contenimento
          return resolve({
            data:
              table === 'pagamenti' ? h.pagamenti
              : table === 'solleciti' ? (c ? h.sollecitiEsistenti.filter((r) => contiene(r[c.col], c.val)) : h.sollecitiEsistenti)
              : table === 'admin_settings' ? h.settingsRows
              : table === 'legame_genitori_alunni' ? h.legami
              : table === 'utenti' ? h.utenti
              : table === 'pagamenti_quote' ? h.quote
              : [],
            error: null,
          })
        }
        return b
      },
    }),
  }
})
```

Nel `beforeEach`, sostituisci:

```ts
  h.sequenza = []
  h.sendEmailDetailed.mockImplementation(async (opts) => {
```

con:

```ts
  h.sequenza = []
  h.cadenzaInDb = null
  h.ultimaPresa = null
  h.annullamenti = []
  h.erroreAnnullamento = null
  h.contenimenti = []
  h.sendEmailDetailed.mockImplementation(async (opts) => {
```

In `__tests__/api/solleciti-causale-codice.test.ts`, sostituisci (riga 134):

```ts
      b.neq = () => b
```

con:

```ts
      b.neq = () => b
      // Sessione 9: i livelli si leggono con `.contains('destinatari', …)`.
      b.contains = () => b
```

- [ ] **Passo 3: il caso del livello (rosso)**

In fondo a `__tests__/api/pagamenti-solleciti-invio.test.ts` aggiungi:

```ts

// =============================================================================
// SESSIONE 9 — un sollecito conta come inviato solo se un'email è partita.
// Indirizzi solo su `example.test`.
// =============================================================================
describe('solleciti — il livello conta solo i solleciti RECAPITATI (sessione 9)', () => {
  it('L1 recapitato, L2 registrato senza nessuna email partita ⇒ il prossimo è di nuovo il 2', async () => {
    h.sollecitiEsistenti = [
      { pagamento_id: PID, livello: 1, destinatari: [{ id: 'g-1', inviata: true }] },
      { pagamento_id: PID, livello: 2, destinatari: [{ id: 'g-1', inviata: false }] },
    ]
    const res = await POST(post({ pagamento_ids: [PID], anteprima: true }))
    const j = await res.json()
    expect(j.data[0]).toMatchObject({ pagamento_id: PID, ok: true, livello: 2 })
    expect(h.contenimenti).toContainEqual({ table: 'solleciti', col: 'destinatari', val: '[{"inviata":true}]' })
  })
})
```

- [ ] **Passo 4: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/api/pagamenti-solleciti-invio.test.ts __tests__/api/solleciti-causale-codice.test.ts 2>&1 | tail -12
```

Atteso: un solo test rosso, quello nuovo: `livello` 3 invece di 2 (senza filtro conta anche la riga non recapitata) e `contenimenti` vuoto. Tutti gli altri restano verdi col database finto nuovo.

- [ ] **Passo 5: il filtro**

In `src/lib/pagamenti/solleciti-invio.ts`, sostituisci:

```ts
const REGISTRO_ASSENTE = new Set(['42P01', 'PGRST205'])
```

con:

```ts
const REGISTRO_ASSENTE = new Set(['42P01', 'PGRST205'])

/**
 * Il filtro dei livelli (sessione 9): solo le righe del registro con ALMENO un destinatario
 * raggiunto. Da questa sessione il registro scrive anche i tentativi falliti; senza il filtro
 * una riga non recapitata farebbe salire il livello, e alla famiglia arriverebbe il 3° sollecito
 * senza aver mai ricevuto il 2°. Stringa JSON e non array: postgrest-js tradurrebbe un array JS
 * nel letterale Postgres `cs.{…}`, che su una colonna jsonb non vale; con la stringa esce
 * `cs.[{"inviata":true}]`, cioè `destinatari @> '[{"inviata":true}]'`.
 */
const FILTRO_RECAPITATO = '[{"inviata":true}]'
```

e sostituisci:

```ts
            const { data, error: errLivelli } = await supabase.from('solleciti').select('pagamento_id, livello').in('pagamento_id', blocco)
```

con:

```ts
            const { data, error: errLivelli } = await supabase.from('solleciti').select('pagamento_id, livello').in('pagamento_id', blocco).contains('destinatari', FILTRO_RECAPITATO)
```

- [ ] **Passo 6: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/api/pagamenti-solleciti-invio.test.ts __tests__/api/solleciti-causale-codice.test.ts __tests__/architecture/pagamenti-errori-controllati.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  3 passed`.

- [ ] **Passo 7: commit**

```bash
git add src/lib/pagamenti/solleciti-invio.ts __tests__/api/pagamenti-solleciti-invio.test.ts __tests__/api/solleciti-causale-codice.test.ts
git commit -m "$(cat <<'EOF'
Solleciti: il livello conta solo i solleciti recapitati (sessione 9)

La lettura dei livelli filtra `destinatari @> [{"inviata":true}]`: una riga del registro
senza nessuna email partita non fa più salire il livello. Il database finto dei test
impara il contenimento jsonb e distingue la presa dall'annullamento.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — Nessuna email partita: la presa si annulla, il registro dice com'è andata

**File:**
- Modifica: `src/lib/pagamenti/solleciti-invio.ts:8`, `:53`, `:61-67`, dopo la costante del Compito 5, `:358`, `:420-485`, dopo `:494`
- Test: `__tests__/api/pagamenti-solleciti-invio.test.ts` (in fondo)

- [ ] **Passo 1: scrivi i test (rossi)**

In fondo a `__tests__/api/pagamenti-solleciti-invio.test.ts` aggiungi:

```ts

describe('solleciti — nessuna email partita, nessun sollecito (sessione 9)', () => {
  const righe = (esito: string) =>
    h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
  const registro = () => h.inserts.filter((i) => i.table === 'solleciti')
  const fallisce = (error: string, incerto?: boolean) =>
    h.sendEmailDetailed.mockImplementation(async () => {
      h.sequenza.push('email')
      return incerto ? { ok: false, error, incerto: true } : { ok: false, error }
    })

  beforeEach(() => {
    h.utenti = [{ id: 'g-1', email: 'genitore.uno@example.test' }]
  })

  it('🔴 nessuna email partita ⇒ la presa si annulla, niente push, registro con l’esito, riga `error`', async () => {
    fallisce('rifiutato dal provider email (403): dominio non verificato per genitore.uno@example.test')
    const j = await (await POST(post({ pagamento_ids: [PID] }))).json()

    expect(h.sequenza).toEqual(['presa', 'email', 'annullamento'])
    expect(h.annullamenti).toEqual([null])
    expect(h.cadenzaInDb).toBeNull()
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
    expect(registro()).toHaveLength(1)
    expect(registro()[0].row.destinatari).toEqual([{ id: 'g-1', email: 'genitore.uno@example.test', inviata: false }])
    expect(j.data[0]).toMatchObject({
      pagamento_id: PID, ok: false, livello: 1, inviate: 0, tentate: 1,
      motivo: 'nessuna email partita: il sollecito resta per il giro successivo',
    })
    const riga = righe('sollecito-non-recapitato')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect(riga[0][2]).toMatchObject({ operazione: 'solleciti-invio', pagamento_id: PID, livello_sollecito: 1, tentate: 1, presa_annullata: true })
    const err = riga[0][3] as Error
    expect(err.name).toBe('SollecitoNonRecapitato')
    expect(err.message).toContain('[email]')
    expect(err.message).not.toContain('example.test')
  })

  it('l’annullamento rimette la cadenza di PRIMA, non `null`', async () => {
    const PRIMA = '2026-05-01T06:00:00.000Z'
    h.pagamenti = [{ ...h.pagamenti[0], ultimo_sollecito_il: PRIMA }]
    h.cadenzaInDb = PRIMA
    fallisce('rifiutato dal provider email (500): errore finto')
    await POST(post({ pagamento_ids: [PID] }))
    expect(h.annullamenti).toEqual([PRIMA])
    expect(h.cadenzaInDb).toBe(PRIMA)
  })

  it('🔴 un altro giro ha ripreso la voce mentre l’email falliva: l’annullamento non tocca la sua cadenza', async () => {
    const ESTRANEA = '2026-10-21T06:00:09.000Z'
    h.sendEmailDetailed.mockImplementation(async () => {
      h.sequenza.push('email')
      h.cadenzaInDb = ESTRANEA // il bottone della segreteria, nello stesso istante
      return { ok: false, error: 'rifiutato dal provider email (500): errore finto' }
    })
    const j = await (await POST(post({ pagamento_ids: [PID] }))).json()

    expect(h.sequenza).toEqual(['presa', 'email', 'annullamento'])
    expect(h.cadenzaInDb).toBe(ESTRANEA)
    expect(j.data[0]).toMatchObject({
      ok: false, inviate: 0, tentate: 1,
      motivo: 'nessuna email partita, e la cadenza non è tornata indietro: il sollecito slitta di una cadenza',
    })
    const ripresa = righe('presa-gia-ripresa')
    expect(ripresa).toHaveLength(1)
    expect(ripresa[0][1]).toBe('info')
    expect(righe('sollecito-non-recapitato')[0][2]).toMatchObject({ presa_annullata: false })
  })

  it('🔴 un destinatario sì e uno no ⇒ il sollecito è partito: la presa resta, push e registro con i due esiti', async () => {
    h.legami = [{ alunno_id: 'al-1', genitore_id: 'g-1' }, { alunno_id: 'al-1', genitore_id: 'g-2' }]
    h.utenti = [{ id: 'g-1', email: 'genitore.uno@example.test' }, { id: 'g-2', email: 'genitore.due@example.test' }]
    h.sendEmailDetailed.mockImplementation(async (opts) => {
      h.sequenza.push('email')
      return opts.to === 'genitore.uno@example.test'
        ? { ok: true, error: null }
        : { ok: false, error: 'rifiutato dal provider email (422): indirizzo non valido' }
    })
    const j = await (await POST(post({ pagamento_ids: [PID] }))).json()

    expect(h.sequenza).toEqual(['presa', 'email', 'email'])
    expect(h.annullamenti).toEqual([])
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
    expect((registro()[0].row.destinatari as { inviata: boolean }[]).map((d) => d.inviata)).toEqual([true, false])
    expect(j.data[0]).toMatchObject({ ok: true, inviate: 1, tentate: 2 })
    expect(righe('sollecito-non-recapitato')).toHaveLength(0)
  })

  it('nessun destinatario con un indirizzo ⇒ niente presa, niente email, niente push, niente registro; una riga `warn`', async () => {
    h.utenti = [{ id: 'g-1', email: null }]
    const j = await (await POST(post({ pagamento_ids: [PID] }))).json()

    expect(h.sequenza).toEqual([])
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
    expect(registro()).toEqual([])
    expect(j.data[0]).toMatchObject({ ok: false, motivo: 'nessun destinatario con un indirizzo email' })
    const riga = righe('nessun-indirizzo-email')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('warn')
    expect(riga[0][2]).toMatchObject({ pagamento_id: PID, n_destinatari: 1 })
  })

  it('esito INCERTO ⇒ la presa resta, niente push, registro con `incerta`, riga `warn`', async () => {
    fallisce('errore di rete verso il provider email: scaduto', true)
    const j = await (await POST(post({ pagamento_ids: [PID] }))).json()

    expect(h.sequenza).toEqual(['presa', 'email'])
    expect(h.annullamenti).toEqual([])
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
    expect(registro()[0].row.destinatari).toEqual([{ id: 'g-1', email: 'genitore.uno@example.test', inviata: false, incerta: true }])
    expect(j.data[0]).toMatchObject({
      ok: false, inviate: 0, tentate: 1,
      motivo: 'esito incerto presso il provider: nessun nuovo invio prima della prossima cadenza',
    })
    const riga = righe('sollecito-esito-incerto')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('warn')
    expect(riga[0][2]).toMatchObject({ pagamento_id: PID, tentate: 1, incerte: 1 })
  })

  it('l’annullamento che fallisce (57014) ⇒ riga `error` col codice, e il sollecito slitta', async () => {
    h.erroreAnnullamento = { code: '57014', message: 'canceling statement due to statement timeout' }
    fallisce('rifiutato dal provider email (500): errore finto')
    const j = await (await POST(post({ pagamento_ids: [PID] }))).json()

    const riga = righe('presa-non-annullata')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect((riga[0][3] as { code?: string }).code).toBe('57014')
    expect(righe('sollecito-non-recapitato')[0][2]).toMatchObject({ presa_annullata: false })
    expect(j.data[0].motivo).toBe('nessuna email partita, e la cadenza non è tornata indietro: il sollecito slitta di una cadenza')
  })
})
```

- [ ] **Passo 2: eseguili e guardali fallire**

```bash
npx vitest run __tests__/api/pagamenti-solleciti-invio.test.ts 2>&1 | tail -15
```

Atteso: rossi i sette casi nuovi (oggi l'esito è `ok: true` anche senza email, la push parte, la presa non si annulla, `inviate`/`tentate` mancano, il registro non porta `incerta`). Verdi tutti gli altri.

- [ ] **Passo 3: import, intestazione, esito e tipi**

In `src/lib/pagamenti/solleciti-invio.ts` sostituisci:

```ts
import { logErrore, logEvento } from '@/lib/logging/logger'
```

con:

```ts
import { logErrore, logEvento } from '@/lib/logging/logger'
import { sanificaMessaggio } from '@/lib/logging/serialize'
```

Sostituisci:

```ts
//    tempo` e le riprende il giro dopo, invece di morire col muro della Function.
```

con:

```ts
//    tempo` e le riprende il giro dopo, invece di morire col muro della Function.
//
// SESSIONE 9 DELLA SECONDA SERIE (email e fornitori senza successi finti):
//  • un sollecito è «inviato» solo se ALMENO UNA email è partita. Se non ne parte nessuna, la
//    presa si annulla con un UPDATE condizionato sulla presa stessa (se un altro giro l'ha già
//    ripresa, resta la sua), l'esito è `ok: false` e il giro dopo la riprende;
//  • se l'esito è INCERTO (scadenza senza risposta, 409 concorrente) la presa resta: il
//    sollecito slitta di una cadenza invece di partire due volte;
//  • il registro si scrive anche quando l'invio fallisce, con l'esito per destinatario; i
//    livelli contano solo le righe con almeno un `inviata: true` (`FILTRO_RECAPITATO`);
//  • niente push se nessuna email è partita: la push accompagna il sollecito, non lo sostituisce;
//  • nessun destinatario con un indirizzo ⇒ niente presa e niente registro, un `warn`;
//  • nel giro automatico l'email ritenta (429, 5xx, rete) dentro il tetto del giro.
```

Sostituisci:

```ts
    /** `true` = non tentato perché il giro ha raggiunto il suo tetto di tempo. */
    rinviato?: boolean
}
```

con:

```ts
    /** `true` = non tentato perché il giro ha raggiunto il suo tetto di tempo. */
    rinviato?: boolean
    /** Sessione 9: le email partite e quelle tentate (i destinatari con un indirizzo). */
    inviate?: number
    tentate?: number
}
```

Sostituisci:

```ts
const FILTRO_RECAPITATO = '[{"inviata":true}]'
```

con:

```ts
const FILTRO_RECAPITATO = '[{"inviata":true}]'

/** Un destinatario nel registro: l'esito del suo invio. */
interface DestinatarioRegistrato {
    id: string
    email?: string | null
    inviata: boolean
    /** Il provider potrebbe averla presa (vedi `SendEmailResult.incerto`). */
    incerta?: true
}

/** La riga del registro `solleciti`, senza il canale (lo aggiunge `registraSollecito`). */
interface RigaRegistro {
    pagamento_id: string
    scuola_id: string
    alunno_id: string
    livello: number
    destinatari: DestinatarioRegistrato[]
    oggetto: string
    corpo: string
    automatico: boolean
    inviato_da: string | null
}
```

- [ ] **Passo 4: nessun indirizzo, nessuna presa**

Sostituisci:

```ts
        if (destinatari.length === 0) { esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun destinatario collegato' }); continue }
```

con:

```ts
        if (destinatari.length === 0) { esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun destinatario collegato' }); continue }
        if (!destinatari.some((d) => !!d.email)) {
            // Sessione 9: nessuno dei destinatari ha un indirizzo. Prima si prendeva la cadenza,
            // si mandava la sola push e si registrava un sollecito senza nessuna email partita: la
            // voce risultava «sollecitata» e il livello saliva. Ora si dice, e la voce resta com'è.
            if (!opts.anteprima) {
                logEvento('pagamento', 'warn', {
                    operazione: 'solleciti-invio', esito: 'nessun-indirizzo-email', pagamento_id: id,
                    n_destinatari: destinatari.length,
                    msg: 'sollecito non inviato: nessun destinatario collegato ha un indirizzo email',
                })
            }
            esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun destinatario con un indirizzo email' }); continue
        }
```

- [ ] **Passo 5: il giro dei destinatari**

Sostituisci il blocco da `        const giorno = presaIl.slice(0, 10)` (riga 420) a `        esiti.push({ pagamento_id: id, ok: true, livello, oggetto, destinatari })` (riga 485), estremi compresi, con:

```ts
        const giorno = presaIl.slice(0, 10)
        const registrati: DestinatarioRegistrato[] = []
        let inviate = 0
        let tentate = 0
        let incerte = 0
        let ultimoErrore: string | null = null
        for (const d of destinatari) {
            if (!d.email) {
                registrati.push({ id: d.id, email: d.email, inviata: false })
                continue
            }
            tentate++
            const invio = await sendEmailDetailed({
                to: d.email, subject: oggetto, text: corpo, html: messaggio.html,
                // voce + livello + destinatario + giorno: lo stesso sollecito ritentato
                // lo stesso giorno Resend non lo rispedisce. Solo uuid e una data.
                chiaveIdempotenza: `sollecito:${id}:L${livello}:${d.id}:${giorno}`,
                // Sessione 9: i ritentativi (429, 5xx, rete) solo nel giro AUTOMATICO e dentro il
                // suo tetto di tempo. Dal bottone la segreteria aspetta davanti allo schermo: un
                // fallimento lo vede subito, e decide lei.
                ...(opts.automatico ? { ritentativi: opts.scadenza !== undefined ? { scadenza: opts.scadenza } : {} } : {}),
            })
            if (invio.ok) {
                inviate++
            } else {
                ultimoErrore = invio.error
                if (invio.incerto) incerte++
            }
            registrati.push({ id: d.id, email: d.email, inviata: invio.ok, ...(invio.incerto ? { incerta: true as const } : {}) })
        }
        // Il registro è l'AUDIT di ciò che si è TENTATO, con l'esito per destinatario, e la fonte
        // dei livelli qui sopra (che però contano solo le righe recapitate: `FILTRO_RECAPITATO`).
        const riga: RigaRegistro = {
            pagamento_id: id,
            scuola_id: pag.scuola_id,
            alunno_id: pag.alunno_id,
            livello,
            destinatari: registrati,
            oggetto,
            corpo,
            automatico: !!opts.automatico,
            inviato_da: opts.attoreId ?? null,
        }
        if (inviate === 0) {
            // NESSUNA EMAIL È PARTITA (sessione 9). Prima: presa scritta, push mandata, registro
            // scritto ed esito `ok: true` — la voce risultava sollecitata e la famiglia non aveva
            // ricevuto niente. Ora:
            //  · esito certo ⇒ la presa si annulla, e il giro dopo riprende la voce;
            //  · esito incerto ⇒ la presa resta: meglio slittare di una cadenza che partire due volte.
            // In entrambi i casi niente push, e il registro dice com'è andata.
            const presaAnnullata = incerte === 0
                ? await annullaPresa(supabase, id, presaIl, pag.ultimo_sollecito_il)
                : false
            await registraSollecito(supabase, riga)
            if (incerte > 0) {
                logEvento('pagamento', 'warn', {
                    operazione: 'solleciti-invio', esito: 'sollecito-esito-incerto', pagamento_id: id,
                    livello_sollecito: livello, tentate, incerte,
                    msg: 'nessuna email confermata dal provider, ma una potrebbe essere partita: la cadenza resta e il sollecito slitta di una cadenza',
                })
                esiti.push({
                    pagamento_id: id, ok: false, livello, inviate: 0, tentate,
                    motivo: 'esito incerto presso il provider: nessun nuovo invio prima della prossima cadenza',
                })
                continue
            }
            logEvento('pagamento', 'error', {
                operazione: 'solleciti-invio', esito: 'sollecito-non-recapitato', pagamento_id: id,
                livello_sollecito: livello, tentate, presa_annullata: presaAnnullata,
            }, erroreNonRecapitato(ultimoErrore))
            esiti.push({
                pagamento_id: id, ok: false, livello, inviate: 0, tentate,
                motivo: presaAnnullata
                    ? 'nessuna email partita: il sollecito resta per il giro successivo'
                    : 'nessuna email partita, e la cadenza non è tornata indietro: il sollecito slitta di una cadenza',
            })
            continue
        }
        try {
            await enqueueNotifiche(supabase, {
                utenteIds: destinatari.map((d) => d.id),
                tipo: 'pagamento',
                titolo: oggetto,
                corpo: `Residuo ${ctx.residuo} — ${ctx.descrizione}`,
                link: '/parent/pagamenti',
                scuolaId: pag.scuola_id,
            })
        } catch (err) {
            // Best-effort: l'email è già partita e il registro qui sotto si scrive lo
            // stesso. Ma una push persa si DICE — il commento «best-effort» era l'unica
            // traccia, e non finiva in `app_log`. Solo l'uuid della voce.
            logEvento('notifica', 'error', {
                operazione: 'solleciti:push',
                esito: 'push-non-accodata',
                pagamento_id: id,
            }, err)
        }
        await registraSollecito(supabase, riga)
        // La cadenza è già scritta: è la presa, qui sopra, prima dell'email.
        esiti.push({ pagamento_id: id, ok: true, livello, oggetto, destinatari, inviate, tentate })
```

- [ ] **Passo 6: le tre funzioni**

In fondo al file, dopo la `}` che chiude `sollecitaPagamenti` (riga 494), aggiungi:

```ts

/**
 * Riporta la cadenza al valore di prima, SOLO se è ancora la nostra presa (sessione 9).
 *
 * È lo stesso UPDATE condizionato della presa, al contrario: `… where ultimo_sollecito_il =
 * <presa>`. Zero righe = un altro giro (il cron, o la segreteria dal bottone) ha ripreso la voce
 * dopo di noi: la cadenza è sua, e non si tocca. `true` solo se la cadenza è tornata indietro.
 */
async function annullaPresa(
    supabase: SupabaseClient,
    id: string,
    presaIl: string,
    precedente: string | null,
): Promise<boolean> {
    try {
        const { data, error } = await supabase
            .from('pagamenti')
            .update({ ultimo_sollecito_il: precedente })
            .eq('id', id)
            .eq('ultimo_sollecito_il', presaIl)
            .select('id')
        if (error) {
            logEvento('pagamento', 'error', {
                operazione: 'solleciti-invio', esito: 'presa-non-annullata', pagamento_id: id,
                msg: 'nessuna email partita e la cadenza non è tornata indietro: il sollecito slitta di una cadenza',
            }, error)
            return false
        }
        if ((data ?? []).length === 0) {
            logEvento('pagamento', 'info', {
                operazione: 'solleciti-invio', esito: 'presa-gia-ripresa', pagamento_id: id,
                msg: 'la cadenza è cambiata dopo la presa: un altro giro ha ripreso la voce, e resta la sua',
            })
            return false
        }
        return true
    } catch (err) {
        logEvento('pagamento', 'error', {
            operazione: 'solleciti-invio', esito: 'presa-non-annullata', pagamento_id: id,
        }, err)
        return false
    }
}

/**
 * Il registro è l'AUDIT di ciò che si è tentato (e la fonte dei livelli). Se non si scrive il
 * sollecito resta quello che è, ma il prossimo ripartirebbe dallo stesso livello: si dice, `info`
 * se il registro non esiste (DB della CI), `error` altrimenti. PostgREST non lancia: si legge
 * `{ error }`. Mai oggetto né corpo nella riga di log.
 */
async function registraSollecito(supabase: SupabaseClient, riga: RigaRegistro): Promise<void> {
    try {
        const { error: errRegistro } = await supabase.from('solleciti').insert({ ...riga, canale: 'email' })
        if (errRegistro) {
            const assente = REGISTRO_ASSENTE.has((errRegistro as { code?: string }).code ?? '')
            logEvento('pagamento', assente ? 'info' : 'error', {
                operazione: 'solleciti:registro',
                esito: assente ? 'registro-solleciti-assente' : 'registro-sollecito-non-scritto',
                pagamento_id: riga.pagamento_id,
            }, errRegistro)
        }
    } catch (err) {
        logEvento('pagamento', 'error', {
            operazione: 'solleciti:registro',
            esito: 'registro-sollecito-non-scritto',
            pagamento_id: riga.pagamento_id,
        }, err)
    }
}

/**
 * L'ultimo motivo del provider come Error VERO, per la riga `sollecito-non-recapitato`: il
 * messaggio arriva sanificato (un indirizzo dentro il rifiuto esce come `[email]`), così la
 * colonna `app_log.messaggio` dice PERCHÉ senza dire A CHI.
 */
function erroreNonRecapitato(motivo: string | null): Error {
    const err = new Error(sanificaMessaggio(motivo ?? 'nessun esito dal provider email'))
    err.name = 'SollecitoNonRecapitato'
    return err
}
```

- [ ] **Passo 7: eseguili e guardali passare**

```bash
npx vitest run __tests__/api/pagamenti-solleciti-invio.test.ts __tests__/api/solleciti-causale-codice.test.ts __tests__/api/cron-battito.test.ts __tests__/architecture/pagamenti-errori-controllati.test.ts __tests__/architecture/catch-muti-allowlist.test.ts __tests__/lib/prestampati-modelli-segreteria.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | head -10
```

Atteso: `Test Files  6 passed`; `tsc` senza output. `prestampati-modelli-segreteria` legge il sorgente cercando `const ctx = {`, che non è cambiato.

- [ ] **Passo 8: commit**

```bash
git add src/lib/pagamenti/solleciti-invio.ts __tests__/api/pagamenti-solleciti-invio.test.ts
git commit -m "$(cat <<'EOF'
Solleciti: senza nessuna email partita la presa si annulla (sessione 9)

Se nessun destinatario è stato raggiunto e l'esito è certo, ultimo_sollecito_il torna al
valore di prima con un UPDATE condizionato sulla presa (se un altro giro l'ha ripresa,
resta la sua); esito ok:false, riga `sollecito-non-recapitato` a error col motivo
sanificato, niente push. Esito incerto: la presa resta, riga `warn`. Il registro si
scrive sempre, con l'esito per destinatario. Esiti con `inviate` e `tentate`. Nessun
destinatario con un indirizzo: niente presa, un `warn`.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — Il battito del giro dice inviate, fallite, rinviate

**File:**
- Modifica: `src/app/api/pagamenti/solleciti/run/route.ts:212-239`
- Test: `__tests__/api/pagamenti-solleciti-invio.test.ts` (in fondo)

- [ ] **Passo 1: scrivi i test (rossi)**

In fondo a `__tests__/api/pagamenti-solleciti-invio.test.ts` aggiungi:

```ts

describe('POST /api/pagamenti/solleciti/run — il battito dice com’è andata (sessione 9)', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    h.settingsRows = [{ scuola_id: 'sc-1', solleciti_config: { enabled: true } }]
    h.utenti = [{ id: 'g-1', email: 'genitore.uno@example.test' }]
  })
  const battiti = () => h.logEvento.mock.calls.filter((c) =>
    c[0] === 'cron' && ['ok', 'ok-parziale'].includes((c[2] as { esito?: string }).esito ?? ''))

  it('nessuna email partita ⇒ battito `ok-parziale` a `warn`, con le voci fallite e le email tentate', async () => {
    h.sendEmailDetailed.mockImplementation(async () => {
      h.sequenza.push('email')
      return { ok: false, error: 'rifiutato dal provider email (500): errore finto' }
    })
    const res = await RUN(runReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, inviati: 0, fallite: 1, esaminati: 1, rinviati: 0 })
    const b = battiti()
    expect(b).toHaveLength(1)
    expect(b[0][1]).toBe('warn')
    expect(b[0][2]).toMatchObject({
      operazione: 'pagamenti-solleciti', esito: 'ok-parziale', inviati: 0, fallite: 1,
      email_inviate: 0, email_tentate: 1, msg: 'pagamenti-solleciti: ok-parziale',
    })
  })

  it('tutto partito ⇒ battito `ok` a `info`, con le email inviate', async () => {
    const res = await RUN(runReq())
    expect(await res.json()).toMatchObject({ success: true, inviati: 1, fallite: 0 })
    const b = battiti()
    expect(b).toHaveLength(1)
    expect(b[0][1]).toBe('info')
    expect(b[0][2]).toMatchObject({ esito: 'ok', fallite: 0, email_inviate: 1, email_tentate: 1 })
  })

  it('il giro automatico chiede i ritentativi con la scadenza del giro; il bottone no', async () => {
    await RUN(runReq())
    expect(typeof h.sendEmailDetailed.mock.calls[0][0].ritentativi?.scadenza).toBe('number')
    h.sendEmailDetailed.mockClear()
    await POST(post({ pagamento_ids: [PID] }))
    expect(h.sendEmailDetailed.mock.calls[0][0].ritentativi).toBeUndefined()
  })
})
```

- [ ] **Passo 2: eseguili e guardali fallire**

```bash
npx vitest run __tests__/api/pagamenti-solleciti-invio.test.ts -t "il battito dice" 2>&1 | tail -12
```

Atteso: i primi due rossi (`fallite`, `email_inviate`, `email_tentate` assenti, battito `ok` a `info` anche senza email); il terzo è già verde dal Compito 6.

- [ ] **Passo 3: il codice**

In `src/app/api/pagamenti/solleciti/run/route.ts` sostituisci il blocco da `    const esiti = await sollecitaPagamenti(` (riga 212) a `    return NextResponse.json({ success: true, inviati, esaminati: ids.length, rinviati })` (riga 239), estremi compresi, con:

```ts
    const esiti = await sollecitaPagamenti(supabase, ids, { automatico: true, scadenza: t0 + TETTO_GIRO_MS })
    const inviati = esiti.filter((e) => e.ok).length
    const guasti = esiti.filter((e) => e.guasto).length
    const rinviati = esiti.filter((e) => e.rinviato).length
    // Sessione 9: una voce «fallita» è una voce in cui si è TENTATA almeno un'email e nessuna è
    // partita (o l'esito è incerto). Le voci saltate per regola (cadenza, saldo, livello non
    // maturo, nessun indirizzo) non tentano niente e non contano.
    const fallite = esiti.filter((e) => !e.ok && (e.tentate ?? 0) > 0).length
    const emailInviate = esiti.reduce((n, e) => n + (e.inviate ?? 0), 0)
    const emailTentate = esiti.reduce((n, e) => n + (e.tentate ?? 0), 0)
    if (guasti > 0) {
      // Voci non lette o cadenze non scritte: il giro NON è andato bene, e il battito
      // «ok» lo direbbe. Le righe col codice PostgREST le ha già scritte il motore.
      logEvento('cron', 'error', {
        operazione: JOB, esito: 'solleciti-con-guasti', ms: Date.now() - t0,
        guasti, inviati, fallite, rinviati, email_inviate: emailInviate, email_tentate: emailTentate,
        esaminati: ids.length,
        msg: `${JOB}: ${guasti} voci non sollecitate per un guasto`,
      })
      return erroreInterno()
    }
    // `esaminati`, `inviati`, `fallite` ed `email_tentate` insieme: se divergono, i solleciti
    // partono ma non arrivano — il guasto silenzioso che è già costato mesi di email di
    // credenziali mai consegnate. Una voce fallita fa `ok-parziale` a `warn`: è un battito (la
    // salute lo legge, `ESITI_BATTITO`), ma in tabella non sembra una notte normale.
    const parziale = fallite > 0
    const esito = parziale ? 'ok-parziale' : 'ok'
    logEvento('cron', parziale ? 'warn' : 'info', {
      operazione: JOB,
      esito,
      ms: Date.now() - t0,
      scuole_attive: abilitate.length,
      inviati,
      fallite,
      rinviati,
      email_inviate: emailInviate,
      email_tentate: emailTentate,
      esaminati: ids.length,
      msg: `${JOB}: ${esito}`,
    })
    return NextResponse.json({ success: true, inviati, fallite, esaminati: ids.length, rinviati })
```

- [ ] **Passo 4: eseguili e guardali passare**

```bash
npx vitest run __tests__/api/pagamenti-solleciti-invio.test.ts __tests__/api/cron-battito.test.ts __tests__/api/cron-secret.test.ts __tests__/api/health.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  4 passed`. `__tests__/api/health.test.ts` è quello che conosce già `ok-parziale` fra gli esiti del battito. Controlla che la riga `Test Files` conti quattro file: vitest su un file inesistente esce 0 senza dirlo.

- [ ] **Passo 5: commit**

```bash
git add src/app/api/pagamenti/solleciti/run/route.ts __tests__/api/pagamenti-solleciti-invio.test.ts
git commit -m "$(cat <<'EOF'
Giro dei solleciti: il battito dice inviate, fallite e rinviate (sessione 9)

Il battito porta `fallite`, `email_inviate`, `email_tentate`; con una voce fallita
diventa `ok-parziale` a warn (già fra gli ESITI_BATTITO). La risposta porta `fallite`.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8 — Lo storico dei solleciti dice se è arrivato

**File:**
- Modifica: `src/lib/storici/adattatori/servizi-contabilita.ts`, dopo la riga 16 e righe 133-137
- Test: `__tests__/lib/storici-servizi.test.ts`, prima della riga 526

Dal Compito 6 il registro contiene anche i tentativi falliti: lo storico che la segreteria stampa li mostrerebbe come solleciti inviati.

- [ ] **Passo 1: scrivi il test (rosso)**

In `__tests__/lib/storici-servizi.test.ts`, subito prima di `  it.each<CategoriaStorico>(['servizi_armadietto', …` (riga 526), aggiungi:

```ts
  it('solleciti: la colonna «Recapitato» dice se almeno una email è partita, senza mostrare indirizzi', async () => {
    const base = { alunno_id: A, scuola_id: SCUOLA, livello: 1, canale: 'email', oggetto: 'Promemoria', corpo: 'Testo di prova', automatico: true }
    const { ctx, letture } = contesto({ solleciti: [
      { ...base, id: 's-1', inviato_il: '2026-01-12T10:00:00Z', destinatari: [{ id: 'g-1', email: 'genitore.uno@example.test', inviata: true }] },
      { ...base, id: 's-2', inviato_il: '2026-01-13T10:00:00Z', destinatari: [{ id: 'g-1', email: 'genitore.uno@example.test', inviata: false, incerta: true }] },
      { ...base, id: 's-3', inviato_il: '2026-01-14T10:00:00Z', destinatari: [{ id: 'g-1', email: 'genitore.uno@example.test', inviata: false }] },
    ] })
    const s = await raccogliServizio(ctx, 'contabilita_solleciti')
    expect(s?.colonne.map(c => c.titolo)).toContain('Recapitato')
    expect(s?.righe.map(r => r.recapitato)).toEqual(['Sì', 'Incerto', 'No'])
    expect(letture.find(l => l.tabella === 'solleciti')?.colonne).toContain('destinatari')
    expect(JSON.stringify(s)).not.toContain('example.test')
  })

```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/storici-servizi.test.ts 2>&1 | tail -8
```

Atteso: un rosso, `Recapitato` non fra le colonne.

- [ ] **Passo 3: il codice**

In `src/lib/storici/adattatori/servizi-contabilita.ts`, dopo la `}` che chiude `incassi` (riga 16), aggiungi:

```ts
/**
 * Sessione 9: il registro dei solleciti scrive anche i tentativi falliti. «Sì» = almeno una email
 * partita; «Incerto» = nessuna confermata, ma il provider potrebbe averne presa una; «No» =
 * nessuna partita. Gli indirizzi non escono mai dallo storico: si legge solo l'esito.
 */
function recapito(v: unknown): string {
  if (!Array.isArray(v)) return 'Non registrato'
  const d = v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
  if (d.some(x => x.inviata === true)) return 'Sì'
  if (d.some(x => x.incerta === true)) return 'Incerto'
  return 'No'
}
```

Poi sostituisci, nel ramo `contabilita_solleciti`:

```ts
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Inviato il'], ['livello', 'Livello'], ['canale', 'Canale'], ['oggetto', 'Oggetto'], ['corpo', 'Testo inviato'], ['automatico', 'Automatico']])
    s.righe = (await perAlunni(ctx, 'solleciti', 'id,alunno_id,scuola_id,inviato_il,livello,canale,oggetto,corpo,automatico', 'inviato_il', true)).map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: testo(r.inviato_il), livello: numero(r.livello), canale: testo(r.canale), oggetto: testo(r.oggetto), corpo: testo(r.corpo), automatico: r.automatico === true }))
```

con:

```ts
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Inviato il'], ['recapitato', 'Recapitato'], ['livello', 'Livello'], ['canale', 'Canale'], ['oggetto', 'Oggetto'], ['corpo', 'Testo inviato'], ['automatico', 'Automatico']])
    s.righe = (await perAlunni(ctx, 'solleciti', 'id,alunno_id,scuola_id,inviato_il,livello,canale,oggetto,corpo,automatico,destinatari', 'inviato_il', true)).map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: testo(r.inviato_il), recapitato: recapito(r.destinatari), livello: numero(r.livello), canale: testo(r.canale), oggetto: testo(r.oggetto), corpo: testo(r.corpo), automatico: r.automatico === true }))
```

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/lib/storici-servizi.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed`.

- [ ] **Passo 5: commit**

```bash
git add src/lib/storici/adattatori/servizi-contabilita.ts __tests__/lib/storici-servizi.test.ts
git commit -m "$(cat <<'EOF'
Storico dei solleciti: colonna «Recapitato» (sessione 9)

Il registro scrive anche i tentativi falliti: lo storico dice Sì, Incerto o No per
riga, leggendo solo l'esito per destinatario, mai gli indirizzi.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 9 — La traduzione: tetto, un ritentativo, `fetch` osservato

**File:**
- Riscrive: `src/lib/translate/claude.ts` (69 righe)
- Modifica: `__tests__/architecture/provider-esterni-osservati.test.ts`, dopo la riga 109
- Test: `__tests__/lib/translate-claude-fornitore.test.ts`

Oggi `new Anthropic({ apiKey })` usa i default dello SDK 0.106.0: 10 minuti di timeout per tentativo, 2 ritentativi, l'attesa che chiede il fornitore senza tetto (`retry-after-ms` prima di `retry-after`), e nessuna riga per tentativo.

- [ ] **Passo 1: il lock dei provider (rosso)**

In `__tests__/architecture/provider-esterni-osservati.test.ts`, dopo la voce `instagram` (che finisce con `    }],` alla riga 109), aggiungi:

```ts
    ['anthropic (traduzione della chat)', {
        // Nessun host letterale: l'URL lo costruisce lo SDK (`@anthropic-ai/sdk`), che chiama il
        // `fetch` che gli si passa. Dalla sessione 9 quel `fetch` è `fetchOsservato`, cioè
        // `externalFetch('anthropic', …)`: il file è un chiamante come gli altri.
        host: [],
        chiamanti: ['src/lib/translate/claude.ts'],
        nome: 'anthropic',
    }],
```

- [ ] **Passo 2: il test del fornitore (rosso)**

Crea `__tests__/lib/translate-claude-fornitore.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * SESSIONE 9 (seconda serie di robustezza) — la traduzione col fornitore osservato.
 *
 * Lo SDK VERO (`@anthropic-ai/sdk`), con un `fetch` finto sotto `externalFetch`: si guarda quante
 * chiamate fa, con che tetto nasce il client, e che righe lascia. Ambiente `node`: in jsdom lo
 * SDK si rifiuta di partire («browser-like environment»). Nessuna attesa vera: le attese che il
 * fornitore chiede qui sono 0.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import {
  translateText, opzioniClientTraduzione, fetchOsservato, TIMEOUT_TRADUZIONE_MS, RITENTATIVI_TRADUZIONE,
} from '@/lib/translate/claude'

const URL_MESSAGGI = 'https://api.anthropic.com/v1/messages'

/** Anthropic finto: risponde in ordine con `risposte` (l'ultima si ripete) e conta le chiamate. */
function anthropicFinto(risposte: Array<() => Response>): { n: number } {
  const conto = { n: 0 }
  vi.stubGlobal('fetch', vi.fn(async () => {
    conto.n++
    return (risposte[conto.n - 1] ?? risposte[risposte.length - 1])()
  }))
  return conto
}

const tradotto = (testo: string) => () => new Response(JSON.stringify({
  id: 'msg_finto', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: testo }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
}), { status: 200, headers: { 'content-type': 'application/json' } })

const rifiuto = (status: number, headers: Record<string, string> = {}) => () => new Response(
  JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
  { status, headers: { 'content-type': 'application/json', ...headers } },
)

/** Le righe di `externalFetch` per il fornitore: [livello, stato]. */
const righeFornitore = () => log.logEvento.mock.calls
  .filter((c) => c[0] === 'traduzione' && (c[2] as { operazione?: string }).operazione === 'messages:create')
  .map((c) => [c[1], (c[2] as { stato: number }).stato])

beforeEach(() => {
  log.logEvento.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('translateText — il fornitore con i numeri scritti', () => {
  it('il client nasce con tetto, ritentativi e fetch osservato espliciti', () => {
    expect(opzioniClientTraduzione('chiave-finta')).toEqual({
      apiKey: 'chiave-finta', timeout: TIMEOUT_TRADUZIONE_MS, maxRetries: RITENTATIVI_TRADUZIONE, fetch: fetchOsservato,
    })
    expect(TIMEOUT_TRADUZIONE_MS).toBe(20_000)
    expect(RITENTATIVI_TRADUZIONE).toBe(1)
  })

  it('successo: una chiamata, una riga `info` del fornitore con lo stato', async () => {
    const conto = anthropicFinto([tradotto('Good morning')])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r).toEqual({ translated: 'Good morning' })
    expect(conto.n).toBe(1)
    expect(righeFornitore()).toEqual([['info', 200]])
    const riga = log.logEvento.mock.calls.find((c) => (c[2] as { operazione?: string }).operazione === 'messages:create')
    expect(riga?.[2]).toMatchObject({ provider: 'anthropic', stato: 200 })
  })

  it('529 (sovraccarico) con `Retry-After: 0`, poi 200: UN ritentativo, due righe', async () => {
    const conto = anthropicFinto([rifiuto(529, { 'retry-after': '0' }), tradotto('Good morning')])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r.translated).toBe('Good morning')
    expect(conto.n).toBe(2)
    expect(righeFornitore()).toEqual([['warn', 529], ['info', 200]])
  })

  it('429 con `Retry-After: 30` (oltre 5 s): nessun ritentativo, traduzione nulla, riga `error`', async () => {
    const conto = anthropicFinto([rifiuto(429, { 'retry-after': '30' })])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r).toEqual({ translated: null })
    expect(conto.n).toBe(1)
    const fallita = log.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string }).esito === 'traduzione-fallita')
    expect(fallita).toHaveLength(1)
    expect(fallita[0][1]).toBe('error')
  })

  it('400 (definitivo): nessun ritentativo, riga `error` del fornitore', async () => {
    const conto = anthropicFinto([rifiuto(400)])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r).toEqual({ translated: null })
    expect(conto.n).toBe(1)
    expect(righeFornitore()).toEqual([['error', 400]])
  })
})

describe('fetchOsservato — il rifiuto tradotto per lo SDK', () => {
  it('500 con `Retry-After: 2` ⇒ `retry-after-ms: 2000`', async () => {
    anthropicFinto([rifiuto(500, { 'retry-after': '2' })])
    const res = await fetchOsservato(URL_MESSAGGI, { method: 'POST' })
    expect(res.status).toBe(500)
    expect(res.headers.get('retry-after-ms')).toBe('2000')
    expect(res.headers.get('x-should-retry')).toBeNull()
  })

  it('429 con `Retry-After: 30` ⇒ `x-should-retry: false`', async () => {
    anthropicFinto([rifiuto(429, { 'retry-after': '30' })])
    const res = await fetchOsservato(URL_MESSAGGI, { method: 'POST' })
    expect(res.status).toBe(429)
    expect(res.headers.get('x-should-retry')).toBe('false')
  })

  it('richiesta interrotta dallo SDK (il suo tetto) ⇒ `AbortError`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('This operation was aborted', 'AbortError') }))
    const c = new AbortController()
    c.abort()
    await expect(fetchOsservato(URL_MESSAGGI, { method: 'POST', signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rete giù ⇒ un errore, che lo SDK tratta come errore di connessione', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }))
    await expect(fetchOsservato(URL_MESSAGGI, { method: 'POST' })).rejects.toThrow(/fetch failed/)
  })
})
```

- [ ] **Passo 3: eseguili e guardali fallire**

```bash
npx vitest run __tests__/lib/translate-claude-fornitore.test.ts __tests__/architecture/provider-esterni-osservati.test.ts 2>&1 | tail -12
```

Atteso: `FAIL`. Il test del fornitore non trova `opzioniClientTraduzione`, `fetchOsservato` e le costanti; il lock dice `anthropic (traduzione della chat): src/lib/translate/claude.ts non chiama più externalFetch` e `non nomina più il provider 'anthropic'` (la seconda può non comparire: il file oggi nomina `'anthropic'` nella riga d'errore).

- [ ] **Passo 4: il codice**

Sostituisci l'intero contenuto di `src/lib/translate/claude.ts` con:

```ts
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { externalFetch } from '@/lib/logging/external'
import { logEvento, type Livello } from '@/lib/logging/logger'
import { msDaRetryAfter } from '@/lib/rete/retry-after'

// P4/DL-042 — Traduzione automatica chat (insegnante↔famiglie straniere) via Claude.
// Servizio gated su ANTHROPIC_API_KEY (dipendenza esterna, come Aruba): se la chiave
// manca, ritorna `disabled` e l'UI nasconde il pulsante "Traduci". Modello haiku
// (economico/veloce); nessun thinking/effort (non supportati/necessari).

const TRANSLATE_MODEL = 'claude-haiku-4-5'

/**
 * IL FORNITORE, CON I NUMERI SCRITTI (sessione 9 della seconda serie di robustezza).
 *
 * Prima: `new Anthropic({ apiKey })`, cioè i default dello SDK — 10 MINUTI di timeout per
 * tentativo e 2 ritentativi, con l'attesa che chiede il fornitore e nessun tetto. Una traduzione
 * appesa teneva aperta la Function di `chat/translate` fino al muro della piattaforma, e nessuna
 * riga diceva perché: la chiamata non passava da `externalFetch`.
 *
 * Ora: 20 s per tentativo, UN ritentativo, e un'attesa chiesta dal fornitore oltre i 5 s non si
 * aspetta (lo SDK riceve `x-should-retry: false`). Caso peggiore 20 + 5 + 20 = 45 s, dentro la
 * `maxDuration = 60` della route.
 */
export const TIMEOUT_TRADUZIONE_MS = 20_000
export const RITENTATIVI_TRADUZIONE = 1
export const ATTESA_MAX_TRADUZIONE_MS = 5_000

export interface TranslateResult {
  translated: string | null
  disabled?: boolean
}

// Interfaccia minima per dependency-injection nei test (no rete).
type Translator = {
  messages: {
    create: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export function isTranslationEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

/** Ciò che lo SDK ritenta da sé (`shouldRetry`): 408, 409, 429, 5xx, e nessuna risposta. */
function ritentabileDallSdk(stato: number): boolean {
  return stato === 0 || stato === 408 || stato === 409 || stato === 429 || stato >= 500
}

function urlDi(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Gli header che lo SDK legge per decidere se e quando ritentare. `retry-after-ms` vince su
 * `retry-after` ed è letto senza tetto: il tetto lo mettiamo qui.
 */
function intestazioniDelRifiuto(retryAfter: string | undefined): Record<string, string> {
  const ms = msDaRetryAfter(retryAfter)
  if (ms === undefined) return {}
  if (ms > ATTESA_MAX_TRADUZIONE_MS) return { 'x-should-retry': 'false' }
  return { 'retry-after-ms': String(ms) }
}

/**
 * Il `fetch` che lo SDK usa. Passa da `externalFetch`, quindi ogni tentativo lascia la sua riga
 * (`evento: 'traduzione'`, `provider: 'anthropic'`, lo stato, i millisecondi, il corpo del
 * rifiuto nel messaggio) e nessuno status resta nudo (AGENTS.md, regola 3).
 *
 * `externalFetch` non lancia mai; lo SDK invece si aspetta una Response o un'eccezione. Quindi:
 *  · successo → la Response vera, col corpo intatto;
 *  · rifiuto HTTP → una Response ricostruita con lo stesso status e lo stesso corpo, più gli
 *    header di `intestazioniDelRifiuto`;
 *  · nessuna risposta → un'eccezione: `AbortError` se lo SDK aveva interrotto (il suo tetto di
 *    20 s), un errore di connessione altrimenti. Lo SDK le riconosce e decide se ritentare.
 * Il segnale dello SDK passa intatto e vince sul tetto di `externalFetch`.
 */
export async function fetchOsservato(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const esito = await externalFetch('anthropic', urlDi(input), init, {
    evento: 'traduzione',
    campi: { operazione: 'messages:create' },
    gravita: (stato: number): Livello => (ritentabileDallSdk(stato) ? 'warn' : 'error'),
  })
  if (esito.ok && esito.res) return esito.res
  if (esito.stato === 0) {
    const errore = new Error(esito.corpo || 'nessuna risposta dal fornitore della traduzione')
    if (init?.signal?.aborted) errore.name = 'AbortError'
    throw errore
  }
  const stato = esito.stato >= 400 && esito.stato <= 599 ? esito.stato : 502
  return new Response(esito.corpo, { status: stato, headers: intestazioniDelRifiuto(esito.retryAfter) })
}

/** Le opzioni del client: esportate perché il test le confronti per intero. */
export function opzioniClientTraduzione(apiKey: string): ClientOptions {
  return { apiKey, timeout: TIMEOUT_TRADUZIONE_MS, maxRetries: RITENTATIVI_TRADUZIONE, fetch: fetchOsservato }
}

export async function translateText(
  text: string,
  targetLang: string,
  opts?: { apiKey?: string | undefined; client?: Translator },
): Promise<TranslateResult> {
  const apiKey = opts?.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { translated: null, disabled: true }

  const trimmed = (text ?? '').trim()
  if (!trimmed) return { translated: '' }

  const client: Translator = opts?.client ?? (new Anthropic(opzioniClientTraduzione(apiKey)) as unknown as Translator)
  try {
    const res = await client.messages.create({
      model: TRANSLATE_MODEL,
      max_tokens: 1024,
      system: `Sei un traduttore. Traduci il messaggio dell'utente nella lingua con codice "${targetLang}". Rispondi SOLO con la traduzione, senza preamboli, virgolette o note. Mantieni il tono colloquiale e gli eventuali emoji.`,
      messages: [{ role: 'user', content: trimmed }],
    })
    const out = res.content.find((b) => b.type === 'text')?.text?.trim() ?? null
    return { translated: out }
  } catch (e) {
    // Provider esterno: l'errore va conservato INTERO (l'SDK porta status e corpo
    // della risposta) — uno status nudo non distingue "chiave scaduta" da "rate
    // limit". Il TESTO da tradurre non va mai a log: è un messaggio di chat fra
    // una famiglia e un docente. A log restano la lingua di destinazione e la
    // lunghezza, che bastano a riprodurre il caso. Ogni tentativo ha già la sua
    // riga da `fetchOsservato`.
    logEvento(
      'traduzione',
      'error',
      {
        operazione: 'translateText',
        provider: 'anthropic',
        esito: 'traduzione-fallita',
        lingua: targetLang,
        caratteri: trimmed.length,
      },
      e,
    )
    return { translated: null }
  }
}
```

- [ ] **Passo 5: eseguili e guardali passare**

```bash
npx vitest run __tests__/lib/translate-claude-fornitore.test.ts __tests__/lib/translate-claude.test.ts __tests__/api/chat-translate.test.ts __tests__/architecture/provider-esterni-osservati.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | head -10
```

Atteso: `Test Files  4 passed`; `tsc` senza output. Nel file non c'è nessun `fetch(` letterale (regola 2 del lock): `fetchOsservato(` e `fetch: fetchOsservato` non lo sono.

- [ ] **Passo 6: commit**

```bash
git add src/lib/translate/claude.ts __tests__/lib/translate-claude-fornitore.test.ts __tests__/architecture/provider-esterni-osservati.test.ts
git commit -m "$(cat <<'EOF'
Traduzione della chat: 20 s per tentativo, un ritentativo, fetch osservato (sessione 9)

Il client Anthropic nasce con timeout 20 s, maxRetries 1 e un fetch che passa da
externalFetch: una riga per tentativo, warn se lo SDK ritenterà, error se è definitivo.
Un'attesa chiesta oltre 5 s diventa x-should-retry: false. Caso peggiore 45 s.
`anthropic` entra fra i provider osservati del lock.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 10 — `news/cron/run` con `segretoCronValido`

**File:**
- Modifica: `src/app/api/news/cron/run/route.ts:13` e `:294`
- Test: `__tests__/lib/segreto-cron-tempo-costante.test.ts:85-92`

Se il Passo 5 del Compito 1 ha trovato `segretoCronValido` già in `news/cron/run`, salta i Passi 3 e 4 e svuota solo il debito, se c'è ancora.

- [ ] **Passo 1: il debito si svuota (rosso)**

In `__tests__/lib/segreto-cron-tempo-costante.test.ts` sostituisci:

```ts
    /**
     * DEBITO DICHIARATO. `news/cron/run` è in lavorazione da un altro intervento
     * nello stesso ciclo (il ricontrollo del consenso fotografico sui post
     * pubblicati): toccarlo qui avrebbe sovrascritto quel lavoro. Va portato alla
     * funzione condivisa appena quel lavoro è dentro. Questa mappa può solo
     * accorciarsi.
     */
    const DEBITO = new Set(['src/app/api/news/cron/run/route.ts'])
```

con:

```ts
    /**
     * DEBITO DICHIARATO. Era `news/cron/run`, rimasto fuori perché un altro intervento
     * dello stesso ciclo ci stava lavorando; portato a `segretoCronValido` nella sessione 9
     * della seconda serie di robustezza. Vuota: questa mappa può solo accorciarsi, e ora
     * qualunque route che confronta il segreto a mano fa rosso.
     */
    const DEBITO = new Set<string>([])
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/lib/segreto-cron-tempo-costante.test.ts 2>&1 | tail -10
```

Atteso: `FAIL`, con `src/app/api/news/cron/run/route.ts` nell'elenco dei confronti a mano.

- [ ] **Passo 3: il codice**

In `src/app/api/news/cron/run/route.ts` sostituisci:

```ts
import { verificaPermanenzaConsenso } from '@/lib/news/permanenza-consenso'
```

con:

```ts
import { verificaPermanenzaConsenso } from '@/lib/news/permanenza-consenso'
import { segretoCronValido } from '@/lib/security/segreto-cron'
```

e sostituisci:

```ts
    if (!secret || secret !== process.env.CRON_SECRET) {
```

con:

```ts
    // Confronto a tempo costante e fail-closed senza `CRON_SECRET` (sessione 9): lo stesso di
    // tutte le altre route del cron.
    if (!segretoCronValido(secret)) {
```

- [ ] **Passo 4: eseguili e guardali passare**

```bash
npx vitest run __tests__/lib/segreto-cron-tempo-costante.test.ts __tests__/api/news-cron.test.ts __tests__/api/news-cron-permanenza.test.ts __tests__/api/cron-secret.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  4 passed`. Il controllo positivo del lock resta verde: il file nomina ancora `CRON_SECRET` nel messaggio d'errore.

- [ ] **Passo 5: commit**

```bash
git add src/app/api/news/cron/run/route.ts __tests__/lib/segreto-cron-tempo-costante.test.ts
git commit -m "$(cat <<'EOF'
news/cron/run: il segreto del cron con segretoCronValido (sessione 9)

Confronto a tempo costante e fail-closed come le altre route del cron; il debito
dichiarato del lock segreto-cron-tempo-costante si svuota.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 11 — `maxDuration` sulle route lunghe, e il lock che le pretende

**File:**
- Modifica: `__tests__/architecture/cron-max-duration.test.ts`, per contenuto (il file lo allarga prima la sessione 8, che aggiunge due `import` dopo la riga 3 e il blocco `CHIAMANTI_CRON` in fondo, senza toccare queste righe): la riga `import { readFileSync, readdirSync, statSync } from 'node:fs'` (la 2 del 20/10), la fine del commento di testa `* numerico: Next lo legge staticamente…` (5-19), la funzione `function violazione(sorgente: string)` (49-58), e la fine del file, dopo l'ultimo blocco che vi trovi
- Modifica: le venti route qui sotto, due righe dopo l'ultimo import
- Crea, fuori dal repository: `${TMPDIR:-/tmp}/s09-max-duration.mjs`

La specifica dice «`maxDuration` sulle 20 route lunghe (19 a 300 s, `chat/translate` a 60 s)» senza elencarle. Il criterio scritto qui sotto (invii in fila, PDF o fogli composti sul server, import ed eliminazioni in blocco, la traduzione) ne dà proprio **venti**, tutte oggi senza `maxDuration`; dieci importano un lavoro pesante (`jspdf`, `xlsx`, la traduzione, il ritmo delle email), e sono tutte fra le venti. Il valore: **300 s** (il default di oggi con Fluid, Passo 12 del Compito 2, reso esplicito) su diciannove, **60 s** sulla traduzione, dove il caso peggiore è 45 s.

| Route (`src/app/api/…/route.ts`) | s | Perché |
|---|---|---|
| `chat/translate` | 60 | traduzione con Claude: 20 s per tentativo, un ritentativo, attesa massima 5 s, 45 s nel caso peggiore |
| `admin/iscrizioni/rinvia-credenziali` | 300 | fino a 100 email in fila, con la pausa fra una e la successiva e il tetto di 10 s di Resend per ciascuna |
| `admin/candidature-insegnanti/inoltro-arretrato` | 300 | fino a 60 inoltri con il curriculum allegato, in fila, con il tetto di 10 s di Resend per ciascuno |
| `admin/registro-presenze/pdf` | 300 | PDF mensile delle presenze di una classe intera, composto sul server |
| `primaria/pagella/batch` | 300 | una pagella PDF per alunno, in sequenza, per tutta la classe |
| `admin/competenze/genera` | 300 | genera e firma un certificato delle competenze per ogni id ricevuto |
| `forms/export/pdf` | 300 | jsPDF con le risposte di un modulo, pagina per pagina, per tutta la sede |
| `forms/export/xlsx` | 300 | foglio xlsx in memoria con tutte le risposte di un modulo |
| `forms/export/delibera` | 300 | delibera in jsPDF con la lista completa delle adesioni |
| `pagamenti/export` | 300 | foglio xlsx con lo scadenziario di una sede |
| `admin/merch/export` | 300 | foglio xlsx con gli ordini di divise e merchandising |
| `admin/protocolli/export` | 300 | foglio xlsx con il registro di protocollo di un anno intero |
| `avvisi/[id]/risposte/esporta` | 300 | CSV con tutte le adesioni a un avviso, una riga per risposta |
| `prestampati/genera` | 300 | modello, Storage, PDF, protocollo e caricamento nel fascicolo, in sequenza |
| `admin/sidi/import` | 300 | riceve, decomprime e importa lo zip del SIDI |
| `admin/import/anagrafiche` | 300 | fino a 2.000 righe di anagrafiche, con la deduplica sul codice fiscale |
| `pagamenti/genera` | 300 | voci e rate per ogni alunno di una classe o di un elenco |
| `admin/gdpr/erase` | 300 | file nello Storage e molte tabelle, genitore per genitore |
| `admin/students/libera-spazio` | 300 | rimuove foto, video e messaggi di un alunno dallo Storage |
| `admin/iscrizioni/elenco/export` | 300 | foglio xlsx con tutte le domande di iscrizione della sede |

- [ ] **Passo 1: il lock allargato (rosso)**

In `__tests__/architecture/cron-max-duration.test.ts` sostituisci:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
```

con:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
```

Sostituisci:

```ts
 * numerico: Next lo legge staticamente, e un `maxDuration = COSTANTE` importata non vale.
 */
```

con:

```ts
 * numerico: Next lo legge staticamente, e un `maxDuration = COSTANTE` importata non vale.
 *
 * SESSIONE 9 DELLA SECONDA SERIE: il lock vale anche per le route LUNGHE che non sono del cron
 * (esportazioni, PDF in blocco, invii in fila, la traduzione). Ognuna sta in `ROUTE_LUNGHE` col
 * suo perché, e una route che importa un lavoro pesante (`IMPORT_PESANTE`) senza starci, e senza
 * essere del cron, fa rosso.
 */
```

Sostituisci:

```ts
/** `null` = in regola; altrimenti la violazione, in parole. */
function violazione(sorgente: string): string | null {
  const codice = senzaCommenti(sorgente)
  if (!CRON.test(codice)) return null
  const m = DICHIARAZIONE.exec(codice)
  if (!m) return 'manca `export const maxDuration = <secondi>` (letterale numerico)'
  const s = Number(m[1])
  if (s < 60 || s > MASSIMO_S) return `maxDuration = ${s}: fuori da 60…${MASSIMO_S} s`
  return null
}
```

con:

```ts
/** Il valore dichiarato, o `null` se manca (o non è un letterale numerico). Commenti già tolti. */
function durataDichiarata(codice: string): number | null {
  const m = DICHIARAZIONE.exec(codice)
  return m ? Number(m[1]) : null
}

/** `null` = in regola; altrimenti cosa non va, in parole. */
function fuoriMisura(s: number | null): string | null {
  if (s === null) return 'manca `export const maxDuration = <secondi>` (letterale numerico)'
  if (s < 60 || s > MASSIMO_S) return `maxDuration = ${s}: fuori da 60…${MASSIMO_S} s`
  return null
}

/** `null` = in regola; altrimenti la violazione, in parole. */
function violazione(sorgente: string): string | null {
  const codice = senzaCommenti(sorgente)
  if (!CRON.test(codice)) return null
  return fuoriMisura(durataDichiarata(codice))
}
```

In fondo al file (dopo l'ultimo `})`: se la sessione 8 è già uscita, dopo il suo blocco `CHIAMANTI_CRON`) aggiungi:

```ts

/**
 * LE ROUTE LUNGHE CHE NON SONO DEL CRON (sessione 9 della seconda serie di robustezza).
 *
 * Senza `maxDuration` una route vive quanto il default del piano, e il giorno in cui il default
 * cambia (o il progetto passa a un altro piano) un'esportazione grande o un invio in fila muore a
 * metà senza che nessun file lo dica. Qui ogni route lunga sta con il suo perché: il numero lo
 * scrive la route, la ragione la scrive questa mappa. Una route nuova che importa un lavoro
 * pesante e non è qui fa rosso (`IMPORT_PESANTE`).
 */
const ROUTE_LUNGHE = new Map<string, string>([
  ['src/app/api/chat/translate/route.ts', 'traduzione con Claude: 20 s per tentativo, un ritentativo, attesa massima 5 s, 45 s nel caso peggiore'],
  ['src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts', 'fino a 100 email in fila, con la pausa fra una e la successiva e il tetto di 10 s di Resend per ciascuna'],
  ['src/app/api/admin/candidature-insegnanti/inoltro-arretrato/route.ts', 'fino a 60 inoltri con il curriculum allegato, in fila, con il tetto di 10 s di Resend per ciascuno'],
  ['src/app/api/admin/registro-presenze/pdf/route.ts', 'PDF mensile delle presenze di una classe intera, composto sul server'],
  ['src/app/api/primaria/pagella/batch/route.ts', 'una pagella PDF per alunno, in sequenza, per tutta la classe'],
  ['src/app/api/admin/competenze/genera/route.ts', 'genera e firma un certificato delle competenze per ogni id ricevuto'],
  ['src/app/api/forms/export/pdf/route.ts', 'jsPDF con le risposte di un modulo, pagina per pagina, per tutta la sede'],
  ['src/app/api/forms/export/xlsx/route.ts', 'foglio xlsx in memoria con tutte le risposte di un modulo'],
  ['src/app/api/forms/export/delibera/route.ts', 'delibera in jsPDF con la lista completa delle adesioni'],
  ['src/app/api/pagamenti/export/route.ts', 'foglio xlsx con lo scadenziario di una sede'],
  ['src/app/api/admin/merch/export/route.ts', 'foglio xlsx con gli ordini di divise e merchandising'],
  ['src/app/api/admin/protocolli/export/route.ts', 'foglio xlsx con il registro di protocollo di un anno intero'],
  ['src/app/api/avvisi/[id]/risposte/esporta/route.ts', 'CSV con tutte le adesioni a un avviso, una riga per risposta'],
  ['src/app/api/prestampati/genera/route.ts', 'modello, Storage, PDF, protocollo e caricamento nel fascicolo, in sequenza'],
  ['src/app/api/admin/sidi/import/route.ts', 'riceve, decomprime e importa lo zip del SIDI'],
  ['src/app/api/admin/import/anagrafiche/route.ts', 'fino a 2.000 righe di anagrafiche, con la deduplica sul codice fiscale'],
  ['src/app/api/pagamenti/genera/route.ts', 'voci e rate per ogni alunno di una classe o di un elenco'],
  ['src/app/api/admin/gdpr/erase/route.ts', 'file nello Storage e molte tabelle, genitore per genitore'],
  ['src/app/api/admin/students/libera-spazio/route.ts', 'rimuove foto, video e messaggi di un alunno dallo Storage'],
  ['src/app/api/admin/iscrizioni/elenco/export/route.ts', 'foglio xlsx con tutte le domande di iscrizione della sede'],
])
/** Contate il 2026-10-20. Se l'elenco scende sotto, qualcuno l'ha accorciato senza dirlo. */
const MINIMO_ROUTE_LUNGHE = 20

/** Un import che vuol dire «questa route lavora a lungo». */
const IMPORT_PESANTE = /from\s+['"](jspdf|jspdf-autotable|xlsx|pdf-lib|jszip|exceljs|@\/lib\/translate\/claude|@\/lib\/email\/ritmo)['"]/
/** Le route con un import pesante contate il 2026-10-20 (cron comprese): il controllo positivo. */
const MINIMO_IMPORT_PESANTI = 10

describe('lock — anche le route lunghe che non sono del cron dichiarano maxDuration (sessione 9)', () => {
  const tutte = routeFiles(API)

  it(`l'elenco ha almeno ${MINIMO_ROUTE_LUNGHE} route, e ogni file esiste`, () => {
    expect(ROUTE_LUNGHE.size).toBeGreaterThanOrEqual(MINIMO_ROUTE_LUNGHE)
    const mancanti = [...ROUTE_LUNGHE.keys()].filter((f) => !existsSync(join(RADICE, f)))
    expect(mancanti, mancanti.join('\n')).toEqual([])
  })

  it('ogni voce dice perché, in almeno 20 caratteri', () => {
    const corte = [...ROUTE_LUNGHE].filter(([, perche]) => perche.trim().length < 20).map(([f]) => f)
    expect(corte).toEqual([])
  })

  it('ogni route lunga dichiara una vita fra 60 e 800 s', () => {
    const fuori = [...ROUTE_LUNGHE.keys()]
      .filter((f) => existsSync(join(RADICE, f)))
      .map((f) => ({ f, v: fuoriMisura(durataDichiarata(senzaCommenti(readFileSync(join(RADICE, f), 'utf8')))) }))
      .filter((x) => x.v !== null)
      .map((x) => `${x.f}: ${x.v}`)
    expect(fuori, fuori.join('\n')).toEqual([])
  })

  it(`ogni route con un import pesante è nell'elenco o è del cron (controllo positivo: almeno ${MINIMO_IMPORT_PESANTI})`, () => {
    const pesanti = tutte
      .map((f) => ({ rel: relative(RADICE, f), codice: senzaCommenti(readFileSync(f, 'utf8')) }))
      .filter((x) => IMPORT_PESANTE.test(x.codice))
    expect(pesanti.length).toBeGreaterThanOrEqual(MINIMO_IMPORT_PESANTI)
    const scoperte = pesanti.filter((x) => !ROUTE_LUNGHE.has(x.rel) && !CRON.test(x.codice)).map((x) => x.rel)
    expect(scoperte, `route con un import pesante, fuori da ROUTE_LUNGHE: aggiungile col perché\n${scoperte.join('\n')}`).toEqual([])
  })

  it('il rilevatore morde', () => {
    expect(IMPORT_PESANTE.test("import { jsPDF } from 'jspdf'")).toBe(true)
    expect(IMPORT_PESANTE.test("import * as XLSX from 'xlsx'")).toBe(true)
    expect(IMPORT_PESANTE.test("import { translateText } from '@/lib/translate/claude'")).toBe(true)
    expect(IMPORT_PESANTE.test("import { z } from 'zod'")).toBe(false)
    expect(IMPORT_PESANTE.test(senzaCommenti("// import { jsPDF } from 'jspdf'\n"))).toBe(false)
    expect(fuoriMisura(durataDichiarata('export const maxDuration = 30\n'))).toMatch(/fuori/)
    expect(fuoriMisura(durataDichiarata('const x = 1\n'))).toMatch(/manca/)
    expect(fuoriMisura(durataDichiarata('export const maxDuration = 300\n'))).toBeNull()
  })
})
```

- [ ] **Passo 2: eseguilo e guardalo fallire**

```bash
npx vitest run __tests__/architecture/cron-max-duration.test.ts 2>&1 | tail -30
```

Atteso: `FAIL` sul solo caso «ogni route lunga dichiara una vita fra 60 e 800 s», con le venti route e `manca \`export const maxDuration = <secondi>\``. Gli altri casi, compresi quelli di prima, verdi.

- [ ] **Passo 3: le venti dichiarazioni, con uno script che rispetta i byte**

Lo script inserisce le due righe dopo l'ultimo import. Lavora sui **byte**, perché `admin/iscrizioni/elenco/export/route.ts` contiene un carattere NUL voluto dentro una template string (riga della chiave delle anomalie) e un editor di testo lo rifiuterebbe; il punto e virgola finale c'è solo dove l'ultimo import ce l'ha (`avvisi/[id]/risposte/esporta` e `admin/import/anagrafiche`).

```bash
cat > "${TMPDIR:-/tmp}/s09-max-duration.mjs" <<'EOF'
// Sessione 9: `export const maxDuration` dopo l'ultimo import delle route lunghe.
// Si lavora sui byte (latin1 = un byte per carattere), così gli offset restano offset di byte.
import { readFileSync, writeFileSync } from 'node:fs'

const VOCI = [
  ['src/app/api/chat/translate/route.ts', 60, "traduzione con Claude: 20 s per tentativo, un ritentativo, attesa massima 5 s, 45 s nel caso peggiore"],
  ['src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts', 300, "fino a 100 email in fila, con la pausa fra una e la successiva e il tetto di 10 s di Resend per ciascuna"],
  ['src/app/api/admin/candidature-insegnanti/inoltro-arretrato/route.ts', 300, "fino a 60 inoltri con il curriculum allegato, in fila, con il tetto di 10 s di Resend per ciascuno"],
  ['src/app/api/admin/registro-presenze/pdf/route.ts', 300, "PDF mensile delle presenze di una classe intera, composto sul server"],
  ['src/app/api/primaria/pagella/batch/route.ts', 300, "una pagella PDF per alunno, in sequenza, per tutta la classe"],
  ['src/app/api/admin/competenze/genera/route.ts', 300, "genera e firma un certificato delle competenze per ogni id ricevuto"],
  ['src/app/api/forms/export/pdf/route.ts', 300, "jsPDF con le risposte di un modulo, pagina per pagina, per tutta la sede"],
  ['src/app/api/forms/export/xlsx/route.ts', 300, "foglio xlsx in memoria con tutte le risposte di un modulo"],
  ['src/app/api/forms/export/delibera/route.ts', 300, "delibera in jsPDF con la lista completa delle adesioni"],
  ['src/app/api/pagamenti/export/route.ts', 300, "foglio xlsx con lo scadenziario di una sede"],
  ['src/app/api/admin/merch/export/route.ts', 300, "foglio xlsx con gli ordini di divise e merchandising"],
  ['src/app/api/admin/protocolli/export/route.ts', 300, "foglio xlsx con il registro di protocollo di un anno intero"],
  ['src/app/api/avvisi/[id]/risposte/esporta/route.ts', 300, "CSV con tutte le adesioni a un avviso, una riga per risposta"],
  ['src/app/api/prestampati/genera/route.ts', 300, "modello, Storage, PDF, protocollo e caricamento nel fascicolo, in sequenza"],
  ['src/app/api/admin/sidi/import/route.ts', 300, "riceve, decomprime e importa lo zip del SIDI"],
  ['src/app/api/admin/import/anagrafiche/route.ts', 300, "fino a 2.000 righe di anagrafiche, con la deduplica sul codice fiscale"],
  ['src/app/api/pagamenti/genera/route.ts', 300, "voci e rate per ogni alunno di una classe o di un elenco"],
  ['src/app/api/admin/gdpr/erase/route.ts', 300, "file nello Storage e molte tabelle, genitore per genitore"],
  ['src/app/api/admin/students/libera-spazio/route.ts', 300, "rimuove foto, video e messaggi di un alunno dallo Storage"],
  ['src/app/api/admin/iscrizioni/elenco/export/route.ts', 300, "foglio xlsx con tutte le domande di iscrizione della sede"],
]

// Un import, anche su più righe: da `import` a inizio riga fino al primo specificatore fra apici.
const IMPORT = /^import\b[\s\S]*?['"][^'"\n]+['"];?[ \t]*$/gm

for (const [file, secondi, perche] of VOCI) {
  const byte = readFileSync(file)
  const testo = byte.toString('latin1')
  if (/export const maxDuration/.test(testo)) throw new Error(`${file}: maxDuration c'è già`)
  const importi = [...testo.matchAll(IMPORT)]
  if (importi.length === 0) throw new Error(`${file}: nessun import trovato`)
  const ultimo = importi[importi.length - 1]
  const fine = ultimo.index + ultimo[0].length
  const semi = ultimo[0].trimEnd().endsWith(';') ? ';' : ''
  const blocco = Buffer.from(`\n\n// Vita massima dichiarata (sessione 9): ${perche}.\nexport const maxDuration = ${secondi}${semi}`, 'utf8')
  writeFileSync(file, Buffer.concat([byte.subarray(0, fine), blocco, byte.subarray(fine)]))
  console.log('ok', secondi, file)
}
EOF
node "${TMPDIR:-/tmp}/s09-max-duration.mjs"
git diff --stat -- src/app/api | tail -4
git diff --text -- 'src/app/api/admin/iscrizioni/elenco/export/route.ts' | head -20
```

Atteso: venti righe `ok`; `git diff --stat` con **19 file** a `+3` ciascuno (57 inserimenti) più `src/app/api/admin/iscrizioni/elenco/export/route.ts | Bin …` (git lo tratta da binario per il NUL: è normale, e il secondo `git diff --text` mostra le tre righe aggiunte come per gli altri). Se lo script si ferma su `maxDuration c'è già`, la sessione 8 o un'altra ha già dichiarato quella route: togli la riga da `VOCI`, lascia la route nella mappa del lock e rilancia sui file non ancora toccati (`git checkout` **non** si usa: se serve ripartire, `git diff --stat` dice quali sono già fatti).

- [ ] **Passo 4: eseguilo e guardalo passare**

```bash
npx vitest run __tests__/architecture/cron-max-duration.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/vercel-json-funzioni-nella-regione-del-db.test.ts 2>&1 | tail -6
npx eslint src/app/api --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | head -10
```

Atteso: `Test Files  3 passed`; ESLint senza righe d'errore; `tsc` senza output.

- [ ] **Passo 5: commit**

```bash
git add -u src/app/api __tests__/architecture/cron-max-duration.test.ts
git commit -m "$(cat <<'EOF'
maxDuration dichiarato sulle 20 route lunghe, e il lock che lo pretende (sessione 9)

Diciannove route a 300 s (il default di oggi, reso esplicito) e la traduzione a 60 s
(caso peggiore 45 s). Il lock cron-max-duration tiene ROUTE_LUNGHE col perché di
ciascuna e fa rosso su una route con un import pesante che non è né lì né del cron.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Log

Tutte le righe nuove portano `esito`; nessuna porta un indirizzo, un nome o un testo libero di una famiglia. In `app_log` restano in chiaro solo `operazione`, `esito`, `provider`, `stato`, uuid, numeri e booleani; il destinatario dell'email è un hash (`hashCorrelabile`), i corpi dei rifiuti passano da `sanificaMessaggio`.

| Dove | Evento · livello | `esito` | Campi | Quando |
|---|---|---|---|---|
| `send.ts` → `externalFetch` | `email` · `info` / `warn` / `error` | (la riga del fornitore di sempre) | `operazione`, `destinatario` (hash), `provider: resend`, `stato`, `ms`, **`tentativo`** (solo con `ritentativi`) | ogni chiamata; `warn` se il rifiuto è ritentabile e i ritentativi ci sono |
| `send.ts` | `email` · `info` | `riuscita-dopo-ritentativo` | `provider`, `tentativi` | successo al 2° o 3° tentativo |
| `send.ts` | `email` · `error` (sempre, 429 compreso) | `ritentativi-esauriti`, `retry-after-oltre-il-tetto`, `ritentativo-oltre-la-scadenza` | `provider`, `stato`, `tentativi`, `attesa_ms`; Error `ResendRitentativiFermati` col corpo sanificato e `code` (status, `429` compreso, `timeout`, `nessuna-risposta`) | ritentativi fermati: l'email in questo giro non parte. È la riga che il controllo `email` della salute conta come rifiuto (`contaEsitiFornitore`, sole righe `error`) |
| `send.ts` | `email` · `warn` | `quota-esaurita` (c'era) | `stato` | solo se non c'è già la riga di chiusura: cioè il 429 di chi non chiede ritentativi (il bottone della segreteria) |
| `solleciti-invio.ts` | `pagamento` · `error` | `sollecito-non-recapitato` | `pagamento_id`, `livello_sollecito`, `tentate`, `presa_annullata`; Error `SollecitoNonRecapitato` col motivo sanificato | nessuna email partita, esito certo |
| `solleciti-invio.ts` | `pagamento` · `warn` | `sollecito-esito-incerto` | `pagamento_id`, `livello_sollecito`, `tentate`, `incerte` | nessuna email confermata, almeno un esito incerto |
| `solleciti-invio.ts` | `pagamento` · `info` | `presa-gia-ripresa` | `pagamento_id` | l'annullamento tocca zero righe (un altro giro ha ripreso la voce) |
| `solleciti-invio.ts` | `pagamento` · `error` | `presa-non-annullata` | `pagamento_id` + l'errore PostgREST col codice | l'annullamento fallisce |
| `solleciti-invio.ts` | `pagamento` · `warn` | `nessun-indirizzo-email` | `pagamento_id`, `n_destinatari` | nessun destinatario con un indirizzo (non in anteprima) |
| `solleciti-invio.ts` | `pagamento` · `info` / `error` | `registro-solleciti-assente`, `registro-sollecito-non-scritto` (c'erano) | `pagamento_id` | ora anche sui tentativi falliti |
| `solleciti/run` | `cron` · `info` / **`warn`** | `ok` / **`ok-parziale`** | + **`fallite`**, **`email_inviate`**, **`email_tentate`** | ogni giro; `ok-parziale` con almeno una voce fallita |
| `solleciti/run` | `cron` · `error` | `solleciti-con-guasti` (c'era) | + `fallite`, `email_inviate`, `email_tentate` | |
| `claude.ts` → `externalFetch` | `traduzione` · `info` / `warn` / `error` | (riga del fornitore) | `operazione: messages:create`, `provider: anthropic`, `stato`, `ms` | ogni tentativo; in tabella solo `warn` ed `error` (`traduzione` non è in `EVENTI_PERSISTITI`) |
| `claude.ts` | `traduzione` · `error` | `traduzione-fallita` (c'era) | `provider`, `lingua`, `caratteri` | la traduzione non è riuscita |

I successi critici si loggano già: l'email accettata (riga `info` di `externalFetch`, persistita perché `email` è in `EVENTI_PERSISTITI`) e il battito del giro.

---

## PRD

### Compito 12 — Changelog e tabella di stato

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (in cima, prima della riga 1)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, la riga della sessione 9 della tabella di stato (la 33 il 20/10; si trova con `grep -n "^| 9 |"`)

- [ ] **Passo 1: la voce di changelog**

In cima a `PRD REGISTRO ELETTRONICO.md`, prima della riga 1, inserisci il blocco qui sotto, sostituendo ogni `{…}` col valore di `${TMPDIR:-/tmp}/s09-misure.env` (e `{data UTC di oggi}` con `date -u +%Y-%m-%d`), seguito da una riga vuota:

```markdown
## ✉️ Changelog — Robustezza, seconda serie, sessione 9: email e fornitori senza successi finti — {data UTC di oggi} (branch `robustezza2/s09-email-e-fornitori`)

**Stato:** 🟡 in revisione. Solo codice: nessuna migrazione, niente da applicare al merge. «In produzione», il commit di `main` e i numeri «dopo» li scrive la sessione che apre dopo, nella sua chiusura della precedente.

**Misura «prima»** ({ISCRIZIONI_ALLE} UTC, sola lettura): `enrollment_submissions` = **{ISCRIZIONI}** righe. Registro dei solleciti: {REGISTRO_RIGHE} righe, {REGISTRO_NON_RECAPITATE} senza nessun destinatario raggiunto. Ultimo giro automatico ({ULTIMO_GIRO}): {ULTIMO_GIRO_RIGHE} solleciti, {ULTIMO_GIRO_SENZA_RECAPITO} senza recapito. Voci aperte con la cadenza avanzata e l'ultimo sollecito non recapitato: **{VOCI_SENZA_RECAPITO}**; prese senza registro in 30 giorni: {PRESE_SENZA_REGISTRO}. Resend in 7 giorni: {EMAIL_7G_OK} accettate, {EMAIL_7G_KO} rifiutate, di cui {EMAIL_7G_429} per quota. Giro più lungo in 14 giorni: {DURATA_GIRO_MAX_MS} ms. Traduzioni fallite in 30 giorni: {TRADUZIONI_30G_KO}. Voci aperte il cui prossimo livello scende col filtro dei recapitati: {LIVELLO_SCENDE_APERTE}.

- **Solleciti (`solleciti-invio.ts`).** Un sollecito conta come inviato solo se almeno un'email è partita. Se non ne parte nessuna e l'esito è certo, `ultimo_sollecito_il` torna al valore di prima con un UPDATE condizionato sulla presa (se un altro giro l'ha già ripresa, resta la sua); esito `ok: false`, riga `sollecito-non-recapitato` a `error`, niente push. Esito incerto (scadenza senza risposta, `409` concorrente): la presa resta, il sollecito slitta di una cadenza, riga `sollecito-esito-incerto`. Il registro si scrive sempre, con l'esito per destinatario (`inviata`, `incerta`); i livelli contano solo le righe con almeno un `inviata: true`. Nessun destinatario con un indirizzo: niente presa, niente push, niente registro, un `warn` (scelta del titolare, Passo 10 del Compito 2: con un no questa frase dice che resta la sola push, senza salire di livello). Gli esiti portano `inviate` e `tentate`.
- **Resend (`send.ts`).** Ritentativi su richiesta (`ritentativi`), chiesti solo dal giro automatico: al massimo 3 chiamate, `429` sempre, `5xx` e rete solo con la chiave d'idempotenza, la stessa chiave a ogni tentativo, attese 1 s e 3 s o il `Retry-After` fino a 10 s, mai oltre il tetto del giro (240 s). Una riga per tentativo (`warn` se ritentabile) e una di chiusura, sempre `error` (429 compreso), col codice e il corpo del provider sanificato: è la riga che il controllo `email` della salute conta. Chi non chiede i ritentativi non vede cambiare niente.
- **Battito del giro (`solleciti/run`).** `fallite`, `email_inviate`, `email_tentate`; con una voce fallita il battito è `ok-parziale` a `warn`.
- **Storico dei solleciti.** Colonna «Recapitato» (Sì / Incerto / No), senza indirizzi.
- **Traduzione della chat (`claude.ts`).** 20 s per tentativo, un ritentativo, un'attesa chiesta oltre 5 s non si aspetta; il `fetch` dello SDK passa da `externalFetch`. `anthropic` è fra i provider osservati. `chat/translate` vive al massimo 60 s.
- **`news/cron/run`.** Il segreto del cron con `segretoCronValido`; il debito del lock è vuoto.
- **Route lunghe.** `maxDuration` dichiarato su 20 route (19 a 300 s, la traduzione a 60 s); il lock `cron-max-duration` le elenca col perché e fa rosso su una route con un import pesante che non è né lì né del cron.

**Cambia per le famiglie.** Un sollecito che non parte non risulta più inviato: il giro dopo lo riprende. Le {LIVELLO_SCENDE_APERTE} voci aperte con un livello registrato ma mai recapitato riceveranno **quel** livello, non il successivo. Chi non ha nessun indirizzo collegato non riceve più la sola push del sollecito ({SENZA_INDIRIZZO_90G} solleciti così negli ultimi 90 giorni; con un numero diverso da 0 la scelta l'ha fatta il titolare prima del codice).

**Prove.** `email-send-ritentativi.test.ts` (Resend finto: 429, 500, 422, 409, rete giù, scadenza, orologio finto), `rete-retry-after.test.ts`, `pagamenti-solleciti-invio.test.ts` (presa annullata, gara con un altro giro, uno sì e uno no, incerto, nessun indirizzo, livelli recapitati, battito), `translate-claude-fornitore.test.ts` (SDK vero con `fetch` finto), `storici-servizi.test.ts`, lock `provider-esterni-osservati`, `segreto-cron-tempo-costante`, `cron-max-duration`.

**Da fare dopo il merge.** La misura «dopo» matura dopo le 06:10 UTC del primo giro automatico successivo al merge: 0 voci con la cadenza avanzata e nessun destinatario raggiunto. La scrive, con data e ora UTC, la sessione che apre dopo, dalla sezione «Per la sessione dopo» del piano.
```

- [ ] **Passo 2: la riga della tabella di stato**

```bash
grep -n "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola (il 20/10 era la 33). La riga si trova così, **mai** con `sed -n` su un numero. Sostituiscila (testo del 20/10; se la colonna «Note» ha già altro, tienilo e aggiungi dopo):

```markdown
| 9 | Email e fornitori senza successi finti | S2, S9 | 7 | da fare | — | `s09-email-e-fornitori` | solo codice |
```

con (sostituendo i `{…}`):

```markdown
| 9 | Email e fornitori senza successi finti | S2, S9 | 7 | in revisione | — | `docs/superpowers/plans/2026-10-20-robustezza2-s09-email-e-fornitori.md` | solo codice; prima: {VOCI_SENZA_RECAPITO} voci con la cadenza avanzata senza recapito, {EMAIL_7G_KO} rifiuti di Resend in 7 giorni ({ISCRIZIONI_ALLE} UTC) |
```

Se il Passo 10 del Compito 2 ha portato una decisione del titolare (`DECISIONE_SENZA_INDIRIZZO` = `si` o `no`), aggiungi in fondo alla colonna «Note», prima della `|` finale: punto e virgola, poi «senza indirizzo: {SENZA_INDIRIZZO_90G} casi in 90 giorni, il titolare ha scelto» seguito da «nessun sollecito» (sì) o «la sola push» (no), con la data UTC della risposta. Il numero della PR (colonna «PR», oggi `—`) si scrive al Compito 13, Passo 3. «In produzione» per questa riga **non** si scrive mai in questa PR: lo scrive la sessione che apre dopo.

- [ ] **Passo 3: nessuna parentesi graffa rimasta, nessun dato personale**

```bash
head -20 "PRD REGISTRO ELETTRONICO.md" | grep -n "{[A-Z][A-Z0-9_]*}\|{data UTC"
grep "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -n "{[A-Z][A-Z0-9_]*}"
head -20 "PRD REGISTRO ELETTRONICO.md" | grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}"
```

Atteso: nessuna riga da nessuno dei tre comandi. Nel PRD ci sono solo numeri, date, nomi di tabelle e di file.

- [ ] **Passo 4: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
PRD e tabella di stato: sessione 9, email e fornitori senza successi finti

Changelog con la misura «prima» (domande d'iscrizione contate, registro dei solleciti,
esiti di Resend in 7 giorni) e la riga 9 della specifica «in revisione».

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 13 — Gate, PR, CI, merge del titolare, verifica

**File:** nessuno nuovo. Dopo il rilascio non si apre nessun ramo di soli documenti: lo Stato «in produzione» nel PRD e nella riga della sessione 9, il commit di `main` e i numeri «dopo» li scrive la sessione che apre dopo, eseguendo la sezione «Per la sessione dopo» di questo piano.

- [ ] **Passo 1: il gate intero**

```bash
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
CI=1 npx vitest run 2>&1 | tail -8
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
```

Atteso: ESLint senza righe d'errore; `tsc` senza output; `Test Files … passed` senza `failed`; la build termina con l'elenco delle route. Leggi i riepiloghi, non il codice d'uscita di una pipe. **Mai** `npm run e2e` in locale: l'E2E gira in CI.

- [ ] **Passo 2: cosa porta il ramo**

```bash
git diff origin/main --stat | tail -40
git diff origin/main --name-only | grep -c "^supabase/migrations/"
git diff --text origin/main | grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" | grep -v "example\.test" | head
```

Atteso: i file della Mappa (più, nel primo commit, quelli della chiusura della sessione precedente: fotografie, `soglia-fotografia.ts`, la sua riga di stato e la sua voce del PRD), `0` migrazioni, e nessuna riga dall'ultimo comando: gli unici indirizzi nel diff sono su `example.test`.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s09-email-e-fornitori
gh pr create --base main --head robustezza2/s09-email-e-fornitori \
  --title "Robustezza 2, sessione 9: email e fornitori senza successi finti" \
  --body "$(cat <<'EOF'
## Cosa cambia
- Solleciti: un sollecito conta come inviato solo se almeno un'email è partita. Se non ne parte nessuna, la presa sulla cadenza si annulla con un UPDATE condizionato sulla presa stessa, l'esito è `ok: false`, niente push; il registro scrive l'esito per destinatario e i livelli contano solo i solleciti recapitati. Esito incerto (scadenza senza risposta, 409 concorrente): la presa resta.
- Resend: nel giro automatico fino a 3 tentativi su 429 / 5xx / rete, con la stessa `Idempotency-Key`, il `Retry-After` rispettato e il tetto del giro (240 s). 5xx e rete si ritentano solo con la chiave. Senza `ritentativi` niente cambia.
- Battito del giro: `ok-parziale` a warn quando una voce non è partita, con `fallite`, `email_inviate`, `email_tentate`.
- Storico dei solleciti: colonna «Recapitato».
- Traduzione della chat: 20 s per tentativo, un ritentativo, attesa massima 5 s, `fetch` da `externalFetch`; `anthropic` fra i provider osservati.
- `news/cron/run` con `segretoCronValido`; il debito del lock è vuoto.
- `maxDuration` su 20 route lunghe (19 a 300 s, la traduzione a 60 s); lock `cron-max-duration` allargato.

## Migrazioni
Nessuna. Solo codice.

## Misura «prima»
Nel changelog del PRD: domande d'iscrizione contate, registro dei solleciti, voci con la cadenza avanzata senza recapito, esiti di Resend in 7 giorni.

## Merge
A mano, dal titolare, dopo la CI verde su tutti i job.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Atteso: l'URL della PR. Trova la riga con `grep -n "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, sostituisci in quella riga `| in revisione | — |` con `| in revisione | #<numero> |` (lo Stato resta «in revisione»), fai un commit sul ramo e ripeti il push:

```bash
grep "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -c "| in revisione | #"
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
Tabella di stato: sessione 9 in revisione, numero della PR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Atteso: `1` dal primo comando (la riga ha il numero della PR e lo Stato «in revisione»); il push senza errori.

- [ ] **Passo 4: la CI, tutti i job**

```bash
gh pr checks --watch 2>&1 | tail -20
```

Atteso: ogni job `pass`. Un E2E `cancelled` non è rosso: si rilancia (`gh run rerun <id> --failed`), una PR alla volta. Nessun job applica migrazioni di questa sessione.

- [ ] **Passo 5: il merge è del titolare**

Non si usa l'auto-merge. Si scrive al titolare che la PR è verde e pronta, con il riepilogo qui sopra e i due numeri che le famiglie vedranno (`LIVELLO_SCENDE_APERTE`, `SENZA_INDIRIZZO_90G`), e si aspetta che la mergi lui. Se `SENZA_INDIRIZZO_90G` era maggiore di 0, la scelta l'ha già fatta al Passo 10 del Compito 2 e sta nella colonna «Note»: si ricorda, non si richiede. Se era 0, si dice che oggi il comportamento nuovo non tocca nessuna famiglia.

- [ ] **Passo 6: dopo il merge e il deploy, la verifica in sola lettura**

```bash
gh pr view <numero> --json mergedAt,mergeCommit --jq '"\(.mergedAt) \(.mergeCommit.oid)"'
```

Scrivi `MERGED_AT=` e `MERGE_SHA=` nel file delle misure. Con lo strumento Vercel `list_deployments` (sola lettura, produzione) controlla che il deploy di produzione più recente sia `READY` sul commit `MERGE_SHA`. Poi:

```sql
SELECT count(*) AS righe_email_dal_merge,
       count(*) FILTER (WHERE contesto->'campi' ? 'tentativo') AS con_tentativo
  FROM app_log
 WHERE evento = 'email' AND visto_l_ultima >= '{MERGED_AT}';
```

Atteso: il deploy `READY` sul commit di merge. Le righe con `tentativo` compaiono solo dopo il primo giro automatico: prima delle 06:00 UTC possono essere 0, ed è normale.

- [ ] **Passo 7: la misura «dopo», al primo giro delle 06:00 UTC**

Dopo le 06:10 UTC del primo giorno successivo al merge (o dopo la prima accensione dello schedule letto al Passo 3 del Compito 2), in sola lettura:

```sql
SELECT now() AT TIME ZONE 'UTC' AS misurato_alle, count(*) AS iscrizioni FROM enrollment_submissions;

-- (a) il battito del giro
SELECT visto_l_ultima, livello,
       contesto->'campi'->>'esito'         AS esito,
       contesto->'campi'->>'inviati'       AS inviati,
       contesto->'campi'->>'fallite'       AS fallite,
       contesto->'campi'->>'rinviati'      AS rinviati,
       contesto->'campi'->>'email_inviate' AS email_inviate,
       contesto->'campi'->>'email_tentate' AS email_tentate,
       contesto->'campi'->>'ms'            AS ms
  FROM app_log
 WHERE evento = 'cron'
   AND contesto->'campi'->>'operazione' = 'pagamenti-solleciti'
   AND visto_l_ultima >= '{MERGED_AT}'
 ORDER BY visto_l_ultima DESC;

-- (b) LA PROVA della specifica: cadenza avanzata dopo il merge, nessun destinatario raggiunto
SELECT count(*) AS cadenza_avanzata_senza_recapito
  FROM pagamenti p
 WHERE p.ultimo_sollecito_il >= '{MERGED_AT}'
   AND NOT EXISTS (
     SELECT 1 FROM solleciti s
      WHERE s.pagamento_id = p.id
        AND s.inviato_il >= '{MERGED_AT}'
        AND (s.destinatari @> '[{"inviata":true}]' OR s.destinatari @> '[{"incerta":true}]'));

-- (c) le prese senza registro dal merge (giri morti fra la presa e il registro)
SELECT count(*) AS prese_senza_registro
  FROM pagamenti p
 WHERE p.ultimo_sollecito_il >= '{MERGED_AT}'
   AND NOT EXISTS (SELECT 1 FROM solleciti s
                    WHERE s.pagamento_id = p.id AND s.inviato_il >= p.ultimo_sollecito_il);

-- (d) gli esiti di Resend dal merge
SELECT livello,
       contesto->'campi'->>'esito' AS esito,
       contesto->'campi'->>'stato' AS stato_http,
       codice,
       sum(occorrenze) AS n
  FROM app_log
 WHERE evento = 'email' AND visto_l_ultima >= '{MERGED_AT}'
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 2, 3, 4;
```

Atteso: (a) un battito `ok` (a `info`) o `ok-parziale` (a `warn`) con i campi nuovi; (b) **0**, che è la prova della specifica; (c) 0 (se non è 0, quelle voci sono il prezzo della fase 8, non di questa sessione: va scritto separato, «osservato» e «causa probabile»); (d) le righe `ritentativi-esauriti` / `riuscita-dopo-ritentativo`, se ce ne sono state. **Soglia:** se (b) è maggiore di (c), una voce ha preso la cadenza senza recapito per un motivo che questa sessione doveva togliere: **fermati**, leggi le righe `pagamento` dal merge (`esito` in `sollecito-non-recapitato`, `presa-non-annullata`, `presa-gia-ripresa`) e dillo al titolare. Scrivi i numeri, con la data e l'ora UTC, nel file delle misure (`DOPO_ALLE=`, `DOPO_ISCRIZIONI=`, `DOPO_SENZA_RECAPITO=`, `DOPO_PRESE_SENZA_REGISTRO=`, `DOPO_ESITO_BATTITO=`). Non si apre nessun ramo per scriverli: nel PRD e nella riga della sessione 9 li scrive la sessione che apre dopo, dalla sezione «Per la sessione dopo», che ripete queste query. Se questa sessione è già chiusa quando la misura matura, il passo qui si salta: lo fa quella sezione, e la soglia vale lì.

- [ ] **Passo 8: pulizia del ramo e del worktree di questa sessione (AGENTS.md, punto 3; §5)**

Dopo il rilascio riuscito:

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s09-email-e-fornitori
git -C /Users/lerri/kidville-web branch -D robustezza2/s09-email-e-fornitori
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s09-email-e-fornitori
git -C /Users/lerri/kidville-web branch -a | grep -v "main$" | head
```

Atteso: nessun ramo né worktree di questa sessione. I rami di altre sessioni con una PR ancora aperta restano (§5).

---

## Ritorno indietro

**Codice.** Instant Rollback di Vercel al deploy di prima (lo fa il titolare dal pannello), poi una PR di revert del commit di merge. Non c'è niente da disfare nel database: la sessione non ha migrazioni.

**Il registro scritto dopo il deploy.** Dal deploy il registro `solleciti` contiene anche righe senza nessun destinatario raggiunto. Il codice di prima legge i livelli **senza** filtro: con quelle righe farebbe salire il livello di voci la cui email non è mai partita. Prima di aprire la PR di revert, contale:

```sql
SELECT count(*) AS righe_non_recapitate_dal_merge
  FROM solleciti
 WHERE inviato_il >= '{MERGED_AT}'
   AND NOT destinatari @> '[{"inviata":true}]';
```

Se sono più di 0, la PR di revert **tiene** la costante `FILTRO_RECAPITATO` e il `.contains('destinatari', FILTRO_RECAPITATO)` della lettura dei livelli (Compito 5), e toglie il resto. E poiché l'Instant Rollback rimette subito il codice senza filtro, la PR di revert va mergiata **prima del giro successivo delle 06:00 UTC**; se non si fa in tempo, il titolare decide se spegnere l'invio automatico dalle impostazioni dei solleciti per quel giorno.

**Cosa resta dopo il revert.** Le righe del registro con `inviata: false` e `incerta: true` restano: sono la traccia di ciò che si è tentato. I `maxDuration` tornano al default (300 s oggi): nessun effetto finché il default non cambia.

---

## Per la sessione dopo

La esegue, nel suo **primo commit**, la sessione `robustezza2/` che apre dopo il rilascio della 9, qualunque numero abbia (§5, «la chiusura della precedente»). Chi la esegue non ha letto questo piano: qui c'è tutto quello che serve. Ogni lettura sul database è in **sola lettura** (strumento MCP `execute_sql`, solo `SELECT`); le risposte vanno in `${TMPDIR:-/tmp}`, mai nel repository; nel PRD e nella specifica vanno solo numeri, date, uuid e codici. Si lavora nel worktree della sessione che apre.

**0. Numero della PR, commit di `main`, giorno zero.**

```bash
N9=$(gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s09-" --json number,headRefName --jq '[.[] | select(.headRefName | endswith("-esito") | not)][0].number')
echo "#$N9 $(gh pr view "$N9" --repo erricoluigi17/kidville-web --json mergeCommit,mergedAt --jq '"\(.mergeCommit.oid[0:8]) \(.mergedAt)"')"
gh pr view "$N9" --repo erricoluigi17/kidville-web --json files --jq '[.files[].path | select(startswith("supabase/migrations/"))] | length'
```

Atteso: `#<numero> <otto caratteri del commit> <data e ora del merge>` e `0`. La data e l'ora del merge sono il **giorno zero** delle maturazioni qui sotto; nelle `SELECT` del punto 3 prendono il posto di `<mergedAt>`.

**1. Fotografie e liste: niente.** La sessione 9 non ha migrazioni (solo codice): nessuna fotografia da rigenerare, nessuna voce da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` né da altre liste. Se il terzo comando del punto 0 non dà `0`, qualcuno ha aggiunto una migrazione dopo la scrittura di questo piano: **fermati** e chiedi al titolare.

**2. Riga di stato.** `grep -n "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (una riga). In quella riga: Stato da `in revisione` a `in produzione`; la colonna «PR» tiene `#<N9>`; nella colonna «Note», dopo quello che c'è (compresa l'eventuale scelta del titolare sui solleciti senza indirizzo), aggiungi: punto e virgola, «in produzione dal» con la data del merge e, fra parentesi, il commit di `main`; poi «dopo», con data e ora UTC della lettura fra parentesi, e i numeri maturi del punto 3 (per esempio: `; in produzione dal 2026-11-12 (1a2b3c4d); dopo (2026-11-13 08:30 UTC): 0 voci con la cadenza avanzata senza recapito, battito ok`, con i valori veri).

**3. Misure «dopo», in sola lettura, e da quando sono mature.** Si scrivono solo quelle mature il giorno della chiusura; le altre restano qui con la loro data, e le scrive la prima PR che tocca la specifica dopo quel giorno (§5). I numeri «prima» per il confronto stanno nella voce della sessione 9 del PRD (punto 4).

| Misura | Matura dal | Atteso |
|---|---|---|
| deploy di produzione | giorno zero | `READY` sul commit di merge (strumento Vercel `list_deployments`, sola lettura) |
| battito del giro, la prova della specifica, prese senza registro, esiti di Resend dal merge: query (a)-(d) | dopo le 06:10 UTC del primo giro automatico successivo al merge (lo schedule è `0 6 * * *`; la 9 l'ha letto al Passo 3 del Compito 2) | (a) un battito `ok` a `info` o `ok-parziale` a `warn`, con `fallite`, `email_inviate`, `email_tentate`; (b) **0**; (c) 0, o comunque non meno di (b) |
| esiti di Resend nei 7 giorni dopo il merge: query (e) | giorno zero + 7 giorni | da affiancare ai «prima» della voce del PRD (accettate, rifiutate, di cui per quota); le righe con `tentativo` compaiono solo se ci sono stati rifiuti ritentabili |

```sql
SELECT now() AT TIME ZONE 'UTC' AS misurato_alle, count(*) AS iscrizioni FROM enrollment_submissions;

-- (a) il battito del giro
SELECT visto_l_ultima, livello,
       contesto->'campi'->>'esito'         AS esito,
       contesto->'campi'->>'inviati'       AS inviati,
       contesto->'campi'->>'fallite'       AS fallite,
       contesto->'campi'->>'rinviati'      AS rinviati,
       contesto->'campi'->>'email_inviate' AS email_inviate,
       contesto->'campi'->>'email_tentate' AS email_tentate,
       contesto->'campi'->>'ms'            AS ms
  FROM app_log
 WHERE evento = 'cron'
   AND contesto->'campi'->>'operazione' = 'pagamenti-solleciti'
   AND visto_l_ultima >= '<mergedAt>'
 ORDER BY visto_l_ultima DESC;

-- (b) LA PROVA della specifica: cadenza avanzata dopo il merge, nessun destinatario raggiunto
SELECT count(*) AS cadenza_avanzata_senza_recapito
  FROM pagamenti p
 WHERE p.ultimo_sollecito_il >= '<mergedAt>'
   AND NOT EXISTS (
     SELECT 1 FROM solleciti s
      WHERE s.pagamento_id = p.id
        AND s.inviato_il >= '<mergedAt>'
        AND (s.destinatari @> '[{"inviata":true}]' OR s.destinatari @> '[{"incerta":true}]'));

-- (c) le prese senza registro dal merge (giri morti fra la presa e il registro)
SELECT count(*) AS prese_senza_registro
  FROM pagamenti p
 WHERE p.ultimo_sollecito_il >= '<mergedAt>'
   AND NOT EXISTS (SELECT 1 FROM solleciti s
                    WHERE s.pagamento_id = p.id AND s.inviato_il >= p.ultimo_sollecito_il);

-- (d) gli esiti di Resend dal merge
SELECT livello,
       contesto->'campi'->>'esito' AS esito,
       contesto->'campi'->>'stato' AS stato_http,
       codice,
       sum(occorrenze) AS n
  FROM app_log
 WHERE evento = 'email' AND visto_l_ultima >= '<mergedAt>'
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 2, 3, 4;

-- (e) Resend nei 7 giorni dopo il merge, nella forma del «prima»
SELECT coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi'->>'provider' = 'resend' AND livello = 'info'), 0) AS accettate,
       coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi'->>'provider' = 'resend' AND livello <> 'info'), 0) AS rifiutate,
       coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi'->>'provider' = 'resend' AND contesto->'campi'->>'stato' = '429'), 0) AS per_quota,
       coalesce(sum(occorrenze) FILTER (WHERE contesto->'campi' ? 'tentativo'), 0) AS righe_di_tentativo
  FROM app_log
 WHERE evento = 'email'
   AND giorno >= ('<mergedAt>'::timestamptz AT TIME ZONE 'UTC')::date
   AND giorno <  ('<mergedAt>'::timestamptz AT TIME ZONE 'UTC')::date + 7;
```

**Soglia:** se (b) è maggiore di (c), una voce ha preso la cadenza senza recapito per un motivo che la sessione 9 doveva togliere: non si corregge nella chiusura. Si leggono le righe `pagamento` dal merge con `esito` in `sollecito-non-recapitato`, `presa-non-annullata`, `presa-gia-ripresa` (solo conteggi e uuid), si scrive il numero nella colonna «Note» della riga 9, con «osservato» e «causa probabile» separati, e lo si dice al titolare.

**4. PRD.** `grep -n "Robustezza, seconda serie, sessione 9" "PRD REGISTRO ELETTRONICO.md"` trova la voce. Sostituisci la sua riga che comincia con `**Stato:** 🟡 in revisione.` con:

```markdown
**Stato:** ✅ in produzione dal <data del merge> (PR #<N9>, commit <commit>). Solo codice: nessuna migrazione.
```

e aggiungi subito sotto:

```markdown
**Misura «dopo»** (<data e ora UTC>, sola lettura): <i numeri maturi del punto 3>; maturano più tardi: <quelli che mancano, ciascuno con la sua data>.
```

Al posto dei segni `<…>` vanno i valori letti. Controllo (la voce della 9 sta sopra le voci più vecchie, alcune delle quali contengono `<data>` di proposito):

```bash
L=$(grep -n "Robustezza, seconda serie, sessione 9" "PRD REGISTRO ELETTRONICO.md" | head -1 | cut -d: -f1)
sed -n "${L},$((L + 15))p" "PRD REGISTRO ELETTRONICO.md" | grep -c "<data\|<N9>\|<commit>\|<i numeri\|<quelli"
grep "^| 9 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep -c "<"
```

Atteso: `0` e `0`.

**5. Solo a certe condizioni.**
- Se il controllo `email` della salute risulta `degradato` e le righe `error` di (d) sono chiusure di ritentativi con `codice` `429`, è la quota di Resend, non un guasto del codice: lo si scrive nella colonna «Note» della riga 9, con la data, e lo si dice al titolare; se la chiusura sul 429 debba tornare `warn` è una sua decisione (vedi «Decisioni che restano al titolare» del piano della sessione 9), non della chiusura.
- Se la scelta del titolare sui solleciti senza indirizzo è stata «la sola push» (colonna «Note» della riga 9), la voce del PRD lo dice già: non si cambia niente.
- Se una parte della 9 è tornata indietro con una PR di revert, la riga 9 dice quale e perché, e le misure di quella parte non si scrivono. Il revert tiene il filtro `FILTRO_RECAPITATO` della lettura dei livelli se il registro ha righe non recapitate dal merge (parte «Ritorno indietro» del piano della sessione 9).

---

## Autorevisione

| Specifica (§7, «Sessione 9 — Email e fornitori senza successi finti», righe 607-638 del 20/10) | Compito |
|---|---|
| Obiettivo: un sollecito conta come inviato solo se un'email è partita; un fallimento lascia la voce al giro dopo | 5, 6 |
| Misura prima: voci con la cadenza avanzata e nessun destinatario raggiunto nell'ultimo giro | 2 (Passo 5) |
| Misura prima: esiti di Resend in `app_log` degli ultimi 7 giorni | 2 (Passo 7) |
| `solleciti-invio.ts:401-406`: nessun destinatario raggiunto ⇒ presa annullata con `update … where ultimo_sollecito_il = <presa>`, `ok:false`, log `error` | 6 (Passi 5-6), test della gara e di «uno sì, uno no» |
| `solleciti-invio.ts:485`: esito con i conteggi inviate/tentate | 6 (Passo 5) |
| Il registro si scrive anche quando l'invio fallisce | 6, con il filtro dei livelli del 5 (senza, il livello salirebbe) e lo storico dell'8 |
| `send.ts:242-287`: al massimo 3 tentativi, rispettando `Retry-After` (tetto 10 s), solo su 429/5xx/rete, `Retry-After`, stessa `Idempotency-Key` | 3, 4 |
| Il giro non si parallelizza | 4 (attese in serie, `chiamaResend`) |
| `solleciti/run/route.ts:212`: il battito riporta inviate/fallite/rinviate | 7 |
| `claude.ts:38-45`: `timeout` esplicito e `fetch` da `externalFetch` | 9 |
| `news/cron/run/route.ts:294`: `segretoCronValido` | 10 |
| `maxDuration` sulle 20 route lunghe (19 a 300 s, `chat/translate` a 60 s), lock `cron-max-duration` allargato partendo da come la 8 l'ha lasciato | 11 (sostituzioni per contenuto, blocco nuovo dopo l'ultimo del file) |
| Rischio: annullare solo quando nessun invio è riuscito; ritentativi dentro il tetto del giro (240 s) | 6 (`inviate === 0`, esito incerto che tiene la presa), 4 (`ritentativo-oltre-la-scadenza`), 2 (Passo 9, margine dei 60 s) |
| Indietro: revert, solo codice | Ritorno indietro (con il filtro dei livelli da tenere) |
| Prova: 0 voci con la cadenza avanzata e i destinatari non raggiunti; test con Resend finto su 429, 500, rete | 13 (Passo 7, query b), Per la sessione dopo (punto 3, query b), 4 |
| Cambia per le famiglie: «Il Passo 0 conta i casi di oggi; decide il titolare» | 2 (Passo 10: con casi negli ultimi 90 giorni ci si ferma e si chiede prima del Compito 6; la risposta va nella colonna «Note»; i passi del 6 che cambiano con un no), 12, 13 (Passo 5) |
| Un'email che non parte deve arrivare a un allarme: la chiusura dei ritentativi è `error` anche sul 429, i tentativi intermedi restano `warn` | 4 (test «429 con `Retry-After: 60`» e «429 tre volte»), Log, 1 (Passo 6: `contaEsitiFornitore` conta le sole `error`) |
| §5, «Apertura di una sessione: i prerequisiti»: la PR della 7 mergiata e le sue migrazioni nel registro, nessuna PR della serie aperta (salvo `-esito`); mai lo «Stato» della tabella | 1 (Passo 1) |
| §5, «Apertura di una sessione: la chiusura della precedente»: la sessione rilasciata per ultima, qualunque numero abbia, dalla sua sezione «Per la sessione dopo»; la fotografia delle migrazioni coi comandi interi; nessuna logica legata a un numero fisso | 1 (Passi 4 e 8) |
| §5, «La tabella di stato (§1), in due tempi»: «in revisione», numero della PR e percorso del piano nella propria PR; «in produzione» e numeri «dopo» dalla sessione che apre dopo; nessun ramo di soli documenti | 12 (Passo 2), 13 (Passi 3 e 7), Per la sessione dopo |
| §5, «Riferimenti al codice»: sostituzioni per contenuto nei file che cambiano le sessioni prima (`cron-max-duration.test.ts`, `soglia-fotografia.ts`, `controlli.ts`) | 1 (Passo 5), 11, Mappa dei file |
| §5, «Codice che regge il momento del merge» | non si applica: nessuna migrazione, nessuna colonna, tabella o RPC nuova |
| §5: worktree da `main`, conteggio di `enrollment_submissions` con l'ora UTC, gate con `CI=1` e la build a 8192, merge a mano, mai una stima, repository pubblico | 1, 2, 12, 13 |
| §6: sezione «Per la sessione dopo» (sessione senza migrazioni: riga di stato, PRD e misura) | Per la sessione dopo |

Segnaposto: nessuno; i `{…}` del Compito 12 e del Rilascio sono valori del file delle misure, sostituiti e controllati (Compito 12, Passo 3); i `<…>` della sezione «Per la sessione dopo» sono valori che legge chi la esegue, controllati dal suo punto 4.

Nomi usati fra i compiti, controllati: `msDaRetryAfter` (3, 4, 9); `ritentativi.scadenza`, `tentativi`, `incerto`, `TENTATIVI_EMAIL_MAX`, `ATTESE_RITENTATIVO_EMAIL_MS`, `ATTESA_MAX_EMAIL_MS`, `chiamaResend`, `eRitentabile`, `motivoPerFermarsi`, `erroreResend` (4); esiti `riuscita-dopo-ritentativo`, `ritentativi-esauriti`, `retry-after-oltre-il-tetto`, `ritentativo-oltre-la-scadenza` (4, Log); `FILTRO_RECAPITATO` (5, 6, Ritorno indietro); `DestinatarioRegistrato`, `RigaRegistro`, `annullaPresa`, `registraSollecito`, `erroreNonRecapitato`, `inviate`, `tentate` (6, 7); esiti `sollecito-non-recapitato`, `sollecito-esito-incerto`, `presa-gia-ripresa`, `presa-non-annullata`, `nessun-indirizzo-email` (6, Log, 13); `fallite`, `email_inviate`, `email_tentate`, `ok-parziale` (7, Log, 13); `recapito` (8); `TIMEOUT_TRADUZIONE_MS`, `RITENTATIVI_TRADUZIONE`, `ATTESA_MAX_TRADUZIONE_MS`, `fetchOsservato`, `opzioniClientTraduzione` (9); `ROUTE_LUNGHE`, `IMPORT_PESANTE`, `durataDichiarata`, `fuoriMisura` (11); chiavi del file delle misure (2, 12, 13).

---

## Decisioni che restano al titolare

- **Nessun indirizzo, nessun sollecito.** Una voce i cui destinatari non hanno nessun indirizzo non prende più la cadenza e non manda più la sola push (prima la mandava, e il livello saliva). Il titolare lo decide **prima del codice**: se il Passo 10 del Compito 2 trova casi negli ultimi 90 giorni, la sessione si ferma lì e gli porta il numero e i due comportamenti; la risposta va nella colonna «Note» della riga 9. Il piano è scritto per il sì; lo stesso passo elenca cosa cambia nel Compito 6 con un no (resta la sola push, senza salire di livello). Con zero casi il numero si porta al merge.
- **La chiusura dei ritentativi è `error` anche sul 429.** Una quota di Resend esaurita per tutto il giorno porta il controllo `email` della salute a `degradato` dalla terza email ferma, se i rifiuti superano gli invii riusciti. È voluto: un'email che non parte deve arrivare a un allarme. Se il titolare preferisce che la quota non suoni, la chiusura sul 429 torna `warn` e il controllo non la vede più (i tentativi intermedi restano comunque `warn`).
- **Niente push quando nessuna email è partita.** Con la presa annullata il giro dopo ritenta: una push a ogni tentativo sarebbe un sollecito al giorno sul telefono. Se si vuole, la push può partire una volta sola su un fallimento, con una regola scritta.
- **L'esito incerto slitta di una cadenza.** Una chiamata scaduta o un `409` concorrente lasciano la presa: se l'email non era davvero partita, la famiglia la riceve una cadenza dopo, con lo stesso livello. È la scelta «meglio tardi che due volte» della fase 8, estesa.
- **Il livello registrato ma mai recapitato si rimanda.** Dal deploy le {LIVELLO_SCENDE_APERTE} voci del Passo 6 ricevono il livello mai arrivato, non il successivo.
- **I ritentativi solo nel giro automatico.** Dal bottone la segreteria vede subito l'esito; se lo vuole anche lì, basta passare `ritentativi: {}` dal POST manuale (il tetto della route è 300 s).
- **Lo storico interno `GET /api/pagamenti/solleciti` e il segno «sollecitata» dei servizi** contano anche i tentativi falliti (leggono il registro senza `destinatari`). Non li usa nessuna famiglia; questa sessione non li tocca.
- **I `maxDuration` a 300 s** su diciannove route sono il default di oggi scritto nel file: se il titolare preferisce un tetto più stretto su qualcuna (per esempio gli export xlsx), si cambia il numero nella route e il lock resta verde fra 60 e 800.
