import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * `POST /api/pagamenti/fattura/coda/azioni` — «Togli» e «Rimetti in coda» (nucleo §3).
 * La coda si legge da tutte le sedi, ma si scrive SOLO sulle proprie: scope per voce.
 * Uuid finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ requireStaff: vi.fn(), scuole: vi.fn(), sb: null as unknown, logEvento: vi.fn() }))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// D2 (consegna 2b): il finto sostituisce SOLO `logEvento`; lo spread lascia vero `rigaEvento`,
// che è la parte decidibile del logging (messaggio, bersaglio, campi redatti).
vi.mock('@/lib/logging/logger', async (o) => ({
  ...(await o<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/auth/scope', async (originale) => {
  const actual = await originale<typeof import('@/lib/auth/scope')>()
  return { ...actual, scuoleDiUtente: h.scuole }
})
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.sb }))

import { POST } from '@/app/api/pagamenti/fattura/coda/azioni/route'
import { CODICI_ERRORE_CODA } from '@/lib/fatture-coda/api'
import { rigaEvento } from '@/lib/logging/logger'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SEDE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const STAFF = uuid(7000)

type Rpc = Record<string, (args: Riga) => RispostaRpc>
let db: DBFinto
let rpcChiamate: { nome: string; args: Riga }[]

function monta(opzioni: { errori?: Record<string, { code: string }>; rpc?: Rpc } = {}) {
  rpcChiamate = []
  const rpc: Rpc = {
    fatture_coda_togli: (a) => ({ data: (a.p_ids as string[]).length, error: null }),
    fatture_coda_rimetti: (a) => ({ data: (a.p_ids as string[]).length, error: null }),
    fatture_coda_tick_http: () => ({ data: null, error: null }),
    ...(opzioni.rpc ?? {}),
  }
  h.sb = creaFintoSupabase(db, [], {
    errori: opzioni.errori,
    rpc: Object.fromEntries(
      Object.entries(rpc).map(([nome, impl]) => [
        nome,
        (args: Riga) => {
          rpcChiamate.push({ nome, args })
          return impl(args)
        },
      ]),
    ),
  })
}
const rpcDi = (nome: string) => rpcChiamate.filter((c) => c.nome === nome)

function post(corpo: unknown): Request {
  return new Request('http://localhost/api/pagamenti/fattura/coda/azioni', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db = {
    fatture_coda: [
      { id: uuid(1), stato: 'errore', scuola_id: SEDE_A },
      { id: uuid(2), stato: 'in_coda', scuola_id: SEDE_A },
      { id: uuid(3), stato: 'errore', scuola_id: SEDE_A },
      { id: uuid(9), stato: 'errore', scuola_id: SEDE_B },
    ],
  }
  monta()
  h.requireStaff.mockResolvedValue({ user: { id: STAFF, role: 'segreteria', scuola_id: SEDE_A } })
  h.scuole.mockResolvedValue([SEDE_A])
})

describe('gate e validazione', () => {
  it('401 e 403 dal gate: nessuna RPC', async () => {
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await POST(post({ azione: 'togli', ids: [uuid(1)] }))).status).toBe(401)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    expect((await POST(post({ azione: 'togli', ids: [uuid(1)] }))).status).toBe(403)
    expect(rpcChiamate).toEqual([])
  })

  it('zod: azione sconosciuta, 0 id, 501 id ⇒ 400', async () => {
    expect((await POST(post({ azione: 'cancella', ids: [uuid(1)] }))).status).toBe(400)
    expect((await POST(post({ azione: 'togli', ids: [] }))).status).toBe(400)
    const troppi = Array.from({ length: 501 }, (_, i) => uuid(i + 1))
    expect((await POST(post({ azione: 'togli', ids: troppi }))).status).toBe(400)
    expect(rpcChiamate).toEqual([])
  })

  it('500 id passano la validazione', async () => {
    h.scuole.mockResolvedValue([SEDE_A, SEDE_B])
    const tanti = Array.from({ length: 500 }, (_, i) => uuid(i + 1))
    const res = await POST(post({ azione: 'togli', ids: tanti }))
    expect(res.status).toBe(200)
    // Solo le voci che esistono arrivano alla RPC.
    expect(rpcDi('fatture_coda_togli')[0].args.p_ids).toEqual([uuid(1), uuid(2), uuid(3), uuid(9)])
  })
})

