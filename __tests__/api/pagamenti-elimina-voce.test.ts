import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, Riga, RispostaRpc, Scrittura } from '../fixtures/finto-supabase'

/**
 * Eliminare una voce generata per errore (2026-10-12): solo admin e segreteria; una ricarica di
 * ticket passa dalla RPC che storna i ticket; dopo l'eliminazione si ricontrolla la sospensione
 * per morosità e si logga il SUCCESSO. Il gate è emulato davvero (rispetta l'elenco dei ruoli
 * passato a `requireStaff`), non un mock che dice sempre sì. Dati sintetici.
 */

const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const PAG = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const UTENTE = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  ruolo: 'segreteria',
  revoca: vi.fn<(...a: unknown[]) => Promise<{ revocati: string[] }>>(async () => ({ revocati: [] })),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rpcArgs: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => {
  const gate = async (_req: Request, ammessi: readonly string[] = ['admin', 'coordinator', 'segreteria']) =>
    ammessi.includes(h.ruolo)
      ? { user: { id: UTENTE, role: h.ruolo, scuola_id: SEDE_A } }
      : { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
  return { requireStaff: gate, requireUser: gate }
})
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => {} }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<object>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, [], {
        scritture: h.scritture as unknown as Scrittura[],
        rpc: Object.fromEntries(Object.entries(h.rpc).map(([nome, f]) => [nome, (args: Riga): RispostaRpc => {
          h.rpcArgs.push({ nome, ...args })
          return f(args) as RispostaRpc
        }])),
      }),
  }
})

import { DELETE } from '@/app/api/pagamenti/[id]/route'
import { GET as eliminabileGET } from '@/app/api/pagamenti/[id]/eliminabile/route'

const req = () => new NextRequest(`http://localhost/api/pagamenti/${PAG}`, { method: 'DELETE' })
const ctx = () => ({ params: Promise.resolve({ id: PAG }) })
const voce = (extra: Riga = {}): Riga => ({
  id: PAG, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Gita finta', importo: 30, importo_pagato: 0,
  stato: 'scaduto', tipo: 'singolo', parent_payment_id: null, ...extra,
})
const scritte = (t: string, op: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === t && s.operazione === op)
const eventi = (esito: string) => h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.ruolo = 'segreteria'
  h.db = {
    alunni: [{ id: ALU, scuola_id: SEDE_A }], pagamenti: [], incassi: [], fatture_emesse: [], fatture_coda: [],
    divise_ordini: [], mensa_ticket_movimenti: [], ticket_mensa: [], registro_modifiche: [],
  } as DBFinto
  h.scritture = []
  h.rpc = {}
  h.rpcArgs = []
})

describe('DELETE /api/pagamenti/[id] · chi può', () => {
  it('🔴 coordinatrice → 403, la voce resta', async () => {
    h.ruolo = 'coordinator'
    h.db.pagamenti = [voce()]
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(403)
    expect(h.db.pagamenti).toHaveLength(1)
  })

  for (const ruolo of ['admin', 'segreteria']) {
    it(`${ruolo} → 200: voce eliminata, audit, revoca della sospensione, log del successo`, async () => {
      h.ruolo = ruolo
      h.db.pagamenti = [voce()]
      const res = await DELETE(req(), ctx())
      expect(res.status).toBe(200)
      expect(h.db.pagamenti).toHaveLength(0)
      expect(scritte('registro_modifiche', 'insert')).toHaveLength(1)
      expect(h.revoca).toHaveBeenCalledWith(expect.anything(), [ALU])
      expect(eventi('voce-eliminata')).toHaveLength(1)
    })
  }

  it('il log del successo porta solo uuid, tipo e numeri — mai la descrizione', async () => {
    h.db.pagamenti = [voce()]
    await DELETE(req(), ctx())
    const campi = eventi('voce-eliminata')[0][2] as Record<string, unknown>
    expect(campi).toMatchObject({ pagamento_id: PAG, tipo: 'singolo', rate: 0, ticket_tolti: 0 })
    expect(JSON.stringify(campi)).not.toContain('Gita finta')
  })

  it('la revoca della sospensione che fallisce non cambia il 200, e si dice', async () => {
    h.db.pagamenti = [voce()]
    h.revoca.mockRejectedValueOnce(new Error('rete'))
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(200)
    expect(eventi('revoca_non_verificata')).toHaveLength(1)
  })

  it('fattura emessa → 409 col codice VOCE_FATTURATA (prima il 409 non aveva codice)', async () => {
    h.db.pagamenti = [voce()]
    h.db.fatture_emesse = [{ id: 'f1', pagamento_id: PAG }]
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_FATTURATA')
  })
})

