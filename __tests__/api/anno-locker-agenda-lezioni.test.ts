import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// Compito 4.3.7 · `locker/materials`, `agenda` e `register/lessons` risolvono una classe PER NOME sull'anno ATTIVO.
//
// Due sezioni omonime di anni diversi nella stessa sede («1A» di oggi e «1A» del 2027/28): il finto APPLICA i filtri,
// quindi senza il filtro d'anno la ricerca ne troverebbe due. Prova 1: con l'anno attivo ne passa UNA sola (la
// configurazione di quella di oggi, nessun 400 di omonimia). Prova 2: con lo schema dell'anno indietro (la CI) nessun
// filtro e nessun errore.
// =============================================================================

const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const S2 = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3 = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_OGGI = '5ec00000-0000-4000-8000-00000000000a'
const SEZ_DOMANI = '5ec00000-0000-4000-8000-00000000000f'
const UTENTE = 'd0000000-0000-4000-8000-00000000ad00'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, ErrorePostgrest>,
}))

vi.mock('@/lib/auth/require-staff', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/auth/require-staff')>()
  return { ...vero, requireUser: h.requireUser, requireDocente: h.requireDocente }
})
vi.mock('@/lib/auth/scope', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/auth/scope')>()
  return {
    ...vero,
    scuoleDiUtente: async () => [SEDE_A],
    resolveScuoleAttive: async () => [SEDE_A],
  }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      crea(h.db as DBFinto, [], { errori: h.errori, rpc: { anno_attivo: () => ({ data: S2, error: null }) } }),
  }
})

import { GET as MATERIALI } from '@/app/api/locker/materials/route'
import { GET as AGENDA } from '@/app/api/agenda/route'

const dbBase = (): Record<string, Record<string, unknown>[]> => ({
  anni_sede: [
    { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
    { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
  ],
  sections: [
    { id: SEZ_OGGI, name: '1A', scuola_id: SEDE_A, anno_id: A2 },
    { id: SEZ_DOMANI, name: '1A', scuola_id: SEDE_A, anno_id: A3 },
  ],
  locker_config: [
    { id: 'c-oggi', nome: 'Pannolini', attivo: true, ordine: 1, section_id: SEZ_OGGI },
    { id: 'c-domani', nome: 'Salviette', attivo: true, ordine: 2, section_id: SEZ_DOMANI },
  ],
  agenda_eventi: [],
  utenti_scuole: [],
})

const senzaAnno = () => {
  h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
  h.db.sections = h.db.sections.map((s) => {
    const c = { ...s }
    delete c.anno_id
    return c
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.errori = {}
  h.requireUser.mockResolvedValue({ user: { id: UTENTE, role: 'admin', scuola_id: SEDE_A } })
  h.requireDocente.mockResolvedValue({ user: { id: UTENTE, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/locker/materials · la classe per nome è quella dell\'anno attivo', () => {
  const chiama = () => MATERIALI(new NextRequest('http://localhost/api/locker/materials?classe_sezione=1A'))

  it('torna la configurazione della «1A» di oggi e NON quella della «1A» del 2027/28', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as { id: string }[]).map((r) => r.id)
    expect(ids).toEqual(['c-oggi'])
  })

  it('con lo schema dell\'anno indietro: nessun filtro e nessun errore (entrambe le omonime)', async () => {
    senzaAnno()
    const res = await chiama()
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as { id: string }[]).map((r) => r.id).sort()
    expect(ids).toEqual(['c-domani', 'c-oggi'])
  })
})

describe('GET /api/agenda · la sezione per nome è quella dell\'anno attivo', () => {
  const chiama = () => AGENDA(new NextRequest('http://localhost/api/agenda?sezione=1A&from=2026-11-01'))

  it('con due «1A» di anni diversi NON c\'è omonimia: la risposta non è 400 né 403', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
  })

  it('con lo schema dell\'anno indietro e UNA sola sezione: nessun filtro e nessun errore', async () => {
    senzaAnno()
    h.db.sections = h.db.sections.slice(0, 1)
    const res = await chiama()
    expect(res.status).toBe(200)
  })

  it('senza il filtro d\'anno le due omonime darebbero SEDE_DA_SPECIFICARE (prova che il test misura)', async () => {
    senzaAnno()
    const res = await chiama()
    expect(res.status).toBe(400)
  })
})
