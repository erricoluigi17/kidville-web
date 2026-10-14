import { ARCHIVE_WRITER, ARCHIVE_WRITER_UNTIL, ARCHIVE_ERASURE } from '@/lib/forms/signed-path'
// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { creaFetchStrumentato } from '@/lib/logging/supabase-fetch'
import { signedFormsClient, SUBMISSION, STUDENT, SCHOOL } from '../fixtures/signed-forms'
import { ensureSignedSubmissionPdf, downloadSignedSubmissionPdf } from '@/lib/forms/signed-archive'
import { obliaModuliGenitori } from '@/lib/gdpr/moduli-genitori'
import { signatureEvidence, validateFrozenSignedDocument } from '@/lib/forms/signed-document'
import { authorizationStatus } from '@/lib/forms/authorization-status'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
const path = `signed_forms/${SCHOOL}/${SUBMISSION}.pdf`
function barriera() {
  let entra!: () => void
  let libera!: () => void
  const entrato = new Promise<void>((resolve) => { entra = resolve })
  const attesa = new Promise<void>((resolve) => { libera = resolve })
  return { entra, libera, entrato, attesa }
}
it('dopo remove/verifica e prima di delete il recupero è fenced e non ricrea un PDF orfano', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  const gate = barriera()
  f.hooks.beforeQuery = async ({ table, action }) => {
    if (table === 'forms_submissions' && action === 'delete') { gate.entra(); await gate.attesa }
  }
  const forgetting = obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')
  await gate.entrato
  expect(f.objects.has(path)).toBe(false)
  try {
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  } finally { gate.libera(); await forgetting }
  expect(f.db.forms_submissions).toEqual([])
  expect(f.objects.size).toBe(0)
})
it('un upload già in volo trattiene l’indice, poi si pulisce e permette il retry dell’oblio', async () => {
  const f = signedFormsClient(), gate = barriera()
  const upload = f.storage.upload.bind(f.storage)
  f.storage.upload = async (...args) => { gate.entra(); await gate.attesa; return upload(...args) }
  const recovering = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await gate.entrato
  const before = structuredClone(f.db.forms_submissions[0])
  try {
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
    expect(f.db.forms_submissions).toHaveLength(1)
    expect(signatureEvidence(f.db.forms_submissions[0].signature_log)).toEqual(signatureEvidence(before.signature_log))
  } finally { gate.libera() }
  expect(await recovering).toMatchObject({ pdf_ready: false, pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  expect(f.objects.size).toBe(0)
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
  expect(f.db.forms_submissions).toEqual([])
})
it('Storage rifiuta l’oblio: snapshot/hash/firma/data restano originali ma prepare/download/report sono bloccati', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  const before = structuredClone(f.db.forms_submissions[0])
  f.faults.remove = { code: '503' }
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  const current = f.db.forms_submissions[0]
  expect(signatureEvidence(current.signature_log)).toEqual(signatureEvidence(before.signature_log))
  expect(current.answers).toEqual(before.answers); expect(current.created_at).toBe(before.created_at)
  expect(validateFrozenSignedDocument(current)).toEqual(validateFrozenSignedDocument(before))
  expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  expect(await downloadSignedSubmissionPdf(f.client, current)).toMatchObject({ status: 409, pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  expect(authorizationStatus(f.db.forms_templates[0], current)).toMatchObject({ signed: false, autorizzato: false })
  delete f.faults.remove
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
})
it('fence DB rifiutato: non parte nessuna rimozione e l’evidenza rimane intatta', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  const before = structuredClone(f.db.forms_submissions[0])
  f.faults['forms_submissions:update'] = { code: '42501' }
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  expect(f.db.forms_submissions[0]).toEqual(before); expect(f.objects.has(path)).toBe(true)
})

it('DB guasto dopo upload: il writer durevole impedisce delete; l’oblio riparte dopo il lease scaduto', async () => {
  const f = signedFormsClient(), gate = barriera()
  const upload = f.storage.upload.bind(f.storage)
  f.storage.upload = async (...args) => {
    gate.entra(); await gate.attesa
    const result = await upload(...args)
    f.faults['forms_submissions:select'] = { code: 'XX000' }
    return result
  }
  const recovering = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await gate.entrato
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  gate.libera()
  expect((await recovering).pdf_ready).toBe(false)
  delete f.faults['forms_submissions:select']
  expect(f.objects.has(path)).toBe(true)
  expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER]).toBeTypeOf('string')
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  ;(f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
  expect(f.objects.size).toBe(0); expect(f.db.forms_submissions).toEqual([])
})
it('il fence con snapshot e risposte lunghi usa solo filtri compatti', async () => {
  const f = signedFormsClient()
  const { buildSignedDocumentSnapshot, freezeSignedDocument } = await import('@/lib/forms/signed-document')
  const row = f.db.forms_submissions[0]
  f.db.forms_templates[0].description = 'Testo lungo del modulo. '.repeat(2000)
  row.answers = { ...(row.answers as object), note: 'Risposta lunga. '.repeat(2000) }
  const snapshot = buildSignedDocumentSnapshot({ template: f.db.forms_templates[0], student: f.db.alunni[0], signer: f.db.utenti[0], answers: row.answers, signatureLog: row.signature_log, source: 'contemporaneous' })
  row.signature_log = freezeSignedDocument(row.signature_log, snapshot)
  f.objects.set(path, new Uint8Array([1, 2, 3])); f.faults.maxFilterBytes = 1024
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
  expect(f.objects.size).toBe(0)
})
it('il lease viene acquisito prima dell’upload anche con pdf_path già deterministico', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION); f.objects.clear()
  const gate = barriera(), upload = f.storage.upload.bind(f.storage)
  f.storage.upload = async (...args) => { gate.entra(); await gate.attesa; return upload(...args) }
  const recovering = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await gate.entrato
  try { expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 }) }
  finally { gate.libera() }
  expect(await recovering).toMatchObject({ pdf_ready: false, pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  expect(f.objects.size).toBe(0)
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
})

