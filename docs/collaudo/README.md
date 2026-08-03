# Kit di collaudo manuale — 20 tester in parallelo

> Ogni tester è **una chat separata**. Si apre la chat e si scrive: **«tu sei il tester n. 7»**.
> Il tester legge questo file, poi `prompt/tester-07-*.md`, esegue **un solo** collaudo e deposita
> il suo report in `risultati/`. Nessun tester scrive codice, nessuno committa, nessuno tocca il
> database in scrittura.

- **Che test esistono e perché sono venti** → [`00-TIPI-DI-TEST.md`](00-TIPI-DI-TEST.md)
- **Come si scrive il report** → [`MODELLO-REPORT.md`](MODELLO-REPORT.md)
- **Come si tirano le somme alla fine** → [`SINTESI.md`](SINTESI.md)

## I venti tester

| n. | Collauda | Prompt |
|---|---|---|
| 01 | gate formale: lint, tipi, unit, build, dipendenze, smoke | [`tester-01-gate.md`](prompt/tester-01-gate.md) |
| 02 | backend: 282 route, gate di ruolo, zod, contratti, casi limite | [`tester-02-backend.md`](prompt/tester-02-backend.md) |
| 03 | database: 92 migrazioni, advisor, RLS, retro-compatibilità | [`tester-03-database.md`](prompt/tester-03-database.md) |
| 04 | sicurezza: bypass, escalation, IDOR, injection, segreti, header | [`tester-04-sicurezza.md`](prompt/tester-04-sicurezza.md) |
| 05 | isolamento fra le tre sedi | [`tester-05-isolamento-sedi.md`](prompt/tester-05-isolamento-sedi.md) |
| 06 | privacy e GDPR su dati di minori | [`tester-06-privacy.md`](prompt/tester-06-privacy.md) |
| 07 | frontend: rendering, idratazione, stati, responsive, WebKit | [`tester-07-frontend.md`](prompt/tester-07-frontend.md) |
| 08 | design system Clay Village | [`tester-08-design.md`](prompt/tester-08-design.md) |
| 09 | accessibilità WCAG 2.2 AA | [`tester-09-accessibilita.md`](prompt/tester-09-accessibilita.md) |
| 10 | localizzazione it/en, date, fusi, layout | [`tester-10-localizzazione.md`](prompt/tester-10-localizzazione.md) |
| 11 | prestazioni: Core Web Vitals, query lente, volume | [`tester-11-prestazioni.md`](prompt/tester-11-prestazioni.md) |
| 12 | osservabilità: se si rompe, me ne accorgo? | [`tester-12-osservabilita.md`](prompt/tester-12-osservabilita.md) |
| 13 | percorsi utente end-to-end e copertura della suite | [`tester-13-e2e.md`](prompt/tester-13-e2e.md) |
| 14 | app nativa Android (Maestro, emulatore) | [`tester-14-android.md`](prompt/tester-14-android.md) |
| 15 | app nativa iOS (Maestro, simulatore) | [`tester-15-ios.md`](prompt/tester-15-ios.md) |
| 16 | offline, service worker, provider caduti, rete lenta | [`tester-16-offline-resilienza.md`](prompt/tester-16-offline-resilienza.md) |
| 17 | notifiche push, email transazionali, digest | [`tester-17-notifiche-email.md`](prompt/tester-17-notifiche-email.md) |
| 18 | contenuti pubblicati: sanificazione, embed, consensi foto, SEO | [`tester-18-contenuti.md`](prompt/tester-18-contenuti.md) |
| 19 | regressione sul diff e retro-compatibilità | [`tester-19-regressione.md`](prompt/tester-19-regressione.md) |
| 20 | prontezza al rilascio: env, migrazioni, rollback, allarmi | [`tester-20-rilascio.md`](prompt/tester-20-rilascio.md) |

---

## Prima di aprire le chat (5 minuti, li fa l'umano)

