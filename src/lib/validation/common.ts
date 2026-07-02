import { z } from 'zod';

/**
 * Schemi zod riusabili tra le route API (M3).
 *
 * NB: zUuid usa z.guid() (formato 8-4-4-4-12) e NON z.uuid():
 * lo strict RFC 9562 rifiuterebbe gli ID seedati in dev
 * (es. '33333333-3333-3333-3333-333333333333', variant non standard).
 */

/** Identificatore UUID/GUID nel formato 8-4-4-4-12. */
export const zUuid = z.guid({ error: 'Identificatore non valido (atteso UUID)' });

/** Data in formato YYYY-MM-DD. */
export const zDataYMD = z
    .string({ error: 'Data mancante' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (atteso YYYY-MM-DD)');

/** Mese in formato YYYY-MM. */
export const zAnnoMese = z
    .string({ error: 'Mese mancante' })
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mese non valido (atteso YYYY-MM)');

/** Paginazione standard: limit 1-200 (default 50), offset ≥ 0 (default 0). */
export const zPaginazione = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

/** Booleano tollerante per query param: 'true'/'1'/'si' → true, 'false'/'0'/'no' → false. */
export const zBool = z.preprocess((v) => {
    if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (['true', '1', 'si', 'sì'].includes(s)) return true;
        if (['false', '0', 'no'].includes(s)) return false;
    }
    return v;
}, z.boolean({ error: 'Valore booleano non valido' }));