it('non avvia upload quando il lease residuo non copre il tetto Storage', async () => {
  const f = signedFormsClient()
  let reads = 0
  f.hooks.beforeQuery = async ({ table, action }) => {
    if (table === 'forms_submissions' && action === 'select' && ++reads === 3) {
      ;(f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = new Date(Date.now() + 1000).toISOString()
    }
  }
  expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SNAPSHOT_CONFLICT' })
  expect(f.storage.uploads).toHaveLength(0); expect(f.objects.size).toBe(0)
})
it('un writer superato non conferma e non rimuove il PDF o il token del successore', async () => {
  const f = signedFormsClient(), upload = f.storage.upload.bind(f.storage)
  f.storage.upload = async (...args) => {
    const result = await upload(...args)
    Object.assign(f.db.forms_submissions[0].signature_log as object, {
      [ARCHIVE_WRITER]: 'token-successore', [ARCHIVE_WRITER_UNTIL]: new Date(Date.now() + 600000).toISOString(),
    })
    return result
  }
  expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SNAPSHOT_CONFLICT' })
  expect(f.objects.has(path)).toBe(true)
  expect(f.db.forms_submissions[0].pdf_path).toBeNull()
  expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER]).toBe('token-successore')
})
it('acquisizioni simultanee fanno un solo upload e rilasciano solo il proprio token', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  f.objects.clear(); f.storage.uploads.length = 0
  const gate = barriera(); let claims = 0
  f.hooks.beforeQuery = async ({ table, action, payload }) => {
    const log = (payload as { signature_log?: Record<string, unknown> } | undefined)?.signature_log
    if (table === 'forms_submissions' && action === 'update' && typeof log?.[ARCHIVE_WRITER] === 'string' && !log[ARCHIVE_ERASURE] && ++claims <= 2) {
      if (claims === 2) gate.entra()
      await gate.attesa
    }
  }
  const a = ensureSignedSubmissionPdf(f.client, SUBMISSION), b = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await gate.entrato; gate.libera()
  expect((await Promise.all([a, b])).map((r) => r.pdf_ready)).toEqual([true, true])
  expect(f.storage.uploads).toHaveLength(1)
  expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER]).toBeUndefined()
})
it('rilascio rifiutato dal DB mantiene il lease e l’indice finché il writer scade', async () => {
  const f = signedFormsClient()
  f.hooks.beforeQuery = async ({ table, action, payload }) => {
    const log = (payload as { signature_log?: Record<string, unknown> } | undefined)?.signature_log
    const current = f.db.forms_submissions[0]?.signature_log as Record<string, unknown> | undefined
    if (table === 'forms_submissions' && action === 'update' && current?.[ARCHIVE_WRITER] && log && !log[ARCHIVE_WRITER]) {
      f.faults['forms_submissions:update'] = { code: 'XX000' }
    }
  }
  expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
  f.hooks.beforeQuery = undefined; delete f.faults['forms_submissions:update']
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  expect(f.objects.has(path)).toBe(true)
  const log = f.db.forms_submissions[0].signature_log as Record<string, unknown>
  log[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
  expect(f.objects.size).toBe(0)
})
it.each(['shared', 'protocollo'])('il writer fenced preserva il file con riferimento %s durante l’upload', async (kind) => {
  const f = signedFormsClient(), gate = barriera(), upload = f.storage.upload.bind(f.storage)
  f.storage.upload = async (...args) => { gate.entra(); await gate.attesa; return upload(...args) }
  const recovery = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await gate.entrato
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  if (kind === 'shared') f.db.alunni.push({ id: '99999999-9999-4999-8999-999999999999', documento_path: `/${path}` })
  else f.db.protocolli = [{ id: '99999999-9999-4999-8999-999999999999', file_originale: `https://storage.example.invalid/storage/v1/object/sign/form_attachments/${path}?token=fittizio` }]
  gate.libera()
  expect(await recovery).toMatchObject({ pdf_ready: false, pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  expect(f.objects.has(path)).toBe(true)
  const forgotten = await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')
  expect(forgotten).toMatchObject(kind === 'shared' ? { righe: 1, condivisi: 1 } : { righe: 0, protetti: 1 })
  expect(f.objects.has(path)).toBe(true)
})

it('lease scaduto prima dell’upload: il vecchio writer si ferma e il recovery può riprovare', async () => {
  const f = signedFormsClient(); let reads = 0
  f.hooks.beforeQuery = async ({ table, action }) => {
    if (table === 'forms_submissions' && action === 'select' && ++reads === 3) {
      ;(f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
    }
  }
  expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'SNAPSHOT_CONFLICT' })
  expect(f.storage.uploads).toHaveLength(0)
  f.hooks.beforeQuery = undefined
  expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
  expect(f.storage.uploads).toHaveLength(1)
})
it('un fence concorrente al rilascio rimane durevole dopo il CAS perso', async () => {
  const f = signedFormsClient(), gate = barriera()
  f.hooks.beforeQuery = async ({ table, action, payload }) => {
    const log = (payload as { signature_log?: Record<string, unknown> } | undefined)?.signature_log
    if (table === 'forms_submissions' && action === 'update' && (f.db.forms_submissions[0]?.signature_log as Record<string, unknown>)?.[ARCHIVE_WRITER] && log && !log[ARCHIVE_WRITER] && !log[ARCHIVE_ERASURE]) { gate.entra(); await gate.attesa }
  }
  const recovery = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await gate.entrato
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  gate.libera(); await recovery
  expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_ERASURE]).toBe(true)
  expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER]).toBeUndefined()
  expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_error: 'SUBMISSION_ERASURE_PENDING' })
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
})
it('delete CAS senza righe non dichiara successo se l’indice rimane vivo', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  f.hooks.beforeQuery = async ({ table, action }) => {
    if (table === 'forms_submissions' && action === 'delete') delete (f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_ERASURE]
  }
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  expect(f.db.forms_submissions).toHaveLength(1)
})

