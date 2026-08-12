import { dataCivile } from '@/i18n/config'
import { PERSONALE_LIMITI } from '@/lib/forms/personale-template'

/**
 * L'ALLARME DI SCADENZA DEL DOCUMENTO D'IDENTITÀ — la parte che DECIDE.
 *
 * Qui non si legge il database, non si manda niente e non si guarda l'orologio:
 * si risponde a due domande sole, e sono le uniche due che possono sbagliarsi in
 * silenzio.
 *
 *   1. «quanti giorni mancano, e quale soglia è stata raggiunta?»
 *   2. «questa soglia è già stata annunciata, o va annunciata adesso?»
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DUE REGOLE COSTRUTTIVE, E NESSUNA DELLE DUE È STILISTICA
 *
 * ─── 1. «OGGI» È SEMPRE UN PARAMETRO, MAI `new Date()` QUI DENTRO ───────────
 *
 * È la disciplina che `src/lib/pagamenti/aging.ts` applica già a ogni sua
 * funzione (`statoEffettivo(p, oggi)`, `bucketDiPagamento(p, oggi)`), e la
 * ragione è che senza di essa i confini NON SI POSSONO PROVARE: un test su «89
 * giorni» dovrebbe costruire una data relativa all'istante in cui gira, cioè
 * misurare l'orologio invece della regola. Con `oggi` iniettato, «il 90 scatta a
 * 90 e non a 89» è un'asserzione su due stringhe.
 *
 * ─── 2. LE DATE SI CONTANO SU STRINGHE `YYYY-MM-DD`, MAI CON I `Date` ───────
 *
 * `(Date.parse(a) - Date.parse(b)) / 86400000` sembra la via ovvia ed è il
 * difetto che `__tests__/architecture/date-senza-fuso.test.ts` sorveglia da
 * un'altra porta: `new Date('2026-10-25')` è mezzanotte UTC, e in `Europe/Rome`
 * quella notte ci sono 25 ore (fine dell'ora legale, ultima domenica d'ottobre).
 * Una differenza calcolata in millisecondi attraversa quel cambio e restituisce
 * `30.041…`, che arrotondato in un verso o nell'altro fa scattare la soglia «30
 * giorni» un giorno prima o un giorno dopo **a seconda del mese**. Il prodotto
 * vive in `Europe/Rome` e la scadenza di un documento è una data civile, non un
 * istante: fra il 2026-08-11 e il 2026-11-09 ci sono 90 giorni qualunque cosa
 * facciano gli orologi.
 *
 * Perciò il conto passa da `giorniDaEpoca()`, che converte una data civile nel
 * suo numero d'ordine sul calendario gregoriano con aritmetica intera pura —
 * nessun `Date`, nessun fuso, nessun cambio d'ora da attraversare.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE SOGLIE NON SI RIBATTONO QUI
 *
 * Vengono da `PERSONALE_LIMITI` (`@/lib/forms/personale-template`), che è lo
 * stesso posto da cui il modulo pubblico prende i termini che PROMETTE
 * all'interessata. Due elenchi indipendenti per la stessa cosa divergono al
 * primo cambio, e a divergere sarebbe la frequenza con cui una persona viene
 * avvisata di un obbligo che la riguarda.
 */

