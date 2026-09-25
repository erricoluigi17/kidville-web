import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { percorsoNelBucket } from '@/lib/allegati/storage'
import {
    GIORNI_CESTINO_REGISTRO,
    GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
    sogliaPurgaCestinoRegistro,
    sogliaConservazioneAllegatiRegistro,
} from '@/lib/primaria/cestino-registro'
import { fascicoloNelCestino, fascicoloAncheNelCestino } from '@/lib/primaria/cestino-fascicolo'
import { allegatiRegistroNelCestino, allegatiRegistroAncheNelCestino } from '@/lib/primaria/cestino-allegati-registro'
import { BUCKET_ALLEGATI_REGISTRO } from '@/lib/primaria/allegati-registro'

/**
 * LA PURGA DEL CESTINO DEL REGISTRO E DEL FASCICOLO — prima il file, poi la riga.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Dalla spec del 2026-09-24 («2 Primaria») un allegato del registro
 * (`allegati_registro`) e un documento del fascicolo (`student_documents`) non si
 * cancellano più subito: «Elimina», la sostituzione del file e l'eliminazione della
 * lezione li mettono nel CESTINO (`eliminato_il`), da cui si ripristinano per
 * `GIORNI_CESTINO_REGISTRO` giorni. Passati quelli la schermata promette che riga e
 * file spariscono. Questo file è ciò che mantiene la promessa: senza, il cestino
 * sarebbe un archivio eterno di diagnosi, PEI e verbali della 104 — invisibili
 * nel prodotto e non cancellati, che è il guasto peggiore secondo
 * `rimozione-verificata.ts`.
 *
 * ─── PERCHÉ UNA ROUTE HTTP E NON UNA FUNZIONE SQL ───────────────────────────
 *
 * Come i gemelli (`retention-galleria`, `retention-candidature`): i file si
 * tolgono solo dalla Storage API. `storage.objects` ha il trigger
 * `protect_objects_delete` e il lock `storage-delete-vietata-in-sql` lo vieta per
 * iscritto. Quindi: route HTTP, chiamata da `pg_cron` via `pg_net`
 * (`supabase/migrations/20260924220100_cestino_registro_cron.sql`).
 *
 * ─── LE REGOLE, IN ORDINE DI IMPORTANZA ─────────────────────────────────────
 *
 * 1. **PRIMA IL FILE, POI LA RIGA — per riga, non per lotto.** Un file che non
 *    esce (o che non si sa se è uscito) trattiene la SUA riga, e solo quella:
 *    cancellare la riga lascerebbe il documento nel bucket senza nessuno che lo
 *    nomini, irraggiungibile anche dall'oblio su richiesta.
 *
 * 2. **UN FILE CHE UN'ALTRA RIGA NOMINA ANCORA NON SI TOCCA.** Nessun indice
 *    UNIQUE sul percorso: prima del `remove` si chiede al database se una riga
 *    FUORI dal lotto — viva o ancora nel cestino — nomina lo stesso percorso. Se
 *    sì il file resta a chi lo reclama, la riga scaduta si cancella comunque e il
 *    fatto si dichiara (`n_file_ancora_reclamati`). Se la domanda non ha
 *    risposta, non si tocca NIENTE di quel contenitore (fail-closed).
 *
 * 3. **IDEMPOTENTE SENZA COLONNE IN PIÙ.** A differenza della galleria qui non c'è
 *    un `file_rimosso_il`, e non serve: se il file è uscito e la `delete` della
 *    riga fallisce, il giro dopo rilegge la stessa riga, `rimuoviEVerifica` trova
 *    il file «già assente» (che NON è un guasto) e la riga si cancella.
 *
 *    La FINESTRA fra il `remove` riuscito e la `delete` fallita, contenitore per
 *    contenitore:
 *     · i due cestini: la riga è oltre la custodia, e il ripristino la rifiuta
 *       (`cestinoScaduto`, ripetuto nell'UPDATE): nessun «Ripristina» restituisce
 *       un file distrutto;
 *     · la conservazione: la riga può essere nel CESTINO o VIVA. Nel cestino la
 *       chiude il ripristino, che rifiuta un allegato oltre la conservazione
 *       (`conservazioneAllegatoScaduta`, `409 ALLEGATO_REGISTRO_CONSERVAZIONE_SCADUTA`,
 *       e la stessa condizione nell'UPDATE); il cestino non la elenca nemmeno. VIVA,
 *       invece, la riga resta visibile nel registro — al docente e ai genitori — con
 *       un file che non c'è più, fino al giro dopo che la cancella. È una finestra
 *       DICHIARATA, non chiusa: la lunghezza è un giro di purga (un giorno), il danno
 *       è un link che risponde «non trovato», e nessun dato torna indietro. Il giro
 *       esce comunque `500` (`cancellazione-fallita`), quindi chi sorveglia lo sa.
 *
 * 4. **LA `delete` RIPETE LE CONDIZIONI DEL CESTINO.** `eliminato_il` non nullo e
 *    più vecchio della soglia, nella stessa istruzione che cancella: una riga viva,
 *    o ripristinata fra la lettura e la cancellazione, non è cancellabile da qui
 *    nemmeno se il suo id arrivasse da una lettura sbagliata.
 *
 * 5. **IL BATTITO SI SCRIVE SEMPRE, ANCHE A ZERO**, in un `finally`, con
 *    `evento: 'cron'` (è ciò che `/api/health` legge). Con i soli errori, «nessun
 *    log» non distingue «cestino vuoto» da «la purga non parte più».
 *
 * 6. **RIGHE TRATTENUTE ⇒ 500.** Un `200` direbbe «fatto» a chi sorveglia, e
 *    resterebbero dati sanitari di minori oltre il termine senza che lo sappia
 *    nessuno. Il database E2E della CI non è migrato: colonne del cestino assenti
 *    ⇒ `503` dichiarato, mai un `200` che direbbe «cestino vuoto».
 *
 * 7. **NESSUN FILTRO DI SEDE, e non è una dimenticanza.** Un termine di custodia
 *    non ha confini di plesso: un documento cestinato a una sede scade lo stesso
 *    giorno che nelle altre, e un `.in('scuola_id', …)` lascerebbe indietro in
 *    silenzio i plessi che il job non conosce. Non c'è nemmeno un utente da cui
 *    derivare uno scope: la chiama `pg_net` col cron secret.
 *
 * 8. **I CONTENITORI SONO INDIPENDENTI.** Un guasto sugli allegati non ferma
 *    il fascicolo né la conservazione, e viceversa: ciascuno ha il suo esito, e
 *    l'esito del giro è `ok` soltanto se lo sono tutti e tre.
 *
 * 9. **LA CONSERVAZIONE DEGLI ALLEGATI DEL REGISTRO È UN TERZO CONTENITORE.**
 *    Decisione del titolare del 2026-09-25: un allegato del registro
 *    (`allegati_registro`, bucket `registro-allegati`) si distrugge
 *    `GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO` giorni dopo il CARICAMENTO
 *    (`creato_il`), vivo o nel cestino che sia. Non è un secondo cron: è il
 *    contenitore `conservazione` di questo stesso giro, con le stesse regole — prima
 *    il file e poi la riga, un file che un'altra riga nomina ancora non si tocca,
 *    la `delete` ripete la condizione (`creato_il` oltre la soglia), lotti a tetto,
 *    esito suo. Il fascicolo (`student_documents`) NON ha questo termine e da qui
 *    non si raggiunge. Una riga con `creato_il` NULL (lo schema lo permette, il
 *    default `now()` lo impedisce in pratica) non scade: `lt` non la prende, e la
 *    purga non inventa un'età che la riga non dichiara.
 *
 * ─── COSA NON ENTRA NEI LOG ─────────────────────────────────────────────────
 *
 * Niente percorsi (portano l'uuid dell'alunno o della lezione e il nome del
 * file), niente nomi, niente tipi di documento. Solo conteggi, enumerati, date.
 */

