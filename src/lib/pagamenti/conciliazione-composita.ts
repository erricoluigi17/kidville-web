// ─── Motore PURO della composizione di un bonifico (conciliazione composita F4) ──
//
// Un bonifico incassato non corrisponde quasi mai a una sola voce: una famiglia
// paga in un colpo solo la retta arretrata, la gita e la ricarica dei ticket
// mensa, magari per due figli in due sedi diverse. Questo modulo è l'aritmetica
// di quella ripartizione, e sta qui — non nella route, non nel componente —
// perché due implementazioni della quadratura sono due verdetti diversi sullo
// stesso bonifico, e quello che sbaglia lo scopre la famiglia.
//
// Nessun I/O e nessun Supabase: logica pura, condivisa fra la route e la UI, e
// senza una riga di React qui dentro. La catena però non è priva di React in
// assoluto, e dirlo tondo sarebbe falso: `aging.ts` — da cui arriva
// `residuoEffettivo` — importa `useTranslations` di `next-intl` per le proprie
// etichette. È già così per le 4 route che lo usano (misurato), e spezzare `aging`
// per far tornare una promessa d'intestazione sarebbe un rimedio peggiore del male.
// La quadratura definitiva resta comunque riverificata lato DB.
//
// Riusa (non riscrive): `round2`/`proponiAllocazione` da `transazioni-quadratura`
// e `residuoEffettivo` da `aging` — che è la definizione autoritativa di residuo.
//
// ⚠️ UN SOLO GATE. Per decidere se «Conferma» si può premere si chiama
// `puoConfermare(righe, importoMovimento)`, e nient'altro. Le altre funzioni
// servono a dire QUALE riga è sbagliata e perché, non a decidere: ricomporre il
// gate a mano è il modo documentato di riaprire i difetti già chiusi qui.
//
// ⚠️ Due limiti noti che NON si chiudono in questo file, e che è meglio sapere:
//  · sopra `Number.MAX_SAFE_INTEGER` il centesimo smette di esistere. Misurato:
//    una riga da `1e17 + 0,01` contro un movimento da `1e17` dà scarto 0, `quadra`
//    dice VERO e **anche `puoConfermare` dice VERO** — i due numeri sono lo stesso
//    double, il centesimo non è mai esistito. È il limite della virgola mobile,
//    non un difetto dell'aritmetica qui sopra, e non si aggira arrotondando
//    meglio: nemmeno il gate unico protegge da questo. Il tetto sull'importo va
//    messo nella `zod` della route (un bonifico scolastico sta in sei cifre), ed
//    è là che va spiegato perché — qui si può solo dichiararlo.
//  · `proponiAllocazioneSuVoci` con id ripetuti può SOTTO-riempire la capienza
//    (`[x da 100, x da 100]` con capienza 300 propone 100, non 300): ogni id si
//    consuma una volta sola, che è la direzione sicura — non si assegna mai al
//    bonifico più denaro di quanto ne porti. Ma la UI non deve presumere che una
//    proposta quadri da sé: quadra solo quando `puoConfermare` lo dice.

import { round2, proponiAllocazione, type VoceResiduo } from './transazioni-quadratura'
import { residuoEffettivo, type AgingPagamento } from './aging'

export { round2, proponiAllocazione }
export type { VoceResiduo }

// ─── Le tre specie di riga ───────────────────────────────────────────────────

export type SpecieRiga = 'esistente' | 'nuova' | 'ticket'

/** Voce di pagamento GIÀ a sistema: si incassa (in tutto o in parte) il suo residuo. */
export interface RigaEsistente {
    specie: 'esistente'
    pagamentoId: string
    alunnoId: string | null
    scuolaId: string | null
    /** Slug della categoria della voce (serve all'àncora: `retta` vince su tutto). */
    categoriaSlug?: string | null
    descrizione: string
    /** Residuo effettivo della voce — da `residuoEffettivo`, mai ricalcolato a mano. */
    residuo: number
    importo: number
}

/** Voce che NON esiste ancora: la si crea già saldata con questo bonifico. */
export interface RigaNuova {
    specie: 'nuova'
    alunnoId: string | null
    scuolaId: string | null
    categoriaId: string | null
    categoriaSlug?: string | null
    descrizione: string
    importo: number
}

/** Ricarica di ticket mensa: il totale è CALCOLATO da quantità × costo unitario. */
export interface RigaTicket {
    specie: 'ticket'
    alunnoId: string | null
    scuolaId: string | null
    quantita: number
    costoUnitario: number
}

export type RigaComposizione = RigaEsistente | RigaNuova | RigaTicket

/** Le righe che diventano una voce di pagamento (tutto tranne la ricarica ticket). */
export type RigaVoce = RigaEsistente | RigaNuova

/** Slug della categoria «retta»: lo stesso usato da `scadenze.ts` contro il DB. */
export const SLUG_RETTA = 'retta'

