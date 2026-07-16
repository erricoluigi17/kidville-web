import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// B3 — il report espone alternative_automatiche[] (un elemento per ogni prenotato
// con conflitto allergie col menu della SUA classe). Il contratto del report resta
// ADDITIVO: i campi preesistenti (data, totale, perClasse, allergie) non cambiano
// forma né spariscono, i consumer attuali non regrediscono.

const ADMIN = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  prenotazioni: [] as { alunno_id: string }[],
  alunni: [] as Record<string, unknown>[],
  configByClasse: {} as Record<string, string | null>,
  menuByConfig: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }) }))
vi.mock('@/lib/sezioni/docenti', () => ({ nomiSezioniDiUtente: async () => [], sezioniDiUtente: async () => [] }))
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({ cutoffOra: '09:30', giorniAttivi: [1, 2, 3, 4, 5], settimaneRotazione: 4, sogliaSaldoBasso: 5 }),
  loadResolveOptions: async (_s: unknown, _sc: unknown, _cfg: unknown, menuConfigId?: string | null) => ({ menuConfigId: menuConfigId ?? null }),
  resolveMenuConfigId: async (_s: unknown, _sc: unknown, classe: string | null) => (classe ? (h.configByClasse[classe] ?? null) : null),
}))
vi.mock('@/lib/mensa/resolveMenu', () => ({
  resolveMenuGiorno: (_data: string, opts: { menuConfigId?: string | null }) =>
    h.menuByConfig[opts?.menuConfigId ?? '__legacy__'] ?? { attivo: false, chiuso: false, allergeni: null },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b; b.in = () => b; b.order = () => b
      b.single = async () => ({ data: h.utente, error: null })
      b.then = (res: (v: unknown) => void) => {
        if (table === 'mensa_prenotazioni') return res({ data: h.prenotazioni, error: null })
        if (table === 'alunni') return res({ data: h.alunni, error: null })
        return res({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/mensa/report/route'

const req = () => new NextRequest('http://localhost/api/mensa/report', { headers: { 'x-user-id': ADMIN } })

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: ADMIN, nome: 'Adm', cognome: 'In', ruolo: 'admin', role: 'admin', scuola_id: 'sc-1' }
  // Un solo menu con glutine; un alunno allergico al glutine, uno no.
  h.configByClasse = { Rossi: 'menuR' }
  h.menuByConfig = { menuR: { attivo: true, chiuso: false, allergeni: { primo: ['glutine'], secondo: ['latte'] } } }
  h.prenotazioni = [{ alunno_id: 'a1' }, { alunno_id: 'a2' }]
  h.alunni = [
    { id: 'a1', nome: 'Anna', cognome: 'A', classe_sezione: 'Rossi', allergeni: ['glutine'], allergies: null },
    { id: 'a2', nome: 'Bea', cognome: 'B', classe_sezione: 'Rossi', allergeni: [], allergies: null },
  ]
})

describe('GET /api/mensa/report — alternative_automatiche[]', () => {
  it('presente un elemento per ogni prenotato in conflitto (e solo quelli)', async () => {
    const j = await (await GET(req())).json()
    expect(Array.isArray(j.data.alternative_automatiche)).toBe(true)
    expect(j.data.alternative_automatiche).toHaveLength(1)
    const auto = j.data.alternative_automatiche[0]
    expect(auto.alunno_id).toBe('a1')
    expect(auto.nome).toBe('Anna A')
    expect(auto.classe).toBe('Rossi')
    expect(auto.allergeni).toContain('glutine')
    expect(auto.allergeni_label).toContain('Glutine')
  })

  it('nessun conflitto → alternative_automatiche vuoto (non manca il campo)', async () => {
    h.menuByConfig = { menuR: { attivo: true, chiuso: false, allergeni: { primo: [], secondo: [] } } }
    const j = await (await GET(req())).json()
    expect(j.data.alternative_automatiche).toEqual([])
  })
})

describe('GET /api/mensa/report — contratto ADDITIVO intatto', () => {
  it('i campi preesistenti restano invariati nella forma', async () => {
    const j = await (await GET(req())).json()
    expect(j.success).toBe(true)
    // data + totale
    expect(typeof j.data.data).toBe('string')
    expect(j.data.totale).toBe(2)
    // perClasse: [{ classe, conteggio, alunni: [{ id, nome, classe, allergeni, conflitti }] }]
    const rossi = j.data.perClasse.find((c: { classe: string }) => c.classe === 'Rossi')
    expect(rossi.conteggio).toBe(2)
    const anna = rossi.alunni.find((a: { id: string }) => a.id === 'a1')
    expect(anna).toMatchObject({ id: 'a1', nome: 'Anna A', classe: 'Rossi' })
    expect(Array.isArray(anna.allergeni)).toBe(true)
    expect(Array.isArray(anna.conflitti)).toBe(true)
    // allergie[]: shape { nome, classe, allergie, conflitto } preservata
    const alAnna = j.data.allergie.find((x: { nome: string }) => x.nome === 'Anna A')
    expect(alAnna).toMatchObject({ nome: 'Anna A', classe: 'Rossi', conflitto: true })
    expect(typeof alAnna.allergie).toBe('string')
  })
})
