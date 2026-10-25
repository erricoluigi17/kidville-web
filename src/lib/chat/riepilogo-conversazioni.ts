import { logEvento } from '@/lib/logging/logger';

/**
 * LA RISPOSTA DI `chat_riepilogo_conversazioni`, DECISA IN UN POSTO (robustezza 2, sessione 12 — S7).
 *
 * La RPC la chiama la route (`chat/threads:GET`), non questo modulo: il lock d'isolamento attribuisce
 * ogni `.rpc(` all'handler in cui sta scritta, e una chiamata nascosta qui finirebbe fuori dalla sua
 * vista. Qui si decide soltanto che cosa vuol dire la risposta:
 *
 *  · `ok`      — una lista di righe con `id`: la forma che la route restituisce al client;
 *  · `assente` — la funzione non c'è (`PGRST202` dalla schema cache di PostgREST, `42883` da Postgres):
 *                è il DB della CI, che non è migrato, o i minuti fra il merge e la ricarica della
 *                cache. Riga `info`, e la route torna al percorso di prima;
 *  · `guasto`  — qualunque altro errore, o una risposta di forma inattesa. Riga `error`, e la route
 *                torna lo stesso al percorso di prima: la lista delle conversazioni non si svuota
 *                per colpa del riepilogo.
 *
 * Insieme locale, sul modello di `RPC_ASSENTE` (`src/app/api/avvisi/[id]/risposte/route.ts:71`), come
 * chiede la §5 della specifica: `src/lib/db/tolleranza-schema.ts` non si allarga. `PGRST203` (due
 * funzioni con lo stesso nome) NON è «assente»: è uno schema rotto, ed esce come guasto.
 *
 * Nei log solo il codice (`error_code`, che la redazione lascia passare): mai il messaggio.
 */
export const RPC_RIEPILOGO_ASSENTE: ReadonlySet<string> = new Set(['PGRST202', '42883']);

export type RigaRiepilogo = Record<string, unknown> & { id: string };

export type EsitoRiepilogo = { esito: 'ok'; threads: RigaRiepilogo[] } | { esito: 'assente' } | { esito: 'guasto' };

function codiceDi(error: unknown): string {
    const codice = (error as { code?: unknown } | null)?.code;
    return typeof codice === 'string' && codice !== '' ? codice : 'sconosciuto';
}

function eUnaRiga(valore: unknown): valore is RigaRiepilogo {
    return typeof valore === 'object' && valore !== null && typeof (valore as { id?: unknown }).id === 'string';
}

export function esitoRiepilogo(risposta: { data: unknown; error: unknown }, operazione: string): EsitoRiepilogo {
    if (risposta.error) {
        const codice = codiceDi(risposta.error);
        if (RPC_RIEPILOGO_ASSENTE.has(codice)) {
            logEvento('chat', 'info', { operazione, esito: 'riepilogo-non-installato', error_code: codice, ripiego: true });
            return { esito: 'assente' };
        }
        logEvento('chat', 'error', { operazione, esito: 'riepilogo-rpc-fallito', error_code: codice, ripiego: true }, risposta.error);
        return { esito: 'guasto' };
    }
    if (!Array.isArray(risposta.data) || !risposta.data.every(eUnaRiga)) {
        logEvento('chat', 'error', { operazione, esito: 'riepilogo-forma-inattesa', ripiego: true });
        return { esito: 'guasto' };
    }
    return { esito: 'ok', threads: risposta.data };
}
