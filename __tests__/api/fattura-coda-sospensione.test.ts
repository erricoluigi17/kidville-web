import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `POST /api/pagamenti/fattura/coda/sospensione` — «Sospendi coda / Riprendi», SOLO admin
 * (nucleo §3). Uuid finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ requireStaff: vi.fn(), rpc: vi.fn(), logEvento: vi.fn(), avvisi: vi.fn() }))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// D2 (consegna 2b): si sostituisce SOLO `logEvento`, per leggere chi ha sospeso o ripreso.
vi.mock('@/lib/logging/logger', async (o) => ({
  ...(await o<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
const CLIENT = vi.hoisted(() => ({ rpc: undefined as unknown }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => CLIENT }))
// Consegna 2c: gli avvisi della coda sono finti qui; il modulo vero è in `avvisi.test.ts`.
vi.mock('@/lib/fatture-coda/avvisi', () => ({ spedisciAvvisiCoda: h.avvisi }))

import { POST } from '@/app/api/pagamenti/fattura/coda/sospensione/route'
import { CODICI_ERRORE_CODA } from '@/lib/fatture-coda/api'

const ADMIN = '00000000-0000-4000-8000-000000007001'

function post(corpo: unknown): Request {
  return new Request('http://localhost/api/pagamenti/fattura/coda/sospensione', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

const chiamateA = (nome: string) => h.rpc.mock.calls.filter((c) => c[0] === nome)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin' } })
  h.rpc.mockResolvedValue({ data: null, error: null })
  CLIENT.rpc = h.rpc
  h.avvisi.mockResolvedValue({ esito: 'nessuno', avvisi: 0, tentate: 0 })
})

describe('solo admin', () => {
  it('il gate è chiesto con i soli admin ammessi', async () => {
    await POST(post({ sospesa: true }))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.any(Request), ['admin'])
  })

  it('403 del gate (segreteria) e 401: nessuna RPC', async () => {
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    expect((await POST(post({ sospesa: true }))).status).toBe(403)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await POST(post({ sospesa: true }))).status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('zod: sospesa assente o non booleana ⇒ 400', async () => {
    expect((await POST(post({}))).status).toBe(400)
    expect((await POST(post({ sospesa: 'sì' }))).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('sospendi e riprendi', () => {
  it('sospendi: RPC con l’attore, nessuna sveglia', async () => {
    const res = await POST(post({ sospesa: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sospesa: true })
    expect(chiamateA('fatture_coda_sospendi')).toEqual([['fatture_coda_sospendi', { p_attore: ADMIN, p_sospesa: true }]])
    expect(chiamateA('fatture_coda_tick_http')).toEqual([])
  })

  it('riprendi: RPC, poi la sveglia', async () => {
    const res = await POST(post({ sospesa: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sospesa: false })
    expect(chiamateA('fatture_coda_sospendi')).toEqual([['fatture_coda_sospendi', { p_attore: ADMIN, p_sospesa: false }]])
    await vi.waitFor(() => expect(chiamateA('fatture_coda_tick_http')).toHaveLength(1))
  })
})

describe('DB non migrato e guasti', () => {
  it.each(['PGRST205', '42P01', 'PGRST202', '42883'])('%s ⇒ 503 CODA_FATTURE_NON_DISPONIBILE', async (code) => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code } })
    const res = await POST(post({ sospesa: false }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.NON_DISPONIBILE)
    expect(chiamateA('fatture_coda_tick_http')).toEqual([])
  })

  it('altro errore ⇒ 500 con codice, niente sveglia', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000' } })
    const res = await POST(post({ sospesa: false }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.SCRITTURA_FALLITA)
    expect(chiamateA('fatture_coda_tick_http')).toEqual([])
  })
})

/**
 * D2 (consegna 2b), caratterizzazione: sospendi e riprendi loggano già l'attore, con livello,
 * messaggio e `utente` diversi fra loro (nessun `distingui` serve). Nasce verde: la prova è
 * togliere `utente` dalla route e guardarlo diventare rosso.
 */
describe('D2: l’attore nei log', () => {
  it('sospendi logga l’attore (warn, coda-sospesa)', async () => {
    await POST(post({ sospesa: true }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'fattura',
      'warn',
      expect.objectContaining({ esito: 'coda-sospesa', utente: ADMIN }),
    )
  })

  it('riprendi logga l’attore (info, coda-ripresa)', async () => {
    await POST(post({ sospesa: false }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'fattura',
      'info',
      expect.objectContaining({ esito: 'coda-ripresa', utente: ADMIN }),
    )
  })
})

/**
 * Consegna 2c (decisione 12): sospensione e ripresa si avvisano agli admin e a chi ha fatture
 * in attesa, meno chi ha premuto — quindi la route passa l'attore. Solo dopo la RPC riuscita:
 * uno stato non scritto non si avvisa.
 */
describe('consegna 2c: gli avvisi dopo la RPC riuscita', () => {
  const chiamataSospendi = () => h.rpc.mock.invocationCallOrder[h.rpc.mock.calls.findIndex((c) => c[0] === 'fatture_coda_sospendi')]

  it('sospendi: una chiamata col client e l’attore, dopo la RPC', async () => {
    expect((await POST(post({ sospesa: true }))).status).toBe(200)
    expect(h.avvisi).toHaveBeenCalledTimes(1)
    expect(h.avvisi.mock.calls[0][0]).toBe(CLIENT)
    expect(h.avvisi.mock.calls[0][1]).toEqual({ operazione: 'coda-sospensione:sospendi', attore: ADMIN })
    expect(chiamataSospendi()).toBeLessThan(h.avvisi.mock.invocationCallOrder[0])
  })

  it('riprendi: operazione «riprendi», dopo la RPC, e la sveglia resta', async () => {
    expect((await POST(post({ sospesa: false }))).status).toBe(200)
    expect(h.avvisi).toHaveBeenCalledTimes(1)
    expect(h.avvisi.mock.calls[0][0]).toBe(CLIENT)
    expect(h.avvisi.mock.calls[0][1]).toEqual({ operazione: 'coda-sospensione:riprendi', attore: ADMIN })
    expect(chiamataSospendi()).toBeLessThan(h.avvisi.mock.invocationCallOrder[0])
    await vi.waitFor(() => expect(chiamateA('fatture_coda_tick_http')).toHaveLength(1))
  })

  it('la route ASPETTA gli avvisi prima di rispondere (su Vercel il lavoro dopo la risposta non è garantito)', async () => {
    // Il finto finisce dopo un macrotask: con `void spedisciAvvisiCoda(…)` la risposta
    // arriverebbe prima, e la sospensione scritta resterebbe senza avviso.
    let finiti = 0
    h.avvisi.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      finiti++
      return { esito: 'nessuno', avvisi: 0, tentate: 0 }
    })
    expect((await POST(post({ sospesa: true }))).status).toBe(200)
    expect(finiti).toBe(1)
  })

  it('un esito degli avvisi andato male non cambia la risposta', async () => {
    h.avvisi.mockResolvedValueOnce({ esito: 'eccezione', avvisi: 0, tentate: 0 })
    const res = await POST(post({ sospesa: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sospesa: true })
  })

  it('nessuna chiamata su 400, 401 e 403', async () => {
    expect((await POST(post({}))).status).toBe(400)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    expect((await POST(post({ sospesa: true }))).status).toBe(403)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await POST(post({ sospesa: true }))).status).toBe(401)
    expect(h.avvisi).not.toHaveBeenCalled()
  })

  it.each(['PGRST202', 'XX000'])('RPC in errore (%s: 503 o 500): nessuna chiamata', async (code) => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code } })
    const res = await POST(post({ sospesa: true }))
    expect([503, 500]).toContain(res.status)
    expect(h.avvisi).not.toHaveBeenCalled()
  })
})
