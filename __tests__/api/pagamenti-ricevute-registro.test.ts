import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Il finto NON è piatto, e riproduce lo schema VERO di produzione (misurato il 2026-09-26
// su pg_constraint): `ricevute_emesse` ha FK su pagamento_id, scuola_id, transazione_id —
// NESSUNA su alunno_id. Quindi:
//  - simula la PROIEZIONE di PostgREST: la risposta contiene solo le colonne chieste;
//  - un embed `alias:colonna ( … )` si risolve SOLO se la colonna ha una FK. Altrimenti
//    risponde PGRST200 col messaggio reale di PostgREST, che nomina la COLONNA
//    («… between 'ricevute_emesse' and 'alunno_id' …»): in app_log ce ne sono 14, a 500.
//  - registra, per OGNI query, tabella, select, eq, in, order e limit.
type Chiamata = { tabella: string; select: string; eq: [string, unknown][]; in: [string, unknown[]][]; order: [string, unknown][]; limit: number[] }
type Errore = { code: string; message: string; details?: string }

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  righeDb: [] as Record<string, unknown>[],
  sedi: {} as Record<string, { nome: string | null }>,
  alunniDb: {} as Record<string, { nome: string; cognome: string; scuola_id?: string }>,
  embedComeArray: false,
  // Errore forzato sulla PRIMA select di ricevute_emesse (qualunque colonna chieda).
  selectErr: null as Errore | null,
  // DB dove la FK verso `schools` manca (DB E2E della CI non migrato).
  fkSchoolsAssente: false,
  // Errore restituito alle select di ricevute_emesse SENZA l'embed `schools` (il ripiego).
  erroreSenzaEmbed: null as Errore | null,
  // Errore restituito alla lettura di `alunni`.
  erroreAlunni: null as Errore | null,
  chiamate: [] as Chiamata[],
}))

// FK davvero presenti su ricevute_emesse (pg_constraint, produzione).
const FK: Record<string, string> = { scuola_id: 'schools', pagamento_id: 'pagamenti', transazione_id: 'pagamenti_transazioni' }

const pgrst200 = (colonna: string): Errore => ({
  code: 'PGRST200',
  message: `Could not find a relationship between 'ricevute_emesse' and '${colonna}' in the schema cache`,
  details: `Searched for a foreign key relationship between 'ricevute_emesse' and '${colonna}' in the schema 'public', but no matches were found.`,
})

/** Divide la select sulle virgole di primo livello (fuori dalle parentesi). */
function tokenTopLevel(sel: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const EMBED = /^(\w+):(\w+)\s*\((.*)\)$/

/** PGRST200 se la select incorpora una colonna senza FK (come fa PostgREST prima di eseguire). */
function erroreRelazione(sel: string): Errore | null {
  for (const tok of tokenTopLevel(sel)) {
    const m = tok.match(EMBED)
    if (!m) continue
    const col = m[2]
    if (!FK[col] || (col === 'scuola_id' && h.fkSchoolsAssente)) return pgrst200(col)
  }
  return null
}

function proietta(riga: Record<string, unknown>, sel: string): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  for (const tok of tokenTopLevel(sel)) {
    const m = tok.match(EMBED)
    if (!m) {
      r[tok] = riga[tok]
      continue
    }
    const [, alias, col, sottoCol] = m
    if (col !== 'scuola_id') throw new Error(`embed non previsto dal finto: ${tok}`)
    const colonne = sottoCol.split(',').map((c) => c.trim())
    const id = riga[col] as string | undefined
    const bersaglio = id && h.sedi[id] ? { ...h.sedi[id] } : null
    const ridotto = bersaglio ? Object.fromEntries(colonne.map((c) => [c, (bersaglio as Record<string, unknown>)[c]])) : null
    r[alias] = h.embedComeArray && ridotto ? [ridotto] : ridotto
  }
  return r
}

