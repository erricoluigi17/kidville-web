import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// /api/news/upload (POST) e /api/news/instagram/valida (POST).
//
// upload: pattern gallery/upload — requireDocente, ogni video → 409 (il percorso
//   vecchio dei video è chiuso: passano solo da /api/video-uploads), bucket «news»
//   garantito a runtime, mai il nome file nei log. valida: parseInstagramUrl → 400 se
//   invalido → health-check via externalFetch('instagram', …) →
//   {valido, shortcode, embed_url, raggiungibile}.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  externalFetch: vi.fn(),
  uploadError: null as { message: string } | null,
  lastUploadPath: null as string | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/logging/external', () => ({ externalFetch: (...a: unknown[]) => h.externalFetch(...a) }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      listBuckets: async () => ({ data: [{ name: 'news' }], error: null }),
      createBucket: async () => ({ data: null, error: null }),
      updateBucket: async () => ({ data: null, error: null }),
      // Dal 2026-08-01 il media sosta nel bucket PRIVATO `news_bozze` finché il
      // gate del consenso non è passato: l'editor riceve un indirizzo firmato,
      // non quello pubblico. Vedi `__tests__/api/news-media-area-privata.test.ts`.
      from: (bucket: string) => ({
        upload: async (path: string) => { h.lastUploadPath = path; return { data: h.uploadError ? null : { path }, error: h.uploadError } },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/public/${bucket}/${path}` } }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://cdn.test/sign/${bucket}/${path}?token=abc` }, error: null }),
      }),
    },
  }),
}))

import { POST as UPLOAD } from '@/app/api/news/upload/route'
import { POST as VALIDA } from '@/app/api/news/instagram/valida/route'

const uploadReq = (file: File | null) => ({
  url: 'http://test/api/news/upload',
  method: 'POST',
  headers: new Headers(),
  formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
}) as never

const validaReq = (body: unknown) => ({
  url: 'http://test/api/news/instagram/valida',
  method: 'POST',
  headers: new Headers(),
  json: async () => body,
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.uploadError = null
  h.lastUploadPath = null
  h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
  h.externalFetch.mockResolvedValue({ ok: true, stato: 200, corpo: '', res: new Response('<meta property="og:image" content="x">') })
})

describe('POST /api/news/upload', () => {
  it('401 quando requireDocente nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await UPLOAD(uploadReq(new File(['x'], 'a.png', { type: 'image/png' })))
    expect(res.status).toBe(401)
  })

  it('400 quando manca il file', async () => {
    const res = await UPLOAD(uploadReq(null))
    expect(res.status).toBe(400)
  })

  it('carica un\'immagine nell\'area di sosta privata, path namespaced sull\'utente', async () => {
    const res = await UPLOAD(uploadReq(new File(['x'], 'foto.png', { type: 'image/png' })))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.fileUrl).toContain('/sign/news_bozze/')
    expect(h.lastUploadPath).toContain('edu-1')
  })

  it('ogni video → 409 «aggiorna l\'app», e nessun byte tocca lo Storage', async () => {
    // Prima di questo giorno un `.mov` prendeva il 415 dello sniff e un mp4 H.264 passava: ora il
    // percorso vecchio è chiuso, e il blocco guarda il tipo, non il contenuto. Anche un
    // `video/quicktime` deve sentirsi dire «aggiorna l'app» e non «formato non ammesso».
    for (const tipo of ['video/quicktime', 'video/mp4', 'video/webm']) {
      h.lastUploadPath = null
      const res = await UPLOAD(uploadReq(new File(['xxxxx'], 'clip.mov', { type: tipo })))
      expect(res.status, tipo).toBe(409)
      expect((await res.json()).codice, tipo).toBe('VIDEO_APP_DA_AGGIORNARE')
      expect(h.lastUploadPath, `${tipo}: rifiutato PRIMA dello Storage`).toBeNull()
    }
  })

  it('errore storage → 500', async () => {
    h.uploadError = { message: 'boom' }
    const res = await UPLOAD(uploadReq(new File(['x'], 'foto.png', { type: 'image/png' })))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/news/instagram/valida', () => {
  it('401 quando requireDocente nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await VALIDA(validaReq({ url: 'https://www.instagram.com/p/ABC12345/' }))
    expect(res.status).toBe(401)
  })

  it('URL non Instagram → 400', async () => {
    const res = await VALIDA(validaReq({ url: 'https://example.com/foo' }))
    expect(res.status).toBe(400)
    expect(h.externalFetch).not.toHaveBeenCalled()
  })

  it('URL valido raggiungibile → {valido, shortcode, embed_url, raggiungibile}', async () => {
    const res = await VALIDA(validaReq({ url: 'https://www.instagram.com/reel/XyZ_123ab/' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.valido).toBe(true)
    expect(j.shortcode).toBe('XyZ_123ab')
    expect(j.embed_url).toBe('https://www.instagram.com/p/XyZ_123ab/embed/captioned/')
    expect(j.raggiungibile).toBe(true)
    expect(h.externalFetch).toHaveBeenCalledTimes(1)
  })

  it('URL valido ma non raggiungibile (rate limit) → raggiungibile:false, esito indeterminato', async () => {
    h.externalFetch.mockResolvedValue({ ok: false, stato: 429, corpo: 'rate limited' })
    const res = await VALIDA(validaReq({ url: 'https://www.instagram.com/p/ABC12345/' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.raggiungibile).toBe(false)
    expect(j.esito).toBe('indeterminato')
  })
})
