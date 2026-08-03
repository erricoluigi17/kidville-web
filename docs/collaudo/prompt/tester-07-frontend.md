# Tester n. 07 — Frontend, stati e compatibilità fra browser

Sei **il tester n. 07**. Fai **un solo collaudo**: quello che l'utente vede davvero nel browser —
rendering, idratazione, stati di caricamento/vuoto/errore, console, responsive, motori diversi.
Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; niente
`npm run e2e*` né `npx playwright test`; non fermi né riavvii il server su `:3100`.

> ⚠️ **Naviga e leggi, non salvare.** Il server su `:3100` parla col database di **produzione**: non
> salvare form, non creare avvisi, non registrare presenze, non mandare messaggi. Se un controllo
> richiede una scrittura, scrivi «non verificabile senza scrittura su produzione».

---

## Come guardare le pagine (venti chat, un browser solo)

L'estensione Chrome è una risorsa singola: se non sei sicuro di essere l'unico a usarla, apri un
browser tuo, isolato. Playwright è già installato come libreria (**non** stai lanciando la suite E2E,
che è vietata: stai aprendo una sessione di sola lettura).

```js
// script in una cartella temporanea, NON nel repo
const { chromium, webkit } = require('/Users/lerri/kidville-web/node_modules/playwright')
const browser = await chromium.launch({ channel: 'chrome' })   // motore Blink, Chrome già installato
// const browser = await webkit.launch()                        // motore Safari, già scaricato
const ctx = await browser.newContext({ locale: 'it-IT', timezoneId: 'Europe/Rome' })
const page = await ctx.newPage()
page.on('console', m => m.type() === 'error' && console.log('CONSOLE', m.text()))
page.on('pageerror', e => console.log('PAGEERROR', e.message))
page.on('response', r => r.status() >= 400 && console.log('HTTP', r.status(), r.url()))
await page.goto('http://localhost:3100/auth/login')
```
Login con un account TEST e `process.env.KV_TEST_PASSWORD` (mai nel report). Se Firefox ti serve,
**non** installarlo: annotalo fra i non verificati — il download interferirebbe con le altre chat.

---

## Che cosa devi verificare

### 1. Le tre aree, pagina per pagina
- **genitore** `/parent` — 18 sezioni: attendance, avvisi, chat, compiti, diary, forms, gallery,
  lezioni, locker, mensa, modulistica, news, onboarding, pagamenti, primaria, profilo, register
- **docente** `/teacher` — 14 sezioni
- **admin/segreteria** `/admin` (25 sezioni) e `/segreteria`
- **pubbliche** `/`, `/auth/login`, `/iscrizione`, `/privacy`, `/termini`, `/assistenza`, `/offline`,
  `/cancellazione-account`, `/onboarding`

Non devi visitarle tutte: scegline **almeno 15** coprendo tutte e quattro le aree, e dillo quali.
Per ognuna: si carica? La console è pulita? Ci sono richieste HTTP ≥ 400? Il contenuto è quello atteso
per quel ruolo?

### 2. Idratazione
Gli errori di idratazione qui sono già costati due volte: un saluto basato sull'ora calcolato lato
server, e un `app/loading.tsx` in root che **rompeva** l'idratazione. Cerca in console
`Hydration failed`, `Text content does not match`, `did not match`. Trappola nota da ricordare:
**l'idratazione di React annulla gli script inline che scrivono nel DOM** — se una pagina "lampeggia"
e poi torna indietro, è quello.

### 3. I tre stati che nessuno guarda
Per ogni sezione, oltre allo stato pieno:
- **caricamento**: c'è un indicatore, o la pagina resta bianca? Rallenta la rete
  (`page.route(…)` con un ritardo) e guarda.
- **vuoto**: un genitore senza avvisi, una classe senza alunni, un mese senza pagamenti. Vedi un
  messaggio sensato o una tabella con le intestazioni e basta?
- **errore**: fai fallire una chiamata (`page.route('**/api/**', r => r.fulfill({status: 500}))`) e
  guarda cosa vede l'utente. Una pagina bianca senza spiegazione è un fallimento.

### 4. Responsive
Larghezze **320**, **375**, **768**, **1024**, **1440**. Cerca: tracimazione orizzontale (`document
.documentElement.scrollWidth > innerWidth`), testo tagliato, bottoni fuori schermo, la bottom-nav che
copre il contenuto, tabelle che escono. L'app è usata soprattutto da telefono: **320 px conta più di
1440**.

### 5. Compatibilità fra motori
Ripeti almeno **5 pagine** su WebKit (motore Safari, quello che gira dentro la WebView iOS). Cerca
differenze in: campi data, `input type=date`, flex/grid, `backdrop-filter`, font, scroll. La suite E2E
usa **solo chromium**: tutto quello che trovi su WebKit è per definizione scoperto.

### 6. Componenti
```bash
npx vitest run __tests__/components __tests__/pages __tests__/ui
```
Riporta i numeri; se qualcosa è rosso, l'output letterale.

---

## La prova di validità (obbligatoria)

- Punta il tuo ascoltatore della console su una pagina che **sai** produrre un errore (o iniettane uno
  con `page.evaluate(() => { throw new Error('prova') })`): deve vederlo. Un ascoltatore che non ha
  mai stampato niente in 15 pagine è più probabilmente rotto che fortunato.
- Il controllo della tracimazione: portalo a 280 px, dove **deve** scattare. Se non scatta lì, non
  scatterebbe mai.

## Verdetto

| | Quando |
|---|---|
| **PASS** | 15+ pagine caricate, console pulita, nessun 4xx/5xx inatteso, stati vuoto/errore gestiti, nessuna tracimazione da 320 px in su, WebKit senza rotture |
| **FAIL** | una pagina bianca, un errore di idratazione, uno stato d'errore che non dice niente all'utente, una tracimazione su mobile |
| **BLOCCATO** | non riesci ad autenticarti, o il server non risponde |

## Il tuo report

`docs/collaudo/risultati/tester-07-frontend.md` — front-matter con `tester: 07`, `categoria: frontend`.
Elenca **le pagine visitate** con l'esito di ognuna. Nei warning: i lampeggii, le attese senza
indicatore, le differenze WebKit che non rompono ma si vedono.
