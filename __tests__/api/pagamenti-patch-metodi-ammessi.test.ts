import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, ErrorePostgrest, Riga, RispostaRpc, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `PATCH /api/pagamenti/[id]` — i METODI AMMESSI si modificano (2026-10-05).
//
// Qui, a differenza della generazione, si scrive SEMPRE l'array normalizzato:
// anche «tutti e due», perché è così che una voce «solo contanti» torna
// pagabile in entrambi i modi.
//
// Sul DB senza la colonna (E2E della CI) il resto della modifica si salva lo
// stesso, e la risposta DICE che i metodi non sono stati salvati
// (`avviso: 'metodi-non-salvabili'`) invece di fingere.
// =============================================================================

const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const PID = '9a9a9a9a-1111-4111-8111-999999999999'
const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => {
  const ERRORE_COLONNA = {
    code: 'PGRST204',
    message: "Could not find the 'metodi_ammessi' column of 'pagamenti' in the schema cache",
    details: null,
    hint: null,
  }

  /**
   * Il DB E2E della CI, NON migrato: PostgREST respinge con PGRST204 ogni
   * insert/update su `pagamenti` che NOMINA `metodi_ammessi`, e accetta lo
   * stesso corpo senza. Emulato sul CONTENUTO della scrittura: un finto a
   * contatore («il primo update fallisce») resterebbe verde anche se il
   * ritentativo rimandasse la colonna.
   */
  function senzaColonnaMetodi<T extends object>(client: T, respinte: unknown[]): T {
    const respinta = () => {
      const r = { data: null, error: { ...ERRORE_COLONNA }, count: null, status: 400, statusText: 'Bad Request' }
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.single = async () => r
      q.maybeSingle = async () => r
      q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(r).then(ok, ko)
      return q
    }
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
              if (qp !== 'insert' && qp !== 'update') return m
              return (valori: Record<string, unknown> | Record<string, unknown>[], ...resto: unknown[]) => {
                const righe = Array.isArray(valori) ? valori : [valori]
                if (righe.some((r) => 'metodi_ammessi' in r)) {
                  respinte.push(righe)
                  return respinta()
                }
                return (m as (...a: unknown[]) => unknown)(valori, ...resto)
              }
            },
          })
        }
      },
    })
  }

  return {
    requireStaff: vi.fn(),
    notificaEvento: vi.fn(async () => {}),
    revoca: vi.fn(async () => ({ revocati: [] })),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    db: {} as Record<string, Record<string, unknown>[]>,
    scritture: [] as unknown[],
    errori: undefined as Record<string, unknown> | undefined,
    rpc: {} as Record<string, (args: Record<string, unknown>) => unknown>,
    /** L'insert dell'audit della DELETE RIGETTA (rete, client): non ritorna `{ error }`. */
    auditLancia: false,
    colonnaAssente: false,
    respinte: [] as unknown[],
    senzaColonnaMetodi,
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...(a as [])),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...(a as [])),
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: () => {},
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const c = creaFintoSupabase(h.db, [], {
        scritture: h.scritture as unknown as Scrittura[],
        errori: h.errori as Record<string, ErrorePostgrest> | undefined,
        rpc: h.rpc as Record<string, (args: Riga) => RispostaRpc | Promise<RispostaRpc>>,
      })
      const base = h.colonnaAssente ? h.senzaColonnaMetodi(c, h.respinte) : c
      if (!h.auditLancia) return base as never
      // L'audit che RIGETTA invece di ritornare `{ error }`: il caso che il vecchio
      // `.then(() => {}, () => {})` ingoiava insieme all'errore vero.
      return new Proxy(base, {
        get(t, prop, rec) {
          const v = Reflect.get(t, prop, rec)
          if (prop !== 'from') return v
          return (tabella: string) => {
            const q = (v as (x: string) => object)(tabella)
            if (tabella !== 'registro_modifiche') return q
            return { insert: () => Promise.reject(new TypeError('fetch failed')) }
          }
        },
      }) as never
    },
  }
})

import { PATCH, DELETE } from '@/app/api/pagamenti/[id]/route'

