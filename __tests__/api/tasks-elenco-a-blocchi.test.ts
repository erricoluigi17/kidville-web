import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * LA BACHECA DEI PROMEMORIA OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * `task_interni` non ha un filtro di data: la bacheca cresce per sempre, e il filtro di
 * visibilità sta in JavaScript (autore e assegnatari vivono nel JSON di `contenuto`). Oltre 1000
 * promemoria in una sede PostgREST ne consegnava i primi 1000, e il resto spariva dalla bacheca.
 * Il finto con `maxRighe: 1000` fa ciò che fa PostgREST.
 *
 * Il finto da solo è più gentile di PostgREST in due modi, e qui glieli si toglie (come in
 * `admin-parents-elenco-a-blocchi.test.ts`):
 *  · restituisce le righe sempre nello stesso ordine, mentre Postgres non garantisce l'ordine fra
 *    righe pari, né che resti lo stesso fra due richieste. Qui la tabella si rimescola a ogni
 *    richiesta (con un seme fisso: il test è ripetibile), così due pagine consecutive ordinate
 *    per una chiave NON unica si sovrappongono e perdono righe, come in produzione;
 *  · non sa far cadere UNA sola richiesta (`errori` vale per tutte): `h.guasto` fa cadere la
 *    N-esima lettura di una tabella, per provare che un blocco caduto in mezzo a blocchi riusciti
 *    dà 500 e non una bacheca a cui manca un pezzo.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
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
  requireDocente: h.requireDocente,
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

  /** Fisher-Yates sul posto: le righe della tabella cambiano ordine a ogni richiesta. */
  const rimescola = (righe: unknown[] | undefined) => {
    if (!righe) return
    for (let i = righe.length - 1; i > 0; i--) {
      const j = Math.floor(h.caso() * (i + 1))
      ;[righe[i], righe[j]] = [righe[j], righe[i]]
    }
  }

  /** La catena del finto, con l'errore di PostgREST al posto della risposta. */
  const guasta = (catena: Catena, errore: { code: string; message: string }): Catena =>
    new Proxy(catena, {
      get(t, p, r) {
        if (p === 'then') {
          return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve({
              data: null,
              error: { ...errore, details: null, hint: null },
              count: null,
              status: 500,
              statusText: '',
            }).then(ok, ko)
        }
        const v = Reflect.get(t, p, r)
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(t, args)
          return out === t ? guasta(t, errore) : out
        }
      },
    })

  const crea = async () => {
    const vero = creaFintoSupabase(h.db, [], { maxRighe: 1000 })
    return new Proxy(vero, {
      get(t, prop, ric) {
        if (prop !== 'from') return Reflect.get(t, prop, ric)
        return (tabella: string) => {
          rimescola(h.db[tabella])
          const n = (h.richieste[tabella] = (h.richieste[tabella] ?? 0) + 1)
          const catena = t.from(tabella) as unknown as Catena
          const g = h.guasto
          return g !== null && g.tabella === tabella && g.richiesta === n ? guasta(catena, g) : catena
        }
      },
    })
  }
  return { createAdminClient: crea, createClient: crea }
})
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))

import { GET } from '@/app/api/tasks/route'

const ADMIN = '11111111-1111-4111-8111-111111111111'
const N = 1005
// La route esige `userId` o `studentId` (400 altrimenti); l'identità vera la dà la sessione.
const richiesta = () => new NextRequest(`http://localhost/api/tasks?userId=${ADMIN}`)
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

const task = (id: string, scuola: string, creatoIl = '2026-10-20T08:00:00.000Z') => ({
  id,
  author_id: null,
  assigned_to: null,
  target_class: null,
  titolo: `T-${id.slice(0, 8)}`,
  contenuto: null,
  completato: false,
  created_at: creatoIl,
  scuola_id: scuola,
})

/** Le righe `evento: 'db'` / `'lettura-troncata'` scritte dalla route. */
const righeLog = (evento: string) => h.logErrore.mock.calls.filter(([c]) => (c as { evento?: string }).evento === evento)

