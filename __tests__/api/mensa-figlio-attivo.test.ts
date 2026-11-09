import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · La mensa del genitore: solo per un figlio attivo (403 `FIGLIO_NON_ATTIVO`), e solo sulle date dell'anno attivo della sede
 * (422 `DATA_FUORI_ANNO` su prenotazione e disdetta; la lettura ritaglia, perché una settimana può stare a cavallo dell'anno e
 * rifiutarla la cancellerebbe tutta). Lo staff allo sportello resta com'è. Schema indietro: come oggi. Un guasto non apre.
 * Solo uuid finti.
 */

const GEN = '99999999-9999-4999-8999-999999999991'
const STAFF = '99999999-9999-4999-8999-999999999992'
const FIGLIO = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ = '55555555-5555-4555-8555-555555555551'
const FREQ = '66666666-6666-4666-8666-666666666661'
const ANNO_PRIMA = '77777777-7777-4777-8777-777777777771'
const ANNO_ORA = '77777777-7777-4777-8777-777777777772'
const ANNO_DOPO = '77777777-7777-4777-8777-777777777773'

const NELL_ANNO = '2026-11-16'
const ANNO_SCORSO = '2026-06-15'
const ANNO_PROSSIMO = '2027-09-15'

type Rpc = (args: Riga) => RispostaRpc

const INDIETRO: RispostaRpc = { data: null, error: { code: 'PGRST202', message: 'assente' } }
const GUASTO: RispostaRpc = { data: null, error: { code: '57014', message: 'timeout' } }

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  errori: {} as Record<string, { code: string; message: string }>,
  figliAttivi: null as unknown,
  chiamate: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: vi.fn(async () => null) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ alunnoSospeso: vi.fn(async () => false) }))
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({ cutoffOra: '09:30', giorniAttivi: [1, 2, 3, 4, 5], settimaneRotazione: 4, sogliaSaldoBasso: 0 }),
  loadResolveOptions: async () => ({}),
  resolveMenuConfigId: async () => null,
  entroCutoff: () => true,
}))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuGiorno: () => ({ attivo: true, chiuso: false }) }))
vi.mock('@/lib/mensa/notify', () => ({ notificaSaldoBasso: vi.fn() }))
vi.mock('@/lib/mensa/allergie-check', () => ({ controllaAllergie: async () => {} }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, h.lette, {
    errori: h.errori,
    rpc: {
      figli_attivi: (args: Riga) => (h.figliAttivi as Rpc)(args),
      scala_ticket_e_prenota: () => {
        h.chiamate.push('scala')
        return { data: 4, error: null }
      },
      riaccredita_ticket_e_disdici: () => {
        h.chiamate.push('riaccredita')
        return { data: 6, error: null }
      },
    },
  }),
}))

import { GET, POST, DELETE } from '@/app/api/mensa/prenotazioni/route'

const url = 'http://test/api/mensa/prenotazioni'
const leggi = () => GET(new Request(`${url}?alunno_id=${FIGLIO}&from=2026-06-01&to=2027-12-31`) as never)
const prenota = (date: string | string[]) => POST(new Request(url, { method: 'POST', body: JSON.stringify({ alunno_id: FIGLIO, date }) }) as never)
const disdici = (data: string) => DELETE(new Request(`${url}?alunno_id=${FIGLIO}&data=${data}`, { method: 'DELETE' }) as never)

const genitore = { user: { id: GEN, role: 'genitore', ruoli: ['genitore'] } }
const staff = { user: { id: STAFF, role: 'segreteria', ruoli: ['segreteria'] } }
const annoSede = (id: string, inizio: string, fine: string, stato: string) => ({
  id: `${id.slice(0, -1)}a`, anno_id: id, scuola_id: SEDE, inizio, fine, ultimo_giorno_aperto: fine, prepara_successivo_dal: fine, stato, domande_aperte: false,
})
const negati = () => h.logEvento.mock.calls.filter((c) => (c[2] as { operazione?: string }).operazione === 'anno/visibilita:negato')

