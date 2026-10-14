// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { signedFormsClient, SUBMISSION, SCHOOL, PARENT } from '../fixtures/signed-forms'

const h = vi.hoisted(() => ({
  auth: vi.fn(), session: vi.fn(), schools: vi.fn(), client: null as unknown,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireUserDaSessioneVerificata: h.auth, requireSessioneAuth: h.session }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: h.schools }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.client }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  h.auth.mockResolvedValue({ user: { id: PARENT, role: 'genitore', nome: 'Genitore', cognome: 'Esempio' } })
  h.session.mockResolvedValue({ sessione: { authUserId: PARENT } })
  h.schools.mockResolvedValue([SCHOOL])
})
async function routes() {
  const pending = import('@/app/api/forms/signed-pdf/route'); await expect(pending).resolves.toBeDefined(); return pending
}
function req(method: 'GET' | 'POST', id: unknown = SUBMISSION) {
  return new NextRequest(`http://localhost/api/forms/signed-pdf${method === 'GET' ? `?id=${id}` : ''}`, { method, headers: { 'content-type': 'application/json', 'x-user-id': PARENT }, ...(method === 'POST' ? { body: JSON.stringify({ id }) } : {}) })
}
describe('route PDF firma completo: accesso e separazione prepare/download', () => {
  it('POST prepara realmente; GET restituisce gli stessi bytes e header privati', async () => {
    const { POST, GET } = await routes(); const f = signedFormsClient(); h.client = f.client
    const post = await POST(req('POST'))
    expect(post.status).toBe(200); expect(await post.json()).toMatchObject({ pdf_ready: true })
    const get = await GET(req('GET'))
    expect(get.status).toBe(200)
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(get.headers.get('content-type')).toBe('application/pdf')
    expect(get.headers.get('x-kidville-document-status')).toBe('signed')
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(Array.from(f.objects.values())[0])
    expect(f.storage.uploads).toHaveLength(1)
  })
  it('GET manca il PDF: 404 esplicito senza generazione o upload', async () => {
    const { GET } = await routes(); const f = signedFormsClient(); h.client = f.client
    const response = await GET(req('GET'))
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ pdf_error: 'PDF_NOT_FOUND' })
    expect(f.storage.uploads).toHaveLength(0)
  })
  it.each([
    { mime: 'image/webp', extension: 'webp' },
    { mime: 'image/heic', extension: 'heic' },
    { mime: 'image/heif', extension: 'heif' },
  ])('scansione originale $mime mantiene bytes, MIME ed estensione', async ({ mime, extension }) => {
    const { GET } = await routes(); const f = signedFormsClient(); h.client = f.client
    f.db.forms_submissions[0].origine = 'cartaceo'
    f.db.forms_submissions[0].signature_log = null
    f.db.forms_submissions[0].pdf_path = `cartaceo/scansione.${extension}`
    const original = new Uint8Array([82, 73, 70, 70, 19, 0, 0, 0, 87, 69, 66, 80])
    f.storage.download = async () => ({ data: new Blob([original], { type: mime }), error: null })
    const response = await GET(req('GET'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mime)
    expect(response.headers.get('content-disposition')).toContain(`.${extension}"`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original)
    expect(f.storage.uploads).toHaveLength(0)
  })
  it.each([
    { extension: 'webp', expected: 'image/webp', bytes: [82, 73, 70, 70, 19, 0, 0, 0, 87, 69, 66, 80] },
    { extension: 'heic', expected: 'image/heic', bytes: [0, 0, 0, 20, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 104, 101, 105, 99] },
    { extension: 'heif', expected: 'image/heif', bytes: [0, 0, 0, 20, 102, 116, 121, 112, 109, 105, 102, 49, 0, 0, 0, 0, 109, 105, 102, 49] },
  ])('scansione con MIME generico identifica $extension dai bytes originali', async ({ extension, expected, bytes }) => {
    const { GET } = await routes(); const f = signedFormsClient(); h.client = f.client
    const row = f.db.forms_submissions[0]
    row.origine = 'cartaceo'; row.signature_log = null; row.pdf_path = 'cartaceo/scansione-senza-estensione'
    const original = new Uint8Array(bytes)
    f.storage.download = async () => ({ data: new Blob([original], { type: 'application/octet-stream' }), error: null })
    const response = await GET(req('GET'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(expected)
    expect(response.headers.get('content-disposition')).toContain(`.${extension}"`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original)
  })
  it('MIME generico senza magic riconoscibile usa l’estensione autorevole della scansione', async () => {
    const { GET } = await routes(); const f = signedFormsClient(); h.client = f.client
    const row = f.db.forms_submissions[0]
    row.origine = 'cartaceo'; row.signature_log = null; row.pdf_path = 'cartaceo/scansione.webp'
    const original = new Uint8Array([1, 2, 3, 4])
    f.storage.download = async () => ({ data: new Blob([original], { type: 'application/octet-stream' }), error: null })
    const response = await GET(req('GET'))
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('content-disposition')).toContain('.webp"')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original)
  })
  it('tipo della scansione ignoto resta binario senza dichiarare un PDF inventato', async () => {
    const { GET } = await routes(); const f = signedFormsClient(); h.client = f.client
    const row = f.db.forms_submissions[0]
    row.origine = 'cartaceo'; row.signature_log = null; row.pdf_path = 'cartaceo/scansione.sconosciuta'
    const original = new Uint8Array([1, 2, 3, 4])
    f.storage.download = async () => ({ data: new Blob([original], { type: 'application/octet-stream' }), error: null })
    const response = await GET(req('GET'))
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('.bin"')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original)
  })
  it.each(['GET', 'POST'] as const)('anonimo o solo header spoofato: %s negato prima di storage e DB', async (method) => {
    const r = await routes(); const f = signedFormsClient(); h.client = f.client
    h.session.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    expect((await r[method](req(method))).status).toBe(401)
    expect(f.actions).toHaveLength(0); expect(f.storage.downloads).toHaveLength(0)
  })
  it.each(['GET', 'POST'] as const)('altro firmatario: %s negato senza PII o bytes privati', async (method) => {
    const r = await routes(); const f = signedFormsClient(); h.client = f.client
    h.auth.mockResolvedValue({ user: { id: '66666666-6666-4666-8666-666666666666', role: 'genitore' } })
    const response = await r[method](req(method))
    expect([403, 404]).toContain(response.status)
    expect(await response.text()).not.toContain('Genitore')
    expect(f.storage.downloads).toHaveLength(0); expect(f.storage.uploads).toHaveLength(0)
  })
  it('staff legge solo nella sede attiva del modello', async () => {
    const { POST } = await routes(); const f = signedFormsClient(); h.client = f.client
    const user = { id: '77777777-7777-4777-8777-777777777777', role: 'segreteria' }
    h.auth.mockResolvedValue({ user }); h.session.mockResolvedValue({ sessione: { authUserId: user.id } })
    expect((await POST(req('POST'))).status).toBe(200)
    expect(h.auth).toHaveBeenCalledWith(expect.anything(), user.id)
    expect(h.schools).toHaveBeenCalledWith(expect.anything(), f.client, user)
  })
  it.each([{ schools: [] }, { schools: ['88888888-8888-4888-8888-888888888888'] }])('staff altra sede o selezione vuota: nessuna archiviazione (%s)', async ({ schools }) => {
    const { POST } = await routes(); const f = signedFormsClient(); h.client = f.client
    const user = { id: '77777777-7777-4777-8777-777777777777', role: 'segreteria' }
    h.auth.mockResolvedValue({ user }); h.session.mockResolvedValue({ sessione: { authUserId: user.id } }); h.schools.mockResolvedValue(schools)
    expect([403, 404]).toContain((await POST(req('POST'))).status)
    expect(f.storage.uploads).toHaveLength(0); expect(f.storage.downloads).toHaveLength(0)
  })
  it.each(['GET', 'POST'] as const)('UUID malformato su %s produce 400', async (method) => {
    const r = await routes(); const f = signedFormsClient(); h.client = f.client
    expect((await r[method](req(method, 'non-uuid'))).status).toBe(400)
    expect(f.actions).toHaveLength(0)
  })
})