/**
 * Normalizza un numero che può arrivare da un campo di form: `Number('')` è `NaN`
 * e un `NaN` propagato farebbe sparire in silenzio il totale di tutta la
 * composizione. Un campo vuoto vale 0 — e uno 0 lo intercetta `violazioniRighe`.
 */
const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
}

/**
 * Arrotondamento al centesimo **che non può fabbricare un infinito**. `num()`
 * scarta `NaN` e `Infinity` in INGRESSO, e non basta: `round2` moltiplica per 100
 * PRIMA di dividere, quindi da un input perfettamente finito come `1e308` produce
 * `Infinity` (`Math.round(1e310) / 100`). Misurato con `round2` nudo: la riga da
 * 1e308 non generava NESSUNA violazione, il movimento da 1e308 nemmeno, e il gate
 * diceva SÌ — perché `Infinity === Infinity`. È la stessa specie del difetto che
 * ha fatto nascere `violazioniComposizione`: il motore risponde «sì» proprio dove
 * non sa niente, e a valle finirebbe un `Infinity` dentro una colonna `numeric`.
 * E `1e308` è JSON validissimo: arriva da un body, o da un `<input type="number">`
 * in cui qualcuno ha incollato qualcosa.
 *
 * Fuori scala vale 0, non «tanto»: ed è il verdetto giusto per un numero che
 * nessuno può aver inteso davvero — **a patto che quello 0 lo intercetti qualcuno**.
 * ⚠️ Fino al 2026-09-12 questa frase diceva «uno 0 lo intercettano
 * `importo_non_positivo` e `movimento_non_positivo`», ed era falsa su una delle tre
 * specie di riga: sul ramo TICKET la regola «importo > 0» era tolta apposta, quindi
 * lo 0 fuori scala era indistinguibile da uno 0 legittimo e nessun codice lo
 * nominava — misurato, `puoConfermare([nuova 100, ticket 1e200 × 1e200], 100)` =
 * **true**, contro `false` per la stessa composizione fatta di sole voci. Oggi le
 * tre specie sono coperte tutte: su una voce e sul movimento parlano
 * `importo_non_positivo` e `movimento_non_positivo`; su una ricarica ticket, dove il
 * totale è CALCOLATO, parlano `quantita_non_valida` (quantità fuori dalla scala
 * sicura), `costo_unitario_non_positivo` e — quando entrambi i campi sono
 * ineccepibili e a uscire di scala è il PRODOTTO — di nuovo `importo_non_positivo`.
 *
 * Sta QUI e non dentro `round2`: quello è condiviso con
 * la quadratura storica, e cambiarlo cambierebbe il comportamento di codice che
 * questo lavoro non collauda.
 *
 * ⚠️ `al2` NON rende sicura `quadra` da sola. Misurato dopo la correzione:
 * `quadra([riga da 1e308], 1e308)` è ancora VERO, perché entrambi i lati
 * diventano 0 — ed è giusto così, «0 quadra con 0». A dire NO è `puoConfermare`,
 * che guarda anche le due violazioni che `al2` fa scattare. Un'altra ragione per
 * cui il gate non si ricompone a mano.
 */
const al2 = (n: number): number => {
    const r = round2(n)
    return Number.isFinite(r) ? r : 0
}

const isVoce = (r: RigaComposizione): r is RigaVoce => r.specie !== 'ticket'

const vuoto = (v: string | null | undefined): boolean => !v || v.trim() === ''

/** Id della voce già a sistema, normalizzato: è la chiave con cui si raggruppa. */
const idVoce = (r: RigaEsistente): string => (r.pagamentoId ?? '').trim()

// ─── Importi ─────────────────────────────────────────────────────────────────

/**
 * Totale di una riga ticket. **Il totale è calcolato, mai digitato**: un totale
 * scritto a mano accanto a quantità e costo unitario è un terzo numero che può
 * smentire gli altri due, e il saldo mensa del bambino seguirebbe quello sbagliato.
 *
 * `al2` e non `round2`: `num()` protegge i due fattori separatamente, non il loro
 * PRODOTTO, e 1e200 × 1e200 è `Infinity` (misurato). Questa funzione è esportata:
 * è quella che un pannello chiama per mostrare «20 × 2,50 = 50,00 €» accanto ai due
 * campi, e con `round2` nudo mostrava «∞ €» a chi avesse incollato un numero assurdo
 * in un `<input type="number">`.
 */
export function totaleTicket(quantita: number, costoUnitario: number): number {
    return al2(num(quantita) * num(costoUnitario))
}

/**
 * Importo di una riga qualunque, al centesimo e **sempre finito**.
 *
 * ⚠️ Onestà sul ramo ticket: da quando `totaleTicket` arrotonda con `al2`, l'`al2`
 * qui attorno è **idempotente** su quel ramo, e togliendolo oggi nessun test diventa
 * rosso (misurato). Resta per due ragioni dichiarate, non per abitudine: la garanzia
 * di `importoRiga` («sempre finito») non deve dipendere dalla promessa di un'altra
 * funzione, e il ramo delle VOCI — `al2(num(riga.importo))` — ne ha bisogno davvero,
 * lì è l'unico strato e il test sulla riga da 1e308 lo dimostra rosso se sparisce.
 */