beforeEach(() => {
  vi.clearAllMocks()
  h.lette.length = 0
  h.chiamate.length = 0
  h.errori = {}
  h.db = {
    alunni: [{ id: FIGLIO, scuola_id: SEDE, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', section_id: SEZ, allergies: null, allergeni: null }],
    ticket_mensa: [{ alunno_id: FIGLIO, saldo_ticket: 5 }],
    mensa_prenotazioni: [
      { alunno_id: FIGLIO, data: ANNO_SCORSO, stato: 'prenotato', origine: 'genitore', id: '88888888-8888-4888-8888-888888888881', ticket_scalato: 1 },
      { alunno_id: FIGLIO, data: NELL_ANNO, stato: 'prenotato', origine: 'genitore', id: '88888888-8888-4888-8888-888888888882', ticket_scalato: 1 },
      { alunno_id: FIGLIO, data: ANNO_PROSSIMO, stato: 'prenotato', origine: 'genitore', id: '88888888-8888-4888-8888-888888888883', ticket_scalato: 1 },
    ],
    anni_sede: [
      annoSede(ANNO_PRIMA, '2025-09-01', '2026-08-31', 'chiuso'),
      annoSede(ANNO_ORA, '2026-09-01', '2027-08-31', 'corrente'),
      // In preparazione: non è ancora l'anno in cui si lavora.
      annoSede(ANNO_DOPO, '2027-09-01', '2028-08-31', 'preparazione'),
    ],
    anni_scolastici: [
      { id: ANNO_PRIMA, anno_inizio: 2025 },
      { id: ANNO_ORA, anno_inizio: 2026 },
      { id: ANNO_DOPO, anno_inizio: 2027 },
    ],
  }
  h.requireUser.mockResolvedValue(genitore)
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.figliAttivi = (() => ({
    data: [{ alunno_id: FIGLIO, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE }],
    error: null,
  })) as Rpc
})

describe('GET /api/mensa/prenotazioni, famiglia', () => {
  const pasti = async () => {
    const res = await leggi()
    expect(res.status).toBe(200)
    const j = await res.json() as { data: { prenotazioni: Array<{ data: string }>; saldo: number } }
    return j.data
  }

  it('i pasti dell’anno attivo: il resto si ritaglia, non si rifiuta', async () => {
    const d = await pasti()

    expect(d.prenotazioni.map((p) => p.data)).toEqual([NELL_ANNO])
    expect(d.saldo).toBe(5)
  })

  it('un figlio non attivo: 403 con il codice, la riga di rifiuto, e i pasti non si leggono', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    const res = await leggi()

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'FIGLIO_NON_ATTIVO' })
    expect(h.lette).not.toContain('mensa_prenotazioni')
    expect(negati()[0][2]).toMatchObject({ tipo: 'mensa-figlio-non-attivo', alunno: FIGLIO, uid: GEN })
  })

  it('chi non è legato resta fuori senza chiedere alla funzione', async () => {
    const chiamata = vi.fn(() => ({ data: [], error: null }))
    h.figliAttivi = chiamata as unknown as Rpc
    h.genitoreHasFiglio.mockResolvedValue(false)

    expect((await leggi()).status).toBe(403)
    expect(chiamata).not.toHaveBeenCalled()
  })

  it('un guasto della funzione non apre: 500, e i pasti non si leggono', async () => {
    h.figliAttivi = (() => GUASTO) as Rpc

    const res = await leggi()

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.lette).not.toContain('mensa_prenotazioni')
  })

  it('un guasto del calendario non apre: 500, non tutti i pasti', async () => {
    h.errori.anni_sede = { code: '57014', message: 'timeout' }

    const res = await leggi()

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
  })

  it('schema indietro: tutti i pasti del periodo, come oggi', async () => {
    h.figliAttivi = (() => INDIETRO) as Rpc
    h.errori.anni_sede = { code: 'PGRST205', message: 'assente' }

    const d = await pasti()

    expect(d.prenotazioni.map((p) => p.data)).toEqual([ANNO_SCORSO, NELL_ANNO, ANNO_PROSSIMO])
  })

  it('lo staff non passa dalla funzione e non ritaglia', async () => {
    const chiamata = vi.fn(() => ({ data: [], error: null }))
    h.figliAttivi = chiamata as unknown as Rpc
    h.requireUser.mockResolvedValue(staff)

    const d = await pasti()

    expect(chiamata).not.toHaveBeenCalled()
    expect(d.prenotazioni).toHaveLength(3)
  })
})

