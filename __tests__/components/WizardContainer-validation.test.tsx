import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { FormSchemaConfig } from '@/types/database.types'

// framer-motion in jsdom: le animazioni con AnimatePresence mode="wait" possono
// bloccare lo scambio di pagina (l'exit non completa). Le sostituiamo con render
// diretto, così il cambio step è deterministico.
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/m/tok',
  useSearchParams: () => new URLSearchParams(),
}))

import { WizardContainer } from '@/components/features/parent/forms/WizardContainer'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

const schemaDuePagine: FormSchemaConfig = {
  version: '1',
  pages: [
    {
      id: 'p1',
      title: 'Pagina Uno',
      fields: [
        { id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Es. Marco', validation: { min_length: 2 } },
        { id: 'residence_province', type: 'text', label: 'Provincia', required: true, placeholder: 'Es. RM', validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
      ],
    },
    { id: 'p2', title: 'Pagina Due', fields: [{ id: 'note', type: 'textarea', label: 'Note' }] },
  ],
}

function renderWizard(schema: FormSchemaConfig, publicToken = 'tok') {
  return render(
    <WizardContainer
      modelId="mod-1"
      title="Modulo Test"
      description={null}
      schema={schema}
      requiresSignature={false}
      userId={null}
      parentEmail={null}
      publicToken={publicToken}
    />,
  )
}

describe('WizardContainer — validazione per pagina', () => {
  it('(a) campi obbligatori vuoti → "Avanti" bloccato + messaggi visibili', async () => {
    renderWizard(schemaDuePagine)
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))

    // Il messaggio compare dopo la validazione (async): attendilo, poi verifica
    // che NON si sia avanzati.
    await screen.findAllByText('Campo obbligatorio')
    expect(screen.getByText('Pagina Uno')).toBeInTheDocument()
    expect(screen.queryByText('Pagina Due')).not.toBeInTheDocument()
  })

  it('(d) pagina valida → si avanza alla pagina successiva', async () => {
    renderWizard(schemaDuePagine)
    fireEvent.change(screen.getByPlaceholderText('Es. Marco'), { target: { value: 'Marco' } })
    fireEvent.change(screen.getByPlaceholderText('Es. RM'), { target: { value: 'NA' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))

    expect(await screen.findByText('Pagina Due')).toBeInTheDocument()
  })

  it('(b) provincia "Napoli" normalizzata → avanza', async () => {
    renderWizard(schemaDuePagine)
    fireEvent.change(screen.getByPlaceholderText('Es. Marco'), { target: { value: 'Marco' } })
    fireEvent.change(screen.getByPlaceholderText('Es. RM'), { target: { value: 'Napoli' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    expect(await screen.findByText('Pagina Due')).toBeInTheDocument()
  })

  it('(c) provincia non riconoscibile → bloccata con messaggio', async () => {
    renderWizard(schemaDuePagine)
    fireEvent.change(screen.getByPlaceholderText('Es. Marco'), { target: { value: 'Marco' } })
    fireEvent.change(screen.getByPlaceholderText('Es. RM'), { target: { value: 'Qwz' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    expect(await screen.findByText(/sigla della provincia/i)).toBeInTheDocument()
    expect(screen.queryByText('Pagina Due')).not.toBeInTheDocument()
  })

  it('(server) 400 con { campi } → messaggi mappati sui campi', async () => {
    const schemaUnaPagina: FormSchemaConfig = {
      version: '1',
      pages: [
        {
          id: 'p1',
          title: 'Pagina Uno',
          fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Es. Marco', validation: { min_length: 2 } }],
        },
      ],
    }
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Alcuni campi non sono validi.', campi: { nome: 'Nome rifiutato dal server' } }),
    })

    renderWizard(schemaUnaPagina)
    fireEvent.change(screen.getByPlaceholderText('Es. Marco'), { target: { value: 'Marco' } })
    // Pagina unica → "Avanti" invia.
    fireEvent.click(screen.getByRole('button', { name: /invia|avanti/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText('Nome rifiutato dal server')).toBeInTheDocument(),
    )
  })
})
