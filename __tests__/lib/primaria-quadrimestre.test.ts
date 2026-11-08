import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type RispostaRpc } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// IL QUADRIMESTRE DI UNA DATA, LETTO DAL DATABASE, E SE IL SUO SCRUTINIO È CHIUSO.
//
// Il finto client filtra DAVVERO (`creaFintoSupabase`): «chiuso per la classe A,
// non per la B» è verificato sulle righe, non asserito da un mock che risponde
// sempre la stessa cosa. Il log "date mancanti" si spegne per sede e per giorno:
// ogni test che lo guarda usa una sede diversa, perché la memoria del modulo non
// si azzera (e non deve poterlo fare).
// =============================================================================

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

import {
  chiusoIn,
  chiusureIn,
  leggiPeriodi,
  leggiQuadrimestri,
  ricalcolaPeriodiSede,
  statoQuadrimestre,
} from '@/lib/primaria/quadrimestre'
import { COLONNE_PERIODO } from '@/lib/primaria/periodo'

const SEZ_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const SEZ_X = 'cccc3333-0000-4000-8000-0000000000c3'
const Q1_A = '9e710001-0000-4000-8000-0000000000a1'
const Q2_A = '9e710002-0000-4000-8000-0000000000a2'
const Q1BIS_A = '9e710003-0000-4000-8000-0000000000a3'
const Q1_B = '9e710001-0000-4000-8000-0000000000b1'
const SEDE_SENZA_PERIODI_1 = 'dddd0001-0000-4000-8000-000000000001'
const SEDE_SENZA_PERIODI_2 = 'dddd0002-0000-4000-8000-000000000002'
const SEDE_SENZA_PERIODI_3 = 'dddd0003-0000-4000-8000-000000000003'

function periodo(extra: Record<string, unknown>) {
  return {
    scuola_id: SEDE_A,
    anno_scolastico: '2026/2027',
    nome: 'Quadrimestre',
    attivo: true,
    ...extra,
  }
}

const P_Q1_A = periodo({ id: Q1_A, ordine: 1, data_inizio: '2026-09-01', data_fine: '2027-01-31' })
const P_Q2_A = periodo({ id: Q2_A, ordine: 2, data_inizio: '2027-02-01', data_fine: '2027-06-30' })
const P_Q1_B = periodo({ id: Q1_B, scuola_id: SEDE_B, ordine: 1, data_inizio: '2026-09-01', data_fine: '2027-01-31' })

let db: DBFinto
let tabelle: string[]
let opzioni: OpzioniFinto

function client() {
  return creaFintoSupabase(db, tabelle, opzioni)
}

beforeEach(() => {
  h.logEvento.mockClear()
  tabelle = []
  opzioni = {}
  db = {
    scrutinio_periodi: [P_Q1_A, P_Q2_A, P_Q1_B],
    scrutini: [
      { section_id: SEZ_A, periodo_id: Q1_A, stato: 'chiuso' },
      { section_id: SEZ_B, periodo_id: Q1_A, stato: 'aperto' },
    ],
  }
})

const logDa = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

describe('leggiPeriodi', () => {
  it('legge i periodi delle sole sedi chieste', async () => {
    const r = await leggiPeriodi(client(), [SEDE_A])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.periodi.map((p) => p.id).sort()).toEqual([Q1_A, Q2_A].sort())
    expect(COLONNE_PERIODO).toContain('scuola_id')
  })

  it('senza sedi non legge niente', async () => {
    const r = await leggiPeriodi(client(), [])
    expect(r).toEqual({ ok: true, periodi: [] })
    expect(tabelle).toEqual([])
  })

  it('un guasto restituisce l’errore, senza logarlo: il log lo scrive chi sa a cosa serve la lettura', async () => {
    opzioni = { errori: { 'scrutinio_periodi:select': { code: '57014' } } }
    const r = await leggiPeriodi(client(), [SEDE_A])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ code: '57014' })
    expect(h.logEvento).not.toHaveBeenCalled()
  })
})

