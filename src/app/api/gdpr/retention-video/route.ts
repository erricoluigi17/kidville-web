import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { scansionaEsitiDiConversione } from '@/lib/media/video/esiti'
import { tipiRegistrati } from '@/lib/media/video/outbox/destinatari'
import {
    codiceDi,
    consumaOutbox,
    OUTBOX_NON_ESEGUITO,
    schemaAssente,
    tipiDellaRetention,
    type EsitoOutbox,
    type EsitoRpc,
} from '@/lib/media/video/outbox'

/**
 * LA CONSERVAZIONE DEI VIDEO — ORIGINALI E USCITE —, I BAMBINI SUGLI INTENTI, LA
 * RICONCILIAZIONE E LA CODA DELLE NOTIFICHE — un giro solo, ogni dieci minuti.
 *
 * (La coda delle notifiche, `video_outbox`, non si consuma qui: il motore e il registro dei
 * destinatari stanno in `@/lib/media/video/outbox`, condivisi con il runner. Questa route
 * chiama il motore con i propri numeri e riporta nel battito quanto ha fatto. Si divide la
 * coda col runner NEL claim: la retention prende i tipi registrati tranne quelli del runner —
 * che consegna le pubblicazioni, lavoro troppo lungo per i 25 eventi e i 120 secondi di lease
 * di un giro di retention —, e `tipiDellaRetention` li ricava dal registro.)
 *
 * ─── IL GIRO, IN ORDINE (PR 2 «server e web», spec §15) ─────────────────────
 *
 *  1. IL FLUSSO VECCHIO — `video_galleria_flusso_vecchio_revoca`. Dopo la PR 2 nessuno può più
 *     pubblicare un video di galleria che non sia «automatico»: gli intenti ancora vivi del
 *     flusso vecchio (gli undici convertiti mai pubblicati, e ogni invio rimasto in volo al
 *     rilascio) si revocano, e la loro uscita riceve la scadenza.
 *  2. I CONVERTITI NON PUBBLICATI — `video_intent_scadi_non_pubblicato`. Un video convertito che
 *     nessuno ha pubblicato si tiene SETTE giorni (decisione del titolare, 02/10):
 *     `GIORNI_CONVERTITO_NON_PUBBLICATO`. Poi si revoca, e l'uscita scade.
 *  3. LE SCADENZE — `video_retention_scadenze`: la rete sotto tutto. Dichiara conclusi gli upload
 *     abbandonati e le code incagliate, e dà una data a ogni originale e a ogni USCITA che non
 *     ce l'ha. È il passo che toglie le righe dall'invisibilità.
 *  4. GLI ORIGINALI SCADUTI — `video_originals`: prima il file, poi il timbro, per riga.
 *  5. LE USCITE SCADUTE — `video_processing`: prima il file, poi `video_retention_uscita_rimossa`,
 *     per riga. SOLO righe che nominano un'uscita (`output_path` non nullo, secondario #77: la RPC
 *     del timbro non lo verifica).
 *  6. GLI ORFANI DEL BUCKET, in tutti e due i magazzini, con la grazia di 24 ore — e, per ogni
 *     oggetto che una riga nomina, i RISORTI: file tornato dopo che la riga era già timbrata come
 *     tolta (due casi misurati il 01/10 sugli originali). Si toglie il file.
 *  7. LA MINIMIZZAZIONE — `video_intenti_minimizza`. Gli identificativi dei bambini scelti non
 *     restano sull'intento oltre i sette giorni dalla conclusione: resta il solo numero.
 *  8. LA CODA DELLE NOTIFICHE — `consumaOutbox`, coi numeri di sempre (25 eventi, lease 120 s), e il
 *     CONTO dei tipi di evento che nessun destinatario conosce (`segnalaTipiSenzaDestinatario`).
 *  9. LA SCANSIONE DEGLI ESITI DI CONVERSIONE (§8.5) — gli intenti automatici con un job `failed` o
 *     `rejected` e nessuna marca: marca `fallito` e, solo con la marca vinta, la notifica a chi ha caricato
 *     (`@/lib/media/video/esiti`). Il runner fa lo stesso subito dopo ogni esito definitivo: la marca decide
 *     chi vince.
 * 10. LA RICONCILIAZIONE — sola lettura, in coda: i conteggi che dicono se il resto ha lavorato.
 *
 * Un passo che non riesce NON ferma, di norma, quelli che non dipendono da lui: il guasto arriva in
 * fondo (un `500` e un battito che non è `ok`) e il resto del giro gira lo stesso. Prima un
 * originale trattenuto interrompeva il giro lì: con un solo file che lo Storage non rilascia, la
 * minimizzazione dei bambini, la coda e la riconciliazione non giravano più, a ogni giro, per sempre.
 * Fanno eccezione i passi su cui si regge tutto — lo schema video che non c'è (`503`), le scadenze che non
 * rispondono o rifiutano (`500`), la lettura degli originali scaduti che non riesce (`500`) —: senza di
 * loro il giro non saprebbe cosa togliere, e un `200` direbbe «niente da fare».
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
 * Lo stesso vale per l'USCITA convertita in `video_processing`, dal file C della PR 2:
 * `output_delete_after` ha il suo indice parziale, e una riga che non ha la data è fuori
 * dall'indice. Fino a quel file il bucket conservava l'uscita di ogni tentativo senza nessun
 * termine (87 oggetti e 2.571 MiB misurati il 01/10: 39 uscite di video già pubblicati, 26
 * orfani, 11 di job annullati, 11 convertiti mai pubblicati): era la lacuna aperta del registro
 * dell'oblio, e adesso ha le sue regole (`REGISTRO_BUCKET_OBLIO`, `video_processing`).
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
 *    `rimozione-verificata.ts`, e vale per i due magazzini con la stessa funzione
 *    (`rimuoviPoiTimbra`): una copia sola, perché due copie della stessa regola divergono.
 *    Al contrario, un errore a metà lascerebbe il video nel bucket con la riga che lo
 *    dichiara già rimosso: irraggiungibile, non cancellato, e nemmeno identificabile per
 *    cancellarlo se una famiglia lo chiedesse. Un file che non esce trattiene **la sua**
 *    riga, non le altre.
 *
 * 2. **UN FILE SI TOGLIE SOLO SE LA SUA SCADENZA È PASSATA, E LO RILEGGE IL
 *    DATABASE.** Qui si legge un elenco e si chiama lo Storage; fra le due cose
 *    passano secondi, e in quei secondi la riga può cambiare. Per questo il timbro
 *    non è un `update` di questa route ma `video_retention_originale_rimosso` (e
 *    `video_retention_uscita_rimossa`), che rilegge la scadenza sotto lock e risponde
 *    `NON_ANCORA_SCADUTO` invece di obbedire. L'errore che quella guardia impedisce —
 *    timbrare come rimosso l'originale di un video che deve ancora essere convertito, o
 *    l'uscita di un video che deve ancora essere pubblicato — è il più costoso di tutti,
 *    perché non è recuperabile.
 *
 * 3. **UN OGGETTO CHE UNA RIGA NOMINA ANCORA NON È UN ORFANO.** La spazzata del
 *    bucket parte da ciò che c'è nell'archivio e chiede al database chi lo reclama:
 *    è la direzione opposta alla purga, e senza la domanda cancellerebbe l'originale
 *    di un job vivo. In più c'è la grazia di 24 ore, perché un upload in corso è un
 *    oggetto che nessuno ha ancora finito di nominare. E un oggetto che una riga
 *    nomina ma che quella riga dichiara GIÀ TOLTO non è un reclamo: è un file risorto, e
 *    si toglie.
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
 * Niente percorsi, niente nomi di file, niente `source_mime`, niente identificativi di
 * bambini (`tag_alunni` esiste proprio per non uscire da dove sta). Il percorso dentro
 * `video_originals` è la chiave con cui si firma il video di un bambino in un bucket
 * privato, cioè una credenziale. Da qui escono conteggi, uuid, date, enumerati e codici
 * d'errore, e basta.
 */

