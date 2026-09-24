import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'

/**
 * LA CONSERVAZIONE DEGLI ORIGINALI VIDEO, LA RICONCILIAZIONE E LA CODA DELLE
 * NOTIFICHE — un giro solo, ogni dieci minuti.
 *
 * ─── PERCHÉ ESISTE: UN ORIGINALE CHE NESSUNA QUERY VEDE ─────────────────────
 *
 * `video_jobs_retention_originali_idx` è un indice PARZIALE
 * (`20260916190000_video_jobs.sql:291`):
 *
 *     WHERE original_deleted_at IS NULL AND original_delete_after IS NOT NULL
 *
 * Una riga con `original_delete_after` a NULL non è «in ritardo»: è **fuori
 * dall'indice**. Il video di un bambino resta nel bucket privato `video_originals`
 * per sempre, e nessun conteggio lo nomina. Il difetto è già stato trovato e chiuso
 * una volta dentro `video_intent_supersede`
 * (`20260916190200_video_intent_lifecycle.sql:1044-1048`, «0 righe su 1»); questa
 * consegna chiude i due cammini che restavano — l'upload abbandonato e la coda
 * incagliata — e mette una rete sotto tutti i futuri. La logica sta nelle RPC, che
 * sono il posto in cui i vincoli della tabella si possono rispettare in una
 * transazione sola; qui c'è ciò che dal database non si può fare.
 *
 * ─── PERCHÉ UNA ROUTE HTTP E NON UNA FUNZIONE SQL ───────────────────────────
 *
 * Per la stessa ragione dei suoi tre gemelli (`retention-galleria`,
 * `retention-candidature`, `retention-personale`), e la ragione è misurata:
 * **i file si tolgono solo dalla Storage API**. Da Postgres non ci si arriva —
 * `storage.objects` ha il trigger `protect_objects_delete`, FOR EACH STATEMENT, che
 * scatta anche a zero righe (`42501`) — e comunque cancellare la riga di
 * `storage.objects` toglie l'indice, non il binario. Il lock
 * `__tests__/architecture/storage-delete-vietata-in-sql.test.ts` lo vieta per
 * iscritto.
 *
 * ─── LE SEI REGOLE, IN ORDINE DI IMPORTANZA ─────────────────────────────────
 *
 * 1. **PRIMA IL FILE, POI LA RIGA — e per riga, non per lotto.** È la regola di
 *    `rimozione-verificata.ts`. Al contrario, un errore a metà lascerebbe il video
 *    nel bucket con la riga che lo dichiara già rimosso: irraggiungibile, non
 *    cancellato, e nemmeno identificabile per cancellarlo se una famiglia lo
 *    chiedesse. Un file che non esce trattiene **la sua** riga, non le altre.
 *
 * 2. **UN ORIGINALE SI TOGLIE SOLO SE LA SUA SCADENZA È PASSATA, E LO RILEGGE IL
 *    DATABASE.** Qui si legge un elenco e si chiama lo Storage; fra le due cose
 *    passano secondi, e in quei secondi la riga può cambiare. Per questo il timbro
 *    non è un `update` di questa route ma `video_retention_originale_rimosso`, che
 *    rilegge la scadenza sotto lock e risponde `NON_ANCORA_SCADUTO` invece di
 *    obbedire. L'errore che quella guardia impedisce — timbrare come rimosso
 *    l'originale di un video che deve ancora essere convertito — è il più costoso
 *    di tutti, perché non è recuperabile.
 *
 * 3. **UN OGGETTO CHE UNA RIGA NOMINA ANCORA NON È UN ORFANO.** La spazzata del
 *    bucket parte da ciò che c'è nell'archivio e chiede al database chi lo reclama:
 *    è la direzione opposta alla purga, e senza la domanda cancellerebbe l'originale
 *    di un job vivo. In più c'è la grazia di 24 ore, perché un upload in corso è un
 *    oggetto che nessuno ha ancora finito di nominare.
 *
 * 4. **IL BATTITO SI SCRIVE SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
 *    FALLIRE.** Sta in un `finally`. Con i soli errori, «nessun log» non distingue
 *    «non c'era niente da togliere» da «il giro non parte più» — ed è l'ambiguità
 *    che in questo progetto ha nascosto per mesi il guasto delle email.
 *
 * 5. **RIGHE TRATTENUTE ⇒ 500.** Un `200` direbbe «fatto» a chi sorveglia il
 *    lavoro, e resterebbero video di minori nell'archivio oltre il termine, senza
 *    che nessuno lo sappia.
 *
 * 6. **NESSUN FILTRO DI SEDE, e non è una dimenticanza.** Un termine di
 *    conservazione non ha confini di plesso: l'originale di un video caricato a
 *    Giugliano scade lo stesso giorno di uno di Aversa e di uno di Cesa, e un
 *    `.in('scuola_id', plessi)` qui lascerebbe indietro i plessi che il job non
 *    conosce — IN SILENZIO, perché il conteggio nel battito direbbe comunque «ok».
 *    E non c'è nessun utente da cui derivare uno scope: la chiama `pg_net` con
 *    `x-cron-secret`.
 *
 * ─── COSA NON ENTRA NEI LOG, E QUI CONTA PIÙ CHE ALTROVE ────────────────────
 *
 * Niente percorsi, niente nomi di file, niente `source_mime`. Il percorso dentro
 * `video_originals` è la chiave con cui si firma il video di un bambino in un
 * bucket privato, cioè una credenziale. Da qui escono conteggi, uuid, date,
 * enumerati e codici d'errore, e basta.
 */