export function importoRiga(riga: RigaComposizione): number {
    if (riga.specie === 'ticket') return al2(totaleTicket(riga.quantita, riga.costoUnitario))
    return al2(num(riga.importo))
}

/**
 * Totale della composizione, al centesimo. Gli arrotondamenti in gioco sono DUE —
 * uno per riga dentro `importoRiga`, uno a ogni passo di questo ciclo — e fanno
 * due mestieri distinti.
 *
 * Il `round2` PER RIGA garantisce che ogni riga sia un importo vero al centesimo:
 * è il numero che la UI mostra accanto alla riga ed è il numero che finisce nel
 * database. Una riga da 33,333 € non esiste né sullo schermo né in una colonna a
 * due decimali, e nessuno deve poterla creare.
 *
 * L'arrotondamento del CICLO è `al2`, e NON `round2`, per una ragione misurata:
 * due righe da 1e306 sono **finite, valide e senza violazioni** — `al2` non le
 * azzera, `violazioniRighe` non ha niente da ridire — ma la loro SOMMA esce dalla
 * scala, e `round2` ne faceva un `Infinity`. Da lì `scartoQuadratura` rispondeva
 * **0,00 €** mentre `quadra` rispondeva **falso**: il motore si contraddiceva, e
 * questo totale è esportato, cioè è il numero che la UI mostra. Soglia misurata:
 * a 5e305 per riga il totale è ancora finito e lo scarto è vero; da 1e306 in su no.
 * Fuori scala vale 0, come ovunque in questo file. È lo stesso difetto che `al2`
 * chiude su `importoRiga`, `quadra` e `scartoQuadratura`: mancava proprio nel ciclo
 * che le alimenta tutte.
 *
 * Ed è anche difesa in profondità: copre in più il caso di un futuro chiamante che
 * passasse righe GREZZE, mai transitate da `importoRiga`.
 *
 * Misurato sul caso che conta — tre righe grezze da 33,333 contro un bonifico da
 * 100,00, dove la somma nuda fa 99,999:
 *   · con entrambi gli arrotondamenti            → 99,99  (non quadra: giusto)
 *   · togliendo SOLO quello per riga             → 99,99  (non quadra)
 *   · togliendo SOLO quello del ciclo            → 99,99  (non quadra)
 *   · togliendoli ENTRAMBI, uno solo in fondo    → 100,00 (quadra: e il centesimo
 *     di scarto sparisce in cassa senza che nessuna riga lo nomini)
 *
 * Cioè i due arrotondamenti sono ridondanti FRA LORO: a proteggere è che ce ne sia
 * almeno uno, e nessuno dei due è «quello che impedisce» il 100,00. Restano
 * entrambi, ciascuno per il proprio mestiere — il primo per l'esattezza di ogni
 * riga, il secondo per le righe che un giorno arrivassero da fuori.
 */
export function totaleComposizione(righe: RigaComposizione[]): number {
    let totale = 0
    for (const riga of righe) totale = al2(totale + importoRiga(riga))
    return totale
}

/**
 * Quadratura ESATTA al centesimo. Nessuna tolleranza oltre il centesimo: è una
 * decisione del titolare, e una tolleranza «piccola» è comunque denaro che
 * nessuno ha assegnato a nessuno.
 */
export function quadra(righe: RigaComposizione[], importoMovimento: number): boolean {
    return totaleComposizione(righe) === al2(num(importoMovimento))
}

/**
 * Scarto di quadratura, dal punto di vista delle RIGHE:
 *  · negativo → manca ancora tanto per coprire il bonifico;
 *  · positivo → le righe sforano il bonifico.
 * Serve a dirlo all'operatore con un numero, invece di un «non quadra» muto.
 *
 * ⚠️ Onestà sui due `al2` di questa riga, misurata il 2026-09-12 rifacendo le
 * mutazioni: presi UNO ALLA VOLTA sopravvivono entrambi — sostituendone uno con
 * `round2` la suite resta verde, perché l'altro raccoglie comunque l'infinito
 * (con un movimento da 1e308: l'interno lo azzera prima della sottrazione,
 * l'esterno azzera il `-Infinity` che ne uscirebbe). Sostituendoli ENTRAMBI la
 * suite diventa rossa. Sono cioè ridondanti FRA LORO e presidiati insieme, non
 * uno per uno: è la stessa struttura già dichiarata per i due arrotondamenti di
 * `totaleComposizione`, e vale la stessa conclusione — a proteggere è che ce ne
 * sia almeno uno. Restano tutt'e due, e la cosa sta scritta qui invece di essere
 * scoperta dal prossimo che muta una riga sola e la trova verde.
 */
export function scartoQuadratura(righe: RigaComposizione[], importoMovimento: number): number {
    return al2(totaleComposizione(righe) - al2(num(importoMovimento)))
}

// ─── Violazioni ──────────────────────────────────────────────────────────────

