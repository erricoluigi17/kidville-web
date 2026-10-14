// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { FORM, SCHOOL, STUDENT, PARENT, ORIGINAL_SIGNATURE, signedFormsDb } from '../fixtures/signed-forms'

async function subject() {
  const pending = import('@/lib/forms/signed-document')
  await expect(pending).resolves.toBeDefined()
  return pending
}
const data = () => {
  const db = signedFormsDb()
  return { template: db.forms_templates[0], student: db.alunni[0], signer: db.utenti[0], answers: db.forms_submissions[0].answers, signatureLog: ORIGINAL_SIGNATURE, source: 'contemporaneous' as const }
}

describe('snapshot immutabile del documento firmato', () => {
  it('congela tutto il contenuto e usa esclusivamente identità server', async () => {
    const { buildSignedDocumentSnapshot } = await subject()
    const input = data()
    const snapshot = buildSignedDocumentSnapshot(input)
    expect(snapshot).toMatchObject({ version: 1, source: 'contemporaneous', school_id: SCHOOL, signed_at: ORIGINAL_SIGNATURE.signed_at, form: { id: FORM, title: 'Autorizzazione uscita', description: 'Autorizzo la visita al museo.' }, student: { id: STUDENT, nome: 'Bambino' }, signer: { id: PARENT, nome: 'Genitore' } })
    input.template.title = 'Testo cambiato dopo la firma'
    expect(snapshot.form.title).toBe('Autorizzazione uscita')
  })
  it('hash documentale distinto da OTP, stabile dopo salvataggio ed estrazione', async () => {
    const { buildSignedDocumentSnapshot, freezeSignedDocument, signatureEvidence, readSignedDocumentSnapshot } = await subject()
    const snapshot = buildSignedDocumentSnapshot(data())
    const frozen = freezeSignedDocument(ORIGINAL_SIGNATURE, snapshot)
    expect(frozen.document_hash).toMatch(/^SHA256-[A-F0-9]{64}$/)
    expect(frozen.hash).toBe(ORIGINAL_SIGNATURE.hash)
    expect(signatureEvidence(frozen)).toEqual(ORIGINAL_SIGNATURE)
    expect(readSignedDocumentSnapshot(frozen)).toEqual(snapshot)
    expect(freezeSignedDocument(frozen, snapshot).document_hash).toBe(frozen.document_hash)
    expect(freezeSignedDocument(ORIGINAL_SIGNATURE, { ...snapshot, answers: { accept: false } }).document_hash).not.toBe(frozen.document_hash)
  })
  it('nessun istante viene dedotto da created_at o dall’orologio attuale', async () => {
    const { buildSignedDocumentSnapshot } = await subject()
    expect(() => buildSignedDocumentSnapshot({ ...data(), signatureLog: { method: 'OTP_EMAIL', hash: 'otp' } })).toThrow()
  })
  it('lo storico dichiara ricostruzione senza alterare l’evidenza originale', async () => {
    const { buildSignedDocumentSnapshot, freezeSignedDocument, signatureEvidence } = await subject()
    const snapshot = buildSignedDocumentSnapshot({ ...data(), source: 'reconstructed', reconstructedAt: '2026-10-14T08:00:00.000Z' })
    const frozen = freezeSignedDocument(ORIGINAL_SIGNATURE, snapshot)
    expect(snapshot).toMatchObject({ source: 'reconstructed', reconstructed_at: '2026-10-14T08:00:00.000Z', signed_at: ORIGINAL_SIGNATURE.signed_at })
    expect(signatureEvidence(frozen)).toEqual(ORIGINAL_SIGNATURE)
  })
})
