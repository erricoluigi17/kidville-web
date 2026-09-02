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

/**
 * IL TETTO DI UN ELENCO — un intero, un minimo, un massimo, e un 400 se non torna.
 *
 * ─── PERCHÉ ESISTE (rilievi Q18 e Q20, quarto collaudo) ─────────────────────
 *
 * `parent/primaria/assenze` faceva `parseInt(q.data.limit ?? '60', 10)` senza clamp, e il
 * valore finiva tale e quale in `.limit()` di postgrest-js, che lo scrive nella query string.
 * Misurato: `?limit=-1` → Range non soddisfacibile (**416**), risposta **200 con
 * `letto:false`** (cioè «non ho potuto leggere» detto per un errore del client) e **due righe
 * `error` in `app_log` per ogni richiesta**. Cinque richieste bastavano a far dichiarare
 * `degradato` `/api/health` — `SOGLIA_IMPRONTE_ERRORE` è 5 impronte distinte in 15 minuti, e
 * l'impronta include l'utente. Un errore del CLIENT diventava un guasto del SERVER.
 *
 * La stessa forma, cercata e trovata, in `admin/primaria/fascicolo-audit`:
 * `Math.min(limit ?? 100, 500)` è un tetto senza pavimento, e lì il ramo d'errore risponde
 * 500 rimandando al chiamante il `message` di PostgREST.
 *
 * ─── PERCHÉ UNA FUNZIONE E NON DUE RIGHE COPIATE ────────────────────────────
 *
 * Perché la regola era già scritta quattro volte nel repo, con quattro sfumature diverse
 * (`gallery`, `admin/students`, `admin/audit`, `news/feed`), e le due rotte rimaste indietro
 * sono rimaste indietro proprio per questo: non c'era niente da riusare, solo qualcosa da
 * ricordare. `zPaginazione` non andava bene per nessuna delle due — cambierebbe il default
 * storico (50 invece di 60/100) e imporrebbe un `offset` che quelle rotte non hanno.
 *
 * ⚠️ RIFIUTA, non clampa. Un clamp silenzioso fa credere al client di aver chiesto ciò che
 * non ha ottenuto; il 400 «Dati non validi» dice dov'è lo sbaglio, e — cosa che il clamp non
 * fa — lascia il ramo `letto:false`/`error` riservato ai guasti VERI del database.
 */
export function zLimite({ predefinito, max }: { predefinito: number; max: number }) {
    return z.coerce
        .number({ error: 'Limite non valido' })
        .int('Il limite deve essere un numero intero')
        .min(1, 'Il limite deve essere almeno 1')
        .max(max, `Il limite non può superare ${max}`)
        .default(predefinito);
}

/**
 * '' / null / assente → `undefined`, poi lo schema dato.
 *
 * ⚠️ Serve perché i moduli e le barre filtri mandano STRINGHE VUOTE, non campi
 * assenti: un `<select>` a «Tutti» vale `''`, e un `.optional()` da solo lo
 * farebbe arrivare allo schema che lo rifiuta (o, peggio, a PostgREST come
 * filtro `= ''`). Era scritto — identico — in `admin/protocolli/route.ts` e in
 * `admin/protocolli/rettifica/route.ts`: due copie della stessa riga, che è il
 * modo in cui una convenzione diventa una consuetudine e poi diverge.
 */
export const zOpzionale = <S extends z.ZodType>(schema: S) =>
    z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

/**
 * Il testo di una barra di ricerca: facoltativo, con un tetto.
 *
 * Il tetto non è un capriccio: quel testo finisce dentro un `ilike` di PostgREST
 * e viaggia nella query string. Duecento caratteri sono più di qualunque ricerca
 * vera; senza tetto, un incolla accidentale di mezza pagina diventa una query
 * che il database esegue davvero.
 * Va sempre usato insieme a `termineOr()` (`@/lib/db/ricerca-postgrest`), che
 * toglie i metacaratteri di `.or()`: questo schema misura la LUNGHEZZA, quello
 * la SINTASSI, e servono tutti e due.
 */
export const zTestoRicerca = zOpzionale(z.string().max(200, 'Testo di ricerca troppo lungo'));

/**
 * I due estremi di un periodo, nominati `<chiave>Da` e `<chiave>A` — gli stessi
 * nomi che la barra filtri scrive nell'indirizzo (`motore.ts` → `versoUrl`), così
 * che il parametro dell'URL, quello della richiesta e quello dello schema siano
 * la stessa parola. Entrambi facoltativi ed entrambi validati sul CALENDARIO
 * (`zDataYMD`: `2026-02-30` non passa).
 *
 * Si spande dentro lo schema della query:
 * ```ts
 * const querySchema = z.object({ ...zPeriodo('data').shape, q: zTestoRicerca })
 * ```
 * Gli estremi sono INCLUSIVI, come nel motore dei filtri: chi costruisce la
 * query ci mette `.gte(da)` e `.lte(a)`, mai `.lt()`.
 */
export function zPeriodo<C extends string>(chiave: C) {
    const estremo = zOpzionale(zDataYMD);
    return z.object({
        [`${chiave}Da`]: estremo,
        [`${chiave}A`]: estremo,
    } as Record<`${C}Da` | `${C}A`, typeof estremo>);
}

/** Booleano tollerante per query param: 'true'/'1'/'si' → true, 'false'/'0'/'no' → false. */
export const zBool = z.preprocess((v) => {
    if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (['true', '1', 'si', 'sì'].includes(s)) return true;
        if (['false', '0', 'no'].includes(s)) return false;
    }
    return v;
}, z.boolean({ error: 'Valore booleano non valido' }));
