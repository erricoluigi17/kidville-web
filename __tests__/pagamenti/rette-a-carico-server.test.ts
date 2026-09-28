import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})

import { caricaLegamiRetta } from '@/lib/pagamenti/rette-a-carico-server'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

const OP = 'test:GET'
const alunno = (id: string, extra: Record<string, unknown>) => ({
  id, nome: `N${id}`, cognome: `C${id}`, classe_sezione: `Sez ${id}`, section_id: `sez-${id}`,
  scuola_id: 's1', stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})

let db: DBFinto
const client = (errori: Record<string, ErrorePostgrest> = {}) =>
  creaFintoSupabase(db, [], { errori }) as unknown as SupabaseClient

beforeEach(() => {
  h.logEvento.mockClear()
  db = {
    alunni: [
      alunno('pag', {}),                                              // paga per «fig»
      alunno('fig', { retta_a_carico_di: 'pag', gender: 'F' }),
      alunno('rit', { retta_a_carico_di: 'pag', stato: 'ritirato' }), // non iscritto: escluso
      alunno('alt', { retta_a_carico_di: 'pag', scuola_id: 's9' }),   // sede fuori: escluso
      alunno('ex', { stato: 'ritirato', gender: 'F' }),               // pagante uscito
      alunno('orf', { retta_a_carico_di: 'ex' }),
      alunno('lon', { scuola_id: 's3' }),                             // pagante in sede NON accessibile
      alunno('nas', { retta_a_carico_di: 'lon' }),
    ],
  }
})

describe('caricaLegamiRetta', () => {
  it('legge i legami degli iscritti delle sedi, con il pagante', async () => {
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1', 's2'], operazione: OP })
    expect(e.ok).toBe(true)
    if (!e.ok) return
    const perAlunno = Object.fromEntries(e.legami.map((l) => [l.alunno_id, l]))
    expect(Object.keys(perAlunno).sort()).toEqual(['fig', 'orf'])
    expect(perAlunno.fig).toEqual({
      alunno_id: 'fig', scuola_id: 's1',
      alunno: { nome: 'Nfig', cognome: 'Cfig', classe_sezione: 'Sez fig', section_id: 'sez-fig' },
      pagante: { id: 'pag', nome: 'Npag', cognome: 'Cpag', sesso: 'M', classe_sezione: 'Sez pag', iscritto: true, scuola_id: 's1' },
    })
    expect(perAlunno.orf.pagante).toMatchObject({ id: 'ex', iscritto: false, sesso: 'F' })
  })

  it('pagante in una sede non accessibile: il legame si scarta e si conta in un warn', async () => {
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.map((l) => l.alunno_id).sort()).toEqual(['fig', 'orf'])
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'warn', expect.objectContaining({ operazione: OP, esito: 'legami-pagante-non-leggibile', n: 1 }))
  })

  it('un pagante archiviato non è iscritto anche se lo stato dice iscritto', async () => {
    db.alunni.find((a) => a.id === 'pag')!.archiviato_il = '2026-09-01T00:00:00Z'
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.find((l) => l.alunno_id === 'fig')?.pagante.iscritto).toBe(false)
  })

  it('nessuna sede: zero legami senza toccare il database', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '57014' } }), { sediBambini: [], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: true, legami: [] })
  })

  // Il messaggio è quello che Postgres scrive davvero (PostgREST lo passa tale e quale).
  const COLONNA_LEGAME_ASSENTE = { code: '42703', message: 'column alunni.retta_a_carico_di does not exist' }

  it('DB non migrato (42703 su retta_a_carico_di): zero legami, log info, NON un guasto', async () => {
    const e = await caricaLegamiRetta(client({ alunni: COLONNA_LEGAME_ASSENTE }), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: true, legami: [] })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'legami-colonna-assente' }), expect.anything())
    expect(h.logEvento).not.toHaveBeenCalledWith('pagamento', 'error', expect.anything(), expect.anything())
  })

  // C5 (revisione 2026-09-28): un 42703 su UN'ALTRA colonna non è «DB non migrato per questa
  // funzione», è un guasto — e degradarlo a «zero legami» lo avrebbe nascosto a livello info.
  it('42703 su un’altra colonna: ok=false e log error, mai «zero legami»', async () => {
    const e = await caricaLegamiRetta(
      client({ alunni: { code: '42703', message: 'column alunni.section_id does not exist' } }),
      { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP },
    )
    expect(e).toEqual({ ok: false })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-bambini-non-letti' }), expect.anything())
    expect(h.logEvento).not.toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'legami-colonna-assente' }), expect.anything())
  })

  it('42703 senza messaggio: non si indovina la colonna, è un guasto', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '42703' } }), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: false })
  })

  it('guasto di lettura: ok=false e log error (PostgREST non lancia)', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '57014' } }), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: false })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-bambini-non-letti' }), expect.anything())
  })
})

