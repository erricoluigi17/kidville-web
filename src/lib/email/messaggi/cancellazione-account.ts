import { esc, grezzo, h, unisci, type Html } from '../html'
import { documento, piedeTesto } from '../layout'
import { avviso, bottone, h1, linkDiScorta, p, riga, spazio, testo } from '../componenti'
import { BODY_FONT, KV, TITLE_FONT } from '../tema'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 09 · Conferma della richiesta di cancellazione dell'account.
//
// ─── BILINGUE, MA IN COLONNA SINGOLA ────────────────────────────────────────
// Italiano e inglese uno SOTTO l'altro, separati da un divisore e da
// un'etichetta di lingua. Mai due colonne affiancate: su un telefono sono
// illeggibili entrambe.
//
// ─── REGISTRO: NEUTRO-FORMALE ───────────────────────────────────────────────
// È un atto giuridico, non una comunicazione di servizio. La sobrietà è il
// messaggio: niente tab gialla, niente mascotte, niente calore.
//
// ─── E NESSUNA SEDE ─────────────────────────────────────────────────────────
// Questa email non nomina un plesso, e non è una dimenticanza: chi chiede la
// cancellazione sta ripudiando il rapporto, e affermare a quale scuola
// apparteneva non aggiunge niente. Il chiamante passa il contesto generico.
// =============================================================================

/** L'etichetta di lingua con la sua riga: rende evidente che sotto ricomincia. */
function etichettaLingua(tag: string): Html {
    return h`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;"><tr><td width="auto" style="font-family:${grezzo(BODY_FONT)};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${grezzo(KV.testo2)};padding-right:12px;white-space:nowrap;">${esc(tag)}</td><td style="font-size:0;line-height:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" style="height:1px;line-height:1px;font-size:0;background:${grezzo(KV.bordo)};">&nbsp;</td></tr></table></td></tr></table>`
}

export interface DatiCancellazioneAccount {
    /** Il link di conferma, già firmato dal chiamante. */
    urlConferma: string
    /** Validità del link in ore. Viene dal TTL vero, non scritto a mano. */
    oreValidita: number
}

export const OGGETTO_CANCELLAZIONE = 'Conferma la richiesta di cancellazione — Kidville'

export function messaggioCancellazioneAccount(d: DatiCancellazioneAccount, sede: ContestoSede): Messaggio {
    const motivo = 'Questo messaggio è stato inviato in risposta a una richiesta di cancellazione account.'
    const ore = d.oreValidita
    const oraOre = ore === 1 ? 'ora' : 'ore'
    const hourHours = ore === 1 ? 'hour' : 'hours'

    const corpo = unisci([
        etichettaLingua('Italiano'),
        h1('Conferma la cancellazione'),
        testo('È stata richiesta la cancellazione dell\'account Kidville associato a questo indirizzo. La richiesta si avvia solo dopo la conferma qui sotto.'),
        bottone(d.urlConferma, 'Confermo la cancellazione'),
        spazio(12),
        linkDiScorta(d.urlConferma, 'Oppure copia questo indirizzo nel browser:'),
        spazio(16),
        p(h`Il collegamento è valido <strong>${esc(ore)} ${esc(oraOre)}</strong>.`, { dimensione: 15 }),
        avviso('info', h`Se non hai richiesto tu la cancellazione, ignora questo messaggio: senza conferma non verrà avviata alcuna richiesta.`),
        riga(),
        etichettaLingua('English'),
        h`<h2 class="kv-h" style="margin:0 0 10px 0;font-family:${grezzo(TITLE_FONT)};font-size:22px;line-height:1.25;font-weight:800;color:${grezzo(KV.verde)};">Confirm account deletion</h2>`,
        testo('A request was made to delete the Kidville account linked to this address. The request starts only after the confirmation below.'),
        bottone(d.urlConferma, 'Confirm deletion'),
        spazio(12),
        linkDiScorta(d.urlConferma, 'Or copy this address into your browser:'),
        spazio(16),
        p(h`The link is valid for <strong>${esc(ore)} ${esc(hourHours)}</strong>.`, { dimensione: 15 }),
        avviso('info', h`If you did not request the deletion, please ignore this message: without confirmation no request will be started.`),
    ])

    return {
        oggetto: OGGETTO_CANCELLAZIONE,
        html: documento(sede, {
            oggetto: OGGETTO_CANCELLAZIONE,
            preheader: `Il collegamento di conferma vale ${ore} ${oraOre}. / The confirmation link is valid for ${ore} ${hourHours}.`,
            corpo,
            motivo,
            logoCliccabile: false,
        }),
        testo: [
            'CONFERMA LA CANCELLAZIONE — KIDVILLE',
            '',
            '[ITALIANO]',
            'È stata richiesta la cancellazione dell\'account Kidville associato a questo indirizzo. La richiesta si avvia solo dopo la conferma.',
            '',
            'Conferma la cancellazione:',
            d.urlConferma,
            '',
            `Il collegamento è valido ${ore} ${oraOre}.`,
            '',
            'Se non hai richiesto tu la cancellazione, ignora questo messaggio: senza conferma non verrà avviata alcuna richiesta.',
            '',
            '-----------------------------------------',
            '',
            '[ENGLISH]',
            'A request was made to delete the Kidville account linked to this address. The request starts only after confirmation.',
            '',
            'Confirm deletion:',
            d.urlConferma,
            '',
            `The link is valid for ${ore} ${hourHours}.`,
            '',
            'If you did not request the deletion, please ignore this message: without confirmation no request will be started.',
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