/**
 * I PREAVVISI, in giorni, dal più lontano al più vicino. Sono
 * `PERSONALE_LIMITI.soglieAvviso` senza lo `0` finale, che non è un preavviso
 * ma la constatazione del fatto compiuto (vedi `SOGLIA_SCADUTO`).
 *
 * Filtrato invece che ribattuto: una soglia aggiunta in `PERSONALE_LIMITI`
 * arriva fin qui da sola, e un elenco ribattuto a mano no.
 *
 * ⚠️ MA NON ARRIVA FINO IN FONDO, ED È LA COSA IMPORTANTE DI QUESTO COMMENTO.
 * Questo file diceva che un preavviso nuovo «entrerebbe in vigore da solo».
 * Non è vero, ed è FALSO IN UN MODO CHE SI PAGA DI NOTTE: il valore annunciato
 * finisce in `anagrafica_personale.scadenza_soglia_avvisata`, che è
 * `smallint check (… in (90,60,30,7,0))` — misurato in
 * `supabase/migrations/20260811205643_anagrafica_personale.sql`, righe 242-243.
 *
 * Con un `120` qui e il CHECK invariato, la catena è questa:
 *
 *   1. `SOGLIA_MAX` diventa 120, la finestra della query si allarga, gli avvisi
 *      partono — cioè la parte visibile funziona e sembra tutto a posto;
 *   2. l'UPDATE del passo 6 della route viola il vincolo (`23514`) e lo stato
 *      NON viene scritto;
 *   3. senza stato, `vaAvvisato(120, null, …)` risponde `true` la notte dopo, e
 *      quella dopo ancora: notifica in-app all'interessata e alla segreteria
 *      OGNI NOTTE, cioè esattamente la raffica che le due colonne esistono per
 *      impedire, più un 500 a ogni giro.
 *
 * Perciò: aggiungere una soglia costa DUE file, questo e una migrazione che
 * allarga il CHECK. Il lock `__tests__/lib/documenti-scadenza.test.ts` («ogni
 * soglia dichiarata è ammessa anche dal DDL») lega le due liste e diventa rosso
 * al gate se si dimentica la seconda — che è l'unico modo perché la dimenticanza
 * si veda prima delle 5:47 in produzione.
 */
export const SOGLIE = PERSONALE_LIMITI.soglieAvviso.filter((s) => s > 0) as readonly number[]

/**
 * LA SOGLIA DEL DOCUMENTO GIÀ SCADUTO.
 *
 * Non è «il preavviso più corto»: è uno stato diverso. Un preavviso si dà una
 * volta e finisce lì; un documento scaduto è una non conformità APERTA — la
 * persona sta lavorando senza un documento valido, e il datore non può
 * identificarla per gli adempimenti obbligatori. Perciò è l'unica soglia che si
 * ripete (vedi `vaAvvisato`), ed è l'unica che vale anche a distanza di mesi.
 */
export const SOGLIA_SCADUTO = 0

/** Il preavviso più lontano: la finestra che il cron interroga ogni notte. */
export const SOGLIA_MAX = Math.max(...SOGLIE)

/** Una soglia annunciabile: uno dei preavvisi, oppure «già scaduto». */
export type Soglia = number

const GIORNI_MESE = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const FORMA_YMD = /^(\d{4})-(\d{2})-(\d{2})$/

function bisestile(anno: number): boolean {
    return (anno % 4 === 0 && anno % 100 !== 0) || anno % 400 === 0
}

/**
 * IL NUMERO D'ORDINE DI UNA DATA CIVILE sul calendario gregoriano (giorni dal
 * 1970-01-01), con aritmetica intera e nessun `Date`.
 *
 * È l'algoritmo `days_from_civil` di Howard Hinnant, quello su cui è costruita
 * `<chrono>` del C++20: sposta l'inizio dell'anno a marzo, così il 29 febbraio
 * cade in fondo e le correzioni bisestili diventano tre divisioni intere.
 * Esatto su tutto l'intervallo che a questo prodotto può servire, e — la sola
 * proprietà che conta qui — **indipendente dal fuso del processo**: su Vercel
 * (UTC) e sul portatile di chi sviluppa (Europe/Rome) restituisce lo stesso
 * numero, che è ciò che una differenza fra `Date` non garantisce.
 *
 * `NaN` se la data non esiste: `2026-02-30` e `2026-13-01` non sono «quasi il
 * 1° marzo», sono un dato sbagliato, e chi legge deve poterlo distinguere da
 * una scadenza vera. `new Date('2026-02-30')` invece scivola al 2 marzo in
 * silenzio, ed è esattamente il genere di scivolata che qui non si vuole:
 * significherebbe avvisare qualcuno con due giorni di ritardo per un refuso di
 * battitura che nessuno vede più.
 */
