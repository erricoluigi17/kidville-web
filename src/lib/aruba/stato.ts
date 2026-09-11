/**
 * Mappa lo stato Aruba sullo stato interno `fattura_stato` e su flag operativi
 * (terminale / scarto). Vedi DL-020.
 *
 * DUE INGRESSI, UNA SOLA TABELLA. Il codice numerico 1..10 è il nostro
 * vocabolario — è ciò che sta in `fatture_emesse.sdi_stato`, ciò su cui
 * l'aggregazione e la coda del cron sanno ragionare. Ma l'API di Aruba, di
 * numeri, non ne manda nessuno: risponde una DICITURA italiana dentro
 * `invoices[0].status` (misurato il 2026-09-11 su 4.000 documenti veri). Perciò
 * la traduzione dicitura→codice sta QUI, accanto alla tabella che poi la legge:
 * se le due si separassero, la prima potrebbe indicare una voce che la seconda
 * non ha più.
 *
 * Filosofia: una fattura che ha superato i controlli SDI (consegnata/accettata/
 * recapito impossibile/decorrenza termini) è fiscalmente **emessa**; i soli
 * rifiuti (errore elaborazione Aruba / scarto SDI / rifiuto destinatario) sono
 * **scartata** e vanno notificati alla Segreteria; gli stati in volo restano
 * **in_attesa**.
 */

import { MESSAGGIO_MAX } from '@/lib/logging/serialize'

export type FatturaStato = 'non_richiesta' | 'in_attesa' | 'emessa' | 'scartata'

export interface StatoArubaMappato {
  fatturaStato: FatturaStato
  label: string
  isTerminal: boolean
  isScarto: boolean
}

const TABELLA: Record<number, StatoArubaMappato> = {
  1: { fatturaStato: 'in_attesa', label: 'Presa in carico', isTerminal: false, isScarto: false },
  2: { fatturaStato: 'scartata', label: 'Errore di elaborazione', isTerminal: true, isScarto: true },
  3: { fatturaStato: 'in_attesa', label: 'Inviata allo SDI', isTerminal: false, isScarto: false },
  4: { fatturaStato: 'scartata', label: 'Scartata dallo SDI', isTerminal: true, isScarto: true },
  5: { fatturaStato: 'in_attesa', label: 'Non consegnata (SDI ritenta)', isTerminal: false, isScarto: false },
  6: { fatturaStato: 'emessa', label: 'Recapito impossibile (depositata)', isTerminal: true, isScarto: false },
  7: { fatturaStato: 'emessa', label: 'Consegnata', isTerminal: true, isScarto: false },
  8: { fatturaStato: 'emessa', label: 'Accettata', isTerminal: true, isScarto: false },
  9: { fatturaStato: 'scartata', label: 'Rifiutata dal destinatario', isTerminal: true, isScarto: true },
  10: { fatturaStato: 'emessa', label: 'Decorrenza termini', isTerminal: true, isScarto: false },
}