describe('POST /api/mensa/prenotazioni', () => {
  beforeEach(() => {
    h.db.mensa_prenotazioni = []
  })

  it('una data dell’anno attivo si prenota', async () => {
    const res = await prenota(NELL_ANNO)

    expect(res.status).toBe(201)
    expect(h.chiamate).toEqual(['scala'])
  })

  it.each([
    ['dell’anno scorso', ANNO_SCORSO],
    ['dell’anno in preparazione', ANNO_PROSSIMO],
  ])('una data %s: 422 `DATA_FUORI_ANNO`, e nessun ticket scalato', async (_nome, data) => {
    const res = await prenota(data)

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ codice: 'DATA_FUORI_ANNO' })
    expect(h.chiamate).toEqual([])
  })

  it('una richiesta con una data dentro e una fuori non prenota nemmeno quella dentro', async () => {
    const res = await prenota([NELL_ANNO, ANNO_SCORSO])

    expect(res.status).toBe(422)
    expect(h.chiamate).toEqual([])
  })

  it('un figlio non attivo: 403, nessun ticket scalato', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    const res = await prenota(NELL_ANNO)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'FIGLIO_NON_ATTIVO' })
    expect(h.chiamate).toEqual([])
  })

  it('un guasto della funzione non apre: 500, nessun ticket scalato', async () => {
    h.figliAttivi = (() => GUASTO) as Rpc

    const res = await prenota(NELL_ANNO)

    expect(res.status).toBe(500)
    expect(h.chiamate).toEqual([])
  })

  it('un guasto del calendario non apre: 500, nessun ticket scalato', async () => {
    h.errori.anni_sede = { code: '57014', message: 'timeout' }

    const res = await prenota(NELL_ANNO)

    expect(res.status).toBe(500)
    expect(h.chiamate).toEqual([])
  })

  it('schema indietro: si prenota come oggi', async () => {
    h.figliAttivi = (() => INDIETRO) as Rpc
    h.errori.anni_sede = { code: 'PGRST205', message: 'assente' }

    expect((await prenota(ANNO_SCORSO)).status).toBe(201)
    expect(h.chiamate).toEqual(['scala'])
  })

  it('la segreteria allo sportello può ancora forzare una data dell’anno scorso', async () => {
    h.requireUser.mockResolvedValue(staff)

    expect((await prenota(ANNO_SCORSO)).status).toBe(201)
    expect(h.chiamate).toEqual(['scala'])
  })
})

describe('DELETE /api/mensa/prenotazioni', () => {
  it('una data dell’anno attivo si disdice', async () => {
    const res = await disdici(NELL_ANNO)

    expect(res.status).toBe(200)
    expect(h.chiamate).toEqual(['riaccredita'])
  })

  it('una data fuori anno: 422, nessun riaccredito', async () => {
    const res = await disdici(ANNO_SCORSO)

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ codice: 'DATA_FUORI_ANNO' })
    expect(h.chiamate).toEqual([])
  })

  it('un figlio non attivo: 403, nessun riaccredito', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    expect((await disdici(NELL_ANNO)).status).toBe(403)
    expect(h.chiamate).toEqual([])
  })

  it('un guasto della funzione non apre: 500, nessun riaccredito', async () => {
    h.figliAttivi = (() => GUASTO) as Rpc

    expect((await disdici(NELL_ANNO)).status).toBe(500)
    expect(h.chiamate).toEqual([])
  })

  it('un guasto del calendario non apre: 500, nessun riaccredito', async () => {
    h.errori.anni_sede = { code: '57014', message: 'timeout' }

    expect((await disdici(NELL_ANNO)).status).toBe(500)
    expect(h.chiamate).toEqual([])
  })

  it('schema indietro: si disdice come oggi', async () => {
    h.figliAttivi = (() => INDIETRO) as Rpc
    h.errori.anni_sede = { code: 'PGRST205', message: 'assente' }

    expect((await disdici(ANNO_SCORSO)).status).toBe(200)
    expect(h.chiamate).toEqual(['riaccredita'])
  })

  it('la segreteria può ancora rettificare una data dell’anno scorso', async () => {
    h.requireUser.mockResolvedValue(staff)

    expect((await disdici(ANNO_SCORSO)).status).toBe(200)
    expect(h.chiamate).toEqual(['riaccredita'])
  })
})
