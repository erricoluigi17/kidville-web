/**
 * Sezionale di fatturazione del minore: «Asilo» o «FPR».
 *
 * Funzioni PURE (nessun I/O, nessun log, NESSUN OROLOGIO). Il log è di chi chiama, perché
 * qui non c'è un identificativo di pratica da correlare: tutto ciò che è interessante esce
 * dalla funzione come booleano, e il chiamante lo registra insieme all'`alunno_id`. Da
 * loggare mai il codice fiscale né la data di nascita: sono dati di minori.
 *
 * ⚠️ «NESSUN OROLOGIO» È UNA PROMESSA CHE FINO AL 2026-08-10 QUESTO FILE NON MANTENEVA.
 * `sezionalePerMinore` chiamava `dataNascitaDaCodiceFiscale(cf)` senza il parametro `oggi`,
 * cioè leggeva `new Date()` per sciogliere il secolo del codice fiscale. Misurato con
 * orologio finto, stesso codice e stesso anno scolastico: emessa il 10/08/2026 usciva
 * `FPR`, riemessa il 20/12/2026 usciva `Asilo` — perché un `26T15` (15 dicembre '26) ad
 * agosto è ancora futuro e ripiegava sul 1926, mentre a dicembre era passato. Una fattura
 * scartata dallo SDI e rifatta due mesi dopo cambiava serie da sola, senza che si alzasse
 * una sola bandiera. Adesso il secolo si scioglie contro la **fine dell'anno scolastico che
 * si sta fatturando** (`finePlausibile`): un dato del documento, non del calendario di chi
 * preme il bottone. Vedi `dataNascitaDaCodiceFiscale(cf, oggi)`.
 *
 * LA REGOLA (dai dati reali di fatturazione della cooperativa):
 *   il bambino che compie 3 anni ENTRO il 30 aprile dell'anno scolastico va su **FPR**;
 *   chi li compie DOPO resta su **Asilo**. Il 30 aprile esatto conta come «entro».
 *
 * PERCHÉ NON SI INDOVINA MAI. La serie fiscale è parte del numero di fattura: sbagliarla
 * significa un numero doppio o un buco nella numerazione di un sezionale, cioè una
 * rettifica verso lo SDI. Se non c'è né codice fiscale né data di nascita, questa
 * funzione **lancia**: chi chiama deve bloccare l'emissione, non scegliere una serie a caso.
 *
 * ⚠️ «ASSENTE», «ILLEGGIBILE» E «IMPOSSIBILE» SONO TRE COSE DIVERSE, e fino al 2026-08-10
 * questo modulo ne distingueva solo due. L'esito di `{ codiceFiscale: 'NON VALIDO' }` era
 * byte per byte identico a quello di `{ codiceFiscale: null }`: un codice fiscale
 * spazzatura attraversava l'emissione **muto**, e nel frattempo finiva verbatim nella
 * descrizione della riga di fattura tramite il segnaposto `{codice_fiscale}` — cioè
 * nell'unico posto dove il minore viene identificato e da cui dipende la detrazione del
 * genitore. Non è un caso di scuola: MISURATO in produzione il 2026-08-10, su 32 alunni
 * 14 hanno un codice fiscale valorizzato e **solo 3 di forma valida** (la colonna è un
 * `char(16)`, che accetta qualunque cosa). Per questo l'esito porta
 * `codiceFiscaleIlleggibile` e `dataNascitaIlleggibile`: chi chiama DEVE loggarli.
 *
 * La terza — «impossibile» — è arrivata dopo, ed è il caso del **codice fiscale del
 * genitore incollato nel campo del bambino**: `…85T10…` è di forma perfetta, si legge
 * benissimo, e dice 1985. Prima produceva una serie fiscale con tutte le bandiere a
 * `false` e la fattura partiva senza che nessuno avesse niente da loggare. Adesso una data
 * che un alunno non può avere (vedi `ETA_MASSIMA_ALUNNO`) NON è una fonte: alza
 * `codiceFiscaleImplausibile` / `dataNascitaImplausibile`, e se resta l'unica fonte si
 * lancia come per il campo mancante.
 */

import { dataNascitaDaCodiceFiscale } from '@/lib/fiscale/codice-fiscale'

/** Le due serie di numerazione realmente in uso. */
export type Sezionale = 'Asilo' | 'FPR'

