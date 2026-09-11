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
  /** `errorCode` di primo livello. `'0000'` è il percorso felice, non un motivo. */
  errorCode?: string | null
  /** `errorDescription` di primo livello. */
  errorDescription?: string | null
}

/** `'0000'` è «nessun errore»: come motivo di uno scarto non dice niente. */
const CODICE_NESSUN_ERRORE = '0000'

const testoUtile = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
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

  const pezzi: string[] = []
  const aggiungi = (v: string | null) => {
    // Dedup case-insensitive: `statusDescription` ed `errorDescription` possono
    // ripetere la stessa frase, e una riga che dice due volte la stessa cosa si
    // legge come se dicesse due cose.
    if (v && !pezzi.some((p) => normalizzaDicitura(p) === normalizzaDicitura(v))) pezzi.push(v)
  }
  aggiungi(testoUtile(dettagli?.descrizioneAruba))
  aggiungi(testoUtile(dettagli?.errorDescription))

  const codice = testoUtile(dettagli?.errorCode)
  const codiceUtile = codice && codice !== CODICE_NESSUN_ERRORE ? codice : null

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
