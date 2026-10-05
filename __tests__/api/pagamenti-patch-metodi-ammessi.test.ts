import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'

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
      })
      return (h.colonnaAssente ? h.senzaColonnaMetodi(c, h.respinte) : c) as never
    },
  }
})

import { PATCH } from '@/app/api/pagamenti/[id]/route'

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
