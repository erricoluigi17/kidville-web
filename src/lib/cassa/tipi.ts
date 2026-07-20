// =============================================================================
// MODULO CASSA · tipi condivisi (contratto §3.1 del piano di ciclo).
//
// Proprietà E1. E2/E3/E4 importano SOLO da qui: le firme sotto sono VINCOLANTI,
// non cambiarle di una virgola.
// =============================================================================

export type CassaTipoMovimento = 'entrata' | 'uscita' | 'prelievo' | 'rettifica'
export type CassaMetodo = 'contanti' | 'bonifico' | 'carta' | 'altro'

export interface CassaMovimento {
  id: string
  scuola_id: string
  tipo: CassaTipoMovimento
  importo: number
  metodo: CassaMetodo
  data: string /* YYYY-MM-DD */
  categoria_id: string | null
  descrizione: string | null
  note: string | null
  allegato_path: string | null
  incasso_id: string | null
  chiusura_id: string | null
  registrato_da: string | null
  creato_il: string
  storno_di: string | null
  stornato_il: string | null
  storno_motivo: string | null
}

/** Riga della lista: movimento reale O entrata auto virtuale da incasso. */
export interface RigaMovimentoCassa extends Omit<CassaMovimento, 'id'> {
  id: string // per le virtuali: `incasso:<incasso_id>`
  origine: 'cassa' | 'incasso' // 'incasso' = virtuale, non stornabile da qui
  categoria_nome: string | null
}

export interface EntratoOggiVoce {
  metodo: string
  totale: number
}

export interface SaldoCassa {
  disponibile: true
  fondo: number
  saldo_atteso: number
  entrate_contanti: number // incassi auto (netto storni) + entrate manuali contanti (netto storni)
  uscite_contanti: number
  prelievi: number
  rettifiche: number
  entrato_oggi: EntratoOggiVoce[]
}

export interface CassaNonDisponibile {
  disponibile: false
}

// `type` (non `interface`): un'interfaccia senza index signature NON soddisfa il
// vincolo `T extends Record<string, unknown>` di getModuleConfig<CassaConfig> —
// che il piano stesso prescrive (E2.3). Il `type` alias ha shape identica e
// nessun consumer se ne accorge. Firma §3.1 preservata.
export type CassaConfig = {
  fondo?: number
  soglia_avviso?: number | null
  soglia_notificata_il?: string | null // stato interno anti-spam, scritto solo dal server
}

export interface CassaCategoria {
  id: string
  scuola_id: string | null
  nome: string
  slug: string
  colore: string | null
  icona: string | null
  ordine: number
  attivo: boolean
  is_sistema: boolean
}

export interface CassaChiusura {
  id: string
  scuola_id: string
  saldo_atteso: number
  contato: number
  differenza: number
  prelevato: number
  fondo_lasciato: number
  note: string | null
  eseguita_da: string | null
  eseguita_il: string
}
