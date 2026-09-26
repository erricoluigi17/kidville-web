// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Riga } from '../fixtures/finto-supabase'

// =============================================================================
// `GET /api/pagamenti` — lettura A BLOCCHI oltre il tetto `max_rows` (K1).
//
// IL DIFETTO. PostgREST taglia ogni risposta a `max_rows` righe (1000 in
// `supabase/config.toml`, 1000 di default sul progetto ospitato) e NON lo dice:
// nessun errore, nessuna intestazione che il client guardi. Con tre sedi accorpate
// la GET senza `range` restituiva le prime 1000 righe per scadenza — KPI e tabelle
// della segreteria tagliati in silenzio.
//
// PERCHÉ IL FINTO VA AVVOLTO. `finto-supabase` applica `range` e `order` ma NON
// emula `max_rows`: da solo restituirebbe 2500 righe anche alla route senza
// paginazione, e il test sarebbe verde con e senza la correzione. L'involucro
// qui sotto aggiunge le due proprietà del server vero che il difetto sfrutta:
//
//  1. il TETTO: ogni risposta si ferma a 1000 righe;
//  2. l'ORDINE NON DETERMINATO DEI PARI: Postgres non garantisce l'ordine fra
//     righe con la stessa `scadenza`, e fra due richieste può cambiarlo. Il finto
//     ordina con un sort STABILE, cioè mantiene l'ordine d'ingresso: rimescolando
//     la tabella prima di ogni lettura, due blocchi letti con il solo
//     `order('scadenza')` si sovrappongono e perdono righe — esattamente come in
//     produzione. Solo il secondo criterio `order('id')` li rende disgiunti.
//
// E per il TETTO di 50 blocchi una tabella «virtuale»: le righe di `pagamenti`
// nascono dall'intervallo `range` chiesto (mai più di 1000), così si provano 50.000
// e 50.001 righe senza costruirle e ordinarle in memoria a ogni lettura.
//
// Uuid, nomi e codici fiscali sintetici: il repository è pubblico.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-0000000000d4'
const ID_GENITORE = 'd0000000-0000-4000-8000-0000000000e1'
const CF_FINTO = 'ABCDEF00A00A000A'
const SEZ_A = 'cccccccc-0000-4000-8000-0000000000c1'
const SEZ_B = 'cccccccc-0000-4000-8000-0000000000c2'
const MAX_ROWS = 1000

type Lettura = {
  tabella: string
  select: string | null
  range: [number, number] | null
  ordini: string[]
  /** Gli id passati a `.in('pagamento_id', …)`, se c'è. */
  inPagamentoId: string[] | null
  inScuolaId: string[] | null
}
type ErrFinto = { code: string; message: string }

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  figli: vi.fn(async () => [] as string[]),
  db: {} as DBFinto,
  tabelle: [] as string[],
  letture: [] as Lettura[],
  /** Risposta forzata per la N-esima lettura (0-based) DI QUELLA TABELLA. */
  guasto: null as null | ((l: Lettura, n: number) => ErrFinto | null),
  /** Se non null, `pagamenti` è una tabella virtuale di N righe (vedi sopra). */
  virtuale: null as number | null,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return {
    ...actual,
    logEvento: h.logEvento,
    // `logErrore` resta VERO sotto la spia: è lui ad alzare la marca anti-doppione
    // (`segnalaErroreLoggato`) che `withRoute` legge sul 5xx. Una spia muta la
    // spegnerebbe, e l'asserzione «nessuna seconda riga `route/error`» diventerebbe
    // rossa anche col codice giusto — o, peggio, andrebbe tolta. Sotto VITEST il
    // logger non persiste niente.
    logErrore: (...a: Parameters<typeof actual.logErrore>) => {
      h.logErrore(...a)
      return actual.logErrore(...a)
    },
  }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: (...a: unknown[]) => h.figli(...(a as [])),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => conServerVero(creaFintoSupabase(h.db, h.tabelle, {})),
  }
})

// ─── L'involucro «server vero»: tetto max_rows + pari in ordine arbitrario ────

/** PRNG deterministico (mulberry32): il rimescolamento cambia a ogni lettura ma
 *  il test resta ripetibile. */
