import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * /admin/students — l'assegnazione in lotto che riesce solo in parte.
 *
 * `PATCH /api/admin/students` risponde 200 anche se una riga è rimasta indietro (`updated` conta quelle scritte,
 * `errori` elenca le altre). La pagina guardava solo `res.ok` e scriveva «2 alunni assegnati» sui 2 selezionati
 * anche quando ne erano passati 1: ora scrive «1 su 2» e lascia selezionato chi è rimasto indietro.
 *
 * Il controllo positivo (il caso di successo pieno) sta accanto, altrimenti «non dice N su M» passerebbe anche su
 * una pagina che non scrive nessun avviso.
 */

const h = vi.hoisted(() => ({ risposta: {} as Record<string, unknown> }))

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=child'),
  useParams: () => ({}),
  usePathname: () => '/admin/students',
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: null,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

const A1 = 'aaaa1111-0000-4000-8000-000000000001'
const A2 = 'aaaa1111-0000-4000-8000-000000000002'
const ALUNNI = [
  { id: A1, nome: 'Uno', cognome: 'Prova', classe_sezione: 'TEST 3 ANNI', stato: 'iscritto' },
  { id: A2, nome: 'Due', cognome: 'Prova', classe_sezione: 'TEST 3 ANNI', stato: 'iscritto' },
]

const fetchMock = vi.fn()
const ok = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo })

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const u = new URL(String(url), 'http://t.test')
    const p = u.pathname
    if (p.includes('/api/admin/sections/scoped')) return ok({ success: true, data: [] })
    if (p.includes('/api/admin/sections')) return ok([])
    if (p.includes('/api/admin/gruppi-mensa')) return ok({ success: true, data: [{ id: 'g1', nome: 'Turno 1' }] })
    if (p.includes('/api/admin/students')) {
      if (init?.method === 'PATCH') return ok(h.risposta)
      return ok(ALUNNI)
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

async function selezionaTuttiEAssegnaMensa() {
  render(<AdminStudentsPage />)
  await waitFor(() => expect(screen.getByText('Prova Uno')).toBeInTheDocument())
  const caselle = screen.getAllByRole('checkbox')
  fireEvent.click(caselle[0]) // seleziona tutti
  const tendina = await screen.findByDisplayValue('Gruppo mensa…')
  fireEvent.change(tendina, { target: { value: 'g1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Assegna mensa' }))
}

describe('Anagrafica — assegnazione in lotto: «N su M» quando qualcuno resta indietro', () => {
  it('2 selezionati, 1 scritto e 1 in errori: dice «1 alunno assegnato su 2» e NON «2 alunni assegnati»; resta selezionato uno solo', async () => {
    h.risposta = { success: true, updated: 1, data: [{ id: A1 }], errori: [{ id: A2, codice: 'SCRITTURA_INCOMPLETA' }] }
    await selezionaTuttiEAssegnaMensa()

    await waitFor(() => expect(screen.getByText(/1 alunno assegnato su 2 al gruppo mensa Turno 1/)).toBeInTheDocument())
    expect(screen.queryByText(/2 alunni assegnati/)).not.toBeInTheDocument()
    // il conteggio della barra: è rimasto selezionato solo chi non è riuscito
    await waitFor(() => expect(screen.getByText('selezionati').previousElementSibling?.textContent).toBe('1'))
  })

  it('CONTROLLO POSITIVO — tutti scritti: «2 alunni assegnati» e la selezione si svuota', async () => {
    h.risposta = { success: true, updated: 2, data: [{ id: A1 }, { id: A2 }] }
    await selezionaTuttiEAssegnaMensa()

    await waitFor(() => expect(screen.getByText(/2 alunni assegnati al gruppo mensa Turno 1/)).toBeInTheDocument())
    expect(screen.queryByText(/ su 2 al gruppo/)).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('selezionati')).not.toBeInTheDocument())
  })
})
