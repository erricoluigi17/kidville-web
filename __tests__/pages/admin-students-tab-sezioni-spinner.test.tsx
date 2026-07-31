import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * /admin/students?tab=sections — lo spinner che non si spegneva mai.
 *
 * Dal dettaglio di una sezione il link «← Tutte le sezioni» porta a
 * `/admin/students?tab=sections`. La pagina montava con `isLoading = true` per
 * QUALUNQUE tab, ma solo tre tab su quattro caricano un elenco: `setIsLoading(false)`
 * vive dentro `caricaElenco`, e con `viewType === 'sections'` nessun fetch parte.
 * Risultato: «Caricamento anagrafica...» per sempre. Riaprire la voce di menu non
 * ripara — è la stessa rotta, il componente non si rimonta: bisogna uscire
 * dall'area e rientrare. Riprodotto 2 volte su 2 sul simulatore iOS.
 *
 * LE DUE ASSERZIONI VANNO INSIEME. «Lo spinner non c'è» da sola passerebbe anche
 * su una pagina che non renderizza affatto: perciò accanto c'è sempre il
 * controllo POSITIVO che il contenuto delle sezioni è davvero a schermo (il
 * titolo della griglia e la card della sezione, resa da `SectionsView` vero — qui
 * NON è mockato apposta).
 *
 * E c'è il caso di controllo opposto, `?tab=child`: lì lo spinner DEVE esserci
 * finché il server non risponde. Senza quello, «spinner mai» passerebbe il test.
 */

const h = vi.hoisted(() => ({ query: '' }))

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.query),
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

/** Una sede con una sezione: basta a distinguere «griglia resa» da «griglia assente». */
const SCOPED = {
  success: true,
  data: [
    {
      scuolaId: SEDE_A,
      scuolaNome: NOME_SEDE_A,
      sezioni: [{ id: 'sez-a1', name: 'TEST 3 ANNI', school_type: 'infanzia' }],
    },
  ],
}

const ALUNNO = {
  id: 'aaaa1111-0000-4000-8000-000000000001',
  nome: 'Test', cognome: 'Alunno', classe_sezione: 'TEST 3 ANNI', stato: 'iscritto',
}

const fetchMock = vi.fn()
/** L'elenco alunni della PAGINA: il test decide quando (e se) il server risponde. */
let rispondiElenco: (righe: unknown[]) => void

beforeEach(() => {
  vi.clearAllMocks()
  h.query = ''
  let sblocca: (v: unknown) => void = () => {}
  const elenco = new Promise<unknown>((res) => { sblocca = res })
  rispondiElenco = (righe) => sblocca({ ok: true, status: 200, json: async () => righe })

  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    const p = u.pathname
    // `/scoped` prima di `/sections`: il secondo è prefisso del primo.
    if (p.includes('/api/admin/sections/scoped')) return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
    if (p.includes('/api/admin/sections')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    if (p.includes('/api/admin/gruppi-mensa')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
    if (p.includes('/api/admin/students')) {
      // `SectionsView` chiede gli alunni SEDE PER SEDE; la pagina chiede l'elenco
      // generale — ed è solo quello che il test tiene in sospeso.
      if (u.searchParams.get('scuola_id')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
      return elenco
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

const spinner = () => screen.queryByText(itAdmin.caricamentoAnagrafica)
const cardSezione = () => document.querySelector('a[href="/admin/students/sezioni/sez-a1"]')

describe('Anagrafica — la tab Sezioni non resta appesa allo spinner', () => {
  it('?tab=sections al montaggio: nessuno spinner, E la griglia delle sezioni è a schermo', async () => {
    h.query = 'tab=sections'
    render(<AdminStudentsPage />)

    // Il difetto era visibile GIÀ al primo render: `isLoading` partiva true.
    expect(spinner()).not.toBeInTheDocument()

    // CONTROLLO POSITIVO: senza questo, una pagina che non rende nulla passerebbe.
    await waitFor(() => expect(cardSezione()).toBeTruthy())
    expect(screen.getByText(itAdmin.secTitolo)).toBeInTheDocument()
    expect(screen.getByText('TEST 3 ANNI')).toBeInTheDocument()
    // ...e nemmeno dopo che tutto si è assestato lo spinner è comparso.
    expect(spinner()).not.toBeInTheDocument()
  })

  it('CONTROLLO OPPOSTO — ?tab=child: lo spinner c\'è finché il server non risponde, e sparisce quando risponde', async () => {
    h.query = 'tab=child'
    render(<AdminStudentsPage />)

    // Elenco in volo: lo spinner DEVE esserci, e la pagina non ancora.
    expect(spinner()).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.listTitolo)).not.toBeInTheDocument()

    rispondiElenco([ALUNNO])

    await waitFor(() => expect(screen.getByText(itAdmin.listTitolo)).toBeInTheDocument())
    expect(spinner()).not.toBeInTheDocument()
  })

  it('passando ad «Sezioni» da un\'altra tab lo spinner non si riaccende, e la griglia compare', async () => {
    h.query = 'tab=child'
    render(<AdminStudentsPage />)
    rispondiElenco([ALUNNO])
    await waitFor(() => expect(screen.getByText(itAdmin.listTitolo)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itAdmin.tabSezioni}$`, 'i') }))

    expect(spinner()).not.toBeInTheDocument()
    await waitFor(() => expect(cardSezione()).toBeTruthy())
    expect(spinner()).not.toBeInTheDocument()
  })
})
