# Sessione 11 — Letture che non si troncano — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** nessun elenco restituisce in silenzio solo le prime 1000 righe, e quando una lettura qualunque tocca il tetto di PostgREST resta una riga `warn` che lo dice, con la tabella e la route.

**Architettura:** prima il segnale. Il `fetch` strumentato dei client Supabase (`src/lib/logging/supabase-fetch.ts`) riconosce una `GET` che riceve una pagina piena senza averla chiesta così, e scrive `max-rows-raggiunto`. Poi la cura: `leggiABlocchi` passa da `src/lib/pagamenti/` a `src/lib/db/`, accanto ad `aBlocchi`, e guadagna l'opzione `chiave` (la chiave unica che chiude l'ordine di ogni blocco; `student_parents` non ha `id`). Le cinque letture della specifica la usano, e un lock impedisce che tornino nude.

**Tecnologie:** Next.js (App Router, route handler), Supabase (PostgREST), vitest, il finto Supabase del repo (`__tests__/fixtures/finto-supabase.ts`, con l'opzione `maxRighe` che imita `max_rows`), le utilità dei lock (`__tests__/fixtures/sorgente.ts`).

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, Sessione 11 (righe 675-699 alla rilettura della sera del 20/10), con il criterio di anticipo della §3 (righe 113-115), le regole comuni della §5 (133-197) e la §6 «Apertura e chiusura» (237-243). La riga della sessione nella tabella di stato si trova con `grep -n "^| 11 |"`, mai per numero.

---

## Mappa dei file

| File | Azione | Ruolo |
|---|---|---|
| `src/lib/db/leggi-a-blocchi.ts` | Crea (con `git mv` dal file dei pagamenti) | `leggiABlocchi`, `descriviTetto`, `BLOCCO_LETTURA`, `MAX_BLOCCHI_LETTURA` e i tipi, letti per intero (righe 1-126). Novità: l'opzione `chiave` (default `['id']`) e il tipo `OpzioniABlocchi` esportato. |
| `src/lib/pagamenti/leggi-a-blocchi.ts` | Riscrivi | Solo riesportazioni da `@/lib/db/leggi-a-blocchi`. Lo importano oggi sei route (`admin/chat/docenti-senza-push:14`, `admin/dashboard:10`, `pagamenti/cassa/movimenti:15`, `pagamenti/servizi:13`, `pagamenti/genera-rette:13`, `pagamenti/export:16`) e due moduli (`lib/pagamenti/guasto-db.ts:3`, `lib/pagamenti/export-rette-a-carico.ts:6`): nessuno cambia. |
| `src/lib/db/blocchi.ts` | Solo lettura | `ID_PER_QUERY = 100` (riga 22), `RIGHE_MASSIME_POSTGREST = 1000` (riga 43), `aBlocchi` (righe 46-54). |
| `supabase/config.toml` | Solo lettura | Riga 18, `max_rows = 1000`. Non si alza (§8.9 della specifica). |
| `src/lib/logging/supabase-fetch.ts` | Modifica | Import (righe 1-6); ramo della risposta ok (righe 372-383); dopo `contaLenta` (che finisce alla riga 626) le funzioni nuove `maxRowsRaggiunto`, `limiteChiesto`, `verboDi`, `registraMaxRows`. Letti anche `descrivi`/`campiDi` (407-445), `registraIlleggibile`/`registraLenta` (592-611), `daPersistere`/`persistibile` (707-729), le letture difensive (846-910). |
| `src/app/api/admin/parents/route.ts` | Modifica | Import (righe 13-15); una funzione `guastoElenco` dopo la riga 71; l'elenco completo del `GET` (righe 114-163). Il ramo `?student_id=` (92-108) e il `PATCH` restano uguali. |
| `src/app/api/admin/presenze/realtime/route.ts` | Modifica | Letto per intero (1-92). Import (righe 7 e 10); una funzione `comeRisposta` dopo la riga 21; le letture (48-64); l'aggregazione (83-88). Esce `.limit(5000)` (riga 61). |
| `src/lib/health/controlli.ts` | Modifica | Un import accanto a quello di `versioneDeploy` (righe 1-3 al 20/10); `motivoDi` dopo `function codiceDi` (541-550 al 20/10); l'intera funzione `controlloTestoClasse` (1044-1077 al 20/10). File toccato anche dalle sessioni 1, 6, 7 e 8: ogni punto si trova per contenuto (firma della funzione, testo dell'import), mai per numero di riga. Letti anche `misura` (585-608) ed `eseguiQualita` (1446-1450). |
| `src/app/api/tasks/route.ts` | Modifica | Import (riga 17); la lettura della bacheca (righe 492-506) e i due `(rows ?? [])` delle righe 510 e 522. |
| `src/app/api/avvisi/route.ts` | Modifica | Import (riga 28); il ramo dello staff `listaAvvisiStaff`, da `const buildQuery` a `let filtered` (righe 385-421). Il feed del genitore (righe 495-520) resta uguale. |
| `__tests__/lib/db-leggi-a-blocchi.test.ts` | Crea | Lo spostamento riesporta gli stessi oggetti; ogni blocco si ordina per una chiave unica, provato con una sorgente che rimescola l'ordine dei pari a ogni richiesta. |
| `__tests__/pagamenti/leggi-a-blocchi.test.ts` | Nessuna modifica | Righe 1-127. Importa dal percorso dei pagamenti: verde dopo lo spostamento, è la prova che chi lo usava già non vede differenze. |
| `__tests__/lib/logging-max-rows.test.ts` | Crea | La regola di `max-rows-raggiunto` con `Content-Range` finti, i casi che non scattano (`0-998/999`, risposte non `GET`, le pagine di `leggiABlocchi`), la riga persistita con la route, il fail-open. |
| `__tests__/api/admin-parents-elenco-a-blocchi.test.ts` | Crea | Elenco genitori sul finto con `maxRighe: 1000`: il totale coincide con il `count(distinct)` dei legami delle stesse sedi. |
| `__tests__/api/presenze-realtime.test.ts` | Modifica | Il finto (righe 7-35) impara `order`, `range` e il tetto di 1000; un caso nuovo oltre il tetto. |
| `__tests__/api/presenze-conteggi-fino-a-oggi.test.ts` | Modifica | Riga 55: `range` fra i metodi del finto; il test T27 (righe 169-176) guarda anche lo status. |
| `__tests__/lib/health/testo-classe-a-blocchi.test.ts` | Crea | `eseguiQualita` sul finto con 1200 iscritti e le divergenze oltre il millesimo. |
| `__tests__/api/tasks-elenco-a-blocchi.test.ts` | Crea | La bacheca con 1005 promemoria in una sede, ordine stabile per `id`. |
| `__tests__/api/allegati-avvisi-task-firmati.test.ts` | Modifica | Riga 178: `range` restituisce le righe vere per `avvisi` e `task_interni`. |
| `__tests__/api/avvisi-staff-a-blocchi.test.ts` | Crea | L'archivio dello staff con 1005 avvisi; un blocco caduto dà `500` con il log `db`. |
| `__tests__/api/avvisi-route.test.ts` | Modifica | Righe 112-116: `range` restituisce le righe vere per `avvisi`. |
| `__tests__/architecture/letture-a-blocchi.test.ts` | Crea | Lock: censimento delle letture delle tabelle sorvegliate nei cinque file, nessun `.limit(N)` oltre `max_rows`, `leggiABlocchi` importato da `@/lib/db/`. |
| `PRD REGISTRO ELETTRONICO.md` | Modifica | Voce di changelog in cima, con i numeri del Passo 0 e l'ora UTC. |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | Modifica | La riga della sessione 11 nella tabella di stato (trovata con `grep`, mai per numero): «in revisione», numero della PR e percorso del piano, nella PR stessa (Compito 11, Passo 5). «In produzione» lo scrive la sessione dopo (sezione «Per la sessione dopo»). Più la riga della sessione chiusa al Compito 1. |

Test esistenti riletti e che restano verdi senza modifiche (usano il finto, che sa già `order` e `range`, o chiudono già la catena su `range`): `liste-persone-sede.test.ts` (239-259), `liste-anagrafica-proiezione-minima.test.ts`, `anagrafica-scope-sede.test.ts`, `health-livelli.test.ts` (176-261), `avvisi-bacheca-docente.test.ts`, `avvisi-niente-n-piu-uno.test.ts` (89-92), `avvisi-degradi-dichiarati.test.ts` (166), `tasks-sede-dichiarata.test.ts`, `gallery-chat-tasks-scope-sede.test.ts`, e i lock `elenchi-operativi-solo-iscritti` (voce di riga 417) e `isolamento-sede-coverage`.

---

## Scelte di questo piano rispetto alla lettera della specifica

Alla rilettura della sera del 20/10 la specifica (§7, «Sessione 11») ha già recepito i punti 1, 2 e 3: restano qui con le ragioni, perché i compiti le usano. I punti 4, 5 e 6 sono scelte di questo piano.

1. **La regola del `warn` non è «un `Content-Range` che finisce a 999»** (la specifica lo dice ora con le stesse parole). Quella regola si accenderebbe su ogni prima pagina piena di `leggiABlocchi` (`.range(0, 999)` risponde proprio `0-999/*`): dopo questa sessione il segnale non andrebbe mai a 0, e la Prova della specifica diventerebbe impossibile. Mancherebbe invece le pagine successive (`1000-1999/*`). La regola scritta qui: verbo `GET`, area `db` o `rpc`, risposta ok, `Content-Range` di **almeno 1000 righe**, e una di queste due cose: il parametro `limit` dell'indirizzo manca, oppure chiede più righe di quante ne sono arrivate. Se il totale c'è (`count: 'exact'`) e la pagina arriva fino in fondo, non è un taglio. postgrest-js 2.112 traduce `.range(da, a)` in `offset=da&limit=a-da+1` e `.limit(n)` in `limit=n` (`node_modules/@supabase/postgrest-js/dist/index.cjs`, righe 984 e 1044-1048).
2. **`chiave` in `leggiABlocchi`.** `student_parents` non ha la colonna `id`: la chiave primaria è `(student_id, parent_id)` (baseline, riga 3804; `__tests__/fixtures/indici-unici-snapshot.json`). Con `order('id')` fisso la lettura dei legami fallirebbe con `42703`. Il default resta `['id']`.
3. **Il cruscotto presenze ha due letture troncate, non una.** La specifica cita ora le righe 48-64: gli iscritti (49-53) e anche le presenze di oggi (56-61), il cui `.limit(5000)` non serve, perché `max_rows` vince su qualunque `limit`.
4. **Le letture delle risposte di UN avviso restano fuori.** Sono `avvisi/[id]/risposte/route.ts:262-265`, `avvisi/[id]/risposte/esporta/route.ts:124-127` e `avvisi/[id]/route.ts:686-689`. Le limitano le famiglie di una sede, e il nuovo `warn` le copre comunque. Il Passo 0.9 le misura: oltre 800 risposte per un avviso ci si ferma (vedi lì).
5. **Nel controllo di qualità vanno a blocchi anche le sezioni.** La lettura non ha filtro di sede, e una mappa delle sezioni troncata produrrebbe lo stesso verde falso. Nel cruscotto, invece, sezioni e sedi dei plessi dello staff restano letture semplici: sono decine di righe (Passo 0.8).
6. **L'elenco genitori legge legami e genitori in parallelo.** Sono blocchi di `ID_PER_QUERY` id letti con `Promise.all`. In sequenza, con circa 800 alunni, sarebbero una ventina di andate e ritorni uno dopo l'altro. È il «più richieste per pagina» che la specifica accetta come rischio. Un blocco fallito fa fallire l'elenco intero.

---

## Passo 0 — misura prima

Tutte le query sono **in sola lettura** e girano sul database di produzione, con lo strumento `execute_sql` della sessione che esegue. Restituiscono solo conteggi, uuid di sede e numeri, mai righe di persone. Prima di proseguire, scrivi ogni risultato con data e ora UTC nelle note della sessione. Finiranno nel PRD (Compito 10) e nella descrizione della PR (Compito 11). Il rapporto `docs/analisi-robustezza-2026-10-20.md` (S6) aveva misurato 806 alunni (790 iscritti) alle 12:56 UTC del 20/10: è un riferimento, non un numero da copiare.

**Se una soglia qui sotto chiede di fermarsi:** non si riapre una decisione dentro il piano (§2 della specifica). Ci si ferma, si scrive il fatto con il suo numero nella colonna «Note» della riga della sessione 11 nella tabella di stato (`grep -n "^| 11 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, mai per numero di riga) e si avvisa il titolare.

- [ ] **0.1 — L'ora**

```sql
select now() at time zone 'utc' as adesso_utc;
```

Nessuna soglia. Questa sessione non ha migrazioni, quindi la regola «si conta `enrollment_submissions` prima di ogni migrazione» non si applica.

- [ ] **0.2 — Il criterio di anticipo della §3**

```sql
select count(*) as legami from student_parents;
```

**Soglia:** 1000. Se questa misura si fa **prima** che tocchi alla sessione 11 ed è sopra 1000, la 11 passa davanti alle altre: lo si scrive nella colonna «Note» della riga della sessione 11 (`grep -n "^| 11 |"`) e si avvisa il titolare. Se si fa all'avvio della sessione, il numero va nel PRD e basta.

- [ ] **0.3 — Legami e genitori distinti per sede: il «prima» della Prova**

```sql
select a.scuola_id, count(*) as legami, count(distinct sp.parent_id) as genitori_distinti
from student_parents sp
join alunni a on a.id = sp.student_id
where a.scuola_id::text not like 'e2e00000-%'
group by a.scuola_id
order by a.scuola_id;

select count(*) as legami, count(distinct sp.parent_id) as genitori_distinti
from student_parents sp
join alunni a on a.id = sp.student_id
where a.scuola_id::text not like 'e2e00000-%';
```

**Soglia:** se `legami` della seconda query supera 1000, l'elenco genitori con «Tutte le sedi» **è già corto oggi**. Il PRD lo scrive come osservato, con il numero, e il titolare va avvisato subito: il rilascio di questa sessione diventa urgente. La sede fittizia `e2e00000-…` si esclude come da `AGENTS.md`.

- [ ] **0.4 — Alunni per sede: tutti gli stati e soli iscritti**

```sql
select scuola_id, count(*) as tutti, count(*) filter (where stato = 'iscritto') as iscritti
from alunni
group by scuola_id
order by scuola_id;
```

L'elenco genitori legge gli alunni di **tutti** gli stati. Il cruscotto presenze e il controllo `sezione-testo-allineato` leggono solo gli iscritti, e il controllo lo fa su **tutte** le sedi, senza filtro.
- **Soglia:** se la somma di `tutti` sulle sedi di produzione supera 1000, l'elenco genitori con «Tutte le sedi» è già troncato alla prima lettura.
- **Soglia:** se la somma di `iscritti` su tutte le righe (anche le sedi `e2e00000-…`, che il controllo non esclude) supera 1000, il controllo di qualità dice già «allineati» senza aver guardato tutti.

In entrambi i casi va nel PRD come osservato, e il titolare va avvisato.

- [ ] **0.5 — Presenze di oggi per sede, e il giorno più pieno**

```sql
select a.scuola_id, count(*) as presenze_oggi
from presenze p
join alunni a on a.id = p.alunno_id
where p.data = (now() at time zone 'Europe/Rome')::date
group by a.scuola_id
order by a.scuola_id;

select max(n) as presenze_del_giorno_piu_pieno
from (
  select p.data, count(*) as n
  from presenze p
  join alunni a on a.id = p.alunno_id
  where a.scuola_id::text not like 'e2e00000-%'
  group by p.data
) t;
```

**Soglia:** se la somma di oggi o il massimo superano 1000, il cruscotto ha già mostrato meno presenze del vero. Va nel PRD come osservato.

- [ ] **0.6 — Avvisi per sede**

```sql
select scuola_id, count(*) as avvisi from avvisi group by scuola_id order by scuola_id;
```

**Soglia:** sopra 1000 in una sede, l'archivio dello staff è già troncato. Va nel PRD come osservato.

- [ ] **0.7 — Promemoria per sede**

```sql
select scuola_id, count(*) as promemoria from task_interni group by scuola_id order by scuola_id;
```

**Soglia:** la stessa del punto 0.6. Il 20/10 il rapporto ne contava 0.

- [ ] **0.8 — Sezioni per sede**

```sql
select scuola_id, count(*) as sezioni from sections group by scuola_id order by scuola_id;
```

**Soglia:** se una sede supera 1000 sezioni, anche la lettura delle sezioni del cruscotto deve passare a blocchi, e il censimento del lock (Compito 9) cambia. Ci si ferma e si avvisa il titolare. Sotto questa soglia, sezioni e sedi del cruscotto restano letture semplici (vedi «Scelte», punto 5).

- [ ] **0.9 — Il massimo delle risposte per un avviso**

```sql
select max(n) as risposte_max_per_avviso
from (select avviso_id, count(*) as n from avvisi_risposte group by avviso_id) t;
```

**Soglia:** 800. Sopra questo numero, le tre letture per avviso del punto 4 delle «Scelte» sono vicine al tetto e devono entrare in questa sessione. Ci si **ferma prima del Compito 2**, si scrive il numero nella colonna «Note» e decide il titolare.

- [ ] **0.10 — Quante letture a blocchi hanno già toccato il loro tetto (per confronto)**

```sql
select route, sum(occorrenze) as volte, max(visto_l_ultima) as ultima
from app_log
where messaggio like 'lettura-troncata:%'
  and visto_l_ultima >= now() - interval '7 days'
group by route
order by volte desc;
```

Nessuna soglia: è il «prima» della famiglia di righe `lettura-troncata` che questa sessione allarga. Di norma non torna nessuna riga.

- [ ] **0.11 — `max_rows` del progetto ospitato**

È una lettura sul pannello, non una query. Supabase → *Project Settings* → *Data API* → *Max rows*.

**Soglia:** deve dire **1000**. Se dice altro, ci si ferma. `BLOCCO_LETTURA` e `RIGHE_MASSIME_POSTGREST` devono coincidere con quel valore, e la regola del `warn` (Compito 3) si basa su di esso.

---

## Compiti

Tutti i comandi partono da `/Users/lerri/kidville-web-s11-letture-a-blocchi` (il worktree del Compito 1), salvo dove è scritto altro. Si legge sempre la riga `Test Files` del riepilogo di vitest, mai il codice d'uscita di una pipe.

### Compito 1 — Prerequisiti, worktree, chiusura della sessione precedente

**File:**
- Modifica (Passo 6): `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la riga di stato della sessione chiusa nella specifica, lo Stato della sua voce nel PRD e gli altri file che nomina la sezione «Per la sessione dopo» del piano della sessione rilasciata per ultima. Se nessuna sessione `robustezza2/` è ancora rilasciata (la 11 può essere anticipata, §3 della specifica), nessuno.

- [ ] **Passo 1: la specifica e questo piano sono su `main`?**

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md && echo presente
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/plans/2026-10-20-robustezza2-s11-letture-a-blocchi.md && echo presente
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep "^| 11 |"
```

Atteso: due volte `presente`, poi la riga della sessione 11, con `—` nella colonna «Dopo». Se manca un file, la PR #254 (solo documenti) non è ancora in `main`: chiedi al titolare di mergiarla prima di partire.

- [ ] **Passo 2: i prerequisiti**

La colonna «Dopo» della sessione 11 è vuota: non c'è una sessione da trovare mergiata, e resta solo il secondo controllo della specifica (§5, «Apertura di una sessione: i prerequisiti») — nessuna PR `robustezza2/` aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: nessuna riga. Se compare qualcosa, **fermati**: «una sessione alla volta» (§5). Quella sessione si chiude prima.

- [ ] **Passo 3: crea il worktree e il ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s11-letture-a-blocchi /Users/lerri/kidville-web-s11-letture-a-blocchi origin/main
cd /Users/lerri/kidville-web-s11-letture-a-blocchi && git status -sb | head -3
```

Atteso: `## robustezza2/s11-letture-a-blocchi...origin/main`, con l'albero pulito. Il nome del ramo è quello del file del piano senza la data: la sessione dopo lo usa per ritrovare questo piano.

- [ ] **Passo 4: `.env.local`**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s11-letture-a-blocchi/.env.local
```

- [ ] **Passo 5: dipendenze**

```bash
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 6: chiudi la sessione rilasciata per ultima (prima di ogni codice)**

Quale sessione chiudere non si deduce da un numero: è la PR `robustezza2/` mergiata più di recente, esclusi i rami `-esito` (specifica §5, «Apertura di una sessione: la chiusura della precedente»).

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga, `<numero> robustezza2/sNN-<nome>`. Con l'ordine 1→14 è di solito la sessione 10, ma vale la riga stampata. **Se non stampa niente** (oppure stampa `null null`), nessuna sessione della serie è ancora rilasciata: questo passo si salta, e si va al Passo 7.

Altrimenti il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-<il ramo senza «robustezza2/»>.md`. Leggi **per intero** la sua sezione «Per la sessione dopo» (l'ultima prima dell'«Autorevisione») ed eseguila tutta, nell'ordine in cui la scrive: fotografie, voci da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`) e dalle altre liste che nomina, la sua riga di stato a «in produzione» (la trovi col `grep -n "^| NN |"` che la sezione indica), il commit di `main`, la misura «dopo» se è già matura, lo Stato della sua voce nel PRD. Una misura che quella sezione dice «matura dal giorno …» la scrive la prima PR che tocca la specifica dopo quel giorno: se il giorno è passato, è questa. Il commit di `main` da scrivere:

```bash
git -C /Users/lerri/kidville-web log origin/main --oneline --grep "(#<numero stampato sopra>)" | head -1
```

La fotografia delle migrazioni si rigenera **sempre** quando la sessione chiusa aveva migrazioni, con questi comandi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa (`select version, name from supabase_migrations.schema_migrations order by version`) con `execute_sql` sul progetto di produzione, in sola lettura, salva la risposta JSON in `${TMPDIR:-/tmp}/s11-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/s11-migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed (1)`; le migrazioni delle sessioni rilasciate compaiono con la version del file. Le altre fotografie (indici unici, policy, chiavi esterne, tabelle per sede, bucket, schema delle candidature) si rigenerano **solo** se quella sezione le nomina, col comando che dà lei.

Poi il commit, il primo di questa sessione:

```bash
git status --short
git add -u
git status --short
git commit -m "$(cat <<'EOF'
Chiusura della sessione rilasciata per ultima, prima della sessione 11

Eseguita la sezione «Per la sessione dopo» del suo piano: fotografia delle
migrazioni rigenerata dalla produzione (e le altre che quella sezione nomina),
riga di stato a «in produzione» col commit di main, Stato della voce nel PRD.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Atteso: dopo `git add -u` ogni riga comincia con `M ` e i file sono solo quelli che la sezione nomina, più la specifica e il PRD; nessun file non tracciato nuovo.

- [ ] **Passo 7: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
```

Atteso: tutti i file verdi tranne, al massimo, `__tests__/architecture/offline-html-nativo.test.ts`. In un worktree nuovo è rosso perché la shell nativa non è sincronizzata, e si rilancia così:

```bash
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed (1)`. Un lock di fotografia rosso vuol dire, quasi sempre, una voce del Passo 6 saltata: rileggi quella sezione. Qualunque altro rosso va capito prima di toccare codice.

- [ ] **Passo 8: la build di partenza**

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso: `✓ Compiled` e nessun `Error`. Senza heap a 8192 MB la build va in OOM su questa macchina.

---

### Compito 2 — `leggiABlocchi` in `src/lib/db/`, con la chiave unica

**File:**
- Crea: `src/lib/db/leggi-a-blocchi.ts` (con `git mv` da `src/lib/pagamenti/leggi-a-blocchi.ts`)
- Riscrivi: `src/lib/pagamenti/leggi-a-blocchi.ts`
- Test: `__tests__/lib/db-leggi-a-blocchi.test.ts` (nuovo), `__tests__/pagamenti/leggi-a-blocchi.test.ts` (invariato)

- [ ] **Passo 1: il test rosso**

Crea `__tests__/lib/db-leggi-a-blocchi.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as daDb from '@/lib/db/leggi-a-blocchi'
import type { QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
import * as daPagamenti from '@/lib/pagamenti/leggi-a-blocchi'

/**
 * `leggiABlocchi` in `src/lib/db/` (robustezza 2, sessione 11).
 *
 * Due cose da provare. La prima: lo spostamento non cambia niente per chi importava dal percorso
 * dei pagamenti — gli oggetti sono GLI STESSI. La seconda: ogni blocco si ordina per una chiave
 * UNICA. Senza, Postgres restituisce i pari (stessa `created_at`, stesso `student_id`) in un
 * ordine qualunque, diverso da una richiesta all'altra, e due blocchi `range` consecutivi si
 * sovrappongono: righe doppie da una parte, righe perse dall'altra.
 */

type Riga = Record<string, string>

/**
 * Una sorgente che si comporta come Postgres: ordina per le colonne chieste e, fra righe pari su
 * quelle colonne, restituisce un ordine qualunque — qui il caso peggiore e ripetibile, l'ordine
 * rovesciato a ogni richiesta dispari (`sort` è stabile, quindi i pari restano nell'ordine della
 * base). Con una chiave unica i pari non esistono, e i blocchi combaciano.
 */
function sorgenteCheRimescola(righe: readonly Riga[]) {
  let richieste = 0
  const ordini: string[][] = []
  const costruisci = (): QueryABlocchi => {
    const n = richieste++
    const chieste: string[] = []
    ordini.push(chieste)
    const q: QueryABlocchi = {
      order(colonna: string) {
        chieste.push(colonna)
        return q
      },
      range(da: number, a: number) {
        const base = n % 2 === 0 ? [...righe] : [...righe].reverse()
        base.sort((x, y) => {
          for (const c of chieste) {
            const d = (x[c] ?? '').localeCompare(y[c] ?? '')
            if (d !== 0) return d
          }
          return 0
        })
        return Promise.resolve({ data: base.slice(da, a + 1), error: null })
      },
    }
    return q
  }
  return { costruisci, ordini }
}

/** Quattro alunni, due genitori ciascuno: la forma di `student_parents`, che non ha `id`. */
const LEGAMI: Riga[] = ['s0', 's1', 's2', 's3'].flatMap((s) =>
  ['p0', 'p1'].map((p) => ({ student_id: s, parent_id: p })),
)
const coppia = (r: Riga) => `${r.student_id}|${r.parent_id}`

describe('leggiABlocchi in `src/lib/db/` — sposta e riesporta', () => {
  it('il modulo dei pagamenti riesporta GLI STESSI oggetti: chi lo importava non cambia', () => {
    expect(daPagamenti.leggiABlocchi).toBe(daDb.leggiABlocchi)
    expect(daPagamenti.descriviTetto).toBe(daDb.descriviTetto)
    expect(daPagamenti.BLOCCO_LETTURA).toBe(daDb.BLOCCO_LETTURA)
    expect(daPagamenti.MAX_BLOCCHI_LETTURA).toBe(daDb.MAX_BLOCCHI_LETTURA)
  })
})

describe('leggiABlocchi — ogni blocco è ordinato per una chiave UNICA', () => {
  it('CONTROLLO: con una chiave che non è unica la sorgente perde e raddoppia righe (il test vede il difetto)', async () => {
    const s = sorgenteCheRimescola(LEGAMI)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 3, chiave: ['student_id'] })
    expect(e.ok).toBe(true)
    const lette = e.ok ? e.righe.map(coppia) : []
    expect(lette).toHaveLength(LEGAMI.length)
    expect(new Set(lette).size).toBeLessThan(LEGAMI.length)
  })

  it('`student_parents` con la sua chiave primaria (student_id, parent_id): ogni coppia, una volta sola', async () => {
    const s = sorgenteCheRimescola(LEGAMI)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 3, chiave: ['student_id', 'parent_id'] })
    const lette = e.ok ? e.righe.map(coppia) : []
    expect(lette).toHaveLength(LEGAMI.length)
    expect(new Set(lette)).toEqual(new Set(LEGAMI.map(coppia)))
    for (const o of s.ordini) expect(o).toEqual(['student_id', 'parent_id'])
  })

  it('senza `chiave` resta `id`, in coda all’ordine del chiamante: com’era prima dello spostamento', async () => {
    const righe = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, created_at: '2026-10-20T08:00:00.000Z' }))
    const s = sorgenteCheRimescola(righe)
    const e = await daDb.leggiABlocchi<Riga>(() => s.costruisci().order('created_at'), { blocco: 3 })
    expect(e.ok && e.righe.map((r) => r.id)).toEqual(righe.map((r) => r.id))
    for (const o of s.ordini) expect(o).toEqual(['created_at', 'id'])
  })

  it('una `chiave` vuota non toglie l’ordine: si torna a `id`', async () => {
    const righe = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }))
    const s = sorgenteCheRimescola(righe)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 2, chiave: [] })
    expect(e.ok && e.righe).toHaveLength(5)
    for (const o of s.ordini) expect(o).toEqual(['id'])
  })
})
```

- [ ] **Passo 2: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/lib/db-leggi-a-blocchi.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`, perché l'import `@/lib/db/leggi-a-blocchi` non si risolve (`Failed to resolve import` oppure `Cannot find module`).

- [ ] **Passo 3: sposta il file, conservandone la storia**

```bash
git mv src/lib/pagamenti/leggi-a-blocchi.ts src/lib/db/leggi-a-blocchi.ts
```

- [ ] **Passo 4: la testata del file spostato**

In `src/lib/db/leggi-a-blocchi.ts` sostituisci le righe 1-3:

```ts
/**
 * ─── LEGGERE TUTTO, A BLOCCHI (revisione 2026-09-28) ────────────────────────────────
 *
```

con:

```ts
/**
 * ─── LEGGERE TUTTO, A BLOCCHI (revisione 2026-09-28) ────────────────────────────────
 *
 * DOVE STA, E PERCHÉ QUI. È nato nei pagamenti (l'export dello Scadenzario) e ci è rimasto fino
 * alla sessione 11 della seconda serie di robustezza (ottobre 2026), quando è stato spostato qui,
 * accanto ad `aBlocchi` e a `RIGHE_MASSIME_POSTGREST`: è la paginazione di PostgREST, non una
 * regola dei pagamenti. `src/lib/pagamenti/leggi-a-blocchi.ts` resta e RIESPORTA da qui, così
 * nessun chiamante di prima cambia, né i test che mockano quel percorso. Il codice nuovo importa
 * da `@/lib/db/leggi-a-blocchi`, e il lock `__tests__/architecture/letture-a-blocchi.test.ts` lo
 * pretende nei file che sorveglia.
 *
```

- [ ] **Passo 5: «L'ORDINE STABILE» parla della chiave**

Nello stesso file sostituisci:

```ts
 * sovrappongono e perdono righe. Per questo `id` lo aggiunge QUI, in coda all'ordine del
 * chiamante: chi usa questo modulo non può dimenticarlo.
```

con:

```ts
 * sovrappongono e perdono righe. Per questo la chiave UNICA la aggiunge QUI, in coda
 * all'ordine del chiamante: chi usa questo modulo non può dimenticarla. Di solito è `id`; una
 * tabella senza `id` passa la sua con l'opzione `chiave` — `student_parents` ha come chiave
 * primaria la coppia `(student_id, parent_id)`, e ordinarla per `id` sarebbe un `42703`.
```

- [ ] **Passo 6: l'opzione `chiave`**

Sostituisci l'interfaccia delle opzioni:

```ts
interface OpzioniABlocchi {
  /** Solo per i test: il blocco e il tetto veri sono le costanti qui sopra. */
  blocco?: number
  maxBlocchi?: number
}
```

con:

```ts
export interface OpzioniABlocchi {
  /** Solo per i test: il blocco e il tetto veri sono le costanti qui sopra. */
  blocco?: number
  maxBlocchi?: number
  /**
   * Le colonne della chiave UNICA che chiudono l'ordine di ogni blocco (vedi «L'ORDINE
   * STABILE»). Assente o vuota vale `['id']`: il comportamento di sempre.
   */
  chiave?: readonly string[]
}

/** La chiave unica di quasi ogni tabella del progetto. */
const CHIAVE_PREDEFINITA: readonly string[] = ['id']
```

E dentro `leggiABlocchi` sostituisci la riga:

```ts
  const pagina = (da: number, a: number) => costruisci().order('id', { ascending: true }).range(da, a)
```

con:

```ts
  const chiave = o.chiave && o.chiave.length > 0 ? o.chiave : CHIAVE_PREDEFINITA
  const pagina = (da: number, a: number) => {
    let q = costruisci()
    for (const colonna of chiave) q = q.order(colonna, { ascending: true })
    return q.range(da, a)
  }
```

- [ ] **Passo 7: il vecchio percorso riesporta**

Crea di nuovo `src/lib/pagamenti/leggi-a-blocchi.ts`, con questo solo contenuto:

```ts
/**
 * `leggiABlocchi` vive in `src/lib/db/leggi-a-blocchi.ts` dalla sessione 11 della seconda serie
 * di robustezza: è la paginazione di PostgREST, non una regola dei pagamenti.
 *
 * Questo modulo resta per chi lo importava già (sei route, `guasto-db.ts`,
 * `export-rette-a-carico.ts`, e i test che lo mockano per percorso) e riesporta GLI STESSI
 * oggetti: nessun comportamento cambia. Il codice nuovo importa da `@/lib/db/leggi-a-blocchi`.
 */
