import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * «CHE COSA HA CHIUSO DA SOLA LA MACCHINA, IN QUESTO IMPORT?» — UNA QUERY SOLA.
 *
 * ⚠️ STA FUORI DALLE ROTTE PERCHÉ I CHIAMANTI SONO TRE, e tutti e tre devono
 * fare al database ESATTAMENTE la stessa domanda (la finestra no: v. il
 * riquadro subito sotto):
 *   1. il riepilogo che la segreteria legge (`annulla-import:GET`);
 *   2. l'annullo in blocco che lo disfa (`annulla-import:POST`);
 *   3. la notifica differita che parte quando il riepilogo è stato guardato e
 *      non annullato (`riepilogo-visto:POST`).
 *
 * Tre copie della stessa `select` sarebbero tre insiemi che divergono al primo
 * ritocco — e qui la divergenza ha conseguenze precise e diverse fra loro:
 * l'elenco mostrerebbe righe che l'annullo non tocca (e la conferma DIGITATA,
 * che è un numero, certificherebbe un insieme sbagliato), oppure la notifica
 * partirebbe per righe che l'annullo ha appena disfatto.
 *
 * ─── 🔴 STESSO PREDICATO, FINESTRA DIVERSA — ED È DELIBERATO ────────────────
 *
 * Ciò che le tre porte condividono per costruzione sono le TRE CONDIZIONI qui
 * sotto, cioè la domanda posta al database. Quanto in là si legge, invece, è un
 * parametro: `finestra.tetto`, che di default è `TETTO_ANNULLO`.
 *
 * La differenza NON è una comodità, è la correzione di un difetto misurato. Il
 * tetto di 200 esiste per il ciclo di STORNI: oltre quel numero l'annullo in
 * blocco rifiuta, quindi continuare a paginare sarebbe traffico pagato per un
 * elenco che nessuno userà. Ma la fase automatica può chiuderne fino a 500
 * (`MAX_AUTO_PER_IMPORT`), e la NOTIFICA differita non rifiuta niente: se si
 * fermasse al tetto dell'annullo, gli avvisi partirebbero sempre per le prime
 * 200 righe — le STESSE a ogni riapertura, perché l'ordine è stabile e notificare
 * non cambia lo stato della riga — e dalla 201ª in poi le famiglie non
 * verrebbero avvisate MAI, in silenzio. L'annullo di quell'import è per giunta
 * rifiutato (`troppe` ⇒ 422), quindi quelle righe resterebbero confermate e mute
 * per sempre.
 *
 * Perciò la notifica legge con `TETTO_FINESTRA` — la finestra STRUTTURALE, che
 * è quanto questo lettore può portare in memoria in un colpo — e si ferma solo
 * sulla pagina vuota. Non è «nessun tetto»: un ciclo senza fine su una rotta
 * serverless sarebbe un timeout travestito da successo parziale anche qui.
 *
 * ─── LE TRE CONDIZIONI, E CHE COSA TOGLIE CIASCUNA ──────────────────────────
 *  · `import_id`               — solo questo import, mai lo storico;
 *  · `stato = 'confermato'`    — una riga già riaperta non si riapre due volte,
 *                                e non entra nel numero da digitare;
 *  · `abbinato_auto_il NOT NULL` — **solo ciò che ha deciso la macchina**. Una
 *    riga riaperta e riconfermata A MANO ha la marca spenta (la azzerano
 *    `./riapertura-movimento` e `annulla_transazione_contabile`): non entra, ed
 *    è tutto il punto — l'annullo in blocco non deve disfare il lavoro di una
 *    persona.
 *
 * Nella STESSA query, non in memoria dopo la lettura: un filtro applicato dopo
 * avrebbe lavorato su una pagina già tagliata.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Oltre questo numero di righe l'annullo in blocco RIFIUTA invece di provarci.
 *
 * Un ciclo non limitato su una rotta serverless è un timeout travestito da
 * successo parziale: a `maxDuration` scaduto la richiesta muore, le righe già
 * stornate restano stornate e nessuna risposta dice quali fossero. Duecento è
 * anche il punto oltre il quale un elenco smette di essere una cosa che una
 * persona GUARDA prima di disfarla, che è tutto il senso del riepilogo.
 *
 * ⚠️ Il tetto della fase automatica è 500 (`MAX_AUTO_PER_IMPORT`): un import può
 * legittimamente chiuderne più di 200, quindi questo rifiuto è raggiungibile. È
 * voluto — il verso in cui si sbaglia è quello che lascia il lavoro a una
 * persona, che è l'unico recuperabile.
 */
export const TETTO_ANNULLO = 200