/** Da dove è stata presa la data di nascita usata per decidere. */
export type FonteDataNascita = 'cf' | 'data_nascita'

export interface EsitoSezionale {
  sezionale: Sezionale
  fonte: FonteDataNascita
  /**
   * `true` quando il codice fiscale e l'anagrafica dicono due date diverse.
   * Richiede che ENTRAMBE le fonti siano utilizzabili: se una delle due non lo è, non
   * c'è confronto possibile e il segnale da guardare è quello dell'illeggibilità o
   * dell'impossibilità.
   */
  discordanza: boolean
  /**
   * `true` quando un codice fiscale C'ERA ma non si è potuto leggere (forma sbagliata,
   * mese inesistente, giorno fuori scala, data che non sta sul calendario).
   *
   * Distinto da «assente» apposta: assente è un'anagrafica incompleta, illeggibile è un
   * dato SBAGLIATO che qualcuno ha digitato e che nessuno sta correggendo — e che dalla
   * causale finisce stampato su un documento fiscale irreversibile.
   */
  codiceFiscaleIlleggibile: boolean
  /** `true` quando una data di nascita C'ERA ma non si è potuta leggere (es. «30/04/2024»). */
  dataNascitaIlleggibile: boolean
  /**
   * `true` quando il codice fiscale si legge benissimo ma dice una data che un alunno di
   * quell'anno scolastico non può avere: il caso reale è il **codice del genitore**
   * incollato nel campo del bambino. Non è «illeggibile» — la forma è giusta — e proprio
   * per questo prima passava senza che si alzasse niente.
   */
  codiceFiscaleImplausibile: boolean
  /** Come sopra, per `alunni.data_nascita`: una data reale, ma impossibile per un alunno. */
  dataNascitaImplausibile: boolean
}

export interface IngressoSezionale {
  /** Codice fiscale del minore. Può mancare, essere illeggibile o dire una data impossibile. */
  codiceFiscale?: string | null
  /**
   * Data di nascita da anagrafica. Accetta sia la stringa `YYYY-MM-DD` che arriva da
   * PostgREST sia una `Date`; `new Date('2024-04-30')` (mezzanotte UTC) è gestita
   * esplicitamente e non slitta al giorno prima — vedi `aDataCalendario`.
   * Passare la stringa quando c'è resta la strada più corta e più difficile da sbagliare.
   */
  dataNascita?: Date | string | null
  /** Anno d'apertura dell'anno scolastico: 2026 sta per «2026/2027». */
  annoScolastico: number
  /**
   * `true` quando l'anno scolastico qui sopra NON è stato dichiarato da nessuno ma
   * ricavato dalla data del documento **in agosto**, cioè nell'unico mese in cui la
   * risposta cambia a seconda di quale regola si guarda (vedi `annoScolasticoDiCompetenza`
   * → `ambiguo`). In quel caso la serie si emette solo se è la STESSA su entrambi gli anni
   * candidati; altrimenti si lancia, perché una serie fiscale non si tira a sorte.
   */
  annoScolasticoAmbiguo?: boolean
}

/**
 * L'anno scolastico che decide la serie non si è potuto stabilire, e i due candidati
 * porterebbero il bambino su serie DIVERSE.
 *
 * Ha una classe propria perché chi chiama deve poterlo distinguere dall'anagrafica
 * incompleta: la riparazione è un'altra (compilare «periodo di competenza» sul pagamento,
 * non completare la scheda del bambino) e il messaggio all'utente pure.
 */
export class ErroreSerieAmbigua extends Error {
  constructor(messaggio: string) {
    super(messaggio)
    this.name = 'ErroreSerieAmbigua'
  }
}

