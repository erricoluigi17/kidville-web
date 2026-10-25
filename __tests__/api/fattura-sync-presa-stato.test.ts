import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'

/**
 * POST /api/pagamenti/fattura/sync — UN GIRO ALLA VOLTA, provato con lo STATO (sessione 8 della
 * seconda serie, D12; test portato dalla revisione indipendente).
 *
 * `fattura-sync-presa.test.ts` finge la presa e fa lanciare il database alla prima lettura: lì
 * «rilascio a giro finito» e «rilascio a giro in corso» non si distinguono, e togliendo l'`await`
 * da `return await giroSync(…)` il `finally` libererebbe la presa mentre il giro è ancora in volo
 * senza che nessun test se ne accorga. Qui la presa è VERA (`@/lib/cron/presa` non è finto) e il
 * database finto ha uno stato: `cron_presa_prendi`/`cron_presa_rilascia` imitano le due RPC della
 * migrazione `*_promemoria_e_sync_senza_doppioni.sql` col tempo del database controllabile, e la
 * lettura di `fatture_emesse` resta «in volo» finché il test non la libera.
 */

type Presa = { token: string | null; scade: number | null }
type ErroreFinto = { code: string; message: string }

class FintoDB {
  prese = new Map<string, Presa>()
  /** Il tempo del database, in millisecondi: lo sposta il test. */
  ora = 1_000_000
  rpcAssente = false
  erroreRpcPrendi: ErroreFinto | null = null
  erroreRpcRilascia: ErroreFinto | null = null
  chiamateRpc: string[] = []
  letture = 0
  lanciaSincrono = false
  private inVolo: Array<() => void> = []