const ctx = { params: Promise.resolve({ id: PID }) }
const patch = (body: unknown) =>
  new NextRequest(`http://localhost/api/pagamenti/${PID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  pagamenti: [{
    id: PID, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Gita al museo', importo: 10,
    importo_pagato: 0, sconto: 0, scadenza: '2026-10-30', stato: 'da_pagare', tipo: 'singolo',
    metodi_ammessi: ['contanti', 'bonifico'],
  }],
})

const riga = () => (h.db.pagamenti as Riga[])[0]
const updateSuPagamenti = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'pagamenti' && s.operazione === 'update')
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.scritture = []
  h.errori = undefined
  h.rpc = {}
  h.auditLancia = false
  h.respinte = []
  h.colonnaAssente = false
  h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('PATCH /api/pagamenti/[id] — metodi ammessi', () => {
  it('«solo contanti»: l\'update scrive metodi_ammessi e il successo si logga', async () => {
    const res = await PATCH(patch({ metodi_ammessi: ['contanti'] }), ctx)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    expect(corpo).not.toHaveProperty('avviso')
    expect(riga().metodi_ammessi).toEqual(['contanti'])
    expect(updateSuPagamenti()).toHaveLength(1)
    expect(updateSuPagamenti()[0].valori[0]).toMatchObject({ metodi_ammessi: ['contanti'] })
    const ok = eventi('metodi-ammessi-modificati')
    expect(ok).toHaveLength(1)
    expect(ok[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(ok[0][2]).toMatchObject({
      operazione: 'pagamenti/[id]:PATCH', pagamento_id: PID, solo_contanti: true, solo_bonifico: false,
    })
  })

  it('«tutti e due» si SCRIVE (normalizzato): è così che una voce torna pagabile in entrambi i modi', async () => {
    h.db.pagamenti[0].metodi_ammessi = ['contanti']
    const res = await PATCH(patch({ metodi_ammessi: ['bonifico', 'contanti'] }), ctx)
    expect(res.status).toBe(200)
    expect(riga().metodi_ammessi).toEqual(['contanti', 'bonifico'])
    expect(eventi('metodi-ammessi-modificati')[0][2]).toMatchObject({ solo_contanti: false, solo_bonifico: false })
  })

  it.each([
    ['vuoto, da solo', { metodi_ammessi: [] }],
    ['vuoto, insieme a un altro campo', { descrizione: 'Gita allo zoo', metodi_ammessi: [] }],
    ['metodo ignoto', { descrizione: 'Gita allo zoo', metodi_ammessi: ['pos'] }],
  ])('metodi_ammessi %s ⇒ 400 e nessun update', async (_n, corpo) => {
    const res = await PATCH(patch(corpo), ctx)
    expect(res.status).toBe(400)
    expect(updateSuPagamenti()).toEqual([])
    expect(riga().descrizione).toBe('Gita al museo')
    expect(riga().metodi_ammessi).toEqual(['contanti', 'bonifico'])
  })

  it('un errore del DB che NON è «colonna assente» ⇒ 500, nessun ritentativo, errore loggato', async () => {
    h.errori = { 'pagamenti:update': { code: '23514', message: 'violazione del vincolo' } }
    const res = await PATCH(patch({ descrizione: 'Gita allo zoo', metodi_ammessi: ['contanti'] }), ctx)
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalled()
    expect(eventi('metodi-ammessi-colonna-assente')).toHaveLength(0)
    expect(eventi('metodi-ammessi-modificati')).toHaveLength(0)
  })

  describe('DB senza la colonna (E2E della CI, non migrato)', () => {
    beforeEach(() => {
      h.colonnaAssente = true
      delete h.db.pagamenti[0].metodi_ammessi
    })

    it('metodi_ammessi era l\'UNICO campo: 200 con avviso «metodi-non-salvabili», nessun update vuoto', async () => {
      const res = await PATCH(patch({ metodi_ammessi: ['contanti'] }), ctx)
      expect(res.status).toBe(200)
      const corpo = await res.json()
      expect(corpo).toMatchObject({ success: true, avviso: 'metodi-non-salvabili' })
      expect(corpo.data).toMatchObject({ id: PID })
      // respinto perché nominava la colonna, e poi NON ritentato con il solo `aggiornato_il`
      expect(h.respinte).toHaveLength(1)
      expect(updateSuPagamenti()).toEqual([])
      expect(riga()).not.toHaveProperty('metodi_ammessi')
      const warn = eventi('metodi-ammessi-colonna-assente')
      expect(warn).toHaveLength(1)
      expect(warn[0].slice(0, 2)).toEqual(['pagamento', 'warn'])
      expect(warn[0][2]).toMatchObject({ operazione: 'pagamenti/[id]:PATCH', pagamento_id: PID })
      expect(eventi('metodi-ammessi-modificati')).toHaveLength(0)
    })

    it('insieme a un altro campo: il resto si salva SENZA la colonna, e la risposta lo dice', async () => {
      const res = await PATCH(patch({ descrizione: 'Gita allo zoo', metodi_ammessi: ['contanti'] }), ctx)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ success: true, avviso: 'metodi-non-salvabili' })
      expect(riga().descrizione).toBe('Gita allo zoo')
      expect(riga()).not.toHaveProperty('metodi_ammessi')
      expect(updateSuPagamenti()).toHaveLength(1)
      expect(updateSuPagamenti()[0].valori[0]).not.toHaveProperty('metodi_ammessi')
      expect(eventi('metodi-ammessi-modificati')).toHaveLength(0)
    })

    it('una modifica che non tocca i metodi non nomina la colonna: nessun rifiuto, nessun avviso', async () => {
      const res = await PATCH(patch({ descrizione: 'Gita allo zoo' }), ctx)
      expect(res.status).toBe(200)
      expect(await res.json()).not.toHaveProperty('avviso')
      expect(h.respinte).toHaveLength(0)
      expect(riga().descrizione).toBe('Gita allo zoo')
    })
  })
})

// =============================================================================
// Le scritture SECONDARIE della route non ingoiano più gli errori (rifinitura,
// 2026-10-05). Nella PATCH il ricalcolo dello stato (`ricalcola_stato_padre` /
// `ricalcola_stato_pagamento`), nella DELETE l'audit su `registro_modifiche`: erano
// `.then(() => {}, () => {})`, che scarta il successo, il `{ error }` di PostgREST E il
// rigetto. Ora l'errore si legge e si logga — `info` se è lo schema non migrato (RPC o
// tabella assenti), `error` altrimenti — e un rigetto NON trasforma in 500
// un'operazione già riuscita. Nei log solo uuid e codici.
// =============================================================================
const RICALCOLO_OK = (): RispostaRpc => ({ data: null, error: null })
const eventiRicalcolo = () =>
  h.logEvento.mock.calls.filter((c) => /^ricalcolo-/.test(String((c[2] as { esito?: string } | undefined)?.esito)))

describe('PATCH /api/pagamenti/[id] — il ricalcolo dello stato non tace', () => {
  it('riuscito: la RPC giusta è chiamata con l’id, e nessuna riga di errore', async () => {
    const chiamate: unknown[] = []
    h.rpc = { ricalcola_stato_pagamento: (a) => { chiamate.push(a); return RICALCOLO_OK() } }
    const res = await PATCH(patch({ importo: 12 }), ctx)
    expect(res.status).toBe(200)
    // Presenza prima: il ricalcolo è partito davvero.
    expect(chiamate).toEqual([{ p_id: PID }])
    expect(eventiRicalcolo()).toHaveLength(0)
  })

  it('RPC assente (PGRST202, DB non migrato): 200 e una riga `info`', async () => {
    h.rpc = {
      ricalcola_stato_pagamento: () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.ricalcola_stato_pagamento' },
      }),
    }
    const res = await PATCH(patch({ scadenza: '2026-11-30' }), ctx)
    expect(res.status).toBe(200)
    expect(riga().scadenza).toBe('2026-11-30')
    const log = eventiRicalcolo()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(log[0][2]).toEqual({
      operazione: 'pagamenti/[id]:PATCH', esito: 'ricalcolo-rpc-assente', pagamento_id: PID, tipo: 'singolo',
    })
    expect(log[0][3]).toMatchObject({ code: 'PGRST202' })
  })

  it('RPC fallita per un altro motivo: 200 (la modifica è salvata) e una riga `error`', async () => {
    h.rpc = { ricalcola_stato_pagamento: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) }
    const res = await PATCH(patch({ importo: 12 }), ctx)
    expect(res.status).toBe(200)
    expect(riga().importo).toBe(12)
    const log = eventiRicalcolo()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][2]).toMatchObject({ esito: 'ricalcolo-non-riuscito', pagamento_id: PID })
    expect(log[0][3]).toMatchObject({ code: '57014' })
  })

  it('RPC che RIGETTA: non diventa un 500, e il rigetto si logga', async () => {
    h.rpc = { ricalcola_stato_pagamento: () => { throw new TypeError('fetch failed') } }
    const res = await PATCH(patch({ importo: 12 }), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(h.logErrore).not.toHaveBeenCalled()
    const log = eventiRicalcolo()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][3]).toBeInstanceOf(TypeError)
  })

  it('voce PADRE: si chiama `ricalcola_stato_padre`; assente (42883) ⇒ `info` col tipo', async () => {
    h.db.pagamenti[0].tipo = 'padre'
    const chiamate: unknown[] = []
    h.rpc = {
      ricalcola_stato_padre: (a) => {
        chiamate.push(a)
        return { data: null, error: { code: '42883', message: 'function ricalcola_stato_padre(uuid) does not exist' } }
      },
    }
    const res = await PATCH(patch({ importo: 12 }), ctx)
    expect(res.status).toBe(200)
    expect(chiamate).toEqual([{ p_parent: PID }])
    const log = eventiRicalcolo()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(log[0][2]).toMatchObject({ esito: 'ricalcolo-rpc-assente', tipo: 'padre' })
  })
})

describe('DELETE /api/pagamenti/[id] — l’audit della cancellazione non tace', () => {
  const del = () => new NextRequest(`http://localhost/api/pagamenti/${PID}`, { method: 'DELETE' })
  const eventiAudit = () =>
    h.logEvento.mock.calls.filter((c) => /^audit-/.test(String((c[2] as { esito?: string } | undefined)?.esito)))

  beforeEach(() => {
    h.db.fatture_emesse = []
    h.db.incassi = []
    h.db.registro_modifiche = []
  })

  it('riuscito: la voce sparisce, l’audit è scritto, nessuna riga di errore', async () => {
    const res = await DELETE(del(), ctx)
    expect(res.status).toBe(200)
    expect(h.db.pagamenti).toEqual([])
    // Presenza prima: l'audit c'è, con l'id della voce cancellata.
    expect(h.db.registro_modifiche).toHaveLength(1)
    expect(h.db.registro_modifiche[0]).toMatchObject({ azione: 'elimina_pagamento', record_id: PID })
    expect(eventiAudit()).toHaveLength(0)
  })

  it('tabella dell’audit assente (42P01, DB non migrato): 200 e una riga `info`', async () => {
    h.errori = { 'registro_modifiche:insert': { code: '42P01', message: 'relation "registro_modifiche" does not exist' } }
    const res = await DELETE(del(), ctx)
    expect(res.status).toBe(200)
    expect(h.db.pagamenti).toEqual([])
    const log = eventiAudit()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(log[0][2]).toEqual({
      operazione: 'pagamenti/[id]:DELETE', esito: 'audit-tabella-assente', pagamento_id: PID,
    })
  })

  it('audit fallito per un altro motivo: 200 (la voce è già cancellata) e una riga `error`, senza i dati della voce', async () => {
    h.errori = { 'registro_modifiche:insert': { code: '23502', message: 'null value in column "utente_id" violates not-null constraint' } }
    const res = await DELETE(del(), ctx)
    expect(res.status).toBe(200)
    expect(h.db.pagamenti).toEqual([])
    const log = eventiAudit()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][2]).toEqual({
      operazione: 'pagamenti/[id]:DELETE', esito: 'audit-eliminazione-non-scritto', pagamento_id: PID,
    })
    expect(log[0][3]).toMatchObject({ code: '23502' })
    // Il `vecchio_valore` dell'audit (descrizione, alunno…) non finisce nei campi del log.
    expect(JSON.stringify(log[0][2])).not.toContain('Gita al museo')
  })

  it('audit che RIGETTA: la cancellazione riuscita non diventa un 500', async () => {
    h.auditLancia = true
    const res = await DELETE(del(), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(h.db.pagamenti).toEqual([])
    expect(h.logErrore).not.toHaveBeenCalled()
    const log = eventiAudit()
    expect(log).toHaveLength(1)
    expect(log[0].slice(0, 2)).toEqual(['pagamento', 'error'])
    expect(log[0][3]).toBeInstanceOf(TypeError)
  })

  it('la cancellazione stessa fallisce: 500, e il 500 si logga col codice', async () => {
    h.errori = { 'pagamenti:delete': { code: '23503', message: 'update or delete on table "pagamenti" violates foreign key constraint' } }
    const res = await DELETE(del(), ctx)
    expect(res.status).toBe(500)
    expect(h.db.pagamenti).toHaveLength(1)
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(h.logErrore.mock.calls[0][0]).toMatchObject({ operazione: 'pagamenti/[id]:DELETE', stato: 500, evento: 'db' })
    expect(h.logErrore.mock.calls[0][1]).toMatchObject({ code: '23503' })
    // Nessun audit di una cancellazione che non è avvenuta.
    expect(h.db.registro_modifiche).toEqual([])
  })
})
