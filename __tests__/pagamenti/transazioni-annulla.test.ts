import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/transazioni/[id]/annulla — annullo ATOMICO via RPC (ciclo 2).
//  L'annullo non enumera più a mano incassi/credito (che dimenticava le RICARICHE
//  MENSA): delega tutto alla RPC `annulla_transazione_contabile`, che storna in una
//  sola transazione incassi + ricariche mensa (saldo ticket) + eccedenza a credito.
//  Contratto verificato:
//   (a) annullo con ricarica mensa → chiama la RPC; payload = { transazione_id, motivo }
//   (b) RPC assente (PGRST202/42883) → 503 pulito, senza storni parziali
//   (c) motivo mancante/troppo corto → 400
//   (d) doppio annullo → 409 (sia pre-check sia EXCEPTION KV409 della RPC)
//   + credito eccedenza già speso (KV410) → 409; transazione non trovata → 404.
//
//  (f) 2026-09-12 — LA QUARTA CLASSE: il movimento bancario riaperto.
//   Da `20260912180200_annulla_transazione_riapre_movimento.sql` la RPC riapre
//   anche il movimento dell'estratto conto legato alla transazione e ne restituisce
//   il conteggio (`movimenti_riaperti`). Quel numero deve ARRIVARE da qualche parte:
//   l'UPDATE cancella `confermato_da`/`confermato_il`, cioè si perde chi aveva
//   confermato quel bonifico, mentre il verso opposto (la conferma) scrive
//   `logScrittura`. Con il conteggio letto da nessuno, una riapertura che tocca 0
//   righe dove doveva toccarne 1 non lascerebbe traccia in nessun posto — ed è la
//   regola 5 del logging (AGENTS): gli eventi critici loggano anche il SUCCESSO.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  revoca: vi.fn(),
  annullaRic: vi.fn(),
  rpc: vi.fn(),
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  tx: null as Record<string, unknown> | null,
  txErr: null as { code: string } | null,
  incassiRevoca: [] as Record<string, unknown>[],
  pagamentiRevoca: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
  logCalls: [] as unknown[][],
}))

vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.logCalls.push(a),
  logErrore: (...a: unknown[]) => h.logCalls.push(a),
  logEvento: (...a: unknown[]) => h.logCalls.push(a),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