/** Il nome con cui questo lavoro si presenta in `app_log` e in `cron.job`. */
const JOB = 'video-retention'

/** Il magazzino privato degli originali, dichiarato da `20260916190000:366`. */
const BUCKET_ORIGINALI = 'video_originals'

/**
 * DOPO QUANTE ORE UN UPLOAD È ABBANDONATO.
 *
 * Quarantotto, e non ventiquattro come per gli orfani degli altri bucket. La
 * ragione è la portata del caricamento: qui si accettano originali fino a
 * 2.000.000.000 byte, TUS riprende un caricamento interrotto, e un genitore che
 * carica dalla rete di casa può cominciare la sera e finire il giorno dopo. La
 * finestra di ripresa di Supabase per un upload TUS è di 24 ore: quarantotto sono
 * DUE di quelle finestre, cioè un margine e non una stima.
 *
 * ⚠️ Il tetto vero è questa soglia PIÙ un giro di cron, cioè ~48 h e 10 minuti.
 * Con una corsa ogni dieci minuti lo scarto è trascurabile; diradando lo schedule
 * crescerebbe, e nessuna riga di testo lo direbbe.
 */
const ORE_UPLOAD_ABBANDONATO = 48

/**
 * DOPO QUANTE ORE UNA CONVERSIONE È INCAGLIATA.
 *
 * Sette giorni. Una conversione dura minuti — misurato in `docs/superpowers/plans/`:
 * il caso tipico sta fra 212 e 653 secondi secondo il numero di vCPU — quindi una
 * settimana non è una stima del tempo di lavoro: è il tempo che serve a un GUASTO
 * per essere notato e riparato. Sotto quella soglia si spegnerebbe una coda che è
 * solo in ritardo perché il runner è fermo per un rilascio andato male; sopra, si
 * terrebbero originali di minori per un lavoro che nessuno farà più.
 *
 * Sommato ai sette giorni di TTL che la dichiarazione assegna, un originale
 * incagliato vive al massimo quattordici giorni. `video_riconciliazione` conta la
 * coda in ritardo ogni dieci minuti: se questo numero comincia a pescare, l'allarme
 * era già suonato molto prima.
 */
const ORE_INCAGLIO = 7 * 24

/** Da quante ore un job in coda è «in ritardo» ai fini del solo conteggio. */
const ORE_RITARDO_CODA = 1

/**
 * La grazia sugli oggetti del bucket che nessuna riga nomina.
 *
 * Ventiquattro ore, la stessa di `ORE_GRAZIA_ORFANI` sulla galleria e di
 * `ORE_CURRICULUM_ORFANO` sulle candidature. Qui la protezione è doppia: un upload
 * in corso ha già la sua riga `awaiting_upload` — la crea `video_intent_open` PRIMA
 * che il primo byte parta — quindi il suo percorso è reclamato e non risulterebbe
 * orfano nemmeno senza la grazia. La grazia copre il caso in cui la riga non c'è
 * ancora perché la richiesta che la crea è a metà.
 */
const ORE_GRAZIA_ORFANI = 24

/** Quanti originali si trattano per giro, e quanti job si dichiarano conclusi. */
const TETTO_LOTTO = 200

/**
 * A quanti percorsi per volta si chiede al database «questo lo reclama qualcuno?».
 *
 * `.in()` finisce nella query string di PostgREST, e una `IN` con mille valori
 * produce un URL che nessuno garantisce venga accettato per intero. Cento è la
 * misura prudente su un lavoro che gira ogni dieci minuti.
 */
const LOTTO_RECLAMI = 100

/** Quanti oggetti si guardano per cartella, e quante cartelle per giro. */
const TETTO_VOCI_PER_CARTELLA = 1000

/**
 * QUANTO IN PROFONDITÀ SI SCENDE NEL BUCKET, e perché è una traversata e non un
 * prefisso.
 *
 * `spazzaMediaOrfani` sulla galleria sa che i percorsi sono `uploads/<uuid>/<nome>`
 * — è misurato in produzione, e la testata di quella route racconta che una copia
 * riga per riga dal gemello avrebbe guardato 37 cartelle senza riconoscere un solo
 * oggetto, riferendo «zero orfani» ogni notte: verde, e cieca.
 *
 * Qui quella misura NON si può fare: `video_originals` non esiste ancora in
 * produzione, e il percorso lo sceglierà la route di caricamento (V07), che non è
 * scritta. Scrivere un prefisso adesso sarebbe scrivere un'ipotesi, cioè
 * riprodurre di proposito il difetto appena citato. Quindi non c'è nessun prefisso:
 * si parte dalla radice e si SCENDE dove si trovano cartelle (`id === null`), fino
 * a questa profondità. Tre livelli coprono sia `<uuid>/file` sia
 * `originals/<uuid>/file`; una cartella trovata al livello più basso non viene
 * esplorata e il fatto si DICHIARA (`orfani_profondita_troncata`), perché un
 * troncamento silenzioso racconterebbe una pulizia che non è avvenuta.
 */
const PROFONDITA_MASSIMA = 3

/** Quante notifiche si prendono per giro, e per quanto si tiene la loro lease. */
const LOTTO_OUTBOX = 25
const LEASE_OUTBOX_SECONDI = 120

/** Lo Storage non risponde: l'esito è ignoto, e «non so» non è «non c'è». */
const NIENTE_DA_TOGLIERE: EsitoRimozione = {
    rimossi: [],
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
}

