// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `POST /api/iscrizione` è la porta da cui arrivano le domande vere. Un guasto qui rispondeva a un anonimo con
 * il testo di PostgREST, e i due inserimenti falliti non lasciavano nemmeno una riga di log. Il payload è
 * quello minimo di `iscrizione.test.ts`.
 */

const h = vi.hoisted(() => ({
  modello: {
    schema: {
      version: '1',
      pages: [
        { id: 'bambino', title: 'B', fields: [
          { id: 'nome', type: 'text', label: 'Nome', required: true, validation: { min_length: 2 } },
          { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
        ] },
        { id: 'adulto', title: 'A', fields: [
          { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
        ] },
      ],
    },
  } as Record<string, unknown>,
  inserimenti: [] as Array<{ data: unknown; error: unknown }>,
  adminLancia: false,
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
})
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
    return {
      from: (table: string) => {
        const b: Record<string, unknown> = {}
        if (table === 'schools' || table === 'scuole') {
          // `sediReali` legge le due tabelle con catene diverse: il builder è thenable.
          const risultato =
            table === 'schools'
              ? { data: [{ id: 'scuola-reale', nome: 'Sede di prova' }], error: null }
              : { data: [{ id: 'scuola-reale', attiva: true }], error: null }
          b.select = () => b
          b.order = () => b
          b.in = () => b
          b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risultato).then(ok, ko)
          return b
        }
        if (table === 'form_models') {
          b.select = () => b
          b.eq = () => b
          b.maybeSingle = async () => ({ data: h.modello, error: null })
          return b
        }
        // enrollment_submissions: un esito per inserimento, in ordine.
        b.insert = () => b
        b.select = () => b
        b.single = async () => h.inserimenti.shift() ?? { data: { id: 'sub-1' }, error: null }
        return b
      },
    }
  },
}))

import { POST } from '@/app/api/iscrizione/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/iscrizione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

const domanda = {
  data: {
    presa_visione_informativa: true,
    children: [{ nome: 'Marco', residence_province: 'MI' }],
    adults: [{ residence_province: 'RM' }],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.inserimenti = []
  h.adminLancia = false
})

describe('POST /api/iscrizione — un guasto risponde con un codice, mai con il testo di Postgres', () => {
  it('inserimento rifiutato → 500 SCRITTURA_FALLITA, e la riga di log che prima mancava', async () => {
    const guasto = { code: '23505', message: 'duplicate key value violates unique constraint "enrollment_submissions_pkey"' }
    h.inserimenti = [{ data: null, error: guasto }]
    const res = await POST(req(domanda))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SCRITTURA_FALLITA')
    expect(JSON.stringify(corpo)).not.toContain('duplicate key')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'iscrizione:POST', stato: 500, evento: 'db:enrollment_submissions' }),
      guasto,
    )
  })

  it('colonna assente, poi secondo inserimento rifiutato → 500 SCRITTURA_FALLITA', async () => {
    h.inserimenti = [
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'consents_log' column" } },
      { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    ]
    const res = await POST(req(domanda))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SCRITTURA_FALLITA')
    expect(JSON.stringify(corpo)).not.toContain('statement timeout')
  })

  it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
    h.adminLancia = true
    const res = await POST(req(domanda))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ERRORE_INTERNO')
    expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'iscrizione:POST', stato: 500 }),
      expect.any(Error),
    )
  })
})
