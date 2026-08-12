import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { PERSONALE_LIMITI } from '@/lib/forms/personale-template'

/**
 * LA CONSERVAZIONE DELL'ANAGRAFICA DEL PERSONALE — scansione del documento
 * d'identità compresa.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ È UNA ROUTE E NON UNA FUNZIONE SQL ─────────────
 *
 * Il modulo pubblico `/anagrafica-personale` raccoglie di una dipendente il
 * codice fiscale, la residenza e **la fotografia del suo documento d'identità**.
 * La base giuridica non è il consenso — fra datore e dipendente non sarebbe
 * libero (art. 7 §4 e cons. 43) — ma l'esecuzione del contratto di lavoro
 * (art. 6.1.b) e gli obblighi legali del datore (art. 6.1.c: UNILAV, libro unico,
 * denunce INPS/INAIL, sostituto d'imposta). Nessuna di quelle due basi copre la
 * conservazione all'infinito, e nessuna norma impone al datore di custodire una
 * FOTOCOPIA: impone di identificare. Da qui i tre termini di questo file.
 *
 * Ed è una route HTTP e non una funzione SQL per la stessa ragione del gemello
 * `retention-candidature`: **i file si tolgono solo dalla Storage API**, e da
 * Postgres non ci si arriva. La versione SQL del bisnonno — la conservazione
 * delle domande d'iscrizione — nacque con un `DELETE FROM storage.objects`
 * dentro, e Postgres lo vieta (`42501`, trigger `protect_objects_delete`, FOR
 * EACH STATEMENT: scatta anche a zero righe). Sarebbe fallita dalla prima notte
 * e per sempre.
 *
 * ─── LE QUATTRO COSE CHE I GEMELLI HANNO GIÀ PAGATO ─────────────────────────
 *
 * 1. **PRIMA I FILE, POI LE RIGHE.** Al contrario, un errore a metà lascerebbe
 *    le scansioni dei documenti nell'archivio senza più nessuna riga che le
 *    nomini: invisibili, non cancellate — il modo peggiore di conservare il dato
 *    di una persona. E la rinuncia è PER PRATICA: una scansione che non esce
 *    trattiene **la sua** riga, non l'intero lotto.
 *
 *    ⚠️ VALE ANCHE PER L'UPDATE, e qui è più facile sbagliarsi che nel gemello:
 *    azzerare `documento_path` NON è una cancellazione più mite di una `DELETE`,
 *    è la stessa perdita di riferimento. Se si azzerasse la colonna prima di
 *    togliere il file, resterebbe un oggetto nel bucket che nessuna riga nomina
 *    più — e la volta dopo questo lavoro non saprebbe nemmeno che esiste.
 *
 * 2. **IL CONTEGGIO SI SCRIVE SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
 *    FALLIRE.** Nella versione SQL del bisnonno l'`INSERT` in `app_log` stava
 *    DOPO la `DELETE`: l'eccezione lo saltava, e la difesa che doveva accorgersi
 *    del guasto era a valle del guasto. Qui il battito sta in un `finally`. Con
 *    i soli errori, «nessun log» non distingue «tutto a posto» da «non è mai
 *    partito niente».
 *
 * 3. **RIGHE TRATTENUTE ⇒ 500.** Un 200 direbbe «fatto» a chi sorveglia il
 *    lavoro notturno, e la conservazione di quelle scansioni resterebbe scoperta
 *    senza che nessuno lo sappia.
 *
 * 4. **IL TERMINE APPLICATO È IL TERMINE PROMESSO.** I 90 giorni, i 12 mesi e i
 *    10 anni non sono numeri di questo file: sono `PERSONALE_LIMITI`, cioè quelli
 *    che il testo del consenso INTERPOLA nella frase che l'interessata legge e
 *    spunta — frase che finisce congelata in `pratiche_personale.consents_log`.
 *    Ribatterli qui significherebbe che il giorno in cui il titolare cambia
 *    termine il modulo promette una cosa e il cron ne applica un'altra, in
 *    silenzio, e su una promessa scritta (art. 13 §2 lett. a GDPR).
 *
 * ─── LE REGOLE, DECISE PER RIGA ─────────────────────────────────────────────
 *
 *   pratica MAI VALUTATA (`pending`, `in_approvazione`)
 *        → 90 giorni dalla RICEZIONE (`creata_il`): via il file, via la riga.
 *   pratica RESPINTA (`rifiutata`)
 *        → 90 giorni dalla DECISIONE (`evasa_il`): via il file, via la riga. E se
 *          la decisione non si legge — colonna assente, valore nullo, data rotta —
 *          **non si cancella**: ripiegare sulla ricezione anticiperebbe il termine
 *          promesso di tutto il tempo che la Segreteria ci ha messo a decidere.
 *   anagrafica con `cessato_il` valorizzata
 *        → a 12 mesi via la SOLA scansione (file, poi `documento_path = null`);
 *        → a 10 anni via la riga intera, e CON LEI la pratica **approvata** che
 *          l'ha generata (`origine_pratica_id`).
 *   `cessato_il` NULL = rapporto in corso
 *        → non si cancella niente. Mai.
 *
 * ─── LA PRATICA APPROVATA, E PERCHÉ NON POTEVA RESTARE PER SEMPRE ───────────
 *
 * Fino all'11/08/2026 questo riquadro dichiarava che la pratica approvata «questo
 * lavoro non la tocca», e chiudeva così: «se un giorno si vorrà farla scadere, il
 * termine va prima DICHIARATO in /privacy e poi applicato qui, in quest'ordine».
 * Era già dichiarato dieci righe più in là: `/privacy`, nella voce sulle richieste
 * di anagrafica, dice che «se la richiesta viene approvata i dati confluiscono nel
 * fascicolo del personale e seguono i termini indicati ai due punti precedenti» —
 * cioè dieci anni dalla cessazione. Il perimetro contraddiceva sé stesso, e
 * l'effetto MISURATO era che in tutto `src/` nessuna `.delete()` toccasse mai una
 * riga `approvata`: nome, codice fiscale, data e luogo di nascita, residenza,
 * domicilio, recapiti, estremi del documento e `consents_log` restavano in tabella
 * senza termine (rilievo del revisore, 2026-08-11).
 *
 * Ed è peggio del caso del gemello per un dettaglio di schema: `origine_pratica_id`
 * sta sul lato ANAGRAFICA (`on delete set null` verso `pratiche_personale`), quindi
 * cancellare l'anagrafica non si porta via la pratica — e distrugge l'unica riga che
 * sapeva quale fosse. Da lì due conseguenze operative, che non sono di stile:
 *
 *   · **LA PRATICA SI CANCELLA PRIMA DELLA SUA ANAGRAFICA.** Nell'ordine opposto,
 *     una seconda `delete` che fallisce lascia in tabella una copia completa
 *     dell'anagrafica di una persona e nessuna riga che la nomini: il giro dopo non
 *     saprebbe nemmeno cercarla. È lo stesso guasto del file rimasto nel bucket —
 *     invisibile, non cancellato — applicato a una riga invece che a un oggetto.
 *   · **SE `origine_pratica_id` NON SI PUÒ LEGGERE, non si chiude nessun
 *     fascicolo.** «Non so quale pratica appartenga a questa anagrafica» vale «non
 *     toccare», per la stessa ragione per cui vale su `documento_path`.
 *
 * ⚠️ RESTA FUORI, e si dichiara invece di scoprirlo fra sei mesi: la pratica
 * approvata che NESSUNA anagrafica cita. Oggi non può esistere — MISURATO
 * l'11/08/2026: in tutto `src/` non c'è una riga che scriva
 * `pratiche_personale.stato = 'approvata'` né una che scriva `anagrafica_personale`,
 * perché la route di approvazione della Segreteria non è ancora stata scritta.
 * Potrà nascere in due modi: se chi la scriverà dimenticherà `origine_pratica_id`,
 * o se l'utente verrà cancellato (`on delete cascade` da `utenti` porta via
 * l'anagrafica e con lei il legame). Il primo modo è chiuso da una prova
 * (`gdpr-retention-personale`: chi approva scrive il legame, o il lock è rosso); il
 * secondo è un debito misurato e scritto qui. Cancellare «tutte le approvate che
 * nessuno cita» sarebbe la strada facile e sbagliata: su un database in cui il
 * legame non fosse stato scritto porterebbe via il modulo d'origine di persone
 * ANCORA IN SERVIZIO, e su un'operazione irreversibile «non so» vale «non toccare».
 *
 * ─── COSA NON ENTRA NEI LOG, E PERCHÉ QUI CONTA PIÙ CHE ALTROVE ─────────────
 *
 * Il **percorso della scansione** e il nome del suo file. Il bucket è
 * `documenti_personale` e l'oggetto è la fotografia di una carta d'identità:
 * `app_log` è interrogabile in SQL per 30 giorni, e una riga che riportasse quel
 * percorso pubblicherebbe l'indirizzo di un documento d'identità dentro una
 * tabella di diagnosi. Niente percorsi, niente nomi di file, niente email,
 * niente codici fiscali, niente uuid di utente. Conteggi, esiti, codici d'errore.
 */

