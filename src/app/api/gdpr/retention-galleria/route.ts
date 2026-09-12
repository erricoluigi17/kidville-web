import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import {
    GIORNI_CESTINO_GALLERIA,
    sogliaScadenzaCestino,
    soloNelCestino,
    ancheNelCestino,
    colonnaCestinoAssente,
} from '@/lib/gallery/cestino'
import { BUCKET_GALLERIA, percorsoNelBucket } from '@/lib/gallery/storage'

/**
 * LA PURGA DEL CESTINO DELLA GALLERIA — la riga, il file, e gli orfani del bucket.
 *
 * ─── PERCHÉ ESISTE: UNA PROMESSA CHE OGGI NON È MANTENUTA ───────────────────
 *
 * Dal 2026-09-11 «Elimina» non distrugge più: NASCONDE. La riga resta in
 * `galleria_media_v2` con `eliminato_il` valorizzato, il file resta nel bucket, e
 * il dialogo che l'insegnante legge prima di confermare
 * (`DialogoEliminaMedia.tsx`) le promette due cose:
 *   · «la segreteria può ripristinarla entro 30 giorni»;
 *   · e, passati quelli, che la foto **viene distrutta**.
 *
 * La prima metà è vera. La seconda, fino a questo file, non era mantenuta da
 * NIENTE: nessun lavoro cancellava la riga, nessuno toglieva il file. «Entro 30
 * giorni viene distrutta» era una frase sullo schermo, e la foto di un bambino
 * restava nell'archivio per sempre — invisibile alle famiglie e non cancellata,
 * che è la definizione di guasto peggiore secondo `rimozione-verificata.ts`.
 * Un'interfaccia che promette ciò che il sistema non fa è un difetto, e il fatto
 * che il difetto sia una promessa in italiano invece di un `500` non lo rende
 * meno tale: qui la promessa è la dichiarazione dell'art. 13 §2 lett. a su un
 * dato di un minore.
 *
 * ─── PERCHÉ È UNA ROUTE HTTP E NON UNA FUNZIONE SQL ─────────────────────────
 *
 * Per la stessa ragione dei suoi due gemelli (`retention-candidature`,
 * `retention-personale`), e la ragione è misurata, non stilistica: **i file si
 * togliono solo dalla Storage API**. Da Postgres non ci si arriva —
 * `storage.objects` ha il trigger `protect_objects_delete`, FOR EACH STATEMENT,
 * che scatta anche a zero righe (`42501`) — e comunque cancellare la riga di
 * `storage.objects` toglie l'indice, non il binario. Il lock
 * `__tests__/architecture/storage-delete-vietata-in-sql.test.ts` lo vieta per
 * iscritto. Quindi: route HTTP, chiamata da `pg_cron` via `pg_net`.
 *
 * ─── LE SEI REGOLE, IN ORDINE DI IMPORTANZA ─────────────────────────────────
 *
 * 1. **PRIMA IL FILE, POI LA RIGA — e per riga, non per lotto.** Al contrario,
 *    un errore a metà lascerebbe la foto nel bucket senza più nessuna riga che
 *    la nomini: irraggiungibile, non cancellata, e nemmeno identificabile per
 *    cancellarla se una famiglia lo chiedesse. Un file che non esce trattiene
 *    **la sua** riga, non le altre: `bloccanti(esito)` dice quali, e quelle
 *    restano nel cestino per il giro dopo. La regola sta scritta in
 *    `rimozione-verificata.ts` e la applica già `obliaFotoAlunno`: «fra
 *    un'immagine rotta e una foto pubblica per sempre, si sceglie l'immagine
 *    rotta».
 *
 * 2. **UN FILE CHE UN'ALTRA RIGA NOMINA ANCORA NON SI TOCCA.** Su `file_url` non
 *    c'è nessun indice UNIQUE, e non è un'ipotesi: il 2026-09-12 due righe VIVE
 *    condividono lo stesso percorso in produzione, nate a 0,33 secondi di
 *    distanza da una `POST` dei metadati arrivata due volte. Cestinarne una e
 *    lasciare l'altra è il gesto più naturale del mondo («compare due volte, ne
 *    elimino una»), e trenta giorni dopo distruggerebbe il file di una foto viva
 *    che una famiglia sta guardando. Prima del `remove` si chiede al database
 *    quali percorsi siano ancora reclamati da una riga FUORI dal lotto, e quelli
 *    si lasciano dov'è. La riga scaduta si cancella comunque — il file è di chi lo
 *    nomina ancora — ma il fatto si dichiara (`n_file_ancora_reclamati`): un `200`
 *    che dicesse «distrutto» su un file rimasto è la bugia che questo intero file
 *    esiste per non raccontare.
 *
 * 3. **FRA IL FILE E LA RIGA C'È `file_rimosso_il`.** Appena lo Storage conferma
 *    che il file è uscito si timbra la riga, e solo DOPO si cancella. Se la
 *    `delete` fallisce, il timbro è già lì: il giro dopo riprende quella riga
 *    senza richiedere niente allo Storage (il file non c'è più, chiederlo di
 *    nuovo produrrebbe soltanto un `info` «già assente»), e nel frattempo il
 *    cestino non offre più un «Ripristina» su una foto che non esiste —
 *    `soloNelCestino` filtra `file_rimosso_il IS NULL` proprio per questo.
 *    È la colonna che rende questa purga IDEMPOTENTE, ed è il motivo per cui le
 *    righe da trattare si leggono in DUE lotti (vedi `LOTTO A`/`LOTTO B`).
 *
 * 4. **IL BATTITO SI SCRIVE SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
 *    FALLIRE.** Sta in un `finally`. Con i soli errori, «nessun log» non
 *    distingue «non c'era niente nel cestino» da «la purga non parte più» — ed è
 *    l'ambiguità che ha nascosto per mesi il guasto delle email. Nella versione
 *    SQL del primo gemello l'`INSERT` in `app_log` stava DOPO la `DELETE`:
 *    l'eccezione lo saltava, e la difesa che doveva accorgersi del guasto era a
 *    valle del guasto.
 *
 * 5. **RIGHE TRATTENUTE ⇒ 500.** Un `200` direbbe «fatto» a chi sorveglia il
 *    lavoro notturno, e resterebbero foto di minori nell'archivio oltre il
 *    termine promesso senza che nessuno lo sappia.
 *
 * 6. **NESSUN FILTRO DI SEDE, e non è una dimenticanza.** Un termine di
 *    conservazione non ha confini di plesso: una foto messa nel cestino a
 *    Giugliano scade lo stesso giorno di una di Aversa e di una di Cesa. Un
 *    `.in('scuola_id', plessi)` qui non proteggerebbe nessuno — lascerebbe
 *    indietro i plessi che il job non conosce, e li lascerebbe indietro IN
 *    SILENZIO, perché il conteggio nel battito direbbe comunque «ok». E non c'è
 *    nessun utente da cui derivare uno scope: la chiama `pg_net` con
 *    `x-cron-secret`. La ragione è dichiarata in
 *    `__tests__/architecture/isolamento-sede-coverage.test.ts`, dove la stessa
 *    esenzione è già scritta per i due gemelli.
 *
 * ─── COSA NON ENTRA NEI LOG, E QUI CONTA PIÙ CHE ALTROVE ────────────────────
 *
 * Niente percorsi, niente nomi di file, niente didascalie. Il percorso nel
 * bucket `gallery` è `uploads/<uuid utente>/<nome>`: è la chiave con cui si
 * firma la foto di un bambino in un bucket privato, cioè una credenziale. E la
 * DIDASCALIA è spesso il nome del bambino. `app_log` è interrogabile in SQL per
 * 30 giorni. Da qui escono conteggi, uuid, date ed enumerati, e basta.
 */

/** Il nome con cui questo lavoro si presenta in `app_log` e in `cron.job`. */
const JOB = 'galleria-retention'

