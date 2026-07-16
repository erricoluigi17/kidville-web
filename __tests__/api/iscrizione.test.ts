// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  modelError: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      if (table === 'schools') {
        return { select: async () => ({ data: [{ id: 'scuola-reale', nome: 'Kidville Giugliano' }], error: null }) }
      }
      if (table === 'form_models') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: h.model, error: h.modelError })
        return b
      }
      // enrollment_submissions
      const b: Record<string, unknown> = {}
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.select = () => b
      b.single = async () => ({ data: { id: 'sub-1' }, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/iscrizione/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/iscrizione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

// Modello minimale con pagine bambino/adulto (id stabili) e una provincia validata.
const minimalModel = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'B', fields: [
        { id: 'nome', type: 'text', label: 'Nome', required: true, validation: { min_length: 2 } },
        { id: 'residence_province', type: 'text', label: 'Provincia', required: true, placeholder: 'Es. RM', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
      ] },
      { id: 'adulto', title: 'A', fields: [
        { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
      ] },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.model = minimalModel
  h.modelError = null
  h.inserts = []
})

describe('POST /api/iscrizione — validazione province', () => {
  it('provincia per esteso riconoscibile → 201 e viene salvata la SIGLA', async () => {
    const res = await POST(req({ data: {
      children: [{ nome: 'Marco', residence_province: 'Napoli' }],
      adults: [{ residence_province: 'na' }],
    } }))
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(1)
    const saved = h.inserts[0].data as { children: Array<Record<string, unknown>>; adults: Array<Record<string, unknown>> }
    expect(saved.children[0].residence_province).toBe('NA')
    expect(saved.adults[0].residence_province).toBe('NA')
  })

  it('provincia non riconoscibile → 400 con messaggio per campo, nessun insert', async () => {
    const res = await POST(req({ data: {
      children: [{ nome: 'Marco', residence_province: 'Pippo' }],
      adults: [{ residence_province: 'RM' }],
    } }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    const json = await res.json() as { error: string; campi: { children?: Record<string, Record<string, string>> } }
    expect(json.error).toBeTruthy()
    expect(json.campi.children!['0'].residence_province).toContain('sigla della provincia')
  })

  it('sigla formalmente valida ma INESISTENTE (es. XY) → 400, nessun insert', async () => {
    // Regressione CAUSA RADICE 1: 'XY' passa il pattern ^[A-Z]{2}$ ma non è una
    // provincia reale. La normalizzazione non la riconosce (resta 'XY') e la
    // validazione ora la blocca PRIMA del salvataggio, così non arriva più al
    // vicolo cieco del pre-flight dell'import in segreteria.
    const res = await POST(req({ data: {
      children: [{ nome: 'Marco', residence_province: 'XY' }],
      adults: [{ residence_province: 'RM' }],
    } }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    const json = await res.json() as { campi: { children?: Record<string, Record<string, string>> } }
    expect(json.campi.children!['0'].residence_province).toContain('inesistente')
  })

  it('payload già valido → 201 e valori invariati', async () => {
    const res = await POST(req({ data: {
      children: [{ nome: 'Marco', residence_province: 'MI' }],
      adults: [{ residence_province: 'RM' }],
    } }))
    expect(res.status).toBe(201)
    const saved = h.inserts[0].data as { children: Array<Record<string, unknown>>; adults: Array<Record<string, unknown>> }
    expect(saved.children[0].residence_province).toBe('MI')
    expect(saved.adults[0].residence_province).toBe('RM')
  })

  it('campo obbligatorio mancante → 400 con "Campo obbligatorio"', async () => {
    const res = await POST(req({ data: {
      children: [{ residence_province: 'MI' }],
      adults: [{ residence_province: 'RM' }],
    } }))
    expect(res.status).toBe(400)
    const json = await res.json() as { campi: { children?: Record<string, Record<string, string>> } }
    expect(json.campi.children!['0'].nome).toBe('Campo obbligatorio')
  })

  it('degrada pulito se form_models non è caricabile (DB E2E) → usa i template in codice', async () => {
    // Simula il DB E2E senza il modello: la query fallisce.
    h.model = null
    h.modelError = { code: '42P01', message: 'relation "form_models" does not exist' }
    const res = await POST(req({ data: {
      children: [{ nome: 'x' }], // volutamente incompleto per i template in codice
      adults: [{ ruolo: 'mother' }],
    } }))
    // Non deve andare in 500: cade sui template in codice e valida.
    expect(res.status).toBe(400)
    const json = await res.json() as { campi: { children?: Record<string, Record<string, string>> } }
    // cognome è obbligatorio in CHILD_FIELDS (template di codice).
    expect(json.campi.children!['0'].cognome).toBe('Campo obbligatorio')
  })
})
