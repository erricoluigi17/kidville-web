import { acquireArchiveWriter, releaseArchiveWriter, archiveWriterOwns, archiveWriterMayUpload } from './signed-archive-state'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PDFDocument } from 'pdf-lib'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti } from '@/lib/storage/rimozione-verificata'
import { SIGNED_FORMS_BUCKET, signedSubmissionPath, ARCHIVE_ERASURE, ARCHIVE_WRITER, ARCHIVE_WRITER_UNTIL, archiveErasurePending } from './signed-path'
import { buildSignedPdfSuCarta } from './signed-pdf'
import {
  buildSignedDocumentSnapshot, freezeSignedDocument, recordOf,
  signatureEvidence, validSignatureEvidence, validateFrozenSignedDocument,
  SignedDocumentError, type SignedDocumentSnapshotV1, type SignedPdfErrorCode,
} from './signed-document'

export { SIGNED_FORMS_BUCKET } from './signed-path'
export interface SignedSubmissionPdfResult {
  submission?: Record<string, unknown>
  pdf_ready: boolean
  pdf_error?: SignedPdfErrorCode
  pdf_message?: string
  status: number
}
export interface SignedSubmissionDownloadResult {
  bytes?: Uint8Array
  content_type?: string
  pdf_error?: SignedPdfErrorCode
  pdf_message?: string
  status: number
}
const messages: Record<SignedPdfErrorCode, string> = {
  SUBMISSION_NOT_FOUND: 'Compilazione non trovata', SUBMISSION_NOT_SIGNED: 'Compilazione non firmata',
  SIGNATURE_INCOMPLETE: 'Evidenza della firma incompleta: documento non ricostruibile',
  TEMPLATE_MISSING: 'Modello non disponibile: documento non ricostruibile', SCHOOL_MISMATCH: 'La sede del modello non corrisponde al bambino',
  SIGNER_MISSING: 'Nominativo del firmatario non disponibile', STUDENT_MISSING: 'Nominativo del bambino non disponibile',
  SNAPSHOT_INVALID: 'Contenuto documentale o hash non validi', SNAPSHOT_CONFLICT: 'Il documento è stato modificato durante il recupero: riprova',
  SNAPSHOT_SAVE_FAILED: 'Non è stato possibile congelare il contenuto del documento',
  PDF_NOT_FOUND: 'PDF non ancora disponibile: prepara il documento', PDF_DOWNLOAD_FAILED: 'Non è stato possibile leggere il documento archiviato',
  PDF_GENERATION_FAILED: 'Firma salvata; la creazione del PDF non è riuscita. Puoi riprovare senza firmare di nuovo.',
  PDF_UPLOAD_FAILED: 'Firma salvata; l’archiviazione del PDF non è riuscita. Puoi riprovare senza firmare di nuovo.',
  PDF_PATH_SAVE_FAILED: 'Firma salvata; il PDF deve essere collegato alla compilazione. Puoi riprovare senza firmare di nuovo.',
  SUBMISSION_READ_FAILED: 'Non è stato possibile leggere la compilazione', PAPER_ORIGINAL_MISSING: 'Scansione originale non disponibile',
  SUBMISSION_ERASURE_PENDING: 'Il documento è in cancellazione e non è disponibile.',
  PDF_TOO_LARGE: 'Firma salvata; il PDF supera il limite dell’archivio e deve essere recuperato dalla segreteria.',
}
function publicSubmission(submission: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!submission) return undefined
  const log = recordOf(submission.signature_log)
  if (!log) return submission
  const signature_log = { ...log }; delete signature_log[ARCHIVE_WRITER]; delete signature_log[ARCHIVE_WRITER_UNTIL]
  return { ...submission, signature_log }
}
function failure(code: SignedPdfErrorCode, submission?: Record<string, unknown>, error?: unknown): SignedSubmissionPdfResult {
  logEvento('modulistica', 'error', { operazione: 'forms/signed-pdf', esito: code, entita_id: typeof submission?.id === 'string' ? submission.id : null }, error)
  const status = ['SUBMISSION_NOT_FOUND', 'TEMPLATE_MISSING', 'PDF_NOT_FOUND', 'PAPER_ORIGINAL_MISSING'].includes(code) ? 404 : ['SUBMISSION_NOT_SIGNED', 'SUBMISSION_ERASURE_PENDING'].includes(code) ? 409 :
    ['SIGNATURE_INCOMPLETE', 'SCHOOL_MISMATCH', 'SIGNER_MISSING', 'STUDENT_MISSING', 'SNAPSHOT_INVALID'].includes(code) ? 422 : 503
  return { submission: publicSubmission(submission), pdf_ready: false, pdf_error: code, pdf_message: messages[code], status }
}
function storageMissing(error: unknown): boolean {
  const e = recordOf(error)
  return e?.code === 'NoSuchKey' || e?.code === 'not_found' ||
    ((e?.statusCode === '404' || e?.statusCode === '400') && e?.message === 'Object not found')
}
function storageCollision(error: unknown): boolean {
  const e = recordOf(error)
  const status = Number(e?.status ?? e?.statusCode)
  if (!e || ('name' in e && e.name !== 'StorageApiError') || 'originalError' in e || status === 408 || status >= 500) return false
  return e?.code === 'ResourceAlreadyExists' || e?.code === 'Duplicate' ||
    ((e?.statusCode === '409' || e?.statusCode === '400') && ['The resource already exists', 'already exists'].includes(String(e?.message)))
}
/** Un rifiuto HTTP esplicito non avvia un commit. Timeout/5xx/esiti sconosciuti
 * possono invece arrivare dopo che Storage ha accettato il body. */