/**
 * I codici PostgREST che dicono «questo schema qui non c'è».
 *
 * Il database E2E della CI è un progetto separato e **non migrato**, e le quattro
 * migrazioni video sono dichiarate in `IN_CODA`: là dentro `video_jobs` non esiste
 * e le RPC nemmeno. Un `500` racconterebbe un guasto; un `200` racconterebbe «non
 * c'era niente da fare», che è un altro fatto. Si dichiara e si esce con un `503`.
 */
const CODICI_SCHEMA_ASSENTE = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])

function codiceDi(errore: unknown): string {
    const c = (errore as { code?: unknown } | null)?.code
    return typeof c === 'string' && c.length > 0 ? c : 'sconosciuto'
}

function schemaAssente(errore: unknown): boolean {
    return CODICI_SCHEMA_ASSENTE.has(codiceDi(errore))
}

type Supa = Awaited<ReturnType<typeof createAdminClient>>

/** Il risultato di una RPC del gruppo video: `{ ok }` più i suoi conteggi. */
type EsitoRpc = { ok?: boolean; code?: string } & Record<string, unknown>

function numero(esito: EsitoRpc | null, chiave: string): number {
    const v = esito?.[chiave]
    return typeof v === 'number' ? v : 0
}

/** Una riga di `video_jobs` per ciò che serve a questa route, e niente di più. */
type RigaJob = { id: string; original_path: string }

// ═══════════════════════════════════════════════════════════════════════════════
// LA SPAZZATA DEGLI ORFANI — dal bucket al database, che è la direzione opposta
// ═══════════════════════════════════════════════════════════════════════════════

type EsitoSpazzata = {
    esito: string
    esaminati: number
    reclamati: number
    rimossi: number
    troncato: boolean
    profonditaTroncata: boolean
}

const SPAZZATA_NON_ESEGUITA: EsitoSpazzata = {
    esito: 'non-eseguita',
    esaminati: 0,
    reclamati: 0,
    rimossi: 0,
    troncato: false,
    profonditaTroncata: false,
}

/**
 * Tutti gli oggetti del bucket, scendendo nelle cartelle fino a
 * `PROFONDITA_MASSIMA`. Restituisce i percorsi completi e i due fatti che rendono
 * il conteggio leggibile: se un elenco era pieno (troncato) e se una cartella è
 * rimasta inesplorata (profondità).
 */
async function elencaOggetti(
    supabase: Supa,
    nato_prima_di: Date,
): Promise<{ percorsi: string[]; troncato: boolean; profonditaTroncata: boolean; errore: unknown }> {
    const percorsi: string[] = []
    let troncato = false
    let profonditaTroncata = false
    let daVisitare: { prefisso: string; livello: number }[] = [{ prefisso: '', livello: 1 }]

    while (daVisitare.length > 0) {
        const { prefisso, livello } = daVisitare.shift()!
        const { data, error } = await supabase.storage
            .from(BUCKET_ORIGINALI)
            .list(prefisso, { limit: TETTO_VOCI_PER_CARTELLA })
        if (error) return { percorsi, troncato, profonditaTroncata, errore: error }

        const voci = Array.isArray(data) ? data : []
        if (voci.length >= TETTO_VOCI_PER_CARTELLA) troncato = true

        for (const voce of voci as { name?: string; id?: string | null; created_at?: string }[]) {
            const nome = typeof voce?.name === 'string' ? voce.name : ''
            if (nome.length === 0) continue
            const completo = prefisso.length > 0 ? `${prefisso}/${nome}` : nome

            // `id === null` è la firma di una CARTELLA nella Storage API: non è un
            // oggetto, e trattarla come tale è il difetto che la galleria ha pagato.
            if (voce?.id === null || voce?.id === undefined) {
                if (livello >= PROFONDITA_MASSIMA) profonditaTroncata = true
                else daVisitare = [...daVisitare, { prefisso: completo, livello: livello + 1 }]
                continue
            }

            // La grazia: un oggetto giovane può essere un caricamento la cui riga sta
            // ancora nascendo. Una data illeggibile vale come «giovane», perché nel
            // dubbio non si distrugge il video di un bambino.
            const nato = Date.parse(voce?.created_at ?? '')
            if (!Number.isFinite(nato) || nato > nato_prima_di.getTime()) continue

            percorsi.push(completo)
        }
    }

    return { percorsi, troncato, profonditaTroncata, errore: null }
}

/**
 * Toglie dal bucket gli oggetti che NESSUNA riga di `video_jobs` nomina.
 *
 * Non lancia mai: ogni ramo cattura e riferisce, così il chiamante non ha bisogno
 * di un `try` attorno e un guasto qui non impedisce al battito di essere scritto.
 */