/** Aprile, indice 3 nei mesi di `Date`. */
const MESE_APRILE = 3
/** Ultimo giorno utile per compiere i 3 anni e passare su FPR. */
const GIORNO_LIMITE = 30
/** Quanti anni deve compiere il bambino entro il limite. */
const ETA_SOGLIA = 3
/**
 * Primo mese del nuovo anno scolastico ai fini della FATTURAZIONE: settembre.
 *
 * ⚠️ DIVERGENZA DA `@/lib/anno-scolastico`, DECISA il 2026-08-10 e non più «da decidere».
 * `annoScolasticoCorrente()` fa partire l'anno da AGOSTO perché risponde a un'altra
 * domanda — *in quale anno scolastico sta operando la scuola oggi* — e ad agosto la scuola
 * sta già iscrivendo per settembre. Qui la domanda è *a quale anno scolastico appartiene
 * il documento che sto emettendo*, e una fattura emessa ad agosto salda quasi sempre
 * arretrati dell'anno che si è appena chiuso: a settembre non c'è ancora stato un giorno
 * di scuola da fatturare. Due domande diverse, due confini diversi, scritti tutti e due in
 * `docs/fatturazione/tracciato-di-riferimento.md`.
 *
 * ⚠️ E LA DIVERGENZA HA UN COSTO CHE NON RESTA PIÙ MUTO. In agosto — e solo in agosto — le
 * due regole rispondono anni diversi, quindi il RIPIEGO sulla data del documento
 * (`fonte: 'data_documento'`, cioè 71 pagamenti su 98 in produzione) è indecidibile.
 * `annoScolasticoDiCompetenza` lo marca `ambiguo`, e `sezionalePerMinore` con
 * `annoScolasticoAmbiguo: true` **rifiuta di scegliere** se i due anni candidati portano
 * il bambino su serie diverse. Non blocca l'intero agosto: blocca esattamente i bambini
 * per cui la differenza esiste — la coorte a cavallo del 30 aprile.
 */
const MESE_INIZIO_ANNO_SCOLASTICO = 9
/**
 * L'unico mese in cui il ripiego sulla data del documento è indecidibile: AGOSTO, il mese
 * che sta fra il confine di `annoScolasticoCorrente()` (1° agosto) e quello di questo
 * modulo (1° settembre).
 */
const MESE_RIPIEGO_AMBIGUO = MESE_INIZIO_ANNO_SCOLASTICO - 1
/**
 * Nessun alunno di questa scuola può avere più di 18 anni all'apertura dell'anno
 * scolastico. Non è una stima di comodo: è il limite oltre il quale la data non descrive
 * più un minore, ed è il controllo che manda in errore il codice fiscale di un GENITORE
 * incollato nel campo del bambino (il caso `…85T10…`, misurato).
 */
const ETA_MASSIMA_ALUNNO = 18

/**
 * Anno scolastico di una data: 15/10/2026 → 2026, 20/02/2027 → 2026.
 * Il confine è il 1° settembre — vedi `MESE_INIZIO_ANNO_SCOLASTICO` per il perché, e per
 * quale prezzo si paga in agosto.
 */
export function annoScolasticoDi(data: Date): number {
  if (!(data instanceof Date) || !Number.isFinite(data.getTime())) {
    throw new Error('annoScolasticoDi: data non valida.')
  }
  const anno = data.getFullYear()
  const mese = data.getMonth() + 1
  return mese >= MESE_INIZIO_ANNO_SCOLASTICO ? anno : anno - 1
}

/** Da dove è stato ricavato l'anno scolastico che decide la serie. */
export type FonteAnnoScolastico = 'periodo_competenza' | 'data_documento'

export interface EsitoAnnoScolastico {
  /** Anno d'apertura: 2026 sta per «2026/2027». */
  anno: number
  fonte: FonteAnnoScolastico
  /**
   * `true` quando l'anno è un ripiego sulla data del documento E quella data cade in
   * AGOSTO: l'unico mese in cui le due regole d'anno scolastico in uso nel prodotto
   * rispondono anni diversi, quindi l'unico in cui il ripiego è una monetina.
   * Chi chiama lo passa a `sezionalePerMinore` come `annoScolasticoAmbiguo`.
   */
  ambiguo: boolean
}

