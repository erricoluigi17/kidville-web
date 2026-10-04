import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import servizi from '../../messages/it/teacherServizi.json'
import condivisi from '../../messages/it/shared.json'
import type { ElencoAlunniRisposta, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'

const T = servizi as Record<string, string>
const S = condivisi as Record<string, string>

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  }
})

import { ElencoAlunniDocente } from '@/components/features/teacher/anagrafica/ElencoAlunniDocente'

const voce = (v: Partial<VoceElencoAlunno> & { id: string; nome: string; cognome: string }): VoceElencoAlunno => ({
  sectionId: 'S1', grado: 'infanzia', dataNascita: '2021-01-01', annoNascita: 2021, sesso: 'F',
  allergeni: [], haAllergie: false, besDsa: false, usaPannolino: false,
  consensoFotoSito: true, consensoFotoSocial: true, ...v,
})

const DATI: ElencoAlunniRisposta = {
  sezioni: [
    { id: 'S1', nome: 'Girasoli', grado: 'infanzia' },
    { id: 'S2', nome: 'Tulipani', grado: 'infanzia' },
  ],
  alunni: [
    voce({ id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', nome: 'Aurora', cognome: 'Arcobaleno-E2E', allergeni: ['latte'], haAllergie: true }),
    voce({ id: 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa', nome: 'Bruno', cognome: 'Baleno-E2E' }),
    voce({ id: 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa', nome: 'Clara', cognome: 'Cometa-E2E', sectionId: 'S2' }),
  ],
}

const fetchMock = vi.fn()
const risposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/teacher/alunni')
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ElencoAlunniDocente', () => {
  it('raggruppa per sezione, con il conteggio e il link alla scheda', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    const girasoli = await screen.findByRole('region', { name: /Girasoli/ })
    expect(within(girasoli).getAllByRole('link')).toHaveLength(2)
    expect(within(girasoli).getByText('2 bambini')).toBeTruthy()
    const aurora = within(girasoli).getByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    expect(aurora.getAttribute('href')).toBe('/teacher/alunni/a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa')
    expect(within(aurora).getByText(T.anagraficaBadgeAllergie)).toBeTruthy()
    // il badge è solo di chi ha allergie
    const bruno = within(girasoli).getByRole('link', { name: /Baleno-E2E Bruno/ })
    expect(within(bruno).queryByText(T.anagraficaBadgeAllergie)).toBeNull()
    const tulipani = screen.getByRole('region', { name: /Tulipani/ })
    expect(within(tulipani).getByText('1 bambino')).toBeTruthy()
    expect(within(tulipani).getByRole('link', { name: /Cometa-E2E Clara/ }).getAttribute('href')).toBe(
      '/teacher/alunni/a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa',
    )
  })

  it('la ricerca per nome restringe l’elenco, il contatore lo dice, e NON va nell’indirizzo', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    fireEvent.change(screen.getByLabelText(T.anagraficaFiltroCerca), { target: { value: 'clara' } })
    expect(screen.queryByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeNull()
    expect(screen.getByRole('link', { name: /Cometa-E2E Clara/ })).toBeTruthy()
    expect(screen.getByTestId('conteggio-risultati').textContent).toBe('1 risultato su 3')
    expect(new URLSearchParams(window.location.search).get('q')).toBeNull()
  })

  it('un filtro dall’indirizzo vale fin dal primo disegno (si monta DOPO i dati)', async () => {
    window.history.replaceState(null, '', '/teacher/alunni?sezione=S2')
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByRole('link', { name: /Cometa-E2E Clara/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeNull()
  })

  it('toccando un bambino salva i filtri per il ritorno (senza la ricerca per nome)', async () => {
    window.history.replaceState(null, '', '/teacher/alunni?sezione=S1')
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    fireEvent.click(await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ }))
    expect(window.sessionStorage.getItem('kv-teacher-alunni-ritorno')).toBe('?sezione=S1')
  })

  it('elenco vuoto: il messaggio per chi non ha classi assegnate', async () => {
    fetchMock.mockResolvedValue(risposta(200, { sezioni: [], alunni: [] }))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(T.anagraficaVuotoTitolo)).toBeTruthy()
    expect(screen.getByText(T.anagraficaVuotoCorpo)).toBeTruthy()
  })

  it('lettura fallita: errore con «Riprova», mai «nessun bambino»', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockResolvedValueOnce(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(S.filtriErroreTitolo)).toBeTruthy()
    expect(screen.queryByText(T.anagraficaVuotoTitolo)).toBeNull()
    // il guasto lascia traccia: livello e stato HTTP, nessun dato del bambino
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', evento: 'fetch', stato: 500 }))
    fireEvent.click(screen.getByRole('button', { name: S.paginaErroreRiprova }))
    expect(await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeTruthy()
  })
})
