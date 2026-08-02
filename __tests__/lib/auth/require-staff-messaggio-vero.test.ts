import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S27 — «Accesso negato: operazione riservata allo staff» DETTO A UNO STAFF.
//
// Misurato il 2026-07-31 (collaudo frontend F1): la segreteria apriva il
// dettaglio di una sezione e leggeva in cima una fascia rossa con scritto
// «operazione riservata allo staff» — mentre `requireStaff` la considera staff
// a tutti gli effetti (è nel default del gate, PRD §3). La frase era falsa: la
// funzione era riservata alla DIREZIONE, cioè alla lista esplicita
// `['admin','coordinator']` che quella route passava.
//
// Un messaggio d'errore che dice il falso non è un dettaglio di cortesia: è la
// sola informazione che l'operatore ha per capire se deve chiedere un permesso
// o segnalare un guasto. Chi legge «riservata allo staff» ed È staff conclude
// che l'applicazione è rotta, e apre una segnalazione che nessuno può chiudere.
//
// Qui si asserisce il TESTO che esce dalla risposta, per entrambe le forme del
// gate — perché l'asserzione negativa da sola («non dice staff») passerebbe
// anche se il messaggio diventasse vuoto.
// =============================================================================

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  utentiMaybeSingle: vi.fn(),
  parentsMaybeSingle: vi.fn(),
  utentiSingle: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mocks.getUser } }),
  createAdminClient: vi.fn().mockResolvedValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: table === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
          single: mocks.utentiSingle,
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))

import { requireStaff } from '@/lib/auth/require-staff'
import { SEDE_A } from '../../fixtures/sedi'

const SEGRETERIA = {
  id: 'd0000000-0000-4000-8000-00000000e600',
  nome: 'X',
  cognome: 'Y',
  ruolo: 'segreteria',
  role: 'segreteria',
  scuola_id: SEDE_A,
}
const GENITORE = { ...SEGRETERIA, id: 'd0000000-0000-4000-8000-000000009e00', ruolo: 'genitore', role: 'genitore' }

const richiesta = (id: string) =>
  new Request('http://localhost/api/admin/sections/x/teachers', { headers: { 'x-user-id': id } })

/** Il testo che l'operatore legge davvero: quello dentro il corpo della 403. */
async function messaggioDelDiniego(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string }
  return body.error ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
  mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null })
})

describe('requireStaff — il 403 dice CHI può, e dice il vero', () => {
  it('gate di sola Direzione: alla segreteria dice «riservata alla Direzione», non «allo staff»', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: SEGRETERIA, error: null })

    const auth = await requireStaff(richiesta(SEGRETERIA.id), ['admin', 'coordinator'])

    expect(auth.response?.status).toBe(403)
    const testo = await messaggioDelDiniego(auth.response!)
    // Il controllo POSITIVO: il messaggio nomina l'organo che può davvero.
    expect(testo).toBe('Accesso negato: operazione riservata alla Direzione')
    // …e solo insieme al positivo vale il negativo: la parola falsa è sparita.
    expect(testo).not.toContain('staff')
  })

  it('gate staff (default): a un genitore dice ancora «riservata allo staff» — lì è vero', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: GENITORE, error: null })

    const auth = await requireStaff(richiesta(GENITORE.id))

    expect(auth.response?.status).toBe(403)
    expect(await messaggioDelDiniego(auth.response!)).toBe('Accesso negato: operazione riservata allo staff')
  })

  it('la segreteria passa il gate staff: è staff, e il default del gate lo dice da sempre', async () => {
    mocks.utentiSingle.mockResolvedValue({ data: SEGRETERIA, error: null })

    const auth = await requireStaff(richiesta(SEGRETERIA.id))

    expect(auth.response).toBeUndefined()
    expect(auth.user?.role).toBe('segreteria')
  })
})
