/**
 * LA VERSIONE DI QUESTO RILASCIO — una regola sola, per tre lettori.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE QUESTO FILE. La funzione viveva dentro `src/lib/health/controlli.ts`
 * (`versioneCorrente`) e serviva a UN solo corpo di risposta, quello di `/api/health/vivo`.
 * Dal 2026-10-12 la stessa stringa la leggono TRE posti:
 *
 *  1. `/api/health/vivo` e `/api/health`, dove dice «stai parlando col rilascio nuovo»;
 *  2. `GET /api/versione`, che è la domanda che il browser fa quando torna in primo piano;
 *  3. il BUNDLE DEL BROWSER, dove la stessa stringa è COTTA IN BUILD (`VERSIONE_BUNDLE`).
 *
 * I tre devono dire la stessa cosa a partire dallo stesso commit, e la ragione è pratica, non
 * estetica: il client confronta ciò che ha in mano con ciò che il server serve, e se le due
 * normalizzazioni divergessero di un carattere il confronto sarebbe diverso PER SEMPRE —
 * cioè una ricarica a ogni ritorno in primo piano, su ogni telefono. Una regola scritta due
 * volte è una regola che diverge; perciò sta qui e la si importa.
 *
 * ⚠️ IL VINCOLO CHE NON SI ALLENTA. `/api/versione` è PUBBLICA (non ha gate: non c'è niente
 * dietro), e il valore arriva da una variabile d'ambiente. Una variabile d'ambiente non è un
 * dato nostro: se non ha la forma di uno sha NON ESCE. Senza questo filtro la route
 * rilancerebbe a un anonimo il contenuto arbitrario di `process.env` — che è la stessa ragione
 * per cui `conIdentita()` in `controlli.ts` nasceva già con questo controllo.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Quanti caratteri dello sha si tengono. Dodici è la lunghezza che git stesso usa per
 * disambiguare su repository grandi, ed è quella che `/api/health` già pubblica: cambiarla
 * farebbe divergere i corpi di due endpoint che parlano dello stesso deploy.
 */
export const VERSIONE_MAX = 12;

/** La forma di uno sha di commit: da quello corto di git (7) a quello pieno (40). */
const FORMA_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Lo sha ridotto alla forma che può uscire: minuscolo, `VERSIONE_MAX` caratteri, oppure `null`.
 *
 * `null` e NON stringa vuota: il client confronta la versione servita con la propria, e `''`
 * sarebbe «una versione» diversa da qualunque altra — cioè una ricarica garantita. Il niente
 * si dichiara come niente.
 */
export function shaNormalizzato(valore: string | null | undefined): string | null {
    const sha = typeof valore === 'string' ? valore.trim() : '';
    return FORMA_SHA.test(sha) ? sha.slice(0, VERSIONE_MAX).toLowerCase() : null;
}

/**
 * La versione del rilascio secondo l'ambiente del SERVER.
 *
 * `VERCEL_GIT_COMMIT_SHA` la valorizza Vercel (`autoExposeSystemEnvs`); fuori da Vercel — una
 * build locale, la CI, `next dev` — non c'è, e la risposta è `null`: non si inventa una versione
 * per far sembrare configurato ciò che non lo è.
 *
 * L'accesso a `process.env` è STATICO di proposito: è la forma che il bundler sostituisce, e
 * quella dinamica (`process.env[nome]`) non verrebbe mai sostituita (vedi `ambiente.ts`).
 */
export function versioneDeploy(): string | null {
    try {
        return shaNormalizzato(process.env.VERCEL_GIT_COMMIT_SHA);
    } catch {
        // `process` inesistente (una WebView, un worker): non c'è nessuna versione da dichiarare.
        return null;
    }
}

/**
 * LA VERSIONE COTTA NEL BUNDLE DEL BROWSER — cioè «quale codice ha in mano l'utente».
 *
 * La inietta `next.config.ts` con la chiave `env`, derivandola dalla STESSA
 * `VERCEL_GIT_COMMIT_SHA` e con la STESSA `shaNormalizzato`. Non è una variabile che qualcuno
 * imposta a mano: cambia a ogni commit, e un valore impostato a mano sarebbe sbagliato dal
 * secondo deploy in poi.
 *
 * ⚠️ PERCHÉ NON SI LEGGE `VERCEL_GIT_COMMIT_SHA` DA QUI. Solo le variabili `NEXT_PUBLIC_*` (e
 * le chiavi dichiarate in `env` di `next.config`) vengono sostituite nel bundle del client:
 * `process.env.VERCEL_GIT_COMMIT_SHA` nel browser è `undefined`, sempre, e un confronto fra
 * `undefined` e lo sha servito non direbbe «versione diversa» — direbbe niente, cioè il
 * controllo spento in silenzio. Questa è la metà della storia che DEVE stare nel bundle.
 *
 * Assente (sviluppo, CI, un ambiente senza la variabile) → `null`, e il controllo non parte:
 * un'applicazione che si ricarica da sola in sviluppo sarebbe insopportabile e inutile.
 */
export const VERSIONE_BUNDLE: string | null = shaNormalizzato(
    process.env.NEXT_PUBLIC_VERSIONE_BUNDLE,
);
