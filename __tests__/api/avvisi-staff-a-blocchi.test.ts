import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * L'ARCHIVIO AVVISI DELLO STAFF OLTRE `max_rows` (robustezza 2, sessione 11).
 *
 * Allo staff gli avvisi scaduti non si nascondono (decisione del committente: il cockpit è anche
 * l'archivio), quindi l'elenco cresce per sempre. Oltre 1000 avvisi in una sede PostgREST ne
 * consegnava i primi 1000. Il finto con `maxRighe: 1000` fa ciò che fa PostgREST. Montaggio
 * ripreso da `avvisi-bacheca-docente.test.ts`.
 *
 * Il finto da solo è più gentile di PostgREST in due modi, e qui glieli si toglie (come in
 * `admin-parents-elenco-a-blocchi.test.ts`):
 *  · restituisce le righe sempre nello stesso ordine, mentre Postgres non garantisce l'ordine fra
 *    righe pari, né che resti lo stesso fra due richieste. Qui la tabella si rimescola a ogni
 *    richiesta (con un seme fisso: il test è ripetibile), così due pagine consecutive ordinate
 *    per una chiave NON unica si sovrappongono e perdono righe, come in produzione;
 *  · non sa far cadere UNA sola richiesta (`errori` vale per tutte): `h.guasto` fa cadere la
 *    N-esima lettura di una tabella, per provare che un blocco caduto in mezzo a blocchi riusciti
 *    dà 500 e non un archivio a cui manca un pezzo, e che il degrado di proiezione riparte da capo.
 */

type Guasto = { tabella: string; richiesta: number; code: string; message: string }

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
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

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: vi.fn(),
}))
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v,
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
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
    const vero = creaFintoSupabase(h.db, [], { errori: h.errori, maxRighe: 1000 })
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
  return { createAdminClient: crea }
})

import { GET } from '@/app/api/avvisi/route'

const SEGRETERIA = 'seg-1'
const N = 1005
const uuid = (prefisso: string, i: number) => `${prefisso}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`

const req = (query = '') => ({
  url: `http://test/api/avvisi${query}`,
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams(query.replace(/^\?/, '')) },
  cookies: { get: () => undefined },
}) as never

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

const avviso = (
  id: string,
  scuola = SEDE_A,
  // Tutti nello stesso istante: l'ordine fra pari lo decide la chiave unica, `id`.
  creatoIl = '2026-10-05T08:00:00.000Z',
  scope: 'globale' | 'classe' = 'globale',
) => ({
  id,
  author_id: SEGRETERIA,
  titolo: id,
  contenuto: 'c',
  tipo: 'presa_visione',
  target_scope: scope,
  target_classes: scope === 'classe' ? ['3 ANNI'] : null,
  scadenza: null,
  scadenza_avviso: '2026-12-31T22:59:59.999Z',
  scadenza_adesione: null,
  chiedi_numero: false,
  etichetta_numero: null,
  numero_min: 1,
  numero_max: 20,
  posti_totali: null,
  attachment_url: null,
  form_model_id: null,
  created_at: creatoIl,
  scuola_id: scuola,
})

const dbGrande = (): DBFinto => ({
  utenti: [{ id: SEGRETERIA, first_name: SEGRETERIA, last_name: 'X', role: 'segreteria', ruolo: 'segreteria', nome: null, cognome: null }],
  avvisi_risposte: [],
  utenti_sezioni: [],
  avvisi: Array.from({ length: N }, (_, i) => avviso(uuid('e', i))),
})

/** Le righe di `logErrore` con quell'`evento`. */
const righeLog = (evento: string) => h.logErrore.mock.calls.filter(([c]) => (c as { evento?: string }).evento === evento)

