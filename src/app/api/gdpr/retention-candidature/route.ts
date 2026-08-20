import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { CANDIDATURA_LIMITI } from '@/lib/forms/insegnanti-template'
import { BUCKET_CURRICULUM, CV_PREFISSO } from '@/lib/candidature/percorso-cv'

/**
 * LA CONSERVAZIONE DELLE CANDIDATURE SPONTANEE — curriculum compreso.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ È UNA ROUTE E NON UNA FUNZIONE SQL ─────────────
 *
 * Il modulo pubblico `/lavora-con-noi` raccoglie il nome, il recapito e spesso il
 * curriculum di persone adulte che si propongono per un lavoro. La base giuridica
 * è l'art. 6.1.b (misure precontrattuali su richiesta dell'interessata): finita la
 * valutazione, quella base **si esaurisce** e non copre più niente. Tenere il
 * curriculum «per il futuro» è una finalità nuova, e per quella serve il consenso
 * — che il modulo chiede a parte, facoltativo e revocabile.
 *
 * Da qui i due termini di questo file. E da qui la ragione per cui è una route
 * HTTP e non una funzione SQL: **i file si tolgono solo dalla Storage API**, e da
 * Postgres non ci si arriva. Il gemello di questo lavoro — la conservazione delle
 * domande d'iscrizione — è nato come funzione SQL con un `DELETE FROM
 * storage.objects` dentro, e Postgres lo vieta (`42501`, trigger
 * `protect_objects_delete`, FOR EACH STATEMENT: scatta anche a zero righe). Quel
 * lavoro sarebbe fallito dalla prima notte e per sempre.
 *
 * ─── LE QUATTRO COSE CHE IL GEMELLO HA GIÀ PAGATO ───────────────────────────
 *
 * 1. **PRIMA I FILE, POI LE RIGHE.** Al contrario, un errore a metà lascerebbe i
 *    curriculum nell'archivio senza più nessuna riga che li nomini: invisibili,
 *    non cancellati — che è il modo peggiore di conservare un dato personale. E
 *    la rinuncia è PER CANDIDATURA: un curriculum che non esce trattiene **la
 *    sua** riga, non l'intero lotto.
 *
 * 2. **IL CONTEGGIO SI SCRIVE SEMPRE, ANCHE A ZERO, E FUORI DAL RAMO CHE PUÒ
 *    FALLIRE.** Nella versione SQL del gemello l'`INSERT` in `app_log` stava DOPO
 *    la `DELETE`: l'eccezione lo saltava, e la difesa che doveva accorgersi del
 *    guasto era a valle del guasto. Qui il battito sta in un `finally`, ed è la
 *    prima cosa che questo file garantisce. Con i soli errori, «nessun log» non
 *    distingue «tutto a posto» da «non è mai partito niente».
 *
 * 3. **RIGHE TRATTENUTE ⇒ 500.** Un 200 direbbe «fatto» a chi sorveglia il lavoro
 *    notturno, e la conservazione di quelle candidature resterebbe scoperta senza
 *    che nessuno lo sappia.
 *
 * 4. **IL TERMINE APPLICATO È IL TERMINE PROMESSO.** I 24 mesi non sono un numero
 *    di questo file: sono `CANDIDATURA_LIMITI.mesiConservazione`, cioè quelli
 *    interpolati nel testo del consenso che la persona ha letto e spuntato. Due
 *    costanti indipendenti per lo stesso termine divergono in silenzio, e qui a
 *    divergere sarebbe la dichiarazione su cui è stato prestato il consenso
 *    (art. 13 §2 lett. a GDPR).
 *
 *    ⚠️ CORRETTO IL 2026-08-10, ed è il difetto più istruttivo di questo file:
 *    la prima stesura scriveva questa riga e poi non la rispettava. Applicava i
 *    24 mesi anche alla candidatura **accolta senza consenso**, e per giunta
 *    facendoli decorrere da `evasa_il` invece che dalla ricezione — cioè fino a
 *    ~24 mesi oltre il termine dichiarato. Le tre fonti dicevano tutte un'altra
 *    cosa, e concordavano fra loro:
 *      · l'informativa: «dodici mesi dalla ricezione, o dalla decisione se la
 *        candidatura NON è accolta»; ventiquattro **con il consenso**;
 *      · il testo del consenso (`insegnanti-template.ts`): 24 mesi «anche se la
 *        valutazione dovesse avere esito NEGATIVO», cioè il consenso è la sola
 *        leva che allunga;
 *      · la docstring della costante importata: «Mesi di conservazione della
 *        candidatura NON accolta, se acconsentito».
 *    A divergere era il codice, ed è il codice che si è mosso: nessuna riga
 *    dell'informativa è stata riscritta per giustificare a posteriori ciò che il
 *    programma faceva. Se un giorno il titolare vorrà un termine PROPRIO per la
 *    candidatura accolta (è il fascicolo di una persona poi assunta, e la cosa è
 *    difendibile), quel termine va prima DICHIARATO nell'informativa e poi
 *    applicato qui — in quest'ordine, non nell'altro.
 *
 * ─── COSA NON ENTRA NEI LOG, E PERCHÉ QUI CONTA PIÙ DEL SOLITO ──────────────
 *
 * Il **nome del file del curriculum**. In produzione si chiama `cv-<cognome>.pdf`:
 * quel nome È il cognome di chi si è candidato, e `app_log` è interrogabile in SQL
 * per 30 giorni. Niente email, niente nomi, niente telefono, niente motivo del
 * rifiuto, niente percorsi. Conteggi, uuid, esiti, codici d'errore.
 */

/** Il nome con cui questo lavoro si presenta in `app_log` e in `JOB_CRON`. */
const JOB = 'candidature-retention'

/**
 * DODICI MESI — il termine ordinario.
 *
 * Vale per la candidatura **mai valutata** (dalla ricezione) e per quella
 * **rifiutata** (dalla decisione): esaurita la valutazione, l'art. 6.1.b non
 * copre più il trattamento. È il numero che l'informativa dichiara, in lettere,
 * nella voce «Candidature spontanee di personale».
 */
const MESI_SENZA_CONSENSO = 12

