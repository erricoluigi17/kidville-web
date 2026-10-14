import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import type { FormField } from '@/types/database.types'
import { buildSignedDocumentSnapshot, freezeSignedDocument, SignedDocumentError, validateSubmissionAnswers } from './signed-document'
import { ensureSignedSubmissionPdf, type SignedSubmissionPdfResult } from './signed-archive'

export interface SignedSubmissionInput {
  form_id: string
  parent_id: string
  student_id?: string | null
  answers: Record<string, unknown>
  is_signed?: boolean
  signature_log?: unknown
  /** Nominativo già risolto dal gate della sessione; non dal body del client. */
  signer?: { id: string; nome?: string | null; cognome?: string | null }
}

export interface SignedSubmissionResult {
  submission?: Record<string, unknown>
  error?: string
  status: number
  pdf_ready?: boolean
  pdf_error?: SignedSubmissionPdfResult['pdf_error']
  pdf_message?: string
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
  const { form_id, parent_id, student_id, answers } = input

  // 1. Carica il template per verificare i campi e l'auto-aggiornamento anagrafica
  const { data: template, error: tempErr } = await supabase
    .from('forms_templates')
    .select('*')
    .eq('id', form_id)
    .single()

  if (tempErr || !template) {
    if (tempErr) logEvento('db', 'error', { operazione: 'forms/persist-submission', esito: 'modello-non-letto', entita_id: form_id }, tempErr)
    return { error: 'Form non trovato', status: 404 }
  }

  const fields: FormField[] = Array.isArray(template.fields) ? template.fields : []
  const invalidAnswer = validateSubmissionAnswers(fields, answers)
  if (invalidAnswer) return { error: invalidAnswer, status: 400 }
  let student: Record<string, unknown> | null = null
  if (student_id) {
    const result = await supabase.from('alunni').select('id, nome, cognome, scuola_id').eq('id', student_id).maybeSingle()
    if (result.error) {
      logEvento('db', 'error', { operazione: 'forms/persist-submission', esito: 'alunno-non-letto' }, result.error)
      return { error: 'Non è stato possibile verificare il bambino', status: 500 }
    }
    if (!result.data || !template.scuola_id || result.data.scuola_id !== template.scuola_id) return { error: 'La sede del modulo non corrisponde a quella del bambino', status: 403 }
    student = result.data
  }
  const is_signed = input.is_signed === true
  let signature_log: unknown = null
  if (is_signed) {
    let signer: Record<string, unknown> | undefined = input.signer
    if (signer && signer.id !== parent_id) return { error: 'Firmatario non valido', status: 400 }
    if (!signer) {
      const result = await supabase.from('utenti').select('id, nome, cognome').eq('id', parent_id).maybeSingle()
      if (result.error) {
        logEvento('db', 'error', { operazione: 'forms/persist-submission', esito: 'firmatario-non-letto' }, result.error)
        return { error: 'Non è stato possibile verificare il firmatario', status: 500 }
      }
      signer = result.data ?? undefined
    }
    try {
      const snapshot = buildSignedDocumentSnapshot({ template, student, signer: signer ?? {}, answers, signatureLog: input.signature_log, source: 'contemporaneous' })
      signature_log = freezeSignedDocument(input.signature_log, snapshot)
    } catch (error) {
      logEvento('modulistica', 'error', { operazione: 'forms/persist-submission', esito: error instanceof SignedDocumentError ? error.code : 'snapshot-fallito' }, error)
      return { error: 'Firma o contenuto documentale incompleti', status: 400 }
    }
  }

  // Il pre-check precede anche gli aggiornamenti anagrafici: una ri-firma respinta
  // non modifica i dati già presenti. L'indice unique è il backstop di concorrenza.
  if (is_signed && student_id) {
    const { data: giaFirmata, error: dupErr } = await supabase.from('forms_submissions').select('id')
      .eq('form_id', form_id).eq('student_id', student_id).eq('is_signed', true).limit(1).maybeSingle()
    if (dupErr) {
      logEvento('db', 'error', { operazione: 'forms/persist-submission', esito: 'duplicati-non-verificati' }, dupErr)
      return { error: 'Non è stato possibile verificare le firme esistenti', status: 500 }
    }
    if (giaFirmata) return { error: 'Esiste già una firma per questo modulo e alunno', status: 409 }
  }

  // 2. Auto-aggiornamento anagrafica dai campi mappati (es. "alunni.note_mediche", "utenti.cellulare")
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
        const { error } = await supabase.from('adults').update(adultsUpdates).eq('id', parent_id)
        if (error) logEvento('db', 'info', { operazione: 'forms/persist-submission', esito: 'compat-adults-non-aggiornata' }, error)
      }
    } catch (error) {
      logEvento('db', 'info', { operazione: 'forms/persist-submission', esito: 'compat-adults-non-disponibile' }, error)
    }
  }

  // Firma e snapshot durano insieme. Il percorso resta nullo fino a upload confermato.
  const record = {
    form_id,
    parent_id,
    student_id: student_id || null,
    answers,
    is_signed: !!is_signed,
    signature_log: signature_log || null,
    pdf_path: null,
  }

  const { data: submission, error: subErr } = await supabase
    .from('forms_submissions')
    .insert(record)
    .select()
    .single()

  if (subErr) {
    logEvento('db', 'error', { operazione: 'forms/persist-submission', esito: 'compilazione-non-salvata', entita_id: form_id }, subErr)
    // Backstop race-safe: l'indice unique parziale ha respinto una firma duplicata
    // arrivata in concorrenza col pre-check (M5) → 409, non 500.
    if ((subErr as { code?: string }).code === '23505') {
      return { error: 'Esiste già una firma per questo modulo e alunno', status: 409 }
    }
    return { error: 'Non è stato possibile salvare la compilazione', status: 500 }
  }
  if (!submission) return { error: 'Non è stato possibile salvare la compilazione', status: 500 }
  logEvento('modulistica', 'info', { operazione: 'forms/persist-submission', esito: is_signed ? 'firma-salvata' : 'compilazione-salvata', entita_id: submission.id })
  if (!is_signed) return { submission, status: 201, pdf_ready: false }
  const archived = await ensureSignedSubmissionPdf(supabase, submission.id)
  // La firma è già durevole: un guasto successivo non manda il genitore a firmare di nuovo.
  return { submission: archived.submission ?? submission, status: 201, pdf_ready: archived.pdf_ready, pdf_error: archived.pdf_error, pdf_message: archived.pdf_message }
}
