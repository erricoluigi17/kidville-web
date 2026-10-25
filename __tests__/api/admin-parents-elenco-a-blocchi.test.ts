import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

/**
 * L'ELENCO GENITORI OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * Il finto con `maxRighe: 1000` fa ciò che fa PostgREST: una lettura non restituisce mai più di
 * 1000 righe, e non lo dice. L'elenco legge gli alunni (di TUTTI gli stati), i legami e i
 * genitori: ognuna delle tre letture poteva uscire corta. La Prova della specifica è il
 * confronto qui sotto: il totale dell'elenco coincide con il `count(distinct parent_id)` dei
 * legami degli alunni delle stesse sedi.
 *
 * Il finto da solo è più gentile di PostgREST in due modi, e qui glieli si toglie entrambi
 * (`comePostgrest`, nel mock del client):
 *  · ordina per una colonna che non esiste senza dire niente, mentre Postgres risponde `42703`.
 *    `student_parents` non ha `id`: una lettura a blocchi dei legami senza la sua chiave
 *    `(student_id, parent_id)` in produzione è un 500, e qui deve esserlo anche nel test;
 *  · restituisce le righe sempre nello stesso ordine, mentre Postgres non garantisce l'ordine
 *    fra righe pari, né che resti lo stesso fra due richieste. Qui la tabella si rimescola a
 *    ogni richiesta (con un seme fisso: il test è ripetibile), così due pagine consecutive
 *    ordinate per una chiave NON unica si sovrappongono e perdono righe, come in produzione.
 * Più il guasto di UNA sola richiesta (`h.guasto`), che `errori` del finto non sa iniettare:
 * con quello si prova che un blocco caduto in mezzo a blocchi riusciti dà 500, non un elenco
 * a cui manca un pezzo.
 */

type Guasto = { tabella: string; richiesta: number; code: string; message: string }

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  /** La `richiesta`-esima lettura (da 1) di `tabella` risponde con questo errore. */
  guasto: null as { tabella: string; richiesta: number; code: string; message: string } | null,
  /** Quante letture sono partite, per tabella. */
  richieste: {} as Record<string, number>,
  /** Il generatore del rimescolamento, con un seme fisso (vedi `beforeEach`). */
  caso: Math.random as () => number,
  /** Il tetto iniettato in `leggiABlocchi` (il modulo VERO, che accetta già queste opzioni). */
  tetto: null as { blocco?: number; maxBlocchi?: number } | null,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireStaff: h.requireStaff,
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
}))
vi.mock('@/lib/db/leggi-a-blocchi', async (orig) => {
  const vero = await orig<typeof import('@/lib/db/leggi-a-blocchi')>()
  type Args = Parameters<typeof vero.leggiABlocchi>
  return {
    ...vero,
    leggiABlocchi: (c: Args[0], o: Args[1]) => vero.leggiABlocchi(c, h.tetto ? { ...o, ...h.tetto } : o),
  }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  type Catena = Record<string, unknown>
  type Errore = { code: string; message: string; details: null; hint: null }

  /** Fisher-Yates sul posto: le righe della tabella cambiano ordine a ogni richiesta. */
  const rimescola = (righe: unknown[] | undefined) => {
    if (!righe) return
    for (let i = righe.length - 1; i > 0; i--) {
      const j = Math.floor(h.caso() * (i + 1))
      ;[righe[i], righe[j]] = [righe[j], righe[i]]
    }
  }
  /** Le colonne che la tabella ha davvero: quelle delle sue righe nel finto. */
  const colonneDi = (tabella: string) => new Set((h.db[tabella] ?? []).flatMap((r) => Object.keys(r)))

  /** La catena del finto, con l'errore di Postgres al posto della risposta quando serve. */
  const comePostgrest = (tabella: string, catena: Catena, stato: { errore: Errore | null; http: number }): Catena =>
    new Proxy(catena, {
      get(t, p, r) {
        if (p === 'then' && stato.errore) {
          const errore = stato.errore
          return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: errore, count: null, status: stato.http, statusText: '' }).then(ok, ko)
        }
        const v = Reflect.get(t, p, r)
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          if (p === 'order' && !stato.errore && !colonneDi(tabella).has(String(args[0]))) {
            stato.errore = { code: '42703', message: `column ${tabella}.${String(args[0])} does not exist`, details: null, hint: null }
            stato.http = 400
          }
          const out = (v as (...a: unknown[]) => unknown).apply(t, args)
          return out === t ? comePostgrest(tabella, t, stato) : out
        }
      },
    })

  const crea = async () => {
    const vero = creaFintoSupabase(h.db, [], { maxRighe: 1000, errori: h.errori })
    return new Proxy(vero, {
      get(t, prop, ric) {
        if (prop !== 'from') return Reflect.get(t, prop, ric)
        return (tabella: string) => {
          rimescola(h.db[tabella])
          const n = (h.richieste[tabella] = (h.richieste[tabella] ?? 0) + 1)
          const g = h.guasto
          const colpita = g !== null && g.tabella === tabella && g.richiesta === n
          const stato = {
            errore: colpita ? { code: g.code, message: g.message, details: null, hint: null } : null,
            http: 500,
          }
          return comePostgrest(tabella, t.from(tabella) as unknown as Catena, stato)
        }
      },
    })
  }
  return { createAdminClient: crea, createClient: crea }
})

