import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  elenco: {
    caricamento: false,
    scaricabili: [] as Array<{
      id: string
      numero: number
      anno: number
      quota_label: string | null
      intestatario: string
      pdf_disponibile: boolean
    }>,
    scarti: [] as Array<{ id: string; numero: number; motivo: string }>,
  },
  useFatture: vi.fn(),
  salva: vi.fn(),
  presentazione: vi.fn(),
  telemetria: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/pagamenti/scarico-fattura', () => ({
  useFattureScaricabili: h.useFatture,
  nomeFileFattura: (numero: number, anno: number) => `fattura-${numero}-${anno}.pdf`,
  urlFattura: ({ pagamentoId, fatturaId, userId }: {
    pagamentoId: string
    fatturaId: string
    userId: string
  }) => `/api/pagamenti/fattura?pagamento_id=${pagamentoId}&userId=${userId}&fattura_id=${fatturaId}`,
  presentazioneSalvataggioFattura: h.presentazione,
  salvaFattura: h.salva,
}))

vi.mock('@/lib/pagamenti/esito-fattura', () => ({ registraEsitoFattura: h.telemetria }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (errore: unknown) => errore instanceof Error ? errore.name : 'ErroreSconosciuto',
}))

vi.mock('@/components/features/pagamenti/FatturaViewer', () => ({
  FatturaViewer: ({
    open,
    url,
    onClose,
    onScarica,
    etichettaScarica,
    onEsito,
  }: {
    open: boolean
    url: string
    onClose: () => void
    onScarica?: () => void
    etichettaScarica?: string
    onEsito?: (esito: 'visualizzata' | 'annullata') => void
  }) => open ? (
    <div role="dialog" data-url={url}>
      <button type="button" onClick={onClose}>Chiudi viewer finto</button>
      <button type="button" onClick={onScarica}>{etichettaScarica}</button>
      <button type="button" onClick={() => onEsito?.('visualizzata')}>Viewer pronto</button>
      <button type="button" onClick={() => onEsito?.('annullata')}>Viewer annullato</button>
    </div>
  ) : null,
}))

import { FatturaDocumenti } from '@/components/features/pagamenti/FatturaDocumenti'

const PAGAMENTO = '85320395-0000-4000-8000-000000000001'
const UTENTE = 'bbbbbbbb-0000-4000-8000-000000000004'
const FATTURA_1 = 'cccccccc-0000-4000-8000-000000000011'
const FATTURA_2 = 'cccccccc-0000-4000-8000-000000000012'

function documento(id = FATTURA_1, numero = 1948) {
  return {
    id,
    numero,
    anno: 2026,
    quota_label: numero === 1948 ? 'Quota uno' : 'Quota due',
    intestatario: 'Intestatario',
    pdf_disponibile: true,
  }
}

function monta(props?: Partial<React.ComponentProps<typeof FatturaDocumenti>>) {
  return render(
    <FatturaDocumenti
      pagamentoId={PAGAMENTO}
      userId={UTENTE}
      aspetto="genitore"
      {...props}
    />,
  )
}

