import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import JSZip from 'jszip'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  applySidiBatch: vi.fn(),
  inserted: null as any,
}))
vi.mock('@/lib/auth/require-staff', async (orig) => ({ ...(await orig() as object), requireStaff: h.requireStaff }))
vi.mock('@/lib/sidi/import-apply', () => ({ applySidiBatch: h.applySidiBatch }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from() {
      const q: any = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.limit = () => q
      q.insert = (row: any) => { h.inserted = row; return { select: () => ({ single: async () => ({ data: { id: 'batch-1' }, error: null }) }) } }
      q.then = (r: any) => r({ data: [], error: null })
      return q
    },
  }),
}))

import { POST, PATCH } from '@/app/api/admin/sidi/import/route'

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never

async function zipBuf(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('domande.csv', 'NUMERO_DOMANDA,ALUNNO_NOME\n777,Pippo')
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

// Richiesta-stub: evita il round-trip multipart reale (lento/instabile in jsdom)
// fornendo direttamente formData(). Il file espone name + arrayBuffer come un File.
function reqWithFile(file: { name: string; arrayBuffer: () => Promise<ArrayBuffer> } | null): Request {
  return {
    formData: async () => ({ get: (key: string) => (key === 'file' ? file : null) }),
  } as unknown as Request
}
async function fileStub(): Promise<{ name: string; arrayBuffer: () => Promise<ArrayBuffer> }> {
  const b = await zipBuf()
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  return { name: 'domande_sidi.zip', arrayBuffer: async () => ab }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.inserted = null
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: 'sc1' } })
  h.applySidiBatch.mockResolvedValue({ matched: 1, creati: 0, aggiornati: 0, warnings: [] })
})

describe('POST /api/admin/sidi/import — upload + parse', () => {
  it('parsa lo ZIP e crea un batch in stato parsed', async () => {
    const res = await POST(reqWithFile(await fileStub()) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.batchId).toBe('batch-1')
    expect(body.totale).toBe(1)
    expect(h.inserted.stato).toBe('parsed')
    expect(h.inserted.parsed_payload).toHaveLength(1)
  })

  it('400 senza file', async () => {
    const res = await POST(reqWithFile(null) as never)
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/admin/sidi/import — apply', () => {
  it('403 per la segreteria (apply riservato alla dirigenza)', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await PATCH(new Request('http://localhost/api/admin/sidi/import', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batchId: 'b1' }) }) as never)
    expect(res.status).toBe(403)
  })

  it('applica il batch e ritorna i conteggi', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'admin', scuola_id: 'sc1' } })
    const res = await PATCH(new Request('http://localhost/api/admin/sidi/import', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batchId: 'b1' }) }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.matched).toBe(1)
    expect(h.applySidiBatch).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({ id: 'dir1' }))
  })
})
