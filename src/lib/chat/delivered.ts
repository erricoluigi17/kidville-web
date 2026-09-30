import type { SupabaseClient } from '@supabase/supabase-js';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';

/**
 * Consegna dei messaggi di chat: il terzo stato (fra "inviato" e "letto").
 *
 * `marcaConsegnati` valorizza `delivered_at = now()` sui messaggi RICEVUTI dall'utente
 * (`sender_id <> userId`) e non ancora consegnati (`delivered_at IS NULL`), per uno o più
 * thread oppure per un elenco di id.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * REGOLA FERREA — UPDATE SEPARATO, MAI unito al mark-read.
 *
 * Il DB E2E della CI NON è migrato: la colonna `delivered_at` non esiste. Un `update`
 * che scrivesse `read_at` E `delivered_at` insieme fallirebbe TUTTO con PGRST204, e con
 * lui sparirebbe anche il mark-read — cioè una feature nuova (la doppia spunta) romperebbe
 * una feature vecchia (i messaggi letti). Perciò la consegna è una query a sé: se la colonna
 * manca, questa fallisce da sola e il mark-read (chiamato separatamente) resta intatto.
 *
 * Il fallimento per colonna-assente NON è un errore: è degrado pulito, e si logga `info`.
 * PostgREST codifica la colonna mancante in due modi a seconda di dove la incontra —
 * `PGRST204` sul payload dell'UPDATE, `42703` sul filtro — e vanno gestiti entrambi.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Best-effort: non lancia mai (il chiamante è una route che ha già fatto il suo lavoro
 * vero), e su errore reale logga senza propagare. Non mette MAI dati personali nei log:
 * solo uuid, conteggi ed esiti.
 *
 * ─── A BLOCCHI, PERCHÉ `.in()` VIAGGIA NELL'URL ─────────────────────────────────────────
 *
 * PostgREST non mette `.in('thread_id', ids)` nel corpo: lo mette in QUERY STRING. Cento uuid
 * sono ~3.800 caratteri, mille ~38 kB e la richiesta torna **414** (vedi `@/lib/db/blocchi`).
 * Finché la consegna partiva solo dalla lista chat gli elenchi erano corti; ora parte anche da
 * `notifiche:GET`, su TUTTE le conversazioni di una persona, e una maestra di plesso ne ha
 * centinaia. Un `.in()` solo si romperebbe da sé il giorno in cui gli elenchi crescono — cioè
 * dopo, quando nessuno guarda più. Sul primo ERRORE di un blocco si smette: insistere su un
 * database che ha appena detto no non ha mai consegnato niente. Un blocco che consegna ZERO
 * righe invece non ferma nulla: è il caso normale, e i thread di una persona non si riempiono
 * tutti insieme.
 *
 * ─── PERCHÉ ESISTE `creatiFinoA` ────────────────────────────────────────────────────────
 *
 * «Consegnato» vuol dire *quel* messaggio è arrivato su un dispositivo acceso. Chi chiama la
 * consegna in differita (dopo la risposta, con `after()`) ha contato i messaggi a un certo
 * istante: quelli nati DOPO non sono arrivati da nessuna parte, e marcarli sarebbe una doppia
 * spunta falsa — lo stesso genere di bugia che questo lavoro esiste per togliere di mezzo, solo
 * rovesciata. `creatiFinoA` è quella linea: `created_at <= istante`, e senza il parametro non
 * c'è nessun filtro, quindi i chiamanti che consegnano in linea non cambiano di una virgola.
 *
 * ─── NIENTE SONDA: UN SOLO UPDATE PER BLOCCO ────────────────────────────────────────────
 *
 * Davanti all'UPDATE NON c'è una `select … limit(1)` di controllo per «non scrivere a vuoto ogni
 * 60 secondi», e non va aggiunta: il «se in attesa» del nome è il FILTRO
 * `is('delivered_at', null)`, non una query in più. In Postgres un UPDATE che
 * non trova righe **non assegna un xid, non scrive WAL, non prende lock di riga e non genera
 * eventi Realtime**: costa la stessa scansione dell'indice parziale che costava la sonda. La
 * sonda quindi non risparmiava nulla nel caso normale, e nel caso che conta — quando c'è
 * davvero qualcosa da consegnare — aggiungeva un giro di database.
 *
 * ─── I LOG: UNO PER CONSEGNA, NESSUNO PER GIRO ──────────────────────────────────────────
 *
 * `marcaConsegnati` non logga il successo: i suoi chiamanti sono dentro la chat (e il
 * dispatcher, che ha i propri contatori), dove la riga di `withRoute` della route basta.
 *
 * `consegnaSeInAttesa` invece logga `chat-consegnati-app-aperta` con quante righe ha scritto,
 * e solo quando sono più di zero. La distinzione è fra una riga PER GIRO e una riga PER
 * CONSEGNA: la prima sarebbe rumore — la funzione gira ogni 60 s per ogni persona connessa, e
 * sul canale `chat`, che è in `EVENTI_PERSISTITI`, finirebbe anche in tabella, dove la
 * deduplicazione di `app_log` terrebbe il contesto della PRIMA occorrenza del giorno. La
 * seconda è rara (solo quando qualcosa arriva davvero) ed è l'unica prova che D2 funziona in
 * produzione: senza, per sapere se le doppie spunte si accendono bisognerebbe interrogare il
 * database a mano — cioè non lo saprebbe nessuno, che è esattamente come sono rimaste spente
 * per cinque ore senza che un test fosse rosso.
 *
 * Il conteggio è il `count: 'exact'` dell'UPDATE, non un numero dedotto: «consegnati 0» e
 * «consegnati 40» non devono poter essere la stessa riga muta. (In `app_log`, che deduplica per
 * giorno, resta la `n` della PRIMA consegna del giorno: è un battito, non un totale. Il totale
 * dei messaggi consegnati sta nei log della piattaforma.) Se un blocco si guasta a metà
 * giro, il parziale già scritto SI logga — al contrario di `leggiChatNonLetti`, dove il
 * parziale era un numero da restituire e metà numero è un numero falso; qui sono righe scritte
 * per davvero, e tacerle nasconderebbe una consegna avvenuta.
 *
 * ─── INDICE GIÀ IN TABELLA, nessuna migrazione da questo passo ──────────────────────────
 *
 * `idx_chat_messages_undelivered (thread_id, sender_id) WHERE delivered_at IS NULL` — è
 * l'indice parziale giusto per l'UPDATE: filtra per thread su `delivered_at IS NULL`,
 * escludendo il proprio `sender_id`.
 *
 * ⚠️ CHI AGGIUNGE UN EXPORT QUI guardi prima chi sostituisce questo modulo per intero:
 * `grep -rln "vi.mock('@/lib/chat/delivered'" __tests__/` trova una decina di file con una
 * factory che espone SOLO `marcaConsegnati`. Un nome nuovo importato da un modulo che quei
 * file caricano li fa esplodere tutti con «No "…" export is defined on the mock». Oggi non
 * succede perché le route della chat importano solo `marcaConsegnati` e `consegnaSeInAttesa`
 * la usa la sola `notifiche:GET`, il cui test la dichiara.
 */

