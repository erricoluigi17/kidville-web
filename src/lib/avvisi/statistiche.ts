import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';

// =============================================================================
// Statistiche e autori degli avvisi — IN BLOCCO, mai una query per avviso.
//
// PERCHÉ ESISTE QUESTO MODULO (T11-F2, misurato il 2026-08-03).
//
// `GET /api/avvisi` chiamava `autoreEStats(supabase, avviso)` dentro un `.map()`:
// tre `count` su `avvisi_risposte` più una `maybeSingle()` su `utenti`, cioè
// QUATTRO query per ogni avviso. Il ramo genitore ne aggiungeva una quinta (le
// proprie risposte). Il `Promise.all` esterno le mandava in parallelo, il che
// nasconde il problema a chi guarda il cronometro con dieci avvisi in tabella e
// lo rende un incidente quando saranno duecento: 1000 round-trip verso Postgres
// per una schermata, e un pool di connessioni che si esaurisce.
//
// Qui il numero di query non dipende più da quanti avvisi ci sono: una per
// blocco di 100 avvisi (più le pagine, se le righe superano il tetto del
// server), una per blocco di 100 autori.
//
// IL CONTEGGIO RESTA ESATTO, E QUESTA È LA PARTE CHE NON SI PUÒ SBAGLIARE.
// L'aggregazione avviene in memoria a partire dalle righe lette, quindi una
// lettura TRONCATA produrrebbe numeri più bassi del vero senza nessun segnale —
// e «hanno letto in 3» invece di «in 47» è peggio di un errore, perché sembra un
// dato. PostgREST tronca eccome: su Supabase `db-max-rows` vale 1000 di default.
// Per questo ogni pagina chiede anche `count: 'exact'` (il totale VERO lato
// server, indipendente dal troncamento) e si avanza di `data.length` — non del
// numero richiesto — finché non si è letto tutto. Se il tetto di pagine viene
// raggiunto prima, si logga `error`: il numero incompleto si dichiara, non si
// stampa e basta.
// =============================================================================

export type StatsAvviso = { letti: number; adesioni_si: number; adesioni_no: number };

export type AutoreAvviso = { first_name: string; last_name: string; role: string };

/** Autore non risolto: stessa forma che la route restituiva prima, invariata. */
export const AUTORE_IGNOTO: AutoreAvviso = { first_name: '?', last_name: '?', role: 'unknown' };

/** Statistiche a zero: un avviso senza nemmeno una risposta è il caso normale. */
export const STATS_ZERO: StatsAvviso = { letti: 0, adesioni_si: 0, adesioni_no: 0 };

/**
 * Quanti id entrano in un solo `.in(...)`.
 *
 * PostgREST li mette in QUERY STRING: 100 uuid sono ~3.800 caratteri, che stanno
 * comodi sotto il limite di riga di qualunque proxy. Con 1000 si arriverebbe a
 * ~38 kB e la richiesta verrebbe rifiutata con un 414 — cioè il tetto qui non è
 * cosmetico, è ciò che impedisce alla correzione di rompersi da sola quando gli
 * avvisi cresceranno.
 */
export const AVVISI_PER_QUERY = 100;

/**
 * Righe chieste per pagina. Coincide col `db-max-rows` di default di Supabase:
 * chiederne di più non ne restituirebbe di più, chiederne di meno moltiplicherebbe
 * i round-trip. Se il server dovesse restituirne meno (tetto più basso) il ciclo
 * si adatta da solo, perché avanza di quante ne ha RICEVUTE.
 */
export const RIGHE_PER_PAGINA = 1000;

/**
 * Tetto ASSOLUTO di pagine per blocco: 20 × 1000 = 20.000 risposte per 100
 * avvisi. Misurato in produzione il 2026-08-03: `avvisi_risposte` ha 45 righe in
 * tutto, quindi il tetto è a tre ordini di grandezza dal caso reale. Non è lì per
 * il presente: è lì perché un ciclo che pagina senza fine, il giorno in cui il
 * `count` mentisse, bloccherebbe la richiesta invece di rispondere.
 */
export const MAX_PAGINE = 20;

/** Divide un elenco in blocchi di dimensione fissa (l'ultimo può essere più corto). */
export function aBlocchi<T>(elementi: readonly T[], dimensione: number): T[][] {
    if (dimensione < 1) return elementi.length > 0 ? [[...elementi]] : [];
    const blocchi: T[][] = [];
    for (let i = 0; i < elementi.length; i += dimensione) {
        blocchi.push(elementi.slice(i, i + dimensione));
    }
    return blocchi;
}

