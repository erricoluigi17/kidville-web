import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// =============================================================================
// PERIODI DI SCRUTINIO: SI ARCHIVIANO, NON SI CANCELLANO (fase 4 della robustezza, D3-C).
//
// Un periodo con scrutini non si può eliminare (RESTRICT dalla fase 7). Qui si prova
// l'altra metà: l'archiviazione lo toglie dall'elenco senza toccare niente di suo,
// lo disattiva nella stessa scrittura, si annulla, lascia traccia, e sul database
// della CI (non migrato) degrada dicendolo invece di rompersi.
// =============================================================================

const SEDE = '11111111-1111-4111-8111-111111111111'
const PERIODO = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'

type Chiamata = { tabella: string; metodo: string; argomenti: unknown[] }

const h = vi.hoisted(() => ({
  chiamate: [] as { tabella: string; metodo: string; argomenti: unknown[] }[][],
  /** Risposta della lettura: in funzione delle clausole (per simulare la colonna assente solo col filtro). */
  lettura: null as null | ((clausole: { tabella: string; metodo: string; argomenti: unknown[] }[]) => { data: unknown; error: unknown }),
  aggiornamento: { data: [{ id: '22222222-2222-4222-8222-222222222222' }], error: null } as { data: unknown; error: unknown },
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => ({ user: { id: '33333333-3333-4333-8333-333333333333', scuola_id: '11111111-1111-4111-8111-111111111111' }, response: null })),
}))

vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['11111111-1111-4111-8111-111111111111']),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: '11111111-1111-4111-8111-111111111111', response: null })),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const clausole: Chiamata[] = []
      h.chiamate.push(clausole)
      let aggiorna = false
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'order', 'eq', 'is', 'limit']) {
        qb[m] = (...argomenti: unknown[]) => {
          clausole.push({ tabella, metodo: m, argomenti })
          return qb
        }
      }
      qb.update = (...argomenti: unknown[]) => {
        aggiorna = true
        clausole.push({ tabella, metodo: 'update', argomenti })
        return qb
      }
      qb.then = (res: (v: unknown) => unknown) => {
        if (aggiorna) return Promise.resolve(h.aggiornamento).then(res)
        return Promise.resolve(h.lettura ? h.lettura(clausole) : { data: [], error: null }).then(res)
      }
      return qb
    },
  }),
}))

import { GET, PATCH } from '@/app/api/admin/primaria/scrutinio-periodi/route'

const get = (query = '') => GET(new NextRequest(`http://localhost/api/admin/primaria/scrutinio-periodi${query}`))
const patch = (body: unknown) =>
  PATCH(
    new NextRequest('http://localhost/api/admin/primaria/scrutinio-periodi', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const filtroArchiviati = (c: Chiamata[]) => c.find((x) => x.metodo === 'is' && x.argomenti[0] === 'archiviato_il')
const scrittura = () => h.chiamate.flat().find((x) => x.metodo === 'update')?.argomenti[0] as Record<string, unknown> | undefined

beforeEach(() => {
  h.chiamate = []
  h.lettura = null
  h.aggiornamento = { data: [{ id: PERIODO }], error: null }
  h.eventi = []
})

describe('scrutinio-periodi · l’elenco', () => {
  it('di default nasconde gli archiviati', async () => {
    const res = await get(`?scuolaId=${SEDE}`)
    expect(res.status).toBe(200)
    expect(filtroArchiviati(h.chiamate[0])?.argomenti).toEqual(['archiviato_il', null])
  })

  it('con archiviati=si li mostra tutti', async () => {
    await get('?archiviati=si')
    expect(filtroArchiviati(h.chiamate[0])).toBeUndefined()
  })

  it('sul DB non migrato (42703) rilegge senza il filtro, e lo scrive nel log', async () => {
    h.lettura = (c) =>
      filtroArchiviati(c)
        ? { data: null, error: { code: '42703', message: 'column scrutinio_periodi.archiviato_il does not exist' } }
        : { data: [{ id: PERIODO, nome: 'Primo quadrimestre' }], error: null }
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toHaveLength(1)
    expect(h.chiamate).toHaveLength(2)
    expect(h.eventi.find((e) => e.campi.esito === 'archiviazione-non-disponibile-schema')).toBeDefined()
  })

  it('un errore vero non diventa un elenco vuoto: 500 con il codice', async () => {
    h.lettura = () => ({ data: null, error: { code: '57014', message: 'canceled' } })
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
  })
})

describe('scrutinio-periodi · archivia e rimetti in elenco', () => {
  it('archiviare scrive l’istante E disattiva il periodo, nella stessa scrittura, e lascia traccia', async () => {
    const res = await patch({ id: PERIODO, archiviato: true })
    expect(res.status).toBe(200)
    const s = scrittura()!
    expect(typeof s.archiviato_il).toBe('string')
    expect(Number.isNaN(Date.parse(s.archiviato_il as string))).toBe(false)
    expect(s.attivo).toBe(false)
    const traccia = h.eventi.find((e) => e.campi.esito === 'periodo-archiviato')
    expect(traccia?.campi).toMatchObject({ periodo_id: PERIODO, utente_id: ADMIN })
  })

  it('rimettere in elenco azzera l’istante e non tocca «attivo»', async () => {
    await patch({ id: PERIODO, archiviato: false })
    const s = scrittura()!
    expect(s).toHaveProperty('archiviato_il', null)
    expect(s).not.toHaveProperty('attivo')
    expect(h.eventi.find((e) => e.campi.esito === 'periodo-ripristinato')).toBeDefined()
  })

  it('una modifica normale non tocca l’archiviazione', async () => {
    await patch({ id: PERIODO, nome: 'Scrutinio finale' })
    expect(scrittura()).not.toHaveProperty('archiviato_il')
  })

  it('sul DB non migrato (PGRST204) risponde 503 e lo dice, senza fingere', async () => {
    h.aggiornamento = { data: null, error: { code: 'PGRST204', message: "Could not find the 'archiviato_il' column" } }
    const res = await patch({ id: PERIODO, archiviato: true })
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ARCHIVIAZIONE_NON_DISPONIBILE')
  })

  it('un periodo di un’altra sede (0 righe) è 404, e non lascia traccia di archiviazione', async () => {
    h.aggiornamento = { data: [], error: null }
    const res = await patch({ id: PERIODO, archiviato: true })
    expect(res.status).toBe(404)
    expect(h.eventi.find((e) => e.campi.esito === 'periodo-archiviato')).toBeUndefined()
  })
})
