# Tester n. 02 — Backend, gate di ruolo e contratti API

Sei **il tester n. 02**. Fai **un solo collaudo**: le 282 route API — chi le può chiamare, cosa
accettano, cosa rispondono. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; sul database di
produzione **solo `SELECT`**; niente `npm run e2e*` né `npx playwright test`; niente dati personali né
segreti nel report (il repo è pubblico); non fermi né riavvii il server su `:3100`.

> ⚠️ **Divieto specifico tuo**: contro `:3100` e contro la produzione puoi mandare **solo
> `GET`, `HEAD`, `OPTIONS`**. Nessun `POST`/`PUT`/`PATCH`/`DELETE`, nemmeno con un payload che ti
> aspetti venga rifiutato dalla validazione: se la validazione fosse rotta — cioè proprio il difetto
> che stai cercando — scriveresti spazzatura in un database che contiene dati di minori. I percorsi
> di scrittura si collaudano **leggendo il codice e i test mirati**, non sparando richieste.

---

## Che cosa devi verificare

### 1. L'inventario, e i tre lock che lo sorvegliano
```bash
find src/app/api -name route.ts | wc -l                  # atteso ~282
npx vitest run __tests__/api/zod-coverage.test.ts        # ogni route valida l'input con zod
npx vitest run __tests__/architecture/logging-coverage.test.ts   # ogni export HTTP è avvolto in withRoute
npx vitest run __tests__/architecture/gate-coverage.test.ts      # ogni route ha il suo gate
node scripts/audit-route-gates.mjs                       # audit dei gate, riga per riga
```
Un lock verde dice che la **forma** è giusta. Il tuo lavoro è la **sostanza**: prendi un campione di
almeno **25 route** distribuite fra `admin` (97), `pagamenti` (41), `parent` (26), `primaria` (25),
`news` (14), `chat` (9), `mensa`/`forms` (7) e verificale a mano.

### 2. Il gate di ruolo regge davvero
Per ogni route del campione, leggi il sorgente e rispondi a tre domande:
- il gate (`requireStaff` / `requireDocente` / `CRON_SECRET`) c'è **prima** di ogni lettura del corpo
  e di ogni accesso al database? (esiste il lock `corpo-letto-dopo-il-gate`, ma verifica i casi veri)
- il gate controlla il **ruolo giusto**? Una route di segreteria che accetta un docente è un difetto,
  anche se un gate c'è.
- la route dichiara la **sede** su cui scrive/legge, o la indovina? `resolveScuolaScrittura` deve
  rispondere **400** quando l'utente ha più sedi e nessuna è indicata. Una route che indovina archivia
  i dati nel plesso sbagliato **in silenzio**.

Poi provalo sul server, in sola lettura:
```bash
# senza sessione: nessuna route protetta deve rispondere 200, e nessuna deve rispondere 500
for r in /api/parent/students /api/admin/students /api/news/feed /api/mensa/stato; do
  printf '%-30s %s\n' "$r" "$(curl -s -o /dev/null -w '%{http_code}' -m 20 http://localhost:3100$r)"
done
```
Atteso `401`/`403` (o `307` se la route rimanda al login). **`200` è un fallimento bloccante.
`500` è un fallimento**: significa che il codice è arrivato a rompersi prima di negare l'accesso.

### 3. Casi limite e input storti (solo su GET)
Sui parametri di query e sui path dinamici: valore mancante, vuoto, non-uuid, uuid inesistente,
numero negativo, data impossibile (`2026-02-30`), `limit` enorme, stringa lunghissima, caratteri
unicode. Attese: **400 con un codice d'errore**, mai `500`, mai uno stack trace nella risposta.
Esiste il lock `errori-con-codice`: verifica che valga anche sui casi che provi tu.

### 4. Il contratto della risposta
Per ogni route del campione: la forma del JSON è stabile e documentata? I codici di stato sono
coerenti (404 per "non c'è", 403 per "non puoi", 400 per "hai sbagliato tu")? Il corpo dell'errore
non contiene messaggi grezzi del database (lock `messaggio-errore-nei-log`)? Le date escono in un
formato solo?

### 5. PostgREST non lancia
La regola numero 7 di `AGENTS.md`: `await supabase.from(…)` **non lancia mai**, ritorna `{ error }`.
Un `try/catch` attorno non scatta. Cerca i punti dove il valore di ritorno non viene controllato:
```bash
grep -rn "await supabase" src/app/api --include=route.ts | wc -l
grep -rn -A3 "await supabase" src/app/api --include=route.ts | grep -c "error"
```
Il rapporto fra i due numeri ti dice dove guardare. Verifica a mano almeno 10 casi sospetti: una
query che fallisce e non viene controllata produce una pagina vuota senza nessun errore da nessuna
parte.

---

## La prova di validità (obbligatoria)

- Punta il controllo "senza sessione → non 200" su una rotta **pubblica** (`/api/news/feed` se lo è,
  o `/iscrizione`): deve rispondere `200`. Se il tuo metodo dà `403` anche lì, stai misurando altro.
- Prendi un `curl` con un uuid valido ma inesistente: se ricevi `200` con lista vuota invece di `404`,
  hai trovato un difetto di contratto — o il tuo controllo non discrimina. Distingui i due casi.

## Verdetto

| | Quando |
|---|---|
| **PASS** | i lock verdi, il campione di 25 route con gate corretto, nessun 200 senza sessione, nessun 500, casi limite gestiti con codice d'errore |
| **FAIL** | una route protetta raggiungibile, un 500 su input storto, un gate sul ruolo sbagliato, una scrittura che indovina la sede |
| **BLOCCATO** | il server su `:3100` non risponde e non puoi riavviarlo |

## Il tuo report

`docs/collaudo/risultati/tester-02-backend.md` — front-matter con `tester: 02`, `categoria: backend`.
Elenca **le route che hai davvero provato** (non "un campione"), e nei warning metti le route in cui
il ritorno di PostgREST non è controllato anche se oggi non si rompe.
