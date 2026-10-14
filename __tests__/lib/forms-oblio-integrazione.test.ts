// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { signedFormsClient, SUBMISSION, STUDENT, PARENT } from '../fixtures/signed-forms'
import { ensureSignedSubmissionPdf } from '@/lib/forms/signed-archive'
import { anonimizzaAlunno, anonimizzaParent } from '@/lib/gdpr/esegui'
import { rimuoviFileAlunno } from '@/lib/alunni/elimina-definitivo'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
it('l’oblio dell’alunno svuota anche l’archivio dei moduli genitori', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  const result = await anonimizzaAlunno(f.client, { id: STUDENT } as never, '2026-10-14T10:00:00Z', 'test')
  expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
  expect(result.file).toBe(1)
})
it('l’oblio del genitore usa il ponte auth_user_id prima di cancellarlo', async () => {
  const f = signedFormsClient(); f.db.parents = [{ id: 'scheda-genitore', auth_user_id: PARENT }]
  await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  const result = await anonimizzaParent(f.client, 'scheda-genitore', '2026-10-14T10:00:00Z', 'test')
  expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
  expect(result.fileRimossi).toBe(1)
})
it('la cancellazione definitiva toglie file ed evidenza prima della RPC distruttiva', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  expect(await rimuoviFileAlunno(f.client, { id: STUDENT }, 'test')).toMatchObject({ ok: true })
  expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
})
it('la cancellazione definitiva si ferma su file dei moduli ancora presente', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  f.faults.keepFiles = true
  expect(await rimuoviFileAlunno(f.client, { id: STUDENT }, 'test')).toMatchObject({ ok: false })
  expect(f.db.forms_submissions).toHaveLength(1); expect(f.objects.size).toBe(1)
})

it('il preventivo conta i moduli ordinari e distingue l’inventario non letto', async () => {
  const { contaCosaDistrugge } = await import('@/lib/gdpr/cosa-distrugge')
  const f = signedFormsClient()
  expect(await contaCosaDistrugge(f.client, STUDENT, 'test')).toMatchObject({ moduli_genitori: 1 })
  f.faults['forms_submissions:select'] = { code: '42501' }
  expect(await contaCosaDistrugge(f.client, STUDENT, 'test')).toMatchObject({ moduli_genitori: null })
})

it('il ponte genitore non letto rende l’oblio incompleto', async () => {
  const f = signedFormsClient(); f.db.parents = [{ id: 'scheda-genitore', auth_user_id: PARENT }]
  f.faults['parents:select'] = { code: '42501' }
  const result = await anonimizzaParent(f.client, 'scheda-genitore', '2026-10-14T10:00:00Z', 'test')
  expect(result.lettureFallite).toBeGreaterThan(0)
  expect(f.db.forms_submissions).toHaveLength(1)
})
it('un file non rimovibile preserva il ponte fino al successivo tentativo di oblio', async () => {
  const f = signedFormsClient(); f.db.parents = [{ id: 'scheda-genitore', auth_user_id: PARENT }]
  await ensureSignedSubmissionPdf(f.client, SUBMISSION); f.faults.keepFiles = true
  const result = await anonimizzaParent(f.client, 'scheda-genitore', '2026-10-14T10:00:00Z', 'test')
  expect(result.fileNonRimossi).toBeGreaterThanOrEqual(1)
  expect(f.db.parents[0].auth_user_id).toBe(PARENT)
  delete f.faults.keepFiles
  await anonimizzaParent(f.client, 'scheda-genitore', '2026-10-14T10:00:00Z', 'test')
  expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
})
