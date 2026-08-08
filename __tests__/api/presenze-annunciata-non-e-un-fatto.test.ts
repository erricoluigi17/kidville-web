/**
 * Q4 — UN'ASSENZA SOLTANTO ANNUNCIATA NON È UN FATTO DEL REGISTRO.
 *
 * L'onda 3 ha separato il futuro dal passato guardando la DATA. Ma il confronto
 * `data <= oggi` non può, per costruzione, escludere una riga che cade su OGGI:
 * `oggi <= oggi` è vero sempre. E `oggi` è il valore PREIMPOSTATO del modulo su
 * entrambe le schermate che scrivono — cioè il caso di gran lunga più frequente,
 * non un bordo.
 *
 * Misura del 2026-08-08 (una sola POST di «Comunica un'assenza» per oggi):
 *   PRIMA  oggi.stato = null · riepilogo assenze 0 · oreTotali 0
 *   DOPO   oggi.stato = 'assente' · riepilogo assenze 1 · oreTotali 5,25
 *   e `registrato_da IS NULL`: nessun docente aveva registrato niente.
 *
 * Questo file misura i QUATTRO consumatori insieme, perché la lezione del ciclo
 * è che un rimedio applicato al solo file in cui il difetto è stato misurato
 * lascia in piedi il gemello.
 *
 * ⚠️ LA CONTROPROVA CHE VALE PIÙ DELLE ALTRE (ultimo `describe`): il predicato
 * che il rilievo proponeva alla lettera — «è un fatto solo se `registrato_da IS
 * NOT NULL`» — è stato MISURATO su produzione prima di essere scartato:
 *   SELECT count(*), count(registrato_da) FROM presenze;  →  49, 13
 * Trentasei righe su quarantanove sono appelli VERI scritti prima che
 * `attendance/daily:POST` valorizzasse la colonna. Ogni consumatore qui sotto
 * ha il suo caso che lo dimostra.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Riga = Record<string, unknown>
type Filtro = { op: string; col: string; val: unknown }

const h = vi.hoisted(() => {
  const state = {
    tabelle: {} as Record<string, Riga[]>,
    eseguite: [] as { tabella: string; colonne: string; filtri: Filtro[] }[],
  }

  /** Un ramo `a.op.val` del filtro `or` di PostgREST. */
  function ramoOr(riga: Riga, ramo: string): boolean {
    const [col, ...resto] = ramo.split('.')
    const coda = resto.join('.')
    const v = riga[col]
    if (coda === 'is.null') return v === null || v === undefined
    if (coda === 'not.is.null') return v !== null && v !== undefined
    if (coda.startsWith('neq.')) return String(v ?? '') !== coda.slice(4)
    if (coda.startsWith('eq.')) return String(v ?? '') === coda.slice(3)
    throw new Error(`ramo or non gestito dal doppio: ${ramo}`)
  }

  function applica(riga: Riga, f: Filtro): boolean {
    const v = riga[f.col]
    switch (f.op) {
      case 'eq':
        return v === f.val
      case 'gte':
        return String(v) >= String(f.val)
      case 'lte':
        return String(v) <= String(f.val)
      case 'in':
        return (f.val as unknown[]).includes(v)
      case 'is':
        return f.val === null ? v === null || v === undefined : v === f.val
      case 'not.is':
        return f.val === null ? v !== null && v !== undefined : v !== f.val
      case 'or':
        return String(f.val).split(',').some((ramo) => ramoOr(riga, ramo))
      default:
        return true
    }
  }

  function proietta(riga: Riga, colonne: string): Riga {
    if (colonne === '*') return { ...riga }
    const out: Riga = {}
    for (const c of colonne.split(',').map((s) => s.trim()).filter(Boolean)) out[c] = riga[c] ?? null
    return out
  }

  function makeClient() {
    return {
      from(tabella: string) {
        const filtri: Filtro[] = []
        let colonne = '*'
        let conteggio = false
        let soloTesta = false
        const qb: Record<string, unknown> = {}
        qb.select = (c?: string, opts?: { count?: string; head?: boolean }) => {
          if (typeof c === 'string' && c.trim()) colonne = c
          if (opts?.count) conteggio = true
          if (opts?.head) soloTesta = true
          return qb
        }
        for (const op of ['eq', 'gte', 'lte', 'in'] as const) {
          qb[op] = (col: string, val: unknown) => {
            filtri.push({ op, col, val })
            return qb
          }
        }
        qb.is = (col: string, val: unknown) => (filtri.push({ op: 'is', col, val }), qb)
        qb.not = (col: string, op: string, val: unknown) => (filtri.push({ op: `not.${op}`, col, val }), qb)
        qb.or = (val: string) => (filtri.push({ op: 'or', col: '', val }), qb)
        qb.order = () => qb
        qb.limit = () => qb
        const esegui = () => {
          state.eseguite.push({ tabella, colonne, filtri: [...filtri] })
          const righe = (state.tabelle[tabella] ?? []).filter((r) => filtri.every((f) => applica(r, f)))
          if (conteggio) return { data: soloTesta ? null : righe, error: null, count: righe.length }
          return { data: righe.map((r) => proietta(r, colonne)), error: null }
        }
        qb.maybeSingle = () => {
          const res = esegui() as { data: Riga[] | null; error: unknown }
          return Promise.resolve({ data: res.data?.[0] ?? null, error: null })
        }
        qb.single = qb.maybeSingle
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(esegui()).then(res, rej)
        return qb
      },
    }
  }

  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.makeClient()),
}))
vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: vi.fn(async () => ({ user: { id: GENITORE, role: 'genitore' }, response: null })),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: DOCENTE, role: 'educator' }, response: null })),
  requireStaff: vi.fn(async () => ({ user: { id: DOCENTE, role: 'admin' }, response: null })),
  requireUser: vi.fn(async () => ({ user: { id: DOCENTE, role: 'admin' }, response: null })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
  assertClasseNomeInScope: vi.fn(async () => null),
  resolveScuoleAttive: vi.fn(async () => [SEDE]),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: vi.fn(), logEvento: vi.fn(), logOk: vi.fn() }
})