/**
 * VENTIQUATTRO MESI — e non è un numero scritto qui.
 *
 * È `CANDIDATURA_LIMITI.mesiConservazione`, cioè **il termine che il testo del
 * consenso promette all'interessata** (`insegnanti-template.ts` lo interpola
 * dentro la frase che la persona spunta, e la frase finisce congelata in
 * `consents_log`). Ribatterlo qui come `24` significherebbe che il giorno in cui
 * il titolare cambia termine il modulo promette una cosa e il cron ne applica
 * un'altra — in silenzio, e su una promessa scritta.
 *
 * ⚠️ SI APPLICA **SOLO COL CONSENSO** (o quando il consenso è ignoto, che vale
 * consenso). La costante dichiara di sé, testualmente, «mesi di conservazione
 * della candidatura NON accolta, **se acconsentito**»: usarla per un caso che
 * quella riga esclude — la candidatura accolta, senza consenso — sarebbe
 * riprendere il difetto appena corretto da un'altra porta.
 */
const MESI_CON_CONSENSO = CANDIDATURA_LIMITI.mesiConservazione

/**
 * L'id del blocco di consenso alla conservazione, in `consents_log`.
 *
 * È un letterale, e non può non esserlo: `CONSENSI_INSEGNANTI_FIELDS` è un
 * array di campi, non una mappa, e dedurre «il consenso facoltativo» dalla forma
 * dell'array si romperebbe il giorno in cui i consensi facoltativi diventano due.
 * Il presidio è un test — `gdpr-retention-candidature.test.ts` verifica che questo
 * id esista davvero fra i campi del modulo: se qualcuno lo rinominasse lì, qui si
 * cercherebbe per sempre un campo che non c'è, e **ogni candidatura verrebbe
 * cancellata a dodici mesi come se nessuno avesse mai acconsentito**.
 */
const ID_CONSENSO_CONSERVAZIONE = 'consenso_conservazione_candidatura'

/**
 * Il bucket dei curriculum, e il prefisso sotto cui vivono.
 *
 * ⚠️ SI IMPORTANO, non si ribattono. Fino al 2026-08-15 qui c'era
 * `const BUCKET_ALLEGATI = 'form_attachments'` e nel pannello di Segreteria
 * `const BUCKET_CV = 'form_attachments'`: due nomi diversi per lo stesso
 * archivio, in due file che DEVONO puntare allo stesso posto — uno firma ciò
 * che l'altro cancella. Adesso li dichiara `@/lib/candidature/percorso-cv`, che
 * è anche il file dove vive la forma del percorso.
 */
const BUCKET_ALLEGATI = BUCKET_CURRICULUM

/**
 * Da quante ore un curriculum che nessuna candidatura nomina è un ORFANO.
 *
 * Ventiquattro, come `ORE_CARICAMENTO_IN_SOSPESO` del modulo del personale, e per
 * la stessa ragione: il margine deve coprire abbondantemente una compilazione
 * interrotta e ripresa. Chi carica il curriculum e poi finisce di compilare il
 * modulo mezz'ora dopo non deve trovarsi il file portato via da sotto le mani.
 */
const ORE_CURRICULUM_ORFANO = 24

/**
 * Quanti oggetti si guardano per giro.
 *
 * Mille è il numero del precedente (`obliaPdfCredenziali`), ed è il massimo che
 * la Storage API serve in una pagina. Con ~3 candidature l'ora possibili per IP
 * questo prefisso non ci arriva vicino; il tetto c'è perché una pagina piena è
 * un elenco TRONCATO, cioè oggetti che nessuno ha nemmeno guardato, e un
 * troncamento silenzioso qui varrebbe una pulizia dichiarata e non fatta.
 */
const TETTO_ELENCO_ORFANI = 1000

/**
 * A quanti percorsi per volta si chiede al database «questo lo nomina qualcuno?».
 *
 * `.in()` finisce nella query string di PostgREST, e una `IN` con mille valori
 * produce un URL che nessuno garantisce venga accettato per intero. Cento è la
 * misura prudente: dieci andate e ritorni nel caso peggiore, su un lavoro che
 * gira una volta a notte.
 */
const LOTTO_VERIFICA_ORFANI = 100

/**
 * Gli stati in cui la candidatura NON è stata accolta: **lì, e solo lì**, il
 * termine decorre dalla decisione.
 *
 * Non è una sfumatura, è la frase dell'informativa letta alla lettera: «dodici
 * mesi dalla ricezione, **o dalla decisione se la candidatura non è accolta**».
 * `approvata` stava dentro questo insieme fino al 2026-08-10 e non doveva
 * starci: spostava il giorno d'inizio in avanti — di quanto ci mette la
 * Direzione a decidere — su una candidatura per cui l'informativa promette la
 * decorrenza dalla RICEZIONE.
 *
 * Il verso dell'errore era quello che conserva DI PIÙ, ed è il verso sbagliato
 * quando il numero è un termine dichiarato: conservare oltre il termine promesso
 * non è prudenza, è il trattamento che l'art. 13 §2 lett. a non copre più.
 */
const STATI_NON_ACCOLTE = new Set(['rifiutata'])

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
 * L'errore riguarda le RIGHE DI SEDE, cioè l'embed?
 *
 * ⚠️ NON basta «un errore qualunque». Se un guasto qualsiasi facesse cadere
 * l'embed, il ripiego sulla colonna aggregata diventerebbe la strada normale —
 * e siccome è meno conservativo sul caso misto, si cancellerebbe prima del
 * dovuto per un guasto di rete. Si ripiega solo su ciò che dice, con parole
 * sue, che la relazione o la tabella non c'è:
 *
 *  · `PGRST200` — «Could not find a relationship … in the schema cache»,
 *    che è la risposta esatta a un embed verso una tabella che non esiste;
 *  · tabella assente, ma SOLO se il messaggio nomina `candidature_sedi`:
 *    lo stesso codice su `candidature_insegnanti` è un'altra storia, e va
 *    a finire in 503 come prima.
 */
function sediIllegibili(err: unknown): boolean {
    const codice = codiceDi(err)
    if (codice === 'PGRST200') return true
    const messaggio = String((err as { message?: unknown } | null)?.message ?? '')
    return (
        (CODICI_TABELLA_ASSENTE.has(codice) || CODICI_COLONNA_ASSENTE.has(codice)) &&
        messaggio.includes('candidature_sedi')
    )
}

/**
 * Le colonne che possono mancare su un database non migrato, e cosa significa
 * perderle. Nessuna di queste assenze autorizza a cancellare di più: quando
 * un'informazione non c'è, si sceglie sempre il verso che CONSERVA.
 */
const COLONNE_FACOLTATIVE = ['consents_log', 'evasa_il', 'cv_path'] as const
type ColonnaFacoltativa = (typeof COLONNE_FACOLTATIVE)[number]

const COLONNE_SEMPRE = ['id', 'stato', 'creata_il'] as const