export type CodiceViolazione =
    | 'importo_non_positivo'
    | 'quantita_non_valida'
    | 'costo_unitario_negativo'
    /**
     * Costo unitario a ZERO su una ricarica ticket. Codice suo, separato da
     * `costo_unitario_negativo`, perché il rimedio è diverso: un costo negativo è
     * un refuso, uno zero è una ricarica in omaggio — che è una cosa legittima, ma
     * si fa da Mensa (`ricariche_mensa`), non da qui. I due non si sovrappongono
     * mai: sotto zero parla il primo, a zero il secondo.
     */
    | 'costo_unitario_non_positivo'
    | 'oltre_residuo'
    /** Più righe sulla STESSA voce che, sommate, ne superano il residuo. */
    | 'oltre_residuo_aggregato'
    | 'alunno_mancante'
    /** Riga senza sede: la sede del DOCUMENTO non si indovina (vedi `sediCoinvolte`). */
    | 'sede_mancante'
    | 'descrizione_vuota'
    | 'categoria_mancante'

export interface Violazione {
    /** Indice della riga che causa la violazione: la UI la evidenzia, il log la nomina. */
    indice: number
    /** Codice-enumerato, NON un testo da mostrare: il messaggio lo sceglie la UI. */
    codice: CodiceViolazione
}

/**
 * Guai che NON stanno su nessuna riga, ma sulla composizione nel suo insieme.
 * Sono un enumerato SEPARATO apposta: `Violazione.indice` deve restare un indice
 * di riga vero — un `-1` di comodo manderebbe la UI a evidenziare una riga che
 * non esiste, e il log a nominarla.
 */
export type CodiceViolazioneComposizione = 'composizione_vuota' | 'movimento_non_positivo'

/**
 * Le voci (per `pagamentoId`) a cui la composizione, PRESA NEL SUO INSIEME, chiede
 * più residuo di quanto ne abbiano. Il tetto `oltre_residuo` si valuta riga per
 * riga, e riga per riga due righe da 100 € su una voce che di residuo ne ha 100
 * sono **entrambe ineccepibili**: misurato prima di questa regola, quella coppia
 * contro un movimento da 200 € dava `violazioniRighe` = `[]` e
 * `puoConfermare` = **VERO**. Cioè il gate autorizzava a incassare 200 € su 100 di
 * residuo: 100 € assegnati a nulla, che `residuoEffettivo` tronca poi a 0 **in
 * silenzio**. Non servono numeri astronomici, sono importi di tutti i giorni.
 *
 * E l'elenco con id ripetuti non è teoria: nasce concatenando le voci aperte di due
 * fratelli, o da un ritento — è lo stesso caso per cui `proponiAllocazioneSuVoci`
 * consuma ogni id una volta sola. Quel rischio era già chiuso nella funzione che
 * PROPONE e restava aperto in quella che DECIDE.
 *
 * Tre scelte, e il motivo di ciascuna:
 *  · **codice separato** da `oltre_residuo`: riusarlo direbbe all'operatrice
 *    «importo oltre il residuo» su una riga da 100 € con residuo 100 €, cioè un
 *    messaggio che la riga stessa smentisce. Qui il difetto non è l'importo di una
 *    riga: è che la voce compare due volte.
 *  · **su TUTTE le righe di quella voce**, non solo su quella che fa traboccare:
 *    l'operatrice deve vedere la coppia. Evidenziandone una sola le si direbbe di
 *    cancellare quella riga, senza farle capire che il problema è la ripetizione —
 *    e nel caso dei due fratelli la riga "di troppo" non è né la prima né l'ultima
 *    in senso proprio, sono la stessa voce arrivata due volte.
 *  · **il tetto è il residuo PIÙ PICCOLO** fra quelli dichiarati dalle righe di
 *    quell'id: se due letture della stessa voce divergono (una stantia), la
 *    direzione sicura è non assegnare mai più di quanto la lettura più prudente
 *    regga.
 *
 * Un `pagamentoId` vuoto non identifica nessuna voce: quelle righe non si
 * raggruppano, perché accusare di doppio incasso due righe che non si sa nemmeno
 * se siano la stessa voce sarebbe un falso positivo che blocca un incasso vero.
 *
 * `al2` e non `round2`, sulla somma E sul tetto, perché i due infiniti mentirebbero
 * in due direzioni opposte: una SOMMA `Infinity` starebbe sopra qualunque tetto e
 * accuserebbe sempre; un TETTO `Infinity` starebbe sopra qualunque somma e non
 * accuserebbe mai. Con `al2` entrambi valgono 0 quando escono di scala, ed è la
 * direzione sicura in tutt'e due i casi — misurato: due righe da 1e306 su un residuo
 * da 100 € portano `oltre_residuo` su entrambe (il difetto è già nominato riga per
 * riga, l'aggregata non serve), e due righe da 100 € su un residuo dichiarato 1e308
 * portano `oltre_residuo_aggregato` su entrambe, perché un residuo fuori scala non è
 * un residuo.
 */
