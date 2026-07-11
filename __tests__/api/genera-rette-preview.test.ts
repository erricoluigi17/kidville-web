import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  alunni: [] as Record<string, unknown>[],
  esistenti: [] as Record<string, unknown>[],
  colonnaMancante: false,
  selects: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let selectArg = ''
      const b: Record<string, unknown> = {}
      b.select = (arg: string) => { selectArg = arg ?? ''; h.selects.push(`${table}:${selectArg}`); return b }
      b.eq = () => b
      b.in = () => b
      b.is = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'payment_categories' ? { id: 'cat-retta' } : table === 'admin_settings' ? { retta_default_importo: 150, scuola_id: 'sc-1' } : null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'alunni') {
          if (h.colonnaMancante && selectArg.includes('data_iscrizione')) {
            return resolve({ data: null, error: { code: '42703', message: 'column alunni.data_iscrizione does not exist' } })
          }
          return resolve({ data: h.alunni, error: null })
        }
        return resolve({ data: table === 'pagamenti' ? h.esistenti : [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/genera-rette/route'

const url = (qs: string) => new Request(`http://localhost/api/pagamenti/genera-rette?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.selects = []
  h.colonnaMancante = false
  h.esistenti = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.alunni = [
    // iscritto a novembre: candidato SOLO da novembre in poi
    { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', section_id: null, importo_retta_mensile: 0, data_iscrizione: '2026-11-15' },
    // storico (NULL): candidato per tutto l'anno
    { id: 'a2', nome: 'Lia', cognome: 'Bianchi', classe_sezione: '1A', section_id: null, importo_retta_mensile: 0, data_iscrizione: null },
    // senza sezione: MAI candidato (non frequentante)
    { id: 'a3', nome: 'Ugo', cognome: 'Verdi', classe_sezione: null, section_id: null, importo_retta_mensile: 0, data_iscrizione: null },
  ]
})

describe('GET /api/pagamenti/genera-rette — preview con data_iscrizione', () => {
  it('annuale: prima del mese di iscrizione l\'alunno non è candidato', async () => {
    const res = await GET(url('anno=2026'))
    expect(res.status).toBe(200)
    const j = await res.json()
    const settembre = j.data.mesi.find((m: { periodo: string }) => m.periodo === '2026-09-01')
    const novembre = j.data.mesi.find((m: { periodo: string }) => m.periodo === '2026-11-01')
    expect(settembre.candidati).toBe(1) // solo a2 (a1 non ancora iscritto, a3 senza sezione)
    expect(novembre.candidati).toBe(2)  // a1 + a2
    expect(j.data.alunni_attivi).toBe(2)
  })

  it('mensile: stesso filtro sul periodo richiesto', async () => {
    const res = await GET(url('periodo=2026-09'))
    const j = await res.json()
    expect(j.data.candidati).toHaveLength(1)
    expect(j.data.candidati[0].id).toBe('a2')
  })

  it('DB senza la colonna (CI): retry senza data_iscrizione, tutti gli in-sezione candidati', async () => {
    h.colonnaMancante = true
    h.alunni = h.alunni.map((a) => { const resto = { ...a }; delete resto.data_iscrizione; return resto })
    const res = await GET(url('periodo=2026-09'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.candidati).toHaveLength(2) // a1+a2 (senza colonna = iscritti da sempre)
  })
})
