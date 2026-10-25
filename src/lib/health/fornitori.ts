import type { Valutazione } from './valutazione'

/**
 * EMAIL E PUSH, LETTI DA `app_log` E MAI DAI FORNITORI (sessione 7 della seconda serie).
 *
 * Per mesi nessuna email di credenziali è arrivata, e nessun controllo lo diceva (AGENTS.md,
 * «Logging obbligatorio»). Oggi ogni chiamata a Resend, FCM e web-push passa da `externalFetch`, che
 * scrive in `app_log` il successo (`info`) e il rifiuto (`error`) con il `provider`: questo modulo
 * li conta, e la salute non chiama nessun fornitore (un campanello che interroga ogni minuto
 * spenderebbe la quota di Resend per sapere se c'è).
 *
 * LA REGOLA. `degradato` se nelle ultime 24 h i rifiuti sono almeno `SOGLIA_RIFIUTI_FORNITORE` E
 * più degli invii riusciti. Nessun invio è `ok`: una domenica non è un guasto. Riuscito = riga
 * `info` con stato 2xx che non sia una chiamata che non consegna niente (`OPERAZIONI_NON_INVII`);
 * rifiuto = riga `error`. Le righe `warn` (rifiuto transitorio che il chiamante ritenta, esito
 * illeggibile) e le `info` non 2xx (token di un'app disinstallata, abbonamento web scaduto) non
 * contano né da una parte né dall'altra.
 *
 * IL LIMITE DICHIARATO. `occorrenze` è contata PER GIORNO (chiave `(fingerprint, giorno)` di
 * `app_log`): una riga vista nelle ultime 24 h porta il conteggio del suo giorno intero. La
 * finestra vera va quindi da 24 a 48 h, uguale per riusciti e rifiuti.
 */

const MIN = 60_000

export const FINESTRA_FORNITORI_MS = 24 * 60 * MIN

/** Il numero di rifiuti sotto cui non si suona mai: due email respinte in un giorno sono un
 *  indirizzo sbagliato, non un fornitore rotto. Misurata al Passo 0.6 del piano della sessione 7. */
export const SOGLIA_RIFIUTI_FORNITORE = 3

/** Le chiamate che riescono senza consegnare niente: il gettone OAuth di FCM
 *  (`src/lib/push/native-push.ts`). Contarle fra i riusciti coprirebbe le push respinte. */
const OPERAZIONI_NON_INVII: ReadonlySet<string> = new Set(['oauth-token'])

/** Una riga come la restituisce la `select` di `controlloEmail`/`controlloPush`. */
export interface RigaEsitoFornitore {
    livello: unknown
    stato_http: unknown
    occorrenze: unknown
    visto_l_ultima: unknown
    operazione: unknown
}

export interface ConteggioFornitore {
    riusciti: number
    rifiuti: number
    /** L'ultima riga riuscita (ms), `null` se nessuna. */
    ultimoRiuscito: number | null
}

function occorrenzeDi(valore: unknown): number {
    return typeof valore === 'number' && Number.isFinite(valore) && valore >= 1 ? Math.floor(valore) : 1
}

export function contaEsitiFornitore(righe: readonly RigaEsitoFornitore[]): ConteggioFornitore {
    let riusciti = 0
    let rifiuti = 0
    let ultimoRiuscito: number | null = null
    for (const r of righe) {
        const n = occorrenzeDi(r.occorrenze)
        if (r.livello === 'error') {
            rifiuti += n
            continue
        }
        const stato = r.stato_http
        if (r.livello !== 'info' || typeof stato !== 'number' || stato < 200 || stato > 299) continue
        if (typeof r.operazione === 'string' && OPERAZIONI_NON_INVII.has(r.operazione)) continue
        riusciti += n
        const t = typeof r.visto_l_ultima === 'string' ? Date.parse(r.visto_l_ultima) : Number.NaN
        if (!Number.isNaN(t) && (ultimoRiuscito === null || t > ultimoRiuscito)) ultimoRiuscito = t
    }
    return { riusciti, rifiuti, ultimoRiuscito }
}

export function fornitoreInAffanno(c: ConteggioFornitore): boolean {
    return c.rifiuti >= SOGLIA_RIFIUTI_FORNITORE && c.rifiuti > c.riusciti
}

/** La decisione per un fornitore. Il dettaglio porta il nome del fornitore e numeri, nient'altro. */
export function valutaFornitore(nome: string, c: ConteggioFornitore, adesso: number): Valutazione {
    if (c.riusciti === 0 && c.rifiuti === 0) {
        return { esito: 'ok', dettaglio: `${nome}: nessun invio nelle ultime 24 h` }
    }
    const ultimo =
        c.ultimoRiuscito === null ? 'nessuno riuscito' : `ultimo riuscito ${Math.floor((adesso - c.ultimoRiuscito) / MIN)} min fa`
    return {
        esito: fornitoreInAffanno(c) ? 'degradato' : 'ok',
        dettaglio: `${nome} nelle ultime 24 h: ${c.riusciti} riusciti, ${c.rifiuti} rifiutati, ${ultimo}`,
    }
}
