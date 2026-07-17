import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

export interface SignedSubmissionInput {
  form_id: string
  parent_id: string
  student_id?: string | null
  answers: Record<string, unknown>
  is_signed?: boolean
  signature_log?: unknown
}

export interface SignedSubmissionResult {
  submission?: Record<string, unknown>
  error?: string
  status: number
}

/**
 * Persistenza condivisa di una sottomissione modulo del genitore:
 *  1. carica il template (`forms_templates`)
 *  2. auto-aggiorna l'anagrafica (alunni / utenti) dai campi mappati via `db_mapping`
 *  3. inserisce la riga in `forms_submissions`
 *
 * Usata sia dal POST diretto (/api/parent/submissions) sia dalla firma OTP
 * (/api/parent/forms/otp) così la logica resta una sola.
 */
export async function persistSignedSubmission(
  supabase: SupabaseClient,
  input: SignedSubmissionInput
): Promise<SignedSubmissionResult> {
  const { form_id, parent_id, student_id, answers, is_signed, signature_log } = input

  // 1. Carica il template per verificare i campi e l'auto-aggiornamento anagrafica
  const { data: template, error: tempErr } = await supabase
    .from('forms_templates')
    .select('*')
    .eq('id', form_id)
    .single()

  if (tempErr || !template) {
    return { error: 'Form non trovato', status: 404 }
  }

  // 2. Auto-aggiornamento anagrafica dai campi mappati (es. "alunni.note_mediche", "utenti.cellulare")
  const fields = template.fields || []
  const studentUpdates: Record<string, unknown> = {}
  const parentUpdates: Record<string, unknown> = {}

  for (const field of fields) {
    const answerValue = answers[field.id]
    if (answerValue !== undefined && answerValue !== null && answerValue !== '') {
      const mapping = field.db_mapping
      if (mapping && typeof mapping === 'string') {
        const [table, column] = mapping.split('.')
        if (table === 'alunni' && student_id) {
          studentUpdates[column] = answerValue
        } else if (table === 'utenti') {
          parentUpdates[column] = answerValue
        }
      }
    }
  }

  if (Object.keys(studentUpdates).length > 0 && student_id) {
    const { error: studentErr } = await supabase
      .from('alunni')
      .update(studentUpdates)
      .eq('id', student_id)
    // PostgREST non lancia: si controlla il valore di ritorno. L'auto-aggiornamento
    // anagrafica è best-effort (la firma resta valida), ma un fallimento va tracciato.
    if (studentErr) logEvento('db', 'error', { operazione: 'forms/persist-submission', azione: 'auto_update_alunno', esito: 'fallito' }, studentErr)
  }

  if (Object.keys(parentUpdates).length > 0) {
    const { error: parentErr } = await supabase
      .from('utenti')
      .update(parentUpdates)
      .eq('id', parent_id)
    if (parentErr) logEvento('db', 'error', { operazione: 'forms/persist-submission', azione: 'auto_update_genitore', esito: 'fallito' }, parentErr)

    // Aggiorna anche adults per compatibilità (se la tabella esiste)
    try {
      const adultsUpdates: Record<string, unknown> = {}
      if (parentUpdates.nome) adultsUpdates.first_name = parentUpdates.nome
      if (parentUpdates.cognome) adultsUpdates.last_name = parentUpdates.cognome
      if (parentUpdates.cellulare) adultsUpdates.phones = [parentUpdates.cellulare]
      if (Object.keys(adultsUpdates).length > 0) {
        await supabase.from('adults').update(adultsUpdates).eq('id', parent_id)
      }
    } catch {
      // tabella adults non presente: skip
    }
  }

  // 2-bis. Ri-firma vietata (M5): una sola submission FIRMATA per (form_id, student_id).
  // Difesa in profondità: pre-check applicativo (409 deterministico e testabile) +
  // indice unique parziale su forms_submissions(form_id, student_id) WHERE is_signed
  // (backstop race-safe, gestito sotto sul 23505 dell'INSERT). Solo con student_id:
  // l'onboarding (student_id assente) resta non vincolato, coerente con l'indice.
  if (is_signed && student_id) {
    const { data: giaFirmata, error: dupErr } = await supabase
      .from('forms_submissions')
      .select('id')
      .eq('form_id', form_id)
      .eq('student_id', student_id)
      .eq('is_signed', true)
      .limit(1)
      .maybeSingle()
    // PostgREST non lancia: se `is_signed` non esiste (DB E2E CI) → 42703, si degrada
    // pulito saltando il pre-check (il vincolo DB, se presente, resta il backstop).
    if (!dupErr && giaFirmata) {
      return { error: 'Esiste già una firma per questo modulo e alunno', status: 409 }
    }
  }

  // 3. Salva la sottomissione (path PDF simulato per l'archiviazione)
  const randomName = Math.random().toString(36).substring(2, 10)
  const pdfPath = `signed_forms/${form_id}/${student_id || 'onboarding'}_${randomName}.pdf`

  const record = {
    form_id,
    parent_id,
    student_id: student_id || null,
    answers,
    is_signed: !!is_signed,
    signature_log: signature_log || null,
    pdf_path: pdfPath,
  }

  const { data: submission, error: subErr } = await supabase
    .from('forms_submissions')
    .insert(record)
    .select()
    .single()

  if (subErr) {
    // Backstop race-safe: l'indice unique parziale ha respinto una firma duplicata
    // arrivata in concorrenza col pre-check (M5) → 409, non 500.
    if ((subErr as { code?: string }).code === '23505') {
      return { error: 'Esiste già una firma per questo modulo e alunno', status: 409 }
    }
    return { error: subErr.message, status: 500 }
  }

  return { submission, status: 201 }
}
