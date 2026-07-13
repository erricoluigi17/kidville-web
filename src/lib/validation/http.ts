import { NextResponse } from 'next/server';
import { z } from 'zod';
import { impostaPayload } from '@/lib/logging/context';

/**
 * Helper condivisi per la validazione zod delle route API (M3).
 *
 * Pattern d'uso (dopo il gate auth):
 *   const q = parseQuery(request, querySchema);
 *   if ('response' in q) return q.response;
 *   // q.data è tipizzato
 *
 * La risposta di errore è SEMPRE:
 *   400 { error: 'Dati non validi', details: [{ path, message }] }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ QUI DENTRO C'È IL LOGGING (Task 7)
 *
 * `withRoute` osserva l'esito di una richiesta ma NON ne legge il body: lo stream si
 * consuma una volta sola, e leggerlo lì romperebbe tutte le POST; clonarlo sarebbe peggio
 * ancora — sulle 12 route multipart significherebbe tenere in RAM una copia di uno ZIP o
 * di una foto da 20 MB per il gusto di loggarla. Ma senza il payload un log dice *che* una
 * richiesta è fallita, non *con quali dati*: cioè quasi niente.
 *
 * Il payload lo deposita quindi chi lo ha GIÀ letto, cioè questo modulo: zero letture in
 * più, zero cloni, e i dati sono già strutturati — che è la condizione perché la redazione
 * per chiave di `redact()` funzioni con precisione (su un blob di testo non funzionerebbe).
 * Copertura: `parseQuery` è usata da 173 route, `parseBody` da 124, `parseData` da 31.
 *
 * IL DEPOSITO AVVIENE PRIMA DELLA VALIDAZIONE, ed è il punto del task. Il payload che
 * interessa davvero è quello che zod ha RIFIUTATO: è il 400 che si va a diagnosticare
 * ("il client ha spedito un payload che il nostro stesso schema rifiuta" — e `withRoute`
 * lo manda in tabella proprio quando arriva da un utente autenticato, perché è un bug
 * NOSTRO). Depositando dopo la validazione, nei 400 il contesto sarebbe vuoto: si loggherebbe
 * il payload solo quando la richiesta è andata bene, cioè quando non serve a nessuno.
 *
 * Il valore si deposita GREZZO: è `impostaPayload` a redigerlo, e a farlo una volta sola.
 * Redigere qui sarebbe una doppia passata (`[redatto:str/40]` verrebbe redatto di nuovo, e
 * i marcatori sparirebbero) — vedi la nota su `ContestoRichiesta.payload`.
 *
 * Fuori da una richiesta (cron, boot, unit test) `impostaPayload` è un no-op: non lancia e
 * non alloca. La validazione non cambia comportamento in nessun caso.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type ParseResult<T> = { data: T } | { response: NextResponse };

export function validationError(
    issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
): NextResponse {
    return NextResponse.json(
        {
            error: 'Dati non validi',
            details: issues.map((i) => ({
                path: i.path.map(String).join('.'),
                message: i.message,
            })),
        },
        { status: 400 }
    );
}

/**
 * La validazione NUDA, senza deposito.
 *
 * Esiste perché `parseBody` e `parseQuery` delegavano a `parseData`: se continuassero a
 * farlo ORA, ogni body finirebbe nel contesto due volte — una sotto `body` e una sotto
 * `params` — bruciando uno dei quattro slot e mentendo su cosa fosse il payload.
 * Ogni porta d'ingresso deposita sotto la PROPRIA chiave, una volta sola.
 */
function valida<S extends z.ZodType>(schema: S, value: unknown): ParseResult<z.output<S>> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return { response: validationError(parsed.error.issues) };
    return { data: parsed.data };
}

/**
 * Valida un valore già estratto (params dinamici, campi multipart, body già letto).
 *
 * Slot `params`, e le chiamate successive nella stessa richiesta si SOVRASCRIVONO. Non è una
 * perdita: quando una route ne chiama più d'una (`/public/forms/[token]/upload` valida prima
 * il token e poi il file), quella che fallisce fa tornare subito la 400 — quindi l'ultima
 * depositata è sempre quella che ha causato l'errore, cioè l'unica che si vuole leggere.
 * Numerare gli slot (`params1`, `params2`…) esaurirebbe il cap di `impostaPayload` con i
 * payload che sono andati BENE.
 */
export function parseData<S extends z.ZodType>(
    schema: S,
    value: unknown
): ParseResult<z.output<S>> {
    impostaPayload('params', value);
    return valida(schema, value);
}

/**
 * Valida il body JSON della richiesta. JSON assente o malformato → 400.
 *
 * Sul body malformato non c'è un payload da depositare — ma il silenzio sarebbe ambiguo:
 * "questa richiesta non ha loggato il body" e "questa richiesta un body non ce l'aveva" si
 * leggerebbero uguali. Si deposita quindi un marcatore, sotto la chiave `esito` perché è
 * nella lista bianca di `redact` e sopravvive in chiaro anche nella riga persistita (una
 * stringa nuda, invece, uscirebbe come `[redatto:str/21]`: un log che non dice nulla).
 */
export async function parseBody<S extends z.ZodType>(
    request: Request,
    schema: S
): Promise<ParseResult<z.output<S>>> {
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        impostaPayload('body', { esito: 'body-json-malformato' });
        return {
            response: validationError([
                { path: [], message: 'Body JSON mancante o malformato' },
            ]),
        };
    }
    impostaPayload('body', raw);
    return valida(schema, raw);
}

/**
 * Valida i query param come oggetto piatto.
 * Chiavi ripetute (?id=a&id=b) diventano array di stringhe.
 */
export function parseQuery<S extends z.ZodType>(
    request: Request,
    schema: S
): ParseResult<z.output<S>> {
    const { searchParams } = new URL(request.url);
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(searchParams.keys())) {
        const values = searchParams.getAll(key);
        query[key] = values.length > 1 ? values : values[0];
    }
    impostaPayload('query', query);
    return valida(schema, query);
}
