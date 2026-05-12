export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      adults: {
        Row: {
          id: string
          first_name: string
          last_name: string
          gender: string | null
          birth_date: string | null
          birth_place: string | null
          fiscal_code: string | null
          document_type: string | null
          document_number: string | null
          iban: string | null
          address: string | null
          emails: string[] | null
          phones: string[] | null
          role: string
          created_at: string
        }
        Insert: {
          id: string
          first_name: string
          last_name: string
          gender?: string | null
          birth_date?: string | null
          birth_place?: string | null
          fiscal_code?: string | null
          document_type?: string | null
          document_number?: string | null
          iban?: string | null
          address?: string | null
          emails?: string[] | null
          phones?: string[] | null
          role?: string
          created_at?: string
        }
        Update: {
          first_name?: string
          last_name?: string
          gender?: string | null
          birth_date?: string | null
          birth_place?: string | null
          fiscal_code?: string | null
          document_type?: string | null
          document_number?: string | null
          iban?: string | null
          address?: string | null
          emails?: string[] | null
          phones?: string[] | null
          role?: string
        }
      }
      student_adults: {
        Row: {
          student_id: string
          adult_id: string
          relationship_role: string | null
          is_invoice_holder: boolean
          can_pickup: boolean
          can_view_diary: boolean
        }
        Insert: {
          student_id: string
          adult_id: string
          relationship_role?: string | null
          is_invoice_holder?: boolean
          can_pickup?: boolean
          can_view_diary?: boolean
        }
        Update: {
          relationship_role?: string | null
          is_invoice_holder?: boolean
          can_pickup?: boolean
          can_view_diary?: boolean
        }
      }
      educator_sections: {
        Row: {
          educator_id: string
          section_id: string
        }
        Insert: {
          educator_id: string
          section_id: string
        }
        Update: {
          educator_id?: string
          section_id?: string
        }
      }
      eventi_diario: {
        Row: {
          id: string
          alunno_id: string
          maestra_id: string
          tipo_evento: string
          orario_inizio: string
          orario_fine: string | null
          dettagli: Record<string, unknown> | null
          nota_libera: string | null
          activity_description: string | null
          pubblicato: boolean
          created_at: string
        }
        Insert: {
          alunno_id: string
          maestra_id: string
          tipo_evento: string
          orario_inizio?: string
          orario_fine?: string | null
          dettagli?: Record<string, unknown> | null
          nota_libera?: string | null
          activity_description?: string | null
          pubblicato?: boolean
        }
        Update: {
          dettagli?: Record<string, unknown> | null
          orario_fine?: string | null
          nota_libera?: string | null
          activity_description?: string | null
          pubblicato?: boolean
        }
      }
      armadietto: {
        Row: {
          id: string
          alunno_id: string
          materiale: string
          quantita: number
          date: string
          portato: boolean
          created_at: string | null
        }
        Insert: {
          id?: string
          alunno_id: string
          materiale: string
          quantita?: number
          date?: string
          portato?: boolean
          created_at?: string | null
        }
        Update: {
          materiale?: string
          quantita?: number
          date?: string
          portato?: boolean
        }
      }
    }
  }
}
