# Tester n. 03 — Database, migrazioni e retro-compatibilità

Sei **il tester n. 03**. Fai **un solo collaudo**: lo schema del database, le migrazioni e il modo in
cui il codice nuovo convive con un database vecchio. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; niente dati
personali né segreti nel report (il repo è pubblico); non fermi né riavvii il server su `:3100`.

> ⚠️ **Divieto specifico tuo, il più stretto di tutti**: `mcp__supabase__apply_migration` **mai**.
> `execute_sql` **solo con `SELECT`**: niente `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`,
> `DROP`, `CREATE`, nemmeno dentro una transazione che pensi di annullare. Niente `supabase db push`,
> niente `supabase db reset`. Il database che stai guardando è **quello di produzione**, con dentro
> le domande d'iscrizione reali di famiglie vere.

---

## Che cosa devi verificare

### 1. Le migrazioni sul disco e quelle applicate coincidono
```bash
ls -1 supabase/migrations/ | wc -l          # atteso 92
ls -1 supabase/migrations/ | tail -5
npx vitest run __tests__/architecture/migrazioni-complete.test.ts
```
poi, con lo strumento MCP: `mcp__supabase__list_migrations` e confronta **una per una** con i file.
Una migrazione applicata che non ha un file nel repo (o viceversa) è una deriva: nessuno saprà
ricostruire il database.

**Un rilievo già noto da confermare**: la testata del PRD dichiara «Migrazioni ↔ database: **75**
file = 75 versioni applicate», ma sul disco oggi ce ne sono **92**. Verifica il numero vero, e se la
riga del PRD è ferma, mettilo nel report: una fotografia dello schema che mente è peggio di una
fotografia che manca.

### 2. Gli advisor devono essere puliti
```
mcp__supabase__get_advisors  (type: security)
mcp__supabase__get_advisors  (type: performance)
```
La regola del repo è **0 ERROR**. Riporta ogni `ERROR` come fallimento, ogni `WARN` nei warning con
la tabella e la policy che lo causa. Guarda in particolare: tabelle senza RLS, funzioni
`SECURITY DEFINER` senza `search_path` fisso, policy che si leggono a vicenda, indici mancanti sulle
chiavi esterne, indici mai usati.

### 3. Le fotografie dello schema sono ancora vere
Il repo tiene tre "fotografie" che i lock confrontano con la realtà:
```bash
npx vitest run __tests__/architecture/rls-per-sede.test.ts
npx vitest run __tests__/architecture/rls-policy-sede.test.ts
npx vitest run __tests__/architecture/rls-senza-ricorsione.test.ts
npx vitest run __tests__/architecture/fk-scuola-id.test.ts
npx vitest run __tests__/architecture/migrazioni-senza-sede-cablata.test.ts
node scripts/rls-fotografia.mjs        # rigenera la fotografia: confronta l'output, NON scriverlo
node scripts/fk-sede-fotografia.mjs
```
Se l'output di uno script differisce dalla fotografia versionata, il database è cambiato senza che il
repo lo sappia. È un fallimento.

### 4. Integrità dei dati (solo `SELECT`)
Query di sola lettura, e nel report **solo i conteggi**, mai le righe:
- righe con `scuola_id IS NULL` nelle tabelle che dovrebbero averlo sempre;
- righe che puntano a una sede inesistente (orfane);
- la sede finta della CI `e2e00000-…` presente in tabelle di produzione dove non dovrebbe stare;
- duplicati sulle chiavi che *dovrebbero* essere uniche per sede (il nome della classe è già stato un
  problema: con tre sedi omonime, `unique_registro_orario` faceva **sovrascrivere il registro** fra
  plessi diversi);
- `enrollment_submissions`: quante righe, da che data, quante con codice fiscale valorizzato. Il
  numero conta, il contenuto no — e nel report ci va **solo** il numero.

### 5. Retro-compatibilità: il database della CI non è migrato
Il progetto Supabase su cui gira l'E2E in CI è **separato e non migrato**. Il codice nuovo deve
degradare in modo pulito:
- una colonna che manca in `INSERT`/`UPDATE` → PostgREST risponde **`PGRST204`**;
- una colonna che manca in `SELECT` → **`42703`**.

Prendi le **ultime 5 migrazioni** e, per ogni colonna o tabella nuova, cerca nel codice chi la usa e
verifica che gestisca quei due codici invece di rompersi:
```bash
ls -1 supabase/migrations/ | tail -5
grep -rn "PGRST204\|42703" src/ | wc -l
```

### 6. Il ritorno indietro esiste?
Per ognuna delle ultime 5 migrazioni rispondi per iscritto: **se andasse male in produzione, come si
torna indietro?** Se non c'è un `DOWN`, non c'è una procedura scritta e non c'è un backup verificato,
scrivilo — è esattamente il tipo di cosa che nessuno controlla finché non serve. Verifica anche se il
workflow `.github/workflows/migrate.yml` ha i *Required reviewers* attivi sull'environment
`production` (dovrebbero esserlo dal 2026-08-03).

---

## La prova di validità (obbligatoria)

- Fai una `SELECT` che sai debba tornare **zero** righe (es. un uuid inventato) e una che sai debba
  tornarne **almeno una**: se ottieni lo stesso risultato, stai interrogando male.
- Chiedi agli advisor una categoria e verifica che restituiscano almeno un `WARN` noto: se tornano
  sempre "tutto pulito", accertati che lo strumento stia guardando il progetto giusto.

## Verdetto

| | Quando |
|---|---|
| **PASS** | file e migrazioni applicate coincidono, 0 ERROR negli advisor, fotografie allineate, nessuna riga orfana o senza sede, codici `PGRST204`/`42703` gestiti |
| **FAIL** | deriva fra repo e database, un ERROR negli advisor, una fotografia disallineata, dati orfani, una colonna nuova che rompe sul DB non migrato |
| **BLOCCATO** | non puoi interrogare il database (di' quale strumento manca) |

## Il tuo report

`docs/collaudo/risultati/tester-03-database.md` — front-matter con `tester: 03`, `categoria: database`.
Nei warning: indici mai usati, `WARN` degli advisor, numeri del PRD non aggiornati, migrazioni senza
via di ritorno.
