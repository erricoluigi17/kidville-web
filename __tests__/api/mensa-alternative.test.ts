import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// GET/POST/DELETE /api/mensa/alternative — alternative MANUALI del pasto.
//  · gate: GET requireKitchenRead (educator ammesso, scoped), POST/DELETE requireStaff;
//  · POST = upsert su (alunno_id, data);
//  · degrade su DB non migrato: GET 42P01 → lista vuota, POST/DELETE → 503 chiaro;
//  · i log del successo NON contengono il testo della richiesta né nomi (dati di minori).

const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
const CUOCA = 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0'
const GENITORE = '90909090-9090-9090-9090-909090909090'
const ALUNNO = 'a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  alternative: [] as Record<string, unknown>[],
  alunni: [] as Record<string, unknown>[],
  altError: null as { code?: string; message?: string } | null,
  upsertError: null as { code?: string; message?: string } | null,
  deleteError: null as { code?: string; message?: string } | null,
}))

vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  assertAlunnoInScope: async () => null,
}))
vi.mock('@/lib/sezioni/docenti', () => ({
  nomiSezioniDiUtente: async () => ['Rossi'],
  sezioniDiUtente: async () => [],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b; b.in = () => b; b.order = () => b
      b.single = async () => ({ data: h.utente, error: null })
      b.upsert = async () => ({ error: h.upsertError })
      b.delete = () => { b.__delete = true; return b }
      b.then = (res: (v: unknown) => void) => {
        if (table === 'alunni') return res({ data: h.alunni, error: null })
        if (table === 'mensa_alternative') {
          if (b.__delete) return res({ data: null, error: h.deleteError })
          return res({ data: h.alternative, error: h.altError })
        }
        return res({ data: [], error: null })
      }
      return b
    },
  }),
}))

import * as logger from '@/lib/logging/logger'
import { GET, POST, DELETE } from '@/app/api/mensa/alternative/route'

const jsonReq = (userId: string, body: unknown) =>
  new NextRequest('http://localhost/api/mensa/alternative', {
    method: 'POST',
    headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const getReq = (userId: string, qs = '') =>
  new NextRequest(`http://localhost/api/mensa/alternative${qs}`, { headers: { 'x-user-id': userId } })
const delReq = (userId: string, qs: string) =>
  new NextRequest(`http://localhost/api/mensa/alternative${qs}`, { method: 'DELETE', headers: { 'x-user-id': userId } })

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: SEGRETERIA, nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria', role: 'segreteria', scuola_id: 'sc-1' }
  h.alternative = []
  h.alunni = []
  h.altError = null
  h.upsertError = null
  h.deleteError = null
})

describe('GET /api/mensa/alternative — gate + degrade', () => {
  it('genitore → 403 (requireKitchenRead lo esclude)', async () => {
    h.utente = { ...h.utente, id: GENITORE, ruolo: 'genitore', role: 'genitore' }
    expect((await GET(getReq(GENITORE))).status).toBe(403)
  })

  it('cuoca → 200 con lista (sola lettura ammessa)', async () => {
    h.utente = { ...h.utente, id: CUOCA, ruolo: 'cuoca', role: 'cuoca' }
    h.alternative = [{ id: 'x1', alunno_id: ALUNNO, data: '2026-07-14', richiesta: 'pasto in bianco', origine: 'segreteria', created_at: '2026-07-14T10:00:00Z' }]
    h.alunni = [{ id: ALUNNO, nome: 'Marco', cognome: 'Verdi', classe_sezione: 'Rossi' }]
    const res = await GET(getReq(CUOCA, '?data=2026-07-14'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.alternative).toHaveLength(1)
    expect(j.data.alternative[0].nome).toBe('Marco Verdi')
  })

  it('tabella assente (42P01) → 200 lista vuota (degrade, non 500)', async () => {
    h.altError = { code: '42P01', message: 'relation "mensa_alternative" does not exist' }
    const res = await GET(getReq(SEGRETERIA, '?data=2026-07-14'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.alternative).toEqual([])
  })
})

describe('POST /api/mensa/alternative — gate + upsert + log senza testo', () => {
  it('cuoca → 403 (le scritture sono riservate allo staff)', async () => {
    h.utente = { ...h.utente, id: CUOCA, ruolo: 'cuoca', role: 'cuoca' }
    const res = await POST(jsonReq(CUOCA, { alunno_id: ALUNNO, data: '2026-07-14', richiesta: 'x' }))
    expect(res.status).toBe(403)
  })

  it('segreteria → 200 e UPSERT eseguito', async () => {
    const res = await POST(jsonReq(SEGRETERIA, { alunno_id: ALUNNO, data: '2026-07-14', richiesta: 'pasto in bianco senza latticini' }))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it('body senza richiesta → 400', async () => {
    const res = await POST(jsonReq(SEGRETERIA, { alunno_id: ALUNNO, data: '2026-07-14' }))
    expect(res.status).toBe(400)
  })

  it('tabella assente (42P01) → 503 «funzione non ancora disponibile», non 500', async () => {
    h.upsertError = { code: '42P01', message: 'relation "mensa_alternative" does not exist' }
    const res = await POST(jsonReq(SEGRETERIA, { alunno_id: ALUNNO, data: '2026-07-14', richiesta: 'x' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('Funzione non ancora disponibile')
  })

  it('il log del successo NON contiene il testo della richiesta', async () => {
    const spy = vi.spyOn(logger, 'logEvento')
    const TESTO = 'diario segreto allergia rara del bambino'
    const res = await POST(jsonReq(SEGRETERIA, { alunno_id: ALUNNO, data: '2026-07-14', richiesta: TESTO }))
    expect(res.status).toBe(200)
    // C'è un log di successo con uuid alunno + data…
    const successo = spy.mock.calls.find(c => c[0] === 'mensa' && c[1] === 'info')
    expect(successo).toBeTruthy()
    expect(JSON.stringify(successo![2])).toContain(ALUNNO)
    // …ma NESSUNA chiamata di log porta il testo della richiesta.
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TESTO)
    }
    spy.mockRestore()
  })
})

describe('DELETE /api/mensa/alternative — gate + degrade', () => {
  it('genitore → 403', async () => {
    h.utente = { ...h.utente, id: GENITORE, ruolo: 'genitore', role: 'genitore' }
    expect((await DELETE(delReq(GENITORE, `?alunno_id=${ALUNNO}&data=2026-07-14`))).status).toBe(403)
  })

  it('segreteria → 200', async () => {
    const res = await DELETE(delReq(SEGRETERIA, `?alunno_id=${ALUNNO}&data=2026-07-14`))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it('tabella assente (42P01) → 503 chiaro', async () => {
    h.deleteError = { code: '42P01', message: 'relation "mensa_alternative" does not exist' }
    const res = await DELETE(delReq(SEGRETERIA, `?alunno_id=${ALUNNO}&data=2026-07-14`))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('Funzione non ancora disponibile')
  })
})