/** Il nome con cui questo lavoro si presenta in `app_log` e in `cron.job`. */
const JOB = 'cestino-registro-retention'

/**
 * I BUCKET, quelli in cui si CARICANO i file — un bucket sbagliato qui vuol dire
 * righe cancellate e file rimasti.
 *
 *  · allegati del registro: `BUCKET_ALLEGATI_REGISTRO`, IMPORTATO da
 *    `@/lib/primaria/allegati-registro`, la stessa costante con cui
 *    `primaria/allegati:POST` e `primaria/allegati/sostituisci` fanno l'`upload`.
 *    Una costante sola per chi carica e per chi cancella: non c'è una seconda
 *    stringa da tenere allineata (fino al 2026-09-24 c'era, e la suite la
 *    confrontava con una `const BUCKET` della route che poi è sparita);
 *  · fascicolo: `sensitive_documents`, lo stesso `BUCKET_FASCICOLO` dell'oblio e
 *    dei prestampati (tutte le righe di `student_documents` vivono lì), ripetuto
 *    qui come in `documenti-firmati/dettaglio`: la suite rilegge la route di
 *    caricamento e l'oblio e diventa rossa se il nome diverge.
 */
const BUCKET_FASCICOLO = 'sensitive_documents'

/**
 * IL TETTO DEL LOTTO per contenitore. Una lettura senza `.limit()` si fa tagliare
 * da qualcun altro (`max_rows` di PostgREST) in silenzio; con un tetto nostro il
 * taglio si dichiara (`lotto_pieno`) e il giro dopo riprende dalle più vecchie.
 */
