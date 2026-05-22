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
      // ── Fase 3: Comunicazione e Multimedialità ──
      chat_threads: {
        Row: {
          id: string
          teacher_id: string
          parent_id: string
          student_id: string
          last_message_at: string
          created_at: string
        }
        Insert: {
          teacher_id: string
          parent_id: string
          student_id: string
          last_message_at?: string
        }
        Update: {
          last_message_at?: string
        }
      }
      chat_messages: {
        Row: {
          id: string
          thread_id: string
          sender_id: string
          content: string
          attachment_url: string | null
          attachment_type: string | null
          read_at: string | null
          created_at: string
        }
        Insert: {
          thread_id: string
          sender_id: string
          content: string
          attachment_url?: string | null
          attachment_type?: string | null
        }
        Update: {
          content?: string
          read_at?: string | null
        }
      }
      avvisi: {
        Row: {
          id: string
          author_id: string
          titolo: string
          contenuto: string
          tipo: string
          target_scope: string
          target_classes: string[] | null
          scadenza: string | null
          attachment_url: string | null
          created_at: string
        }
        Insert: {
          author_id: string
          titolo: string
          contenuto: string
          tipo?: string
          target_scope?: string
          target_classes?: string[] | null
          scadenza?: string | null
          attachment_url?: string | null
        }
        Update: {
          titolo?: string
          contenuto?: string
          tipo?: string
          target_scope?: string
          target_classes?: string[] | null
          scadenza?: string | null
          attachment_url?: string | null
        }
      }
      avvisi_risposte: {
        Row: {
          id: string
          avviso_id: string
          parent_id: string
          student_id: string
          letto_il: string | null
          risposta: string | null
          risposto_il: string | null
        }
        Insert: {
          avviso_id: string
          parent_id: string
          student_id: string
          letto_il?: string | null
          risposta?: string | null
          risposto_il?: string | null
        }
        Update: {
          letto_il?: string | null
          risposta?: string | null
          risposto_il?: string | null
        }
      }
      galleria_media_v2: {
        Row: {
          id: string
          uploaded_by: string
          file_url: string
          file_type: string
          caption: string | null
          tag_students: string[]
          is_broadcast: boolean
          target_classes: string[] | null
          created_at: string
        }
        Insert: {
          uploaded_by: string
          file_url: string
          file_type?: string
          caption?: string | null
          tag_students?: string[]
          is_broadcast?: boolean
          target_classes?: string[] | null
        }
        Update: {
          file_url?: string
          file_type?: string
          caption?: string | null
          tag_students?: string[]
          is_broadcast?: boolean
          target_classes?: string[] | null
        }
      }
      task_interni: {
        Row: {
          id: string
          author_id: string
          assigned_to: string | null
          target_class: string | null
          titolo: string
          contenuto: string
          completato: boolean
          created_at: string
        }
        Insert: {
          author_id: string
          titolo: string
          contenuto: string
          assigned_to?: string | null
          target_class?: string | null
          completato?: boolean
        }
        Update: {
          titolo?: string
          contenuto?: string
          assigned_to?: string | null
          target_class?: string | null
          completato?: boolean
        }
      }
    }
  }
}