export {
  BLOCCO_LETTURA,
  MAX_BLOCCHI_LETTURA,
  descriviTetto,
  leggiABlocchi,
} from '@/lib/db/leggi-a-blocchi'
export type { EsitoABlocchi, OpzioniABlocchi, QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
```

- [ ] **Passo 8: test verdi, il nuovo e quello di prima**

```bash
npx vitest run __tests__/lib/db-leggi-a-blocchi.test.ts __tests__/pagamenti/leggi-a-blocchi.test.ts __tests__/api/admin-chat-docenti-senza-push-blocchi.test.ts __tests__/api/pagamenti-export-a-blocchi.test.ts __tests__/architecture/report-aggregati-in-sql.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  5 passed (5)`. I due test che mockano `@/lib/pagamenti/leggi-a-blocchi` con `{ ...vero, leggiABlocchi: … }` restano verdi, perché lo spread di un modulo che riesporta porta con sé gli stessi nomi. `tsc` non stampa niente.

- [ ] **Passo 9: commit**

```bash
git add src/lib/db/leggi-a-blocchi.ts src/lib/pagamenti/leggi-a-blocchi.ts __tests__/lib/db-leggi-a-blocchi.test.ts
git commit -m "$(cat <<'EOF'
leggiABlocchi in src/lib/db, con la chiave unica per blocco

Il modulo esce dai pagamenti e va accanto ad aBlocchi; il vecchio percorso
riesporta gli stessi oggetti. Nuova opzione `chiave` (default ['id']) per
le tabelle senza id, come student_parents.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 3 — Il segnale prima della cura: `max-rows-raggiunto`

**File:**
- Modifica: `src/lib/logging/supabase-fetch.ts:1-6`, `:372-383`, e dopo la riga 626
- Test: `__tests__/lib/logging-max-rows.test.ts` (nuovo)

- [ ] **Passo 1: il test rosso**

Crea `__tests__/lib/logging-max-rows.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { maxRowsRaggiunto } from '@/lib/logging/supabase-fetch'

/**
 * `max-rows-raggiunto` (robustezza 2, sessione 11).
 *
 * PostgREST taglia ogni risposta a `max_rows` (1000, `supabase/config.toml:18`) e non lo dice:
 * nessun errore, nessuno status diverso. L'unica traccia è `Content-Range`, che il client legge
 * solo per il conteggio. Qui si prova la regola che la trasforma in un `warn` persistito, con la
 * tabella e la route — e soprattutto i casi in cui NON deve scattare: le pagine di
 * `leggiABlocchi` (`.range(0, 999)` chiede `limit=1000` e riceve `0-999/*`) sono piene per
 * scelta, non per taglio. Se scattassero, il segnale non andrebbe mai a zero.
 */

type Riga = {
  livello: string
  evento: string
  messaggio: string
  statoHttp?: number
  bersaglio?: string
  contestoExtra?: { campi?: Record<string, unknown> }
}

/**
 * `SILENZIOSO` si valuta al caricamento di `logger.ts`: si ricarica il registro con `VITEST`
 * vuota. `app-log` è mockato perché `.env.local` punta alla produzione. Il mock annota la route
 * del contesto nel momento della scrittura: è ciò che `app-log.ts` mette nella colonna `route`.
 */
async function carica() {
  const percorsi: (string | undefined)[] = []
  const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  const strumento = await import('@/lib/logging/supabase-fetch')
  const context = await import('@/lib/logging/context')
  appLog.mockImplementation(async () => {
    percorsi.push(context.contesto()?.path)
  })
  return { ...strumento, ...context, appLog, percorsi }
}

const TABELLA = 'https://x.supabase.co/rest/v1/alunni?select=id%2Cscuola_id&scuola_id=in.%28a%29'
const RPC = 'https://x.supabase.co/rest/v1/rpc/conta_cose'

function ok(contentRange?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (contentRange) headers['content-range'] = contentRange
  return new Response('[]', { status: 200, headers })
}

describe('maxRowsRaggiunto — la regola, con intestazioni finte', () => {
  const base = { verbo: 'GET', area: 'db' as const, url: TABELLA }

  it.each([
    ['0-999/*', TABELLA, { righe: 1000, limite: undefined }],
    ['0-999/1500', TABELLA, { righe: 1000, limite: undefined }],
    ['0-999/*', `${TABELLA}&limit=5000`, { righe: 1000, limite: 5000 }],
    ['1000-1999/*', `${TABELLA}&offset=1000&limit=2000`, { righe: 1000, limite: 2000 }],
  ])('%s su %s → scatta', (contentRange, url, atteso) => {
    expect(maxRowsRaggiunto({ ...base, url, contentRange })).toEqual(atteso)
  })

  it('anche una funzione chiamata in GET (`rpc`) può essere tagliata', () => {
    expect(maxRowsRaggiunto({ ...base, area: 'rpc', url: RPC, contentRange: '0-999/*' })).toEqual({
      righe: 1000,
      limite: undefined,
    })
  })

  it.each([
    ['0-998/999', TABELLA, 'meno di max_rows'],
    ['0-999/1000', TABELLA, 'il totale dice che è arrivato tutto'],
    ['0-999/*', `${TABELLA}&offset=0&limit=1000`, 'la prima pagina di leggiABlocchi'],
    ['1000-1999/*', `${TABELLA}&offset=1000&limit=1000`, 'la seconda pagina di leggiABlocchi'],
    ['*/0', TABELLA, 'risposta vuota'],
    [null, TABELLA, 'intestazione assente'],
    ['0-999', TABELLA, 'intestazione fuori forma'],
  ])('%s su %s → non scatta (%s)', (contentRange, url) => {
    expect(maxRowsRaggiunto({ ...base, url, contentRange })).toBeNull()
  })

  it('POST e HEAD non scattano, nemmeno con 0-999/*', () => {
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'rpc', url: RPC, contentRange: '0-999/*' })).toBeNull()
    expect(maxRowsRaggiunto({ ...base, verbo: 'HEAD', contentRange: '0-999/*' })).toBeNull()
  })

  it('storage e auth non scattano: max_rows è di PostgREST', () => {
    expect(maxRowsRaggiunto({ ...base, area: 'storage', contentRange: '0-999/*' })).toBeNull()
    expect(maxRowsRaggiunto({ ...base, area: 'auth', contentRange: '0-999/*' })).toBeNull()
  })
})

describe('supabase-fetch — la riga `max-rows-raggiunto`', () => {
  let err: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('KV_LOG_LEVEL', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    err = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('una GET senza `limit` che riceve 0-999/*: un warn persistito, con la tabella e la route', async () => {
    const { creaFetchStrumentato, conContesto, appLog, percorsi } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))

    const res = await conContesto({ requestId: 'r1', path: '/api/admin/parents' }, () => f(TABELLA))

    // La risposta arriva intatta: il segnale osserva, non cambia niente.
    expect(res.status).toBe(200)
    expect(appLog).toHaveBeenCalledTimes(1)
    const riga = appLog.mock.calls[0][0]
    expect(riga).toMatchObject({ livello: 'warn', evento: 'db', messaggio: 'max-rows-raggiunto', statoHttp: 200 })
    expect(riga.contestoExtra?.campi).toMatchObject({ operazione: 'alunni', righe: 1000, esito: 'max-rows-raggiunto' })
    // Una riga per tabella: due letture troncate sulla stessa route non si sommano in una.
    expect(riga.bersaglio).toBe('operazione=alunni')
    expect(percorsi).toEqual(['/api/admin/parents'])
    // Su Vercel esce come KV_WARN, sul canale degli errori (console.warn non si usa).
    const testo = err.mock.calls.map((c) => String(c[0])).join('\n')
    expect(testo).toContain('KV_WARN')
    expect(testo).toContain('esito=max-rows-raggiunto')
  })

  it('la pagina di leggiABlocchi (offset=0&limit=1000, 0-999/*) non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))
    await f(`${TABELLA}&offset=0&limit=1000`)
    expect(appLog).not.toHaveBeenCalled()
  })

  it('0-998/999 non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-998/999'))
    await f(TABELLA)
    expect(appLog).not.toHaveBeenCalled()
  })

  it('una POST (rpc) con 0-999/* non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))
    await f(RPC, { method: 'POST', body: '{}' })
    expect(appLog).not.toHaveBeenCalled()
  })

  it('FAIL-OPEN: intestazioni che lanciano non tolgono la risposta al chiamante', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const ostile = ok('0-999/*')
    Object.defineProperty(ostile, 'headers', {
      get() {
        throw new Error('getter ostile')
      },
    })
    const f = creaFetchStrumentato(async () => ostile)
    await expect(f(TABELLA)).resolves.toBe(ostile)
    expect(appLog).not.toHaveBeenCalled()
  })
})
```

- [ ] **Passo 2: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/lib/logging-max-rows.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. I casi della regola falliscono con `maxRowsRaggiunto is not a function`. Il primo caso della riga fallisce con `expected "spy" to be called 1 times, but got 0 times`.

- [ ] **Passo 3: l'import**

In `src/lib/logging/supabase-fetch.ts`, sotto la riga 6 (`import { limitaRetryAfter, … } from '@/lib/supabase/attesa-ritentativi';`) aggiungi:

```ts
import { RIGHE_MASSIME_POSTGREST } from '@/lib/db/blocchi';
```

- [ ] **Passo 4: il ramo della risposta ok**

Sostituisci le righe 372-383:

```ts
        try {
            const esito = esitoDi(res);
            if (esito === 'ko') {
                await registraFallimento(b, res, ms);
            } else if (esito === 'illeggibile') {
                registraIlleggibile(b, res, ms);
            } else if (ms > LENTA_MS) {
                registraLenta(b, res, ms);
            }
        } catch {
            // L'osservabilità non può rompere la risposta che sta osservando: si perde il log.
        }
```

con:

```ts
        try {
            const esito = esitoDi(res);
            if (esito === 'ko') {
                await registraFallimento(b, res, ms);
            } else if (esito === 'illeggibile') {
                registraIlleggibile(b, res, ms);
            } else {
                // Una risposta OK può essere TRONCATA (`max_rows`): si guarda prima della lentezza,
                // e `registraMaxRows` ha il suo `try`, così un guasto lì non spegne la riga della lenta.
                registraMaxRows(b, input, init, res);
                if (ms > LENTA_MS) registraLenta(b, res, ms);
            }
        } catch {
            // L'osservabilità non può rompere la risposta che sta osservando: si perde il log.
        }
```

- [ ] **Passo 5: le funzioni nuove**

Subito dopo la funzione `contaLenta` (che finisce alla riga 626), aggiungi:

```ts
/* ────────────────────────────────────────────────────────────────────────────
 * `max_rows`: la risposta piena che non lo dice (robustezza 2, sessione 11).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * PostgREST taglia OGNI risposta a `max_rows` righe (1000, `supabase/config.toml:18`) e non lo
 * dice: nessun errore, nessuno status diverso, e postgrest-js legge `Content-Range` solo per il
 * conteggio. In questo repo ha già morso tre volte (export delle rette, statistiche degli avvisi,
 * routine del diario), sempre scoperto per caso.
 *
 * LA REGOLA. Una `GET` di PostgREST (area `db` o `rpc`) ha toccato il tetto quando:
 *  · `Content-Range` dichiara ALMENO `RIGHE_MASSIME_POSTGREST` righe (`0-999/*`, `1000-1999/*`);
 *  · il totale è ignoto (`*`) o più grande dell'ultima riga arrivata (`0-999/1500`): con
 *    `count: 'exact'` e `0-999/1000` è arrivato tutto, e non è un taglio;
 *  · il parametro `limit` dell'indirizzo manca, oppure chiede PIÙ righe di quante ne sono
 *    arrivate. È ciò che distingue un taglio da una pagina: postgrest-js traduce `.range(da, a)`
 *    in `limit = a - da + 1`, quindi le pagine di `leggiABlocchi` (`limit=1000`, `0-999/*`) sono
 *    piene per scelta. `.limit(5000)` che riceve 1000 righe, invece, è stato tagliato.
 *
 * NON è «un `Content-Range` che finisce a 999»: quella regola scatterebbe su ogni prima pagina di
 * `leggiABlocchi` e mancherebbe tutte le successive. `>=` e non `===`: `RIGHE_MASSIME_POSTGREST`
 * è una SOGLIA DI SOSPETTO (vedi la sua testata in `@/lib/db/blocchi`).
 *
 * Pura e senza eccezioni: la prova sta in `__tests__/lib/logging-max-rows.test.ts`.
 */
export function maxRowsRaggiunto(r: {
    verbo: string;
    area: Bersaglio['area'];
    url: string;
    contentRange: string | null | undefined;
}): { righe: number; limite: number | undefined } | null {
    try {
        if (r.verbo !== 'GET') return null;
        if (r.area !== 'db' && r.area !== 'rpc') return null;
        const m = /^\s*(\d+)-(\d+)\/(\d+|\*)\s*$/.exec(r.contentRange ?? '');
        if (!m) return null;
        const fine = Number(m[2]);
        const righe = fine - Number(m[1]) + 1;
        if (!Number.isSafeInteger(righe) || righe < RIGHE_MASSIME_POSTGREST) return null;
        if (m[3] !== '*' && fine + 1 >= Number(m[3])) return null;
        const limite = limiteChiesto(r.url);
        if (limite !== undefined && limite <= righe) return null;
        return { righe, limite };
    } catch {
        return null;
    }
}

