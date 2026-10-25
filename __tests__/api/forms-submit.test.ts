// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
  insertError: null as unknown,
  sospensione: null as unknown, // NextResponse se sospeso, null altrimenti
  modelError: null as unknown,
  utenteError: null as unknown,
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
  clientIp: vi.fn().mockReturnValue('test-ip'),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  // Contabilità v2: la route usa la variante flag-aware. Delega sul flag come la reale.
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn(async (_sb: unknown, _id: unknown, opts: { sempreFirmabile?: boolean }) =>
    opts?.sempreFirmabile ? null : h.sospensione),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
    return {
      from: (table: string) => {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        // `utenti`: chi compila ha una sede — è la condizione di TUTTI i 51 utenti
        // in produzione, ed è la prima fonte da cui la compilazione prende la
        // propria `scuola_id` (una riga senza sede non la vedrebbe più nessuno).
        b.maybeSingle = async () => ({
          data: table === 'form_models' ? h.model : table === 'utenti' ? { scuola_id: 'sc-1' } : null,
          error: table === 'form_models' ? h.modelError : table === 'utenti' ? h.utenteError : null,
        })
        b.single = async () => ({ data: { id: 'sub-new' }, error: h.insertError })
        b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
        return b
      },
    }
  },
}))

import { POST } from '@/app/api/forms/submit/route'

function req(body: unknown) {
  return new Request('http://localhost/api/forms/submit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

const modelloConConsenso = {
  schema: {
    version: '1.0',
    pages: [{
      id: 'p1', title: 'P',
      fields: [
        { id: 'nome', type: 'text', label: 'Nome' },
        { id: 'privacy', type: 'consent', label: 'Trattamento dati', text: 'Acconsento', required: true },
      ],
    }],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.model = modelloConConsenso
  h.inserts = []
  h.insertError = null
  h.sospensione = null
  h.modelError = null
  h.utenteError = null
  h.adminLancia = false
})

describe('POST /api/forms/submit (path senza firma)', () => {
  it('400 se mancano modelId o data', async () => {
    expect((await POST(req({ userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11' }))).status).toBe(400)
  })

  it('400 se un consenso obbligatorio non è spuntato', async () => {
    const res = await POST(req({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10', userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', data: { nome: 'Marco', privacy: false } }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('403 se il genitore è sospeso (moroso)', async () => {
    h.sospensione = NextResponse.json({ error: 'sospeso' }, { status: 403 })
    const res = await POST(req({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10', userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', data: { nome: 'Marco', privacy: true } }))
    expect(res.status).toBe(403)
  })

  it('201 inserisce completed con consents_log snapshot', async () => {
    const res = await POST(req({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10', userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', data: { nome: 'Marco', privacy: true } }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('sub-new')
    const row = h.inserts[0]
    expect(row.status).toBe('completed')
    expect(row.model_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10')
    // La sede di chi compila finisce sulla riga: senza, la compilazione non
    // comparirebbe in nessun elenco (`NULL IN (…)` in SQL vale NULL).
    expect(row.scuola_id).toBe('sc-1')
    const log = row.consents_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({ field_id: 'privacy', label: 'Trattamento dati', accepted: true })
    expect(typeof log[0].accepted_at).toBe('string')
  })
})

describe('POST /api/forms/submit — un guasto risponde con un codice, mai con il testo di Postgres', () => {
  const corpo = {
    modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10',
    userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11',
    data: { nome: 'Marco', privacy: true },
  }

  it('modello non letto → 500 LETTURA_FALLITA, nessun inserimento', async () => {
    h.modelError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(req(corpo))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('LETTURA_FALLITA')
    expect(JSON.stringify(json)).not.toContain('statement timeout')
    expect(h.inserts).toHaveLength(0)
  })

  it('utente non letto → 500 LETTURA_FALLITA', async () => {
    h.utenteError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(req(corpo))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('LETTURA_FALLITA')
    expect(JSON.stringify(json)).not.toContain('statement timeout')
  })

  it('compilazione non registrata → 500 SCRITTURA_FALLITA', async () => {
    h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "form_submissions_pkey"' }
    const res = await POST(req(corpo))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('SCRITTURA_FALLITA')
    expect(JSON.stringify(json)).not.toContain('duplicate key')
  })

  it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
    h.adminLancia = true
    const res = await POST(req(corpo))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.codice).toBe('ERRORE_INTERNO')
    expect(JSON.stringify(json)).not.toContain('dettaglio interno')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'forms/submit:POST', stato: 500 }),
      expect.any(Error),
    )
  })
})