import { GET } from '@/app/api/admin/parents/route'

/** uuid sintetici: una lettera di prefisso e un numero, nient'altro. */
const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

/** mulberry32: abbastanza per rimescolare, e con lo stesso seme dà sempre lo stesso ordine. */
function generatore(seme: number): () => number {
  let s = seme >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const genitore = (id: string, i: number) => ({
  id, first_name: 'Nome-finto', last_name: `Cognome-finto-${i}`, emails: [], phone_numbers: [], fiscal_code: null,
})

function dbGrande(): DBFinto {
  // 1200 alunni nella sede A (metà ritirati: l'anagrafica li legge tutti) e 50 nella sede B.
  const alunni = [
    ...Array.from({ length: 1200 }, (_, i) => ({
      id: uuid('a', i), scuola_id: SEDE_A, stato: i % 2 === 0 ? 'iscritto' : 'ritirato',
    })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: uuid('b', i), scuola_id: SEDE_B, stato: 'iscritto' })),
  ]
  // Un genitore per alunno, e un secondo per i primi 400 della sede A: 1650 legami.
  const student_parents = [
    ...alunni.map((a, i) => ({ student_id: a.id, parent_id: uuid('c', i) })),
    ...alunni.slice(0, 400).map((a, i) => ({ student_id: a.id, parent_id: uuid('c', i + 1) })),
  ]
  const parents = alunni.map((_, i) => genitore(uuid('c', i), i))
  return { alunni, student_parents, parents }
}

/**
 * Pochi alunni, tanti legami: 60 alunni della sede C con 24 adulti ciascuno, 1440 legami in UN
 * blocco di `ID_PER_QUERY` alunni. Non è la forma della produzione (2-3 legami per alunno): è la
 * prova che la lettura di ogni blocco non si fida di quel rapporto. Con 24 legami per alunno il
 * confine della pagina (riga 1000) cade in mezzo ai legami di un alunno, quindi una chiave che
 * non fosse UNICA perderebbe righe proprio lì.
 */
function dbBloccoFitto(): DBFinto {
  const alunni = Array.from({ length: 60 }, (_, i) => ({ id: uuid('e', i), scuola_id: SEDE_C, stato: 'iscritto' }))
  const student_parents = alunni.flatMap((a, i) =>
    Array.from({ length: 24 }, (_, k) => ({ student_id: a.id, parent_id: uuid('f', i * 24 + k) })),
  )
  const parents = student_parents.map((l, i) => genitore(l.parent_id, i))
  return { alunni, student_parents, parents }
}

/** Il `count(distinct sp.parent_id)` della specifica, fatto sui dati finti. */
function genitoriDistinti(db: DBFinto, sedi: string[]): number {
  const alunniDelleSedi = new Set(
    db.alunni.filter((a) => sedi.includes(a.scuola_id as string)).map((a) => a.id),
  )
  return new Set(
    db.student_parents.filter((l) => alunniDelleSedi.has(l.student_id)).map((l) => l.parent_id),
  ).size
}

/** Le righe `evento: 'db'` scritte dalla route. */
const righeDb = () => h.logErrore.mock.calls.filter(([c]) => (c as { evento?: string }).evento === 'db')

const req = () => new NextRequest('http://localhost/api/admin/parents')