export function giorniDaEpoca(ymd: string): number {
    const m = FORMA_YMD.exec(ymd ?? '')
    if (!m) return NaN
    const anno = Number(m[1])
    const mese = Number(m[2])
    const giorno = Number(m[3])
    if (mese < 1 || mese > 12) return NaN
    const massimo = mese === 2 && bisestile(anno) ? 29 : GIORNI_MESE[mese - 1]
    if (giorno < 1 || giorno > massimo) return NaN

    // Anno che comincia il 1° marzo: il giorno bisestile finisce ultimo.
    const y = anno - (mese <= 2 ? 1 : 0)
    const era = Math.floor(y / 400)
    const annoNellEra = y - era * 400 // [0, 399]
    const giornoNellAnno = Math.floor((153 * (mese + (mese > 2 ? -3 : 9)) + 2) / 5) + giorno - 1
    const giornoNellEra =
        annoNellEra * 365 +
        Math.floor(annoNellEra / 4) -
        Math.floor(annoNellEra / 100) +
        giornoNellAnno
    // 719468 = giorni fra 0000-03-01 e 1970-01-01.
    return era * 146097 + giornoNellEra - 719468
}

/**
 * Una data civile `n` giorni dopo un'altra, sempre su stringhe.
 *
 * Serve al cron per costruire il limite superiore della query (`oggi + 90`)
 * senza passare da un `Date`: la stessa ragione di `giorniDaEpoca`, e con
 * l'aggiunta che quel limite viaggia dritto dentro una clausola SQL su una
 * colonna `date` — dove un giorno di scarto è una riga che non viene letta.
 *
 * `''` su data non valida: una stringa vuota in una clausola PostgREST produce
 * un errore visibile, mentre un `Invalid Date` silenzioso produrrebbe una
 * finestra sbagliata di cui non si accorgerebbe nessuno.
 */
export function aggiungiGiorni(ymd: string, n: number): string {
    const base = giorniDaEpoca(ymd)
    if (Number.isNaN(base)) return ''
    return dataDaGiorni(base + n)
}

/** L'inversa di `giorniDaEpoca` (`civil_from_days` di Hinnant). */
function dataDaGiorni(giorni: number): string {
    const z = giorni + 719468
    const era = Math.floor(z / 146097)
    const giornoNellEra = z - era * 146097 // [0, 146096]
    const annoNellEra = Math.floor(
        (giornoNellEra - Math.floor(giornoNellEra / 1460) + Math.floor(giornoNellEra / 36524) - Math.floor(giornoNellEra / 146096)) / 365,
    ) // [0, 399]
    const y = annoNellEra + era * 400
    const giornoNellAnno =
        giornoNellEra - (365 * annoNellEra + Math.floor(annoNellEra / 4) - Math.floor(annoNellEra / 100))
    const mp = Math.floor((5 * giornoNellAnno + 2) / 153) // [0, 11], 0 = marzo
    const giorno = giornoNellAnno - Math.floor((153 * mp + 2) / 5) + 1
    const mese = mp + (mp < 10 ? 3 : -9)
    const anno = y + (mese <= 2 ? 1 : 0)
    return `${String(anno).padStart(4, '0')}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`
}

/**
 * I giorni che mancano alla scadenza. Negativo = documento già scaduto, `0` =
 * scade oggi, `NaN` = una delle due date non esiste.
 *
 * Entrambe le date sono CIVILI e italiane: `oggi` lo produce `dataCivile()`
 * (`@/i18n/config`, `Europe/Rome`), `scadenza` è una colonna `date` di Postgres
 * — che non ha fuso per definizione. Confrontarle come istanti sarebbe un
 * errore di categoria, oltre che di calendario.
 */
export function giorniResidui(scadenzaYMD: string, oggiYMD: string): number {
    const scadenza = giorniDaEpoca(scadenzaYMD)
    const oggi = giorniDaEpoca(oggiYMD)
    if (Number.isNaN(scadenza) || Number.isNaN(oggi)) return NaN
    return scadenza - oggi
}

/**
 * La soglia raggiunta da un documento a cui mancano `giorni`, oppure `null` se
 * non c'è ancora niente da dire.
 *
 * I confini, per esteso, perché sono la sola cosa che questa funzione decide:
 *
 *   giorni  <  0   → `SOGLIA_SCADUTO` (0)   il documento NON è più valido
 *   giorni ===  0  → 7                      scade oggi: è ancora valido oggi
 *   giorni <=  7   → 7
 *   giorni <= 30   → 30
 *   giorni <= 60   → 60
 *   giorni <= 90   → 90
 *   giorni >  90   → null                   troppo presto per dire qualcosa
 *
 * ⚠️ `giorni === 0` NON è «scaduto», ed è il confine più facile da sbagliare.
 * Un documento d'identità è valido FINO AL giorno di scadenza compreso: dire a
 * una persona che il suo documento è scaduto mentre è ancora buono la manderebbe
 * in Comune un giorno prima del necessario, e — più seriamente — renderebbe
 * `SOGLIA_SCADUTO` una constatazione falsa in un fascicolo del personale.
 *
 * Le soglie NON sono ribattute: si scorre `SOGLIE` dalla più stretta alla più
 * larga, così un preavviso aggiunto in `PERSONALE_LIMITI` non obbliga a toccare
 * QUESTA funzione — ma non basta lui: serve anche la migrazione che allarga il
 * CHECK di `scadenza_soglia_avvisata`, vedi l'avvertenza su `SOGLIE`.
 */
