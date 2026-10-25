// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Il link a un certificato delle competenze nasce da `createSignedUrl`, che non lancia: risponde
 * `{ data: null, error }`. Fino al 20/10 il guasto spariva in un `?? null` (genitore) o in un 500 senza codice
 * e senza log (segreteria).
 */

const h = vi.hoisted(() => ({
  cert: 'c0000000-0000-4000-8000-0000000000c1',
  firma: { data: null as { signedUrl: string } | null, error: null as unknown },
  adminLancia: false,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: unknown[]) => h.logEvento(...a),
    logErrore: (...a: unknown[]) => h.logErrore(...a),
  }
})
vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireStaff: async () => ({ user: { id: 'st1', role: 'admin', scuola_id: 'sc-1' } }),
}))
vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: async () => ({ user: { id: 'par1' } }),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertSezioneInScope: async () => null,
}))
vi.mock('@/lib/competenze/certificato-store', () => ({ CERTIFICATI_BUCKET: 'certificati-competenze' }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
    return {
      storage: { from: () => ({ createSignedUrl: async () => h.firma }) },
      from: () => {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.in = () => q
        q.order = () => q
        q.maybeSingle = async () => ({ data: { file_url: 'c1.pdf', section_id: 'sez1' }, error: null })
        q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve({
            data: [{ id: h.cert, stato: 'firmato', anno_scolastico: '2025/26', file_url: 'c1.pdf' }],
            error: null,
          }).then(ok, ko)
        return q
      },
    }
  },
}))

import { GET as GENITORE } from '@/app/api/parent/competenze/route'
import { GET as SEGRETERIA } from '@/app/api/admin/competenze/download/route'

const FRASE = 'Si è verificato un errore imprevisto. Riprova fra poco.'
const guastoFirma = { name: 'StorageApiError', message: 'Object not found', status: 400 }
const reqGenitore = () => new Request('http://localhost/api/parent/competenze?studentId=al1&userId=par1') as never
const reqSegreteria = () =>
  new Request(`http://localhost/api/admin/competenze/download?certificatoId=${h.cert}`) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.firma = { data: null, error: guastoFirma }
  h.adminLancia = false
})

describe('certificati delle competenze — l’URL firmato che non si crea lascia una riga', () => {
  it('genitore: il certificato resta in elenco senza link, e il guasto è registrato', async () => {
    const res = await GENITORE(reqGenitore())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data).toEqual([{ id: h.cert, anno: '2025/26', stato: 'firmato', downloadUrl: null }])
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', {
      operazione: 'parent/competenze:GET',
      esito: 'url-firmato-non-creato',
      entita_id: h.cert,
    }, guastoFirma)
  })

  it('segreteria: 500 ERRORE_INTERNO, e il guasto è registrato', async () => {
    const res = await SEGRETERIA(reqSegreteria())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: FRASE, codice: 'ERRORE_INTERNO' })
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', {
      operazione: 'admin/competenze/download:GET',
      esito: 'url-firmato-non-creato',
      entita_id: h.cert,
    }, guastoFirma)
  })

  it('genitore: un’eccezione risponde ERRORE_INTERNO, il messaggio solo nel log', async () => {
    h.adminLancia = true
    const res = await GENITORE(reqGenitore())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ERRORE_INTERNO')
    expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'parent/competenze:GET', stato: 500 }),
      expect.any(Error),
    )
  })

  it('segreteria: un’eccezione risponde ERRORE_INTERNO, il messaggio solo nel log', async () => {
    h.adminLancia = true
    const res = await SEGRETERIA(reqSegreteria())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ERRORE_INTERNO')
    expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
    // Come nel test del genitore: senza questa riga il test restava verde anche togliendo il
    // `logErrore` dal `catch` (mutazione provata il 25/10).
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/competenze/download:GET', stato: 500 }),
      expect.any(Error),
    )
  })
})
