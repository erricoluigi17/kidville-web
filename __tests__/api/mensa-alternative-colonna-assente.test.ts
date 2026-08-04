import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `GET/POST/DELETE /api/mensa/alternative` — la seconda delle tre copie di
 * `tabellaMancante`, con lo stesso regex sul MESSAGGIO:
 *
 *     /does not exist|schema cache|could not find/i.test(error.message)
 *
 * Qui la tolleranza cadeva anche su `42703` (colonna assente in SELECT) e su
 * `PGRST204` (colonna assente in INSERT/UPDATE), che erano perfino elencati per
 * codice. Conseguenza: una migrazione applicata a metà su `mensa_alternative` —
 * tabella che in produzione ESISTE ed è viva — faceva rispondere «nessuna
 * alternativa oggi» alla cucina, e «funzione non ancora disponibile» alla
 * segreteria che stava registrando una richiesta alimentare.
 *
 * L'alternativa del pasto è il posto dove finiscono le intolleranze: una lista
 * vuota che dovrebbe avere righe è un bambino che riceve il piatto sbagliato.
 * Perciò la tolleranza resta SOLO su «la tabella non c'è» (42P01/PGRST205).
 */

const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
const ALUNNO = 'a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  alunno: null as Record<string, unknown> | null,
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
      b.maybeSingle = async () => ({ data: table === 'alunni' ? h.alunno : h.utente, error: null })
      b.upsert = async () => ({ error: h.upsertError })
      b.delete = () => { b.__delete = true; return b }
      b.then = (res: (v: unknown) => void) => {
        if (table === 'alunni') return res({ data: [], error: null })
        if (table === 'mensa_alternative') {
          if (b.__delete) return res({ data: null, error: h.deleteError })
          return res({ data: [], error: h.altError })
        }
        return res({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET, POST, DELETE } from '@/app/api/mensa/alternative/route'

const getReq = (qs = '') =>
  new NextRequest(`http://localhost/api/mensa/alternative${qs}`, { headers: { 'x-user-id': SEGRETERIA } })
const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/mensa/alternative', {
    method: 'POST',
    headers: { 'x-user-id': SEGRETERIA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const delReq = (qs: string) =>
  new NextRequest(`http://localhost/api/mensa/alternative${qs}`, {
    method: 'DELETE',
    headers: { 'x-user-id': SEGRETERIA },
  })

const CORPO = { alunno_id: ALUNNO, data: '2026-07-14', richiesta: 'pasto in bianco' }

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: SEGRETERIA, nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria', role: 'segreteria', scuola_id: 'sc-1' }
  h.alunno = { id: ALUNNO, scuola_id: 'sc-1' }
  h.altError = null
  h.upsertError = null
  h.deleteError = null
})

describe('GET /api/mensa/alternative — tabella assente vs colonna assente', () => {
  it('42P01 → 200 con lista vuota (tolleranza d\'ambiente)', async () => {
    h.altError = { code: '42P01', message: 'relation "mensa_alternative" does not exist' }
    const res = await GET(getReq('?data=2026-07-14'))
    expect(res.status).toBe(200)
    expect((await res.json()).data.alternative).toEqual([])
  })

  it('PGRST205 → 200 con lista vuota', async () => {
    h.altError = { code: 'PGRST205', message: "Could not find the table 'public.mensa_alternative' in the schema cache" }
    const res = await GET(getReq('?data=2026-07-14'))
    expect(res.status).toBe(200)
    expect((await res.json()).data.alternative).toEqual([])
  })

  it('42703 (COLONNA assente) → 500, NON una lista vuota', async () => {
    // «Nessuna alternativa oggi» detto a chi cucina, quando invece la query non
    // è mai riuscita, è il piatto sbagliato servito a un bambino intollerante.
    h.altError = { code: '42703', message: 'column mensa_alternative.origine does not exist' }
    const res = await GET(getReq('?data=2026-07-14'))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.data?.alternative).toBeUndefined()
  })

  it('il 500 non racconta lo schema al chiamante', async () => {
    h.altError = { code: '42703', message: 'column mensa_alternative.origine does not exist' }
    const corpo = JSON.stringify(await (await GET(getReq('?data=2026-07-14'))).json())
    expect(corpo).not.toContain('mensa_alternative')
    expect(corpo).not.toContain('origine does not exist')
  })
})

describe('POST /api/mensa/alternative — tabella assente vs colonna assente', () => {
  it('42P01 → 503 «Funzione non ancora disponibile»', async () => {
    h.upsertError = { code: '42P01', message: 'relation "mensa_alternative" does not exist' }
    const res = await POST(postReq(CORPO))
    expect(res.status).toBe(503)
  })

  it('PGRST204 (colonna assente in INSERT) → 500, NON un 503 «non ancora disponibile»', async () => {
    // 503 dice «questa funzione qui non c'è»: è vero su un ambiente non migrato,
    // è falso su una tabella viva a cui manca una colonna. Chi legge il 503 non
    // apre nessun incidente, e la richiesta alimentare resta non registrata.
    h.upsertError = { code: 'PGRST204', message: "Could not find the 'origine' column of 'mensa_alternative' in the schema cache" }
    const res = await POST(postReq(CORPO))
    expect(res.status).toBe(500)
  })

  it('42703 → 500', async () => {
    h.upsertError = { code: '42703', message: 'column "origine" does not exist' }
    expect((await POST(postReq(CORPO))).status).toBe(500)
  })
})

describe('DELETE /api/mensa/alternative — tabella assente vs colonna assente', () => {
  it('42P01 → 503', async () => {
    h.deleteError = { code: '42P01', message: 'relation "mensa_alternative" does not exist' }
    expect((await DELETE(delReq(`?alunno_id=${ALUNNO}&data=2026-07-14`))).status).toBe(503)
  })

  it('42703 → 500, non 503', async () => {
    h.deleteError = { code: '42703', message: 'column "data" does not exist' }
    expect((await DELETE(delReq(`?alunno_id=${ALUNNO}&data=2026-07-14`))).status).toBe(500)
  })
})