describe('chiusoIn', () => {
  it('chiuso per la classe dello scrutinio, non per le altre; scrutini letti una volta', async () => {
    const r = await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A, SEZ_B] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(chiusoIn(r.letti, SEDE_A, SEZ_A, '2026-10-01')).toBe(true)
    expect(chiusoIn(r.letti, SEDE_A, SEZ_B, '2026-10-01')).toBe(false) // scrutinio aperto
    expect(chiusoIn(r.letti, SEDE_A, SEZ_A, '2027-07-15')).toBe(false) // nessun periodo copre quel giorno
    expect(chiusoIn(r.letti, SEDE_A, SEZ_A, '2027-03-10')).toBe(false) // il Q2 non è chiuso
    expect(tabelle.filter((t) => t === 'scrutini')).toHaveLength(1)
    expect(tabelle.filter((t) => t === 'scrutinio_periodi')).toHaveLength(1)
  })

  it('degli scrutini entrano solo le classi chieste e i periodi delle sedi chieste', async () => {
    db.scrutini.push(
      { section_id: SEZ_X, periodo_id: Q1_A, stato: 'chiuso' }, // un’altra classe
      { section_id: SEZ_A, periodo_id: Q1_B, stato: 'chiuso' }, // il periodo di un’altra sede
    )
    const r = await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A, SEZ_B] })
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.letti.chiusi]).toEqual([`${SEZ_A}:${Q1_A}`])
  })

  it('nessun periodo con le date: gli scrutini non si leggono', async () => {
    db.scrutinio_periodi = [periodo({ id: Q1_A, ordine: 1, data_inizio: '2026-09-01', data_fine: null })]
    const r = await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A] })
    expect(r.ok).toBe(true)
    expect(tabelle).not.toContain('scrutini')
    if (r.ok) expect(chiusoIn(r.letti, SEDE_A, SEZ_A, '2026-10-01')).toBe(false)
  })

  it('senza sedi non legge niente', async () => {
    const r = await leggiQuadrimestri(client(), { scuolaIds: [], sectionIds: [SEZ_A] })
    expect(r.ok).toBe(true)
    expect(tabelle).toEqual([])
  })

  it('due periodi sovrapposti, uno chiuso: chiuso (D14)', async () => {
    db.scrutinio_periodi = [
      P_Q1_A,
      periodo({ id: Q1BIS_A, ordine: 0, data_inizio: '2027-01-15', data_fine: '2027-03-01' }),
    ]
    // Il 20/01 lo coprono entrambi e vince (periodoId) il BIS, che è aperto; lo scrutinio chiuso è
    // quello del periodo che PERDE lo spareggio. Basta uno solo dei coprenti perché la data sia congelata.
    db.scrutini = [{ section_id: SEZ_A, periodo_id: Q1_A, stato: 'chiuso' }]
    const r = await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(chiusoIn(r.letti, SEDE_A, SEZ_A, '2027-01-20')).toBe(true)
    expect(chiusoIn(r.letti, SEDE_A, SEZ_A, '2027-02-20')).toBe(false) // qui copre solo il periodo aperto
  })

  it('chiusureIn: quando ogni scrutinio chiuso che copre la data è stato chiuso (null se la riga non lo dice)', async () => {
    db.scrutinio_periodi = [
      P_Q1_A,
      periodo({ id: Q1BIS_A, ordine: 0, data_inizio: '2027-01-15', data_fine: '2027-03-01' }),
    ]
    db.scrutini = [
      { section_id: SEZ_A, periodo_id: Q1_A, stato: 'chiuso', chiuso_il: '2027-02-05T08:00:00Z' },
      { section_id: SEZ_A, periodo_id: Q1BIS_A, stato: 'chiuso' }, // chiuso senza data
      { section_id: SEZ_B, periodo_id: Q1_A, stato: 'aperto', chiuso_il: null },
    ]
    const r = await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A, SEZ_B] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(chiusureIn(r.letti, SEDE_A, SEZ_A, '2026-10-01')).toEqual(['2027-02-05T08:00:00Z']) // solo Q1
    expect(chiusureIn(r.letti, SEDE_A, SEZ_A, '2027-01-20')).toHaveLength(2) // Q1 e il suo bis
    expect(chiusureIn(r.letti, SEDE_A, SEZ_A, '2027-01-20')).toEqual(expect.arrayContaining([null, '2027-02-05T08:00:00Z']))
    expect(chiusureIn(r.letti, SEDE_A, SEZ_A, '2027-02-20')).toEqual([null]) // solo il bis
    expect(chiusureIn(r.letti, SEDE_A, SEZ_B, '2026-10-01')).toEqual([]) // lo scrutinio della 2B è aperto
    expect(chiusureIn(r.letti, SEDE_A, SEZ_A, '2027-07-15')).toEqual([]) // nessun periodo copre quel giorno
    expect(chiusureIn(r.letti, null, SEZ_A, '2026-10-01')).toEqual([])
  })

  it('la chiusura vale per la sede della classe: una sede senza periodi, o scuolaId null, non è chiusa', async () => {
    const r = await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A, SEDE_B], sectionIds: [SEZ_A] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(chiusoIn(r.letti, SEDE_B, SEZ_A, '2026-10-01')).toBe(false) // il Q1 chiuso è della SEDE_A
    expect(chiusoIn(r.letti, SEDE_C, SEZ_A, '2026-10-01')).toBe(false)
    expect(chiusoIn(r.letti, null, SEZ_A, '2026-10-01')).toBe(false)
  })

  it('un guasto su scrutinio_periodi o su scrutini: { ok: false } e log error', async () => {
    opzioni = { errori: { 'scrutinio_periodi:select': { code: '57014' } } }
    expect(await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A] })).toEqual({ ok: false })
    expect(logDa('periodi-non-letti')).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      { operazione: 'primaria/quadrimestre', esito: 'periodi-non-letti' },
      expect.objectContaining({ code: '57014' }),
    )

    h.logEvento.mockClear()
    opzioni = { errori: { 'scrutini:select': { code: '57014' } } }
    expect(await leggiQuadrimestri(client(), { scuolaIds: [SEDE_A], sectionIds: [SEZ_A] })).toEqual({ ok: false })
    expect(logDa('scrutini-non-letti')).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      { operazione: 'primaria/quadrimestre', esito: 'scrutini-non-letti' },
      expect.objectContaining({ code: '57014' }),
    )
  })
})

