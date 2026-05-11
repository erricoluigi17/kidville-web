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
    }
  }
}