/**
 * L'anno scolastico che decide la serie, preso dal PERIODO CHE SI STA FATTURANDO e non
 * dal giorno in cui si preme il bottone.
 *
 * IL DIFETTO CHE QUESTA FUNZIONE ESISTE PER CHIUDERE. `emettiFatturaPagamento` calcolava
 * l'anno scolastico da `oggiFiscaleISO()`, cioè da OGGI. Una retta di **maggio 2026**
 * (anno scolastico 2025/2026) fatturata a **settembre 2026** — un sollecito, un incasso
 * arrivato tardi, una fattura rifatta dopo uno scarto SDI — veniva valutata sull'anno
 * 2026/2027, e il confine dei tre anni si sposta di dodici mesi: lo stesso bambino esce
 * su «FPR» invece che su «Asilo». Il numero è già consumato sulla serie sbagliata e si
 * rimedia solo con una nota di variazione. La miccia è accesa perché la regola vera —
 * scritta in `docs/fatturazione/tracciato-di-riferimento.md` — è «deciso una volta per
 * anno scolastico, così non cambia a metà anno», e con la data di emissione cambiava
 * eccome.
 *
 * IL RIPIEGO È LA MAGGIORANZA, non un caso limite: misurato in produzione il 2026-08-10,
 * **71 pagamenti su 98 non hanno `periodo_competenza`**. Per questo la funzione non
 * lancia — bloccare i tre quarti delle fatture per un campo facoltativo sarebbe peggio
 * del difetto — ma DICE da dove ha preso l'anno, e chi chiama logga il ripiego.
 *
 * ⚠️ CON UN'ECCEZIONE, ed è agosto. Dal 1° al 31 agosto il ripiego risponde l'anno vecchio
 * mentre `annoScolasticoCorrente()` risponde già quello nuovo: lo stesso pagamento
 * fatturato il 31 agosto e il 1° settembre esce su due serie diverse per la coorte a
 * cavallo del 30 aprile. In quel mese l'esito porta `ambiguo: true`, e `sezionalePerMinore`
 * si rifiuta di scegliere quando la differenza cambia davvero la serie.
 *
 * @param periodoCompetenza `pagamenti.periodo_competenza`: colonna `date`, quindi
 *        «YYYY-MM-DD» da PostgREST. Si accetta anche «YYYY-MM» e una `Date`.
 * @param dataDocumento la data del documento, come ripiego. Va passata come
 *        data-calendario locale (vedi `giornoDaIsoFiscale` in `@/lib/aruba/emissione`).
 */
export function annoScolasticoDiCompetenza(
  periodoCompetenza: Date | string | null | undefined,
  dataDocumento: Date,
): EsitoAnnoScolastico {
  const competenza = aMeseCalendario(periodoCompetenza)
  if (competenza) {
    const { anno, mese } = competenza
    return {
      anno: mese >= MESE_INIZIO_ANNO_SCOLASTICO ? anno : anno - 1,
      fonte: 'periodo_competenza',
      ambiguo: false,
    }
  }
  const anno = annoScolasticoDi(dataDocumento)
  return {
    anno,
    fonte: 'data_documento',
    ambiguo: dataDocumento.getMonth() + 1 === MESE_RIPIEGO_AMBIGUO,
  }
}

/**
 * Anno e mese di un periodo di competenza, senza mai passare da `new Date(stringa)`.
 * Stessa scelta (e stessa ragione) di `meseAnnoDaPeriodo` in `@/lib/pagamenti/periodo`:
 * una mezzanotte UTC riletta in un fuso negativo scivolerebbe al mese precedente, e qui
 * il mese decide un anno scolastico.
 */
function aMeseCalendario(valore: Date | string | null | undefined): { anno: number; mese: number } | null {
  if (valore === null || valore === undefined) return null
  if (valore instanceof Date) {
    if (!Number.isFinite(valore.getTime())) return null
    const giorno = aDataCalendario(valore)
    return giorno ? { anno: giorno.getFullYear(), mese: giorno.getMonth() + 1 } : null
  }
  const pezzi = /^(\d{4})-(\d{2})/.exec(valore.trim())
  if (!pezzi) return null
  const anno = Number(pezzi[1])
  const mese = Number(pezzi[2])
  if (mese < 1 || mese > 12) return null
  return { anno, mese }
}

/**
 * Riduce l'ingresso a una data-calendario alla mezzanotte LOCALE, la stessa convenzione
 * di `dataNascitaDaCodiceFiscale`, così le due date sono confrontabili con `getTime()`.
 * La stringa `YYYY-MM-DD` viene letta a pezzi, senza passare da `Date`: è l'unica strada
 * indipendente dal fuso.
 */
