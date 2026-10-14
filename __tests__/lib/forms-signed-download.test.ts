import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ fetch: vi.fn(), scarica: vi.fn() }))
vi.mock('@/lib/native/scarica', async (original) => ({ ...await original<typeof import('@/lib/native/scarica')>(), scaricaDocumento: h.scarica }))
const ID = '55555555-5555-4555-8555-555555555555'
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', h.fetch); h.scarica.mockResolvedValue({ esito: 'web-blob' }) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function download() {
  const pending = import('@/lib/forms/signed-download')
  await expect(pending).resolves.toBeDefined()
  return (await pending).downloadSignedForm(ID)
}
describe('download del documento firmato con recupero senza OTP', () => {
  it('preparazione autonoma restituisce solo il percorso archiviato verificato dal server', async () => {
    const pending = await import('@/lib/forms/signed-download')
    expect(pending.prepareSignedForm).toBeTypeOf('function')
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_ready: true, submission: { pdf_path: 'signed_forms/reale.pdf' } }) })
    expect(await pending.prepareSignedForm(ID)).toMatchObject({ pdf_ready: true, pdf_path: 'signed_forms/reale.pdf' })
    expect(h.scarica).not.toHaveBeenCalled()
    expect(h.fetch).toHaveBeenCalledOnce()
  })
  it.each(['web-blob', 'nativo-file'])('prepara e scarica passando i byte all’helper %s', async (esito) => {
    const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' })
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_ready: true }) }).mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => pdf })
    h.scarica.mockResolvedValue({ esito })
    expect(await download()).toMatchObject({ ok: true })
    expect(h.fetch.mock.calls[0]).toEqual(['/api/forms/signed-pdf', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: ID }), cache: 'no-store' })])
    expect(h.fetch.mock.calls[1]).toEqual([`/api/forms/signed-pdf?id=${ID}`, expect.objectContaining({ cache: 'no-store' })])
    expect(h.scarica).toHaveBeenCalledWith(expect.objectContaining({ sorgente: pdf, mime: 'application/pdf', nomeFile: `autorizzazione-firmata-${ID.slice(0, 8)}.pdf` }))
  })
  it.each([['image/webp', 'webp'], ['image/heic', 'heic'], ['image/heif', 'heif'], ['image/jpeg', 'jpg'], ['application/octet-stream', 'bin']])('la scansione %s conserva MIME ed estensione', async (mime, extension) => {
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_ready: true }) }).mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': mime }), blob: async () => new Blob(['originale'], { type: mime }) })
    expect(await download()).toMatchObject({ ok: true })
    expect(h.scarica).toHaveBeenCalledWith(expect.objectContaining({ mime, nomeFile: `autorizzazione-firmata-${ID.slice(0, 8)}.${extension}` }))
  })
  it('PDF guasto non scarica e un retry prepara la stessa compilazione senza OTP', async () => {
    h.fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ pdf_ready: false, pdf_error: 'PDF_UPLOAD_FAILED' }) })
    expect(await download()).toMatchObject({ ok: false, pdf_unavailable: true, pdf_error: 'PDF_UPLOAD_FAILED' })
    expect(h.scarica).not.toHaveBeenCalled()
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_ready: true }) }).mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => new Blob(['pdf']) })
    expect(await download()).toMatchObject({ ok: true })
    expect(h.fetch.mock.calls.map(([url]) => url).some((url) => String(url).includes('otp'))).toBe(false)
  })
  it('un foglio nativo annullato non dà successo di download', async () => {
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_ready: true }) }).mockResolvedValueOnce({ ok: true, headers: new Headers(), blob: async () => new Blob(['pdf'], { type: 'application/pdf' }) })
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'annullato' })
    expect(await download()).toMatchObject({ ok: false, pdf_unavailable: false, delivery: { esito: 'non-riuscito' } })
  })
  it.each(['prepare', 'download'])('timeout %s: la firma resta salvata e il retry usa la stessa compilazione senza OTP', async (phase) => {
    const { downloadSignedForm } = await import('@/lib/forms/signed-download')
    const signature = { method: 'OTP_EMAIL', signed_at: '2026-10-14T10:00:00Z', hash: 'impronta-originale' }
    const row = { id: ID, is_signed: true, signature_log: structuredClone(signature), created_at: '2026-10-14T10:00:00Z' }
    const before = structuredClone(row)
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const budgets: number[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { budgets.push(ms); return timeout(15) })
    let first = true
    h.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (first) {
        first = false
        if (init.signal) await new Promise<never>((_resolve, reject) => {
          const signal = init.signal!
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        // Senza tetto il trasporto continua e il test deve fallire, non rimanere appeso.
      }
      return init.method === 'POST'
        ? { ok: true, json: async () => ({ pdf_ready: true }) }
        : { ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => new Blob(['%PDF-1.7']) }
    })
    const options = { alreadyPrepared: phase === 'download' }
    expect(await downloadSignedForm(ID, options)).toMatchObject({ ok: false, pdf_unavailable: true })
    expect(h.scarica).not.toHaveBeenCalled()
    expect(row).toEqual(before)
    expect(await downloadSignedForm(ID, options)).toMatchObject({ ok: true })
    expect(h.scarica).toHaveBeenCalledOnce()
    expect(row).toEqual(before)
    expect(budgets.length).toBeGreaterThanOrEqual(2)
    expect(budgets.every((ms) => ms === 120000)).toBe(true)
    for (const [url, init] of h.fetch.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/forms\/signed-pdf(?:\?id=.+)?$/)
      expect(String(url)).not.toContain('otp')
      if (init.method === 'POST') expect(JSON.parse(init.body)).toEqual({ id: ID })
    }
  })

})
