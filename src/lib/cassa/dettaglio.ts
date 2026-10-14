/** Riga del dettaglio contabilità: gli incassi conservano la categoria del pagamento. */
export interface RigaDettaglioCassa {
  id: string
  origine: 'incasso' | 'cassa'
  scuola_id: string
  scuola_nome: string | null
  data: string
  categoria_id: string | null
  categoria_nome: string | null
  metodo: string
  importo: number
  descrizione: string | null
  note: string | null
  allegato_path: string | null
  storno_di: string | null
  stornato_il: string | null
  pagamento_id: string | null
}

/** Totali dell'intero filtro, visibili soltanto ai ruoli reali di Direzione. */
export interface TotaliDettaglioCassa {
  totale: number
  contanti: number
  altri: number
}

export type DettaglioCassa = {
  disponibile: true
  righe: RigaDettaglioCassa[]
  conteggio: number
  pagina: number
  limite: number
  totali?: TotaliDettaglioCassa
} | {
  disponibile: false
  righe: []
  conteggio: 0
  pagina: number
  limite: number
  totali?: never
}
