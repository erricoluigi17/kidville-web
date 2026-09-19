import type { SupabaseClient } from '@supabase/supabase-js';
import { logEvento } from '@/lib/logging/logger';
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';

/** Ri-esportato: il motore sta in `@/lib/db/blocchi`, un posto solo. */
export { aBlocchi };

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

/**
 * I CONTEGGI DI UN AVVISO.
 *
 * ⚠️ LE TRE CHIAVI STORICHE — `letti`, `adesioni_si`, `adesioni_no` — NON cambiano
 * né nome né significato. Continuano a contare RIGHE: quante famiglie hanno letto,
 * quante hanno detto sì, quante hanno detto no. I consumatori (cockpit, card,
 * esportazioni) non si toccano, ed è la ragione per cui le nuove sono cinque campi
 * NUOVI invece di una ridefinizione delle vecchie.
 *
 * Le cinque nuove servono al tetto dei posti (cantiere A2), che si conta in
 * PERSONE e non in adesioni:
 *  · `adesioni_ammesse` / `persone_ammesse` — chi è dentro, in righe e in teste;
 *  · `adesioni_in_attesa` / `persone_in_attesa` — la coda, e che cosa entrerebbe
 *    alzando il tetto;
 *  · `adesioni_senza_numero` — quante adesioni stiamo contando come UNA persona
 *    per convenzione, perché un numero non l'hanno mai dichiarato.
 */
export type StatsAvviso = {
    letti: number;
    adesioni_si: number;
    adesioni_no: number;
    adesioni_ammesse: number;
    persone_ammesse: number;
    adesioni_in_attesa: number;
    persone_in_attesa: number;
    adesioni_senza_numero: number;
};

export type AutoreAvviso = { first_name: string; last_name: string; role: string };

/** Autore non risolto: stessa forma che la route restituiva prima, invariata. */
export const AUTORE_IGNOTO: AutoreAvviso = { first_name: '?', last_name: '?', role: 'unknown' };

/** Statistiche a zero: un avviso senza nemmeno una risposta è il caso normale. */
export const STATS_ZERO: StatsAvviso = {
    letti: 0,
    adesioni_si: 0,
    adesioni_no: 0,
    adesioni_ammesse: 0,
    persone_ammesse: 0,
    adesioni_in_attesa: 0,
    persone_in_attesa: 0,
    adesioni_senza_numero: 0,
};

/**
 * Quanti id entrano in un solo `.in(...)`.
 *
 * La regola (PostgREST mette gli id in query string, oltre il migliaio si prende
 * un 414) vive ora in `@/lib/db/blocchi`, perché è una proprietà del trasporto e
 * non degli avvisi: dal 2026-09-08 la usa anche il debounce delle notifiche.
 * Il nome resta qui per chi già lo importa.
 */
export const AVVISI_PER_QUERY = ID_PER_QUERY;

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


/** Riga di `avvisi_risposte` nella proiezione MINIMA usata per aggregare. */
type RigaRisposta = {
    avviso_id?: unknown;
    letto_il?: unknown;
    risposta?: unknown;
    stato_adesione?: unknown;
    numero_partecipanti?: unknown;
};

/**
 * QUANTE PERSONE VALE UNA RIGA: il suo `numero_partecipanti` se è un numero VERO,
 * **altrimenti 1**.
 *
 * ⚠️ GEMELLO DICHIARATO del `COALESCE(numero_partecipanti, 1)` che vive dentro la
 * funzione SQL `avviso_posti_occupati` (migrazione
 * `20260919132612_avvisi_scadenze_posti_e_partecipanti.sql`, § 7). Sono la stessa
 * regola in due linguaggi, con due mestieri diversi: **quella decide chi entra,
 * questa mostra il totale.** Se divergono — se una delle due contasse le righe
 * senza numero come zero — la schermata della segreteria direbbe «22 su 50» mentre
 * il database rifiuta la ventitreesima adesione, e **nessun test se ne
 * accorgerebbe**, perché ciascuna delle due metà, da sola, è perfettamente
 * coerente: il difetto esiste solo nel confronto, che è il posto dove nessuno
 * guarda. Chi tocca il `COALESCE` là dentro tocca anche questa riga.
 *
 * È lo stesso gemello — e la stessa frase — di `personeDellaRiga` in
 * `@/lib/avvisi/posti`: là si parte da righe già in mano al chiamante, qui da righe
 * lette a blocchi. Due punti d'ingresso, una regola sola.
 *
 * `Number.isFinite` e non `typeof === 'number'`: `NaN` è un `number`, e sommato una
 * volta sola renderebbe `NaN` l'intero riepilogo — «50 posti su NaN» a schermo.
 */
function personeDellaRiga(n: unknown): number {
    return typeof n === 'number' && Number.isFinite(n) ? n : 1;
}

