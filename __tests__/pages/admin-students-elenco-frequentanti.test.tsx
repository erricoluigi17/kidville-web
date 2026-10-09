import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * L'ANAGRAFICA DIVISA IN DUE (2026-10-09): la linguetta «Alunni» legge
 * `elenco=frequentanti`, la linguetta «Non iscritti» `elenco=non_iscritti`.
 *
 * Quello che questo file tiene fermo è il CABLAGGIO della pagina, che i test
 * della vista (`AlunniArchiviatiView.test.tsx`) non vedono:
 *  · la lettura dell'elenco Alunni dichiara `elenco=frequentanti`, e nessuna
 *    chiamata all'anagrafica resta cieca;
 *  · i filtri non offrono più ciò che in quell'elenco non può esserci
 *    («Non assegnata», «Ritirato»): darebbero sempre zero righe;
 *  · la card che contava «tutti gli stati» dice ora che cosa conta;
 *  · lo stato della lettura delle SEZIONI arriva alla linguetta «Non iscritti»:
 *    una lettura fallita non diventa «nessuna sezione in questa sede».
 *
 * I nomi sono finti: il repository è PUBBLICO.
 */

const h = vi.hoisted(() => ({ query: '', sezioniOk: true }))

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
// I figli pesanti non c'entrano: qui interessano le chiamate e i filtri.
vi.mock('@/components/features/admin/StudentTable', () => ({ StudentTable: () => null }))
vi.mock('@/components/features/admin/SectionsView', () => ({ SectionsView: () => null }))
vi.mock('@/components/features/admin/BulkAssignBar', () => ({ BulkAssignBar: () => null }))

const SEZIONI = [{ id: 'sez-a1', name: 'SEZIONE PROVA', school_type: 'infanzia', scuola_id: SEDE_A }]

/** Un iscritto senza sezione: è la riga che offre «Assegna sezione» nella linguetta «Non iscritti». */
const SENZA_SEZIONE = {
  id: 'dddd4444-0000-4000-8000-000000000004',
  nome: 'Bambino', cognome: 'DiProva', data_nascita: '2022-01-10',
  scuola_id: SEDE_A, stato: 'iscritto', section_id: null,
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  h.query = ''
  h.sezioniOk = true
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sections') {
      return Promise.resolve(
        h.sezioniOk
          ? { ok: true, status: 200, json: async () => SEZIONI }
          : { ok: false, status: 500, json: async () => ({ error: 'x' }) },
      )
    }
    if (u.pathname === '/api/admin/gruppi-mensa') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
    if (u.pathname === '/api/admin/students') {
      const righe = u.searchParams.get('elenco') === 'non_iscritti' ? [SENZA_SEZIONE] : []
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => righe })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

/** Le URL chiamate verso l'anagrafica alunni. */
const chiamateAnagrafica = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/admin/students?'))

const tendinaClasse = () =>
  Array.from(document.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.textContent === itAdmin.filtroTutteClassi),
  ) as HTMLSelectElement
const tendinaStato = () =>
  Array.from(document.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.textContent === itAdmin.filtroTuttiStati),
  ) as HTMLSelectElement

describe('Anagrafica — la linguetta «Alunni» è l’elenco di chi frequenta', () => {
  it('l’elenco Alunni chiede `elenco=frequentanti`, e nessuna chiamata all’anagrafica resta cieca', async () => {
    render(<AdminStudentsPage />)
    await waitFor(() => expect(chiamateAnagrafica().some((u) => u.includes('elenco=frequentanti'))).toBe(true))
    // La linguetta «Non iscritti» legge la sua metà, sempre all'apertura (pillola).
    expect(chiamateAnagrafica().some((u) => u.includes('elenco=non_iscritti'))).toBe(true)
    expect(chiamateAnagrafica().filter((u) => !u.includes('elenco='))).toEqual([])
  })

  it('il filtro classe non offre «Non assegnata» e quello di stato non offre «Ritirato»', async () => {
    render(<AdminStudentsPage />)
    // Controllo POSITIVO prima: le tendine ci sono, e la sezione arrivata è offerta.
    await waitFor(() => expect(Array.from(tendinaClasse()?.options ?? []).map((o) => o.value)).toContain('SEZIONE PROVA'))
    const classi = Array.from(tendinaClasse().options)
    // La voce «Non assegnata» non c'è più nemmeno nel catalogo (chiave tolta il
    // 2026-10-09: nessuno la mostrava): si controlla il testo che aveva.
    expect(classi.map((o) => o.textContent)).not.toContain('Non assegnata')
    expect(classi.map((o) => o.value)).not.toContain('')

    const stati = Array.from(tendinaStato().options).map((o) => o.value)
    expect(stati).toContain('iscritto')
    expect(stati).toContain('sospeso')
    expect(stati).not.toContain('ritirato')
  })

  it('la card del totale dice che cosa conta: chi frequenta, non «tutti gli stati»', async () => {
    render(<AdminStudentsPage />)
    expect(await screen.findByText(itAdmin.statTotale)).toBeInTheDocument()
    expect(itAdmin.statTotale).toBe('Frequentanti')
  })
})

describe('Anagrafica — lo stato delle sezioni arriva alla linguetta «Non iscritti»', () => {
  it('sezioni NON arrivate: «Sezioni non caricate», mai «Nessuna sezione in questa sede»', async () => {
    h.query = 'tab=archiviati'
    h.sezioniOk = false
    render(<AdminStudentsPage />)
    expect(await screen.findByText(itAdmin.arcSezioniNonCaricate)).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.arcNessunaSezioneInSede)).toBeNull()
    expect(screen.queryByRole('combobox', { name: /DiProva/ })).toBeNull()
  })

  it('CONTROLLO POSITIVO — sezioni arrivate: la riga offre la tendina con la sezione della sua sede', async () => {
    h.query = 'tab=archiviati'
    render(<AdminStudentsPage />)
    const tendina = (await screen.findByRole('combobox', { name: /DiProva/ })) as HTMLSelectElement
    expect(Array.from(tendina.options).map((o) => o.value)).toEqual(['', 'SEZIONE PROVA'])
    expect(screen.queryByText(itAdmin.arcSezioniNonCaricate)).toBeNull()
  })
})
