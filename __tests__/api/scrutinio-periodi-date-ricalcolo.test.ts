import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * PERIODI DI SCRUTINIO · DATE, RICALCOLO, PROMEMORIA (spec D13, D14 della data dei voti).
 *
 * Ogni voto e ogni «impreparato» porta il `periodo_id` del quadrimestre che copre la sua data.
 * Quando la segreteria crea, sposta o elimina un periodo, il server riassegna `periodo_id` per
 * quella sede (RPC `primaria_ricalcola_periodi`). Qui si prova:
 *  · i rifiuti PRIMA di scrivere: una data che non è `YYYY-MM-DD` (400 di validazione), una data
 *    sola, la fine prima dell'inizio, due periodi della stessa sede che si sovrappongono (di
 *    QUALUNQUE anno: la copertura di un giorno non guarda l'anno), le date di un periodo con lo
 *    scrutinio chiuso (409);
 *  · il ricalcolo: chiamato solo quando le date cambiano, mai annullato da un suo guasto;
 *  · il promemoria: `dateMancanti` nella GET.
 *
 * Si guarda lo STATO del finto database e le chiamate all'RPC, non la forma delle query. Il finto
 * `creaFintoSupabase` filtra davvero, quindi «il periodo di un'altra sede non conta» è provato.
 * Solo dati finti: sedi da `fixtures/sedi`, nomi inventati.
 */

const Q1 = '55555555-1111-4111-8111-aaaaaaaaaa01'
const Q2 = '55555555-1111-4111-8111-aaaaaaaaaa02'
const Q_B = '55555555-2222-4222-8222-bbbbbbbbbb01'
const SEZ_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ADMIN = '88888888-1111-4111-8111-aaaaaaaaaaaa'
const ANNO = '2026/2027'
const OP = (m: string) => `admin/primaria/scrutinio-periodi:${m}`
const URL_PERIODI = 'http://localhost/api/admin/primaria/scrutinio-periodi'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  rpc: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: undefined as Record<string, { code: string; message: string }> | undefined,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<object>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, [], {
      scritture: h.scritture as never,
      rpc: { primaria_ricalcola_periodi: (args) => h.rpc(args) },
      ...(h.errori ? { errori: h.errori } : {}),
    })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import {
  GET,
  POST,
  PATCH,
  DELETE,
} from '@/app/api/admin/primaria/scrutinio-periodi/route'

const get = (query = '') => GET(new NextRequest(`${URL_PERIODI}${query}`))
const conCorpo = (metodo: 'POST' | 'PATCH', body: unknown) =>
  new NextRequest(URL_PERIODI, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const post = (body: unknown) => POST(conCorpo('POST', body))
const patch = (body: unknown) => PATCH(conCorpo('PATCH', body))
const elimina = (id: string) => DELETE(new NextRequest(`${URL_PERIODI}?id=${id}`, { method: 'DELETE' }))

const nuovo = (extra: Record<string, unknown> = {}) => ({
  scuolaId: SEDE_A,
  annoScolastico: ANNO,
  nome: 'Periodo di prova',
  ...extra,
})

/** Le scritture sulla tabella dei periodi di una data operazione. */
const scritte = (operazione: 'insert' | 'update' | 'delete') =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'scrutinio_periodi' && s.operazione === operazione)

/** I log di rifiuto con quel codice (il quarto campo di `logEvento` è l'oggetto dei campi). */
const rifiuti = (codice: string) =>
  h.logEvento.mock.calls
    .map((c) => c[2] as Record<string, unknown> | undefined)
    .filter((c): c is Record<string, unknown> => c?.error_code === codice)

const esiti = (esito: string) =>
  h.logEvento.mock.calls
    .map((c) => c[2] as Record<string, unknown> | undefined)
    .filter((c) => c?.esito === esito)

