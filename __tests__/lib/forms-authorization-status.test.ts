// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildSignedDocumentSnapshot, freezeSignedDocument } from '@/lib/forms/signed-document'
import { signedFormsDb, ORIGINAL_SIGNATURE } from '../fixtures/signed-forms'

async function status(template: Record<string, unknown>, submission: Record<string, unknown> | null) {
  const pending = import('@/lib/forms/authorization-status')
  await expect(pending).resolves.toBeDefined()
  return (await pending).authorizationStatus(template, submission)
}
function fixture() {
  const db = signedFormsDb()
  const template: Record<string, unknown> = { ...db.forms_templates[0], form_type: 'autorizzazione' }
  return { template, submission: db.forms_submissions[0], db }
}
describe('stato autorizzazione distinto da compilazione e firma', () => {
  it('risposta assente e compilazione non firmata non autorizzano', async () => {
    const { template, submission } = fixture()
    expect(await status(template, null)).toMatchObject({ autorizzato: false, signed: false, stato_autorizzazione: 'risposta_assente', signed_at: null })
    expect(await status(template, { ...submission, is_signed: false })).toMatchObject({ autorizzato: false, signed: false, stato_autorizzazione: 'firma_mancante' })
  })
  it.each([false, undefined, 'true', 1, ['yes']])('consenso required %s non autorizza', async (accept) => {
    const { template, submission } = fixture()
    expect(await status(template, { ...submission, answers: { accept } })).toMatchObject({ autorizzato: false, stato_autorizzazione: 'consenso_negato_o_incompleto' })
  })
  it('solo is_signed non basta; evidenza valida e consensi true autorizzano', async () => {
    const { template, submission } = fixture()
    expect(await status(template, { ...submission, signature_log: {} })).toMatchObject({ autorizzato: false, stato_autorizzazione: 'firma_da_verificare' })
    expect(await status(template, submission)).toMatchObject({ autorizzato: true, signed: true, signed_at: ORIGINAL_SIGNATURE.signed_at, stato_autorizzazione: 'autorizzato' })
  })
  it('consenso condizionale nascosto non è richiesto', async () => {
    const { template, submission } = fixture()
    template.fields = [{ id: 'hidden', type: 'checkbox', required: true, condition: { field_id: 'bus', operator: 'eq', value: true } }]
    expect(await status(template, submission)).toMatchObject({ autorizzato: true })
  })
  it('snapshot congelato ha precedenza sul modello modificato; hash corrotto richiede verifica', async () => {
    const { template, submission, db } = fixture()
    const snapshot = buildSignedDocumentSnapshot({ template, student: db.alunni[0], signer: db.utenti[0], answers: submission.answers, signatureLog: submission.signature_log, source: 'contemporaneous' })
    submission.signature_log = freezeSignedDocument(submission.signature_log, snapshot)
    template.fields = [{ id: 'nuovo', type: 'checkbox', required: true }]
    expect(await status(template, submission)).toMatchObject({ autorizzato: true })
    submission.signature_log = { ...submission.signature_log as object, document_hash: 'corrotto' }
    expect(await status(template, submission)).toMatchObject({ autorizzato: false, stato_autorizzazione: 'firma_da_verificare' })
  })
  it('cartaceo PROXY_CARTACEO validato dallo staff usa originale senza spunte digitali', async () => {
    const { template, submission } = fixture()
    const paper = { ...submission, origine: 'cartaceo', pdf_path: 'originale.pdf', answers: { proxy: true }, signature_log: { method: 'PROXY_CARTACEO', acquisito_da: '66666666-6666-4666-8666-666666666666', signed_at: ORIGINAL_SIGNATURE.signed_at } }
    expect(await status(template, paper)).toMatchObject({ autorizzato: true, metodo: 'Cartaceo' })
    expect(await status(template, { ...paper, pdf_path: null })).toMatchObject({ autorizzato: false, stato_autorizzazione: 'firma_da_verificare' })
  })
  it.each(['gradimento', 'sondaggio'])('%s senza OTP è risposta ricevuta', async (form_type) => {
    const { template, submission } = fixture()
    expect(await status({ ...template, form_type }, { ...submission, is_signed: false })).toMatchObject({ autorizzato: false, signed: false, stato_autorizzazione: 'risposta_ricevuta' })
  })
})
