// =============================================================================
// Tipi e costanti della sezione «News» (client-safe: nessun import server).
// Single source of truth condivisa da route, lib e frontend.
// =============================================================================

/** Bucket Storage dei media delle news. */
export const NEWS_BUCKET = 'news'

/** Tipi di contenuto pubblicabile. */
export const NEWS_TIPI = ['articolo', 'breve', 'instagram'] as const
export type NewsTipo = (typeof NEWS_TIPI)[number]

/** Stati del workflow editoriale (bozza→proposta→programmata→pubblicata; nascosta = ritirata). */
export const NEWS_STATI = ['bozza', 'proposta', 'programmata', 'pubblicata', 'nascosta'] as const
export type NewsStato = (typeof NEWS_STATI)[number]

/** Ambito di destinazione del post. */
export const NEWS_SCOPES = ['globale', 'grado', 'classi'] as const
export type NewsScope = (typeof NEWS_SCOPES)[number]

/** Gradi scolastici (allineati a school_type_enum del DB). */
export type NewsGrado = 'nido' | 'infanzia' | 'primaria'

/** Tipi di media associabili a un post. */
export const NEWS_MEDIA_TIPI = ['immagine', 'video', 'youtube', 'vimeo'] as const
export type NewsMediaTipo = (typeof NEWS_MEDIA_TIPI)[number]

export interface NewsCategoria {
  id: string
  scuola_id: string | null
  nome: string
  slug: string
  colore: string | null
  icona: string | null
  ordine: number
  is_sistema: boolean
  attivo: boolean
  created_at?: string
}

export interface NewsMedia {
  id: string
  post_id: string
  tipo: NewsMediaTipo | null
  url: string
  poster_url: string | null
  ordine: number
}

export interface NewsPost {
  id: string
  tipo: NewsTipo
  stato: NewsStato
  titolo: string
  contenuto_json: unknown | null
  contenuto_html: string | null
  contenuto_testo: string | null
  categoria_id: string | null
  programmata_il: string | null
  pubblicata_il: string | null
  pinned: boolean
  target_scope: NewsScope
  target_gradi: NewsGrado[] | null
  target_classes: string[] | null
  copertina_url: string | null
  instagram_url: string | null
  instagram_shortcode: string | null
  ig_check_falliti: number
  ig_check_il: string | null
  nascosta_motivo: string | null
  invia_notifica: boolean
  notifica_inviata_il: string | null
  approvata_da: string | null
  approvata_il: string | null
  scuola_id: string | null
  author_id: string
  created_at?: string
  updated_at?: string
}

export interface NewsDigestEdizione {
  id: string
  scuola_id: string
  anno: number
  mese: number
  titolo: string | null
  post_ids: string[] | null
  html: string | null
  generata_il: string
  inviata_il: string | null
  destinatari_count: number
  errori_count: number
}

/** Nomi dei mesi in italiano (indice 0 = Gennaio). */
export const MESI_IT = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
] as const
