/**
 * LO STATO DI UNA CONVERSAZIONE DELLA CHAT — le regole, senza React.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-14 le due pagine gemelle (`parent/chat`, `teacher/chat`, ~700 righe
 * ciascuna) tenevano la stessa logica di unione dei messaggi scritta due volte, e le due copie
 * avevano già preso strade diverse. Il titolare ha segnalato che chi invia un messaggio lo vede
 * due volte e che a volte i messaggi nuovi non compaiono: le cause stavano proprio in quelle
 * righe duplicate.
 *
 * Qui la regola sta UNA volta, ed è PURA: niente React, niente `fetch`, niente `window`. Si
 * prova con dati e basta (`__tests__/lib/chat/stato-conversazione.test.ts`).
 */

export interface ChatMessage {
    id: string;
    thread_id: string;
    sender_id: string;
    content: string;
    attachment_url: string | null;
    attachment_type: string | null;
    read_at: string | null;
    /** Consegnato (scaricato dal destinatario). OPZIONALE: il payload E2E non lo ha
     *  finché il DB della CI non è migrato — l'assenza degrada a "solo inviato". */
    delivered_at?: string | null;
    created_at: string;
}

/**
 * L'allegato si mostra solo quando è un indirizzo che il browser può aprire.
 *
 * Da S32 (2026-08-01) in `chat_messages.attachment_url` c'è il PERCORSO nel
 * bucket privato, non più un link firmato a 365 giorni: le route lo firmano al
 * momento della lettura, ma il Realtime di Supabase consegna la riga del
 * database così com'è e per qualche istante la bolla ha in mano un percorso.
 * Un percorso dentro un `<img src>` è un'immagine rotta, e «la chat è rotta» è
 * la conclusione sbagliata che se ne trae: meglio niente, finché il ricarico
 * non porta il link firmato.
 *
 * Vale anche come rete di sicurezza sugli schemi non-http (`javascript:`), che
 * era già la regola per i documenti e non lo era per le immagini.
 *
 * Vive qui dal 2026-09-14 (prima in `ChatMessageArea.tsx`, che la riesporta): la usa anche
 * l'unione dei messaggi, per non far vincere un percorso grezzo su un link firmato.
 */
export function allegatoMostrabile(url: string | null | undefined): boolean {
    return !!url && /^https?:\/\//i.test(url);
}
