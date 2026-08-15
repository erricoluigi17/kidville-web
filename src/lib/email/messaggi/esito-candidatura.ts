import { esc, h, unisci } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import { h1, p, testo } from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 08 · Esito negativo di una candidatura.
//
// È l'email più delicata del sistema: deve chiudere una porta senza sbatterla.
//
// ─── PERCHÉ È LA PIÙ SOBRIA DI TUTTE ────────────────────────────────────────
// Niente tab gialla, niente mascotte, niente bottone, niente icone. Cinque
// righe. Il rispetto, qui, si esprime togliendo: una mascotte che sorride sopra
// un rifiuto è una mancanza di misura, non un tocco di brand.
//
// ─── E PERCHÉ NON DÀ NESSUNA MOTIVAZIONE ────────────────────────────────────
// Quello che si dice in segreteria non è quello che si scrive alla persona. Il
// motivo del rifiuto non entra in questa email, e non entra nemmeno nell'audit:
// è già la regola della route che la manda, e questo modulo non riceve affatto
// il campo — non si può far uscire un dato che non si ha.
// =============================================================================

export interface DatiEsitoCandidatura {
    /** Nome della candidata. Può mancare: il saluto degrada. */
    nome?: string | null
}

export const OGGETTO_ESITO_CANDIDATURA = 'Esito della tua candidatura — Kidville'

export function messaggioEsitoCandidatura(d: DatiEsitoCandidatura, sede: ContestoSede): Messaggio {
    const motivo = `Ricevi questo messaggio perché hai inviato una candidatura a ${sede.nome}.`
    const saluto = d.nome ? `Gentile ${d.nome},` : 'Gentile candidata, gentile candidato,'

    const corpo = unisci([
        h1('Esito della candidatura'),
        testo(saluto),
        p(h`la ringraziamo per il tempo dedicato alla sua candidatura a ${esc(sede.nome)} e per averci fatto conoscere il suo percorso.`),
        testo('Per questa posizione la scelta è caduta su un altro profilo.'),
        testo('Con il suo consenso conserviamo il curriculum per le posizioni che si apriranno nei prossimi mesi: se ne avremo una adatta, la ricontatteremo noi.'),
        p(h`Un cordiale saluto,<br>La Segreteria di ${esc(sede.nome)}`),
    ])

    return {
        oggetto: OGGETTO_ESITO_CANDIDATURA,
        html: documento(sede, {
            oggetto: OGGETTO_ESITO_CANDIDATURA,
            preheader: `Una risposta sulla candidatura inviata a ${sede.nome}.`,
            corpo,
            motivo,
            // Nessun invito a tornare sul sito: non c'è niente da fare, ed è
            // esattamente il messaggio.
            logoCliccabile: false,
        }),
        testo: [
            intestazioneTesto('Esito della candidatura', sede),
            '',
            saluto,
            '',
            `la ringraziamo per il tempo dedicato alla sua candidatura a ${sede.nome} e per averci fatto conoscere il suo percorso.`,
            '',
            'Per questa posizione la scelta è caduta su un altro profilo.',
            '',
            'Con il suo consenso conserviamo il curriculum per le posizioni che si apriranno nei prossimi mesi: se ne avremo una adatta, la ricontatteremo noi.',
            '',
            'Un cordiale saluto,',
            `La Segreteria di ${sede.nome}`,
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