/**
 * Aggregazione PURA di righe già lette → statistiche per avviso.
 *
 * È separata dall'accesso al database di proposito: è la parte che può sbagliare
 * i conti, ed è l'unica che si può provare senza finti client.
 *
 * ── SOLO `ammessa` OCCUPA, ED È UNA LISTA BIANCA ────────────────────────────
 *
 * Il confronto è `=== 'ammessa'`, non `!== 'in_attesa'`: il giorno in cui arriva un
 * terzo stato (un `annullata`, per dire) con la lista bianca quel valore
 * semplicemente non occupa posti, con la lista nera occuperebbe e il tetto si
 * riempirebbe di righe che nessuno conta più. Stessa scelta di
 * `@/lib/avvisi/posti` e di `zStatoAdesione`, dall'altro lato del filo.
 *
 * `adesioni_senza_numero` conta le righe con `risposta === 'si'` che un numero non
 * l'hanno dichiarato — è quindi un SOTTOINSIEME di `adesioni_si`, e dice quante
 * delle teste contate valgono 1 per convenzione e non per dichiarazione. Sono
 * tutte le 869 righe storiche e tutte quelle di un avviso senza `chiedi_numero`.
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

        const persone = personeDellaRiga(r.numero_partecipanti);
        if (r.risposta === 'si' && !(typeof r.numero_partecipanti === 'number' && Number.isFinite(r.numero_partecipanti))) {
            s.adesioni_senza_numero += 1;
        }
        if (r.stato_adesione === 'ammessa') {
            s.adesioni_ammesse += 1;
            s.persone_ammesse += persone;
        } else if (r.stato_adesione === 'in_attesa') {
            s.adesioni_in_attesa += 1;
            s.persone_in_attesa += persone;
        }
    }
    return out;
}

/**
 * I due codici con cui PostgREST dice «quella colonna qui non c'è»: `42703` sulla
 * lettura, `PGRST204` quando è la cache dello schema a non conoscerla. È il
 * linguaggio del DB E2E della CI, che è un progetto separato e NON è migrato.
 */
function proiezioneMancante(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code ?? '';
    return code === '42703' || code === 'PGRST204';
}

/**
 * Legge TUTTE le righe che soddisfano il filtro, paginando finché il `count`
 * esatto del server non è stato raggiunto. Ritorna anche `completo:false` quando
 * la lettura si è fermata prima: chi chiama deve poterlo dire, non indovinarlo.
 *
 * ── `colonneRidotte`: IL DEGRADO CHE IMPEDISCE UNO ZERO CHE SEMBRA UN DATO ──
 *
 * ⚠️ Prima del 2026-09-19 un `42703` finiva nel ramo `error` qui sotto: livello
 * `error`, `completo:false`, e **statistiche a zero** restituite al chiamante — che
 * è esattamente la forma di guasto che la testata di questo file condanna, «hanno
 * letto in 3 invece che in 47», solo portata all'estremo. Con la proiezione
 * allargata alle due colonne nuove (`stato_adesione`, `numero_partecipanti`)
 * sarebbe successo **a ogni richiesta** sul DB E2E non migrato: ogni avviso a zero
 * letture, in una schermata che non ha modo di dire «non lo so».
 *
 * Perciò, ALLA PRIMA PAGINA e SOLO su quei due codici, si riprova una volta con la
 * proiezione STORICA e si dichiara il degrado. Sugli altri codici il comportamento
 * resta identico a prima: un guasto di lettura non diventa un ripiego silenzioso.
 * Le colonne nuove mancano ⇒ i cinque conteggi nuovi restano a zero, ma i tre
 * storici tornano veri, che è il verso giusto in cui perdere qualcosa.
 */
async function leggiTutte(
    supabase: SupabaseClient,
    tabella: string,
    colonne: string,
    applicaFiltri: (q: ReturnType<ReturnType<SupabaseClient['from']>['select']>) => unknown,
    operazione: string,
    colonneRidotte?: string,
): Promise<{ righe: Record<string, unknown>[]; completo: boolean }> {
    const righe: Record<string, unknown>[] = [];
    let letto = 0;
    let proiezione = colonne;
    let giaRidotta = false;

    const pagina1 = (da: number) => {
        const base = supabase.from(tabella).select(proiezione, { count: 'exact' });
        const q = applicaFiltri(base as never) as {
            range: (a: number, b: number) => PromiseLike<{ data: unknown; count: number | null; error: unknown }>;
        };
        return q.range(da, da + RIGHE_PER_PAGINA - 1);
    };

    for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
        let { data, count, error } = await pagina1(letto);

        // Il degrado si tenta una volta sola, sulla PRIMA pagina: se la colonna
        // mancasse a metà paginazione non sarebbe un DB non migrato, sarebbe uno
        // schema che cambia sotto i piedi — e quello va visto, non assorbito.
        if (error && pagina === 0 && !giaRidotta && colonneRidotte && proiezioneMancante(error)) {
            logEvento('db', 'warn', {
                operazione,
                esito: 'statistiche-proiezione-ridotta',
                entita_tipo: tabella,
                error_code: (error as { code?: string } | null)?.code ?? null,
            });
            proiezione = colonneRidotte;
            giaRidotta = true;
            ({ data, count, error } = await pagina1(letto));
        }

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
        //
        // Le due colonne aggiunte il 2026-09-19 sono uno STATO e un NUMERO: zero
        // dati personali, come le tre di prima. Resta una query per blocco e resta
        // la paginazione esatta con `count:'exact'`.
        const { righe } = await leggiTutte(
            supabase,
            'avvisi_risposte',
            'avviso_id, letto_il, risposta, stato_adesione, numero_partecipanti',
            (q) => (q as unknown as { in: (c: string, v: string[]) => unknown }).in('avviso_id', blocco),
            operazione,
            // Il ripiego per il DB E2E non migrato: le tre colonne storiche.
            'avviso_id, letto_il, risposta',
        );
        for (const [id, stats] of aggregaStatistiche(blocco, righe as RigaRisposta[])) {
            out.set(id, stats);
        }
    }
    return out;
}

