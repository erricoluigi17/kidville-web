# Istruzioni di progetto — Kidville Web

Queste regole valgono per **ogni** sessione e vanno rispettate sempre.

## Lingua
- Comunicare con l'utente **solo in italiano**.

## Workflow di modifica (branch · PRD · deploy)
Regole operative obbligatorie:

1. **Si lavora sempre su un branch secondario, mai direttamente su `main`.**
   **Non** si crea un branch nuovo a ogni attività: si **continua sul branch secondario esistente**
   (es. `feat/batch-segreteria`). Un **nuovo branch va creato SOLO dopo un deploy andato a buon fine**
   (merge in `main` + rilascio + pulizia dei branch, vedi punto 3). Non committare mai direttamente su `main`.

2. **Ogni modifica aggiorna anche il PRD.** Il PRD di riferimento è
   **`PRD REGISTRO ELETTRONICO.md`** (nella radice del repo). Qualunque cambiamento a
   codice/funzionalità/schema dati deve essere riflesso nel PRD nello stesso lavoro: aggiornare le
   tabelle di stato in cima e/o aggiungere una voce di changelog datata (vedi il blocco
   "Changelog — …" come modello). Un intervento non è completo se il PRD non è allineato.

3. **Dopo un deploy andato a buon fine** (cioè dopo che **tutte le verifiche/gate sono passate** —
   vedi sotto — e il branch è stato mergeato in `main` e rilasciato), **eliminare tutti i branch
   secondari** (locali e remoti): il branch appena rilasciato e ogni altro branch di lavoro residuo.
   `main` deve restare l'unico branch. Alla prossima modifica si riparte dal punto 1 con un nuovo branch.

4. **Ogni modifica porta con sé i propri log.** Vale per una nuova funzionalità, una nuova route,
   un nuovo trigger, un fix, una migrazione. Il logging **non è un extra**: è parte della
   definizione di "fatto", esattamente come i test e il PRD. Vedi la sezione **Logging obbligatorio**.

## Logging obbligatorio (osservabilità)

**Un codice che fallisce in silenzio è un codice rotto**, anche quando i test passano. In questo
progetto è già successo: per mesi nessuna email di credenziali è arrivata a destinazione perché il
provider rispondeva `403` e il codice registrava soltanto il numero `403`, senza il corpo della
risposta che diceva *perché*. Nessun test era rosso. Nessuno se n'è accorto.

Le regole qui sotto esistono per impedire che si ripeta. **Non sono negoziabili.**

1. **Mai `console.*` diretto in `src/`.** Si usa `@/lib/logging/logger`
   (`logOk`, `logErrore`, `logEvento`). La regola ESLint `no-console` la impone; le eccezioni sono
   solo `src/lib/logging/**`, `src/instrumentation.ts` e `src/middleware.ts` (Edge runtime).

2. **Ogni nuova route API nasce avvolta in `withRoute`:**
   `export const GET = withRoute('gruppo/route:GET', async (request) => { … })`.
   Il lock `__tests__/architecture/logging-coverage.test.ts` lo verifica e **fallisce** se un export
   HTTP resta nudo. Il wrapper è solo osservabilità: gate (`requireStaff`/`requireDocente`) e
   validazione `zod` restano nel corpo della route.

3. **Il corpo dell'errore di un provider esterno non si butta MAI via.** Ogni chiamata a un
   servizio di terze parti (email, FCM, web-push, Aruba/SDI, SIDI) passa da `externalFetch()`.
   **Loggare uno status senza il corpo è il bug**, non un dettaglio: `403` non dice nulla,
   `403 "the domain is not verified"` dice tutto.

4. **Configurazione mancante = livello `error`, mai `info`.** Una variabile d'ambiente critica
   assente in produzione è un incidente, non una nota a piè di pagina.

5. **Gli eventi critici loggano anche il SUCCESSO** (email, push, cron, fattura, pagamento).
   Con i soli errori, *"nessun log" non distingue "tutto ok" da "non è mai partito niente"* — ed è
   esattamente l'ambiguità che ha nascosto il guasto delle email.

6. **Un `catch` che non logga è un bug.** `.catch(() => {})` e `catch { /* ignora */ }` sono vietati:
   se un errore è davvero ignorabile, lo si logga a livello `info` spiegando perché.

7. **PostgREST non lancia: ritorna `{ error }`.** Un `try/catch` attorno a `await supabase.from(…)`
   **non scatta mai**. Va sempre controllato il valore di ritorno. (Il `fetch` strumentato sui client
   Supabase logga comunque ogni `!res.ok`, ma il codice applicativo deve gestire l'errore, non solo
   lasciarlo registrare.)

8. **Mai dati personali nei log.** La redazione (`@/lib/logging/redact`) è a **lista bianca**: passano
   in chiaro solo uuid, numeri, booleani, date e le chiavi esplicitamente permesse. Nomi, email,
   codici fiscali → hash correlabile. Testo libero, diagnosi, allergie, voti, firme, OTP, password →
   redatti. Se aggiungi un campo nuovo, **non** aggiungerlo alla lista bianca "perché sarebbe comodo
   vederlo": sono dati di minori.