/**
 * IL TETTO DEL LOTTO, e perché un giro senza tetto è un giro che a un certo
 * punto smette di funzionare senza dirlo.
 *
 * PostgREST ha un suo massimo di righe (`db-max-rows`) e la funzione ha un tempo
 * massimo: una lettura senza `.limit()` non è «tutte le righe», è «tutte finché
 * qualcun altro non decide di tagliare» — e il taglio di qualcun altro arriva
 * muto. Con un tetto ESPLICITO il taglio è nostro, si sa quand'è avvenuto
 * (`lotto_pieno` nel battito) e il giro dopo riprende dalle più vecchie, perché
 * la lettura è ordinata per `creata_il` crescente: la candidatura più in ritardo
 * è la prima a uscire, non l'ultima.
 */
const TETTO_LOTTO = 500

type Candidatura = {
    id: string
    stato?: string | null
    creata_il?: string | null
    evasa_il?: string | null
    cv_path?: string | null
    consents_log?: unknown
    /**
     * LE DECISIONI, UNA PER PLESSO. Assente ⇒ il database non ha
     * `candidature_sedi` (la CI non è migrata) e si ripiega sulla colonna
     * aggregata: vedi `scadenza()`.
     */
    candidature_sedi?: { stato?: string | null; evasa_il?: string | null }[] | null
}

/**
 * L'embed delle righe di sede. NON è filtrato, e non deve esserlo: il cron non
 * guarda per conto di un plesso, guarda per conto del titolare del trattamento —
 * deve vedere TUTTE le decisioni, perché è l'ultima a fissare il termine.
 */
const EMBED_SEDI = 'candidature_sedi(stato, evasa_il)'

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
function colonneMancanti(errore: unknown): ColonnaFacoltativa[] {
    const testo = [
        (errore as { message?: unknown } | null)?.message,
        (errore as { details?: unknown } | null)?.details,
        (errore as { hint?: unknown } | null)?.hint,
    ]
        .map((v) => (typeof v === 'string' ? v : ''))
        .join(' ')
    const nominate = COLONNE_FACOLTATIVE.filter((c) => testo.includes(c))
    return nominate.length > 0 ? [...nominate] : [...COLONNE_FACOLTATIVE]
}

/** `data + n mesi`, con lo stesso arrotondamento di `Date.setMonth`. */
function piuMesi(data: Date, mesi: number): Date {
    const d = new Date(data.getTime())
    d.setMonth(d.getMonth() + mesi)
    return d
}

/**
 * Ha acconsentito alla conservazione per opportunità future?
 *
 * `consents_log` è l'array prodotto da `estraiConsensi`: un elemento per blocco,
 * con `field_id` e `accepted`. `ignoto = true` (la colonna non esiste su questo
 * database) risponde **sì**: non si cancella prima del termine più lungo che si
 * potrebbe aver promesso. «Non lo so» non autorizza a distruggere — è la stessa
 * regola di `rimuoviEVerifica`, dove «non so se il file c'è ancora» vale «c'è».
 */
function haConsensoConservazione(consents: unknown, ignoto: boolean): boolean {
    if (ignoto) return true
    if (!Array.isArray(consents)) return false
    return consents.some((c) => {
        const b = c as { field_id?: unknown; accepted?: unknown } | null
        return b?.field_id === ID_CONSENSO_CONSERVAZIONE && b?.accepted === true
    })
}

/**
 * Il giorno da cui decorre il termine, e i mesi che si applicano.
 *
 * Una regola sola, in un posto solo, e **due leve indipendenti** — che è il modo
 * in cui la si legge senza sbagliarsi:
 *
 *  · IL GIORNO D'INIZIO lo sposta **solo il rifiuto**: dalla DECISIONE se la
 *    candidatura non è accolta, dalla RICEZIONE in ogni altro caso (mai
 *    valutata, in valutazione, accolta). Parole dell'informativa: «dodici mesi
 *    dalla ricezione, o dalla decisione se la candidatura non è accolta».
 *
 *  · LA DURATA la allunga **solo il consenso**: 24 mesi se la persona ha
 *    spuntato la conservazione per opportunità future (o se il consenso è
 *    ignoto, che qui vale sì), 12 altrimenti. Parole del modulo: 24 mesi «anche
 *    se la valutazione dovesse avere esito negativo».
 *
 * I tre casi, per esteso, perché il lock li prova uno per uno:
 *   accolta      → 12 mesi dalla RICEZIONE   (24 col consenso)
 *   respinta     → 12 mesi dalla DECISIONE   (24 col consenso)
 *   mai valutata → 12 mesi dalla RICEZIONE   (24 col consenso)
 */
function termine(
    riga: Candidatura,
    consensoIgnoto: boolean,
): { riferimento: Date | null; mesi: number } {
    const stato = typeof riga.stato === 'string' ? riga.stato : ''
    const decisione =
        STATI_NON_ACCOLTE.has(stato) && typeof riga.evasa_il === 'string' ? riga.evasa_il : null
    const base = decisione ?? (typeof riga.creata_il === 'string' ? riga.creata_il : null)
    const t = base ? Date.parse(base) : NaN
    const mesi = haConsensoConservazione(riga.consents_log, consensoIgnoto)
        ? MESI_CON_CONSENSO
        : MESI_SENZA_CONSENSO
    return { riferimento: Number.isNaN(t) ? null : new Date(t), mesi }
}

