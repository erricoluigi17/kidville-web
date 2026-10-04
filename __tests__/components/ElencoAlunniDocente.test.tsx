import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
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
    // Il clic arriva al gestore della pagina, poi si ferma: jsdom non tenta la navigazione.
    default: ({
      children,
      href,
      onClick,
      ...rest
    }: {
      children: React.ReactNode
      href: string
      onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void
    }) =>
      React.createElement(
        'a',
        {
          href,
          ...rest,
          onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
            onClick?.(e)
            e.preventDefault()
          },
        },
        children,
      ),
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

/** Una risposta che arriva quando lo decide il test. */
const differita = () => {
  let risolvi!: (r: Response) => void
  const promessa = new Promise<Response>((r) => {
    risolvi = r
  })
  return { promessa, risolvi }
}

const cerca = (testo: string) =>
  fireEvent.change(screen.getByLabelText(T.anagraficaFiltroCerca), { target: { value: testo } })

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/teacher/alunni')
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

  it('chi non ha una sezione nota (nessuna, o una fuori elenco) finisce in fondo, in «Senza sezione»', async () => {
    fetchMock.mockResolvedValue(
      risposta(200, {
        ...DATI,
        alunni: [
          voce({ id: 'a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa', nome: 'Dario', cognome: 'Duna-E2E', sectionId: null }),
          ...DATI.alunni,
          voce({ id: 'a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa', nome: 'Elena', cognome: 'Eclissi-E2E', sectionId: 'S9' }),
        ],
      }),
    )
    render(<ElencoAlunniDocente />)
    const senza = await screen.findByRole('region', { name: new RegExp(T.anagraficaSenzaSezione) })
    expect(within(senza).getAllByRole('link').map((a) => a.textContent)).toEqual([
      expect.stringContaining('Duna-E2E Dario'),
      expect.stringContaining('Eclissi-E2E Elena'),
    ])
    expect(within(senza).getByText('2 bambini')).toBeTruthy()
    const titoli = screen.getAllByRole('heading', { level: 2 }).map((h2) => h2.querySelector('span')?.textContent)
    expect(titoli).toEqual(['Girasoli', 'Tulipani', T.anagraficaSenzaSezione])
  })

  it('la ricerca per nome restringe l’elenco, il contatore lo dice, e NON va nell’indirizzo', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    cerca('clara')
    expect(screen.queryByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeNull()
    expect(screen.getByRole('link', { name: /Cometa-E2E Clara/ })).toBeTruthy()
    // una sezione senza nessuno che passa i filtri non resta come titolo vuoto
    expect(screen.queryByRole('region', { name: /Girasoli/ })).toBeNull()
    expect(screen.getByTestId('conteggio-risultati').textContent).toBe('1 risultato su 3')
    expect(new URLSearchParams(window.location.search).get('q')).toBeNull()
  })

  it('il conteggio della sezione è quello dei bambini che passano i filtri', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    cerca('aurora')
    const girasoli = screen.getByRole('region', { name: /Girasoli/ })
    expect(within(girasoli).getByText('1 bambino')).toBeTruthy()
    expect(within(girasoli).getAllByRole('link')).toHaveLength(1)
  })

  it('nessun risultato: «nessun risultato con questi filtri», non «nessun bambino»; «Pulisci filtri» li riporta', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    cerca('zzz')
    const titolo = screen.getByText(S.filtriSenzaRisultatiTitolo)
    expect(screen.queryByText(T.anagraficaVuotoTitolo)).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    // il «Pulisci filtri» dello stato senza risultati (la barra ne ha un altro, uguale)
    fireEvent.click(within(titolo.parentElement as HTMLElement).getByRole('button', { name: S.filtriPulisci }))
    expect(screen.getAllByRole('link')).toHaveLength(3)
    expect(screen.queryByText(S.filtriSenzaRisultatiTitolo)).toBeNull()
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
    const aurora = await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    expect(window.sessionStorage.getItem('kv-teacher-alunni-ritorno')).toBeNull()
    cerca('aur')
    fireEvent.click(aurora)
    expect(window.sessionStorage.getItem('kv-teacher-alunni-ritorno')).toBe('?sezione=S1')
  })

  it('il link porta l’anello di fuoco DENTRO di sé: l’elenco con gli angoli tondi lo taglierebbe', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    const aurora = await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    // Col `!`: la regola globale `:focus-visible` (globals.css) sta fuori dai layer e
    // batte qualunque utility Tailwind senza `!important` — misurato in Chromium.
    expect(aurora.className.split(/\s+/)).toContain('focus-visible:outline-offset-[-3px]!')
  })

  it('elenco vuoto: solo il messaggio per chi non ha classi assegnate, senza la barra dei filtri', async () => {
    fetchMock.mockResolvedValue(risposta(200, { sezioni: [], alunni: [] }))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(T.anagraficaVuotoTitolo)).toBeTruthy()
    expect(screen.getByText(T.anagraficaVuotoCorpo)).toBeTruthy()
    expect(screen.queryByLabelText(T.anagraficaFiltroCerca)).toBeNull()
    expect(screen.queryByTestId('conteggio-risultati')).toBeNull()
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

  it('l’errore si annuncia da una regione `aria-live` montata da prima, non annidata nel `role="status"`', async () => {
    const lenta = differita()
    fetchMock.mockReturnValue(lenta.promessa)
    render(<ElencoAlunniDocente />)
    expect(screen.getByText(S.caricamentoInCorso)).toBeTruthy()
    const regioni = document.querySelectorAll('[aria-live="polite"]')
    expect(regioni).toHaveLength(1)
    const regione = regioni[0] as HTMLElement
    await act(async () => {
      lenta.risolvi(risposta(500, {}))
    })
    expect((await screen.findByText(S.filtriErroreTitolo)).closest('[aria-live="polite"]')).toBe(regione)
    expect(regione.closest('[role="status"]')).toBeNull()
    expect(regione.querySelector('[role="status"]')).toBeNull()
  })

  it('dopo «Riprova» il fuoco va sul contenitore dell’esito, non su <body>', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockReturnValueOnce(differita().promessa)
    render(<ElencoAlunniDocente />)
    fireEvent.click(await screen.findByRole('button', { name: S.paginaErroreRiprova }))
    const contenitore = (await screen.findByText(S.caricamentoInCorso)).closest('[tabindex="-1"]')
    expect(contenitore).not.toBeNull()
    expect(document.activeElement).toBe(contenitore)
  })

  it('401 ⇒ sessione scaduta, con il link all’accesso, senza «Riprova» e senza log', async () => {
    fetchMock.mockResolvedValue(risposta(401, { codice: 'NON_AUTENTICATO' }))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(T.anagraficaErroreSessione)).toBeTruthy()
    expect(screen.getByRole('link', { name: T.anagraficaAccedi }).getAttribute('href')).toBe('/auth/login')
    expect(screen.queryByRole('button', { name: S.paginaErroreRiprova })).toBeNull()
    expect(screen.queryByText(S.filtriErroreTitolo)).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('senza rete: errore con «Riprova», ma nessun log', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(S.filtriErroreTitolo)).toBeTruthy()
    expect(screen.getByRole('button', { name: S.paginaErroreRiprova })).toBeTruthy()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('rete giù ma «online»: errore, con un log `error`', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(S.filtriErroreTitolo)).toBeTruthy()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch' }))
  })
})