/**
 * LA PROPRIA RIGA, COM'È ARCHIVIATA.
 *
 * ⚠️ `stato_adesione` e `numero_partecipanti` NON sono una statistica di capienza,
 * e la distinzione è la decisione n. 17 del committente: `posti_totali` e
 * `persone_ammesse` dicono **quanto spazio resta agli altri** e, messi accanto,
 * sono una sottrazione; questi due dicono **dove sta questa famiglia**, ed è un
 * dato suo. Senza di loro il genitore non ha modo di sapere «sei in lista
 * d'attesa», che è esattamente l'informazione che la lista d'attesa esiste per
 * dargli.
 */
export type RispostaDelGenitore = {
    letto_il: string | null;
    risposta: string | null;
    risposto_il: string | null;
    /** `'ammessa'` · `'in_attesa'` · `null` (nessuna adesione, o riga storica). */
    stato_adesione: string | null;
    numero_partecipanti: number | null;
};

/**
 * Le risposte DI UN SOLO GENITORE su tutti gli avvisi indicati, indicizzate per
 * `avviso_id` e poi per `student_id`.
 *
 * Sostituisce la query per-avviso del ramo genitore: era la quinta del gruppo di
 * cinque, e stava nel percorso più caldo dell'applicazione (la home genitore).
 *
 * ── IL RIPIEGO SULLE COLONNE STORICHE ───────────────────────────────────────
 *
 * Stessa forma (e stessa ragione) di `statistichePerAvviso`: sul DB E2E della CI,
 * che non è migrato, le due colonne del cantiere A2 non esistono e un `42703`
 * farebbe tornare ZERO righe — cioè `my_response: null` su ogni avviso, che a
 * schermo è «non hai mai risposto» per chi ha risposto. Con il ripiego i tre campi
 * storici tornano veri e i due nuovi restano `null`, che è il verso giusto in cui
 * perdere qualcosa.
 */
export async function rispostePerAvvisoDelGenitore(
    supabase: SupabaseClient,
    avvisoIds: readonly string[],
    parentId: string,
    operazione: string,
): Promise<Map<string, Map<string, RispostaDelGenitore>>> {
    const unici = [...new Set(avvisoIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
    const out = new Map<string, Map<string, RispostaDelGenitore>>();
    if (unici.length === 0 || !parentId) return out;

    for (const blocco of aBlocchi(unici, AVVISI_PER_QUERY)) {
        const { righe } = await leggiTutte(
            supabase,
            'avvisi_risposte',
            'avviso_id, student_id, letto_il, risposta, risposto_il, stato_adesione, numero_partecipanti',
            (q) =>
                (q as unknown as {
                    in: (c: string, v: string[]) => { eq: (c: string, v: string) => unknown };
                })
                    .in('avviso_id', blocco)
                    .eq('parent_id', parentId),
            operazione,
            'avviso_id, student_id, letto_il, risposta, risposto_il',
        );
        for (const r of righe as Array<Record<string, unknown>>) {
            if (typeof r.avviso_id !== 'string' || typeof r.student_id !== 'string') continue;
            let perFiglio = out.get(r.avviso_id);
            if (!perFiglio) { perFiglio = new Map(); out.set(r.avviso_id, perFiglio); }
            perFiglio.set(r.student_id, {
                letto_il: (r.letto_il as string | null) ?? null,
                risposta: (r.risposta as string | null) ?? null,
                risposto_il: (r.risposto_il as string | null) ?? null,
                stato_adesione: (r.stato_adesione as string | null) ?? null,
                // `Number.isFinite` e non un cast: un `NaN` che arrivasse dal
                // trasporto verrebbe mostrato come «NaN persone» alla famiglia.
                numero_partecipanti:
                    typeof r.numero_partecipanti === 'number' && Number.isFinite(r.numero_partecipanti)
                        ? r.numero_partecipanti
                        : null,
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