/** Il nome con cui questo lavoro si presenta in `app_log` e in `cron.job`. */
const JOB = 'video-retention'

/** Il magazzino privato degli originali, dichiarato da `20260916190000:366`. */
const BUCKET_ORIGINALI = 'video_originals'

/**
 * Il magazzino privato delle USCITE convertite (`video_jobs.output_bucket`, sempre questo valore:
 * lo impone `video_jobs_output_chk`). Ci scrive il runner, un file per tentativo.
 */
const BUCKET_USCITE = 'video_processing'

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
 * ancora perché la richiesta che la crea è a metà. Per le USCITE copre il runner: il file
 * convertito viene scritto in `video_processing` PRIMA che `video_job_ready` dia il
 * suo percorso alla riga.
 */
const ORE_GRAZIA_ORFANI = 24

/**
 * QUANTI GIORNI SI TIENE UN VIDEO CONVERTITO CHE NESSUNO HA PUBBLICATO.
 *
 * Sette, per decisione del titolare (02/10/2026): oltre, l'intento si revoca e l'uscita scade
 * (`video_intent_scadi_non_pubblicato`). Il numero sta SOLO qui, e il registro dell'oblio
 * (`REGISTRO_BUCKET_OBLIO`, voce `video_processing`) lo cita in prosa: un test li tiene allineati.
 */
const GIORNI_CONVERTITO_NON_PUBBLICATO = 7

/**
 * DOPO QUANTI GIORNI DALLA CONCLUSIONE I BAMBINI SI TOLGONO DALL'INTENTO.
 *
 * `video_intents.tag_alunni` è un archivio di identificativi di minori in una tabella che non aveva una
 * conservazione. Si svuota alla pubblicazione; qui si svuota anche per ciò che conclude senza
 * pubblicare. Resta `n_tag`: un numero non identifica nessuno.
 */
const GIORNI_MINIMIZZAZIONE_INTENTI = 7

/**
 * Quanti originali e quante uscite si trattano per giro, e quanti job si dichiarano conclusi.
 * Anche il tetto che si passa alle RPC del giro (accettano da 1 a 1000): un giro che tiene lock su
 * migliaia di righe supera il tempo massimo della richiesta.
 */
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
 * Qui non c'è nessun prefisso scritto a mano, e non perché la forma dei percorsi sia ignota:
 * oggi gli originali sono `<chi carica>/<impronta>.<estensione>` (due livelli) e le uscite
 * `<chi carica>/<job>/<tentativo>.mp4` (tre), ma un prefisso nel codice è un'ipotesi che
 * invecchia con la route che sceglie i percorsi, ed è esattamente il modo in cui la
 * galleria è diventata cieca. Si parte dalla radice e si SCENDE dove si trovano cartelle
 * (`id === null`), fino a questa profondità. Tre livelli coprono entrambe le forme; una cartella
 * trovata al livello più basso non viene esplorata e il fatto si DICHIARA
 * (`orfani_profondita_troncata`), perché un troncamento silenzioso racconterebbe una pulizia
 * che non è avvenuta.
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

// `codiceDi`, `schemaAssente` (i codici PostgREST che dicono «questo schema qui non c'è»: il
// database E2E della CI non è migrato, e qui si risponde `503` invece di un `200` che
// direbbe «niente da fare») ed `EsitoRpc` stanno in `@/lib/media/video/outbox/rpc`: li usa
// anche il consumo della coda, e una copia sola dell'insieme di codici non diverge.

type Supa = Awaited<ReturnType<typeof createAdminClient>>

function numero(esito: EsitoRpc | null, chiave: string): number {
    const v = esito?.[chiave]
    return typeof v === 'number' ? v : 0
}

/**
 * Un conteggio che può NON ESSERCI: `null` quando la risposta non c'è o il campo non è un numero.
 *
 * ⚠️ `numero` dice 0 in quel caso, ed è giusto per i conteggi che contano lavoro fatto. Per quelli che
 * MISURANO, 0 e «non so» sono due fatti diversi: `arrivi_mancati` è `null` quando
 * `video_riconciliazione` non può leggere `storage.objects` (la rete degli arrivi non vede niente), e un
 * `0` direbbe «nessun arrivo mancato». Lo stesso vale per tutti i conteggi della riconciliazione quando
 * la riconciliazione non è girata.
 */
function numeroONull(esito: EsitoRpc | null, chiave: string): number | null {
    const v = esito?.[chiave]
    return typeof v === 'number' ? v : null
}

/** Una riga di `video_jobs` per ciò che serve a questa route, e niente di più. */
type RigaJob = { id: string; original_path: string }
/** `output_path` è nullo finché il runner non consegna: la lettura lo esclude, e qui si controlla lo stesso. */
type RigaUscita = { id: string; output_path: string | null }

// ═══════════════════════════════════════════════════════════════════════════════
// I PASSI CHE SONO UNA RPC SOLA
// ═══════════════════════════════════════════════════════════════════════════════

type EsitoPasso =
    | { stato: 'ok'; dati: EsitoRpc }
    | { stato: 'schema-assente'; codice: string }
    | { stato: 'guasto'; codice: string }

/**
 * Chiama la RPC di un passo e controlla IL VALORE DI RITORNO: PostgREST non lancia, ritorna
 * `{ error }`, e una RPC che risponde `{ ok: false }` ha rifiutato. Dice com'è andata e basta: cosa fare di
 * un guasto lo decide il chiamante (un passo che ne regge altri risponde `503`/`500` subito, gli altri
 * si limitano a dichiararlo). Il guasto vero si grida qui; lo schema assente no, perché lo dichiara chi
 * risponde.
 */
