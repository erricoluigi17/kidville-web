import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  arubaBaseUrls,
  resolveArubaCredentials,
  arubaSignin,
  arubaUpload,
  arubaGetByFilename,
} from '@/lib/aruba/client'

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response
}

describe('arubaBaseUrls', () => {
  it('production → host di produzione', () => {
    expect(arubaBaseUrls('production')).toEqual({
      auth: 'https://auth.fatturazioneelettronica.aruba.it',
      ws: 'https://ws.fatturazioneelettronica.aruba.it',
    })
  })
  it('demo/sandbox/default → host demo', () => {
    const demo = {
      auth: 'https://demoauth.fatturazioneelettronica.aruba.it',
      ws: 'https://demows.fatturazioneelettronica.aruba.it',
    }
    expect(arubaBaseUrls('demo')).toEqual(demo)
    expect(arubaBaseUrls('sandbox')).toEqual(demo)
    expect(arubaBaseUrls(undefined)).toEqual(demo)
  })
})

describe('resolveArubaCredentials', () => {
  afterEach(() => {
    delete process.env.ARUBA_PASSWORD
    delete process.env.ARUBA_USERNAME
  })
  it('risolve la password dalla env indicata da password_ref (mai in chiaro nel config)', () => {
    process.env.ARUBA_PASSWORD = 'segretissima'
    const creds = resolveArubaCredentials({ username: 'utente@scuola.it', password_ref: 'ARUBA_PASSWORD' })
    expect(creds).toEqual({ username: 'utente@scuola.it', password: 'segretissima' })
  })
  it('senza env/credenziali → null', () => {
    expect(resolveArubaCredentials({ username: 'u', password_ref: 'ARUBA_PASSWORD' })).toBeNull()
    expect(resolveArubaCredentials({})).toBeNull()
  })
})

describe('Aruba REST client (HTTP)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('arubaSignin: POST form-urlencoded grant_type=password e ritorna i token', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 1799 })
    )
    const tokens = await arubaSignin('demo', { username: 'u', password: 'p' })
    expect(tokens.accessToken).toBe('AT')
    expect(tokens.refreshToken).toBe('RT')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://demoauth.fatturazioneelettronica.aruba.it/auth/signin')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toContain('application/x-www-form-urlencoded')
    expect(init.body).toContain('grant_type=password')
    expect(init.body).toContain('username=u')
    expect(init.body).toContain('password=p')
  })

  it('arubaUpload: invia dataFile base64 + Bearer, ok quando errorCode 0000', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ uploadFileName: 'IT01879020517_abcde.xml.p7m', errorCode: '0000', errorDescription: 'OK' })
    )
    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'PGZhdHR1cmE+', senderPIVA: '12345678903' })
    expect(res.ok).toBe(true)
    expect(res.uploadFileName).toBe('IT01879020517_abcde.xml.p7m')
    expect(res.errorCode).toBe('0000')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://demows.fatturazioneelettronica.aruba.it/services/invoice/upload')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer AT')
    const body = JSON.parse(init.body)
    expect(body.dataFile).toBe('PGZhdHR1cmE+')
    expect(body.senderPIVA).toBe('12345678903')
  })

  it('arubaUpload: errorCode diverso da 0000 → ok=false con descrizione errore', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ errorCode: '0094', errorDescription: 'IdTrasmittente non valido' })
    )
    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: 'p' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('0094')
    expect(res.errorDescription).toContain('IdTrasmittente')
  })

  it('arubaGetByFilename: GET con filename+includePdf e parsing di stato/pdf', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 7, pdfFile: 'JVBERi0=' }))
    const st = await arubaGetByFilename('production', 'AT', 'IT01879020517_abcde.xml.p7m')
    expect(st.stato).toBe(7)
    expect(st.pdfBase64).toBe('JVBERi0=')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('https://ws.fatturazioneelettronica.aruba.it/services/invoice/out/getByFilename')
    expect(url).toContain('filename=IT01879020517_abcde.xml.p7m')
    expect(url).toContain('includePdf=true')
    expect(init.headers.Authorization).toBe('Bearer AT')
  })
})