function vociOltreIlResiduoAggregato(righe: RigaComposizione[]): Set<string> {
    const per = new Map<string, { somma: number; tetto: number; quante: number }>()
    for (const riga of righe) {
        if (riga.specie !== 'esistente') continue
        const id = idVoce(riga)
        if (id === '') continue
        const tetto = al2(num(riga.residuo))
        const gruppo = per.get(id)
        if (gruppo) {
            gruppo.somma = al2(gruppo.somma + importoRiga(riga))
            gruppo.tetto = Math.min(gruppo.tetto, tetto)
            gruppo.quante += 1
        } else {
            per.set(id, { somma: importoRiga(riga), tetto, quante: 1 })
        }
    }
    const oltre = new Set<string>()
    // `quante > 1`: con una riga sola il verdetto è già di `oltre_residuo`, e i due
    // codici resterebbero ridondanti sulla stessa riga senza dire niente di nuovo.
    for (const [id, g] of per) if (g.quante > 1 && g.somma > g.tetto) oltre.add(id)
    return oltre
}

/**
 * Tutti i motivi per cui la composizione non si può confermare, riga per riga.
 * Ritorna l'elenco COMPLETO (non si ferma al primo): l'operatore deve vedere in
 * un colpo solo tutto ciò che deve correggere.
 *
 * ⚠️ NOTA SUL TICKET, riscritta il 2026-09-12 perché quella di prima era falsa e
 * costava un 500. Diceva: «un costo unitario 0 è ammesso (ricarica in omaggio),
 * quindi per i ticket non vale la regola importo > 0 — … gli stessi vincoli del
 * check storico su `pagamenti/ticket`». Il rimando era alla route sbagliata:
 * `RigaTicket` **non** alimenta `POST /api/pagamenti/ticket` (che scrive un
 * `importo` in `ricariche_mensa`), alimenta il blocco `voci_ticket` della RPC di
 * questa branch. E quella RPC rifiuta lo zero — in
 * `20260912180100_transazione_voci_nuove.sql` si cerca, con un `grep -F`:
 * `IF v_costo IS NULL OR v_costo <= 0`
 * (citato per CONTENUTO e non per numero di riga: qui c'era `:486-491`, e
 * ventuno righe di prosa aggiunte a quel file in un'altra fetta l'hanno spostato
 * a 511 senza che questo commento se ne accorgesse — un numero di riga in un
 * file che qualcun altro sta scrivendo scade nel giro di un commit). E il
 * rifiuto è questo, anch'esso su una riga sola perché si possa incollare:
 * `RAISE EXCEPTION 'voce ticket #%: costo_unitario deve essere > 0'`
 * — ⚠️ un'àncora mandata a capo NON è un'àncora: `grep -F` le cerca a righe, e
 * spezzate valevano `0`. È la stessa lezione dell'apostrofo tipografico del §7,
 * con un ritorno a capo al posto suo. Per una ragione strutturale, non per
 * gusto: a costo zero la riga vale
 * `0.00` e l'INSERT in `incassi` viola `incassi_importo_check CHECK (importo <> 0)`,
 * SQLSTATE 23514. Misurato prima della correzione: `violazioniRighe([ticket 20 × 0])`
 * = `[]` e il gate diceva SÌ, cioè «Conferma» verde e un 500 addosso all'operatrice.
 *
 * Decisione del titolare: **in conciliazione il ticket si PAGA**. Un bonifico che
 * paga zero euro di ticket non ha senso in una schermata che deve quadrare
 * all'esatto; la ricarica in omaggio resta possibile da `ricariche_mensa`, che non
 * passa da `incassi`. Quindi per un ticket valgono: quantità intera positiva **e
 * dentro la scala sicura**, costo unitario **> 0**, e un totale che non sia 0.
 */
