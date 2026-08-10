/**
 * Generatore XML FatturaPA 1.2.3 — tracciato per lo SDI via Aruba.
 *
 * Funzione PURA (nessun I/O): mappa un input strutturato sul tracciato
 * `FatturaElettronicaPrivati` (FPR12, B2C). IVA parametrica via `input.iva`
 * (default storico: 0% / Natura N4, esente art. 10 DPR 633/1972), marca da
 * bollo virtuale via `input.bollo` (blocco DatiBollo, dovuta sugli esenti
 * oltre € 77,47) e coordinate di pagamento via `input.pagamento` (blocco
 * DatiPagamento). IdTrasmittente = Aruba PEC (obbligatorio per il canale
 * API, altrimenti errore 0094).
 *
 * ─── LA VERSIONE, CHE FINO AL 2026-08-09 QUESTA RIGA SBAGLIAVA ────────────────
 * Qui c'era scritto «1.2.2». Lo schema in vigore è il **1.2.3** dal **1° aprile
 * 2025** (*Specifiche tecniche del formato della FatturaPA* v1.4): il commento era
 * stale da oltre un anno. Il codice non cambia — l'attributo `versione="FPR12"` e
 * il namespace `…/docs/xsd/fatture/v1.2` sono gli stessi nelle due revisioni, ed è
 * proprio per questo che nessuno se n'era accorto: era una riga di prosa che nessun
 * test poteva contraddire.
 *
 * ─── ORA UNO C'È ─────────────────────────────────────────────────────────────
 * `__tests__/lib/aruba/fatturapa-xsd.test.ts` valida l'output di questa funzione
 * contro lo XSD ufficiale committato in `src/lib/aruba/xsd/` (vedi il README lì
 * dentro per provenienza e impronte). Fino ad allora i test confrontavano stringhe:
 * dicevano che `<TipoDocumento>` conteneva `TD01`, non che lo SdI l'avrebbe accettato.
 *
 * ⚠️ MA LO XSD NON VEDE TUTTO, ed è misurato: `aliquota 22 + Natura N4` e
 * `aliquota 0 senza Natura` passano entrambi la validazione dello schema e vengono
 * entrambi SCARTATI dallo SdI (00400 / 00401). Le regole che lo schema non esprime
 * stanno in `verificaCoerenzaIva`, qui sotto, che LANCIA: un documento incoerente non
 * deve nemmeno esistere come stringa.
 *
 * ─── L'ORDINE NON È UNO STILE: È IL TRACCIATO ────────────────────────────────
 * Ogni blocco di FatturaPA è una `xs:sequence`. Un elemento giusto nel posto
 * sbagliato non è «quasi valido»: è uno scarto, e la notizia arriva per PEC giorni
 * dopo con un codice numerico. `DatiPagamento` sta DOPO `DatiBeniServizi`,
 * `NumeroCivico` fra `Indirizzo` e `CAP`, `Provincia` fra `Comune` e `Nazione`,
 * `DatiBollo` fra `Numero` e `ImportoTotaleDocumento`.
 *
 * ─── I CARATTERI E LE LUNGHEZZE, che fino al 2026-08-09 non erano imposti ─────
 * Il tracciato ammette solo `[\p{IsBasicLatin}\p{IsLatin-1Supplement}]` nei campi
 * testuali (fuori restano «—», «–», «’», «“”», «€», «…») e li tronca a lunghezze
 * precise; `Numero` e `ProgressivoInvio` vogliono perfino il solo ASCII. Prima qui
 * c'era il solo escaping dei metacaratteri XML, e il risultato era un file BEN
 * FORMATO che lo SdI scartava — misurato dalla validazione XSD su un trattino
 * lungo che l'emissione scriveva a mano. Ora ogni campo passa da `testoLatin`
 * (oppure `testoAscii`), che translittera ciò che ha un equivalente, butta ciò che
 * non ne ha e tronca al limite dichiarato in `LIMITI`.
 *
 * ⚠️ Il troncamento è l'ULTIMA difesa, non il posto dove si decide: accorciare la
 * causale di un documento fiscale è una scelta di merito, e chi emette la prende
 * PRIMA (`eccedeLimiteFatturaPA` in `@/lib/pagamenti/causale-fattura`, e la riga
 * di log che l'accompagna in `@/lib/aruba/emissione`). Qui si garantisce solo che
 * un documento parta valido invece di essere respinto.
 *
 * ─── COSA IL MOTORE DI KIDVILLE NON PASSA MAI, E PERCHÉ È SCRITTO QUI ────────
 * Questo generatore sa scrivere `<Causale>`, `<IBAN>` e `<Beneficiario>` perché il
 * tracciato li prevede. **L'emissione di Kidville non li usa**, e non è una
 * dimenticanza: il 2026-08-10 sono stati scaricati due documenti veri della
 * cooperativa (`scripts/aruba-campioni.mjs`, campioni `Asilo 2327/2026` e
 * `FPR 1946/26`) e nessuno dei tre elementi c'è — la descrizione sta solo nella
 * riga, e `<DettaglioPagamento>` contiene esclusivamente `ModalitaPagamento`,
 * `DataScadenzaPagamento` e `ImportoPagamento`. Le fatture del software convivono
 * nelle stesse serie fiscali di quelle scritte a mano: ciò che aggiungeremmo «per
 * completezza» sarebbe una differenza, e le differenze qui si vedono.
 * Vedi `docs/fatturazione/tracciato-di-riferimento.md` e `@/lib/aruba/emissione`.
 *
 * ⚠️ E chi decide PRIMA deve misurare la STESSA stringa che verrà scritta qui, non
 * quella che ha in mano: la riduzione al tracciato **allunga** (`€`→`EUR`, `…`→`...`,
 * `™`→`(TM)`) e accorcia (caratteri senza equivalente, spazi doppi). Per questo la
 * riduzione senza troncamento è esportata come `causalePerTracciato`: è l'unica
 * misura, e la usano sia il pannello di configurazione sia il gate del log.
 */