import { NextRequest } from 'next/server'
import { GET as ParentPresenze } from '@/app/api/parent/presenze/route'
import { GET as ParentAssenze } from '@/app/api/parent/primaria/assenze/route'
import { GET as OreAssenza } from '@/app/api/primaria/ore-assenza/route'
import { GET as Mensile, type MonthlyAttendanceRecord } from '@/app/api/attendance/monthly/route'

const SEDE = 'e1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const DOCENTE = 'd1111111-1111-4111-8111-111111111111'
const GENITORE = 'b1111111-1111-4111-8111-111111111111'
const ALUNNO = 'a1111111-1111-4111-8111-111111111111'

// 8 agosto 2026, mezzogiorno UTC: nessuna ambiguità di fuso in questo file.
const ISTANTE = new Date('2026-08-08T12:00:00.000Z')
const OGGI = '2026-08-08'
const IERI = '2026-08-07'
const LUGLIO = '2026-07-23'
const DOMANI = '2026-08-09'

/** L'assenza che il genitore ha ANNUNCIATO: nessun docente l'ha lavorata. */
const annunciata = (data: string, id: string): Riga => ({
  id, alunno_id: ALUNNO, section_id: SEZIONE, scuola_id: SEDE, data,
  stato: 'assente', orario_entrata: null, orario_uscita: null,
  giustificata: true, giustificata_da: GENITORE, giustificata_il: `${data}T07:00:00Z`,
  giustificazione_testo: null, note_appello: null, registrato_da: null,
})

/** L'appello del docente: un fatto del registro. */
const appello = (data: string, id: string, stato = 'assente'): Riga => ({
  ...annunciata(data, id), stato,
  giustificata: false, giustificata_da: null, giustificata_il: null,
  registrato_da: DOCENTE,
})

/**
 * Le 36 righe storiche misurate in produzione: appelli VERI dello 0-6 scritti
 * prima che `attendance/daily:POST` valorizzasse `registrato_da`. Non hanno
 * NESSUNA delle due colonne di provenienza.
 */
const storica = (data: string, id: string, stato = 'assente'): Riga => ({
  ...appello(data, id, stato), registrato_da: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ISTANTE)
  h.state.tabelle = {
    alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Test', section_id: SEZIONE, scuola_id: SEDE, classe_sezione: 'TEST 1A' }],
    sections: [{ id: SEZIONE, school_type: 'primaria', name: 'TEST 1A', scuola_id: SEDE }],
    campanelle: [],
    presenze: [],
    materie: [],
    orario_settimanale: [],
  }
  h.state.eseguite = []
})
afterEach(() => {
  vi.useRealTimers()
})

const parentReq = (base: string) =>
  new NextRequest(`http://localhost${base}?studentId=${ALUNNO}&userId=${GENITORE}`, {
    headers: { 'x-user-id': GENITORE },
  })

