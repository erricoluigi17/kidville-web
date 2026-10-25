/**
 * UN SOLO GIRO DI DISPATCH ANTICIPATO PER CONVERSAZIONE, PER FINESTRA (robustezza 2, sessione 12 — S7).
 *
 * Ogni messaggio della chat programmava con `after()` un giro di `eseguiDispatch` 30 s dopo. In una
 * raffica di tre messaggi in dieci secondi partivano tre giri, e dalla fase 8 i due in più si fermano
 * sì («superfluo»), ma solo DOPO aver letto la coda. Qui il secondo messaggio non programma niente:
 * la sua notifica (una sola per conversazione, per il `debounce`) la spedisce il giro già in attesa.
 *
 * LA FINESTRA SI CHIUDE PRIMA DI LEGGERE LA CODA, non alla fine del giro (`chiudiFinestraDispatch`
 * in `chat/messages:POST`). Un messaggio che arriva mentre il giro sta già lavorando programma il suo:
 * nessuna notifica resta senza giro, e nessuna parte più tardi di prima.
 *
 * Per ISTANZA della funzione: una mappa in memoria. Fra istanze diverse si resta come prima, e la presa
 * atomica di `eseguiDispatch` impedisce il doppione. Una finestra condivisa vorrebbe una tabella, cioè
 * il carico che questa sessione toglie.
 *
 * Scade da sola dopo l'attesa più `MARGINE_FINESTRA_MS`: se `after()` non arriva in fondo (istanza
 * fermata, eccezione nel timer), il messaggio dopo non resta senza giro per sempre. Le finestre
 * scadute si tolgono a ogni apertura, di qualunque conversazione: la mappa non cresce senza limite.
 */
export const MARGINE_FINESTRA_MS = 15_000;

const finestre = new Map<string, { gettone: number; scade: number }>();
let ultimoGettone = 0;

/** Apre la finestra della conversazione e restituisce il gettone, o `null` se ce n'è già una aperta. */
export function apriFinestraDispatch(threadId: string, attesaMs: number, ora: number = Date.now()): number | null {
    for (const [id, finestra] of finestre) {
        if (finestra.scade <= ora) finestre.delete(id);
    }
    if (finestre.has(threadId)) return null;
    const gettone = ++ultimoGettone;
    finestre.set(threadId, { gettone, scade: ora + attesaMs + MARGINE_FINESTRA_MS });
    return gettone;
}

/** Chiude la finestra, solo se è ancora quella del gettone (non quella aperta da un giro dopo). */
export function chiudiFinestraDispatch(threadId: string, gettone: number): void {
    if (finestre.get(threadId)?.gettone === gettone) finestre.delete(threadId);
}

/** Per i test: quante finestre tiene la mappa, scadute comprese finché nessuno le ha tolte. */
export function finestreDispatchAperte(): number {
    return finestre.size;
}

/** Per i test: come un'istanza nuova. */
export function azzeraFinestreDispatch(): void {
    finestre.clear();
}
