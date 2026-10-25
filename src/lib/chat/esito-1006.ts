/**
 * IL 1006 CHE RIENTRA DA SOLO NON È UN GUASTO (robustezza 2, sessione 12 — S7).
 *
 * `socket closed: 1006` è la chiusura anomala del WebSocket: la rete del telefono che cambia, il
 * sistema che sospende la scheda, un proxy che taglia. realtime-js rientra da solo dopo 1, 2, 5, 10 s
 * e poi ogni 10 s, e quasi sempre ci riesce. Fino al 2026-10-20 ogni interruzione aperta da un 1006
 * scriveva SUBITO un `warn` `chat-realtime-errore: socket-chiuso-1006`: 544 in 7 giorni, mescolati
 * alle interruzioni vere.
 *
 * Adesso si aspetta l'esito. Se il canale rientra entro `FINESTRA_RIENTRO_1006_MS`, del 1006 resta la riga
 * di rientro (`chat-realtime-rientrato: …`, con il numero di errori), che `useConversazioneChat` già
 * scrive: è una riconnessione. Se allo scadere l'interruzione è ancora aperta e la pagina si vede, si
 * scrive il `warn` di prima: è un'interruzione vera. A pagina nascosta si riarma, perché lì il canale
 * chiuso è il sistema che risparmia, non un guasto che qualcuno vede.
 *
 * Gli altri motivi (anche `trasporto`) si loggano subito come prima: una decisione per volta.
 */
export const MOTIVO_1006 = 'socket-chiuso-1006';
// Una FINESTRA, non una scadenza: nessuna chiamata si interrompe quando passa, si decide solo se
// scrivere il `warn`. Per questo non si chiama `ATTESA_…` o `TETTO_…`: il lock `logging-tetto` conta
// quelle come tetti di una chiamata e le vuole entro il taglio di piattaforma (30 s).
export const FINESTRA_RIENTRO_1006_MS = 60_000;

export type DecisioneErroreCanale = 'subito' | 'aspetta-esito';

export function decidiLogErroreCanale(motivo: string): DecisioneErroreCanale {
    return motivo === MOTIVO_1006 ? 'aspetta-esito' : 'subito';
}

export type DecisioneScadenza1006 = 'nulla' | 'logga' | 'riarma';

export function decidiScadenza1006({
    interruzioneAperta,
    paginaVisibile,
}: {
    interruzioneAperta: boolean;
    paginaVisibile: boolean;
}): DecisioneScadenza1006 {
    if (!interruzioneAperta) return 'nulla';
    return paginaVisibile ? 'logga' : 'riarma';
}