function storageRejected(error: unknown): boolean {
  const e = recordOf(error)
  if (!e || ('name' in e && e.name !== 'StorageApiError') || 'originalError' in e) return false
  return ['400', '401', '403', '404', '405', '413', '415', '422'].includes(String(e?.status ?? e?.statusCode ?? ''))
}
const PAPER_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
}
/** L'upload legacy salva octet-stream quando il browser non dichiara file.type. */
function paperContentType(bytes: Uint8Array, path: string, declared: string): string {
  const mime = declared.split(';')[0].trim().toLowerCase()
  if (Object.values(PAPER_MIME_BY_EXTENSION).includes(mime)) return mime
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (ascii(4, 4) === 'ftyp') {
    const boxSize = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) : 0
    const brands = [ascii(8, 4)]
    for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.byteLength, 256); offset += 4) brands.push(ascii(offset, 4))
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand))) return 'image/heic'
    if (brands.some((brand) => ['mif1', 'msf1', 'heif'].includes(brand))) return 'image/heif'
  }
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return PAPER_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}
async function storedBytes(supabase: SupabaseClient, path: string, expectedHash?: string, paper = false): Promise<SignedSubmissionDownloadResult> {
  try {
    const { data, error } = await supabase.storage.from(SIGNED_FORMS_BUCKET).download(path)
    if (error || !data) {
      if (error && storageMissing(error)) return { pdf_error: 'PDF_NOT_FOUND', status: 404 }
      logEvento('modulistica', 'error', { operazione: 'forms/signed-pdf', esito: 'PDF_DOWNLOAD_FAILED' }, error)
      return { pdf_error: 'PDF_DOWNLOAD_FAILED', status: 503 }
    }
    const bytes = new Uint8Array(await data.arrayBuffer())
    if (!paper) {
      const doc = await PDFDocument.load(bytes)
      if (doc.getPageCount() < 1 || (expectedHash && doc.getSubject() !== `kidville-signed-document:${expectedHash}`)) {
        logEvento('modulistica', 'error', { operazione: 'forms/signed-pdf', esito: 'archivio-hash-diverso' })
        return { pdf_error: 'PDF_DOWNLOAD_FAILED', status: 503 }
      }
    }
    return { bytes, content_type: paper ? paperContentType(bytes, path, data.type) : 'application/pdf', status: 200 }
  } catch (error) {
    logEvento('modulistica', 'error', { operazione: 'forms/signed-pdf', esito: 'PDF_DOWNLOAD_FAILED' }, error)
    return { pdf_error: 'PDF_DOWNLOAD_FAILED', status: 503 }
  }
}
/** Legge solo bytes già archiviati. Il chiamante deve aver autorizzato la riga. */
export async function downloadSignedSubmissionPdf(supabase: SupabaseClient, submission: Record<string, unknown>): Promise<SignedSubmissionDownloadResult> {
  if (archiveErasurePending(submission.signature_log)) return { pdf_error: 'SUBMISSION_ERASURE_PENDING', pdf_message: messages.SUBMISSION_ERASURE_PENDING, status: 409 }
  if (submission.is_signed !== true) return { pdf_error: 'SUBMISSION_NOT_SIGNED', pdf_message: messages.SUBMISSION_NOT_SIGNED, status: 409 }
  const paper = submission.origine === 'cartaceo'
  if (!paper && !validSignatureEvidence(submission.signature_log)) return { pdf_error: 'SIGNATURE_INCOMPLETE', pdf_message: messages.SIGNATURE_INCOMPLETE, status: 422 }
  const path = typeof submission.pdf_path === 'string' && submission.pdf_path.trim() ? submission.pdf_path : null
  if (!path) return { pdf_error: paper ? 'PAPER_ORIGINAL_MISSING' : 'PDF_NOT_FOUND', pdf_message: messages[paper ? 'PAPER_ORIGINAL_MISSING' : 'PDF_NOT_FOUND'], status: 404 }
  const log = recordOf(submission.signature_log)
  if (!paper && log && ('document_snapshot' in log || 'document_hash' in log)) {
    try { validateFrozenSignedDocument(submission) } catch (error) {
      const f = failure('SNAPSHOT_INVALID', submission, error)
      return { pdf_error: f.pdf_error, pdf_message: f.pdf_message, status: f.status }
    }
  }
  const result = await storedBytes(supabase, path, !paper && typeof log?.document_hash === 'string' ? log.document_hash : undefined, paper)
  return { ...result, ...(result.pdf_error ? { pdf_message: messages[result.pdf_error] } : {}) }
}

