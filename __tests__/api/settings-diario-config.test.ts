import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

/**
 * PATCH /api/admin/settings — `diario_config` NON È PIÙ UN BAULE (2026-09-28).
 *
 * Fino a oggi `diario_config` passava come `z.unknown()`: niente di quello che conteneva aveva
 * effetto, quindi niente andava controllato. Da oggi le routine FUNZIONANO — spengono bottoni,
 * rifiutano scritture, compaiono nel diario dei genitori — e una lista rovinata avrebbe effetti
 * veri. Tre regole:
 *  · `routine_attive` contiene solo nomi di routine base;
 *  · ogni routine della scuola è valida (nome, icona, tipo di risposta, opzioni per la scelta)
 *    e ha un id suo; al massimo 20;
 *  · il TIPO DI RISPOSTA di una routine già salvata non cambia: le voci già scritte portano la
 *    fotografia del tipo vecchio, e la maestra ritroverebbe «Fatto» dove ora c'è un orario. Per
 *    cambiarlo si crea una routine nuova.
 * L'oggetto resta APERTO: le chiavi vecchie (`visibile_genitori_da`…) sono ancora salvate nelle
 * sedi, e il pannello le rimanda indietro a ogni «Salva» — rifiutarle vorrebbe dire non poter più
 * salvare il diario di Giugliano.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  upserted: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async () => {
  const { SEDE_A: SEDE } = await import('../fixtures/sedi')
  return { resolveScuolaScrittura: async () => ({ scuolaId: SEDE }), resolveScuoleAttive: async () => [SEDE] }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      let colonne = '*'
      b.select = (cols?: string) => { if (typeof cols === 'string') colonne = cols; return b }
      b.eq = () => b
      b.maybeSingle = async () => {
        if (!h.existing) return { data: null, error: null }
        if (colonne === '*') return { data: h.existing, error: null }
        const chieste = colonne.split(',').map((c) => c.trim()).filter(Boolean)
        const riga = h.existing as Record<string, unknown>
        return { data: Object.fromEntries(chieste.filter((c) => c in riga).map((c) => [c, riga[c]])), error: null }
      }
      b.upsert = (row: Record<string, unknown>) => {
        h.upserted = row
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/settings/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

const CREMA = { id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true }
const BIBERON = { id: 'e5f6a7b8', nome: 'Biberon', emoji: '🍼', risposta: 'scelta', opzioni: ['Poco', 'Tutto'], multipla: false, attiva: true }

const salva = (diario_config: unknown) => PATCH(req({ scuola_id: SEDE_A, diario_config }))

beforeEach(() => {
  vi.clearAllMocks()
  h.upserted = null
  h.existing = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('PATCH /api/admin/settings — `diario_config`', () => {
  it('il pannello salva routine base e routine della scuola, e le chiavi vecchie restano', async () => {
    const res = await salva({
      routine_attive: ['pasto', 'cambio'],
      routine_personalizzate: [CREMA, BIBERON],
      buffer_visibilita_min: 10,
      visibile_genitori_da: '09:00',
    })
    expect(res.status).toBe(200)
    const salvato = h.upserted?.diario_config as Record<string, unknown>
    expect(salvato.routine_attive).toEqual(['pasto', 'cambio'])
    expect(salvato.routine_personalizzate).toEqual([CREMA, BIBERON])
    expect(salvato, 'una chiave vecchia rifiutata = il diario di Giugliano non si salva più').toHaveProperty('visibile_genitori_da', '09:00')
  })

  it('nome e opzioni si salvano senza spazi ai bordi', async () => {
    await salva({ routine_personalizzate: [{ ...BIBERON, nome: '  Biberon  ', opzioni: [' Poco ', 'Tutto'] }] })
    const [r] = (h.upserted?.diario_config as { routine_personalizzate: Array<Record<string, unknown>> }).routine_personalizzate
    expect(r.nome).toBe('Biberon')
    expect(r.opzioni).toEqual(['Poco', 'Tutto'])
  })

  it.each([
    ['una routine base che non esiste', { routine_attive: ['pasto', 'pallone'] }],
    ['una scelta con una sola opzione', { routine_personalizzate: [{ ...BIBERON, opzioni: ['Poco'] }] }],
    ['opzioni ripetute', { routine_personalizzate: [{ ...BIBERON, opzioni: ['Poco', 'poco'] }] }],
    ['un nome vuoto', { routine_personalizzate: [{ ...CREMA, nome: '   ' }] }],
    ['un tipo di risposta inventato', { routine_personalizzate: [{ ...CREMA, risposta: 'pallone' }] }],
    ['un id fuori formato', { routine_personalizzate: [{ ...CREMA, id: '../x' }] }],
    ['due routine con lo stesso id', { routine_personalizzate: [CREMA, { ...CREMA, nome: 'Altra' }] }],
    ['più di 20 routine', { routine_personalizzate: Array.from({ length: 21 }, (_, i) => ({ ...CREMA, id: `a1b2c${String(i).padStart(3, '0')}` })) }],
    ['un ritardo di visibilità fuori scala', { buffer_visibilita_min: 500 }],
  ])('rifiutato con 400, e niente scritto: %s', async (_caso, config) => {
    const res = await salva(config)
    expect(res.status).toBe(400)
    expect(h.upserted).toBeNull()
  })

  it('il tipo di risposta di una routine GIÀ SALVATA non cambia: 422, e niente scritto', async () => {
    h.existing = { diario_config: { routine_personalizzate: [CREMA] } }
    const res = await salva({ routine_personalizzate: [{ ...CREMA, risposta: 'orario' }] })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ROUTINE_RISPOSTA_NON_MODIFICABILE')
    expect(h.upserted).toBeNull()
  })

  it('…ma nome, icona, opzioni e stato sì; e una routine tolta dalla lista sparisce', async () => {
    h.existing = { diario_config: { routine_personalizzate: [CREMA, BIBERON] } }
    const res = await salva({ routine_personalizzate: [{ ...BIBERON, nome: 'Latte', opzioni: ['Poco', 'Metà', 'Tutto'], attiva: false }] })
    expect(res.status).toBe(200)
    const lista = (h.upserted?.diario_config as { routine_personalizzate: Array<Record<string, unknown>> }).routine_personalizzate
    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ id: 'e5f6a7b8', nome: 'Latte', attiva: false })
  })
})