beforeEach(() => {
  h.elenco = { caricamento: false, scaricabili: [], scarti: [] }
  h.useFatture.mockImplementation(() => h.elenco)
  h.presentazione.mockReturnValue({ modalita: 'download-web', etichetta: 'Salva' })
  h.salva.mockResolvedValue({ ok: true, modalita: 'download-web', avviso: null })
  h.telemetria.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FatturaDocumenti', () => {
  it('non rende comandi durante il caricamento né con un elenco autorizzato vuoto', () => {
    h.elenco = { caricamento: true, scaricabili: [], scarti: [] }
    const vista = monta()

    expect(screen.queryByRole('button')).toBeNull()
    expect(h.useFatture).toHaveBeenCalledTimes(1)

    h.elenco = { caricamento: false, scaricabili: [], scarti: [] }
    vista.rerender(
      <FatturaDocumenti pagamentoId={PAGAMENTO} userId={UTENTE} aspetto="genitore" />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('Apri mostra il PDF nel viewer interno all’URL inline e non avvia il salvataggio', () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    monta()

    fireEvent.click(screen.getByRole('button', { name: 'Apri' }))

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-url',
      `/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}&userId=${UTENTE}&fattura_id=${FATTURA_1}`,
    )
    expect(h.salva).not.toHaveBeenCalled()
  })

  it('registra gli esiti del viewer con le coordinate del documento aperto', () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'Apri' }))

    fireEvent.click(screen.getByRole('button', { name: 'Viewer pronto' }))
    fireEvent.click(screen.getByRole('button', { name: 'Viewer annullato' }))

    expect(h.telemetria).toHaveBeenNthCalledWith(1, {
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA_1,
      esito: 'visualizzata',
    })
    expect(h.telemetria).toHaveBeenNthCalledWith(2, {
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA_1,
      esito: 'annullata',
    })
  })

  it('usa “Scarica” su web/Filesystem e il testo esplicito nel nativo senza Filesystem', () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    const vista = monta()
    expect(screen.getByRole('button', { name: 'Scarica' })).toBeInTheDocument()

    h.presentazione.mockReturnValue({
      modalita: 'browser-esterno',
      etichetta: 'Apri nel browser per salvare',
    })
    vista.rerender(
      <FatturaDocumenti pagamentoId={PAGAMENTO} userId={UTENTE} aspetto="genitore" />,
    )
    expect(screen.getByRole('button', { name: 'Apri nel browser per salvare' })).toBeInTheDocument()
  })

  it('Scarica passa documento e signal all’helper senza annunciare un falso “salvato”', async () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    monta()

    fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))

    expect(h.salva).toHaveBeenCalledWith(expect.objectContaining({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA_1,
      userId: UTENTE,
      numero: 1948,
      anno: 2026,
      signal: expect.any(AbortSignal),
    }))
    expect(document.body.textContent?.toLowerCase()).not.toContain('salvato')
  })

  it('mostra il fallimento e lascia disponibile il comando per riprovare', async () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    h.salva
      .mockResolvedValueOnce({
        ok: false,
        modalita: 'download-web',
        motivo: 'http-503',
        riprovabile: true,
        avviso: 'non-riuscito',
      })
      .mockResolvedValueOnce({ ok: true, modalita: 'download-web', avviso: null })
    monta()

    fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Download non riuscito'))

    fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    await waitFor(() => expect(h.salva).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('')
  })

  it('registra un errore inatteso con soli campi sintetici e permette il retry', async () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    h.salva.mockRejectedValueOnce(new TypeError('url con dati che non va nei log'))
    monta()

    fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    await waitFor(() => expect(h.logClient).toHaveBeenCalledTimes(1))

    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'js',
      messaggio: 'fattura-salvataggio-ui-fallito',
      campi: { error_code: 'TypeError' },
    })
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(PAGAMENTO)
    expect(screen.getByRole('button', { name: 'Scarica' })).toBeEnabled()
  })

  it('cambiando documento chiude la vista vecchia e attribuisce il callback al nuovo id', () => {
    h.elenco = {
      caricamento: false,
      scaricabili: [documento(), documento(FATTURA_2, 1949)],
      scarti: [],
    }
    monta()
    const apri = screen.getAllByRole('button', { name: 'Apri' })

    fireEvent.click(apri[0])
    expect(screen.getByRole('dialog')).toHaveAttribute('data-url', expect.stringContaining(FATTURA_1))
    fireEvent.click(apri[1])
    expect(screen.getByRole('dialog')).toHaveAttribute('data-url', expect.stringContaining(FATTURA_2))
    fireEvent.click(screen.getByRole('button', { name: 'Viewer pronto' }))

    expect(h.telemetria).toHaveBeenLastCalledWith({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA_2,
      esito: 'visualizzata',
    })
  })

  it('cambiando documento annulla il salvataggio precedente prima dell’handoff', () => {
    h.elenco = {
      caricamento: false,
      scaricabili: [documento(), documento(FATTURA_2, 1949)],
      scarti: [],
    }
    h.salva.mockReturnValue(new Promise(() => {}))
    monta()

    fireEvent.click(screen.getAllByRole('button', { name: 'Scarica' })[0])
    const signal = h.salva.mock.calls[0][0].signal as AbortSignal
    fireEvent.click(screen.getAllByRole('button', { name: 'Apri' })[1])

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('dialog')).toHaveAttribute('data-url', expect.stringContaining(FATTURA_2))
  })

  it('cambiando pagamento non mostra mai il viewer del pagamento precedente', () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    const vista = monta()
    fireEvent.click(screen.getByRole('button', { name: 'Apri' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    h.elenco = { caricamento: true, scaricabili: [], scarti: [] }
    vista.rerender(
      <FatturaDocumenti pagamentoId="85320395-0000-4000-8000-000000000099" userId={UTENTE} aspetto="genitore" />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apri' })).toBeNull()

    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    vista.rerender(
      <FatturaDocumenti pagamentoId={PAGAMENTO} userId={UTENTE} aspetto="genitore" />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cambiando pagamento annulla il salvataggio in volo prima di un handoff tardivo', () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    h.salva.mockReturnValue(new Promise(() => {}))
    const vista = monta()
    fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    const signal = h.salva.mock.calls[0][0].signal as AbortSignal

    h.elenco = { caricamento: true, scaricabili: [], scarti: [] }
    vista.rerender(
      <FatturaDocumenti pagamentoId="85320395-0000-4000-8000-000000000099" userId={UTENTE} aspetto="genitore" />,
    )

    expect(signal.aborted).toBe(true)
  })

  it('annulla il salvataggio in volo quando il componente viene smontato', () => {
    h.elenco = { caricamento: false, scaricabili: [documento()], scarti: [] }
    h.salva.mockReturnValue(new Promise(() => {}))
    const vista = monta()
    fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    const signal = h.salva.mock.calls[0][0].signal as AbortSignal

    vista.unmount()

    expect(signal.aborted).toBe(true)
  })
})
