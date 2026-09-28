import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})

import { caricaLegamiRetta, sediDeiPaganti } from '@/lib/pagamenti/rette-a-carico-server'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { ID_PER_QUERY } from '@/lib/db/blocchi'

// K4 (seconda revisione 2026-09-28): le sedi dei paganti = sedi dei bambini ∪ accessibili.
describe('sediDeiPaganti', () => {
  it('l’unione, senza doppioni, nell’ordine: prima le sedi dei bambini', () => {
    expect(sediDeiPaganti(['s1'], ['s1', 's2'])).toEqual(['s1', 's2'])
    expect(sediDeiPaganti(['s1', 's2'], ['s3'])).toEqual(['s1', 's2', 's3'])
  })
  it('accessibili vuote (la seconda `scuoleDiUtente` fallita): restano le sedi dei bambini', () => {
    expect(sediDeiPaganti(['s1', 's2'], [])).toEqual(['s1', 's2'])
  })
  it('lo stesso uuid scritto in maiuscolo non è un doppione (in Postgres è lo stesso valore)', () => {
    expect(sediDeiPaganti(['aaaa-bbbb'], ['AAAA-BBBB', 's2'])).toEqual(['aaaa-bbbb', 's2'])
  })
})

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
    // «nas» paga «lon», che sta in s3: fuori da sediPaganti.
    expect(e.nonVisibili).toEqual([{ alunno_id: 'nas', scuola_id: 's1' }])
  })

  // C3 (revisione 2026-09-28): scartare il legame faceva tornare il bambino «Non generata» e
  // «mancante» PER SEMPRE — la generazione lo salta comunque. Il pagante resta nascosto, ma
  // il bambino (che è nella sede dell'utente) si sa che è a carico di qualcuno.
  it('pagante in una sede non accessibile: niente dati del pagante, ma il bambino è fra i nonVisibili (e un warn lo conta)', async () => {
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.map((l) => l.alunno_id).sort()).toEqual(['fig', 'orf'])
    expect(e.ok && e.nonVisibili).toEqual([{ alunno_id: 'nas', scuola_id: 's1' }])
    expect(JSON.stringify(e)).not.toContain('Nlon')
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'warn', expect.objectContaining({ operazione: OP, esito: 'legami-pagante-non-leggibile', n: 1 }))
  })

  it('nessuna sede leggibile per i paganti: tutti i bambini a carico sono nonVisibili', async () => {
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: [], operazione: OP })
    expect(e.ok && e.legami).toEqual([])
    expect(e.ok && e.nonVisibili.map((b) => b.alunno_id).sort()).toEqual(['fig', 'nas', 'orf'])
  })

  it('un pagante archiviato non è iscritto anche se lo stato dice iscritto', async () => {
    db.alunni.find((a) => a.id === 'pag')!.archiviato_il = '2026-09-01T00:00:00Z'
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.find((l) => l.alunno_id === 'fig')?.pagante.iscritto).toBe(false)
  })

  // C6: un pagante SOSPESO è «ancora iscritto» per `stato.ts`, ma non è `iscritto`: l'avviso
  // si accende — ed è per questo che il testo dice «non risulta iscritto», non «non più».
  it('un pagante sospeso accende l’avviso (iscritto=false)', async () => {
    db.alunni.find((a) => a.id === 'pag')!.stato = 'sospeso'
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.find((l) => l.alunno_id === 'fig')?.pagante.iscritto).toBe(false)
  })

  it('nessuna sede: zero legami senza toccare il database', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '57014' } }), { sediBambini: [], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: true, legami: [], nonVisibili: [] })
  })

  // Il messaggio è quello che Postgres scrive davvero (PostgREST lo passa tale e quale).
  const COLONNA_LEGAME_ASSENTE = { code: '42703', message: 'column alunni.retta_a_carico_di does not exist' }

  it('DB non migrato (42703 su retta_a_carico_di): zero legami, log info, NON un guasto', async () => {
    const e = await caricaLegamiRetta(client({ alunni: COLONNA_LEGAME_ASSENTE }), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: true, legami: [], nonVisibili: [] })
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

  // R5 (terza revisione 2026-09-29): il ripiego scattava su QUALUNQUE 42703, e in silenzio. Come
  // per la prima query (C5), solo se il messaggio (o `details`) nomina una delle due colonne che
  // il ripiego toglie; e lo si dice con un log info. Ogni altro 42703 è un guasto.
  describe('R5 — il ripiego sul 42703 dei paganti è mirato, e parla', () => {
    const PAGANTI = { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP }
    const ripiego = (errore: Record<string, unknown>) => copione([
      { data: [BAMBINO], error: null },
      { data: null, error: errore },
      { data: [PAGANTE_BASE], error: null },
    ])

    it('gender nel messaggio: ripiego, e un log info che lo dice (niente error)', async () => {
      const { client, chiamate } = ripiego({ code: '42703', message: 'column alunni.gender does not exist' })
      expect((await caricaLegamiRetta(client, PAGANTI)).ok).toBe(true)
      expect(chiamate).toHaveLength(3)
      expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ operazione: OP, esito: 'legami-paganti-colonne-assenti' }), expect.anything())
      expect(h.logEvento.mock.calls.filter((c) => c[1] === 'error')).toEqual([])
    })

    it('archiviato_il nel messaggio: ripiego', async () => {
      const { client, chiamate } = ripiego({ code: '42703', message: 'column alunni.archiviato_il does not exist' })
      expect((await caricaLegamiRetta(client, PAGANTI)).ok).toBe(true)
      expect(chiamate).toHaveLength(3)
    })

    it('la colonna in `details` e non nel messaggio: ripiego', async () => {
      const { client, chiamate } = ripiego({ code: '42703', message: '', details: 'column "gender" does not exist' })
      expect((await caricaLegamiRetta(client, PAGANTI)).ok).toBe(true)
      expect(chiamate).toHaveLength(3)
    })

    it('42703 su un’ALTRA colonna: guasto (ok=false, error), nessun ripiego, nessun info', async () => {
      const { client, chiamate } = ripiego({ code: '42703', message: 'column alunni.classe_sezione does not exist' })
      expect(await caricaLegamiRetta(client, PAGANTI)).toEqual({ ok: false })
      expect(chiamate).toHaveLength(2)
      expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-paganti-non-letti' }), expect.anything())
      expect(h.logEvento).not.toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'legami-paganti-colonne-assenti' }), expect.anything())
    })

    it('42703 senza messaggio né details: non si indovina, è un guasto', async () => {
      const { client, chiamate } = ripiego({ code: '42703' })
      expect(await caricaLegamiRetta(client, PAGANTI)).toEqual({ ok: false })
      expect(chiamate).toHaveLength(2)
    })

    it('il ripiego che fallisce a sua volta: guasto (ok=false, error)', async () => {
      const { client } = copione([
        { data: [BAMBINO], error: null },
        { data: null, error: { code: '42703', message: 'column alunni.gender does not exist' } },
        { data: null, error: { code: '57014', message: 'timeout' } },
      ])
      expect(await caricaLegamiRetta(client, PAGANTI)).toEqual({ ok: false })
      expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-paganti-non-letti' }), expect.anything())
    })
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

