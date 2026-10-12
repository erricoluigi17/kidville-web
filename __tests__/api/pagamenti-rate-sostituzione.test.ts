import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'

/**
 * «Dividi in acconti» SOSTITUISCE una voce (2026-10-12): prima il browser creava il piano e poi
 * chiamava la DELETE dell'originale — se la seconda falliva restavano voce e piano (debito
 * doppio), e col gate della DELETE ristretto ad admin e segreteria la coordinatrice ci sarebbe
 * caduta sempre. Ora lo fa il server: guardie PRIMA di scrivere, eliminazione DOPO, e se
 * l'eliminazione non riesce il piano si toglie. Si guarda lo STATO del finto DB. Dati sintetici.
 */

const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const PAG = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const UTENTE = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => {
  /**
   * Respinge la DELETE di UNA riga precisa (quella col filtro `id = <bersaglio>`), non «la prima
   * DELETE»: un finto a contatore resterebbe verde anche se la compensazione cancellasse la riga
   * sbagliata. Le altre DELETE passano al finto vero.
   */
  function deleteRespinta<T extends object>(client: T, bersaglio: () => string | null, errore: ErrorePostgrest): T {
    const risposta = { data: null, error: errore, count: null, status: 409, statusText: 'Conflict' }
    return new Proxy(client, {
      get(t, prop, rec) {
        const v = Reflect.get(t, prop, rec)
        if (prop !== 'from') return v
        return (tabella: string) => {
          const q = (v as (x: string) => object)(tabella)
          if (tabella !== 'pagamenti') return q
          return new Proxy(q, {
            get(qt, qp, qr) {
              const m = Reflect.get(qt, qp, qr)
              if (qp !== 'delete') return m
              return (...a: unknown[]) => {
                const filtro = (m as (...x: unknown[]) => Record<string, unknown>)(...a)
                return new Proxy(filtro, {
                  get(ft, fp, fr) {
                    const fm = Reflect.get(ft, fp, fr)
                    if (fp !== 'eq') return fm
                    return (col: string, val: unknown) =>
                      col === 'id' && val === bersaglio()
                        ? { then: (ok: (x: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risposta).then(ok, ko) }
                        : (fm as (c: string, x: unknown) => unknown)(col, val)
                  },
                })
              }
            },
          })
        }
      },
    })
  }

  return {
    ruolo: 'coordinator',
    logEvento: vi.fn(),
    db: {} as Record<string, Record<string, unknown>[]>,
    scritture: [] as unknown[],
    errori: null as null | Record<string, ErrorePostgrest>,
    respingiDelete: null as null | { id: string; errore: ErrorePostgrest },
    rpcArgs: [] as unknown[],
    deleteRespinta,
  }
})

vi.mock('@/lib/auth/require-staff', () => {
  const gate = async (_req: Request, ammessi: readonly string[] = ['admin', 'coordinator', 'segreteria']) =>
    ammessi.includes(h.ruolo)
      ? { user: { id: UTENTE, role: h.ruolo, scuola_id: SEDE_A } }
      : { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
  return { requireStaff: gate, requireUser: gate }
})
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<object>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const c = creaFintoSupabase(h.db, [], {
        scritture: h.scritture as unknown as Scrittura[],
        ...(h.errori ? { errori: h.errori } : {}),
        // Una ricarica che si rateizza NON deve chiamare la RPC che storna i ticket.
        rpc: { elimina_voce_ricarica_ticket: (args: Riga) => {
          h.rpcArgs.push(args)
          return { data: { esito: 'eliminata' }, error: null }
        } },
      })
      const r = h.respingiDelete
      return (r ? h.deleteRespinta(c, () => r.id, r.errore) : c) as never
    },
  }
})

import { POST } from '@/app/api/pagamenti/rate/route'

