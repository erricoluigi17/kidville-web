import { z } from 'zod';

/**
 * Schemi zod riusabili tra le route API (M3).
 *
 * NB: zUuid usa z.guid() (formato 8-4-4-4-12) e NON z.uuid():
 * lo strict RFC 9562 rifiuterebbe gli ID seedati in dev
 * (cifre ripetute a variant non standard, es. 'aaaaaaaa-aaaa-…').
 */

/** Identificatore UUID/GUID nel formato 8-4-4-4-12. */
export const zUuid = z.guid({ error: 'Identificatore non valido (atteso UUID)' });

/**
 * Vero se `s` (già nel formato YYYY-MM-DD) è una data ESISTENTE nel calendario.
 * `Date.UTC` normalizza silenziosamente i valori fuori range (30/02 → 02/03,
 * mese 13 → gennaio dell'anno dopo): il round-trip lo smaschera confrontando i
 * componenti d'origine con quelli della data ricostruita. Anni bisestili inclusi.
 */
function dataCalendarioValida(s: string): boolean {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Data in formato YYYY-MM-DD ED esistente nel calendario.
 *
 * La sola regex validava il FORMATO, non il giorno: `2026-02-30`/`2026-13-99`
 * la superavano, arrivavano a Postgres e generavano un 22008 → 500 (RC4). Il
 * `.refine` chiude la falla nel validatore condiviso (cassa, attendance, mensa).
 */
export const zDataYMD = z
    .string({ error: 'Data mancante' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (atteso YYYY-MM-DD)')
    .refine(dataCalendarioValida, 'Data inesistente nel calendario');

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
