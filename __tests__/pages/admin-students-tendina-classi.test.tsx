import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, within } from '@testing-library/react'

import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * W3-B (R71) — Anagrafica alunni: il filtro «classe» e la barra di assegnazione
 * massiva elencavano le sezioni di TUTTE le sedi attive, per nome.
 *
 * Con tre plessi la tendina mostrava «3 ANNI», «3 ANNI», «3 ANNI»: tre voci
 * IDENTICHE, indistinguibili, e con la stessa `value`. Il filtro lavora sul
 * NOME (`s.classe_sezione === filterClass`), quindi le tre voci erano anche
 * letteralmente lo stesso filtro: rumore puro. La barra massiva manda quel nome
 * al server, che da W2-C rifiuta con 400 se la classe non esiste nella sede di
 * OGNI alunno selezionato — ma sceglierne «una delle tre» non ha mai voluto dire
 * nulla.
 *
 * Qui si asserisce l'unica cosa vera: un nome = una voce.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
  usePathname: () => '/admin/students',
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [
      { id: SEDE_A, nome: 'Kidville Alfa' },
      { id: SEDE_B, nome: 'Kidville Beta' },
    ],
    selezionate: [],
    effettive: [SEDE_A, SEDE_B],
    sedeCorrente: null,
    reFetchKey: `${SEDE_A},${SEDE_B}`,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))
// I figli pesanti non c'entrano con la tendina: qui interessa solo l'elenco.
vi.mock('@/components/features/admin/StudentTable', () => ({ StudentTable: () => null }))
vi.mock('@/components/features/admin/SectionsView', () => ({ SectionsView: () => null }))
vi.mock('@/components/features/admin/BulkAssignBar', () => ({
  BulkAssignBar: ({ availableClasses }: { availableClasses: string[] }) => (
    <div data-testid="classi-bulk">{availableClasses.join('|')}</div>
  ),
}))

// La stessa «3 ANNI» in due sedi + una sola «PRIMAVERA» ad Alfa.
const SEZIONI = [
  { id: 'sez-a1', name: '3 ANNI', school_type: 'infanzia', scuola_id: SEDE_A },
  { id: 'sez-b1', name: '3 ANNI', school_type: 'infanzia', scuola_id: SEDE_B },
  { id: 'sez-a2', name: 'PRIMAVERA', school_type: 'nido', scuola_id: SEDE_A },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = String(url)
    if (u.includes('/api/admin/sections')) return Promise.resolve({ ok: true, json: async () => SEZIONI })
    if (u.includes('/api/admin/gruppi-mensa')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) })
    return Promise.resolve({ ok: true, json: async () => [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

const tendinaClasse = () =>
  Array.from(document.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.value === 'all'),
  ) as HTMLSelectElement

describe('Anagrafica alunni — la tendina delle classi non ripete lo stesso nome', () => {
  it('due sezioni omonime in sedi diverse producono UNA sola voce di filtro', async () => {
    render(<AdminStudentsPage />)
    await waitFor(() => expect(tendinaClasse()).toBeTruthy())

    const etichette = Array.from(tendinaClasse().options).map((o) => o.textContent)
    expect(etichette.filter((e) => e === '3 ANNI')).toHaveLength(1)
    expect(etichette).toContain('PRIMAVERA')
    // Nessuna coppia di `value` duplicata: le chiavi React e la scelta restano univoche.
    const valori = Array.from(tendinaClasse().options).map((o) => o.value)
    expect(new Set(valori).size).toBe(valori.length)
  })

  it('anche la barra di assegnazione massiva riceve nomi UNIVOCI', async () => {
    const { getByTestId } = render(<AdminStudentsPage />)
    await waitFor(() => expect(tendinaClasse()).toBeTruthy())
    const classi = within(getByTestId('classi-bulk')).getByText(/3 ANNI/).textContent!.split('|')
    expect(classi.filter((c) => c === '3 ANNI')).toHaveLength(1)
    expect(classi).toContain('PRIMAVERA')
  })
})