const periodo = (id: string, scuola: string, ordine: number, inizio: string | null, fine: string | null, extra = {}) => ({
  id,
  scuola_id: scuola,
  anno_scolastico: ANNO,
  nome: `Quadrimestre ${ordine}`,
  ordine,
  data_inizio: inizio,
  data_fine: fine,
  attivo: true,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
    sections: [{ id: SEZ_A, scuola_id: SEDE_A, name: '2 A' }],
    utenti_scuole: [],
    utenti_sezioni: [],
    utenti: [{ id: ADMIN, scuola_id: SEDE_A, ruolo: 'admin', nome: 'Dir', cognome: 'Uno' }],
    scrutinio_periodi: [
      periodo(Q1, SEDE_A, 1, '2026-09-01', '2027-01-31'),
      periodo(Q2, SEDE_A, 2, '2027-02-01', '2027-06-30'),
    ],
    scrutini: [],
  } as DBFinto
  h.scritture = []
  h.errori = undefined
  h.rpc.mockReset()
  h.rpc.mockImplementation(() => ({ data: { valutazioni: 4, impreparati: 1 }, error: null }))
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A } })
})

/** L'admin di Direzione, con il ponte verso la seconda sede. */
const conPonte = () => {
  h.db.utenti_scuole = [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
  ]
}