describe('scope di sede per voce', () => {
  it('una voce di un’altra sede in mezzo ⇒ 403 SEDE_NON_ACCESSIBILE, niente scrittura', async () => {
    const res = await POST(post({ azione: 'togli', ids: [uuid(1), uuid(9), uuid(2)] }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(rpcDi('fatture_coda_togli')).toEqual([])
  })

  it('l’admin con entrambe le sedi può toccarle tutte', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: STAFF, role: 'admin', scuola_id: SEDE_A } })
    h.scuole.mockResolvedValue([SEDE_A, SEDE_B])
    const res = await POST(post({ azione: 'togli', ids: [uuid(1), uuid(9)] }))
    expect(res.status).toBe(200)
    expect(rpcDi('fatture_coda_togli')[0].args.p_ids).toEqual([uuid(1), uuid(9)])
  })

  it('gli id inesistenti non arrivano alla RPC', async () => {
    const res = await POST(post({ azione: 'togli', ids: [uuid(1), uuid(404)] }))
    expect(res.status).toBe(200)
    expect(rpcDi('fatture_coda_togli')[0].args).toEqual({ p_ids: [uuid(1)], p_attore: STAFF })
    expect(await res.json()).toEqual({ aggiornate: 1 })
  })

  it('nessuna voce trovata ⇒ {aggiornate:0} senza RPC', async () => {
    const res = await POST(post({ azione: 'rimetti', ids: [uuid(404)] }))
    expect(await res.json()).toEqual({ aggiornate: 0 })
    expect(rpcChiamate).toEqual([])
  })
})