/**
 * IL TETTO DEL LOTTO. Una lettura senza `.limit()` non è «tutte le righe»: è
 * «tutte finché qualcun altro non decide di tagliare» (`db-max-rows` di
 * PostgREST, il tempo massimo della funzione) — e il taglio di qualcun altro
 * arriva muto. Con un tetto esplicito il taglio è nostro, si sa quand'è avvenuto
 * (`lotto_pieno` nel battito) e il giro dopo riprende dalle più vecchie, perché
 * la lettura è ordinata per `eliminato_il` crescente: la foto in attesa da più
 * tempo è la prima a uscire, non l'ultima.
 */
const TETTO_LOTTO = 500

/**
 * LA GRAZIA DEGLI ORFANI DEL BUCKET: ventiquattro ore.
 *
 * Un oggetto sotto `uploads/` che nessuna riga nomina è un orfano — ma non
 * subito. Il file si carica PRIMA che la riga esista (`PUT` firmata, poi `POST`
 * dei metadati): fra i due gesti c'è un'insegnante su rete mobile che può
 * perdere il campo. Portarle via il file da sotto le mani mentre il
 * caricamento è in corso significherebbe farle ricominciare — e la causa vera
 * degli orfani è esattamente quella metà mancante, che resta aperta.
 *
 * Ventiquattro ore è la stessa soglia di `ORE_CURRICULUM_ORFANO`
 * (`retention-candidature`) e di `ORE_CARICAMENTO_IN_SOSPESO` (modulo del
 * personale), e per la stessa ragione: il margine deve coprire abbondantemente
 * un caricamento interrotto e ripreso.
 *
 * ⚠️ IL TETTO VERO È SOGLIA + UN GIRO DI CRON. Con una corsa a notte
 * (`23 5 * * *`) un file che alla corsa di stanotte ha 23 ore sopravvive e se ne
 * va solo domani notte, a ~47. È l'aritmetica che il lock
 * `informativa-termine-orfani-sostenibile` fa rispettare sul gemello, ed è il
 * motivo per cui l'informativa NON promette un termine in ore su questi
 * orfani: qui il termine dichiarato è quello del cestino (trenta giorni), e la
 * spazzata è manutenzione di un archivio, non un termine promesso a nessuno.
 */
const ORE_GRAZIA_ORFANI = 24

/**
 * IL PREFISSO SOTTO CUI VIVONO I MEDIA, e perché l'elenco è a DUE livelli.
 *
 * Qui sta la differenza vera con `spazzaCurriculumOrfani`, ed è misurata:
 * sotto `candidature/` gli oggetti sono piatti, sotto `uploads/` **no**. In
 * produzione, il 2026-09-12: 1.352 oggetti nel bucket `gallery`, TUTTI con tre
 * segmenti di percorso (`uploads/<uuid utente>/<nome>`), zero con due, e 37
 * cartelle-utente distinte.
 *
 *   select count(*) filter (where array_length(path_tokens,1) = 3),
 *          count(distinct path_tokens[2])
 *     from storage.objects where bucket_id = 'gallery';
 *
 * `list('uploads')` restituisce quindi le 37 CARTELLE (`id = null`), non i file:
 * una spazzata copiata dal gemello riga per riga avrebbe guardato 37 voci, non
 * ne avrebbe riconosciuta nessuna come oggetto, e avrebbe riferito «zero orfani»
 * ogni notte — verde, e cieca. Per questo si scende di un livello.
 */
const PREFISSO_UPLOADS = 'uploads'

/**
 * Quante CARTELLE si guardano per giro, e quanti FILE dentro ognuna.
 *
 * Mille è il massimo che la Storage API serve in una pagina. Il tetto non è
 * prudenza teorica: una pagina piena è un elenco TRONCATO, cioè oggetti che
 * nessuno ha nemmeno guardato, e un troncamento silenzioso racconterebbe una
 * pulizia completa che non è avvenuta. Perciò si dichiara (`orfani_troncato`).
 * Oggi le cartelle sono 37 e la più popolosa non arriva a un migliaio.
 */
const TETTO_CARTELLE = 1000
const TETTO_FILE_PER_CARTELLA = 1000

/**
 * A quanti percorsi per volta si chiede al database «questo lo reclama qualcuno?».
 *
 * `.in()` finisce nella query string di PostgREST, e una `IN` con mille valori
 * produce un URL che nessuno garantisce venga accettato per intero. Cento è la
 * misura prudente su un lavoro che gira una volta a notte.
 *
 * ⚠️ Serve a DUE domande, non solo alla spazzata degli orfani (per questo non si
 * chiama più `LOTTO_RECLAMI`): «nessuna riga nomina questo oggetto?» per
 * gli orfani, e «una riga FUORI da questo lotto nomina ancora questo percorso?»
 * per la purga del cestino. Sono la stessa domanda dalle due parti.
 */
const LOTTO_RECLAMI = 100

/**
 * QUANTI ID PER VOLTA in una scrittura che nomina le righe per `id`.
 *
 * Lo stesso vincolo di `LOTTO_RECLAMI`, e la stessa aritmetica: un uuid sono 36
 * caratteri, più la codifica dei separatori. Un lotto pieno di questo lavoro sono
 * `TETTO_LOTTO` righe per lotto e fino a `2 × TETTO_LOTTO` id nella `delete`
 * (quelle appena timbrate più quelle della ripresa): mille uuid in una query
 * string sono ~45 KB, oltre i limiti tipici del proxy davanti a PostgREST.
 *
 * ⚠️ Non è teoria misurata a zero: oggi nel cestino ci sono **3 righe** (misurato
 * il 2026-09-12), quindi il tetto non si raggiunge. Ma il giorno in cui lo si
 * raggiunge il fallimento non sarebbe un giro perso, sarebbe un INCAGLIO che si
 * ripresenta identico ogni notte — i file già rimossi, le righe non timbrate, e
 * il giro dopo che ritenta con gli stessi mille. E questo stesso file, cento
 * righe più su, argomenta già esattamente questo per le letture: applicarlo alle
 * letture e non alle scritture era incoerente.
 *
 * Ogni pezzo porta il SUO `count`, e i `count` si SOMMANO: così
 * `conteggio_verificato` resta una misura e non un'intenzione anche a lotti.
 */
const LOTTO_SCRITTURA = 100

/**
 * IL DB DELLA CI NON È MIGRATO, e il codice deve degradare in modo DICHIARATO.
 * Tabella assente ⇒ 503 con il codice, mai un `200` bugiardo: «non ho cancellato
 * niente perché la tabella non c'è» e «non c'era niente da cancellare» sono due
 * fatti diversi, e confonderli è il guasto invisibile.
 */
const CODICI_TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

/** Il codice PostgREST/Postgres dell'errore, se c'è. */
function codiceDi(errore: unknown): string {
    const c = (errore as { code?: unknown } | null)?.code
    return typeof c === 'string' ? c : ''
}

const NIENTE_DA_TOGLIERE: EsitoRimozione = {
    rimossi: [],
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
}

type RigaCestino = {
    id: string
    file_url?: string | null
    eliminato_il?: string | null
}

/**
 * ─── LA RAGIONE DEI DUE `ancheNelCestino` DI QUESTO FILE ────────────────────
 *
 * Il lock `cestino-galleria-ogni-lettura-dichiara` pretende che ogni query su
 * `galleria_media_v2` dichiari il suo verso, e `ancheNelCestino` è l'identità con
 * l'obbligo di scrivere perché. Le ragioni stanno accanto a ciascuna chiamata e
 * non sono intercambiabili: una riguarda la RIPRESA dopo una `delete` fallita,
 * l'altra la domanda «questo file lo reclama qualcuno?», dove una riga nel
 * cestino reclama ancora il suo file eccome.
 */

