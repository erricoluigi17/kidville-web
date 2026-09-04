import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * L'anteprima delle rette DEVE far vedere un anello, invece di lasciarlo passare.
 *
 * ─── IL CASO VERO, misurato in produzione il 2026-09-04 ──────────────────────
 * A Kidville Giugliano un bambino con `importo_retta_mensile = 250` era marcato
 * `retta_a_carico_di` un fratello che aveva **0,01 €**. Entrambe le strade che
 * generano le rette saltano chi è a carico di un altro, quindi:
 *
 *   · il bambino da 250 € non generava nulla;
 *   · il fratello generava 0,01 €;
 *   · la famiglia è stata addebitata di **un centesimo** per settembre 2026.
 *
 * L'anteprima mostrava quella riga come una riga qualunque — «€ 0,01» in mezzo a una
 * colonna di importi — e nessun log diceva niente. Nove mesi così sono 2.250 € che
 * nessuno avrebbe mai chiesto, e il modo per accorgersene non esisteva.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  alunni: [] as Record<string, unknown>[],
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['sc-1'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
}))
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return { ...m, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.is = () => b
      b.or = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'admin_settings' ? { retta_default_importo: 150, scuola_id: 'sc-1' } : null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'alunni') return resolve({ data: h.alunni, error: null })
        if (table === 'payment_categories') return resolve({ data: [{ id: 'cat-retta', scuola_id: null }], error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/genera-rette/route'

const url = (qs: string) => new Request(`http://localhost/api/pagamenti/genera-rette?${qs}`)

/** Il PAGANTE ha un centesimo; il fratello, con la retta vera, è a suo carico. */
const PAGANTE = 'al-centesimo'
const A_CARICO = 'al-duecentocinquanta'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.alunni = [
    { id: PAGANTE, nome: 'Anna', cognome: 'Bianchi', classe_sezione: '1A', section_id: null, importo_retta_mensile: 0.01, data_iscrizione: null, retta_a_carico_di: null },
    { id: A_CARICO, nome: 'Luca', cognome: 'Bianchi', classe_sezione: '2A', section_id: null, importo_retta_mensile: 250, data_iscrizione: null, retta_a_carico_di: PAGANTE },
    { id: 'al-normale', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', section_id: null, importo_retta_mensile: 200, data_iscrizione: null, retta_a_carico_di: null },
  ]
})

describe('anteprima rette · l’anello si vede', () => {
  it('contrassegna l’importo simbolico e dice per quanti fratelli paga', async () => {
    const j = await (await GET(url('periodo=2026-09-01'))).json()
    const candidati = j.data.candidati as Array<Record<string, unknown>>

    const centesimo = candidati.find((c) => c.id === PAGANTE)!
    expect(centesimo.importo_previsto).toBe(0.01)
    expect(centesimo.importo_simbolico).toBe(true)
    expect(centesimo.paga_per).toBe(1)

    // Chi è a carico di un altro non è candidato: è il filtro che c'era già, ed è
    // proprio quello che rende l'anello invisibile senza il contrassegno.
    expect(candidati.find((c) => c.id === A_CARICO)).toBeUndefined()
  })

  it('un importo normale NON viene contrassegnato', async () => {
    const j = await (await GET(url('periodo=2026-09-01'))).json()
    const normale = (j.data.candidati as Array<Record<string, unknown>>).find((c) => c.id === 'al-normale')!
    expect(normale.importo_simbolico).toBe(false)
    expect(normale.paga_per).toBe(0)
  })

  it('lo ZERO non è un importo simbolico: significa «usa il default di sede»', async () => {
    h.alunni = [{ id: 'a0', nome: 'Zoe', cognome: 'Neri', classe_sezione: '1A', section_id: null, importo_retta_mensile: 0, data_iscrizione: null, retta_a_carico_di: null }]
    const j = await (await GET(url('periodo=2026-09-01'))).json()
    const c = (j.data.candidati as Array<Record<string, unknown>>)[0]
    expect(c.importo_previsto).toBe(150)
    expect(c.importo_simbolico).toBe(false)
  })

  it('lo scrive anche nei LOG, con i soli conteggi', async () => {
    await GET(url('periodo=2026-09-01'))
    const righe = h.logEvento.mock.calls.filter((c) => c[2]?.esito === 'famiglie-totale-sospetto')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('warn')
    expect(righe[0][2].n).toBe(1)
    // Mai nomi, mai codici fiscali: sono dati di minori (AGENTS.md, regola 8).
    const campi = JSON.stringify(righe[0][2])
    expect(campi).not.toContain('Anna')
    expect(campi).not.toContain('Bianchi')
  })

  it('senza famiglie sospette non logga niente: il warn deve restare raro per essere letto', async () => {
    h.alunni = [{ id: 'al-normale', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', section_id: null, importo_retta_mensile: 200, data_iscrizione: null, retta_a_carico_di: null }]
    await GET(url('periodo=2026-09-01'))
    expect(h.logEvento.mock.calls.filter((c) => c[2]?.esito === 'famiglie-totale-sospetto')).toHaveLength(0)
  })
})
