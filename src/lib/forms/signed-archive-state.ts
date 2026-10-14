import type { SupabaseClient } from '@supabase/supabase-js'
import { recordOf } from './signed-document'
import { ARCHIVE_ERASURE, ARCHIVE_WRITER, ARCHIVE_WRITER_UNTIL, archiveErasurePending } from './signed-path'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { tettoMsArea } from '@/lib/logging/supabase-fetch'
type Row = Record<string, unknown>
// Il lease supera il tetto Storage server (20s) e viene ricontrollato prima
// dell’upload con 10s di margine: nessun upload parte a ridosso della scadenza.
// Un processo terminato non blocca l’oblio per sempre; token scaduti non confermano.
const WRITER_LEASE_MS = 10 * 60 * 1000
export function archiveWriterActive(row: Row): boolean {
  const log = recordOf(row.signature_log)
  if (typeof log?.[ARCHIVE_WRITER] !== 'string') return false
  const until = Date.parse(String(log[ARCHIVE_WRITER_UNTIL] ?? ''))
  return !Number.isFinite(until) || until > Date.now()
}
export function archiveWriterOwns(row: Row, token: string): boolean {
  return recordOf(row.signature_log)?.[ARCHIVE_WRITER] === token && archiveWriterActive(row)
}
export function archiveWriterMayUpload(row: Row, token: string): boolean {
  const until = Date.parse(String(recordOf(row.signature_log)?.[ARCHIVE_WRITER_UNTIL] ?? ''))
  return archiveWriterOwns(row, token) && until > Date.now() + tettoMsArea('storage') + 10_000
}
/** CAS compatto: mai lo snapshot o il signature_log completo nella query string. */
async function cas(db: SupabaseClient, row: Row, next: Row) {
  const log = recordOf(row.signature_log)
  let query = db.from('forms_submissions').update({ signature_log: next }).eq('id', row.id)
  for (const field of ['document_hash', 'hash', 'method', 'signed_at', 'timestamp', ARCHIVE_WRITER] as const) {
    const value = log?.[field]
    query = typeof value === 'string' ? query.eq(`signature_log->>${field}`, value) : query.is(`signature_log->>${field}`, null)
  }
  query = archiveErasurePending(log) ? query.eq(`signature_log->>${ARCHIVE_ERASURE}`, true) : query.is(`signature_log->>${ARCHIVE_ERASURE}`, null)
  return query.select('*').maybeSingle()
}
export async function fenceSignedArchive(db: SupabaseClient, id: string): Promise<Row | null> {
  for (let n = 0; n < 3; n++) {
    const read = await db.from('forms_submissions').select('*').eq('id', id).maybeSingle()
    if (read.error || !read.data) { logErrore({ operazione: 'forms/oblio-fence', evento: 'fence-non-letto' }, read.error); return null }
    if (archiveErasurePending(read.data.signature_log)) return read.data
    const result = await cas(db, read.data, { ...recordOf(read.data.signature_log), [ARCHIVE_ERASURE]: true })
    if (result.error) { logErrore({ operazione: 'forms/oblio-fence', evento: 'fence-non-salvato' }, result.error); return null }
    if (result.data) { logEvento('gdpr', 'info', { operazione: 'forms/oblio-fence', esito: 'recupero-bloccato', n: 1 }); return result.data }
  }
  logEvento('gdpr', 'error', { operazione: 'forms/oblio-fence', esito: 'fence-conflitto', n: 1 })
  return null
}
export async function acquireArchiveWriter(db: SupabaseClient, id: string, hash: string): Promise<{ row?: Row; token?: string; error?: 'SUBMISSION_ERASURE_PENDING' | 'PDF_PATH_SAVE_FAILED' | 'SNAPSHOT_CONFLICT' }> {
  for (let n = 0; n < 100; n++) {
    const read = await db.from('forms_submissions').select('*').eq('id', id).maybeSingle()
    if (read.error || !read.data) return { error: 'PDF_PATH_SAVE_FAILED' }
    if (archiveErasurePending(read.data.signature_log)) return { error: 'SUBMISSION_ERASURE_PENDING' }
    const log = recordOf(read.data.signature_log)
    if (log?.document_hash !== hash) return { error: 'SNAPSHOT_CONFLICT' }
    if (archiveWriterActive(read.data)) { await new Promise((resolve) => setTimeout(resolve, 50)); continue }
    const token = crypto.randomUUID()
    const result = await cas(db, read.data, { ...log, [ARCHIVE_WRITER]: token, [ARCHIVE_WRITER_UNTIL]: new Date(Date.now() + WRITER_LEASE_MS).toISOString() })
    if (result.error) return { error: 'PDF_PATH_SAVE_FAILED' }
    if (result.data) return { row: result.data, token }
  }
  return { error: 'SNAPSHOT_CONFLICT' }
}
export async function releaseArchiveWriter(db: SupabaseClient, id: string, token: string): Promise<void> {
  for (let n = 0; n < 3; n++) {
    const read = await db.from('forms_submissions').select('*').eq('id', id).maybeSingle()
    if (read.error) { logErrore({ operazione: 'forms/signed-pdf', evento: 'writer-non-rilasciato' }, read.error); return }
    const log = recordOf(read.data?.signature_log)
    if (!read.data || log?.[ARCHIVE_WRITER] !== token) return
    const next = { ...log }; delete next[ARCHIVE_WRITER]; delete next[ARCHIVE_WRITER_UNTIL]
    const result = await cas(db, read.data, next)
    if (result.error) { logErrore({ operazione: 'forms/signed-pdf', evento: 'writer-non-rilasciato' }, result.error); return }
    if (result.data) return
  }
  logEvento('modulistica', 'error', { operazione: 'forms/signed-pdf', esito: 'writer-rilascio-conflitto', n: 1 })
}