/** P.IVA di Aruba PEC S.p.A. — obbligatoria come IdTrasmittente sul canale API Aruba. */
export const ARUBA_PEC_PIVA = '01879020517'
const NATURA_ESENTE = 'N4'
/**
 * La dicitura dell'esenzione **così com'è scritta sulle fatture vere**, lettera per
 * lettera: `Art.` maiuscolo e l'anno a DUE cifre.
 *
 * ─── NON È UNA SCELTA EDITORIALE: È UNA MISURA ───────────────────────────────
 * Fino al 2026-08-10 qui c'era `Esente art. 10 DPR 633/1972` — minuscolo e anno a
 * quattro cifre — cioè esattamente la stringa che
 * `docs/fatturazione/tracciato-di-riferimento.md` elenca alla colonna «l'errore
 * facile». Misurato lo stesso giorno scaricando due documenti veri con
 * `scripts/aruba-campioni.mjs` (`Asilo 2327/2026` e `FPR 1946/26`) ed estraendo il
 * tracciato dall'involucro `.p7m`: entrambi portano
 * `<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>`.
 *
 * Il difetto non era formale — lo SDI accetta tutte e due — ma nella stessa serie
 * fiscale sarebbero convissuti documenti con due diciture diverse, metà scritti a
 * mano dalla segreteria e metà dal software, e la differenza sarebbe saltata fuori
 * al primo controllo. Il documento che dichiara l'obiettivo («devono uscire
 * identiche») era stato committato insieme al codice che lo violava.
 */
const RIFERIMENTO_NORMATIVO = 'Esente Art. 10 DPR 633/72'

/** Bonifico. È l'unica modalità con cui questa scuola incassa le rette. */
export const MODALITA_PAGAMENTO_BONIFICO = 'MP05'
/** Pagamento completo, in unica soluzione (non a rate). */
export const CONDIZIONI_PAGAMENTO_UNICA_SOLUZIONE = 'TP02'

/**
 * Le lunghezze massime del tracciato, campo per campo. Non sono convenzioni
 * interne: sono i `maxLength`/`pattern` dello XSD ufficiale, e superarli produce
 * uno scarto formale.
 */
