import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dipendenze = vi.hoisted(() => ({
  salva: vi.fn(),
  scaricabili: [] as Array<{
    id: string
    numero: number
    anno: number
    pdf_disponibile: boolean
    quota_label: string | null
    intestatario: string
  }>,
}))

vi.mock('@/lib/pagamenti/scarico-fattura', () => ({
  useFattureScaricabili: () => ({
    caricamento: false,
    scarti: [],
    scaricabili: dipendenze.scaricabili,
  }),
  presentazioneSalvataggioFattura: () => ({ modalita: 'download-web' }),
  salvaFattura: dipendenze.salva,
  urlFattura: () => '/api/pdf',
}))

vi.mock('@/lib/pagamenti/esito-fattura', () => ({ registraEsitoFattura: vi.fn() }))

import { FatturaDocumenti } from '@/components/features/pagamenti/FatturaDocumenti'

function deferred<T>() {
  let resolve!: (valore: T) => void
  const promise = new Promise<T>((risolvi) => { resolve = risolvi })
  return { promise, resolve }
}

beforeEach(() => {
  dipendenze.scaricabili = [{
    id: 'fattura-1',
    numero: 1,
    anno: 2026,
    pdf_disponibile: true,
    quota_label: null,
    intestatario: 'Intestatario',
  }]
  global.fetch = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FatturaDocumenti con viewer reale', () => {
  it('annuncia il fallimento nel dialog, blocca i doppi comandi e consente una nuova prova pulita', async () => {
    const primoTentativo = deferred<{
      ok: false
      avviso: 'non-riuscito'
    }>()
    dipendenze.salva
      .mockReturnValueOnce(primoTentativo.promise)
      .mockResolvedValueOnce({ ok: true, modalita: 'download-web', avviso: null })

    render(
      <FatturaDocumenti
        pagamentoId="pagamento-1"
        userId="utente-1"
        aspetto="genitore"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apri' }))

    const dialog = screen.getByRole('dialog')
    const scarica = within(dialog).getByRole('button', { name: 'Scarica' })
    fireEvent.click(scarica)

    expect(scarica).toBeDisabled()
    expect(scarica).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(scarica)
    expect(dipendenze.salva).toHaveBeenCalledTimes(1)

    primoTentativo.resolve({ ok: false, avviso: 'non-riuscito' })

    const avviso = await within(dialog).findByRole('alert')
    expect(avviso).toHaveTextContent('Download non riuscito. Riprova fra poco.')
    expect(scarica).toBeEnabled()

    fireEvent.click(scarica)
    await waitFor(() => expect(dipendenze.salva).toHaveBeenCalledTimes(2))
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('ripulisce l’avviso quando si apre un documento diverso', async () => {
    dipendenze.scaricabili = [
      ...dipendenze.scaricabili,
      {
        id: 'fattura-2',
        numero: 2,
        anno: 2026,
        pdf_disponibile: true,
        quota_label: 'Quota due',
        intestatario: 'Intestatario',
      },
    ]
    dipendenze.salva.mockResolvedValueOnce({ ok: false, avviso: 'non-riuscito' })

    render(
      <FatturaDocumenti
        pagamentoId="pagamento-1"
        userId="utente-1"
        aspetto="genitore"
      />,
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Apri' })[0])
    const primoDialog = screen.getByRole('dialog')
    fireEvent.click(within(primoDialog).getByRole('button', { name: 'Scarica' }))
    expect(await within(primoDialog).findByRole('alert')).toHaveTextContent('Download non riuscito')

    fireEvent.click(within(primoDialog).getByRole('button', { name: 'Chiudi anteprima fattura' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Download non riuscito')
    fireEvent.click(screen.getAllByRole('button', { name: 'Apri' })[1])

    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull()
  })
})
