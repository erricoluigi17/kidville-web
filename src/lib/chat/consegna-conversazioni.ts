import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * QUANDO LA PAGINA CHAT CHIEDE LA CONSEGNA, E COME (robustezza 2, sessione 12 — S7).
 *
 * La consegna (`delivered_at`, la doppia spunta del mittente) la faceva la GET della lista a ogni
 * giro. Adesso è `POST /api/chat/threads/consegnati`, e parte solo quando serve: quando un thread
 * con non letti ha un'impronta diversa dalla lista precedente (più non letti, o un messaggio più
 * recente). Una lista uguale, o tutta letta, non consegna niente.
 */
export const URL_CONSEGNA = '/api/chat/threads/consegnati';

export interface ThreadConsegna {
    id: string;
    unread_count?: number | null;
    last_message_at?: string | null;
}

function impronta(t: ThreadConsegna): string {
    return `${t.unread_count ?? 0}|${t.last_message_at ?? ''}`;
}

function haNonLetti(t: ThreadConsegna): boolean {
    return typeof t.unread_count === 'number' && t.unread_count > 0;
}

/** L'impronta dei non letti di una lista, per confrontarla con la prossima. */
export function fotografiaNonLetti(lista: readonly ThreadConsegna[]): Map<string, string> {
    return new Map(lista.map((t) => [t.id, impronta(t)]));
}

export function serveConsegna(precedente: ReadonlyMap<string, string> | null, lista: readonly ThreadConsegna[]): boolean {
    return lista.some((t) => haNonLetti(t) && precedente?.get(t.id) !== impronta(t));
}

/**
 * La POST, con corpo vuoto: l'identità la decide il server dal gate. Non rifiuta mai.
 *
 * Una risposta non ok si dice con lo `stato`: il livello con cui lascia il dispositivo lo decide
 * `livelloEvento` di `@/lib/logging/client` (un 500 esce `error`, un 401 di sessione scaduta non esce
 * affatto). La rete giù si dice con la classe dell'errore, mai col messaggio.
 */
export function inviaConsegna(rotta: string): Promise<void> {
    return fetch(URL_CONSEGNA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    }).then(
        (res) => {
            if (res.ok) return;
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `chat-consegna-non-riuscita: http-${res.status}`,
                route: rotta,
                stato: res.status,
            });
        },
        (err: unknown) => {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `chat-consegna-non-riuscita: ${nomeErrore(err)}`,
                route: rotta,
            });
        },
    );
}