const TIMEOUT: Omit<Guasto, 'tabella' | 'richiesta'> = {
  code: '57014',
  message: 'canceling statement due to statement timeout',
}
const COLONNA_MANCANTE: Omit<Guasto, 'tabella' | 'richiesta'> = {
  code: '42703',
  message: 'column avvisi.posti_totali does not exist',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbGrande()
  h.errori = {}
  h.guasto = null
  h.richieste = {}
  h.tetto = null
  h.caso = generatore(20261025)
  h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

describe('GET /api/avvisi — l’archivio dello staff oltre le 1000 righe', () => {
  it('la segreteria vede TUTTI gli avvisi della sede, una volta sola ciascuno, in ordine stabile', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as { id: string }[]).map((a) => a.id)
    expect(ids).toHaveLength(N)
    expect(new Set(ids).size).toBe(N)
    expect(ids).toEqual([...ids].sort())
  })

  it('una lettura che fallisce dà 500 con il log `db`: mai un archivio a metà', async () => {
    h.errori = { avvisi: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }),
      expect.anything(),
    )
  })

  it('con `created_at` diversi: il più recente per primo, poi `id` fra i pari', async () => {
    const giorni = ['2026-10-03T08:00:00.000Z', '2026-10-04T08:00:00.000Z', '2026-10-05T08:00:00.000Z']
    const righe = Array.from({ length: N }, (_, i) => avviso(uuid('e', i), SEDE_A, giorni[i % 3]))
    h.db.avvisi = righe
    const ids = ((await (await GET(req())).json()) as { id: string }[]).map((a) => a.id)
    const attesi = [...righe]
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? 1 : -1))
      .map((a) => a.id)
    expect(ids).toHaveLength(N)
    expect(ids).toEqual(attesi)
  })

  it('legge a pagine: due richieste per 1005 righe, non una', async () => {
    await GET(req())
    expect(h.richieste.avvisi).toBe(2)
  })
})

describe('GET /api/avvisi — l’archivio resta quello della sede e del filtro dichiarati', () => {
  /** 1005 avvisi della sede A, più 60 della sede B. */
  const dueSedi = () => [
    ...Array.from({ length: N }, (_, i) => avviso(uuid('e', i), SEDE_A)),
    ...Array.from({ length: 60 }, (_, i) => avviso(uuid('b', i), SEDE_B)),
  ]

  it('con la sola sede A attiva gli avvisi della sede B non entrano, e nessuno della A si perde', async () => {
    h.db.avvisi = dueSedi()
    const ids = ((await (await GET(req())).json()) as { id: string }[]).map((a) => a.id)
    expect(ids).toHaveLength(N)
    expect(ids.every((id) => id.startsWith('e'))).toBe(true)
    expect(new Set(ids).size).toBe(N)
  })

  it('con le due sedi attive: il totale delle due, la B non si perde dietro la A', async () => {
    h.db.avvisi = dueSedi()
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
    const ids = ((await (await GET(req())).json()) as { id: string }[]).map((a) => a.id)
    expect(ids).toHaveLength(N + 60)
    expect(ids.filter((id) => id.startsWith('b'))).toHaveLength(60)
    expect(new Set(ids).size).toBe(N + 60)
  })

  it('`?scope=` resta un filtro del server: gli avvisi di classe sono solo 30, i globali 1005 per intero', async () => {
    h.db.avvisi = [
      ...Array.from({ length: N }, (_, i) => avviso(uuid('e', i), SEDE_A, undefined, 'globale')),
      ...Array.from({ length: 30 }, (_, i) => avviso(uuid('c', i), SEDE_A, undefined, 'classe')),
    ]
    const classe = (await (await GET(req('?scope=classe'))).json()) as { id: string }[]
    expect(classe).toHaveLength(30)
    expect(classe.every((a) => a.id.startsWith('c'))).toBe(true)
    const globali = (await (await GET(req('?scope=globale'))).json()) as { id: string }[]
    expect(globali).toHaveLength(N)
    expect(globali.every((a) => a.id.startsWith('e'))).toBe(true)
  })
})