export function sogliaRaggiunta(giorni: number): Soglia | null {
    if (!Number.isFinite(giorni)) return null
    if (giorni < 0) return SOGLIA_SCADUTO
    // Crescente: la PRIMA soglia che contiene `giorni` è la più stretta, cioè
    // quella che descrive davvero l'urgenza. Con l'ordine opposto un documento a
    // 3 giorni dalla scadenza verrebbe annunciato come «mancano 90 giorni».
    const crescenti = [...SOGLIE].sort((a, b) => a - b)
    for (const soglia of crescenti) if (giorni <= soglia) return soglia
    return null
}

/**
 * CHE COSA DIRE, ADESSO, A CHI STA GUARDANDO UNA DATA DI SCADENZA.
 *
 * `sogliaRaggiunta` risponde a «quale preavviso va ANNUNCIATO stanotte», che è la
 * domanda del cron; questa risponde a «che cosa mostro accanto al campo mentre la
 * persona lo sta compilando», che è un'altra cosa. Stanno nello stesso file e sopra
 * le STESSE due funzioni pure, così un confine spostato si sposta per tutt'e due.
 *
 * ─── PERCHÉ NON SI RIUSA `sogliaRaggiunta` E BASTA ──────────────────────────
 *
 * Perché quella collassa tre situazioni in due numeri, ed è giusto che lo faccia
 * per il cron: a `giorni === 0` risponde `7` (il documento è valido FINO AL giorno
 * di scadenza compreso), e a `giorni < 0` risponde `0` — che è anche il numero di
 * giorni residui di un documento che scade oggi. Un riquadro che leggesse la
 * soglia direbbe «scade fra 7 giorni» a chi ha appena scritto la data di oggi, e
 * non saprebbe distinguere «scade oggi» da «è scaduto». Qui gli stati sono quattro
 * e portano con sé i giorni veri, segno compreso.
 *
 * ─── I QUATTRO STATI ────────────────────────────────────────────────────────
 *
 *   `ignoto`      la data non c'è o non esiste sul calendario (campo vuoto,
 *                 digitazione a metà, `31/02`). NON si segnala qui: il campo
 *                 obbligatorio ha già il suo messaggio da `validateField`, e un
 *                 secondo riquadro rosso sotto direbbe che i problemi sono due.
 *   `scaduto`     `giorni < 0`, e `giorni` è NEGATIVO: il documento non è più
 *                 valido. ⚠️ Non blocca nessun invio, mai — vedi
 *                 `personale-template.ts`: chi ha il documento scaduto è
 *                 esattamente la persona per cui quel modulo esiste, e respingerla
 *                 lascerebbe la Segreteria senza nemmeno il nome.
 *   `in-scadenza` `0 <= giorni <= SOGLIA_MAX`: dentro la finestra del preavviso
 *                 più lontano, che è lo stesso numero che il cron interroga ogni
 *                 notte. Scrivere «90» qui sarebbe una seconda finestra, che
 *                 diverge alla prima modifica — e a divergere sarebbe ciò che una
 *                 persona LEGGE rispetto a ciò per cui verrà avvisata.
 *   `valido`      oltre la finestra: NIENTE da dire. Un pannello che segnala tutto
 *                 non segnala niente, e una carta d'identità dura dieci anni.
 *
 * `oggi` è un parametro e non `new Date()`: vedi la regola 1 in testa al file, e il
 * lock di forma che la sorveglia.
 */
export type StatoScadenza =
    | { stato: 'ignoto' }
    | { stato: 'scaduto'; giorni: number }
    | { stato: 'in-scadenza'; giorni: number }
    | { stato: 'valido'; giorni: number }