/** Quello che la spazzata degli orfani ha fatto, per il battito e per la risposta. */
interface EsitoSpazzata {
    /** Cartelle-utente effettivamente elencate sotto il prefisso. */
    cartelle: number
    /** Oggetti più vecchi della grazia, effettivamente guardati. */
    esaminati: number
    /** …di cui nessuna riga di `galleria_media_v2` porta il percorso. */
    orfani: number
    /** …e che sono davvero usciti dall'archivio. */
    rimossi: number
    /** Una pagina era piena: là sotto c'è dell'altro che nessuno ha guardato. */
    troncato: boolean
    /**
     * ⚠️ `non-eseguita` NON è `ok`. La spazzata gira in coda al PERCORSO FELICE:
     * se il lotto principale trattiene delle righe la route esce prima, e la
     * spazzata non parte affatto. Con un valore iniziale `'ok'` il battito nel
     * `finally` scriverebbe «guardato, niente da fare» su un giro in cui nessuno
     * ha guardato niente — l'ambiguità che l'intero file esiste per togliere.
     */
    esito:
        | 'ok'
        | 'non-eseguita'
        | 'elenco-non-letto'
        | 'reclami-non-leggibili'
        | 'verifica-non-riuscita'
        | 'rimozione-non-riuscita'
}

const SPAZZATA_NON_ESEGUITA: EsitoSpazzata = {
    cartelle: 0,
    esaminati: 0,
    orfani: 0,
    rimossi: 0,
    troncato: false,
    esito: 'non-eseguita',
}

/** Una voce d'elenco della Storage API, nella forma minima che serve qui. */
type VoceStorage = { name?: string | null; id?: string | null; created_at?: string | null }

/** Il segnaposto che lo Storage crea da sé quando una cartella resta vuota. */
const SEGNAPOSTO_CARTELLA = '.emptyFolderPlaceholder'

/** È un OGGETTO (e non una voce-cartella, che ha `id === null`)? */
function eUnOggetto(v: VoceStorage): boolean {
    return typeof v?.id === 'string' && v.id !== '' && (v.name ?? '') !== '' && v.name !== SEGNAPOSTO_CARTELLA
}

/** È una voce-CARTELLA? `id === null` è il modo in cui la Storage API lo dice. */
function eUnaCartella(v: VoceStorage): boolean {
    return (v?.id ?? null) === null && (v.name ?? '') !== '' && v.name !== SEGNAPOSTO_CARTELLA
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  GLI ORFANI DEL BUCKET — i 26 file che nessuna riga nomina                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL FATTO, MISURATO E NON SUPPOSTO (2026-09-12, sola lettura) ───────────
 *
 * Nel bucket `gallery` ci sono **1.352** oggetti e in `galleria_media_v2` **1.327**
 * righe. La differenza non è un arrotondamento: **26** oggetti non sono nominati
 * da nessuna riga, pesano **19 MB**, e il più vecchio è del **26 maggio 2026**.
 * Ventiquattro di quei 26 hanno più di 24 ore.
 *
 *   with ogg as (select name, created_at from storage.objects
 *                 where bucket_id = 'gallery' and name like 'uploads/%')
 *   select count(*) from ogg
 *    where name not in (select distinct file_url from galleria_media_v2);
 *
 * ── PERCHÉ STA QUI E NON IN UNO SCRIPT UNA-TANTUM ──────────────────────────
 *
 * Perché **gli orfani nascono da soli**: 26 in tre mesi e mezzo, e la causa
 * resta aperta — il file si carica con una `PUT` firmata e la riga nasce con una
 * `POST` successiva, quindi una `POST` che non arriva lascia il file nel bucket
 * senza nessuna riga che lo nomini. Uno script una-tantum chiude il conto di
 * oggi e riapre quello di domani; una spazzata notturna lo tiene chiuso.
 *
 * È anche lo stato che questo repo chiama, con parole sue, «il modo peggiore di
 * conservare un dato personale»: quelle sono foto di bambini, invisibili nel
 * prodotto, non cancellate, e non identificabili per cancellarle se una famiglia
 * lo chiedesse — perché l'oblio parte dalle RIGHE.
 *
 * ── LE CINQUE PRUDENZE ─────────────────────────────────────────────────────
 *
 *  1. **Solo ciò che è vecchio** (24 ore): un caricamento in corso non deve
 *     trovarsi il file portato via da sotto.
 *  2. **Prima si chiede al database, poi si cancella.** Se la lettura dei
 *     reclami fallisce non si tocca NIENTE: «non so quali file siano reclamati»
 *     vale «sono tutti reclamati». Stesso verso di `rimuoviEVerifica`, dove «non
 *     so se il file c'è ancora» vale «c'è».
 *  3. **La domanda comprende il CESTINO.** Una riga cestinata reclama ancora il
 *     suo file: è la condizione del «Ripristina». Filtrare le sole vive
 *     dichiarerebbe orfano il file di ogni foto nel cestino e lo porterebbe via
 *     — cioè distruggerebbe a 24 ore ciò che il prodotto promette di custodire
 *     per trenta giorni, e offrirebbe un «Ripristina» su un'immagine rotta.
 *  4. **La FORMA dei reclami si verifica prima di fidarsi.** Vedi
 *     `reclamiConfrontabili`: qui un falso negativo non costa un file in più,
 *     costa la foto di un bambino cancellata mentre la sua riga era viva.
 *  5. **Il troncamento si dichiara** e **non lancia mai.** Un guasto della
 *     spazzata non può diventare un giro di conservazione fallito: la purga del
 *     cestino risponde a una promessa scritta sullo schermo, la spazzata è
 *     manutenzione.
 */
async function spazzaMediaOrfani(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    adesso: Date,
): Promise<EsitoSpazzata> {
    const soglia = new Date(adesso.getTime() - ORE_GRAZIA_ORFANI * 60 * 60 * 1000)

    // ── PRIMO LIVELLO: le cartelle-utente ───────────────────────────────────
    let radice: VoceStorage[]
    try {
        const { data, error } = await supabase.storage.from(BUCKET_GALLERIA).list(PREFISSO_UPLOADS, {
            limit: TETTO_CARTELLE,
            sortBy: { column: 'name', order: 'asc' },
        })
        if (error) {
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'orfani-elenco-non-letto',
                    bucket: BUCKET_GALLERIA,
                    msg: `${JOB}: elenco delle cartelle sotto il prefisso dei media non letto: nessun orfano rimosso`,
                },
                error,
            )
            return { ...SPAZZATA_NON_ESEGUITA, esito: 'elenco-non-letto' }
        }
        radice = (data ?? []) as VoceStorage[]
    } catch (e) {
        // La Storage API può LANCIARE (rete, JSON malformato): qui si assorbe, e si
        // dice che si è assorbito. Un `catch` muto è un bug.
        logEvento(
            'cron',
            'error',
            {
                operazione: JOB,
                esito: 'orfani-elenco-non-letto',
                bucket: BUCKET_GALLERIA,
                msg: `${JOB}: eccezione elencando le cartelle sotto il prefisso dei media`,
            },
            e,
        )
        return { ...SPAZZATA_NON_ESEGUITA, esito: 'elenco-non-letto' }
    }

    let troncato = radice.length >= TETTO_CARTELLE
    // Un oggetto direttamente sotto `uploads/` oggi non esiste (misurato: 0 su
    // 1.352), ma se ne comparisse uno va guardato come tutti gli altri: un
    // riconoscitore che salta una forma che non si aspetta è un riconoscitore che
    // tace proprio sul caso nuovo.
    const candidati: string[] = radice
        .filter(eUnOggetto)
        .filter((o) => vecchioAbbastanza(o, soglia))
        .map((o) => `${PREFISSO_UPLOADS}/${o.name}`)

    const cartelle = radice.filter(eUnaCartella)
    // Un elenco che non si legge SALTA la sua cartella e lo dichiara: l'orfanità
    // di un percorso la decide il DATABASE, non questo elenco, quindi una cartella
    // non letta produce MENO rimozioni e mai una rimozione sbagliata. L'esito però
    // non può restare `ok`: chi legge il battito deve sapere che la pulizia di
    // stanotte non ha guardato tutto.
    let elencoIncompleto = false
    for (const c of cartelle) {
        const cartella = `${PREFISSO_UPLOADS}/${c.name}`
        let dentro: VoceStorage[]
        try {
            const { data, error } = await supabase.storage.from(BUCKET_GALLERIA).list(cartella, {
                limit: TETTO_FILE_PER_CARTELLA,
                // I più vecchi per primi: se la pagina taglia, taglia i meno in ritardo.
                sortBy: { column: 'created_at', order: 'asc' },
            })
            if (error) {
                elencoIncompleto = true
                logEvento(
                    'cron',
                    'error',
                    {
                        operazione: JOB,
                        esito: 'orfani-cartella-non-letta',
                        bucket: BUCKET_GALLERIA,
                        msg: `${JOB}: una cartella-utente del prefisso dei media non si è potuta elencare: i suoi oggetti non sono stati guardati`,
                    },
                    error,
                )
                continue
            }
            dentro = (data ?? []) as VoceStorage[]
        } catch (e) {
            elencoIncompleto = true
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'orfani-cartella-non-letta',
                    bucket: BUCKET_GALLERIA,
                    msg: `${JOB}: eccezione elencando una cartella-utente del prefisso dei media`,
                },
                e,
            )
            continue
        }
        if (dentro.length >= TETTO_FILE_PER_CARTELLA) troncato = true
        for (const o of dentro) {
            if (!eUnOggetto(o) || !vecchioAbbastanza(o, soglia)) continue
            candidati.push(`${cartella}/${o.name}`)
        }
    }

    const esitoElenco = elencoIncompleto ? 'elenco-non-letto' : 'ok'
    const base = { cartelle: cartelle.length, troncato }

    if (candidati.length === 0) {
        return { ...base, esaminati: 0, orfani: 0, rimossi: 0, esito: esitoElenco }
    }

    // ── LA FORMA DEI RECLAMI, prima di fidarsene ────────────────────────────
    const confrontabili = await reclamiConfrontabili(supabase)
    if (!confrontabili) {
        return { ...base, esaminati: candidati.length, orfani: 0, rimossi: 0, esito: 'reclami-non-leggibili' }
    }

    // ── CHI È RECLAMATO DA UNA RIGA? ────────────────────────────────────────
    const reclamati = new Set<string>()
    for (let i = 0; i < candidati.length; i += LOTTO_RECLAMI) {
        const lotto = candidati.slice(i, i + LOTTO_RECLAMI)
        const { data, error } = await ancheNelCestino(
            supabase.from('galleria_media_v2').select('file_url').in('file_url', lotto),
            'una riga NEL CESTINO reclama ancora il suo file: è la condizione stessa del «Ripristina» che il ' +
                'prodotto promette per trenta giorni. Filtrando le sole vive, ogni foto cestinata diventerebbe ' +
                'un orfano e il suo file uscirebbe dal bucket a ventiquattro ore: la purga a trenta giorni non ' +
                'troverebbe più niente da togliere e la segreteria si vedrebbe offrire un «Ripristina» che ' +
                'restituisce un riquadro rotto. Qui il verso sbagliato è filtrare.',
        )
        if (error) {
            // FAIL-CLOSED, e vale per l'INTERA spazzata e non per il solo lotto: con
            // una parte dei reclami sconosciuta, gli orfani calcolati sui lotti
            // riusciti comprenderebbero file che una riga nomina davvero.
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: 'orfani-verifica-non-riuscita',
                    bucket: BUCKET_GALLERIA,
                    error_code: codiceDi(error),
                    n_file: candidati.length,
                    msg: `${JOB}: non si è potuto sapere quali media siano reclamati da una riga: NESSUN orfano rimosso`,
                },
                error,
            )
            return { ...base, esaminati: candidati.length, orfani: 0, rimossi: 0, esito: 'verifica-non-riuscita' }
        }
        for (const r of (data ?? []) as { file_url?: unknown }[]) {
            if (typeof r.file_url === 'string' && r.file_url !== '') reclamati.add(r.file_url)
        }
    }

    const orfani = candidati.filter((p) => !reclamati.has(p))
    if (orfani.length === 0) {
        return { ...base, esaminati: candidati.length, orfani: 0, rimossi: 0, esito: esitoElenco }
    }

    const rimozione = await rimuoviEVerifica(supabase, BUCKET_GALLERIA, orfani, JOB)
    const bloccati = bloccanti(rimozione)
    if (rimozione.erroreRimozione || bloccati.length > 0) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'orfani-non-rimossi',
            bucket: BUCKET_GALLERIA,
            n_file: orfani.length,
            n_file_bloccanti: bloccati.length,
            msg: `${JOB}: media orfani non rimossi (o non verificabili): restano nell'archivio senza nessuna riga che li nomini`,
        })
        return {
            ...base,
            esaminati: candidati.length,
            orfani: orfani.length,
            rimossi: rimozione.rimossi.length,
            esito: 'rimozione-non-riuscita',
        }
    }

    // Il SUCCESSO si logga, e qui più che altrove: questa pulizia non ha nessuna
    // schermata che si riempie a vista e nessuno che telefoni se smette di girare.
    logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'orfani-rimossi',
        bucket: BUCKET_GALLERIA,
        n_file: rimozione.rimossi.length,
        n_file_gia_assenti: rimozione.giaAssenti.length,
        ore: ORE_GRAZIA_ORFANI,
        msg: `${JOB}: ${rimozione.rimossi.length} media caricati e mai registrati, più vecchi di ${ORE_GRAZIA_ORFANI} ore, tolti dall'archivio`,
    })
    return {
        ...base,
        esaminati: candidati.length,
        orfani: orfani.length,
        rimossi: rimozione.rimossi.length,
        esito: esitoElenco,
    }
}

