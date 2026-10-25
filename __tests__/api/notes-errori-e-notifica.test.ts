// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `/api/notes` — le note disciplinari. Il 20/10 la notifica ai genitori falliva in un `catch { /* non bloccare *\/ }`
 * senza lasciare traccia, e i 500 mandavano `details: error.message` al client.
 */

const h = vi.hoisted(() => ({
  lettura: { data: [] as unknown[] | null, error: null as unknown },
  scrittura: { data: [{ id: 'n1' }] as unknown[] | null, error: null as unknown },
  notifica: null as unknown,
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
  requireDocente: async () => ({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } }),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertAlunnoInScope: async () => null,
  resolveScuoleAttive: async () => ['sc-1'],
  sezioniVisibili: async () => null,
}))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: async () => {
    if (h.notifica) throw h.notifica
  },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
    return {
      from: () => {
        let esito: unknown = h.lettura
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.in = () => b
        b.eq = () => b
        b.order = () => b
        b.insert = () => { esito = h.scrittura; return b }
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko)
        return b
      },
    }
  },
}))

import { GET, POST } from '@/app/api/notes/route'

const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const nota = { alunnoIds: [ALUNNO], categoria: 'comportamento', testo: 'Testo di prova', richiedeFirma: false }
const post = (corpo: unknown) =>
  new NextRequest('http://localhost/api/notes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.lettura = { data: [], error: null }
  h.scrittura = { data: [{ id: 'n1' }], error: null }
  h.notifica = null
  h.adminLancia = false
})

describe('/api/notes — guasti con codice, notifica non accodata registrata', () => {
  it('POST: nota scritta, notifica ai genitori fallita → 200, e una riga `notifica` a livello error', async () => {
    const guasto = new Error('coda notifiche irraggiungibile')
    h.notifica = guasto
    const res = await POST(post(nota))
    expect(res.status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('notifica', 'error', {
      operazione: 'notes:POST',
      esito: 'notifica-genitori-non-accodata',
    }, guasto)
  })

  it('POST: scrittura fallita → 500 SCRITTURA_FALLITA, senza il testo di Postgres', async () => {
    h.scrittura = { data: null, error: { code: '23503', message: 'insert or update on table "note_disciplinari" violates foreign key constraint' } }
    const res = await POST(post(nota))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('SCRITTURA_FALLITA')
    expect(JSON.stringify(corpo)).not.toContain('foreign key')
  })

  it('GET: lettura fallita → 500 LETTURA_FALLITA, senza `details`', async () => {
    h.lettura = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await GET(new NextRequest(`http://localhost/api/notes?alunnoId=${ALUNNO}`))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('LETTURA_FALLITA')
    expect(corpo.details).toBeUndefined()
    expect(JSON.stringify(corpo)).not.toContain('statement timeout')
  })

  it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
    h.adminLancia = true
    const res = await POST(post(nota))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ERRORE_INTERNO')
    expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'notes:POST', stato: 500 }),
      expect.any(Error),
    )
  })
})