const TETTO_LOTTO = 500

/** Quanti valori per volta in un `.in()`: finisce nella query string di PostgREST. */
const LOTTO_IN = 100

/** Colonna del cestino assente (DB E2E non migrato): `42703` in lettura, `PGRST204` in scrittura. */
const CODICI_COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])
/** Tabella assente. */
const CODICI_TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

function codiceDi(errore: unknown): string {
    const c = (errore as { code?: unknown } | null)?.code
    return typeof c === 'string' ? c : ''
}

type ChiaveContenitore = 'allegati' | 'conservazione' | 'fascicolo'

type Supabase = Awaited<ReturnType<typeof createAdminClient>>

type Lettura = PromiseLike<{ data: unknown; error: unknown }>
type Cancellazione = PromiseLike<{ error: unknown; count: number | null }>

type Contenitore = {
    chiave: ChiaveContenitore
    bucket: string
    /** Il termine che questo contenitore applica, per i log e la risposta. */
    giorni: number
    /**
     * La soglia ISO di QUESTO contenitore: `eliminato_il` per i due cestini,
     * `creato_il` per la conservazione. Calcolata dal modulo puro, mai qui.
     */
    soglia: (adesso: Date) => string
    /**
     * Le colonne del percorso, IN ORDINE DI PRECEDENZA: si usa la prima valorizzata.
     * `student_documents` porta il percorso in `storage_path` **e** in `file_url`
     * (le righe più vecchie solo nella seconda): stessa regola di
     * `obliaFascicoloAlunno`, perché due letture dello stesso dato che scelgono
     * colonne diverse divergono in silenzio.
     */
    colonnePercorso: readonly string[]
    /**
     * LE TRE QUERY, scritte per tabella e col nome della tabella IN CHIARO: un
     * `from(variabile)` sarebbe invisibile ai lock che pretendono che ogni lettura
     * di `student_documents` dichiari cosa fa del cestino
     * (`@/lib/primaria/cestino-fascicolo`). Le condizioni sono le stesse per le due
     * tabelle, e le prove della suite le verificano su entrambe.
     *
     *  · `scadute`  — nel cestino E oltre la custodia (per la conservazione: caricate
     *                 oltre il termine, vive o cestinate), le più vecchie per prime;
     *  · `reclami`  — chi nomina questi percorsi, cestino COMPRESO;
     *  · `cancella` — per id, RIPETENDO le condizioni della lettura (regola 4).
     */
    scadute: (s: Supabase, soglia: string) => Lettura
    reclami: (s: Supabase, colonna: string, percorsi: string[]) => Lettura
    cancella: (s: Supabase, soglia: string, ids: string[]) => Cancellazione
}

/**
 * Chi nomina questi percorsi fra gli allegati del registro, cestino COMPRESO. Una
 * funzione sola per i due contenitori che toccano `registro-allegati` (cestino e
 * conservazione): la domanda è la stessa, e due copie divergerebbero in silenzio.
 */
const reclamiAllegatiRegistro = (s: Supabase, colonna: string, percorsi: string[]): Lettura =>
    allegatiRegistroAncheNelCestino(
        s.from('allegati_registro').select(`id, ${colonna}`).in(colonna, percorsi),
        'la domanda «un\'altra riga nomina ancora questo percorso?» deve vedere anche gli allegati ' +
            'nel CESTINO non ancora scaduti: reclamano il loro file finché sono ripristinabili, e ' +
            'filtrando i soli vivi la purga toglierebbe dal bucket il file di un allegato che il ' +
            'docente può ancora ripristinare.',
    )

