import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Contabilità — 12 route che agivano sui SOLDI di un'altra sede.
//
// Il gate di ruolo c'era ovunque; lo scope da nessuna parte. Conoscendo l'uuid
// di un pagamento si incassava, si stornava, si scontava, si emetteva fattura e
// si leggeva il credito di una famiglia di un altro plesso.
//
// `pagamenti` ha già `scuola_id`, e per la contabilità è quello che conta: una
// retta appartiene a un plesso. Da qui `assertPagamentoInScope`.
// Il CREDITO invece è di una FAMIGLIA, e i genitori non hanno una sede propria
// (possono avere figli in due plessi): là lo scope passa dai figli.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const PAG_A = '11111111-1111-4111-8111-111111111111'
const PAG_B = '22222222-2222-4222-8222-222222222222'
const PAR_B = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireStaff,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET as INCASSI } from '@/app/api/pagamenti/incassi/route'
import { GET as CREDITO } from '@/app/api/pagamenti/credito/route'
import { GET as TUTORI } from '@/app/api/pagamenti/tutori/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)

const dbBase = (): DBFinto => ({
  sections: [{ id: 'sec-b', scuola_id: SEDE_B, name: '2 ANNI' }],
  utenti_scuole: [],
  utenti_sezioni: [],
  alunni: [
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  pagamenti: [
    { id: PAG_A, alunno_id: 'x', scuola_id: SEDE_A, importo: 100 },
    { id: PAG_B, alunno_id: ALU_B, scuola_id: SEDE_B, importo: 250 },
  ],
  incassi: [
    { id: 'inc-a', pagamento_id: PAG_A, importo: 100, metodo: 'contanti', note: 'INCASSO-SEDE-A' },
    { id: 'inc-b', pagamento_id: PAG_B, importo: 250, metodo: 'contanti', note: 'INCASSO-SEDE-B' },
  ],
  crediti_famiglia: [
    { id: 'cr-b', parent_id: PAR_B, importo: 80, saldo_dopo: 80, causale: 'CREDITO-SEDE-B' },
  ],
  student_parents: [
    { student_id: ALU_B, parent_id: PAR_B, alunni: { scuola_id: SEDE_B } },
  ],
  legame_genitori_alunni: [
    { genitore_id: PAR_B, alunno_id: ALU_B, utenti: { id: PAR_B, nome: 'Genitore', cognome: 'DiBeta', email: 'gen.b@example.invalid' } },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/pagamenti/incassi — gli incassi di un\'altra sede', () => {
  it('403 sul pagamento di un\'altra sede, senza leggere gli incassi', async () => {
    const res = await INCASSI(req(`/api/pagamenti/incassi?pagamento_id=${PAG_B}`))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('INCASSO-SEDE-B')
    expect(h.tabelle).not.toContain('incassi')
  })

  // Controllo positivo. `not.toBe(403)` sarebbe verde anche su un 500: fino al
  // 31/07 lo era davvero (audit R130). Qui si asserisce lo stato ESATTO e il
  // contenuto: il ledger della PROPRIA sede arriva, quello dell'altra no.
  it('passa sul pagamento della propria sede e restituisce il SUO ledger', async () => {
    const res = await INCASSI(req(`/api/pagamenti/incassi?pagamento_id=${PAG_A}`))
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: { id: string; note: string }[] }
    expect(corpo.data.map((r) => r.note)).toEqual(['INCASSO-SEDE-A'])
  })
})

describe('GET /api/pagamenti/credito — il credito è della FAMIGLIA', () => {
  it('403 sul genitore di un\'altra sede: lo scope passa dai figli', async () => {
    const res = await CREDITO(req(`/api/pagamenti/credito?parent_id=${PAR_B}`))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('CREDITO-SEDE-B')
  })
})

describe('GET /api/pagamenti/tutori — nomi ed email dei tutori', () => {
  it('403 sull\'alunno di un\'altra sede', async () => {
    const res = await TUTORI(req(`/api/pagamenti/tutori?alunno_id=${ALU_B}`))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('gen.b@example.invalid')
  })
})