// =============================================================================
describe('POST · le date si danno entrambe o nessuna', () => {
  for (const [nome, date] of [
    ['solo l’inizio', { dataInizio: '2026-09-01' }],
    ['solo la fine', { dataFine: '2026-12-31' }],
  ] as const) {
    it(`una data sola (${nome}) → 422 PERIODO_DATE_INCOMPLETE, nessun insert e nessun ricalcolo`, async () => {
      h.db.scrutinio_periodi = []
      const res = await post(nuovo(date))
      expect(res.status).toBe(422)
      const corpo = await res.json()
      expect(corpo.codice).toBe('PERIODO_DATE_INCOMPLETE')
      expect(corpo.error).toBe('Indica entrambe le date del periodo, oppure nessuna.')
      expect(scritte('insert')).toHaveLength(0)
      expect(h.db.scrutinio_periodi).toHaveLength(0)
      expect(h.rpc).not.toHaveBeenCalled()
      expect(rifiuti('PERIODO_DATE_INCOMPLETE')).toEqual([
        expect.objectContaining({ operazione: OP('POST'), scuola_id: SEDE_A, error_code: 'PERIODO_DATE_INCOMPLETE' }),
      ])
    })
  }

  it('la fine prima dell’inizio → 400 PERIODO_ROVESCIATO, nessun insert', async () => {
    const res = await post(nuovo({ dataInizio: '2027-07-01', dataFine: '2027-06-30' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('PERIODO_ROVESCIATO')
    expect(scritte('insert')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(rifiuti('PERIODO_ROVESCIATO')).toHaveLength(1)
  })

  it('un periodo di un solo giorno (inizio = fine) è valido', async () => {
    h.db.scrutinio_periodi = []
    const res = await post(nuovo({ dataInizio: '2027-02-01', dataFine: '2027-02-01' }))
    expect(res.status).toBe(201)
  })
})

describe('POST · la forma delle date', () => {
  // I controlli confrontano stringhe: l'ordine lessicografico vale solo su `YYYY-MM-DD`. Con Q2 a
  // 2027-02-01 / 2027-06-30, «2027-6-1» sta DOPO «2027-06-30» come testo e prima come giorno: senza
  // validazione passerebbe il controllo di sovrapposizione e il database lo salverebbe sopra Q2.
  for (const [nome, date] of [
    ['senza zeri', { dataInizio: '2027-6-1', dataFine: '2027-6-20' }],
    ['un istante ISO', { dataInizio: '2027-06-01T00:00:00Z', dataFine: '2027-06-20' }],
    ['un giorno che non esiste', { dataInizio: '2027-02-30', dataFine: '2027-03-15' }],
    ['una data scritta all’italiana', { dataInizio: '01/06/2027', dataFine: '20/06/2027' }],
  ] as const) {
    it(`una data ${nome} → 400 di validazione, nessun insert e nessun ricalcolo`, async () => {
      const res = await post(nuovo(date))
      expect(res.status).toBe(400)
      expect(scritte('insert')).toHaveLength(0)
      expect(h.db.scrutinio_periodi).toHaveLength(2)
      expect(h.rpc).not.toHaveBeenCalled()
    })
  }

  it('due campi data vuoti («») valgono «nessuna data»: 201 senza ricalcolo', async () => {
    h.db.scrutinio_periodi = []
    const res = await post(nuovo({ dataInizio: '', dataFine: '' }))
    expect(res.status).toBe(201)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(scritte('insert')[0].colpite[0]).toMatchObject({ data_inizio: null, data_fine: null })
  })

  it('una data vuota e una piena restano una data sola → 422 PERIODO_DATE_INCOMPLETE', async () => {
    const res = await post(nuovo({ dataInizio: '2026-09-01', dataFine: '' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODO_DATE_INCOMPLETE')
  })
})

describe('POST · sovrapposizioni (stessa sede, qualunque anno)', () => {
  it('sovrapposto a un periodo della stessa sede e dello stesso anno → 422 PERIODI_SOVRAPPOSTI, nessun insert', async () => {
    const res = await post(nuovo({ nome: 'Terzo', dataInizio: '2027-01-15', dataFine: '2027-03-01' }))
    expect(res.status).toBe(422)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PERIODI_SOVRAPPOSTI')
    expect(corpo.error).toBe('Le date si sovrappongono a un altro periodo dello stesso anno scolastico.')
    expect(scritte('insert')).toHaveLength(0)
    expect(h.db.scrutinio_periodi).toHaveLength(2)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(rifiuti('PERIODI_SOVRAPPOSTI')).toEqual([
      expect.objectContaining({ operazione: OP('POST'), scuola_id: SEDE_A, error_code: 'PERIODI_SOVRAPPOSTI' }),
    ])
  })

  it('gli estremi sono inclusi: iniziare il giorno in cui un altro finisce si sovrappone', async () => {
    h.db.scrutinio_periodi = [periodo(Q1, SEDE_A, 1, '2026-09-01', '2027-01-31')]
    const res = await post(nuovo({ dataInizio: '2027-01-31', dataFine: '2027-06-30' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODI_SOVRAPPOSTI')
  })

  it('il giorno dopo la fine dell’altro non si sovrappone → 201', async () => {
    h.db.scrutinio_periodi = [periodo(Q1, SEDE_A, 1, '2026-09-01', '2027-01-31')]
    const res = await post(nuovo({ dataInizio: '2027-02-01', dataFine: '2027-06-30' }))
    expect(res.status).toBe(201)
  })

  it('un periodo non attivo (archiviato) conta lo stesso: le sue date valgono ancora per i voti', async () => {
    h.db.scrutinio_periodi = [periodo(Q1, SEDE_A, 1, '2026-09-01', '2027-01-31', { attivo: false })]
    const res = await post(nuovo({ dataInizio: '2026-10-01', dataFine: '2026-11-01' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODI_SOVRAPPOSTI')
  })

  it('le stesse date in un’ALTRA SEDE → 201 (il periodo altrui non conta)', async () => {
    conPonte()
    const res = await post(nuovo({ scuolaId: SEDE_B, dataInizio: '2027-01-15', dataFine: '2027-03-01' }))
    expect(res.status).toBe(201)
    expect(scritte('insert')[0].colpite[0].scuola_id).toBe(SEDE_B)
  })

  it('date che si sovrappongono a un periodo di un ALTRO anno della stessa sede → 422 (la copertura non guarda l’anno)', async () => {
    // Un periodo salvato con l'anno sbagliato (pagina del 2025/2026, date del 2027) ruberebbe i voti a Q1 e Q2
    // al ricalcolo successivo: l'anno non può restringere la ricerca.
    const res = await post(nuovo({ annoScolastico: '2025/2026', dataInizio: '2027-01-15', dataFine: '2027-03-01' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODI_SOVRAPPOSTI')
    expect(scritte('insert')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un periodo non attivo di un altro anno conta lo stesso', async () => {
    h.db.scrutinio_periodi.push(periodo('55555555-1111-4111-8111-aaaaaaaaaa09', SEDE_A, 1, '2025-09-01', '2026-01-31', {
      anno_scolastico: '2025/2026', attivo: false,
    }))
    const res = await post(nuovo({ annoScolastico: '2026/2027', dataInizio: '2026-01-31', dataFine: '2026-02-15' }))
    expect(res.status).toBe(422)
  })

  it('date di un altro anno che NON si sovrappongono a niente → 201', async () => {
    const res = await post(nuovo({ annoScolastico: '2025/2026', dataInizio: '2025-09-01', dataFine: '2026-01-31' }))
    expect(res.status).toBe(201)
  })
})

describe('POST · ricalcolo del quadrimestre dei voti', () => {
  it('valido → 201, ricalcolo chiamato per la sede, risposta «fatto»', async () => {
    h.db.scrutinio_periodi = []
    const res = await post(nuovo({ dataInizio: '2026-09-01', dataFine: '2027-01-31' }))
    expect(res.status).toBe(201)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    expect(corpo.ricalcolo).toBe('fatto')
    expect(corpo.data.scuola_id).toBe(SEDE_A)
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith({ p_scuola_id: SEDE_A })
    expect(scritte('insert')).toHaveLength(1)
    // L'esito del ricalcolo lo scrive già `ricalcolaPeriodiSede`: qui basta che sia quello della route.
    expect(esiti('periodi-ricalcolati')).toEqual([
      expect.objectContaining({ operazione: OP('POST'), scuola_id: SEDE_A }),
    ])
  })

  it('senza date → 201, nessun ricalcolo, «non-necessario»', async () => {
    h.db.scrutinio_periodi = []
    const res = await post(nuovo())
    expect(res.status).toBe(201)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(scritte('insert')).toHaveLength(1)
  })

  it('un ricalcolo fallito non annulla la scrittura: 201 con «non-riuscito»', async () => {
    h.db.scrutinio_periodi = []
    h.rpc.mockImplementation(() => ({ data: null, error: { code: 'XX000', message: 'esplosa' } }))
    const res = await post(nuovo({ dataInizio: '2026-09-01', dataFine: '2027-01-31' }))
    expect(res.status).toBe(201)
    expect((await res.json()).ricalcolo).toBe('non-riuscito')
    expect(h.db.scrutinio_periodi).toHaveLength(1)
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it('una lettura dei periodi fallita → 500 LETTURA_FALLITA, nessun insert e nessun ricalcolo', async () => {
    h.errori = { 'scrutinio_periodi:select': { code: '57014', message: 'canceling statement' } }
    const res = await post(nuovo({ dataInizio: '2027-02-01', dataFine: '2027-06-30' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(scritte('insert')).toHaveLength(0)
    expect(h.db.scrutinio_periodi).toHaveLength(2)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('senza date non c’è nulla da confrontare: la lettura dei periodi non serve e non blocca', async () => {
    h.errori = { 'scrutinio_periodi:select': { code: '57014', message: 'canceling statement' } }
    const res = await post(nuovo())
    expect(res.status).toBe(201)
  })
})

// =============================================================================
describe('PATCH · le date di un periodo', () => {
  it('le date cambiano con uno scrutinio chiuso → 409 PERIODO_CON_SCRUTINI_CHIUSI, nessun update', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q1, section_id: SEZ_A, stato: 'chiuso' }]
    const res = await patch({ id: Q1, dataFine: '2027-01-30' })
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('PERIODO_CON_SCRUTINI_CHIUSI')
    expect(corpo.error).toBe('Il periodo ha uno scrutinio chiuso: per spostarne le date va prima riaperto.')
    expect(scritte('update')).toHaveLength(0)
    expect(h.db.scrutinio_periodi.find((p) => p.id === Q1)!.data_fine).toBe('2027-01-31')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(rifiuti('PERIODO_CON_SCRUTINI_CHIUSI')).toEqual([
      expect.objectContaining({ operazione: OP('PATCH'), scuola_id: SEDE_A, error_code: 'PERIODO_CON_SCRUTINI_CHIUSI' }),
    ])
  })

  it('togliere le date a un periodo con lo scrutinio chiuso è uno spostamento: 409', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q1, section_id: SEZ_A, stato: 'chiuso' }]
    const res = await patch({ id: Q1, dataInizio: null, dataFine: null })
    expect(res.status).toBe(409)
    expect(scritte('update')).toHaveLength(0)
  })

  it('il solo nome di un periodo con lo scrutinio chiuso → 200, nessun ricalcolo', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q1, section_id: SEZ_A, stato: 'chiuso' }]
    const res = await patch({ id: Q1, nome: 'Primo quadrimestre 2026' })
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.ricalcolo).toBe('non-necessario')
    expect(corpo.data.nome).toBe('Primo quadrimestre 2026')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('le stesse date rimandate invariate non sono uno spostamento: 200 anche con lo scrutinio chiuso', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q1, section_id: SEZ_A, stato: 'chiuso' }]
    const res = await patch({ id: Q1, nome: 'Rinominato', dataInizio: '2026-09-01', dataFine: '2027-01-31' })
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('lo scrutinio chiuso di un ALTRO periodo non blocca queste date', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q2, section_id: SEZ_A, stato: 'chiuso' }]
    const res = await patch({ id: Q1, dataFine: '2027-01-30' })
    expect(res.status).toBe(200)
  })

  it('le date cambiano con lo scrutinio APERTO → 200 e ricalcolo per la sede', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q1, section_id: SEZ_A, stato: 'aperto' }]
    const res = await patch({ id: Q1, dataFine: '2027-01-30' })
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.ricalcolo).toBe('fatto')
    expect(h.db.scrutinio_periodi.find((p) => p.id === Q1)!.data_fine).toBe('2027-01-30')
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith({ p_scuola_id: SEDE_A })
  })

  it('una data non canonica nel corpo → 400 di validazione, nessun update', async () => {
    for (const corpo of [{ dataInizio: '2027-6-1' }, { dataFine: '2027-06-30T00:00:00Z' }, { dataFine: '2027-02-30' }]) {
      const res = await patch({ id: Q2, ...corpo })
      expect(res.status).toBe(400)
    }
    expect(scritte('update')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un campo data vuoto («») toglie la data: ne resta una sola → 422 PERIODO_DATE_INCOMPLETE', async () => {
    const res = await patch({ id: Q1, dataFine: '' })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODO_DATE_INCOMPLETE')
    expect(scritte('update')).toHaveLength(0)
  })

  it('spostare le date sopra un periodo di un ALTRO anno della stessa sede → 422 PERIODI_SOVRAPPOSTI', async () => {
    h.db.scrutinio_periodi.push(periodo('55555555-1111-4111-8111-aaaaaaaaaa09', SEDE_A, 1, '2025-09-01', '2026-01-31', {
      anno_scolastico: '2025/2026',
    }))
    const res = await patch({ id: Q1, dataInizio: '2026-01-15' })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODI_SOVRAPPOSTI')
    expect(scritte('update')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un periodo di un altro anno che non tocca le nuove date non blocca lo spostamento → 200', async () => {
    h.db.scrutinio_periodi.push(periodo('55555555-1111-4111-8111-aaaaaaaaaa09', SEDE_A, 1, '2025-09-01', '2026-01-31', {
      anno_scolastico: '2025/2026',
    }))
    const res = await patch({ id: Q1, dataInizio: '2026-09-10' })
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('fatto')
  })

  it('spostare le date NON si sovrappone a sé stesso → 200', async () => {
    const res = await patch({ id: Q1, dataInizio: '2026-09-10', dataFine: '2027-01-31' })
    expect(res.status).toBe(200)
  })

  it('un ricalcolo fallito non annulla lo spostamento: 200 con «non-riuscito»', async () => {
    h.rpc.mockImplementation(() => ({ data: null, error: { code: 'XX000', message: 'esplosa' } }))
    const res = await patch({ id: Q1, dataFine: '2027-01-30' })
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-riuscito')
    expect(h.db.scrutinio_periodi.find((p) => p.id === Q1)!.data_fine).toBe('2027-01-30')
  })

  it('togliere una data sola (restano due date incomplete dopo l’unione) → 422 PERIODO_DATE_INCOMPLETE', async () => {
    const res = await patch({ id: Q1, dataFine: null })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODO_DATE_INCOMPLETE')
    expect(scritte('update')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(rifiuti('PERIODO_DATE_INCOMPLETE')).toEqual([
      expect.objectContaining({ operazione: OP('PATCH'), scuola_id: SEDE_A }),
    ])
  })

  it('mettere la fine prima dell’inizio unito alla riga → 400 PERIODO_ROVESCIATO', async () => {
    const res = await patch({ id: Q1, dataFine: '2026-08-31' })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('PERIODO_ROVESCIATO')
    expect(scritte('update')).toHaveLength(0)
  })

  it('spostare le date sopra un altro periodo → 422 PERIODI_SOVRAPPOSTI, nessun update', async () => {
    const res = await patch({ id: Q2, dataInizio: '2027-01-15' })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('PERIODI_SOVRAPPOSTI')
    expect(scritte('update')).toHaveLength(0)
    expect(h.db.scrutinio_periodi.find((p) => p.id === Q2)!.data_inizio).toBe('2027-02-01')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(rifiuti('PERIODI_SOVRAPPOSTI')).toEqual([
      expect.objectContaining({ operazione: OP('PATCH'), scuola_id: SEDE_A }),
    ])
  })

  it('un periodo di un’altra sede è 404 e non si tocca niente', async () => {
    // L'admin non ha il ponte verso la sede B: il suo periodo non è in scope.
    h.db.scrutinio_periodi.push(periodo(Q_B, SEDE_B, 1, '2026-09-01', '2027-01-31'))
    const res = await patch({ id: Q_B, dataFine: '2027-01-30' })
    expect(res.status).toBe(404)
    expect(scritte('update')).toHaveLength(0)
    expect(h.db.scrutinio_periodi.find((p) => p.id === Q_B)!.data_fine).toBe('2027-01-31')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un id che non esiste è 404', async () => {
    const res = await patch({ id: '55555555-9999-4999-8999-999999999999', nome: 'X' })
    expect(res.status).toBe(404)
  })

  it('rinominare un periodo rimasto con una data sola (dati vecchi) non è bloccato: il corpo non tocca le date', async () => {
    const VECCHIO = '55555555-1111-4111-8111-aaaaaaaaaa03'
    h.db.scrutinio_periodi.push(periodo(VECCHIO, SEDE_A, 3, '2027-07-01', null))
    const res = await patch({ id: VECCHIO, nome: 'Estate' })
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('cambiare solo «attivo» non sposta niente: nessun ricalcolo', async () => {
    const res = await patch({ id: Q1, attivo: false })
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('lettura del periodo fallita → 500 LETTURA_FALLITA, nessun update', async () => {
    h.errori = { 'scrutinio_periodi:select': { code: '57014', message: 'canceling statement' } }
    const res = await patch({ id: Q1, dataFine: '2027-01-30' })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(scritte('update')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('lettura degli scrutini fallita → 500 LETTURA_FALLITA: non si sa se è chiuso, nessun update', async () => {
    h.errori = { 'scrutini:select': { code: '57014', message: 'canceling statement' } }
    const res = await patch({ id: Q1, dataFine: '2027-01-30' })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(scritte('update')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

// =============================================================================
describe('DELETE · un periodo con le date', () => {
  it('con le date → eliminato e ricalcolo per la sede', async () => {
    const res = await elimina(Q2)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    expect(corpo.ricalcolo).toBe('fatto')
    expect(h.db.scrutinio_periodi.map((p) => p.id)).not.toContain(Q2)
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith({ p_scuola_id: SEDE_A })
  })

  it('senza date → eliminato, nessun ricalcolo', async () => {
    h.db.scrutinio_periodi.push(periodo('55555555-1111-4111-8111-aaaaaaaaaa03', SEDE_A, 3, null, null))
    const res = await elimina('55555555-1111-4111-8111-aaaaaaaaaa03')
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('con una data sola non copre niente: nessun ricalcolo', async () => {
    h.db.scrutinio_periodi.push(periodo('55555555-1111-4111-8111-aaaaaaaaaa03', SEDE_A, 3, '2027-07-01', null))
    const res = await elimina('55555555-1111-4111-8111-aaaaaaaaaa03')
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-necessario')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un ricalcolo fallito non annulla l’eliminazione: 200 con «non-riuscito»', async () => {
    h.rpc.mockImplementation(() => ({ data: null, error: { code: 'XX000', message: 'esplosa' } }))
    const res = await elimina(Q2)
    expect(res.status).toBe(200)
    expect((await res.json()).ricalcolo).toBe('non-riuscito')
    expect(h.db.scrutinio_periodi.map((p) => p.id)).not.toContain(Q2)
  })

  it('un periodo con scrutini resta 409 e NON si ricalcola niente', async () => {
    h.db.scrutini = [{ id: 'sc1', periodo_id: Q2, section_id: SEZ_A, stato: 'chiuso' }]
    const res = await elimina(Q2)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('PERIODO_CON_SCRUTINI')
    expect(scritte('delete')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('lettura del periodo fallita → 500 LETTURA_FALLITA, niente eliminato', async () => {
    h.errori = { 'scrutinio_periodi:select': { code: '57014', message: 'canceling statement' } }
    const res = await elimina(Q2)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(scritte('delete')).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

// =============================================================================
describe('GET · il promemoria delle date mancanti', () => {
  const dateMancanti = async (query: string) => (await (await get(query)).json()).dateMancanti

  it('nessun periodo per quella sede e quell’anno → true', async () => {
    h.db.scrutinio_periodi = []
    expect(await dateMancanti(`?scuolaId=${SEDE_A}&annoScolastico=${ANNO}`)).toBe(true)
  })

  it('i due quadrimestri con entrambe le date → false', async () => {
    expect(await dateMancanti(`?scuolaId=${SEDE_A}&annoScolastico=${ANNO}`)).toBe(false)
  })

  it('il secondo senza data di fine → true', async () => {
    h.db.scrutinio_periodi = [
      periodo(Q1, SEDE_A, 1, '2026-09-01', '2027-01-31'),
      periodo(Q2, SEDE_A, 2, '2027-02-01', null),
    ]
    expect(await dateMancanti(`?scuolaId=${SEDE_A}&annoScolastico=${ANNO}`)).toBe(true)
  })

  it('i periodi di un’altra sede non coprono questa: true', async () => {
    h.db.scrutinio_periodi = [periodo(Q_B, SEDE_B, 1, '2026-09-01', '2027-01-31')]
    expect(await dateMancanti(`?scuolaId=${SEDE_A}&annoScolastico=${ANNO}`)).toBe(true)
  })

  it('senza scuolaId (o senza anno) il promemoria non si calcola: null', async () => {
    expect(await dateMancanti(`?annoScolastico=${ANNO}`)).toBeNull()
    expect(await dateMancanti(`?scuolaId=${SEDE_A}`)).toBeNull()
    expect(await dateMancanti('')).toBeNull()
  })

  it('una sede non accessibile: elenco vuoto e nessun promemoria (null), non «mancano le date»', async () => {
    const res = await get(`?scuolaId=${SEDE_B}&annoScolastico=${ANNO}`)
    const corpo = await res.json()
    expect(corpo.data).toEqual([])
    expect(corpo.dateMancanti).toBeNull()
  })

  it('la risposta porta ancora l’elenco, com’era', async () => {
    const corpo = await (await get(`?scuolaId=${SEDE_A}&annoScolastico=${ANNO}`)).json()
    expect(corpo.success).toBe(true)
    expect(corpo.data.map((p: { id: string }) => p.id)).toEqual([Q1, Q2])
  })
})
