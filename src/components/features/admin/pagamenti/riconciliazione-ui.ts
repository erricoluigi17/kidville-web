/**
 * Modello e pelle della lista a semaforo della Riconciliazione bancaria (v2).
 *
 * Qui vivono i TIPI lato client dei movimenti/suggerimenti, la logica PURA che
 * decide il badge «CF» e la condizione «multi-CF» (aggancio «Incasso unico» che
 * l'esecutore UI-2 collega), e la mappa a semaforo con SFONDI PIENI per stato.
 *
 * Perché sfondi pieni e MAI opacità Tailwind (`/80`, `white/70`): su un fondo
 * colorato l'opacità abbassa il contrasto sotto AA (lezione a11y del ciclo
 * precedente → varianti PIENE). I colori sono token brand, non hex: `@theme
 * inline` li rimappa in Alto Contrasto. L'unico caso che il rimappaggio non
 * copre è il giallo (in HC diventa near-white e il testo chiaro sparirebbe):
 * l'override sta in `globals.css` agganciato a `hcClass`.
 */
import { formatEuro } from '@/lib/format/valuta'

export type StatoMovimento = 'da_abbinare' | 'suggerito' | 'confermato' | 'ignorato'

/** Un candidato all'abbinamento calcolato dal server (`lib/pagamenti/riconciliazione.ts`). */
export interface SuggerimentoUi {
  pagamento_id: string
  score: number
  motivi: string[]
  label?: string | null
  /** True se agganciato per codice fiscale (aggancio dominante, ordina primo). */
  cf_match?: boolean
  /** Alunno del pagamento: serve a raggruppare i CF per l'«Incasso unico». */
  alunno_id?: string | null
}

/** Una riga del registro movimenti (GET /api/pagamenti/riconciliazione). */
export interface MovimentoUi {
  id: string
  import_id?: string | null
  scuola_id?: string | null
  data_operazione: string
  importo: number
  causale?: string | null
  controparte?: string | null
  stato: StatoMovimento
  suggerimenti?: SuggerimentoUi[] | null
  pagamento_id?: string | null
  confermato_il?: string | null
  /**
   * Stato del pagamento collegato (`pagamenti.stato`), DERIVATO dal server e
   * valorizzato solo sui movimenti confermati di una sede dell'operatore.
   * Serve a un caso solo: distinguere «da fatturare» (saldato) dal rumore.
   */
  pagamento_stato?: string | null
  /** Stato di fatturazione del pagamento collegato, stessa minimizzazione. */
  fattura_stato?: StatoFattura | null
}

/** Gli stati di `pagamenti.fattura_stato` (colonna esistente, nessuna migrazione). */
export type StatoFattura = 'non_richiesta' | 'in_attesa' | 'emessa' | 'scartata'

/** Un pagamento aperto (fonte della ricerca manuale): GET /api/pagamenti?solo_aperti=true. */
export interface PagamentoApertoUi {
  id: string
  descrizione?: string | null
  importo: number
  importo_pagato: number
  tipo: string
  alunni?: { nome?: string | null; cognome?: string | null } | null
}

/** Esito di un import CSV (POST /api/pagamenti/riconciliazione). */
export interface EsitoImport {
  nuovi: number
  duplicati: number
  scartate: number
  suggeriti: number
  con_cf?: number
  da_abbinare: number
  /** Addebiti: righe capite benissimo e non importabili per progetto. */
  uscite?: number
  /** Righe oltre il tetto del lettore: NON sono state lette. */
  troncate?: number
  /** Movimenti senza ordinante: il campanello che suona se la banca cambia formato. */
  senza_ordinante?: number
}

/** Il PRIMO suggerimento è un aggancio per CF? → badge «CF» sulla riga. */
export function suggerimentoPrincipaleCf(sugg?: SuggerimentoUi[] | null): boolean {
  return Boolean(sugg && sugg.length > 0 && sugg[0]?.cf_match)
}

/** «n parola» con singolare/plurale scelto sul conteggio (0 e >1 → plurale). */
const plurale = (n: number, uno: string, molti: string): string => `${n} ${n === 1 ? uno : molti}`

/**
 * Testo del toast di riepilogo import, con singolare/plurale corretti (E2):
 * «1 nuovo movimento (1 con suggerimento) · 1 già visto · 1 riga scartata».
 * Il dettaglio «per codice fiscale» compare solo se `con_cf > 0`.
 *
 * ─── I DUE PEZZI IN CODA, E PERCHÉ NON SONO LA STESSA COSA ──────────────────
 * Le USCITE sono addebiti: righe capite benissimo e non importabili per progetto. Sul file
 * annuale vero sono 2.225, e finché finivano dentro «scartate» l'operatore leggeva «2.225
 * righe scartate» su un import perfettamente riuscito — cioè un allarme su un esito
 * corretto, che è il modo più rapido di insegnare a qualcuno a non leggere più il toast.
 * Si dicono, ma solo quando ci sono, e con la parola giusta: **ignorate**, non scartate.
 *
 * Le TRONCATE sono l'opposto: righe che il lettore non ha nemmeno guardato, perché oltre il
 * suo tetto. Sono una PERDITA, e il vecchio troncamento era silenzioso. Vanno in evidenza.
 */
