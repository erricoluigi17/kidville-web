import type { SupabaseClient } from '@supabase/supabase-js';
import { logErrore, logEvento } from '@/lib/logging/logger';

/**
 * Consegna dei messaggi di chat: il terzo stato (fra "inviato" e "letto").
 *
 * `marcaConsegnati` valorizza `delivered_at = now()` sui messaggi RICEVUTI dall'utente
 * (`sender_id <> userId`) e non ancora consegnati (`delivered_at IS NULL`), per uno o più
 * thread oppure per un elenco di id.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * REGOLA FERREA — UPDATE SEPARATO, MAI unito al mark-read.
 *
 * Il DB E2E della CI NON è migrato: la colonna `delivered_at` non esiste. Un `update`
 * che scrivesse `read_at` E `delivered_at` insieme fallirebbe TUTTO con PGRST204, e con
 * lui sparirebbe anche il mark-read — cioè una feature nuova (la doppia spunta) romperebbe
 * una feature vecchia (i messaggi letti). Perciò la consegna è una query a sé: se la colonna
 * manca, questa fallisce da sola e il mark-read (chiamato separatamente) resta intatto.
 *
 * Il fallimento per colonna-assente NON è un errore: è degrado pulito, e si logga `info`.
 * PostgREST codifica la colonna mancante in due modi a seconda di dove la incontra —
 * `PGRST204` sul payload dell'UPDATE, `42703` sul filtro — e vanno gestiti entrambi.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Best-effort: non lancia mai (il chiamante è una route che ha già fatto il suo lavoro
 * vero), e su errore reale logga senza propagare. Non mette MAI dati personali nei log:
 * solo uuid, conteggi ed esiti.
 */

/**
 * Codici emessi quando `delivered_at` non esiste ancora (CI non migrata):
 *  · PGRST204 → il payload dell'UPDATE cita una colonna che PostgREST non trova;
 *  · 42703    → il filtro `is('delivered_at', null)` colpisce una colonna inesistente.
 */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703']);

interface MarcaConsegnatiParams {
    /** L'utente che sta ricevendo (i suoi messaggi in USCITA non vanno mai marcati). */
    userId: string;
    /** Consegna tutti i messaggi ricevuti in questi thread. */
    threadIds?: string[];
    /** Consegna questi id specifici (usato dopo il mark-read sugli stessi id). */
    messageIds?: string[];
}

export async function marcaConsegnati(
    supabase: SupabaseClient,
    { userId, threadIds, messageIds }: MarcaConsegnatiParams,
): Promise<void> {
    const perId = Array.isArray(messageIds) && messageIds.length > 0;
    const perThread = Array.isArray(threadIds) && threadIds.length > 0;

    // Nessun bersaglio → nessuna query (niente scritture a vuoto sul DB di produzione).
    if (!perId && !perThread) return;

    let query = supabase
        .from('chat_messages')
        .update({ delivered_at: new Date().toISOString() })
        .neq('sender_id', userId)
        .is('delivered_at', null);

    // `messageIds` ha la precedenza: è il caso "dopo il read, consegna gli stessi id".
    query = perId ? query.in('id', messageIds as string[]) : query.in('thread_id', threadIds as string[]);

    // PostgREST NON lancia: ritorna `{ error }`. Un try/catch qui non scatterebbe mai —
    // si controlla SEMPRE il valore di ritorno.
    const { error } = await query;

    if (!error) return;

    if (error.code && COLONNA_ASSENTE.has(error.code)) {
        // DB non migrato (E2E della CI): degrado pulito, non un guasto. `info` → non persistito.
        // Nessun PII: solo l'operazione e l'esito.
        logEvento('db', 'info', {
            operazione: 'chat/delivered:marcaConsegnati',
            esito: 'colonna-delivered_at-assente',
        });
        return;
    }

    // Errore vero: si logga (senza propagare — la consegna è accessoria alla risposta).
    logErrore({ operazione: 'chat/delivered:marcaConsegnati', evento: 'db' }, error);
}