export function statoScadenza(
    scadenzaYMD: string | null | undefined,
    oggiYMD: string,
): StatoScadenza {
    const giorni = giorniResidui(typeof scadenzaYMD === 'string' ? scadenzaYMD : '', oggiYMD)
    if (!Number.isFinite(giorni)) return { stato: 'ignoto' }
    if (giorni < 0) return { stato: 'scaduto', giorni }
    if (giorni <= SOGLIA_MAX) return { stato: 'in-scadenza', giorni }
    return { stato: 'valido', giorni }
}

/**
 * L'IDEMPOTENZA — la regola che decide se questa notte si manda qualcosa.
 *
 * Lo stato vive su due colonne di `anagrafica_personale`
 * (`scadenza_soglia_avvisata`, `scadenza_avvisata_il`) e un trigger le azzera
 * quando `document_expiry` cambia: quella logica **non si replica qui**, e
 * questa funzione non ne sa niente — riceve i due valori come sono.
 *
 * Si avvisa in TRE casi, e in nessun altro:
 *
 *  1. `ultimaSoglia == null` — non è mai stato detto niente su questo documento
 *     (o il documento è stato rinnovato e il trigger ha riaperto il conto).
 *
 *  2. `soglia < ultimaSoglia` — la soglia SCENDE. È la sola direzione ammessa:
 *     90 poi 60 poi 30 poi 7 poi 0, ognuna una volta sola. Una soglia che SALE
 *     (`soglia > ultimaSoglia`) significa uno stato incoerente — nessun percorso
 *     applicativo la produce — e in quel caso si tace: ripetere «mancano 90
 *     giorni» a chi ha già ricevuto «mancano 30» non informa, disinforma.
 *
 *  3. `soglia === SOGLIA_SCADUTO` e l'ultimo invio è più vecchio di
 *     `PERSONALE_LIMITI.giorniRisollecitoScaduto` giorni. È l'unica ripetizione
 *     ammessa, e la ragione è scritta su `SOGLIA_SCADUTO`: la non conformità
 *     resta aperta finché il documento non viene rinnovato, quindi un solo
 *     avviso «il documento è scaduto» e poi il silenzio per sempre sarebbe un
 *     allarme che si spegne da solo. Il periodo è settimanale e non quotidiano
 *     per la ragione opposta, ed è scritta nella migrazione che ha creato le due
 *     colonne: «un allarme quotidiano si impara a ignorare».
 *
 * ⚠️ ULTIMO INVIO ILLEGGIBILE O ASSENTE, con `ultimaSoglia === 0`: si avvisa.
 * È la combinazione che nessun percorso applicativo produce (le due colonne si
 * scrivono e si azzerano insieme), quindi esiste solo dopo una scrittura fatta a
 * mano in SQL. Fra le due scelte possibili — tacere per sempre su un documento
 * scaduto, o mandare un avviso in più — si sceglie l'avviso: si autoripara al
 * primo giro (il campo viene riscritto subito dopo l'invio) e non può quindi
 * diventare la raffica quotidiana che questa funzione esiste per impedire.
 *
 * @param soglia         la soglia raggiunta ADESSO (da `sogliaRaggiunta`)
 * @param ultimaSoglia   `anagrafica_personale.scadenza_soglia_avvisata`
 * @param ultimoInvioISO `anagrafica_personale.scadenza_avvisata_il`
 * @param adessoISO      l'istante del giro, iniettato: vedi la regola 1 in testa
 */
export function vaAvvisato(
    soglia: Soglia,
    ultimaSoglia: number | null | undefined,
    ultimoInvioISO: string | null | undefined,
    adessoISO: string,
): boolean {
    if (ultimaSoglia === null || ultimaSoglia === undefined) return true
    if (soglia < ultimaSoglia) return true
    if (soglia !== SOGLIA_SCADUTO) return false

    // Da qui in giù: documento scaduto, e lo si era già detto. Si risollecita.
    if (ultimaSoglia !== SOGLIA_SCADUTO) return false
    return giorniDaUltimoInvio(ultimoInvioISO, adessoISO) >= PERSONALE_LIMITI.giorniRisollecitoScaduto
}