export function violazioniRighe(righe: RigaComposizione[]): Violazione[] {
    const out: Violazione[] = []
    const vociInEccesso = vociOltreIlResiduoAggregato(righe)
    righe.forEach((riga, indice) => {
        const aggiungi = (codice: CodiceViolazione) => out.push({ indice, codice })

        if (riga.specie === 'ticket') {
            const q = num(riga.quantita)
            const costo = num(riga.costoUnitario)
            // `isSafeInteger` e non `isInteger`: 1e200 e 1e308 sono interi per
            // `isInteger`, e la loro riga non produceva NESSUNA violazione mentre
            // `al2` ne azzerava il totale — misurato, `puoConfermare([nuova 100,
            // ticket 1e200 × 1e200], 100)` = **true**. Sopra 2**53 «un ticket in più»
            // non è più un ticket in più: due interi vicini sono lo stesso double.
            const qOk = Number.isSafeInteger(q) && q > 0
            if (!qOk) aggiungi('quantita_non_valida')
            // Quantità e costo sono due campi indipendenti e si giudicano separati:
            // `violazioniRighe` promette l'elenco COMPLETO, e chi sbaglia tutt'e due
            // deve vederli tutt'e due. In catena stanno invece i tre verdetti che si
            // escludono a vicenda — costo sotto zero, costo a zero, prodotto a zero:
            // dire «il totale è 0» a chi ha già letto «il costo dev'essere > 0» non
            // aggiunge niente, ed è la stessa ragione del `quante > 1` del tetto
            // aggregato, poco sopra.
            if (costo < 0) aggiungi('costo_unitario_negativo')
            else if (costo <= 0) aggiungi('costo_unitario_non_positivo')
            // Ultima rete, e non è teorica: qui i due campi sono entrambi ineccepibili
            // e il PRODOTTO vale comunque 0. Succede per eccesso — `20 × 1e308` è
            // `Infinity`, che `al2` porta a 0 — e per difetto, `1 × 0,001` che al
            // centesimo è `0,00`. In tutt'e due i casi la RPC calcola `round(q × c, 2)`
            // = `0.00` e sbatte sullo stesso `incassi_importo_check`. Misurato con la
            // sola correzione sulla quantità: `violazioniRighe([ticket 20 × 1e308])`
            // = `[]` e `puoConfermare([nuova 100, ticket 20 × 1e308], 100)` = **true**,
            // cioè il difetto chiuso da una porta e lasciato aperto dall'altra.
            else if (qOk && totaleTicket(q, costo) <= 0) aggiungi('importo_non_positivo')
        } else {
            if (importoRiga(riga) <= 0) aggiungi('importo_non_positivo')
            if (riga.specie === 'esistente') {
                // `round2` e non `al2` — a differenza del tetto aggregato di
                // `vociOltreIlResiduoAggregato`, poco sopra — e la differenza si vede.
                // Un residuo fuori scala rende questo tetto `Infinity`, e un tetto
                // infinito non blocca niente. Dalla strada vera non apre una finestra:
                // il residuo arriva da `rigaDaVoceAperta`, che lo azzera con `al2`, e la
                // riga viene fermata dall'altro capo — misurato,
                // `[{ indice: 0, codice: 'importo_non_positivo' }]`, mai `oltre_residuo`.
                // ⚠️ Il limite, misurato e dichiarato: una riga costruita a mano con
                // `residuo: 1e308` e `importo: 100` passa di qui indisturbata (una sola
                // riga → `[]`; due righe così le ferma il tetto aggregato, che con `al2`
                // legge quel residuo per quello che è, cioè 0). Non è la finestra che
                // sembra: il `residuo` di riga NON è autorevole — lo dichiara il client,
                // e un client che mente può scrivere 999.999 senza bisogno di 1e308. Chi
                // decide davvero è la RPC, che riverifica il residuo sul database.
                if (importoRiga(riga) > round2(num(riga.residuo))) aggiungi('oltre_residuo')
                // Emesso QUI e non in coda all'elenco: le violazioni restano ordinate
                // per indice di riga, che è l'ordine in cui la UI le evidenzia.
                if (vociInEccesso.has(idVoce(riga))) aggiungi('oltre_residuo_aggregato')
            }
        }

        if (vuoto(riga.alunnoId)) aggiungi('alunno_mancante')
        // ⚠️ La sede della riga NON è quella che decide dove finiscono i soldi: la sede
        // autorevole di ogni voce la deriva il server dall'alunno (`alunni.scuola_id`,
        // letto dalla RPC in `20260912180100_transazione_voci_nuove.sql`, che ignora
        // apposta lo `scuola_id` del payload — «la sede si deriva dall'alunno»).
        // Questa `scuolaId` serve alla UI: propone la sede del DOCUMENTO e alimenta
        // `sediCoinvolte`, cioè dice all'operatrice se il bonifico è cross-sede. È per
        // questo che dev'esserci, non perché sia lei ad archiviare la voce — e nessuno
        // ci costruisca sopra la convinzione contraria.
        // Pretenderla non blocca nessun percorso legittimo: le righe esistenti la
        // portano dal DB, le nuove dal contesto che conosce già il plesso del bambino.
        if (vuoto(riga.scuolaId)) aggiungi('sede_mancante')

        if (isVoce(riga)) {
            if (vuoto(riga.descrizione)) aggiungi('descrizione_vuota')
            if (riga.specie === 'nuova' && vuoto(riga.categoriaId)) aggiungi('categoria_mancante')
        }
    })
    return out
}

/**
 * Le due condizioni che rendono impossibile confermare una composizione anche
 * quando ogni singola riga è ineccepibile — e che sta qui, nel motore, per lo
 * stesso motivo della quadratura: il gate naturale del pannello è
 * `violazioniRighe(r).length === 0 && quadra(r, importo)`, e quel gate **da solo
 * dice SÌ al caso peggiore**. Con zero righe il totale è 0; se anche l'importo
 * del movimento è 0 — o è `NaN`/assente, che `num()` porta a 0 — allora `0 === 0`
 * e la composizione «quadra» senza aver assegnato un centesimo a nessuno. È il
 * peggior default possibile: risponde «sì» proprio quando non sa niente.
 *
 * Ritorna l'elenco COMPLETO come `violazioniRighe`: se mancano entrambe le cose,
 * l'operatore le deve vedere insieme, non una alla volta.
 */