export const LIMITI = {
  denominazione: 80,
  nome: 60,
  cognome: 60,
  indirizzo: 60,
  numeroCivico: 8,
  comune: 60,
  causale: 200,
  descrizione: 1000,
  /**
   * `String100LatinType`, non 200: fino al 2026-08-10 il riferimento normativo
   * veniva troncato a `LIMITI.causale` — cioè NON veniva troncato dove serviva.
   * Una dicitura configurata a mano di 120 caratteri passava di qui intatta e
   * usciva un documento che viola il `pattern` dello XSD (`{1,100}`): scarto
   * formale, con il numero già consumato sul sezionale.
   */
  riferimentoNormativo: 100,
  /**
   * `EmailContattiType`: da 7 a 256 caratteri, e la forma `.+@.+[.]+.+` — che è
   * la sola cosa che quello schema pretende di un indirizzo.
   */
  email: 256,
  /** `String20Type`: ASCII puro, niente accentate. */
  numero: 20,
  /** `String10Type`: ASCII puro. */
  progressivoInvio: 10,
  beneficiario: 200,
} as const

export interface SedeFiscale {
  indirizzo: string
  /** Separato dall'indirizzo: il tracciato ha un elemento apposta e non lo indovina. */
  numeroCivico?: string
  cap: string
  comune: string
  provincia?: string
  nazione?: string // default IT
}

export interface CedenteInput {
  piva: string
  codiceFiscale?: string
  denominazione: string
  regimeFiscale: string // es. RF01, RF19
  sede: SedeFiscale
  /**
   * `<Contatti><Email>` — la casella da cui la scuola risponde al genitore.
   *
   * Facoltativo per lo schema, PRESENTE su tutte le fatture vere della
   * cooperativa (misurato il 2026-08-10 sui due campioni scaricati con
   * `scripts/aruba-campioni.mjs`: entrambi portano il blocco `<Contatti>`).
   * Fino a quel giorno il generatore chiudeva `</CedentePrestatore>` subito dopo
   * `<Sede>` e l'elemento non usciva mai: ogni fattura emessa dal software era
   * distinguibile da quelle scritte a mano nella stessa serie, per una
   * differenza che non stava scritta da nessuna parte.
   *
   * Assente o malformato ⇒ blocco omesso (è facoltativo): meglio una fattura
   * senza contatto che un documento scartato per un dato accessorio. Chi emette
   * lo dice nei log, perché una differenza silenziosa è il difetto.
   */
  email?: string
}

export interface CessionarioInput {
  codiceFiscale: string
  nome: string
  cognome: string
  sede: SedeFiscale
}

export interface RigaFattura {
  descrizione: string
  quantita?: number // default 1
  prezzoUnitario: number
}

export interface IvaFattura {
  aliquota: number
  /** Natura per aliquota 0 (es. N4); omessa → nessun tag Natura. */
  natura?: string
  riferimentoNormativo?: string
}

/**
 * Coordinate di pagamento (blocco 2.4). Facoltativo per lo schema, presente su
 * TUTTE le fatture vere della cooperativa — ma con TRE elementi soltanto:
 * `CondizioniPagamento`, `ModalitaPagamento`, `DataScadenzaPagamento`,
 * `ImportoPagamento` (misurato il 2026-08-10 sui campioni veri).
 *
 * `iban` e `beneficiario` restano scrivibili perché il tracciato li prevede, ma
 * l'emissione di Kidville NON li passa: vedi la testata del file.
 */
export interface PagamentoFattura {
  /** Default `MP05` (bonifico). */
  modalita?: string
  /** Default `TP02` (unica soluzione). */
  condizioni?: string
  /** `YYYY-MM-DD`. Assente → elemento omesso (è facoltativo). */
  dataScadenza?: string
  /** IBAN del conto della scuola. Assente o malformato → elemento omesso. */
  iban?: string
  /** Importo da pagare. Assente → il totale del documento. */
  importo?: number
  /** Beneficiario del bonifico (la denominazione del cedente). */
  beneficiario?: string
}

