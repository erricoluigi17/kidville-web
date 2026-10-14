/** La stessa key per recupero e oblio, anche se il CAS di pdf_path non è riuscito. */
export const SIGNED_FORMS_BUCKET = 'form_attachments'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function signedSubmissionPath(schoolId: unknown, submissionId: unknown): string | null {
  return typeof schoolId === 'string' && UUID.test(schoolId) && typeof submissionId === 'string' && UUID.test(submissionId)
    ? `signed_forms/${schoolId}/${submissionId}.pdf` : null
}
export function pendingSignedSubmissionPath(submission: Record<string, unknown>): string | null {
  const log = submission.signature_log as { document_snapshot?: { school_id?: unknown } } | null
  return signedSubmissionPath(log?.document_snapshot?.school_id, submission.id)
}

/** Stato operativo interno: non è evidenza di firma e non entra nell'hash documentale. */
export const ARCHIVE_ERASURE = '_archive_erasure_pending'
export const ARCHIVE_WRITER = '_archive_writer_token'
export const ARCHIVE_WRITER_UNTIL = '_archive_writer_until'
export const ARCHIVE_INTERNAL_FIELDS = [ARCHIVE_ERASURE, ARCHIVE_WRITER, ARCHIVE_WRITER_UNTIL] as const
export function archiveErasurePending(log: unknown): boolean {
  return !!log && typeof log === 'object' && (log as Record<string, unknown>)[ARCHIVE_ERASURE] === true
}
