import { ARCHIVE_INTERNAL_FIELDS } from './signed-path'
import { z } from 'zod'
import { canonicalJson, computeContentHash } from '@/lib/fea/receipt-pdf'
import { campoVisibile } from './conditional'
import { validateField } from './validate-fields'
import type { FormField } from '@/types/database.types'

export const SIGNED_PDF_ERROR_CODES = [
  'SUBMISSION_NOT_FOUND', 'SUBMISSION_NOT_SIGNED', 'SIGNATURE_INCOMPLETE',
  'TEMPLATE_MISSING', 'SCHOOL_MISMATCH', 'SIGNER_MISSING', 'STUDENT_MISSING',
  'SNAPSHOT_INVALID', 'SNAPSHOT_CONFLICT', 'SNAPSHOT_SAVE_FAILED', 'PDF_NOT_FOUND',
  'PDF_DOWNLOAD_FAILED', 'PDF_GENERATION_FAILED', 'PDF_UPLOAD_FAILED', 'PDF_PATH_SAVE_FAILED',
  'SUBMISSION_READ_FAILED', 'PAPER_ORIGINAL_MISSING', 'PDF_TOO_LARGE', 'SUBMISSION_ERASURE_PENDING',
] as const
export type SignedPdfErrorCode = typeof SIGNED_PDF_ERROR_CODES[number]
export class SignedDocumentError extends Error {
  readonly code: SignedPdfErrorCode
  constructor(code: SignedPdfErrorCode, message: string) { super(message); this.code = code; this.name = 'SignedDocumentError' }
}

