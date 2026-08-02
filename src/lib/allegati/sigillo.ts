// Il SIGILLO di rimozione: la prova che quel file l'ha caricato QUESTO utente, ADESSO.
//
// PERCHÉ ESISTE (S35, collaudo del 2026-07-31).
//
// Chi allega un PDF a un avviso e poi ci ripensa lasciava il documento nel bucket per
// sempre: `removeFile` e la chiusura del modulo toglievano il file dalla BOZZA e mai dallo
// Storage. In produzione c'era già un orfano del 24/05/2026 che nessun avviso nominava.
//
// Un endpoint che cancella un oggetto dal bucket, però, è per costruzione anche il modo di
// cancellare l'allegato dell'avviso di un altro: il percorso non è un segreto, si legge dal
// link firmato che la bacheca restituisce a chiunque possa vedere l'avviso. Serviva quindi
// un modo di dimostrare — non di dichiarare — che il file da togliere è quello appena
// caricato dalla persona che sta chiedendo di toglierlo.
//
// COME. L'upload restituisce un sigillo HMAC su `bucket + percorso + utente + scadenza`.
// Chi chiede la rimozione lo rimanda indietro; il server ricalcola l'HMAC su ciò che ha in
// mano (il percorso arrivato nel corpo, l'utente del PROPRIO gate d'autenticazione) e
// confronta. Cambiare il percorso, spacciarsi per un altro o riusare il sigillo domani
// produce una firma diversa: non serve nessuno stato sul server, e non c'è nessuna tabella
// nuova da tenere pulita. È lo stesso schema dei ticket OTP (`src/lib/auth/otp-ticket.ts`),
// che qui si riusa invece di inventarne un secondo.
//
// IL SIGILLO NON È L'UNICO GATE, ed è importante: la route verifica ANCHE che nessun avviso
// referenzi quel percorso. Il sigillo dice «l'hai caricato tu poco fa»; il secondo controllo
// dice «e nel frattempo non è diventato l'allegato di una comunicazione pubblicata».
//
// NIENTE VARIABILE D'AMBIENTE NUOVA. Il segreto è quello già dichiarato e documentato per i
// ticket OTP, con lo stesso ripiego sulla chiave di servizio (che il preflight critico
// pretende presente in produzione). Un nome nuovo avrebbe voluto dire una variabile in più
// da impostare a mano e una funzione che resta spenta finché qualcuno non se ne ricorda.
// Il DOMINIO è separato nel messaggio firmato (`allegato-rimozione:v1:…`): due usi dello
// stesso segreto non devono poter produrre firme scambiabili.

import { createHmac, timingSafeEqual } from 'crypto'
import { logEvento } from '@/lib/logging/logger'

/**
 * Quanto vale un sigillo: sei ore.
 *
 * È il tempo in cui una bozza può restare aperta su uno schermo — la modale non si chiude da
 * sola, e un modulo lasciato lì durante la giornata è normale. Allungarlo non aumenta il
 * rischio in modo interessante (il secondo gate resta), accorciarlo produrrebbe la
 * situazione peggiore: il file NON viene rimosso e nessuno sa perché.
 */
export const TTL_SIGILLO_ALLEGATO_MS = 6 * 60 * 60 * 1000

type Riferimento = { bucket: string; percorso: string; utenteId: string }

/**
 * Il segreto, letto A OGNI CHIAMATA (non alla prima importazione): su Vercel la
 * configurazione arriva prima del codice, ma nei test si sostituisce, e un valore catturato
 * al caricamento del modulo renderebbe non verificabile proprio il ramo fail-closed.
 *
 * `null` quando non c'è niente da usare: NON esiste un ripiego costante. Un segreto scritto
 * nel sorgente sarebbe pubblico — questo repository lo è — e un sigillo che chiunque può
 * ricalcolare non è un sigillo: è un campo del corpo della richiesta.
 */
function segreto(): string | null {
    const s = process.env.OTP_TICKET_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    return s.trim() === '' ? null : s
}

function impronta(rif: Riferimento, scadenza: number, chiave: string): string {
    return createHmac('sha256', chiave)
        .update(`allegato-rimozione:v1:${rif.bucket}:${rif.percorso}:${rif.utenteId}:${scadenza}`)
        .digest('hex')
}

function confrontoCostante(a: string, b: string): boolean {
    try {
        const ba = Buffer.from(a, 'hex')
        const bb = Buffer.from(b, 'hex')
        return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb)
    } catch {
        // `Buffer.from('zz', 'hex')` non lancia ma tronca; un input non esadecimale finisce
        // comunque con lunghezze diverse. Il catch copre gli argomenti non stringa.
        return false
    }
}

/**
 * Il sigillo da restituire insieme al percorso appena caricato: `<scadenza>.<hmac>`.
 *
 * `null` se non c'è un segreto: in quel caso la rimozione non si offre affatto, invece di
 * offrirla con una firma che non protegge niente. La riga di log è a livello `error` perché
 * una configurazione mancante è un incidente, non una nota (AGENTS §4) — e la conseguenza
 * concreta è che gli allegati abbandonati tornano ad accumularsi in silenzio.
 */
export function firmaRimozioneAllegato(rif: Riferimento): string | null {
    const chiave = segreto()
    if (!chiave) {
        logEvento('config', 'error', {
            operazione: 'firmaRimozioneAllegato',
            esito: 'segreto-assente',
            bucket: rif.bucket,
        })
        return null
    }
    const scadenza = Date.now() + TTL_SIGILLO_ALLEGATO_MS
    return `${scadenza}.${impronta(rif, scadenza, chiave)}`
}

/**
 * Vero solo se il sigillo è stato emesso da noi, per QUESTO file, a QUESTO utente, e non è
 * scaduto. Ogni altro caso — compresa la configurazione mancante — è falso: un gate che in
 * caso di dubbio lascia passare è peggio di nessun gate, perché sembra esserci.
 *
 * Non logga: il chiamante sa che operazione stava facendo ed è l'unico che può scriverne una
 * riga sensata. Non lancia mai: un guasto qui diventerebbe un 500 su un gesto (chiudere una
 * modale) che non deve poter fallire.
 */
export function verificaRimozioneAllegato(rif: Riferimento & { sigillo: unknown }): boolean {
    const chiave = segreto()
    if (!chiave) return false
    if (typeof rif.sigillo !== 'string' || rif.sigillo.trim() === '') return false

    const [testaScadenza, firma] = rif.sigillo.split('.')
    const scadenza = Number(testaScadenza)
    if (!Number.isFinite(scadenza) || !firma) return false
    if (Date.now() > scadenza) return false

    return confrontoCostante(impronta(rif, scadenza, chiave), firma)
}
