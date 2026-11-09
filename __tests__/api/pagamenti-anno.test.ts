import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · Le voci di pagamento di una famiglia le decide `voci_visibili_genitore`: lista e dettaglio dicono lo stesso.
 * `getFigliDiGenitore` non si restringe: la voce del ritirato con dovuto aperto resta. Schema indietro: come oggi. Un guasto non
 * apre. Lo staff resta com'è. Solo uuid finti.
 */

const GEN = '99999999-9999-4999-8999-999999999991'
const DOCENTE = '99999999-9999-4999-8999-999999999992'
const STAFF = '99999999-9999-4999-8999-999999999993'
const FIGLIO = '11111111-1111-4111-8111-111111111111'
const RITIRATO = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'

const RETTA = '88888888-8888-4888-8888-888888888881'
const ANNO_FUTURO = '88888888-8888-4888-8888-888888888882'
const CONTENITORE = '88888888-8888-4888-8888-888888888883'
const RATA = '88888888-8888-4888-8888-888888888884'
const QUOTA_MIA = '88888888-8888-4888-8888-888888888885'
const QUOTA_ALTRUI = '88888888-8888-4888-8888-888888888886'
const DOVUTO_RITIRATO = '88888888-8888-4888-8888-888888888887'
const NON_PUBBLICATA = '88888888-8888-4888-8888-888888888888'

const FUTURO_LONTANO = '2999-01-01'

type Rpc = (args: Riga) => RispostaRpc

const INDIETRO: RispostaRpc = { data: null, error: { code: 'PGRST202', message: 'assente' } }
const GUASTO: RispostaRpc = { data: null, error: { code: '57014', message: 'timeout' } }

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  voci: null as unknown,
  argomenti: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => [SEDE]),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: h.getFigliDiGenitore,
  genitoreHasFiglio: h.genitoreHasFiglio,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, h.lette, {
    rpc: {
      voci_visibili_genitore: (args: Riga) => {
        h.argomenti.push(args)
        return (h.voci as Rpc)(args)
      },
    },
  }),
}))

import { GET as lista } from '@/app/api/pagamenti/route'
import { GET as dettaglio } from '@/app/api/pagamenti/[id]/route'

const leggiLista = () => lista(new Request('http://test/api/pagamenti') as never)
const apri = (id: string) =>
  dettaglio(new Request(`http://test/api/pagamenti/${id}`), { params: Promise.resolve({ id }) })

const genitore = { user: { id: GEN, role: 'genitore', ruoli: ['genitore'] } }
const docenteGenitore = { user: { id: DOCENTE, role: 'educator', ruoli: ['educator', 'genitore'] } }
const staff = { user: { id: STAFF, role: 'segreteria', ruoli: ['segreteria'], scuola_id: SEDE } }

const voce = (id: string, altri: Record<string, unknown> = {}) => ({
  id,
  alunno_id: FIGLIO,
  scuola_id: SEDE,
  descrizione: 'voce',
  importo: 100,
  importo_pagato: 0,
  scadenza: '2026-12-01',
  stato: 'da_pagare',
  tipo: 'singolo',
  visibile_dal: null,
  ...altri,
})
const dalla = (...voci: string[]): Rpc => () => ({ data: voci.map((voce_id) => ({ voce_id })), error: null })
const idDi = async (res: Response) => {
  expect(res.status).toBe(200)
  return ((await res.json()).data as { id: string }[]).map((r) => r.id).sort()
}
const negati = () => h.logEvento.mock.calls.filter((c) => (c[2] as { operazione?: string }).operazione === 'anno/visibilita:negato')

beforeEach(() => {
  vi.clearAllMocks()
  h.lette.length = 0
  h.argomenti.length = 0
  h.db = {
    pagamenti: [
      voce(RETTA),
      voce(ANNO_FUTURO),
      voce(CONTENITORE, { tipo: 'padre' }),
      voce(RATA, { tipo: 'rata', parent_payment_id: CONTENITORE }),
      voce(QUOTA_MIA, { tipo: 'split', importo: 200 }),
      voce(QUOTA_ALTRUI, { tipo: 'split', importo: 200 }),
      voce(DOVUTO_RITIRATO, { alunno_id: RITIRATO }),
      voce(NON_PUBBLICATA, { visibile_dal: FUTURO_LONTANO }),
    ],
    pagamenti_quote: [{ id: 'q1', pagamento_id: QUOTA_MIA, adult_id: GEN, importo: 80 }],
    incassi: [],
    schools: [{ id: SEDE, name: 'sede' }],
  }
  h.requireUser.mockResolvedValue(genitore)
  h.requireStaff.mockResolvedValue(staff)
  h.getFigliDiGenitore.mockResolvedValue([FIGLIO, RITIRATO])
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.voci = dalla(RETTA, CONTENITORE, RATA, QUOTA_MIA, DOVUTO_RITIRATO)
})

