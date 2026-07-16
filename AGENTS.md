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

Spiegazione completa in **`CLAUDE.md`** — dove sta anche il **promemoria pre-lancio**: oggi
merge, deploy e migrazioni in produzione girano **senza conferma umana** perché non ci sono
ancora dati reali di famiglie e bambini; prima del lancio le conferme vanno riattivate.

## Note
- `utenti.role` è una colonna **generata** da `ruolo`: non scriverla mai.
- Le route admin usano il pattern service-role (`createAdminClient`) + gate applicativo
  (`requireStaff`/`requireDocente`) + validazione `zod` (lock `zod-coverage`).
- Sede di produzione unica: **Kidville Giugliano** (`d53b0fbc-a9eb-4073-b302-73d1d5abd529`).