export interface FatturaPAInput {
  progressivoInvio: string
  numero: string
  data: string // YYYY-MM-DD
  cedente: CedenteInput
  cessionario: CessionarioInput
  righe: RigaFattura[]
  /**
   * `<Causale>` (2.1.1.11). ⚠️ **L'emissione di Kidville non lo valorizza**: sulle
   * fatture vere è ASSENTE e la descrizione sta solo nella riga. Passarlo
   * significherebbe scrivere lo stesso testo due volte con due limiti diversi
   * (200 qui, 1000 in `<Descrizione>`), cioè farlo uscire intero da una parte e
   * tagliato a metà parola dall'altra, sullo stesso documento.
   */
  causale?: string
  /** IVA di righe/riepilogo; assente = esente art. 10 (default storico). */
  iva?: IvaFattura
  /** Bollo assolto in modo virtuale (documenti esenti oltre € 77,47). */
  bollo?: { importo: number }
  /** Coordinate di pagamento; assente = blocco DatiPagamento omesso. */
  pagamento?: PagamentoFattura
}

/* ────────────────────────────────────────────────────────────────────────────
 * Normalizzazione del testo: ciò che il tracciato sa leggere.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I caratteri tipografici che una tastiera italiana e un correttore automatico
 * producono da soli, e che il tracciato NON ammette — con il loro equivalente.
 *
 * Translitterare e non cancellare è la scelta giusta perché questi caratteri
 * portano significato: un «—» che sparisce incolla due parole, un «€» che sparisce
 * lascia un importo senza valuta. Ciò che non ha equivalente viene tolto dopo.
 */
const TRANSLITTERAZIONE: Readonly<Record<string, string>> = {
  // Trattini e lineette (da U+2010 a U+2015), il segno meno U+2212, il punto elenco U+2022.
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-',
  '\u2015': '-', '\u2212': '-', '\u2022': '-',
  // Spazi «speciali»: unificatore U+00A0, fine U+2009, sottile unificatore U+202F.
  '\u00A0': ' ', '\u2009': ' ', '\u202F': ' ',
  // Apici e virgolette tipografiche (la tastiera del Mac le mette da sola).
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',
  // Il resto che compare davvero in una causale scritta a mano.
  '\u2026': '...', '\u20AC': 'EUR', '\u2122': '(TM)', '\u2117': '(P)',
}

/**
 * Le sole chiavi della tabella qui sopra: nessun INTERVALLO.
 *
 * Scritto prima come `/[\u2010-\u2033 …]/`, cioè un intervallo che si portava dentro
 * venti caratteri mai dichiarati e li cancellava col ramo `?? ''` — una regola
 * invisibile che nessuno avrebbe ritrovato leggendo la tabella. Qui la classe È la
 * tabella: ciò che non è dichiarato non viene translitterato, e se non è ammesso
 * dal tracciato lo toglie il filtro sotto, in modo dichiarato.
 */
const DA_TRANSLITTERARE = new RegExp(`[${Object.keys(TRANSLITTERAZIONE).join('')}]`, 'g')

/**
 * Un testo qualunque ridotto a ciò che il tracciato accetta, **senza troncare**.
 *
 * È la sola misura onesta di «quanto è lungo davvero» un testo destinato al tracciato,
 * perché questa riduzione NON conserva la lunghezza: `€` diventa `EUR` (1→3), `…`
 * diventa `...` (1→3), `™` diventa `(TM)` (1→4), un carattere senza equivalente
 * sparisce (1→0) e due spazi contigui contano per uno.
 *
 * Contare i caratteri PRIMA di questa riduzione — come faceva il pannello delle
 * causali fino al 2026-08-10 — significa dichiarare «200/200» su una causale che nel
 * documento ne occupa 202 e viene tagliata a metà dell'importo (`EUR 150,` invece di
 * `EUR 150,00`), su una fattura elettronica che si corregge solo con una nota di
 * variazione. Per questo esiste `causalePerTracciato` qui sotto: la misura deve vivere
 * in un posto solo, e quel posto è accanto alla tabella che allunga i caratteri.
 */
function riduciAlTracciato(valore: unknown, soloAscii: boolean): string {
  const grezzo = valore == null ? '' : String(valore)
  const translitterato = grezzo.replace(DA_TRANSLITTERARE, (c) => TRANSLITTERAZIONE[c] ?? '')
  const senzaAccapo = translitterato.replace(/[\t\n\r]+/g, ' ')
  // `xs:normalizedString` non ammette a capo; il resto lo decide il `pattern`: solo
  // Basic Latin (da U+0020 a U+007E) per Numero/ProgressivoInvio, più il Latin-1
  // Supplement (da U+00A1 a U+00FF) altrove. Restano fuori i caratteri di controllo e
  // tutto il resto di Unicode, che il tracciato non sa leggere.
  const ammessi = soloAscii
    ? senzaAccapo.replace(/[^\u0020-\u007E]/g, '')
    : senzaAccapo.replace(/[^\u0020-\u007E\u00A1-\u00FF]/g, '')
  return ammessi.replace(/ {2,}/g, ' ').trim()
}