beforeEach(() => {
  vi.clearAllMocks()
  // Tutti creati nello stesso istante: l'ordine fra pari lo decide la chiave unica, `id`.
  h.db = {
    utenti: [],
    task_interni: Array.from({ length: N }, (_, i) => task(uuid('d', i), SEDE_A)),
  }
  h.guasto = null
  h.richieste = {}
  h.tetto = null
  h.caso = generatore(20261025)
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/tasks — oltre le 1000 righe', () => {
  it('la direzione vede TUTTI i promemoria della sede, una volta sola ciascuno', async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j).toHaveLength(N)
    expect(new Set(j.map((t) => t.id)).size).toBe(N)
  })

  it('a parità di `created_at` l’ordine è quello di `id`: stabile da un blocco all’altro', async () => {
    const j = (await (await GET(richiesta())).json()) as { id: string }[]
    const attesi = h.db.task_interni.map((t) => t.id as string).sort()
    expect(j.map((t) => t.id)).toEqual(attesi)
  })

  it('con `created_at` diversi: il più recente per primo, poi `id` fra i pari', async () => {
    const giorni = ['2026-10-18T08:00:00.000Z', '2026-10-19T08:00:00.000Z', '2026-10-20T08:00:00.000Z']
    const righe = Array.from({ length: N }, (_, i) => task(uuid('d', i), SEDE_A, giorni[i % 3]))
    h.db.task_interni = righe
    const j = (await (await GET(richiesta())).json()) as { id: string }[]
    const attesi = [...righe]
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? 1 : -1))
      .map((t) => t.id)
    expect(j).toHaveLength(N)
    expect(j.map((t) => t.id)).toEqual(attesi)
  })

  it('legge a pagine: due richieste per 1005 righe, non una', async () => {
    await GET(richiesta())
    expect(h.richieste.task_interni).toBe(2)
  })
})

describe('GET /api/tasks — la sede resta quella dichiarata', () => {
  /** 1005 promemoria della sede A, più 60 della sede B. */
  const dueSedi = () => [
    ...Array.from({ length: N }, (_, i) => task(uuid('d', i), SEDE_A)),
    ...Array.from({ length: 60 }, (_, i) => task(uuid('b', i), SEDE_B)),
  ]

  it('con la sola sede A attiva i promemoria della sede B non entrano, e nessuno della A si perde', async () => {
    h.db.task_interni = dueSedi()
    const j = (await (await GET(richiesta())).json()) as { id: string }[]
    expect(j).toHaveLength(N)
    expect(j.every((t) => t.id.startsWith('d'))).toBe(true)
    expect(new Set(j.map((t) => t.id)).size).toBe(N)
  })

  it('con le due sedi attive: il totale delle due, la B non si perde dietro la A', async () => {
    h.db.task_interni = dueSedi()
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
    const j = (await (await GET(richiesta())).json()) as { id: string }[]
    expect(j).toHaveLength(N + 60)
    expect(j.filter((t) => t.id.startsWith('b'))).toHaveLength(60)
    expect(new Set(j.map((t) => t.id)).size).toBe(N + 60)
  })
})

describe('GET /api/tasks — UN blocco che cade fa cadere la bacheca intera', () => {
  const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' }

  it('il secondo blocco cade: 500 con un messaggio fisso e una riga `db`, mai 1000 promemoria su 1005', async () => {
    h.guasto = { tabella: 'task_interni', richiesta: 2, ...TIMEOUT }
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    // Il testo di PostgREST resta nel log: al client non torna, e nemmeno una lista parziale.
    expect(await res.json()).toEqual({ error: 'Lettura dei promemoria non riuscita' })
    expect(h.richieste.task_interni).toBe(2)
    expect(righeLog('db')).toHaveLength(1)
    expect(righeLog('db')[0][0]).toEqual({ operazione: 'tasks:GET', stato: 500, evento: 'db' })
    expect(righeLog('db')[0][1]).toMatchObject({ code: '57014' })
    // Nel log solo operazione, stato, evento e l'errore di PostgREST: nessuna riga di dati.
    expect(JSON.stringify(h.logErrore.mock.calls)).not.toContain('T-')
  })

  it('il primo blocco cade: 500, e la seconda pagina non parte nemmeno', async () => {
    h.guasto = { tabella: 'task_interni', richiesta: 1, ...TIMEOUT }
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Lettura dei promemoria non riuscita' })
    expect(h.richieste.task_interni).toBe(1)
    expect(righeLog('db')).toHaveLength(1)
  })

  it('il tetto di `leggiABlocchi` toccato: 500 e una riga `lettura-troncata` di soli numeri', async () => {
    h.tetto = { maxBlocchi: 1 }
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Lettura dei promemoria non riuscita' })
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    const [campi, errore] = h.logErrore.mock.calls[0]
    expect(campi).toEqual({ operazione: 'tasks:GET', stato: 500, evento: 'lettura-troncata' })
    expect((errore as Error).message).toBe(
      'lettura-troncata: tasks-bacheca oltre 1000 righe (1000 lette in 2 blocchi), rifiutata per intero',
    )
  })
})