/**
 * IL TETTO DEI RISOLLECITI VIA EMAIL su un documento già scaduto.
 *
 * ─── PERCHÉ ESISTE (rilievo del revisore, 2026-08-12) ───────────────────────
 *
 * `vaAvvisato` fa ripartire l'avviso ogni `giorniRisollecitoScaduto` giorni
 * finché il documento non viene rinnovato o `cessato_il` valorizzato, e NON HA
 * UN TERMINE. Sul canale in-app va bene: la notifica resta nel centro notifiche
 * e la non conformità deve restare visibile finché è aperta. Sull'EMAIL no, ed è
 * il caso reale che nessun test formale vede: una persona che per mesi non
 * riesce a rinnovare il documento — oppure un rapporto chiuso senza che nessuno
 * abbia scritto `cessato_il` — produce **un'email a settimana a lei e a ogni
 * membro della segreteria della sede, per sempre**. A quel punto la segreteria
 * smette di leggere anche l'avviso dei 7 giorni, che è quello che serve davvero:
 * è la stessa dinamica che la migrazione di queste colonne nomina («un allarme
 * quotidiano si impara a ignorare»), alla cadenza di una settimana invece che di
 * un giorno.
 *
 * OTTO risolleciti a cadenza settimanale ≈ **due mesi** dal PRIMO ANNUNCIO — non
 * dalla scadenza, ed è la correzione del 2026-08-12 (vedi `inizioSerieScaduto`):
 * per chi entra nel sistema con il documento già scaduto le due date non sono la
 * stessa, e ancorare il tetto alla seconda gli faceva saltare la prima email. Due
 * mesi sono più del tempo che serve a ottenere un appuntamento in Comune per una
 * carta d'identità, che è il vincolo pratico che questo tetto deve superare senza
 * mordere sul caso normale.
 *
 * ⚠️ IL TETTO VALE SOLO PER L'EMAIL. La notifica in-app continua a partire a ogni
 * risollecito, il battito continua a contare quella persona in `n_scaduti`, e il
 * tipo di notifica resta spegnibile dal pannello Impostazioni: l'allarme non si
 * spegne da solo — smette di occupare la casella di posta di tutta la segreteria.
 *
 * (Il commento diceva «`n_scaduti` continua a contarla OGNI NOTTE», ed era falso:
 * `nScaduti` si incrementa dentro il ciclo degli avvisi, cioè solo nelle notti in
 * cui `vaAvvisato` dice di sì — una ogni `giorniRisollecitoScaduto`, non una al
 * giorno. Chi leggesse il battito aspettandosi un conteggio quotidiano vedrebbe
 * `n_scaduti: 0` sei notti su sette e lo scambierebbe per un allarme spento.)
 *
 * NON sta in `PERSONALE_LIMITI` di proposito: quel blocco è il CONTRATTO del
 * modulo pubblico — i termini che la pagina promette a chi compila (conservazione,
 * soglie di preavviso, cadenza del risollecito). Su quale canale l'avviso viaggia
 * dopo due mesi non è una promessa fatta all'interessata: è una scelta di
 * osservabilità interna, e vive dove vive la decisione.
 */
export const MAX_RISOLLECITI_EMAIL = 8

/**
 * DA QUANDO COMINCIA LA SERIE DEI RISOLLECITI, in giorni dall'epoca.
 *
 * ⚠️ QUESTA FUNZIONE È LA CORREZIONE DEL DIFETTO PIÙ GRAVE DI QUESTO MODULO
 * (rilievo del revisore, 2026-08-12, MISURATO eseguendo la route vera).
 *
 * Prima la serie cominciava dalla SCADENZA e basta: `floor(giorni_scaduti / 7)`.
 * È corretto per chi invecchia dentro il sistema e falso per chi ci ENTRA già
 * scaduto — cioè per la sola popolazione che questo modulo dichiara di esistere
 * per servire (`personale-template.ts:210-212`: «chi ha il documento scaduto è
 * esattamente la persona per cui questo modulo esiste»). Con un'anagrafica creata
 * oggi e una carta d'identità scaduta da 215 giorni il contatore nasceva a 30,
 * cioè GIÀ ESAURITO: misurato `notifiche=2, email=[], email_oltre_tetto=1`, con la
 * riga di `warn` che dichiarava «l'email non riparte» mentre non era mai partita.
 * Il confine misurato sulla funzione pura: a 62 giorni dalla scadenza la posta
 * partiva, a 63 no — anche alla PRIMISSIMA volta.
 *
 * Il fatto che rende il vecchio conto sbagliato è uno solo: **la serie non può
 * essere cominciata prima che la riga esistesse**. Perciò l'origine è la più
 * TARDA fra due date:
 *
 *   · il giorno dopo la scadenza (`scadenza + 1`), che è il primo in cui il
 *     documento è davvero scaduto — `sogliaRaggiunta` risponde `0` da `giorni < 0`;
 *   · il giorno civile in cui l'anagrafica è nata (`creata_il`), perché prima di
 *     quello nessun risollecito poteva essere partito: non c'era niente da cui
 *     farlo partire.
 *
 * `creata_il` illeggibile o assente ⇒ si torna alla sola scadenza. È il verso
 * conservativo giusto perché il caso «entra già scaduta» resta comunque coperto
 * dal primo ramo di `emailRisollecitoDovuta`, che non guarda nessuna data.
 */