export function riepilogoImport(e: EsitoImport): string {
  const cf = e.con_cf ? `, ${e.con_cf} per codice fiscale` : ''
  const suggeriti = `${plurale(e.suggeriti, 'con suggerimento', 'con suggerimenti')}${cf}`
  const uscite = e.uscite ? ` · ${plurale(e.uscite, 'uscita ignorata', 'uscite ignorate')}` : ''
  const troncate = e.troncate
    ? ` · ⚠️ ${plurale(e.troncate, 'riga NON letta', 'righe NON lette')} (limite)`
    : ''
  return (
    `${plurale(e.nuovi, 'nuovo movimento', 'nuovi movimenti')} (${suggeriti})` +
    ` · ${plurale(e.duplicati, 'già visto', 'già visti')}` +
    ` · ${plurale(e.scartate, 'riga scartata', 'righe scartate')}` +
    uscite +
    troncate
  )
}

/**
 * «Multi-CF»: ≥2 suggerimenti agganciati per CF (`cf_match:true`) con `alunno_id`
 * DISTINTI. È la condizione per proporre l'«Incasso unico» di famiglia (un solo
 * bonifico che salda più figli). Qui si calcola soltanto: l'aggancio del bottone
 * lo implementa l'esecutore UI-2 tramite la prop `onIncassoUnico`.
 */
export function movimentoMultiCf(sugg?: SuggerimentoUi[] | null): boolean {
  if (!sugg) return false
  const alunni = new Set<string>()
  for (const s of sugg) if (s.cf_match && s.alunno_id) alunni.add(s.alunno_id)
  return alunni.size >= 2
}

const nomeAlunno = (p: PagamentoApertoUi) =>
  [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ').trim()

const residuoAperto = (p: PagamentoApertoUi) =>
  Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0))

/** Etichetta leggibile del pagamento aperto (ricerca manuale + suggerimenti senza label). */
export function labelPagamentoAperto(p: PagamentoApertoUi): string {
  const nome = nomeAlunno(p) || '—'
  const desc = p.descrizione || '—'
  return `${nome} · ${desc} (residuo ${formatEuro(residuoAperto(p))})`
}

/** Testo minuscolo su cui filtra la ricerca manuale (nome alunno + descrizione). */
export function testoRicercaPagamento(p: PagamentoApertoUi): string {
  return `${nomeAlunno(p)} ${p.descrizione ?? ''}`.toLowerCase()
}

/**
 * Pelle a semaforo per stato. `bg`/`testo`/`sub` sono token PIENI, verificati AA
 * in luce normale; `hcClass` è la classe-àncora dell'override Alto Contrasto in
 * `globals.css` (unlayered → vince sulle utility Tailwind).
 *
 * Contrasti (luce normale):
 *  · confermato  green        + white → 6,4:1
 *  · suggerito   yellow       + ink   → 7,3:1
 *  · da abbinare error-strong + white → 5,6:1
 *  · ignorato    neutral-soft + ink   → 10,4:1  (sub → 8,9:1)
 */
export const SEMAFORO: Record<StatoMovimento, {
  label: string
  hcClass: string
  bg: string
  testo: string
  sub: string
}> = {
  confermato: { label: 'Confermato', hcClass: 'kv-recon-row--confermato', bg: 'bg-kidville-green', testo: 'text-kidville-white', sub: 'text-kidville-white' },
  suggerito: { label: 'Suggerito', hcClass: 'kv-recon-row--suggerito', bg: 'bg-kidville-yellow', testo: 'text-kidville-ink', sub: 'text-kidville-ink' },
  da_abbinare: { label: 'Da abbinare', hcClass: 'kv-recon-row--da_abbinare', bg: 'bg-kidville-error-strong', testo: 'text-kidville-white', sub: 'text-kidville-white' },
  ignorato: { label: 'Ignorato', hcClass: 'kv-recon-row--ignorato', bg: 'bg-kidville-neutral-soft', testo: 'text-kidville-ink', sub: 'text-kidville-sub' },
}

/** Filtri per stato del registro (id vuoto = tutti). Passati al GET come `?stato=`. */
export const FILTRI: { id: '' | StatoMovimento; label: string }[] = [
  { id: '', label: 'Tutti' },
  { id: 'da_abbinare', label: 'Da abbinare' },
  { id: 'suggerito', label: 'Suggeriti' },
  { id: 'confermato', label: 'Confermati' },
  { id: 'ignorato', label: 'Ignorati' },
]

