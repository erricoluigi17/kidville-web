import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `POST /api/pagamenti/genera` — i METODI AMMESSI della voce (2026-10-05).
//
// La segreteria può emettere una voce pagabile «solo in contanti» o «solo con
// bonifico». Tre cose da provare, guardando lo STATO del finto DB e non la
// forma delle chiamate:
//  · un sottoinsieme proprio si SCRIVE su ogni riga generata (singole, padre e
//    rate);
//  · «tutti e due» NON si scrive: lo mette il default della colonna, e così il
//    caso normale non nomina mai la colonna — sul DB E2E della CI, che non è
//    migrato, non può fallire;
//  · sul DB senza la colonna (PGRST204) la generazione non si perde: si
//    ritenta senza, e lo si DICE con un `warn`.
// =============================================================================

const SEGRETERIA = '22222222-2222-4222-8222-222222222222'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'

const h = vi.hoisted(() => {
  const ERRORE_COLONNA = {
    code: 'PGRST204',
    message: "Could not find the 'metodi_ammessi' column of 'pagamenti' in the schema cache",
    details: null,
    hint: null,
  }

  /**
   * Il DB E2E della CI, NON migrato: la colonna `metodi_ammessi` non esiste.
   * PostgREST respinge con PGRST204 ogni insert/update su `pagamenti` che la
   * NOMINA, e accetta lo stesso corpo senza. Si emula così, sul CONTENUTO
   * della scrittura, e non con «il primo insert fallisce»: un finto a
   * contatore resterebbe verde anche se il ritentativo rimandasse la colonna.
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
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    db: {} as Record<string, Record<string, unknown>[]>,
    tabelle: [] as string[],
    scritture: [] as unknown[],
    colonnaAssente: false,
    respinte: [] as unknown[],
    senzaColonnaMetodi,
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...(a as [])),
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
      const c = creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as unknown as Scrittura[] })
      return (h.colonnaAssente ? h.senzaColonnaMetodi(c, h.respinte) : c) as never
    },
  }
})

import { POST } from '@/app/api/pagamenti/genera/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/pagamenti/genera', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const BASE = { descrizione: 'Gita al museo', importo: 10, scadenza: '2026-10-30', alunno_ids: [ALU_1, ALU_2] }
const RATE = [
  { importo: 60, scadenza: '2026-10-31' },
  { importo: 40, scadenza: '2026-11-30' },
]

const dbBase = (): DBFinto => ({
  alunni: [
    { id: ALU_1, scuola_id: SEDE_A, classe_sezione: '3 ANNI', section_id: 'sec-a', stato: 'iscritto' },
    { id: ALU_2, scuola_id: SEDE_A, classe_sezione: '3 ANNI', section_id: 'sec-a', stato: 'iscritto' },
  ],
  pagamenti: [],
  registro_modifiche: [],
})

const pagamenti = () => h.db.pagamenti as Riga[]
const scrittureSuPagamenti = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'pagamenti' && s.operazione === 'insert')
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.respinte = []
  h.colonnaAssente = false
  h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('POST /api/pagamenti/genera — metodi ammessi', () => {
  it('«solo contanti»: 201 e OGNI riga generata porta metodi_ammessi = [contanti]', async () => {
    const res = await POST(post({ ...BASE, metodi_ammessi: ['contanti'] }))
    expect(res.status).toBe(201)
    expect(pagamenti()).toHaveLength(2)
    for (const r of pagamenti()) expect(r.metodi_ammessi).toEqual(['contanti'])
    // l'audit dice cosa è stato scritto
    const audit = (h.db.registro_modifiche as Riga[])[0]
    expect(audit.nuovo_valore).toMatchObject({ metodi_ammessi: ['contanti'], generati: 2 })
    // e il successo si logga: senza, «nessun log» non distingue «scritto» da «mai partito»
    expect(eventi('metodi-ammessi-scritti')).toHaveLength(1)
    expect(eventi('metodi-ammessi-scritti')[0].slice(0, 2)).toEqual(['pagamento', 'info'])
    expect(eventi('metodi-ammessi-scritti')[0][2]).toMatchObject({ solo_contanti: true, generati: 2 })
  })

  it.each([
    ['assenti', undefined],
    ['tutti e due', ['contanti', 'bonifico']],
    ['tutti e due, in ordine inverso', ['bonifico', 'contanti']],
  ])('metodi %s: la riga NON nomina la colonna (decide il default del DB)', async (_n, metodi) => {
    const res = await POST(post({ ...BASE, ...(metodi ? { metodi_ammessi: metodi } : {}) }))
    expect(res.status).toBe(201)
    expect(pagamenti()).toHaveLength(2)
    for (const r of pagamenti()) expect(r).not.toHaveProperty('metodi_ammessi')
    for (const s of scrittureSuPagamenti()) {
      for (const v of s.valori) expect(v).not.toHaveProperty('metodi_ammessi')
    }
    expect(eventi('metodi-ammessi-scritti')).toHaveLength(0)
  })

  it.each([
    ['vuoto', []],
    ['metodo ignoto', ['pos']],
    ['metodo ripetuto', ['contanti', 'contanti']],
  ])('metodi_ammessi %s ⇒ 400 e nessun insert', async (_n, metodi) => {
    const res = await POST(post({ ...BASE, metodi_ammessi: metodi }))
    expect(res.status).toBe(400)
    expect(pagamenti()).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('piano rateale «solo contanti»: il PADRE e TUTTE le rate portano il metodo', async () => {
    const res = await POST(post({
      descrizione: 'Corso di nuoto', rate: RATE, alunno_ids: [ALU_1], metodi_ammessi: ['contanti'],
    }))
    expect(res.status).toBe(201)
    const padri = pagamenti().filter((r) => r.tipo === 'padre')
    const rate = pagamenti().filter((r) => r.tipo === 'rata')
    expect(padri).toHaveLength(1)
    expect(rate).toHaveLength(2)
    expect(padri[0].metodi_ammessi).toEqual(['contanti'])
    for (const r of rate) {
      expect(r.metodi_ammessi).toEqual(['contanti'])
      expect(r.parent_payment_id).toBe(padri[0].id)
    }
  })

  describe('DB senza la colonna (E2E della CI, non migrato)', () => {
    beforeEach(() => { h.colonnaAssente = true })

    it('voci singole: PGRST204 ⇒ si ritenta SENZA la colonna, 201, e un warn lo dice', async () => {
      const res = await POST(post({ ...BASE, metodi_ammessi: ['contanti'] }))
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ success: true, data: { generati: 2 } })
      // il primo tentativo è stato respinto proprio perché nominava la colonna…
      expect(h.respinte).toHaveLength(1)
      // …e le righe ci sono, senza la colonna
      expect(pagamenti()).toHaveLength(2)
      for (const r of pagamenti()) expect(r).not.toHaveProperty('metodi_ammessi')
      const warn = eventi('metodi-ammessi-colonna-assente')
      expect(warn).toHaveLength(1)
      expect(warn[0].slice(0, 2)).toEqual(['pagamento', 'warn'])
      expect(warn[0][2]).toMatchObject({ operazione: 'pagamenti/genera:POST', tipo: 'singolo' })
      // non si finge: niente log di «scritti», e l'audit non li registra
      expect(eventi('metodi-ammessi-scritti')).toHaveLength(0)
      expect((h.db.registro_modifiche as Riga[])[0].nuovo_valore).toMatchObject({ metodi_ammessi: null })
    })

    it('piano rateale: padre e rate nascono lo stesso, per ogni alunno, con UN solo warn', async () => {
      const res = await POST(post({
        descrizione: 'Corso di nuoto', rate: RATE, alunno_ids: [ALU_1, ALU_2], metodi_ammessi: ['contanti'],
      }))
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ data: { generati: 2 } })
      expect(pagamenti().filter((r) => r.tipo === 'padre')).toHaveLength(2)
      expect(pagamenti().filter((r) => r.tipo === 'rata')).toHaveLength(4)
      for (const r of pagamenti()) expect(r).not.toHaveProperty('metodi_ammessi')
      expect(eventi('metodi-ammessi-colonna-assente')).toHaveLength(1)
      expect(eventi('metodi-ammessi-scritti')).toHaveLength(0)
    })

    it('«tutti e due»: la colonna non si nomina, quindi nessun rifiuto e nessun warn', async () => {
      const res = await POST(post({ ...BASE, metodi_ammessi: ['contanti', 'bonifico'] }))
      expect(res.status).toBe(201)
      expect(h.respinte).toHaveLength(0)
      expect(pagamenti()).toHaveLength(2)
      expect(eventi('metodi-ammessi-colonna-assente')).toHaveLength(0)
    })
  })
})