/** Il parametro `limit` dell'indirizzo di PostgREST, se c'è ed è un numero. Non lancia. */
function limiteChiesto(indirizzo: string): number | undefined {
    try {
        const v = new URL(indirizzo).searchParams.get('limit');
        if (v === null) return undefined;
        const n = Number(v);
        return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Il verbo HTTP della richiesta, con la stessa regola che usa `descrivi`: prima `init.method`
 * (postgrest-js lo passa sempre), poi quello di una `Request`, altrimenti `GET`. Non lancia.
 */
function verboDi(input: unknown, init: RequestInit | undefined): string {
    try {
        const v = init?.method ?? (input as { method?: unknown } | null | undefined)?.method ?? 'GET';
        return typeof v === 'string' ? v.toUpperCase() : 'GET';
    } catch {
        return 'GET';
    }
}

/**
 * `warn` persistito: la riga in `app_log` porta la tabella (o la funzione) in `operazione`, le
 * righe arrivate e il `limit` chiesto, e la route nella colonna `route` (dal contesto della
 * richiesta, come ogni riga). `distingui: ['operazione']`: due letture troncate sulla stessa
 * route restano due righe, una per tabella. Una riga al giorno per impronta, con `occorrenze`.
 *
 * Fail-open (AGENTS.md, regola 9): qualunque eccezione qui dentro si perde, e la risposta arriva
 * al chiamante intatta.
 */
function registraMaxRows(b: Descrizione, input: unknown, init: RequestInit | undefined, res: Response): void {
    try {
        const visto = maxRowsRaggiunto({
            verbo: verboDi(input, init),
            area: b.area,
            url: url(input),
            contentRange: res.headers.get('content-range'),
        });
        if (!visto) return;
        const s = stato(res);
        logEvento(
            b.area,
            'warn',
            campiDi(b, { stato: s, righe: visto.righe, limite: visto.limite, esito: 'max-rows-raggiunto' }),
            undefined,
            { persisti: daPersistere('warn', b.area, s ?? 0), distingui: ['operazione'] },
        );
    } catch {
        // Un'intestazione illeggibile non toglie la risposta a nessuno: si perde la riga.
    }
}
```

- [ ] **Passo 6: test verdi, il nuovo e quelli del `fetch` strumentato**

```bash
npx vitest run __tests__/lib/logging-max-rows.test.ts __tests__/lib/logging-supabase-fetch.test.ts __tests__/lib/logging-rumore-lente.test.ts __tests__/lib/logging-tetto.test.ts __tests__/architecture/supabase-client-strumentato.test.ts __tests__/architecture/eventi-log.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  6 passed (6)` e `tsc` senza output.

- [ ] **Passo 7: commit**

```bash
git add src/lib/logging/supabase-fetch.ts __tests__/lib/logging-max-rows.test.ts
git commit -m "$(cat <<'EOF'
Logging: warn max-rows-raggiunto quando PostgREST taglia una GET

Una GET di PostgREST con Content-Range di almeno 1000 righe, senza un
limit che le abbia chieste e senza un totale che dica che e' arrivato
tutto, scrive un warn persistito con la tabella e la route. Le pagine di
leggiABlocchi (limit=1000) non lo accendono. Fail-open.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — L'elenco genitori a blocchi

**File:**
- Modifica: `src/app/api/admin/parents/route.ts:13-15`, dopo `:71`, `:114-163`
- Test: `__tests__/api/admin-parents-elenco-a-blocchi.test.ts` (nuovo)

- [ ] **Passo 1: il test rosso**

Crea `__tests__/api/admin-parents-elenco-a-blocchi.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * L'ELENCO GENITORI OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * Il finto con `maxRighe: 1000` fa ciò che fa PostgREST: una lettura non restituisce mai più di
 * 1000 righe, e non lo dice. L'elenco legge gli alunni (di TUTTI gli stati), i legami e i
 * genitori: ognuna delle tre letture poteva uscire corta. La Prova della specifica è il
 * confronto qui sotto: il totale dell'elenco coincide con il `count(distinct parent_id)` dei
 * legami degli alunni delle stesse sedi.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireStaff: h.requireStaff,
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const finto = () => creaFintoSupabase(h.db, [], { maxRighe: 1000, errori: h.errori })
  return { createAdminClient: async () => finto(), createClient: async () => finto() }
})

import { GET } from '@/app/api/admin/parents/route'

/** uuid sintetici: una lettera di prefisso e un numero, nient'altro. */
const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

function dbGrande(): DBFinto {
  // 1200 alunni nella sede A (metà ritirati: l'anagrafica li legge tutti) e 50 nella sede B.
  const alunni = [
    ...Array.from({ length: 1200 }, (_, i) => ({
      id: uuid('a', i), scuola_id: SEDE_A, stato: i % 2 === 0 ? 'iscritto' : 'ritirato',
    })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: uuid('b', i), scuola_id: SEDE_B, stato: 'iscritto' })),
  ]
  // Un genitore per alunno, e un secondo per i primi 400 della sede A: 1650 legami.
  const student_parents = [
    ...alunni.map((a, i) => ({ student_id: a.id, parent_id: uuid('c', i) })),
    ...alunni.slice(0, 400).map((a, i) => ({ student_id: a.id, parent_id: uuid('c', i + 1) })),
  ]
  const parents = alunni.map((_, i) => ({
    id: uuid('c', i), first_name: 'G', last_name: `N${i}`, emails: [], phone_numbers: [], fiscal_code: null,
  }))
  return { alunni, student_parents, parents }
}

/** Il `count(distinct sp.parent_id)` della specifica, fatto sui dati finti. */
function genitoriDistinti(db: DBFinto, sedi: string[]): number {
  const alunniDelleSedi = new Set(
    db.alunni.filter((a) => sedi.includes(a.scuola_id as string)).map((a) => a.id),
  )
  return new Set(
    db.student_parents.filter((l) => alunniDelleSedi.has(l.student_id)).map((l) => l.parent_id),
  ).size
}

const req = () => new NextRequest('http://localhost/api/admin/parents')

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbGrande()
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/admin/parents — oltre le 1000 righe', () => {
  it('il totale dell’elenco coincide con il count(distinct) dei legami della sede', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; scuole_ids: string[] }[]
    expect(j).toHaveLength(genitoriDistinti(h.db, [SEDE_A]))
    expect(j).toHaveLength(1200)
    expect(new Set(j.map((p) => p.id)).size).toBe(j.length)
    expect(j.every((p) => p.scuole_ids.length === 1 && p.scuole_ids[0] === SEDE_A)).toBe(true)
  })

  it('con due sedi attive: il totale delle due, e la sede B non si perde dietro la A', async () => {
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
    const j = (await (await GET(req())).json()) as { id: string; scuole_ids: string[] }[]
    expect(j).toHaveLength(genitoriDistinti(h.db, [SEDE_A, SEDE_B]))
    expect(j.filter((p) => p.scuole_ids.includes(SEDE_B))).toHaveLength(50)
  })

  it('una lettura dei legami che fallisce dà 500: mai un elenco a metà', async () => {
    h.errori = { student_parents: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(Array.isArray(await res.json())).toBe(false)
  })
})
```

- [ ] **Passo 2: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/api/admin-parents-elenco-a-blocchi.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. I primi due casi falliscono: l'elenco ha 1000 genitori invece di 1200 (e invece di 1250). Il terzo è già verde: è la guardia del tutto-o-niente, e la correzione non deve romperla.

- [ ] **Passo 3: gli import**

In `src/app/api/admin/parents/route.ts`, sotto la riga 15 (`import { selectResiliente } from '@/lib/supabase/select-resiliente';`), aggiungi:

```ts
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi';
```

- [ ] **Passo 4: la risposta al guasto di una lettura a blocchi**

Dopo la riga 71 (`const COLONNE_PER_ALUNNO = ['id', 'intestatario_default'];`), aggiungi:

```ts

/**
 * Un blocco caduto, o il tetto di `leggiABlocchi`: l'elenco non esce a metà. Una riga sola con
 * `stato: 500` (vedi «CHI LOGGA COSA» in `@/lib/db/leggi-a-blocchi`), e `logErrore` alza la marca
 * anti-doppione di `withRoute`. Sull'errore il corpo resta quello di prima (`{ error: message }`):
 * le risposte con il `message` di PostgREST si sistemano solo nelle sessioni dopo la 13 (specifica
 * della seconda serie, §7 «Sessione 13»), e questa non ne aggiunge di nuove.
 */
function guastoElenco(esito: Extract<EsitoABlocchi<unknown>, { ok: false }>, tipo: string): NextResponse {
    if (esito.motivo === 'tetto') {
        // Solo il nome della lettura e dei conteggi: mai dati (AGENTS.md, regola 8).
        logErrore(
            { operazione: 'admin/parents:GET', stato: 500, evento: 'lettura-troncata' },
            new Error(`${descriviTetto(tipo, esito)}, rifiutata per intero`),
        );
        return NextResponse.json({ error: "L'elenco non si è potuto leggere per intero." }, { status: 500 });
    }
    logErrore({ operazione: 'admin/parents:GET', stato: 500, evento: 'db' }, esito.error);
    const messaggio = (esito.error as { message?: unknown } | null)?.message;
    return NextResponse.json(
        { error: typeof messaggio === 'string' ? messaggio : 'Lettura non riuscita' },
        { status: 500 },
    );
}
```

- [ ] **Passo 5: le tre letture**

Sostituisci le righe 114-163, da `const plessi = await resolveScuoleAttive(request, supabase, auth.user);` fino a `return NextResponse.json(conSede);` compreso, con:

```ts
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);

        // ── A BLOCCHI: `max_rows` TAGLIA IN SILENZIO (robustezza 2, sessione 11) ──────────
        // Ognuna delle tre letture qui sotto restituiva al massimo 1000 righe, senza un errore.
        // Gli alunni sono di TUTTI gli stati (è un'anagrafica: vedi il lock
        // `elenchi-operativi-solo-iscritti`), e i legami genitore-figlio sono più degli alunni:
        // con «Tutte le sedi» l'elenco usciva corto e nessuno se ne accorgeva. Gli alunni si
        // leggono con `leggiABlocchi`; legami e genitori per blocchi di `ID_PER_QUERY` id
        // (l'`.in()` viaggia nell'URL), in parallelo per non sommare le attese. Un blocco
        // fallito fa fallire l'elenco intero.
        const alunniLetti = await leggiABlocchi<{ id: string; scuola_id: string | null }>(() =>
            supabase.from('alunni').select('id, scuola_id').in('scuola_id', plessi),
        );
        if (!alunniLetti.ok) return guastoElenco(alunniLetti, 'admin-parents-alunni');
        const sedePerAlunno = new Map(alunniLetti.righe.map((a) => [a.id, a.scuola_id ?? null]));
        const alunniIds = [...sedePerAlunno.keys()];
        if (alunniIds.length === 0) return NextResponse.json([]);

        const legamiLetti = await Promise.all(
            aBlocchi(alunniIds, ID_PER_QUERY).map((blocco) =>
                leggiABlocchi<{ parent_id: string; student_id: string }>(
                    () => supabase.from('student_parents').select('parent_id, student_id').in('student_id', blocco),
                    // `student_parents` non ha `id`: la chiave primaria è la coppia.
                    { chiave: ['student_id', 'parent_id'] },
                ),
            ),
        );
        const legami: { parent_id: string; student_id: string }[] = [];
        for (const esito of legamiLetti) {
            if (!esito.ok) return guastoElenco(esito, 'admin-parents-legami');
            legami.push(...esito.righe);
        }
        const parentIds = [...new Set(legami.map((l) => l.parent_id))];
        if (parentIds.length === 0) return NextResponse.json([]);

        // Sede del genitore = sedi dei suoi FIGLI. `parents` non ha (e non deve
        // avere) una colonna di sede: un genitore può avere figli in due plessi.
        // Senza questa derivazione la tab «Genitori» dell'anagrafica resta l'unica
        // lista di persone che non sa dire di quale scuola sta parlando (R72).
        const sediPerGenitore = new Map<string, Set<string>>();
        for (const l of legami) {
            const sede = sedePerAlunno.get(l.student_id);
            if (!sede) continue;
            const insieme = sediPerGenitore.get(l.parent_id) ?? new Set<string>();
            insieme.add(sede);
            sediPerGenitore.set(l.parent_id, insieme);
        }

        // Per chiave primaria, al massimo `ID_PER_QUERY` righe per blocco: nessun tetto da toccare.
        const genitoriLetti = await Promise.all(
            aBlocchi(parentIds, ID_PER_QUERY).map((blocco) =>
                selectResiliente(
                    COLONNE_ELENCO,
                    (cols) => supabase.from('parents').select(cols.join(', ')).in('id', blocco),
                    'admin/parents:GET',
                ),
            ),
        );
        const genitori: Record<string, unknown>[] = [];
        for (const { data, error } of genitoriLetti) {
            if (error) {
                logErrore({ operazione: 'admin/parents:GET', stato: 500, evento: 'db' }, error);
                return NextResponse.json({ error: error.message }, { status: 500 });
            }
            // `as unknown as` e non un cast diretto: `selectResiliente` è generica e
            // conserva il tipo vero di PostgREST (che su una select dinamica include
            // `GenericStringError[]`). Il tipo è più preciso, il cast deve dirlo.
            genitori.push(...((data ?? []) as unknown as Record<string, unknown>[]));
        }

        const conSede = genitori.map((p) => ({
            ...p,
            scuole_ids: [...(sediPerGenitore.get(p.id as string) ?? [])],
        }));
        return NextResponse.json(conSede);
```

- [ ] **Passo 6: test verdi, il nuovo e quelli della route**

```bash
npx vitest run __tests__/api/admin-parents-elenco-a-blocchi.test.ts __tests__/api/liste-persone-sede.test.ts __tests__/api/liste-anagrafica-proiezione-minima.test.ts __tests__/api/anagrafica-scope-sede.test.ts __tests__/api/admin-parents-patch-colonna-assente.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  8 passed (8)` e `tsc` senza output. `errori-con-codice` resta verde perché le tre risposte d'errore senza codice delle letture di prima (alunni, legami, genitori) diventano tre (le due di `guastoElenco` e quella dei genitori): il conteggio di `src/app/api/admin/parents/route.ts` nell'allowlist non cresce. Il lock `elenchi-operativi-solo-iscritti` continua a vedere **una** lettura scoperta di `alunni` in `admin/parents:GET`, cioè la sua voce della riga 417: la lettura è la stessa, ora dentro `leggiABlocchi`.

- [ ] **Passo 7: commit**

```bash
git add src/app/api/admin/parents/route.ts __tests__/api/admin-parents-elenco-a-blocchi.test.ts
git commit -m "$(cat <<'EOF'
Elenco genitori a blocchi: oltre 1000 righe non esce piu' corto

Alunni con leggiABlocchi, legami (chiave student_id+parent_id) e genitori
per blocchi di ID_PER_QUERY id in parallelo. Un blocco fallito o il tetto
danno 500 con una riga di log, mai un elenco a meta'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 5 — Il cruscotto presenze a blocchi

**File:**
- Modifica: `src/app/api/admin/presenze/realtime/route.ts:7`, `:10`, dopo `:21`, `:48-64`, `:83-88`
- Test: `__tests__/api/presenze-realtime.test.ts:7-35` e un caso nuovo, `__tests__/api/presenze-conteggi-fino-a-oggi.test.ts:55` e `:169-176`

- [ ] **Passo 1: il finto impara `order`, `range` e il tetto**

In `__tests__/api/presenze-realtime.test.ts` sostituisci le righe 7-35 (da `const h = vi.hoisted(` alla chiusura di `vi.mock('@/lib/supabase/server-client', …)`) con:

```ts
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rows: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; method: string; args: unknown[] }[],
  /** Il `max_rows` di PostgREST: nessuna risposta porta più righe di così, e nessuna lo dice. */
  MAX_ROWS: 1000,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const rows = () => h.rows[table] ?? []
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) =>
          res({ data: rows().slice(0, h.MAX_ROWS), error: null }),
      }
      const track = (method: string) => (...args: unknown[]) => {
        h.filters.push({ table, method, args })
        return b
      }
      b.select = track('select')
      b.in = track('in')
      b.eq = track('eq')
      b.limit = track('limit')
      b.order = track('order')
      // `.range()` chiude la catena di `leggiABlocchi`: la pagina chiesta, mai oltre il tetto.
      b.range = (da: number, a: number) => {
        h.filters.push({ table, method: 'range', args: [da, a] })
        return Promise.resolve({ data: rows().slice(da, a + 1).slice(0, h.MAX_ROWS), error: null })
      }
      return b
    },
  }),
}))
```

- [ ] **Passo 2: il caso nuovo**

In fondo al `describe('GET /api/admin/presenze/realtime', …)`, prima della `})` finale (riga 123), aggiungi:

```ts

  it('oltre max_rows: TUTTI gli iscritti e TUTTE le presenze, a blocchi ordinati per id, senza `.limit`', async () => {
    const id = (p: string, i: number) => `${p}-${String(i).padStart(4, '0')}`
    h.rows['alunni'] = Array.from({ length: 1500 }, (_, i) => ({ id: id('al', i), section_id: 'sez-a', scuola_id: 'sc-1' }))
    h.rows['presenze'] = Array.from({ length: 1200 }, (_, i) => ({ id: id('pr', i), alunno_id: id('al', i), stato: 'presente' }))
    h.rows['sections'] = [{ id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' }]
    h.rows['schools'] = [{ id: 'sc-1', nome: 'Kidville Centro' }]

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.totale).toMatchObject({ iscritti: 1500, presenti: 1200 })
    const ordini = h.filters.filter((f) => f.method === 'order').map((f) => `${f.table}:${String(f.args[0])}`)
    expect(new Set(ordini)).toEqual(new Set(['alunni:id', 'presenze:id']))
    // `.limit(5000)` non serviva: `max_rows` vince su qualunque `limit`.
    expect(h.filters.filter((f) => f.method === 'limit')).toEqual([])
  })
```

- [ ] **Passo 3: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/api/presenze-realtime.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. Solo il caso nuovo è rosso: arrivano `iscritti: 1000` e `presenti: 1000` invece di 1500 e 1200. Gli altri cinque restano verdi.

- [ ] **Passo 4: gli import e `comeRisposta`**

In `src/app/api/admin/presenze/realtime/route.ts` sostituisci la riga 7:

```ts
import { aggregaPresenze, TOTALE_VUOTO } from '@/lib/presenze/aggregate'
```

con:

```ts
import { aggregaPresenze, TOTALE_VUOTO, type AlunnoRow, type PresenzaRow } from '@/lib/presenze/aggregate'
```

Sotto la riga 10 (`import { logEvento } from '@/lib/logging/logger'`) aggiungi:

```ts
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi'
```

Dopo la riga 21 (`const getQuerySchema = z.object({}) // nessun parametro in ingresso`) aggiungi:

```ts

/**
 * L'esito di `leggiABlocchi` nella forma `{ data, error }` che il ciclo di log della route già
 * conosce. Il tetto diventa un errore che lo dice (`descriviTetto`): il cruscotto degrada come per
 * un guasto, e la riga `cockpit-lettura-parziale` porta i conteggi invece di un numero sbagliato.
 */
function comeRisposta<T>(esito: EsitoABlocchi<T>, tipo: string): { data: T[] | null; error: unknown } {
  if (esito.ok) return { data: esito.righe, error: null }
  if (esito.motivo === 'tetto') return { data: null, error: new Error(descriviTetto(tipo, esito)) }
  return { data: null, error: esito.error }
}
```

- [ ] **Passo 5: le letture**

Sostituisci le righe 48-64 (`const [alunniRes, presenzeRes, sectionsRes, schoolsRes] = await Promise.all([` fino alla `])` di chiusura) con:

```ts
  // ── A BLOCCHI (robustezza 2, sessione 11) ───────────────────────────────────
  // Con «Tutte le sedi» gli iscritti e le presenze di un giorno si avvicinano a 1000: oltre,
  // PostgREST consegnava le prime 1000 righe in silenzio, e il cruscotto contava meno presenti e
  // più «appelli mancanti» del vero. `.limit(5000)` non serviva a niente: `max_rows` vince su
  // qualunque `limit`. Sezioni e sedi dei plessi restano letture semplici (decine di righe).
  const [alunniLetti, presenzeLette, sectionsRes, schoolsRes] = await Promise.all([
    leggiABlocchi<AlunnoRow>(() =>
      supabase
        .from('alunni')
        .select('id, section_id, scuola_id')
        .in('scuola_id', plessi)
        .eq('stato', 'iscritto'),
    ),
    // Scope in query via join sull'alunno; l'aggregazione ignora comunque
    // le righe di alunni fuori elenco (doppia cintura).
    leggiABlocchi<PresenzaRow>(() =>
      supabase
        .from('presenze')
        .select('alunno_id, stato, alunni!inner ( scuola_id )')
        .eq('data', today)
        .in('alunni.scuola_id', plessi),
    ),
    supabase.from('sections').select('id, name, scuola_id').in('scuola_id', plessi),
    supabase.from('schools').select('id, nome').in('id', plessi),
  ])
  const alunniRes = comeRisposta(alunniLetti, 'presenze-realtime-alunni')
  const presenzeRes = comeRisposta(presenzeLette, 'presenze-realtime-presenze')
```

Il ciclo di log delle righe 71-81 resta com'è: legge `alunniRes` e `presenzeRes`, che ora vengono da `comeRisposta`. Anche l'aggregazione delle righe 83-88 resta uguale.

- [ ] **Passo 6: il finto del test dei conteggi impara `range`**

In `__tests__/api/presenze-conteggi-fino-a-oggi.test.ts` sostituisci la riga 55:

```ts
      for (const m of ['select', 'order', 'not', 'is'] as const) qb[m] = () => qb
```

con:

```ts
      // `range` chiude la catena di `leggiABlocchi` (cruscotto realtime, sessione 11): restituisce
      // il costruttore stesso, che è «thenable», e le righe arrivano dal `then` qui sotto.
      for (const m of ['select', 'order', 'not', 'is', 'range'] as const) qb[m] = () => qb
```

Nel test T27 (righe 169-176), la riga `await Realtime(new NextRequest('http://localhost/api/admin/presenze/realtime'))` diventa:

```ts
    const res = await Realtime(new NextRequest('http://localhost/api/admin/presenze/realtime'))
    // Un'asserzione che passa su un 500 non misura niente (la testata di questo finto lo dice).
    expect(res.status).toBe(200)
```

Il resto del test resta com'è. Senza `range` il cruscotto risponderebbe 500 e il filtro sulla data verrebbe registrato lo stesso: il test resterebbe verde per la ragione sbagliata.

- [ ] **Passo 7: test verdi**

```bash
npx vitest run __tests__/api/presenze-realtime.test.ts __tests__/api/presenze-conteggi-fino-a-oggi.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  2 passed (2)` e `tsc` senza output.

- [ ] **Passo 8: commit**

```bash
git add src/app/api/admin/presenze/realtime/route.ts __tests__/api/presenze-realtime.test.ts __tests__/api/presenze-conteggi-fino-a-oggi.test.ts
git commit -m "$(cat <<'EOF'
Cruscotto presenze a blocchi: iscritti e presenze oltre 1000 righe

Iscritti e presenze di oggi con leggiABlocchi; tolto .limit(5000), che
max_rows ignorava. Il tetto passa dalla riga cockpit-lettura-parziale.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — Il controllo del testo di classe a blocchi

**File:**
- Modifica: `src/lib/health/controlli.ts` — un import accanto a `import { versioneDeploy } from '@/lib/versione/deploy'`, una funzione dopo `function codiceDi`, l'intera `async function controlloTestoClasse` (al 20/10: righe 3, 541-550 e 1044-1077). Le sessioni 1, 6, 7 e 8 inseriscono righe più in alto nello stesso file: **ogni punto si trova per contenuto**, mai per numero di riga
- Test: `__tests__/lib/health/testo-classe-a-blocchi.test.ts` (nuovo)

- [ ] **Passo 1: il test rosso**

Crea `__tests__/lib/health/testo-classe-a-blocchi.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { eseguiQualita } from '@/lib/health/controlli'

/**
 * `sezione-testo-allineato` OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * Il controllo legge gli iscritti di TUTTE le sedi (è una sonda di qualità, senza filtro di sede).
 * Oltre 1000 PostgREST ne consegnava i primi 1000, e il controllo diceva «allineati» senza aver
 * guardato gli altri: un verde falso, la forma di silenzio che questo endpoint esiste per togliere.
 * Il finto con `maxRighe: 1000` fa ciò che fa PostgREST.
 */

const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

function db(divergentiInCoda: number): DBFinto {
  const n = 1200
  return {
    sections: [{ id: 's1', name: 'Sezione A' }],
    alunni: Array.from({ length: n }, (_, i) => ({
      id: uuid('a', i),
      section_id: 's1',
      // Le divergenze stanno IN CODA, oltre il millesimo: una lettura troncata non le vede.
      classe_sezione: i >= n - divergentiInCoda ? 'Sezione B' : 'Sezione A',
      stato: 'iscritto',
    })),
  }
}

describe('controllo `sezione-testo-allineato` — oltre le 1000 righe', () => {
  it('vede le divergenze oltre il millesimo iscritto', async () => {
    const salute = await eseguiQualita(creaFintoSupabase(db(5), [], { maxRighe: 1000 }))
    const c = salute.controlli.find((x) => x.nome === 'sezione-testo-allineato')
    expect(c?.esito).toBe('degradato')
    expect(c?.dettaglio).toBe('5 alunni col testo classe divergente')
  })

  it('senza divergenze conta TUTTI gli iscritti, non i primi 1000', async () => {
    const salute = await eseguiQualita(creaFintoSupabase(db(0), [], { maxRighe: 1000 }))
    // Per nome e non per posizione: un controllo aggiunto a `eseguiQualita` non deve spostare la prova.
    const c = salute.controlli.find((x) => x.nome === 'sezione-testo-allineato')
    expect(c).toMatchObject({ esito: 'ok', dettaglio: '1200 iscritti allineati' })
  })
})
```

- [ ] **Passo 2: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/lib/health/testo-classe-a-blocchi.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. Il primo caso riceve `esito: 'ok'` al posto di `degradato`. Il secondo riceve `1000 iscritti allineati` al posto di `1200 iscritti allineati`.

- [ ] **Passo 3: l'import e `motivoDi`**

In `src/lib/health/controlli.ts`, subito sotto la riga `import { versioneDeploy } from '@/lib/versione/deploy'` (la riga 3 al 20/10; cercala per contenuto: le sessioni precedenti possono aver aggiunto import), aggiungi:

```ts
import { leggiABlocchi, type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi'
```

Subito dopo la chiusura della funzione che comincia con `function codiceDi(err: unknown): string {` (righe 541-550 al 20/10; si cerca la firma, non il numero), aggiungi:

```ts

/** Il codice di una lettura a blocchi fallita: `tetto`, oppure il solo `code` di PostgREST. */
function motivoDi(esito: Extract<EsitoABlocchi<unknown>, { ok: false }>): string {
    return esito.motivo === 'tetto' ? 'tetto' : codiceDi(esito.error)
}
```

- [ ] **Passo 4: il controllo**

Sostituisci **l'intera funzione `controlloTestoClasse`**: dalla riga che comincia con `async function controlloTestoClasse(supabase: SupabaseClient): Promise<Controllo> {` fino alla sua `}` di chiusura, quella subito prima del commento `/* ════ … 7. La coda delle fatture Aruba non è ferma` (righe 1044-1077 al 20/10, ma le sessioni 1, 6, 7 e 8 inseriscono righe più in alto: si trova per contenuto, con `grep -n "^async function controlloTestoClasse" src/lib/health/controlli.ts`). Il commento di testa della funzione resta com'è. Il testo nuovo:

```ts
async function controlloTestoClasse(supabase: SupabaseClient): Promise<Controllo> {
    return misura('sezione-testo-allineato', 'degradato', async () => {
        // A BLOCCHI (robustezza 2, sessione 11): sopra 1000 righe PostgREST taglia in silenzio, e
        // qui un taglio è un VERDE FALSO — gli iscritti (o le sezioni) oltre il millesimo non
        // verrebbero confrontati. Il tetto di `leggiABlocchi` diventa `degradato`, col solo codice.
        const sezioni = await leggiABlocchi<{ id: string; name: string }>(() =>
            supabase.from('sections').select('id, name'),
        )
        // PostgREST non lancia: senza questo ramo una lettura caduta darebbe
        // «zero divergenze», cioè un verde che non ha misurato niente.
        if (!sezioni.ok) return { esito: 'degradato', dettaglio: `sections:${motivoDi(sezioni)}` }

        const alunni = await leggiABlocchi<{ section_id: string | null; classe_sezione: string | null }>(() =>
            supabase
                .from('alunni')
                .select('section_id, classe_sezione')
                .eq('stato', 'iscritto'),
        )
        if (!alunni.ok) return { esito: 'degradato', dettaglio: `alunni:${motivoDi(alunni)}` }

        const nomePerSezione = new Map(sezioni.righe.map((s) => [s.id, s.name]))
        const divergenti = alunni.righe.filter((a) => {
            const sid = a.section_id
            if (!sid) return false // gli orfani sono un'altra misura, non questa
            const nome = nomePerSezione.get(sid)
            return nome !== undefined && a.classe_sezione !== nome
        }).length

        // Nel corpo esce SOLO il numero: i nomi delle classi divergenti direbbero
        // a chiunque interroghi `/api/health` come si chiamano le sezioni della
        // scuola, e per contare non servono.
        if (divergenti > 0) {
            return { esito: 'degradato', dettaglio: `${divergenti} alunni col testo classe divergente` }
        }
        return { esito: 'ok', dettaglio: `${alunni.righe.length} iscritti allineati` }
    })
}
```

La testata del controllo (il commento subito sopra la funzione, righe 1035-1042 al 20/10) dice «Se un giorno gli iscritti diventassero decine di migliaia, la strada giusta è una vista o una RPC». Resta vera: oltre 50.000 righe `leggiABlocchi` si ferma al tetto e il controllo dice `alunni:tetto`.

- [ ] **Passo 5: test verdi**

```bash
npx vitest run __tests__/lib/health/testo-classe-a-blocchi.test.ts __tests__/api/health-livelli.test.ts __tests__/api/health.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  3 passed (3)` e `tsc` senza output. Il caso di `health-livelli.test.ts` con la lettura di `sections` caduta (righe 221-230) resta verde: l'errore arriva da `leggiABlocchi` come `motivo: 'errore'`, e il dettaglio porta ancora `57014`.

- [ ] **Passo 6: commit**

```bash
git add src/lib/health/controlli.ts __tests__/lib/health/testo-classe-a-blocchi.test.ts
git commit -m "$(cat <<'EOF'
Salute: il controllo del testo di classe legge sezioni e iscritti a blocchi

Oltre 1000 iscritti il controllo diceva "allineati" senza averli guardati
tutti. Ora legge tutto con leggiABlocchi; il tetto e' degradato col codice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — La bacheca dei promemoria a blocchi

**File:**
- Modifica: `src/app/api/tasks/route.ts:17`, `:492-506`, `:510`, `:522`
- Test: `__tests__/api/tasks-elenco-a-blocchi.test.ts` (nuovo), `__tests__/api/allegati-avvisi-task-firmati.test.ts:176-178`

- [ ] **Passo 1: il test rosso**

Crea `__tests__/api/tasks-elenco-a-blocchi.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

/**
 * LA BACHECA DEI PROMEMORIA OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * `task_interni` non ha un filtro di data: la bacheca cresce per sempre, e il filtro di
 * visibilità sta in JavaScript (autore e assegnatari vivono nel JSON di `contenuto`). Oltre 1000
 * promemoria in una sede PostgREST ne consegnava i primi 1000, e il resto spariva dalla bacheca.
 * Il finto con `maxRighe: 1000` fa ciò che fa PostgREST.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const finto = () => creaFintoSupabase(h.db, [], { maxRighe: 1000 })
  return { createAdminClient: async () => finto(), createClient: async () => finto() }
})
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))

import { GET } from '@/app/api/tasks/route'

const ADMIN = '11111111-1111-4111-8111-111111111111'
const N = 1005
const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

beforeEach(() => {
  vi.clearAllMocks()
  // Tutti creati nello stesso istante: l'ordine fra pari lo decide la chiave unica, `id`.
  h.db = {
    utenti: [],
    task_interni: Array.from({ length: N }, (_, i) => ({
      id: uuid('d', i),
      author_id: null,
      assigned_to: null,
      target_class: null,
      titolo: `T${i}`,
      contenuto: null,
      completato: false,
      created_at: '2026-10-20T08:00:00.000Z',
      scuola_id: SEDE_A,
    })),
  }
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/tasks — oltre le 1000 righe', () => {
  it('la direzione vede TUTTI i promemoria della sede, una volta sola ciascuno', async () => {
    const res = await GET(new NextRequest('http://localhost/api/tasks'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j).toHaveLength(N)
    expect(new Set(j.map((t) => t.id)).size).toBe(N)
  })

  it('a parità di `created_at` l’ordine è quello di `id`: stabile da un blocco all’altro', async () => {
    const j = (await (await GET(new NextRequest('http://localhost/api/tasks'))).json()) as { id: string }[]
    const attesi = h.db.task_interni.map((t) => t.id as string).sort()
    expect(j.map((t) => t.id)).toEqual(attesi)
  })
})
```

- [ ] **Passo 2: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/api/tasks-elenco-a-blocchi.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. Il primo caso riceve 1000 promemoria invece di 1005. Il secondo ha 1000 elementi contro 1005.

- [ ] **Passo 3: l'import**

In `src/app/api/tasks/route.ts`, sotto la riga 17 (`import { leggiVive } from '@/lib/gallery/cestino';`), aggiungi:

```ts
import { descriviTetto, leggiABlocchi } from '@/lib/db/leggi-a-blocchi';
```

- [ ] **Passo 4: la lettura**

Sostituisci le righe 492-506, da `// Fetch rows (all tasks — filtering happens in JS since author/assignee are in JSON)` fino alla `}` che chiude `if (rowsErr) { … }`, con:

```ts
        // Fetch rows (all tasks — filtering happens in JS since author/assignee are in JSON)
        //
        // ── A BLOCCHI (robustezza 2, sessione 11) ────────────────────────────
        // La bacheca non ha filtro di data e cresce per sempre: oltre 1000 promemoria in una
        // sede PostgREST consegnava i primi 1000 in silenzio. `leggiABlocchi` chiude l'ordine
        // con `id` dopo `created_at`, così i pari restano stabili da un blocco all'altro.
        const letti = await leggiABlocchi<Record<string, unknown>>(() =>
            supabase
                .from('task_interni')
                .select('id, author_id, assigned_to, target_class, titolo, contenuto, completato, created_at, scuola_id')
                .in('scuola_id', plessi)
                .order('created_at', { ascending: false }),
        );

        if (!letti.ok) {
            if (letti.motivo === 'tetto') {
                // Solo il nome della lettura e dei conteggi: mai dati (AGENTS.md, regola 8).
                logErrore(
                    { operazione: 'tasks:GET', stato: 500, evento: 'lettura-troncata' },
                    new Error(`${descriviTetto('tasks-bacheca', letti)}, rifiutata per intero`),
                );
            } else {
                // Il testo di PostgREST (nomi di colonna, di vincolo, di host) resta
                // nel log — con `codice`, che è il dato più utile che ha — e non
                // torna più al client: non gli dice niente di azionabile e descrive
                // lo schema a chi non deve conoscerlo.
                logErrore({ operazione: 'tasks:GET', stato: 500, evento: 'db' }, letti.error);
            }
            return NextResponse.json({ error: 'Lettura dei promemoria non riuscita' }, { status: 500 });
        }
        const rows = letti.righe;
```

Poi, nelle due righe che seguono (prima 510 e 522), sostituisci `const visible = (rows ?? [])` con `const visible = rows`. Il risultato di `leggiABlocchi` non è mai `null`.

- [ ] **Passo 5: vedi rosso il test degli allegati**

```bash
npx vitest run __tests__/api/allegati-avvisi-task-firmati.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. Falliscono i due casi di `GET /api/tasks` (righe 447 e 468). Il loro finto chiude ogni `.range()` con un elenco vuoto (riga 178), e la bacheca ora si chiude lì.

- [ ] **Passo 6: il finto degli allegati restituisce le righe vere**

In `__tests__/api/allegati-avvisi-task-firmati.test.ts` sostituisci le righe 176-178:

```ts
    // Statistiche avvisi in BLOCCO e paginate (T11-F2): la catena si chiude su
    // `.range()`, non più su `.then()`.
    b.range = async () => ({ data: [], count: 0, error: null })
```

con:

```ts
    // Statistiche avvisi in BLOCCO e paginate (T11-F2): la catena si chiude su
    // `.range()`, non più su `.then()`. Dalla sessione 11 di robustezza 2 si chiudono
    // su `.range()` anche l'archivio avvisi dello staff e la bacheca dei promemoria
    // (`leggiABlocchi`): per quelle due tabelle, la pagina chiesta delle righe vere.
    b.range = async (da: number, a: number) => {
      if (table === 'avvisi' || table === 'task_interni') {
        const righe = (result() as { data: unknown[] }).data
        return { data: righe.slice(da, a + 1), count: null, error: null }
      }
      return { data: [], count: 0, error: null }
    }
```

Il ramo `avvisi` serve al Compito 8. Qui non cambia niente, perché oggi l'archivio dello staff si chiude ancora su `.then()`.

- [ ] **Passo 7: test verdi**

```bash
npx vitest run __tests__/api/tasks-elenco-a-blocchi.test.ts __tests__/api/allegati-avvisi-task-firmati.test.ts __tests__/api/tasks-sede-dichiarata.test.ts __tests__/api/tasks-cestino-sezioni-dedotte.test.ts __tests__/api/tasks-identita-da-sessione.test.ts __tests__/api/tasks-lunghezza-massima.test.ts __tests__/api/gallery-chat-tasks-scope-sede.test.ts __tests__/api/tasks.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  8 passed (8)` e `tsc` senza output.

- [ ] **Passo 8: commit**

```bash
git add src/app/api/tasks/route.ts __tests__/api/tasks-elenco-a-blocchi.test.ts __tests__/api/allegati-avvisi-task-firmati.test.ts
git commit -m "$(cat <<'EOF'
Bacheca promemoria a blocchi: oltre 1000 righe non perde promemoria

task_interni con leggiABlocchi, ordine created_at poi id. Il tetto da'
500 con lettura-troncata; il finto degli allegati restituisce le righe.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 8 — L'archivio degli avvisi dello staff a blocchi

**File:**
- Modifica: `src/app/api/avvisi/route.ts:28`, `:385-421`
- Test: `__tests__/api/avvisi-staff-a-blocchi.test.ts` (nuovo), `__tests__/api/avvisi-route.test.ts:112-116`

- [ ] **Passo 1: il test rosso**

Crea `__tests__/api/avvisi-staff-a-blocchi.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * L'ARCHIVIO AVVISI DELLO STAFF OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * Allo staff gli avvisi scaduti non si nascondono (decisione del committente: il cockpit è anche
 * l'archivio), quindi l'elenco cresce per sempre. Oltre 1000 avvisi in una sede PostgREST ne
 * consegnava i primi 1000. Il finto con `maxRighe: 1000` fa ciò che fa PostgREST. Montaggio
 * ripreso da `avvisi-bacheca-docente.test.ts`.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: vi.fn(),
}))
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v,
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori, maxRighe: 1000 }),
  }
})

import { GET } from '@/app/api/avvisi/route'

const SEGRETERIA = 'seg-1'
const N = 1005
const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

const req = () => ({
  url: 'http://test/api/avvisi',
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams() },
  cookies: { get: () => undefined },
}) as never

const avviso = (id: string) => ({
  id,
  author_id: SEGRETERIA,
  titolo: id,
  contenuto: 'c',
  tipo: 'presa_visione',
  target_scope: 'globale',
  target_classes: null,
  scadenza: null,
  scadenza_avviso: '2026-12-31T22:59:59.999Z',
  scadenza_adesione: null,
  chiedi_numero: false,
  etichetta_numero: null,
  numero_min: 1,
  numero_max: 20,
  posti_totali: null,
  attachment_url: null,
  form_model_id: null,
  // Tutti nello stesso istante: l'ordine fra pari lo decide la chiave unica, `id`.
  created_at: '2026-10-05T08:00:00.000Z',
  scuola_id: SEDE_A,
})

const dbGrande = (): DBFinto => ({
  utenti: [{ id: SEGRETERIA, first_name: SEGRETERIA, last_name: 'X', role: 'segreteria', ruolo: 'segreteria', nome: null, cognome: null }],
  avvisi_risposte: [],
  utenti_sezioni: [],
  avvisi: Array.from({ length: N }, (_, i) => avviso(uuid('e', i))),
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbGrande()
  h.errori = {}
  h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/avvisi — l’archivio dello staff oltre le 1000 righe', () => {
  it('la segreteria vede TUTTI gli avvisi della sede, una volta sola ciascuno, in ordine stabile', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as { id: string }[]).map((a) => a.id)
    expect(ids).toHaveLength(N)
    expect(new Set(ids).size).toBe(N)
    expect(ids).toEqual([...ids].sort())
  })

  it('una lettura che fallisce dà 500 con il log `db`: mai un archivio a metà', async () => {
    h.errori = { avvisi: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }),
      expect.anything(),
    )
  })
})
```

- [ ] **Passo 2: eseguilo e vedilo fallire**

```bash
npx vitest run __tests__/api/avvisi-staff-a-blocchi.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. Il primo caso riceve 1000 avvisi invece di 1005. Il secondo è già verde: è la guardia del 500, e la correzione non deve romperla.

- [ ] **Passo 3: l'import**

In `src/app/api/avvisi/route.ts`, sotto la riga 28 (`import { logErrore, logEvento } from '@/lib/logging/logger';`), aggiungi:

```ts
import { descriviTetto, leggiABlocchi } from '@/lib/db/leggi-a-blocchi';
```

- [ ] **Passo 4: la lettura dello staff**

Sostituisci le righe 385-421, da `const buildQuery = (cols: string) => {` fino a `let filtered = (res.data ?? []) as unknown as AvvisoRow[];` compresa, con:

```ts
    // ── A BLOCCHI (robustezza 2, sessione 11) ─────────────────────────────────
    // L'archivio dello staff non ha filtro di scadenza (qui sotto il perché), quindi cresce per
    // sempre: oltre 1000 avvisi in una sede PostgREST consegnava i primi 1000 in silenzio.
    // `leggiABlocchi` chiude l'ordine con `id` dopo `created_at`: fra avvisi creati nello stesso
    // istante l'ordine resta lo stesso da un blocco all'altro.
    const leggiAvvisi = (cols: string) => leggiABlocchi<AvvisoRow>(() => {
        // ⚠️ NESSUN FILTRO DI SCADENZA, ed è una decisione del committente: allo
        // staff gli avvisi scaduti restano visibili. Il cockpit è anche l'archivio
        // di ciò che è stato pubblicato, e «sparito dalla bacheca delle famiglie»
        // non vuol dire «sparito dal lavoro della segreteria».
        let query = supabase.from('avvisi').select(cols).order('created_at', { ascending: false })
            .in('scuola_id', plessiScope);
        if (scope) query = query.eq('target_scope', scope);
        return query;
    });
    // `scuola_id` serve al filtro della docente (la classe è una coppia nome+sede)
    // e sta in ENTRAMBI i passi del degrado: è una colonna storica.
    let letti = await leggiAvvisi(`${AVVISO_COLS_SCADENZE}, form_model_id, scuola_id`);
    if (!letti.ok && letti.motivo === 'errore' && colonnaMancante(letti.error as { code?: string } | null)) {
        letti = await leggiAvvisi(`${AVVISO_COLS}, scuola_id`);
        // 🔴 IL DEGRADO SI DICHIARA, E QUI PIÙ CHE ALTROVE. Senza le sette colonne
        // del cantiere A2, `posti_totali` arriva `undefined` su OGNI riga e
        // `sopraCapienza` restituisce `false` per tutti: un indicatore di sicurezza
        // che si spegne MOSTRANDO IL VALORE RASSICURANTE. La segreteria legge
        // «nessun avviso sopra capienza» e non ha nulla da guardare per sapere che
        // quel numero non è stato calcolato — è la stessa forma di silenzio falso
        // che ha nascosto per mesi il guasto delle email di credenziali.
        // Degrada anche la scadenza (`scadenzaEffettiva` ripiega sulla vecchia
        // `scadenza date`), ma quello è un ripiego leggibile; questo è un `false`.
        //
        // Solo conteggi: quante righe hanno ricevuto il booleano non calcolato.
        logEvento('avvisi', 'warn', {
            operazione: 'avvisi:GET',
            esito: 'degrado-proiezione-capienza-spenta',
            n: letti.ok ? letti.righe.length : 0,
        });
    }
    if (!letti.ok) {
        // UNA risposta sola, come prima della sessione 11: le risposte d'errore senza `codice`
        // di questo file sono contate (`errori-con-codice` e la sua allowlist) e non devono
        // crescere. Sul guasto del DB il corpo resta quello di prima (il `message` di
        // PostgREST): sistemarlo spetta alle sessioni dopo la 13 (specifica §7, «Sessione 13»).
        let messaggio = 'Gli avvisi non si sono potuti leggere per intero.';
        if (letti.motivo === 'tetto') {
            // Solo il nome della lettura e dei conteggi: mai dati (AGENTS.md, regola 8).
            logErrore(
                { operazione: 'avvisi:GET', stato: 500, evento: 'lettura-troncata' },
                new Error(`${descriviTetto('avvisi-staff', letti)}, rifiutata per intero`),
            );
        } else {
            logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, letti.error);
            const m = (letti.error as { message?: unknown } | null)?.message;
            messaggio = typeof m === 'string' ? m : 'Lettura degli avvisi non riuscita';
        }
        return NextResponse.json({ error: messaggio }, { status: 500 });
    }
    let filtered = letti.righe;
```

Il resto di `listaAvvisiStaff`, dalla riga 422 (`// La docente vede solo ciò che la riguarda.`) in giù, resta uguale.

- [ ] **Passo 5: vedi rosso il test della route**

```bash
npx vitest run __tests__/api/avvisi-route.test.ts 2>&1 | tail -20
```

Atteso: `Test Files  1 failed (1)`. Fallisce il solo caso «lo staff vede gli avvisi del proprio plesso» (riga 249), che riceve 0 avvisi invece di 3: il suo finto chiude `.range()` con un elenco vuoto per ogni tabella tranne `avvisi_risposte`.

- [ ] **Passo 6: il finto della route restituisce le righe vere**

In `__tests__/api/avvisi-route.test.ts` sostituisci le righe 112-116:

```ts
      // Le statistiche degli avvisi si leggono in BLOCCO e paginate (T11-F2):
      // `.range()` è la chiamata che chiude la catena, non più `.then()`.
      b.range = async () => (table === 'avvisi_risposte'
        ? { data: h.risposte, count: h.risposte.length, error: null }
        : { data: [], count: 0, error: null })
```

con:

```ts
      // Le statistiche degli avvisi si leggono in BLOCCO e paginate (T11-F2):
      // `.range()` è la chiamata che chiude la catena, non più `.then()`. Dalla
      // sessione 11 di robustezza 2 la chiude anche l'archivio dello staff
      // (`leggiABlocchi`): per `avvisi`, la pagina chiesta delle righe vere.
      b.range = async (da: number, a: number) => {
        if (table === 'avvisi_risposte') return { data: h.risposte, count: h.risposte.length, error: null }
        if (table === 'avvisi') {
          const righe = (result() as { data: unknown[] }).data
          return { data: righe.slice(da, a + 1), count: null, error: null }
        }
        return { data: [], count: 0, error: null }
      }
```

- [ ] **Passo 7: test verdi**

```bash
npx vitest run __tests__/api/avvisi-staff-a-blocchi.test.ts __tests__/api/avvisi-route.test.ts __tests__/api/avvisi-degradi-dichiarati.test.ts __tests__/api/avvisi-niente-n-piu-uno.test.ts __tests__/api/avvisi-bacheca-docente.test.ts __tests__/api/allegati-avvisi-task-firmati.test.ts __tests__/api/avvisi-cerchio-bacheca-adesione.test.ts __tests__/api/avvisi-feed-scadenza-istante.test.ts __tests__/api/avvisi-pubblicazione-per-sede.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -15
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `Test Files  10 passed (10)` e `tsc` senza output. `errori-con-codice` resta verde perché il ramo dello staff ha ancora **una** risposta d'errore senza codice, come prima: il conteggio di `src/app/api/avvisi/route.ts` nell'allowlist non cresce. `avvisi-degradi-dichiarati` resta verde. Il suo `range` (riga 166) restituisce `42703` alla prima proiezione e le righe alla seconda: `leggiABlocchi` consegna l'errore con `motivo: 'errore'`, e il ripiego parte come prima.

- [ ] **Passo 8: commit**

```bash
git add src/app/api/avvisi/route.ts __tests__/api/avvisi-staff-a-blocchi.test.ts __tests__/api/avvisi-route.test.ts
git commit -m "$(cat <<'EOF'
Avvisi dello staff a blocchi: l'archivio oltre 1000 righe resta intero

Il ramo staff di GET /api/avvisi legge con leggiABlocchi (ordine
created_at poi id), con il degrado di proiezione invariato. Il tetto da'
500 con lettura-troncata.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 9 — Il lock sui file toccati

**File:**
- Crea: `__tests__/architecture/letture-a-blocchi.test.ts`

- [ ] **Passo 1: il lock**

Crea `__tests__/architecture/letture-a-blocchi.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fineParentesi, riga } from '../fixtures/sorgente'
import { RIGHE_MASSIME_POSTGREST } from '@/lib/db/blocchi'

/**
 * LE LETTURE CHE NON SI TRONCANO RESTANO TALI (robustezza 2, sessione 11).
 *
 * PostgREST taglia ogni risposta a `max_rows` (1000) senza un errore. La sessione 11 ha portato a
 * blocchi le letture che crescono senza un tetto naturale in cinque file: elenco genitori,
 * cruscotto presenze, controllo del testo di classe, bacheca dei promemoria, archivio avvisi dello
 * staff. Questo lock impedisce che tornino nude. Per ogni file e ogni tabella sorvegliata dichiara
 * QUANTE letture ci sono e in quale FORMA; e un `.limit(N)` sopra `max_rows` non passa.
 *
 * Le forme:
 *  · `a-blocchi`: la `.from()` sta dentro gli argomenti di una chiamata a `leggiABlocchi`;
 *  · `per-id`: `.in('id', blocco)`, cioè un blocco di `ID_PER_QUERY` chiavi primarie (≤ 100 righe);
 *  · `una-riga`: `.single()` / `.maybeSingle()`;
 *  · `altro`: tutto il resto, e ognuna ha la sua ragione scritta accanto al censimento.
 * Le scritture (`insert`, `update`, `upsert`, `delete`) non si contano.
 *
 * Una lettura nuova in questi file fa rosso finché qualcuno non sceglie la sua forma e la dichiara
 * qui: è il punto. Il sorgente si legge con la maschera di `sorgente.ts`, quindi una `.from(…)`
 * dentro un commento non conta, e una parentesi dentro una stringa non sbilancia niente.
 */

type Forma = 'a-blocchi' | 'per-id' | 'una-riga' | 'altro'
type Censimento = Record<string, Partial<Record<Forma, number>>>

interface Lettura {
  tabella: string
  riga: number
  forma: Forma
}

const CENSIMENTO: Record<string, Censimento> = {
  'src/app/api/admin/parents/route.ts': {
    alunni: { 'a-blocchi': 1 },
    student_parents: { 'a-blocchi': 1 },
    // per-id: i genitori di un blocco di `ID_PER_QUERY` id. una-riga: il PATCH legge il genitore
    // prima di scriverlo. altro: il ramo `?student_id=`, i genitori di UN alunno.
    parents: { 'per-id': 1, 'una-riga': 1, altro: 1 },
  },
  'src/app/api/admin/presenze/realtime/route.ts': {
    alunni: { 'a-blocchi': 1 },
    presenze: { 'a-blocchi': 1 },
    // Le sezioni e le sedi dei plessi dello staff: decine di righe (Passo 0.8 del piano).
    sections: { altro: 1 },
    schools: { altro: 1 },
  },
  'src/lib/health/controlli.ts': {
    alunni: { 'a-blocchi': 1 },
    sections: { 'a-blocchi': 1 },
  },
  'src/app/api/tasks/route.ts': {
    task_interni: { 'a-blocchi': 1 },
  },
  'src/app/api/avvisi/route.ts': {
    // altro: il feed del genitore, che legge solo gli avvisi non scaduti delle sedi dei figli.
    avvisi: { 'a-blocchi': 1, altro: 1 },
  },
}

const DA_TABELLA = /\.from\(\s*'([a-z_]+)'\s*\)/g
const CHIAMATA_A_BLOCCHI = /\bleggiABlocchi\s*(?:<[^()]*?>)?\s*\(/g
const SCRITTURA = /\.(?:insert|update|upsert|delete)\s*\(/
const UNA_RIGA = /\.(?:single|maybeSingle)\s*\(/
const PER_ID = /\.in\(\s*'id'\s*,\s*blocco\s*\)/

/** Le letture di un sorgente, ciascuna con la sua forma. */
function letture(src: string): Lettura[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  // Gli intervalli degli ARGOMENTI di ogni chiamata a `leggiABlocchi`, sul testo `struttura`.
  const argomenti: [number, number][] = []
  for (const m of struttura.matchAll(CHIAMATA_A_BLOCCHI)) {
    const apertura = m.index + m[0].length - 1
    argomenti.push([apertura, fineParentesi(struttura, apertura)])
  }
  const out: Lettura[] = []
  for (const m of senzaCommenti.matchAll(DA_TABELLA)) {
    const inizio = m.index
    const catena = senzaCommenti.slice(inizio, fineCatena(struttura, inizio))
    if (SCRITTURA.test(catena)) continue
    const forma: Forma = argomenti.some(([a, b]) => inizio > a && inizio < b)
      ? 'a-blocchi'
      : UNA_RIGA.test(catena)
        ? 'una-riga'
        : PER_ID.test(catena)
          ? 'per-id'
          : 'altro'
    out.push({ tabella: m[1], riga: riga(src, inizio), forma })
  }
  return out
}

function censisci(ls: Lettura[]): Censimento {
  const out: Censimento = {}
  for (const l of ls) {
    const t = out[l.tabella] ?? {}
    t[l.forma] = (t[l.forma] ?? 0) + 1
    out[l.tabella] = t
  }
  return out
}

const leggi = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('letture a blocchi — i file della sessione 11 non tornano a leggere «le prime 1000»', () => {
  for (const [file, atteso] of Object.entries(CENSIMENTO)) {
    describe(file, () => {
      it('ogni lettura delle tabelle sorvegliate ha la forma dichiarata, né più né meno', () => {
        const trovate = letture(leggi(file)).filter((l) => l.tabella in atteso)
        const elenco = trovate.map((l) => `${l.tabella}: ${l.forma} (riga ${l.riga})`).join('\n')
        expect(censisci(trovate), `letture trovate in ${file}:\n${elenco}`).toEqual(atteso)
      })

      it('nessun `.limit(N)` sopra `max_rows`: PostgREST lo ignora e taglia in silenzio', () => {
        const src = leggi(file)
        const { senzaCommenti } = mascheraSorgente(src)
        const oltre = [...senzaCommenti.matchAll(/\.limit\(\s*([\d_]+)\s*\)/g)]
          .filter((m) => Number(m[1].replace(/_/g, '')) > RIGHE_MASSIME_POSTGREST)
          .map((m) => `riga ${riga(src, m.index)}: ${m[0]}`)
        expect(oltre).toEqual([])
      })

      it('`leggiABlocchi` viene da `@/lib/db/leggi-a-blocchi`', () => {
        expect(leggi(file)).toMatch(
          /import\s*\{[^}]*\bleggiABlocchi\b[^}]*\}\s*from\s*'@\/lib\/db\/leggi-a-blocchi'/,
        )
      })
    })
  }
})

describe('il lock non è cieco', () => {
  it('legge davvero i cinque file, e ci trova tutte le letture a blocchi dichiarate', () => {
    let trovate = 0
    let attese = 0
    for (const [file, atteso] of Object.entries(CENSIMENTO)) {
      expect(fs.existsSync(path.join(process.cwd(), file)), file).toBe(true)
      trovate += letture(leggi(file)).filter((l) => l.tabella in atteso && l.forma === 'a-blocchi').length
      attese += Object.values(atteso).reduce((s, f) => s + (f['a-blocchi'] ?? 0), 0)
    }
    expect(attese).toBe(8)
    expect(trovate).toBe(attese)
  })

  it('distingue le forme su un sorgente scritto apposta, e ignora commenti e scritture', () => {
    const src = [
      "import { leggiABlocchi } from '@/lib/db/leggi-a-blocchi'",
      "const a = await leggiABlocchi<{ id: string }>(() => supabase.from('alunni').select('id').in('scuola_id', p))",
      "const b = await supabase.from('alunni').select('id').in('scuola_id', p)",
      "const c = await supabase.from('alunni').select('id').eq('id', x).maybeSingle()",
      "for (const blocco of aBlocchi(ids, ID_PER_QUERY)) await supabase.from('parents').select('id').in('id', blocco)",
      "await supabase.from('alunni').update({ stato: 'x' }).eq('id', x)",
      "// leggiABlocchi(() => supabase.from('alunni').select('id')) dentro un commento non conta",
    ].join('\n')
    expect(letture(src).map((l) => `${l.tabella}:${l.forma}`)).toEqual([
      'alunni:a-blocchi',
      'alunni:altro',
      'alunni:una-riga',
      'parents:per-id',
    ])
  })
})
```

- [ ] **Passo 2: eseguilo**

```bash
npx vitest run __tests__/architecture/letture-a-blocchi.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 passed (1)`. I Compiti 4-8 hanno già portato i file nella forma dichiarata. Se un censimento è diverso, il messaggio elenca le letture con la riga: si guarda quale lettura il conteggio non prevede e si capisce perché, prima di toccare il censimento.

- [ ] **Passo 3: prova di mutazione — una lettura nuda fa rosso**

Con l'editor (non con `git checkout`), in `src/app/api/tasks/route.ts` aggiungi subito dopo `const rows = letti.righe;` questa riga:

```ts
        void supabase.from('task_interni').select('id').in('scuola_id', plessi);
```

```bash
npx vitest run __tests__/architecture/letture-a-blocchi.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`. Il censimento di `src/app/api/tasks/route.ts` ha `altro: 1` in più per `task_interni`, e il messaggio nomina la riga.

Togli la riga con l'editor e verifica che il file sia tornato quello del commit:

```bash
git diff --exit-code -- src/app/api/tasks/route.ts && echo identico
```

Atteso: `identico`.

- [ ] **Passo 4: prova di mutazione — `.limit(5000)` fa rosso**

Con l'editor, in `src/app/api/admin/presenze/realtime/route.ts` cambia `.in('alunni.scuola_id', plessi),` (dentro la lettura delle presenze) in `.in('alunni.scuola_id', plessi).limit(5000),`.

```bash
npx vitest run __tests__/architecture/letture-a-blocchi.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  1 failed (1)`. Il caso «nessun `.limit(N)` sopra `max_rows`» del cruscotto elenca la riga con `.limit(5000)`.

Togli la modifica con l'editor e verifica:

```bash
git diff --exit-code -- src/app/api/admin/presenze/realtime/route.ts && echo identico
```

Atteso: `identico`.

- [ ] **Passo 5: commit**

```bash
git add __tests__/architecture/letture-a-blocchi.test.ts
git commit -m "$(cat <<'EOF'
Lock: le letture della sessione 11 restano a blocchi

Censimento per file e tabella delle letture (a-blocchi, per-id, una-riga,
altro), nessun .limit(N) oltre max_rows, leggiABlocchi da @/lib/db.
Provato con due mutazioni.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Migrazione

Nessuna: la sessione non tocca lo schema, non lascia fotografie da rigenerare alla sessione dopo e non conta `enrollment_submissions`.

---

## Log

| Dove | Evento · livello | `esito` (o messaggio) | Campi (solo conteggi, nomi di tabella, codici) | Quando |
|---|---|---|---|---|
| `src/lib/logging/supabase-fetch.ts` (`registraMaxRows`) | `db` o `rpc` · `warn`, persistito | `max-rows-raggiunto` | `operazione` (tabella o funzione), il verbo, `stato`, `righe`, `limite`; la route nella colonna `route` dal contesto; impronta distinta per `operazione` | una `GET` di PostgREST riceve una pagina di almeno 1000 righe che non aveva chiesto così (regola del Compito 3) |
| `src/app/api/admin/parents/route.ts` (`guastoElenco`) | `logErrore` · `error`, `stato: 500` | evento `lettura-troncata`, messaggio `lettura-troncata: admin-parents-alunni` o `admin-parents-legami oltre N righe (…), rifiutata per intero` | solo il tipo e i conteggi nel messaggio | il tetto di 50.000 righe |
| idem | `logErrore` · `error`, `stato: 500` | evento `db` | l'errore PostgREST completo | un blocco di alunni, legami o genitori fallisce |
| `src/app/api/tasks/route.ts` | `logErrore` · `error`, `stato: 500` | evento `lettura-troncata` (nuovo, tipo `tasks-bacheca`) / `db` (com'era) | idem | tetto / blocco fallito |
| `src/app/api/avvisi/route.ts` | `logErrore` · `error`, `stato: 500` | evento `lettura-troncata` (nuovo, tipo `avvisi-staff`) / `db` (com'era); il `warn` `degrado-proiezione-capienza-spenta` resta | idem | tetto / blocco fallito / colonne A2 assenti |
| `src/app/api/admin/presenze/realtime/route.ts` | `registro` · `error` (riga esistente) | `cockpit-lettura-parziale` | `entita_tipo`; al tetto l'errore porta `lettura-troncata: presenze-realtime-alunni` o `-presenze …` | tetto o blocco fallito: il cruscotto degrada |
| `src/lib/health/controlli.ts` | nessuna riga nuova | — | il `dettaglio` del controllo: `alunni:tetto`, `sections:tetto` o il codice PostgREST | ogni lettura di `/api/health/qualita` |

Tutte le righe `lettura-troncata` hanno il messaggio che comincia con `lettura-troncata:`: la ricerca del Passo 0.10 le trova insieme a quelle che c'erano già. I campi nuovi `righe` e `limite` sono numeri, e nessuna chiave entra nella lista bianca della redazione.

---

## PRD

### Compito 10 — Voce di changelog nel PRD

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md:1` (la voce nuova va **in cima**, sopra la prima `## `)

- [ ] **Passo 1: scrivi la voce**

Inserisci in cima al PRD il blocco qui sotto. I valori fra parentesi graffe sono quelli **misurati** nel Passo 0, con la loro ora: non si copiano da nessun documento.

```markdown
## 🛡️ Changelog — Robustezza 2, sessione 11: le letture non si troncano più a 1000 righe — {data UTC} (branch `robustezza2/s11-letture-a-blocchi`)

**Stato:** 🔀 in revisione (merge a mano del titolare). Specifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` §7, sessione 11; piano: `docs/superpowers/plans/2026-10-20-robustezza2-s11-letture-a-blocchi.md`. Nessuna migrazione.

- **Misura prima ({data} {ora} UTC, sola lettura):** legami `student_parents` {0.2}; per sede legami / genitori distinti {0.3}; alunni tutti / iscritti per sede {0.4}; presenze di oggi {0.5} e del giorno più pieno {0.5}; avvisi {0.6}, promemoria {0.7}, sezioni {0.8} per sede; risposte massime per un avviso {0.9}; righe `lettura-troncata` negli ultimi 7 giorni {0.10}; `max_rows` del progetto {0.11}. Elenchi già corti prima del rilascio (osservato): {quali, dai Passi 0.3-0.7, oppure «nessuno»}.
- **S6 — il segnale.** `src/lib/logging/supabase-fetch.ts`: una `GET` di PostgREST che riceve una pagina di almeno 1000 righe senza averla chiesta così (`limit` assente o più grande, totale ignoto o maggiore) scrive un `warn` `max-rows-raggiunto`, persistito, con la tabella in `operazione`, `righe`, `limite` e la route in colonna. Le pagine di `leggiABlocchi` (`limit=1000`) non lo accendono.
- **S6 — `leggiABlocchi` in `src/lib/db/`.** Accanto ad `aBlocchi`, con l'opzione `chiave` (default `['id']`): ogni blocco si ordina per una chiave unica, e `student_parents` usa la sua chiave primaria `(student_id, parent_id)`. `src/lib/pagamenti/leggi-a-blocchi.ts` riesporta gli stessi oggetti: i chiamanti di prima non cambiano.
- **S6 — le letture.** Elenco genitori (`admin/parents:GET`): alunni a blocchi, legami e genitori per blocchi di 100 id, in parallelo. Cruscotto presenze (`admin/presenze/realtime:GET`): iscritti e presenze di oggi a blocchi; tolto `.limit(5000)`, che `max_rows` ignorava. Controllo `sezione-testo-allineato` di `/api/health/qualita`: sezioni e iscritti a blocchi. Bacheca promemoria (`tasks:GET`) e archivio avvisi dello staff (`avvisi:GET`). Al tetto di 50.000 righe la lettura si rifiuta per intero (`500` con `lettura-troncata`, o `degradato` nel controllo): mai un elenco a metà. Restano fuori, misurate dal Passo 0.9, le letture delle risposte di un singolo avviso.
- **Lock** `__tests__/architecture/letture-a-blocchi.test.ts`: le letture delle tabelle sorvegliate nei cinque file hanno la forma dichiarata, nessun `.limit(N)` oltre 1000, `leggiABlocchi` viene da `@/lib/db/`.
- **Logging.** `max-rows-raggiunto` (`db`/`rpc`, `warn`, persistito); `lettura-troncata` (`logErrore`, `stato: 500`) su genitori, promemoria e avvisi; nel cruscotto il tetto passa dalla riga esistente `cockpit-lettura-parziale`.
- **Da fare dopo il merge:** misura a 7 giorni, matura dal {data del deploy + 7} dopo le {ora} UTC: `max-rows-raggiunto` deve essere a 0 **sulle letture toccate da questa sessione**; se compare su altre letture, quelle sono il prossimo lavoro e vanno nelle «Note» della tabella di stato (specifica §7, «Sessione 11», «Prova»). Il totale dell'elenco genitori deve essere uguale al `count(distinct parent_id)` delle stesse sedi. La scrive la prima PR che tocca la specifica dopo quel giorno (sezione «Per la sessione dopo» del piano).
```

- [ ] **Passo 2: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: robustezza 2, sessione 11 (letture a blocchi, warn max-rows-raggiunto)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 11 — Gate, PR, merge del titolare, verifica

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (la riga **Stato** della voce del Compito 10)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga della sessione 11 nella tabella di stato, trovata con `grep -n "^| 11 |"`: «in revisione», nella PR stessa)

- [ ] **Passo 1: gate completo**

```bash
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
npx vitest run 2>&1 | tail -15
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -15
```

Atteso:
- eslint e tsc senza output;
- vitest: tutti i file verdi; se l'unico rosso è `offline-html-nativo`, si rilancia con `CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts`;
- build: `✓ Compiled` e nessun `Error`.

Leggi le righe di riepilogo, non il codice d'uscita di una pipe.

- [ ] **Passo 2: log presenti sul codice toccato**

```bash
grep -n "max-rows-raggiunto" src/lib/logging/supabase-fetch.ts
grep -n "lettura-troncata" src/app/api/admin/parents/route.ts src/app/api/tasks/route.ts src/app/api/avvisi/route.ts
grep -n "descriviTetto" src/app/api/admin/presenze/realtime/route.ts
grep -n "motivoDi(" src/lib/health/controlli.ts
```

Atteso: almeno una riga per ciascun comando.

- [ ] **Passo 3: push e PR**

```bash
git push -u origin robustezza2/s11-letture-a-blocchi
gh pr create --base main --head robustezza2/s11-letture-a-blocchi \
  --title "Robustezza 2, sessione 11: le letture non si troncano più a 1000 righe" \
  --body "$(cat <<'EOF'
## Cosa cambia
- **Il segnale.** `supabase-fetch.ts` scrive un `warn` persistito `max-rows-raggiunto` (tabella in `operazione`, `righe`, `limite`, route in colonna) quando una GET di PostgREST riceve una pagina di almeno 1000 righe senza averla chiesta così. Le pagine di `leggiABlocchi` (`limit=1000`) non lo accendono.
- **`leggiABlocchi` in `src/lib/db/`**, con l'opzione `chiave` per le tabelle senza `id` (`student_parents`). Il vecchio percorso dei pagamenti riesporta gli stessi oggetti.
- **A blocchi:** elenco genitori (`admin/parents:GET`), cruscotto presenze (`admin/presenze/realtime:GET`, tolto `.limit(5000)`), controllo `sezione-testo-allineato`, bacheca promemoria (`tasks:GET`), archivio avvisi dello staff (`avvisi:GET`). Al tetto la lettura si rifiuta per intero.
- **Lock** `__tests__/architecture/letture-a-blocchi.test.ts`.

## Misure (sola lettura, prima del merge)
- Ora: {0.1}. Legami `student_parents`: {0.2}.
- Legami e genitori distinti per sede: {0.3}.
- Alunni tutti / iscritti per sede: {0.4}. Presenze di oggi / giorno più pieno: {0.5}.
- Avvisi / promemoria / sezioni per sede: {0.6} / {0.7} / {0.8}. Risposte massime per avviso: {0.9}.
- `max_rows` del progetto: {0.11}.

## Migrazione
Nessuna.

## Merge
A mano, dal titolare. Niente auto-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Prima di lanciarlo, sostituisci nel corpo i valori fra graffe con quelli misurati. Annota il numero della PR stampato da `gh`.

- [ ] **Passo 4: CI verde su tutti i job**

```bash
gh pr checks {numero PR} --watch
```

Atteso: ogni job `pass`. Un job `cancelled` del gruppo E2E non è rosso: succede quando più PR partono di fila, e si rilancia con `gh run rerun {id del run} --failed`, una PR alla volta. «CI verde» vuol dire **tutti** i job.

- [ ] **Passo 5: lo stato nel PRD e nella tabella di stato dice «in revisione», e si committa**

Nella voce del Compito 10 la riga **Stato** diventa `🔀 in revisione: PR #{numero}, CI verde, merge a mano del titolare.` Poi la tabella di stato della specifica:

```bash
grep -n "^| 11 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola. In quella riga (mai una riga presa per numero), colonne «Stato», «PR» e «Piano»: `da fare` → `in revisione` (queste parole, non «PR aperta» né «in corso»), `—` → `#{numero}`, `` `s11-letture-a-blocchi` `` → `` `docs/superpowers/plans/2026-10-20-robustezza2-s11-letture-a-blocchi.md` ``. **Mai** «in produzione» su questa riga in questa PR: lo scrive la sessione che apre dopo, eseguendo la sezione «Per la sessione dopo» di questo piano (specifica §5, «La tabella di stato, in due tempi»).

```bash
git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
Sessione 11 di robustezza 2 in revisione: PRD e tabella di stato

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

Poi aspetta di nuovo la CI (Passo 4).

- [ ] **Passo 6: merge — lo fa il titolare, a mano**

Avvisa il titolare con il link della PR e i numeri del Passo 0. Se il Passo 0.3 o il Passo 0.4 hanno trovato elenchi già corti, diglielo. **Mai** auto-merge, **mai** `gh pr merge` da chi esegue. Annota l'istante UTC del merge (`gh pr view {numero} --json mergedAt,mergeCommit`).

- [ ] **Passo 7: verifica dopo il merge**

Non c'è una migrazione da confermare. Si conferma che il codice nuovo è quello in produzione e che legge tutto.

```bash
curl -s https://app.kidville.it/api/health/qualita
```

Atteso:
- `versione` uguale allo sha del commit di merge;
- il controllo `sezione-testo-allineato` con il dettaglio `N iscritti allineati`, oppure `M alunni col testo classe divergente`.

Nel primo caso, `N` deve coincidere con questa query (sola lettura, tutte le sedi, come il controllo):

```sql
select count(*) as iscritti from alunni where stato = 'iscritto';
```

Poi, un'ora dopo il deploy:

```sql
select route, contesto->'campi'->>'operazione' as tabella,
       sum(occorrenze) as volte, max(visto_l_ultima) as ultima
from app_log
where messaggio = 'max-rows-raggiunto'
  and visto_l_ultima >= '{istante del merge, UTC}'
group by 1, 2
order by volte desc;
```

Atteso: nessuna riga sulle route delle letture toccate da questa sessione (`/api/admin/parents`, `/api/admin/presenze/realtime`, `/api/health/qualita`, `/api/tasks`, `/api/avvisi`). Una riga su un'altra route è una scoperta, non un guasto del rilascio: è una lettura troncata che nessuno vedeva, e la correzione è un lavoro a parte. Non è un motivo per tornare indietro. Si riferisce al titolare (route, tabella, volte); nella specifica e nel PRD la scrive la sessione dopo, con la misura a 7 giorni (sezione «Per la sessione dopo», punto 2).

- [ ] **Passo 8: la Prova dell'elenco genitori**

Per ciascuna delle tre sedi di produzione, una alla volta. Il titolare apre l'anagrafica, linguetta «Genitori», con quella sola sede selezionata. Dagli strumenti del browser (scheda Rete) legge la lunghezza dell'array che restituisce `GET /api/admin/parents`. Nello stesso momento, chi esegue lancia la prima query del Passo 0.3.

**Atteso:** la lunghezza coincide con `genitori_distinti` della riga di quella sede. Se non coincide, si guarda prima `app_log`: una riga `lettura-troncata` o `db` della route spiega il perché. Se `app_log` non dice niente, si porta la differenza al titolare.

L'esito non va perso, ma la PR è già mergiata: lo si lascia come **commento della PR**, solo numeri (uuid della sede, lunghezza dell'array, `genitori_distinti`, ora UTC), e la sessione dopo lo copia nella specifica e nel PRD (sezione «Per la sessione dopo», punto 3):

```bash
gh pr comment {numero} --repo erricoluigi17/kidville-web --body "Prova dell'elenco genitori ({data e ora UTC}): {uuid sede} array {n} / genitori_distinti {n}; {…le altre due sedi}"
```

- [ ] **Passo 9: pulizia del ramo della sessione**

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s11-letture-a-blocchi
git -C /Users/lerri/kidville-web branch -D robustezza2/s11-letture-a-blocchi
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s11-letture-a-blocchi
```

Si cancellano solo il ramo e il worktree di questa sessione. Gli altri rami con una PR aperta **non** si toccano. Niente rami di soli documenti dopo il rilascio: riga di stato a «in produzione», commit di `main`, misura a 7 giorni e Stato nel PRD li scrive la sessione dopo, dalla sezione «Per la sessione dopo» in fondo a questo piano.

- [ ] **Passo 10: la misura «dopo» — dove sta e quando matura**

La misura a 7 giorni (la Prova della specifica) **matura sette giorni dopo il merge**, dopo l'ora del merge. Le `SELECT`, l'atteso e chi le scrive stanno nella sezione «Per la sessione dopo», punto 2: le esegue la sessione dopo, se a quel giorno apre; altrimenti la prima PR che tocca la specifica dopo quel giorno. Questa sessione non apre rami per scriverla.

---

## Ritorno indietro

**Subito:** il titolare fa l'Instant Rollback di Vercel al deploy precedente. Non c'è una migrazione e nessun dato è cambiato: il rollback è completo.

**Poi, la PR di revert.** Su un ramo nuovo, da `origin/main` con l'albero pulito. Il ramo sta **fuori** dal prefisso `robustezza2/`: la chiusura della precedente cerca la PR `robustezza2/` mergiata per ultima e ne apre il piano, e un `robustezza2/s11-revert` la manderebbe a un piano che non esiste (specifica §5: nessun altro nome di ramo nella serie).

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web worktree add -b revert/s11-letture-a-blocchi /Users/lerri/kidville-web-s11-revert origin/main
cd /Users/lerri/kidville-web-s11-revert && git revert --no-edit {sha del commit di merge della PR}
```

Poi gate (Compito 11, Passo 1), PR con un corpo che dice cosa torna indietro e perché, CI verde su tutti i job (Passo 4) e merge a mano del titolare (Passo 6). La riga della sessione 11 nella tabella di stato non si tocca qui: la chiude la sessione dopo, che trova il ramo `revert/s11-letture-a-blocchi` mergiato («Per la sessione dopo», punto 4). Il PRD riceve una voce datata che dice cosa è tornato com'era e perché.

**Tornare indietro su un pezzo solo.** Con lo squash, i compiti non sono commit separati su `main`. Per annullarne uno solo, su un ramo nuovo con l'albero pulito si riporta il file alla versione che aveva prima del merge:

```bash
git checkout {sha del commit di main prima del merge} -- {percorso del file}
```

Due casi tipici:
- Il `warn` fa troppo rumore: si riporta `src/lib/logging/supabase-fetch.ts`, e il suo test si toglie nello stesso commit.
- Una route si comporta male: si riporta quella route e si toglie la sua voce da `CENSIMENTO` nel lock.

`leggiABlocchi` in `src/lib/db/` e la riesportazione possono restare: non cambiano niente per nessuno.

**Cosa si riperde tornando indietro:** gli elenchi sopra 1000 righe tornano corti in silenzio, e `.limit(5000)` torna nel cruscotto. Prima di farlo, rilancia i Passi 0.3-0.7. Se un elenco è già sopra 1000, il titolare va avvisato: il revert riporta un difetto che in quel momento è visibile.

---

## Per la sessione dopo

Questa sezione la esegue **chi apre la prima sessione dopo il rilascio della 11**, quando il suo Compito 1 trova `robustezza2/s11-letture-a-blocchi` come PR `robustezza2/` mergiata per ultima, nel **primo commit** della sua sessione, dal suo worktree. Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Sulla produzione si fanno **solo letture** (`execute_sql`, solo `SELECT`); si scrive solo nel repository.

**1. Fotografie e liste: niente.** La sessione 11 non ha migrazioni: nessuna fotografia da rigenerare per lei e nessuna voce da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` o da altre liste. Restano la riga di stato, il PRD e la misura.

Il numero e l'istante del merge della sessione 11, che servono sotto:

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s11-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
git log origin/main --oneline --grep "(#<numero stampato sopra>)" | head -1
```

**2. La misura a 7 giorni (la Prova della specifica).** **Matura sette giorni dopo l'istante del merge** stampato sopra. Se a quel momento la sessione dopo ha già fatto il suo primo commit, la scrive **la prima PR che tocca la specifica dopo quel giorno**. Prima di quel giorno non si scrive niente: si scrive solo «misura a 7 giorni: matura dal <giorno> <ora> UTC» nelle «Note» della riga della sessione 11. In sola lettura, con l'istante del merge al posto di `<istante del merge, UTC>`:

```sql
select now() at time zone 'utc' as adesso_utc;

select route, contesto->'campi'->>'operazione' as tabella,
       sum(occorrenze) as volte, max(visto_l_ultima) as ultima
from app_log
where messaggio = 'max-rows-raggiunto'
  and visto_l_ultima >= '<istante del merge, UTC>'
group by 1, 2
order by volte desc;

select route, sum(occorrenze) as volte, max(visto_l_ultima) as ultima
from app_log
where messaggio like 'lettura-troncata:%'
  and visto_l_ultima >= now() - interval '7 days'
group by route
order by volte desc;

select count(*) as legami, count(distinct sp.parent_id) as genitori_distinti
from student_parents sp
join alunni a on a.id = sp.student_id
where a.scuola_id::text not like 'e2e00000-%';
```

**Atteso** (specifica §7, «Sessione 11», «Prova»): `max-rows-raggiunto` a **0 sulle letture toccate dalla sessione**, cioè nessuna riga con `route` fra `/api/admin/parents`, `/api/admin/presenze/realtime`, `/api/health/qualita`, `/api/tasks`, `/api/avvisi`. Righe su **altre** route non sono un fallimento della sessione 11: sono il prossimo lavoro, e vanno nelle «Note» della riga della sessione 11 con route, tabella e volte. Una riga sulle cinque route toccate, invece, è una lettura che la sessione non ha chiuso: va nelle «Note» come tale e si avvisa il titolare. Si scrivono i numeri osservati con giorno, ora UTC e finestra (dall'istante del merge a `adesso_utc`).

**3. La prova dell'elenco genitori.** La sessione 11 l'ha fatta col titolare dopo il merge e ne ha lasciato l'esito come commento della sua PR:

```bash
gh pr view <numero della PR della sessione 11> --repo erricoluigi17/kidville-web --comments | grep -n "Prova dell'elenco genitori"
```

Si copiano nelle «Note» e nel PRD i soli numeri per sede (lunghezza dell'array e `genitori_distinti`, con l'ora). Se il commento non c'è, si scrive «prova dell'elenco genitori non registrata» e si avvisa il titolare: non si ricostruisce a memoria.

**4. La riga di stato.**

```bash
grep -n "^| 11 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Prima, un controllo: la sessione 11 non deve essere tornata indietro.

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:revert/s11-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: nessuna riga. Se ne stampa una, la PR di revert (ramo `revert/s11-letture-a-blocchi`, sezione «Ritorno indietro») è in `main`: «Stato» resta `in revisione`, in coda alle «Note» si scrive «tornata indietro, PR #<numero del revert>», i punti sotto si saltano e si avvisa il titolare.

Nella riga trovata (mai per numero di riga): «Stato» `in revisione` → `in produzione`; in coda alle «Note», il commit di `main` (`` commit `<sha corto>` ``), l'esito del punto 3 e, se matura, la misura del punto 2.

**5. Il PRD.** La voce `## 🛡️ Changelog — Robustezza 2, sessione 11: le letture non si troncano più a 1000 righe` (si trova con `grep -n "Robustezza 2, sessione 11" "PRD REGISTRO ELETTRONICO.md"`): la riga **Stato** diventa `✅ in produzione dal <giorno> (PR #<numero>, commit <sha corto>).`; se la misura del punto 2 è matura, il punto «Da fare dopo il merge» diventa «**Misura dopo** (<giorno e ora UTC>, finestra …)» con i numeri osservati e le route nuove trovate dal `warn`.

---

## Autorevisione (fatta alla stesura, da ripetere alla fine)

**Copertura della §7, sessione 11:**

| Specifica | Dove |
|---|---|
| Obiettivo: nessun elenco restituisce in silenzio solo le prime 1000 righe | Compiti 4-8 (la cura) e 3 (il segnale per tutte le altre letture) |
| Misura prima: `count(*) from student_parents` e i conteggi delle altre tabelle lette, per sede; oltre 1000 si anticipa (§3) | Passo 0.2 (criterio della §3), 0.3-0.8 (per sede), 0.9-0.11 (soglie che fermano il piano) |
| `supabase-fetch.ts`: `warn` `max-rows-raggiunto` con la route | Compito 3. La regola è più precisa della lettera: vedi «Scelte», punto 1 |
| `leggiABlocchi` esce dai pagamenti verso `src/lib/db/`, accanto ad `aBlocchi`, e si riusa | Compito 2: `git mv`, riesportazione, test che lo prova; riuso nei Compiti 4-8 |
| `admin/parents/route.ts:114-163` | Compito 4 (con `chiave` per `student_parents`) |
| `admin/presenze/realtime/route.ts:48-64`: gli iscritti e le presenze di oggi, senza `.limit(5000)` | Compito 5 («Scelte», punto 3) |
| Il controllo del testo di classe in `controlli.ts:1044-1077` | Compito 6 (l'intera funzione `controlloTestoClasse`, trovata per firma: il file lo toccano anche le sessioni 1, 6, 7 e 8) |
| `tasks/route.ts:492-506` e `avvisi/route.ts:385-421` | Compiti 7 (`tasks:GET`) e 8 (ramo staff di `avvisi:GET`) |
| Un lock sui file toccati | Compito 9, con due prove di mutazione |
| Rischio: più richieste; ordine non stabile | Ordine per chiave unica, provato con una sorgente che rimescola i pari (Compito 2) e con l'ordine per `id` nei Compiti 5, 7, 8; blocchi in parallelo nell'elenco genitori («Scelte», punto 6) |
| Indietro: revert | «Ritorno indietro» |
| Prova: nei 7 giorni dopo, `max-rows-raggiunto` a 0 **sulle letture toccate dalla sessione** (le altre, se compaiono, nelle «Note»); totale genitori = `count(distinct …)` | Compito 11, Passi 7 e 8; «Per la sessione dopo», punti 2 e 3 (la misura matura a 7 giorni); e già in test (Compito 4) |
| §5: worktree, `.env.local` col sì del titolare, gate con `CI=1` e heap 8192, merge a mano, pulizia, PRD, log con `esito` | Compiti 1, 10, 11; parti «Log» e «PRD» |
| §5 prerequisiti: «Dopo» vuota, quindi solo nessuna PR `robustezza2/` aperta salvo `-esito` | Compito 1, Passo 2 |
| §5 chiusura della sessione rilasciata per ultima dal suo «Per la sessione dopo», o niente se nessuna è rilasciata | Compito 1, Passo 6 |
| §5 tabella di stato in due tempi: «in revisione» con PR e piano nella propria PR; «in produzione» dalla sessione dopo | Compito 11, Passo 5; «Per la sessione dopo», punto 4 |
| §5 nessun altro nome di ramo: niente rami di soli documenti dopo il rilascio, revert fuori dal prefisso | Compito 11, Passi 9 e 10; «Ritorno indietro» |
| §5 riferimenti al codice per contenuto (`controlli.ts`, condiviso con le sessioni 1, 6, 7, 8) | Compito 6, Passi 3 e 4 |
| §7 S13: le risposte con `error.message` si sistemano solo dopo la 13 | Compiti 4 e 8: `admin/parents` e `avvisi` non ne aggiungono e non ne correggono |
| §6: sei parti fisse, TDD, nessun segnaposto, «Per la sessione dopo» | Struttura di questo documento |

**Segnaposto:** nessuna parte rimandata. Le parentesi graffe stanno solo nei valori che si misurano (Passo 0, numero della PR, sha, istanti), come nel modello della sessione 1.

**Coerenza dei nomi:**
- `leggiABlocchi` / `OpzioniABlocchi.chiave` / `CHIAVE_PREDEFINITA` / `EsitoABlocchi` / `descriviTetto`: Compito 2, usati nei Compiti 4-8.
- `maxRowsRaggiunto({ verbo, area, url, contentRange })` / `limiteChiesto` / `verboDi` / `registraMaxRows`: Compito 3.
- `guastoElenco` (Compito 4), `comeRisposta` (Compito 5), `motivoDi` (Compito 6), `leggiAvvisi` (Compito 8).
- I tipi del tetto sono `admin-parents-alunni`, `admin-parents-legami`, `presenze-realtime-alunni`, `presenze-realtime-presenze`, `tasks-bacheca`, `avvisi-staff`.
- `CENSIMENTO` del lock (Compito 9) conta 8 letture `a-blocchi`: 2 nei genitori, 2 nel cruscotto, 2 nel controllo, 1 nei promemoria, 1 negli avvisi.