async function readSubmission(supabase: SupabaseClient, id: string) {
  return supabase.from('forms_submissions').select('*').eq('id', id).maybeSingle()
}
async function cleanupRevokedArchive(supabase: SupabaseClient, path: string, writerToken: string | undefined, known: Record<string, unknown> | null): Promise<void> {
  const token = recordOf(known?.signature_log)?.[ARCHIVE_WRITER]
  if ((typeof token === 'string' && token !== writerToken) || known?.protocollato === true || (typeof known?.protocollo_id === 'string' && known.protocollo_id.length > 0)) {
    logEvento('modulistica', 'info', { operazione: 'forms/signed-pdf', esito: 'pulizia-affidata-al-successore', n_file: 1 })
    return
  }
  // La lettura DB che ha accertato cancellazione/revoca precede ogni chiamata.
  // Un guasto DB conserva l'oggetto per il successivo recupero.
  const { riferimentoVivoAlPdf } = await import('@/lib/gdpr/moduli-genitori')
  if (await riferimentoVivoAlPdf(supabase, path, path.split('/').at(-1)!.replace(/\.pdf$/, ''))) {
    logEvento('modulistica', 'info', { operazione: 'forms/signed-pdf', esito: 'oblio-concorrente-file-condiviso', n_file: 1 })
    return
  }
  const removed = await rimuoviEVerifica(supabase, SIGNED_FORMS_BUCKET, [path], 'forms/signed-pdf:oblio-concorrente')
  logEvento('modulistica', removed.erroreRimozione || bloccanti(removed).length ? 'error' : 'info', { operazione: 'forms/signed-pdf', esito: 'oblio-concorrente', n_file: removed.rimossi.length })
}
/**
 * Recupero senza nuovo OTP. Snapshot CAS prima della generazione, oggetto immutabile,
 * percorso DB confermato dopo upload. Non importa sessioni/Next: utilizzabile dal batch.
 */
