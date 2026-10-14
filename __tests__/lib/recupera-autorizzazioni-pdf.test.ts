// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { signedFormsClient, SUBMISSION, SCHOOL, ORIGINAL_SIGNATURE } from '../fixtures/signed-forms'
import { ensureSignedSubmissionPdf, downloadSignedSubmissionPdf } from '@/lib/forms/signed-archive'
import { pendingSignedSubmissionPath } from '@/lib/forms/signed-path'
import { validSignatureEvidence, signatureEvidence } from '@/lib/forms/signed-document'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
async function subject() {
  const mod = await import('../../scripts/recupera-autorizzazioni-pdf.mjs').catch(() => null)
  expect(mod, 'batch di recupero mancante').not.toBeNull()
  return mod!
}
function deps(f = signedFormsClient()) {
  return { f, deps: { db: f.client, ensure: ensureSignedSubmissionPdf, download: downloadSignedSubmissionPdf, validEvidence: validSignatureEvidence, signatureEvidence, pendingPath: pendingSignedSubmissionPath, countEnrollment: vi.fn(async () => 712), report: vi.fn(), log: vi.fn() } }
}
describe('recupero batch Sistema B', () => {
  it('default dry-run read-only verifica anche un pdf_path simulato non nullo', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    f.db.forms_submissions[0].pdf_path = `signed_forms/${SUBMISSION}.pdf`
    const before = structuredClone(f.db)
    expect(await eseguiRecupero(d)).toMatchObject({ firmate: 1, digitali: 1, mancanti: 1, presenti: 0, recuperati: 0, anomalie: 0 })
    expect(f.db).toEqual(before); expect(f.objects.size).toBe(0)
    expect(f.actions.every((a) => a.action === 'select')).toBe(true)
  })
  it('apply due volte mantiene evidenza/data originali e hash dei bytes effettivi', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    const created = f.db.forms_submissions[0].created_at
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ recuperati: 1, mancanti: 1, anomalie: 0, enrollment_submissions: 712 })
    const first = f.objects.get(`signed_forms/${SCHOOL}/${SUBMISSION}.pdf`)!.slice()
    expect(signatureEvidence(f.db.forms_submissions[0].signature_log)).toEqual(ORIGINAL_SIGNATURE)
    expect(f.db.forms_submissions[0].created_at).toBe(created)
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ recuperati: 0, presenti: 1 })
    expect(f.objects.get(`signed_forms/${SCHOOL}/${SUBMISSION}.pdf`)).toEqual(first)
    expect(f.storage.uploads).toHaveLength(1)
    expect(d.report.mock.invocationCallOrder[0]).toBeLessThan(d.log.mock.invocationCallOrder[0])
  })
  it('keyset legge più di una pagina prima di qualsiasi mutazione', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    const row = structuredClone(f.db.forms_submissions[0])
    f.db.forms_submissions = Array.from({ length: 235 }, () => ({ ...structuredClone(row), id: randomUUID() }))
    expect(await eseguiRecupero(d)).toMatchObject({ firmate: 235, mancanti: 235 })
    const reads = f.actions.filter((a) => a.table === 'forms_submissions')
    expect(reads).toHaveLength(2)
    expect(reads.every((a) => a.action === 'select')).toBe(true)
  })
  it('l’alterazione della data originale non viene dichiarata recupero riuscito', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    d.ensure = async (...args) => {
      const result = await ensureSignedSubmissionPdf(...args)
      f.db.forms_submissions[0].created_at = '2099-01-01T00:00:00Z'
      return result
    }
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ recuperati: 0, anomalie_per_codice: { ORIGINAL_EVIDENCE_CHANGED: 1 } })
  })
  it('esclude tutte le sedi e2e prima di qualsiasi scrittura', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    f.db.forms_templates[0].scuola_id = 'e2e00000-0000-4000-8000-000000000001'
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ firmate: 0, recuperati: 0 })
    expect(f.actions.every((a) => a.action === 'select')).toBe(true)
  })
  it('cartacei intatti ed evidenze insufficienti diventano anomalie esplicite', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    const row = f.db.forms_submissions[0]; row.signature_log = {}
    f.db.forms_submissions.push({ ...structuredClone(row), id: 'scansione', origine: 'cartaceo', pdf_path: 'scansioni/originale.pdf' })
    f.objects.set('scansioni/originale.pdf', new Uint8Array([1, 2, 3]))
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ cartacee: 1, anomalie: 1, recuperati: 0, presenti: 1 })
    expect(f.db.forms_submissions[0].signature_log).toEqual({}); expect(f.storage.uploads).toHaveLength(0)
    expect(f.objects.get('scansioni/originale.pdf')).toEqual(new Uint8Array([1, 2, 3]))
  })
  it('guasti download o upload non fabbricano successo', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    f.faults.download = { statusCode: '403', message: 'vietato' }
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ anomalie: 1, recuperati: 0 })
    delete f.faults.download; f.faults.upload = { statusCode: '503' }
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ anomalie: 1, recuperati: 0 })
    expect(f.db.forms_submissions[0].is_signed).toBe(true)
  })
  it('dry-run rileva l’upload presente con CAS del percorso fallito e apply lo collega', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    await ensureSignedSubmissionPdf(f.client, SUBMISSION); f.db.forms_submissions[0].pdf_path = null
    const uploads = f.storage.uploads.length
    expect(await eseguiRecupero(d)).toMatchObject({ presenti: 1, mancanti: 0, recuperati: 0 })
    expect(f.db.forms_submissions[0].pdf_path).toBeNull()
    expect(await eseguiRecupero(d, { apply: true })).toMatchObject({ recuperati: 1 })
    expect(f.storage.uploads).toHaveLength(uploads)
  })
  it('conteggio enrollment assente impedisce apply prima delle scritture', async () => {
    const { eseguiRecupero } = await subject(); const { f, deps: d } = deps()
    d.countEnrollment.mockResolvedValueOnce(null as never)
    await expect(eseguiRecupero(d, { apply: true })).rejects.toThrow('Conteggio')
    expect(f.actions.every((a) => a.action === 'select')).toBe(true)
  })
  it('il bootstrap rifiuta progetto errato e sanitizza errori CLI con segreti', async () => {
    const { configurazioneLinked } = await subject()
    const exec = vi.fn(() => { throw Object.assign(new Error('TOKEN-SEGRETO'), { status: 7, stderr: 'RAW-SEGRETO' }) })
    expect(() => configurazioneLinked({ read: () => 'progetto-errato', exec })).toThrow('Progetto')
    expect(exec).not.toHaveBeenCalled()
    let error: unknown
    try { configurazioneLinked({ read: () => 'uimulkjyekgemjakmepp', exec }) } catch (e) { error = e }
    expect(String(error)).toContain('7'); expect(String(error)).not.toMatch(/TOKEN-SEGRETO|RAW-SEGRETO/)
  })
  it('il bootstrap prende api_key service_role dal Management CLI, senza .env.local', async () => {
    const { configurazioneLinked } = await subject()
    const exec = vi.fn(() => JSON.stringify([{ name: 'anon', api_key: 'anon-finto' }, { name: 'service_role', api_key: 'service-finto' }]))
    const config = configurazioneLinked({ read: () => 'uimulkjyekgemjakmepp', exec })
    expect(config).toEqual({ url: 'https://uimulkjyekgemjakmepp.supabase.co', key: 'service-finto' })
    expect(exec).toHaveBeenCalledWith('supabase', ['projects', 'api-keys', '--project-ref', 'uimulkjyekgemjakmepp', '--output', 'json'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }))
  })
})
