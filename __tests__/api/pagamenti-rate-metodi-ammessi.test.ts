import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `POST /api/pagamenti/rate` — i METODI AMMESSI del piano (revisione finale,
// 2026-10-05).
//
// «Dividi in acconti» SOSTITUISCE una voce: crea padre + rate con questa rotta e
// poi cancella l'originale. Senza metodi, una voce «solo contanti» rinasceva
// pagabile anche con bonifico — e il vincolo spariva insieme alla voce. Ora:
//  · un sottoinsieme proprio si SCRIVE sul padre E su ogni rata;
//  · «tutti e due» (o assente: «Acquisto rapido» non li manda) NON si scrive —
//    lo mette il default della colonna, e il DB E2E della CI non migrato non
//    vede mai nominare la colonna;
//  · sul DB senza la colonna (PGRST204/42703) il piano nasce lo stesso: si
//    ritenta senza, e lo si DICE con un `warn` (stessa forma di `genera`);
//  · `[]` è un 400, senza scritture.
// Si guarda lo STATO del finto DB, non la forma delle chiamate.
// =============================================================================

const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => {
  /**
   * Il DB senza la colonna `metodi_ammessi`: PostgREST respinge ogni insert su
   * `pagamenti` che la NOMINA e accetta lo stesso corpo senza. Si emula sul
   * CONTENUTO della scrittura, non con «il primo insert fallisce»: un finto a
   * contatore resterebbe verde anche se il ritentativo rimandasse la colonna.
   */
  function senzaColonnaMetodi<T extends object>(client: T, respinte: unknown[], codice: string): T {
    const respinta = () => {
      const r = {
        data: null,
        error: { code: codice, message: 'column "metodi_ammessi" does not exist', details: null, hint: null },
        count: null,
        status: 400,
        statusText: 'Bad Request',
      }
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
              if (qp !== 'insert') return m
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
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    db: {} as Record<string, Record<string, unknown>[]>,
    tabelle: [] as string[],
    scritture: [] as unknown[],
    colonnaAssente: null as null | string,
    respinte: [] as unknown[],
    senzaColonnaMetodi,
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Lo scope ha i suoi test: qui conta che cosa si SCRIVE, non chi può.
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => null }))
vi.mock('@/lib/logging/logger', () => ({
  logOk: () => {},
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const c = creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as unknown as Scrittura[] })
      return (h.colonnaAssente ? h.senzaColonnaMetodi(c, h.respinte, h.colonnaAssente) : c) as never
    },
  }
})

import { POST } from '@/app/api/pagamenti/rate/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/pagamenti/rate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const PIANO = {
  alunno_id: ALU,
  descrizione: 'Corso di nuoto',
  importo_totale: 100,
  rate: [
    { importo: 60, scadenza: '2026-10-31' },
    { importo: 40, scadenza: '2026-11-30' },
  ],
}

const dbBase = (): DBFinto => ({
  alunni: [{ id: ALU, scuola_id: SEDE_A, classe_sezione: '3 ANNI', section_id: 'sec-a', stato: 'iscritto' }],
  pagamenti: [],
})