function esegui(c: Chiamata): { data: unknown; error: Errore | null } {
  if (c.tabella === 'alunni') {
    if (h.erroreAlunni) return { data: null, error: h.erroreAlunni }
    const ids = c.in.find(([col]) => col === 'id')?.[1] ?? []
    const perimetro = c.in.find(([col]) => col === 'scuola_id')?.[1]
    const data = Object.entries(h.alunniDb)
      .filter(([id]) => ids.includes(id))
      .filter(([, a]) => !perimetro || perimetro.includes(a.scuola_id ?? 'sc-1'))
      .map(([id, a]) => proietta({ id, ...a }, c.select))
    return { data, error: null }
  }
  if (c.tabella !== 'ricevute_emesse') throw new Error(`tabella non prevista dal finto: ${c.tabella}`)
  const primaDiRicevute = h.chiamate.filter((x) => x.tabella === 'ricevute_emesse')[0] === c
  const conEmbedSede = /\bschools\s*:/.test(c.select)
  const errore =
    (primaDiRicevute ? h.selectErr : null) ?? erroreRelazione(c.select) ?? (!conEmbedSede ? h.erroreSenzaEmbed : null)
  if (errore) return { data: null, error: errore }
  const perimetro = c.in.find(([col]) => col === 'scuola_id')?.[1]
  const data = h.righeDb
    .filter((r) => !perimetro || perimetro.includes(r.scuola_id))
    .filter((r) => c.eq.every(([col, v]) => r[col] === v))
    .map((r) => proietta(r, c.select))
  return { data, error: null }
}

// Logger vero, ma spiato: serve a vedere che il ripiego senza sede NON è muto.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: vi.fn(vero.logEvento), logErrore: vi.fn(vero.logErrore) }
})
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: vi.fn(async () => ['sc-1', 'sc-2']) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const c: Chiamata = { tabella, select: '', eq: [], in: [], order: [], limit: [] }
      h.chiamate.push(c)
      const b: Record<string, unknown> = {}
      b.select = (s: string) => ((c.select = s), b)
      b.eq = (col: string, v: unknown) => (c.eq.push([col, v]), b)
      b.in = (col: string, v: unknown[]) => (c.in.push([col, v]), b)
      b.order = (col: string, opts: unknown) => (c.order.push([col, opts]), b)
      b.limit = (n: number) => (c.limit.push(n), b)
      b.then = (resolve: (v: unknown) => unknown) => resolve(esegui(c))
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/ricevute/route'
import { logEvento, logErrore } from '@/lib/logging/logger'

const req = (qs = '') => new Request(`http://localhost/api/pagamenti/ricevute?${qs}`) as unknown as import('next/server').NextRequest

const riga = (over: Record<string, unknown>) => ({
  id: 'r1',
  pagamento_id: 'p1',
  scuola_id: 'sc-1',
  alunno_id: 'a1',
  numero: 1,
  anno: 2026,
  importo: 150,
  periodo_competenza: null,
  metodi: ['contanti'],
  tracciabile: true,
  bollo: false,
  annullata_il: null,
  annullo_motivo: null,
  creato_il: '2026-09-01T10:00:00Z',
  ...over,
})

const ricevute = () => h.chiamate.filter((c) => c.tabella === 'ricevute_emesse')
const letture = (tabella: string) => h.chiamate.filter((c) => c.tabella === tabella)
const warnSede = () =>
  vi.mocked(logEvento).mock.calls.filter((a) => (a[2] as { esito?: string } | undefined)?.esito === 'sede-senza-nome-fk-assente')