/**
 * LA SCADENZA DELLA CANDIDATURA È LA PIÙ LONTANA FRA QUELLE DELLE SUE SEDI.
 *
 * ─── PERCHÉ UNA DATA SOLA NON BASTAVA ───────────────────────────────────────
 * `candidature_insegnanti.evasa_il` è UNA colonna e porta il termine di PIÙ
 * trattamenti: dal 2026-08-19 una candidatura può essere rivolta a tre plessi, e
 * ognuno la valuta per conto suo. Il trigger `candidature_sedi_aggrega` ci scrive
 * `max()` — il verso che conserva di più — ma l'aggregato `stato` è un'altra cosa
 * ancora, e nel caso MISTO le due cose insieme sbagliano.
 *
 * Aversa rifiuta a novembre, Giugliano approva a dicembre, la candidatura è
 * arrivata a gennaio. L'aggregato vale `approvata`, quindi il termine decorre
 * dalla RICEZIONE: si cancella a gennaio, cioè DUE MESI dopo il rifiuto di
 * Aversa invece dei dodici che l'informativa promette. Il verbale di quel
 * rifiuto sparisce prima del dovuto — la stessa classe di difetto che la
 * migrazione `20260820004500` ha chiuso su un altro percorso.
 *
 * ─── LA REGOLA, PER RIGA ────────────────────────────────────────────────────
 *   riga `rifiutata` → dalla SUA decisione
 *   riga `approvata` → dalla ricezione
 *   riga `pending`   → dalla ricezione
 * e la candidatura si cancella quando è scaduta l'ULTIMA.
 *
 * La DURATA (12 / 24 mesi) resta una proprietà della PERSONA, non della riga:
 * la sposta il consenso, e il consenso è uno solo.
 *
 * ⚠️ NEI CASI NON MISTI NON CAMBIA NIENTE, ed è la prova che questa non è una
 * riscrittura del termine: tutte rifiutate → l'ultima decisione, identico a
 * `max(evasa_il)`; tutte approvate o mai valutate → la ricezione, identico a
 * prima. Cambia solo il misto, e nel verso che CONSERVA. Nessuna promessa
 * dell'informativa viene ridotta, quindi non c'è niente da riscrivere lì.
 *
 * ─── SENZA LE RIGHE DI SEDE ─────────────────────────────────────────────────
 * Il database della CI non ha `candidature_sedi`: lì si ripiega su `termine()`,
 * cioè sulla regola della colonna aggregata. Il ripiego è DICHIARATO da chi
 * legge (`esito: 'sedi-non-leggibili'`), non taciuto qui.
 */
function scadenza(riga: Candidatura, consensoIgnoto: boolean): Date | null {
    const mesi = haConsensoConservazione(riga.consents_log, consensoIgnoto)
        ? MESI_CON_CONSENSO
        : MESI_SENZA_CONSENSO
    const righe = riga.candidature_sedi
    if (!Array.isArray(righe) || righe.length === 0) {
        const { riferimento } = termine(riga, consensoIgnoto)
        return riferimento ? piuMesi(riferimento, mesi) : null
    }
    const ricezione = typeof riga.creata_il === 'string' ? Date.parse(riga.creata_il) : NaN
    let piuLontana: Date | null = null
    for (const r of righe) {
        const stato = typeof r.stato === 'string' ? r.stato : ''
        const decisione =
            STATI_NON_ACCOLTE.has(stato) && typeof r.evasa_il === 'string' ? Date.parse(r.evasa_il) : NaN
        const base = Number.isNaN(decisione) ? ricezione : decisione
        // Una data che non si sa leggere non è un permesso: su un'operazione
        // irreversibile «non verificabile» vale «non toccare», e basta UNA riga
        // illeggibile perché l'intera candidatura resti.
        if (Number.isNaN(base)) return null
        const sua = piuMesi(new Date(base), mesi)
        if (piuLontana === null || sua.getTime() > piuLontana.getTime()) piuLontana = sua
    }
    return piuLontana
}

/** Quello che la spazzata degli orfani ha fatto, per il battito e per la risposta. */
interface EsitoSpazzata {
    /** Oggetti sotto il prefisso, più vecchi della soglia, effettivamente guardati. */
    esaminati: number
    /** …di cui nessuna candidatura nomina. */
    orfani: number
    /** …e che sono davvero usciti dall'archivio. */
    rimossi: number
    /** La pagina era piena: là sotto c'è dell'altro che nessuno ha guardato. */
    troncato: boolean
    /**
     * ⚠️ `non-eseguita` NON è `ok`, ed è la correzione di un difetto che questo
     * file predicava di evitare due schermate più su.
     *
     * La spazzata gira in coda al PERCORSO FELICE: se il lotto principale
     * trattiene delle candidature la route esce prima, e la spazzata non parte
     * affatto. Con un valore iniziale `'ok'` il battito nel `finally` avrebbe
     * scritto `orfani_esito: 'ok'` e `n_orfani_esaminati: 0` — cioè «guardato,
     * niente da fare» — su un giro in cui nessuno ha guardato niente. È
     * esattamente l'ambiguità che l'intero file esiste per togliere: «tutto a
     * posto» e «non è mai partito niente» devono restare due fatti diversi.
     */
    esito:
        | 'ok'
        | 'non-eseguita'
        | 'elenco-non-letto'
        | 'verifica-non-riuscita'
        | 'rimozione-non-riuscita'
}

/** Il valore prima che la spazzata parta: dice che NON è partita. */
const SPAZZATA_NON_ESEGUITA: EsitoSpazzata = {
    esaminati: 0,
    orfani: 0,
    rimossi: 0,
    troncato: false,
    esito: 'non-eseguita',
}

/** …e questo è «è partita e non c'era niente da togliere», che è un altro fatto. */
const SPAZZATA_SENZA_ORFANI: EsitoSpazzata = { ...SPAZZATA_NON_ESEGUITA, esito: 'ok' }

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  GLI ORFANI DEL PREFISSO `candidature/`                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL DIFETTO, che non è il caso dell'abuso ma quello normale ─────────────
 *
 * Il curriculum si carica PRIMA che la candidatura esista: la rotta di
 * caricamento scrive subito nel bucket e restituisce il percorso, e l'invio del
 * modulo viene dopo. Fra i due gesti c'è una persona che può chiudere la pagina.
 * Chi lo fa lascia il proprio curriculum nell'archivio a tempo indeterminato,
 * senza nessuna riga che lo nomini — e tutto ciò che sta sopra in questo file
 * NON può vederlo: la conservazione parte dalle RIGHE, quindi guarda solo i
 * curriculum già reclamati.
 *
 * È esattamente lo stato che questo file chiama, con parole sue, «il modo
 * peggiore di conservare un dato personale»: invisibile, non cancellato, e
 * nemmeno identificabile per cancellarlo se quella persona lo chiedesse. Il
 * modulo del personale l'ha pagato l'11/08/2026 e l'ha chiuso con un registro
 * (`caricamenti_personale`): una tabella, una migrazione, un secondo
 * proprietario.
 *
 * ── PERCHÉ QUI BASTA UNA SPAZZATA PER PREFISSO ─────────────────────────────
 *
 * Perché sotto `candidature/` scrive UNA rotta sola e non ci scrive nient'altro
 * (`iscrizione/insegnanti/upload:POST` — l'altra porta pubblica sullo stesso
 * bucket usa `iscrizioni/…`). Quindi «elencato sotto il prefisso e non nominato
 * da nessuna riga» È già la definizione esatta di orfano: non serve una tabella
 * per ricostruirla, serve una lettura. Il registro del personale doveva fare
 * anche un'altra cosa che qui è già fatta altrove — dimostrare che l'oggetto
 * ESISTE, e imporre «un oggetto, un proprietario» — e quella metà, dal
 * 2026-08-15, la impone l'indice unico su `cv_path`.
 *
 * ── LE QUATTRO PRUDENZE ────────────────────────────────────────────────────
 *
 *  1. **Solo ciò che è vecchio.** Un curriculum caricato dieci minuti fa è di
 *     qualcuno che sta ancora compilando: la soglia è di 24 ore.
 *  2. **Prima si chiede al database, poi si cancella.** Se la lettura di
 *     `cv_path` fallisce non si tocca NIENTE: «non so quali file siano reclamati»
 *     vale «sono tutti reclamati». È lo stesso verso di `rimuoviEVerifica`, dove
 *     «non so se il file c'è ancora» vale «c'è».
 *  3. **Il troncamento si dichiara.** Una pagina piena significa oggetti mai
 *     guardati, e un elenco tagliato in silenzio racconta una pulizia completa.
 *  4. **Non lancia mai.** Un guasto della spazzata non può diventare un giro di
 *     conservazione fallito: le due cose sono indipendenti, e la seconda è quella
 *     che risponde a una promessa scritta nel consenso.
 *
 * ⚠️ NEI LOG NON VA NESSUN PERCORSO, come in tutto il resto di questo file:
 * conteggi ed esiti. Il nome del file non c'è più per costruzione (la rotta di
 * caricamento lo butta via), ma il percorso resta la chiave con cui si firma il
 * curriculum di una persona.
 */
