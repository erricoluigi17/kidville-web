import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, Riga, RispostaRpc, Scrittura } from '../fixtures/finto-supabase'

/**
 * `pagamenti` — un guasto del database non diventa un valore (fase 5 robustezza, sesto pezzo).
 *
 * PostgREST non lancia: restituisce `{ data: null, error }`. Fino al 2026-10-10 in queste
 * route il `null` diventava «nessuno», «zero», «non trovato» — e a volte una SCRITTURA:
 * una voce generata due volte, una voce fatturata cancellata, un saldo letto 0. Ogni caso
 * qui sotto mette un guasto VERO (codice Postgres, non 42P01/42703 che sono «schema
 * assente») su una lettura, e guarda lo STATO del finto DB, non la forma delle chiamate.
 * Ognuno è rosso sul codice di prima (provato rimettendo le route di `origin/main`).
 */

const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const PAG = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const GUASTO = { code: '57014', message: 'canceling statement due to statement timeout' }

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  notificaEvento: vi.fn(async () => {}),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: undefined as Record<string, { code: string; message: string }> | undefined,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rpcChiamate: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notificaEvento(...(a as [])) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: async () => {} }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<object>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, [], {
        scritture: h.scritture as unknown as Scrittura[],
        ...(h.errori ? { errori: h.errori } : {}),
        rpc: Object.fromEntries(
          Object.entries(h.rpc).map(([nome, f]) => [nome, (args: Riga): RispostaRpc => {
            h.rpcChiamate.push(nome)
            return f(args)
          }]),
        ),
      }),
  }
})

import { POST as generaPOST } from '@/app/api/pagamenti/genera/route'
import { POST as genereRettePOST } from '@/app/api/pagamenti/genera-rette/route'
import { DELETE as pagamentoDELETE, GET as pagamentoGET } from '@/app/api/pagamenti/[id]/route'
import { POST as scontoPOST } from '@/app/api/pagamenti/[id]/sconto/route'
import { GET as storicoGET } from '@/app/api/pagamenti/ticket/storico/route'
import { GET as attestazioneGET } from '@/app/api/pagamenti/attestazione/route'
import { applyOverpaymentSpill } from '@/lib/pagamenti/spill'
import { createAdminClient } from '@/lib/supabase/server-client'

const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const voce = (extra: Riga = {}): Riga => ({
  id: PAG, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Retta ottobre', importo: 300, importo_pagato: 0,
  sconto: 0, stato: 'da_pagare', tipo: 'singolo', scadenza: '2026-10-05', ...extra,
})

const scritte = (tabella: string, operazione: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    alunni: [{ id: ALU, scuola_id: SEDE_A, nome: 'Prova', cognome: 'Collaudo', classe_sezione: '3 ANNI', section_id: 'sec-a', stato: 'iscritto', intestatario_fatture: null }],
    pagamenti: [],
    incassi: [],
    fatture_emesse: [],
    registro_modifiche: [],
    ticket_mensa: [],
    mensa_ticket_movimenti: [],
    payment_categories: [{ id: 'c1c1c1c1-1111-4111-8111-cccccccccccc', slug: 'retta', scuola_id: null }],
  } as DBFinto
  h.scritture = []
  h.errori = undefined
  h.rpc = {}
  h.rpcChiamate = []
  h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('generazione · un guasto sui «già generati» non genera di nuovo', () => {
  it('🔴 genera POST: la lettura del gruppo fallisce → 500, e NESSUNA voce scritta (prima: doppio addebito)', async () => {
    h.db.pagamenti = [voce({ gruppo: 'gita-2026' })]
    h.errori = { 'pagamenti:select': GUASTO }
    const res = await generaPOST(json('/api/pagamenti/genera', 'POST', {
      descrizione: 'Gita', importo: 10, scadenza: '2026-10-30', gruppo: 'gita-2026', alunno_ids: [ALU],
    }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(scritte('pagamenti', 'insert')).toEqual([])
    expect(h.db.pagamenti).toHaveLength(1)
  })

  it('🔴 genera-rette POST mensile: «chi l’aveva già» non letto → 500 PRIMA della RPC (prima: «nuova retta» a tutta la sede)', async () => {
    h.rpc.genera_rette_mensili = () => ({ data: 1, error: null })
    h.errori = { 'pagamenti:select': GUASTO }
    const res = await genereRettePOST(json('/api/pagamenti/genera-rette', 'POST', { periodo: '2026-11-01', scuola_id: SEDE_A }))
    expect(res.status).toBe(500)
    expect(h.rpcChiamate).not.toContain('genera_rette_mensili')
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })
})

describe('eliminazione · una guardia che non ha potuto guardare ferma la DELETE', () => {
  it('🔴 fatture_emesse non lette → 500, e la voce RESTA (prima: cancellata con la fattura emessa)', async () => {
    h.db.pagamenti = [voce()]
    h.db.fatture_emesse = [{ id: 'f1', pagamento_id: PAG }]
    h.errori = { 'fatture_emesse:select': GUASTO }
    const res = await pagamentoDELETE(json(`/api/pagamenti/${PAG}`, 'DELETE'), ctx(PAG))
    expect(res.status).toBe(500)
    expect(h.db.pagamenti).toHaveLength(1)
    expect(scritte('pagamenti', 'delete')).toEqual([])
  })

  it('🔴 incassi di transazione non letti → 500, e la voce RESTA', async () => {
    h.db.pagamenti = [voce()]
    h.errori = { 'incassi:select': GUASTO }
    const res = await pagamentoDELETE(json(`/api/pagamenti/${PAG}`, 'DELETE'), ctx(PAG))
    expect(res.status).toBe(500)
    expect(h.db.pagamenti).toHaveLength(1)
  })

  it('schema assente (colonna transazione_id, 42703: DB E2E non migrato) → la guardia salta come prima', async () => {
    h.db.pagamenti = [voce()]
    h.errori = { 'incassi:select': { code: '42703', message: 'column incassi.transazione_id does not exist' } }
    const res = await pagamentoDELETE(json(`/api/pagamenti/${PAG}`, 'DELETE'), ctx(PAG))
    expect(res.status).toBe(200)
    expect(h.db.pagamenti).toHaveLength(0)
  })
})

describe('letture · un guasto non è «non trovato» né «vuoto»', () => {
  it('🔴 dettaglio voce: pagamenti non letti → 500 LETTURA_FALLITA (prima: 404 «non trovato»)', async () => {
    h.db.pagamenti = [voce()]
    h.errori = { 'pagamenti:select': GUASTO }
    const res = await pagamentoGET(json(`/api/pagamenti/${PAG}`, 'GET'), ctx(PAG))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
  })

  it('🔴 storico ticket: saldo non letto → 500 (prima: «0 ticket» a chi li aveva pagati)', async () => {
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 12, ultimo_carico: '2026-10-01' }]
    h.errori = { 'ticket_mensa:select': GUASTO }
    const res = await storicoGET(json(`/api/pagamenti/ticket/storico?alunno_id=${ALU}`, 'GET'))
    expect(res.status).toBe(500)
  })

  it('storico ticket: il ledger assente (42P01) degrada a nessun movimento, il saldo resta vero', async () => {
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 12, ultimo_carico: '2026-10-01' }]
    h.errori = { 'mensa_ticket_movimenti:select': { code: '42P01', message: 'relation does not exist' } }
    const res = await storicoGET(json(`/api/pagamenti/ticket/storico?alunno_id=${ALU}`, 'GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.saldo_ticket).toBe(12)
    expect(body.data.movimenti).toEqual([])
  })

  it('🔴 attestazione 730: incassi non letti → 500, nessun PDF con versato 0', async () => {
    h.db.pagamenti = [voce()]
    h.errori = { 'incassi:select': GUASTO }
    const res = await attestazioneGET(json(`/api/pagamenti/attestazione?alunno_id=${ALU}&anno=2026`, 'GET'))
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).not.toContain('application/pdf')
  })
})