describe('statoQuadrimestre', () => {
  it('periodo e chiusura', async () => {
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_A, '2026-10-01')).toEqual({
      ok: true,
      periodoId: Q1_A,
      chiuso: true,
      dateMancanti: false,
    })
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_B, '2026-10-01')).toEqual({
      ok: true,
      periodoId: Q1_A,
      chiuso: false,
      dateMancanti: false,
    })
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_A, '2027-03-10')).toEqual({
      ok: true,
      periodoId: Q2_A,
      chiuso: false,
      dateMancanti: false,
    })
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('fuori da ogni periodo, con le date tutte impostate: nessun periodo, nessun log', async () => {
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_A, '2027-07-15')).toEqual({
      ok: true,
      periodoId: null,
      chiuso: false,
      dateMancanti: false,
    })
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  const logDateMancanti = (sede: string) =>
    h.logEvento.mock.calls.filter(
      (c) =>
        c[0] === 'config' &&
        c[1] === 'error' &&
        (c[2] as { esito?: string; scuola_id?: string }).esito === 'date-quadrimestre-mancanti' &&
        (c[2] as { scuola_id?: string }).scuola_id === sede,
    )

  it('l’anno dei periodi segue il calendario della sede: il 15 luglio, se la sede ha già aperto il 2027/28 in marzo, mancano le date', async () => {
    const riga = (id: string, annoInizio: number, inizio: string, fine: string) => ({
      id,
      scuola_id: SEDE_A,
      anno_id: `anno-${annoInizio}`,
      inizio,
      fine,
      ultimo_giorno_aperto: fine,
      prepara_successivo_dal: inizio,
      stato: 'corrente',
      domande_aperte: false,
      anni_scolastici: { anno_inizio: annoInizio },
    })
    // Senza calendario il 15 luglio è del 2026/2027, configurato: nessun periodo lo copre ma non è un guasto.
    db.anni_sede = []
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_A, '2027-07-15')).toMatchObject({ dateMancanti: false })
    // Con il calendario che apre il 2027/28 il 1° marzo 2027 lo stesso giorno è del 2027/2028, senza periodi.
    db.anni_sede = [
      riga('as-26', 2026, '2026-09-01', '2027-02-28'),
      riga('as-27', 2027, '2027-03-01', '2028-08-31'),
    ]
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_A, '2027-07-15')).toMatchObject({ dateMancanti: true })
  })

  it('date mancanti: un solo log error al giorno per sede', async () => {
    const c = client()
    const adesso = new Date('2026-11-04T10:00:00Z')
    const r = await statoQuadrimestre(c, SEDE_SENZA_PERIODI_1, SEZ_X, '2026-11-04', adesso)
    expect(r).toEqual({ ok: true, periodoId: null, chiuso: false, dateMancanti: true })
    await statoQuadrimestre(c, SEDE_SENZA_PERIODI_1, SEZ_X, '2026-10-01', adesso)
    expect(logDateMancanti(SEDE_SENZA_PERIODI_1)).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith('config', 'error', {
      operazione: 'primaria/periodo',
      esito: 'date-quadrimestre-mancanti',
      scuola_id: SEDE_SENZA_PERIODI_1,
      data: '2026-11-04',
    })
    await statoQuadrimestre(c, SEDE_SENZA_PERIODI_1, SEZ_X, '2026-11-05', new Date('2026-11-05T08:00:00Z'))
    expect(logDateMancanti(SEDE_SENZA_PERIODI_1)).toHaveLength(2)
  })

  it('il giorno del log è quello di Roma: alle 23:30 UTC è già il giorno dopo', async () => {
    const c = client()
    await statoQuadrimestre(c, SEDE_SENZA_PERIODI_2, SEZ_X, '2026-11-04', new Date('2026-11-04T22:30:00Z')) // 4/11 a Roma
    await statoQuadrimestre(c, SEDE_SENZA_PERIODI_2, SEZ_X, '2026-11-04', new Date('2026-11-04T23:30:00Z')) // già 5/11 a Roma
    expect(logDateMancanti(SEDE_SENZA_PERIODI_2)).toHaveLength(2)
  })

  it('la memoria del log è per sede: un’altra sede senza periodi loga per conto suo', async () => {
    const c = client()
    const adesso = new Date('2026-11-04T10:00:00Z')
    await statoQuadrimestre(c, SEDE_SENZA_PERIODI_3, SEZ_X, '2026-11-04', adesso)
    await statoQuadrimestre(c, SEDE_C, SEZ_X, '2026-11-04', adesso)
    expect(logDateMancanti(SEDE_SENZA_PERIODI_3)).toHaveLength(1)
    expect(logDateMancanti(SEDE_C)).toHaveLength(1)
  })

  it('scuolaId null: nessuna lettura, nessun log', async () => {
    expect(await statoQuadrimestre(client(), null, SEZ_A, '2026-10-01')).toEqual({
      ok: true,
      periodoId: null,
      chiuso: false,
      dateMancanti: false,
    })
    expect(tabelle).toEqual([])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('un guasto di lettura: { ok: false }, mai un “non chiuso” inventato', async () => {
    opzioni = { errori: { 'scrutini:select': { code: '57014' } } }
    expect(await statoQuadrimestre(client(), SEDE_A, SEZ_A, '2026-10-01')).toEqual({ ok: false })
    expect(logDa('scrutini-non-letti')).toHaveLength(1)
  })
})