  async rpc(nome: string, args: Record<string, unknown>) {
    this.chiamateRpc.push(nome)
    await Promise.resolve()
    if (this.rpcAssente) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${nome}` } }
    const job = String(args.p_job)
    if (!this.prese.has(job)) this.prese.set(job, { token: null, scade: null })
    const p = this.prese.get(job)!
    if (nome === 'cron_presa_prendi') {
      if (this.erroreRpcPrendi) return { data: null, error: this.erroreRpcPrendi }
      if (p.scade === null || p.scade < this.ora) {
        p.token = randomUUID()
        p.scade = this.ora + Number(args.p_durata_s) * 1000
        return { data: p.token, error: null }
      }
      return { data: null, error: null }
    }
    if (nome === 'cron_presa_rilascia') {
      if (this.erroreRpcRilascia) return { data: null, error: this.erroreRpcRilascia }
      if (args.p_token && p.token === args.p_token) {
        p.token = null
        p.scade = null
        return { data: true, error: null }
      }
      return { data: false, error: null }
    }
    return { data: null, error: { code: 'PGRST202', message: 'funzione sconosciuta' } }
  }

  /** Libera la lettura in volo più vecchia: risponde con un errore, e quel giro chiude 500. */
  liberaLaPrima() {
    this.inVolo.shift()?.()
  }

  /** Libera tutte le letture in volo. */
  liberaLetture() {
    const tutte = this.inVolo
    this.inVolo = []
    tutte.forEach((libera) => libera())
  }

  from(tabella: string) {
    if (this.lanciaSincrono) throw new Error('trasporto esploso')
    this.letture++
    const costruttore: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'not', 'limit', 'eq', 'is', 'order']) costruttore[m] = () => costruttore
    costruttore.then = (ok: (v: unknown) => void) => {
      new Promise<void>((libera) => this.inVolo.push(libera)).then(() =>
        ok({ data: null, error: { code: '57014', message: `lettura finta di ${tabella} fallita` } }))
    }
    return costruttore
  }

  presaLibera(job = 'fattura-sync') {
    const p = this.prese.get(job)
    return !p || p.scade === null || p.scade < this.ora
  }
}

const h = vi.hoisted(() => ({
  db: { current: null as unknown },
  creaLancia: false,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaGetByFilename: vi.fn() }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.creaLancia) throw new Error('chiave di servizio assente')
    return h.db.current
  },
}))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'

const req = (secret?: string) => new Request('http://localhost/api/pagamenti/fattura/sync', {
  method: 'POST',
  headers: secret ? { 'x-cron-secret': secret } : {},
})
/** Un giro di event loop abbondante: il POST arriva fino alla lettura e lì resta in volo. */
const tick = () => new Promise((r) => setTimeout(r, 5))

let db: FintoDB
beforeEach(() => {
  vi.clearAllMocks()
  db = new FintoDB()
  h.db.current = db
  h.creaLancia = false
  process.env.CRON_SECRET = 'topsecret'
})
afterEach(() => {
  delete process.env.CRON_SECRET
})

describe('sync SDI — presa con scadenza, con lo stato', () => {
  it('due giri insieme: il secondo salta (200), il primo tiene la presa FINCHÉ FINISCE; poi un terzo parte', async () => {
    const pA = POST(req('topsecret'))
    await tick()
    expect(db.letture).toBe(1)
    // Il giro A è in volo: la presa deve essere ancora sua. Senza l'`await` davanti a `giroSync`
    // il `finally` l'avrebbe già rilasciata qui.
    expect(db.presaLibera()).toBe(false)
    const rB = await POST(req('topsecret'))
    expect(rB.status).toBe(200)
    expect(await rB.json()).toEqual({ success: true, data: { saltato: 'presa-altrui' } })
    expect(db.letture).toBe(1)
    db.liberaLetture()
    const rA = await pA
    expect(rA.status).toBe(500)
    expect(db.presaLibera()).toBe(true)
    const pC = POST(req('topsecret'))
    await tick()
    expect(db.letture).toBe(2)
    db.liberaLetture()
    await pC
    expect(db.presaLibera()).toBe(true)
  })

  it('dieci giri simultanei: uno solo legge, gli altri nove saltano', async () => {
    const tutti = Array.from({ length: 10 }, () => POST(req('topsecret')))
    await tick()
    expect(db.letture).toBe(1)
    db.liberaLetture()
    const risposte = await Promise.all(tutti)
    expect(risposte.filter((r) => r.status === 200)).toHaveLength(9)
    expect(risposte.filter((r) => r.status === 500)).toHaveLength(1)
  })

  it('POST anonimo mentre un giro tiene la presa: 401, non «saltato», e nessuna RPC in più', async () => {
    const pA = POST(req('topsecret'))
    await tick()
    const r = await POST(req())
    expect(r.status).toBe(401)
    expect(db.chiamateRpc).toEqual(['cron_presa_prendi'])
    db.liberaLetture()
    await pA
  })

  it('giro più lungo della presa: B la prende alla scadenza, e il rilascio tardivo di A non libera quella di B', async () => {
    const pA = POST(req('topsecret'))
    await tick()
    db.ora += 331_000
    const pB = POST(req('topsecret'))
    await tick()
    expect(db.letture).toBe(2)
    const tokenB = db.prese.get('fattura-sync')!.token
    db.liberaLaPrima()
    await pA
    expect(db.prese.get('fattura-sync')!.token).toBe(tokenB)
    expect(db.presaLibera()).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'warn', { operazione: 'fattura-sync', esito: 'presa-gia-scaduta' })
    db.liberaLetture()
    await pB
    expect(db.presaLibera()).toBe(true)
  })

  it('eccezione dentro il giro dopo la presa: 500, e la presa si rilascia', async () => {
    db.lanciaSincrono = true
    const r = await POST(req('topsecret'))
    expect(r.status).toBe(500)
    expect(db.presaLibera()).toBe(true)
    expect(db.chiamateRpc).toEqual(['cron_presa_prendi', 'cron_presa_rilascia'])
  })

  it('RPC assente (DB della CI): il giro parte senza presa, nessun rilascio, riga info', async () => {
    db.rpcAssente = true
    const p = POST(req('topsecret'))
    await tick()
    expect(db.letture).toBe(1)
    db.liberaLetture()
    await p
    expect(db.chiamateRpc).toEqual(['cron_presa_prendi'])
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'info', { operazione: 'fattura-sync', esito: 'presa-senza-rpc' }, expect.objectContaining({ code: 'PGRST202' }),
    )
  })

  it('presa non verificabile: 503 col codice, nessuna lettura', async () => {
    db.erroreRpcPrendi = { code: '57014', message: 'canceling statement due to statement timeout' }
    const r = await POST(req('topsecret'))
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ codice: 'CRON_PRESA_NON_VERIFICATA' })
    expect(db.letture).toBe(0)
  })

  it('client admin che non si crea: 500 ERRORE_INTERNO, battito «cron», nessuna RPC', async () => {
    h.creaLancia = true
    const r = await POST(req('topsecret'))
    expect(r.status).toBe(500)
    expect(await r.json()).toMatchObject({ codice: 'ERRORE_INTERNO' })
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'fattura-sync', evento: 'cron', stato: 500 }), expect.any(Error),
    )
    expect(db.chiamateRpc).toEqual([])
  })

  it('rilascio fallito: la risposta resta quella del giro, la route non lancia', async () => {
    db.erroreRpcRilascia = { code: '08006', message: 'connessione persa' }
    const p = POST(req('topsecret'))
    await tick()
    db.liberaLetture()
    const r = await p
    expect(r.status).toBe(500)
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-rilasciata' }, expect.objectContaining({ code: '08006' }),
    )
  })
})
