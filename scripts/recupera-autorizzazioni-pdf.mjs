#!/usr/bin/env node
/** Sistema B (forms_templates/submissions). Default dry-run, nessun OTP o email.
 * node scripts/recupera-autorizzazioni-pdf.mjs --linked [--apply]
 * La chiave corretta arriva dal Management CLI e rimane solo in memoria.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_REF = 'uimulkjyekgemjakmepp'
const PAGE = 200
/** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
const CHILD_OPTIONS = { cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
/** Mai rilanciare l'Error originale di exec: contiene command/stdout/stderr e segreti. */
function cli(exec, args) {
  try { return exec('supabase', args, CHILD_OPTIONS) }
  catch (error) { throw new Error(`CLI Supabase non riuscita (uscita ${Number.isInteger(error?.status) ? error.status : 'non disponibile'})`) }
}
/** @param {{ read?: (path: string, encoding: 'utf8') => string, exec?: (file: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string }} options */
export function configurazioneLinked({ read = readFileSync, exec = execFileSync } = {}) {
  let ref
  try { ref = String(read(resolve(ROOT, 'supabase/.temp/project-ref'), 'utf8')).trim() }
  catch { throw new Error('Progetto Supabase linked non disponibile') }
  if (ref !== EXPECTED_REF) throw new Error('Progetto Supabase linked diverso da quello atteso: nessuna operazione eseguita')
  let keys
  try { keys = JSON.parse(cli(exec, ['projects', 'api-keys', '--project-ref', ref, '--output', 'json'])) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('CLI Supabase')) throw error
    throw new Error('Risposta Management CLI non valida: nessuna chiave stampata')
  }
  const key = Array.isArray(keys) ? keys.find((k) => k.name === 'service_role')?.api_key : null
  if (typeof key !== 'string' || !key.trim()) throw new Error('Chiave service_role Management assente')
  return { url: `https://${ref}.supabase.co`, key }
}
async function tutte(db, table, select, filtro = (query) => query) {
  const rows = []
  let last = null
  for (;;) {
    let query = filtro(db.from(table).select(select).order('id').limit(PAGE))
    if (last) query = query.gt('id', last)
    const { data, error } = await query
    if (error || !Array.isArray(data)) throw new Error(`Inventario ${table} non leggibile`)
    rows.push(...data)
    if (data.length < PAGE) return rows
    const next = data.at(-1)?.id
    if (typeof next !== 'string' || next === last) throw new Error('Paginazione keyset non valida')
    last = next
  }
}
/** Le dipendenze sono iniettate per provare i guasti senza rete o dati reali. */
export async function eseguiRecupero(deps, { apply = false } = {}) {
  const { db, ensure, download, validEvidence, signatureEvidence, pendingPath, report, log } = deps
  const templates = await tutte(db, 'forms_templates', 'id, scuola_id')
  const templateIds = templates.filter((t) => typeof t.scuola_id === 'string' && !t.scuola_id.toLowerCase().startsWith('e2e00000-')).map((t) => t.id)
  // Congela PRIMA l'elenco dei candidati; nessun offset su una lista in mutazione.
  const candidates = []
  for (let n = 0; n < templateIds.length; n += PAGE) {
    const ids = templateIds.slice(n, n + PAGE)
    candidates.push(...await tutte(db, 'forms_submissions', '*', (q) => q.eq('is_signed', true).in('form_id', ids)))
  }
  const counts = { modalita: apply ? 'apply' : 'dry-run', firmate: candidates.length, digitali: 0, cartacee: 0, presenti: 0, mancanti: 0, anomalie: 0, recuperati: 0 }
  const missing = []
  const anomalies = {}
  const anomaly = (code) => { counts.anomalie++; anomalies[code] = (anomalies[code] ?? 0) + 1 }
  for (const row of candidates) {
    const paper = row.origine === 'cartaceo'
    if (paper) counts.cartacee++; else counts.digitali++
    if (!paper && !validEvidence(row.signature_log)) { anomaly('SIGNATURE_INCOMPLETE'); continue }
    let existing = await download(db, row)
    let pendingFound = false
    const pending = pendingPath?.(row)
    if (!existing.bytes && existing.pdf_error === 'PDF_NOT_FOUND' && pending && pending !== row.pdf_path) {
      existing = await download(db, { ...row, pdf_path: pending })
      pendingFound = !!existing.bytes
    }
    if (existing.bytes) {
      counts.presenti++
      // L'oggetto è presente ma il CAS è fallito: apply deve collegarlo senza upload.
      if (pendingFound) missing.push(row)
    } else if (existing.pdf_error === 'PDF_NOT_FOUND' || existing.pdf_error === 'PAPER_ORIGINAL_MISSING') {
      counts.mancanti++
      if (paper) anomaly('PAPER_ORIGINAL_MISSING'); else missing.push(row)
    } else anomaly(existing.pdf_error ?? 'PDF_DOWNLOAD_FAILED')
  }
  report({ ...counts, anomalie_per_codice: { ...anomalies } })
  if (!apply) {
    log('modulistica', counts.anomalie ? 'warn' : 'info', { operazione: 'scripts/recupera-autorizzazioni-pdf', esito: 'recupero-dry-run', n: counts.firmate, n_errori: counts.anomalie })
    return { ...counts, anomalie_per_codice: anomalies }
  }
  const enrollmentCount = await deps.countEnrollment()
  if (!Number.isSafeInteger(enrollmentCount) || enrollmentCount < 0) throw new Error('Conteggio enrollment_submissions non disponibile: apply fermato')
  counts.enrollment_submissions = enrollmentCount
  report({ ...counts, operazioni: 'Congela snapshot storico se assente; upload PDF immutabile solo se mancante; collega pdf_path; verifica bytes/hash e firma/data originali. Nessun nuovo OTP, email o overwrite.', da_recuperare: missing.length })
  for (const original of missing) {
    const result = await ensure(db, original.id)
    if (!result.pdf_ready || !result.submission) { anomaly(result.pdf_error ?? 'RECOVERY_FAILED'); continue }
    // Rilettura autorevole, non l'oggetto tornato dal generatore.
    const { data: current, error } = await db.from('forms_submissions').select('*').eq('id', original.id).maybeSingle()
    if (error || !current) { anomaly('SUBMISSION_READ_FAILED'); continue }
    if (current.created_at !== original.created_at || !isDeepStrictEqual(signatureEvidence(current.signature_log), signatureEvidence(original.signature_log))) {
      anomaly('ORIGINAL_EVIDENCE_CHANGED'); continue
    }
    const archived = await download(db, current)
    if (!archived.bytes || new TextDecoder().decode(archived.bytes.subarray(0, 5)) !== '%PDF-') { anomaly(archived.pdf_error ?? 'PDF_DOWNLOAD_FAILED'); continue }
    counts.recuperati++
  }
  log('modulistica', counts.anomalie ? 'error' : 'info', { operazione: 'scripts/recupera-autorizzazioni-pdf', esito: counts.anomalie ? 'recupero-parziale' : 'recupero-eseguito', n: counts.recuperati, n_errori: counts.anomalie })
  return { ...counts, anomalie_per_codice: anomalies }
}
/** Il dry-run osserva solo in console; apply conserva il logging ordinario. Errori propagati. */
export async function conOsservabilitaRecupero(apply, work) {
  if (apply) return work()
  const { conLogSoloConsole } = await import('@/lib/logging/context')
  return conLogSoloConsole(work)
}
async function main(args) {
  if (args.includes('--help')) {
    console.log('Uso: node scripts/recupera-autorizzazioni-pdf.mjs --linked [--apply]. Default: sola lettura. Node 24 richiesto.')
    return
  }
  if (!args.includes('--linked') || args.some((a) => !['--linked', '--apply'].includes(a))) throw new Error('Specificare --linked; solo --apply abilita le scritture')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Questo script richiede Node 24')
  const config = configurazioneLinked()
  // Nessuna lettura di .env.local. URL/chiave prima dell'import del logger e dei renderer.
  process.env.NEXT_PUBLIC_SUPABASE_URL = config.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = config.key
  await import('./lib/risolvi-ts.mjs')
  await conOsservabilitaRecupero(args.includes('--apply'), async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { creaFetchStrumentato } = await import('@/lib/logging/supabase-fetch')
    const { logEvento } = await import('@/lib/logging/logger')
    const { ensureSignedSubmissionPdf, downloadSignedSubmissionPdf } = await import('@/lib/forms/signed-archive')
    const { validSignatureEvidence, signatureEvidence } = await import('@/lib/forms/signed-document')
    const { pendingSignedSubmissionPath } = await import('@/lib/forms/signed-path')
    const { righeDaJsonCli } = await import('./lib/aruba-lettura.mjs')
    const db = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: creaFetchStrumentato() } })
    const report = (counts) => console.log(JSON.stringify(counts)) // soli conteggi e codici, mai nominativi/percorso/evidenza
    const result = await eseguiRecupero({ db, ensure: ensureSignedSubmissionPdf, download: downloadSignedSubmissionPdf, validEvidence: validSignatureEvidence, signatureEvidence, pendingPath: pendingSignedSubmissionPath, log: logEvento, report,
      countEnrollment: async () => {
        const output = cli(execFileSync, ['db', 'query', '--linked', '--agent', 'no', '-o', 'json', 'SELECT count(*) FROM enrollment_submissions;'])
        let rows
        try { rows = righeDaJsonCli(output) } catch { throw new Error('Conteggio enrollment_submissions non leggibile') }
        return Number(rows[0]?.count)
      },
    }, { apply: args.includes('--apply') })
    report(result)
    if (result.anomalie) process.exitCode = 2
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // L'errore originale può contenere segreti/PII del provider: il dettaglio SDK passa dal logger redatto.
    console.error('Recupero interrotto: configurazione, lettura o verifica non riuscita. Nessun segreto stampato.')
    process.exitCode = 1
  })
}