function aDataCalendario(valore: Date | string | null | undefined): Date | null {
  if (valore === null || valore === undefined) return null

  if (valore instanceof Date) {
    if (!Number.isFinite(valore.getTime())) return null
    /*
     * Una `Date` esattamente a mezzanotte UTC è, di fatto, una data-calendario: è quello
     * che produce `new Date('2024-05-01')`, cioè la scorciatoia che chiunque scrive
     * partendo dalla stringa `YYYY-MM-DD` di PostgREST. Va riletta con i getter UTC.
     *
     * MISURATO, non temuto: con i soli getter locali, un bambino nato il 01/05/2024
     * (un giorno DOPO il confine, quindi «Asilo») usciva su **FPR** in America/New_York e
     * in America/Los_Angeles, perché la mezzanotte UTC lì è ancora il 30 aprile. In
     * Europe/Rome e in UTC — la macchina di sviluppo e Vercel — il difetto non si vede:
     * è latente, ed è la forma esatta del guasto già pagato in questo repo (il banco di
     * prova che viveva in un altro fuso dal prodotto).
     *
     * Ogni altra `Date` è costruita con l'ora locale (`new Date(2024, 4, 1)`) e con i
     * getter locali va riletta.
     */
    const eMezzanotteUtc = valore.getUTCHours() === 0 && valore.getUTCMinutes() === 0
      && valore.getUTCSeconds() === 0 && valore.getUTCMilliseconds() === 0
    return eMezzanotteUtc
      ? new Date(valore.getUTCFullYear(), valore.getUTCMonth(), valore.getUTCDate())
      : new Date(valore.getFullYear(), valore.getMonth(), valore.getDate())
  }

  const pezzi = /^(\d{4})-(\d{2})-(\d{2})/.exec(valore.trim())
  if (!pezzi) return null
  const anno = Number(pezzi[1])
  const mese = Number(pezzi[2])
  const giorno = Number(pezzi[3])
  const d = new Date(anno, mese - 1, giorno)
  // Scarta il 31 aprile e il 29 febbraio non bisestile, che `Date` traslerebbe in silenzio.
  if (d.getFullYear() !== anno || d.getMonth() !== mese - 1 || d.getDate() !== giorno) return null
  return d
}

/** Stesso giorno di calendario? (entrambe le date arrivano normalizzate a mezzanotte locale) */
function stessoGiorno(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime()
}

/**
 * C'è qualcosa in quel campo, o è vuoto?
 *
 * La distinzione fra «assente» e «illeggibile» sta tutta qui, e la stringa di soli spazi
 * va contata come ASSENTE per una ragione misurata: `alunni.codice_fiscale` è un
 * `char(16)`, cioè PostgREST consegna il valore **riempito di spazi a destra** fino a
 * sedici. Un campo lasciato in bianco arriva come sedici spazi, non come `''`, e senza
 * il `trim` verrebbe segnalato come «codice fiscale illeggibile» a ogni fattura di ogni
 * bambino a cui semplicemente non è stato compilato — un allarme che grida sempre non
 * lo guarda più nessuno.
 */
function presente(valore: unknown): boolean {
  if (valore === null || valore === undefined) return false
  if (typeof valore === 'string') return valore.trim() !== ''
  return true
}

/**
 * L'ULTIMO GIORNO in cui può essere nato un alunno dell'anno scolastico `annoScolastico`:
 * il 31 agosto successivo, cioè la chiusura di quell'anno. Dopo quella data il bambino
 * non era ancora nato quando l'anno si è chiuso.
 *
 * Serve a due cose insieme, ed è la stessa cosa detta una volta sola:
 *  1. **sciogliere il secolo del codice fiscale** senza guardare l'orologio (`26` è 2026 o
 *     1926? Non «dipende da che giorno è oggi», ma «dipende da quale anno scolastico sto
 *     fatturando»);
 *  2. fare da confine superiore di plausibilità.
 */
function finePlausibile(annoScolastico: number): Date {
  // giorno 0 del mese d'inizio = ultimo giorno del mese precedente, cioè il 31 agosto.
  return new Date(annoScolastico + 1, MESE_INIZIO_ANNO_SCOLASTICO - 1, 0)
}

/**
 * Il PRIMO giorno in cui può essere nato un alunno di quell'anno scolastico: il 1°
 * settembre di diciotto anni prima. Prima di quella data la persona non è un minore, e il
 * dato descrive qualcun altro — nel caso reale, il genitore.
 */
function inizioPlausibile(annoScolastico: number): Date {
  return new Date(annoScolastico - ETA_MASSIMA_ALUNNO, MESE_INIZIO_ANNO_SCOLASTICO - 1, 1)
}

/** La data può appartenere a un alunno di quell'anno scolastico? */
function plausibilePerAlunno(data: Date, annoScolastico: number): boolean {
  return data.getTime() >= inizioPlausibile(annoScolastico).getTime()
    && data.getTime() <= finePlausibile(annoScolastico).getTime()
}