// =============================================================================
// R8 (terza revisione 2026-09-29) — `.in('id', idPaganti)` passava la lista INTERA nell'URL: un
// pagante per famiglia, e oltre un centinaio la richiesta sfora il limite dei proxy (414,
// `@/lib/db/blocchi`). Ora a pezzi di `ID_PER_QUERY`, con l'errore di OGNI pezzo guardato.
// =============================================================================
describe('caricaLegamiRetta — gli id dei paganti a blocchi (R8)', () => {
  const N = 160
  const id = (p: string, i: number) => `${p}-${String(i).padStart(3, '0')}`

  it(`${N} paganti: ogni \`.in('id')\` sta nel blocco, e i legami ci sono TUTTI`, async () => {
    db = { alunni: [] }
    for (let i = 0; i < N; i++) db.alunni.push(alunno(id('p', i), {}), alunno(id('f', i), { retta_a_carico_di: id('p', i) }))
    const registro: { colonna: string; n: number }[] = []
    const c = client()
    const from = c.from.bind(c)
    Object.assign(c, {
      from: (t: string) => {
        const q = from(t) as unknown as Record<string, unknown>
        const inVero = q.in as (colonna: string, v: unknown[]) => unknown
        q.in = (colonna: string, v: unknown[]) => { registro.push({ colonna, n: v.length }); return inVero(colonna, v) }
        return q
      },
    })
    const e = await caricaLegamiRetta(c, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.length).toBe(N)
    expect(e.ok && e.nonVisibili).toEqual([])
    const perId = registro.filter((r) => r.colonna === 'id')
    expect(perId.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...perId.map((r) => r.n))).toBeLessThanOrEqual(ID_PER_QUERY)
    expect(perId.reduce((s, r) => s + r.n, 0)).toBe(N)
  })

  /** Client a copione (come sopra), con il `.in('id', …)` di ogni lettura registrato. */
  function copioneIn(risposte: { data: unknown; error: unknown }[]) {
    const chiamate: { select: string; ids: string[] | null }[] = []
    const client = {
      from: () => {
        const c = { select: '', ids: null as string[] | null }
        chiamate.push(c)
        const indice = chiamate.length - 1
        const b: Record<string, unknown> = {}
        for (const m of ['eq', 'not']) b[m] = () => b
        b.in = (col: string, v: string[]) => { if (col === 'id') c.ids = v; return b }
        b.select = (x: string) => { c.select = x; return b }
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risposte[indice]).then(ok, ko)
        return b
      },
    } as unknown as SupabaseClient
    return { client, chiamate }
  }
  const bambini = Array.from({ length: N }, (_, i) => ({
    id: id('f', i), nome: 'F', cognome: 'X', classe_sezione: null, section_id: null, scuola_id: 's1', retta_a_carico_di: id('p', i),
  }))
  const paganti = (da: number, a: number) => Array.from({ length: a - da }, (_, k) => ({
    id: id('p', da + k), nome: 'P', cognome: 'X', classe_sezione: null, stato: 'iscritto', scuola_id: 's1',
  }))

  it('il SECONDO pezzo fallisce: guasto (ok=false, error), non i legami del primo spacciati per tutti', async () => {
    const { client } = copioneIn([
      { data: bambini, error: null },
      { data: paganti(0, ID_PER_QUERY), error: null },
      { data: null, error: { code: '57014', message: 'timeout' } },
    ])
    expect(await caricaLegamiRetta(client, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })).toEqual({ ok: false })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-paganti-non-letti', n: N }), expect.anything())
  })

  it('42703 su gender al primo pezzo: un log info, e si rileggono TUTTI i pezzi senza gender', async () => {
    const { client, chiamate } = copioneIn([
      { data: bambini, error: null },
      { data: null, error: { code: '42703', message: 'column alunni.gender does not exist' } },
      { data: paganti(0, ID_PER_QUERY), error: null },
      { data: paganti(ID_PER_QUERY, N), error: null },
    ])
    const e = await caricaLegamiRetta(client, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.length).toBe(N)
    expect(chiamate.slice(2).map((c) => [c.select.includes('gender'), c.ids?.length])).toEqual([[false, ID_PER_QUERY], [false, N - ID_PER_QUERY]])
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'legami-paganti-colonne-assenti' }), expect.anything())
  })
})
