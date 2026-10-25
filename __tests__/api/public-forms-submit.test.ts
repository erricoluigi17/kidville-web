// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
  modelError: null as unknown,
  insertError: null as unknown,
  adminLancia: false,
  logErrore: vi.fn(),
}))

// «Il messaggio solo nel log» va VERIFICATO: senza questa spia il test restava verde anche togliendo
// il `logErrore` dal `catch` (mutazione provata il 25/10).
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
})

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
    return {
      from: () => {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: h.model, error: h.modelError })
        b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
        b.single = async () => ({ data: h.insertError ? null : { id: 'sub-pub' }, error: h.insertError })
        return b
      },
    }
  },
}))

import { POST } from '@/app/api/public/forms/[token]/submit/route'

// I TOKEN SONO UUID. Qui c'erano `'tok'` e `'nope'`, e non era una svista da poco:
// `form_models.public_token` è di tipo `uuid`, quindi in produzione una stringa così non
// produce «nessuna riga» — produce l'errore `22P02` di Postgres, che è un altro ramo di
// codice. Il doppio finto rispondeva `{ data: null }` a qualunque valore e faceva sembrare
// coperto proprio il caso che il 2026-08-02 rispondeva 500 a un anonimo. Il ramo del token
// malformato vive ora in `public-forms-token-malformato.test.ts`, con un doppio fedele.
const TOKEN = 'c0000000-0000-4000-8000-00000000c0de'
const TOKEN_SCONOSCIUTO = 'd0000000-0000-4000-8000-00000000dead'
const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const req = (body: unknown) =>
  new Request('http://localhost/api/public/forms/tok/submit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

// Il modello DICHIARA la sua sede: nell'invio anonimo è l'unico dato da cui
// dedurla — chi apre un link pubblico non ha nient'altro. Senza, l'invio viene
// rifiutato (400) invece di generare una riga che non vedrebbe nessuno.
const pubModel = {
  id: 'm-1', published_at: '2026-06-26T00:00:00Z', access_mode: 'public', scuola_id: 'sc-1',
  schema: { version: '1.0', pages: [{ id: 'p', title: 'P', fields: [
    { id: 'privacy', type: 'consent', label: 'Privacy', required: true },
  ] }] },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.model = pubModel
  h.inserts = []
  h.modelError = null
  h.insertError = null
  h.adminLancia = false
})

describe('POST /api/public/forms/[token]/submit', () => {
  it('404 se il token non corrisponde a un modello pubblicato', async () => {
    h.model = null
    expect((await POST(req({ data: {} }), ctx(TOKEN_SCONOSCIUTO))).status).toBe(404)
  })

  it('404 se il modello esiste ma non è pubblicato', async () => {
    h.model = { ...pubModel, published_at: null }
    expect((await POST(req({ data: {} }), ctx(TOKEN))).status).toBe(404)
  })

  it('403 se access_mode=authenticated', async () => {
    h.model = { ...pubModel, access_mode: 'authenticated' }
    expect((await POST(req({ data: { privacy: true } }), ctx(TOKEN))).status).toBe(403)
  })

  it('400 se un consenso obbligatorio non è spuntato', async () => {
    const res = await POST(req({ data: { privacy: false } }), ctx(TOKEN))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('201 inserisce completed + consents_log (user_id null)', async () => {
    const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('sub-pub')
    const row = h.inserts[0]
    expect(row.status).toBe('completed')
    expect(row.user_id).toBeNull()
    expect(row.scuola_id).toBe('sc-1')
    expect((row.consents_log as Array<Record<string, unknown>>)[0]).toMatchObject({ field_id: 'privacy', accepted: true })
  })

  it('lettura del modello fallita → 500 LETTURA_FALLITA, senza il testo di Postgres', async () => {
    h.modelError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('LETTURA_FALLITA')
    expect(JSON.stringify(json)).not.toContain('statement timeout')
  })

  it('invio non registrato → 500 SCRITTURA_FALLITA', async () => {
    h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "form_submissions_pkey"' }
    const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('SCRITTURA_FALLITA')
    expect(JSON.stringify(json)).not.toContain('duplicate key')
  })

  it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
    h.adminLancia = true
    const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('ERRORE_INTERNO')
    expect(JSON.stringify(json)).not.toContain('dettaglio interno')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'public/forms/[token]/submit:POST', stato: 500 }),
      expect.any(Error),
    )
  })
})
