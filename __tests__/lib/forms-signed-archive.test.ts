// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ARCHIVE_WRITER, ARCHIVE_WRITER_UNTIL } from '@/lib/forms/signed-path'
import { signedFormsClient, SUBMISSION, SCHOOL, ORIGINAL_SIGNATURE } from '../fixtures/signed-forms'

const h = vi.hoisted(() => ({ generationFails: false, generated: 0, log: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: h.log, logOk: h.log }))
vi.mock('@/lib/forms/signed-pdf', async (orig) => {
  const actual = await orig<typeof import('@/lib/forms/signed-pdf')>()
  return { ...actual, buildSignedPdfSuCarta: async (...args: Parameters<typeof actual.buildSignedPdfSuCarta>) => {
    h.generated++
    if (h.generationFails) throw new Error('generatore indisponibile')
    return actual.buildSignedPdfSuCarta(...args)
  } }
})
beforeEach(() => { h.generationFails = false; h.generated = 0; h.log.mockClear() })
async function subject() {
  const pending = import('@/lib/forms/signed-archive'); await expect(pending).resolves.toBeDefined(); return pending
}
describe('archivio PDF privato e recupero idempotente', () => {
  it('ricostruisce uno storico, preserva firma, carica bytes veri e solo poi salva percorso', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    const result = await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    expect(result).toMatchObject({ pdf_ready: true, status: 200 })
    const row = f.db.forms_submissions[0]
    expect(row.pdf_path).toBe(`signed_forms/${SCHOOL}/${SUBMISSION}.pdf`)
    expect(row.signature_log).toMatchObject({ ...ORIGINAL_SIGNATURE, document_snapshot: { source: 'reconstructed', signed_at: ORIGINAL_SIGNATURE.signed_at } })
    expect(f.storage.uploads).toHaveLength(1)
    expect(f.storage.uploads[0].options).toEqual({ upsert: false, contentType: 'application/pdf' })
    expect(new TextDecoder().decode(f.objects.get(String(row.pdf_path))!.slice(0, 5))).toBe('%PDF-')
  })
  it('ripetere prepara restituisce gli stessi bytes senza rigenerare o sovrascrivere', async () => {
    const { ensureSignedSubmissionPdf, downloadSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const first = await downloadSignedSubmissionPdf(f.client, f.db.forms_submissions[0])
    await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const second = await downloadSignedSubmissionPdf(f.client, f.db.forms_submissions[0])
    expect(second.bytes).toEqual(first.bytes)
    expect(h.generated).toBe(1)
    expect(f.storage.uploads).toHaveLength(1)
  })
  it.each(['generation', 'upload', 'path'])('firma durevole, errore %s recuperabile senza OTP', async (fault) => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    // Congela lo snapshot prima di iniettare il guasto sul SOLO percorso.
    await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    f.objects.clear(); f.db.forms_submissions[0].pdf_path = null; f.storage.uploads.length = 0
    h.generationFails = fault === 'generation'
    if (fault === 'upload') f.faults.upload = { statusCode: '503', message: 'provider unavailable' }
    if (fault === 'path') f.faults['forms_submissions:update'] = { code: 'XX000', message: 'write failed' }
    const result = await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    expect(result).toMatchObject({ pdf_ready: false, pdf_error: { generation: 'PDF_GENERATION_FAILED', upload: 'PDF_UPLOAD_FAILED', path: 'PDF_PATH_SAVE_FAILED' }[fault] })
    expect(f.db.forms_submissions[0].is_signed).toBe(true)
    expect(f.db.forms_submissions[0].pdf_path).toBeNull()
    expect(result.submission).toBeDefined()
    expect(h.log.mock.calls.some((call) => call[1] === 'error')).toBe(true)
    h.generationFails = false; delete f.faults.upload; delete f.faults['forms_submissions:update']
    if (fault === 'upload') {
      const log = f.db.forms_submissions[0].signature_log as Record<string, unknown>
      expect(log[ARCHIVE_WRITER]).toBeTypeOf('string')
      // Un 503 non dimostra che l'upload sia stato rifiutato: il retry che può
      // produrre nuovi bytes aspetta la scadenza conservativa del writer.
      log[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
    }
    const bytesStored = Array.from(f.objects.values())[0]
    expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
    if (bytesStored) expect(Array.from(f.objects.values())[0]).toEqual(bytesStored)
  })
  it('download generico fallito non viene scambiato per oggetto assente', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.faults.download = { statusCode: '403', message: 'Access denied' }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_DOWNLOAD_FAILED' })
    expect(f.storage.uploads).toHaveLength(0); expect(h.generated).toBe(0)
  })
  it('due richieste simultanee congelano lo stesso snapshot e non sovrascrivono il vincitore', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    const results = await Promise.all([ensureSignedSubmissionPdf(f.client, SUBMISSION), ensureSignedSubmissionPdf(f.client, SUBMISSION)])
    expect(results.every((r) => r.pdf_ready)).toBe(true)
    expect(f.objects.size).toBe(1)
    expect(f.storage.uploads.every((u) => (u.options as { upsert: boolean }).upsert === false)).toBe(true)
    expect(results[0].submission?.signature_log).toEqual(results[1].submission?.signature_log)
  })
  it.each(['signature', 'template', 'unsigned'])('non fabbrica PDF con %s mancante', async (fault) => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    if (fault === 'signature') f.db.forms_submissions[0].signature_log = { method: 'OTP_EMAIL' }
    if (fault === 'template') f.db.forms_templates = []
    if (fault === 'unsigned') f.db.forms_submissions[0].is_signed = false
    const result = await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    expect(result.pdf_ready).toBe(false); expect(result.pdf_error).toBeDefined()
    expect(f.storage.uploads).toHaveLength(0)
  })
  it('anagrafica cambiata: usa il nominativo storico della firma', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.db.utenti[0].nome = 'Nome successivo'
    const result = await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const snapshot = (result.submission?.signature_log as { document_snapshot: { signer: { nome: string } } }).document_snapshot
    expect(snapshot.signer.nome).toBe('Genitore')
  })
  it.each([
    { details: { nome: 'Nome storico' }, expected: { nome: 'Nome storico', cognome: 'Cognome attuale' } },
    { details: { cognome: 'Cognome storico' }, expected: { nome: 'Nome attuale', cognome: 'Cognome storico' } },
  ])('nominativo storico parziale: integra solo il campo mancante (%s)', async ({ details, expected }) => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    const signature = f.db.forms_submissions[0].signature_log as Record<string, unknown>
    signature.parent_details = details
    f.db.utenti[0].nome = 'Nome attuale'; f.db.utenti[0].cognome = 'Cognome attuale'
    const result = await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    expect(result.pdf_ready).toBe(true)
    const snapshot = (result.submission?.signature_log as { document_snapshot: { signer: Record<string, unknown> } }).document_snapshot
    expect(snapshot.signer).toMatchObject(expected)
    expect((result.submission?.signature_log as Record<string, unknown>).parent_details).toEqual(details)
  })
  it('la scansione cartacea viene servita intatta e non rigenerata', async () => {
    const { ensureSignedSubmissionPdf, downloadSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); const row = f.db.forms_submissions[0]
    row.origine = 'cartaceo'; row.signature_log = null; row.pdf_path = 'cartaceo/scansione.pdf'
    const scan = new Uint8Array([37, 80, 68, 70, 45, 49]); f.objects.set(String(row.pdf_path), scan)
    expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
    expect((await downloadSignedSubmissionPdf(f.client, row)).bytes).toEqual(scan)
    expect(h.generated).toBe(0); expect(f.storage.uploads).toHaveLength(0)
  })
  it('GET/helper download senza bytes non crea documenti', async () => {
    const { downloadSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    expect(await downloadSignedSubmissionPdf(f.client, f.db.forms_submissions[0])).toMatchObject({ pdf_error: 'PDF_NOT_FOUND', status: 404 })
    expect(h.generated).toBe(0); expect(f.storage.uploads).toHaveLength(0)
  })
  it('un PDF digitale originale già archiviato mantiene percorso e bytes pregressi', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const { buildSignedPdfContent } = await import('@/lib/forms/signed-pdf')
    const { buildSignedDocumentSnapshot, freezeSignedDocument } = await import('@/lib/forms/signed-document')
    const f = signedFormsClient(), row = f.db.forms_submissions[0]
    const snapshot = buildSignedDocumentSnapshot({ template: f.db.forms_templates[0], student: f.db.alunni[0], signer: f.db.utenti[0], answers: row.answers, signatureLog: row.signature_log, source: 'contemporaneous' })
    const originalBytes = buildSignedPdfContent({ submissionId: SUBMISSION, snapshot, signatureLog: ORIGINAL_SIGNATURE, contentHash: freezeSignedDocument(ORIGINAL_SIGNATURE, snapshot).document_hash })
    row.pdf_path = 'signed_forms/vecchio-percorso/originale.pdf'; f.objects.set(String(row.pdf_path), originalBytes)
    const result = await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    expect(result).toMatchObject({ pdf_ready: true, submission: { pdf_path: 'signed_forms/vecchio-percorso/originale.pdf' } })
    expect(f.objects.get(String(row.pdf_path))).toEqual(originalBytes)
    expect(row.signature_log).toEqual(ORIGINAL_SIGNATURE)
    expect(f.storage.uploads).toHaveLength(0); expect(h.generated).toBe(0)
  })
  it('guasto generico del percorso pregresso blocca ricostruzione senza overwrite', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.db.forms_submissions[0].pdf_path = 'signed_forms/vecchio-percorso/originale.pdf'
    f.faults.download = { statusCode: '503', message: 'provider unavailable' }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_DOWNLOAD_FAILED' })
    expect(f.db.forms_submissions[0].signature_log).toEqual(ORIGINAL_SIGNATURE)
    expect(f.storage.uploads).toHaveLength(0)
  })
  it('testo oltre 8KB non inserisce l’intero snapshot nel filtro URL del collegamento PDF', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.faults.maxFilterBytes = 8192
    f.db.forms_templates[0].description = 'Testo integrale di autorizzazione lungo. '.repeat(500)
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: true })
    const pathUpdate = f.actions.find((a) => a.action === 'update' && !!(a.payload as { pdf_path?: string })?.pdf_path)
    expect(pathUpdate?.filters).toEqual(expect.arrayContaining([['signature_log->>document_hash', expect.stringMatching(/^SHA256-/)]]))
  })
  it('un’eccezione durante upload è diagnosticata come upload, con firma durevole', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.storage.upload = vi.fn().mockRejectedValue(new Error('errore rete upload'))
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_UPLOAD_FAILED', submission: { is_signed: true } })
  })
  it('glifi non rappresentabili preservano firma e segnalano errore di generazione', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.db.forms_templates[0].description = 'Consenso 漢'
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_GENERATION_FAILED', submission: { is_signed: true } })
    expect(f.storage.uploads).toHaveLength(0)
  })
  it('snapshot non salvabile: nessun upload o falsa disponibilità', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); f.faults['forms_submissions:update'] = { code: 'XX000', message: 'write failed' }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SNAPSHOT_SAVE_FAILED' })
    expect(f.db.forms_submissions[0].signature_log).toEqual(ORIGINAL_SIGNATURE)
    expect(f.storage.uploads).toHaveLength(0)
  })
  it('hash corrotto non viene riparato riscrivendo l’evidenza già congelata', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const row = f.db.forms_submissions[0]; (row.signature_log as Record<string, unknown>).document_hash = 'hash-inventato'
    const before = structuredClone(row.signature_log)
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SNAPSHOT_INVALID' })
    expect(row.signature_log).toEqual(before)
    expect(f.storage.uploads).toHaveLength(1)
  })
  it('modello e anagrafica cambiati dopo freeze non rigenerano il documento archiviato', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const before = structuredClone(f.db.forms_submissions[0].signature_log), bytes = Array.from(f.objects.values())[0]
    f.db.forms_templates[0].title = 'Titolo attuale differente'; f.db.alunni[0].nome = 'Nome differente'
    expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
    expect(f.db.forms_submissions[0].signature_log).toEqual(before)
    expect(Array.from(f.objects.values())[0]).toEqual(bytes)
  })
  it('log di successo e guasto non contengono risposte né nominativi', async () => {
    const { ensureSignedSubmissionPdf } = await subject(); const f = signedFormsClient()
    await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    const logs = JSON.stringify(h.log.mock.calls)
    for (const secret of ['Genitore', 'Bambino', 'Risposta presente', ORIGINAL_SIGNATURE.email, ORIGINAL_SIGNATURE.hash]) expect(logs).not.toContain(secret)
  })
  it('un oblio che cancella la riga durante upload non lascia il PDF orfano', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    const upload = f.storage.upload.bind(f.storage)
    f.storage.upload = async (...args) => {
      const result = await upload(...args)
      f.db.forms_submissions = [] // la cancellazione arriva dopo la lettura/lo snapshot
      return result
    }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false })
    expect(f.objects.size).toBe(0)
  })
  it('un oblio che revoca la firma durante upload non può essere ricreato dal recupero', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    const upload = f.storage.upload.bind(f.storage)
    f.storage.upload = async (...args) => {
      const result = await upload(...args)
      Object.assign(f.db.forms_submissions[0], { is_signed: false, signature_log: null, answers: {} })
      return result
    }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false })
    expect(f.objects.size).toBe(0)
  })

  it('oblio durante rigenerazione con percorso già deterministico non lascia un upload orfano', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    await ensureSignedSubmissionPdf(f.client, SUBMISSION)
    f.objects.clear()
    const upload = f.storage.upload.bind(f.storage)
    f.storage.upload = async (...args) => {
      const result = await upload(...args)
      f.db.forms_submissions = []
      return result
    }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false })
    expect(f.objects.size).toBe(0)
  })

  it('una lettura DB guasta dopo upload mantiene il PDF per il recupero successivo', async () => {
    const { ensureSignedSubmissionPdf } = await subject()
    const f = signedFormsClient()
    const upload = f.storage.upload.bind(f.storage)
    f.storage.upload = async (...args) => {
      const result = await upload(...args)
      f.faults['forms_submissions:select'] = { code: 'XX000' }
      return result
    }
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SUBMISSION_READ_FAILED' })
    expect(f.objects.size).toBe(1)
    delete f.faults['forms_submissions:select']
    expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
  })

})