describe('DELETE /api/pagamenti/[id] · ricarica di ticket', () => {
  const conRicarica = () => {
    h.db.pagamenti = [voce()]
    h.db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 10 }]
  }

  it('passa dalla RPC (non dalla DELETE diretta) e scrive ticket_tolti nell’audit', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => {
      h.db.pagamenti = []
      return { data: { esito: 'eliminata', ticket_tolti: 10, saldo_dopo: 0 }, error: null }
    }
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(200)
    expect(h.rpcArgs).toEqual([{ nome: 'elimina_voce_ricarica_ticket', p_pagamento_id: PAG, p_operatore: UTENTE }])
    expect(scritte('pagamenti', 'delete')).toEqual([])
    expect(JSON.stringify(scritte('registro_modifiche', 'insert'))).toContain('"ticket_tolti":10')
    expect(eventi('voce-eliminata')[0][2]).toMatchObject({ ticket_tolti: 10 })
  })

  it('🔴 RPC «ticket_gia_usati» → 409 TICKET_GIA_USATI, niente audit', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: { esito: 'ticket_gia_usati', ticket: 10, saldo: 7 }, error: null })
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('TICKET_GIA_USATI')
    expect(scritte('registro_modifiche', 'insert')).toEqual([])
  })

  it('🔴 RPC assente (DB non migrato) → 503 e la voce RESTA, nessuna DELETE diretta', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ELIMINAZIONE_RICARICA_NON_DISPONIBILE')
    expect(h.db.pagamenti).toHaveLength(1)
    expect(scritte('pagamenti', 'delete')).toEqual([])
    expect(eventi('rpc-eliminazione-ricarica-assente')).toHaveLength(1)
  })

  it('🔴 RPC respinta dal freno (23503: incasso arrivato nel frattempo) → 409 VOCE_CON_CONTABILITA', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: null, error: { code: '23503', message: 'violates foreign key constraint' } })
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_CON_CONTABILITA')
  })

  it('🔴 esito inatteso della RPC → 409, e si logga', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: { esito: 'senza_ricarica' }, error: null })
    const res = await DELETE(req(), ctx())
    expect(res.status).toBe(409)
    expect(eventi('rpc-esito-inatteso')).toHaveLength(1)
  })
})

describe('GET /api/pagamenti/[id]/eliminabile · il verdetto per la finestra Modifica', () => {
  const get = () => eliminabileGET(new NextRequest(`http://localhost/api/pagamenti/${PAG}/eliminabile`), ctx())

  it('🔴 coordinatrice → 403', async () => {
    h.ruolo = 'coordinator'
    h.db.pagamenti = [voce()]
    expect((await get()).status).toBe(403)
  })

  it('voce pulita → 200 eliminabile, 0 rate, 0 ticket, e NIENTE scritto', async () => {
    h.db.pagamenti = [voce()]
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, eliminabile: true, rate: 0, ticket: 0 })
    expect(h.scritture).toEqual([])
    expect(h.db.pagamenti).toHaveLength(1)
  })

  it('ricarica intatta → eliminabile con i ticket da togliere', async () => {
    h.db.pagamenti = [voce()]
    h.db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 10 }]
    expect(await (await get()).json()).toMatchObject({ eliminabile: true, ticket: 10 })
  })

  it('voce con incassi → 200 NON eliminabile, col codice', async () => {
    h.db.pagamenti = [voce()]
    h.db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 10, transazione_id: null }]
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, eliminabile: false, codice: 'VOCE_CON_INCASSI' })
  })

  it('voce inesistente → 404', async () => {
    expect((await get()).status).toBe(404)
  })
})