/** Riga di `avvisi_risposte` nella proiezione MINIMA usata per aggregare. */
type RigaRisposta = { avviso_id?: unknown; letto_il?: unknown; risposta?: unknown };

/**
 * Aggregazione PURA di righe già lette → statistiche per avviso.
 *
 * È separata dall'accesso al database di proposito: è la parte che può sbagliare
 * i conti, ed è l'unica che si può provare senza finti client.
 */
export function aggregaStatistiche(
    avvisoIds: readonly string[],
    righe: readonly RigaRisposta[],
): Map<string, StatsAvviso> {
    const out = new Map<string, StatsAvviso>();
    for (const id of avvisoIds) out.set(id, { ...STATS_ZERO });
    for (const r of righe) {
        if (typeof r.avviso_id !== 'string') continue;
        const s = out.get(r.avviso_id);
        // Una riga di un avviso NON richiesto non entra nei conti di nessun altro:
        // sommarla al primo avviso o crearne una voce spuria falserebbe la lista.
        if (!s) continue;
        if (r.letto_il != null) s.letti += 1;
        if (r.risposta === 'si') s.adesioni_si += 1;
        else if (r.risposta === 'no') s.adesioni_no += 1;
    }
    return out;
}

/**
 * Legge TUTTE le righe che soddisfano il filtro, paginando finché il `count`
 * esatto del server non è stato raggiunto. Ritorna anche `completo:false` quando
 * la lettura si è fermata prima: chi chiama deve poterlo dire, non indovinarlo.
 */
async function leggiTutte(
    supabase: SupabaseClient,
    tabella: string,
    colonne: string,
    applicaFiltri: (q: ReturnType<ReturnType<SupabaseClient['from']>['select']>) => unknown,
    operazione: string,
): Promise<{ righe: Record<string, unknown>[]; completo: boolean }> {
    const righe: Record<string, unknown>[] = [];
    let letto = 0;

    for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
        const base = supabase.from(tabella).select(colonne, { count: 'exact' });
        const q = applicaFiltri(base as never) as {
            range: (a: number, b: number) => PromiseLike<{ data: unknown; count: number | null; error: unknown }>;
        };
        const { data, count, error } = await q.range(letto, letto + RIGHE_PER_PAGINA - 1);

        if (error) {
            // PostgREST NON lancia: senza questo controllo un guasto di lettura
            // diventerebbe «zero risposte», cioè una statistica a zero che sembra
            // un dato. Si dichiara incompleta e si logga con il codice.
            logEvento('db', 'error', {
                operazione,
                esito: 'statistiche-avvisi-lettura-fallita',
                entita_tipo: tabella,
                n: righe.length,
                error_code: (error as { code?: string } | null)?.code ?? null,
            }, error);
            return { righe, completo: false };
        }

        const pezzo = (data ?? []) as Record<string, unknown>[];
        righe.push(...pezzo);
        letto += pezzo.length;

        const totale = count ?? letto;
        // Fine naturale: si è letto quanto il server dichiara di avere.
        if (letto >= totale) return { righe, completo: true };
        // Pagina vuota con totale ancora più alto: continuare girerebbe a vuoto.
        if (pezzo.length === 0) {
            logEvento('db', 'error', {
                operazione,
                esito: 'statistiche-avvisi-pagina-vuota',
                entita_tipo: tabella,
                n: righe.length,
                totale,
            });
            return { righe, completo: false };
        }
    }

    // Tetto raggiunto: i conteggi che seguono sono PER DIFETTO. `error`, non
    // `warn`: da qui in poi la schermata mostra numeri più bassi del vero e
    // nessuno può accorgersene guardandola.
    logEvento('db', 'error', {
        operazione,
        esito: 'statistiche-avvisi-troncate',
        entita_tipo: tabella,
        n: righe.length,
        max_pagine: MAX_PAGINE,
    });
    return { righe, completo: false };
}

/**
 * Conteggi (letture, adesioni sì/no) di TUTTI gli avvisi indicati.
 *
 * Query: `ceil(N/100)` più le eventuali pagine. Con l'elenco vuoto: nessuna.
 * Un avviso senza risposte è comunque presente nella mappa, a zero: chi chiama
 * non deve distinguere «zero» da «non c'era».
 */