describe('togli e rimetti', () => {
  it('togli: RPC fatture_coda_togli con l’attore, niente sveglia', async () => {
    const res = await POST(post({ azione: 'togli', ids: [uuid(1), uuid(2)] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ aggiornate: 2 })
    expect(rpcDi('fatture_coda_togli')[0].args).toEqual({ p_ids: [uuid(1), uuid(2)], p_attore: STAFF })
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })

  it('rimetti: RPC fatture_coda_rimetti, poi la sveglia', async () => {
    const res = await POST(post({ azione: 'rimetti', ids: [uuid(1), uuid(3)] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ aggiornate: 2 })
    expect(rpcDi('fatture_coda_rimetti')[0].args).toEqual({ p_ids: [uuid(1), uuid(3)], p_attore: STAFF })
    await vi.waitFor(() => expect(rpcDi('fatture_coda_tick_http')).toHaveLength(1))
  })

  it('rimetti che non cambia niente (0) ⇒ nessuna sveglia', async () => {
    monta({ rpc: { fatture_coda_rimetti: () => ({ data: 0, error: null }) } })
    const res = await POST(post({ azione: 'rimetti', ids: [uuid(2)] }))
    expect(await res.json()).toEqual({ aggiornate: 0 })
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })
})

describe('DB non migrato e guasti', () => {
  it.each(['PGRST205', '42P01'])('tabella assente (%s) ⇒ 503 CODA_FATTURE_NON_DISPONIBILE', async (code) => {
    monta({ errori: { fatture_coda: { code } } })
    const res = await POST(post({ azione: 'togli', ids: [uuid(1)] }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.NON_DISPONIBILE)
  })

  it('RPC assente (PGRST202) ⇒ 503', async () => {
    monta({ rpc: { fatture_coda_togli: () => ({ data: null, error: { code: 'PGRST202' } }) } })
    const res = await POST(post({ azione: 'togli', ids: [uuid(1)] }))
    expect(res.status).toBe(503)
  })

  it('errore di lettura qualunque ⇒ 500 LETTURA_FALLITA', async () => {
    monta({ errori: { fatture_coda: { code: '57014' } } })
    const res = await POST(post({ azione: 'togli', ids: [uuid(1)] }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
  })

  it('errore della RPC ⇒ 500 CODA_FATTURE_SCRITTURA_FALLITA', async () => {
    monta({ rpc: { fatture_coda_rimetti: () => ({ data: null, error: { code: 'XX000' } }) } })
    const res = await POST(post({ azione: 'rimetti', ids: [uuid(1)] }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.SCRITTURA_FALLITA)
    expect(rpcDi('fatture_coda_tick_http')).toEqual([])
  })
})

/**
 * D2 (consegna 2b): «Togli» e «Rimetti» loggano l'ATTORE, e le due azioni non si sommano nella
 * stessa riga di `app_log`. Il gate mette già l'attore nella colonna `utente_id`; il campo
 * `utente` lo rende leggibile e verificabile, `distingui: ['operazione']` tiene separate togli e
 * rimetti, che senza avrebbero la stessa impronta (stesso messaggio, route e utente).
 */
describe('D2: l’attore nei log, togli e rimetti su righe diverse', () => {
  const chiamataCon = (esito: string) => h.logEvento.mock.calls.find((c) => (c[2] as Riga).esito === esito)

  it('togli porta l’attore e distingue per operazione', async () => {
    await POST(post({ azione: 'togli', ids: [uuid(1), uuid(2)] }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'fattura',
      'info',
      expect.objectContaining({ operazione: 'coda-azioni:togli', esito: 'azione-eseguita', utente: STAFF }),
      undefined,
      { distingui: ['operazione'] },
    )
    const [evento, livello, campi, err, opzioni] = chiamataCon('azione-eseguita')!
    const riga = rigaEvento(evento, livello, campi, err, opzioni)
    expect(riga?.bersaglio).toBe('operazione=coda-azioni:togli')
    expect((riga?.contestoExtra as { campi: Riga }).campi.utente).toBe(STAFF)
  })

  it('togli e rimetti: impronte diverse', async () => {
    await POST(post({ azione: 'togli', ids: [uuid(1)] }))
    const togli = chiamataCon('azione-eseguita')!
    h.logEvento.mockClear()
    await POST(post({ azione: 'rimetti', ids: [uuid(3)] }))
    const rimetti = chiamataCon('azione-eseguita')!
    expect(rimetti[2]).toEqual(expect.objectContaining({ operazione: 'coda-azioni:rimetti', utente: STAFF }))
    const bT = rigaEvento(togli[0], togli[1], togli[2], togli[3], togli[4])?.bersaglio
    const bR = rigaEvento(rimetti[0], rimetti[1], rimetti[2], rimetti[3], rimetti[4])?.bersaglio
    expect(bR).toBe('operazione=coda-azioni:rimetti')
    expect(bR).not.toBe(bT)
  })

  it('errore della RPC: il log error azione-fallita porta l’attore e distingue', async () => {
    const guasto = { code: 'XX000' }
    monta({ rpc: { fatture_coda_rimetti: () => ({ data: null, error: guasto }) } })
    await POST(post({ azione: 'rimetti', ids: [uuid(1)] }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'fattura',
      'error',
      expect.objectContaining({ operazione: 'coda-azioni:rimetti', esito: 'azione-fallita', utente: STAFF }),
      expect.objectContaining({ code: 'XX000' }),
      { distingui: ['operazione'] },
    )
  })

  it('nessuna voce trovata: il log info porta l’attore', async () => {
    await POST(post({ azione: 'rimetti', ids: [uuid(404)] }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'fattura',
      'info',
      expect.objectContaining({ operazione: 'coda-azioni:rimetti', esito: 'nessuna-voce-trovata', utente: STAFF }),
      undefined,
      { distingui: ['operazione'] },
    )
  })
})