/** Un testo qualunque, ridotto a ciò che il tracciato accetta e tagliato al limite. */
function normalizza(valore: unknown, max: number, soloAscii: boolean): string {
  return riduciAlTracciato(valore, soloAscii).slice(0, max)
}

/**
 * La causale **così come finirà in `<Causale>`**, prima del troncamento a
 * `LIMITI.causale`. Non tronca di proposito: serve a *misurare*, non a decidere.
 *
 * Chi deve sapere se una causale ci sta — il pannello che la configura e il gate del
 * log dell'emissione — chiede la lunghezza di QUESTA stringa, non di quella scritta a
 * schermo. La regola «quanto è lunga davvero» vale per due strade, quindi vive in un
 * posto solo.
 */
export function causalePerTracciato(valore: unknown): string {
  return riduciAlTracciato(valore, false)
}

/** Testo per i campi `…LatinType` (Basic Latin + Latin-1 Supplement). */
function testoLatin(valore: unknown, max: number): string {
  return normalizza(valore, max, false)
}

/** Testo per i campi ASCII puro: `Numero` (String20) e `ProgressivoInvio` (String10). */
function testoAscii(valore: unknown, max: number): string {
  return normalizza(valore, max, true)
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Testo normalizzato E con i metacaratteri XML sfuggiti: la sola strada verso l'XML. */
function xmlLatin(valore: unknown, max: number): string {
  return esc(testoLatin(valore, max))
}

function importo(n: number): string {
  return n.toFixed(2)
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * L'IBAN è valido per lo schema? `IBANType` vuole `[a-zA-Z]{2}[0-9]{2}[a-zA-Z0-9]{11,30}`.
 * Gli spazi con cui gli IBAN si scrivono e si incollano vanno tolti prima.
 * Un IBAN che non passa non si scrive a metà: si OMETTE — l'elemento è facoltativo,
 * e un IBAN storpiato farebbe scartare l'intero documento per un dato accessorio.
 */
const FORMA_IBAN = /^[A-Za-z]{2}[0-9]{2}[A-Za-z0-9]{11,30}$/
export function ibanPerTracciato(valore?: string | null): string | null {
  const pulito = (valore ?? '').replace(/[\s.-]/g, '').toUpperCase()
  return FORMA_IBAN.test(pulito) ? pulito : null
}

/** `YYYY-MM-DD`: qualunque altra cosa non è una data per `xs:date` e si omette. */
const FORMA_DATA = /^\d{4}-\d{2}-\d{2}$/

/**
 * L'indirizzo è scrivibile in `<Email>`? `EmailContattiType` chiede tre cose e
 * nient'altro: da 7 a 256 caratteri e la forma `.+@.+[.]+.+`.
 *
 * Qui NON si valida «che sia un'email vera» — quello lo fa `validaCedente` sulla
 * configurazione, che è il posto dove una persona può ancora correggerla. Questa è
 * l'ultima difesa: ciò che lo schema rifiuterebbe si OMETTE, perché l'elemento è
 * facoltativo e un contatto storpiato non deve far scartare l'intero documento.
 */
/**
 * Più STRETTA del `pattern` dello schema, di proposito: `.+@.+[.]+.+` accetta
 * anche «mario rossi@ .it», che non è un recapito ma un refuso. Ciò che passa di
 * qui passa di sicuro anche lo XSD; il contrario non ci interessa.
 */
const FORMA_EMAIL_TRACCIATO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function emailPerTracciato(valore?: string | null): string | null {
  const pulito = testoLatin(valore, LIMITI.email)
  if (pulito.length < 7) return null
  return FORMA_EMAIL_TRACCIATO.test(pulito) ? pulito : null
}

function sedeXml(sede: SedeFiscale): string {
  // Ordine da schema (IndirizzoType): Indirizzo · NumeroCivico? · CAP · Comune ·
  // Provincia? · Nazione.
  const civico = testoLatin(sede.numeroCivico, LIMITI.numeroCivico)
  const civicoXml = civico ? `        <NumeroCivico>${esc(civico)}</NumeroCivico>\n` : ''
  // `ProvinciaType` è `[A-Z]{2}`: una sigla minuscola o di tre lettere fa scartare.
  const prov = (sede.provincia ?? '').trim().toUpperCase()
  const provXml = /^[A-Z]{2}$/.test(prov) ? `        <Provincia>${prov}</Provincia>\n` : ''
  return (
    `      <Sede>\n` +
    `        <Indirizzo>${xmlLatin(sede.indirizzo, LIMITI.indirizzo)}</Indirizzo>\n` +
    civicoXml +
    `        <CAP>${esc((sede.cap ?? '').trim())}</CAP>\n` +
    `        <Comune>${xmlLatin(sede.comune, LIMITI.comune)}</Comune>\n` +
    provXml +
    `        <Nazione>${esc((sede.nazione || 'IT').trim())}</Nazione>\n` +
    `      </Sede>`
  )
}

/** Blocco 2.4 DatiPagamento, o stringa vuota se non ci sono coordinate da scrivere. */
function datiPagamentoXml(pagamento: PagamentoFattura | undefined, totale: number): string {
  if (!pagamento) return ''
  const modalita = (pagamento.modalita || MODALITA_PAGAMENTO_BONIFICO).trim()
  const condizioni = (pagamento.condizioni || CONDIZIONI_PAGAMENTO_UNICA_SOLUZIONE).trim()
  const importoPagamento = pagamento.importo ?? totale

  const beneficiario = testoLatin(pagamento.beneficiario, LIMITI.beneficiario)
  const beneficiarioXml = beneficiario ? `        <Beneficiario>${esc(beneficiario)}</Beneficiario>\n` : ''
  const scadenza = (pagamento.dataScadenza ?? '').trim()
  const scadenzaXml = FORMA_DATA.test(scadenza) ? `        <DataScadenzaPagamento>${scadenza}</DataScadenzaPagamento>\n` : ''
  const iban = ibanPerTracciato(pagamento.iban)
  const ibanXml = iban ? `        <IBAN>${iban}</IBAN>\n` : ''

  // Ordine da schema (DettaglioPagamentoType): Beneficiario? · ModalitaPagamento ·
  // … · DataScadenzaPagamento? · ImportoPagamento · … · IBAN?
  return (
    `    <DatiPagamento>\n` +
    `      <CondizioniPagamento>${esc(condizioni)}</CondizioniPagamento>\n` +
    `      <DettaglioPagamento>\n` +
    beneficiarioXml +
    `        <ModalitaPagamento>${esc(modalita)}</ModalitaPagamento>\n` +
    scadenzaXml +
    `        <ImportoPagamento>${importo(round2(importoPagamento))}</ImportoPagamento>\n` +
    ibanXml +
    `      </DettaglioPagamento>\n` +
    `    </DatiPagamento>\n`
  )
}

/**
 * La coerenza fra `AliquotaIVA` e `Natura` — la regola che lo XSD NON vede.
 *
 * Misurato con il validatore di `__tests__/lib/aruba/fatturapa-xsd.test.ts`:
 * `aliquota 22` con `<Natura>N4</Natura>` è XSD-VALIDO, e `aliquota 0` senza
 * `<Natura>` pure. Sono entrambi scarti SDI — **00400** («aliquota IVA diversa da
 * zero a fronte di una natura») e **00401** («natura non presente a fronte di
 * un'aliquota pari a zero») — e nessun test basato sullo schema può accorgersene,
 * perché il vincolo sta nelle *regole di controllo* dello SdI, non nel tracciato.
 *
 * Qui si LANCIA invece di correggere: scegliere una natura al posto di chi
 * configura significherebbe decidere il regime IVA di un documento fiscale, e
 * `N4` (esente art. 10) non è un default innocuo — è un'affermazione sull'operazione.
 * Chi chiama deve fermarsi PRIMA di allocare un numero: un numero bruciato su un
 * documento scartato si corregge solo con una nota di variazione.
 */
export class FatturaPAInputError extends Error {
  constructor(messaggio: string, public readonly codiceSdi: string) {
    super(messaggio)
    this.name = 'FatturaPAInputError'
  }
}

/** L'IVA è coerente? Lancia se no; non tocca nulla se sì. Esportata per validare PRIMA. */
export function verificaCoerenzaIva(iva: IvaFattura): void {
  const aliquota = Number(iva.aliquota)
  if (!Number.isFinite(aliquota) || aliquota < 0)
    throw new FatturaPAInputError(
      `Aliquota IVA non valida (${String(iva.aliquota)}): il tracciato ammette solo un numero non negativo.`,
      '00400',
    )
  const natura = (iva.natura ?? '').trim()
  if (aliquota === 0 && natura === '')
    throw new FatturaPAInputError(
      'Aliquota IVA 0 senza Natura: lo SDI scarta il documento (00401). ' +
        'Indica la natura dell’operazione (es. N4 per l’esente art. 10 DPR 633/1972).',
      '00401',
    )
  if (aliquota > 0 && natura !== '')
    throw new FatturaPAInputError(
      `Aliquota IVA ${aliquota} con Natura «${natura}»: lo SDI scarta il documento (00400). ` +
        'La natura si indica solo sulle operazioni ad aliquota zero.',
      '00400',
    )
}

export function buildFatturaElettronicaXml(input: FatturaPAInput): string {
  const { cedente, cessionario, righe } = input
  const totale = righe.reduce((acc, r) => acc + (r.quantita ?? 1) * r.prezzoUnitario, 0)

  const iva = input.iva ?? { aliquota: 0, natura: NATURA_ESENTE, riferimentoNormativo: RIFERIMENTO_NORMATIVO }
  // Prima di scrivere un solo carattere: un documento incoerente non deve nemmeno
  // esistere come stringa, perché esistendo verrebbe caricato.
  verificaCoerenzaIva(iva)
  const naturaXml = iva.natura ? `        <Natura>${esc(iva.natura)}</Natura>\n` : ''
  const imposta = round2((totale * iva.aliquota) / 100)

  const linee = righe
    .map((r, i) => {
      const q = r.quantita ?? 1
      const tot = q * r.prezzoUnitario
      return (
        `      <DettaglioLinee>\n` +
        `        <NumeroLinea>${i + 1}</NumeroLinea>\n` +
        `        <Descrizione>${xmlLatin(r.descrizione, LIMITI.descrizione)}</Descrizione>\n` +
        `        <Quantita>${importo(q)}</Quantita>\n` +
        `        <PrezzoUnitario>${importo(r.prezzoUnitario)}</PrezzoUnitario>\n` +
        `        <PrezzoTotale>${importo(tot)}</PrezzoTotale>\n` +
        `        <AliquotaIVA>${importo(iva.aliquota)}</AliquotaIVA>\n` +
        naturaXml +
        `      </DettaglioLinee>`
      )
    })
    .join('\n')

  const cedenteCf = cedente.codiceFiscale
    ? `        <CodiceFiscale>${esc(String(cedente.codiceFiscale).trim())}</CodiceFiscale>\n`
    : ''
  const causaleTesto = testoLatin(input.causale, LIMITI.causale)
  const causale = causaleTesto ? `        <Causale>${esc(causaleTesto)}</Causale>\n` : ''
  // Posizione da schema: DatiBollo sta tra Numero e ImportoTotaleDocumento.
  const datiBollo = input.bollo
    ? `        <DatiBollo>\n` +
      `          <BolloVirtuale>SI</BolloVirtuale>\n` +
      `          <ImportoBollo>${importo(input.bollo.importo)}</ImportoBollo>\n` +
      `        </DatiBollo>\n`
    : ''
  const rifNormativo = iva.riferimentoNormativo
    ? `        <RiferimentoNormativo>${xmlLatin(iva.riferimentoNormativo, LIMITI.riferimentoNormativo)}</RiferimentoNormativo>\n`
    : ''
  // `<Contatti>` sta DOPO `<Sede>` (CedentePrestatoreType: DatiAnagrafici · Sede ·
  // StabileOrganizzazione? · IscrizioneREA? · Contatti? · RiferimentoAmministrazione?).
  const emailCedente = emailPerTracciato(cedente.email)
  const contattiCedente = emailCedente
    ? `      <Contatti>\n` +
      `        <Email>${esc(emailCedente)}</Email>\n` +
      `      </Contatti>\n`
    : ''

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<p:FatturaElettronica versione="FPR12"` +
    ` xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"` +
    ` xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `  <FatturaElettronicaHeader>\n` +
    `    <DatiTrasmissione>\n` +
    `      <IdTrasmittente>\n` +
    `        <IdPaese>IT</IdPaese>\n` +
    `        <IdCodice>${ARUBA_PEC_PIVA}</IdCodice>\n` +
    `      </IdTrasmittente>\n` +
    `      <ProgressivoInvio>${esc(testoAscii(input.progressivoInvio, LIMITI.progressivoInvio))}</ProgressivoInvio>\n` +
    `      <FormatoTrasmissione>FPR12</FormatoTrasmissione>\n` +
    `      <CodiceDestinatario>0000000</CodiceDestinatario>\n` +
    `    </DatiTrasmissione>\n` +
    `    <CedentePrestatore>\n` +
    `      <DatiAnagrafici>\n` +
    `        <IdFiscaleIVA>\n` +
    `          <IdPaese>IT</IdPaese>\n` +
    `          <IdCodice>${esc(String(cedente.piva ?? '').trim())}</IdCodice>\n` +
    `        </IdFiscaleIVA>\n` +
    cedenteCf +
    `        <Anagrafica>\n` +
    `          <Denominazione>${xmlLatin(cedente.denominazione, LIMITI.denominazione)}</Denominazione>\n` +
    `        </Anagrafica>\n` +
    `        <RegimeFiscale>${esc(String(cedente.regimeFiscale ?? '').trim())}</RegimeFiscale>\n` +
    `      </DatiAnagrafici>\n` +
    sedeXml(cedente.sede) +
    `\n` +
    contattiCedente +
    `    </CedentePrestatore>\n` +
    `    <CessionarioCommittente>\n` +
    `      <DatiAnagrafici>\n` +
    `        <CodiceFiscale>${esc(String(cessionario.codiceFiscale ?? '').trim())}</CodiceFiscale>\n` +
    `        <Anagrafica>\n` +
    `          <Nome>${xmlLatin(cessionario.nome, LIMITI.nome)}</Nome>\n` +
    `          <Cognome>${xmlLatin(cessionario.cognome, LIMITI.cognome)}</Cognome>\n` +
    `        </Anagrafica>\n` +
    `      </DatiAnagrafici>\n` +
    sedeXml(cessionario.sede) +
    `\n    </CessionarioCommittente>\n` +
    `  </FatturaElettronicaHeader>\n` +
    `  <FatturaElettronicaBody>\n` +
    `    <DatiGenerali>\n` +
    `      <DatiGeneraliDocumento>\n` +
    `        <TipoDocumento>TD01</TipoDocumento>\n` +
    `        <Divisa>EUR</Divisa>\n` +
    `        <Data>${esc(String(input.data ?? '').trim())}</Data>\n` +
    `        <Numero>${esc(testoAscii(input.numero, LIMITI.numero))}</Numero>\n` +
    datiBollo +
    `        <ImportoTotaleDocumento>${importo(round2(totale + imposta))}</ImportoTotaleDocumento>\n` +
    causale +
    `      </DatiGeneraliDocumento>\n` +
    `    </DatiGenerali>\n` +
    `    <DatiBeniServizi>\n` +
    linee +
    `\n      <DatiRiepilogo>\n` +
    `        <AliquotaIVA>${importo(iva.aliquota)}</AliquotaIVA>\n` +
    naturaXml +
    `        <ImponibileImporto>${importo(totale)}</ImponibileImporto>\n` +
    `        <Imposta>${importo(imposta)}</Imposta>\n` +
    rifNormativo +
    `      </DatiRiepilogo>\n` +
    `    </DatiBeniServizi>\n` +
    datiPagamentoXml(input.pagamento, round2(totale + imposta)) +
    `  </FatturaElettronicaBody>\n` +
    `</p:FatturaElettronica>\n`
  )
}
