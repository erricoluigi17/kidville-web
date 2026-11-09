import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · GET /api/parent/forms: i moduli da firmare arrivano per uuid di sezione, ai figli attivi. Il caso che decide è la
 * sezione omonima: due bambini con lo stesso `classe_sezione` in due sezioni diverse. Solo uuid finti.
 */

const GEN_A = '99999999-9999-4999-8999-999999999991'
const GEN_B = '99999999-9999-4999-8999-999999999992'
const FIGLIO_A = '11111111-1111-4111-8111-111111111111'
const FIGLIO_B = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_ALTRA = '22222222-2222-4222-8222-222222222223'
const SEZ_A = '55555555-5555-4555-8555-555555555551'
const SEZ_B = '55555555-5555-4555-8555-555555555552'
const FREQ = '66666666-6666-4666-8666-666666666661'
const MODULO_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const MODULO_SENZA_UUID = 'aaaaaaaa-0000-4000-8000-000000000002'

type Rpc = (args: Riga) => RispostaRpc

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  figliAttivi: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, h.lette, {
    rpc: { figli_attivi: (args: Riga) => (h.figliAttivi as Rpc)(args) },
  }),
}))

import { GET } from '@/app/api/parent/forms/route'

const req = () => new Request('http://test/api/parent/forms') as never
const riga = (alunno: string, sezione: string | null, sede = SEDE) => ({
  alunno_id: alunno, frequenza_id: FREQ, section_id: sezione, scuola_id: sede,
})
const famiglia = (id: string) => ({ user: { id, role: 'genitore', ruoli: ['genitore'] } })
const modulo = (id: string, extra: Record<string, unknown>) => ({
  id, title: 't', description: 'd', form_type: 'autorizzazione', fields: [], expiration_date: null, scuola_id: SEDE, target_scope: 'class',
  target_classes: ['Girasoli'], target_section_ids: [SEZ_A], ...extra,
})

const moduli = async () => {
  const res = await GET(req())
  expect(res.status).toBe(200)
  return await res.json() as Array<{ form_id: string; student: { id: string }; status: string }>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.lette.length = 0
  h.db = {
    legame_genitori_alunni: [
      { genitore_id: GEN_A, alunno_id: FIGLIO_A },
      { genitore_id: GEN_B, alunno_id: FIGLIO_B },
    ],
    parents: [],
    student_parents: [],
    alunni: [
      { id: FIGLIO_A, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', scuola_id: SEDE },
      { id: FIGLIO_B, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', scuola_id: SEDE },
    ],
    forms_templates: [
      modulo(MODULO_A, {}),
      modulo(MODULO_SENZA_UUID, { target_section_ids: null }),
    ],
    forms_submissions: [],
  }
  h.requireUser.mockResolvedValue(famiglia(GEN_A))
  h.figliAttivi = ((args: Riga) => ({
    data: [args.p_utente === GEN_A ? riga(FIGLIO_A, SEZ_A) : riga(FIGLIO_B, SEZ_B)],
    error: null,
  })) as Rpc
})

describe('GET /api/parent/forms', () => {
  it('il modulo arriva per uuid di sezione, e una sola volta per figlio', async () => {
    const r = await moduli()

    expect(r.map((m) => [m.form_id, m.student.id])).toEqual([[MODULO_A, FIGLIO_A]])
    expect(r[0].status).toBe('pending')
  })

  it('la sezione omonima non lo riceve', async () => {
    h.requireUser.mockResolvedValue(famiglia(GEN_B))

    expect(await moduli()).toEqual([])
  })

  it('un modulo scritto in nomi che nessuna sezione ha non arriva a nessuno', async () => {
    const r = await moduli()

    expect(r.map((m) => m.form_id)).not.toContain(MODULO_SENZA_UUID)
  })

  it('un bambino vivo in due sedi riceve il modulo dalla sede giusta', async () => {
    h.db.forms_templates = [modulo(MODULO_A, { scuola_id: SEDE_ALTRA, target_section_ids: [SEZ_B] })]
    h.figliAttivi = (() => ({ data: [riga(FIGLIO_A, SEZ_A), riga(FIGLIO_A, SEZ_B, SEDE_ALTRA)], error: null })) as Rpc

    const r = await moduli()

    expect(r.map((m) => [m.form_id, m.student.id])).toEqual([[MODULO_A, FIGLIO_A]])
  })

  it('la stessa sezione in un’altra sede non conta: la sede del modulo è quella della frequenza', async () => {
    h.db.forms_templates = [modulo(MODULO_A, { scuola_id: SEDE_ALTRA, target_section_ids: [SEZ_A] })]

    expect(await moduli()).toEqual([])
  })

  it('anche se il genitore ha un figlio pure nell’altra sede: il modulo si legge, ma la sezione è di un’altra frequenza', async () => {
    h.db.forms_templates = [modulo(MODULO_A, { scuola_id: SEDE_ALTRA, target_section_ids: [SEZ_A] })]
    h.figliAttivi = (() => ({ data: [riga(FIGLIO_A, SEZ_A), riga(FIGLIO_A, SEZ_B, SEDE_ALTRA)], error: null })) as Rpc

    expect(await moduli()).toEqual([])
    expect(h.lette).toContain('forms_templates')
  })

  it('nessun figlio attivo: lista vuota, e i moduli non si leggono', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    expect(await moduli()).toEqual([])
    expect(h.lette).not.toContain('forms_templates')
  })

  it('un guasto della funzione non apre: 500, e i moduli non si leggono', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    const res = await GET(req())

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.lette).not.toContain('forms_templates')
  })

  it('schema indietro: il confronto per nome di oggi', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc
    h.db.forms_templates = [modulo(MODULO_A, { target_section_ids: undefined })]
    h.requireUser.mockResolvedValue(famiglia(GEN_B))

    const r = await moduli()

    expect(r.map((m) => [m.form_id, m.student.id])).toEqual([[MODULO_A, FIGLIO_B]])
  })
})
