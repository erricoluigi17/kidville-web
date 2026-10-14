import { ARCHIVE_ERASURE } from '@/lib/forms/signed-path'
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { signedFormsClient, SUBMISSION, STUDENT, PARENT, SCHOOL } from '../fixtures/signed-forms'
import { ensureSignedSubmissionPdf } from '@/lib/forms/signed-archive'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
async function subject() {
  const mod = await import('@/lib/gdpr/moduli-genitori').catch(() => null)
  expect(mod, 'manca il canale di oblio dei moduli genitori').not.toBeNull()
  return mod!
}
describe('oblio moduli genitori: file ed evidenza originale', () => {
  it('cancella il file realmente caricato e la riga con risposte, firma e snapshot', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const result = await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')
    expect(result).toMatchObject({ rimossi: 1, nonRimossi: 0, righe: 1, letto: true })
    expect(f.objects.size).toBe(0); expect(f.db.forms_submissions).toEqual([])
    expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_error).toBe('SUBMISSION_NOT_FOUND')
  })
  it('ritrova la key deterministica quando upload riuscito e pdf_path null', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    f.db.forms_submissions[0].pdf_path = null
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ rimossi: 1, righe: 1 })
    expect(f.objects.size).toBe(0)
  })
  it.each(['remove', 'keepFiles', 'list'])('un guasto %s conserva indice ed evidenza e dichiara parziale', async (fault) => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const before = structuredClone(f.db.forms_submissions[0]); f.faults.keepFiles = true
    f.faults[fault] = fault === 'keepFiles' ? true : { code: '403', message: 'guasto storage' }
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ nonRimossi: 1, righe: 0 })
    expect(f.db.forms_submissions[0]).toEqual({ ...before, signature_log: { ...(before.signature_log as Record<string, unknown>), [ARCHIVE_ERASURE]: true } }); expect(f.objects.size).toBe(1)
  })
  it('lettura fallita non diventa zero e non scrive né toglie file', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); f.faults['forms_submissions:select'] = { code: '42501' }
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ letto: false })
    expect(f.actions.every((a) => a.action === 'select')).toBe(true)
  })
  it('il canale genitore prende entrambi gli spazi-id e non il genitore estraneo', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); const row = f.db.forms_submissions[0]
    f.db.forms_submissions.push({ ...structuredClone(row), id: '66666666-6666-4666-8666-666666666666', parent_id: 'parent-scheda', is_signed: false })
    f.db.forms_submissions.push({ ...structuredClone(row), id: 'altro', parent_id: 'estraneo' })
    expect(await obliaModuliGenitori(f.client, { parentIds: [PARENT, 'parent-scheda'] }, 'test')).toMatchObject({ righe: 2 })
    expect(f.db.forms_submissions.map((r) => r.id)).toEqual(['altro'])
  })
  it('scansione condivisa: cancella la propria evidenza e mantiene file e riga altrui', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    f.db.forms_submissions.push({ id: 'altro', student_id: 'altro-alunno', pdf_path: 'scansioni/condivisa.pdf' })
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, condivisi: 1, nonRimossi: 0 })
    expect(f.objects.size).toBe(1); expect(f.db.forms_submissions.map((r) => r.id)).toEqual(['altro'])
  })
  it('una scansione condivisa solo fra compilazioni da obliare esce senza lasciare file orfani', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/stesso-soggetto.pdf' })
    f.db.forms_submissions.push({ ...structuredClone(f.db.forms_submissions[0]), id: '66666666-6666-4666-8666-666666666666' })
    f.objects.set('scansioni/stesso-soggetto.pdf', new Uint8Array([1, 2, 3]))
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 2, rimossi: 1, nonRimossi: 0, condivisi: 0 })
    expect(f.objects.size).toBe(0); expect(f.db.forms_submissions).toEqual([])
  })
  it.each([
    '/scansioni/condivisa.pdf',
    'https://example.invalid/storage/v1/object/public/form_attachments/scansioni/condivisa.pdf',
    'https://example.invalid/storage/v1/object/sign/form_attachments/scansioni%2Fcondivisa%2Epdf?token=fittizio',
    '/storage/v1/object/authenticated/form_attachments/scansioni%2Fcondivisa.pdf',
    'storage/v1/object/sign/form_attachments/scansioni%2Fcondivisa.pdf?token=fittizio',
  ])('una scansione altrui con alias %s resta nell’archivio', async (alias) => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    f.db.forms_submissions.push({ id: 'altro', student_id: 'altro-alunno', pdf_path: alias })
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, condivisi: 1, rimossi: 0 })
    expect(f.objects.has('scansioni/condivisa.pdf')).toBe(true)
    expect(f.db.forms_submissions.map((r) => r.id)).toEqual(['altro'])
  })
  it.each([['protocolli', 'file_originale'], ['protocolli', 'file_timbrato'], ['protocolli_allegati', 'path']])('il link protetto %s.%s riconosce URL Storage relativo e codificato', async (table, column) => {
    const { obliaModuliGenitori, contaModuliGenitoriPerOblio } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    f.db[table] = [{ id: 'protocollo', [column]: '/storage/v1/object/sign/form_attachments/scansioni%2Fcondivisa%2Epdf?token=fittizio' }]
    expect(await contaModuliGenitoriPerOblio(f.client, STUDENT, 'test')).toBe(0)
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ protetti: 1, righe: 0, rimossi: 0 })
    expect(f.objects.has('scansioni/condivisa.pdf')).toBe(true)
    expect(f.db.forms_submissions).toHaveLength(1)
  })
  it.each(['alunni', 'parents', 'enrollment_submissions'])('normalizza anche il riferimento condiviso in %s', async (table) => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    f.db[table] = [...(f.db[table] ?? []), table === 'enrollment_submissions'
      ? { id: 'altro', data: { children: [{ documento_path: '/scansioni/condivisa.pdf' }] } }
      : { id: 'altro', documento_path: '/scansioni/condivisa.pdf' }]
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ condivisi: 1, rimossi: 0 })
    expect(f.objects.has('scansioni/condivisa.pdf')).toBe(true)
  })
  it('l’alias condiviso oltre la prima pagina non è escluso da una lettura troncata', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    for (let n = 1; n <= 501; n++) f.db.forms_submissions.push({ id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, student_id: 'altro', pdf_path: 'scansioni/diversa.pdf' })
    f.db.forms_submissions.push({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', student_id: 'altro', pdf_path: '/scansioni/condivisa.pdf' })
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ condivisi: 1, rimossi: 0 })
    expect(f.objects.has('scansioni/condivisa.pdf')).toBe(true)
  })
  it('un inventario dei link protetti non leggibile conserva file e righe', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    f.faults['protocolli:select'] = { code: '42501' }
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ letto: false, righe: 0, rimossi: 0 })
    expect(f.objects.size).toBe(1); expect(f.db.forms_submissions).toHaveLength(1)
  })
  it('gli alias nel solo lotto di oblio non trattengono una scansione rimasta senza soggetto', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); Object.assign(f.db.forms_submissions[0], { origine: 'cartaceo', pdf_path: 'scansioni/condivisa.pdf' })
    f.db.forms_submissions.push({ ...structuredClone(f.db.forms_submissions[0]), id: '66666666-6666-4666-8666-666666666666', pdf_path: '/storage/v1/object/sign/form_attachments/scansioni%2Fcondivisa.pdf?token=fittizio' })
    f.objects.set('scansioni/condivisa.pdf', new Uint8Array([1, 2, 3]))
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 2, rimossi: 1, condivisi: 0 })
    expect(f.objects.size).toBe(0); expect(f.db.forms_submissions).toEqual([])
  })
  it('copie del protocollo e collegamenti protetti non sono distrutti', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const path = `signed_forms/${SCHOOL}/${SUBMISSION}.pdf`
    f.db.protocolli = [{ id: 'protocollo', file_originale: path, file_timbrato: 'protocollo/conservato.pdf' }]
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ protetti: 1, righe: 0 })
    expect(f.objects.has(path)).toBe(true); expect(f.db.protocolli).toHaveLength(1)
  })
  it('la copia protocollata nel bucket protocollo resta e la sorgente ordinaria viene obliata', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    f.db.protocolli = [{ id: 'protocollo', file_originale: 'protocollo/originale.pdf', file_timbrato: 'protocollo/timbrato.pdf' }]
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, protetti: 0 })
    expect(f.db.protocolli).toHaveLength(1)
  })
  it('una compilazione protocollata conserva anche risposte ed evidenza', async () => {
    const { obliaModuliGenitori } = await subject()
    const f = signedFormsClient(); f.db.forms_submissions[0].protocollato = true
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ protetti: 1, righe: 0 })
    expect(f.db.forms_submissions).toHaveLength(1)
  })
})