async function chiamaPasso(
    supabase: Supa,
    rpc: string,
    argomenti: Record<string, unknown>,
    passo: string,
    canale: string,
): Promise<EsitoPasso> {
    const { data, error } = await supabase.rpc(rpc, argomenti)
    if (error) {
        if (schemaAssente(error)) return { stato: 'schema-assente', codice: codiceDi(error) }
        logEvento(
            'cron',
            'error',
            { operazione: JOB, esito: `${passo}-fallito`, canale, error_code: codiceDi(error) },
            error,
        )
        return { stato: 'guasto', codice: codiceDi(error) }
    }
    const dati = (data ?? null) as EsitoRpc | null
    if (dati?.ok !== true) {
        const codice = typeof dati?.code === 'string' ? dati.code : 'sconosciuto'
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: `${passo}-rifiutato`,
            canale,
            error_code: codice,
            msg: `${JOB}: ${rpc} ha rifiutato la richiesta`,
        })
        return { stato: 'guasto', codice }
    }
    return { stato: 'ok', dati }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMA IL FILE, POI LA RIGA — una funzione sola, per i due magazzini
// ═══════════════════════════════════════════════════════════════════════════════

/** Come si toglie un file di un magazzino e come si timbra la riga che lo nominava. */
type DefinizioneRimozione = {
    bucket: string
    /** La RPC che timbra la riga DOPO che il file è uscito: rilegge la scadenza sotto lock. */
    rpcTimbro: string
    /** Come si presentano nei log i due guasti per riga: il timbro che non risponde e quello rifiutato. */
    esitoTimbroFallito: string
    esitoTimbroRifiutato: string
}

const RIMOZIONE_ORIGINALI: DefinizioneRimozione = {
    bucket: BUCKET_ORIGINALI,
    rpcTimbro: 'video_retention_originale_rimosso',
    esitoTimbroFallito: 'timbro-fallito',
    esitoTimbroRifiutato: 'timbro-rifiutato',
}

const RIMOZIONE_USCITE: DefinizioneRimozione = {
    bucket: BUCKET_USCITE,
    rpcTimbro: 'video_retention_uscita_rimossa',
    esitoTimbroFallito: 'uscita-timbro-fallito',
    esitoTimbroRifiutato: 'uscita-timbro-rifiutato',
}

type EsitoRimozioneRighe = {
    timbrati: number
    trattenuti: number
    rimozione: EsitoRimozione
}

/**
 * Toglie i file dal magazzino e, SOLO per quelli usciti, timbra la riga. Non lancia mai (ogni ramo
 * cattura e riferisce).
 *
 * PRIMA IL FILE. `rimuoviEVerifica` verifica lo STATO di ciò che non risulta uscito, invece di contare:
 * «non c'è più» è l'esito voluto, «c'è ancora» e «non so» sono guasti. POI LA RIGA, e per riga: un file che
 * non esce trattiene la SUA riga, non quelle degli altri. Il timbro non è un `update` di questa route ma una
 * RPC che rilegge la scadenza sotto lock.
 */
async function rimuoviPoiTimbra(
    supabase: Supa,
    def: DefinizioneRimozione,
    righe: { id: string; percorso: string }[],
    canale: string,
): Promise<EsitoRimozioneRighe> {
    if (righe.length === 0) return { timbrati: 0, trattenuti: 0, rimozione: NIENTE_DA_TOGLIERE }

    const rimozione = await rimuoviEVerifica(
        supabase,
        def.bucket,
        righe.map((r) => r.percorso),
        JOB,
    )
    const restano = new Set(bloccanti(rimozione))
    let timbrati = 0
    let trattenuti = 0

    for (const riga of righe) {
        if (restano.has(riga.percorso)) {
            trattenuti += 1
            continue
        }
        const { data: esitoTimbro, error: erroreTimbro } = await supabase.rpc(def.rpcTimbro, {
            p_job_id: riga.id,
        })
        if (erroreTimbro) {
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: def.esitoTimbroFallito,
                    canale,
                    error_code: codiceDi(erroreTimbro),
                    job_id: riga.id,
                },
                erroreTimbro,
            )
            trattenuti += 1
            continue
        }
        if ((esitoTimbro as EsitoRpc | null)?.ok !== true) {
            // Il file è uscito e la riga non lo sa: il giro dopo la
            // riprenderà e lo Storage risponderà «già assente», che NON è un
            // guasto. Ma il fatto si grida adesso, perché l'unico modo di
            // arrivare qui è che la scadenza sia cambiata sotto i piedi.
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: def.esitoTimbroRifiutato,
                canale,
                job_id: riga.id,
                error_code:
                    typeof (esitoTimbro as EsitoRpc | null)?.code === 'string'
                        ? ((esitoTimbro as EsitoRpc).code as string)
                        : 'sconosciuto',
                msg: `${JOB}: il file è uscito dall'archivio ma la riga non ha accettato il timbro`,
            })
            trattenuti += 1
            continue
        }
        timbrati += 1
    }

    return { timbrati, trattenuti, rimozione }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LA SPAZZATA DEGLI ORFANI — dal bucket al database, che è la direzione opposta
// ═══════════════════════════════════════════════════════════════════════════════

/** Un magazzino da spazzare, e come lo nomina `video_jobs`. */
type Magazzino = {
    bucket: string
    /** La colonna di `video_jobs` che dice in quale bucket sta il file: `original_bucket` | `output_bucket`. */
    colonnaBucket: string
    /** La colonna che dice il percorso: `original_path` | `output_path`. */
    colonnaPercorso: string
    /** Il timbro di «già tolto»: se la riga che nomina un file lo porta, quel file è RISORTO. */
    colonnaTimbro: string
    /** Il prefisso degli `esito` di questa spazzata nei log: `orfani` | `orfani-uscite`. */
    esito: string
    /** L'evento dei risorti: `originali-risorti-rimossi` | `uscite-risorte-rimosse`. */
    eventoRisorti: string
}

const MAGAZZINO_ORIGINALI: Magazzino = {
    bucket: BUCKET_ORIGINALI,
    colonnaBucket: 'original_bucket',
    colonnaPercorso: 'original_path',
    colonnaTimbro: 'original_deleted_at',
    esito: 'orfani',
    eventoRisorti: 'originali-risorti-rimossi',
}

const MAGAZZINO_USCITE: Magazzino = {
    bucket: BUCKET_USCITE,
    colonnaBucket: 'output_bucket',
    colonnaPercorso: 'output_path',
    colonnaTimbro: 'output_deleted_at',
    esito: 'orfani-uscite',
    eventoRisorti: 'uscite-risorte-rimosse',
}

type EsitoSpazzata = {
    esito: string
    esaminati: number
    reclamati: number
    /** Gli orfani usciti: oggetti che nessuna riga nomina. */
    rimossi: number
    /** I risorti usciti: oggetti che una riga nomina ma dichiara già tolti. */
    risorti: number
    troncato: boolean
    profonditaTroncata: boolean
}

