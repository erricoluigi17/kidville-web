import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * S27 — «ETICHETTA BUGIARDA» (warning del collaudo frontend, 2026-07-31).
 *
 * Con la tab «SEZIONI» attiva, il bottone principale dell'Anagrafica diceva
 * **«NUOVO GENITORE»** e portava a `/admin/students/new`, che i genitori li
 * crea davvero — cioè nella pagina delle classi c'era un invito a creare
 * tutt'altro. Il predicato era `viewType !== 'staff'`: escludeva lo staff e si
 * dimenticava delle sezioni, per cui `sections` finiva nel ramo «genitore»
 * semplicemente perché non era «alunno».
 *
 * Le sezioni hanno GIÀ il loro comando di creazione, dentro `SectionsView`
 * («Nuova Sezione»): il bottone della testata non serviva, mentiva e basta.
 *
 * I CONTROLLI POSITIVI SONO METÀ DEL TEST: «il bottone non c'è» passerebbe
 * anche su una pagina che non rende niente, o se qualcuno togliesse il bottone
 * da tutte le tab. Perciò accanto c'è sempre la tab in cui quel bottone DEVE
 * esserci, con la sua etichetta giusta.
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

beforeEach(() => {
  vi.clearAllMocks()
  h.query = ''
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    const p = u.pathname
    if (p.includes('/api/admin/sections/scoped')) return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
    if (p.includes('/api/admin/sections')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    if (p.includes('/api/admin/gruppi-mensa')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
    if (p.includes('/api/admin/students')) {
      if (u.searchParams.get('scuola_id')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
      return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

const bottone = (etichetta: string) =>
  screen.queryByRole('button', { name: new RegExp(`^${etichetta}$`, 'i') })

describe('Anagrafica — il bottone principale dice ciò che fa', () => {
  it('tab SEZIONI: nessun «Nuovo Genitore» (le sezioni hanno il loro «Nuova Sezione»)', async () => {
    h.query = 'tab=sections'
    render(<AdminStudentsPage />)

    // CONTROLLO POSITIVO: la pagina delle sezioni c'è davvero, col comando giusto.
    await waitFor(() => expect(screen.getByText(itAdmin.secTitolo)).toBeInTheDocument())
    expect(bottone(itAdmin.secNuova)).toBeInTheDocument()

    // …e l'etichetta bugiarda è sparita, insieme a quella dell'alunno.
    expect(bottone(itAdmin.azioneNuovoGenitore)).not.toBeInTheDocument()
    expect(bottone(itAdmin.azioneNuovoAlunno)).not.toBeInTheDocument()
  })

  it('CONTROLLO POSITIVO — tab GENITORI: «Nuovo Genitore» c\'è, ed è lì che ha senso', async () => {
    h.query = 'tab=adult'
    render(<AdminStudentsPage />)

    await waitFor(() => expect(bottone(itAdmin.azioneNuovoGenitore)).toBeInTheDocument())
    expect(bottone(itAdmin.azioneNuovoAlunno)).not.toBeInTheDocument()
  })

  it('CONTROLLO POSITIVO — tab ALUNNI: «Nuovo Alunno»', async () => {
    h.query = 'tab=child'
    render(<AdminStudentsPage />)

    await waitFor(() => expect(bottone(itAdmin.azioneNuovoAlunno)).toBeInTheDocument())
    expect(bottone(itAdmin.azioneNuovoGenitore)).not.toBeInTheDocument()
  })

  it('tab STAFF: nessuno dei due (lo staff si crea dalla gestione RBAC)', async () => {
    h.query = 'tab=staff'
    render(<AdminStudentsPage />)

    await waitFor(() => expect(screen.getByText(itAdmin.listTitolo)).toBeInTheDocument())
    expect(bottone(itAdmin.azioneNuovoGenitore)).not.toBeInTheDocument()
    expect(bottone(itAdmin.azioneNuovoAlunno)).not.toBeInTheDocument()
  })
})
