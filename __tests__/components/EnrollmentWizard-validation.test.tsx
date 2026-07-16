import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

const fetchMock = vi.fn()

// Schema ridotto e CONTROLLATO (id pagine 'bambino'/'adulto' = quelli attesi da
// extractEnrollmentTemplates), così il targeting dei campi nel test è pulito.
const modelSchema = {
  schema: {
    version: '1',
    pages: [
      {
        id: 'bambino',
        title: 'Dati del bambino',
        fields: [
          { id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Nome bimbo' },
          { id: 'residence_province', type: 'text', label: 'Provincia', required: true, placeholder: 'Prov bimbo', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
        ],
      },
      {
        id: 'adulto',
        title: 'Adulto',
        fields: [
          { id: 'first_name', type: 'text', label: 'Nome adulto', required: true, placeholder: 'Nome adulto' },
        ],
      },
    ],
  },
}

function mockFetch(postImpl?: () => unknown) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/model')) {
      return Promise.resolve({ ok: true, json: async () => modelSchema })
    }
    if (url.includes('/api/iscrizione') && init?.method === 'POST') {
      return Promise.resolve(postImpl ? postImpl() : { ok: true, status: 201, json: async () => ({ id: 'x' }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('EnrollmentWizard — validazione per pagina (template ripetibile)', () => {
  it('(a) "Bambino 1" con campi vuoti → "Avanti" bloccato + messaggio', async () => {
    mockFetch()
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))

    // Il messaggio compare dopo la validazione (async).
    await screen.findAllByText('Campo obbligatorio')
    expect(screen.getByText('Bambino 1')).toBeInTheDocument()
    // Non è avanzato all'adulto.
    expect(screen.queryByText(/^Adulto 1/)).not.toBeInTheDocument()
  })

  it('(b) provincia "Napoli" + nome validi → normalizzata e si avanza all\'adulto', async () => {
    mockFetch()
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Marco' } })
    fireEvent.change(screen.getByPlaceholderText('Prov bimbo'), { target: { value: 'Napoli' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))

    await waitFor(() => expect(screen.getByText(/^Adulto 1/)).toBeInTheDocument())
  })

  it('(c) provincia non riconoscibile → bloccata con messaggio', async () => {
    mockFetch()
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Marco' } })
    fireEvent.change(screen.getByPlaceholderText('Prov bimbo'), { target: { value: 'Qwz' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))

    expect(await screen.findByText(/sigla della provincia/i)).toBeInTheDocument()
    expect(screen.getByText('Bambino 1')).toBeInTheDocument()
    expect(screen.queryByText(/^Adulto 1/)).not.toBeInTheDocument()
  })

  it('(server) POST 400 con { campi: { children } } → torna al bambino e mostra il messaggio', async () => {
    mockFetch(() => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'Alcuni campi non sono validi.',
        campi: { children: { '0': { nome: 'Nome rifiutato dal server' } } },
      }),
    }))
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    // Bambino 1 → Adulto 1
    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Marco' } })
    fireEvent.change(screen.getByPlaceholderText('Prov bimbo'), { target: { value: 'NA' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByText(/^Adulto 1/)).toBeInTheDocument())

    // Adulto 1 → Riepilogo
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Maria' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())

    // Riepilogo → Invia (POST 400 con campi)
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    await waitFor(() =>
      expect(screen.getByText('Nome rifiutato dal server')).toBeInTheDocument(),
    )
  })
})