const CONTENITORI_CESTINO_REGISTRO: readonly Contenitore[] = [
    {
        chiave: 'allegati',
        bucket: BUCKET_ALLEGATI_REGISTRO,
        giorni: GIORNI_CESTINO_REGISTRO,
        soglia: (adesso) => sogliaPurgaCestinoRegistro(adesso),
        colonnePercorso: ['file_url'],
        // Lettura DENTRO il cestino: è la purga, una delle due eccezioni della spec
        // alla regola «ogni lettura esclude il cestino».
        scadute: (s, soglia) =>
            allegatiRegistroNelCestino(s.from('allegati_registro').select('id, file_url'))
                .lt('eliminato_il', soglia)
                .order('eliminato_il', { ascending: true })
                .limit(TETTO_LOTTO),
        // Cestino COMPRESO: una riga cestinata e non ancora scaduta reclama il suo
        // file finché è ripristinabile (vedi la ragione scritta sul fascicolo, qui sotto).
        reclami: reclamiAllegatiRegistro,
        cancella: (s, soglia, ids) =>
            allegatiRegistroNelCestino(s.from('allegati_registro').delete({ count: 'exact' }))
                .lt('eliminato_il', soglia)
                .in('id', ids),
    },
    {
        // LA CONSERVAZIONE (decisione del titolare del 2026-09-25, regola 9): gli
        // allegati caricati oltre il termine, VIVI O NEL CESTINO. Stesso bucket e
        // stessa costante del contenitore qui sopra: chi carica, chi cestina e chi
        // conserva leggono tutti `BUCKET_ALLEGATI_REGISTRO`.
        chiave: 'conservazione',
        bucket: BUCKET_ALLEGATI_REGISTRO,
        giorni: GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
        soglia: (adesso) => sogliaConservazioneAllegatiRegistro(adesso),
        colonnePercorso: ['file_url'],
        scadute: (s, soglia) =>
            allegatiRegistroAncheNelCestino(
                s.from('allegati_registro').select('id, file_url'),
                'la conservazione conta dal CARICAMENTO e vale per vivi e cestinati insieme: decisione del ' +
                    'titolare del 2026-09-25, un allegato del registro si distrugge oltre il termine anche se ' +
                    'nessuno lo ha mai eliminato, e filtrare i soli vivi lascerebbe indietro quelli nel cestino.',
            )
                .lt('creato_il', soglia)
                .order('creato_il', { ascending: true })
                .limit(TETTO_LOTTO),
        reclami: reclamiAllegatiRegistro,
        // La `delete` ripete la condizione della lettura: una riga caricata DOPO la
        // soglia non è cancellabile da qui nemmeno se il suo id arrivasse per errore.
        cancella: (s, soglia, ids) =>
            allegatiRegistroAncheNelCestino(
                s.from('allegati_registro').delete({ count: 'exact' }),
                'la cancellazione per conservazione tocca vivi e cestinati: il termine del titolare del ' +
                    '2026-09-25 si misura sul caricamento, non sull\'eliminazione, e la condizione vera è ' +
                    'il creato_il oltre la soglia, ripetuta qui sotto nella stessa istruzione.',
            )
                .lt('creato_il', soglia)
                .in('id', ids),
    },
    {
        chiave: 'fascicolo',
        bucket: BUCKET_FASCICOLO,
        giorni: GIORNI_CESTINO_REGISTRO,
        soglia: (adesso) => sogliaPurgaCestinoRegistro(adesso),
        colonnePercorso: ['storage_path', 'file_url'],
        scadute: (s, soglia) =>
            fascicoloNelCestino(s.from('student_documents').select('id, storage_path, file_url'))
                .lt('eliminato_il', soglia)
                .order('eliminato_il', { ascending: true })
                .limit(TETTO_LOTTO),
        reclami: (s, colonna, percorsi) =>
            fascicoloAncheNelCestino(
                s.from('student_documents').select(`id, ${colonna}`).in(colonna, percorsi),
                'la domanda «un\'altra riga nomina ancora questo percorso?» deve vedere anche le righe nel ' +
                    'CESTINO non ancora scadute: reclamano il loro file finché sono ripristinabili, e filtrando ' +
                    'le sole vive la purga toglierebbe dal bucket il file di un documento che la segreteria può ' +
                    'ancora ripristinare — il «Ripristina» restituirebbe un documento che non c\'è più.',
            ),
        cancella: (s, soglia, ids) =>
            fascicoloNelCestino(s.from('student_documents').delete({ count: 'exact' }))
                .lt('eliminato_il', soglia)
                .in('id', ids),
    },
]