/**
 * Il nome con cui questo lavoro si presenta in `app_log` e in `JOB_CRON`.
 *
 * ⚠️ `retention-personale` e NON `personale-retention`, che sarebbe la forma dei
 * fratelli (`candidature-retention`, `iscrizioni-retention`,
 * `notifiche-retention`). La convenzione qui perde contro due fatti, entrambi
 * scritti prima di questo file: `personale-template.ts` dice «chi scriverà
 * `retention-personale` legga i termini da qui», e `JOB_CRON`
 * (`src/lib/health/controlli.ts`) porta la voce con quella grafia. Ed è la
 * grafia che conta, perché questa stringa è la CHIAVE con cui
 * `controlloBattitoCron` associa il battito al job: due nomi che si somigliano
 * sono peggio di un nome brutto — il job non verrebbe mai riconosciuto,
 * `/api/health` direbbe «job senza battito: retention-personale» dal primo
 * deploy e per sempre, e un allarme che suona da solo viene spento. Coincide per
 * giunta con il percorso della route.
 */
const JOB = 'retention-personale'

/**
 * NOVANTA GIORNI — la pratica non approvata, scansione compresa.
 *
 * Non è un numero scritto qui: è `PERSONALE_LIMITI.giorniPraticaNonApprovata`,
 * cioè il termine che il terzo blocco di consenso interpola nella frase «…ed
 * entro N giorni se questa richiesta non viene approvata». Chi compila quel
 * modulo legge quel numero: è la dichiarazione, non una nota interna.
 */
const GIORNI_PRATICA = PERSONALE_LIMITI.giorniPraticaNonApprovata

/**
 * DODICI MESI — la sola scansione, dopo la cessazione del rapporto.
 *
 * È il termine più corto dell'intero modulo, e ha una ragione: la copia del
 * documento è il pezzo con la base giuridica più fragile che questa Scuola
 * conservi. Nessuna norma impone al datore di custodire una fotocopia — impone
 * di IDENTIFICARE — e l'identificazione, cessato il rapporto, è finita.
 */
const MESI_DOCUMENTO = PERSONALE_LIMITI.mesiDocumentoDopoCessazione

/**
 * DIECI ANNI — il fascicolo anagrafico, dopo la cessazione.
 *
 * È il termine degli obblighi documentali del datore di lavoro (libro unico,
 * documentazione contributiva e fiscale: art. 2220 c.c. e normativa tributaria,
 * gli stessi dieci anni che l'informativa dichiara per i documenti contabili).
 */
const ANNI_FASCICOLO = PERSONALE_LIMITI.anniFascicoloDopoCessazione

/**
 * Il bucket delle scansioni. È `documenti_personale` e non `form_attachments`:
 * quello custodisce i documenti allegati alle domande d'iscrizione, cioè carte
 * d'identità di genitori e fotografie di MINORI. Due popolazioni, due basi
 * giuridiche, due termini — e tenerli insieme significherebbe che il risolutore
 * di percorso di un modulo può, sbagliando, cancellare l'oggetto dell'altro.
 */
const BUCKET_DOCUMENTI = 'documenti_personale'

/**
 * Gli stati in cui la pratica NON è stata accolta: **lì, e solo lì**, si cancella.
 *
 * È un elenco POSITIVO e non la negazione di `approvata`, e la differenza non è
 * di stile. Con `stato !== 'approvata'` uno stato NUOVO — introdotto domani da
 * chi aggiunge un passaggio al flusso di segreteria — cadrebbe da solo dentro
 * l'insieme di ciò che si cancella a novanta giorni, senza che nessuno l'abbia
 * deciso. Un elenco positivo sbaglia nel verso opposto: uno stato ignoto non si
 * tocca, e la riga resta finché qualcuno non aggiorna questa costante.
 */
const STATI_NON_APPROVATE = new Set(['pending', 'in_approvazione', 'rifiutata'])

/**
 * Gli stati in cui la richiesta è stata RESPINTA: **lì, e solo lì**, il termine
 * decorre dalla decisione invece che dalla ricezione.
 *
 * È la frase dell'informativa letta alla lettera («novanta giorni dalla
 * ricezione, o dalla decisione se la richiesta è stata respinta»), e la
 * distinzione non è teorica nemmeno qui, dove tutti gli stati trattati sono
 * «non approvati»: una riga `pending` con un `evasa_il` valorizzato — una
 * incoerenza che nessun percorso applicativo produce oggi, ma che una scrittura
 * a mano in SQL produce in un secondo — verrebbe conservata NOVANTA GIORNI OLTRE
 * il termine dichiarato. È il verso in cui il gemello ha sbagliato il 2026-08-10,
 * e la sua lezione va riusata: conservare oltre il termine promesso non è
 * prudenza, è il trattamento che l'art. 13 §2 lett. a non copre più.
 *
 * ⚠️ E LA DECORRENZA NON RIPIEGA SULL'ALTRA. Fino all'11/08/2026 una pratica
 * respinta senza `evasa_il` leggibile tornava a `creata_il`, e il `warn` del
 * ripiego dichiarava che «la ricezione è la data più vecchia: non si anticipa
 * nessuna cancellazione». È rovesciato, ed è aritmetica: `creata_il <= evasa_il`,
 * quindi il termine calcolato dalla data più VECCHIA scade PRIMA — di tutto il
 * tempo che la Segreteria ci ha messo a decidere. Su un database che avesse
 * `stato` e non `evasa_il` (il DB della CI, o una colonna caduta) se ne andavano
 * la pratica E la scansione della carta d'identità allegata, prima del termine che
 * l'informativa promette. Adesso una decorrenza illeggibile vale «non toccare» —
 * la stessa regola della data rotta, e il verso che `COLONNE_PRATICA_FACOLTATIVE`
 * dichiara per ogni assenza (rilievo del revisore, 2026-08-11).
 *
 * Il verso opposto — conservare più a lungo del promesso — resta un difetto, e per
 * questo non è silenzioso: le righe che restano indietro si contano e finiscono nel
 * battito (`n_pratiche_senza_riferimento`), con un `warn` che le dichiara. Una
 * `rifiutata` senza `evasa_il` è un'incoerenza da riparare alla fonte, non da
 * risolvere cancellando al buio.
 */