/** Lo stato di UNA delle due fonti, dopo lettura e controllo di plausibilità. */
interface Fonte {
  /** La data utilizzabile, oppure `null` se assente, illeggibile o impossibile. */
  data: Date | null
  illeggibile: boolean
  implausibile: boolean
}

const FONTE_ASSENTE: Fonte = { data: null, illeggibile: false, implausibile: false }

/** Fonte «codice fiscale», sciolta contro l'anno scolastico e non contro l'orologio. */
function fonteDaCodiceFiscale(codiceFiscale: unknown, annoScolastico: number): Fonte {
  if (!presente(codiceFiscale)) return FONTE_ASSENTE
  const letta = dataNascitaDaCodiceFiscale(codiceFiscale as string, finePlausibile(annoScolastico))
  if (letta === null) return { data: null, illeggibile: true, implausibile: false }
  if (!plausibilePerAlunno(letta, annoScolastico)) {
    return { data: null, illeggibile: false, implausibile: true }
  }
  return { data: letta, illeggibile: false, implausibile: false }
}

/** Fonte «anagrafica» (`alunni.data_nascita`), con lo stesso metro di plausibilità. */
function fonteDaAnagrafica(dataNascita: Date | string | null | undefined, annoScolastico: number): Fonte {
  if (!presente(dataNascita)) return FONTE_ASSENTE
  const letta = aDataCalendario(dataNascita)
  if (letta === null) return { data: null, illeggibile: true, implausibile: false }
  if (!plausibilePerAlunno(letta, annoScolastico)) {
    return { data: null, illeggibile: false, implausibile: true }
  }
  return { data: letta, illeggibile: false, implausibile: false }
}

/**
 * Decide la serie fiscale del minore.
 *
 * - codice fiscale e anagrafica **d'accordo** → `fonte: 'cf'`, `discordanza: false`
 * - **in disaccordo** → vince l'anagrafica (`fonte: 'data_nascita'`, `discordanza: true`)
 * - codice fiscale assente, illeggibile o impossibile → `fonte: 'data_nascita'`
 * - anagrafica assente, illeggibile o impossibile → `fonte: 'cf'`
 * - **nessuna delle due utilizzabile → lancia**
 * - anno scolastico ambiguo (agosto, senza periodo di competenza) e le due letture
 *   portano su serie diverse → **lancia** `ErroreSerieAmbigua`
 *
 * I casi si distinguono nell'esito: `discordanza` dice che le due fonti si contraddicono,
 * `…Illeggibile` che una delle due non è nemmeno arrivata al confronto, `…Implausibile`
 * che si legge ma descrive qualcun altro. Sono segnali diversi e vanno loggati tutti:
 * vedi `@/lib/aruba/emissione`.
 *
 * @throws {ErroreSerieAmbigua} quando l'anno scolastico è un ripiego d'agosto e i due anni
 *         candidati darebbero serie diverse
 * @throws {Error} quando non esiste alcuna data di nascita utilizzabile
 */
export function sezionalePerMinore({
  codiceFiscale,
  dataNascita,
  annoScolastico,
  annoScolasticoAmbiguo = false,
}: IngressoSezionale): EsitoSezionale {
  if (!Number.isInteger(annoScolastico) || annoScolastico < 1900 || annoScolastico > 2999) {
    throw new Error(
      `Sezionale non determinabile: anno scolastico non valido (${String(annoScolastico)}). `
      + "Atteso l'anno d'apertura a quattro cifre, es. 2026 per il 2026/2027.",
    )
  }

  const esito = risolviSullAnno(codiceFiscale, dataNascita, annoScolastico)

  if (annoScolasticoAmbiguo) {
    /*
     * AGOSTO, SENZA «PERIODO DI COMPETENZA». L'anno scolastico non l'ha dichiarato
     * nessuno: è stato dedotto dalla data del documento, nell'unico mese in cui la
     * deduzione cambia risposta a seconda di quale regola si guarda. Qui non si sceglie
     * a maggioranza: si guarda se la differenza CONTA per questo bambino.
     *
     * Undici volte su dodici (e per la gran parte dei bambini anche in agosto) i due anni
     * candidati danno la stessa serie, e allora l'ambiguità è una questione di lana
     * caprina: la fattura parte. Per la coorte a cavallo del 30 aprile invece la serie
     * cambia davvero — ed è il numero di un registro fiscale, non un'etichetta. Si blocca.
     */
    const alternativo = annoScolastico + 1
    const altro = risolviSullAnno(codiceFiscale, dataNascita, alternativo, { lancia: false })
    if (altro && altro.sezionale !== esito.sezionale) {
      throw new ErroreSerieAmbigua(
        "Serie fiscale ambigua: il pagamento non ha un «periodo di competenza» e la fattura si emette in "
        + `agosto, il mese in cui l'anno scolastico cambia. Sull'anno ${annoScolastico}/${annoScolastico + 1} `
        + `questo bambino va su «${esito.sezionale}», sull'anno ${alternativo}/${alternativo + 1} su `
        + `«${altro.sezionale}». Compila «periodo di competenza» sul pagamento: la serie fiscale non si tira a sorte.`,
      )
    }
  }

  return esito
}