export function violazioniComposizione(
    righe: RigaComposizione[],
    importoMovimento: number,
): CodiceViolazioneComposizione[] {
    const out: CodiceViolazioneComposizione[] = []
    if (righe.length === 0) out.push('composizione_vuota')
    // `al2(num(...))` e non `> 0` sul grezzo: un movimento da 0,004 € non è un
    // incasso, è rumore — e al centesimo vale 0, come lo vede tutta la quadratura.
    // `al2` e non `round2`: 1e308 è finito, passa da `num()` indisturbato, e
    // `round2` ne farebbe un `Infinity` che quadra con sé stesso. Fuori scala è 0,
    // cioè non positivo, cioè proprio quello che va detto.
    if (al2(num(importoMovimento)) <= 0) out.push('movimento_non_positivo')
    return out
}

/**
 * **L'unico modo corretto di decidere se il pulsante «Conferma» è attivo.** Vero
 * soltanto se nessuna riga è in violazione, nessuna regola d'insieme è violata, e
 * il totale quadra col movimento al centesimo.
 *
 * Esiste perché il gate naturale — `violazioniRighe(r).length === 0 && quadra(r, x)`
 * — **compila**. `violazioniComposizione` ritorna un enumerato DIVERSO da
 * `Violazione`, quindi dimenticarla non è un errore di tipo: passa `tsc`, passa
 * ogni lock, e su zero righe contro un movimento a 0 (o `NaN`, o assente) dice SÌ.
 * Una protezione che regge solo finché ogni chiamante si ricorda di comporre tre
 * pezzi nell'ordine giusto è già rotta: qui è una funzione sola, e chiamarla è
 * più corto che sbagliarla.
 *
 * Le tre funzioni restano esportate, ma per un altro mestiere: dire QUALE riga è
 * sbagliata e perché — evidenziazione, messaggi all'operatore, log. Chi **decide**
 * usa questa.
 */
export function puoConfermare(righe: RigaComposizione[], importoMovimento: number): boolean {
    return (
        violazioniRighe(righe).length === 0 &&
        violazioniComposizione(righe, importoMovimento).length === 0 &&
        quadra(righe, importoMovimento)
    )
}

// ─── Àncora della fattura ────────────────────────────────────────────────────

export type MotivoAncora = 'retta' | 'maggiore'

export interface Ancora {
    indice: number
    motivo: MotivoAncora
}

/**
 * Quale riga «ancora» la fattura (intestazione, causale, competenza). Regola
 * decisa dal titolare:
 *  1. la voce con categoria `retta` — anche quando NON è la maggiore: è la riga
 *     che dà senso fiscale al documento (detrazione 730);
 *  2. in mancanza, la riga di importo maggiore; a parità, la prima;
 *  3. una ricarica ticket non ancora mai la fattura se esiste una voce, nemmeno
 *     se vale di più: il ticket è un anticipo, non una prestazione fatturata.
 *     Se però ci sono SOLE ricariche, ancora la maggiore fra quelle.
 * `motivo` è un enumerato per log e test, non un testo da mostrare.
 */
export function proponiAncora(righe: RigaComposizione[]): Ancora | null {
    if (righe.length === 0) return null

    const indiciVoci = righe.map((r, i) => (isVoce(r) ? i : -1)).filter((i) => i >= 0)

    for (const i of indiciVoci) {
        const slug = (righe[i] as RigaVoce).categoriaSlug
        if (slug && slug.trim().toLowerCase() === SLUG_RETTA) return { indice: i, motivo: 'retta' }
    }

    // Senza voci restano solo ricariche: lì la maggiore va bene.
    const candidati = indiciVoci.length > 0 ? indiciVoci : righe.map((_, i) => i)
    let migliore = candidati[0]
    for (const i of candidati) {
        // `>` stretto: a parità vince la prima incontrata.
        if (importoRiga(righe[i]) > importoRiga(righe[migliore])) migliore = i
    }
    return { indice: migliore, motivo: 'maggiore' }
}

// ─── Sedi ────────────────────────────────────────────────────────────────────

/**
 * Uuid distinti delle sedi toccate dalla composizione, ordinati. Più di uno
 * significa bonifico cross-sede: la sede del documento non si può indovinare
 * (`resolveScuolaScrittura` risponde 400 proprio per questo) e va scelta
 * dall'operatore.
 *
 * Le righe senza sede non entrano nell'elenco, e la loro assenza è un problema
 * **della riga**: `violazioniRighe` emette `sede_mancante`. Fino a questa correzione
 * la frase qui sopra era falsa e lo si poteva misurare —
 * `puoConfermare([riga senza sede], 100)` rispondeva **true**, e per l'assenza di
 * sede non esisteva alcun codice: non era un problema di nessuno. Tacere qui e
 * tacere là significava lasciar passare una composizione di cui il pannello non
 * sapeva dire in che plesso stesse.
 */