const dateSchema = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)), 'Istante non valido')
const personSchema = z.object({ id: z.uuid(), nome: z.string().trim().min(1), cognome: z.string().trim().min(1) })
const fieldSchema = z.object({
  id: z.string().min(1), label: z.string(), type: z.string().min(1), required: z.boolean(),
  options: z.array(z.object({ label: z.string(), value: z.string() })),
  text: z.string().optional(), link: z.string().optional(), link_label: z.string().optional(),
  condition: z.object({ field_id: z.string(), operator: z.enum(['eq', 'neq', 'contains', 'gt', 'lt']), value: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
})
export const signedDocumentSnapshotSchema = z.object({
  version: z.literal(1), source: z.enum(['contemporaneous', 'reconstructed']),
  reconstructed_at: dateSchema.nullable(),
  form: z.object({ id: z.uuid(), title: z.string().min(1), description: z.string(), fields: z.array(fieldSchema) }),
  school_id: z.uuid(), student: personSchema.nullable(), signer: personSchema,
  answers: z.record(z.string(), z.unknown()), signed_at: dateSchema,
}).superRefine((value, ctx) => {
  if ((value.source === 'reconstructed') !== (value.reconstructed_at !== null)) ctx.addIssue({ code: 'custom', message: 'Origine e data ricostruzione incoerenti' })
})
export type SignedDocumentSnapshotV1 = z.infer<typeof signedDocumentSnapshotSchema>
export type SignedSignatureLog = Record<string, unknown> & { document_snapshot: SignedDocumentSnapshotV1; document_hash: string }

export function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
/** Tutte le evidenze originali entrano nell'hash, tranne l'estensione documentale stessa. */
export function signatureEvidence(signatureLog: unknown): Record<string, unknown> {
  const evidence = { ...recordOf(signatureLog) }
  delete evidence.document_snapshot
  delete evidence.document_hash
  for (const field of ARCHIVE_INTERNAL_FIELDS) delete evidence[field]
  return evidence
}
export function signatureSignedAt(signatureLog: unknown): string | null {
  const log = recordOf(signatureLog)
  const parsed = dateSchema.safeParse(log?.signed_at ?? log?.timestamp)
  return parsed.success ? parsed.data : null
}
export function validSignatureEvidence(signatureLog: unknown): boolean {
  const log = recordOf(signatureLog)
  return !!log && !!signatureSignedAt(log) &&
    (log.method === 'CONFERMA_APP' || (log.method === 'OTP_EMAIL' && typeof log.hash === 'string' && log.hash.trim().length > 0))
}
export function readSignedDocumentSnapshot(signatureLog: unknown): SignedDocumentSnapshotV1 | null {
  const result = signedDocumentSnapshotSchema.safeParse(recordOf(signatureLog)?.document_snapshot)
  return result.success ? result.data : null
}

/** Validazione condivisa server; una checkbox obbligatoria non accetta coercizioni truthy. */
export function validateSubmissionAnswers(fields: FormField[], answers: Record<string, unknown>): string | null {
  for (const field of fields) {
    if (!campoVisibile(field, answers)) continue
    if (field.required && (field.type === 'checkbox' || field.type === 'consent') && answers[field.id] !== true) return `Devi accettare il campo «${field.label}»`
    // Il validatore generico gestisce checkbox a selezione multipla come array.
    // Qui le spunte d'autorizzazione sono booleani: true è già validato sopra.
    if ((field.type === 'checkbox' || field.type === 'consent') && typeof answers[field.id] === 'boolean') continue
    const error = validateField(field, answers[field.id])
    if (error) return `${field.label}: ${error}`
  }
  return null
}

export interface BuildSignedDocumentSnapshotInput {
  template: Record<string, unknown>
  student: Record<string, unknown> | null
  signer: Record<string, unknown>
  answers: unknown
  signatureLog: unknown
  source: SignedDocumentSnapshotV1['source']
  reconstructedAt?: string
}
/** Dati da DB/gate, mai da nominativi o schema inviati nel body del client. */
export function buildSignedDocumentSnapshot(input: BuildSignedDocumentSnapshotInput): SignedDocumentSnapshotV1 {
  if (!validSignatureEvidence(input.signatureLog)) throw new SignedDocumentError('SIGNATURE_INCOMPLETE', 'Evidenza della firma incompleta')
  if (input.student && input.student.scuola_id !== input.template.scuola_id) throw new SignedDocumentError('SCHOOL_MISMATCH', 'La sede del modulo non corrisponde a quella del bambino')
  if (!personSchema.safeParse(input.signer).success) throw new SignedDocumentError('SIGNER_MISSING', 'Nominativo del firmatario non disponibile')
  if (input.student && !personSchema.safeParse(input.student).success) throw new SignedDocumentError('STUDENT_MISSING', 'Nominativo del bambino non disponibile')
  const fields = Array.isArray(input.template.fields) ? input.template.fields as FormField[] : []
  const candidate = {
    version: 1, source: input.source,
    reconstructed_at: input.source === 'reconstructed' ? input.reconstructedAt ?? new Date().toISOString() : null,
    form: { id: input.template.id, title: input.template.title, description: input.template.description ?? '', fields: fields.map((f) => ({
      id: f.id, label: f.label, type: f.type, required: f.required === true,
      options: (f.options ?? []).map((o) => ({ label: o.label, value: o.value })),
      ...(f.text !== undefined ? { text: f.text } : {}), ...(f.link !== undefined ? { link: f.link } : {}),
      ...(f.link_label !== undefined ? { link_label: f.link_label } : {}), ...(f.condition ? { condition: f.condition } : {}),
    })) },
    school_id: input.template.scuola_id, student: input.student, signer: input.signer,
    answers: input.answers, signed_at: signatureSignedAt(input.signatureLog),
  }
  const result = signedDocumentSnapshotSchema.safeParse(candidate)
  if (!result.success) throw new SignedDocumentError('SNAPSHOT_INVALID', 'Contenuto documentale incompleto')
  // JSON clone impedisce che mutazioni successive delle risposte tocchino lo snapshot.
  return JSON.parse(JSON.stringify(result.data)) as SignedDocumentSnapshotV1
}
export function freezeSignedDocument(signatureLog: unknown, snapshot: SignedDocumentSnapshotV1): SignedSignatureLog {
  const evidence = signatureEvidence(signatureLog)
  const state = recordOf(signatureLog)
  const internal = Object.fromEntries(ARCHIVE_INTERNAL_FIELDS.filter((field) => state && field in state).map((field) => [field, state![field]]))
  return { ...evidence, ...internal, document_snapshot: snapshot, document_hash: computeContentHash(snapshot, evidence) }
}
/** Un'estensione già presente e corrotta non viene silenziosamente riscritta. */
export function validateFrozenSignedDocument(submission: Record<string, unknown>): SignedDocumentSnapshotV1 {
  const log = recordOf(submission.signature_log)
  const snapshot = readSignedDocumentSnapshot(log)
  if (!snapshot || !validSignatureEvidence(log) || snapshot.signed_at !== signatureSignedAt(log) ||
    snapshot.form.id !== submission.form_id || snapshot.signer.id !== submission.parent_id ||
    (snapshot.student?.id ?? null) !== (submission.student_id ?? null) ||
    canonicalJson(snapshot.answers) !== canonicalJson(submission.answers) ||
    log?.document_hash !== computeContentHash(snapshot, signatureEvidence(log))) {
    throw new SignedDocumentError('SNAPSHOT_INVALID', 'Snapshot o hash del documento non validi')
  }
  return snapshot
}