function prng(seme: number) {
  let a = seme >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let semeLettura = 1
function rimescola(righe: Riga[] | undefined) {
  if (!righe) return
  const r = prng(semeLettura++)
  for (let i = righe.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[righe[i], righe[j]] = [righe[j], righe[i]]
  }
}

/** Riga leggera della tabella virtuale: tutto ciò che la route legge, niente di più. */
function pagamentoVirtuale(i: number): Riga {
  return {
    id: `pv-${String(i).padStart(6, '0')}`,
    alunno_id: 'al-v',
    scuola_id: SEDE_A,
    descrizione: 'Retta',
    importo: 1,
    importo_pagato: 1,
    scadenza: '2026-09-10',
    stato: 'pagato',
    tipo: 'singolo',
    alunni: null,
    payment_categories: null,
  }
}

function conServerVero(client: SupabaseClient): SupabaseClient {
  const fromVero = (client as unknown as { from: (t: string) => object }).from
  const avvolgi = (builder: object, tabella: string): object => {
    const l: Lettura = { tabella, select: null, range: null, ordini: [], inPagamentoId: null, inScuolaId: null }
    const involucro: object = new Proxy(builder, {
      get(t, p) {
        if (p === 'then') {
          return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
            const n = h.letture.filter((x) => x.tabella === tabella).length
            h.letture.push(l)
            const g = h.guasto?.(l, n)
            if (g) return Promise.resolve({ data: null, error: g, count: null, status: 400, statusText: 'Bad Request' }).then(ok, ko)
            if (tabella === 'pagamenti' && h.virtuale !== null) {
              // Rispetta `range` e il tetto: senza `range` sarebbero le prime 1000.
              const [da, a] = l.range ?? [0, Number.MAX_SAFE_INTEGER]
              const fine = Math.min(a, h.virtuale - 1, da + MAX_ROWS - 1)
              const righe: Riga[] = []
              for (let i = da; i <= fine; i++) righe.push(pagamentoVirtuale(i))
              return Promise.resolve({ data: righe, error: null, count: null, status: 200, statusText: 'OK' }).then(ok, ko)
            }
            if (tabella === 'pagamenti' || tabella === 'fatture_coda') rimescola(h.db[tabella])
            const vero = Reflect.get(t, p) as (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise<unknown>
            return vero((r: unknown) => {
              const ris = r as { data: unknown }
              if (Array.isArray(ris.data) && ris.data.length > MAX_ROWS) return ok({ ...ris, data: ris.data.slice(0, MAX_ROWS) })
              return ok(r)
            }, ko)
          }
        }
        const v = Reflect.get(t, p)
        if (typeof v !== 'function') return v
        return (...a: unknown[]) => {
          if (p === 'select') l.select = String(a[0] ?? '')
          if (p === 'range') l.range = [a[0] as number, a[1] as number]
          // Colonna E direzione: con i soli nomi, `.order('scadenza')` crescente o
          // `.order('id', { ascending: false })` passerebbero inosservati.
          if (p === 'order') {
            const crescente = (a[1] as { ascending?: boolean } | undefined)?.ascending !== false
            l.ordini.push(`${String(a[0])} ${crescente ? 'asc' : 'desc'}`)
          }
          if (p === 'in' && a[0] === 'pagamento_id') l.inPagamentoId = [...(a[1] as string[])]
          if (p === 'in' && a[0] === 'scuola_id') l.inScuolaId = [...(a[1] as string[])]
          const r = (v as (...x: unknown[]) => unknown).apply(t, a)
          return r === t ? involucro : r
        }
      },
    })
    return involucro
  }
  return new Proxy(client, {
    get(t, p) {
      if (p === 'from') return (tabella: string) => avvolgi(fromVero(tabella), tabella)
      return Reflect.get(t, p)
    },
  }) as SupabaseClient
}

import { GET } from '@/app/api/pagamenti/route'

// ─── Dati ─────────────────────────────────────────────────────────────────────

const SCADENZE = ['2026-09-10', '2026-10-10', '2026-11-10']

function pagamento(i: number, extra: Partial<Riga> = {}): Riga {
  const id = `pg-${String(i).padStart(5, '0')}`
  const sede = i % 2 === 0 ? SEDE_A : SEDE_B
  return {
    id,
    alunno_id: `al-${i}`,
    scuola_id: sede,
    descrizione: 'Retta',
    importo: 200,
    importo_pagato: 200,
    sconto: null,
    // Solo TRE scadenze per 2500 righe: i pari sono la regola, non l'eccezione.
    scadenza: SCADENZE[i % SCADENZE.length],
    stato: 'pagato',
    tipo: 'singolo',
    visibile_dal: null,
    periodo_competenza: '2026-09',
    payment_categories: { id: 'cat-retta', nome: 'Retta', slug: 'retta', colore: null, icona: null },
    alunni: {
      id: `al-${i}`,
      nome: 'Mario',
      cognome: 'Rossi',
      codice_fiscale: CF_FINTO,
      classe_sezione: '3 ANNI',
      section_id: sede === SEDE_A ? SEZ_A : SEZ_B,
      sospeso: false,
    },
    ...extra,
  }
}

const dbCon = (n: number): DBFinto => ({
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  admin_settings: [],
  pagamenti: Array.from({ length: n }, (_, i) => pagamento(i)),
  pagamenti_quote: [],
  fatture_coda: [],
})

function voceCoda(i: number, pagamentoId: string, sede: string, stato = 'in_coda'): Riga {
  return { id: `coda-${String(i).padStart(5, '0')}`, pagamento_id: pagamentoId, scuola_id: sede, stato }
}

function req(qs = ''): NextRequest {
  return {
    url: `http://localhost/api/pagamenti${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

type RigaRisposta = {
  id: string
  scuola_id: string
  scuola_nome: string | null
  tipo?: string
  importo?: number
  quota_id?: string
  coda_stato?: string | null
  alunni: { section_id?: string | null } | null
}

const esitoDi = (c: unknown) => (c as { esito?: string } | undefined)?.esito
const eventi = (esito: string) => h.logEvento.mock.calls.filter(([, , c]) => esitoDi(c) === esito)
const lettureDi = (tabella: string) => h.letture.filter((l) => l.tabella === tabella)

function comeGenitore(figli: string[]) {
  h.requireUser.mockResolvedValue({ user: { id: ID_GENITORE, role: 'genitore' } })
  h.figli.mockResolvedValue(figli)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.letture = []
  h.guasto = null
  h.virtuale = null
  semeLettura = 1
  h.requireUser.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.figli.mockResolvedValue([])
})

describe('GET /api/pagamenti — oltre max_rows, a blocchi', () => {
  it('2500 righe su due sedi: tornano TUTTE, una volta sola, in 3 blocchi', async () => {
    h.db = dbCon(2500)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    const righe = j.data as RigaRisposta[]

    // Tutte, e nessuna due volte: senza `order('id')` i blocchi si sovrappongono.
    expect(righe).toHaveLength(2500)
    const ids = new Set(righe.map((r) => r.id))
    expect(ids.size).toBe(2500)
    expect([...ids].sort()).toEqual(h.db.pagamenti.map((r) => r.id as string).sort())

    // Tre richieste, con intervalli contigui e l'ordinamento stabile.
    const pag = lettureDi('pagamenti')
    expect(pag.map((l) => l.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    for (const l of pag) expect(l.ordini).toEqual(['scadenza desc', 'id asc'])

    // E l'ordine EFFETTIVO della risposta è quello del contratto: scadenza
    // decrescente, poi id crescente. Il riferimento è una copia ordinata dei dati del
    // fixture (che il finto rimescola a ogni lettura), non l'uscita della route.
    const atteso = [...h.db.pagamenti]
      .sort((x, y) => {
        const sx = String(x.scadenza)
        const sy = String(y.scadenza)
        if (sx !== sy) return sx < sy ? 1 : -1
        return String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0
      })
      .map((r) => r.id)
    expect(righe.map((r) => r.id)).toEqual(atteso)

    // Ogni riga porta la sua sede (id + nome) e la sezione dell'alunno.
    for (const r of righe) {
      expect([SEDE_A, SEDE_B]).toContain(r.scuola_id)
      expect(r.scuola_nome).toBe(r.scuola_id === SEDE_A ? NOME_SEDE_A : NOME_SEDE_B)
      expect(r.alunni?.section_id).toBe(r.scuola_id === SEDE_A ? SEZ_A : SEZ_B)
    }

    // Un solo evento, solo conteggi, e NON persistito (riassunto di una richiesta:
    // in `app_log` il contesto resterebbe quello della prima apertura del giorno).
    const blocchi = eventi('lettura-a-blocchi')
    expect(blocchi).toHaveLength(1)
    expect(blocchi[0][0]).toBe('pagamento')
    expect(blocchi[0][1]).toBe('info')
    expect(blocchi[0][2]).toEqual({ operazione: 'pagamenti:GET', esito: 'lettura-a-blocchi', blocchi: 3, righe: 2500, sedi: 2 })
    expect(blocchi[0][3]).toBeUndefined()
    expect(blocchi[0][4]).toEqual({ persisti: false })
  })

  it('la SELECT chiede `section_id` dentro il join `alunni(...)`', async () => {
    // Il finto non proietta le colonne (restituisce righe intere): la prova è sulla
    // stringa di select che parte verso PostgREST.
    h.db = dbCon(3)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const pag = lettureDi('pagamenti')
    expect(pag.length).toBeGreaterThan(0)
    for (const l of pag) expect(l.select).toMatch(/alunni\s*\([^)]*\bsection_id\b[^)]*\)/)
  })

  it('poche righe: una richiesta sola, e nessun evento «a blocchi»', async () => {
    h.db = dbCon(4)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(4)
    expect(lettureDi('pagamenti').map((l) => l.range)).toEqual([[0, 999]])
    // L'assenza si guarda DOPO la presenza delle righe: la lettura è già avvenuta.
    expect(eventi('lettura-a-blocchi')).toHaveLength(0)
  })

  it('esattamente 1000 righe: un blocco pieno obbliga a chiedere il successivo', async () => {
    h.db = dbCon(1000)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1000)
    expect(lettureDi('pagamenti').map((l) => l.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('il filtro sede resta: con ?scuola_id=A tornano solo le 1250 righe di A, in 2 blocchi', async () => {
    h.db = dbCon(2500)
    const res = await GET(req(`scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    const righe = j.data as RigaRisposta[]
    expect(righe).toHaveLength(1250)
    expect(new Set(righe.map((r) => r.scuola_id))).toEqual(new Set([SEDE_A]))
    expect(lettureDi('pagamenti')).toHaveLength(2)
    expect(eventi('lettura-a-blocchi')[0]?.[2]).toMatchObject({ blocchi: 2, righe: 1250, sedi: 1 })
  })

  it('un blocco successivo che fallisce: 500, e NESSUNA risposta parziale', async () => {
    h.db = dbCon(2500)
    h.guasto = (l, n) => (l.tabella === 'pagamenti' && n === 1 ? { code: '08006', message: 'connection failure' } : null)

    const res = await GET(req())
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.data).toBeUndefined()
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'pagamenti:GET', stato: 500, evento: 'db' }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('DB non migrato (42703 su `sconto`): il ripiego sul SELECT base è paginato anch\'esso', async () => {
    h.db = dbCon(2500)
    h.guasto = (l) => (l.tabella === 'pagamenti' && l.select?.includes('sconto') ? { code: '42703', message: 'column does not exist' } : null)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(new Set((j.data as RigaRisposta[]).map((r) => r.id)).size).toBe(2500)
    const basi = lettureDi('pagamenti').filter((l) => !l.select?.includes('sconto'))
    expect(basi.map((l) => l.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
})

describe('GET /api/pagamenti — il tetto di 50 blocchi è tutto-o-niente', () => {
  it('50.001 righe: la riga di prova trova l\'eccedenza → 500, nessuna riga, e un `error` «lettura-troncata»', async () => {
    h.db = dbCon(0)
    h.virtuale = 50_001

    const res = await GET(req())
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.data).toBeUndefined()
    expect(j.error).toMatch(/restringi i filtri/)
    expect(j.codice).toBe('LETTURA_FALLITA')

    const pag = lettureDi('pagamenti')
    expect(pag).toHaveLength(51)
    // Cinquanta blocchi pieni, poi UNA riga di prova oltre il tetto.
    expect(pag[49].range).toEqual([49_000, 49_999])
    expect(pag[50].range).toEqual([50_000, 50_000])

    // UNA riga `error`, da `logErrore` (che alza la marca anti-doppione), solo conteggi.
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    const [campi, err] = h.logErrore.mock.calls[0] as [Record<string, unknown>, Error]
    expect(campi).toEqual({ operazione: 'pagamenti:GET', stato: 500, evento: 'lettura-troncata' })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('lettura-troncata: oltre 50000 righe, 51 blocchi')

    // …e `withRoute` tace: senza la marca scriverebbe una SECONDA riga `route/error`
    // (il «doppione più povero» che la deduplica del 5xx esiste per evitare).
    // `logEvento` è la spia anche per `withRoute`, che importa lo stesso modulo.
    expect(h.logEvento.mock.calls.filter(([ev, liv]) => ev === 'route' && liv === 'error')).toEqual([])
    expect(h.logEvento.mock.calls.filter(([, liv]) => liv === 'error')).toEqual([])
  }, 30_000)

  it('ESATTAMENTE 50.000 righe: la prova torna vuota → 200 completo, nessun allarme', async () => {
    h.db = dbCon(0)
    h.virtuale = 50_000

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(50_000)
    const pag = lettureDi('pagamenti')
    expect(pag.at(-1)!.range).toEqual([50_000, 50_000])
    // L'assenza si guarda DOPO la presenza delle 50.000 righe.
    expect(h.logErrore).not.toHaveBeenCalled()
    expect(eventi('lettura-a-blocchi')[0]?.[2]).toMatchObject({ blocchi: 51, righe: 50_000 })
  }, 30_000)
})

describe('GET /api/pagamenti — coda fatture: per sede e stato, a blocchi in sequenza', () => {
  it('2500 pagamenti, una voce attiva: UNA lettura per sede/stato (URL corto), trovata anche sull\'ultima riga', async () => {
    h.db = dbCon(2500)
    const ultimo = h.db.pagamenti.map((r) => r.id as string).sort().at(-1)!
    const sedeUltimo = h.db.pagamenti.find((r) => r.id === ultimo)!.scuola_id as string
    h.db.fatture_coda = [voceCoda(0, ultimo, sedeUltimo), voceCoda(1, 'pg-altro', SEDE_A, 'emessa')]

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    const perId = Object.fromEntries((j.data as RigaRisposta[]).map((r) => [r.id, r.coda_stato]))
    expect(perId[ultimo]).toBe('in_coda')
    expect(Object.values(perId).filter((s) => s !== null)).toHaveLength(1)

    const coda = lettureDi('fatture_coda')
    expect(coda).toHaveLength(1)
    expect(coda[0].inPagamentoId).toBeNull()
    expect(new Set(coda[0].inScuolaId)).toEqual(new Set([SEDE_A, SEDE_B]))
    expect(coda[0].range).toEqual([0, 499])
    expect(coda[0].ordini).toEqual(['id asc'])
  })

  it('1200 voci attive: tre blocchi in SEQUENZA, contigui, tutte trovate, nessun «troncato»', async () => {
    h.db = dbCon(1200)
    h.db.fatture_coda = h.db.pagamenti.map((p, i) => voceCoda(i, p.id as string, p.scuola_id as string, i % 3 === 0 ? 'errore' : 'in_coda'))

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    const righe = j.data as RigaRisposta[]
    expect(righe).toHaveLength(1200)
    // Tutte: il finto rimescola la coda a ogni lettura, solo `order('id')` rende i blocchi disgiunti.
    expect(righe.filter((r) => r.coda_stato !== null)).toHaveLength(1200)
    expect(righe.filter((r) => r.coda_stato === 'errore')).toHaveLength(400)

    expect(lettureDi('fatture_coda').map((l) => l.range)).toEqual([[0, 499], [500, 999], [1000, 1499]])
    expect(eventi('coda-badge-troncato')).toHaveLength(0)
  })

  it('coda guasta con 2500 pagamenti: UNA lettura e UNA riga di log, non una per pezzo', async () => {
    h.db = dbCon(2500)
    h.guasto = (l) => (l.tabella === 'fatture_coda' ? { code: '08006', message: 'connection failure' } : null)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(2500)
    for (const r of j.data as RigaRisposta[]) expect(r.coda_stato).toBeNull()
    expect(lettureDi('fatture_coda')).toHaveLength(1)
    expect(eventi('coda-badge-non-letta')).toHaveLength(1)
  })
})

describe('GET /api/pagamenti — ramo genitore', () => {
  const FIGLI = ['al-f1', 'al-f2']

  it('1400 voci dei figli: 2 blocchi, `.in(alunno_id)` e la visibilità ritardata restano su ogni blocco', async () => {
    h.db = dbCon(0)
    h.db.pagamenti = [
      ...Array.from({ length: 1400 }, (_, i) => pagamento(i, { alunno_id: FIGLI[i % 2], visibile_dal: i % 5 === 0 ? '2026-01-01' : null })),
      // Non ancora pubblicate: fuori anche se sono dei figli.
      ...Array.from({ length: 60 }, (_, i) => pagamento(2000 + i, { alunno_id: 'al-f1', visibile_dal: '2999-01-01' })),
      // Di un altro bambino: fuori.
      ...Array.from({ length: 300 }, (_, i) => pagamento(3000 + i, { alunno_id: 'al-estraneo' })),
    ]
    comeGenitore(FIGLI)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    const righe = j.data as RigaRisposta[]
    expect(righe).toHaveLength(1400)
    expect(new Set(righe.map((r) => r.id)).size).toBe(1400)
    expect(righe.every((r) => Number(r.id.slice(3)) < 1400)).toBe(true)

    const pag = lettureDi('pagamenti')
    expect(pag.map((l) => l.range)).toEqual([[0, 999], [1000, 1999]])
    for (const l of pag) expect(l.ordini).toEqual(['scadenza desc', 'id asc'])
    // Il genitore non vede la coda.
    for (const r of righe) expect(r).not.toHaveProperty('coda_stato')
    expect(lettureDi('fatture_coda')).toHaveLength(0)
  })

  function conVociDivise() {
    h.db = dbCon(0)
    // 420 voci divise dei figli: 400 con la quota di QUESTO genitore, 20 senza.
    h.db.pagamenti = Array.from({ length: 420 }, (_, i) => pagamento(i, { alunno_id: FIGLI[i % 2], tipo: 'split', importo: 300 }))
    h.db.pagamenti_quote = h.db.pagamenti.slice(0, 400).map((p, i) => ({
      id: `q-${i}`,
      pagamento_id: p.id,
      adult_id: ID_GENITORE,
      importo: 100,
    }))
  }

  it('voci divise: le quote si leggono a pezzi di ≤150 id e si trovano TUTTE', async () => {
    conVociDivise()
    comeGenitore(FIGLI)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    const righe = j.data as RigaRisposta[]
    expect(righe).toHaveLength(400)
    for (const r of righe) {
      expect(r.quota_id).toMatch(/^q-/)
      expect(r.importo).toBe(100)
    }

    const quote = lettureDi('pagamenti_quote')
    expect(quote).toHaveLength(3)
    for (const l of quote) expect(l.inPagamentoId!.length).toBeLessThanOrEqual(150)
    expect(quote.reduce((s, l) => s + l.inPagamentoId!.length, 0)).toBe(420)
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('un pezzo di quote che fallisce: `logErrore evento:quote`, e SOLO le voci di quel pezzo spariscono', async () => {
    conVociDivise()
    comeGenitore(FIGLI)
    h.guasto = (l, n) => (l.tabella === 'pagamenti_quote' && n === 1 ? { code: '08006', message: 'connection failure' } : null)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    const righe = j.data as RigaRisposta[]

    const fallito = new Set(lettureDi('pagamenti_quote')[1].inPagamentoId)
    expect(fallito.size).toBe(150)
    const conQuota = new Set(h.db.pagamenti_quote.map((q) => q.pagamento_id as string))
    const attese = h.db.pagamenti.map((p) => p.id as string).filter((id) => conQuota.has(id) && !fallito.has(id))
    expect(righe.map((r) => r.id).sort()).toEqual(attese.sort())
    expect(righe.some((r) => fallito.has(r.id))).toBe(false)

    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(h.logErrore).toHaveBeenCalledWith(
      { operazione: 'pagamenti:GET', evento: 'quote' },
      expect.objectContaining({ code: '08006' }),
    )
  })
})