export async function ensureSignedSubmissionPdf(supabase: SupabaseClient, submissionId: string): Promise<SignedSubmissionPdfResult> {
  let submission: Record<string, unknown> | undefined
  let writerToken: string | undefined
  let uploadOutcomeCertain = true
  let stage: SignedPdfErrorCode = 'SUBMISSION_READ_FAILED'
  try {
    const read = await readSubmission(supabase, submissionId)
    if (read.error) return failure('SUBMISSION_READ_FAILED', undefined, read.error)
    if (!read.data) return failure('SUBMISSION_NOT_FOUND')
    submission = read.data as Record<string, unknown>
    if (archiveErasurePending(submission.signature_log)) return failure('SUBMISSION_ERASURE_PENDING', submission)
    if (submission.is_signed !== true) return failure('SUBMISSION_NOT_SIGNED', submission)
    if (submission.origine === 'cartaceo') {
      const original = await downloadSignedSubmissionPdf(supabase, submission)
      if (original.bytes) {
        const current = await readSubmission(supabase, submissionId)
        if (current.error) return failure('SUBMISSION_READ_FAILED', submission, current.error)
        if (!current.data || archiveErasurePending(current.data.signature_log)) return failure('SUBMISSION_ERASURE_PENDING', submission)
        return { submission: publicSubmission(current.data), pdf_ready: true, status: 200 }
      }
      return failure(original.pdf_error === 'PDF_NOT_FOUND' ? 'PAPER_ORIGINAL_MISSING' : original.pdf_error!, submission)
    }
    if (!validSignatureEvidence(submission.signature_log)) return failure('SIGNATURE_INCOMPLETE', submission)
    if (typeof submission.pdf_path === 'string' && submission.pdf_path.trim()) {
      const original = await downloadSignedSubmissionPdf(supabase, submission)
      if (original.bytes) {
        const current = await readSubmission(supabase, submissionId)
        if (current.error) return failure('SUBMISSION_READ_FAILED', submission, current.error)
        if (!current.data || archiveErasurePending(current.data.signature_log)) return failure('SUBMISSION_ERASURE_PENDING', submission)
        submission = current.data
        logEvento('modulistica', 'info', { operazione: 'forms/signed-pdf', esito: 'pdf-gia-archiviato', entita_id: submissionId })
        return { submission: publicSubmission(submission), pdf_ready: true, status: 200 }
      }
      if (original.pdf_error !== 'PDF_NOT_FOUND') return failure(original.pdf_error ?? 'PDF_DOWNLOAD_FAILED', submission)
    }
    let snapshot: SignedDocumentSnapshotV1
    const originalLog = recordOf(submission.signature_log)!
    if ('document_snapshot' in originalLog || 'document_hash' in originalLog) {
      snapshot = validateFrozenSignedDocument(submission)
    } else {
      const { data: template, error: templateError } = await supabase.from('forms_templates').select('*').eq('id', submission.form_id).maybeSingle()
      if (templateError) return failure('SUBMISSION_READ_FAILED', submission, templateError)
      if (!template) return failure('TEMPLATE_MISSING', submission)
      let student: Record<string, unknown> | null = null
      if (submission.student_id) {
        const result = await supabase.from('alunni').select('id, nome, cognome, scuola_id').eq('id', submission.student_id).maybeSingle()
        if (result.error) return failure('SUBMISSION_READ_FAILED', submission, result.error)
        if (!result.data) return failure('STUDENT_MISSING', submission)
        student = result.data
      }
      // La firma storica precede le modifiche all'anagrafica: quei nominativi hanno priorità.
      const details = recordOf(originalLog.parent_details)
      let signer: Record<string, unknown> = { ...details, id: submission.parent_id }
      if (!details?.nome || !details?.cognome) {
        const result = await supabase.from('utenti').select('id, nome, cognome').eq('id', submission.parent_id).maybeSingle()
        if (result.error) return failure('SUBMISSION_READ_FAILED', submission, result.error)
        if (!result.data) return failure('SIGNER_MISSING', submission)
        signer = {
          ...result.data,
          nome: details?.nome || result.data.nome,
          cognome: details?.cognome || result.data.cognome,
        }
      }
      snapshot = buildSignedDocumentSnapshot({ template, student, signer, answers: submission.answers, signatureLog: originalLog, source: 'reconstructed' })
      const frozen = freezeSignedDocument(originalLog, snapshot)
      stage = 'SNAPSHOT_SAVE_FAILED'
      const saved = await supabase.from('forms_submissions').update({ signature_log: frozen }).eq('id', submissionId)
        .eq('is_signed', true).filter('signature_log', 'eq', JSON.stringify(originalLog)).select('*').maybeSingle()
      if (saved.error) return failure('SNAPSHOT_SAVE_FAILED', submission, saved.error)
      if (saved.data) submission = saved.data
      else {
        stage = 'SUBMISSION_READ_FAILED'
        const winner = await readSubmission(supabase, submissionId)
        if (winner.error) return failure('SUBMISSION_READ_FAILED', submission, winner.error)
        if (!winner.data) return failure('SNAPSHOT_CONFLICT', submission)
        if (archiveErasurePending(winner.data.signature_log)) return failure('SUBMISSION_ERASURE_PENDING', winner.data)
        submission = winner.data
      }
      snapshot = validateFrozenSignedDocument(submission!)
    }
    let current = submission!
    const hash = String(recordOf(current.signature_log)!.document_hash)
    const path = signedSubmissionPath(snapshot.school_id, submissionId)!
    // Si consulta sempre la key deterministica: un upload riuscito seguito da DB guasto
    // viene recuperato senza ricreare bytes, e un 403/503 non diventa un "file assente".
    let existing = await storedBytes(supabase, path, hash)
    if (!existing.bytes && existing.pdf_error !== 'PDF_NOT_FOUND') return failure('PDF_DOWNLOAD_FAILED', current)
    if (!existing.bytes) {
      const claim = await acquireArchiveWriter(supabase, submissionId, hash)
      if (!claim.row || !claim.token) return failure(claim.error ?? 'SNAPSHOT_CONFLICT', current)
      writerToken = claim.token
      current = claim.row
      existing = await storedBytes(supabase, path, hash)
      if (!existing.bytes && existing.pdf_error !== 'PDF_NOT_FOUND') return failure('PDF_DOWNLOAD_FAILED', current)
    }
    if (!existing.bytes) {
      let bytes: Uint8Array
      try {
        bytes = await buildSignedPdfSuCarta({ submissionId, snapshot, signatureLog: signatureEvidence(current.signature_log), contentHash: hash })
      } catch (error) { return failure('PDF_GENERATION_FAILED', current, error) }
      if (bytes.byteLength > 8 * 1024 * 1024) return failure('PDF_TOO_LARGE', current)
      const allowed = await readSubmission(supabase, submissionId)
      if (allowed.error) return failure('SUBMISSION_READ_FAILED', current, allowed.error)
      if (!allowed.data || archiveErasurePending(allowed.data.signature_log)) return failure('SUBMISSION_ERASURE_PENDING', current)
      if (!writerToken || !archiveWriterMayUpload(allowed.data, writerToken)) return failure('SNAPSHOT_CONFLICT', current)
      stage = 'PDF_UPLOAD_FAILED'
      // L'abort del fetch NON annulla il commit lato Storage. Finché non abbiamo
      // un esito certo, il lease durevole deve sopravvivere anche a questo finally.
      uploadOutcomeCertain = false
      const uploaded = await supabase.storage.from(SIGNED_FORMS_BUCKET).upload(path, bytes, { upsert: false, contentType: 'application/pdf' })
      if (uploaded.error) {
        uploadOutcomeCertain = storageCollision(uploaded.error) || storageRejected(uploaded.error)
        if (!storageCollision(uploaded.error)) return failure('PDF_UPLOAD_FAILED', current, uploaded.error)
        const winner = await storedBytes(supabase, path, hash)
        if (!winner.bytes) return failure('PDF_UPLOAD_FAILED', current, uploaded.error)
      } else if (!uploaded.data) return failure('PDF_UPLOAD_FAILED', current)
      else uploadOutcomeCertain = true
    }
    if (writerToken) {
      const owner = await readSubmission(supabase, submissionId)
      if (owner.error) return failure('SUBMISSION_READ_FAILED', current, owner.error)
      if (!owner.data || owner.data.is_signed !== true || archiveErasurePending(owner.data.signature_log)) {
        await cleanupRevokedArchive(supabase, path, writerToken, owner.data)
        return failure('SUBMISSION_ERASURE_PENDING', current)
      }
      if (!archiveWriterOwns(owner.data, writerToken)) return failure('SNAPSHOT_CONFLICT', current)
    }
    if (current.pdf_path !== path) {
      stage = 'PDF_PATH_SAVE_FAILED'
      let update = supabase.from('forms_submissions').update({ pdf_path: path }).eq('id', submissionId)
        .eq('is_signed', true).eq('signature_log->>document_hash', hash).is(`signature_log->>${ARCHIVE_ERASURE}`, null)
      if (writerToken) update = update.eq(`signature_log->>${ARCHIVE_WRITER}`, writerToken)
      update = current.pdf_path == null ? update.is('pdf_path', null) : update.eq('pdf_path', current.pdf_path)
      const saved = await update.select('*').maybeSingle()
      if (saved.error) {
        const known = await readSubmission(supabase, submissionId)
        if (!known.error && (!known.data || archiveErasurePending(known.data.signature_log))) {
          await cleanupRevokedArchive(supabase, path, writerToken, known.data)
          return failure('SUBMISSION_ERASURE_PENDING', current)
        }
        return failure('PDF_PATH_SAVE_FAILED', current, saved.error)
      }
      if (!saved.data) {
        const winner = await readSubmission(supabase, submissionId)
        if (winner.error) return failure('SUBMISSION_READ_FAILED', current, winner.error)
        if (!winner.data || winner.data.is_signed !== true || archiveErasurePending(winner.data.signature_log)) {
          // L'oblio può aver tolto file e riga mentre l'upload era in volo. Si pulisce
          // solo dopo una lettura riuscita: un guasto DB conserva il file recuperabile.
          await cleanupRevokedArchive(supabase, path, writerToken, winner.data)
          return failure(winner.data && archiveErasurePending(winner.data.signature_log) ? 'SUBMISSION_ERASURE_PENDING' : 'SUBMISSION_NOT_FOUND', current)
        }
        if (winner.data.pdf_path !== path) return failure('SNAPSHOT_CONFLICT', current)
        validateFrozenSignedDocument(winner.data)
        submission = winner.data
      } else {
        validateFrozenSignedDocument(saved.data)
        submission = saved.data
      }
    }
    // Anche una riga con pdf_path già deterministico può essere cancellata mentre
    // si rigenera l'oggetto: lì il CAS è superfluo ma la verifica finale no.
    const confirmed = await readSubmission(supabase, submissionId)
    if (confirmed.error) return failure('SUBMISSION_READ_FAILED', current, confirmed.error)
    if (!confirmed.data || confirmed.data.is_signed !== true || archiveErasurePending(confirmed.data.signature_log)) {
      await cleanupRevokedArchive(supabase, path, writerToken, confirmed.data)
      return failure(confirmed.data && archiveErasurePending(confirmed.data.signature_log) ? 'SUBMISSION_ERASURE_PENDING' : 'SUBMISSION_NOT_FOUND', current)
    }
    if (writerToken && !archiveWriterOwns(confirmed.data, writerToken)) return failure('SNAPSHOT_CONFLICT', current)
    validateFrozenSignedDocument(confirmed.data)
    if (confirmed.data.pdf_path !== path || recordOf(confirmed.data.signature_log)?.document_hash !== hash) return failure('SNAPSHOT_CONFLICT', current)
    submission = confirmed.data
    logEvento('modulistica', 'info', { operazione: 'forms/signed-pdf', esito: 'pdf-archiviato', entita_id: submissionId })
    return { submission: publicSubmission(submission), pdf_ready: true, status: 200 }
  } catch (error) {
    return failure(error instanceof SignedDocumentError ? error.code : stage, submission, error)
  } finally {
    if (writerToken && !uploadOutcomeCertain) {
      logEvento('modulistica', 'warn', { operazione: 'forms/signed-pdf', esito: 'upload-incerto-lease-conservato', entita_id: submissionId, n: 1 })
    } else if (writerToken) {
      try { await releaseArchiveWriter(supabase, submissionId, writerToken) }
      catch (error) { logEvento('modulistica', 'error', { operazione: 'forms/signed-pdf', esito: 'writer-non-rilasciato', n: 1 }, error) }
    }
  }
}