/**
 * Righe CHIESTE per pagina.
 *
 * ⚠️ E UN CICLO C'È DAVVERO, anche se col `db-max-rows` di oggi (1000, in
 * `supabase/config.toml`) una pagina sola basterebbe sempre — il tetto qui sopra
 * è più basso. Quel 1000 è una riga di CONFIGURAZIONE, non una costante di
 * questo codice: può scendere senza che nessuno tocchi questo file, e PostgREST
 * tronca **in silenzio**, senza errore e senza intestazione. Con una `.range()`
 * sola e un `max_rows` abbassato a 100, l'annullo avrebbe disfatto cento righe
 * su centocinquanta rispondendo «fatto» — il successo parziale travestito da
 * successo, cioè il difetto che il tetto esiste per impedire. Si avanza di
 * quante righe si sono RICEVUTE e ci si ferma su una pagina vuota: stesso schema
 * della finestra di dedup dell'import.
 */
const BLOCCO_RIGHE = 100

/** Il tetto dei round-trip: col `db-max-rows` di oggi il ciclo si ferma al terzo giro. */
const MAX_PAGINE = 20

/**
 * La finestra STRUTTURALE: oltre questo numero di righe questo lettore non
 * arriva comunque, perché finisce le pagine.
 *
 * È il tetto da passare quando si vuole l'import INTERO e non il solo bersaglio
 * dell'annullo — cioè la notifica differita, che non rifiuta niente e non può
 * lasciare fuori nessuno (v. il riquadro in testata). Vale quattro volte
 * `MAX_AUTO_PER_IMPORT` (500), che è il massimo di righe che la fase automatica
 * può chiudere in un import: il rapporto è verificato da un test, non dedotto
 * qui — se un giorno quel tetto salisse, questa finestra va salita con lui.
 *
 * ⚠️ Con questo tetto `troppe` non può più venire dal confronto (il ciclo finisce
 * le pagine prima): resta la dichiarazione onesta di «ho letto fin dove potevo»,
 * ed è per quello che chi la riceve deve dirlo, non archiviarla in un `info`.
 */
export const TETTO_FINESTRA = MAX_PAGINE * BLOCCO_RIGHE

/**
 * «Quella colonna qui non c'è»: `42703` su una SELECT, `PGRST204` su una
 * scrittura. Il DB E2E della CI non è migrato e `abbinato_auto_il` lì non esiste
 * — è lo stato ATTESO su quell'ambiente, non un guasto.
 */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/** Il registro non esiste proprio su questo database (tabella assente). */
const SCHEMA_MANCANTE = new Set(['42P01', 'PGRST205'])

/**
 * Le colonne della riga automatica.
 *
 * ⚠️ UNA SOLA VARIANTE, e non le tre di `…/[id]:PATCH`. Là la lettura serve
 * anche alla conferma, che deve funzionare su un database non migrato; qui la
 * marca sta nel `WHERE` — senza di lei la domanda «che cosa ha chiuso la
 * macchina?» non ha nemmeno senso — quindi una scala di varianti sarebbe la
 * scala verso una risposta che non si può dare. Le colonne presenti su un
 * database sono sempre un PREFISSO dell'ordine delle migrazioni
 * (`transazione_id` 20260912180100, poi `abbinato_auto_il` 20260920124742):
 * un ambiente che ha la marca ha certamente anche la transazione, quindi un
 * `42703` qui vuol dire una cosa sola — su questo database l'annullamento in
 * blocco non esiste — e si dichiara invece di ripiegare.
 *
 * 🔴 E NON SI RIPIEGA MAI su «tutti i confermati di questo import»: sarebbe
 * disfare il lavoro fatto a mano da una persona, cioè il danno esatto che la
 * marca esiste per evitare.
 */
const SELECT_AUTO =
    'id, scuola_id, data_operazione, importo, causale, controparte, pagamento_id, incasso_id, transazione_id, abbinato_auto_il'

/** Una riga chiusa dalla macchina, come torna dal registro. */
export interface RigaAuto {
    id: string
    /** La sede in cui il denaro è stato registrato: la scrive la conferma. */
    scuola_id: string | null
    data_operazione: string
    importo: number
    causale: string | null
    controparte: string | null
    /** La voce su cui è stata chiusa — l'ÀNCORA, sul ramo composito. */
    pagamento_id: string | null
    incasso_id: string | null
    /** Valorizzato ⇒ ha saldato una transazione a più voci. */
    transazione_id: string | null
    abbinato_auto_il: string | null
}

/** Un rifiuto già formato, nella stessa forma di `EsitoRiapertura`: la rotta lo veste. */
export interface RifiutoLettura {
    status: number
    body: Record<string, unknown>
}

/** Quanto in là leggere. Il PREDICATO non si tocca: quello è lo stesso per tutti. */
export interface FinestraLettura {
    /**
     * Oltre quante righe fermarsi. Default `TETTO_ANNULLO` (200), che è il
     * bersaglio dell'annullo in blocco; la notifica differita passa
     * `TETTO_FINESTRA` perché non può lasciare fuori nessuna famiglia.
     */
    tetto?: number
}