const STATI_RESPINTE = new Set(['rifiutata'])

/**
 * IL DB DELLA CI NON È MIGRATO, e il codice deve degradare in modo DICHIARATO.
 * Tabella assente ⇒ 503 con il codice, mai un 200 bugiardo: «non ho cancellato
 * niente perché la tabella non c'è» e «non c'era niente da cancellare» sono due
 * fatti diversi, e confonderli è esattamente il guasto invisibile.
 */
const CODICI_TABELLA_ASSENTE = new Set(['PGRST205', 'PGRST202', '42P01'])

/** Colonna assente ⇒ si ritenta senza, con un `warn` che la NOMINA. */
const CODICI_COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/**
 * Le colonne che possono mancare su un database non migrato, tabella per
 * tabella. Nessuna di queste assenze autorizza a cancellare di più: quando
 * un'informazione non c'è si sceglie sempre il verso che CONSERVA.
 */
const COLONNE_PRATICA_FACOLTATIVE = ['evasa_il', 'documento_path'] as const
const COLONNE_PRATICA_SEMPRE = ['id', 'stato', 'creata_il'] as const

const COLONNE_ANAGRAFICA_FACOLTATIVE = [
    'cessato_il',
    'documento_path',
    // Il legame col modulo d'origine. È FACOLTATIVA come le altre due — un
    // database non migrato non ce l'ha — ma la sua assenza costa più delle altre:
    // senza, un fascicolo che scade porterebbe via l'anagrafica e lascerebbe in
    // `pratiche_personale` la copia che l'ha generata, irraggiungibile per sempre.
    'origine_pratica_id',
] as const
const COLONNE_ANAGRAFICA_SEMPRE = ['utente_id'] as const

/**
 * IL TETTO DEL LOTTO, e perché un giro senza tetto è un giro che a un certo
 * punto smette di funzionare senza dirlo.
 *
 * PostgREST ha un suo massimo di righe (`db-max-rows`) e la funzione ha un tempo
 * massimo: una lettura senza `.limit()` non è «tutte le righe», è «tutte finché
 * qualcun altro non decide di tagliare» — e il taglio di qualcun altro arriva
 * muto. Con un tetto ESPLICITO il taglio è nostro, si sa quand'è avvenuto
 * (`lotto_pieno` nel battito) e il giro dopo riprende dalle più vecchie, perché
 * entrambe le letture sono ordinate crescenti sulla loro data: la riga più in
 * ritardo è la prima a uscire, non l'ultima.
 */
const TETTO_LOTTO = 500

type Pratica = {
    id: string
    stato?: string | null
    creata_il?: string | null
    evasa_il?: string | null
    documento_path?: string | null
}

type Anagrafica = {
    utente_id: string
    cessato_il?: string | null
    documento_path?: string | null
    origine_pratica_id?: string | null
}

/**
 * Una riga da chiudere, tenuta legata al SUO file fino alla fine.
 *
 * `legata` è l'id di un'ALTRA riga che deve sparire per prima: la usa la sola
 * anagrafica, e vi mette la pratica che l'ha generata. Serve perché il legame
 * `origine_pratica_id` muore con l'anagrafica: cancellare quest'ultima mentre la
 * sua pratica resta indietro — trattenuta dal proprio file — lascerebbe in
 * `pratiche_personale` una copia integrale che nessuna riga nomina più.
 */
type RigaConFile = { chiave: string; percorso: string | null; legata?: string | null }

const NIENTE_DA_TOGLIERE: EsitoRimozione = {
    rimossi: [],
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
}

/** Il codice PostgREST/Postgres dell'errore, se c'è. */
function codiceDi(errore: unknown): string {
    const c = (errore as { code?: unknown } | null)?.code
    return typeof c === 'string' ? c : ''
}

/**
 * Quali fra le colonne facoltative l'errore NOMINA. Non si legge il messaggio
 * grezzo per scriverlo nei log — si cerca dentro di esso un nome che conosciamo
 * già, così ciò che esce di qui è un valore chiuso e non testo di un terzo.
 * Se non se ne riconosce nessuna, si rinuncia a tutte: è il ripiego più
 * conservativo, e resta dichiarato nel `warn`.
 */
function colonneMancanti<C extends string>(errore: unknown, facoltative: readonly C[]): C[] {
    const testo = [
        (errore as { message?: unknown } | null)?.message,
        (errore as { details?: unknown } | null)?.details,
        (errore as { hint?: unknown } | null)?.hint,
    ]
        .map((v) => (typeof v === 'string' ? v : ''))
        .join(' ')
    const nominate = facoltative.filter((c) => testo.includes(c))
    return nominate.length > 0 ? [...nominate] : [...facoltative]
}

/** `data + n giorni`. */
function piuGiorni(data: Date, giorni: number): Date {
    const d = new Date(data.getTime())
    d.setDate(d.getDate() + giorni)
    return d
}

/** `data + n mesi`, con lo stesso arrotondamento di `Date.setMonth`. */
function piuMesi(data: Date, mesi: number): Date {
    const d = new Date(data.getTime())
    d.setMonth(d.getMonth() + mesi)
    return d
}

/** `data + n anni`. */
function piuAnni(data: Date, anni: number): Date {
    const d = new Date(data.getTime())
    d.setFullYear(d.getFullYear() + anni)
    return d
}

/** La data leggibile, o `null` se non lo è. */
function quando(v: unknown): Date | null {
    if (typeof v !== 'string' || v.trim() === '') return null
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t)
}

/**
 * Il valore testuale non vuoto, o `null`. Serve due volte, e la domanda è la
 * stessa: «questa riga nomina davvero qualcosa?». Vale per il percorso di una
 * scansione come per l'uuid della pratica d'origine — e la risposta sbagliata, in
 * entrambi i casi, è la stringa vuota scambiata per un nome, che manderebbe una
 * `remove('')` allo Storage o una `.in('id', [''])` a PostgREST.
 */