it('un’acquisizione letta prima del fence perde il CAS e non può avviare un nuovo writer', async () => {
  const f = signedFormsClient(); await ensureSignedSubmissionPdf(f.client, SUBMISSION)
  f.objects.clear(); f.storage.uploads.length = 0
  const claim = barriera(), deletion = barriera()
  f.hooks.beforeQuery = async ({ table, action, payload }) => {
    const log = (payload as { signature_log?: Record<string, unknown> } | undefined)?.signature_log
    if (table === 'forms_submissions' && action === 'update' && log?.[ARCHIVE_WRITER] && !log[ARCHIVE_ERASURE]) { claim.entra(); await claim.attesa }
    if (table === 'forms_submissions' && action === 'delete') { deletion.entra(); await deletion.attesa }
  }
  const recovery = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  await claim.entrato
  const forgetting = obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')
  await deletion.entrato
  claim.libera()
  try {
    expect(await recovery).toMatchObject({ pdf_ready: false, pdf_error: 'SUBMISSION_ERASURE_PENDING' })
    expect(f.storage.uploads).toHaveLength(0)
    expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER]).toBeUndefined()
  } finally { deletion.libera(); await forgetting }
  expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
})

it.each(['timeout', 'rete', '500', '502', '503', '504', '408', 'sconosciuto', 'sconosciuto-403', 'sconosciuto-collisione', '503-collisione', 'risposta-vuota'])('upload con esito incerto %s conserva lease/indice anche prima di un commit tardivo', async (fault) => {
  const f = signedFormsClient(), gate = barriera(), upload = f.storage.upload.bind(f.storage)
  const original = structuredClone(f.db.forms_submissions[0])
  let eventual!: Promise<unknown>
  f.storage.upload = async (...args) => {
    eventual = gate.attesa.then(() => upload(...args))
    if (fault === 'rete' || fault === 'timeout') throw Object.assign(new Error('upload non confermato'), { name: fault === 'timeout' ? 'TimeoutError' : 'TypeError' })
    // Risposta malformata deliberata: non è una conferma di upload.
    if (fault === 'risposta-vuota') return { data: null, error: null } as unknown as Awaited<ReturnType<typeof upload>>
    if (fault === 'sconosciuto-collisione' || fault === '503-collisione') return { data: null, error: { name: fault === '503-collisione' ? 'StorageApiError' : 'StorageUnknownError', status: fault === '503-collisione' ? 503 : 409, code: 'ResourceAlreadyExists' } }
    return { data: null, error: fault === 'sconosciuto-403' ? { name: 'StorageUnknownError', status: 403, originalError: new Error('errore rete') } : { statusCode: fault, message: 'upload non confermato' } }
  }
  try {
    expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_UPLOAD_FAILED' })
    const row = f.db.forms_submissions[0], log = row.signature_log as Record<string, unknown>
    expect(log[ARCHIVE_WRITER]).toBeTypeOf('string')
    expect(Date.parse(String(log[ARCHIVE_WRITER_UNTIL]))).toBeGreaterThan(Date.now() + 9 * 60000)
    expect(signatureEvidence(log)).toEqual(signatureEvidence(original.signature_log))
    expect(row.created_at).toBe(original.created_at); expect(row.answers).toEqual(original.answers)
    const snapshot = validateFrozenSignedDocument(row)
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
    expect(f.db.forms_submissions).toHaveLength(1); expect(f.objects.size).toBe(0)
    gate.libera(); await eventual
    expect(f.objects.has(path)).toBe(true)
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
    expect(validateFrozenSignedDocument(f.db.forms_submissions[0])).toEqual(snapshot)
    ;(f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
    expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
  } finally { gate.libera(); await eventual }
})
it('SDK reale: il timeout dopo body accettato conserva l’indice prima del commit tardivo sul solo loopback', async () => {
  const f = signedFormsClient(), accepted = barriera(), commit = barriera(), committed = barriera()
  const realFetch = globalThis.fetch
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of req) chunks.push(chunk)
    const bytes = new Uint8Array(Buffer.concat(chunks))
    accepted.entra(); await commit.attesa
    f.objects.set(path, bytes); committed.entra()
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ Key: `form_attachments/${path}` })) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const fetchLocal: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== '127.0.0.1' || url.port !== String(port)) throw new Error('Rete esterna vietata nel test')
    return realFetch(input, init)
  }
  const sdk = createClient(`http://127.0.0.1:${port}`, 'chiave-loopback-fittizia', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: creaFetchStrumentato(fetchLocal, { timeoutMs: 100 }) } })
  f.storage.upload = async (...args) => sdk.storage.from('form_attachments').upload(args[0], args[1], args[2] as { upsert?: boolean; contentType?: string })
  // Staging del SOLO test: il timer nativo parte dopo la ricezione del body.
  // La rete e l'abort restano reali; il carico della CI non può anticipare
  // il timeout rispetto al punto di concorrenza che vogliamo riprodurre.
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    void accepted.entrato.then(() => {
      const signal = nativeTimeout(ms)
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    })
    return controller.signal
  })
  const recovery = ensureSignedSubmissionPdf(f.client, SUBMISSION)
  try {
    await accepted.entrato
    expect(await recovery).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_UPLOAD_FAILED' })
    const log = f.db.forms_submissions[0].signature_log as Record<string, unknown>
    expect(log[ARCHIVE_WRITER]).toBeTypeOf('string')
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
    expect(f.db.forms_submissions).toHaveLength(1); expect(f.objects.size).toBe(0)
    commit.libera(); await committed.entrato
    expect(new TextDecoder().decode(f.objects.get(path)!.subarray(0, 5))).toBe('%PDF-')
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
    ;(f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
    expect(f.db.forms_submissions).toEqual([]); expect(f.objects.size).toBe(0)
  } finally {
    commit.libera(); await committed.entrato; await recovery
    deadline.mockRestore()
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each(['400', '401', '403', '404', '405', '413', '415', '422'])('rifiuto Storage esplicito %s rilascia il writer e permette retry immediato', async (statusCode) => {
  const f = signedFormsClient()
  f.faults.upload = { statusCode, message: 'upload rifiutato' }
  expect(await ensureSignedSubmissionPdf(f.client, SUBMISSION)).toMatchObject({ pdf_ready: false, pdf_error: 'PDF_UPLOAD_FAILED' })
  expect((f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER]).toBeUndefined()
  expect(f.objects.size).toBe(0)
  delete f.faults.upload
  expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
})
it('retry dopo commit tardivo verifica e collega gli stessi bytes senza upload né rilascio prematuro del lease', async () => {
  const f = signedFormsClient(), gate = barriera(), upload = f.storage.upload.bind(f.storage)
  let eventual!: Promise<unknown>
  f.storage.upload = async (...args) => {
    eventual = gate.attesa.then(() => upload(...args))
    return { data: null, error: { statusCode: '503', message: 'risposta upload incerta' } }
  }
  expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(false)
  const original = structuredClone(f.db.forms_submissions[0])
  gate.libera(); await eventual
  const bytes = f.objects.get(path)!
  expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(true)
  expect(f.storage.uploads).toHaveLength(1); expect(f.objects.get(path)).toBe(bytes)
  const row = f.db.forms_submissions[0]
  expect(row.pdf_path).toBe(path); expect(row.signature_log).toEqual(original.signature_log)
  expect(row.created_at).toBe(original.created_at); expect(row.answers).toEqual(original.answers)
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
  ;(row.signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
  expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 1, nonRimossi: 0 })
  expect(f.objects.size).toBe(0)
})
it.each(['shared', 'protocollo'])('il commit tardivo con riferimento %s rimane protetto anche dopo la scadenza', async (kind) => {
  const f = signedFormsClient(), gate = barriera(), upload = f.storage.upload.bind(f.storage)
  let eventual!: Promise<unknown>
  f.storage.upload = async (...args) => {
    eventual = gate.attesa.then(() => upload(...args))
    throw new Error('risposta upload non ricevuta')
  }
  try {
    expect((await ensureSignedSubmissionPdf(f.client, SUBMISSION)).pdf_ready).toBe(false)
    const original = structuredClone(f.db.forms_submissions[0])
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject({ righe: 0, nonRimossi: 1 })
    if (kind === 'shared') f.db.alunni.push({ id: '99999999-9999-4999-8999-999999999999', documento_path: `/${path}` })
    else f.db.protocolli = [{ id: '99999999-9999-4999-8999-999999999999', file_originale: `https://storage.example.invalid/storage/v1/object/sign/form_attachments/${path}?token=fittizio` }]
    gate.libera(); await eventual
    const bytes = f.objects.get(path)!
    ;(f.db.forms_submissions[0].signature_log as Record<string, unknown>)[ARCHIVE_WRITER_UNTIL] = '2000-01-01T00:00:00Z'
    expect(await obliaModuliGenitori(f.client, { studentId: STUDENT }, 'test')).toMatchObject(kind === 'shared' ? { righe: 1, condivisi: 1 } : { righe: 0, protetti: 1 })
    expect(f.objects.get(path)).toBe(bytes)
    if (kind === 'protocollo') expect(signatureEvidence(f.db.forms_submissions[0].signature_log)).toEqual(signatureEvidence(original.signature_log))
  } finally { gate.libera(); await eventual }
})