function inizioSerieScaduto(scadenzaYMD: string, creataISO: string | null | undefined): number {
    const scadenza = giorniDaEpoca(scadenzaYMD)
    if (Number.isNaN(scadenza)) return NaN
    const primoGiornoScaduto = scadenza + 1
    const nascitaRiga = dataCivileDaISO(creataISO)
    if (nascitaRiga === null) return primoGiornoScaduto
    return Math.max(primoGiornoScaduto, nascitaRiga)
}

/**
 * A quale risollecito siamo: `0` = il primo annuncio («il documento è scaduto»),
 * `1` = il primo risollecito, e così via.
 *
 * Si DERIVA dalle date — nessuna colonna nuova, nessuna migrazione su una tabella
 * già in produzione — ma dalle date GIUSTE: vedi `inizioSerieScaduto`, che è ciò
 * che distingue «scaduto da tanto» da «sollecitato tante volte». Le due cose
 * coincidono solo per chi invecchia dentro il sistema, e questo modulo esiste
 * anche per chi ci entra dall'altra parte.
 *
 * `0` su una data illeggibile: il verso giusto su un allarme è l'email in più.
 */
export function numeroRisollecito(
    scadenzaYMD: string,
    creataISO: string | null | undefined,
    oggiYMD: string,
): number {
    const oggi = giorniDaEpoca(oggiYMD)
    const inizio = inizioSerieScaduto(scadenzaYMD, creataISO)
    if (Number.isNaN(oggi) || Number.isNaN(inizio)) return 0
    return Math.max(0, Math.floor((oggi - inizio) / PERSONALE_LIMITI.giorniRisollecitoScaduto))
}

/**
 * Se l'avviso di questa soglia merita ancora un'EMAIL, oltre alla notifica.
 *
 * TRE risposte, in quest'ordine, e la seconda è quella che il revisore ha
 * dovuto chiedere due volte:
 *
 *  1. un PREAVVISO (90/60/30/7) si manda una volta sola per definizione — la
 *     monotonia di `vaAvvisato` lo garantisce — quindi non c'è niente da limitare;
 *
 *  2. il PRIMO ANNUNCIO dello stato «scaduto» — `ultimaSoglia` diversa da
 *     `SOGLIA_SCADUTO`, cioè `null` (mai detto niente, o documento appena
 *     cambiato: il trigger azzera) oppure un preavviso — manda SEMPRE l'email,
 *     qualunque cosa dicano le date. Un tetto sui RISOLLECITI che sopprime il
 *     PRIMO annuncio non è un tetto: è un silenzio. E senza quella prima email la
 *     segreteria non sa che una persona in servizio è priva di documento valido —
 *     senza il quale UNILAV, libro unico e denunce INPS/INAIL non si eseguono;
 *
 *  3. solo un RISOLLECITO vero (`ultimaSoglia === SOGLIA_SCADUTO`: lo scaduto era
 *     già stato annunciato) si conta contro `MAX_RISOLLECITI_EMAIL`.
 *
 * ⚠️ IL TETTO È ANCORATO ALLO STATO, NON ALL'ANZIANITÀ DELLA SCADENZA. Il punto 2
 * legge `scadenza_soglia_avvisata`, cioè quello che è stato DETTO, non quanto è
 * vecchia la data — che è l'inversione da cui nasceva il difetto. L'argomento in
 * oggetto invece che posizionale non è stile: qui viaggiano insieme due date
 * `YYYY-MM-DD` e un istante ISO, e scambiare `scadenzaYMD` con `oggiYMD` in una
 * chiamata posizionale darebbe un numero plausibile e sbagliato — che è
 * esattamente la classe di guasto che questo modulo esiste per non avere.
 */