function testoDi(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

// POST /api/gdpr/retention-personale
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-personale:POST', async (request: NextRequest) => {
    const t0 = Date.now()
    let canale = 'cron'

    // ── I CONTATORI DEL BATTITO ──
    // Vivono QUI, fuori da ogni ramo che può fallire, e si scrivono nel `finally`.
    // È il punto di tutto questo file: un log che dimostra il funzionamento non
    // può stare dentro la transazione che deve sorvegliare.
    let esitoBattito = 'ok'
    let nPratiche = 0
    let nPraticheFascicolo = 0
    let nAnagrafiche = 0
    let nScansioni = 0
    let nPraticheScadute = 0
    let nPraticheSenzaRiferimento = 0
    let nAnagraficheScadute = 0
    let nScansioniScadute = 0
    let nTrattenute = 0
    let esito: EsitoRimozione = NIENTE_DA_TOGLIERE
    let nBloccanti = 0
    let documentoIgnoto = false
    let cessazioneIgnota = false
    let origineIgnota = false
    let lottoPieno = false
    let conteggioVerificato = false

    try {
        const secret = request.headers.get('x-cron-secret')
        const isCron = segretoCronValido(secret)
        if (!isCron) {
            // Si grida solo se l'header c'è ma non torna: quello è un cron che bussa
            // con la chiave sbagliata, ed è il guasto invisibile — smette di cancellare
            // e non lo dice a nessuno. Se manca del tutto è lo staff che lancia il giro
            // a mano, e il gate qui sotto è il suo.
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

        // ═══ FASE 1 · LE PRATICHE NON APPROVATE ══════════════════════════════
        //
        // Il TAGLIO GROSSOLANO si fa su `creata_il`, ed è corretto: il giorno di
        // riferimento non è mai anteriore alla ricezione (`evasa_il` viene dopo),
        // quindi nessuna pratica ricevuta da meno di 90 giorni può essere scaduta.
        // Il taglio FINE — per riga, con il suo riferimento — si fa in memoria
        // subito sotto, dove è leggibile e collaudabile.
        const sogliaPratiche = piuGiorni(adesso, -GIORNI_PRATICA)

        const leggiPratiche = (colonne: string) =>
            supabase
                .from('pratiche_personale')
                .select(colonne)
                // Elenco POSITIVO degli stati: vedi `STATI_NON_APPROVATE`. La stessa
                // condizione è ripetuta in memoria, e non è ridondanza inutile — è
                // ciò che rende la regola vera anche se qualcuno un giorno tocca la
                // query e non il filtro (o viceversa).
                .in('stato', [...STATI_NON_APPROVATE])
                .lt('creata_il', sogliaPratiche.toISOString())
                // Le più vecchie per prime: se il tetto taglia, taglia le meno in
                // ritardo. Con l'ordine opposto un lotto pieno lascerebbe indietro
                // per sempre proprio le pratiche scadute da più tempo.
                .order('creata_il', { ascending: true })
                .limit(TETTO_LOTTO)

        let colonnePratica = [...COLONNE_PRATICA_SEMPRE, ...COLONNE_PRATICA_FACOLTATIVE].join(', ')
        // PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo un
        // guasto di lettura diventerebbe «nessuna pratica scaduta», cioè un giro a
        // vuoto che si dichiara riuscito.
        let { data: datiPratiche, error: erroreP } = await leggiPratiche(colonnePratica)

        if (erroreP && CODICI_COLONNA_ASSENTE.has(codiceDi(erroreP))) {
            const mancanti = colonneMancanti(erroreP, COLONNE_PRATICA_FACOLTATIVE)
            if (mancanti.includes('documento_path')) documentoIgnoto = true
            colonnePratica = [
                ...COLONNE_PRATICA_SEMPRE,
                ...COLONNE_PRATICA_FACOLTATIVE.filter((c) => !mancanti.includes(c)),
            ].join(', ')
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'colonna-assente',
                canale,
                entita_tipo: 'pratica',
                error_code: codiceDi(erroreP),
                msg:
                    `${JOB}: colonne assenti su pratiche_personale (${mancanti.join(', ')}), lettura ` +
                    `ritentata senza. Senza \`evasa_il\` le pratiche RESPINTE non si cancellano: il ` +
                    `loro termine decorre dalla decisione, e ripiegare sulla RICEZIONE — che è la ` +
                    `data più vecchia — le farebbe scadere PRIMA del termine promesso. Le altre ` +
                    `seguono la ricezione, che è già la loro decorrenza`,
            })
            ;({ data: datiPratiche, error: erroreP } = await leggiPratiche(colonnePratica))
        }

        if (erroreP) {
            const codice = codiceDi(erroreP)
            const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
            esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                entita_tipo: 'pratica',
                error_code: codice,
                ms: Date.now() - t0,
                msg: tabellaAssente
                    ? `${JOB}: la tabella pratiche_personale non esiste su questo database (${codice}): nessuna cancellazione, e non si finge il contrario`
                    : `${JOB}: lettura delle pratiche scadute non riuscita`,
            })
            // `{ ok, motivo }` e non `{ error }`: questa route la chiama pg_net, non
            // un browser. Una prosa italiana qui non la legge nessun utente — sarebbe
            // solo una stringa in più da tradurre.
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: tabellaAssente ? 503 : 500 },
            )
        }

        // ═══ FASE 2 · LE ANAGRAFICHE DI CHI HA CESSATO ═══════════════════════
        //
        // Il taglio grossolano si fa sul termine PIÙ BREVE dei due (12 mesi): una
        // riga cessata da meno di così non ha niente da perdere, né la scansione né
        // il fascicolo. Col termine più lungo, tutte le cessazioni fra i 12 mesi e i
        // 10 anni non verrebbero MAI lette — quindi mai sbiancate — e il battito
        // continuerebbe a dire «ok, zero».
        //
        // `.lt('cessato_il', …)` esclude già le righe con `cessato_il` NULL (in SQL
        // un confronto con NULL non è mai vero), ma il rapporto in corso è la cosa
        // che questo lavoro non deve toccare per nessun motivo: la stessa condizione
        // è riverificata in memoria, dove un test la può misurare.
        const sogliaAnagrafiche = piuMesi(adesso, -MESI_DOCUMENTO)

        const leggiAnagrafiche = (colonne: string) =>
            supabase
                .from('anagrafica_personale')
                .select(colonne)
                .lt('cessato_il', sogliaAnagrafiche.toISOString())
                .order('cessato_il', { ascending: true })
                .limit(TETTO_LOTTO)

        let colonneAnagrafica = [
            ...COLONNE_ANAGRAFICA_SEMPRE,
            ...COLONNE_ANAGRAFICA_FACOLTATIVE,
        ].join(', ')
        let { data: datiAnagrafiche, error: erroreA } = await leggiAnagrafiche(colonneAnagrafica)

        if (erroreA && CODICI_COLONNA_ASSENTE.has(codiceDi(erroreA))) {
            const mancanti = colonneMancanti(erroreA, COLONNE_ANAGRAFICA_FACOLTATIVE)
            if (mancanti.includes('documento_path')) documentoIgnoto = true
            if (mancanti.includes('cessato_il')) cessazioneIgnota = true
            if (mancanti.includes('origine_pratica_id')) origineIgnota = true
            colonneAnagrafica = [
                ...COLONNE_ANAGRAFICA_SEMPRE,
                ...COLONNE_ANAGRAFICA_FACOLTATIVE.filter((c) => !mancanti.includes(c)),
            ].join(', ')
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'colonna-assente',
                canale,
                entita_tipo: 'anagrafica',
                error_code: codiceDi(erroreA),
                msg: cessazioneIgnota
                    ? `${JOB}: colonne assenti su anagrafica_personale (${mancanti.join(', ')}). ` +
                      `Senza \`cessato_il\` non si sa chi abbia cessato e non esiste nemmeno la ` +
                      `condizione con cui selezionarlo: la lettura NON viene ritentata e nessuna ` +
                      `anagrafica viene toccata. Le pratiche seguono la loro strada`
                    : `${JOB}: colonne assenti su anagrafica_personale (${mancanti.join(', ')}), ` +
                      `lettura ritentata senza`,
            })
            if (cessazioneIgnota) {
                // ⚠️ NON SI RITENTA, e non è una rinuncia comoda: è l'unica forma in
                // cui il ripiego può funzionare.
                //
                // `cessato_il` non è soltanto una colonna della `select`: è anche il
                // `.lt()` e l'`.order()` di questa query. Togliendola dalla sola lista
                // delle colonne lette, PostgREST rialzerebbe **lo stesso `42703`** sul
                // filtro, `erroreA` resterebbe valorizzato e la route uscirebbe 500
                // `lettura-fallita` — mentre il `warn` qui sopra racconta una
                // degradazione pulita e il battito scrive `cessazione_ignota: true`.
                // Un ramo irraggiungibile che si descrive nei log è peggio di un ramo
                // che non c'è: chi cerca in `app_log` un giro degradato-ma-riuscito ne
                // troverebbe uno fallito, e non capirebbe perché. (Rilievo del
                // revisore del 2026-08-11; la prova che lo copriva era verde solo
                // perché la fixture faceva RIUSCIRE la seconda lettura, cosa che un
                // database senza quella colonna non fa mai.)
                //
                // Non si perde niente: senza `cessato_il` nessuna riga è databile,
                // quindi l'insieme delle anagrafiche scadute è vuoto per costruzione —
                // rileggere la tabella senza filtro servirebbe solo a portare in
                // memoria fino a 500 righe da scartare tutte, e a far scattare
                // `lotto_pieno` su un lotto che nessuno lavorerà.
                erroreA = null
                datiAnagrafiche = null
            } else {
                ;({ data: datiAnagrafiche, error: erroreA } =
                    await leggiAnagrafiche(colonneAnagrafica))
            }
        }

        if (erroreA) {
            const codice = codiceDi(erroreA)
            const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
            esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                entita_tipo: 'anagrafica',
                error_code: codice,
                ms: Date.now() - t0,
                msg: tabellaAssente
                    ? `${JOB}: la tabella anagrafica_personale non esiste su questo database (${codice}): nessuna cancellazione, e non si finge il contrario`
                    : `${JOB}: lettura delle anagrafiche cessate non riuscita`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: tabellaAssente ? 503 : 500 },
            )
        }

        // ── IL TAGLIO FINE, per riga ──
        const pratiche = (datiPratiche ?? []) as unknown as Pratica[]
        const anagrafiche = (datiAnagrafiche ?? []) as unknown as Anagrafica[]
        lottoPieno = pratiche.length >= TETTO_LOTTO || anagrafiche.length >= TETTO_LOTTO

        const praticheScadute = pratiche.filter((r) => {
            const stato = typeof r.stato === 'string' ? r.stato : ''
            if (!STATI_NON_APPROVATE.has(stato)) return false
            // Il riferimento è la DECISIONE se la richiesta è stata RESPINTA, la
            // RICEZIONE in ogni altro caso — e NON si ripiega dall'una all'altra:
            // l'unica direzione possibile sarebbe verso la data più VECCHIA, cioè
            // verso una cancellazione ANTICIPATA. Vedi `STATI_RESPINTE`.
            const riferimento = STATI_RESPINTE.has(stato)
                ? quando(r.evasa_il)
                : quando(r.creata_il)
            // Riferimento illeggibile ⇒ non si cancella. Un dato mancante non è un
            // permesso: è un «non verificabile», e su un'operazione irreversibile
            // «non verificabile» vale «non toccare».
            if (!riferimento) {
                // Si conta, invece di sparire dentro un `false`: «zero righe
                // scadute» e «righe che non so datare» sono due fatti diversi, e
                // confonderli è la forma di guasto che questo file esiste per non
                // ripetere. Il numero finisce nel battito.
                nPraticheSenzaRiferimento++
                return false
            }
            return piuGiorni(riferimento, GIORNI_PRATICA).getTime() <= adesso.getTime()
        })
        nPraticheScadute = praticheScadute.length

        if (nPraticheSenzaRiferimento > 0) {
            // Trattenere oltre il termine promesso è a sua volta un difetto (art. 13
            // §2 lett. a), solo reversibile: quindi si sceglie, ma non in silenzio.
            // Nessun conteggio per riga e nessun id: chi indaga parte da qui e va a
            // guardare la tabella, non `app_log`.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'riferimento-illeggibile',
                canale,
                n_pratiche_senza_riferimento: nPraticheSenzaRiferimento,
                msg:
                    `${JOB}: ${nPraticheSenzaRiferimento} pratiche non approvate senza una decorrenza ` +
                    `leggibile (una respinta senza data di decisione, o una data non interpretabile): ` +
                    `NON vengono cancellate, e restano oltre il termine dichiarato finché il dato non ` +
                    `viene riparato alla fonte`,
            })
        }

        // `cessato_il` NULL o illeggibile = rapporto in corso, o comunque non
        // databile: non si tocca niente. È la regola più importante di questo file,
        // perché è l'unica che protegge una persona ANCORA IN SERVIZIO.
        const cessate = anagrafiche
            .map((r) => ({ riga: r, cessato: quando(r.cessato_il) }))
            .filter((x): x is { riga: Anagrafica; cessato: Date } => x.cessato !== null)

        const anagraficheScadute = cessate
            .filter((x) => piuAnni(x.cessato, ANNI_FASCICOLO).getTime() <= adesso.getTime())
            .map((x) => x.riga)
        nAnagraficheScadute = anagraficheScadute.length

        // LE PRATICHE APPROVATE DEI FASCICOLI CHE SCADONO, raccolte ADESSO.
        //
        // Il legame vive sul lato anagrafica e muore con lei (`origine_pratica_id`,
        // `on delete set null` verso `pratiche_personale`): letto dopo la
        // cancellazione, non esisterebbe più. È la ragione per cui la riga della
        // pratica va chiusa nello stesso giro, e prima della sua anagrafica.
        const idPraticheFascicolo = [
            ...new Set(
                anagraficheScadute
                    .map((r) => testoDi(r.origine_pratica_id))
                    .filter((v): v is string => v !== null),
            ),
        ]

        const daCancellare = new Set(anagraficheScadute.map((r) => r.utente_id))
        // Lo sbiancamento riguarda SOLO chi non viene cancellato del tutto: sulla
        // riga che sta per sparire un `UPDATE` sarebbe lavoro doppio, e — peggio —
        // farebbe contare due volte lo stesso file.
        const scansioniScadute = cessate
            .filter(
                (x) =>
                    !daCancellare.has(x.riga.utente_id) &&
                    testoDi(x.riga.documento_path) !== null &&
                    piuMesi(x.cessato, MESI_DOCUMENTO).getTime() <= adesso.getTime(),
            )
            .map((x) => x.riga)
        nScansioniScadute = scansioniScadute.length

        if (lottoPieno) {
            // Un lotto tagliato che rispondesse `ok` senza dirlo sarebbe un giro
            // riuscito a metà travestito da giro riuscito: il resto delle righe
            // scadute è ancora lì e nessuno lo saprebbe. L'esito resta `ok` — il
            // lavoro si riprende la notte dopo dalle più vecchie — ma il fatto è
            // scritto, ed è leggibile con una query su `app_log`.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'lotto-pieno',
                canale,
                n_pratiche_lette: pratiche.length,
                n_anagrafiche_lette: anagrafiche.length,
                msg: `${JOB}: lotto al tetto di ${TETTO_LOTTO} righe, il giro successivo riprende dalle più vecchie`,
            })
        }

        // ── SENZA `documento_path` NON SI CANCELLA NIENTE ──
        //
        // Il difetto che questo blocco chiude, e che il gemello ha pagato per
        // davvero: se `documento_path` finisce fra le colonne assenti, la seconda
        // `select` la esclude, `percorso` è `undefined`, nessuna `remove()` parte —
        // e senza questo `return` le righe si cancellerebbero LO STESSO. Risultato:
        // scansioni di documenti d'identità nel bucket senza più nessuna riga che le
        // nomini, cioè «invisibili, non cancellate», il modo peggiore di conservare
        // un dato personale.
        //
        // Vale ANCHE per il ripiego di `colonneMancanti`, che quando non riconosce
        // nessun nome rinuncia a TUTTE le colonne facoltative: qualunque
        // `42703`/`PGRST204` che non sappiamo leggere finisce qui, e qui non si
        // cancella. È lo stesso verso di `rimuoviEVerifica`: «non so quali file
        // questa riga nomini» vale «li nomina», e su un'operazione irreversibile
        // «non so» vale «non toccare».
        //
        // ⚠️ LA STESSA REGOLA VALE PER `origine_pratica_id`, ed è il verso di errore
        // che il revisore ha trovato l'11/08/2026 sull'altra sponda: se il legame non
        // si può leggere, cancellare l'anagrafica lascerebbe in `pratiche_personale`
        // la copia integrale che l'ha generata — codice fiscale, nascita, residenza,
        // domicilio, recapiti, estremi del documento, `consents_log` — e nessuna riga
        // che sappia più a chi appartiene. Vale solo quando c'è davvero un fascicolo
        // da chiudere: senza anagrafiche scadute non c'è niente da orfanare, e un
        // ripiego che si allargasse oltre il proprio danno fermerebbe la
        // cancellazione delle pratiche a 90 giorni per un motivo che non le riguarda.
        const legameIgnoto = origineIgnota && nAnagraficheScadute > 0
        if (documentoIgnoto || legameIgnoto) {
            esitoBattito = documentoIgnoto ? 'documento-path-ignoto' : 'origine-pratica-ignota'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_pratiche_scadute: nPraticheScadute,
                n_anagrafiche_scadute: nAnagraficheScadute,
                ms: Date.now() - t0,
                msg: documentoIgnoto
                    ? `${JOB}: la colonna documento_path non esiste su questo database, quindi non si sa ` +
                      `quali scansioni ogni riga nomini: NESSUNA riga viene toccata. Cancellarle ` +
                      `lascerebbe i file nell'archivio senza più nulla che li nomini`
                    : `${JOB}: la colonna origine_pratica_id non esiste su questo database, quindi non si sa ` +
                      `quale pratica abbia generato ciascun fascicolo: NESSUNA riga viene toccata. ` +
                      `Chiudere il fascicolo lascerebbe la sua pratica in tabella senza più nulla che la nomini`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    motivo: esitoBattito,
                    pratiche: 0,
                    anagrafiche: 0,
                    scansioni: 0,
                    pratiche_scadute: nPraticheScadute,
                    anagrafiche_scadute: nAnagraficheScadute,
                },
                { status: 503 },
            )
        }

        // ═══ FASE 3 · LA PRATICA APPROVATA CHE HA GENERATO IL FASCICOLO ══════
        //
        // Si rilegge, invece di cancellarla per id e basta, per sapere una cosa
        // sola: **se porta ancora un file**. Per contratto non lo porta —
        // «all'approvazione l'oggetto NON si copia: l'anagrafica punta allo stesso
        // file e questa colonna torna NULL», commento di colonna della migrazione
        // `20260811205643` — ma cancellare una riga fidandosi di un contratto è
        // esattamente il modo in cui una fotografia di carta d'identità resta nel
        // bucket senza più nulla che la nomini. Il contratto lo scriverà una route
        // di approvazione che oggi non esiste ancora: verificarlo costa una lettura
        // per lotto, e solo nei giri in cui un fascicolo scade davvero.
        //
        // Un id che NON torna è una riga già sparita (cancellata a mano, o da un
        // giro precedente andato a metà): non è un errore, è il lavoro già fatto.
        const idPraticheScadute = new Set(praticheScadute.map((r) => r.id))
        let praticheFascicolo: Pratica[] = []
        if (idPraticheFascicolo.length > 0) {
            const { data, error } = await supabase
                .from('pratiche_personale')
                .select('id, documento_path')
                .in('id', idPraticheFascicolo)
            if (error) {
                const codice = codiceDi(error)
                const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
                esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'pratica-fascicolo',
                    error_code: codice,
                    n_anagrafiche_scadute: nAnagraficheScadute,
                    ms: Date.now() - t0,
                    msg: `${JOB}: lettura delle pratiche d'origine dei fascicoli scaduti non riuscita: nessuna riga viene toccata`,
                })
                return NextResponse.json(
                    { ok: false, motivo: esitoBattito, error_code: codice },
                    { status: tabellaAssente ? 503 : 500 },
                )
            }
            praticheFascicolo = ((data ?? []) as unknown as Pratica[]).filter(
                // Una riga già nell'insieme dei 90 giorni non si conta due volte: la
                // seconda `delete` toccherebbe zero righe e farebbe gridare
                // `conteggio-discorde` a un giro perfettamente riuscito.
                (r) => !idPraticheScadute.has(r.id),
            )
        }

        // Ogni riga resta legata al SUO file fino alla fine: è ciò che permette di
        // trattenere una riga sola invece dell'intero lotto.
        const praticheConFile: RigaConFile[] = praticheScadute.map((r) => ({
            chiave: r.id,
            percorso: testoDi(r.documento_path),
        }))
        const fascicoloConFile: RigaConFile[] = praticheFascicolo.map((r) => ({
            chiave: r.id,
            percorso: testoDi(r.documento_path),
        }))
        const anagraficheConFile: RigaConFile[] = anagraficheScadute.map((r) => ({
            chiave: r.utente_id,
            percorso: testoDi(r.documento_path),
            legata: testoDi(r.origine_pratica_id),
        }))
        const scansioniConFile: RigaConFile[] = scansioniScadute.map((r) => ({
            chiave: r.utente_id,
            percorso: testoDi(r.documento_path),
        }))

        const tuttiIPercorsi = [
            ...new Set(
                [...praticheConFile, ...fascicoloConFile, ...anagraficheConFile, ...scansioniConFile]
                    .map((r) => r.percorso)
                    .filter((p): p is string => p !== null),
            ),
        ]

        // ── PRIMA I FILE ──
        if (tuttiIPercorsi.length > 0) {
            esito = await rimuoviEVerifica(supabase, BUCKET_DOCUMENTI, tuttiIPercorsi, JOB)
            if (esito.erroreRimozione) {
                // La chiamata è fallita: nessun file è uscito e non c'è niente da
                // verificare. Toccare le righe adesso renderebbe le scansioni
                // irraggiungibili invece che cancellate. Si riprova il giro dopo.
                esitoBattito = 'file-non-rimossi'
                nTrattenute =
                    praticheConFile.length +
                    fascicoloConFile.length +
                    anagraficheConFile.length +
                    scansioniConFile.length
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    n_file: tuttiIPercorsi.length,
                    n_righe_trattenute: nTrattenute,
                    ms: Date.now() - t0,
                    msg: `${JOB}: rimozione delle scansioni non riuscita, righe NON toccate`,
                })
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'allegati-non-rimossi',
                        pratiche: 0,
                        anagrafiche: 0,
                        scansioni: 0,
                        righe_trattenute: nTrattenute,
                        file: tuttiIPercorsi.length,
                    },
                    { status: 500 },
                )
            }
        }

        // Una scansione ancora nell'archivio — o che non si è potuto verificare —
        // trattiene la SUA riga, e soltanto quella.
        const daNonToccare = new Set(bloccanti(esito))
        nBloccanti = daNonToccare.size
        const chiudibili = (righe: RigaConFile[]) =>
            righe.filter((r) => r.percorso === null || !daNonToccare.has(r.percorso))

        const praticheChiudibili = chiudibili(praticheConFile)
        const fascicoloChiudibili = chiudibili(fascicoloConFile)
        const scansioniChiudibili = chiudibili(scansioniConFile)

        // ── UNA PRATICA TRATTENUTA TRATTIENE ANCHE LA SUA ANAGRAFICA ──
        //
        // L'ordine «prima la pratica, poi l'anagrafica» da solo non basta, e il
        // controesempio è concreto: se la scansione allegata alla pratica d'origine
        // non esce dall'archivio, quella riga viene trattenuta — e l'anagrafica, che
        // ha un file suo (o nessuno), sarebbe chiudibile. Cancellandola si perderebbe
        // `origine_pratica_id`, cioè l'unico puntatore alla pratica rimasta: un
        // orfano con dentro codice fiscale, nascita, residenza, domicilio, recapiti e
        // `consents_log`, che nessun giro successivo saprebbe più trovare.
        //
        // Una pratica che la lettura non ha nemmeno restituito NON trattiene niente:
        // quell'id non è in `fascicoloConFile`, ed è una riga già sparita.
        const fascicoloChiuse = new Set(fascicoloChiudibili.map((r) => r.chiave))
        const fascicoloTrattenute = new Set(
            fascicoloConFile.filter((r) => !fascicoloChiuse.has(r.chiave)).map((r) => r.chiave),
        )
        const anagraficheChiudibili = chiudibili(anagraficheConFile).filter(
            (r) => !(typeof r.legata === 'string' && fascicoloTrattenute.has(r.legata)),
        )

        nTrattenute =
            praticheConFile.length -
            praticheChiudibili.length +
            (fascicoloConFile.length - fascicoloChiudibili.length) +
            (anagraficheConFile.length - anagraficheChiudibili.length) +
            (scansioniConFile.length - scansioniChiudibili.length)

        // ── POI LE RIGHE ──
        //
        // `count: 'exact'` — e non è pignoleria. Senza, il numero che finisce nel
        // battito e nella risposta è quello delle righe che si INTENDEVA toccare:
        // questo file predica «si verifica lo STATO, non il conteggio» per i file, e
        // sulle righe darebbe per buona la propria intenzione.
        let conteggiChiesti = 0
        let conteggiOttenuti = 0
        let scartoConteggio = false

        const registraConteggio = (count: number | null, attese: number): number => {
            conteggiChiesti++
            if (typeof count !== 'number') return attese
            conteggiOttenuti++
            if (count !== attese) scartoConteggio = true
            return count
        }

        if (praticheChiudibili.length > 0) {
            const { error, count } = await supabase
                .from('pratiche_personale')
                .delete({ count: 'exact' })
                .in('id', praticheChiudibili.map((r) => r.chiave))
            if (error) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'pratica',
                    error_code: codiceDi(error),
                    n_pratiche: praticheChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: scansioni rimosse ma righe di pratiche_personale NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nPratiche = registraConteggio(count ?? null, praticheChiudibili.length)
        }

        // ── LA PRATICA D'ORIGINE, PRIMA DELLA SUA ANAGRAFICA ──
        //
        // L'ordine è la sostanza, non lo stile: `origine_pratica_id` vive sul lato
        // anagrafica e la `delete` della pratica lo azzera da sé (`on delete set
        // null`). Cancellando prima l'anagrafica, se questa `delete` fallisse
        // resterebbe in tabella la copia integrale di un'anagrafica e nessuna riga
        // che sappia più a chi appartiene: il giro dopo non saprebbe nemmeno
        // cercarla. In quest'ordine, invece, un guasto lascia l'anagrafica al suo
        // posto e la coppia si richiude la notte seguente.
        //
        // È un blocco separato da quello sopra, e non un unico `.in()`, perché i due
        // conteggi rispondono a due domande diverse — «quante richieste non
        // approvate sono scadute» e «quanti fascicoli si sono chiusi» — e sommarli
        // renderebbe il battito illeggibile proprio nel giro in cui serve.
        if (fascicoloChiudibili.length > 0) {
            const { error, count } = await supabase
                .from('pratiche_personale')
                .delete({ count: 'exact' })
                .in('id', fascicoloChiudibili.map((r) => r.chiave))
            if (error) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'pratica-fascicolo',
                    error_code: codiceDi(error),
                    n_pratiche_fascicolo: fascicoloChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg:
                        `${JOB}: pratiche d'origine dei fascicoli scaduti NON cancellate; le anagrafiche ` +
                        `restano al loro posto, così la coppia si richiude al giro successivo`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nPraticheFascicolo = registraConteggio(count ?? null, fascicoloChiudibili.length)
        }

        if (anagraficheChiudibili.length > 0) {
            const { error, count } = await supabase
                .from('anagrafica_personale')
                .delete({ count: 'exact' })
                .in('utente_id', anagraficheChiudibili.map((r) => r.chiave))
            if (error) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'anagrafica',
                    error_code: codiceDi(error),
                    n_anagrafiche: anagraficheChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: scansioni rimosse ma righe di anagrafica_personale NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nAnagrafiche = registraConteggio(count ?? null, anagraficheChiudibili.length)
        }

        if (scansioniChiudibili.length > 0) {
            // L'UPDATE che DIMENTICA il file, e viene DOPO la sua rimozione. Il
            // rapporto di lavoro è finito da un anno ma il fascicolo resta ancora
            // nove: si toglie la sola copia del documento, e la riga sopravvive.
            const { error, count } = await supabase
                .from('anagrafica_personale')
                .update({ documento_path: null }, { count: 'exact' })
                .in('utente_id', scansioniChiudibili.map((r) => r.chiave))
            if (error) {
                // Le scansioni sono USCITE e la colonna le nomina ancora: è il caso
                // in cui il prossimo giro troverà un percorso che non esiste più.
                // Non è una perdita di dati — `rimuoviEVerifica` tratta il file già
                // assente come esito raggiunto — ma è un guasto, e si dichiara.
                esitoBattito = 'scansioni-non-azzerate'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    entita_tipo: 'anagrafica',
                    error_code: codiceDi(error),
                    n_scansioni: scansioniChiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: scansioni rimosse dall'archivio ma documento_path NON azzerato`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'scansioni-non-azzerate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            nScansioni = registraConteggio(count ?? null, scansioniChiudibili.length)
        }

        conteggioVerificato = conteggiChiesti > 0 && conteggiOttenuti === conteggiChiesti
        if (scartoConteggio) {
            // `.in('id', …)` non può toccare PIÙ righe di quante ne nomina: lo scarto
            // è sempre in difetto, e significa che quelle righe erano già sparite fra
            // la SELECT e la DELETE. Resta `warn` e non `error`, ma per la ragione
            // giusta: il fine di questo job — quelle righe non ci sono più — è
            // raggiunto comunque, e chiamare «errore» una retention riuscita è la
            // strada per far spegnere l'allarme. Ciò che questo `warn` garantisce è
            // che il numero dichiarato sia quello VERO e che lo scarto abbia un nome.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'conteggio-discorde',
                canale,
                n_pratiche: nPratiche,
                n_pratiche_fascicolo: nPraticheFascicolo,
                n_anagrafiche: nAnagrafiche,
                n_scansioni: nScansioni,
                msg: `${JOB}: toccate meno righe di quante ne erano state nominate; cercare una scrittura manuale in SQL o due giri sovrapposti. Si dichiara il numero vero`,
            })
        }

        if (nTrattenute > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto.
            esitoBattito = 'righe-trattenute'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_pratiche: nPratiche,
                n_pratiche_fascicolo: nPraticheFascicolo,
                n_anagrafiche: nAnagrafiche,
                n_scansioni: nScansioni,
                n_righe_trattenute: nTrattenute,
                n_file_bloccanti: nBloccanti,
                n_file_ancora_presenti: esito.ancoraPresenti.length,
                n_file_non_verificati: esito.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${nTrattenute} righe NON chiuse, ${nBloccanti} scansioni ancora nell'archivio o non verificabili`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                    // risposta: chi legge il registro deve poter distinguere un archivio
                    // che non risponde da un file che non esce.
                    motivo:
                        esito.ancoraPresenti.length > 0
                            ? 'allegati-non-rimossi'
                            : 'verifica-non-riuscita',
                    pratiche: nPratiche,
                    pratiche_fascicolo: nPraticheFascicolo,
                    anagrafiche: nAnagrafiche,
                    scansioni: nScansioni,
                    righe_trattenute: nTrattenute,
                    file: esito.rimossi.length,
                    file_bloccanti: nBloccanti,
                },
                { status: 500 },
            )
        }

        return NextResponse.json({
            ok: true,
            pratiche: nPratiche,
            // Separato da `pratiche`, e non sommato: sono due termini diversi —
            // novanta giorni dalla richiesta non approvata, dieci anni dalla
            // cessazione per il modulo che ha generato il fascicolo. Un numero solo
            // renderebbe impossibile capire quale dei due sta lavorando.
            pratiche_fascicolo: nPraticheFascicolo,
            anagrafiche: nAnagrafiche,
            scansioni: nScansioni,
            file: esito.rimossi.length,
            file_gia_assenti: esito.giaAssenti.length,
            // Il lotto tagliato si dichiara anche qui: chi lancia il giro a mano
            // deve sapere se richiamarlo, e non deve dedurlo da un conteggio.
            lotto_pieno: lottoPieno,
            giorni_pratica: GIORNI_PRATICA,
            mesi_documento: MESI_DOCUMENTO,
            anni_fascicolo: ANNI_FASCICOLO,
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
        // SEMPRE, anche a zero, anche quando tutto è fallito: è la riga che nella
        // versione SQL del bisnonno non veniva mai scritta.
        //
        // `esito: 'ok'` solo quando il giro ha davvero finito il lavoro, ed è
        // deliberato: `controlloBattitoCron` (`/api/health`) conta come battito i
        // soli esiti di `ESITI_BATTITO` — `ok` e `ok-parziale` — quindi un lavoro
        // che fallisce ogni notte diventa visibile come «job senza battito» oltre
        // la finestra. L'esito risponde a «è andata bene?», non a «di che cosa si
        // occupa».
        //
        // ⚠️ QUESTO GIRO NON SCRIVE MAI `ok-parziale`, e non è un dettaglio: il
        // terzo stato serve a chi salta una porzione di lavoro per una funzionalità
        // assente (è il caso di `notifiche-promemoria` con `locker_requests`).
        // Qui una fase saltata significa che una scansione di documento d'identità
        // è rimasta dov'era, e non esiste un modo mite di dirlo: gli esiti di
        // guasto qui sopra sono tutti nomi propri di ciò che non è stato tolto.
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            n_pratiche: nPratiche,
            n_pratiche_fascicolo: nPraticheFascicolo,
            n_anagrafiche: nAnagrafiche,
            n_scansioni: nScansioni,
            n_pratiche_scadute: nPraticheScadute,
            // Le pratiche non approvate che NON si sono potute datare, e che perciò
            // restano indietro. Sta accanto a `n_pratiche_scadute` di proposito:
            // insieme dicono «quante ne ho chiuse» e «quante non ho potuto
            // guardare», che è la distinzione senza la quale un `esito: ok` a zero
            // righe non significa niente.
            n_pratiche_senza_riferimento: nPraticheSenzaRiferimento,
            n_anagrafiche_scadute: nAnagraficheScadute,
            n_scansioni_scadute: nScansioniScadute,
            n_righe_trattenute: nTrattenute,
            n_file: esito.rimossi.length,
            n_file_gia_assenti: esito.giaAssenti.length,
            n_file_bloccanti: nBloccanti,
            giorni_pratica: GIORNI_PRATICA,
            mesi_documento: MESI_DOCUMENTO,
            anni_fascicolo: ANNI_FASCICOLO,
            documento_path_ignoto: documentoIgnoto,
            cessazione_ignota: cessazioneIgnota,
            // La colonna del LEGAME fra fascicolo e modulo d'origine. Si dichiara
            // anche quando non ha fermato niente (nessun fascicolo scaduto in questo
            // giro): è l'unico modo di distinguere, rileggendo `app_log`, «il
            // database ce l'ha» da «non c'era ancora niente da chiudere».
            origine_pratica_ignota: origineIgnota,
            lotto_pieno: lottoPieno,
            // `false` non vuol dire «il conteggio è sbagliato»: vuol dire che
            // PostgREST non l'ha restituito (o che non c'era niente da contare) e i
            // numeri qui accanto sono l'intenzione, non la misura. Distinguere le due
            // cose è tutto il punto di questo file.
            conteggio_verificato: conteggioVerificato,
            ms: Date.now() - t0,
            msg: `${JOB}: ${nPratiche} pratiche, ${nPraticheFascicolo} moduli d'origine, ${nAnagrafiche} anagrafiche e ${nScansioni} scansioni oltre il termine`,
        })
    }
})
