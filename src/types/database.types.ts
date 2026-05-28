export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// ─── Form Management — tipi JSONB strutturati ────────────────

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'phone'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'signature'
  | 'section_header'
  | 'paragraph'

export interface FormFieldOption {
  label: string
  value: string
  /** Punteggio assegnato alla scelta per lo scoring automatico */
  points?: number
}

export interface FormFieldCondition {
  field_id: string
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt'
  value: string | number | boolean
}

export interface FormFieldValidation {
  min?: number
  max?: number
  pattern?: string
  min_length?: number
  max_length?: number
}

export interface FormField {
  id: string
  type: FormFieldType
  label: string
  placeholder?: string
  required?: boolean
  /** Punteggio base del campo per graduatorie e scoring */
  points?: number
  options?: FormFieldOption[]
  /** Logica condizionale: mostra/nascondi in base a un altro campo */
  condition?: FormFieldCondition
  /** Mapping verso colonna DB per ETL (es. "adults.fiscal_code") */
  db_mapping?: string
  validation?: FormFieldValidation
}

/** Una pagina/step del wizard — mappata 1:1 a uno step Framer Motion */
export interface FormPage {
  id: string
  title: string
  description?: string
  fields: FormField[]
}

export interface FormScoringConfig {
  enabled: boolean
  /** Punteggio massimo raggiungibile */
  max_score?: number
  /** Soglia di superamento (es. 60 su 100) */
  passing_threshold?: number
  /** Moltiplicatori per campo: { field_id: weight } */
  weights?: Record<string, number>
}

/**
 * Struttura del campo `schema` in form_models.
 * Pensata per mappare direttamente il wizard Framer Motion:
 *   - `pages` → ogni step del wizard
 *   - `scoring` → calcolo automatico graduatorie
 */
export interface FormSchemaConfig {
  version: string
  pages: FormPage[]
  scoring?: FormScoringConfig
  settings?: {
    allow_save_draft?: boolean
    show_progress_bar?: boolean
    show_page_numbers?: boolean
    submit_confirmation_message?: string
  }
}

/** Risposta dell'utente: { field_id → valore } */
export type FormSubmissionData = Record<
  string,
  string | number | boolean | string[] | null
>

export type FormSubmissionStatus = 'draft' | 'pending_signature' | 'completed'

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
      // ── Fase 5: Form Management — Modelli Dinamici ──
      form_models: {
        Row: {
          id: string
          title: string
          description: string | null
          /** FormSchemaConfig serializzato: pages, scoring, settings */
          schema: FormSchemaConfig
          is_active: boolean
          requires_signature: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          title: string
          description?: string | null
          schema?: FormSchemaConfig
          is_active?: boolean
          requires_signature?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          title?: string
          description?: string | null
          schema?: FormSchemaConfig
          is_active?: boolean
          requires_signature?: boolean
          updated_at?: string
        }
      }
      form_submissions: {
        Row: {
          id: string
          model_id: string
          /** Null per compilazioni guest (genitore non ancora registrato) */
          user_id: string | null
          /** FormSubmissionData serializzato: { field_id → valore } */
          data: FormSubmissionData
          status: FormSubmissionStatus
          /** Hash SHA-256 del segreto OTP — mai memorizzato in chiaro */
          otp_secret: string | null
          signed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          model_id: string
          user_id?: string | null
          data?: FormSubmissionData
          status?: FormSubmissionStatus
          otp_secret?: string | null
          signed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          data?: FormSubmissionData
          status?: FormSubmissionStatus
          otp_secret?: string | null
          signed_at?: string | null
          updated_at?: string
        }
      }
    }
  }
}