/**
 * L'oggetto è più vecchio della grazia?
 *
 * Data illeggibile o assente ⇒ **no**: su un'operazione irreversibile «non
 * verificabile» vale «non toccare», ed è lo stesso verso di tutto il resto di
 * questo file.
 */
function vecchioAbbastanza(o: VoceStorage, soglia: Date): boolean {
    const nato = Date.parse(o.created_at ?? '')
    return !Number.isNaN(nato) && nato <= soglia.getTime()
}

/**
 * LA DOMANDA «QUESTO PERCORSO LO RECLAMA QUALCUNO?» SA RISPONDERE?
 *
 * ─── PERCHÉ QUESTO CONTROLLO ESISTE, ED È IL PIÙ IMPORTANTE DELLA SPAZZATA ──
 *
 * La spazzata confronta i percorsi elencati nel bucket con `file_url` **per
 * uguaglianza** (`.in('file_url', lotto)`). Il confronto funziona solo se
 * `file_url` porta il PERCORSO NUDO — ed è così per tutte le righe di oggi
 * (misurato il 2026-09-12: 1.327 su 1.327 cominciano per `uploads/`, zero sono
 * URL completi). Ma la colonna ammette anche le altre due forme che
 * `percorsoNelBucket` sa leggere: l'URL pubblico delle righe storiche, di quando
 * il bucket era pubblico, e un URL già firmato.
 *
 * Se una riga VIVA portasse una di quelle forme, `.in('file_url', …)` non la
 * troverebbe, il suo file risulterebbe «non reclamato da nessuno» e la spazzata
 * lo porterebbe via: **la foto di un bambino cancellata dal bucket mentre la sua
 * riga è viva e la sua famiglia la sta guardando**. Non è il costo di un file in
 * più conservato: è il danno opposto, ed è irreversibile.
 *
 * Perciò, prima di fidarsi del confronto, si CONTA quante righe non sono nella
 * forma confrontabile. Se ce n'è anche una sola, la spazzata non parte e lo dice
 * (`reclami-non-leggibili`): la purga del cestino, che è la promessa vera, gira
 * comunque. Fra una spazzata che salta un giro e una foto viva distrutta, non
 * c'è scelta da fare.
 *
 * ⚠️ `head: true` + `count: 'exact'`: si chiede QUANTE, non QUALI. Nessun
 * `file_url` attraversa questa funzione, e quindi nessun percorso può finire in
 * un log per sbaglio.
 *
 * ⚠️ Anche un percorso con la barra iniziale (`/uploads/…`) cade qui, ed è
 * corretto: nel bucket l'oggetto si chiama `uploads/…`, quindi l'uguaglianza non
 * scatterebbe. Il verso dell'errore è quello che CONSERVA.
 */
