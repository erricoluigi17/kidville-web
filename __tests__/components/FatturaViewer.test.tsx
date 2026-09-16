import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dipendenze = vi.hoisted(() => ({
  caricaMotorePdf: vi.fn(),
  logClient: vi.fn(),
}))

const rifiutiNonGestiti: unknown[] = []
const registraRifiutoNonGestito = (errore: unknown) => {
  rifiutiNonGestiti.push(errore)
}

vi.mock('@/lib/pagamenti/pdf-renderer', () => ({
  caricaMotorePdf: dipendenze.caricaMotorePdf,
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: dipendenze.logClient,
  nomeErrore: (errore: unknown) => (errore instanceof Error ? errore.name : 'errore'),
}))

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ open, title, className, children }: {
    open: boolean
    title: string
    className?: string
    children: React.ReactNode
  }) => open ? <div role="dialog" aria-label={title} className={className}>{children}</div> : null,
}))

import { FatturaViewer } from '@/components/features/pagamenti/FatturaViewer'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (valore: T) => void
  reject: (errore: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (valore: T) => void
  let reject!: (errore: unknown) => void
  const promise = new Promise<T>((ok, ko) => {
    resolve = ok
    reject = ko
  })
  return { promise, resolve, reject }
}

function rispostaPdf(): Response {
  return new Response(new Uint8Array([37, 80, 68, 70]), {
    status: 200,
    headers: { 'content-type': 'application/pdf; charset=binary' },
  })
}

function creaDocumento(testi = ['Testo pagina uno', 'Testo pagina due']) {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() }
  const pagine = testi.map((testo) => ({
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    })),
    render: vi.fn(() => renderTask),
    getTextContent: vi.fn(async () => ({ items: [{ str: testo }] })),
  }))
  return {
    documento: {
      numPages: pagine.length,
      getPage: vi.fn(async (numero: number) => pagine[numero - 1]),
      destroy: vi.fn(async () => undefined),
    },
    pagine,
    renderTask,
  }
}

function montaMotore(documento: ReturnType<typeof creaDocumento>['documento']) {
  const getDocumentProxy = vi.fn(async () => documento)
  dipendenze.caricaMotorePdf.mockResolvedValue(getDocumentProxy)
  return getDocumentProxy
}

beforeEach(() => {
  vi.clearAllMocks()
  rifiutiNonGestiti.length = 0
  process.on('unhandledRejection', registraRifiutoNonGestito)
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})

afterEach(() => {
  process.off('unhandledRejection', registraRifiutoNonGestito)
  cleanup()
  vi.restoreAllMocks()
})

