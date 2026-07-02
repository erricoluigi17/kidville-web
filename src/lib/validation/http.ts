import { NextResponse } from 'next/server';
import { z } from 'zod';

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
 * Valida un valore già estratto (params dinamici, campi multipart, body già letto).
 */
export function parseData<S extends z.ZodType>(
    schema: S,
    value: unknown
): ParseResult<z.output<S>> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return { response: validationError(parsed.error.issues) };
    return { data: parsed.data };
}

/**
 * Valida il body JSON della richiesta. JSON assente o malformato → 400.
 */
export async function parseBody<S extends z.ZodType>(
    request: Request,
    schema: S
): Promise<ParseResult<z.output<S>>> {
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return {
            response: validationError([
                { path: [], message: 'Body JSON mancante o malformato' },
            ]),
        };
    }
    return parseData(schema, raw);
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
    return parseData(schema, query);
}