/**
 * L'esito su UN anno scolastico dato. Estratto da `sezionalePerMinore` perché in agosto va
 * calcolato due volte, sui due anni candidati — e senza `try/catch` attorno alla seconda
 * chiamata: un `catch` che inghiotte è un bug (AGENTS.md), quindi il caso «non c'è dato
 * utilizzabile» qui si dice con `null`, non con un'eccezione.
 *
 * @param opzioni `lancia: false` per la seconda lettura, quella di confronto.
 */
function risolviSullAnno(
  codiceFiscale: string | null | undefined,
  dataNascita: Date | string | null | undefined,
  annoScolastico: number,
  opzioni: { lancia: false },
): EsitoSezionale | null
function risolviSullAnno(
  codiceFiscale: string | null | undefined,
  dataNascita: Date | string | null | undefined,
  annoScolastico: number,
): EsitoSezionale
function risolviSullAnno(
  codiceFiscale: string | null | undefined,
  dataNascita: Date | string | null | undefined,
  annoScolastico: number,
  opzioni: { lancia: boolean } = { lancia: true },
): EsitoSezionale | null {
  const cf = fonteDaCodiceFiscale(codiceFiscale, annoScolastico)
  const anagrafica = fonteDaAnagrafica(dataNascita, annoScolastico)

  if (!cf.data && !anagrafica.data) {
    if (!opzioni.lancia) return null
    // Il messaggio dice QUALE dei casi è, perché la riparazione è diversa: «manca» si
    // completa, «c'è ma è sbagliato» si corregge, «c'è ma è di un'altra persona» si
    // sostituisce — e chi legge il log deve sapere quale dei tre. Nessun valore nel
    // testo: sono dati di un minore.
    throw new Error(
      `Sezionale non determinabile: ${motivoNonUtilizzabili(cf, anagrafica)}. `
      + "Bloccare l'emissione della fattura e completare l'anagrafica del minore: "
      + 'la serie fiscale non si indovina.',
    )
  }

  const discordanza = !!cf.data && !!anagrafica.data && !stessoGiorno(cf.data, anagrafica.data)
  /*
   * QUANDO DISCORDANO VINCE L'ANAGRAFICA. È una regola scritta, non un'inclinazione del
   * codice: sta anche in `docs/fatturazione/tracciato-di-riferimento.md`, e i due file
   * devono dire la stessa cosa. Fino al 2026-08-10 non la dicevano — il documento
   * attribuiva la scelta al codice fiscale — ed erano stati committati insieme.
   *
   * Le ragioni, quelle misurabili (la motivazione precedente, «è il dato che un umano ha
   * verificato sul documento», era falsa: `alunni.data_nascita` arriva dallo stesso
   * modulo pubblico di iscrizione da cui arriva il codice fiscale):
   *
   *  1. `data_nascita` è una colonna `date`: il database rifiuta tutto ciò che non è una
   *     data. `codice_fiscale` è un `char(16)` che accetta qualunque testo — e infatti in
   *     produzione, il 2026-08-10, su 14 codici valorizzati solo 3 hanno la forma giusta,
   *     mentre la data di nascita c'è su 32 alunni su 32.
   *  2. È lo stesso campo con cui il resto del prodotto ragiona sull'età del bambino
   *     (elenchi, certificati, deduplica delle iscrizioni): scegliere l'altro farebbe
   *     uscire una serie fiscale in disaccordo con tutto il resto della sua scheda.
   *  3. Cambiare oggi il vincitore sposterebbe di serie bambini già fatturati, e il
   *     sezionale si decide una volta per anno scolastico.
   *
   * La scelta non è mai muta: `discordanza` esce di qui e chi chiama la logga a `error`.
   */
  const usaAnagrafica = !cf.data || discordanza
  const scelta = usaAnagrafica ? anagrafica.data! : cf.data!
  const fonte: FonteDataNascita = usaAnagrafica ? 'data_nascita' : 'cf'

  return {
    sezionale: serieDallaData(scelta, annoScolastico),
    fonte,
    discordanza,
    codiceFiscaleIlleggibile: cf.illeggibile,
    dataNascitaIlleggibile: anagrafica.illeggibile,
    codiceFiscaleImplausibile: cf.implausibile,
    dataNascitaImplausibile: anagrafica.implausibile,
  }
}