const TIMEOUT: Omit<Guasto, 'tabella' | 'richiesta'> = {
  code: '57014',
  message: 'canceling statement due to statement timeout',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbGrande()
  h.errori = {}
  h.guasto = null
  h.richieste = {}
  h.tetto = null
  h.caso = generatore(20261025)
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/admin/parents — oltre le 1000 righe', () => {
  it('il totale dell’elenco coincide con il count(distinct) dei legami della sede', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; scuole_ids: string[] }[]
    expect(j).toHaveLength(genitoriDistinti(h.db, [SEDE_A]))
    expect(j).toHaveLength(1200)
    expect(new Set(j.map((p) => p.id)).size).toBe(j.length)
    expect(j.every((p) => p.scuole_ids.length === 1 && p.scuole_ids[0] === SEDE_A)).toBe(true)
  })

  it('con due sedi attive: il totale delle due, e la sede B non si perde dietro la A', async () => {
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; scuole_ids: string[] }[]
    expect(j).toHaveLength(genitoriDistinti(h.db, [SEDE_A, SEDE_B]))
    expect(j).toHaveLength(1250)
    expect(j.filter((p) => p.scuole_ids.includes(SEDE_B))).toHaveLength(50)
  })

  it('un blocco di alunni con più di 1000 legami si legge per intero, ordinato per (student_id, parent_id)', async () => {
    h.db = dbBloccoFitto()
    h.resolveScuoleAttive.mockResolvedValue([SEDE_C])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; scuole_ids: string[] }[]
    expect(j).toHaveLength(genitoriDistinti(h.db, [SEDE_C]))
    expect(j).toHaveLength(1440)
    // Due pagine dello stesso blocco: la prova che la lettura del blocco è davvero a pagine.
    expect(h.richieste.student_parents).toBe(2)
  })

  it('una lettura dei legami che fallisce dà 500: mai un elenco a metà', async () => {
    h.errori = { student_parents: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(Array.isArray(await res.json())).toBe(false)
  })
})

describe('GET /api/admin/parents — UN blocco che cade fa cadere l’elenco intero', () => {
  it('il terzo blocco dei legami (su 12) cade: 500 con il messaggio di PostgREST e una riga `db`', async () => {
    h.guasto = { tabella: 'student_parents', richiesta: 3, ...TIMEOUT }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: TIMEOUT.message })
    // Gli altri blocchi sono partiti e riusciti: l'elenco a cui mancano 100 alunni c'era, e
    // non è uscito.
    expect(h.richieste.student_parents).toBe(12)
    expect(righeDb()).toHaveLength(1)
    // Nel log solo operazione, stato, evento e l'errore di PostgREST: nessuna riga di dati.
    expect(righeDb()[0][0]).toEqual({ operazione: 'admin/parents:GET', stato: 500, evento: 'db' })
    expect(righeDb()[0][1]).toMatchObject({ code: '57014' })
    expect(JSON.stringify(h.logErrore.mock.calls)).not.toContain('finto')
  })

  it('il secondo blocco dei genitori cade: 500, non 1100 genitori su 1200', async () => {
    h.guasto = { tabella: 'parents', richiesta: 2, ...TIMEOUT }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: TIMEOUT.message })
    expect(h.richieste.parents).toBe(12)
    expect(righeDb()).toHaveLength(1)
    expect(righeDb()[0][0]).toEqual({ operazione: 'admin/parents:GET', stato: 500, evento: 'db' })
    expect(righeDb()[0][1]).toMatchObject({ code: '57014' })
  })

  it('la seconda pagina degli alunni cade: 500, e i legami non si leggono nemmeno', async () => {
    h.guasto = { tabella: 'alunni', richiesta: 2, ...TIMEOUT }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: TIMEOUT.message })
    expect(h.richieste.student_parents).toBeUndefined()
    expect(righeDb()).toHaveLength(1)
    expect(righeDb()[0][0]).toEqual({ operazione: 'admin/parents:GET', stato: 500, evento: 'db' })
  })

  it('il tetto di `leggiABlocchi` toccato: 500 e una riga `lettura-troncata` di soli numeri', async () => {
    h.tetto = { maxBlocchi: 1 }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(Array.isArray(await res.json())).toBe(false)
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    const [campi, errore] = h.logErrore.mock.calls[0]
    expect(campi).toEqual({ operazione: 'admin/parents:GET', stato: 500, evento: 'lettura-troncata' })
    expect((errore as Error).message).toBe(
      'lettura-troncata: admin-parents-alunni oltre 1000 righe (1000 lette in 2 blocchi), rifiutata per intero',
    )
  })
})
