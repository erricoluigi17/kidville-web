import type { NextResponse } from 'next/server'

import { rispostaVideo, statoHttpVideo } from '@/app/api/video-uploads/risposte'
import { mimeBase } from '@/lib/gallery/limiti'
import { logEvento } from '@/lib/logging/logger'
import { BLOCCO_LEGACY_VIDEO_ATTIVO } from '@/lib/media/interruttore-legacy-video'
import { codiceMessaggioVideo, type CodiceBordoVideo } from '@/lib/media/video/contratto'

/**
 * IL BLOCCO DEL PERCORSO VECCHIO DEI VIDEO — la decisione, in un posto solo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Le tre porte storiche (`gallery/upload`, `gallery/upload-url`, `news/upload`)
 * ricevono un filmato già compresso dal browser e lo archiviano come un file
 * qualsiasi. Quando la pipeline nuova sarà viva, quel file resterà lì senza che
 * nessuno lo converta: un video che una maestra crede caricato e che nessun
 * genitore vedrà mai. Perciò la porta si chiude, con un rifiuto che dice cosa
 * fare invece di limitarsi a dire di no.
 *
 * ⚠️ L'INTERRUTTORE NON STA QUI: sta in `./interruttore-legacy-video`, che
 * contiene quel valore e nient'altro. La separazione serve a poterlo sostituire
 * nei test — in ESM una funzione che chiamasse un export del proprio modulo non
 * vedrebbe mai il sostituto, e «da spento non cambia niente» resterebbe
 * indimostrato. Un interruttore che nessuno ha mai visto scattare non è un
 * interruttore.
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
 * nessuno ha provato a caricare: il giorno dell'accensione bisogna poter dire
 * quanti telefoni parlano ancora la lingua vecchia, altrimenti «non si è
 * lamentato nessuno» significherà insieme «hanno aggiornato tutti» e «non lo
 * sappiamo». Livello `warn` e non `error`: è il protocollo che funziona come
 * previsto, non un guasto — ma va visto.
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
 * Questo caricamento va fermato?
 *
 * Vero solo se l'interruttore è acceso **e** si sta caricando un video: le foto
 * non c'entrano niente con la pipeline video e devono continuare a passare dalla
 * stessa porta anche il giorno dell'accensione. Il controllo sul tipo sta QUI e
 * non nelle tre route, perché scritto tre volte sarebbe sbagliato in uno dei tre
 * entro un mese — ed è già successo, con lo stesso `split` a mano ribattuto in
 * tre punti.
 *
 * `mimeBase` e non un confronto diretto: `MediaRecorder` consegna
 * `video/mp4;codecs=avc1`, che è la forma che arriva davvero da un telefono. Il
 * 2026-09-08 un confronto per uguaglianza su quella stessa stringa ha respinto 33
 * caricamenti validi in un giorno, 8 insegnanti, 3 sedi.
 */
export function videoLegacyDaFermare(mime: string): boolean {
    return BLOCCO_LEGACY_VIDEO_ATTIVO && mimeBase(mime).startsWith('video/')
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
