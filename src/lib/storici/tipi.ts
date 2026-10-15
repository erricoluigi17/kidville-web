import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import type { CategoriaStorico, RichiestaStorico } from './catalogo'

export interface AlunnoStorico { id: string; nome: string; cognome: string; scuola_id: string; section_id: string | null; archiviato_il?: string | null }
export interface AppartenenzaStorica { alunno_id: string; scuola_id: string; section_id: string; section_nome?: string; dal: string; al: string | null }
export interface ContestoStorico {
  db: SupabaseClient
  utente: AppUser
  richiesta: RichiestaStorico
  alunni: AlunnoStorico[]
  appartenenze: AppartenenzaStorica[]
  scuolaNome: string
  titolo: string
  avvisi: string[]
}
export interface ColonnaStorico { chiave: string; titolo: string }
export type CellaStorico = string | number | boolean | null
export interface AllegatoStorico { bucket: string; percorso: string; nome: string; mime?: string; alunnoId?: string }
export interface SezioneStorico {
  categoria: CategoriaStorico
  titolo: string
  colonne: ColonnaStorico[]
  righe: Record<string, CellaStorico>[]
  allegati: AllegatoStorico[]
  generati?: Array<{ nome: string; mime: string; base64: string; alunnoId?: string }>
  avvisi: string[]
}
export interface DocumentoStorico { titolo: string; scuolaNome: string; dal: string; al: string; generatoIl: string; sezioni: SezioneStorico[]; avvisi: string[] }
export const BUCKET_STORICI = 'storici-stampe'
export type StatoGenerazione = 'in_coda' | 'in_corso' | 'completato' | 'parziale' | 'errore'
export interface GenerazioneStorico {
  id: string; scuola_id: string; richiesto_da: string | null; richiesta: RichiestaStorico; stato: StatoGenerazione
  cursore: number; tentativi: number; preso_il: string | null; creato_il: string; scade_il: string
  file_path: string | null; errore: string | null; avvisi: string[]; titolo: string | null
  /** Impronta dei ruoli reali di lavoro, indipendente dalla veste e dal ponte genitore. */
  ruolo_richiedente: string; alunni_ids: string[]
}