async function spazzaOriginaliOrfani(supabase: Supa, adesso: Date): Promise<EsitoSpazzata> {
    const soglia = new Date(adesso.getTime() - ORE_GRAZIA_ORFANI * 3_600_000)
    const { percorsi, troncato, profonditaTroncata, errore } = await elencaOggetti(supabase, soglia)

    if (errore) {
        logEvento(
            'cron',
            'error',
            { operazione: JOB, esito: 'orfani-elenco-fallito', n_file: percorsi.length },
            errore,
        )
        return { ...SPAZZATA_NON_ESEGUITA, esito: 'elenco-fallito', troncato, profonditaTroncata }
    }
    if (percorsi.length === 0) {
        return { esito: 'ok', esaminati: 0, reclamati: 0, rimossi: 0, troncato, profonditaTroncata }
    }

    // LA DOMANDA AL DATABASE, a lotti: «quali di questi percorsi sono reclamati da
    // una riga?». Senza, si cancellerebbe l'originale di un job vivo.
    const reclamati = new Set<string>()
    for (let i = 0; i < percorsi.length; i += LOTTO_RECLAMI) {
        const lotto = percorsi.slice(i, i + LOTTO_RECLAMI)
        const { data, error } = await supabase
            .from('video_jobs')
            .select('original_path')
            .eq('original_bucket', BUCKET_ORIGINALI)
            .in('original_path', lotto)
        if (error) {
            // PostgREST non lancia: ritorna `{ error }`. Un `try` attorno non
            // scatterebbe mai, e senza questo controllo si andrebbe avanti a
            // cancellare avendo per risposta «nessuno lo reclama» — che qui
            // significa distruggere il video di un bambino il cui job è vivo.
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'orfani-reclami-falliti',
                    error_code: codiceDi(error),
                    n_file: lotto.length,
                },
                error,
            )
            return { ...SPAZZATA_NON_ESEGUITA, esito: 'reclami-falliti', troncato, profonditaTroncata }
        }
        for (const riga of (data ?? []) as { original_path?: unknown }[]) {
            if (typeof riga?.original_path === 'string') reclamati.add(riga.original_path)
        }
    }

    const orfani = percorsi.filter((p) => !reclamati.has(p))
    if (orfani.length === 0) {
        return {
            esito: 'ok',
            esaminati: percorsi.length,
            reclamati: reclamati.size,
            rimossi: 0,
            troncato,
            profonditaTroncata,
        }
    }

    const esito = await rimuoviEVerifica(supabase, BUCKET_ORIGINALI, orfani, JOB)
    const restano = bloccanti(esito)
    if (restano.length > 0) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'orfani-non-rimossi',
            n_file: restano.length,
            msg: `${JOB}: ${restano.length} oggetti orfani di ${BUCKET_ORIGINALI} non sono usciti dall'archivio`,
        })
    }
    return {
        esito: restano.length > 0 ? 'parziale' : 'ok',
        esaminati: percorsi.length,
        reclamati: reclamati.size,
        rimossi: esito.rimossi.length + esito.giaAssenti.length,
        troncato,
        profonditaTroncata,
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LA CODA DELLE NOTIFICHE — `video_outbox`, e chi la consuma
// ═══════════════════════════════════════════════════════════════════════════════

type EventoOutbox = {
    id: string
    intent_id: string
    revision: number
    event_type: string
    attempts: number
}

type EsitoConsegna = { consegnato: boolean; codice?: string }

/**
 * I DESTINATARI DEGLI EVENTI, uno per tipo.
 *
 * ─── PERCHÉ UN REGISTRO E NON UNO `switch` ─────────────────────────────────
 *
 * Perché il caso che conta non è quello noto: è il tipo SENZA destinatario. La
 * testata di `video_outbox_fail`
 * (`20260916190200_video_intent_lifecycle.sql:1430-1448`) racconta la misura che
 * l'ha scritta: venticinque tentativi bruciati in sedici millisecondi, e l'evento
 * che dice «aggancia questo video alla sua News» non riprovato mai più. Qui un tipo
 * sconosciuto viene messo in attesa con il suo backoff e **gridato** (`error`), non
 * cancellato e non dichiarato inviato. Poi, a venticinque tentativi, va in
 * quarantena — e `video_riconciliazione` la conta, così «nessuno lo consegnerà mai»
 * è un numero e non una scoperta.
 *
 * ─── I TRE TIPI CHE ESISTONO OGGI ──────────────────────────────────────────
 *
 * `intent.superseded` e `intent.revoked` li emette il database
 * (`20260916190200_video_intent_lifecycle.sql`, gli INSERT in `video_outbox` di
 * `:1093` e `:1242`), e il loro effetto POST-COMMIT è scritto accanto
 * all'emissione: «la revisione superata porta con sé i propri originali, che nessuno
 * pubblicherà più: **la retention deve saperlo**, o quei file restano sette giorni
 * in più di quanto serva». Il destinatario di quei due eventi, quindi, è questo
 * stesso giro — e la consegna è la RICEVUTA: si verifica che ogni job di
 * quell'intent abbia davvero una scadenza, cioè che l'effetto dichiarato dentro la
 * transazione sia sopravvissuto al commit. Se non ce l'ha, l'evento NON è
 * consegnato: si riprova, e il codice dice cosa cercare.
 *
 * `gallery.published` lo scrive `POST /api/gallery` (V08) attraverso
 * `video_intent_finalize`. Fino al 2026-09-24 qui non aveva un destinatario: dal
 * 18 al 23/09 tredici eventi hanno gridato `outbox-senza-destinatario` a ogni giro
 * e sono finiti in quarantena (`attempts` 25) con `DESTINATARIO_ASSENTE`. La
 * sessione che rilascia questa correzione li rimette in circolo una volta, a mano
 * (consegna 2b, D14).
 *
 * ⚠️ QUANDO V09 AGGIUNGERÀ `news.published` E GLI ALTRI, il posto in cui scrivere il
 * loro destinatario è questo oggetto, una riga per tipo. Finché non c'è, quel tipo
 * grida a ogni giro invece di essere consegnato per finta — e il lock di famiglia in
 * `__tests__/api/gdpr-retention-video.test.ts` diventa rosso appena qualcuno lo
 * scrive in `video_outbox` con un letterale.
 */
const DESTINATARI: Record<string, (supabase: Supa, evento: EventoOutbox) => Promise<EsitoConsegna>> = {
    'intent.superseded': ricevutaRetention,
    'intent.revoked': ricevutaRetention,
    // V08 (`src/app/api/gallery/route.ts`, la RPC che accoda questo tipo). La
    // notifica ai genitori parte già SINCRONA in quella richiesta: un secondo avviso
    // da qui sarebbe un doppione. L'effetto dopo il commit che resta è la retention:
    // `video_intent_finalize` pubblica solo con tutti i job `ready` e verificati, e
    // un job `ready` ha per vincolo la scadenza dell'originale
    // (`video_jobs_ready_chk`). La ricevuta lo verifica.
    'gallery.published': ricevutaRetention,
}

/**
 * La ricevuta della retention: ogni job dell'intent dell'evento ha una scadenza, o
 * è già uscito.
 *
 * `head: true` con `count: 'exact'`: si chiede un NUMERO, non le righe. Da questa
 * query non esce nessun percorso e nessun mime — sono video di minori, e un elenco
 * che non serve è un elenco che può finire in un log.
 */
async function ricevutaRetention(supabase: Supa, evento: EventoOutbox): Promise<EsitoConsegna> {
    const { count, error } = await supabase
        .from('video_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('intent_id', evento.intent_id)
        .is('original_delete_after', null)
        .is('original_deleted_at', null)

    if (error) {
        logEvento(
            'cron',
            'error',
            { operazione: JOB, esito: 'outbox-ricevuta-fallita', error_code: codiceDi(error) },
            error,
        )
        return { consegnato: false, codice: 'RICEVUTA_NON_LETTA' }
    }
    if ((count ?? 0) > 0) {
        // L'effetto dichiarato dentro la transazione non c'è: quei job sono
        // invisibili all'indice della retention. Non si consegna, e il giro
        // successivo — dopo `video_retention_scadenze` — troverà la rete già tesa.
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'outbox-originali-senza-scadenza',
            intent_id: evento.intent_id,
            n_righe: count ?? 0,
            msg: `${JOB}: l'intent dell'evento ha ancora job senza scadenza dell'originale`,
        })
        return { consegnato: false, codice: 'ORIGINALI_SENZA_SCADENZA' }
    }
    return { consegnato: true }
}