export function mapStatoAruba(code: number): StatoArubaMappato {
  return (
    TABELLA[code] ?? {
      fatturaStato: 'in_attesa',
      label: `Stato sconosciuto (${code})`,
      isTerminal: false,
      isScarto: false,
    }
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA DICITURA — perché di numeri, Aruba, non ne manda nessuno.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * IL CODICE `0`: «NON ANCORA INTERPRETATO», e non è sinonimo di «in attesa».
 *
 * `mapStatoAruba(0)` cade sul ramo difensivo — `in_attesa`, non terminale, non
 * scarto — ed è voluto, ma la ragione è più stretta di «non lo sappiamo»: uno
 * stato non interpretato deve poter TORNARE, cioè deve restare nella coda del
 * cron (`STATI_IN_VOLO` in `pagamenti/fattura/sync`, che dal 2026-09-11
 * contiene lo `0` proprio per questo). Un `0` che uscisse dalla coda si
 * congelerebbe per sempre — è esattamente il difetto che questo lavoro chiude.
 *
 * E c'è l'altra metà, che è la ragione per cui `0` non diventerà mai `emessa`:
 * fra i due modi di sbagliare NON SONO EQUIVALENTI. Una fattura congelata si
 * scongela al giro dopo; una fattura SCARTATA marcata «emessa» esce dalla coda,
 * non genera nessun avviso alla Segreteria, resta in contabilità come valida e
 * NON viene mai corretta e ritrasmessa. Nel dubbio si resta in coda.
 */
export const CODICE_NON_INTERPRETATO = 0

/**
 * DICITURA ARUBA → codice della tabella numerica qui sopra.
 *
 * ─── LA MISURA, 2026-09-11, contro l'API vera ───────────────────────────────
 * `getByFilename` NON risponde con un numero, e non ha mai avuto un campo
 * `status` (né `stato`) al primo livello: le chiavi di primo livello sono `id`,
 * `sender`, `receiver`, `filename`, `invoices`, `username`, `lastUpdate`,
 * `idSdi`, `creationDate`, `signed`, `unsignedFile`, `errorCode`,
 * `errorDescription`, `pddAvailable`, `invoiceType`, `docType`. Non esiste
 * nemmeno l'involucro `value`.
 *
 * Lo stato sta DENTRO `invoices[0]` — quattro chiavi esatte: `invoiceDate`,
 * `number`, `status`, `statusDescription` — ed è una STRINGA ITALIANA.
 *
 * Su 4.000 documenti veri (anni 2026 e 2025) le diciture distinte sono TRE,
 * non dieci:
 *
 *     3960   «Non consegnata»   → 6  Recapito impossibile (depositata) → emessa
 *       31   «Scartata»         → 4  Scartata dallo SDI                → scartata
 *        9   «Consegnata»       → 7  Consegnata                        → emessa
 *
 * ─── ⚠️ «NON CONSEGNATA» NON VUOL DIRE «NON EMESSA», ED È IL CASO NORMALE ────
 * È la voce più sorprendente di questa mappa e la sola che qualcuno, in futuro,
 * sarà tentato di «correggere» in `in_attesa` credendo di sistemare un difetto.
 * NON LO È — e prima di cambiarla si legga questo paragrafo per intero.
 *
 * I destinatari delle nostre fatture sono i genitori: PRIVATI CITTADINI, senza
 * cassetto fiscale e senza codice destinatario. Lo SDI non ha nessun canale
 * telematico a cui recapitare il documento, quindi non lo recapita: lo DEPOSITA
 * nell'area riservata del destinatario sul sito dell'Agenzia delle Entrate.
 * «Non consegnata» descrive il MANCATO RECAPITO, non un mancato invio: la
 * fattura è stata trasmessa, ha superato i controlli dello SDI, è EMESSA, è
 * valida ed è fiscalmente in essere. È in tutto e per tutto la voce 6 della
 * tabella qui sopra, «Recapito impossibile (depositata)», che infatti mappa
 * già su `emessa`.
 *
 * E la misura dice 3.960 su 4.000: è il caso NORMALE, non l'eccezione — il 99%
 * dei documenti della cooperativa. Mapparlo su `in_attesa` metterebbe quasi
 * tutte le nostre fatture in un limbo perpetuo, e con esse il PDF, che per una
 * famiglia senza cassetto fiscale è l'unico modo di avere la propria fattura.
 *
 * ─── PERCHÉ UNA `Map` E NON UN OGGETTO ──────────────────────────────────────
 * La chiave qui è testo che arriva DAL PROVIDER. Su un oggetto letterale
 * `DICITURA['constructor']` non è `undefined`: è una funzione ereditata dal
 * prototipo, e `?? 0` non la intercetta. Una `Map` non ha prototipo da
 * interrogare, e la stessa riga smette di poter mentire.
 */
const DICITURA_A_CODICE = new Map<string, number>([
  // Recapitata davvero: il destinatario aveva un canale (PEC o codice destinatario).
  ['consegnata', 7],
  // Recapito impossibile → lo SDI DEPOSITA. La fattura È emessa. Vedi il blocco qui sopra.
  ['non consegnata', 6],
  // Respinta dallo SDI: NON è emessa. Va corretta e RITRASMESSA, e la Segreteria va avvisata.
  ['scartata', 4],
])

/**
 * Normalizzazione DELIBERATAMENTE STUPIDA: minuscole, estremi tagliati, spazi
 * interni collassati. Nient'altro.
 *
 * Niente accenti tolti, niente prefissi, niente `startsWith`, niente `includes`.
 * Un confronto per sottostringa riconoscerebbe «Consegnata» DENTRO «Non
 * consegnata» — cioè scambierebbe due voci opposte della mappa — ed è il genere
 * di intelligenza che su un documento fiscale si paga. Se Aruba scriverà una
 * dicitura nuova, deve restare NON RICONOSCIUTA (codice 0, che ritenta) invece
 * di essere indovinata: indovinare è l'unico errore che non torna indietro.
 */
function normalizzaDicitura(d: string): string {
  return d.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Il codice della dicitura di Aruba, o `0` se non la riconosciamo.
 *
 * `0` anche quando la dicitura manca del tutto (`invoices` assente o vuoto): il
 * significato è lo stesso — non sappiamo in che stato sia quel documento — e la
 * conseguenza voluta è la stessa: resta in coda e si richiede al giro dopo.
 */
export function codiceStatoAruba(dicitura: string | null | undefined): number {
  if (typeof dicitura !== 'string') return CODICE_NON_INTERPRETATO
  const normalizzata = normalizzaDicitura(dicitura)
  if (normalizzata === '') return CODICE_NON_INTERPRETATO
  return DICITURA_A_CODICE.get(normalizzata) ?? CODICE_NON_INTERPRETATO
}

/**
 * L'etichetta da scrivere a registro: la NOSTRA + la parola vera di Aruba,
 * quando divergono.
 *
 * Il corpo del provider non si butta via (AGENTS.md, regola 3). Qui vale due
 * volte: la nostra tabella è una traduzione, e una traduzione che sostituisce
 * l'originale cancella l'unico modo di accorgersi che è sbagliata. Con «Non
 * consegnata» la riga a registro dice
 * `Recapito impossibile (depositata) — Aruba: «Non consegnata»`: chi la legge
 * vede insieme cosa ha detto lo SDI e come l'abbiamo classificata, e può
 * contestare la seconda metà senza dover riaprire l'API.
 *
 * Quando le due coincidono («Consegnata») non si scrive due volte la stessa
 * parola: una riga rumorosa si smette di leggere.
 */
export function etichettaStatoAruba(
  mappato: StatoArubaMappato,
  dicituraAruba?: string | null,
): string {
  const dicitura = typeof dicituraAruba === 'string' ? dicituraAruba.trim() : ''
  if (dicitura === '') return mappato.label
  if (normalizzaDicitura(dicitura) === normalizzaDicitura(mappato.label)) return mappato.label
  return `${mappato.label} — Aruba: «${dicitura}»`
}

/**
 * I pezzi grezzi che Aruba manda insieme allo stato, così come `arubaGetByFilename`
 * li ha letti. Struttura locale e non un import da `client.ts`: `client.ts` importa
 * di qui (`codiceStatoAruba`), e la dipendenza inversa chiuderebbe un ciclo.
 */
export interface DettagliAruba {
  /** `invoices[0].statusDescription`. */
  descrizioneAruba?: string | null
  /** `errorCode` di primo livello. Uno ZERO in qualunque forma è il percorso felice, non un motivo. */
  errorCode?: string | null
  /** `errorDescription` di primo livello. */
  errorDescription?: string | null
}

const testoUtile = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/**
 * IL CODICE D'ERRORE, se ne dice uno. `null` = «nessun errore», in tutte le sue forme.
 *
 * ─── LO ZERO HA UNA FAMIGLIA, NON UNA FORMA SOLA ────────────────────────────
 * Fino al 2026-09-11 il guardiano era `codice !== '0000'`, cioè un confronto con UNA
 * stringa. Ma questi codici arrivano da JSON e passano da `String(v)`: `0` numerico, `'0'`,
 * `'00'`, `'000'` sono lo stesso «nessun errore» e NESSUNO di loro è `'0000'`. Tutti e
 * quattro superavano il guardiano e scrivevano `(0) OK` dentro `sdi_scarto_motivo` di una
 * fattura respinta — che è peggio del motivo povero, perché SEMBRA un'informazione.
 *
 * ─── ⚠️ `Number(t) === 0`, NON `!Number(t)` ─────────────────────────────────
 * `Number('ABC')` è `NaN`, e `NaN` è FALSY: la versione negata butterebbe via ogni codice
 * alfanumerico, cioè trasformerebbe la correzione in una perdita più grande del difetto.
 * Il confronto con `0` prende tutta la famiglia degli zeri (`'0'`, `'00'`, `'0000.0'`,
 * `'+0'`) e lascia passare tutto il resto, `NaN` compreso.
 *
 * Sta qui, in un punto solo, perché lo usano DUE ingressi: i campi di `getByFilename`
 * (`motivoScartoAruba`) e quelli delle notifiche (`pezziDiNotifica`). Due copie della
 * stessa condizione divergono, e divergono in silenzio.
 */
function codiceDErrore(codice: string | null | undefined): string | null {
  const t = testoUtile(codice)
  if (t === null) return null
  return Number(t) === 0 ? null : t
}

/**
 * I pezzi di motivo che il PROVIDER ha dato davvero, deduplicati. Vuoto = ramo difensivo.
 *
 * Estratto dal corpo di `motivoScartoAruba` per una ragione sola, e vale la riga:
 * `scartoSenzaDescrizione` deve poter rispondere «questo scarto è senza motivo» SENZA
 * rileggere la frase italiana che abbiamo appena scritto noi. Una seconda implementazione
 * della stessa condizione — o peggio un `includes('nessun motivo dal provider')` sul nostro
 * stesso testo — diverge il giorno in cui qualcuno riscrive quella frase, e diverge in
 * silenzio. Qui le due funzioni leggono gli stessi pezzi, quindi non possono discordare.
 */
function pezziDelMotivo(dettagli?: DettagliAruba): string[] {
  const pezzi: string[] = []
  const aggiungi = (v: string | null) => {
    // Dedup case-insensitive: `statusDescription` ed `errorDescription` possono
    // ripetere la stessa frase, e una riga che dice due volte la stessa cosa si
    // legge come se dicesse due cose.
    if (v && !pezzi.some((p) => normalizzaDicitura(p) === normalizzaDicitura(v))) pezzi.push(v)
  }
  aggiungi(testoUtile(dettagli?.descrizioneAruba))
  aggiungi(testoUtile(dettagli?.errorDescription))
  return pezzi
}

/**
 * Vero quando su uno scarto il provider NON ha dato NESSUNA DESCRIZIONE — cioè quando
 * `motivoScartoAruba` sta per cadere su uno dei due rami difensivi, «Scarto Aruba 0093:
 * nessuna descrizione dal provider» o «nessun motivo dal provider».
 *
 * È la condizione che accende la chiamata alle NOTIFICHE in `fattura/sync`, e per questo
 * comprende anche il caso col solo codice: `0093` è verificabile sulla documentazione, ma
 * alla Segreteria che deve correggere e ritrasmettere non dice COSA correggere.
 *
 * ⚠️ NON è «il motivo è `null`»: su uno scarto `motivoScartoAruba` non ritorna mai `null`
 * (lì `null` significa «non è uno scarto»). La domanda è un'altra — *il provider ha detto
 * qualcosa?* — e si risponde sui dettagli, non sulla stringa.
 */
export function scartoSenzaDescrizione(dettagli?: DettagliAruba): boolean {
  return pezziDelMotivo(dettagli).length === 0
}

/**
 * IL MOTIVO DI UNO SCARTO, cioè l'unico campo che dice COSA CORREGGERE.
 *
 * ─── PERCHÉ NON BASTA L'ETICHETTA ───────────────────────────────────────────
 * Fino al 2026-09-11 `fattura/sync` scriveva in `sdi_scarto_motivo` la nostra
 * etichetta — «Scartata dallo SDI — Aruba: «Scartata»» — che è la stessa cosa
 * già scritta in `sdi_stato_label`, ripetuta con altre parole. Su una fattura
 * respinta quella colonna è il posto in cui la Segreteria va a guardare per
 * capire cosa sbagliare di meno alla ritrasmissione: dirle «è stata scartata»
 * quando la domanda è «perché» è zero informazione occupata da del testo.
 *
 * Al 2026-09-11 quattro fatture vere della cooperativa (FPR 1985/26, FPR
 * 2009/26, Asilo 2394/2026, Asilo 2407/2026) risultano scartate su Aruba: sono
 * esattamente le righe per cui questo campo serve.
 *
 * ─── LA PRASSI ERA GIÀ IN CASA ──────────────────────────────────────────────
 * `emissione.ts:2166` scrive in QUELLA STESSA COLONNA
 * `up.errorDescription ?? up.errorCode` sul percorso di upload. Il polling era
 * incoerente col resto del proprio file, non con un'idea nuova: qui la regola è
 * la stessa, allargata a `statusDescription` perché nella risposta di
 * `getByFilename` è il campo che descrive lo stato della SINGOLA fattura,
 * mentre `errorCode`/`errorDescription` di primo livello parlano della
 * richiesta.
 *
 * ─── PERCHÉ NON RITORNA MAI STRINGA VUOTA SU UNO SCARTO ─────────────────────
 * `null` in questa colonna significa «non è uno scarto» — è il valore che il
 * ramo non-scarto ci scrive. Se il provider non desse nessun motivo e noi
 * lasciassimo `null`, una fattura respinta si presenterebbe come una fattura
 * regolare. Perciò nel caso peggiore si scrive a lettere che il motivo NON È
 * ARRIVATO: è un'informazione anche quella, ed è vera.
 */
export function motivoScartoAruba(
  mappato: StatoArubaMappato,
  dicituraAruba?: string | null,
  dettagli?: DettagliAruba,
): string | null {
  if (!mappato.isScarto) return null

  const pezzi = pezziDelMotivo(dettagli)

  const codiceUtile = codiceDErrore(dettagli?.errorCode)

  if (pezzi.length === 0) {
    // Nessuna descrizione. Il codice da solo è poco, ma è verificabile sulla
    // documentazione Aruba: meglio di una frase nostra.
    if (codiceUtile) return `Scarto Aruba ${codiceUtile}: nessuna descrizione dal provider`
    const dicitura = testoUtile(dicituraAruba)
    return dicitura
      ? `Aruba: «${dicitura}» — nessun motivo dal provider`
      : `${mappato.label} — nessun motivo dal provider`
  }

  const testo = pezzi.join(' · ')
  return codiceUtile ? `(${codiceUtile}) ${testo}` : testo
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE NOTIFICHE SDI — dove il «perché» di uno scarto vive davvero.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ─── IL FATTO MISURATO, 2026-09-11 ──────────────────────────────────────────
 * Corretta la lettura dello stato (PR #138) la coda del cron ha ricominciato a girare, e
 * la prima fattura respinta è emersa alle 10:31Z con `sdi_stato = 4`. In
 * `sdi_scarto_motivo` è finito
 *
 *     Aruba: «Scartata» — nessun motivo dal provider
 *
 * cioè il ramo difensivo qui sopra: `getByFilename` aveva risposto con `statusDescription`,
 * `errorCode` ed `errorDescription` TUTTI VUOTI. Non è una risposta arrivata tardi e non
 * serve aspettare il tick successivo: **su quel canale il motivo non c'è**. Il perché di uno
 * scarto lo scrive lo SdI in una NOTIFICA — tipicamente una `NS`, «notifica di scarto» — che
 * ha un endpoint suo (`arubaGetNotifications`).
 *
 * ─── ⚠️ QUESTA FUNZIONE NON È STATA MISURATA CONTRO L'API VERA ──────────────
 * E la riga va letta come sta scritta, perché è il punto di tutto il blocco: la forma della
 * risposta di `/services/notification/out/getByInvoiceFilename` **non è nota**. Non è stata
 * misurata DI PROPOSITO: Aruba concede 1 autenticazione al minuto e 12 ricerche al minuto
 * *per IP* (SLA §3), il cron di produzione sta consumando quel secchio adesso e l'08/09 sono
 * già arrivati nove `429`. Una sonda esplorativa avrebbe rubato lo slot a chi sta emettendo.
 *
 * Perciò qui NON si presume una forma sola: si cerca, su più forme plausibili, e dove non si
 * riconosce niente si risponde `null` invece di indovinare. Le forme accettate sono quelle
 * che un elenco di notifiche assume di solito — un array nudo, un involucro con una chiave
 * (`notifications`, `content`, `value`…), una notifica sola — con dentro o un elenco di
 * errori (`errors`/`errori`/`listaErrori`) o dei campi piatti
 * (`errorCode`/`errorDescription`/`descrizione`) — questi ultimi solo dove reggono davvero,
 * cioè con un codice d'errore vero o su una notifica che si DICHIARA `NS`: su un involucro
 * riuscito gli stessi campi valgono `0000` e «OK». **Nessuna di queste è verificata**: vanno
 * confermate alla prima notifica reale, e la riga di log `notifiche-forma-ignota` di
 * `fattura/sync` esiste esattamente per quello — porta in `app_log` i NOMI dei campi e la
 * loro forma (mai i valori: vedi `descriviForma`).
 *
 * ─── PERCHÉ `null` È LA RISPOSTA GIUSTA QUANDO NON SI CAPISCE ───────────────
 * Il corpo di una notifica SDI contiene l'anagrafica fiscale dell'intestatario della
 * fattura: denominazione, codice fiscale, partita IVA di una famiglia. Pescare «il primo
 * campo di testo che si trova» significherebbe scrivere il nome di qualcuno dentro un
 * registro fiscale al posto di un codice d'errore. Nel dubbio resta il motivo povero, che è
 * poco ma è vero.
 */

/** Quante notifiche si guardano al massimo, e quanti errori dentro ciascuna. */
const NOTIFICHE_MAX = 20
const ERRORI_MAX = 10
/** Il tetto del testo che finisce in `sdi_scarto_motivo`: è un registro, non un dump. */
const MOTIVO_NOTIFICHE_MAX = 500
/** Quanti nomi di campo entrano nella descrizione di forma, e quanto lunghi. */
const CHIAVI_FORMA_MAX = 24
const CHIAVE_FORMA_MAX = 40

/**
 * Lo spazio riservato a ciò che sta DAVANTI alla forma nel messaggio di log: il prefisso
 * della riga `esito: 'notifiche-forma-ignota'`, in
 * `src/app/api/pagamenti/fattura/sync/route.ts`, che è l'unico posto da cui questa stringa
 * esce. Oggi quel prefisso misura una trentina di caratteri; qui se ne dichiarano 60, cioè
 * il doppio, così chi lo riscrive un po' più lungo non fa sparire in silenzio la coda della
 * forma — che è proprio la parte con i nomi più annidati.
 *
 * ⚠️ Se un giorno quel prefisso dovesse crescere oltre i 60, è QUESTO numero che va alzato:
 * il tetto del canale non si sposta, e la somma dei due non può superarlo.
 */
const PREFISSO_MSG_MAX = 60

/**
 * IL TETTO DELLA DESCRIZIONE DI FORMA, e non è un numero scelto: è ciò che AVANZA.
 *
 * ⚠️ Fino al 2026-09-11 qui c'era `600`, scritto a mano. Ma questa stringa viaggia dentro il
 * `msg` di una riga di log, e `sanificaMessaggio` tronca a `MESSAGGIO_MAX` (500): cento
 * caratteri erano promessi e buttati via in silenzio — e buttati via dalla CODA, cioè
 * proprio dai nomi più annidati, quelli per cui la profondità qui sotto esiste. Un budget
 * più largo del canale che lo trasporta è una bugia.
 *
 * Derivato, non ricopiato: se `MESSAGGIO_MAX` cambia, questo lo segue. Il lock che lo misura
 * non legge nemmeno questo numero — chiede a `sanificaMessaggio` dove tronca davvero
 * (`__tests__/lib/aruba/notifiche-motivo-scarto.test.ts`).
 */
export const FORMA_MAX = MESSAGGIO_MAX - PREFISSO_MSG_MAX

/**
 * OTTO LIVELLI, e ognuno è contato su una forma che `elencoNotifiche` attraversa davvero:
 *
 *     1-3  gli involucri annidati (`INVOLUCRI_MAX`: `{value: {content: {items: […]}}}`)
 *       4  l'array delle notifiche
 *       5  la notifica, dove sta `listaErrori`
 *       6  l'involucro `{errore: […]}` della conversione XML→JSON dell'`NS` dello SdI
 *       7  l'array degli errori
 *       8  l'oggetto errore: `codice`, `descrizione` — I NOMI CHE SERVONO
 *
 * ⚠️ A QUATTRO (il valore fino al 2026-09-11) la riga non ci arrivava, ed era la sua unica
 * ragione di esistere. Misurato: su `{notifications: […]}` l'elenco errori usciva
 * `listaErrori: {errore: array(1)}` — senza `codice` né `descrizione` — e su
 * `{value: {content: […]}}` usciva `listaErrori: oggetto(1 chiavi)`, perdendo persino il
 * nome `errore`. Cioè: «c'è qualcosa lì dentro», che è esattamente l'inutilità da cui questa
 * funzione doveva liberarci.
 *
 * Il costo è contenuto da `FORMA_MAX`, non dalla profondità: sulle quattro forme misurate la
 * descrizione completa sta fra 134 e 153 caratteri, un terzo del budget.
 */
const PROFONDITA_FORMA = 8
/** Quanti involucri annidati si attraversano prima di rinunciare. */
const INVOLUCRI_MAX = 3

/** `notificationType`, `notification_type`, `Notification Type` → `notificationtype`. */
const chiaveNormalizzata = (k: string): string => k.toLowerCase().replace(/[_\-\s]/g, '')

const oggettoSemplice = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const tronca = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/**
 * Le chiavi sotto cui un ELENCO di notifiche può stare. Nessuna misurata: `content` e
 * `value` vengono dalle altre risposte di Aruba (paginazione Spring e involucro storico),
 * le altre sono i nomi ovvi.
 */
const CONTENITORI_NOTIFICHE = [
  'notifications', 'notifiche', 'notificationlist', 'content', 'items', 'list', 'value', 'data', 'elements',
]

/**
 * Le chiavi che dichiarano il TIPO di una notifica SDI (`NS`, `RC`, `MC`, `NE`, `DT`, `AT`).
 * Sono in ordine di preferenza: il primo nome trovato vince.
 *
 * ─── `doctype` È L'UNICO NOME MISURATO, 2026-09-11 alle 16:30Z ──────────────
 * Gli altri cinque sono nomi plausibili, scritti quando la forma della risposta non era nota.
 * La prima notifica vera l'ha detta: il tipo sta in `docType`, `stringa(2)` — cioè le due
 * lettere dello SdI, `NS` per lo scarto. Senza questa voce quella notifica risultava «tipo
 * assente» e passava solo per il ramo difensivo.
 *
 * ⚠️ E L'ALTRA METÀ CONTA DI PIÙ. Finché `docType` non è stato qui, OGNI notifica di Aruba
 * risultava «tipo assente»: il filtro «NS o tipo assente», che esiste per escludere le altre,
 * non escludeva niente. Una `RC` — la ricevuta di CONSEGNA, cioè il racconto di un successo —
 * poteva fornire il testo scritto in `sdi_scarto_motivo` sotto il titolo «Perché lo SDI l'ha
 * respinta». Riconoscere il tipo non serve solo a trovare la `NS`: serve a ESCLUDERE le altre.
 */
const CHIAVI_TIPO_NOTIFICA = ['notificationtype', 'tiponotifica', 'doctype', 'type', 'tipo', 'kind']

/** Le chiavi che portano l'ELENCO degli errori dentro una notifica di scarto. */
const CHIAVI_ELENCO_ERRORI = ['errors', 'errori', 'listaerrori', 'errorlist', 'errorslist']

/**
 * Le chiavi che portano una DESCRIZIONE d'errore, in ordine di preferenza. Deliberatamente
 * STRETTE: sono nomi che parlano di un errore, non «qualunque campo di testo». `descrizione`
 * è il più largo dei sei e resta perché è il nome che lo SdI usa dentro `<Errore>`.
 */
const CHIAVI_DESCRIZIONE_ERRORE = [
  'errordescription', 'descrizioneerrore', 'descrizione', 'description', 'message', 'messaggio', 'suggerimento', 'hint',
]

/** Le chiavi che portano un CODICE d'errore, in ordine di preferenza. */
const CHIAVI_CODICE_ERRORE = ['errorcode', 'codiceerrore', 'codice', 'code']

/** La notifica che dice «scartata». Le altre (`RC`, `MC`, `NE`, `DT`) parlano d'altro. */
const TIPO_SCARTO = 'NS'

/* ────────────────────────────────────────────────────────────────────────────
 * L'ALLEGATO — dove il motivo stava davvero, misurato il 2026-09-11 alle 16:30Z.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ─── IL FATTO ───────────────────────────────────────────────────────────────
 * La prima notifica vera è arrivata: `aruba:notifiche` ha risposto **HTTP 200** in 626 ms,
 * quindi `invoiceFilename` era il parametro giusto. Ma l'estrattore non ha riconosciuto
 * niente, e la riga `notifiche-forma-ignota` ha portato in `app_log` la forma esatta:
 *
 *     {count: numero,
 *      notifications: array(1) di {filename: stringa(35), number: null,
 *        notificationDate: null, docType: stringa(2), date: stringa(29),
 *        invoiceId: stringa(24), file: stringa(6304), result: null,
 *        errorCode: null, errorDescription: null},
 *      errorCode: stringa(4), errorDescription: null}
 *
 * `errorCode` ed `errorDescription` della notifica sono **null**: cercare il motivo nei campi
 * JSON non porterà mai a niente su questo canale. Il motivo è dentro `file`, 6304 caratteri,
 * che è l'XML della notifica SdI — per lo standard una `NS` porta `<ListaErrori>` con N
 * `<Errore>`, ognuno con `<Codice>`, `<Descrizione>` e spesso `<Suggerimento>`.
 *
 * ─── ⚠️ NON SI DÀ PER SCONTATO CHE SIA BASE64 ───────────────────────────────
 * 6304 caratteri possono essere base64 dell'XML oppure l'XML in chiaro: la forma dice la
 * LUNGHEZZA, non il contenuto (ed è giusto così, vedi `descriviForma`). Si riconosce quale
 * dei due è — se comincia con `<`, eventualmente dopo spazi o BOM, è già XML — e si gestiscono
 * entrambi. Dare per scontata la codifica significherebbe non leggere mai il caso in chiaro e
 * non accorgersene: il ramo difensivo risponde `null` con la stessa faccia in tutti e due.
 *
 * ─── E SI CERCA DOVUNQUE NEL TESTO, NON SOLO DALL'INIZIO ────────────────────
 * L'allegato può essere FIRMATO (`.p7m`): i byte dell'XML restano dentro l'involucro CAdES,
 * circondati da binario. Decodificato come UTF-8 il binario diventa spazzatura, ma i tag
 * ASCII sopravvivono — e sono l'unica cosa che serve. Un lettore ancorato al primo carattere
 * butterebbe via quel caso senza dire perché.
 */

/**
 * Le chiavi sotto cui può stare il DOCUMENTO della notifica. `file` è l'unica misurata; le
 * altre sono i nomi affini, nell'ordine in cui le chiediamo noi.
 *
 * ⚠️ `content` è anche un nome di CONTENITORE (vedi `CONTENITORI_NOTIFICHE`), e non è un
 * conflitto: là si scende solo dentro array e oggetti, qui si guardano solo le STRINGHE.
 * E `filename` — che nella forma misurata sta accanto a `file` — non entra da nessuna parte,
 * perché il confronto sui nomi normalizzati è ESATTO, non per prefisso.
 */
const CHIAVI_ALLEGATO = ['file', 'notificationfile', 'filecontent', 'xml', 'xmlfile', 'content', 'document']

/**
 * IL TETTO DI CIÒ CHE SI DECODIFICA E SI LEGGE, e non è una questione di stile.
 *
 * Questo codice gira dentro il giro di un cron che ha un tetto di tempo suo
 * (`TETTO_TEMPO_MS` in `fattura/sync`), su un campo che arriva DAL PROVIDER e di cui non
 * controlliamo la dimensione. Un allegato enorme non deve poter far esplodere né la memoria
 * né il tempo: sopra il tetto non si decodifica affatto, e la lunghezza finisce nella traccia
 * diagnostica — così il giorno in cui servisse più spazio lo si alza su una MISURA, non su
 * un'ipotesi.
 *
 * ⚠️ 16 KiB È SCELTO CONTRO IL BACKTRACKING, ED È UN NUMERO MISURATO. Il lettore è a
 * espressioni regolari, e un `<Errore>` aperto e mai chiuso fa ripartire la scansione fino in
 * fondo a ogni occorrenza: il costo peggiore è QUADRATICO nella lunghezza. Misurato su questa
 * macchina, con quell'input avverso:
 *
 *      16 KiB →     3 ms          256 KiB →  2.010 ms
 *      64 KiB →    51 ms        1.024 KiB → 36.898 ms
 *
 * Il tetto non è prudenza generica: fra 16 KiB e 1 MiB ci sono quattro ordini di grandezza, e
 * il giro del cron ha `TETTO_TEMPO_MS` da rispettare per tutte le fatture, non per una. A
 * 16 KiB l'intero estrattore costa **6,4 ms** sul caso peggiore (misurato end-to-end), cioè
 * niente accanto ai 626 ms della chiamata HTTP che gli ha portato quei byte. Ed è più del
 * doppio della misura vera, 6304 caratteri.
 */
export const ALLEGATO_MAX = 16 * 1024

/**
 * Quanti nomi di tag si RACCOLGONO al massimo, e quanto lunghi. Non è il numero che finisce
 * nella traccia: quello lo decide il budget residuo, un nome alla volta (vedi `rendiTraccia`).
 * Questo è solo il tetto sulla SCANSIONE, perché un XML può avere migliaia di tag distinti.
 */
const TAG_XML_MAX = 12
const NOME_TAG_MAX = 32

/**
 * Lo spazio MINIMO garantito alla traccia dell'allegato dentro `FORMA_MAX`, e il separatore
 * che la stacca dalla forma del JSON.
 *
 * ⚠️ Non è una divisione a metà, ed è deliberato: la forma misurata del JSON occupa ~290
 * caratteri e ha il diritto di arrivare INTERA — è quella che ha reso possibile questo
 * lavoro. Perciò al JSON si dà tutto ciò che gli serve fino a `FORMA_MAX` meno questo
 * minimo, e alla traccia va tutto ciò che AVANZA davvero, che sul caso vero è ~147.
 * Riservare invece un blocco fisso e largo taglierebbe la coda della forma del JSON, cioè
 * proprio `errorCode` ed `errorDescription`, che sono la parte che ha detto «qui non c'è
 * niente, guarda altrove».
 */
const TRACCIA_ALLEGATO_MIN = 120
const SEPARATORE_FORMA = ' · '

/** `ns3:Errore` → `Errore`. Il confronto è sul nome LOCALE: il prefisso è variabile. */
function nomeLocaleTag(tag: string): string {
  const i = tag.indexOf(':')
  return i < 0 ? tag : tag.slice(i + 1)
}

/**
 * LE ENTITÀ XML, SCIOLTE IN UN PASSAGGIO SOLO.
 *
 * ⚠️ L'ORDINE NON È UN DETTAGLIO, ed è il motivo per cui qui c'è UNA regex e non cinque
 * `replace` in fila: sciogliere `&amp;` prima delle altre trasformerebbe `&amp;lt;` in
 * `&lt;` e poi in `<`, cioè inventerebbe della marcatura dentro una descrizione. Con una
 * sola scansione ogni entità viene toccata una volta e nessun risultato viene rivisitato.
 *
 * Senza questo passaggio la colonna che la Segreteria apre direbbe «Fattura &amp;amp; nota di
 * credito» — e nelle descrizioni dello SdI le entità non sono rare: i riferimenti agli
 * elementi della fattura (`&lt;Natura&gt;`, `&lt;AliquotaIVA&gt;`) sono la parte che dice
 * DOVE correggere.
 */
const ENTITA_XML = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

const decodificaEntita = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (intero, nome: string) => ENTITA_XML.get(nome) ?? intero)

/**
 * Il testo dentro un tag, ripulito. L'ordine dei tre passaggi è vincolante:
 *
 *   1. via l'involucro `<![CDATA[…]]>`, che è marcatura e non contenuto;
 *   2. via l'eventuale marcatura interna, sostituita da uno spazio;
 *   3. **e solo adesso** le entità.
 *
 * ⚠️ Invertire 2 e 3 trasformerebbe `&lt;Natura&gt;` in `<Natura>` e il passaggio successivo
 * se lo mangerebbe come se fosse un tag: la descrizione perderebbe esattamente il riferimento
 * all'elemento da correggere, che è la sua parte utile.
 */
function testoDelContenuto(grezzo: string): string | null {
  const senzaCdata = grezzo.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // ⚠️ `[^<>]` E NON `[^>]`, e la differenza è fra 0,1 ms e 119 ms sullo stesso input.
  // Su un contenuto pieno di `<` senza `>` — XML troncato, o firma binaria — `[^>]*` è greedy
  // e riparte da ogni `<`: costo quadratico. Escludere anche `<` dalla classe fa fallire il
  // match in O(1), perché il primo `<` successivo chiude il tentativo invece di allungarlo.
  // Misurato al tetto di 16 KiB: 119,41 ms → 0,10 ms, con lo stesso identico risultato sulla
  // marcatura vera. È il passo che domina il costo dell'estrattore, non `blocchiErrore`.
  const senzaMarcatura = senzaCdata.replace(/<[^<>]*>/g, ' ')
  return testoUtile(decodificaEntita(senzaMarcatura).replace(/\s+/g, ' '))
}

/**
 * Il TESTO decodificato di un allegato in base64, o `null` se base64 non è.
 *
 * ⚠️ LA VALIDAZIONE VA FATTA PRIMA, ED È OBBLIGATORIA. `Buffer.from(s, 'base64')` non lancia
 * mai: sui caratteri fuori alfabeto TACE e decodifica quel che resta. Senza il controllo qui
 * sotto, una stringa qualunque del provider diventerebbe dei byte qualunque, e da quei byte
 * potrebbe uscire qualcosa che somiglia a un tag — cioè un motivo inventato dentro un
 * registro fiscale. Il controllo è anche ciò che distingue «non è base64» da «è base64 di
 * qualcosa che non è XML»: due diagnosi diverse, due righe di log diverse.
 *
 * `Buffer` è di Node, e `stato.ts` oggi è importato solo da route Node e da `client.ts`. Il
 * guardiano `typeof` non è scaramanzia: `motivoDalleNotificheSdi` è chiamata FUORI da ogni
 * `try` in `fattura/sync`, quindi un'eccezione qui diventerebbe un 500 e farebbe saltare
 * l'intero giro del cron — un dettaglio mancante trasformato in perdita di lavoro.
 */
function daBase64(grezzo: string): string | null {
  const compatto = grezzo.replace(/\s+/g, '')
  // `% 4 === 1` non è mai un base64 valido; sotto i 16 caratteri non c'è nessun XML dentro.
  if (compatto.length < 16 || compatto.length % 4 === 1) return null
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compatto)) return null
  if (typeof Buffer === 'undefined') return null
  // base64url (`-` e `_`) riportato all'alfabeto standard: Aruba non l'ha mai usato, ma
  // riconoscerlo costa una riga e non riconoscerlo costerebbe un giro di log per scoprirlo.
  const standard = compatto.replace(/-/g, '+').replace(/_/g, '/')
  return testoUtile(Buffer.from(standard, 'base64').toString('utf8'))
}

/** C'è almeno un tag plausibile? È il confine fra «XML» e «byte qualunque». */
const SEMBRA_XML = /<[A-Za-z_]/

/** L'XML dell'allegato, oppure il PERCHÉ non c'è — che è l'altra metà della diagnosi. */
type EsitoAllegato = { xml: string; perche: null } | { xml: null; perche: string }

function leggiAllegato(grezzo: string): EsitoAllegato {
  if (grezzo.length > ALLEGATO_MAX) {
    return { xml: null, perche: `oltre il tetto di ${ALLEGATO_MAX}` }
  }
  // XML IN CHIARO: comincia con `<`, eventualmente dopo spazi o BOM. Il BOM si scrive
  // `\uFEFF` e non come carattere: un BOM letterale nel sorgente è invisibile a chi rilegge.
  if (/^[\s\uFEFF]*</.test(grezzo)) return { xml: grezzo, perche: null }
  const decodificato = daBase64(grezzo)
  if (decodificato === null) return { xml: null, perche: 'non decodificabile' }
  if (!SEMBRA_XML.test(decodificato)) return { xml: null, perche: 'decodificato, ma non è XML' }
  return { xml: decodificato, perche: null }
}

/**
 * I blocchi `<Errore>…</Errore>`, con qualunque prefisso di namespace e fino a `ERRORI_MAX`.
 *
 * ⚠️ NIENTE PARSER DA NPM, e niente regex furba. `[\s\S]*?` è pigro e seguito da un letterale:
 * non c'è nessuna alternanza annidata su cui il motore possa esplodere. Il costo peggiore
 * resta quadratico — un `<Errore>` aperto e mai chiuso ripetuto N volte — ed è contenuto da
 * `ALLEGATO_MAX`, non dalla forma dell'espressione. Vedi il commento su quel tetto.
 *
 * La regex è LOCALE e non di modulo: una `/g` di modulo si porta dietro `lastIndex` fra una
 * chiamata e l'altra, ed è il modo classico di leggere la seconda notifica a metà.
 */
function blocchiErrore(xml: string): string[] {
  const re = /<(?:[A-Za-z_][\w.-]*:)?Errore(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?Errore\s*>/gi
  const blocchi: string[] = []
  let m: RegExpExecArray | null
  while (blocchi.length < ERRORI_MAX && (m = re.exec(xml)) !== null) blocchi.push(m[1])
  return blocchi
}

/**
 * Le espressioni per un nome di tag, costruite una volta sola. I nomi vengono dalle nostre
 * costanti (`CHIAVI_CODICE_ERRORE`, `CHIAVI_DESCRIZIONE_ERRORE`), mai dal provider: non c'è
 * niente da neutralizzare, ma la cache evita di ricostruire ~120 regex per notifica.
 */
const REGEX_TAG = new Map<string, RegExp>()
function regexTag(nome: string): RegExp {
  let re = REGEX_TAG.get(nome)
  if (!re) {
    // Nessuna `/g`: `exec` su una regex globale avanzerebbe `lastIndex` fra le chiamate.
    re = new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${nome}\\s*>`,
      'i',
    )
    REGEX_TAG.set(nome, re)
  }
  return re
}

/**
 * Il primo tag utile fra quelli attesi, nell'ordine in cui li chiediamo NOI — la stessa
 * regola di `testoDaChiavi` sui campi JSON, applicata ai tag. Le stesse costanti, per la
 * stessa ragione: due elenchi di nomi divergono, e divergono in silenzio.
 *
 * ⚠️ Il `>` finale fa da confine di parola: cercando `codice`, `<CodiceErrore>` NON matcha —
 * ed è voluto, perché `codiceerrore` viene prima nell'elenco e deve poter vincere.
 */
function testoDelTagLocale(xml: string, attesi: readonly string[]): string | null {
  for (const nome of attesi) {
    const m = regexTag(nome).exec(xml)
    if (m) {
      const t = testoDelContenuto(m[1])
      if (t) return t
    }
  }
  return null
}

/**
 * La traccia diagnostica di un allegato, tenuta a PEZZI e non come stringa finita: l'elenco
 * dei nomi va reso dentro il budget che avanza, e per farlo togliendo nomi INTERI bisogna
 * ancora saperli distinguere. Una stringa già composta si può solo tagliare a metà parola.
 */
interface TracciaAllegato {
  /** `allegato(6304) tag:` — o, quando non si è letto niente, il perché per esteso. */
  intestazione: string
  /** I PRIMI nomi dei tag, già troncati e senza duplicati. Vuoto = niente da elencare. */
  nomi: string[]
  /**
   * Quanti nomi DISTINTI ha davvero l'XML, non quanti se ne sono tenuti.
   *
   * ⚠️ Serve a far dire il vero al `…+N`. I nomi vengono scartati in DUE punti — il tetto
   * sulla scansione (`TAG_XML_MAX`) e il budget della riga — e un `…+N` che contasse solo il
   * secondo direbbe «+2» su un documento che ne ha cinquanta: chi lo legge crederebbe di aver
   * visto quasi tutto l'XML e cercherebbe il difetto nel documento sbagliato.
   */
  distinti: number
}

/**
 * LA DIAGNOSTICA DEL LIVELLO PIÙ PROFONDO: i NOMI dei tag dell'XML, MAI il loro contenuto.
 *
 * 🔴 È la stessa regola di `descriviForma`, scesa di un gradino. Quell'XML è una notifica
 * fiscale: porta denominazione, codice fiscale e partita IVA dell'intestatario della fattura,
 * cioè di una FAMIGLIA. `sanificaMessaggio` maschera email e codici fiscali, NON una ragione
 * sociale. I nomi dei tag non sono dati di nessuno e sono esattamente ciò che, alla prossima
 * forma sconosciuta, permetterà di riconoscerla senza spendere un'altra interrogazione dentro
 * un secchio da 12 richieste al minuto.
 *
 * Solo i tag di APERTURA (`<Nome`), perché i chiusi sono duplicati; niente prologo (`<?xml`),
 * niente commenti né CDATA (`<!`), che non cominciano per lettera. Il nome è troncato e
 * l'insieme è finito: una spazzatura binaria che somigliasse a un tag non può occupare il
 * budget di tutti gli altri.
 */
function tracciaTagXml(xml: string, lunghezza: number): TracciaAllegato {
  const re = /<([A-Za-z_][\w.:-]*)/g
  const nomi: string[] = []
  const visti = new Set<string>()
  let m: RegExpExecArray | null
  // Si scandisce TUTTO (l'XML è già limitato da `ALLEGATO_MAX`): i nomi tenuti sono i primi
  // `TAG_XML_MAX`, ma quanti siano in tutto va saputo, o il `…+N` mentirebbe.
  while ((m = re.exec(xml)) !== null) {
    const nome = tronca(nomeLocaleTag(m[1]), NOME_TAG_MAX)
    const chiave = nome.toLowerCase()
    if (visti.has(chiave)) continue
    visti.add(chiave)
    if (nomi.length < TAG_XML_MAX) nomi.push(nome)
  }
  return nomi.length === 0
    ? { intestazione: `allegato(${lunghezza}): nessun tag`, nomi: [], distinti: 0 }
    : { intestazione: `allegato(${lunghezza}) tag:`, nomi, distinti: visti.size }
}

/**
 * LA TRACCIA RESA DENTRO IL BUDGET CHE AVANZA, TOGLIENDO NOMI INTERI E DICENDO QUANTI.
 *
 * ⚠️ Prima qui c'era un `tronca` secco, e tagliava a metà l'ultimo nome: `EsitoSconosciut…`.
 * Su una riga che esiste per farsi RICONOSCERE una forma ignota, mezzo nome non è mezza
 * informazione — è zero, perché non si può cercare. Peggio: non diceva quanti nomi mancavano,
 * quindi chi la leggeva non sapeva nemmeno di star guardando un elenco parziale.
 *
 * È lo stesso difetto che `FORMA_MAX` racconta di sé stesso duecento righe più su, in un
 * punto diverso: un budget che promette più di quanto il canale porti, e butta via la coda in
 * silenzio. Qui la coda si butta a nomi interi e il taglio si dichiara (`…+2`).
 */
function rendiTraccia(t: TracciaAllegato, budget: number): string {
  if (t.nomi.length === 0) return tronca(t.intestazione, budget)
  const dentro: string[] = []
  for (const nome of t.nomi) {
    const fuori = t.distinti - dentro.length - 1
    const candidato = `${t.intestazione} ${[...dentro, nome].join(', ')}${fuori > 0 ? ` …+${fuori}` : ''}`
    if (candidato.length > budget) break
    dentro.push(nome)
  }
  // Nemmeno il primo nome ci sta: resta l'intestazione, che almeno dice la lunghezza.
  if (dentro.length === 0) return tronca(t.intestazione, budget)
  const fuori = t.distinti - dentro.length
  return `${t.intestazione} ${dentro.join(', ')}${fuori > 0 ? ` …+${fuori}` : ''}`
}

export interface MotivoDalleNotifiche {
  /** Il motivo ricavato, già troncato. `null` = non si è riconosciuto niente di utile. */
  motivo: string | null
  /**
   * Quanti elementi si sono riconosciuti come ELENCO di notifiche. `0` significa «nessun
   * elenco»: o la risposta era una notifica sola, o la forma non è stata capita affatto.
   */
  notifiche: number
  /** Il tipo dichiarato della notifica da cui viene il motivo (`NS`…), se c'era. */
  tipo: string | null
  /**
   * TUTTI i tipi DICHIARATI dalle notifiche della risposta, distinti, in ordine di apparizione.
   *
   * ⚠️ Esiste per una ragione sola, e vale la pena saperla: `docType` è entrato fra le chiavi
   * del tipo il 2026-09-11 sulla misura `docType: stringa(2)` — cioè sulla sua LUNGHEZZA.
   * `descriviForma` per costruzione non porta i valori, quindi che quelle due lettere siano
   * davvero `NS` è una DEDUZIONE, non una misura.
   *
   * Se fossero altro, il filtro qui sotto passerebbe da «tipo assente ⇒ ammessa» a «tipo
   * dichiarato e diverso da NS ⇒ ESCLUSA», e la funzione diventerebbe muta **in silenzio**:
   * nessun errore, nessuna eccezione, e la riga diagnostica identica a prima, perché la forma
   * non cambia. Sarebbe il modo peggiore di sbagliare — quello che cancella le proprie tracce.
   *
   * Questo campo è l'antidoto: i tipi VERI risalgono fino ad `app_log`, e la prossima notifica
   * reale dirà se `NS` è la parola giusta, senza spendere una richiesta in più nel secchio da
   * 12 al minuto. Sono codici a due lettere di un vocabolario pubblico, non dati di nessuno.
   */
  tipiVisti: string[]
  /**
   * La FORMA della risposta — nomi dei campi e tipi, MAI i valori. Serve al log.
   *
   * Quando il motivo è `null` e la notifica portava un ALLEGATO che non ha detto niente, qui
   * si aggiunge un gradino: i nomi dei TAG dell'XML dentro l'allegato e la sua lunghezza.
   * Sempre nomi, mai contenuto — quell'XML è una notifica fiscale.
   */
  forma: string
}

/** Il primo valore utile fra le chiavi attese, nell'ordine in cui le chiediamo NOI. */
function testoDaChiavi(o: Record<string, unknown>, attese: readonly string[]): string | null {
  const perNome = new Map<string, unknown>()
  for (const [k, v] of Object.entries(o)) {
    const n = chiaveNormalizzata(k)
    if (!perNome.has(n)) perNome.set(n, v)
  }
  for (const attesa of attese) {
    const v = perNome.get(attesa)
    if (typeof v === 'string') {
      const t = testoUtile(v)
      if (t) return t
    }
    // Un codice può arrivare come NUMERO (`errorCode: 400`): resta il codice.
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/**
 * L'elenco delle notifiche dentro la risposta, e se è un ELENCO davvero.
 *
 * La discesa attraversa solo chiavi il cui NOME è in `CONTENITORI_NOTIFICHE`, e per al più
 * tre livelli. Non è una ricerca ricorsiva del primo array che capita: frugare a fondo in un
 * corpo che contiene l'anagrafica fiscale di una famiglia è il modo di pescare un campo che
 * non è un motivo di scarto.
 */
function elencoNotifiche(risposta: unknown, giri = INVOLUCRI_MAX): { elenco: unknown[]; daElenco: boolean } {
  if (Array.isArray(risposta)) return { elenco: risposta.slice(0, NOTIFICHE_MAX), daElenco: true }
  if (!oggettoSemplice(risposta)) return { elenco: [], daElenco: false }
  if (giri > 0) {
    // ⚠️ SI CONTINUA A CERCARE. Un oggetto sotto una chiave nota è un RIPIEGO, non una
    // risposta: `data` e `value` sono involucri comunissimi e possono portare qualcosa che
    // non c'entra niente, mentre l'elenco vero sta sotto una chiave successiva. Uscire al
    // primo nome noto significa perdere la risposta per l'ordine in cui il provider ha
    // scritto le chiavi — misurato su `{data: {esito}, notifications: [...]}`, dove
    // l'elenco veniva scartato e il motivo usciva `null`.
    let ripiego: Record<string, unknown> | null = null
    for (const [k, v] of Object.entries(risposta)) {
      if (!CONTENITORI_NOTIFICHE.includes(chiaveNormalizzata(k))) continue
      if (Array.isArray(v)) return { elenco: v.slice(0, NOTIFICHE_MAX), daElenco: true }
      if (oggettoSemplice(v)) {
        // Un involucro dentro l'involucro (`value: { content: [...] }`).
        const dentro = elencoNotifiche(v, giri - 1)
        if (dentro.daElenco) return dentro
        // ⚠️ SI PROPAGA CIÒ CHE LA RICORSIONE HA RAGGIUNTO, non l'involucro che l'ha portata.
        //
        // Qui prima c'era `ripiego = v`, e buttava via il lavoro appena fatto: su
        // `{value: {content: {notificationType: 'NS', listaErrori: {…}}}}` la ricorsione
        // arrivava fino alla notifica, e il livello sopra la riavvolgeva in `{content: …}`;
        // quello ancora sopra in `{value: …}`. Alla fine `motivoDalleNotificheSdi` riceveva
        // un involucro invece di una notifica, non ci trovava né tipo né errori, e il motivo
        // usciva `null` — cioè la fattura restava col motivo povero.
        // Il difetto era invisibile ai test perché il caso «involucro annidato» era provato
        // solo con un ARRAY in fondo (che esce dal ramo `daElenco`, sopra), e il caso
        // «notifica sola» solo SENZA involucri: la combinazione delle due non era coperta.
        const raggiunta = dentro.elenco[0]
        if (ripiego === null) ripiego = oggettoSemplice(raggiunta) ? raggiunta : v
      }
    }
    if (ripiego !== null) return { elenco: [ripiego], daElenco: false }
  }
  // Nessun contenitore riconosciuto: l'oggetto STESSO può essere la notifica.
  return { elenco: [risposta], daElenco: false }
}

/** L'elenco degli errori dentro una notifica, con un livello di annidamento tollerato. */
function erroriDiNotifica(n: Record<string, unknown>): unknown[] {
  for (const [k, v] of Object.entries(n)) {
    if (!CHIAVI_ELENCO_ERRORI.includes(chiaveNormalizzata(k))) continue
    if (Array.isArray(v)) return v.slice(0, ERRORI_MAX)
    if (oggettoSemplice(v)) {
      // `listaErrori: { errore: [...] }` è la forma che esce da una conversione XML→JSON
      // dell'`NS` dello SdI, dove `<ListaErrori>` contiene N `<Errore>`. Un livello solo.
      for (const dentro of Object.values(v)) {
        if (Array.isArray(dentro)) return dentro.slice(0, ERRORI_MAX)
      }
      return [v]
    }
  }
  return []
}

/**
 * Il tipo della notifica, ridotto alla forma di un ENUMERATO.
 *
 * Il vincolo non è estetico: questo valore finisce nel campo `tipo` di una riga di log, e
 * `redact` lascia `tipo` in chiaro **solo se il valore ha la forma di un enumerato tecnico**.
 * Una stringa qualunque del provider lì dentro sarebbe un canale di testo libero verso
 * `app_log`. Ciò che non ha quella forma esce `null`, e la riga perde un dettaglio invece di
 * portarsi dietro del contenuto.
 */
function tipoNotifica(n: Record<string, unknown>): string | null {
  const grezzo = testoDaChiavi(n, CHIAVI_TIPO_NOTIFICA)
  if (grezzo === null) return null
  const t = grezzo.trim().toUpperCase()
  return /^[A-Z0-9_-]{1,16}$/.test(t) ? t : null
}

/**
 * I motivi leggibili dentro UNA notifica, il suo tipo, e — quando l'allegato c'era ma non ha
 * detto niente — la traccia diagnostica che descrive l'XML che porta dentro.
 */
function pezziDiNotifica(n: unknown): { pezzi: string[]; tipo: string | null; traccia: TracciaAllegato | null } {
  if (!oggettoSemplice(n)) return { pezzi: [], tipo: null, traccia: null }
  const tipo = tipoNotifica(n)
  const pezzi: string[] = []
  const aggiungi = (codice: string | null, descrizione: string | null) => {
    const codiceUtile = codiceDErrore(codice)
    const testo = descrizione
      ? codiceUtile
        ? `(${codiceUtile}) ${descrizione}`
        : descrizione
      : codiceUtile
        ? `Errore ${codiceUtile}`
        : null
    if (!testo || pezzi.length >= ERRORI_MAX) return
    if (pezzi.some((p) => normalizzaDicitura(p) === normalizzaDicitura(testo))) return
    pezzi.push(testo)
  }

  for (const e of erroriDiNotifica(n)) {
    if (oggettoSemplice(e)) {
      aggiungi(testoDaChiavi(e, CHIAVI_CODICE_ERRORE), testoDaChiavi(e, CHIAVI_DESCRIZIONE_ERRORE))
    } else if (typeof e === 'string') {
      // Un elenco di STRINGHE è una forma legittima: `errori: ["00400 Natura non ammessa"]`.
      aggiungi(null, testoUtile(e))
    }
  }

  /* ─── L'ALLEGATO, che è dove il motivo sta DAVVERO (misurato) ─────────────────
   * Terzo per ordine, non per importanza: prima l'elenco JSON, che è già interpretato e non
   * va decodificato; poi questo; infine i campi piatti, che sono il ripiego più largo.
   * L'ordine non è preferenza estetica — un elenco JSON è una lettura senza ambiguità,
   * l'XML è una lettura per espressioni regolari su testo del provider.
   * ──────────────────────────────────────────────────────────────────────────── */
  let traccia: TracciaAllegato | null = null
  if (pezzi.length === 0) {
    const allegato = testoDaChiavi(n, CHIAVI_ALLEGATO)
    if (allegato !== null) {
      const esito = leggiAllegato(allegato)
      if (esito.xml === null) {
        traccia = { intestazione: `allegato(${allegato.length}): ${esito.perche}`, nomi: [], distinti: 0 }
      } else {
        for (const blocco of blocchiErrore(esito.xml)) {
          aggiungi(
            testoDelTagLocale(blocco, CHIAVI_CODICE_ERRORE),
            testoDelTagLocale(blocco, CHIAVI_DESCRIZIONE_ERRORE),
          )
        }
        // La traccia serve SOLO quando l'allegato non ha detto niente: se il motivo è uscito,
        // la riga di log che la trasporta non viene nemmeno emessa.
        if (pezzi.length === 0) traccia = tracciaTagXml(esito.xml, allegato.length)
      }
    }
  }

  if (pezzi.length === 0) {
    // Né un elenco di errori né un allegato che parli: restano i campi piatti della notifica.
    // E qui SERVE UN TITOLO PER PARLARE, perché questo ramo legge dei campi che su una
    // risposta RIUSCITA valgono `errorCode: '0000'` ed `errorDescription: 'OK'` (misurato
    // su `upload`).
    //
    // ⚠️ IL GUARDIANO DELLO ZERO DA SOLO NON BASTAVA: copriva `'0000'` e lasciava passare
    // `'0'`, `0`, `'00'`, `'000'` — e soprattutto lasciava passare il caso SENZA codice
    // affatto, dove restava un «OK» nudo. Scritto in `sdi_scarto_motivo` di una fattura
    // respinta è peggio del motivo povero, perché sembra un'informazione.
    //
    // Perciò il ramo piatto parla a due condizioni, e basta una: o c'è un codice d'errore
    // VERO (`codiceDErrore` ha già tolto tutti gli zeri), o la notifica si DICHIARA una
    // `NS`. Fuori di lì il campo di testo che si trova addosso a un involucro non è un
    // motivo di scarto: è la formula di cortesia del provider.
    const codice = codiceDErrore(testoDaChiavi(n, CHIAVI_CODICE_ERRORE))
    if (codice !== null || tipo === TIPO_SCARTO) {
      aggiungi(codice, testoDaChiavi(n, CHIAVI_DESCRIZIONE_ERRORE))
    }
  }

  return { pezzi, tipo, traccia }
}

/**
 * LA FORMA DEL JSON, E — QUANDO SERVE — LA TRACCIA DELL'ALLEGATO, DENTRO UN BUDGET SOLO.
 *
 * ⚠️ Le due si contendono `FORMA_MAX`, e la divisione non è a metà. La forma misurata del
 * JSON occupa ~290 caratteri e ha il diritto di arrivare INTERA: è quella che ha detto
 * «`errorCode` è null, guarda dentro `file`». Perciò al JSON si dà tutto lo spazio fino a
 * `FORMA_MAX` meno `TRACCIA_ALLEGATO_MIN`, e alla traccia va tutto ciò che AVANZA davvero —
 * sul caso vero ~147 caratteri, cioè otto o nove nomi di tag.
 */
function componiForma(risposta: unknown, traccia: TracciaAllegato | null): string {
  if (traccia === null) return descriviForma(risposta)
  const tettoJson = FORMA_MAX - TRACCIA_ALLEGATO_MIN - SEPARATORE_FORMA.length
  const formaJson = descriviForma(risposta, PROFONDITA_FORMA, tettoJson)
  const tettoTraccia = FORMA_MAX - formaJson.length - SEPARATORE_FORMA.length
  return `${formaJson}${SEPARATORE_FORMA}${rendiTraccia(traccia, tettoTraccia)}`
}

/** Il motivo di uno scarto letto dalle notifiche SDI. Vedi il blocco qui sopra. */
export function motivoDalleNotificheSdi(risposta: unknown): MotivoDalleNotifiche {
  const { elenco, daElenco } = elencoNotifiche(risposta)
  const notifiche = daElenco ? elenco.length : 0

  const lette = elenco.map((n) => pezziDiNotifica(n))

  /* ─── SI FILTRA, NON SI ORDINA ─────────────────────────────────────────────────
   * ⚠️ Fino al 2026-09-11 qui le `NS` venivano messe PER PRIME e poi il ciclo PROSEGUIVA
   * sulle altre. Mettere in cima non è escludere: se nell'elenco non c'è nessuna `NS` — o
   * se la chiave che porta il tipo non è fra quelle riconosciute, e allora `tipo` è `null`
   * per tutte — vinceva la prima notifica con una descrizione qualunque. Tipicamente una
   * `RC`, la ricevuta di consegna: il racconto di una consegna RIUSCITA, finito in
   * `sdi_scarto_motivo` e letto dalla Segreteria sotto il titolo «Perché lo SDI l'ha
   * respinta». Era esattamente l'esito che il commento su quella riga dichiarava di
   * impedire.
   *
   * Adesso il motivo lo possono dare due sole categorie:
   *
   *   • `NS` — la notifica di scarto, l'unica che per contratto SdI porta i codici errore;
   *   • tipo ASSENTE — `null` non vuol dire «non è uno scarto», vuol dire «la chiave che
   *     porta il tipo non è una di quelle che conosciamo», cioè NON ABBIAMO CAPITO LA
   *     FORMA. Lì il difensivo ha senso e va tenuto: la chiamata alle notifiche parte solo
   *     su fatture che SONO scartate, e rinunciare lascerebbe la Segreteria senza niente.
   *
   * Una notifica con un tipo DICHIARATO e diverso da `NS` (`RC`, `MC`, `NE`, `DT`, `AT` —
   * o un nome che non riconosciamo) non fornisce mai il motivo: meglio `null` e il motivo
   * povero, con la riga `notifiche-forma-ignota` di `fattura/sync` che porta in `app_log` i
   * NOMI dei campi e fa emergere la forma vera. In un registro fiscale nessun motivo è
   * meglio del motivo sbagliato — ed è la stessa scelta che `codiceStatoAruba` fa più su,
   * dove una dicitura nuova resta NON riconosciuta invece di essere indovinata.
   *
   * ⚠️ E la forma nel log dice anche questo: un `notificationType: stringa(2)` è quasi
   * certamente il codice a due lettere dello SdI; una stringa più lunga è un vocabolario
   * diverso, e allora è `CHIAVI_TIPO_NOTIFICA`/`TIPO_SCARTO` che vanno aggiornati — su una
   * misura, non su un'ipotesi.
   * ──────────────────────────────────────────────────────────────────────────── */
  // I tipi DICHIARATI, prima di filtrare: è ciò che dirà se `NS` è la parola giusta. Vedi
  // `tipiVisti` nell'interfaccia — lì c'è la ragione per esteso, e non è un dettaglio.
  const tipiVisti = [...new Set(lette.map((l) => l.tipo).filter((x): x is string => x !== null))]

  const ammesse = [
    ...lette.filter((l) => l.tipo === TIPO_SCARTO),
    ...lette.filter((l) => l.tipo === null),
  ]
  for (const l of ammesse) {
    if (l.pezzi.length === 0) continue
    return {
      motivo: tronca(l.pezzi.join(' · '), MOTIVO_NOTIFICHE_MAX),
      notifiche,
      tipo: l.tipo,
      tipiVisti,
      forma: componiForma(risposta, null),
    }
  }
  // Nessun motivo: è il caso in cui la forma serve DAVVERO, e la traccia dell'allegato è il
  // gradino in più. Si prende quella delle notifiche AMMESSE — descrivere l'allegato di una
  // `RC` significherebbe portarsi dietro un documento che non stavamo nemmeno leggendo.
  const traccia = ammesse.find((l) => l.traccia !== null)?.traccia ?? null
  return { motivo: null, notifiche, tipo: null, tipiVisti, forma: componiForma(risposta, traccia) }
}

/**
 * LA STRUTTURA DI UNA RISPOSTA, SENZA IL SUO CONTENUTO — i nomi dei campi, i tipi, le
 * lunghezze, i conteggi. Mai un valore.
 *
 * ⚠️ È il compromesso che rende loggabile un corpo che NON si può loggare. La risposta delle
 * notifiche porta denominazione, codice fiscale e partita IVA dell'intestatario della
 * fattura — di una famiglia — e il `msg` di una riga finisce in `app_log` in chiaro per
 * trenta giorni: `sanificaMessaggio` maschera email e codici fiscali, non una ragione
 * sociale. Ma senza NESSUNA traccia, il giorno in cui l'estrattore non riconosce la forma non
 * resta niente su cui lavorare, e si tornerebbe a interrogare l'API a tentativi dentro un
 * limite di 12 richieste al minuto.
 *
 * I NOMI dei campi non sono dati di nessuno, e sono esattamente ciò che serve per riconoscere
 * la forma vera. È lo stesso criterio già adottato da `chiaviPrimoElemento` in `client.ts`,
 * dove gli elementi contengono `receiver.fiscalCode` di genitori reali e si logga solo
 * l'elenco delle chiavi.
 */
/**
 * La profondità di default è `PROFONDITA_FORMA`: il conto dei livelli sta scritto lì.
 *
 * Il `tetto` si stringe in un caso solo — quando accanto alla forma deve stare anche la
 * traccia dell'allegato, e le due si dividono `FORMA_MAX` (vedi `componiForma`). Non si
 * allarga mai: il budget del canale è `MESSAGGIO_MAX`, e chi lo supera non se ne accorge.
 */
export function descriviForma(
  valore: unknown,
  profondita = PROFONDITA_FORMA,
  tetto = FORMA_MAX,
): string {
  return tronca(forma(valore, profondita), Math.min(tetto, FORMA_MAX))
}

function forma(v: unknown, p: number): string {
  if (v === null) return 'null'
  if (v === undefined) return 'assente'
  if (Array.isArray(v)) {
    if (v.length === 0 || p <= 0) return `array(${v.length})`
    return `array(${v.length}) di ${forma(v[0], p - 1)}`
  }
  if (typeof v === 'object') {
    const chiavi = Object.keys(v as Record<string, unknown>)
    if (p <= 0) return `oggetto(${chiavi.length} chiavi)`
    const dentro = chiavi
      .slice(0, CHIAVI_FORMA_MAX)
      .map((k) => `${tronca(k, CHIAVE_FORMA_MAX)}: ${forma((v as Record<string, unknown>)[k], p - 1)}`)
    if (chiavi.length > CHIAVI_FORMA_MAX) dentro.push(`…+${chiavi.length - CHIAVI_FORMA_MAX}`)
    return `{${dentro.join(', ')}}`
  }
  if (typeof v === 'string') return `stringa(${v.length})`
  if (typeof v === 'number') return 'numero'
  if (typeof v === 'boolean') return 'booleano'
  return typeof v
}

export interface RigaFatturaAgg {
  sdi_stato: number | null
  numero?: number | null
  quota_adult_id?: string | null
}

/**
 * Aggrega lo stato del PAGAMENTO dalle sue righe `fatture_emesse` (una per quota).
 * Regola: uno scarto → `scartata`; tutte le quote emesse/consegnate → `emessa`;
 * altrimenti `in_attesa`. Per ogni quota considera solo la riga più recente
 * (numero massimo), così una quota scartata e poi RI-emessa non blocca l'aggregato.
 */
export function aggregaFatturaStato(righe: RigaFatturaAgg[]): FatturaStato {
  if (!righe || righe.length === 0) return 'in_attesa'
  const perQuota = new Map<string, RigaFatturaAgg>()
  for (const r of righe) {
    const key = r.quota_adult_id ?? '__single__'
    const cur = perQuota.get(key)
    if (!cur || (r.numero ?? 0) >= (cur.numero ?? 0)) perQuota.set(key, r)
  }
  const mapped = [...perQuota.values()].map((r) => mapStatoAruba(r.sdi_stato ?? 1))
  if (mapped.some((m) => m.isScarto)) return 'scartata'
  if (mapped.every((m) => m.fatturaStato === 'emessa')) return 'emessa'
  return 'in_attesa'
}
