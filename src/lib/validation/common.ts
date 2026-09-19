import { z } from 'zod';
import { FORMA_DATA_ORA_LOCALE } from '@/lib/format/confini-giorno';

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

/**
 * Un'ora del giorno, `HH:MM` a 24 ore.
 *
 * ⚠️ NON è `/^\d{2}:\d{2}$/`, che è la regex che l'appello della primaria usava
 * (`primaria/appello/route.ts`) e che **accetta `99:99`**. Un'ora è un'ora: le ore
 * arrivano a 23 e i minuti a 59, e chi valida un orario del registro di un minore
 * non ha motivo di essere più permissivo del calendario.
 *
 * Sul filo passa questa forma, e non un ISO: è ciò che `<input type="time">`
 * produce, ed è l'unica che `@/lib/logging/redact` non lascia passare in chiaro —
 * un ISO matcha `DATA_ISO` e uscirebbe intero in `app_log`, cioè l'istante
 * d'arrivo di un bambino. La conversione in istante la fa il server
 * (`aOrarioIso`), dove il fuso è dichiarato e non dipende dall'orologio del tablet.
 */
export const zOraHHMM = z
    .string({ error: 'Orario mancante' })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Orario non valido (atteso HH:MM)');

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

/**
 * UNA DATA CON L'ORA, COME LA DIGITA UNA PERSONA IN ITALIA — `YYYY-MM-DDTHH:MM`.
 *
 * È esattamente ciò che `<input type="datetime-local">` mette nel `value`, e
 * nient'altro: niente secondi, niente `Z`, niente `+02:00`. Il nome dice la cosa
 * importante — è un'ora **locale**, cioè cifre su un orologio a muro italiano, non
 * un istante. L'istante lo compone il server con `istanteDaLocale`
 * (`@/lib/format/confini-giorno`).
 *
 * ── PERCHÉ NON SI ACCETTA UN ISO ────────────────────────────────────────────
 *
 * È la stessa decisione già presa per `zOraHHMM` qui sopra, e la prima delle due
 * ragioni vale identica:
 *
 * (a) **un ISO costruito dal browser porta con sé l'orologio E il fuso del
 *     tablet.** `new Date(...).toISOString()` su un tablet della segreteria
 *     configurato male — o semplicemente su un fuso diverso, cosa che capita
 *     quando un dispositivo torna da un aggiornamento con `America/Los_Angeles` —
 *     produce un istante che nessuno ha digitato. La conversione in istante la fa
 *     il SERVER, dove il fuso è dichiarato (`APP_TIMEZONE`) e provato
 *     (`__tests__/lib/confini-giorno.test.ts`). Qui sul filo passano le cifre che
 *     la persona ha visto, e la responsabilità di interpretarle sta in un posto
 *     solo.
 *
 * (b) la seconda ragione di `zOraHHMM` — «un ISO matcha `DATA_ISO` di
 *     `@/lib/logging/redact` e uscirebbe in chiaro in `app_log`» — ⚠️ **QUI NON
 *     DISCRIMINA, ed è stato verificato invece che ricopiato.** `DATA_ISO` è
 *     `/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/`:
 *     il gruppo dopo la data è OPZIONALE fino ai secondi, quindi `2026-06-01T18:00`
 *     la matcha esattamente come `2026-06-01T16:00:00.000Z`. Nessuna delle due
 *     forme viene redatta, e scrivere il contrario in questo commento sarebbe un
 *     file che dice il falso su sé stesso. La differenza vera è che qui **va bene
 *     così**: `redact.ts` lascia passare le date per tipo proprio per «istanti,
 *     scadenze, giorni», e la scadenza di un avviso è materiale della stessa
 *     famiglia di `creato_il` — non è il dato di un minore. Il caso di `zOraHHMM`
 *     era l'opposto (l'orario d'ARRIVO di un bambino), ed è per quello che lì la
 *     ragione (b) conta e qui no. Se un giorno questa forma finisse a descrivere
 *     una persona invece di un avviso, la difesa da aggiungere è sulla CHIAVE
 *     (come `RADICI_NASCITA`), non sul formato: `2019-05-03` e `2026-08-31` sono
 *     indistinguibili a guardare il valore.
 *
 * La parte DATA passa dallo stesso `.refine(dataCalendarioValida)` di `zDataYMD`:
 * la regex valida il formato, non il calendario, e `2026-02-30T10:00` la
 * supererebbe per finire in un 22008 → 500 — il difetto RC4, di nuovo.
 * L'ora è ancorata come in `zOraHHMM`: `([01]\d|2[0-3]):[0-5]\d`, non `\d{2}:\d{2}`
 * che accetta `99:99`. E il caso è PROVATO, non promesso:
 * `__tests__/validation/zdata-ymd.test.ts` rifiuta `99:99`, `24:00` e `23:60` uno
 * per uno — fino al 2026-09-19 questa frase era l'unica cosa che sosteneva
 * l'ancoraggio, e sostituire la regex con quella permissiva lasciava la suite
 * intera verde con numeri identici.
 *
 * ⚠️ LA FORMA NON È SCRITTA QUI. Arriva da `FORMA_DATA_ORA_LOCALE`
 * (`@/lib/format/confini-giorno`), che è lo stesso oggetto che `istanteDaLocale`
 * usa per DESTRUTTURARE la stringa. Le due regex sono state due per un po', e la
 * seconda era la versione permissiva di questa: la ragione per cui adesso è una
 * sola sta scritta accanto alla costante. Chi vuole cambiare la forma la cambia
 * là, e cambia i due posti insieme perché sono lo stesso posto.
 */
export const zDataOraLocale = z
    .string({ error: 'Data e ora mancanti' })
    .regex(FORMA_DATA_ORA_LOCALE, 'Data e ora non valide (atteso YYYY-MM-DDTHH:MM)')
    .refine((s) => dataCalendarioValida(s.slice(0, 10)), 'Data inesistente nel calendario');

/** Booleano tollerante per query param: 'true'/'1'/'si' → true, 'false'/'0'/'no' → false. */
export const zBool = z.preprocess((v) => {
    if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (['true', '1', 'si', 'sì'].includes(s)) return true;
        if (['false', '0', 'no'].includes(s)) return false;
    }
    return v;
}, z.boolean({ error: 'Valore booleano non valido' }));