// ─── FATTURAZIONE: UN CHIP SULLA RIGA VERDE, NON UN QUINTO STATO ─────────────
//
// Il registro ha quattro stati e soli quattro (`CHECK` sul DB): la riga diventa
// verde alla conferma e resta identica per sempre, anche dopo l'emissione — che
// scrive su `pagamenti.fattura_stato` e mai sul movimento. Su centinaia di righe
// verdi indistinguibili nessuno può dire quali restano da fatturare, e SALTARE
// una fattura non lo ferma nessuno (fatturare due volte sì: c'è la guardia di
// idempotenza dell'emissione). Il dato è DERIVATO e derivato resta.

/** I quattro «tono» del chip: la chiave della pelle, non un testo. */
export type TonoFatturazione = 'fatturata' | 'attesa' | 'scartata' | 'da_fatturare'

/**
 * Pelle del chip. Fondi PIENI, mai opacità: il chip vive sopra il fondo VERDE
 * della riga confermata, e `bg-kidville-white/70` su verde scende sotto AA (la
 * lezione già pagata dal semaforo). `hcClass` è l'àncora dell'override Alto
 * Contrasto in `globals.css`: `@theme inline` INLINA l'hex nelle utility, quindi
 * ridefinire i token sotto `[data-contrast="high"]` non ribalta nessuna classe —
 * la superficie si dipinge a mano, fuori da ogni `@layer`.
 *
 * Contrasti MISURATI (luce normale, WCAG 2.x §1.4.3):
 *  · fatturata    white + green        → 6,51:1
 *  · attesa       white + warn-strong  → 5,61:1
 *  · scartata     white + error-strong → 5,62:1
 *  · da_fatturare yellow + ink         → 7,33:1
 */
export const CHIP_FATTURAZIONE: Record<TonoFatturazione, {
  labelKey: string
  hcClass: string
  bg: string
  testo: string
}> = {
  fatturata: { labelKey: 'reconChipFatturata', hcClass: 'kv-recon-chip--fatturata', bg: 'bg-kidville-white', testo: 'text-kidville-green' },
  attesa: { labelKey: 'reconChipAttesaSdi', hcClass: 'kv-recon-chip--attesa', bg: 'bg-kidville-white', testo: 'text-kidville-warn-strong' },
  scartata: { labelKey: 'reconChipScartata', hcClass: 'kv-recon-chip--scartata', bg: 'bg-kidville-white', testo: 'text-kidville-error-strong' },
  da_fatturare: { labelKey: 'reconChipDaFatturare', hcClass: 'kv-recon-chip--da-fatturare', bg: 'bg-kidville-yellow', testo: 'text-kidville-ink' },
}

/** Da quale stato di fatturazione nasce quale tono (gli sconosciuti: nessuno). */
const TONO_DA_FATTURA: Partial<Record<StatoFattura, TonoFatturazione>> = {
  in_attesa: 'attesa',
  emessa: 'fatturata',
  scartata: 'scartata',
}

/**
 * Il chip di fatturazione di una riga, o `null` se non se ne mostra nessuno.
 *
 * Guarda SOLO i due campi derivati: il server li valorizza esclusivamente sui
 * movimenti confermati di una sede dell'operatore (stessa minimizzazione delle
 * label dei suggerimenti), quindi su una riga suggerita/ignorata arrivano `null`
 * e il chip non nasce — senza duplicare qui la regola di visibilità del server.
 *
 * ⚠️ «Da fatturare» è l'unico caso che pretende DUE campi: `non_richiesta` su un
 * pagamento non ancora saldato non è un invito ad agire, è rumore su una riga che
 * non si può fatturare.
 */
export function chipFatturazione(
  m: Pick<MovimentoUi, 'fattura_stato' | 'pagamento_stato'>,
): { labelKey: string; tono: TonoFatturazione; hcClass: string; bg: string; testo: string } | null {
  const fs = m.fattura_stato
  if (!fs) return null
  const tono: TonoFatturazione | undefined =
    fs === 'non_richiesta' ? (m.pagamento_stato === 'pagato' ? 'da_fatturare' : undefined) : TONO_DA_FATTURA[fs]
  if (!tono) return null
  return { tono, ...CHIP_FATTURAZIONE[tono] }
}

/**
 * Sottofiltro «Fatturazione», componibile col filtro per stato: passato al GET
 * come `?fattura=`. I due tagli utili sono asimmetrici per progetto — «da
 * fatturare» è la lista di lavoro, «fatturate» è la verifica — e implicano
 * entrambi i CONFERMATI, gli unici su cui la fatturazione esista.
 */
export const FILTRI_FATTURA: { id: '' | 'da_fatturare' | 'fatturate'; labelKey: string }[] = [
  { id: '', labelKey: 'reconFiltroTutte' },
  { id: 'da_fatturare', labelKey: 'reconFiltroDaFatturare' },
  { id: 'fatturate', labelKey: 'reconFiltroFatturate' },
]
