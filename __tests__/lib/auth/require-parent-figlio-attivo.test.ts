import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type RispostaRpc } from '../../fixtures/finto-supabase'

/**
 * PR 4.4 · `requireParentOfStudent(…, { soloAttivo: true })`.
 *
 * Solo sul ramo del legame: lo staff e la docente-genitore in veste di lavoro su un bambino che non è suo non passano mai
 * dalla funzione. Le altre route restano col booleano di sempre, e non la chiamano.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  figliAttivi: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: h.assertAlunnoInScope }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, [], {
    rpc: { figli_attivi: () => h.figliAttivi() as RispostaRpc },
  }),
}))

import { requireParentOfStudent } from '@/lib/auth/require-parent'

const GEN = '99999999-9999-4999-8999-999999999991'
const FIGLIO = '11111111-1111-4111-8111-111111111111'
const ALTRO = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ = '55555555-5555-4555-8555-555555555551'
const FREQ = '66666666-6666-4666-8666-666666666661'

const req = () => new Request('http://localhost/api/gallery')
const riga = { alunno_id: FIGLIO, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    legame_genitori_alunni: [{ genitore_id: GEN, alunno_id: FIGLIO }],
    parents: [],
    student_parents: [],
    alunni: [{ id: FIGLIO, section_id: SEZ, stato: 'iscritto', archiviato_il: null }],
  }
  h.requireUser.mockResolvedValue({ user: { id: GEN, role: 'genitore', roles: ['genitore'], has_parent_profile: true } })
  h.figliAttivi.mockReturnValue({ data: [riga], error: null })
  h.assertAlunnoInScope.mockResolvedValue(null)
})

describe('requireParentOfStudent con `soloAttivo`', () => {
  it('figlio attivo: passa, e dice che la porta l’ha aperta il legame', async () => {
    const auth = await requireParentOfStudent(req(), FIGLIO, { soloAttivo: true })

    expect(auth.response).toBeUndefined()
    expect(auth.user?.id).toBe(GEN)
    expect(auth).toMatchObject({ perLegame: true })
  })

  it('figlio legato ma non attivo: 403 `FIGLIO_NON_ATTIVO`, e il rifiuto resta in tabella', async () => {
    h.figliAttivi.mockReturnValue({ data: [], error: null })

    const auth = await requireParentOfStudent(req(), FIGLIO, { soloAttivo: true })

    expect(auth.response?.status).toBe(403)
    expect(await auth.response?.json()).toMatchObject({ codice: 'FIGLIO_NON_ATTIVO' })
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'warn', expect.objectContaining({
      operazione: 'anno/visibilita:negato',
      tipo: 'figlio-non-attivo',
      utente: GEN,
      alunno_id: FIGLIO,
      stato: 403,
    }), undefined, { distingui: ['alunno_id'] })
  })

  it('la frequenza è viva ma manca la sezione: resta nascosto come oggi (`ALUNNO_NON_TROVATO`)', async () => {
    h.db.alunni[0].section_id = null
    h.figliAttivi.mockReturnValue({ data: [{ ...riga, section_id: null }], error: null })

    const auth = await requireParentOfStudent(req(), FIGLIO, { soloAttivo: true })

    expect(auth.response?.status).toBe(403)
    expect(await auth.response?.json()).toMatchObject({ codice: 'ALUNNO_NON_TROVATO' })
  })

  it('schema indietro: il controllo di oggi, e passa', async () => {
    h.figliAttivi.mockReturnValue({ data: null, error: { code: 'PGRST202', message: 'assente' } })

    const auth = await requireParentOfStudent(req(), FIGLIO, { soloAttivo: true })

    expect(auth.response).toBeUndefined()
    expect(auth).toMatchObject({ perLegame: true })
  })

  it('un guasto della funzione non apre: 500', async () => {
    h.figliAttivi.mockReturnValue({ data: null, error: { code: '57014', message: 'timeout' } })

    const auth = await requireParentOfStudent(req(), FIGLIO, { soloAttivo: true })

    expect(auth.response?.status).toBe(500)
    expect(await auth.response?.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
  })

  it('senza opzione la funzione non si chiama: le altre route restano come sono', async () => {
    const auth = await requireParentOfStudent(req(), FIGLIO)

    expect(auth.response).toBeUndefined()
    expect(h.figliAttivi).not.toHaveBeenCalled()
  })

  it('il booleano `false` di prestampati continua a valere', async () => {
    h.db.alunni[0].archiviato_il = '2026-10-01T10:00:00Z'

    const auth = await requireParentOfStudent(req(), FIGLIO, false)

    expect(auth.response).toBeUndefined()
    expect(h.figliAttivi).not.toHaveBeenCalled()
  })

  it('la docente-genitore in veste di lavoro su un bambino non suo non passa dalla funzione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN, role: 'educator', roles: ['educator'], has_parent_profile: true } })

    const auth = await requireParentOfStudent(req(), ALTRO, { soloAttivo: true })

    expect(auth.response).toBeUndefined()
    expect(h.assertAlunnoInScope).toHaveBeenCalled()
    expect(h.figliAttivi).not.toHaveBeenCalled()
    expect(auth).not.toMatchObject({ perLegame: true })
  })

  it('lo staff senza legame non passa dalla funzione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN, role: 'segreteria', roles: ['segreteria'] } })

    const auth = await requireParentOfStudent(req(), FIGLIO, { soloAttivo: true })

    expect(auth.response).toBeUndefined()
    expect(h.figliAttivi).not.toHaveBeenCalled()
  })
})