async function reclamiConfrontabili(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
): Promise<boolean> {
    const { count, error } = await ancheNelCestino(
        supabase
            .from('galleria_media_v2')
            .select('id', { count: 'exact', head: true })
            .not('file_url', 'like', `${PREFISSO_UPLOADS}/%`),
        'si contano le righe di TUTTA la tabella, cestino compreso, perché anche una riga cestinata reclama il ' +
            'suo file e deve poter impedire che la spazzata lo dichiari orfano. Filtrando le sole vive, una ' +
            'riga nel cestino con un `file_url` in forma di URL passerebbe inosservata e il confronto per ' +
            'uguaglianza la salterebbe: il suo file uscirebbe dal bucket mentre il prodotto promette trenta ' +
            'giorni di «Ripristina».',
    )
    if (error) {
        logEvento(
            'cron',
            'error',
            {
                operazione: JOB,
                esito: 'orfani-forma-reclami-ignota',
                error_code: codiceDi(error),
                msg: `${JOB}: non si è potuto sapere se i percorsi in tabella siano confrontabili: NESSUN orfano rimosso`,
            },
            error,
        )
        return false
    }
    if ((count ?? 0) > 0) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'orfani-forma-reclami-non-confrontabile',
            n_righe: count ?? 0,
            msg:
                `${JOB}: ${count ?? 0} righe non portano un percorso nudo (URL completo o firmato): il confronto ` +
                `per uguaglianza le salterebbe e la spazzata dichiarerebbe orfani file ancora reclamati. ` +
                `NESSUN orfano rimosso: prima si normalizza quella colonna`,
        })
        return false
    }
    return true
}