async function spazzaCurriculumOrfani(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    adesso: Date,
): Promise<EsitoSpazzata> {
    // `list()` vuole il prefisso SENZA la barra finale, e restituisce nomi
    // RELATIVI a quel prefisso: il percorso pieno si ricompone qui.
    const cartella = CV_PREFISSO.replace(/\/+$/, '')
    const soglia = new Date(adesso.getTime() - ORE_CURRICULUM_ORFANO * 60 * 60 * 1000)

    let elenco: { name?: string | null; id?: string | null; created_at?: string | null }[]
    try {
        const { data, error } = await supabase.storage.from(BUCKET_ALLEGATI).list(cartella, {
            limit: TETTO_ELENCO_ORFANI,
            // I più vecchi per primi: se la pagina taglia, taglia i meno in ritardo.
            sortBy: { column: 'created_at', order: 'asc' },
        })
        if (error) {
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'orfani-elenco-non-letto',
                bucket: BUCKET_ALLEGATI,
                msg: `${JOB}: elenco degli oggetti sotto il prefisso dei curriculum non letto: nessun orfano rimosso`,
            }, error)
            return { ...SPAZZATA_NON_ESEGUITA, esito: 'elenco-non-letto' }
        }
        elenco = (data ?? []) as typeof elenco
    } catch (e) {
        // La Storage API può lanciare (rete, JSON malformato): qui si assorbe, e
        // si dice che si è assorbito. Un `catch` muto è un bug.
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'orfani-elenco-non-letto',
            bucket: BUCKET_ALLEGATI,
            msg: `${JOB}: eccezione elencando gli oggetti sotto il prefisso dei curriculum`,
        }, e)
        return { ...SPAZZATA_NON_ESEGUITA, esito: 'elenco-non-letto' }
    }

    const troncato = elenco.length >= TETTO_ELENCO_ORFANI
    if (troncato) {
        logEvento('cron', 'warn', {
            operazione: JOB,
            esito: 'orfani-elenco-troncato',
            bucket: BUCKET_ALLEGATI,
            n_file: elenco.length,
            msg: `${JOB}: pagina piena a ${TETTO_ELENCO_ORFANI} oggetti, sotto il prefisso ce n'è dell'altro che questo giro non ha guardato`,
        })
    }

    // ⚠️ Le VOCI-CARTELLA hanno `id === null` e non sono oggetti: cancellarle non
    // si può, e trattarle come percorsi farebbe cercare al database righe che non
    // esistono. `.emptyFolderPlaceholder` è il segnaposto che lo Storage crea da
    // sé quando una cartella resta vuota: toglierlo farebbe sparire la cartella.
    const candidati = elenco
        .filter((o) => typeof o?.id === 'string' && o.id !== '')
        .filter((o) => (o.name ?? '') !== '' && o.name !== '.emptyFolderPlaceholder')
        .filter((o) => {
            const nato = Date.parse(o.created_at ?? '')
            // Data illeggibile ⇒ non si tocca: su un'operazione irreversibile «non
            // verificabile» vale «non toccare».
            return !Number.isNaN(nato) && nato <= soglia.getTime()
        })
        .map((o) => `${cartella}/${o.name}`)

    if (candidati.length === 0) return { ...SPAZZATA_SENZA_ORFANI, troncato }

    // ── CHI È RECLAMATO DA UNA RIGA? ────────────────────────────────────────
    const reclamati = new Set<string>()
    for (let i = 0; i < candidati.length; i += LOTTO_VERIFICA_ORFANI) {
        const lotto = candidati.slice(i, i + LOTTO_VERIFICA_ORFANI)
        const { data, error } = await supabase
            .from('candidature_insegnanti')
            .select('cv_path')
            .in('cv_path', lotto)
        if (error) {
            // FAIL-CLOSED, e vale per l'INTERA spazzata e non per il solo lotto: con
            // una parte dei reclami sconosciuta, gli orfani calcolati sui lotti
            // riusciti comprenderebbero file che una riga nomina davvero.
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'orfani-verifica-non-riuscita',
                bucket: BUCKET_ALLEGATI,
                error_code: codiceDi(error),
                n_file: candidati.length,
                msg: `${JOB}: non si è potuto sapere quali curriculum siano reclamati da una riga: NESSUN orfano rimosso`,
            }, error)
            return { esaminati: candidati.length, orfani: 0, rimossi: 0, troncato, esito: 'verifica-non-riuscita' }
        }
        for (const r of (data ?? []) as { cv_path?: unknown }[]) {
            if (typeof r.cv_path === 'string' && r.cv_path !== '') reclamati.add(r.cv_path)
        }
    }

    const orfani = candidati.filter((p) => !reclamati.has(p))
    if (orfani.length === 0) {
        return { esaminati: candidati.length, orfani: 0, rimossi: 0, troncato, esito: 'ok' }
    }

    const rimozione = await rimuoviEVerifica(supabase, BUCKET_ALLEGATI, orfani, JOB)
    const bloccati = bloccanti(rimozione)
    if (rimozione.erroreRimozione || bloccati.length > 0) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'orfani-non-rimossi',
            bucket: BUCKET_ALLEGATI,
            n_file: orfani.length,
            n_file_bloccanti: bloccati.length,
            msg: `${JOB}: curriculum orfani non rimossi (o non verificabili): restano nell'archivio senza nessuna riga che li nomini`,
        })
        return {
            esaminati: candidati.length,
            orfani: orfani.length,
            rimossi: rimozione.rimossi.length,
            troncato,
            esito: 'rimozione-non-riuscita',
        }
    }

    // Il SUCCESSO si logga, e qui più che altrove: questa pulizia non ha nessuna
    // schermata che si riempie a vista e nessuno che telefoni se smette di girare.
    logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'orfani-rimossi',
        bucket: BUCKET_ALLEGATI,
        n_file: rimozione.rimossi.length,
        n_file_gia_assenti: rimozione.giaAssenti.length,
        ore: ORE_CURRICULUM_ORFANO,
        msg: `${JOB}: ${rimozione.rimossi.length} curriculum caricati e mai inviati, più vecchi di ${ORE_CURRICULUM_ORFANO} ore, tolti dall'archivio`,
    })
    return {
        esaminati: candidati.length,
        orfani: orfani.length,
        rimossi: rimozione.rimossi.length,
        troncato,
        esito: 'ok',
    }
}