export async function statistichePerAvviso(
    supabase: SupabaseClient,
    avvisoIds: readonly string[],
    operazione: string,
): Promise<Map<string, StatsAvviso>> {
    const unici = [...new Set(avvisoIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
    const out = new Map<string, StatsAvviso>();
    for (const id of unici) out.set(id, { ...STATS_ZERO });
    if (unici.length === 0) return out;

    for (const blocco of aBlocchi(unici, AVVISI_PER_QUERY)) {
        // Proiezione minima: `parent_id` e `student_id` NON servono a contare, e
        // non devono nemmeno essere caricati in memoria su una richiesta di un
        // genitore che sta guardando la propria bacheca (sono le risposte delle
        // altre famiglie). Meno colonne qui è insieme meno banda e meno dati.
        const { righe } = await leggiTutte(
            supabase,
            'avvisi_risposte',
            'avviso_id, letto_il, risposta',
            (q) => (q as unknown as { in: (c: string, v: string[]) => unknown }).in('avviso_id', blocco),
            operazione,
        );
        for (const [id, stats] of aggregaStatistiche(blocco, righe as RigaRisposta[])) {
            out.set(id, stats);
        }
    }
    return out;
}

/**
 * Le risposte DI UN SOLO GENITORE su tutti gli avvisi indicati, indicizzate per
 * `avviso_id` e poi per `student_id`.
 *
 * Sostituisce la query per-avviso del ramo genitore: era la quinta del gruppo di
 * cinque, e stava nel percorso più caldo dell'applicazione (la home genitore).
 */
export async function rispostePerAvvisoDelGenitore(
    supabase: SupabaseClient,
    avvisoIds: readonly string[],
    parentId: string,
    operazione: string,
): Promise<Map<string, Map<string, { letto_il: string | null; risposta: string | null; risposto_il: string | null }>>> {
    const unici = [...new Set(avvisoIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
    const out = new Map<string, Map<string, { letto_il: string | null; risposta: string | null; risposto_il: string | null }>>();
    if (unici.length === 0 || !parentId) return out;

    for (const blocco of aBlocchi(unici, AVVISI_PER_QUERY)) {
        const { righe } = await leggiTutte(
            supabase,
            'avvisi_risposte',
            'avviso_id, student_id, letto_il, risposta, risposto_il',
            (q) =>
                (q as unknown as {
                    in: (c: string, v: string[]) => { eq: (c: string, v: string) => unknown };
                })
                    .in('avviso_id', blocco)
                    .eq('parent_id', parentId),
            operazione,
        );
        for (const r of righe as Array<Record<string, unknown>>) {
            if (typeof r.avviso_id !== 'string' || typeof r.student_id !== 'string') continue;
            let perFiglio = out.get(r.avviso_id);
            if (!perFiglio) { perFiglio = new Map(); out.set(r.avviso_id, perFiglio); }
            perFiglio.set(r.student_id, {
                letto_il: (r.letto_il as string | null) ?? null,
                risposta: (r.risposta as string | null) ?? null,
                risposto_il: (r.risposto_il as string | null) ?? null,
            });
        }
    }
    return out;
}

/**
 * Nome e ruolo degli autori, in blocco. Un id non trovato semplicemente non
 * compare nella mappa: chi chiama usa `AUTORE_IGNOTO`, come faceva prima la
 * route quando `maybeSingle()` non trovava la riga.
 */
export async function autoriDegliAvvisi(
    supabase: SupabaseClient,
    authorIds: readonly string[],
    operazione: string,
): Promise<Map<string, AutoreAvviso>> {
    const unici = [...new Set(authorIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
    const out = new Map<string, AutoreAvviso>();
    if (unici.length === 0) return out;

    for (const blocco of aBlocchi(unici, AVVISI_PER_QUERY)) {
        const { data, error } = await supabase
            .from('utenti')
            .select('id, nome, cognome, ruolo, first_name, last_name, role')
            .in('id', blocco);
        if (error) {
            // Nome dell'autore mancante = la bacheca mostra «? ?» su ogni riga.
            // Non è fatale, ma non deve restare muto.
            logEvento('db', 'error', {
                operazione,
                esito: 'autori-avvisi-non-letti',
                entita_tipo: 'utenti',
                n: blocco.length,
                error_code: (error as { code?: string } | null)?.code ?? null,
            }, error);
            continue;
        }
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
            if (typeof r.id !== 'string') continue;
            out.set(r.id, {
                first_name: (r.first_name as string) || (r.nome as string) || '?',
                last_name: (r.last_name as string) || (r.cognome as string) || '?',
                role: (r.role as string) || (r.ruolo as string) || 'unknown',
            });
        }
    }
    return out;
}