/**
 * Codici emessi quando `delivered_at` non esiste ancora (CI non migrata):
 *  · PGRST204 → il payload dell'UPDATE cita una colonna che PostgREST non trova;
 *  · 42703    → il filtro `is('delivered_at', null)` colpisce una colonna inesistente.
 *
 * ⚠️ Un `code` VUOTO non è in questo elenco, e non deve entrarci: è la forma con cui
 * postgrest-js riporta un fetch caduto (vedi `consegnaBlocco`). Rete giù ≠ colonna assente.
 */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703']);

const OP_MARCA = 'chat/delivered:marcaConsegnati';
const OP_CONSEGNA = 'chat/delivered:consegnaSeInAttesa';

/** Esito di un blocco: si continua solo su `ok`. */
interface EsitoBlocco {
    esito: 'ok' | 'fermati';
    /** Righe scritte, quando il conteggio è stato chiesto. Zero altrimenti. */
    n: number;
}

/**
 * Tratta l'`error` di PostgREST: `info` se la colonna manca (degrado pulito), `logErrore` se è
 * un guasto vero. In entrambi i casi il chiamante si ferma — la differenza è solo il livello.
 */
function riportaGuasto(operazione: string, error: unknown): void {
    const codice = (error as { code?: string } | null)?.code;
    if (codice && COLONNA_ASSENTE.has(codice)) {
        // DB non migrato (E2E della CI): degrado pulito, non un guasto. `info` → non persistito.
        // Nessun PII: solo l'operazione e l'esito.
        logEvento('db', 'info', { operazione, esito: 'colonna-delivered_at-assente' });
        return;
    }
    // Errore vero: si logga (senza propagare — la consegna è accessoria alla risposta).
    logErrore({ operazione, evento: 'db' }, error);
}