const SPAZZATA_NON_ESEGUITA: EsitoSpazzata = {
    esito: 'non-eseguita',
    esaminati: 0,
    reclamati: 0,
    rimossi: 0,
    risorti: 0,
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
    bucket: string,
    nato_prima_di: Date,
): Promise<{ percorsi: string[]; troncato: boolean; profonditaTroncata: boolean; errore: unknown }> {
    const percorsi: string[] = []
    let troncato = false
    let profonditaTroncata = false
    let daVisitare: { prefisso: string; livello: number }[] = [{ prefisso: '', livello: 1 }]

    while (daVisitare.length > 0) {
        const { prefisso, livello } = daVisitare.shift()!
        const { data, error } = await supabase.storage
            .from(bucket)
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
 * Toglie dal bucket gli oggetti che NESSUNA riga di `video_jobs` nomina — e quelli che una riga nomina
 * ma dichiara GIÀ TOLTI (i risorti).
 *
 * Non lancia mai: ogni ramo cattura e riferisce, così il chiamante non ha bisogno
 * di un `try` attorno e un guasto qui non impedisce al battito di essere scritto.
 *
 * ⚠️ I RISORTI. Una riga timbrata (`*_deleted_at` valorizzato) dice che il file è già uscito: se l'oggetto
 * c'è, è tornato dopo (un caricamento tardivo, un tentativo che scrive quando la riga è già chiusa). Il
 * trigger d'arrivo del file B riarma gli originali che ricompaiono, ma non vede un job `ready` e tace se
 * fallisce: questa è la rete. Si toglie il FILE, mai la riga (è già a posto). La grazia di 24 ore
 * vale anche per loro.
 */
async function spazzaMagazzino(supabase: Supa, adesso: Date, m: Magazzino): Promise<EsitoSpazzata> {
    const soglia = new Date(adesso.getTime() - ORE_GRAZIA_ORFANI * 3_600_000)
    const { percorsi, troncato, profonditaTroncata, errore } = await elencaOggetti(supabase, m.bucket, soglia)

    if (errore) {
        logEvento(
            'cron',
            'error',
            { operazione: JOB, esito: `${m.esito}-elenco-fallito`, n_file: percorsi.length },
            errore,
        )
        return { ...SPAZZATA_NON_ESEGUITA, esito: 'elenco-fallito', troncato, profonditaTroncata }
    }
    if (percorsi.length === 0) {
        return { ...SPAZZATA_NON_ESEGUITA, esito: 'ok', troncato, profonditaTroncata }
    }

    // LA DOMANDA AL DATABASE, a lotti: «quali di questi percorsi sono reclamati da
    // una riga, e quali di quelle righe li dichiarano già tolti?». Senza, si cancellerebbe
    // l'originale di un job vivo.
    const reclamati = new Set<string>()
    const risorti = new Set<string>()
    for (let i = 0; i < percorsi.length; i += LOTTO_RECLAMI) {
        const lotto = percorsi.slice(i, i + LOTTO_RECLAMI)
        const { data, error } = await supabase
            .from('video_jobs')
            .select(`${m.colonnaPercorso}, ${m.colonnaTimbro}`)
            .eq(m.colonnaBucket, m.bucket)
            .in(m.colonnaPercorso, lotto)
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
                    esito: `${m.esito}-reclami-falliti`,
                    error_code: codiceDi(error),
                    n_file: lotto.length,
                },
                error,
            )
            return { ...SPAZZATA_NON_ESEGUITA, esito: 'reclami-falliti', troncato, profonditaTroncata }
        }
        for (const riga of (data ?? []) as unknown as Record<string, unknown>[]) {
            const percorso = riga?.[m.colonnaPercorso]
            if (typeof percorso !== 'string') continue
            reclamati.add(percorso)
            // Il timbro assente (`undefined`) vale «non timbrata»: nel dubbio non si distrugge.
            if (riga[m.colonnaTimbro] !== null && riga[m.colonnaTimbro] !== undefined) risorti.add(percorso)
        }
    }

    const orfani = percorsi.filter((p) => !reclamati.has(p))
    const daTogliere = [...orfani, ...percorsi.filter((p) => risorti.has(p))]
    if (daTogliere.length === 0) {
        return {
            ...SPAZZATA_NON_ESEGUITA,
            esito: 'ok',
            esaminati: percorsi.length,
            reclamati: reclamati.size,
            troncato,
            profonditaTroncata,
        }
    }

    const esito = await rimuoviEVerifica(supabase, m.bucket, daTogliere, JOB)
    const restano = bloccanti(esito)
    if (restano.length > 0) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: `${m.esito}-non-rimossi`,
            n_file: restano.length,
            msg: `${JOB}: ${restano.length} oggetti orfani o risorti di ${m.bucket} non sono usciti dall'archivio`,
        })
    }
    const rimastiFermi = new Set(restano)
    const orfaniRimossi = orfani.filter((p) => !rimastiFermi.has(p)).length
    const risortiRimossi = [...risorti].filter((p) => !rimastiFermi.has(p)).length
    if (risortiRimossi > 0) {
        // Non è un guasto di chi lavora, ma è un fatto da vedere: qualcosa ha scritto un file
        // in un magazzino la cui riga lo dichiarava già tolto.
        logEvento('cron', 'warn', {
            operazione: JOB,
            esito: m.eventoRisorti,
            n_file: risortiRimossi,
            msg: `${JOB}: ${risortiRimossi} file di ${m.bucket} erano tornati dopo il timbro di rimozione, e sono stati tolti`,
        })
    }
    return {
        esito: restano.length > 0 ? 'parziale' : 'ok',
        esaminati: percorsi.length,
        reclamati: reclamati.size,
        rimossi: orfaniRimossi,
        risorti: risortiRimossi,
        troncato,
        profonditaTroncata,
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LA SCANSIONE DEGLI ESITI DI CONVERSIONE (spec §8.5) E I TIPI SENZA DESTINATARIO
// ═══════════════════════════════════════════════════════════════════════════════

type EsitoScansioneEsiti = {
    /** `non-eseguita` finché il passo non gira; poi `ok` o il motivo per cui non è partita (`schema-assente`, `lettura-fallita`). */
    esito: string
    /** Quanti intenti ha marcato `fallito` e notificato. */
    notificati: number
}

/** Il valore di chi non ha girato. Congelato: è condiviso fra le richieste. */
const SCANSIONE_ESITI_NON_ESEGUITA: EsitoScansioneEsiti = Object.freeze({
    esito: 'non-eseguita',
    notificati: 0,
})

/**
 * La scansione, nel punto del giro che le spetta: DOPO la coda (le notifiche d'esito usano le stesse tabelle e non devono far aspettare le
 * ricevute) e PRIMA della riconciliazione (che conta `esiti_da_notificare` dopo che la scansione ha lavorato).
 *
 * La logica non è qui: è `@/lib/media/video/esiti`, la libreria che usa anche il runner. Due copie della regola «una sola marca, una sola
 * notifica» divergono il giorno in cui qualcuno ne corregge una. Questa funzione la chiama col nome del lavoro e riporta il conto.
 *
 * Non lancia e non fa fallire il giro: un guasto della scansione si dice nei log (`error`) e nel battito (`esiti_eseguita`, `n_esiti_da_notificare`
 * della riconciliazione resta alto), e il resto della conservazione gira lo stesso.
 */
async function scansionaEsitiConversione(supabase: Supa): Promise<EsitoScansioneEsiti> {
    const scansione = await scansionaEsitiDiConversione(supabase, { operazione: JOB })
    return { esito: scansione.esito, notificati: scansione.notificati }
}

/** Quante righe di `video_outbox` si leggono per contare i tipi senza destinatario: un campione, non l'archivio. */
const TETTO_LETTURA_TIPI_SENZA_DESTINATARIO = 200

/**
 * GLI EVENTI CHE NESSUNO SA CONSEGNARE (secondario #115): un tipo di evento nella coda che il registro dei destinatari non conosce.
 *
 * Col filtro NEL claim un tipo non registrato non lo prende più nessuno: né la retention (prende i registrati tranne quelli del runner) né il
 * runner (prende solo i suoi). Prima la retention lo prendeva e lo gridava a ogni giro, e bruciava i suoi venticinque tentativi; ora resta
 * fermo e INTATTO — e fermo non fa rumore. Rimaneva solo un `warn` aggregato di `video_riconciliazione` (`outbox-in-ritardo`), che dice che
 * qualcosa è fermo da un'ora ma non che cosa né perché. Questo è il grido che mancava: una riga `error` per TIPO, col suo conteggio, perché
 * un tipo scritto nella coda e mai registrato è una configurazione mancante, e la configurazione mancante è `error` (AGENTS, regola 4) e mai `info`.
 *
 * Si guarda `video_outbox` per ciò che non è stato consegnato e il cui tipo non sta nel registro (`tipiRegistrati`, TUTTI i tipi di TUTTI i
 * consumatori: ricavarli dai tipi della retention scambierebbe quelli del runner per «senza destinatario»). Legge il solo tipo: nessun
 * identificativo, nessun payload. Il conteggio è su un campione (`TETTO_LETTURA_TIPI_SENZA_DESTINATARIO` righe), e `troncato` lo dice.
 *
 * Non fa fallire il giro e non lancia: una lettura che non riesce lascia una riga `warn` e vale zero.
 */
async function segnalaTipiSenzaDestinatario(supabase: Supa, canale: string): Promise<number> {
    const { data, error } = await supabase
        .from('video_outbox')
        .select('event_type')
        .is('sent_at', null)
        .not('event_type', 'in', `(${tipiRegistrati().join(',')})`)
        .limit(TETTO_LETTURA_TIPI_SENZA_DESTINATARIO)
    // PostgREST non lancia: l'errore è nel valore di ritorno.
    if (error) {
        logEvento(
            'cron',
            'warn',
            { operazione: JOB, esito: 'outbox-tipi-non-letti', canale, error_code: codiceDi(error) },
            error,
        )
        return 0
    }

    const righe = (data ?? []) as { event_type?: unknown }[]
    const perTipo = new Map<string, number>()
    for (const riga of righe) {
        if (typeof riga.event_type !== 'string') continue
        perTipo.set(riga.event_type, (perTipo.get(riga.event_type) ?? 0) + 1)
    }
    const troncato = righe.length >= TETTO_LETTURA_TIPI_SENZA_DESTINATARIO
    let totale = 0
    for (const [tipo, n] of perTipo) {
        totale += n
        logEvento(
            'cron',
            'error',
            {
                operazione: JOB,
                esito: 'outbox-senza-destinatario',
                canale,
                tipo,
                n_righe: n,
                troncato,
                msg: `${JOB}: eventi di video_outbox di un tipo che nessun destinatario sa consegnare: nessuno li consegnerà finché il tipo non è registrato`,
            },
            undefined,
            { distingui: ['tipo'] },
        )
    }
    return totale
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
    // Il `motivo` che il corpo della risposta dà al guasto (può differire dall'`esito` del battito).
    let motivoGuasto = 'ok'
    let codiceGuasto: string | null = null
    let nFlussoVecchioRevocati = 0
    let nFlussoVecchioRifiutati = 0
    let nNonPubblicatiScaduti = 0
    let nNonPubblicatiRifiutati = 0
    let nAbbandonati = 0
    let nIncagliati = 0
    let nSenzaScadenza = 0
    let nUsciteDichiarate = 0
    let nScaduti = 0
    let nTimbrati = 0
    let nTrattenuti = 0
    let lottoPieno = false
    let rimozione: EsitoRimozione = NIENTE_DA_TOGLIERE
    let nUsciteScadute = 0
    let nUsciteRimosse = 0
    let nUsciteTrattenute = 0
    let lottoUscitePieno = false
    let rimozioneUscite: EsitoRimozione = NIENTE_DA_TOGLIERE
    let spazzata: EsitoSpazzata = SPAZZATA_NON_ESEGUITA
    let spazzataUscite: EsitoSpazzata = SPAZZATA_NON_ESEGUITA
    let nIntentiMinimizzati = 0
    let outbox: EsitoOutbox = OUTBOX_NON_ESEGUITO
    let nOutboxNonRegistrati = 0
    let esiti: EsitoScansioneEsiti = SCANSIONE_ESITI_NON_ESEGUITA
    let conti: EsitoRpc | null = null

    /**
     * Registra il guasto di un passo che NON ferma il giro. Vince il PRIMO: è quello che dice dove è
     * cominciato, e il battito deve avere un solo `esito`. Il giro continua, e la risposta è un `500`.
     */
    const segnalaGuasto = (esito: string, motivo: string, codice: string | null = null) => {
        if (esitoBattito !== 'ok') return
        esitoBattito = esito
        motivoGuasto = motivo
        codiceGuasto = codice
    }

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

        /**
         * Il database E2E della CI non è migrato, e le migrazioni video sono in `IN_CODA`: là non c'è
         * nessuna pipeline video da conservare. Si dichiara e si esce — un `200` qui direbbe «niente da
         * togliere», che è un altro fatto.
         */
        const rispondiSchemaAssente = (codice: string) => {
            esitoBattito = 'schema-assente'
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                error_code: codice,
                ms: Date.now() - t0,
                msg: `${JOB}: lo schema video non esiste su questo database, nessun originale trattato, e non si finge il contrario`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: 503 },
            )
        }

        // ── 1. IL FLUSSO VECCHIO ────────────────────────────────────────────
        //
        // Per primo, nell'ordine della testata del file C: la revoca scrive la scadenza dell'uscita
        // degli intenti che spegne, e la rete delle scadenze (passo 3) trova già il lavoro fatto.
        const flusso = await chiamaPasso(
            supabase,
            'video_galleria_flusso_vecchio_revoca',
            { p_limite: TETTO_LOTTO },
            'flusso-vecchio',
            canale,
        )
        if (flusso.stato === 'schema-assente') return rispondiSchemaAssente(flusso.codice)
        if (flusso.stato === 'guasto') {
            segnalaGuasto('flusso-vecchio-fallito', 'flusso-vecchio-fallito', flusso.codice)
        } else {
            nFlussoVecchioRevocati = numero(flusso.dati, 'revocati')
            nFlussoVecchioRifiutati = numero(flusso.dati, 'rifiutati')
            if (nFlussoVecchioRevocati > 0 || nFlussoVecchioRifiutati > 0) {
                logEvento('cron', 'info', {
                    operazione: JOB,
                    esito: 'flusso-vecchio-revocato',
                    canale,
                    n_righe: nFlussoVecchioRevocati,
                    n_righe_rifiutate: nFlussoVecchioRifiutati,
                    msg: `${JOB}: intenti del flusso vecchio revocati: nessuno può più pubblicarli, e la loro uscita scade`,
                })
            }
        }

        // ── 2. I CONVERTITI CHE NESSUNO HA PUBBLICATO ───────────────────────
        const nonPubblicati = await chiamaPasso(
            supabase,
            'video_intent_scadi_non_pubblicato',
            { p_giorni: GIORNI_CONVERTITO_NON_PUBBLICATO, p_limite: TETTO_LOTTO },
            'non-pubblicati',
            canale,
        )
        if (nonPubblicati.stato === 'schema-assente') return rispondiSchemaAssente(nonPubblicati.codice)
        if (nonPubblicati.stato === 'guasto') {
            segnalaGuasto('non-pubblicati-fallito', 'non-pubblicati-fallito', nonPubblicati.codice)
        } else {
            nNonPubblicatiScaduti = numero(nonPubblicati.dati, 'scaduti')
            nNonPubblicatiRifiutati = numero(nonPubblicati.dati, 'rifiutati')
            if (nNonPubblicatiScaduti > 0 || nNonPubblicatiRifiutati > 0) {
                logEvento('cron', 'info', {
                    operazione: JOB,
                    esito: 'non-pubblicati-scaduti',
                    canale,
                    giorni: GIORNI_CONVERTITO_NON_PUBBLICATO,
                    n_righe: nNonPubblicatiScaduti,
                    n_righe_rifiutate: nNonPubblicatiRifiutati,
                    msg: `${JOB}: video convertiti e mai pubblicati da oltre ${GIORNI_CONVERTITO_NON_PUBBLICATO} giorni: intenti revocati e uscite in scadenza`,
                })
            }
        }

        // ── 3. LE SCADENZE ──────────────────────────────────────────────────
        //
        // Prima di ogni rimozione, e non per abitudine: è il passo che toglie le righe
        // dall'invisibilità. Un originale senza `original_delete_after` non comparirà
        // nell'elenco del passo 4 nemmeno fra dieci anni, e un'uscita senza `output_delete_after`
        // non comparirà in quello del passo 5.
        const { data: datiScadenze, error: erroreScadenze } = await supabase.rpc(
            'video_retention_scadenze',
            {
                p_ore_upload: ORE_UPLOAD_ABBANDONATO,
                p_ore_incaglio: ORE_INCAGLIO,
                p_limite: TETTO_LOTTO,
            },
        )

        if (erroreScadenze && schemaAssente(erroreScadenze)) {
            return rispondiSchemaAssente(codiceDi(erroreScadenze))
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
        nUsciteDichiarate = numero(scadenze, 'uscite_senza_scadenza')

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
        if (nUsciteDichiarate > 0) {
            // ⚠️ NON È UN GUASTO, a differenza dei conclusi senza scadenza qui sopra (secondario #81).
            // Le tre RPC che annullano, revocano o sostituiscono un intento non scrivono la scadenza
            // dell'uscita, e la rete è proprio il loro meccanismo: «ne ho pescate» è il lavoro che la
            // conservazione ha trovato da fare, non un cammino che si è dimenticato di qualcosa.
            logEvento('cron', 'info', {
                operazione: JOB,
                esito: 'uscite-dichiarate',
                canale,
                n_righe: nUsciteDichiarate,
                msg: `${JOB}: ${nUsciteDichiarate} uscite di job conclusi o pubblicati hanno ricevuto la loro scadenza`,
            })
        }

        // ── 4. GLI ORIGINALI SCADUTI ────────────────────────────────────────
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

        const esitoOriginali = await rimuoviPoiTimbra(
            supabase,
            RIMOZIONE_ORIGINALI,
            scaduti.map((r) => ({ id: r.id, percorso: r.original_path })),
            canale,
        )
        rimozione = esitoOriginali.rimozione
        nTimbrati = esitoOriginali.timbrati
        nTrattenuti = esitoOriginali.trattenuti

        if (nTrattenuti > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto. Un
            // `200` direbbe «fatto» a chi sorveglia, e resterebbero originali di
            // video di minori nell'archivio oltre il termine, senza che nessuno lo
            // sappia. Il giro prosegue (vedi la testata): il `500` arriva in fondo.
            segnalaGuasto(
                'originali-trattenuti',
                // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                // risposta: chi legge deve poter distinguere un archivio che non
                // risponde da un file che non esce.
                rimozione.ancoraPresenti.length > 0 ? 'file-non-rimossi' : 'verifica-non-riuscita',
            )
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'originali-trattenuti',
                canale,
                n_righe: nTimbrati,
                n_righe_trattenute: nTrattenuti,
                n_file_ancora_presenti: rimozione.ancoraPresenti.length,
                n_file_non_verificati: rimozione.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${nTrattenuti} originali NON tolti dall'archivio o non timbrati`,
            })
        }

        // ── 5. LE USCITE SCADUTE ────────────────────────────────────────────
        //
        // L'elenco esce dall'indice parziale `video_jobs_uscite_da_togliere_idx` (file A), per scadenza
        // crescente. `output_path` non nullo è una CONDIZIONE, non un'ottimizzazione (secondario #77): il
        // timbro non verifica che la riga nomini un file, e una riga con la scadenza e senza il percorso
        // passerebbe un `null` allo Storage e sarebbe timbrata come «tolta» senza che ci fosse niente.
        const { data: datiUscite, error: erroreUscite } = await supabase
            .from('video_jobs')
            .select('id, output_path')
            .eq('output_bucket', BUCKET_USCITE)
            .is('output_deleted_at', null)
            .not('output_delete_after', 'is', null)
            .not('output_path', 'is', null)
            .lte('output_delete_after', adesso.toISOString())
            .order('output_delete_after', { ascending: true })
            .limit(TETTO_LOTTO)

        if (erroreUscite) {
            // Stesso difetto da evitare del passo 4: un elenco vuoto per un errore direbbe «zero uscite
            // scadute». Qui non si ferma il giro: la lettura non regge i passi che seguono.
            segnalaGuasto('uscite-lettura-fallita', 'uscite-lettura-fallita', codiceDi(erroreUscite))
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'uscite-lettura-fallita',
                    canale,
                    error_code: codiceDi(erroreUscite),
                    ms: Date.now() - t0,
                    msg: `${JOB}: lettura delle uscite scadute non riuscita`,
                },
                erroreUscite,
            )
        } else {
            // Doppia cintura del #77: la lettura chiede `output_path` non nullo, e qui si scarta comunque
            // ogni riga che non nomina un file. Passarne una a `rimuoviPoiTimbra` vorrebbe dire timbrarla
            // come «tolta» senza che ci fosse niente da togliere: la RPC del timbro non lo verifica.
            const uscite = ((datiUscite ?? []) as unknown as RigaUscita[]).filter(
                (r): r is { id: string; output_path: string } =>
                    typeof r.output_path === 'string' && r.output_path.trim().length > 0,
            )
            nUsciteScadute = uscite.length
            lottoUscitePieno = nUsciteScadute >= TETTO_LOTTO

            const esitoUscite = await rimuoviPoiTimbra(
                supabase,
                RIMOZIONE_USCITE,
                uscite.map((r) => ({ id: r.id, percorso: r.output_path })),
                canale,
            )
            rimozioneUscite = esitoUscite.rimozione
            nUsciteRimosse = esitoUscite.timbrati
            nUsciteTrattenute = esitoUscite.trattenuti

            if (nUsciteRimosse > 0) {
                logEvento('cron', 'info', {
                    operazione: JOB,
                    esito: 'uscite-rimosse',
                    canale,
                    n_righe: nUsciteRimosse,
                    n_file_gia_assenti: rimozioneUscite.giaAssenti.length,
                    msg: `${JOB}: ${nUsciteRimosse} uscite tolte da ${BUCKET_USCITE} e timbrate`,
                })
            }
            if (nUsciteTrattenute > 0) {
                segnalaGuasto(
                    'uscite-trattenute',
                    rimozioneUscite.ancoraPresenti.length > 0 ? 'file-non-rimossi' : 'verifica-non-riuscita',
                )
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'uscite-trattenute',
                    canale,
                    n_righe: nUsciteRimosse,
                    n_righe_trattenute: nUsciteTrattenute,
                    n_file_ancora_presenti: rimozioneUscite.ancoraPresenti.length,
                    n_file_non_verificati: rimozioneUscite.incerti.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: ${nUsciteTrattenute} uscite NON tolte dall'archivio o non timbrate`,
                })
            }
        }

        // ── 6. GLI ORFANI E I RISORTI DEI BUCKET ────────────────────────────
        // Dopo le rimozioni per scadenza (riuscite o no), e non prima: togliere ciò che ha una
        // scadenza è la promessa, spazzare ciò che nessuno nomina è manutenzione. Gira anche se una
        // riga è rimasta trattenuta qui sopra: se lo Storage non risponde la spazzata se ne accorge
        // da sé (elenco o reclami che falliscono) e non toglie niente. Non lancia mai, quindi non
        // serve un `try` attorno.
        spazzata = await spazzaMagazzino(supabase, adesso, MAGAZZINO_ORIGINALI)
        spazzataUscite = await spazzaMagazzino(supabase, adesso, MAGAZZINO_USCITE)

        // ── 7. I BAMBINI SUGLI INTENTI ──────────────────────────────────────
        // Non dipende dallo Storage: gira anche quando una rimozione qui sopra è rimasta indietro, e
        // un file che non esce non ritarda mai il momento in cui l'identificativo di un minore lascia
        // la tabella.
        const minimizzazione = await chiamaPasso(
            supabase,
            'video_intenti_minimizza',
            { p_giorni: GIORNI_MINIMIZZAZIONE_INTENTI, p_limite: TETTO_LOTTO },
            'minimizzazione',
            canale,
        )
        if (minimizzazione.stato === 'ok') {
            nIntentiMinimizzati = numero(minimizzazione.dati, 'minimizzati')
            if (nIntentiMinimizzati > 0) {
                logEvento('cron', 'info', {
                    operazione: JOB,
                    esito: 'intenti-minimizzati',
                    canale,
                    giorni: GIORNI_MINIMIZZAZIONE_INTENTI,
                    n_righe: nIntentiMinimizzati,
                    msg: `${JOB}: ${nIntentiMinimizzati} intenti conclusi da oltre ${GIORNI_MINIMIZZAZIONE_INTENTI} giorni non nominano più i bambini scelti`,
                })
            }
        } else {
            if (minimizzazione.stato === 'schema-assente') {
                logEvento('cron', 'warn', {
                    operazione: JOB,
                    esito: 'minimizzazione-schema-assente',
                    canale,
                    error_code: minimizzazione.codice,
                    msg: `${JOB}: video_intenti_minimizza non esiste su questo database: gli identificativi dei bambini restano sugli intenti`,
                })
            }
            segnalaGuasto('minimizzazione-fallito', 'minimizzazione-fallito', minimizzazione.codice)
        }

        // ── 8. LA CODA DELLE NOTIFICHE ──────────────────────────────────────
        // Tutti i tipi registrati TRANNE quelli del runner (le pubblicazioni): il filtro sta nel claim,
        // e `tipiDellaRetention` lo ricava dal registro. Il motore non lancia, quindi non serve un
        // `try` attorno.
        outbox = await consumaOutbox(supabase, {
            operazione: JOB,
            limite: LOTTO_OUTBOX,
            leaseSecondi: LEASE_OUTBOX_SECONDI,
            tipi: tipiDellaRetention(),
        })
        // I tipi che il filtro del claim lascia a nessuno: si contano e si gridano (#115).
        nOutboxNonRegistrati = await segnalaTipiSenzaDestinatario(supabase, canale)

        // ── 9. LA SCANSIONE DEGLI ESITI DI CONVERSIONE ──────────────────────
        // Dopo la coda e prima della riconciliazione: vedi `scansionaEsitiConversione`.
        esiti = await scansionaEsitiConversione(supabase)
        // Una scansione che non è riuscita (lettura fallita, schema assente) ha già lasciato la sua riga: qui si rende visibile al battito. Non
        // ferma niente — la riconciliazione che segue conta proprio gli esiti ancora da notificare —, ma un giro in cui nessuno sa se i video
        // falliti sono stati notificati non è un «ok».
        if (esiti.esito !== 'ok') segnalaGuasto('esiti-fallito', 'esiti-fallito')

        // ── 10. LA RICONCILIAZIONE ──────────────────────────────────────────
        // Sola lettura: conta, e non aggiusta. Un conteggio che sistema quel che
        // conta non distingue più il guasto dall'assenza di guasto. In coda, dopo
        // tutto il lavoro: i numeri dicono com'è finito il giro, non com'era iniziato.
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
            if (numero(conti, 'outbox_in_ritardo') > 0) {
                // Con il filtro nel claim un tipo che il registro non conosce non lo prende più nessuno,
                // e non grida più a ogni giro: questo è il suo sintomo (insieme a un consumatore fermo).
                // `warn` e non `error`: da solo il ritardo è anche un backlog legittimo.
                logEvento('cron', 'warn', {
                    operazione: JOB,
                    esito: 'outbox-in-ritardo',
                    canale,
                    n_righe: numero(conti, 'outbox_in_ritardo'),
                    msg: `${JOB}: eventi di video_outbox fermi da oltre un'ora: un tipo che nessun consumatore conosce, o un consumatore fermo`,
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

        const corpo = {
            giorni_ttl: 7,
            giorni_convertito_non_pubblicato: GIORNI_CONVERTITO_NON_PUBBLICATO,
            flusso_vecchio_revocati: nFlussoVecchioRevocati,
            flusso_vecchio_rifiutati: nFlussoVecchioRifiutati,
            non_pubblicati_scaduti: nNonPubblicatiScaduti,
            non_pubblicati_rifiutati: nNonPubblicatiRifiutati,
            abbandonati: nAbbandonati,
            incagliati: nIncagliati,
            conclusi_senza_scadenza: nSenzaScadenza,
            uscite_dichiarate: nUsciteDichiarate,
            originali_scaduti: nScaduti,
            originali_rimossi: nTimbrati,
            originali_trattenuti: nTrattenuti,
            originali_gia_assenti: rimozione.giaAssenti.length,
            // Il lotto tagliato si dichiara: chi lancia il giro a mano deve sapere se
            // richiamarlo, e non deve dedurlo da un conteggio.
            lotto_pieno: lottoPieno,
            uscite_scadute: nUsciteScadute,
            uscite_rimosse: nUsciteRimosse,
            uscite_trattenute: nUsciteTrattenute,
            uscite_gia_assenti: rimozioneUscite.giaAssenti.length,
            uscite_lotto_pieno: lottoUscitePieno,
            orfani_esito: spazzata.esito,
            orfani_esaminati: spazzata.esaminati,
            orfani_rimossi: spazzata.rimossi,
            originali_risorti_rimossi: spazzata.risorti,
            orfani_elenco_troncato: spazzata.troncato,
            orfani_profondita_troncata: spazzata.profonditaTroncata,
            orfani_uscite_esito: spazzataUscite.esito,
            orfani_uscite_esaminati: spazzataUscite.esaminati,
            orfani_uscite_rimossi: spazzataUscite.rimossi,
            uscite_risorte_rimosse: spazzataUscite.risorti,
            orfani_uscite_elenco_troncato: spazzataUscite.troncato,
            orfani_uscite_profondita_troncata: spazzataUscite.profonditaTroncata,
            intenti_minimizzati: nIntentiMinimizzati,
            outbox_esito: outbox.esito,
            outbox_presi: outbox.presi,
            outbox_inviati: outbox.inviati,
            outbox_falliti: outbox.falliti,
            outbox_senza_destinatario: outbox.senzaDestinatario,
            outbox_saltati: outbox.saltati,
            outbox_non_registrati: nOutboxNonRegistrati,
            esiti_esito: esiti.esito,
            esiti_notificati: esiti.notificati,
            riconciliazione: conti ?? null,
        }

        if (esitoBattito !== 'ok') {
            // Un passo non è riuscito, o una riga è rimasta trattenuta: `500`, non `200`. I passi che non
            // dipendevano da lui hanno girato lo stesso, e il corpo dice quanto.
            return NextResponse.json(
                {
                    ok: false,
                    motivo: motivoGuasto,
                    ...(codiceGuasto === null ? {} : { error_code: codiceGuasto }),
                    ...corpo,
                },
                { status: 500 },
            )
        }

        return NextResponse.json({ ok: true, ...corpo })
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
                n_righe: nTimbrati + nUsciteRimosse,
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
            n_flusso_vecchio_revocati: nFlussoVecchioRevocati,
            n_flusso_vecchio_rifiutati: nFlussoVecchioRifiutati,
            n_non_pubblicati_scaduti: nNonPubblicatiScaduti,
            n_non_pubblicati_rifiutati: nNonPubblicatiRifiutati,
            n_abbandonati: nAbbandonati,
            n_incagliati: nIncagliati,
            n_conclusi_senza_scadenza: nSenzaScadenza,
            n_uscite_dichiarate: nUsciteDichiarate,
            n_originali_scaduti: nScaduti,
            n_originali_rimossi: nTimbrati,
            n_originali_trattenuti: nTrattenuti,
            n_uscite_scadute: nUsciteScadute,
            n_uscite_rimosse: nUsciteRimosse,
            n_uscite_trattenute: nUsciteTrattenute,
            n_orfani_rimossi: spazzata.rimossi,
            n_originali_risorti_rimossi: spazzata.risorti,
            n_orfani_uscite_rimossi: spazzataUscite.rimossi,
            n_uscite_risorte_rimosse: spazzataUscite.risorti,
            n_intenti_minimizzati: nIntentiMinimizzati,
            n_outbox_presi: outbox.presi,
            n_outbox_inviati: outbox.inviati,
            n_outbox_senza_destinatario: outbox.senzaDestinatario,
            // I tipi di evento che nessuno sa consegnare: gli eventi fermi nella coda, contati sul campione (#115).
            n_outbox_non_registrati: nOutboxNonRegistrati,
            // Un booleano e non l'`esito`: la redazione dei log è a lista bianca, e una stringa sotto una
            // chiave che non ci sta (`esiti_esito`) uscirebbe in `app_log` come «[redatto:str/13]». Vero se la
            // scansione è girata in questo giro (anche a zero notifiche): falso solo se il giro si è fermato prima.
            esiti_eseguita: esiti.esito !== SCANSIONE_ESITI_NON_ESEGUITA.esito,
            n_esiti_notificati: esiti.notificati,
            // ── I CONTEGGI DELLA RICONCILIAZIONE ──
            // Stanno nel battito perché è l'unico posto che resta interrogabile in SQL per trenta
            // giorni, e dicono se la conservazione lavora: `uscite_da_togliere` è lavoro che aspetta
            // (a regime, dopo un giro, zero o poco più di un lotto), `uscite_senza_scadenza` la rete
            // vista da fuori. `null` vuol dire «non misurato» — la riconciliazione non è girata, o non
            // ha potuto leggere `storage.objects` —, e NON è zero. Fino al file C della PR 2 qui c'era
            // il «buco dichiarato» delle uscite senza termine: chiuso, e con lui il suo contatore.
            n_uscite_da_togliere: numeroONull(conti, 'uscite_da_togliere'),
            n_uscite_senza_scadenza: numeroONull(conti, 'uscite_senza_scadenza'),
            n_pubblicazioni_in_attesa: numeroONull(conti, 'pubblicazioni_in_attesa'),
            n_esiti_da_notificare: numeroONull(conti, 'esiti_da_notificare'),
            n_arrivi_mancati: numeroONull(conti, 'arrivi_mancati'),
            n_flusso_vecchio_in_volo: numeroONull(conti, 'flusso_vecchio_in_volo'),
            n_outbox_in_ritardo: numeroONull(conti, 'outbox_in_ritardo'),
            ms: Date.now() - t0,
        })
    }
})