/** Il pezzo di messaggio che dice, per ciascun campo, se manca / non si legge / è di un altro. */
function motivoNonUtilizzabili(cf: Fonte, anagrafica: Fonte): string {
  const dettoCf = descriviFonte(cf)
  const dettoAnagrafica = descriviFonte(anagrafica)
  if (!dettoCf && !dettoAnagrafica) {
    return 'né il codice fiscale né la data di nascita sono utilizzabili'
  }
  if (dettoCf && dettoAnagrafica) {
    return `il codice fiscale e la data di nascita ci sono ENTRAMBI: il primo ${dettoCf}, `
      + `la seconda ${dettoAnagrafica}`
  }
  if (dettoCf) return `il codice fiscale ${dettoCf}, e la data di nascita manca`
  return `la data di nascita ${dettoAnagrafica}, e il codice fiscale manca`
}

/** `null` quando il campo semplicemente non c'era: non c'è niente da raccontare. */
function descriviFonte(fonte: Fonte): string | null {
  if (fonte.illeggibile) return 'c’è ma NON è leggibile'
  if (fonte.implausibile) {
    return "c’è e si legge, ma indica una data di nascita che un alunno non può avere "
      + "(è il caso del dato di un adulto finito nel campo del bambino)"
  }
  return null
}

/**
 * «Compie 3 anni entro il 30/04/(annoScolastico+1)» equivale a «è nato entro il
 * 30/04/(annoScolastico−2)»: si sposta il confine di tre anni invece di sommare tre anni
 * alla data di nascita. Non è un'ottimizzazione, è per togliere di mezzo il 29 febbraio —
 * un nato il 29/02/2024 non ha un terzo compleanno sul calendario, e sommare gli anni
 * obbligherebbe a decidere se cade il 28 febbraio o il 1° marzo. Così la domanda non si pone.
 */
function serieDallaData(dataNascita: Date, annoScolastico: number): Sezionale {
  const ultimoGiornoFpr = new Date(annoScolastico - ETA_SOGLIA + 1, MESE_APRILE, GIORNO_LIMITE)
  return dataNascita.getTime() <= ultimoGiornoFpr.getTime() ? 'FPR' : 'Asilo'
}

/**
 * Numero di fattura completo di sezionale.
 *
 * I due sezionali scrivono l'anno in modo **diverso**, ed è così nelle fatture reali:
 * `Asilo 2328/2026` (quattro cifre) e `FPR 1947/26` (due cifre). Uniformarli
 * cambierebbe il numero di documenti già trasmessi allo SDI.
 */
export function formattaNumeroFattura(
  sezionale: Sezionale,
  numero: number,
  anno: number,
): string {
  if (!Number.isInteger(numero) || numero < 1) {
    throw new Error(
      `Numero di fattura non valido (${String(numero)}): atteso un intero positivo.`,
    )
  }
  if (!Number.isInteger(anno) || anno < 1000 || anno > 9999) {
    throw new Error(`Anno di fattura non valido (${String(anno)}): attese quattro cifre.`)
  }
  if (sezionale !== 'Asilo' && sezionale !== 'FPR') {
    throw new Error(`Sezionale sconosciuto (${String(sezionale)}): attesi 'Asilo' o 'FPR'.`)
  }

  const annoScritto = sezionale === 'FPR' ? String(anno).slice(-2) : String(anno)
  return `${sezionale} ${numero}/${annoScritto}`
}