describe('ricalcolaPeriodiSede', () => {
  const rpcCon = (r: RispostaRpc | (() => RispostaRpc)): OpzioniFinto => ({
    rpc: { primaria_ricalcola_periodi: (args) => {
      chiamate.push(args)
      return typeof r === 'function' ? r() : r
    } },
  })
  let chiamate: Record<string, unknown>[]
  beforeEach(() => {
    chiamate = []
  })

  it('riuscito: true e info con i conteggi', async () => {
    opzioni = rpcCon({ data: { valutazioni: 3, impreparati: 1 }, error: null })
    expect(await ricalcolaPeriodiSede(client(), SEDE_A, 'admin/periodi:PATCH')).toBe(true)
    expect(chiamate).toEqual([{ p_scuola_id: SEDE_A }])
    expect(h.logEvento).toHaveBeenCalledWith('registro', 'info', {
      operazione: 'admin/periodi:PATCH',
      esito: 'periodi-ricalcolati',
      scuola_id: SEDE_A,
      n_valutazioni: 3,
      n_impreparati: 1,
    })
  })

  it('funzione non ancora migrata (PGRST202 o 42883): false e info, non un errore', async () => {
    for (const code of ['PGRST202', '42883']) {
      h.logEvento.mockClear()
      opzioni = rpcCon({ data: null, error: { code } })
      expect(await ricalcolaPeriodiSede(client(), SEDE_A, 'admin/periodi:PATCH')).toBe(false)
      expect(h.logEvento).toHaveBeenCalledTimes(1)
      expect(h.logEvento).toHaveBeenCalledWith('registro', 'info', {
        operazione: 'admin/periodi:PATCH',
        esito: 'ricalcolo-non-disponibile-schema',
        scuola_id: SEDE_A,
      })
    }
  })

  it('un altro errore: false e log error', async () => {
    const errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    opzioni = rpcCon({ data: null, error: errore })
    expect(await ricalcolaPeriodiSede(client(), SEDE_A, 'admin/periodi:PATCH')).toBe(false)
    expect(h.logEvento).toHaveBeenCalledTimes(1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      { operazione: 'admin/periodi:PATCH', esito: 'ricalcolo-periodi-non-riuscito', scuola_id: SEDE_A },
      errore,
    )
  })

  it('un’eccezione: false e log error, mai propagata', async () => {
    const boom = new Error('rete caduta')
    opzioni = rpcCon(() => {
      throw boom
    })
    expect(await ricalcolaPeriodiSede(client(), SEDE_A, 'admin/periodi:PATCH')).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      { operazione: 'admin/periodi:PATCH', esito: 'ricalcolo-periodi-non-riuscito', scuola_id: SEDE_A },
      boom,
    )
  })

  it('una risposta senza conteggi conta zero', async () => {
    opzioni = rpcCon({ data: null, error: null })
    expect(await ricalcolaPeriodiSede(client(), SEDE_A, 'admin/periodi:PATCH')).toBe(true)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'periodi-ricalcolati', n_valutazioni: 0, n_impreparati: 0 }),
    )
  })
})