9. **Il logger non deve mai rompere l'app.** Fail-open: qualunque eccezione dentro il logging va
   inghiottita. Un bug dell'osservabilità non può diventare un bug del prodotto.

Riferimenti: `docs/superpowers/specs/2026-07-12-logging-strutturato-design.md` (design) e
`docs/superpowers/plans/2026-07-12-logging-strutturato.md` (implementazione).

## Gate di verifica (prima di considerare "fatto" / prima del merge)
Devono essere tutti verdi:
- `npx eslint . --max-warnings 0` → 0 errori (include `no-console` su `src/`)
- `npx vitest run` → tutti verdi (include i lock `zod-coverage` e `logging-coverage`)
- `npm run build` → build ok
- E2E Playwright → verde (gira in CI su push)
- **Log presenti** sul codice toccato: se hai aggiunto una route, un'integrazione esterna o un
  percorso d'errore e non hai aggiunto un log, **l'intervento non è finito**.

## Pipeline `/ship-cycle` (ciclo autonomo di rilascio)
Il repo porta con sé una pipeline agentica committata in `.claude/` (agenti, comando, hook di
gate, flow Maestro). Si invoca con **`/ship-cycle <obiettivo>`**: fa l'intervista iniziale e poi
gira da sola *pianifica → implementa → collauda → correggi* finché tutti gli 11 tester non danno
`PASS` (o si ferma dopo 8 cicli). Rispetta e fa rispettare tutte le regole di questo documento:
branch secondario, PRD aggiornato, logging obbligatorio, gate di verifica.

Spiegazione completa in **`CLAUDE.md`** — dove sta anche il blocco sulle **conferme umane**.
🟩 **Stato dal 2026-09-18**: **autonomia piena, i prompt non arrivano più all'utente** — né in
lettura né in scrittura, né sul DB di produzione, né su merge, `git push`, deploy o migrazioni.
🔴 Resta vero, e non cambia con i permessi: in produzione ci sono **dati reali di minori**. Non
copiare un conteggio da un file: rifallo con `SELECT count(*) FROM enrollment_submissions;` — è una
**lettura**, non ti fermerà nessuno. E mostra comunque cosa stai per applicare: *mostrare* non è
*chiedere*, non costa niente, ed è l'unica cosa fra un errore e le famiglie dietro quelle righe.
Dettagli operativi (hook, `autoMode`, vie di fuga) in **`CLAUDE.md`**; come ci si è arrivati, con
tutte le volte in cui la documentazione ha detto il falso su sé stessa, in
**`docs/storia-permessi-e-conferme.md`**.

## Come si legge il codice (il contesto si paga a ogni turno)

Il contesto di avvio viene riletto **a ogni scambio**: quello che entra una volta lo paghi per tutta
la sessione. Quattro abitudini, misurate su questo repo:

1. **Si legge con `Read`, non con `cat`/`sed` dentro `Bash`.** Non è una preferenza di stile: le
   regole di `.claude/rules/` si attivano sul **Read** di un file che corrisponde ai loro `paths`.
   Chi legge via `Bash` non le riceve mai. (Misurato: 1.914 `Bash` contro 42 `Read`, 0 `Grep`.)
2. **File grosso: `Read` con `offset`/`limit`.** Una lettura costa in media 2.632 token perché si
   prende il file intero dove bastava una fetta.
3. **Si cerca con `Grep`/`Glob`**, che restituiscono solo ciò che corrisponde.
4. **Ogni comando che può stampare molto passa da `head`/`tail`.** `BASH_MAX_OUTPUT_LENGTH` è
   impostato a **5.000** caratteri in `.claude/settings.json`: oltre quella soglia il risultato non
   entra in contesto, arriva un'anteprima di 2 KB e il resto finisce in un file che puoi leggere con
   `Read`. Non perdi niente, ma se ti serve tutto devi fare un giro in più. (Misurato: il 50% dei
   comandi sta sotto i 443 caratteri, il 95% sotto 3.403; la soglia morde il 3%.)

## Note
- `utenti.role` è una colonna **generata** da `ruolo`: non scriverla mai.
- Le route admin usano il pattern service-role (`createAdminClient`) + gate applicativo
  (`requireStaff`/`requireDocente`) + validazione `zod` (lock `zod-coverage`).
- **Tre sedi di produzione** (dal 2026-07-29): **Kidville Giugliano**
  (`d53b0fbc-a9eb-4073-b302-73d1d5abd529`), **Kidville Aversa** e **Kidville Cesa**. Più la sede
  fittizia `e2e00000-…` su cui gira la CI, che va **esclusa** da ogni elenco pubblico.
  Non dare più per scontato che la sede sia una sola: `resolveScuolaScrittura` risponde **400**
  quando l'utente ne ha più d'una e nessuna è indicata, e una route che "indovina" la sede
  archivia i dati nel plesso sbagliato **in silenzio**. Ogni scrittura dichiara la sua sede.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