describe('caricaLegamiRetta — la seconda query (paganti)', () => {
  /** Client a copione: la N-esima `from()` risolve con la N-esima risposta, e registra select e filtri. */
  function copione(risposte: { data: unknown; error: unknown }[]) {
    const chiamate: { select: string; filtri: unknown[][] }[] = []
    const client = {
      from: () => {
        const c = { select: '', filtri: [] as unknown[][] }
        chiamate.push(c)
        const indice = chiamate.length - 1
        const b: Record<string, unknown> = {}
        for (const m of ['eq', 'in', 'not']) b[m] = (...a: unknown[]) => { c.filtri.push([m, ...a]); return b }
        b.select = (s: string) => { c.select = s; return b }
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risposte[indice]).then(ok, ko)
        return b
      },
    } as unknown as SupabaseClient
    return { client, chiamate }
  }
  const BAMBINO = { id: 'b', nome: 'B', cognome: 'X', classe_sezione: null, section_id: null, scuola_id: 's1', retta_a_carico_di: 'p' }
  const PAGANTE_BASE = { id: 'p', nome: 'P', cognome: 'X', classe_sezione: null, stato: 'iscritto', scuola_id: 's1' }

  it('42703 sui paganti: riprova senza gender e archiviato_il', async () => {
    const { client, chiamate } = copione([
      { data: [BAMBINO], error: null },
      { data: null, error: { code: '42703', message: 'column alunni.gender does not exist' } },
      { data: [PAGANTE_BASE], error: null },
    ])
    const e = await caricaLegamiRetta(client, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami[0].pagante).toEqual({ id: 'p', nome: 'P', cognome: 'X', sesso: null, classe_sezione: null, iscritto: true, scuola_id: 's1' })
    expect(chiamate[1].select).toContain('gender')
    expect(chiamate[2].select).not.toContain('gender')
    expect(chiamate[2].select).not.toContain('archiviato_il')
    // Le due letture dei paganti restano ristrette per id E per sede.
    for (const c of [chiamate[1], chiamate[2]]) {
      expect(c.filtri).toContainEqual(['in', 'id', ['p']])
      expect(c.filtri).toContainEqual(['in', 'scuola_id', ['s1']])
    }
  })

  it('altro errore sui paganti: ok=false e log error', async () => {
    const { client } = copione([
      { data: [BAMBINO], error: null },
      { data: null, error: { code: '57014', message: 'timeout' } },
    ])
    expect(await caricaLegamiRetta(client, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })).toEqual({ ok: false })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-paganti-non-letti' }), expect.anything())
  })

  it('la prima query filtra iscritti, sedi e legame valorizzato', async () => {
    const { client, chiamate } = copione([{ data: [], error: null }])
    await caricaLegamiRetta(client, { sediBambini: ['s1', 's2'], sediPaganti: ['s1'], operazione: OP })
    expect(chiamate[0].filtri).toEqual(expect.arrayContaining([
      ['eq', 'stato', 'iscritto'], ['in', 'scuola_id', ['s1', 's2']], ['not', 'retta_a_carico_di', 'is', null],
    ]))
    expect(chiamate).toHaveLength(1)
  })
})
