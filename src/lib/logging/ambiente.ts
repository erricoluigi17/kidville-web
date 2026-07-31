/**
 * DOVE STA GIRANDO QUESTO CODICE — l'unica risposta che il log ha il diritto di dare.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL GUASTO CHE QUESTO MODULO ESISTE PER IMPEDIRE (dimostrato in produzione).
 *
 * La regola era `VERCEL_ENV ?? NODE_ENV`. Sembra prudente — "se Vercel non me lo dice,
 * chiedo a Node" — e invece è il modo esatto per far mentire il log: `next build` imposta
 * `NODE_ENV='production'` su QUALUNQUE macchina, perché descrive il TIPO DI BUILD
 * (ottimizzata, senza dev tooling), non il luogo in cui il codice gira. Un `npm run build`
 * sul portatile di uno sviluppatore apre quindi un processo che si crede in produzione,
 * esegue il preflight, non trova le variabili — che sul portatile non ci sono mai — e
 * scrive nella tabella di produzione una riga `livello=error`, `ambiente=production`.
 *
 * È successo davvero: dal 16 al 31 luglio 2026, otto righe «variabile d'ambiente critica
 * mancante: LOG_HASH_SALT» in `app_log`, con `ambiente=production` e `livello=error`,
 * mentre su Vercel il salt c'era e gli hash uscivano regolarmente. Le smaschera
 * `app_versione = null`: nessuno sha di commit, cioè nessun deploy — ma quella colonna la
 * guarda chi ha già il sospetto, e chi indaga un guasto alle tre di notte filtra prima di
 * tutto per `livello` e `ambiente`. Il log non taceva: raccontava un incidente inventato,
 * al livello più alto, nel canale più letto. È il difetto peggiore che un log possa avere,
 * peggio di un log assente — perché manda a cercare una causa che non esiste.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * LA REGOLA, unica e senza scorciatoie: **solo Vercel può dire «production»**.
 * `VERCEL_ENV` la piattaforma la valorizza SEMPRE sulle proprie invocazioni
 * (`production` | `preview` | `development` per `vercel dev`). Se non c'è, il processo non
 * sta girando su Vercel: sta girando sulla macchina di qualcuno — build locale, `next dev`,
 * uno script, la CI. Per quel caso c'è UNA sola etichetta, `locale`, e non due: dal punto
 * di vista di chi legge i log, un `next dev` e un `next build` sullo stesso portatile sono
 * la stessa identica cosa — non sono l'applicazione distribuita. Distinguerli
 * rimetterebbe in ballo `NODE_ENV`, cioè la fonte che ha già mentito una volta.
 *
 * NIENTE IMPORT, e non è pigrizia: `src/instrumentation.ts` importa questo modulo in modo
 * STATICO, e finisce anche nel bundle Edge del middleware, dove `node:crypto` e il client
 * Supabase non esistono. Come `./path` e `./serialize`, questo file resta caricabile da
 * qualunque runtime perché non tira dentro niente.
 */

/**
 * L'ambiente della riga di log: `production` | `preview` | `development` quando siamo su
 * Vercel (è il valore che la piattaforma dichiara), altrimenti `locale`.
 *
 * Non lancia mai — è chiamata dal logger, e un logger che lancia trasforma una 200 in 500.
 * L'accesso a `process.env.VERCEL_ENV` è STATICO: è la forma che il bundler sostituisce, e
 * quella dinamica (`process.env[nome]`) restituirebbe `undefined` in un bundle client.
 */
export function ambienteCorrente(): string {
    try {
        const v = process.env.VERCEL_ENV;
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
    } catch {
        // `process` inesistente (browser, worker): non siamo su Vercel, punto.
    }
    return 'locale';
}
