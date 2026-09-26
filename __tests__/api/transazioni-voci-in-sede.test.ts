/**
 * `POST /api/pagamenti/transazioni` non incassa sulle rette di un'altra sede.
 *
 * IL DIFETTO (collaudo backend del 2026-07-31, rilievo F3 — **bloccante**).
 * La route validava soltanto la sede DICHIARATA (`sedi.includes(body.scuola_id)`);
 * i `pagamento_id` delle voci non venivano mai confrontati con quella sede, e la
 * RPC `registra_transazione_contabile` — l'unico punto atomico — valida quadratura
 * e importi ma non la provenienza (letto in `pg_get_functiondef`: nessun confronto
 * fra la sede della transazione e `pagamenti.scuola_id`).
 *
 * Il tester l'ha dimostrato incassando davvero, e poi ripristinando:
 *
 *   segreteria AVERSA → POST {scuola_id: <AVERSA>, voci:[{pagamento_id: <retta di GIUGLIANO>, importo: 1}]}
 *   → 200 {"incassi":1,"transazione_id":"ddcf2cc1-…"}
 *   DB dopo: pagamento di Giugliano  importo_pagato 0.00 → 1.00, stato scaduto → …
 *            transazione registrata su Aversa
 *            2 notifiche «pagamento registrato» spedite a genitori di Giugliano
 *
 * CAUSA RADICE: lo scope contabile era stato applicato al CONTENITORE (la
 * transazione) e non al CONTENUTO (le voci). `assertPagamentoInScope` esiste ed è
 * usato su ricevuta e sconto, ma non qui.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-07-31): togliendo il blocco di verifica delle
 * voci, il primo caso torna 200 e la RPC viene invocata — il test diventa rosso su
 * entrambe le asserzioni.
 *
 * COSA È CAMBIATO IL 2026-09-26 (K4, divisione per sede). La sede della voce non
 * si confronta più con quella DICHIARATA dal client: una famiglia con figli in
 * due plessi paga le voci di entrambi in una operazione, e la route la divide in
 * una transazione per sede. Il confine resta lo stesso, ma è lo SCOPE: una voce
 * di una sede non attiva per l'operatore è ancora 403, e la RPC non parte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const AVERSA = '22222222-2222-4222-8222-222222222222'
const GIUGLIANO = '33333333-3333-4333-8333-333333333333'
const RETTA_ALTRA_SEDE = '44444444-4444-4444-8444-444444444444'
const RETTA_PROPRIA = '55555555-5555-4555-8555-555555555555'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  rpcChiamate: [] as string[],
  sediPagamenti: new Map<string, string>(),
  erroreLettura: null as { code?: string; message?: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: h.resolveScuoleAttive,
  assertPagamentoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      // `insert` serve all'audit (`registro_modifiche`), scritto DOPO la RPC:
      // senza, la route lancia e risponde 500 a un incasso già registrato.
      for (const m of ['select', 'eq', 'order', 'limit', 'is', 'neq', 'gte', 'lte', 'insert']) qb[m] = () => qb
      qb.in = (_col: string, ids: string[]) => {
        if (tabella === 'pagamenti') {
          qb.then = (res: (v: unknown) => unknown) =>
            Promise.resolve(
              h.erroreLettura
                ? { data: null, error: h.erroreLettura }
                : { data: ids.map((id) => ({ id, scuola_id: h.sediPagamenti.get(id) ?? null })), error: null },
            ).then(res)
        }
        return qb
      }
      qb.maybeSingle = async () => ({ data: null, error: null })
      qb.single = async () => ({ data: null, error: null })
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return qb
    },
    rpc: async (nome: string) => {
      h.rpcChiamate.push(nome)
      if (nome === 'registra_transazioni_per_sede') {
        return { data: { transazioni: [{ transazione_id: 't-1' }, { transazione_id: 't-2' }] }, error: null }
      }
      return { data: { transazione_id: 't-1', incassi: 1 }, error: null }
    },
  })),
}))

import { POST } from '@/app/api/pagamenti/transazioni/route'

function richiesta(corpo: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pagamenti/transazioni', {
    method: 'POST',
    body: JSON.stringify(corpo),
    headers: { 'content-type': 'application/json' },
  })
}

function corpo(pagamentoId: string) {
  return {
    scuola_id: AVERSA,
    pagante_parent_id: '66666666-6666-4666-8666-666666666666',
    importo_totale: 1,
    metodo: 'contanti',
    voci: [{ pagamento_id: pagamentoId, importo: 1 }],
    ricariche_mensa: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rpcChiamate = []
  h.erroreLettura = null
  h.sediPagamenti = new Map([
    [RETTA_ALTRA_SEDE, GIUGLIANO],
    [RETTA_PROPRIA, AVERSA],
  ])
  h.requireStaff.mockResolvedValue({ user: { id: 'u-aversa', role: 'segreteria', scuola_id: AVERSA } })
  h.resolveScuoleAttive.mockResolvedValue([AVERSA])
})

describe('POST /api/pagamenti/transazioni — le VOCI devono stare nelle sedi ATTIVE dell\'operatore', () => {
  it('voce di un\'altra sede ⇒ 403 e la RPC non viene MAI invocata', async () => {
    const res = await POST(richiesta(corpo(RETTA_ALTRA_SEDE)))
    expect(res.status).toBe(403)
    // La RPC è atomica: se non parte, non esiste incasso, non esiste transazione,
    // non partono notifiche. È l'asserzione che conta più dello status.
    expect(h.rpcChiamate).toEqual([])
    // Il corpo non deve confermare l'esistenza del pagamento altrui.
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain(RETTA_ALTRA_SEDE)
  })

  it('voce della propria sede ⇒ il controllo lascia passare e la RPC viene invocata', async () => {
    // Ciò che il controllo di sede deve garantire è che una voce legittima arrivi
    // fino alla RPC. Dal 26/09 il finto emula anche l'`insert` dell'audit (le
    // notifiche e la revoca sono best-effort in try/catch), quindi si fissa pure
    // il 200: un controllo che lascia passare e poi fa morire la route non basta.
    const res = await POST(richiesta(corpo(RETTA_PROPRIA)))
    expect(h.rpcChiamate).toEqual(['registra_transazione_contabile'])
    expect(res.status).toBe(200)
  })

  it('voci di DUE sedi entrambe attive ⇒ ammesse: la RPC divisa per sede viene invocata', async () => {
    // Prima del 26/09 questo era un 403 «voci-fuori-sede»: la voce di Giugliano
    // non stava nella sede dichiarata (Aversa). Ora, se l'operatore ha attive
    // entrambe le sedi, l'operazione si divide in una transazione per sede.
    h.resolveScuoleAttive.mockResolvedValue([AVERSA, GIUGLIANO])
    const res = await POST(richiesta({
      ...corpo(RETTA_PROPRIA),
      importo_totale: 2,
      voci: [
        { pagamento_id: RETTA_PROPRIA, importo: 1 },
        { pagamento_id: RETTA_ALTRA_SEDE, importo: 1 },
      ],
    }))
    expect(h.rpcChiamate).toEqual(['registra_transazioni_per_sede'])
    // Ammesse vuol dire ammesse: l'operazione deve arrivare fino in fondo, non
    // solo passare il controllo di sede e poi morire dopo la RPC.
    expect(res.status).toBe(200)
  })

  it('voce di una sede attiva + voce di una sede NON attiva ⇒ ancora 403, nessuna RPC', async () => {
    const res = await POST(richiesta({
      ...corpo(RETTA_PROPRIA),
      importo_totale: 2,
      voci: [
        { pagamento_id: RETTA_PROPRIA, importo: 1 },
        { pagamento_id: RETTA_ALTRA_SEDE, importo: 1 },
      ],
    }))
    expect(res.status).toBe(403)
    expect(h.rpcChiamate).toEqual([])
  })

  it('lettura delle voci fallita ⇒ 500, mai «nessuna voce fuori sede»', async () => {
    // PostgREST non lancia: senza controllare `{ error }` un guasto di lettura
    // diventerebbe un permesso.
    h.erroreLettura = { code: '42501', message: 'permission denied' }
    const res = await POST(richiesta(corpo(RETTA_PROPRIA)))
    expect(res.status).toBe(500)
    expect(h.rpcChiamate).toEqual([])
  })
})