/** Scrive `delivered_at` su UN blocco di id. Non lancia: torna se si può continuare. */
async function consegnaBlocco(
    supabase: SupabaseClient,
    operazione: string,
    colonna: 'id' | 'thread_id',
    blocco: string[],
    userId: string,
    creatiFinoA?: string,
    /** Chiede a PostgREST quante righe ha toccato: serve a chi logga la consegna. */
    conteggia = false,
): Promise<EsitoBlocco> {
    // Il `try` comincia PRIMA della costruzione della query, non all'`await`: è la difesa del
    // contratto «non lancia mai» contro l'imprevisto (un client sostituito, un builder che cambia
    // forma, un bug del logger), e un builder che non ha più `lte` lancia mentre si costruisce,
    // non mentre si attende. Un chiamante in differita — dentro `after()`, o il dispatcher delle
    // push dopo la presa — non ha nessuno a cui propagare.
    try {
        const tabella = supabase.from('chat_messages');
        const payload = { delivered_at: new Date().toISOString() };

        // `count: 'exact'` solo a chi logga quante righe ha scritto: `marcaConsegnati` non lo
        // chiede, perché non logga il successo e un conteggio che nessuno legge è solo un header.
        let query = (conteggia ? tabella.update(payload, { count: 'exact' }) : tabella.update(payload))
            .neq('sender_id', userId)
            .is('delivered_at', null);

        if (creatiFinoA) query = query.lte('created_at', creatiFinoA);

        // PostgREST NON lancia, e non lancia nemmeno quando il fetch cade: in quel caso
        // restituisce `{ data: null, count: null, error: { code: '', message: 'TypeError: …' },
        // status: 0 }` (postgrest-js 2.112, `dist/index.mjs`), che finisce in `logErrore` come
        // ogni altro errore — il `code` vuoto non è fra quelli della colonna assente. Si
        // controlla quindi SEMPRE il valore di ritorno.
        const { count, error } = await query.in(colonna, blocco);
        if (!error) return { esito: 'ok', n: count ?? 0 };
        riportaGuasto(operazione, error);
    } catch (e) {
        // Un catch che non logga è un bug.
        logErrore({ operazione, evento: 'db' }, e);
    }
    return { esito: 'fermati', n: 0 };
}

interface MarcaConsegnatiParams {
    /** L'utente che sta ricevendo (i suoi messaggi in USCITA non vanno mai marcati). */
    userId: string;
    /** Consegna tutti i messaggi ricevuti in questi thread. */
    threadIds?: string[];
    /** Consegna questi id specifici (usato dopo il mark-read sugli stessi id). */
    messageIds?: string[];
    /**
     * Solo i messaggi NATI fino a questo istante (ISO). Assente = nessun limite temporale.
     * Vedi «PERCHÉ ESISTE `creatiFinoA`» in testata.
     */
    creatiFinoA?: string;
}

export async function marcaConsegnati(
    supabase: SupabaseClient,
    { userId, threadIds, messageIds, creatiFinoA }: MarcaConsegnatiParams,
): Promise<void> {
    const perId = Array.isArray(messageIds) && messageIds.length > 0;
    const perThread = Array.isArray(threadIds) && threadIds.length > 0;

    // Nessun bersaglio → nessuna query (niente scritture a vuoto sul DB di produzione).
    if (!perId && !perThread) return;

    // `messageIds` ha la precedenza: è il caso "dopo il read, consegna gli stessi id".
    const colonna = perId ? 'id' : 'thread_id';
    const ids = (perId ? messageIds : threadIds) as string[];

    for (const blocco of aBlocchi(ids, ID_PER_QUERY)) {
        const { esito } = await consegnaBlocco(supabase, OP_MARCA, colonna, blocco, userId, creatiFinoA);
        if (esito !== 'ok') return;
    }
}

interface ConsegnaSeInAttesaParams {
    /** Identità del GATE (`auth.user.id`), mai un input del client. */
    userId: string;
    /** Le conversazioni su cui consegnare. Vuoto = nessuna query. */
    threadIds: string[];
    /** Solo i messaggi nati fino a questo istante (ISO). Vedi la testata. */
    creatiFinoA?: string;
}

/**
 * Consegna i messaggi ancora in attesa nei thread dati, e dice quante ne ha consegnate.
 *
 * Un UPDATE per blocco, col `count`, e una riga di log solo se qualcosa è stato scritto: il
 * perché sta in «NIENTE SONDA» e «I LOG» in testata. Non lancia mai. Un blocco a vuoto non
 * ferma il giro; un blocco in errore sì, e il parziale già consegnato resta loggato.
 */
export async function consegnaSeInAttesa(
    supabase: SupabaseClient,
    { userId, threadIds, creatiFinoA }: ConsegnaSeInAttesaParams,
): Promise<void> {
    if (!Array.isArray(threadIds) || threadIds.length === 0) return;

    let consegnati = 0;

    for (const blocco of aBlocchi(threadIds, ID_PER_QUERY)) {
        const { esito, n } = await consegnaBlocco(
            supabase, OP_CONSEGNA, 'thread_id', blocco, userId, creatiFinoA, true,
        );
        consegnati += n;
        // `break` e non `return`: il parziale va comunque detto (vedi la testata).
        if (esito !== 'ok') break;
    }

    if (consegnati > 0) {
        // L'unica prova che D2 funziona in produzione. Solo conteggi ed esito: niente uuid di
        // thread, niente testi, niente persone.
        logEvento('chat', 'info', {
            operazione: OP_CONSEGNA,
            esito: 'chat-consegnati-app-aperta',
            n: consegnati,
        });
    }
}