type EsitoContenitore = {
    esito:
        | 'ok'
        | 'colonne-cestino-assenti'
        | 'tabella-assente'
        | 'lettura-fallita'
        | 'reclami-non-letti'
        | 'file-non-rimossi'
        | 'cancellazione-fallita'
        | 'righe-trattenute'
    scadute: number
    cancellate: number
    trattenute: number
    senzaFile: number
    fileRimossi: number
    fileGiaAssenti: number
    fileBloccanti: number
    fileAncoraReclamati: number
    lottoPieno: boolean
    conteggioVerificato: boolean
}

const NIENTE: EsitoContenitore = {
    esito: 'ok',
    scadute: 0,
    cancellate: 0,
    trattenute: 0,
    senzaFile: 0,
    fileRimossi: 0,
    fileGiaAssenti: 0,
    fileBloccanti: 0,
    fileAncoraReclamati: 0,
    lottoPieno: false,
    conteggioVerificato: false,
}

/** Esiti che il giro dichiara GUASTO (500): righe oltre il termine rimaste in tabella. */
const ESITI_GUASTO = new Set<EsitoContenitore['esito']>([
    'lettura-fallita',
    'reclami-non-letti',
    'file-non-rimossi',
    'cancellazione-fallita',
    'righe-trattenute',
])
/** Esiti che dicono «qui non c'è un cestino da purgare» (503): DB non migrato. */
const ESITI_ASSENZA = new Set<EsitoContenitore['esito']>(['colonne-cestino-assenti', 'tabella-assente'])

type Riga = Record<string, unknown> & { id: string }

/** La prima colonna VALORIZZATA, non la prima colonna. */
function valorePercorso(r: Record<string, unknown>, colonne: readonly string[]): string {
    for (const c of colonne) {
        const v = r[c]
        if (typeof v === 'string' && v.trim().length > 0) return v.trim()
    }
    return ''
}

/**
 * Purga UN contenitore (tabella + bucket). Non lancia per gli errori di PostgREST
 * (li restituisce come esito); un'eccezione vera sale al `catch` della route.
 */
