import type { NextResponse } from 'next/server'

import { rispostaVideo, statoHttpVideo } from '@/app/api/video-uploads/risposte'
import { mimeBase } from '@/lib/gallery/limiti'
import { logEvento } from '@/lib/logging/logger'
import { codiceMessaggioVideo, type CodiceBordoVideo } from '@/lib/media/video/contratto'

/**
 * IL BLOCCO DEL PERCORSO VECCHIO DEI VIDEO — la decisione, in un posto solo, e senza interruttore.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Le tre porte storiche (`gallery/upload`, `gallery/upload-url`, `news/upload`)
 * ricevevano un filmato già compresso dal browser e lo archiviavano come un file
 * qualsiasi. Con la pipeline nuova quel file resterebbe lì senza che nessuno lo
 * converta e lo pubblichi: un video che una maestra crede caricato e che nessun
 * genitore vedrà mai. Perciò le tre porte rifiutano OGNI `video/*`, con un 409 che
 * dice cosa fare — aggiornare l'app o ricaricare la pagina — invece di limitarsi a
 * dire di no. I video passano solo da `POST /api/video-uploads`.
 *
 * ⚠️ NON C'È PIÙ UN INTERRUTTORE, ed è una scelta. Fino al 2026-10-02 il rifiuto
 * stava dietro una costante spenta, in un file suo di una riga: si scriveva
 * presto e si sarebbe acceso il giorno in cui la pipeline nuova fosse stata in
 * aria, perché chiuderlo prima avrebbe lasciato maestre e genitori senza nessun
 * modo di caricare un video. Quel giorno è questo: la pipeline gira, e un blocco
 * che si può spegnere è un blocco che qualcuno spegne per sbaglio — e con lui
 * si riapre la strada da cui un video entra in archivio e non esce più. Che qui
 * non ci sia una condizione, e che nessuna delle tre porte si sottragga, lo
 * misura `__tests__/architecture/blocco-legacy-video.test.ts`; che il rifiuto
 * scatti davvero su tutte e tre lo dimostra `__tests__/api/video-legacy-blocco.test.ts`.
 *
 * ⚠️ NIENTE SNIFF DEL CONTENUTO. Il rifiuto guarda il tipo dichiarato e basta:
 * un video H.264 «buono» e un HEVC ricevono la stessa risposta. Il vecchio
 * controllo sui primi 64 KB (lo sniff del codec) era una difesa in profondità contro
 * un HEVC sfuggito alla conversione del browser; ora il browser non converte più
 * niente, ogni video lo sonda e lo converte la pipeline nuova, e tenere quel
 * controllo avrebbe voluto dire un secondo posto in cui decidere cosa è un video
 * «buono».
 *
 * ─── PERCHÉ NÉ IL NUMERO NÉ LA FRASE SONO SCRITTI IN QUESTO FILE ────────────
 * `CLIENT_UPDATE_REQUIRED` è un codice DI BORDO già dichiarato nel contratto
 * (`@/lib/media/video/contratto`), il **409** lo decide `STATO_HTTP_VIDEO` e la
 * frase la decide `MAPPA_MESSAGGIO_VIDEO` insieme ai due cataloghi. Qui si nomina
 * solo il codice: se un giorno quel rifiuto cambiasse numero o parole,
 * cambierebbe in un posto solo e queste tre porte seguirebbero. Riscriverli a
 * mano vorrebbe dire due 409 che fra un mese sono un 409 e un 403, con due frasi
 * diverse — ed è per evitarlo che `src/app/api/video-uploads/risposte.ts` esiste.
 *
 * ⚠️ IL LOG NON È UN DI PIÙ. Un rifiuto muto è indistinguibile dal caso in cui
 * nessuno ha provato a caricare: bisogna poter dire quanti telefoni parlano
 * ancora la lingua vecchia, altrimenti «non si è lamentato nessuno» significherà
 * insieme «hanno aggiornato tutti» e «non lo sappiamo». È anche la misura che dirà
 * quando le tre porte si potranno smontare del tutto. Livello `warn` e non
 * `error`: è il protocollo che funziona come previsto, non un guasto — ma va
 * visto.
 *
 * ⚠️ MAI IL NOME DEL FILE. Un video di galleria si chiama `recita-di-mario.mp4`:
 * è anagrafica di un minore, e in `app_log` resterebbe trenta giorni,
 * interrogabile in SQL. Passano solo il tipo e la dimensione, che sono ciò che
 * serve per contare.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Il codice interno del rifiuto: uno solo, e viene dal contratto. */
const CODICE_LEGACY: CodiceBordoVideo = 'CLIENT_UPDATE_REQUIRED'

/**
 * Questo caricamento è un video, cioè va fermato?
 *
 * Vero per ogni `video/*`, senza altre condizioni: le foto non c'entrano niente
 * con la pipeline video e devono continuare a passare dalle stesse porte. Il
 * controllo sul tipo sta QUI e non nelle tre route, perché scritto tre volte
 * sarebbe sbagliato in uno dei tre entro un mese — ed è già successo, con lo
 * stesso `split` a mano ribattuto in tre punti.
 *
 * `mimeBase` e non un confronto diretto: un telefono può consegnare
 * `video/mp4;codecs=avc1`, e una porta che confrontasse per uguaglianza lascerebbe
 * passare (o, all'opposto, respingerebbe con la frase sbagliata) proprio la forma
 * che arriva davvero. Il 2026-09-08 un confronto per uguaglianza su quella stessa
 * stringa ha respinto 33 caricamenti validi in un giorno, 8 insegnanti, 3 sedi.
 */
export function eVideoLegacy(mime: string): boolean {
    return mimeBase(mime).startsWith('video/')
}

/**
 * Il rifiuto: una riga di log, e la risposta che il contratto già descrive.
 *
 * `gruppo` è il gruppo di `app_log` (`galleria` o `news`) e `operazione` è il
 * nome della route, lo stesso che usa `withRoute`: senza, in tabella non si
 * distinguerebbe quale delle tre porte ha rifiutato — e sono tre client diversi,
 * con tre tempi di aggiornamento diversi.
 */
export function rifiutoLegacyVideo(
    gruppo: 'galleria' | 'news',
    operazione: string,
    mime: string,
    size: number,
): NextResponse {
    logEvento(gruppo, 'warn', {
        operazione,
        esito: 'legacy-video-bloccato',
        mime: mimeBase(mime),
        size,
        error_code: CODICE_LEGACY,
    })
    return rispostaVideo(codiceMessaggioVideo(CODICE_LEGACY), statoHttpVideo(CODICE_LEGACY))
}
