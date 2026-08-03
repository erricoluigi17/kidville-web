# Tester n. 12 — Osservabilità: se si rompe, me ne accorgo?

Sei **il tester n. 12**. Fai **un solo collaudo**: i log. Non "ci sono i log", ma: *quando questa cosa
si romperà in produzione, il log mi dirà **perché**?* Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; sul database di
produzione **solo `SELECT`**; non fermi né riavvii il server su `:3100`.

---

## Il precedente che giustifica questo tester

Per **mesi** nessuna email di credenziali è arrivata a destinazione. Il provider rispondeva `403` e il
codice registrava il numero `403`, senza il corpo della risposta che diceva *perché*
(«the domain is not verified»). Nessun test era rosso. Nessuno se n'è accorto.

Da lì le nove regole di `AGENTS.md` § *Logging obbligatorio*. Il tuo lavoro è verificare che valgano
**oggi, sul codice vero**, non che siano scritte.

---

## Che cosa devi verificare

### 1. I lock, e poi la sostanza
```bash
npx vitest run __tests__/logging __tests__/architecture/logging-coverage.test.ts
npx vitest run __tests__/architecture/eventi-log.test.ts
npx vitest run __tests__/architecture/catch-muti-allowlist.test.ts
npx vitest run __tests__/architecture/provider-esterni-osservati.test.ts
npx vitest run __tests__/architecture/messaggio-errore-nei-log.test.ts
npx vitest run __tests__/architecture/errori-con-codice.test.ts
npx vitest run __tests__/architecture/cron-http-esito-osservato.test.ts
npx vitest run __tests__/architecture/console-suppressions.test.ts
```

### 2. `console.*` fuori posto
Vietato in `src/`, tranne `src/lib/logging/**`, `src/instrumentation.ts`, `src/middleware.ts`.
```bash
grep -rn "console\." src/ --include=*.ts --include=*.tsx | grep -v "src/lib/logging\|instrumentation\|middleware" | head -30
grep -rn "eslint-disable.*no-console" src/ | head -20
```
Una soppressione ESLint è più grave di una violazione: la violazione è visibile, la soppressione no.

### 3. Il corpo dell'errore dei provider esterni
Ogni chiamata a un servizio di terze parti (email, FCM, web-push, Aruba/SDI, SIDI) deve passare da
`externalFetch()` e **conservare il corpo della risposta**, non solo lo status.
```bash
grep -rn "fetch(" src/lib src/app/api --include=*.ts | grep -v externalFetch | grep -v supabase | head -40
```
Ogni `fetch` diretto verso l'esterno che non passa dalla primitiva è un rilievo. Per ognuno chiediti:
se questo rispondesse `403`, dal log capirei il perché?

### 4. Catch muti
```bash
grep -rn "catch\s*{\s*}\|catch\s*(\w*)\s*{\s*}\|\.catch(() => {})\|catch.*ignora" src/ | head -30
```
Un `catch` che non logga è un bug. Se un errore è davvero ignorabile, va loggato a livello `info`
**spiegando perché**.

### 5. PostgREST non lancia
`await supabase.from(…)` ritorna `{ error }`, non lancia: un `try/catch` attorno **non scatta mai**.
Cerca i punti dove il ritorno non viene controllato (metodo nel prompt del tester 02; qui interessa il
lato log: un errore del database che nessuno registra è un guasto invisibile).

### 6. Il successo si logga, non solo l'errore
Regola 5: gli eventi critici loggano **anche il successo** — email, push, cron, fattura, pagamento.
Senza, *«nessun log» non distingue «tutto ok» da «non è mai partito niente»*: è precisamente
l'ambiguità che ha nascosto il guasto delle email.
```bash
grep -rn "logOk\|logEvento" src/lib/notifiche src/lib/email src/app/api/cron 2>/dev/null | head -30
```

### 7. Configurazione mancante = `error`
Una variabile d'ambiente critica assente in produzione è un incidente, non una nota.
```bash
npx vitest run __tests__/architecture/env-critiche-documentate.test.ts
grep -rn "process.env" src/ | grep -c ""
```
Verifica che ogni variabile critica, se manca, produca un log di livello `error` — non `info`, non
silenzio.

### 8. La realtà: guarda `app_log`
La politica dei livelli decide **cosa finisce in tabella**: 2xx/3xx e 4xx normali no; 408/409/413/429,
i 400 da utente autenticato, i 5xx e le eccezioni sì. Con `SELECT` (solo aggregati):
- quante righe negli ultimi 7 giorni, per livello e per route;
- le 10 route che producono più errori;
- se c'è una route che **non compare mai**, anche se è chiamata: è il caso sospetto — o non passa da
  `withRoute`, o non logga niente;
- se il tasso di errore è **zero ovunque**: sospetto anche quello. Un sistema con 282 route e zero
  errori in 7 giorni, di solito, non sta loggando.

### 9. E poi cosa? Gli allarmi
I log servono se qualcuno li legge. Verifica se esiste un allarme, una soglia, una notifica — o se
l'unico modo di accorgersi di un guasto è che lo dica un genitore. Se non c'è niente, **è un rilievo**:
scrivi cosa proporresti (tre allarmi concreti, con soglia).

### 10. Un dettaglio da confermare
`src/lib/logging/with-route.ts:7` parla di **239 route**; oggi sono **282**. Verifica e riportalo: un
commento che mente sul proprio dominio è il primo sintomo di una documentazione che nessuno rilegge.

---

## La prova di validità (obbligatoria)

Devi **provocare un errore** e vedere se il log lo racconta. Senza scrivere sul database e senza
toccare il codice:
- chiama una route con un parametro palesemente storto (un uuid inventato, un `limit` assurdo) e
  guarda se compare in `app_log` con route, codice e causa;
- fai una richiesta a una rotta inesistente e verifica che non generi rumore inutile;
- verifica che nel log **non** finisca il valore che hai mandato, se contiene qualcosa di personale
  (la redazione è a lista bianca).
Se dopo aver provocato l'errore in `app_log` non c'è niente, il rilievo è grosso e va scritto.

## Verdetto

| | Quando |
|---|---|
| **PASS** | lock verdi, nessun `console.*` fuori posto, nessun catch muto, provider esterni con corpo dell'errore, successi loggati, errore provocato che compare in `app_log` con la causa |
| **FAIL** | un catch muto, un provider che logga solo lo status, un evento critico senza log di successo, un errore provocato che non lascia traccia |
| **BLOCCATO** | non puoi leggere `app_log` |

## Il tuo report

`docs/collaudo/risultati/tester-12-osservabilita.md` — front-matter con `tester: 12`,
`categoria: log`. Nei warning finisce tutto quello che i test formali non colgono: commenti obsoleti,
soppressioni, log troppo verbosi, log che non servirebbero a nessuno durante un guasto vero.