async function purgaContenitore(
    supabase: Supabase,
    c: Contenitore,
    soglia: string,
    canale: string,
): Promise<EsitoContenitore> {
    const esito: EsitoContenitore = { ...NIENTE }
    const base = { operazione: JOB, canale, tipo: c.chiave, bucket: c.bucket }

    // ── LE RIGHE SCADUTE ─────────────────────────────────────────────────────
    // Lettura di proposito DENTRO il cestino (è la purga: una delle due eccezioni
    // alla regola «ogni lettura esclude il cestino» della spec). Ordinate in modo
    // crescente sulla colonna del termine di QUESTO contenitore (`eliminato_il` per i
    // due cestini, `creato_il` per la conservazione): se il tetto taglia, taglia le
    // meno in ritardo.
    const { data, error } = await c.scadute(supabase, soglia)

    if (error) {
        const codice = codiceDi(error)
        if (CODICI_COLONNA_ASSENTE.has(codice) || CODICI_TABELLA_ASSENTE.has(codice)) {
            esito.esito = CODICI_COLONNA_ASSENTE.has(codice) ? 'colonne-cestino-assenti' : 'tabella-assente'
            logEvento('cron', 'warn', {
                ...base,
                esito: esito.esito,
                error_code: codice,
                msg:
                    `${JOB}: su questo database le colonne di questo contenitore non esistono (${codice}): ` +
                    `nessuna riga trattata, e non si finge il contrario`,
            })
            return esito
        }
        esito.esito = 'lettura-fallita'
        logEvento(
            'cron',
            'error',
            { ...base, esito: esito.esito, error_code: codice, msg: `${JOB}: lettura delle righe scadute non riuscita` },
            error,
        )
        return esito
    }

    const righe = ((data ?? []) as unknown as Record<string, unknown>[])
        .filter((r): r is Riga => typeof r.id === 'string' && r.id.length > 0)
    esito.scadute = righe.length
    esito.lottoPieno = righe.length >= TETTO_LOTTO
    if (esito.lottoPieno) {
        logEvento('cron', 'warn', {
            ...base,
            esito: 'lotto-pieno',
            n_righe: righe.length,
            msg: `${JOB}: lotto al tetto di ${TETTO_LOTTO} righe, il giro successivo riprende dalle più vecchie`,
        })
    }
    if (righe.length === 0) return esito

    // ── IL PERCORSO DI OGNI RIGA ─────────────────────────────────────────────
    // Tre casi, e non due: nessun file (la riga si cancella: è un indice che non
    // punta a niente e continua a dire «questo alunno ha una diagnosi»), un
    // percorso leggibile, un valore che NON è di questo bucket (la riga si
    // TRATTIENE: cancellarla perderebbe l'unica traccia di un file che non è nostro
    // da togliere). Misurato il 2026-09-25: in produzione zero righe con un URL.
    const perRiga = righe.map((r) => {
        const valore = valorePercorso(r, c.colonnePercorso)
        if (valore === '') return { id: r.id, percorso: null as string | null, illeggibile: false }
        const p = percorsoNelBucket(c.bucket, valore)
        return { id: r.id, percorso: p, illeggibile: p === null }
    })
    esito.senzaFile = perRiga.filter((r) => r.percorso === null && !r.illeggibile).length
    const illeggibili = perRiga.filter((r) => r.illeggibile)
    if (illeggibili.length > 0) {
        logEvento('cron', 'error', {
            ...base,
            esito: 'percorso-non-ricavabile',
            n_righe: illeggibili.length,
            msg:
                `${JOB}: ${illeggibili.length} righe scadute portano un riferimento che non è di questo bucket: ` +
                `NON si cancellano, perché cancellarle perderebbe l'unico riferimento a quel file`,
        })
    }

    const percorsi = [...new Set(perRiga.map((r) => r.percorso).filter((p): p is string => p !== null))]

    // ── CHI ALTRO RECLAMA QUESTI PERCORSI? ───────────────────────────────────
    // Tutte le righe della tabella, vive E nel cestino (una riga cestinata ma non
    // ancora scaduta reclama il suo file: è la condizione del «Ripristina»). Le
    // righe di QUESTO giro si escludono per id in memoria: sono loro che escono.
    const idsDelGiro = new Set(perRiga.map((r) => r.id))
    const reclamatiAltrove = new Set<string>()
    for (const colonna of c.colonnePercorso) {
        for (let i = 0; i < percorsi.length; i += LOTTO_IN) {
            const lotto = percorsi.slice(i, i + LOTTO_IN)
            const { data: reclami, error: erroreReclami } = await c.reclami(supabase, colonna, lotto)
            if (erroreReclami) {
                esito.esito = 'reclami-non-letti'
                esito.trattenute = righe.length
                logEvento(
                    'cron',
                    'error',
                    {
                        ...base,
                        esito: esito.esito,
                        error_code: codiceDi(erroreReclami),
                        n_file: percorsi.length,
                        n_righe_trattenute: esito.trattenute,
                        msg:
                            `${JOB}: non si è potuto sapere se un'altra riga nomini ancora questi file: ` +
                            `NESSUN file rimosso e NESSUNA riga cancellata in questo contenitore`,
                    },
                    erroreReclami,
                )
                return esito
            }
            for (const r of (reclami ?? []) as unknown as Record<string, unknown>[]) {
                const v = r[colonna]
                if (typeof r.id !== 'string' || typeof v !== 'string') continue
                if (!idsDelGiro.has(r.id)) reclamatiAltrove.add(v.trim())
            }
        }
    }

    const daTogliere = percorsi.filter((p) => !reclamatiAltrove.has(p))
    esito.fileAncoraReclamati = percorsi.length - daTogliere.length
    if (esito.fileAncoraReclamati > 0) {
        logEvento('cron', 'warn', {
            ...base,
            esito: 'file-ancora-reclamato',
            n_file: esito.fileAncoraReclamati,
            msg:
                `${JOB}: ${esito.fileAncoraReclamati} file NON si toccano perché un'altra riga li nomina ancora: ` +
                `le righe scadute si cancellano, i file restano a chi li reclama`,
        })
    }

    // ── PRIMA IL FILE ────────────────────────────────────────────────────────
    let rimozione: EsitoRimozione = {
        rimossi: [],
        giaAssenti: [],
        ancoraPresenti: [],
        incerti: [],
        erroreRimozione: false,
    }
    if (daTogliere.length > 0) {
        rimozione = await rimuoviEVerifica(supabase, c.bucket, daTogliere, JOB)
    }
    esito.fileRimossi = rimozione.rimossi.length
    esito.fileGiaAssenti = rimozione.giaAssenti.length

    // Chi trattiene la sua riga: tutti i file chiesti se la chiamata è fallita
    // (nessuno è uscito), altrimenti i soli bloccanti (ancora lì, o non si sa).
    const fermi = new Set(rimozione.erroreRimozione ? daTogliere : bloccanti(rimozione))
    esito.fileBloccanti = fermi.size
    const cancellabili = perRiga.filter((r) => !r.illeggibile && !(r.percorso !== null && fermi.has(r.percorso)))
    esito.trattenute = perRiga.length - cancellabili.length

    // ── POI LE RIGHE ─────────────────────────────────────────────────────────
    const ids = cancellabili.map((r) => r.id)
    let contate = 0
    let tuttiContati = true
    let raggiunte = 0
    for (let i = 0; i < ids.length; i += LOTTO_IN) {
        const lotto = ids.slice(i, i + LOTTO_IN)
        const { error: erroreDelete, count } = await c.cancella(supabase, soglia, lotto)
        if (erroreDelete) {
            // Si ferma al primo lotto che fallisce: le righe rimaste (col file già
            // uscito) le riprende il giro dopo, che troverà i file «già assenti».
            esito.esito = 'cancellazione-fallita'
            esito.trattenute += ids.length - raggiunte
            esito.cancellate = tuttiContati ? contate : raggiunte
            esito.conteggioVerificato = tuttiContati && raggiunte > 0
            logEvento(
                'cron',
                'error',
                {
                    ...base,
                    esito: esito.esito,
                    error_code: codiceDi(erroreDelete),
                    n_righe: esito.cancellate,
                    n_righe_trattenute: esito.trattenute,
                    n_file: esito.fileRimossi,
                    msg: `${JOB}: file rimossi ma righe NON cancellate: il giro successivo le riprende`,
                },
                erroreDelete,
            )
            return esito
        }
        raggiunte += lotto.length
        if (typeof count === 'number') contate += count
        else tuttiContati = false
    }
    esito.conteggioVerificato = tuttiContati && raggiunte > 0
    esito.cancellate = esito.conteggioVerificato ? contate : raggiunte

    if (esito.conteggioVerificato && esito.cancellate !== ids.length) {
        // Meno righe di quante nominate: sparite (o ripristinate) fra la lettura e la
        // cancellazione. Il fine è raggiunto; si dichiara il numero VERO.
        logEvento('cron', 'warn', {
            ...base,
            esito: 'conteggio-discorde',
            n_righe: esito.cancellate,
            n_righe_attese: ids.length,
            msg: `${JOB}: cancellate meno righe di quante ne erano state nominate; si dichiara il numero vero`,
        })
    }

    if (esito.trattenute > 0) {
        esito.esito = rimozione.erroreRimozione ? 'file-non-rimossi' : 'righe-trattenute'
        logEvento('cron', 'error', {
            ...base,
            esito: esito.esito,
            n_righe: esito.cancellate,
            n_righe_trattenute: esito.trattenute,
            n_file_bloccanti: esito.fileBloccanti,
            n_file_ancora_presenti: rimozione.ancoraPresenti.length,
            n_file_non_verificati: rimozione.incerti.length,
            msg: `${JOB}: ${esito.trattenute} righe scadute NON cancellate: il loro file è ancora nell'archivio, non verificabile o non riconoscibile`,
        })
        return esito
    }

    // Il SUCCESSO del contenitore si logga: è un evento critico (distrugge dati di
    // minori) e il battito, da solo, somma i tre contenitori.
    logEvento('cron', 'info', {
        ...base,
        esito: 'contenitore-purgato',
        n_righe: esito.cancellate,
        n_righe_senza_file: esito.senzaFile,
        n_file_rimossi: esito.fileRimossi,
        n_file_gia_assenti: esito.fileGiaAssenti,
        n_file_ancora_reclamati: esito.fileAncoraReclamati,
        conteggio_verificato: esito.conteggioVerificato,
        msg: `${JOB}: ${esito.cancellate} righe e ${esito.fileRimossi} file distrutti oltre i ${c.giorni} giorni`,
    })
    return esito
}

