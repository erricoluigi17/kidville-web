import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SEDE_A, SEDE_DEMO, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * Punto 7 · il modulo pubblico dice PER QUALE ANNO ci si iscrive, la quota di nuova iscrizione e i documenti da
 * consegnare (`/api/iscrizione/info-anno`, configurazione pubblica). Senza quota nel listino non si inventa un importo;
 * se la lettura fallisce il modulo resta com'è. Il riepilogo rimostra tutto. Uuid e dati finti.
 */

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const {
      initial, animate, exit, variants, transition, custom,
      whileHover, whileTap, layout, layoutId, ...rest
    } = props
    void initial; void animate; void exit; void variants; void transition
    void custom; void whileHover; void whileTap; void layout; void layoutId
    return rest
  }
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef(function M(
          { children, ...props }: { children?: React.ReactNode },
          ref: React.Ref<HTMLElement>,
        ) {
          return React.createElement(tag, { ...strip(props), ref }, children)
        }),
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

const A_CORR = { anno_id: 'a2222222-2222-4222-8222-222222222222', etichetta_breve: '2026/27', ingresso: 'durante' as const }
const A_PROSS = { anno_id: 'a3333333-3333-4333-8333-333333333333', etichetta_breve: '2027/28', ingresso: 'inizio' as const }

const modelSchema = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'Dati del bambino', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Nome bimbo' }] },
      { id: 'adulto', title: 'Adulto', fields: [{ id: 'first_name', type: 'text', label: 'Nome adulto', required: true, placeholder: 'Nome adulto' }] },
    ],
  },
}

const fetchMock = vi.fn()
let chiamateInfo: string[] = []
type Info = { quote: { fascia: string | null; importo: number }[]; moduli: { codice: string; titolo: string }[] } | 'errore'

function mockFetch(anni: unknown[], info: Info | ((url: string) => Info)) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/iscrizione/model')) return Promise.resolve({ ok: true, json: async () => modelSchema })
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [{ id: SEDE_A, nome: NOME_SEDE_A }] }) })
    }
    if (url.includes('/api/iscrizione/info-anno')) {
      chiamateInfo.push(url)
      const r = typeof info === 'function' ? info(url) : info
      if (r === 'errore') return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'x' }) })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: r }) })
    }
    if (url.includes('/api/iscrizione/anni')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { anni, scelta: anni.length > 1, chiuso: false } }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const NOME = /Anno, quota e documenti/
const pannello = () => screen.findByRole('region', { name: NOME })
/** Il pannello si rimonta a ogni cambio di passo: lo si rilegge a ogni controllo, mai un riferimento tenuto. */
const P = () => screen.getByRole('region', { name: NOME })

beforeEach(() => {
  vi.clearAllMocks()
  chiamateInfo = []
  vi.stubGlobal('fetch', fetchMock)
})

describe('EnrollmentWizard · anno, quota e documenti', () => {
  it('anno singolo: appena la sede è nota il primo passo dice l\'anno, la quota e i documenti', async () => {
    mockFetch([A_PROSS], { quote: [{ fascia: null, importo: 120 }], moduli: [{ codice: 'a', titolo: 'Delega al ritiro' }, { codice: 'b', titolo: 'Certificato vaccinale' }] })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await pannello()
    expect(P()).toHaveTextContent('Stai iscrivendo il bambino per l’anno scolastico 2027/28')
    await waitFor(() => expect(P()).toHaveTextContent(/Quota di nuova iscrizione: .*120,00/))
    expect(within(P()).getByText('Delega al ritiro')).toBeInTheDocument()
    expect(within(P()).getByText('Certificato vaccinale')).toBeInTheDocument()
    expect(chiamateInfo[0]).toContain(`anno_id=${A_PROSS.anno_id}`)
    expect(chiamateInfo[0]).toContain(`scuola_id=${SEDE_A}`)
  })

  it('due anni: il passo «anno» c\'è già, e dopo la scelta il pannello mostra QUELL\'anno con la sua quota', async () => {
    mockFetch([A_CORR, A_PROSS], (url) =>
      url.includes(A_PROSS.anno_id)
        ? { quote: [{ fascia: null, importo: 120 }], moduli: [{ codice: 'a', titolo: 'Delega al ritiro' }] }
        : { quote: [{ fascia: null, importo: 90 }], moduli: [] },
    )
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    fireEvent.click(await screen.findByRole('radio', { name: /2027\/28/ }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await pannello()
    expect(P()).toHaveTextContent('2027/28')
    await waitFor(() => expect(P()).toHaveTextContent(/120,00/))
    expect(P()).not.toHaveTextContent(/90,00/)
  })

  it('quota assente nel listino: l\'anno e i documenti ci sono, nessun importo', async () => {
    mockFetch([A_PROSS], { quote: [], moduli: [{ codice: 'a', titolo: 'Delega al ritiro' }] })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await pannello()
    await waitFor(() => expect(within(P()).getByText('Delega al ritiro')).toBeInTheDocument())
    expect(P()).not.toHaveTextContent(/Quota/)
    expect(P()).not.toHaveTextContent(/€/)
  })

  it('quote diverse per fascia: l\'elenco per fascia, mai un importo solo', async () => {
    mockFetch([A_PROSS], { quote: [{ fascia: 'infanzia', importo: 100 }, { fascia: 'nido_1', importo: 150 }], moduli: [] })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await pannello()
    await waitFor(() => expect(P()).toHaveTextContent(/Infanzia: .*100,00/))
    expect(P()).toHaveTextContent(/Nido, primo anno: .*150,00/)
  })

  it('sede Demo raggiunta col link della sede: la lettura chiede la Demo', async () => {
    mockFetch([A_PROSS], { quote: [{ fascia: null, importo: 50 }], moduli: [{ codice: 'd', titolo: 'Modulo di prova' }] })
    render(<EnrollmentWizard scuolaId={SEDE_DEMO} />)
    await pannello()
    await waitFor(() => expect(within(P()).getByText('Modulo di prova')).toBeInTheDocument())
    expect(chiamateInfo[0]).toContain(`scuola_id=${SEDE_DEMO}`)
    expect(P()).toHaveTextContent(/50,00/)
  })

  it('lettura fallita: l\'anno si dice lo stesso, senza quota né elenco, e il modulo prosegue', async () => {
    mockFetch([A_PROSS], 'errore')
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await pannello()
    expect(P()).toHaveTextContent('2027/28')
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('info-anno'))).toBe(true))
    expect(P()).not.toHaveTextContent(/€/)
    expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument()
  })

  it('il riepilogo finale rimostra anno, quota e documenti', async () => {
    mockFetch([A_PROSS], { quote: [{ fascia: null, importo: 120 }], moduli: [{ codice: 'a', titolo: 'Delega al ritiro' }] })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())
    await pannello()
    expect(P()).toHaveTextContent('2027/28')
    expect(P()).toHaveTextContent(/120,00/)
    expect(within(P()).getByText('Delega al ritiro')).toBeInTheDocument()
  })
})