describe('GET /api/pagamenti/ricevute — registro', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.selectErr = null
    h.fkSchoolsAssente = false
    h.erroreSenzaEmbed = null
    h.erroreAlunni = null
    h.chiamate = []
    h.embedComeArray = false
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.sedi = { 'sc-1': { nome: 'Sede Uno' }, 'sc-2': { nome: 'Sede Due' } }
    h.alunniDb = { a1: { nome: 'Alunno', cognome: 'Prova' }, a2: { nome: 'Altro', cognome: 'Prova' } }
    h.righeDb = [riga({})]
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(req())).status).toBe(403)
  })

  it('200 con elenco', async () => {
    const res = await GET(req('anno=2026'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    expect(j.disponibile).not.toBe(false)
  })

  it('degrada se il registro non esiste (42P01) → lista vuota, disponibile:false', async () => {
    h.selectErr = { code: '42P01', message: 'relation does not exist' }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(j.disponibile).toBe(false)
  })

  it('PRODUZIONE: nessuna FK su alunno_id → il registro esce (niente PGRST200), con nome e cognome dell\'alunno', async () => {
    // È il 500 che c'era in produzione (14 PGRST200 in app_log, ultimo il 2026-09-23):
    // l'embed `alunni:alunno_id ( … )` non si può risolvere. Il finto risponde PGRST200 a
    // qualunque embed su alunno_id, esattamente come PostgREST.
    h.righeDb = [riga({ id: 'r-a', alunno_id: 'a1' }), riga({ id: 'r-b', alunno_id: 'a2', numero: 2 })]
    const res = await GET(req('anno=2026'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: Record<string, unknown>[] }
    const perId = Object.fromEntries(j.data.map((r) => [r.id as string, r]))
    expect(perId['r-a'].alunni).toEqual({ nome: 'Alunno', cognome: 'Prova' })
    expect(perId['r-b'].alunni).toEqual({ nome: 'Altro', cognome: 'Prova' })
    // La select del registro non incorpora più `alunni`: i nomi arrivano da una seconda lettura.
    expect(ricevute()).toHaveLength(1)
    expect(ricevute()[0].select).not.toMatch(/\balunn\w*\s*:/)
    expect(letture('alunni')).toHaveLength(1)
    expect(letture('alunni')[0].select).toBe('id, nome, cognome')
    expect(letture('alunni')[0].in).toEqual([
      ['id', ['a1', 'a2']],
      ['scuola_id', ['sc-1', 'sc-2']],
    ])
    // Nessun warn sulla sede (la FK di schools c'è) e nessun errore.
    expect(warnSede()).toHaveLength(0)
    expect(logErrore).not.toHaveBeenCalled()
    // La forma del contratto non cambia: `alunno_id` non esce.
    expect(perId['r-a']).not.toHaveProperty('alunno_id')
  })

  it('PGRST200 su una relazione che NON è la sede → 500 loggato, niente warn sulla sede, niente ripiego', async () => {
    h.selectErr = pgrst200('alunno_id')
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(ricevute()).toHaveLength(1)
    expect(warnSede()).toHaveLength(0)
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'pagamenti/ricevute:GET', stato: 500 }),
      expect.objectContaining({ code: 'PGRST200' }),
    )
  })

  it('alunno_id nullo o alunno non trovato → alunni null; ricevute senza alunni → nessuna lettura di alunni', async () => {
    h.righeDb = [riga({ id: 'r-a', alunno_id: null }), riga({ id: 'r-b', alunno_id: 'a-sparito' })]
    const j = (await (await GET(req())).json()) as { data: Record<string, unknown>[] }
    expect(j.data.map((r) => [r.id, r.alunni])).toEqual([
      ['r-a', null],
      ['r-b', null],
    ])
    expect(letture('alunni')[0].in[0]).toEqual(['id', ['a-sparito']])

    h.chiamate = []
    h.righeDb = [riga({ alunno_id: null })]
    await GET(req())
    expect(letture('alunni')).toHaveLength(0)
  })

  it('isolamento: il nome di un alunno oggi in una sede FUORI perimetro non esce (alunni null), la ricevuta sì', async () => {
    // Misurato il 2026-09-26: 2 ricevute su 144 hanno l'alunno oggi in un'altra sede.
    h.alunniDb = { a1: { nome: 'Alunno', cognome: 'Prova', scuola_id: 'sc-1' }, a9: { nome: 'Fuori', cognome: 'Sede', scuola_id: 'sc-9' } }
    h.righeDb = [riga({ id: 'r-a', alunno_id: 'a1' }), riga({ id: 'r-b', alunno_id: 'a9', numero: 2 })]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: Record<string, unknown>[] }
    expect(j.data.map((r) => [r.id, r.scuola_id, r.alunni])).toEqual([
      ['r-a', 'sc-1', { nome: 'Alunno', cognome: 'Prova' }],
      ['r-b', 'sc-1', null],
    ])
    expect(letture('alunni')[0].in).toContainEqual(['scuola_id', ['sc-1', 'sc-2']])
  })

  it('molti alunni → lettura a blocchi da 100 id (l\'URL di .in() non cresce oltre il 414)', async () => {
    h.alunniDb = {}
    h.righeDb = Array.from({ length: 250 }, (_, i) => {
      h.alunniDb[`a${i}`] = { nome: `N${i}`, cognome: 'C' }
      return riga({ id: `r${i}`, alunno_id: `a${i}`, numero: i + 1 })
    })
    const j = (await (await GET(req())).json()) as { data: Record<string, unknown>[] }
    expect(letture('alunni').map((c) => (c.in[0][1] as unknown[]).length)).toEqual([100, 100, 50])
    expect(j.data.find((r) => r.id === 'r249')?.alunni).toEqual({ nome: 'N249', cognome: 'C' })
  })

  it('errore nella lettura di alunni → 500 loggato, mai un registro senza nomi spacciato per completo', async () => {
    h.erroreAlunni = { code: '08006', message: 'connection failure' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'pagamenti/ricevute:GET', stato: 500 }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('K7: due sedi con lo STESSO numero → ogni ricevuta dice di quale sede è (scuola_id + scuola_nome)', async () => {
    h.righeDb = [
      riga({ id: 'r-a', scuola_id: 'sc-1', alunno_id: 'a1', numero: 7 }),
      riga({ id: 'r-b', scuola_id: 'sc-2', alunno_id: 'a2', numero: 7 }),
    ]
    const res = await GET(req('anno=2026'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: Record<string, unknown>[] }
    const perId = Object.fromEntries(j.data.map((r) => [r.id as string, r]))
    expect(perId['r-a']).toMatchObject({ numero: 7, scuola_id: 'sc-1', scuola_nome: 'Sede Uno' })
    expect(perId['r-b']).toMatchObject({ numero: 7, scuola_id: 'sc-2', scuola_nome: 'Sede Due' })
    expect(perId['r-a'].alunni).toEqual({ nome: 'Alunno', cognome: 'Prova' })
    // L'embed grezzo della sede non esce: il contratto è `scuola_nome`.
    expect(perId['r-a']).not.toHaveProperty('schools')
  })

  it('K7: embed restituito come array (forma alternativa di PostgREST) → scuola_nome letto uguale', async () => {
    h.embedComeArray = true
    h.righeDb = [riga({ scuola_id: 'sc-2' })]
    const j = (await (await GET(req())).json()) as { data: Record<string, unknown>[] }
    expect(j.data[0]).toMatchObject({ scuola_id: 'sc-2', scuola_nome: 'Sede Due' })
  })

  it('K7: sede senza nome o senza riga in schools → scuola_nome null, mai crash', async () => {
    h.sedi = { 'sc-1': { nome: null } }
    h.righeDb = [riga({ id: 'r-a', scuola_id: 'sc-1' }), riga({ id: 'r-b', scuola_id: 'sc-2' })]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: Record<string, unknown>[] }
    expect(j.data.map((r) => [r.id, r.scuola_id, r.scuola_nome])).toEqual([
      ['r-a', 'sc-1', null],
      ['r-b', 'sc-2', null],
    ])
  })

  it('K7: FK verso schools assente (PGRST200 sulla sede, DB E2E non migrato) → registro restituito lo stesso, scuola_nome null', async () => {
    h.fkSchoolsAssente = true
    h.righeDb = [
      riga({ id: 'r-a', scuola_id: 'sc-1', alunno_id: 'a1', numero: 7 }),
      riga({ id: 'r-b', scuola_id: 'sc-2', alunno_id: 'a2', numero: 7 }),
    ]
    const res = await GET(req('anno=2026'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: Record<string, unknown>[]; disponibile?: boolean }
    expect(j.disponibile).not.toBe(false)
    expect(j.data.map((r) => [r.id, r.numero, r.scuola_id, r.scuola_nome])).toEqual([
      ['r-a', 7, 'sc-1', null],
      ['r-b', 7, 'sc-2', null],
    ])
    expect(j.data[0].alunni).toEqual({ nome: 'Alunno', cognome: 'Prova' })
    expect(j.data[0]).not.toHaveProperty('schools')
    // Due query sul registro: la prima con l'embed della sede, il ripiego senza.
    expect(ricevute()).toHaveLength(2)
    expect(ricevute()[0].select).toMatch(/\bschools\s*:/)
    expect(ricevute()[1].select).not.toMatch(/\bschools\s*:/)
    expect(ricevute()[1].select).toMatch(/\bscuola_id\b/)
    // Il ripiego non è muto (warn, non error: il registro esce), e non passa per il 500.
    expect(logEvento).toHaveBeenCalledWith(
      'db',
      'warn',
      expect.objectContaining({ operazione: 'pagamenti/ricevute:GET', esito: 'sede-senza-nome-fk-assente' }),
      expect.objectContaining({ code: 'PGRST200' }),
    )
    expect(warnSede()).toHaveLength(1)
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('K7: PGRST200 sulla sede e poi errore generico sul ripiego → 500 loggato, mai un registro finto', async () => {
    h.fkSchoolsAssente = true
    h.erroreSenzaEmbed = { code: '08006', message: 'connection failure' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(ricevute()).toHaveLength(2)
    expect(logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'pagamenti/ricevute:GET', stato: 500 }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('K7: PGRST200 sulla sede e poi registro assente sul ripiego (42P01) → lista vuota, disponibile:false', async () => {
    h.fkSchoolsAssente = true
    h.erroreSenzaEmbed = { code: '42P01', message: 'relation does not exist' }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(j.disponibile).toBe(false)
  })

  it('schema completo → UNA sola query sul registro (il ripiego scatta solo su PGRST200 della sede)', async () => {
    await GET(req())
    expect(ricevute()).toHaveLength(1)
    expect(ricevute()[0].select).toMatch(/\bschools\s*:/)
  })

  it('con anno: filtro anno, perimetro, ordinamento e limite IDENTICI su query principale e ripiego', async () => {
    h.fkSchoolsAssente = true
    h.righeDb = [riga({ id: 'r-26', anno: 2026 }), riga({ id: 'r-25', anno: 2025 })]
    const j = (await (await GET(req('anno=2026'))).json()) as { data: Record<string, unknown>[] }
    expect(j.data.map((r) => r.id)).toEqual(['r-26'])
    expect(ricevute()).toHaveLength(2)
    for (const c of ricevute()) {
      expect(c.eq).toEqual([['anno', 2026]])
      expect(c.in).toEqual([['scuola_id', ['sc-1', 'sc-2']]])
      expect(c.order).toEqual([
        ['anno', { ascending: false }],
        ['numero', { ascending: false }],
      ])
      expect(c.limit).toEqual([500])
    }
  })

  it('senza anno: nessun eq, stesso perimetro, ordinamento e limite (schema completo)', async () => {
    await GET(req())
    expect(ricevute()).toHaveLength(1)
    const [c] = ricevute()
    expect(c.eq).toEqual([])
    expect(c.in).toEqual([['scuola_id', ['sc-1', 'sc-2']]])
    expect(c.order).toEqual([
      ['anno', { ascending: false }],
      ['numero', { ascending: false }],
    ])
    expect(c.limit).toEqual([500])
  })
})