vi.mock('@/lib/pagamenti/ricevute', () => ({ annullaRicevutaTransazioneAttiva: (...a: unknown[]) => h.annullaRic(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.maybeSingle = async () =>
        table === 'pagamenti_transazioni' ? { data: h.tx, error: h.txErr } : { data: null, error: null }
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); return { then: (res: (v: unknown) => unknown) => res({ data: null, error: null }) } }
      b.update = (row: unknown) => { h.updates.push({ table, row }); return { eq: () => ({ then: (res: (v: unknown) => unknown) => res({ data: null, error: null }) }) } }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'incassi') return resolve({ data: h.incassiRevoca, error: null })
        if (table === 'pagamenti') return resolve({ data: h.pagamentiRevoca, error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      return h.rpc(name, args)
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/transazioni/[id]/annulla/route'

const SC = '22222222-2222-4222-8222-222222222222'
const PARENT = '33333333-3333-4333-8333-333333333333'
const TX = '77777777-7777-4777-8777-777777777777'
const ctx = { params: Promise.resolve({ id: TX }) }
const post = (body: unknown) =>
  new Request(`http://localhost/api/pagamenti/transazioni/${TX}/annulla`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
  h.revoca.mockResolvedValue({ revocati: [] })
  h.annullaRic.mockResolvedValue(undefined)
  h.rpc.mockResolvedValue({ data: { incassi_stornati: 2, ricariche_stornate: 1, credito_stornato: 0, ticket_gia_consumati: false }, error: null })
  h.tx = { id: TX, scuola_id: SC, pagante_parent_id: PARENT, importo_totale: 200, annullata_il: null }
  h.txErr = null
  h.incassiRevoca = [{ pagamento_id: 'pag-1' }]
  h.pagamentiRevoca = [{ alunno_id: 'alu-1' }]
  h.inserts = []; h.updates = []; h.rpcCalls = []; h.logCalls = []
})

/** L'evento di successo dell'annullo, fra le chiamate al logger (withRoute logga le sue). */
const eventoAnnullo = () =>
  h.logCalls.find((c) => (c[2] as { esito?: string } | undefined)?.esito === 'transazione_annullata')?.[2] as
    | Record<string, unknown>
    | undefined
/** La riga d'audit scritta in `registro_modifiche`. */
const audit = () =>
  (h.inserts.find((i) => i.table === 'registro_modifiche')?.row ?? {}) as { nuovo_valore?: Record<string, unknown> }

describe('POST annulla transazione — via RPC atomica', () => {
  it('(c) senza motivo → 400 (RPC non chiamata)', async () => {
    const res = await POST(post({}), ctx)
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(c) motivo troppo corto → 400', async () => {
    const res = await POST(post({ motivo: 'x' }), ctx)
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(a) annullo con ricarica mensa → chiama la RPC; payload include transazione_id+motivo', async () => {
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].name).toBe('annulla_transazione_contabile')
    const payload = h.rpcCalls[0].args.p as Record<string, unknown>
    expect(payload.transazione_id).toBe(TX)
    expect(payload.motivo).toBe('errore di registrazione')
    // i conteggi della RPC (incl. ricariche mensa stornate) tornano al chiamante
    const body = await res.json()
    expect(body.data.ricariche_stornate).toBe(1)
    expect(body.data.incassi_stornati).toBe(2)
    // ricevuta famiglia annullata come oggi
    expect(h.annullaRic).toHaveBeenCalledTimes(1)
  })

  it('(b) RPC assente (PGRST202) → 503 pulito senza storni parziali', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(503)
    expect(h.annullaRic).not.toHaveBeenCalled()
  })

  it('(b bis) RPC assente (42883) → 503', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'undefined function' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(503)
  })

  it('(d) doppio annullo (tx già annullata, pre-check) → 409, RPC non chiamata', async () => {
    h.tx = { id: TX, scuola_id: SC, pagante_parent_id: PARENT, importo_totale: 200, annullata_il: '2026-07-18T10:00:00Z' }
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('(d bis) doppio annullo in gara (RPC KV409) → 409', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'KV409', message: 'transazione già annullata' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
  })

  it('credito eccedenza già speso (RPC KV410) → 409 senza annullare la ricevuta', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'KV410', message: 'credito già utilizzato' } })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
    expect(h.annullaRic).not.toHaveBeenCalled()
  })

  it('transazione non trovata → 404 (RPC non chiamata)', async () => {
    h.tx = null
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('scope di sede diverso → 404', async () => {
    h.scope.mockResolvedValue(['99999999-9999-4999-8999-999999999999'])
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('🔴 (f) il movimento bancario riaperto ARRIVA a destinazione: risposta, audit e log di successo', async () => {
    h.rpc.mockResolvedValue({
      data: { incassi_stornati: 2, ricariche_stornate: 0, credito_stornato: 0, ticket_gia_consumati: false, movimenti_riaperti: 1 },
      error: null,
    })
    const res = await POST(post({ motivo: 'bonifico di un altro plesso' }), ctx)
    expect(res.status).toBe(200)

    // 1) all'OPERATORE: «annullata; 1 movimento bancario è tornato in coda».
    const body = await res.json()
    expect(body.data.movimenti_riaperti).toBe(1)

    // 2) nel REGISTRO: l'UPDATE della RPC cancella confermato_da/confermato_il,
    //    cioè chi aveva confermato quel bonifico. Se non lo scrive qui, non lo
    //    scrive nessuno.
    expect(audit().nuovo_valore?.movimenti_riaperti).toBe(1)

    // 3) nel LOG di successo (numeri e uuid soltanto: mai il motivo, mai la causale).
    expect(eventoAnnullo()).toMatchObject({ esito: 'transazione_annullata', movimenti_riaperti: 1 })
  })

  it('(f bis) RPC vecchia senza la chiave → 0, mai `undefined`', async () => {
    // Il DB E2E della CI non è migrato e la funzione lì è quella di prima: il
    // jsonb non porta `movimenti_riaperti`. «0» e «non lo so» non devono
    // diventare la stessa cosa a schermo per colpa di un `undefined`.
    h.rpc.mockResolvedValue({ data: { incassi_stornati: 1, ricariche_stornate: 0, credito_stornato: 0, ticket_gia_consumati: false }, error: null })
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.movimenti_riaperti).toBe(0)
    expect(audit().nuovo_valore?.movimenti_riaperti).toBe(0)
    expect(eventoAnnullo()).toMatchObject({ movimenti_riaperti: 0 })
  })

  it('(f ter) il MOTIVO non finisce mai nei log, nemmeno adesso che i campi sono cinque', async () => {
    const motivo = 'bonifico della famiglia sbagliata, segnalato al telefono'
    await POST(post({ motivo }), ctx)
    expect(JSON.stringify(h.logCalls)).not.toContain('telefono')
    // …ma resta nel registro DB, che è il posto giusto per leggerlo.
    expect(audit().nuovo_valore?.annullo_motivo).toBe(motivo)
  })
})
