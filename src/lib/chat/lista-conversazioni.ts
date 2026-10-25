import { nomeErrore } from '@/lib/logging/client';

/**
 * LA GET DELLA LISTA DELLE CONVERSAZIONI, COME ESITO (robustezza 2, sessione 12 — S7).
 *
 * Non rifiuta mai: restituisce la lista o il perché del guasto, come gettone (`http-<stato>`, la
 * classe dell'errore, `forma-inattesa`). Mai il `.message`: per una rete giù contiene l'URL con l'id.
 * Così chi la usa (`useConversazioneChat`) non ha bisogno di un `try`, e il compilatore di React non
 * ha un motivo per rinunciare al hook.
 *
 * `http` distingue chi ha risposto (il server, con il suo stato) da chi non ha risposto affatto
 * (`null`: rete, corpo illeggibile, forma inattesa). Il primo caso lo registra già il `fetch`
 * strumentato di `@/lib/logging/client`, con il livello di `livelloFetch`.
 *
 * L'URL è quello di prima, con `?userId=` che il server ignora: i test di pagina lo riconoscono così.
 */
export type EsitoListaConversazioni<T> = { lista: T[] } | { guasto: string; http: number | null };

export function scaricaListaConversazioni<T>(userId: string): Promise<EsitoListaConversazioni<T>> {
    return fetch(`/api/chat/threads?userId=${userId}`).then(
        (res): EsitoListaConversazioni<T> | Promise<EsitoListaConversazioni<T>> => {
            if (!res.ok) return { guasto: `http-${res.status}`, http: res.status };
            return res.json().then(
                (data: unknown): EsitoListaConversazioni<T> =>
                    Array.isArray(data) ? { lista: data as T[] } : { guasto: 'forma-inattesa', http: null },
                (err: unknown): EsitoListaConversazioni<T> => ({ guasto: nomeErrore(err), http: null }),
            );
        },
        (err: unknown): EsitoListaConversazioni<T> => ({ guasto: nomeErrore(err), http: null }),
    );
}