// POST /api/gdpr/retention-galleria
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-galleria:POST', async (request: NextRequest) => {
    const t0 = Date.now()
    let canale = 'cron'

    // ── I CONTATORI DEL BATTITO ──
    // Vivono QUI, fuori da ogni ramo che può fallire, e si scrivono nel `finally`.
    let esitoBattito = 'ok'
    let nScadute = 0
    let nCancellate = 0
    let nTrattenute = 0
    let nBloccanti = 0
    let nAncoraReclamati = 0
    let nSegnalazioni = 0
    let segnalazioniEsito = 'non-eseguita'
    let lottoPieno = false
    let conteggioVerificato = false
    let esito: EsitoRimozione = NIENTE_DA_TOGLIERE
    let spazzata: EsitoSpazzata = SPAZZATA_NON_ESEGUITA

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
        const soglia = sogliaScadenzaCestino(adesso)

        // ── LOTTO A — le righe scadute il cui FILE è ancora nel bucket ───────
        //
        // `soloNelCestino(q, soglia)` porta le tre condizioni che servono, e le
        // porta in un posto solo: `eliminato_il IS NOT NULL`,
        // `file_rimosso_il IS NULL`, `eliminato_il < soglia`. Ordinate per
        // `eliminato_il` crescente, perché se il tetto taglia deve tagliare le meno
        // in ritardo.
        const { data: datiA, error: erroreA } = await soloNelCestino(
            supabase.from('galleria_media_v2').select('id, file_url, eliminato_il'),
            soglia,
        )
            .order('eliminato_il', { ascending: true })
            .limit(TETTO_LOTTO)

        if (erroreA && colonnaCestinoAssente(erroreA)) {
            // Il database E2E della CI è un progetto separato e NON migrato: là le
            // tre colonne del cestino non esistono, quindi non esiste nemmeno un
            // cestino da purgare. Si dichiara e si esce: un `200` qui direbbe
            // «cestino vuoto», che è un altro fatto.
            esitoBattito = 'colonne-cestino-assenti'
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                error_code: codiceDi(erroreA),
                ms: Date.now() - t0,
                msg:
                    `${JOB}: le colonne del cestino non esistono su questo database, quindi non c'è nessun ` +
                    `cestino da purgare: nessuna riga trattata, e non si finge il contrario`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codiceDi(erroreA) },
                { status: 503 },
            )
        }

        if (erroreA) {
            const codice = codiceDi(erroreA)
            const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
            esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    error_code: codice,
                    ms: Date.now() - t0,
                    msg: tabellaAssente
                        ? `${JOB}: la tabella galleria_media_v2 non esiste su questo database (${codice}): nessuna cancellazione, e non si finge il contrario`
                        : `${JOB}: lettura delle righe scadute nel cestino non riuscita`,
                },
                erroreA,
            )
            // `{ ok, motivo }` e non `{ error }`: questa route la chiama pg_net, non
            // un browser. Una prosa italiana qui non la legge nessun utente.
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: tabellaAssente ? 503 : 500 },
            )
        }

        const conFile = (datiA ?? []) as unknown as RigaCestino[]

        // ── LOTTO B — le righe il cui file è GIÀ uscito ──────────────────────
        //
        // È la RIPRESA, e senza di lei la purga non sarebbe idempotente ma
        // AMNESICA: se la `delete` del lotto A fallisce dopo che `file_rimosso_il`
        // è stato scritto, quella riga esce per sempre dal raggio di
        // `soloNelCestino` (che filtra `file_rimosso_il IS NULL`) e non verrebbe
        // più cancellata da nessun giro — la foto di un minore resterebbe in
        // tabella per sempre, col file già distrutto e nessuno che lo sappia.
        const { data: datiB, error: erroreB } = await ancheNelCestino(
            supabase
                .from('galleria_media_v2')
                .select('id, eliminato_il')
                .not('eliminato_il', 'is', null)
                .not('file_rimosso_il', 'is', null)
                .lt('eliminato_il', soglia),
            'la RIPRESA dopo una `delete` fallita deve vedere proprio le righe che `soloNelCestino` esclude per ' +
                'costruzione, quelle con `file_rimosso_il` valorizzato. Filtrando le sole ripristinabili, una ' +
                'riga il cui file è già stato distrutto non rientrerebbe in nessun giro successivo e resterebbe ' +
                'in tabella per sempre: la foto di un minore conservata oltre il termine promesso, con il battito ' +
                'che continua a dire «ok». Le due condizioni del cestino sono scritte a mano qui accanto.',
        )
            .order('eliminato_il', { ascending: true })
            .limit(TETTO_LOTTO)

        if (erroreB) {
            esitoBattito = 'lettura-ripresa-fallita'
            logEvento(
                'cron',
                'error',
                {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    error_code: codiceDi(erroreB),
                    n_righe: conFile.length,
                    ms: Date.now() - t0,
                    msg:
                        `${JOB}: lettura delle righe già senza file non riuscita: NESSUNA cancellazione, ` +
                        `nemmeno del lotto che si era potuto leggere`,
                },
                erroreB,
            )
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codiceDi(erroreB) },
                { status: 500 },
            )
        }

        const senzaFile = (datiB ?? []) as unknown as RigaCestino[]
        nScadute = conFile.length + senzaFile.length
        lottoPieno = conFile.length >= TETTO_LOTTO || senzaFile.length >= TETTO_LOTTO

        if (lottoPieno) {
            // Un lotto tagliato che rispondesse `ok` senza dirlo sarebbe un giro
            // riuscito a metà travestito da giro riuscito. L'esito resta `ok` — il
            // lavoro riprende la notte dopo dalle più vecchie — ma il fatto è
            // scritto, e si legge con una query su `app_log`.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'lotto-pieno',
                canale,
                n_righe: conFile.length,
                n_righe_ripresa: senzaFile.length,
                msg: `${JOB}: lotto al tetto di ${TETTO_LOTTO} righe, il giro successivo riprende dalle più vecchie`,
            })
        }

        // ── PRIMA IL FILE ───────────────────────────────────────────────────
        //
        // Ogni riga resta legata al SUO percorso fino alla fine: è ciò che
        // permette di trattenere una riga sola invece dell'intero lotto.
        const perRiga = conFile.map((r) => {
            const percorso = percorsoNelBucket(r.file_url)
            return { id: r.id, percorso }
        })

        // ⚠️ UN `file_url` DA CUI NON SI RICAVA UN PERCORSO NON AUTORIZZA A
        // CANCELLARE LA RIGA. `percorsoNelBucket` risponde `null` per un indirizzo
        // che non appartiene a questo bucket: quel file non è nostro da togliere,
        // e cancellare la riga sarebbe l'unico modo di perdere per sempre l'unica
        // traccia che lo nomina — «invisibile, non cancellato». La riga si
        // TRATTIENE, il giro finisce in 500, e qualcuno va a guardarla.
        // MISURATO il 2026-09-12: in produzione le righe in questa condizione sono
        // ZERO (1.327 su 1.327 portano un percorso `uploads/…`), quindi questo ramo
        // non incaglia nessun giro reale. Se un giorno scattasse, sta scattando su
        // un dato che nessun percorso applicativo produce.
        const senzaPercorso = perRiga.filter((r) => r.percorso === null)
        if (senzaPercorso.length > 0) {
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'percorso-non-ricavabile',
                canale,
                n_righe: senzaPercorso.length,
                msg:
                    `${JOB}: ${senzaPercorso.length} righe scadute portano un file_url da cui non si ricava un ` +
                    `percorso del bucket della galleria: NON si cancellano, perché cancellarle perderebbe ` +
                    `l'unico riferimento a quel file`,
            })
        }

        const daRimuovere = [
            ...new Set(perRiga.map((r) => r.percorso).filter((p): p is string => p !== null)),
        ]

        // ── CHI ALTRO RECLAMA QUESTI PERCORSI? ──────────────────────────────
        //
        // ⚠️ AGGIUNTO IL 2026-09-12, SU UN FATTO MISURATO IN PRODUZIONE, NON SU UN
        // TIMORE. `file_url` non ha nessun indice UNIQUE (verificato su
        // `pg_indexes`, non su `pg_constraint`, che gli indici parziali e unici non
        // li vede), e in questo momento **due righe VIVE condividono lo stesso
        // percorso**:
        //
        //   select file_url from galleria_media_v2
        //    group by file_url having count(*) > 1;   -- 1 gruppo, 2 righe, 0 nel cestino
        //
        // Le due sono nate a **0,33 secondi di distanza**, stesso caricatore, stessa
        // sede, stessa didascalia: non è una foto condivisa per scelta, è una `POST`
        // dei metadati arrivata due volte sullo stesso file caricato una volta sola —
        // lo stesso mezzo guasto che genera gli orfani del bucket, visto dall'altro
        // lato. Quindi si ripresenterà.
        //
        // E la strada che porta al danno è quella che chiunque prenderebbe: «questa
        // foto compare due volte, ne elimino una». `gallery:DELETE` cestina UNA riga
        // per id e non guarda le gemelle. Trenta giorni dopo, senza questo controllo,
        // il lotto A leggerebbe la riga cestinata, `rimuoviEVerifica` toglierebbe il
        // file dal bucket — e **l'altra riga resterebbe viva puntando a un file che
        // non esiste più**: un riquadro rotto nella galleria della famiglia, per
        // sempre, con risposta `200` e battito `esito: 'ok'`.
        //
        // È esattamente il danno che `reclamiConfrontabili` chiama, cento righe più
        // su, «la foto di un bambino cancellata dal bucket mentre la sua riga è viva
        // … irreversibile». Quella guardia stava sulla strada che rimuove i file NON
        // reclamati; questa sta su quella che rimuove i reclamati, che era scoperta.
        //
        // La riga scaduta si cancella comunque: il file resta legittimamente di chi
        // lo nomina ancora, e trattenerla terrebbe nel cestino oltre il termine una
        // foto per una ragione che non la riguarda. Ma NON si dichiara distrutto un
        // file che è rimasto: il fatto esce nel battito come
        // `n_file_ancora_reclamati` e nella risposta come `file_ancora_reclamati`.
        //
        // FAIL-CLOSED come tutto il resto: se questa lettura non risponde, non si
        // rimuove NIENTE e si trattengono le righe. «Non so chi reclami questi
        // percorsi» vale «li reclamano tutti».
        const idsDelGiro = new Set<string>([
            ...perRiga.map((r) => r.id),
            ...senzaFile.map((r) => r.id),
        ])
        const reclamatiAltrove = new Set<string>()
        for (let i = 0; i < daRimuovere.length; i += LOTTO_RECLAMI) {
            const lotto = daRimuovere.slice(i, i + LOTTO_RECLAMI)
            const { data: reclami, error: erroreReclami } = await ancheNelCestino(
                supabase.from('galleria_media_v2').select('id, file_url').in('file_url', lotto),
                'la domanda è «una riga FUORI da questo lotto nomina ancora questo percorso?», e una riga NEL ' +
                    'CESTINO lo nomina eccome: è la condizione stessa del «Ripristina» che il prodotto promette ' +
                    'per trenta giorni. Filtrando le sole vive, una gemella già cestinata non comparirebbe fra i ' +
                    'reclamanti e il file uscirebbe dal bucket mentre quella gemella è ancora ripristinabile: il ' +
                    '«Ripristina» restituirebbe un riquadro rotto. Le righe di QUESTO giro si escludono per `id` ' +
                    'in memoria, non con un filtro: sono loro che stanno uscendo.',
            )
            if (erroreReclami) {
                esitoBattito = 'reclami-non-letti'
                nTrattenute = perRiga.length + senzaFile.length
                logEvento(
                    'cron',
                    'error',
                    {
                        operazione: JOB,
                        esito: esitoBattito,
                        canale,
                        error_code: codiceDi(erroreReclami),
                        n_file: daRimuovere.length,
                        n_righe_trattenute: nTrattenute,
                        ms: Date.now() - t0,
                        msg:
                            `${JOB}: non si è potuto sapere se qualche altra riga nomini ancora questi file: ` +
                            `NESSUN file rimosso e NESSUNA riga cancellata`,
                    },
                    erroreReclami,
                )
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: esitoBattito,
                        righe: 0,
                        righe_trattenute: nTrattenute,
                        file: 0,
                    },
                    { status: 500 },
                )
            }
            for (const r of (reclami ?? []) as { id?: unknown; file_url?: unknown }[]) {
                if (typeof r.id !== 'string' || typeof r.file_url !== 'string') continue
                if (!idsDelGiro.has(r.id)) reclamatiAltrove.add(r.file_url)
            }
        }

        const daTogliere = daRimuovere.filter((p) => !reclamatiAltrove.has(p))
        nAncoraReclamati = daRimuovere.length - daTogliere.length
        if (nAncoraReclamati > 0) {
            // `warn` e non `error`: il lavoro ha fatto la cosa giusta. Ciò che è
            // anomalo è il DATO — due righe sullo stesso percorso — e questa riga è
            // il solo posto da cui si viene a sapere che esiste, perché nel prodotto
            // non si vede da nessuna parte.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'file-ancora-reclamato',
                canale,
                n_file: nAncoraReclamati,
                msg:
                    `${JOB}: ${nAncoraReclamati} file NON si toccano perché un'altra riga li nomina ancora ` +
                    `(nessun indice UNIQUE su file_url): le righe scadute si cancellano, i file restano a chi li reclama`,
            })
        }

        if (daTogliere.length > 0) {
            esito = await rimuoviEVerifica(supabase, BUCKET_GALLERIA, daTogliere, JOB)
            if (esito.erroreRimozione) {
                // La chiamata è fallita: nessun file è uscito e non c'è niente da
                // verificare. Cancellare le righe adesso renderebbe le foto
                // irraggiungibili invece che cancellate. Si riprova il giro dopo.
                esitoBattito = 'file-non-rimossi'
                nTrattenute = perRiga.length + senzaFile.length
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    n_file: daTogliere.length,
                    n_file_ancora_reclamati: nAncoraReclamati,
                    n_righe_trattenute: nTrattenute,
                    ms: Date.now() - t0,
                    msg: `${JOB}: rimozione dei media non riuscita, righe NON cancellate`,
                })
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'file-non-rimossi',
                        righe: 0,
                        righe_trattenute: nTrattenute,
                        file: daTogliere.length,
                    },
                    { status: 500 },
                )
            }
        }

        // Un file ancora nell'archivio — o che non si è potuto verificare —
        // trattiene la SUA riga, e soltanto quella.
        const daNonToccare = new Set(bloccanti(esito))
        nBloccanti = daNonToccare.size
        const chiudibiliConFile = perRiga.filter(
            (r) => r.percorso !== null && !daNonToccare.has(r.percorso),
        )
        nTrattenute = perRiga.length - chiudibiliConFile.length

        // ── IL TIMBRO, fra il file e la riga ────────────────────────────────
        //
        // `file_rimosso_il` si scrive PRIMA della `delete`, e non dopo: è il solo
        // ordine in cui un guasto a metà lascia uno stato recuperabile. Il filtro
        // di `soloNelCestino` sull'UPDATE è una cintura: non si timbra mai una
        // riga viva, nemmeno se gli id arrivassero da una lettura sbagliata.
        //
        // ⚠️ A LOTTI DI `LOTTO_SCRITTURA`, e un lotto che fallisce trattiene SOLO le
        // sue righe: è la regola 1 di questo file («per riga, non per lotto»)
        // applicata anche alla scrittura. Con un solo `update` da 500 id, un
        // fallimento avrebbe trattenuto l'intero giro — e si sarebbe ripresentato
        // identico ogni notte sugli stessi 500.
        const idsConFile = chiudibiliConFile.map((r) => r.id)
        const timbrati: string[] = []
        for (let i = 0; i < idsConFile.length; i += LOTTO_SCRITTURA) {
            const lotto = idsConFile.slice(i, i + LOTTO_SCRITTURA)
            const { error: erroreTimbro } = await soloNelCestino(
                supabase.from('galleria_media_v2').update({ file_rimosso_il: adesso.toISOString() }),
            ).in('id', lotto)
            if (erroreTimbro) {
                // Il file è uscito e la riga non porta il timbro: la riga NON si
                // cancella, perché il giro dopo la rileggerebbe fra le
                // ripristinabili e offrirebbe un «Ripristina» su un file che non
                // c'è. Si trattiene, e il giro dopo `rimuoviEVerifica` la trova
                // «già assente» — che non è un guasto — e ritimbra.
                nTrattenute += lotto.length
                logEvento(
                    'cron',
                    'error',
                    {
                        operazione: JOB,
                        esito: 'timbro-non-scritto',
                        canale,
                        error_code: codiceDi(erroreTimbro),
                        n_righe: lotto.length,
                        n_file: esito.rimossi.length,
                        msg:
                            `${JOB}: file rimossi ma \`file_rimosso_il\` NON scritto: le righe restano nel ` +
                            `cestino e il giro successivo le ritrova già senza file`,
                    },
                    erroreTimbro,
                )
                continue
            }
            timbrati.push(...lotto)
        }

        // ── POI LE RIGHE ────────────────────────────────────────────────────
        //
        // Un solo `delete` per i due lotti: quelle appena timbrate e quelle che il
        // timbro ce l'avevano già dal giro precedente.
        const daCancellare = [...new Set([...timbrati, ...senzaFile.map((r) => r.id)])]
        if (daCancellare.length > 0) {
            // `count: 'exact'` — e non è pignoleria. Senza, il numero che finisce
            // nel battito è quello delle righe che si INTENDEVA cancellare: questo
            // file predica «si verifica lo STATO, non il conteggio» per i file, e
            // sulle righe darebbe per buona la propria intenzione. A lotti i
            // `count` si SOMMANO, per la stessa ragione: un conteggio parziale
            // spacciato per totale è di nuovo un'intenzione.
            const cancellati: string[] = []
            let contate = 0
            let tuttiContati = true
            let erroreDelete: unknown = null
            let nonRaggiunte = 0
            for (let i = 0; i < daCancellare.length; i += LOTTO_SCRITTURA) {
                const lotto = daCancellare.slice(i, i + LOTTO_SCRITTURA)
                const { error, count } = await ancheNelCestino(
                    supabase.from('galleria_media_v2').delete({ count: 'exact' }),
                    'la DELETE deve raggiungere anche le righe il cui file è già uscito (`file_rimosso_il` ' +
                        'valorizzato), che `soloNelCestino` esclude per costruzione: filtrando le sole ripristinabili ' +
                        'una riga rimasta indietro da una DELETE fallita non verrebbe più cancellata da nessun giro. ' +
                        'La cintura contro la riga VIVA resta, e sta qui accanto: `.not(eliminato_il, is, null)`, ' +
                        'cioè una foto che nessuno ha messo nel cestino non è cancellabile da questo lavoro.',
                )
                    .not('eliminato_il', 'is', null)
                    .in('id', lotto)

                if (error) {
                    // Si FERMA al primo lotto che fallisce, e non prosegue: le righe
                    // rimaste sono già timbrate, quindi il giro dopo le riprende dal
                    // lotto B senza richiedere niente allo Storage. Insistere sui
                    // lotti successivi con l'errore in mano vorrebbe dire scrivere un
                    // conteggio composto da un guasto e da un successo.
                    erroreDelete = error
                    nonRaggiunte = daCancellare.length - cancellati.length
                    break
                }
                cancellati.push(...lotto)
                if (typeof count === 'number') contate += count
                else tuttiContati = false
            }

            conteggioVerificato = tuttiContati && cancellati.length > 0
            nCancellate = conteggioVerificato ? contate : cancellati.length

            if (erroreDelete) {
                esitoBattito = 'cancellazione-fallita'
                nTrattenute += nonRaggiunte
                logEvento(
                    'cron',
                    'error',
                    {
                        operazione: JOB,
                        esito: esitoBattito,
                        canale,
                        error_code: codiceDi(erroreDelete),
                        // Il numero VERO delle righe uscite, non zero: con i lotti una
                        // parte può essere già stata cancellata, e dichiarare zero
                        // manderebbe chi indaga a cercare righe che non ci sono più.
                        n_righe: nCancellate,
                        n_righe_trattenute: nTrattenute,
                        n_file: esito.rimossi.length,
                        ms: Date.now() - t0,
                        msg: `${JOB}: media rimossi ma righe NON cancellate`,
                    },
                    erroreDelete,
                )
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'righe-non-cancellate',
                        righe: nCancellate,
                        righe_trattenute: nTrattenute,
                        file: esito.rimossi.length,
                    },
                    { status: 500 },
                )
            }

            if (conteggioVerificato && nCancellate !== daCancellare.length) {
                // `.in('id', …)` non può cancellare PIÙ righe di quante ne nomina: lo
                // scarto è sempre in difetto, e significa che quelle righe erano già
                // sparite fra la SELECT e la DELETE. Resta `warn` e non `error`: il
                // fine di questo job — quelle righe non ci sono più — è raggiunto
                // comunque, e chiamare «errore» una purga riuscita è la strada per
                // far spegnere l'allarme. Ciò che il `warn` garantisce è che il
                // numero dichiarato sia quello VERO.
                logEvento('cron', 'warn', {
                    operazione: JOB,
                    esito: 'conteggio-discorde',
                    canale,
                    n_righe: nCancellate,
                    n_righe_attese: daCancellare.length,
                    msg: `${JOB}: cancellate meno righe di quante ne erano state nominate; si dichiara il numero vero`,
                })
            }

            // ── LE SEGNALAZIONI ORFANE ──────────────────────────────────────
            //
            // Si ripuliscono QUI e non al momento dell'archiviazione, ed è una
            // decisione: una segnalazione è la traccia di una moderazione, e
            // cancellarla insieme alla foto cancellerebbe la RAGIONE per cui la
            // foto è stata rimossa — cioè proprio il documento che serve se
            // qualcuno chiede conto di quella rimozione. Finché la riga della foto
            // esiste (cestino compreso) la segnalazione ha ancora un oggetto; da
            // qui in poi punterebbe al nulla.
            //
            // ⚠️ UN FALLIMENTO QUI NON FA FALLIRE IL GIRO, e l'esito resta `ok`.
            // La promessa che questo lavoro deve mantenere è «la foto viene
            // distrutta», e a quel punto è mantenuta: la riga non c'è più e il file
            // nemmeno. Una segnalazione rimasta appesa è un riferimento morto, non
            // un dato di minore conservato oltre il termine — e mandare in `error`
            // l'esito del battito per questo significherebbe far dire a
            // `/api/health` «job senza battito» su un lavoro che ha fatto il suo
            // lavoro: un allarme che suona da solo viene spento. Il fatto si legge
            // in `app_log` con `segnalazioni_esito`.
            //
            // Gli id sono quelli DAVVERO cancellati (`cancellati`), non quelli che si
            // intendeva cancellare: una segnalazione il cui oggetto è ancora in
            // tabella ha ancora un oggetto, e cancellarla toglierebbe la ragione di
            // una moderazione ancora in corso.
            let segnalazioniContate = 0
            let erroreSegnalazioni: unknown = null
            for (let i = 0; i < cancellati.length; i += LOTTO_SCRITTURA) {
                const lotto = cancellati.slice(i, i + LOTTO_SCRITTURA)
                const { error, count } = await supabase
                    .from('segnalazioni')
                    .delete({ count: 'exact' })
                    .eq('tipo_oggetto', 'media_galleria')
                    .in('oggetto_id', lotto)
                if (error) {
                    erroreSegnalazioni = error
                    break
                }
                segnalazioniContate += count ?? 0
            }
            if (erroreSegnalazioni) {
                segnalazioniEsito = 'non-riuscita'
                logEvento(
                    'cron',
                    'error',
                    {
                        operazione: JOB,
                        esito: 'segnalazioni-orfane-non-rimosse',
                        canale,
                        error_code: codiceDi(erroreSegnalazioni),
                        n_righe: cancellati.length,
                        msg: `${JOB}: segnalazioni delle foto appena distrutte NON cancellate: restano appese a un oggetto che non esiste più`,
                    },
                    erroreSegnalazioni,
                )
            } else {
                segnalazioniEsito = 'ok'
                nSegnalazioni = segnalazioniContate
            }
        }

        if (nTrattenute > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto. Un
            // `200` direbbe «fatto» a chi sorveglia, e resterebbero foto di minori
            // nell'archivio oltre il termine promesso senza che nessuno lo sappia.
            esitoBattito = 'righe-trattenute'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_righe: nCancellate,
                n_righe_trattenute: nTrattenute,
                n_file_bloccanti: nBloccanti,
                n_file_ancora_presenti: esito.ancoraPresenti.length,
                n_file_non_verificati: esito.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${nTrattenute} righe del cestino NON cancellate, ${nBloccanti} file ancora nell'archivio o non verificabili`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                    // risposta: chi legge deve poter distinguere un archivio che non
                    // risponde da un file che non esce.
                    motivo: esito.ancoraPresenti.length > 0 ? 'file-non-rimossi' : 'verifica-non-riuscita',
                    righe: nCancellate,
                    righe_trattenute: nTrattenute,
                    file: esito.rimossi.length,
                    file_bloccanti: nBloccanti,
                },
                { status: 500 },
            )
        }

        // ── GLI ORFANI, dopo il lavoro sulle righe ──────────────────────────
        //
        // In coda al percorso felice, e non prima: la purga del cestino è la
        // promessa scritta sullo schermo dell'insegnante, la spazzata è
        // manutenzione. Se il lotto principale ha trattenuto qualcosa si esce
        // prima e la spazzata salta un giro — che va benissimo: gira ogni notte, e
        // ciò che oggi è orfano lo sarà anche domani.
        //
        // Non lancia mai (ogni suo ramo cattura e riferisce), quindi non serve un
        // `try` attorno.
        spazzata = await spazzaMediaOrfani(supabase, adesso)

        return NextResponse.json({
            ok: true,
            giorni: GIORNI_CESTINO_GALLERIA,
            righe: nCancellate,
            righe_scadute: nScadute,
            file: esito.rimossi.length,
            file_gia_assenti: esito.giaAssenti.length,
            // Un file che un'altra riga nomina ancora NON è stato distrutto, e la
            // risposta non deve far credere il contrario: `righe` e `file` possono
            // legittimamente non combaciare, e questo numero è la ragione.
            file_ancora_reclamati: nAncoraReclamati,
            segnalazioni_orfane: nSegnalazioni,
            segnalazioni_esito: segnalazioniEsito,
            // Il lotto tagliato si dichiara anche qui: chi lancia il giro a mano
            // deve sapere se richiamarlo, e non deve dedurlo da un conteggio.
            lotto_pieno: lottoPieno,
            orfani_cartelle: spazzata.cartelle,
            orfani_esaminati: spazzata.esaminati,
            orfani_rimossi: spazzata.rimossi,
            orfani_esito: spazzata.esito,
            orfani_elenco_troncato: spazzata.troncato,
        })
    } catch (error) {
        esitoBattito = 'eccezione'
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            ms: Date.now() - t0,
            msg: `${JOB}: eccezione non prevista`,
        })
        throw error
    } finally {
        // ── IL BATTITO ──
        // SEMPRE, anche a zero, anche quando tutto è fallito.
        //
        // ⚠️ `evento: 'cron'`, NON `'gdpr'`, e la differenza non è di gusto:
        // `controlloBattitoCron` (`/api/health`) legge `app_log` con
        // `.eq('evento','cron')` e conta solo i battiti con `esito: 'ok'`. Un
        // battito scritto guardando alla NATURA DEL DATO trattato (`gdpr`) invece
        // che alla natura del SEGNALE non lo trova nessuno — è il difetto misurato
        // in produzione il 2026-08-02 su `presenze-giustificazioni-retention`, che
        // scriveva `evento='gdpr'` e risultava muto a chi lo cercava. L'`esito`
        // risponde a «è andata bene?», non a «di che cosa si occupa».
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            giorni: GIORNI_CESTINO_GALLERIA,
            n_cestino_scaduti: nScadute,
            n_righe: nCancellate,
            n_file_rimossi: esito.rimossi.length,
            n_file_gia_assenti: esito.giaAssenti.length,
            n_file_bloccanti: nBloccanti,
            // Distinto dai bloccanti, e non è pignoleria: un bloccante è un file che
            // NON È USCITO e trattiene la sua riga; questo è un file che non si è
            // nemmeno CHIESTO di togliere, perché un'altra riga lo nomina ancora, e
            // la sua riga si cancella comunque. Sommarli nasconderebbe il solo
            // segnale da cui si viene a sapere che due righe condividono un percorso.
            n_file_ancora_reclamati: nAncoraReclamati,
            n_righe_trattenute: nTrattenute,
            n_orfani_esaminati: spazzata.esaminati,
            n_orfani: spazzata.orfani,
            n_orfani_rimossi: spazzata.rimossi,
            orfani_esito: spazzata.esito,
            orfani_elenco_troncato: spazzata.troncato,
            n_segnalazioni_orfane: nSegnalazioni,
            segnalazioni_esito: segnalazioniEsito,
            lotto_pieno: lottoPieno,
            // `false` non vuol dire «il conteggio è sbagliato»: vuol dire che
            // PostgREST non l'ha restituito e il numero qui accanto è l'intenzione,
            // non la misura. Distinguere le due cose è tutto il punto di questo file.
            conteggio_verificato: conteggioVerificato,
            ms: Date.now() - t0,
            msg: `${JOB}: ${nCancellate} righe del cestino e ${esito.rimossi.length} file distrutti oltre i ${GIORNI_CESTINO_GALLERIA} giorni`,
        })
    }
})
