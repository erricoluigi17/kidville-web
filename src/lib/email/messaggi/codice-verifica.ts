import { esc, h, unisci } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import { avviso, nota, p, riquadroCodice, tabMascotte } from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 02 · Codice di verifica — UNA SOLA EMAIL PER TUTTE LE OCCASIONI
//
// Va sempre e solo a un genitore, quindi il «tu» qui è corretto e naturale.
// L'unica cosa che cambia è `{operazione}`, che completa la frase
// «Il tuo codice per **{operazione}** è:».
//
// ─── I QUATTRO REQUISITI DURI ───────────────────────────────────────────────
//  1. IL CODICE È L'UNICA COSA CHE CONTA. Grande, monospaziato, cifre
//     distanziate, primo elemento sotto l'intestazione. Nient'altro compete.
//  2. SI DEVE LEGGERE SENZA APRIRE L'EMAIL. Il preheader contiene il codice
//     stesso: è il gesto reale — la gente lo legge dalla notifica del telefono e
//     il messaggio non lo apre mai. (Il preheader viaggia dentro l'HTML che
//     spediamo a Resend; `externalFetch` logga solo l'hash del destinatario, mai
//     il corpo, quindi il codice non finisce in `app_log`.)
//  3. NESSUN BOTTONE E NESSUN LINK CHE COMPLETI L'OPERAZIONE. È un antifurto
//     contro il phishing: chi riceve il codice deve tornare da sé nell'app. Se
//     l'email avesse un bottone «conferma qui», insegnerebbe alle famiglie
//     esattamente l'abitudine che un truffatore sfrutta.
//  4. LA VALIDITÀ SI DICHIARA IN MINUTI, mai «pochi minuti» — e il numero arriva
//     dal TTL vero, non scritto a mano: due copie dello stesso valore divergono,
//     e quando divergono vince quella sbagliata. (Prima `forms/send-otp` diceva
//     «pochi minuti» mentre il TTL era dieci.)
// =============================================================================

/**
 * Le operazioni per cui si chiede un codice. Completano la frase «Il tuo codice
 * per … è:», quindi sono all'infinito.
 *
 * `{ libera: string }` è il caso dei prestampati, dove l'etichetta del modulo la
 * sceglie la segreteria in Impostazioni: è un DATO, non un'enumerazione, e per
 * questo passa da `esc`. Perdere quale modulo si sta firmando sarebbe una
 * regressione vera per chi legge — «Il tuo codice per firmare il modulo» quando
 * i moduli aperti sono tre non aiuta nessuno.
 */
export type OperazioneOtp =
    | 'firmare la domanda d\'iscrizione'
    | 'firmare il modulo'
    | 'confermare la giustifica dell\'assenza'
    | 'confermare la presa visione della nota'
    | 'confermare la ricezione della pagella'
    | { libera: string }

export function descriviOperazione(op: OperazioneOtp): string {
    return typeof op === 'string' ? op : op.libera
}

export interface DatiCodiceVerifica {
    codice: string
    operazione: OperazioneOtp
    /** Minuti di validità. Viene dal TTL vero del sistema che ha generato il codice. */
    minuti: number
}

export const OGGETTO_CODICE_VERIFICA = 'Il tuo codice di verifica — Kidville'

export function messaggioCodiceVerifica(d: DatiCodiceVerifica, sede: ContestoSede): Messaggio {
    const op = descriviOperazione(d.operazione)
    const motivo = `Questo codice è stato richiesto dall'area riservata di ${sede.nome}.`

    const corpo = unisci([
        p(h`Il tuo codice per <strong>${esc(op)}</strong> è:`),
        riquadroCodice(d.codice),
        p(h`Il codice è valido per <strong>${esc(d.minuti)} minuti</strong>. Va inserito nell'app Kidville, nella schermata da cui è stato richiesto.`, { dimensione: 15 }),
        avviso('avviso', h`Se non hai richiesto tu questo codice, ignora questo messaggio e avvisa la segreteria di ${esc(sede.nome)}.`),
        nota(h`Nessuno di Kidville ti chiederà mai questo codice per telefono, per email o in chat.`),
    ])

    return {
        oggetto: OGGETTO_CODICE_VERIFICA,
        html: documento(sede, {
            oggetto: OGGETTO_CODICE_VERIFICA,
            // Il codice PRIMA di tutto: è la riga che si legge dalla notifica.
            preheader: `${d.codice} è il codice per ${op}. Scade tra ${d.minuti} minuti.`,
            tab: tabMascotte({ occhiello: 'Verifica', titolo: 'Codice di verifica', compatta: true }),
            corpo,
            motivo,
            // Nessun invito a cliccare in un'email che porta un codice: nemmeno
            // sul logo. È la stessa ragione del punto 3.
            logoCliccabile: false,
        }),
        testo: [
            intestazioneTesto('Il tuo codice di verifica', sede),
            '',
            `Il tuo codice per ${op} è:`,
            '',
            `      ${d.codice}`,
            '',
            `Il codice è valido per ${d.minuti} minuti. Va inserito nell'app Kidville, nella schermata da cui è stato richiesto.`,
            '',
            `Se non hai richiesto tu questo codice, ignora questo messaggio e avvisa la segreteria di ${sede.nome}.`,
            '',
            'Nessuno di Kidville ti chiederà mai questo codice per telefono, per email o in chat.',
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