describe('FatturaViewer', () => {
  it('usa 100vh come fallback iOS 15 e applica 100dvh soltanto quando supportato', () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch

    render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)

    const dialogo = screen.getByRole('dialog')
    expect(dialogo).toHaveClass('max-h-[calc(100vh-2rem)]')
    expect(dialogo.className.split(/\s+/)).toContain(
      'supports-[height:100dvh]:max-h-[calc(100dvh-2rem)]',
    )
  })

  it('carica fetch e motore PDF soltanto quando viene aperto', async () => {
    const { documento } = creaDocumento()
    montaMotore(documento)
    const fetchMock = vi.fn(async () => rispostaPdf())
    const onEsito = vi.fn()
    global.fetch = fetchMock as typeof fetch

    const vista = render(
      <FatturaViewer open={false} onClose={vi.fn()} url="/api/fatture/uno" />,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dipendenze.caricaMotorePdf).not.toHaveBeenCalled()

    vista.rerender(
      <FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" onEsito={onEsito} />,
    )

    expect(await screen.findByText('Pagina 1 di 2')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/fatture/uno',
      expect.objectContaining({ credentials: 'same-origin', signal: expect.any(AbortSignal) }),
    )
    expect(dipendenze.caricaMotorePdf).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onEsito).toHaveBeenCalledWith('visualizzata'))
  })

  it('passa bytes e sandbox al renderer e pubblica il testo della pagina', async () => {
    const { documento } = creaDocumento()
    const getDocumentProxy = montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)

    expect(await screen.findByText('Testo pagina uno')).toBeInTheDocument()
    expect(getDocumentProxy).toHaveBeenCalledWith(expect.any(Uint8Array), {
      isEvalSupported: false,
    })
    expect(screen.getByRole('button', { name: 'Pagina precedente' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pagina successiva' })).toBeEnabled()
  })

  it('mostra un errore e riprova senza chiudere il dialogo', async () => {
    const { documento } = creaDocumento()
    montaMotore(documento)
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('errore', { status: 503, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(rispostaPdf()) as typeof fetch

    render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossibile mostrare la fattura.')
    expect(dipendenze.logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'error',
        campi: expect.objectContaining({ operazione: 'risposta' }),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByText('Pagina 1 di 2')).toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('azzera pagina e contenuto mentre carica un URL diverso', async () => {
    const primo = creaDocumento(['Documento A pagina uno', 'Documento A pagina due'])
    const secondo = creaDocumento(['Documento B'])
    const attesaSecondo = deferred<Response>()
    const getDocumentProxy = vi
      .fn()
      .mockResolvedValueOnce(primo.documento)
      .mockResolvedValueOnce(secondo.documento)
    dipendenze.caricaMotorePdf.mockResolvedValue(getDocumentProxy)
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(rispostaPdf())
      .mockImplementationOnce(() => attesaSecondo.promise) as typeof fetch

    const vista = render(
      <FatturaViewer open onClose={vi.fn()} url="/api/fatture/a" />,
    )
    await screen.findByText('Documento A pagina uno')
    fireEvent.click(screen.getByRole('button', { name: 'Pagina successiva' }))
    expect(await screen.findByText('Documento A pagina due')).toBeInTheDocument()

    vista.rerender(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/b" />)
    expect(screen.queryByText('Documento A pagina due')).not.toBeInTheDocument()
    expect(screen.queryByText('Pagina 2 di 2')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Caricamento fattura…')

    attesaSecondo.resolve(rispostaPdf())
    expect(await screen.findByText('Documento B')).toBeInTheDocument()
    expect(primo.documento.destroy).toHaveBeenCalledTimes(1)
  })

  it('naviga fra le pagine, espone zoom e chiusura con nomi accessibili', async () => {
    const { documento } = creaDocumento()
    montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch
    const onClose = vi.fn()
    const onScarica = vi.fn()

    render(
      <FatturaViewer
        open
        onClose={onClose}
        url="/api/fatture/uno"
        onScarica={onScarica}
        etichettaScarica="Salva PDF"
      />,
    )
    await screen.findByText('Testo pagina uno')

    fireEvent.click(screen.getByRole('button', { name: 'Pagina successiva' }))
    expect(await screen.findByText('Testo pagina due')).toBeInTheDocument()
    expect(screen.getByText('Pagina 2 di 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Aumenta zoom' }))
    expect(screen.getByText('125%')).toBeInTheDocument()
    await screen.findByText('Testo pagina due')
    fireEvent.click(screen.getByRole('button', { name: 'Salva PDF' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi anteprima fattura' }))
    expect(onScarica).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('annulla il render e distrugge il documento alla chiusura', async () => {
    const attesaRender = deferred<void>()
    const { documento, pagine, renderTask } = creaDocumento()
    renderTask.promise = attesaRender.promise
    montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    const vista = render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)
    await waitFor(() => expect(pagine[0].render).toHaveBeenCalledTimes(1))

    vista.rerender(<FatturaViewer open={false} onClose={vi.fn()} url="/api/fatture/uno" />)
    expect(renderTask.cancel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(documento.destroy).toHaveBeenCalledTimes(1))
  })

  it('gestisce subito la rejection prodotta da cancel senza falso errore o unhandled rejection', async () => {
    const attesaRender = deferred<void>()
    const { documento, pagine, renderTask } = creaDocumento()
    renderTask.promise = attesaRender.promise
    renderTask.cancel.mockImplementation(() => {
      const cancellazione = new Error('render annullato')
      cancellazione.name = 'RenderingCancelledException'
      attesaRender.reject(cancellazione)
    })
    montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    const vista = render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)
    await waitFor(() => expect(pagine[0].render).toHaveBeenCalledTimes(1))
    vista.rerender(<FatturaViewer open={false} onClose={vi.fn()} url="/api/fatture/uno" />)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renderTask.cancel).toHaveBeenCalledTimes(1)
    expect(rifiutiNonGestiti).toEqual([])
    expect(dipendenze.logClient).not.toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error' }),
    )
  })

  it('un errore del testo cancella il render pendente e conserva lo stadio testo senza rejection orfane', async () => {
    const attesaRender = deferred<void>()
    const attesaTesto = deferred<{ items: Array<{ str: string }> }>()
    const { documento, pagine, renderTask } = creaDocumento()
    renderTask.promise = attesaRender.promise
    pagine[0].getTextContent.mockImplementation(() => attesaTesto.promise)
    renderTask.cancel.mockImplementation(() => {
      const cancellazione = new Error('render annullato dopo errore testo')
      cancellazione.name = 'RenderingCancelledException'
      attesaRender.reject(cancellazione)
    })
    montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)
    await waitFor(() => expect(pagine[0].getTextContent).toHaveBeenCalledTimes(1))
    attesaTesto.reject(new Error('testo PDF illeggibile'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossibile mostrare la fattura.')
    expect(renderTask.cancel).toHaveBeenCalledTimes(1)
    expect(dipendenze.logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'error',
        campi: expect.objectContaining({ operazione: 'testo' }),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rifiutiNonGestiti).toEqual([])
  })

  it('chiude mentre testo e render sono pendenti e assorbe entrambe le rejection successive', async () => {
    const attesaRender = deferred<void>()
    const attesaTesto = deferred<{ items: Array<{ str: string }> }>()
    const { documento, pagine, renderTask } = creaDocumento()
    renderTask.promise = attesaRender.promise
    pagine[0].getTextContent.mockImplementation(() => attesaTesto.promise)
    renderTask.cancel.mockImplementation(() => {
      const cancellazione = new Error('render annullato in chiusura')
      cancellazione.name = 'RenderingCancelledException'
      attesaRender.reject(cancellazione)
    })
    montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    const vista = render(<FatturaViewer open onClose={vi.fn()} url="/api/fatture/uno" />)
    await waitFor(() => expect(pagine[0].getTextContent).toHaveBeenCalledTimes(1))
    vista.rerender(<FatturaViewer open={false} onClose={vi.fn()} url="/api/fatture/uno" />)
    attesaTesto.reject(new Error('testo terminato dopo chiusura'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renderTask.cancel).toHaveBeenCalledTimes(1)
    expect(rifiutiNonGestiti).toEqual([])
    expect(dipendenze.logClient).not.toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error' }),
    )
  })

  it('limita DPR e superficie del canvas a sedici milioni di pixel', async () => {
    const { documento, pagine } = creaDocumento(['Pagina grande'])
    pagine[0].getViewport.mockReturnValue({ width: 5_000, height: 5_000 })
    montaMotore(documento)
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    const { container } = render(
      <FatturaViewer open onClose={vi.fn()} url="/api/fatture/grande" />,
    )
    await screen.findByText('Pagina grande')

    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(16_000_000)
    expect(pagine[0].render).toHaveBeenCalledWith(
      expect.objectContaining({ transform: [0.8, 0, 0, 0.8, 0, 0] }),
    )
  })

  it('distrugge un documento che termina di caricarsi dopo la chiusura', async () => {
    const { documento } = creaDocumento()
    const attesaDocumento = deferred<typeof documento>()
    dipendenze.caricaMotorePdf.mockResolvedValue(vi.fn(() => attesaDocumento.promise))
    global.fetch = vi.fn(async () => rispostaPdf()) as typeof fetch

    const onClose = vi.fn()
    const onEsito = vi.fn()
    const vista = render(
      <FatturaViewer open onClose={onClose} url="/api/fatture/uno" onEsito={onEsito} />,
    )
    await waitFor(() => expect(dipendenze.caricaMotorePdf).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi anteprima fattura' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onEsito).toHaveBeenCalledWith('annullata')
    vista.rerender(
      <FatturaViewer open={false} onClose={onClose} url="/api/fatture/uno" onEsito={onEsito} />,
    )
    attesaDocumento.resolve(documento)

    await waitFor(() => expect(documento.destroy).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Pagina 1 di 2')).not.toBeInTheDocument()
  })
})