export function sediCoinvolte(righe: RigaComposizione[]): string[] {
    const sedi = new Set<string>()
    for (const riga of righe) {
        const s = riga.scuolaId?.trim()
        if (s) sedi.add(s)
    }
    return [...sedi].sort()
}

// ─── Riuso: allocazione automatica e residuo effettivo ───────────────────────

export interface AllocazioneVoce {
    id: string
    importo: number
}

/**
 * Avvolge `proponiAllocazione` (unica implementazione dell'allocazione, già
 * testata) adattandone la forma: la funzione originale produce `{ id → stringa }`
 * perché pensata per i campi di un form, qui servono importi NUMERICI e
 * nell'ordine delle voci, perché il chiamante li somma e li quadra.
 *
 * Ogni `id` si consuma UNA volta sola. La mappa è indicizzata per `id`: due voci
 * con lo stesso id vi collassano in una, e ri-emetterla a ogni occorrenza
 * dell'array raddoppierebbe l'importo allocato, sforando la capienza — cioè
 * assegnando al bonifico più denaro di quanto ne porti. Un elenco con id ripetuti
 * non è teoria: nasce concatenando le voci aperte di due fratelli, o da un ritento.
 *
 * Lo stesso caso, dal lato del GATE, lo chiude `vociOltreIlResiduoAggregato`: qui si
 * evita di PROPORRE un doppio incasso, là si vieta di CONFERMARLO se l'operatrice
 * compone le righe a mano. Erano due buchi della stessa forma, e per un po' solo
 * questo è stato tappato.
 */
export function proponiAllocazioneSuVoci(voci: VoceResiduo[], capienza: number): AllocazioneVoce[] {
    const mappa = proponiAllocazione(voci, capienza)
    const visti = new Set<string>()
    const out: AllocazioneVoce[] = []
    for (const v of voci) {
        if (mappa[v.id] === undefined || visti.has(v.id)) continue
        visti.add(v.id)
        // `al2` e non `round2`: con una voce da 1e308 di residuo, `proponiAllocazione`
        // propone la stringa «Infinity» e `round2` la ripassava tale e quale — misurato
        // `{ id: 'a', importo: Infinity }`. Su valori normali `al2` e `round2` danno lo
        // stesso numero (`al2` ricade su 0 solo quando `round2` non è finito).
        out.push({ id: v.id, importo: al2(Number(mappa[v.id])) })
    }
    return out
}

/** Una voce aperta come arriva dal DB (`pagamenti` + categoria in join). */
export interface VoceApertaDb extends AgingPagamento {
    id: string
    alunno_id?: string | null
    scuola_id?: string | null
    descrizione?: string | null
    payment_categories?: { slug?: string | null } | null
}

/**
 * Adattatore DB → riga «esistente». Esiste perché il `residuo` della riga deve
 * venire da `residuoEffettivo` (importo − sconto − incassato, **mai negativo**)
 * e non essere ricalcolato a mano da ogni chiamante: un sovraincasso con residuo
 * negativo diventerebbe un credito che compensa in silenzio un'altra voce.
 * `importo` esplicito assente → si propone l'intero residuo.
 *
 * Tutt'e due i numeri passano da `al2`, e non da `round2`: con un importo a
 * database da 1e308 questa funzione restituiva `residuo: Infinity` e
 * `importo: Infinity` (misurato), cioè faceva uscire dal motore, dalla strada vera,
 * proprio ciò che `al2` esiste per impedire.
 *
 * ⚠️ E COSA SUCCEDE ALLORA, misurato riga per riga — perché il passaggio di consegne
 * di questa fetta lo aveva dichiarato SBAGLIATO. La frase tramandata era «`num()` lo
 * azzera e **`oltre_residuo` scatta**». Non scatta: `violazioniRighe` su quella riga
 * risponde **`[{ indice: 0, codice: 'importo_non_positivo' }]`**, perché azzerandosi
 * il residuo si azzera anche il TETTO, e `0 > 0` è falso. Il gate ferma comunque, ma
 * per l'altra ragione — ed è la ragione giusta, perché quel numero non è «oltre il
 * residuo»: non è un importo. Il test lo blocca, così la frase non torna a essere
 * un'affermazione non verificata.
 */
export function rigaDaVoceAperta(voce: VoceApertaDb, importo?: number): RigaEsistente {
    const residuo = al2(residuoEffettivo(voce))
    return {
        specie: 'esistente',
        pagamentoId: voce.id,
        alunnoId: voce.alunno_id ?? null,
        scuolaId: voce.scuola_id ?? null,
        categoriaSlug: voce.payment_categories?.slug ?? null,
        descrizione: voce.descrizione ?? '',
        residuo,
        // `al2` anche qui: un importo ESPLICITO da 1e308 usciva `Infinity` (misurato),
        // e questa è la terza porta della stessa funzione, non citata dal rilievo.
        importo: importo === undefined ? residuo : al2(num(importo)),
    }
}
