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
}

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
}

/** Il PRIMO suggerimento è un aggancio per CF? → badge «CF» sulla riga. */
export function suggerimentoPrincipaleCf(sugg?: SuggerimentoUi[] | null): boolean {
  return Boolean(sugg && sugg.length > 0 && sugg[0]?.cf_match)
}

/** «n parola» con singolare/plurale scelto sul conteggio (0 e >1 → plurale). */
const plurale = (n: number, uno: string, molti: string): string => `${n} ${n === 1 ? uno : molti}`

/**
 * Testo del toast di riepilogo import CSV, con singolare/plurale corretti (E2):
 * «1 nuovo movimento (1 con suggerimento) · 1 già visto · 1 riga scartata».
 * Il dettaglio «per codice fiscale» compare solo se `con_cf > 0`.
 */
export function riepilogoImport(e: EsitoImport): string {
  const cf = e.con_cf ? `, ${e.con_cf} per codice fiscale` : ''
  const suggeriti = `${plurale(e.suggeriti, 'con suggerimento', 'con suggerimenti')}${cf}`
  return (
    `${plurale(e.nuovi, 'nuovo movimento', 'nuovi movimenti')} (${suggeriti})` +
    ` · ${plurale(e.duplicati, 'già visto', 'già visti')}` +
    ` · ${plurale(e.scartate, 'riga scartata', 'righe scartate')}`
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
