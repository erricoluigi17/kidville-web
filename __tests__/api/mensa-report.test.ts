import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Copre tre cose del GET /api/mensa/report:
//  · gate requireKitchenRead reale (segreteria/cuoca 200, genitore 403);
//  · A8 — enforcement sezione docente: l'educator vede SOLO le proprie sezioni
//    (sezione altrui → 403), sezione mancante → 400;
//  · B3 prerequisito — menu PER CLASSE: i conflitti allergie si calcolano sul menu
//    della classe di ciascun alunno (mensa_class_menu_assignment), non su un unico
//    menu legacy.

const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
const EDUCATOR = 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5'
const ADMIN = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  prenotazioni: [] as { alunno_id: string }[],
  alunni: [] as Record<string, unknown>[],
  sezioniDocente: [] as string[],
  configByClasse: {} as Record<string, string | null>,
  menuByConfig: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }) }))
vi.mock('@/lib/sezioni/docenti', () => ({
  nomiSezioniDiUtente: async () => h.sezioniDocente,
  sezioniDiUtente: async () => [],
}))
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

const req = (userId: string, qs = '') =>
  new NextRequest(`http://localhost/api/mensa/report${qs}`, { headers: { 'x-user-id': userId } })

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: SEGRETERIA, nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria', role: 'segreteria', scuola_id: 'sc-1' }
  h.prenotazioni = []
  h.alunni = []
  h.sezioniDocente = []
  h.configByClasse = {}
  h.menuByConfig = {}
})

describe('GET /api/mensa/report — gate requireKitchenRead (reale)', () => {
  it('SEGRETERIA → 200: il report cucina è leggibile allo sportello', async () => {
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.totale).toBe(0)
    // Contratto additivo: il campo esiste anche a zero prenotazioni.
    expect(j.data.alternative_automatiche).toEqual([])
  })

  it('cuoca → 200 (allowlist preesistente intatta)', async () => {
    h.utente = { ...h.utente, ruolo: 'cuoca', role: 'cuoca' }
    expect((await GET(req(SEGRETERIA))).status).toBe(200)
  })

  it('genitore → 403 (il gate resta chiuso ai non addetti)', async () => {
    h.utente = { ...h.utente, ruolo: 'genitore', role: 'genitore' }
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Accesso negato: operazione riservata a cucina/staff')
  })
})

describe('GET /api/mensa/report — A8 enforcement sezione docente', () => {
  beforeEach(() => {
    h.utente = { id: EDUCATOR, nome: 'Ed', cognome: 'Rossi', ruolo: 'educator', role: 'educator', scuola_id: 'sc-1' }
    h.sezioniDocente = ['Rossi']
  })

  it('educator senza sezione → 400', async () => {
    const res = await GET(req(EDUCATOR))
    expect(res.status).toBe(400)
  })

  it('educator che chiede una sezione NON sua → 403', async () => {
    const res = await GET(req(EDUCATOR, '?sezione=Blu'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Sezione non assegnata al docente')
  })

  it('educator che chiede la PROPRIA sezione → 200', async () => {
    const res = await GET(req(EDUCATOR, '?sezione=Rossi'))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })
})

describe('GET /api/mensa/report — B3 menu PER CLASSE nei conflitti', () => {
  beforeEach(() => {
    h.utente = { id: ADMIN, nome: 'Adm', cognome: 'In', ruolo: 'admin', role: 'admin', scuola_id: 'sc-1' }
    // Due classi con MENU DIVERSI: Rossi ha glutine nel primo, Blu no.
    h.configByClasse = { Rossi: 'menuR', Blu: 'menuB' }
    h.menuByConfig = {
      menuR: { attivo: true, chiuso: false, allergeni: { primo: ['glutine'] } },
      menuB: { attivo: true, chiuso: false, allergeni: { primo: [] } },
    }
    h.prenotazioni = [{ alunno_id: 'a1' }, { alunno_id: 'a2' }]
    h.alunni = [
      { id: 'a1', nome: 'Anna', cognome: 'A', classe_sezione: 'Rossi', allergeni: ['glutine'], allergies: null },
      { id: 'a2', nome: 'Bea', cognome: 'B', classe_sezione: 'Blu', allergeni: ['glutine'], allergies: null },
    ]
  })

  it('il conflitto nasce solo per la classe il cui menu contiene l\'allergene', async () => {
    const res = await GET(req(ADMIN))
    expect(res.status).toBe(200)
    const j = await res.json()

    const rossi = j.data.perClasse.find((c: { classe: string }) => c.classe === 'Rossi')
    const blu = j.data.perClasse.find((c: { classe: string }) => c.classe === 'Blu')
    // Stessa allergia (glutine) su entrambi, ma menu diversi → esito diverso.
    expect(rossi.alunni[0].conflitti.length).toBe(1)
    expect(blu.alunni[0].conflitti.length).toBe(0)
  })

  it('alternative_automatiche: un elemento per ogni prenotato in conflitto', async () => {
    const res = await GET(req(ADMIN))
    const j = await res.json()
    expect(j.data.alternative_automatiche).toHaveLength(1)
    const auto = j.data.alternative_automatiche[0]
    expect(auto.nome).toBe('Anna A')
    expect(auto.classe).toBe('Rossi')
    expect(auto.allergeni).toContain('glutine')
    expect(auto.allergeni_label).toContain('Glutine')
  })
})