1. **Il codice da collaudare deve essere quello servito su `:3100`.**
   Su quella porta gira `npx next start -p 3100`, cioè una **build congelata**: se hai toccato il
   codice dopo l'ultima build, quel server serve roba vecchia. In quel caso, e **solo** in quel caso:
   ```bash
   lsof -ti tcp:3100 | xargs -r kill        # ferma il server vecchio (padre e figlio)
   npm run build && (npx next start -p 3100 &)
   ```
   Verifica: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/` → `307` va bene
   (le pagine autenticate reindirizzano al login: è il comportamento giusto).

2. **Esporta la password degli account TEST** nella shell da cui apri le chat:
   ```bash
   export KV_TEST_PASSWORD='…'      # sta nel gestore di credenziali del titolare
   ```
   Nessun tester deve cercarla nei file, e **nessuno la scrive nel report**.

3. **Svuota o archivia i risultati del giro precedente**:
   ```bash
   [ -n "$(ls -A docs/collaudo/risultati 2>/dev/null | grep -v '^\.')" ] && \
     mv docs/collaudo/risultati "docs/collaudo/risultati-$(date +%F-%H%M)" && \
     mkdir -p docs/collaudo/risultati
   ```

4. **Decidi quanti tester lanciare.** Non serve lanciarli tutti. Tre insiemi già pronti:

   | Se hai poco tempo | Rilascio normale | Rilascio grosso / audit |
   |---|---|---|
   | 01 · 02 · 04 · 05 · 06 · 19 | + 03 · 07 · 09 · 12 · 13 · 20 | tutti e 20 |
   | il gate e le falle che qui sono già state vere | + il percorso utente e il rilascio | + mobile, prestazioni, contenuti |

---

## Regole comuni — valgono per **tutti** i tester, senza deroghe

### 1. Non modifichi niente
Nessun `git add`, `commit`, `push`, `checkout`, `stash`, `merge`, `reset`. Nessuna modifica a file
tracciati. Nessun `npm install`. **Diciannove altre chat stanno lavorando sullo stesso albero di
lavoro nello stesso momento**: un `git checkout` o un `npm install` sabota il lavoro di tutti gli
altri, non solo il tuo. Gli script d'appoggio si scrivono in una cartella temporanea tua.
L'unico file che scrivi nel repo è il tuo report.

### 2. Il database di produzione si legge, non si scrive
`.env.local` punta al **database di produzione**, dove ci sono **dati reali di minori**
(domande d'iscrizione, codici fiscali, allergie, note mediche).

- Query di lettura: `mcp__supabase__execute_sql` con **solo `SELECT`**. Ti verrà chiesta una
  conferma umana ad ogni query: è previsto, è il funzionamento corretto, non aggirarlo.
- **Mai** `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`, `DROP`. Mai `apply_migration`.
- **Mai** `npm run e2e`, `npm run e2e:seed`, `npx playwright test`: sono vietati dai permessi del
  repo proprio perché scriverebbero nel database di produzione. L'E2E gira **solo in CI**.
- Nell'interfaccia: naviga e leggi. Non salvare form, non creare avvisi, non registrare presenze,
  non inviare messaggi. Se un controllo richiede una scrittura, **non farlo**: scrivi nel report
  «non verificabile senza scrittura su produzione» e spiega cosa servirebbe.

### 3. Mai dati personali, mai segreti, nel report
Il repo è **pubblico**. Nel report non finiscono nomi, cognomi, email reali, codici fiscali,
indirizzi, telefoni, diagnosi, allergie, note mediche, firme, OTP, token, password — **nemmeno
mascherati a metà**. Si scrive: il conteggio delle righe, l'uuid, il codice d'errore, il nome della
colonna. `152 codici fiscali di minori nella colonna X` è un rilievo perfetto; il codice fiscale, no.
Gli account TEST si citano per **ruolo** (`l'account segreteria`), non serve nemmeno l'indirizzo.

### 4. Un test solo, il tuo
Il valore di venti tester in parallelo è che ognuno guarda **una cosa sola, fino in fondo**. Se
inciampi in un difetto che appartiene a un altro tester, annotalo in una riga sotto `ALTRUI` e
tira dritto. Non allargare il perimetro.

### 5. «PASS si guadagna, non si presume» — la prova di validità
Prima di scrivere `PASS`, **dimostra che il tuo test saprebbe fallire**. Rimetti il difetto,
rompi l'asserzione, punta il controllo su una pagina che sai essere rotta: se il test resta verde
lo stesso, il test è finto e il tuo `PASS` non vale niente. In questo repo è già successo tre
volte, con il gate verde: le email che rispondevano `403` da mesi, l'isolamento fra sedi con 3424
test verdi, il loop biometrico Android. **Scrivi nel report *come* hai fatto la prova di validità.**

