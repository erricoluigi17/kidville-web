import { fenceSignedArchive, archiveWriterActive } from '@/lib/forms/signed-archive-state'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SIGNED_FORMS_BUCKET, pendingSignedSubmissionPath, ARCHIVE_ERASURE } from '@/lib/forms/signed-path'
import { percorsoNelBucket } from '@/lib/allegati/storage'
import { rimuoviEVerifica, bloccanti } from '@/lib/storage/rimozione-verificata'
import { logEvento, logErrore } from '@/lib/logging/logger'

type Riga = Record<string, unknown>
export type SoggettoModuliOblio = { studentId: string; parentIds?: never } | { parentIds: (string | null | undefined)[]; studentId?: never }
export interface InventarioModuliOblio { righe: Riga[]; letto: boolean }
const PAGINA = 500
/** Sole letture, keyset: nessun offset mentre le righe vengono cancellate. */
export async function leggiModuliPerOblio(db: SupabaseClient, soggetto: SoggettoModuliOblio, op: string): Promise<InventarioModuliOblio> {
  const parentIds = [...new Set((soggetto.parentIds ?? []).filter((id): id is string => !!id))]
  if (!soggetto.studentId && parentIds.length === 0) return { righe: [], letto: false }
  const righe: Riga[] = []
  let dopo: string | null = null
  try {
    for (;;) {
      let query = db.from('forms_submissions').select('*').order('id').limit(PAGINA)
      query = soggetto.studentId ? query.eq('student_id', soggetto.studentId) : query.in('parent_id', parentIds)
      if (dopo) query = query.gt('id', dopo)
      const { data, error } = await query
      if (error || !Array.isArray(data)) {
        logErrore({ operazione: op, evento: 'oblio_moduli_lettura' }, error ?? { message: 'inventario assente' })
        return { righe: [], letto: false }
      }
      righe.push(...data)
      if (data.length < PAGINA) break
      const ultimo = data.at(-1)?.id
      if (typeof ultimo !== 'string' || ultimo === dopo) throw new Error('Keyset dei moduli non valido')
      dopo = ultimo
    }
    return { righe, letto: true }
  } catch (error) {
    logErrore({ operazione: op, evento: 'oblio_moduli_lettura' }, error)
    return { righe: [], letto: false }
  }
}
/** Stessa identità Storage anche con slash, URL relativo, query di firma e percent-encoding. */
function percorsoModulo(valore: unknown): string | null {
  if (typeof valore !== 'string') return null
  const v = valore.trim()
  if (/^https?:\/\//i.test(v) || /^\/?storage\/v1\/object\//.test(v) || /^\/\/[^/]+\/storage\/v1\/object\//.test(v)) {
    const url = new URL(/^https?:\/\//i.test(v) ? v : v.startsWith('//') ? `https:${v}` : `https://storage.invalid/${v.replace(/^\//, '')}`)
    const parts = /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/.exec(url.pathname)
    if (!parts || decodeURIComponent(parts[1]) !== SIGNED_FORMS_BUCKET) return null
    return percorsoNelBucket(SIGNED_FORMS_BUCKET, `https://storage.invalid/storage/v1/object/public/${SIGNED_FORMS_BUCKET}/${parts[2]}`)
  }
  return percorsoNelBucket(SIGNED_FORMS_BUCKET, v)
}
function percorsi(riga: Riga): { paths: string[]; leggibile: boolean } {
  const salvato = typeof riga.pdf_path === 'string' ? riga.pdf_path.trim() : ''
  const path = percorsoModulo(salvato)
  const pending = riga.origine === 'cartaceo' ? null : pendingSignedSubmissionPath(riga)
  return { paths: [...new Set([path, pending].filter((p): p is string => !!p))], leggibile: !salvato || !!path }
}
function protetto(riga: Riga): boolean {
  return riga.protocollato === true || (typeof riga.protocollo_id === 'string' && riga.protocollo_id.length > 0)
}
/** Legge metadata per pagine; le chiavi normalizzate sono l'unico dato conservato. */
async function visitaRiferimenti(db: SupabaseClient, table: string, columns: string, visita: (row: Riga) => void): Promise<void> {
  let dopo: string | null = null
  for (;;) {
    let query = db.from(table).select(columns).order('id').limit(PAGINA)
    if (dopo) query = query.gt('id', dopo)
    const { data, error } = await query
    if (error || !Array.isArray(data)) throw error ?? new Error('Riferimenti documentali non leggibili')
    const rows = data as unknown as Riga[] // select dinamica: PostgREST non inferisce i campi metadata
    for (const row of rows) visita(row)
    if (rows.length < PAGINA) return
    const ultimo = rows.at(-1)?.id
    if (typeof ultimo !== 'string' || ultimo === dopo) throw new Error('Keyset dei riferimenti non valido')
    dopo = ultimo
  }
}
function aggiungiPercorso(paths: Set<string>, value: unknown): void {
  const path = percorsoModulo(value)
  if (path) paths.add(path)
}
/** Nessuna policy nuova: i link del registro e i flag esistenti trattengono gli originali.
 * Il confronto è sulla key normalizzata, non sull'URL/alias salvato in tabella.
 */
async function riferimentiProtocollo(db: SupabaseClient): Promise<Set<string>> {
  const paths = new Set<string>()
  await visitaRiferimenti(db, 'protocolli', 'id, file_originale, file_timbrato', (row) => {
    aggiungiPercorso(paths, row.file_originale)
    aggiungiPercorso(paths, row.file_timbrato)
  })
  await visitaRiferimenti(db, 'protocolli_allegati', 'id, path', (row) => aggiungiPercorso(paths, row.path))
  return paths
}
async function riferimentiCondivisi(db: SupabaseClient, cancellabili: Set<string>): Promise<Set<string>> {
  const paths = new Set<string>()
  // Le altre righe DELLO STESSO LOTTO non trattengono un file dopo essere state
  // cancellate. Un riferimento protetto o esterno al lotto invece resta vivo.
  await visitaRiferimenti(db, 'forms_submissions', 'id, pdf_path', (row) => {
    if (!cancellabili.has(String(row.id))) aggiungiPercorso(paths, row.pdf_path)
  })
  for (const table of ['alunni', 'parents']) await visitaRiferimenti(db, table, 'id, documento_path', (row) => aggiungiPercorso(paths, row.documento_path))
  // Nei JSON delle domande non si può proiettare documento_path da tutti gli
  // elementi di un array via PostgREST. Ogni pagina viene subito ridotta ai soli
  // percorsi: nomi, codici fiscali e note non si accumulano e non vengono loggati.
  await visitaRiferimenti(db, 'enrollment_submissions', 'id, data', (row) => {
    const data = row.data as { children?: unknown; adults?: unknown } | null
    for (const ramo of [data?.children, data?.adults]) if (Array.isArray(ramo)) {
      for (const persona of ramo) if (persona && typeof persona === 'object') aggiungiPercorso(paths, persona.documento_path)
    }
  })
  return paths
}
export interface EsitoModuliOblio { rimossi: number; nonRimossi: number; righe: number; letto: boolean; protetti: number; condivisi: number }
/** Prima file verificati, poi evidenza originale: recovery non può ricreare PII obliate. */
export async function obliaModuliGenitori(db: SupabaseClient, soggetto: SoggettoModuliOblio, op: string, inventario?: InventarioModuliOblio): Promise<EsitoModuliOblio> {
  const letto = inventario ?? await leggiModuliPerOblio(db, soggetto, op)
  const out: EsitoModuliOblio = { rimossi: 0, nonRimossi: 0, righe: 0, letto: letto.letto, protetti: 0, condivisi: 0 }
  if (!letto.letto) return out
  // Prima tutti i riferimenti: un guasto qui non deve rimuovere metà dei file.
  const piano: Array<{ riga: Riga; paths: string[]; protetto: boolean }> = []
  try {
    const pathsProtocollo = letto.righe.some((r) => percorsi(r).paths.length > 0) ? await riferimentiProtocollo(db) : new Set<string>()
    for (const riga of letto.righe) {
      const keys = percorsi(riga)
      if (!keys.leggibile || typeof riga.id !== 'string') { out.nonRimossi++; continue }
      const conservato = protetto(riga) || keys.paths.some((path) => pathsProtocollo.has(path))
      piano.push({ riga, paths: keys.paths, protetto: conservato })
    }
    const cancellabili = new Set(piano.filter((v) => !v.protetto).map((v) => String(v.riga.id)))
    const propri = new Set(piano.filter((v) => !v.protetto).flatMap((v) => v.paths))
    const esterni = propri.size ? await riferimentiCondivisi(db, cancellabili) : new Set<string>()
    const condivisi = new Set([...propri].filter((path) => esterni.has(path)))
    out.condivisi = condivisi.size
    for (const voce of piano) voce.paths = voce.paths.filter((path) => !condivisi.has(path))
  } catch (error) {
    logErrore({ operazione: op, evento: 'oblio_moduli_riferimenti' }, error)
    return { ...out, letto: false }
  }
  // L'intento è durevole PRIMA di Storage. Nessun nuovo writer può acquisire il
  // documento; un upload già in volo mantiene l'indice finché si è fermato.
  const fenced: typeof piano = []
  for (const voce of piano) {
    if (voce.protetto) { out.protetti++; continue }
    const row = await fenceSignedArchive(db, String(voce.riga.id))
    if (!row || archiveWriterActive(row)) { out.nonRimossi++; continue }
    fenced.push({ riga: row, paths: percorsi(row).paths, protetto: false })
  }
  try {
    // Snapshot/percorso possono essere stati congelati fra inventario e fence.
    const protocollo = fenced.some((v) => v.paths.length) ? await riferimentiProtocollo(db) : new Set<string>()
    for (const voce of fenced) if (protetto(voce.riga) || voce.paths.some((path) => protocollo.has(path))) { voce.protetto = true; out.protetti++ }
    const ids = new Set(fenced.filter((v) => !v.protetto).map((v) => String(v.riga.id)))
    const esterni = fenced.some((v) => !v.protetto && v.paths.length) ? await riferimentiCondivisi(db, ids) : new Set<string>()
    const condivisi = new Set(fenced.filter((v) => !v.protetto).flatMap((v) => v.paths).filter((path) => esterni.has(path)))
    out.condivisi = condivisi.size
    for (const voce of fenced) voce.paths = voce.paths.filter((path) => !condivisi.has(path))
  } catch (error) {
    logErrore({ operazione: op, evento: 'oblio_moduli_fenced_riferimenti' }, error)
    return { ...out, letto: false }
  }
  // Ogni oggetto esce una sola volta; le righe che lo indicizzano seguono lo stesso esito.
  const paths = [...new Set(fenced.filter((v) => !v.protetto).flatMap((v) => v.paths))]
  const result = await rimuoviEVerifica(db, SIGNED_FORMS_BUCKET, paths, op)
  out.rimossi = result.rimossi.length
  const fermi = new Set(result.erroreRimozione ? paths : bloccanti(result))
  out.nonRimossi += fermi.size
  for (const voce of fenced) {
    if (voce.protetto) continue
    if (voce.paths.some((path) => fermi.has(path))) continue
    // Eliminare tutta la riga toglie anche answers, parent_details e snapshot.
    const { data, error } = await db.from('forms_submissions').delete().eq('id', voce.riga.id).eq(`signature_log->>${ARCHIVE_ERASURE}`, true).select('id')
    if (error || !Array.isArray(data)) {
      logErrore({ operazione: op, evento: 'oblio_moduli_evidenza' }, error ?? { message: 'risposta cancellazione assente' })
      out.nonRimossi++
    } else if (data.length === 0) {
      const remaining = await db.from('forms_submissions').select('id').eq('id', voce.riga.id).maybeSingle()
      if (remaining.error || remaining.data) {
        logErrore({ operazione: op, evento: 'oblio_moduli_delete_non_confermato' }, remaining.error ?? { message: 'indice ancora presente dopo delete CAS' })
        out.nonRimossi++
      }
    } else out.righe += data.length
  }
  logEvento('gdpr', out.nonRimossi ? 'error' : 'info', { operazione: op, esito: 'oblio-moduli-genitori', n_file: out.rimossi, n_righe: out.righe, n: out.protetti, n_condivisi: out.condivisi })
  return out
}

/** Il preventivo conta le righe ordinarie, escluse quelle vincolate alla conservazione. */
export async function contaModuliGenitoriPerOblio(db: SupabaseClient, studentId: string, op: string): Promise<number | null> {
  const inventario = await leggiModuliPerOblio(db, { studentId }, op)
  if (!inventario.letto) return null
  let n = 0
  try {
    const pathsProtocollo = inventario.righe.some((r) => percorsi(r).paths.length > 0) ? await riferimentiProtocollo(db) : new Set<string>()
    for (const riga of inventario.righe) if (!protetto(riga) && !percorsi(riga).paths.some((path) => pathsProtocollo.has(path))) n++
    return n
  } catch (error) {
    logErrore({ operazione: op, evento: 'oblio_moduli_conteggio' }, error)
    return null
  }
}

/** Usato dal writer cancellato: gli originali protetti o condivisi non si distruggono. */
export async function riferimentoVivoAlPdf(db: SupabaseClient, path: string, submissionId: string): Promise<boolean> {
  return (await riferimentiProtocollo(db)).has(path) || (await riferimentiCondivisi(db, new Set([submissionId]))).has(path)
}
