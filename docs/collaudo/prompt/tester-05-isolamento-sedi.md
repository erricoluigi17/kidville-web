# Tester n. 05 — Isolamento fra le sedi

Sei **il tester n. 05**. Fai **un solo collaudo**: la tenuta del confine fra **Giugliano**, **Aversa**
e **Cesa**. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; sul database di
produzione **solo `SELECT`**; solo `GET`/`HEAD`/`OPTIONS` verso le API; niente dati personali nel
report; non fermi né riavvii il server su `:3100`.

---

## Perché questo tester esiste da solo

Fino al 2026-07-29 la sede era una. Poi sono diventate tre, e **falle che dormivano da mesi si sono
svegliate col gate verde**: 3424 test passavano mentre il nome di una classe — usato come chiave
univoca quando i plessi erano uno — faceva **sovrascrivere il registro orario** fra sedi omonime, e
il modulo pubblico d'iscrizione non aveva **nessun dato** da cui dedurre la sede. Un audit ha poi
percorso 59 route su 59.

Il tuo compito non è rifare l'audit: è **verificare che regga oggi**, e cercare le strade nuove che
sono nate dopo.

---

## Che cosa devi verificare

### 1. Il lock di copertura e l'inventario
```bash
npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts
npx vitest run __tests__/architecture/inventario-audit-verita.test.ts
npx vitest run __tests__/architecture/scope-vuoto-nega.test.ts
npx vitest run __tests__/architecture/nome-classe-con-sede.test.ts
npx vitest run __tests__/architecture/chiave-registro-per-sede.test.ts
npx vitest run __tests__/architecture/destinatari-con-ponte.test.ts
npx vitest run __tests__/architecture/glossario-sede.test.ts
npx vitest run __tests__/architecture/etl-form-submission-sede.test.ts
```
Leggi `docs/audit/2026-07-30-isolamento-fra-sedi.md`: l'inventario ha tre stati soli — `CHIUSA`,
`APERTA`, `N/A`. Non esiste lo stato «per intenzione». Verifica che le voci `CHIUSA` dicano ancora il
vero (il lock `inventario-audit-verita` lo controlla: se è verde, dimmi *come* lo controlla, perché
un lock che si accontenta della traccia invece della cosa è a sua volta un difetto — è già successo).

### 2. Le route nuove non sono nell'inventario
L'inventario è di fine luglio. Da allora sono arrivate migrazioni e route nuove. Trova quelle che
l'audit non ha mai visto e verificale una per una:
```bash
git log --since=2026-07-30 --name-only --pretty=format: -- src/app/api | sort -u | grep route.ts
```
Per ognuna: legge o scrive dati di una sede? Da dove prende `scuola_id`? Cosa succede se l'utente ne
ha tre? **Una route che indovina la sede archivia i dati nel plesso sbagliato in silenzio.**

### 3. La prova sul campo, con tre identità
Gli account TEST per sede esistono già (cerca `@kidville.test` nel PRD): `test.aversa.segreteria`,
`test.cesa.segreteria`, `test.segreteria` (Giugliano), più `test.multisede.admin` che le vede tutte e
tre. Password in `KV_TEST_PASSWORD`, mai nel report.

Entra come **segreteria di Aversa** e prova a leggere risorse di **Giugliano** passando l'uuid nella
URL: bambini, classi, diario, presenze, pagamenti, avvisi, modulistica, allegati, protocolli.
Atteso: **403**. Un `200` con dati di un'altra sede è **bloccante**. Un `200` con lista vuota è
sospetto e va indagato: nasconde spesso un filtro che *sembra* funzionare ma dipende dallo scope —
il lock `scope-vuoto-nega` esiste perché uno scope vuoto deve **negare**, non «non filtrare».

Ripeti come **docente** e come **genitore** di una sede verso l'altra.

### 4. Le liste pubbliche
La sede finta della CI `e2e00000-…` **non deve comparire** in nessun elenco pubblico (modulo
d'iscrizione, selettore di sede, pagine pubbliche). Verifica sul server e in produzione.

### 5. Il database, in lettura
Con `SELECT` (solo conteggi nel report):
- tabelle con dati di sede e colonna `scuola_id`: quante righe con `scuola_id IS NULL`;
- chiavi univoche che non includono la sede: cerca gli indici `UNIQUE` che non hanno `scuola_id`
  fra le colonne — sono i candidati alla prossima sovrascrittura fra plessi;
- classi/sezioni con lo **stesso nome** in sedi diverse: quante, e quali funzioni le usano come chiave;
- `enrollment_submissions`: la distribuzione per sede, e quante righe hanno sede nulla o incoerente.

### 6. Le primitive devono essere un posto solo
`assertParentInScope`, `assertUtenteInScope`, `assertPagamentoInScope`, `sezioniVisibili`,
`resolveScuolaScrittura`, `resolveScuoleAttive`. La lezione già pagata: **una regola valida per due
strade deve vivere in un posto solo** — è così che POST era protetto e PUT no, tasks sì e avvisi no,
tre OTP su quattro. Cerca ogni punto che reimplementa il controllo invece di chiamare la primitiva:
```bash
grep -rn "assert.*InScope\|resolveScuola\|sezioniVisibili" src/ | wc -l
grep -rn "scuola_id" src/app/api --include=route.ts | wc -l
```
La differenza fra i due numeri è la tua lista di sospetti.

---

## La prova di validità (obbligatoria)

- Prima di dichiarare che un `403` prova l'isolamento, verifica che la **stessa richiesta con
  l'identità giusta** risponda `200` con dati: altrimenti stai misurando una risorsa inesistente.
- Prima di dichiarare che una lista è filtrata per sede, controlla che con l'account **multisede**
  la stessa lista mostri **più** elementi. Se è identica, il filtro non c'è o non discrimina.

## Verdetto

| | Quando |
|---|---|
| **PASS** | lock verdi, route nuove tutte scopate, nessuna lettura cross-sede riuscita con tre identità diverse, nessuna chiave univoca senza sede, sede E2E invisibile in pubblico |
| **FAIL** | una sola lettura o scrittura che attraversa il confine fra sedi è **bloccante** |
| **BLOCCATO** | non riesci a entrare con gli account delle tre sedi |

## Il tuo report

`docs/collaudo/risultati/tester-05-isolamento-sedi.md` — front-matter con `tester: 05`,
`categoria: isolamento-sedi`. Elenca **le route provate con quale identità verso quale sede**, e nei
warning metti le route nuove che l'inventario non copre ancora anche se oggi sembrano a posto.