export type LetturaAuto =
    /**
     * `troppe` = il tetto è stato superato: l'elenco è TRONCATO.
     *
     * ⚠️ Troncato a `tetto + 1` esatte, non «a quante ne è arrivate l'ultima
     * pagina»: si pagina a blocchi di cento, quindi senza il taglio uscirebbero
     * fino a `tetto + 100` righe. La riga in più è quella che DIMOSTRA il
     * superamento; le altre novantanove sarebbero anagrafica di minori letta e
     * portata nel processo per essere buttata una riga dopo.
     */
    | { righe: RigaAuto[]; troppe: boolean }
    | { errore: RifiutoLettura }
    /** Su questo database la marca non esiste: qui l'annullamento in blocco non c'è. */
    | { marcaAssente: true }

/**
 * Le righe che la macchina ha chiuso in questo import, paginate.
 *
 * Non lancia: PostgREST non lancia, e un `try/catch` attorno a una `select` non
 * scatterebbe mai. L'errore sta nel valore di ritorno e si guarda — senza, «non
 * ho potuto leggere» diventerebbe «non c'è niente da annullare», cioè un elenco
 * vuoto su un import che la macchina ha chiuso per intero.
 */
export async function leggiRigheAutomatiche(
    supabase: SupabaseClient,
    importId: string,
    operazione: string,
    finestra: FinestraLettura = {},
): Promise<LetturaAuto> {
    const tetto = finestra.tetto ?? TETTO_ANNULLO
    const righe: RigaAuto[] = []
    for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
        const da = righe.length
        const { data, error } = await supabase
            .from('riconciliazione_movimenti')
            .select(SELECT_AUTO)
            .eq('import_id', importId)
            .eq('stato', 'confermato')
            .not('abbinato_auto_il', 'is', null)
            // L'ordine è STABILE e a due chiavi: senza la seconda, due righe con la
            // stessa data possono presentarsi in ordine diverso fra una pagina e
            // l'altra, e la paginazione per `range` salterebbe una riga
            // duplicandone un'altra. È anche l'ordine con cui l'elenco si legge a
            // schermo: non costa un secondo criterio da ricordare.
            .order('data_operazione', { ascending: true })
            .order('id', { ascending: true })
            .range(da, da + BLOCCO_RIGHE - 1)
        if (error) {
            const code = (error as { code?: string }).code ?? ''
            if (COLONNA_ASSENTE.has(code) || SCHEMA_MANCANTE.has(code)) {
                // `warn` e non `error`: sul DB E2E della CI è lo stato atteso, e un
                // canale rosso a ogni giro di CI smette di essere guardato. Ma
                // nemmeno `info`: qui una funzione intera è spenta, e uno
                // spegnimento che nessuno vede è la prima metà di ogni guasto lungo
                // di questo repository.
                logEvento('pagamento', 'warn', {
                    operazione,
                    esito: 'righe-automatiche-non-disponibili',
                    tipo: COLONNA_ASSENTE.has(code) ? 'colonna-marca-assente' : 'registro-assente',
                    import_id: importId,
                    error_code: code,
                })
                return { marcaAssente: true }
            }
            logErrore({ operazione, evento: 'righe_automatiche_non_lette', stato: 500 }, error)
            return {
                errore: {
                    status: 500,
                    body: {
                        error:
                            'Non è stato possibile leggere che cosa l’import ha chiuso da solo: ' +
                            'nessuna riga è stata toccata.',
                        codice: 'ANNULLO_IMPORT_NON_LETTO',
                    },
                },
            }
        }
        const pagate = (data ?? []) as unknown as RigaAuto[]
        if (pagate.length === 0) return { righe, troppe: false }
        righe.push(...pagate)
        // Il tetto si controlla MENTRE si legge, non dopo: oltre quel numero il
        // chiamante rifiuta (l'annullo) o dichiara il troncamento (la notifica),
        // e continuare a paginare sarebbe traffico pagato per righe che nessuno
        // userà. Il taglio a `tetto + 1` è QUI e non nel chiamante: la pagina è
        // di cento righe, e le novantanove di troppo sono nomi e codici fiscali
        // di minori portati nel processo per niente.
        if (righe.length > tetto) return { righe: righe.slice(0, tetto + 1), troppe: true }
    }
    // Venti pagine piene. Col tetto dell'annullo è irraggiungibile (quello morde
    // al terzo giro); con `TETTO_FINESTRA` è il solo modo in cui si esce di qui
    // troncati, e vuol dire duemila righe automatiche in un import — quattro
    // volte ciò che la fase automatica può chiudere. In tutt'e due i casi
    // l'elenco è TRONCATO, e dichiararlo completo sarebbe la bugia peggiore di
    // questa schermata: è il numero che l'operatrice digita per confermare, ed è
    // l'insieme delle famiglie che riceveranno un avviso.
    logEvento('pagamento', 'error', {
        operazione,
        esito: 'righe-automatiche-finestra-troncata',
        import_id: importId,
        n: righe.length,
    })
    return { righe: righe.slice(0, tetto + 1), troppe: true }
}