type EsitoOutbox = {
    esito: string
    presi: number
    inviati: number
    falliti: number
    senzaDestinatario: number
}

const OUTBOX_NON_ESEGUITO: EsitoOutbox = {
    esito: 'non-eseguito',
    presi: 0,
    inviati: 0,
    falliti: 0,
    senzaDestinatario: 0,
}

/**
 * Svuota `video_outbox` chiamando le tre RPC che esistono già —
 * `video_outbox_claim`, `video_outbox_sent`, `video_outbox_fail` — senza
 * riscriverne nessuna: la lease, il backoff e la quarantena sono decisioni del
 * database, e due copie della stessa decisione divergono il giorno in cui qualcuno
 * ne corregge una sola.
 *
 * Non lancia mai: ogni ramo cattura e riferisce.
 */
async function svuotaOutbox(supabase: Supa): Promise<EsitoOutbox> {
    const proprietario = crypto.randomUUID()
    const { data, error } = await supabase.rpc('video_outbox_claim', {
        p_lease_owner: proprietario,
        p_lease_seconds: LEASE_OUTBOX_SECONDI,
        p_limite: LOTTO_OUTBOX,
    })

    if (error) {
        logEvento(
            'cron',
            schemaAssente(error) ? 'warn' : 'error',
            { operazione: JOB, esito: 'outbox-claim-fallito', error_code: codiceDi(error) },
            error,
        )
        return { ...OUTBOX_NON_ESEGUITO, esito: schemaAssente(error) ? 'schema-assente' : 'claim-fallito' }
    }

    const risposta = (data ?? null) as EsitoRpc | null
    if (risposta?.ok !== true) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'outbox-claim-rifiutato',
            error_code: typeof risposta?.code === 'string' ? risposta.code : 'sconosciuto',
            msg: `${JOB}: video_outbox_claim ha rifiutato la richiesta`,
        })
        return { ...OUTBOX_NON_ESEGUITO, esito: 'claim-rifiutato' }
    }

    const eventi = Array.isArray(risposta.eventi) ? (risposta.eventi as EventoOutbox[]) : []
    let inviati = 0
    let falliti = 0
    let senzaDestinatario = 0

    for (const evento of eventi) {
        const destinatario = DESTINATARI[evento.event_type]
        let consegna: EsitoConsegna
        if (destinatario === undefined) {
            senzaDestinatario += 1
            // Configurazione mancante = livello `error`, mai `info` (AGENTS.md,
            // regola 4). Un evento che nessuno sa consegnare è esattamente questo:
            // un pezzo di configurazione che manca, e che a venticinque tentativi
            // porterà l'evento in quarantena per sempre.
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'outbox-senza-destinatario',
                intent_id: evento.intent_id,
                n_tentativi: evento.attempts,
                msg: `${JOB}: nessun destinatario per un evento di video_outbox; alla venticinquesima prova finirà in quarantena`,
            })
            consegna = { consegnato: false, codice: 'DESTINATARIO_ASSENTE' }
        } else {
            consegna = await destinatario(supabase, evento)
        }

        const rpc = consegna.consegnato ? 'video_outbox_sent' : 'video_outbox_fail'
        const argomenti = consegna.consegnato
            ? { p_evento_id: evento.id, p_lease_owner: proprietario }
            : {
                  p_evento_id: evento.id,
                  p_lease_owner: proprietario,
                  p_error_code: consegna.codice ?? 'CONSEGNA_FALLITA',
              }
        const { data: esitoRpc, error: erroreRpc } = await supabase.rpc(rpc, argomenti)

        if (erroreRpc) {
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'outbox-chiusura-fallita',
                    error_code: codiceDi(erroreRpc),
                    intent_id: evento.intent_id,
                },
                erroreRpc,
            )
            falliti += 1
            continue
        }
        if ((esitoRpc as EsitoRpc | null)?.ok !== true) {
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'outbox-chiusura-rifiutata',
                error_code:
                    typeof (esitoRpc as EsitoRpc | null)?.code === 'string'
                        ? ((esitoRpc as EsitoRpc).code as string)
                        : 'sconosciuto',
                intent_id: evento.intent_id,
                msg: `${JOB}: la RPC di chiusura dell'evento ha rifiutato`,
            })
            falliti += 1
            continue
        }

        if (consegna.consegnato) inviati += 1
        else falliti += 1
    }

    // Gli eventi critici loggano anche il SUCCESSO: a zero, questo `info` è la sola
    // differenza fra «coda vuota» e «non si drena più».
    logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'outbox-svuotato',
        n_righe: eventi.length,
        n_inviati: inviati,
        n_falliti: falliti,
        n_senza_destinatario: senzaDestinatario,
    })

    return { esito: 'ok', presi: eventi.length, inviati, falliti, senzaDestinatario }
}

// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/gdpr/retention-video
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-video:POST', async (request: NextRequest) => {
    const t0 = Date.now()
    let canale = 'cron'

    // ── I CONTATORI DEL BATTITO ──
    // Vivono QUI, fuori da ogni ramo che può fallire, e si scrivono nel `finally`.
    let esitoBattito = 'ok'
    let nAbbandonati = 0
    let nIncagliati = 0
    let nSenzaScadenza = 0
    let nScaduti = 0
    let nTimbrati = 0
    let nTrattenuti = 0
    let lottoPieno = false
    let rimozione: EsitoRimozione = NIENTE_DA_TOGLIERE
    let spazzata: EsitoSpazzata = SPAZZATA_NON_ESEGUITA
    let outbox: EsitoOutbox = OUTBOX_NON_ESEGUITO
    let conti: EsitoRpc | null = null

    try {
        const secret = request.headers.get('x-cron-secret')
        const isCron = segretoCronValido(secret)
        if (!isCron) {
            // Si grida solo se l'header c'è ma non torna: quello è un cron che bussa
            // con la chiave sbagliata, ed è il guasto invisibile — smette di
            // distruggere e non lo dice a nessuno. Se manca del tutto è lo staff che
            // lancia il giro a mano, e il gate qui sotto è il suo.
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
        const adesso = new Date()

        // ── 1. LE SCADENZE ──────────────────────────────────────────────────
        //
        // Prima di tutto, e non per abitudine: è il passo che toglie le righe
        // dall'invisibilità. Un originale senza `original_delete_after` non comparirà
        // nell'elenco del passo 2 nemmeno fra dieci anni.
        const { data: datiScadenze, error: erroreScadenze } = await supabase.rpc(
            'video_retention_scadenze',
            {
                p_ore_upload: ORE_UPLOAD_ABBANDONATO,
                p_ore_incaglio: ORE_INCAGLIO,
                p_limite: TETTO_LOTTO,
            },
        )

        if (erroreScadenze && schemaAssente(erroreScadenze)) {
            // Il database E2E della CI non è migrato, e le quattro migrazioni video
            // sono in `IN_CODA`: là non c'è nessuna pipeline video da conservare. Si
            // dichiara e si esce — un `200` qui direbbe «niente da togliere», che è
            // un altro fatto.
            esitoBattito = 'schema-assente'
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                error_code: codiceDi(erroreScadenze),
                ms: Date.now() - t0,
                msg: `${JOB}: lo schema video non esiste su questo database, nessun originale trattato, e non si finge il contrario`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codiceDi(erroreScadenze) },
                { status: 503 },
            )
        }
        if (erroreScadenze) {
            esitoBattito = 'scadenze-fallite'
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    error_code: codiceDi(erroreScadenze),
                    ms: Date.now() - t0,
                    msg: `${JOB}: video_retention_scadenze non ha risposto, gli originali restano invisibili alla conservazione`,
                },
                erroreScadenze,
            )
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codiceDi(erroreScadenze) },
                { status: 500 },
            )
        }

        const scadenze = (datiScadenze ?? null) as EsitoRpc | null
        if (scadenze?.ok !== true) {
            esitoBattito = 'scadenze-rifiutate'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                error_code: typeof scadenze?.code === 'string' ? scadenze.code : 'sconosciuto',
                ms: Date.now() - t0,
                msg: `${JOB}: video_retention_scadenze ha rifiutato gli argomenti`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: scadenze?.code ?? 'sconosciuto' },
                { status: 500 },
            )
        }
        nAbbandonati = numero(scadenze, 'abbandonati')
        nIncagliati = numero(scadenze, 'incagliati')
        nSenzaScadenza = numero(scadenze, 'senza_scadenza')

        if (nSenzaScadenza > 0) {
            // La rete ha pescato. Significa che un cammino nuovo conclude un job
            // senza dargli una scadenza: qui è stato tappato, ma il cammino resta da
            // trovare, e questo è l'unico posto da cui si può sapere che esiste.
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'conclusi-senza-scadenza',
                canale,
                n_righe: nSenzaScadenza,
                msg: `${JOB}: ${nSenzaScadenza} job conclusi erano senza scadenza dell'originale: un cammino nuovo li ha chiusi senza dargliene una`,
            })
        }

        // ── 2. GLI ORIGINALI SCADUTI ────────────────────────────────────────
        //
        // L'elenco esce dall'indice parziale `video_jobs_retention_originali_idx`,
        // ordinato per scadenza crescente: se il tetto taglia, deve tagliare i meno
        // in ritardo.
        const { data: datiScaduti, error: erroreScaduti } = await supabase
            .from('video_jobs')
            .select('id, original_path')
            .eq('original_bucket', BUCKET_ORIGINALI)
            .is('original_deleted_at', null)
            .not('original_delete_after', 'is', null)
            .lte('original_delete_after', adesso.toISOString())
            .order('original_delete_after', { ascending: true })
            .limit(TETTO_LOTTO)

        if (erroreScaduti) {
            // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo si
            // proseguirebbe con un elenco vuoto, e il battito direbbe «zero originali
            // scaduti» invece di «non ho potuto chiedere».
            esitoBattito = schemaAssente(erroreScaduti) ? 'schema-assente' : 'lettura-fallita'
            logEvento(
                'cron',
                schemaAssente(erroreScaduti) ? 'warn' : 'error',
                {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    error_code: codiceDi(erroreScaduti),
                    ms: Date.now() - t0,
                    msg: `${JOB}: lettura degli originali scaduti non riuscita`,
                },
                erroreScaduti,
            )
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codiceDi(erroreScaduti) },
                { status: schemaAssente(erroreScaduti) ? 503 : 500 },
            )
        }

        const scaduti = (datiScaduti ?? []) as unknown as RigaJob[]
        nScaduti = scaduti.length
        lottoPieno = nScaduti >= TETTO_LOTTO

        if (nScaduti > 0) {
            // PRIMA IL FILE. `rimuoviEVerifica` verifica lo STATO di ciò che non
            // risulta uscito, invece di contare: «non c'è più» è l'esito voluto,
            // «c'è ancora» e «non so» sono guasti.
            rimozione = await rimuoviEVerifica(
                supabase,
                BUCKET_ORIGINALI,
                scaduti.map((r) => r.original_path),
                JOB,
            )
            const restano = new Set(bloccanti(rimozione))

            // POI LA RIGA, e per riga: un file che non esce trattiene la SUA riga,
            // non quelle degli altri.
            for (const riga of scaduti) {
                if (restano.has(riga.original_path)) {
                    nTrattenuti += 1
                    continue
                }
                const { data: esitoTimbro, error: erroreTimbro } = await supabase.rpc(
                    'video_retention_originale_rimosso',
                    { p_job_id: riga.id },
                )
                if (erroreTimbro) {
                    logEvento(
                        'cron',
                        'error',
                        {
                            operazione: JOB,
                            esito: 'timbro-fallito',
                            canale,
                            error_code: codiceDi(erroreTimbro),
                            job_id: riga.id,
                        },
                        erroreTimbro,
                    )
                    nTrattenuti += 1
                    continue
                }
                if ((esitoTimbro as EsitoRpc | null)?.ok !== true) {
                    // Il file è uscito e la riga non lo sa: il giro dopo la
                    // riprenderà e lo Storage risponderà «già assente», che NON è un
                    // guasto. Ma il fatto si grida adesso, perché l'unico modo di
                    // arrivare qui è che la scadenza sia cambiata sotto i piedi.
                    logEvento('cron', 'error', {
                        operazione: JOB,
                        esito: 'timbro-rifiutato',
                        canale,
                        job_id: riga.id,
                        error_code:
                            typeof (esitoTimbro as EsitoRpc | null)?.code === 'string'
                                ? ((esitoTimbro as EsitoRpc).code as string)
                                : 'sconosciuto',
                        msg: `${JOB}: il file è uscito dall'archivio ma la riga non ha accettato il timbro`,
                    })
                    nTrattenuti += 1
                    continue
                }
                nTimbrati += 1
            }
        }

        if (nTrattenuti > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto. Un
            // `200` direbbe «fatto» a chi sorveglia, e resterebbero originali di
            // video di minori nell'archivio oltre il termine, senza che nessuno lo
            // sappia.
            esitoBattito = 'originali-trattenuti'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_righe: nTimbrati,
                n_righe_trattenute: nTrattenuti,
                n_file_ancora_presenti: rimozione.ancoraPresenti.length,
                n_file_non_verificati: rimozione.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${nTrattenuti} originali NON tolti dall'archivio o non timbrati`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                    // risposta: chi legge deve poter distinguere un archivio che non
                    // risponde da un file che non esce.
                    motivo:
                        rimozione.ancoraPresenti.length > 0 ? 'file-non-rimossi' : 'verifica-non-riuscita',
                    originali_scaduti: nScaduti,
                    originali_rimossi: nTimbrati,
                    originali_trattenuti: nTrattenuti,
                },
                { status: 500 },
            )
        }

        // ── 3. GLI ORFANI DEL BUCKET ────────────────────────────────────────
        // In coda al percorso felice, e non prima: togliere ciò che ha una scadenza
        // è la promessa, spazzare ciò che nessuno nomina è manutenzione. Non lancia
        // mai, quindi non serve un `try` attorno.
        spazzata = await spazzaOriginaliOrfani(supabase, adesso)

        // ── 4. LA RICONCILIAZIONE ───────────────────────────────────────────
        // Sola lettura: conta, e non aggiusta. Un conteggio che sistema quel che
        // conta non distingue più il guasto dall'assenza di guasto.
        const { data: datiConti, error: erroreConti } = await supabase.rpc('video_riconciliazione', {
            p_ore_upload: ORE_UPLOAD_ABBANDONATO,
            p_ore_incaglio: ORE_INCAGLIO,
            p_ore_ritardo: ORE_RITARDO_CODA,
        })
        if (erroreConti) {
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'riconciliazione-fallita',
                    canale,
                    error_code: codiceDi(erroreConti),
                },
                erroreConti,
            )
        } else {
            conti = (datiConti ?? null) as EsitoRpc | null
            if (numero(conti, 'outbox_in_quarantena') > 0) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'outbox-in-quarantena',
                    canale,
                    n_righe: numero(conti, 'outbox_in_quarantena'),
                    msg: `${JOB}: eventi di video_outbox oltre i 25 tentativi: nessuno li riprenderà più`,
                })
            }
            if (numero(conti, 'conclusi_senza_scadenza') > 0) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'invisibili-residui',
                    canale,
                    n_righe: numero(conti, 'conclusi_senza_scadenza'),
                    msg: `${JOB}: job conclusi ancora senza scadenza DOPO il passaggio della rete: il tetto del lotto non basta`,
                })
            }
        }

        // ── 5. LA CODA DELLE NOTIFICHE ──────────────────────────────────────
        outbox = await svuotaOutbox(supabase)

        return NextResponse.json({
            ok: true,
            giorni_ttl: 7,
            abbandonati: nAbbandonati,
            incagliati: nIncagliati,
            conclusi_senza_scadenza: nSenzaScadenza,
            originali_scaduti: nScaduti,
            originali_rimossi: nTimbrati,
            originali_gia_assenti: rimozione.giaAssenti.length,
            // Il lotto tagliato si dichiara: chi lancia il giro a mano deve sapere se
            // richiamarlo, e non deve dedurlo da un conteggio.
            lotto_pieno: lottoPieno,
            orfani_esito: spazzata.esito,
            orfani_esaminati: spazzata.esaminati,
            orfani_rimossi: spazzata.rimossi,
            orfani_elenco_troncato: spazzata.troncato,
            orfani_profondita_troncata: spazzata.profonditaTroncata,
            outbox_esito: outbox.esito,
            outbox_presi: outbox.presi,
            outbox_inviati: outbox.inviati,
            outbox_falliti: outbox.falliti,
            outbox_senza_destinatario: outbox.senzaDestinatario,
            riconciliazione: conti ?? null,
        })
    } catch (error) {
        // `withRoute` NON vede le eccezioni che qualcun altro cattura, ma vede quelle
        // rilanciate. Il log qui serve comunque: è l'unico che porta l'`operazione` e
        // i conteggi parziali, cioè l'unico da cui si capisce DOVE si è fermato.
        esitoBattito = 'eccezione'
        logEvento(
            'cron',
            'error',
            {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_righe: nTimbrati,
                ms: Date.now() - t0,
                msg: `${JOB}: eccezione non prevista`,
            },
            error,
        )
        throw error
    } finally {
        // ── IL BATTITO ──
        // SEMPRE, anche a zero, anche quando tutto è fallito.
        //
        // ⚠️ `evento: 'cron'`, NON `'gdpr'`, e la differenza non è di gusto:
        // `controlloBattitoCron` (`/api/health`) legge `app_log` con
        // `.eq('evento','cron')` e conta solo i battiti con `esito: 'ok'`. Un battito
        // scritto guardando alla NATURA DEL DATO trattato (`gdpr`) invece che alla
        // natura del SEGNALE non lo trova nessuno — è il difetto misurato in
        // produzione il 2026-08-02 su `presenze-giustificazioni-retention`.
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            n_abbandonati: nAbbandonati,
            n_incagliati: nIncagliati,
            n_conclusi_senza_scadenza: nSenzaScadenza,
            n_originali_scaduti: nScaduti,
            n_originali_rimossi: nTimbrati,
            n_originali_trattenuti: nTrattenuti,
            n_orfani_rimossi: spazzata.rimossi,
            n_outbox_presi: outbox.presi,
            n_outbox_inviati: outbox.inviati,
            n_outbox_senza_destinatario: outbox.senzaDestinatario,
            // ⚠️ IL BUCO DICHIARATO, e sta nel battito perché è l'unico posto che
            // resta interrogabile in SQL per trenta giorni. Nessun termine governa
            // l'uscita di un job concluso dentro `video_processing`: lo schema non ha
            // un `output_delete_after`, e questa consegna non lo inventa — un termine
            // scritto qui distruggerebbe l'uscita di un job `ready` che il finalizer
            // (V08/V09, non ancora scritto) deve ancora copiare nel bucket del
            // dominio. Il numero esce lo stesso: il giorno in cui si decide il
            // termine, si parte da una misura invece che da una stima.
            n_output_di_job_conclusi: numero(conti, 'output_di_job_conclusi'),
            ms: Date.now() - t0,
        })
    }
})
