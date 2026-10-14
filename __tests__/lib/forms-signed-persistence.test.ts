// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { persistSignedSubmission } from '@/lib/forms/persist-submission'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { signedFormsClient, ORIGINAL_SIGNATURE, SUBMISSION } from '../fixtures/signed-forms'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
const FORM = '11111111-1111-4111-8111-111111111111'
const PARENT = '22222222-2222-4222-8222-222222222222'
const STUDENT = '33333333-3333-4333-8333-333333333333'
const SCHOOL = '44444444-4444-4444-8444-444444444444'
const dbBase = (): DBFinto => ({
  forms_templates: [{ id: FORM, title: 'Autorizzazione uscita', description: 'Autorizzo la visita', scuola_id: SCHOOL, requires_signature: true, fields: [{ id: 'accept', label: 'Autorizzo', type: 'checkbox', required: true }] }],
  forms_submissions: [],
  alunni: [{ id: STUDENT, nome: 'Bambino', cognome: 'Esempio', scuola_id: SCHOOL }],
  utenti: [{ id: PARENT, nome: 'Genitore', cognome: 'Esempio', scuola_id: SCHOOL }],
})
const input = { form_id: FORM, parent_id: PARENT, student_id: STUDENT, answers: { accept: true } }

describe('persistenza documentale delle firme', () => {
  it('una compilazione non firmata non inventa un percorso PDF', async () => {
    const db = dbBase()
    const writes: Scrittura[] = []
    const result = await persistSignedSubmission(creaFintoSupabase(db, [], { scritture: writes }), input)
    expect(result.status).toBe(201)
    expect(db.forms_submissions[0].pdf_path).toBeNull()
  })
  it.each([false, 'true', undefined])('una spunta obbligatoria deve essere boolean true, ricevuto %s', async (accept) => {
    const db = dbBase()
    const result = await persistSignedSubmission(creaFintoSupabase(db), { ...input, answers: { accept } })
    expect(result.status).toBe(400)
    expect(db.forms_submissions).toHaveLength(0)
  })
  it('non archivia la compilazione di un bambino appartenente a un’altra sede', async () => {
    const db = dbBase()
    db.alunni[0].scuola_id = '55555555-5555-4555-8555-555555555555'
    const result = await persistSignedSubmission(creaFintoSupabase(db), input)
    expect(result.status).toBe(403)
    expect(db.forms_submissions).toHaveLength(0)
  })
  it('una firma senza evidenza server non viene fabbricata', async () => {
    const db = dbBase()
    const result = await persistSignedSubmission(creaFintoSupabase(db), { ...input, is_signed: true })
    expect(result.status).toBe(400)
    expect(db.forms_submissions).toHaveLength(0)
  })
  it('una firma nuova congela snapshot contemporaneo nell’INSERT e archivia PDF completo', async () => {
    const f = signedFormsClient(); f.db.forms_submissions = []
    const result = await persistSignedSubmission(f.client, { ...input, is_signed: true, signature_log: ORIGINAL_SIGNATURE })
    expect(result).toMatchObject({ status: 201, pdf_ready: true })
    const insert = f.actions.find((a) => a.table === 'forms_submissions' && a.action === 'insert')
    expect(insert?.payload).toMatchObject({ pdf_path: null, signature_log: { hash: ORIGINAL_SIGNATURE.hash, document_snapshot: { source: 'contemporaneous', reconstructed_at: null } } })
    expect(f.db.forms_submissions[0].pdf_path).toBe(`signed_forms/${SCHOOL}/${SUBMISSION}.pdf`)
  })
  it('upload fallito restituisce comunque la firma durevole con stato esplicito', async () => {
    const f = signedFormsClient(); f.db.forms_submissions = []; f.faults.upload = { statusCode: '503', message: 'archivio non disponibile' }
    const result = await persistSignedSubmission(f.client, { ...input, is_signed: true, signature_log: ORIGINAL_SIGNATURE })
    expect(result).toMatchObject({ status: 201, pdf_ready: false, pdf_error: 'PDF_UPLOAD_FAILED', submission: { is_signed: true, pdf_path: null } })
  })
  it('il campo requires_signature estraneo al modello non cambia la firma richiesta dal flusso', async () => {
    const f = signedFormsClient(); f.db.forms_submissions = []; f.db.forms_templates[0].requires_signature = false
    const result = await persistSignedSubmission(f.client, { ...input, is_signed: true, signature_log: ORIGINAL_SIGNATURE })
    expect(result).toMatchObject({ status: 201, pdf_ready: true, submission: { is_signed: true } })
  })
  it('una compilazione senza richiesta di firma resta unsigned anche se passata evidenza', async () => {
    const f = signedFormsClient(); f.db.forms_submissions = []
    const result = await persistSignedSubmission(f.client, { ...input, is_signed: false, signature_log: ORIGINAL_SIGNATURE })
    expect(result).toMatchObject({ status: 201, pdf_ready: false, submission: { is_signed: false, signature_log: null, pdf_path: null } })
    expect(f.storage.uploads).toHaveLength(0)
  })
})
