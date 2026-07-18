import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

// Firma congiunta + reinvio OTP (DL-031) sul path moderno /api/forms/send-otp.

const h = vi.hoisted(() => ({
  submission: null as Record<string, unknown> | null,
  model: null as Record<string, unknown> | null,
  slots: [] as Record<string, unknown>[],
  email: 'g@x.it',
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  upserts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = async () => ({ data: table === 'fea_signatures' ? h.slots : null, error: null })
      b.maybeSingle = async () => ({
        data:
          table === 'form_submissions' ? h.submission
          : table === 'form_models' ? h.model
          : table === 'utenti' ? { email: h.email, nome: 'A', cognome: 'B' }
          : null,
        error: null,
      })
      b.single = async () => ({ data: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12' }, error: null })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push({ table, ...row }); return b }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, ...row }); return b }
      b.upsert = (row: Record<string, unknown>) => { h.upserts.push({ table, ...row }); return { select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) } }
      return b
    },
  }),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 7, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn(async () => null),
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn(async () => null),
}))

import { POST, PATCH } from '@/app/api/forms/send-otp/route'

const hashOtp = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex')
const reqJSON = (body: unknown, method: 'POST' | 'PATCH' = 'POST') =>
  new Request('http://localhost/api/forms/send-otp', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.submission = null; h.model = null; h.slots = []; h.email = 'g@x.it'
  h.inserts = []; h.updates = []; h.upserts = []
})

describe('POST send-otp — reinvio / 2° firmatario', () => {
  it('404 se la submission da reinviare non esiste', async () => {
    h.submission = null
    const res = await POST(reqJSON({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa13' }))
    expect(res.status).toBe(404)
  })

  it('reinvia: nessuna nuova submission, aggiorna otp_secret e invia al signerEmail', async () => {
    h.submission = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', status: 'pending_signature', user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11' }
    const res = await POST(reqJSON({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', signerEmail: 'papa@x.it' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.submissionId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12')
    expect(json.email).toBe('papa@x.it')
    // niente insert di nuove submission; solo update di otp_secret
    expect(h.inserts.filter(i => i.table === 'form_submissions')).toHaveLength(0)
    expect(h.updates.some(u => u.table === 'form_submissions' && 'otp_secret' in u)).toBe(true)
  })
})

describe('PATCH send-otp — completamento per policy', () => {
  it('joint, 1° firmatario: resta pending → needsMoreSigners', async () => {
    h.submission = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', otp_secret: hashOtp('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', '111111'), status: 'pending_signature', user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', model_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10' }
    h.model = { signature_mode: 'joint' }
    h.slots = [] // nessuno ha ancora firmato
    const res = await PATCH(reqJSON({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', code: '111111' }, 'PATCH'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.completed).toBe(false)
    expect(json.needsMoreSigners).toBe(true)
    // NON deve impostare status=completed
    const fsUpd = h.updates.filter(u => u.table === 'form_submissions')
    expect(fsUpd.some(u => u.status === 'completed')).toBe(false)
  })

  it('joint, 2° firmatario: con 1 slot già firmato → completed', async () => {
    h.submission = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', otp_secret: hashOtp('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', '222222'), status: 'pending_signature', user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', model_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10' }
    h.model = { signature_mode: 'joint' }
    h.slots = [{ slot_index: 0, stato: 'signed' }] // primo già firmato
    const res = await PATCH(reqJSON({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', code: '222222' }, 'PATCH'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.completed).toBe(true)
    const fsUpd = h.updates.filter(u => u.table === 'form_submissions')
    expect(fsUpd.some(u => u.status === 'completed')).toBe(true)
    // il 2° slot registrato ha slot_index 1
    expect(h.upserts.some(u => u.table === 'fea_signatures' && u.slot_index === 1)).toBe(true)
  })

  it('single (default): completa al 1° codice', async () => {
    h.submission = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', otp_secret: hashOtp('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', '333333'), status: 'pending_signature', user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', model_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10' }
    h.model = { signature_mode: 'single' }
    h.slots = []
    const res = await PATCH(reqJSON({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', code: '333333' }, 'PATCH'))
    const json = await res.json()
    expect(json.completed).toBe(true)
  })
})