describe('passi accessori · lo sconto è scritto, il ricalcolo fallito si dice', () => {
  it('🔴 ricalcolo dello stato fallito → 200 con stato_ricalcolato:false e una riga error (prima: inghiottito)', async () => {
    h.db.pagamenti = [voce()]
    h.rpc.ricalcola_stato_pagamento = () => ({ data: null, error: GUASTO })
    const res = await scontoPOST(json(`/api/pagamenti/${PAG}/sconto`, 'POST', { sconto: 50, sconto_motivo: 'fratelli' }), ctx(PAG))
    expect(res.status).toBe(200)
    expect((await res.json()).data.stato_ricalcolato).toBe(false)
    expect(eventi('stato-non-ricalcolato')).toHaveLength(1)
    expect(eventi('stato-non-ricalcolato')[0].slice(0, 2)).toEqual(['pagamento', 'error'])
  })
})

describe('riporto fra rate · tutto o niente', () => {
  const PIANO = 'd0d0d0d0-1111-4111-8111-dddddddddddd'
  const R1 = 'd1d1d1d1-1111-4111-8111-dddddddddddd'
  const R2 = 'd2d2d2d2-1111-4111-8111-dddddddddddd'
  const piano = () => {
    h.db.pagamenti = [
      { id: R1, parent_payment_id: PIANO, importo: 100, importo_pagato: 150, scadenza: '2026-10-01' },
      { id: R2, parent_payment_id: PIANO, importo: 100, importo_pagato: 0, scadenza: '2026-11-01' },
    ]
  }

  it('🔴 le due righe (−50 su R1, +50 su R2) partono in UN insert: una sola istruzione', async () => {
    piano()
    const spills = await applyOverpaymentSpill(await createAdminClient(), R1, SEGRETERIA)
    expect(spills).toEqual([{ rata_id: R2, importo: 50 }])
    const inserti = scritte('incassi', 'insert')
    expect(inserti).toHaveLength(1)
    expect(inserti[0].valori.map((r) => [r.pagamento_id, r.importo])).toEqual([[R1, -50], [R2, 50]])
  })

  it('🔴 insert rifiutato → nessuna riga, nessun riporto dichiarato, e una riga error', async () => {
    piano()
    h.errori = { 'incassi:insert': GUASTO }
    const spills = await applyOverpaymentSpill(await createAdminClient(), R1, SEGRETERIA)
    expect(spills).toEqual([])
    expect(h.db.incassi).toEqual([])
    expect(eventi('riporto-non-scritto')).toHaveLength(1)
  })

  it('🔴 rata non letta → una riga error, non un’uscita muta dal ciclo', async () => {
    piano()
    h.errori = { 'pagamenti:select': GUASTO }
    const spills = await applyOverpaymentSpill(await createAdminClient(), R1, SEGRETERIA)
    expect(spills).toEqual([])
    expect(eventi('rata-non-letta')).toHaveLength(1)
  })
})