// POST /api/gdpr/retention-cestino-registro
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-cestino-registro:POST', async (request: NextRequest) => {
    const t0 = Date.now()
    let canale = 'cron'
    let esitoBattito = 'ok'
    const esiti: Record<ChiaveContenitore, EsitoContenitore> = {
        allegati: { ...NIENTE },
        conservazione: { ...NIENTE },
        fascicolo: { ...NIENTE },
    }

    try {
        const secret = request.headers.get('x-cron-secret')
        if (!segretoCronValido(secret)) {
            // Si grida solo se l'header c'è ma non torna: è un cron che bussa con la
            // chiave sbagliata, e smetterebbe di distruggere senza dirlo a nessuno.
            if (secret) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'secret-errato',
                    msg: process.env.CRON_SECRET
                        ? `${JOB}: x-cron-secret non corrispondente`
                        : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
                })
            }
            const auth = await requireStaff(request)
            if (auth.response) {
                esitoBattito = 'non-autorizzato'
                return auth.response
            }
            canale = 'manuale'
        }

        const supabase = await createAdminClient()
        // UN istante per tutto il giro: le soglie dei tre contenitori si calcolano
        // dallo stesso «adesso», ciascuna col suo termine.
        const adesso = new Date()

        for (const c of CONTENITORI_CESTINO_REGISTRO) {
            esiti[c.chiave] = await purgaContenitore(supabase, c, c.soglia(adesso), canale)
        }

        const lista = Object.values(esiti)
        const guasto = lista.find((e) => ESITI_GUASTO.has(e.esito))
        const assenza = lista.find((e) => ESITI_ASSENZA.has(e.esito))
        const corpo = {
            giorni: GIORNI_CESTINO_REGISTRO,
            giorni_conservazione: GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
            allegati: esiti.allegati,
            conservazione: esiti.conservazione,
            fascicolo: esiti.fascicolo,
        }

        if (guasto) {
            esitoBattito = guasto.esito
            return NextResponse.json({ ok: false, motivo: guasto.esito, ...corpo }, { status: 500 })
        }
        if (assenza) {
            esitoBattito = assenza.esito
            return NextResponse.json({ ok: false, motivo: assenza.esito, ...corpo }, { status: 503 })
        }
        return NextResponse.json({ ok: true, ...corpo })
    } catch (error) {
        esitoBattito = 'eccezione'
        logEvento(
            'cron',
            'error',
            { operazione: JOB, esito: esitoBattito, canale, ms: Date.now() - t0, msg: `${JOB}: eccezione non prevista` },
            error,
        )
        throw error
    } finally {
        // ── IL BATTITO ── SEMPRE, anche a zero, anche quando tutto è fallito.
        // `evento: 'cron'` e non `'gdpr'`: `controlloBattitoCron` (/api/health) legge
        // `.eq('evento','cron')` e conta solo `esito: 'ok'`.
        //
        // I totali (`n_righe`, `n_file_rimossi`, …) sommano i TRE contenitori; i conteggi
        // SEPARATI dicono quanto viene dal cestino (allegati + fascicolo, oltre i
        // giorni di custodia) e quanto dalla conservazione (allegati del registro
        // oltre i giorni dal caricamento): con la sola somma, «12 righe» non
        // distinguerebbe un cestino che si svuota da un archivio che scade.
        const a = esiti.allegati
        const k = esiti.conservazione
        const f = esiti.fascicolo
        const tutti = [a, k, f]
        const somma = (campo: 'scadute' | 'cancellate' | 'trattenute' | 'fileRimossi' | 'fileGiaAssenti' | 'fileBloccanti' | 'fileAncoraReclamati') =>
            tutti.reduce((n, e) => n + e[campo], 0)
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            giorni: GIORNI_CESTINO_REGISTRO,
            giorni_conservazione: GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
            n_cestino_scaduti: a.scadute + f.scadute,
            n_conservazione_scaduti: k.scadute,
            n_righe: somma('cancellate'),
            n_righe_trattenute: somma('trattenute'),
            n_file_rimossi: somma('fileRimossi'),
            n_file_gia_assenti: somma('fileGiaAssenti'),
            n_file_bloccanti: somma('fileBloccanti'),
            n_file_ancora_reclamati: somma('fileAncoraReclamati'),
            n_cestino_righe: a.cancellate + f.cancellate,
            n_cestino_file: a.fileRimossi + f.fileRimossi,
            n_conservazione_righe: k.cancellate,
            n_conservazione_file: k.fileRimossi,
            n_allegati_righe: a.cancellate,
            n_allegati_file: a.fileRimossi,
            n_fascicolo_righe: f.cancellate,
            n_fascicolo_file: f.fileRimossi,
            lotto_pieno: tutti.some((e) => e.lottoPieno),
            conteggio_verificato: tutti.every((e) => e.cancellate === 0 || e.conteggioVerificato),
            ms: Date.now() - t0,
            msg:
                `${JOB}: cestino ${a.cancellate + f.cancellate} righe e ${a.fileRimossi + f.fileRimossi} file ` +
                `oltre i ${GIORNI_CESTINO_REGISTRO} giorni; conservazione ${k.cancellate} righe e ${k.fileRimossi} ` +
                `file oltre i ${GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO} giorni dal caricamento`,
        })
    }
})