const corpo = (extra: Record<string, unknown> = {}) => ({
  alunno_id: ALU, descrizione: 'Retta finta a rate', importo_totale: 300,
  rate: [{ importo: 150, scadenza: '2026-11-05' }, { importo: 150, scadenza: '2026-12-05' }],
  sostituisce_pagamento_id: PAG, ...extra,
})
const post = (b: unknown) => POST(new NextRequest('http://localhost/api/pagamenti/rate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}))
const voce = (extra: Riga = {}): Riga => ({
  id: PAG, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Retta finta', importo: 300, importo_pagato: 0,
  stato: 'da_pagare', tipo: 'singolo', parent_payment_id: null, ...extra,
})
const pagamenti = () => h.db.pagamenti as Riga[]
const piani = () => pagamenti().filter((p) => p.tipo === 'padre')
const scritte = (t: string, op: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === t && s.operazione === op)
const eventi = (esito: string) => h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
const FRENO: ErrorePostgrest = { code: '23503', message: 'violates foreign key constraint' }

beforeEach(() => {
  vi.clearAllMocks()
  h.ruolo = 'coordinator'
  h.db = {
    alunni: [{ id: ALU, scuola_id: SEDE_A, classe_sezione: '3 ANNI', section_id: 'sec-a', stato: 'iscritto' }],
    pagamenti: [], incassi: [], fatture_emesse: [], fatture_coda: [],
    divise_ordini: [], mensa_ticket_movimenti: [], ticket_mensa: [], registro_modifiche: [],
  } as DBFinto
  h.scritture = []
  h.errori = null
  h.respingiDelete = null
  h.rpcArgs = []
})

describe('POST /api/pagamenti/rate · sostituisce la voce in un’operazione sola', () => {
  it('coordinatrice: piano creato, originale eliminato, audit con sostituito_da, log', async () => {
    h.db.pagamenti = [voce()]
    const res = await post(corpo())
    expect(res.status).toBe(201)
    expect(pagamenti().some((p) => p.id === PAG)).toBe(false)
    expect(piani()).toHaveLength(1)
    expect(pagamenti().filter((p) => p.tipo === 'rata')).toHaveLength(2)
    const audit = scritte('registro_modifiche', 'insert')
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).toContain(`"sostituito_da":"${piani()[0].id}"`)
    const ok = eventi('voce-sostituita-da-piano')
    expect(ok).toHaveLength(1)
    expect(ok[0][2]).toMatchObject({ originale_id: PAG, padre_id: piani()[0].id })
    expect(JSON.stringify(ok[0][2])).not.toContain('Retta finta')
  })

  it('🔴 originale con incassi → 409 PRIMA di creare il piano', async () => {
    h.db.pagamenti = [voce()]
    h.db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 50, transazione_id: null }]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_CON_INCASSI')
    expect(scritte('pagamenti', 'insert')).toEqual([])
    expect(pagamenti()).toHaveLength(1)
  })

  it('🔴 originale fatturato → 409 VOCE_FATTURATA, nessun insert', async () => {
    h.db.pagamenti = [voce()]
    h.db.fatture_emesse = [{ id: 'f1', pagamento_id: PAG }]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_FATTURATA')
    expect(scritte('pagamenti', 'insert')).toEqual([])
  })

  it('🔴 originale di un altro bambino → 409 VOCE_NON_SOSTITUIBILE, nessun insert', async () => {
    h.db.pagamenti = [voce({ alunno_id: 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa' })]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_NON_SOSTITUIBILE')
    expect(scritte('pagamenti', 'insert')).toEqual([])
  })

  it('🔴 originale «padre» → 409 VOCE_NON_SOSTITUIBILE, nessun insert', async () => {
    h.db.pagamenti = [voce({ tipo: 'padre' })]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_NON_SOSTITUIBILE')
    expect(scritte('pagamenti', 'insert')).toEqual([])
  })

  it('🔴 originale inesistente → 404, nessun insert', async () => {
    const res = await post(corpo())
    expect(res.status).toBe(404)
    expect(scritte('pagamenti', 'insert')).toEqual([])
  })

  it('una ricarica di ticket si rateizza: i ticket NON si toccano, nessuna RPC', async () => {
    h.db.pagamenti = [voce()]
    h.db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 0 }]
    const res = await post(corpo())
    expect(res.status).toBe(201)
    expect(h.rpcArgs).toEqual([])
    expect(scritte('ticket_mensa', 'update')).toEqual([])
    expect(scritte('mensa_ticket_movimenti', 'insert')).toEqual([])
  })

  it('🔴 DELETE dell’originale respinta dal freno → il piano si toglie (compensazione) e 409', async () => {
    h.db.pagamenti = [voce()]
    h.respingiDelete = { id: PAG, errore: FRENO }
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_CON_CONTABILITA')
    // Stato finale: solo l'originale. Né piano né rate (le rate se ne vanno col padre in CASCADE
    // sul DB vero; il finto non ha la cascata, quindi si guarda il PADRE).
    expect(pagamenti().some((p) => p.id === PAG)).toBe(true)
    expect(piani()).toEqual([])
    expect(eventi('sostituzione-annullata')).toHaveLength(1)
    expect(eventi('sostituzione-annullata')[0][1]).toBe('warn')
    expect(scritte('registro_modifiche', 'insert')).toEqual([])
  })

  it('🔴 DELETE dell’originale per un guasto (non il freno) → piano tolto e 500, log error', async () => {
    h.db.pagamenti = [voce()]
    h.respingiDelete = { id: PAG, errore: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await post(corpo())
    expect(res.status).toBe(500)
    expect(piani()).toEqual([])
    expect(eventi('sostituzione-annullata')[0][1]).toBe('error')
  })

  it('🔴 fallisce anche la compensazione → 500 PAGAMENTI_SCRITTURA_FALLITA, e si dice col suo uuid', async () => {
    h.db.pagamenti = [voce()]
    h.errori = { 'pagamenti:delete': FRENO }
    const res = await post(corpo())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('PAGAMENTI_SCRITTURA_FALLITA')
    const e = eventi('compensazione-piano-fallita')
    expect(e).toHaveLength(1)
    expect(e[0][2]).toMatchObject({ originale_id: PAG, padre_id: piani()[0].id })
  })

  it('senza sostituisce_pagamento_id → comportamento di prima (201, nessuna DELETE)', async () => {
    h.db.pagamenti = [voce()]
    const res = await post(corpo({ sostituisce_pagamento_id: undefined }))
    expect(res.status).toBe(201)
    expect(scritte('pagamenti', 'delete')).toEqual([])
    expect(pagamenti().some((p) => p.id === PAG)).toBe(true)
  })

  it('sostituisce_pagamento_id non uuid → 400, nessuna scrittura', async () => {
    const res = await post(corpo({ sostituisce_pagamento_id: 'non-un-uuid' }))
    expect(res.status).toBe(400)
    expect(h.scritture).toEqual([])
  })
})