### 6. I warning si scrivono anche quando il verdetto è PASS
La sezione `WARNING` non è opzionale ed è quasi sempre la parte più utile del report.

### 7. Un solo file di output, il tuo
```
docs/collaudo/risultati/tester-NN-<slug>.md
```
Il nome esatto sta in fondo al tuo prompt. **Non leggere e non toccare i report degli altri**:
stanno scrivendo nello stesso istante. La cartella `risultati/` è esclusa da git apposta
(può contenere estratti del database di produzione): resta sul disco, non finisce su GitHub.

### 8. Se ti blocchi, il verdetto è `BLOCCATO`
`BLOCCATO` con la spiegazione di cosa manca è un esito onesto e utile. `PASS` dato per non aver
saputo verificare è un danno. Non provare più di due o tre volte la stessa strada che fallisce.

---

## Chi può usare cosa (venti chat, una macchina sola)

| Risorsa | Chi la può usare | Perché |
|---|---|---|
| `npm run build` (scrive `.next/`) | **solo il tester 01** | build concorrenti si corrompono a vicenda |
| `npm run gate` / suite `vitest` intera | **solo il tester 01** | 674 file, ~6200 test: satura la macchina |
| `npx vitest run <percorso>` mirato | tutti | è leggero e non scrive niente |
| `npx eslint <percorso>` · `npx tsc --noEmit` | tutti | non scrivono |
| server `:3100` | tutti, in lettura | **nessuno lo ferma e nessuno lo riavvia** |
| estensione Chrome (`claude-in-chrome`) | **uno alla volta** | è il Chrome vero dell'utente: due chat che cliccano insieme si annullano |
| browser headless tuo | tutti | `webkit` è già installato; per Chromium usa `channel: 'chrome'` |
| emulatore Android | **solo il tester 14** | |
| simulatore iOS | **solo il tester 15** | |
| `mcp__supabase__execute_sql` (solo SELECT) | tutti | ogni query chiede conferma all'umano |
| `git`, `npm install`, `pkill` | **nessuno** | albero di lavoro condiviso |

**Browser in parallelo.** L'estensione Chrome è una risorsa singola. Se sei un tester che deve
guardare pagine e non sei sicuro di essere l'unico, usa un browser tuo isolato:

```js
// script tuo, in una cartella temporanea — NON nel repo
const { webkit, chromium } = require('/Users/lerri/kidville-web/node_modules/playwright')
const browser = await chromium.launch({ channel: 'chrome' })   // Chrome già installato
// const browser = await webkit.launch()                        // motore Safari, già scaricato
const page = await (await browser.newContext({ locale: 'it-IT' })).newPage()
await page.goto('http://localhost:3100/auth/login')
```
Questo **non** è `playwright test` (vietato): è una sessione di sola lettura, senza seed.
Login con gli account TEST e `process.env.KV_TEST_PASSWORD`, poi **solo navigazione**.

---

## Riferimenti utili a tutti

| Cosa | Dove |
|---|---|
| Regole di progetto | `AGENTS.md` · `CLAUDE.md` |
| Account TEST e ruoli | `PRD REGISTRO ELETTRONICO.md` — cerca `@kidville.test` |
| Password account TEST | variabile `KV_TEST_PASSWORD` — **mai** nel report |
| Le tre sedi di produzione | Giugliano `d53b0fbc-…`, Aversa, Cesa (+ la sede finta `e2e00000-…` della CI, da escludere) |
| Audit precedenti | `docs/audit/` — leggi prima di riaprire un rilievo già smontato |
| Arretrato dei warning | `docs/audit/2026-08-02-arretrato-warning.md` |
| Variabili d'ambiente | `docs/env.md` |
| E2E | `docs/e2e.md` |
| Flow Maestro | `.claude/maestro-flows/README.md` |
| Comandi | `npm run gate` · `npm run typecheck` · `npm run build` · `npx vitest run <path>` |

**Comandi vietati dai permessi del repo** (non provarci): `npm run e2e*`, `npx playwright test`,
`node scripts/seed-e2e.mjs`, `supabase db reset`, lettura dei file `.env*`.

---

## Alla fine

Quando i report sono in `risultati/`, apri **una** chat nuova e incolla il contenuto di
[`SINTESI.md`](SINTESI.md): produce l'elenco unico dei difetti, deduplicato, ordinato per gravità,
con il piano di correzione. È lì che si decide cosa si sistema e in che ordine.