const pagamenti = () => h.db.pagamenti as Riga[]
const padri = () => pagamenti().filter((r) => r.tipo === 'padre')
const rate = () => pagamenti().filter((r) => r.tipo === 'rata')
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.respinte = []
  h.colonnaAssente = null
  h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('POST /api/pagamenti/rate — metodi ammessi', () => {
  it('«solo contanti»: 201, e il PADRE e OGNI rata portano metodi_ammessi = [contanti]', async () => {
    const res = await POST(post({ ...PIANO, metodi_ammessi: ['contanti'] }))
    expect(res.status).toBe(201)
    expect(padri()).toHaveLength(1)
    expect(rate()).toHaveLength(2)
    expect(padri()[0].metodi_ammessi).toEqual(['contanti'])
    for (const r of rate()) {
      expect(r.metodi_ammessi).toEqual(['contanti'])
      expect(r.parent_payment_id).toBe(padri()[0].id)
    }
    // Il successo si dice: senza, «nessun log» non distingue «scritto» da «mai partito».
    const ok = eventi('metodi-ammessi-scritti')
    expect(ok).toHaveLength(1)
    expect(ok[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(ok[0][2]).toMatchObject({ operazione: 'pagamenti/rate:POST', solo_contanti: true })
  })

  it('«solo bonifico» si scrive allo stesso modo', async () => {
    const res = await POST(post({ ...PIANO, metodi_ammessi: ['bonifico'] }))
    expect(res.status).toBe(201)
    for (const r of pagamenti()) expect(r.metodi_ammessi).toEqual(['bonifico'])
  })

  it.each([
    ['assenti («Acquisto rapido» non li manda)', undefined],
    ['tutti e due', ['contanti', 'bonifico']],
    ['tutti e due, in ordine inverso', ['bonifico', 'contanti']],
  ])('metodi %s: nessuna riga nomina la colonna (decide il default del DB)', async (_n, metodi) => {
    const res = await POST(post({ ...PIANO, ...(metodi ? { metodi_ammessi: metodi } : {}) }))
    expect(res.status).toBe(201)
    // Presenza prima: il piano c'è davvero.
    expect(pagamenti()).toHaveLength(3)
    for (const r of pagamenti()) expect(r).not.toHaveProperty('metodi_ammessi')
    for (const s of h.scritture as Scrittura[]) {
      for (const v of s.valori ?? []) expect(v).not.toHaveProperty('metodi_ammessi')
    }
    expect(eventi('metodi-ammessi-scritti')).toHaveLength(0)
  })

  it.each([
    ['vuoto', []],
    ['metodo ignoto', ['pos']],
    ['metodo ripetuto', ['contanti', 'contanti']],
  ])('metodi_ammessi %s ⇒ 400 e nessuna scrittura', async (_n, metodi) => {
    const res = await POST(post({ ...PIANO, metodi_ammessi: metodi }))
    expect(res.status).toBe(400)
    expect(pagamenti()).toEqual([])
    expect(h.scritture).toEqual([])
  })

  describe.each(['PGRST204', '42703'])('DB senza la colonna (%s, E2E della CI non migrato)', (codice) => {
    beforeEach(() => { h.colonnaAssente = codice })

    it('padre e rate nascono lo stesso, senza la colonna, e UN warn lo dice', async () => {
      const res = await POST(post({ ...PIANO, metodi_ammessi: ['contanti'] }))
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ success: true })
      // Il primo tentativo è stato respinto proprio perché nominava la colonna…
      expect(h.respinte.length).toBeGreaterThanOrEqual(1)
      // …e il piano c'è, intero, senza la colonna.
      expect(padri()).toHaveLength(1)
      expect(rate()).toHaveLength(2)
      for (const r of pagamenti()) expect(r).not.toHaveProperty('metodi_ammessi')
      const warn = eventi('metodi-ammessi-colonna-assente')
      expect(warn).toHaveLength(1)
      expect(warn[0].slice(0, 2)).toEqual(['pagamento', 'warn'])
      expect(warn[0][2]).toMatchObject({ operazione: 'pagamenti/rate:POST', tipo: 'padre' })
      // Non si finge: niente «scritti».
      expect(eventi('metodi-ammessi-scritti')).toHaveLength(0)
    })

    it('«tutti e due»: la colonna non si nomina, quindi nessun rifiuto e nessun warn', async () => {
      const res = await POST(post({ ...PIANO, metodi_ammessi: ['contanti', 'bonifico'] }))
      expect(res.status).toBe(201)
      expect(h.respinte).toHaveLength(0)
      expect(pagamenti()).toHaveLength(3)
      expect(eventi('metodi-ammessi-colonna-assente')).toHaveLength(0)
    })
  })
})
