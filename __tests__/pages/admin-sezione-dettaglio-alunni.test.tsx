import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * W3-B — Dettaglio sezione: chi sta davvero in questa classe.
 *
 * Gli alunni si chiedono già per sede (`?scuola_id=`), ma il filtro locale era
 * `s.section_id === f.id || s.classe_sezione === f.name`: due condizioni in OR,
 * e la seconda vince anche quando la prima dice il contrario. Un bambino
 * assegnato alla sezione X con il vecchio `classe_sezione` ancora scritto sopra
 * compariva in DUE classi, e il numero in testata (che si legge come «quanti
 * bambini ho») era gonfio.
 *
 * Regola: se `section_id` c'è, quello è il legame. Il nome è solo il ripiego per
 * le righe che il trigger non ha ancora risolto.
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'sez-a1' }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/admin/students/sezioni/sez-a1',
}))

const SCOPED = {
  success: true,
  data: [
    { scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, sezioni: [
      { id: 'sez-a1', name: '3 ANNI', school_type: 'infanzia' },
      { id: 'sez-a2', name: 'PRIMAVERA', school_type: 'nido' },
    ] },
    { scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B, sezioni: [{ id: 'sez-b1', name: '3 ANNI', school_type: 'infanzia' }] },
  ],
}

const ALUNNI_A = [
  // Dentro: legame esplicito con questa sezione.
  { id: 'al-1', nome: 'Ada', cognome: 'Rossi', scuola_id: SEDE_A, section_id: 'sez-a1', classe_sezione: '3 ANNI' },
  // Dentro: nessun `section_id` risolto, ma il nome-classe è questo, nella sede giusta.
  { id: 'al-2', nome: 'Bruno', cognome: 'Neri', scuola_id: SEDE_A, section_id: null, classe_sezione: '3 ANNI' },
  // FUORI: è assegnato a PRIMAVERA; `classe_sezione` è solo un residuo non aggiornato.
  { id: 'al-3', nome: 'Carla', cognome: 'Gialli', scuola_id: SEDE_A, section_id: 'sez-a2', classe_sezione: '3 ANNI' },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname.includes('/api/admin/sections/scoped')) return Promise.resolve({ ok: true, json: async () => SCOPED })
    if (u.pathname.includes('/api/admin/students')) {
      return Promise.resolve({ ok: true, json: async () => (u.searchParams.get('scuola_id') === SEDE_A ? ALUNNI_A : []) })
    }
    return Promise.resolve({ ok: true, json: async () => ({ success: true, assigned: [], available: [] }) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import SezioneDetailPage from '@/app/(dashboard)/admin/students/sezioni/[id]/page'

describe('Dettaglio sezione — l\'elenco è quello della classe, non degli omonimi', () => {
  it('gli alunni si chiedono per la sede della sezione', async () => {
    render(<SezioneDetailPage />)
    await waitFor(() => expect(screen.getByText('Rossi Ada')).toBeInTheDocument())
    expect(fetchMock.mock.calls.map((c) => String(c[0])))
      .toContain(`/api/admin/students?scuola_id=${SEDE_A}&limit=1000`)
  })

  it('chi è assegnato a un\'ALTRA sezione non compare, anche se il nome-classe coincide', async () => {
    render(<SezioneDetailPage />)
    await waitFor(() => expect(screen.getByText('Rossi Ada')).toBeInTheDocument())
    expect(screen.getByText('Neri Bruno')).toBeInTheDocument()
    expect(screen.queryByText('Gialli Carla')).not.toBeInTheDocument()
  })
})