export function emailRisollecitoDovuta(stato: {
    /** La soglia raggiunta ADESSO (da `sogliaRaggiunta`). */
    soglia: Soglia
    /** `anagrafica_personale.scadenza_soglia_avvisata`: ciò che è già stato detto. */
    ultimaSoglia: number | null | undefined
    /** `anagrafica_personale.document_expiry`. */
    scadenzaYMD: string
    /** `anagrafica_personale.creata_il`: la serie non comincia prima della riga. */
    creataISO?: string | null
    /** Il giorno civile italiano del giro, iniettato: vedi la regola 1 in testa. */
    oggiYMD: string
}): boolean {
    if (stato.soglia !== SOGLIA_SCADUTO) return true
    if (stato.ultimaSoglia !== SOGLIA_SCADUTO) return true
    return numeroRisollecito(stato.scadenzaYMD, stato.creataISO, stato.oggiYMD) <= MAX_RISOLLECITI_EMAIL
}

/**
 * Quanti giorni CIVILI separano l'ultimo invio dall'istante corrente.
 *
 * ─── PERCHÉ SU GIORNI CIVILI E NON SU MILLISECONDI ──────────────────────────
 *
 * `adesso - ultimoInvio >= 7 * 86_400_000` sembra equivalente e non lo è, per un
 * motivo pratico: il cron parte a un'ora fissa, quindi la differenza fra due
 * esecuzioni è di sette giorni MENO i secondi di jitter dell'esecuzione. Un
 * confronto sui millisecondi manca il bersaglio per pochi secondi e il
 * risollecito slitta al giorno dopo — e da lì in poi la cadenza diventa di otto
 * giorni, poi di nove: un promemoria settimanale che si allontana da solo. Sui
 * giorni civili (`Europe/Rome`, gli stessi con cui si conta tutto il resto di
 * questo modulo) il settimo giorno è il settimo giorno, a qualunque ora giri.
 *
 * `Number.POSITIVE_INFINITY` quando l'istante manca o non si legge: vedi
 * l'avvertenza in `vaAvvisato`, il verso scelto è «si avvisa».
 */
function giorniDaUltimoInvio(ultimoInvioISO: string | null | undefined, adessoISO: string): number {
    const ultimo = dataCivileDaISO(ultimoInvioISO)
    const adesso = dataCivileDaISO(adessoISO)
    if (ultimo === null) return Number.POSITIVE_INFINITY
    // `adesso` illeggibile è un guasto del chiamante, non un dato mancante: non
    // deve produrre una raffica. Si tace e lo si vedrà nel battito (zero avvisi).
    if (adesso === null) return Number.NEGATIVE_INFINITY
    return adesso - ultimo
}

/**
 * Il numero d'ordine del giorno civile ITALIANO di un istante ISO.
 *
 * Passa da `dataCivile` (`@/i18n/config`), che è la funzione del repo per
 * «quale giorno era in `Europe/Rome`», e non da `iso.slice(0, 10)`, che darebbe
 * il giorno UTC: fra mezzanotte e le due italiane sono due giorni diversi, ed è
 * la misura già pagata qui il 2026-08-01 alle 01:08 (un incasso vero sparito da
 * un KPI perché il server contava in UTC).
 *
 * Un istante illeggibile torna `null` invece di lanciare: questo modulo lo
 * chiama un lavoro notturno, e una colonna malformata non deve fermare il giro
 * per tutte le altre persone.
 */
function dataCivileDaISO(iso: string | null | undefined): number | null {
    if (typeof iso !== 'string' || iso.trim() === '') return null
    const istante = new Date(iso)
    if (Number.isNaN(istante.getTime())) return null
    const n = giorniDaEpoca(dataCivile(istante))
    return Number.isNaN(n) ? null : n
}