// ─────────────────────────────────────────────────────────────────────────────
describe('Q4 · `parent/presenze:GET` — il badge della home torna al suo contratto', () => {
  it('assenza annunciata per OGGI → `oggi.stato` resta null (l’appello non c’è)', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio')]
    const body = await (await ParentPresenze(parentReq('/api/parent/presenze'))).json()
    expect(
      body.data.oggi.stato,
      'il contratto della rotta dice «stato: null = appello non ancora registrato dal docente»',
    ).toBeNull()
  })

  it('…e non entra nel riepilogo dei 30 giorni né nel monte ore', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio')]
    const body = await (await ParentPresenze(parentReq('/api/parent/presenze'))).json()
    expect(body.data.riepilogo.assenze, 'misurato: da 0 a 1 con una sola POST').toBe(0)
    expect(body.data.riepilogo.ore.oreTotali, 'misurato: da 0 a 5,25 ore con una sola POST').toBe(0)
  })

  it('l’appello del docente di stamattina CONTA (non si toglie un dato vero)', async () => {
    h.state.tabelle.presenze = [appello(OGGI, 'p-appello')]
    const body = await (await ParentPresenze(parentReq('/api/parent/presenze'))).json()
    expect(body.data.oggi.stato).toBe('assente')
    expect(body.data.riepilogo.assenze).toBe(1)
  })

  it('la riga storica senza `registrato_da` continua a contare', async () => {
    h.state.tabelle.presenze = [storica(IERI, 'p-storica')]
    const body = await (await ParentPresenze(parentReq('/api/parent/presenze'))).json()
    expect(body.data.riepilogo.assenze, '36 righe su 49 in produzione sono così').toBe(1)
  })

  it('l’elenco `comunicate` continua a mostrare l’annuncio: si toglie dai CONTEGGI, non dalla vista', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio')]
    const body = await (await ParentPresenze(parentReq('/api/parent/presenze'))).json()
    expect(
      (body.data.comunicate as { id: string }[]).map((c) => c.id),
      'senza elenco il genitore non può annullare ciò che ha comunicato',
    ).toEqual(['p-annuncio'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Q4 · `parent/primaria/assenze:GET` — cronologia e conteggi', () => {
  it('l’assenza annunciata per oggi non compare fra quelle avvenute', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio'), storica(LUGLIO, 'p-storica')]
    const body = await (await ParentAssenze(parentReq('/api/parent/primaria/assenze'))).json()
    expect((body.data as { id: string }[]).map((r) => r.id)).toEqual(['p-storica'])
    expect(body.riepilogo.assente).toBe(1)
  })

  it('l’appello del docente di oggi c’è, e conta', async () => {
    h.state.tabelle.presenze = [appello(OGGI, 'p-appello')]
    const body = await (await ParentAssenze(parentReq('/api/parent/primaria/assenze'))).json()
    expect((body.data as { id: string }[]).map((r) => r.id)).toEqual(['p-appello'])
    expect(body.riepilogo.assente).toBe(1)
  })

  it('un RITARDO storico giustificato dal genitore resta un fatto', async () => {
    // `giustifica:POST` scrive `giustificata_da` su una riga che esiste già: con
    // le sole due colonne della sorgente questa riga sembrerebbe un annuncio.
    h.state.tabelle.presenze = [{ ...storica(LUGLIO, 'p-ritardo', 'ritardo'), giustificata_da: GENITORE }]
    const body = await (await ParentAssenze(parentReq('/api/parent/primaria/assenze'))).json()
    expect(body.riepilogo.ritardo).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Q4 · `primaria/ore-assenza:GET` — il numero che valida l’anno scolastico', () => {
  const req = () =>
    new NextRequest(`http://localhost/api/primaria/ore-assenza?sectionId=${SEZIONE}&from=2026-01-01&to=2099-12-31`)

  it('l’assenza annunciata per oggi non entra nel monte ore', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio')]
    const body = await (await OreAssenza(req())).json()
    expect(body.data[0].oreTotali, 'misurato in produzione: 5,25 ore per un appello mai fatto').toBe(0)
  })

  it('l’appello del docente di oggi entra, come sempre', async () => {
    h.state.tabelle.presenze = [appello(OGGI, 'p-appello')]
    const body = await (await OreAssenza(req())).json()
    expect(body.data[0].oreTotali).toBeGreaterThan(0)
  })

  it('la riga storica senza `registrato_da` entra: è un appello vero', async () => {
    h.state.tabelle.presenze = [storica(LUGLIO, 'p-storica')]
    const body = await (await OreAssenza(req())).json()
    expect(body.data[0].oreTotali).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Q4 · `attendance/monthly:GET` — la marca dice «non è un fatto», non «è futura»', () => {
  const req = () =>
    new NextRequest('http://localhost/api/attendance/monthly?sezione=TEST%201A&year=2026&month=8')

  const perData = async () => {
    const righe = (await (await Mensile(req())).json()) as MonthlyAttendanceRecord[]
    return Object.fromEntries(righe.map((r) => [r.date, r]))
  }

  it('l’annuncio di OGGI è marcato «non è un fatto» — il nome `futura` nascondeva proprio questo caso', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio')]
    expect((await perData())[OGGI].fattoDelRegistro).toBe(false)
  })

  it('l’appello di oggi è un fatto, l’annuncio di domani no', async () => {
    h.state.tabelle.presenze = [appello(OGGI, 'p-appello'), annunciata(DOMANI, 'p-domani')]
    const righe = await perData()
    expect(righe[OGGI].fattoDelRegistro).toBe(true)
    expect(righe[DOMANI].fattoDelRegistro).toBe(false)
  })

  it('la riga storica senza `registrato_da` resta un fatto', async () => {
    h.state.tabelle.presenze = [storica(IERI, 'p-storica')]
    expect((await perData())[IERI].fattoDelRegistro).toBe(true)
  })

  it('il calendario le riceve TUTTE: si marcano, non si nascondono', async () => {
    h.state.tabelle.presenze = [annunciata(OGGI, 'p-annuncio'), annunciata(DOMANI, 'p-domani'), appello(IERI, 'p-ieri')]
    expect(Object.keys(await perData()).sort()).toEqual([IERI, OGGI, DOMANI].sort())
  })
})