// POST /api/gdpr/retention-candidature
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-candidature:POST', async (request: NextRequest) => {
    const t0 = Date.now()
    let canale = 'cron'

    // ── I CONTATORI DEL BATTITO ──
    // Vivono QUI, fuori da ogni ramo che può fallire, e si scrivono nel `finally`.
    // È il punto di tutto questo file: un log che dimostra il funzionamento non
    // può stare dentro la transazione che deve sorvegliare.
    let esitoBattito = 'ok'
    let nCancellate = 0
    let nTrattenute = 0
    let nScadute = 0
    let esito: EsitoRimozione = NIENTE_DA_TOGLIERE
    let nBloccanti = 0
    let consensoIgnoto = false
    let cvIgnoto = false
    let lottoPieno = false
    let conteggioVerificato = false
    /**
     * La spazzata degli orfani vive nei contatori del battito come tutto il
     * resto: se non lasciasse una riga anche quando non trova niente, «nessun
     * log» non distinguerebbe «non ci sono curriculum abbandonati» da «la
     * pulizia non parte più» — che è l'ambiguità contro cui è scritto l'intero
     * file.
     */
    let spazzata: EsitoSpazzata = SPAZZATA_NON_ESEGUITA

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

        // Il TAGLIO GROSSOLANO, e perché è corretto farlo su `creata_il`.
        // Il giorno di riferimento non è mai anteriore alla ricezione (`evasa_il`
        // viene dopo) e il termine più breve è di 12 mesi: nessuna candidatura
        // ricevuta da meno di 12 mesi può essere scaduta, qualunque sia il suo
        // stato. Il taglio FINE — per riga, con il suo termine — si fa in memoria
        // subito sotto, dove è leggibile e collaudabile.
        const sogliaMinima = piuMesi(adesso, -MESI_SENZA_CONSENSO)

        const leggi = (colonne: string, conSedi: boolean) =>
            supabase
                .from('candidature_insegnanti')
                .select(conSedi ? `${colonne}, ${EMBED_SEDI}` : colonne)
                .lt('creata_il', sogliaMinima.toISOString())
                // Le più vecchie per prime: se il tetto taglia, taglia le meno in
                // ritardo. Con l'ordine opposto un lotto pieno lascerebbe indietro
                // per sempre proprio le candidature scadute da più tempo.
                .order('creata_il', { ascending: true })
                .limit(TETTO_LOTTO)

        let colonne = [...COLONNE_SEMPRE, ...COLONNE_FACOLTATIVE].join(', ')
        let conSedi = true
        // PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo un
        // guasto di lettura diventerebbe «nessuna candidatura scaduta», cioè un
        // giro a vuoto che si dichiara riuscito.
        let { data, error: erroreLettura } = await leggi(colonne, conSedi)

        if (erroreLettura && conSedi && sediIllegibili(erroreLettura)) {
            // Il database della CI non ha `candidature_sedi`: si ritenta SENZA
            // l'embed e si torna alla regola della colonna aggregata.
            //
            // ⚠️ NON si salta la spazzata. Una conservazione che non gira è
            // peggio di una approssimata: significa curriculum di persone adulte
            // che restano nell'archivio oltre il termine promesso, e nessuno che
            // lo sappia. Il ripiego si DICE, con il codice: un ripiego taciuto
            // diventa la strada normale, ed è così che si scopre dopo un anno.
            conSedi = false
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'sedi-non-leggibili',
                canale,
                error_code: codiceDi(erroreLettura),
                msg:
                    `${JOB}: candidature_sedi non è leggibile su questo database: il termine ` +
                    `torna a essere quello della colonna aggregata. Sul caso MISTO (un plesso ` +
                    `approva, un altro rifiuta) è meno conservativo del dovuto`,
            })
            ;({ data, error: erroreLettura } = await leggi(colonne, conSedi))
        }

        if (erroreLettura && CODICI_COLONNA_ASSENTE.has(codiceDi(erroreLettura))) {
            // Il database della CI non è migrato: si ritenta SENZA le colonne che
            // non esistono, e lo si dice nominandole. Un ripiego taciuto è un
            // ripiego che nessuno scopre.
            const mancanti = colonneMancanti(erroreLettura)
            consensoIgnoto = mancanti.includes('consents_log')
            cvIgnoto = mancanti.includes('cv_path')
            colonne = [
                ...COLONNE_SEMPRE,
                ...COLONNE_FACOLTATIVE.filter((c) => !mancanti.includes(c)),
            ].join(', ')
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'colonna-assente',
                canale,
                error_code: codiceDi(erroreLettura),
                msg:
                    `${JOB}: colonne assenti su questo database (${mancanti.join(', ')}), lettura ` +
                    `ritentata senza. Senza \`consents_log\` il consenso è IGNOTO e vale il termine ` +
                    `più lungo (${MESI_CON_CONSENSO} mesi): non si cancella prima di quanto si ` +
                    `potrebbe aver promesso`,
            })
            ;({ data, error: erroreLettura } = await leggi(colonne, conSedi))
        }

        if (erroreLettura) {
            const codice = codiceDi(erroreLettura)
            const tabellaAssente = CODICI_TABELLA_ASSENTE.has(codice)
            esitoBattito = tabellaAssente ? 'tabella-assente' : 'lettura-fallita'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                error_code: codice,
                ms: Date.now() - t0,
                msg: tabellaAssente
                    ? `${JOB}: la tabella candidature_insegnanti non esiste su questo database (${codice}): nessuna cancellazione, e non si finge il contrario`
                    : `${JOB}: lettura delle candidature scadute non riuscita`,
            })
            // `{ ok, motivo }` e non `{ error }`: questa route la chiama pg_net, non
            // un browser. Una prosa italiana qui non la legge nessun utente — sarebbe
            // solo una stringa in più da tradurre.
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, error_code: codice },
                { status: tabellaAssente ? 503 : 500 },
            )
        }

        // ── IL TAGLIO FINE, per riga ──
        const lette = (data ?? []) as unknown as Candidatura[]
        lottoPieno = lette.length >= TETTO_LOTTO
        const scadute = lette.filter((r) => {
            // Data illeggibile ⇒ non si cancella. Un dato mancante non è un
            // permesso: è un «non verificabile», e su un'operazione irreversibile
            // «non verificabile» vale «non toccare».
            const quando = scadenza(r, consensoIgnoto)
            if (!quando) return false
            return quando.getTime() <= adesso.getTime()
        })
        nScadute = scadute.length

        if (lottoPieno) {
            // Un lotto tagliato che rispondesse `ok` senza dirlo sarebbe un giro
            // riuscito a metà travestito da giro riuscito: il resto delle
            // candidature scadute è ancora lì e nessuno lo saprebbe. L'esito resta
            // `ok` — il lavoro si riprende la notte dopo dalle più vecchie — ma il
            // fatto è scritto, ed è leggibile con una query su `app_log`.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'lotto-pieno',
                canale,
                n_candidature_lette: lette.length,
                n_candidature_scadute: nScadute,
                msg: `${JOB}: lotto al tetto di ${TETTO_LOTTO} righe, il giro successivo riprende dalle più vecchie`,
            })
        }

        // ── SENZA `cv_path` NON SI CANCELLA NIENTE ──
        //
        // Il difetto che questo blocco chiude, e che il file predicava di evitare
        // due schermate più su: se `cv_path` finisce fra le colonne assenti, la
        // seconda `select` la esclude, `r.cv_path` è `undefined`, `percorsi` è
        // vuoto, nessuna `remove()` parte — e senza questo `return` le righe si
        // cancellavano LO STESSO. Risultato: i curriculum restano nel bucket senza
        // più nessuna riga che li nomini, cioè testualmente «invisibili, non
        // cancellati — il modo peggiore di conservare un dato personale» del punto
        // 1 in testa a questo file.
        //
        // Vale ANCHE per il ripiego di `colonneMancanti`, che quando non riconosce
        // nessun nome rinuncia a tutte e tre le colonne: qualunque `42703`/`PGRST204`
        // che non sappiamo leggere finisce qui, e qui non si cancella. È lo stesso
        // verso di `rimuoviEVerifica`: «non so quali file questa riga nomina» vale
        // «li nomina», e su un'operazione irreversibile «non so» vale «non toccare».
        if (cvIgnoto) {
            esitoBattito = 'cv-path-ignoto'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_candidature_scadute: nScadute,
                ms: Date.now() - t0,
                msg:
                    `${JOB}: la colonna cv_path non esiste su questo database, quindi non si sa ` +
                    `quali curriculum ogni riga nomini: NESSUNA riga viene cancellata. Cancellarle ` +
                    `lascerebbe i file nell'archivio senza più nulla che li nomini`,
            })
            return NextResponse.json(
                { ok: false, motivo: esitoBattito, candidature: 0, candidature_scadute: nScadute },
                { status: 503 },
            )
        }

        // La candidatura resta legata al SUO curriculum fino alla fine: è ciò che
        // permette di trattenere una riga sola invece dell'intero lotto.
        const perCandidatura = scadute.map((r) => ({
            id: r.id,
            percorsi: typeof r.cv_path === 'string' && r.cv_path.trim() !== '' ? [r.cv_path.trim()] : [],
        }))
        const tuttiIPercorsi = [...new Set(perCandidatura.flatMap((c) => c.percorsi))]

        // ── PRIMA I FILE ──
        if (tuttiIPercorsi.length > 0) {
            esito = await rimuoviEVerifica(supabase, BUCKET_ALLEGATI, tuttiIPercorsi, JOB)
            if (esito.erroreRimozione) {
                // La chiamata è fallita: nessun file è uscito e non c'è niente da
                // verificare. Cancellare le righe adesso renderebbe i curriculum
                // irraggiungibili invece che cancellati. Si riprova il giro dopo.
                esitoBattito = 'file-non-rimossi'
                nTrattenute = perCandidatura.length
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    n_file: tuttiIPercorsi.length,
                    n_candidature_trattenute: nTrattenute,
                    ms: Date.now() - t0,
                    msg: `${JOB}: rimozione dei curriculum non riuscita, righe NON cancellate`,
                })
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'allegati-non-rimossi',
                        candidature: 0,
                        candidature_trattenute: nTrattenute,
                        file: tuttiIPercorsi.length,
                    },
                    { status: 500 },
                )
            }
        }

        // Un curriculum ancora nell'archivio — o che non si è potuto verificare —
        // trattiene la SUA candidatura, e soltanto quella.
        const daNonToccare = new Set(bloccanti(esito))
        nBloccanti = daNonToccare.size
        const chiudibili = perCandidatura.filter((c) => !c.percorsi.some((p) => daNonToccare.has(p)))
        nTrattenute = perCandidatura.length - chiudibili.length

        // ── POI LE RIGHE ──
        if (chiudibili.length > 0) {
            // `count: 'exact'` — e non è pignoleria. Senza, il numero che finisce
            // nel battito e nella risposta è quello delle righe che si INTENDEVA
            // cancellare: il file predica «si verifica lo STATO, non il conteggio»
            // per i file e poi, sulle righe, dava per buona la propria intenzione.
            const { error: erroreDelete, count } = await supabase
                .from('candidature_insegnanti')
                .delete({ count: 'exact' })
                .in('id', chiudibili.map((c) => c.id))
            if (erroreDelete) {
                esitoBattito = 'cancellazione-fallita'
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: esitoBattito,
                    canale,
                    error_code: codiceDi(erroreDelete),
                    n_candidature: chiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: curriculum rimossi ma righe NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            conteggioVerificato = typeof count === 'number'
            nCancellate = conteggioVerificato ? (count as number) : chiudibili.length
            if (conteggioVerificato && nCancellate !== chiudibili.length) {
                // `.in('id', …)` non può cancellare PIÙ righe di quante ne nomina:
                // lo scarto è sempre in difetto, e significa che quelle righe erano
                // già sparite fra la SELECT e la DELETE.
                //
                // ⚠️ NESSUN PERCORSO APPLICATIVO LE TOGLIE. Misurato: in tutto `src/`
                // esiste UN SOLO `.delete()` su `candidature_insegnanti`, ed è quello
                // qui sopra; il cockpit di segreteria (`admin/candidature-insegnanti`)
                // cambia lo STATO e non cancella. In produzione la tabella non ha
                // trigger e le sue tre chiavi esterne sono senza `ON DELETE CASCADE`,
                // quindi nemmeno il database la svuota per conto suo. Restano due
                // cause, entrambe fuori dal prodotto: una cancellazione fatta a mano
                // in SQL, o due giri di questo job sovrapposti.
                //
                // Resta `warn` e non `error`, ma per la ragione giusta: il fine di
                // questo job — quelle righe non ci sono più — è raggiunto comunque, e
                // chiamare «errore» una retention riuscita è la strada per far
                // spegnere l'allarme. I fallimenti veri di questo lotto (curriculum
                // rimossi e righe no, candidature trattenute) sono già `error` poco
                // sopra e poco sotto. Ciò che questo `warn` deve garantire è che il
                // numero dichiarato sia quello VERO e che lo scarto abbia un nome:
                // non essendoci più una causa benigna da citare, chi lo trova sa che
                // deve andare a cercare chi ha scritto SQL a mano.
                logEvento('cron', 'warn', {
                    operazione: JOB,
                    esito: 'conteggio-discorde',
                    canale,
                    n_candidature: nCancellate,
                    n_candidature_attese: chiudibili.length,
                    msg: `${JOB}: cancellate meno righe di quante ne erano state nominate; nessun percorso applicativo le cancella, quindi cercare una DELETE manuale o due giri sovrapposti. Si dichiara il numero vero`,
                })
            }
        }

        if (nTrattenute > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto.
            esitoBattito = 'candidature-trattenute'
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: esitoBattito,
                canale,
                n_candidature: nCancellate,
                n_candidature_trattenute: nTrattenute,
                n_file_bloccanti: nBloccanti,
                n_file_ancora_presenti: esito.ancoraPresenti.length,
                n_file_non_verificati: esito.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${nTrattenute} candidature NON cancellate, ${nBloccanti} curriculum ancora nell'archivio o non verificabili`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                    // risposta: chi legge il registro deve poter distinguere un archivio
                    // che non risponde da un file che non esce.
                    motivo: esito.ancoraPresenti.length > 0 ? 'allegati-non-rimossi' : 'verifica-non-riuscita',
                    candidature: nCancellate,
                    candidature_trattenute: nTrattenute,
                    file: esito.rimossi.length,
                    file_bloccanti: nBloccanti,
                },
                { status: 500 },
            )
        }

        // ── GLI ORFANI, dopo il lavoro sulle righe ──────────────────────────
        //
        // Sta QUI, in coda al percorso felice, e non prima: la conservazione
        // delle candidature scadute è una promessa scritta nel consenso, la
        // spazzata è manutenzione. Se il lotto principale ha trattenuto qualcosa
        // si esce prima e la spazzata salta un giro — che va benissimo: gira ogni
        // notte, e ciò che oggi è orfano lo sarà anche domani.
        //
        // Non lancia mai (ogni suo ramo cattura e riferisce), quindi non serve un
        // `try` attorno: un guasto della pulizia non può diventare un giro di
        // conservazione fallito.
        spazzata = await spazzaCurriculumOrfani(supabase, adesso)

        return NextResponse.json({
            ok: true,
            candidature: nCancellate,
            file: esito.rimossi.length,
            file_gia_assenti: esito.giaAssenti.length,
            // Il lotto tagliato si dichiara anche qui: chi lancia il giro a mano
            // deve sapere se richiamarlo, e non deve dedurlo da un conteggio.
            lotto_pieno: lottoPieno,
            mesi_senza_consenso: MESI_SENZA_CONSENSO,
            mesi_con_consenso: MESI_CON_CONSENSO,
            // Chi lancia il giro a mano deve poter vedere che cosa ha fatto la
            // pulizia, senza andarla a cercare nei log.
            orfani_esaminati: spazzata.esaminati,
            orfani_rimossi: spazzata.rimossi,
            orfani_esito: spazzata.esito,
            // Il troncamento si dichiara anche QUI, come `lotto_pieno` per le
            // righe: chi lancia il giro a mano deve sapere se richiamarlo, e non
            // deve dedurlo da un conteggio.
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
        // SEMPRE, anche a zero, anche quando tutto è fallito: è la riga che nella
        // versione SQL del gemello non veniva mai scritta.
        //
        // `esito: 'ok'` solo quando il giro ha davvero finito il lavoro, ed è
        // deliberato: `controlloBattitoCron` (`/api/health`) conta solo i battiti
        // con quell'esito, quindi un lavoro che fallisce ogni notte diventa
        // visibile come «job senza battito» oltre la finestra. L'esito risponde a
        // «è andata bene?», non a «di che cosa si occupa».
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: esitoBattito,
            canale,
            n_candidature: nCancellate,
            n_candidature_scadute: nScadute,
            n_candidature_trattenute: nTrattenute,
            n_file: esito.rimossi.length,
            n_file_gia_assenti: esito.giaAssenti.length,
            n_file_bloccanti: nBloccanti,
            mesi: MESI_SENZA_CONSENSO,
            mesi_con_consenso: MESI_CON_CONSENSO,
            consenso_ignoto: consensoIgnoto,
            cv_path_ignoto: cvIgnoto,
            lotto_pieno: lottoPieno,
            // La spazzata degli orfani, nello stesso battito: `orfani_esito` è
            // l'unico modo di sapere in SQL se quella pulizia è arrivata in fondo
            // o si è fermata su una lettura che non ha potuto fare.
            n_orfani_esaminati: spazzata.esaminati,
            n_orfani: spazzata.orfani,
            n_orfani_rimossi: spazzata.rimossi,
            orfani_esito: spazzata.esito,
            orfani_elenco_troncato: spazzata.troncato,
            // `false` non vuol dire «il conteggio è sbagliato»: vuol dire che
            // PostgREST non l'ha restituito e il numero qui accanto è l'intenzione,
            // non la misura. Distinguere le due cose è tutto il punto di questo file.
            conteggio_verificato: conteggioVerificato,
            ms: Date.now() - t0,
            msg: `${JOB}: ${nCancellate} candidature e ${esito.rimossi.length} curriculum oltre il termine`,
        })
    }
})
