import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import servizi from '../../messages/it/teacherServizi.json'
import etichette from '../../messages/it/etichette.json'
import type { SchedaAlunnoDocente } from '@/lib/anagrafiche/docente/tipi'

const T = servizi as Record<string, string>
const E = etichette as Record<string, string>

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  }
})
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

import { SchedaAlunnoLettura } from '@/components/features/teacher/anagrafica/SchedaAlunnoLettura'

const ID = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const SCHEDA: SchedaAlunnoDocente = {
  id: ID,
  nome: 'Aurora',
  cognome: 'Arcobaleno-E2E',
  sesso: 'F',
  dataNascita: '2022-04-10',
  luogoNascita: { comune: 'Testville', provincia: 'TV', nazione: 'Italia' },
  cittadinanza: 'Italiana',
  codiceFiscale: 'TSTRCB22D50Z999Q',
  residenza: { indirizzo: null, civico: null, cap: null, comune: null, provincia: null },
  sezione: { id: 's', nome: 'Girasoli', grado: 'infanzia' },
  dataIscrizione: '2025-09-01',
  salute: { allergeni: ['latte'], allergieAltro: 'fragole', haAllergie: true, noteMediche: 'Riga uno\nRiga due', besDsa: false, usaPannolino: true },
  consensi: { privacy: true, fotoSito: false, fotoSocial: null },
  genitori: [
    { nome: 'Mamma', cognome: 'Arcobaleno-E2E', parentela: 'madre', principale: true, telefoni: ['333 000 0000'], email: ['mamma@example.test'], codiceFiscale: 'TSTMMM80A41Z999Q' },
  ],
  delegati: [{ nome: 'Nonna', cognome: 'Arcobaleno-E2E', parentela: 'Nonna' }],
}

const risposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SchedaAlunnoLettura — pronta', () => {
  beforeEach(() => fetchMock.mockResolvedValue(risposta(200, SCHEDA)))

  it('mostra anagrafica, salute, famiglia e delegati', async () => {
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(`/api/teacher/alunni/${ID}`, expect.objectContaining({ cache: 'no-store' }))
    expect(screen.getByText(T.anagraficaSolaLettura)).toBeTruthy()
    expect(screen.getByText('TSTRCB22D50Z999Q')).toBeTruthy()
    expect(screen.getByText('10/04/2022')).toBeTruthy()
    expect(screen.getByText('Testville (TV), Italia')).toBeTruthy()
    const avviso = screen.getByRole('note', { name: T.anagraficaAvvisoAllergie })
    expect(avviso.textContent).toContain(E.allergene_latte)
    expect(avviso.textContent).toContain('fragole')
    expect(screen.getByText(/Riga uno/).textContent).toBe('Riga uno\nRiga due')
    expect(screen.getByText('Nonna', { selector: 'p, span, dd' })).toBeTruthy()
  })

  it('telefono ed email sono toccabili', async () => {
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    const tel = await screen.findByRole('link', { name: /333 000 0000/ })
    expect(tel.getAttribute('href')).toBe('tel:3330000000')
    expect(screen.getByRole('link', { name: /mamma@example\.test/ }).getAttribute('href')).toBe('mailto:mamma@example.test')
  })

  it('i campi assenti dicono «Non indicato», i consensi Sì/No/Non indicato', async () => {
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getAllByText(T.anagraficaNonIndicato).length).toBeGreaterThanOrEqual(4)
  })

  it('SOLA LETTURA: nessun campo modificabile, nessun salvataggio', async () => {
    const { container } = render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1 })
    expect(container.querySelectorAll('input, textarea, select, [contenteditable="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /salva|modifica|elimina/i })).toBeNull()
  })

  it('«Tutti gli alunni» torna all’elenco con i filtri di prima', async () => {
    window.sessionStorage.setItem('kv-teacher-alunni-ritorno', '?sezione=S1')
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1 })
    fireEvent.click(screen.getByRole('link', { name: T.anagraficaIndietro }))
    expect(h.push).toHaveBeenCalledWith('/teacher/alunni?sezione=S1')
  })
})

describe('SchedaAlunnoLettura — non si apre', () => {
  it('403 ⇒ «non è in una delle tue classi»', async () => {
    fetchMock.mockResolvedValue(risposta(403, { codice: 'ANAGRAFICA_FUORI_SEZIONE' }))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreNegato)).toBeTruthy()
  })

  it('404 ⇒ «Scheda non trovata»', async () => {
    fetchMock.mockResolvedValue(risposta(404, {}))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreNonTrovata)).toBeTruthy()
  })

  it('un id che non è un uuid non parte nemmeno', async () => {
    render(<SchedaAlunnoLettura alunnoId="" />)
    expect(await screen.findByText(T.anagraficaErroreNonTrovata)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('500 ⇒ errore con «Riprova», che ricarica davvero', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockResolvedValueOnce(risposta(200, SCHEDA))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    fireEvent.click(await screen.findByRole('button', { name: T.anagraficaRiprova }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', stato: 500 }))
  })

  it('senza rete ⇒ «Serve la connessione»', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreOffline)).toBeTruthy()
    onLine.mockRestore()
  })

  it('rete giù ma «online» ⇒ errore, con un log `error`', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreLettura)).toBeTruthy()
    await waitFor(() => expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' })))
  })
})