describe('GET /api/avvisi — il degrado di proiezione riparte da capo, a blocchi', () => {
  it('colonne del cantiere A2 assenti: la proiezione storica legge TUTTI i 1005 avvisi e il warn li conta', async () => {
    // La prima richiesta (la proiezione completa) risponde 42703; le due del ripiego riescono.
    h.guasto = { tabella: 'avvisi', richiesta: 1, ...COLONNA_MANCANTE }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as { id: string }[]).map((a) => a.id)
    expect(ids).toHaveLength(N)
    expect(new Set(ids).size).toBe(N)
    // 1 (fallita) + 2 pagine del ripiego.
    expect(h.richieste.avvisi).toBe(3)
    // Il degrado si dichiara, con il solo conteggio delle righe senza il booleano calcolato.
    const degradi = h.logEvento.mock.calls.filter(([, , c]) => (c as { esito?: string }).esito === 'degrado-proiezione-capienza-spenta')
    expect(degradi).toHaveLength(1)
    expect(degradi[0]).toEqual(['avvisi', 'warn', { operazione: 'avvisi:GET', esito: 'degrado-proiezione-capienza-spenta', n: N }])
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('anche il ripiego fallisce: 500 con il messaggio di PostgREST, due sole richieste', async () => {
    h.errori = { avvisi: COLONNA_MANCANTE }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: COLONNA_MANCANTE.message })
    expect(h.richieste.avvisi).toBe(2)
    expect(righeLog('db')).toHaveLength(1)
  })

  it('un errore che NON è una colonna mancante non apre nessun ripiego: una richiesta, nessun degrado', async () => {
    h.errori = { avvisi: TIMEOUT }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: TIMEOUT.message })
    expect(h.richieste.avvisi).toBe(1)
    expect(h.logEvento).not.toHaveBeenCalledWith('avvisi', 'warn', expect.objectContaining({ esito: 'degrado-proiezione-capienza-spenta' }))
  })
})

describe('GET /api/avvisi — UN blocco che cade fa cadere l’archivio intero', () => {
  it('il secondo blocco cade: 500 con una riga `db`, mai 1000 avvisi su 1005', async () => {
    h.guasto = { tabella: 'avvisi', richiesta: 2, ...TIMEOUT }
    const res = await GET(req())
    expect(res.status).toBe(500)
    // Il corpo resta quello di prima della sessione 11: il `message` di PostgREST.
    expect(await res.json()).toEqual({ error: TIMEOUT.message })
    expect(h.richieste.avvisi).toBe(2)
    expect(righeLog('db')).toHaveLength(1)
    expect(righeLog('db')[0][0]).toEqual({ operazione: 'avvisi:GET', stato: 500, evento: 'db' })
    expect(righeLog('db')[0][1]).toMatchObject({ code: '57014' })
    // Nessun avviso cade nel log: solo operazione, stato, evento e l'errore di PostgREST.
    expect(JSON.stringify(h.logErrore.mock.calls)).not.toContain('e000')
    // Un errore di timeout non è una colonna mancante: nessun ripiego, nessun degrado dichiarato.
    expect(h.logEvento).not.toHaveBeenCalledWith('avvisi', 'warn', expect.objectContaining({ esito: 'degrado-proiezione-capienza-spenta' }))
  })

  it('il tetto di `leggiABlocchi` toccato: 500 e una riga `lettura-troncata` di soli numeri', async () => {
    h.tetto = { maxBlocchi: 1 }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Gli avvisi non si sono potuti leggere per intero.' })
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    const [campi, errore] = h.logErrore.mock.calls[0]
    expect(campi).toEqual({ operazione: 'avvisi:GET', stato: 500, evento: 'lettura-troncata' })
    expect((errore as Error).message).toBe(
      'lettura-troncata: avvisi-staff oltre 1000 righe (1000 lette in 2 blocchi), rifiutata per intero',
    )
  })
})