describe('GET /api/pagamenti, famiglia', () => {
  it('chiede le voci per chi guarda, non per chi lo dichiara', async () => {
    await leggiLista()
    expect(h.argomenti).toEqual([{ p_utente: GEN }])
  })

  it('la voce di un anno futuro che la funzione non dà non esce, anche se il figlio è suo e la voce è pubblicata', async () => {
    expect(await idDi(await leggiLista())).not.toContain(ANNO_FUTURO)
  })

  it('la voce del ritirato con dovuto aperto resta: i figli non si restringono', async () => {
    expect(await idDi(await leggiLista())).toContain(DOVUTO_RITIRATO)
    expect(h.getFigliDiGenitore).toHaveBeenCalledWith(expect.anything(), GEN)
  })

  it('la divisa senza la propria quota sparisce, quella con la quota mostra la quota', async () => {
    const res = await leggiLista()
    const righe = (await res.json()).data as { id: string; importo: number; importo_totale_famiglia?: number }[]
    expect(righe.map((r) => r.id)).not.toContain(QUOTA_ALTRUI)
    const mia = righe.find((r) => r.id === QUOTA_MIA)
    expect(mia).toMatchObject({ importo: 80, importo_totale_famiglia: 200 })
  })

  it('il contenitore rateale resta nascosto alla famiglia anche se la funzione lo dà, le rate si vedono', async () => {
    const ids = await idDi(await leggiLista())
    expect(ids).not.toContain(CONTENITORE)
    expect(ids).toContain(RATA)
  })

  it('zero voci: 200 e lista vuota, nessuna pagina in errore', async () => {
    h.voci = dalla()
    const res = await leggiLista()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: [], sedi: [] })
  })

  it('zero figli: 200 e lista vuota, senza nemmeno chiedere le voci', async () => {
    h.getFigliDiGenitore.mockResolvedValue([])
    const res = await leggiLista()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [], sedi: [] })
    expect(h.argomenti).toEqual([])
  })

  it('un guasto non apre: 500 con il codice, nessuna voce letta, e la risposta non si mette in cache', async () => {
    h.voci = () => GUASTO
    const res = await leggiLista()
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('LETTURA_FALLITA')
    expect(corpo.data).toBeUndefined()
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(h.lette).not.toContain('pagamenti')
  })

  it('schema indietro: come oggi, e la voce non ancora pubblicata resta fuori', async () => {
    h.voci = () => INDIETRO
    const ids = await idDi(await leggiLista())
    expect(ids).toEqual([ANNO_FUTURO, DOVUTO_RITIRATO, QUOTA_MIA, RATA, RETTA].sort())
    expect(ids).not.toContain(NON_PUBBLICATA)
  })

  it('docente con figli propri: anche per lei decide la funzione, in veste di lavoro il contenitore si vede', async () => {
    h.requireUser.mockResolvedValue(docenteGenitore)
    const ids = await idDi(await leggiLista())
    expect(h.argomenti).toEqual([{ p_utente: DOCENTE }])
    expect(ids).not.toContain(ANNO_FUTURO)
    expect(ids).toContain(CONTENITORE)
  })
})

describe('GET /api/pagamenti, staff', () => {
  it('il prospetto intero, senza chiedere le voci alla funzione', async () => {
    h.requireUser.mockResolvedValue(staff)
    const ids = await idDi(await leggiLista())
    expect(h.argomenti).toEqual([])
    expect(ids).toContain(ANNO_FUTURO)
    expect(ids).toContain(CONTENITORE)
  })
})

describe('GET /api/pagamenti/[id], famiglia', () => {
  it('la voce data dalla funzione si apre', async () => {
    const res = await apri(RETTA)
    expect(res.status).toBe(200)
    expect(h.argomenti).toEqual([{ p_utente: GEN }])
  })

  it('una vetrina non è una porta: la voce di un anno futuro non si apre nemmeno conoscendone l’uuid', async () => {
    const res = await apri(ANNO_FUTURO)
    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('incassi')
    expect(negati()).toHaveLength(1)
    expect(negati()[0][2]).toMatchObject({ tipo: 'pagamento-nascosto', pagamento: ANNO_FUTURO, uid: GEN })
  })

  it('senza legame col bambino la funzione non viene nemmeno chiesta', async () => {
    h.genitoreHasFiglio.mockResolvedValue(false)
    expect((await apri(RETTA)).status).toBe(403)
    expect(h.argomenti).toEqual([])
  })

  it('un guasto non apre: 500 e nessun incasso letto', async () => {
    h.voci = () => GUASTO
    const res = await apri(RETTA)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.lette).not.toContain('incassi')
  })

  it('schema indietro: come oggi, si apre; la voce non pubblicata resta chiusa', async () => {
    h.voci = () => INDIETRO
    expect((await apri(ANNO_FUTURO)).status).toBe(200)
    expect((await apri(NON_PUBBLICATA)).status).toBe(403)
  })

  it('la divisa con la propria quota mostra la quota', async () => {
    const res = await apri(QUOTA_MIA)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ importo: 80, importo_totale_famiglia: 200 })
  })
})

describe('GET /api/pagamenti/[id], staff', () => {
  it('apre anche la voce dell’anno futuro, senza chiedere alla funzione', async () => {
    h.requireUser.mockResolvedValue(staff)
    expect((await apri(ANNO_FUTURO)).status).toBe(200)
    expect(h.argomenti).toEqual([])
  })
})
