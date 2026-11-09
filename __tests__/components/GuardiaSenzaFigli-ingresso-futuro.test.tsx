import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * PR 4.5 · COMPITO 4.5.11 · LA FAMIGLIA E LA DATA FUTURA.
 *
 * Il caso vero: una famiglia nuova ha UN figlio che comincia l'anno prossimo (stato `in_arrivo`, passato qui come dato nella risposta
 * del server). Oggi vedrebbe «Nessuna iscrizione attiva»; deve vedere «L'iscrizione comincia il {data}» e poter raggiungere
 * `/parent/pagamenti`, dove trova la quota. E non deve MAI vedere una rotella senza fine: dopo `ATTESA_MAX_STATO_FIGLI_MS` senza
 * una risposta, chi non ha un bambino già noto legge un messaggio con il pulsante «Riprova».
 *
 * L'identità qui è quella VERA (`fetchEsitoFigli` + `useSessionIdentity`), con la sola fetch finta.
 */

const mockRouter = { replace: vi.fn(), refresh: vi.fn() }
let mockSearch = new URLSearchParams()
let mockPathname = '/parent'

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => mockPathname,
}))

import { invalidaFigliCache } from '@/lib/auth/use-parent-identity'
import { ATTESA_MAX_STATO_FIGLI_MS, GuardiaSenzaFigli, testoDataIngresso } from '@/components/features/parent/GuardiaSenzaFigli'
import parentServizi from '../../messages/it/parentServizi.json'
import annoFamiglia from '../../messages/it/annoFamiglia.json'

const fetchMock = vi.fn()
const risposta = (body: unknown) => ({ ok: true, json: async () => body })

/** Una famiglia con UN figlio che entra più avanti: nessun figlio visibile, i legami ci sono, il server dice da quando. */
const conIngressoFuturo = (data: string | null, motivo: string | null = 'ritirato') =>
  risposta({ success: true, data: [], senza_figli: false, in_attesa: true, motivo_assenza: motivo, ingresso_futuro: data })

const FRASE_DATA = annoFamiglia.ingressoFuturoTitolo.replace('{data}', '1 settembre 2027')

const montaLaPagina = () =>
  render(
    <GuardiaSenzaFigli>
      <div>CONTENUTO-DELLA-PAGINA</div>
    </GuardiaSenzaFigli>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  invalidaFigliCache()
  window.localStorage.clear()
  window.localStorage.setItem('kv_user_id', 'P1')
  mockSearch = new URLSearchParams()
  mockPathname = '/parent/gallery'
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GuardiaSenzaFigli — un figlio che entra più avanti', () => {
  it('mostra «L’iscrizione comincia il {data}» e NON «Nessuna iscrizione attiva»', async () => {
    fetchMock.mockResolvedValue(conIngressoFuturo('2027-09-01'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(FRASE_DATA)).toBeTruthy())
    expect(screen.queryByText(parentServizi.nonPiuIscrittoTitolo)).toBeNull()
    expect(screen.queryByText(parentServizi.inAttesaTitolo)).toBeNull()
    expect(screen.queryByText('CONTENUTO-DELLA-PAGINA')).toBeNull()
    expect(screen.getByText(annoFamiglia.ingressoFuturoTesto)).toBeTruthy()
  })

  it('la frase vale anche sulla home, che da sola mostrerebbe il suo pannello generico', async () => {
    mockPathname = '/parent'
    fetchMock.mockResolvedValue(conIngressoFuturo('2027-09-01'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(FRASE_DATA)).toBeTruthy())
    expect(screen.queryByText('CONTENUTO-DELLA-PAGINA')).toBeNull()
  })

  it('il pannello porta ai pagamenti, dove sta la quota', async () => {
    fetchMock.mockResolvedValue(conIngressoFuturo('2027-09-01'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(FRASE_DATA)).toBeTruthy())
    const link = screen.getByText(parentServizi.inAttesaPagamenti).closest('a')
    expect(link?.getAttribute('href')).toBe('/parent/pagamenti')
  })

  it('/parent/pagamenti resta raggiungibile: la pagina, non il pannello', async () => {
    mockPathname = '/parent/pagamenti'
    fetchMock.mockResolvedValue(conIngressoFuturo('2027-09-01'))
    montaLaPagina()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy())
    expect(screen.queryByText(FRASE_DATA)).toBeNull()
  })

  it('un guasto del server (nessuna data) ⇒ il pannello neutro, MAI la frase con la data', async () => {
    fetchMock.mockResolvedValue(conIngressoFuturo(null, null))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(parentServizi.inAttesaTitolo)).toBeTruthy())
    expect(screen.queryByText(FRASE_DATA)).toBeNull()
    expect(screen.queryByText(/L’iscrizione comincia/)).toBeNull()
    expect(screen.queryByText(parentServizi.nonPiuIscrittoTitolo)).toBeNull()
  })

  it('una data che non è YYYY-MM-DD non diventa una frase', async () => {
    fetchMock.mockResolvedValue(conIngressoFuturo('domani', null))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(parentServizi.inAttesaTitolo)).toBeTruthy())
    expect(screen.queryByText(/L’iscrizione comincia/)).toBeNull()
  })

  it('senza data, il motivo di sempre: «Nessuna iscrizione attiva» per chi ha lasciato', async () => {
    fetchMock.mockResolvedValue(conIngressoFuturo(null, 'ritirato'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(parentServizi.nonPiuIscrittoTitolo)).toBeTruthy())
  })

  it('con zero figli attivi NESSUNA rotella: il pannello è subito la risposta, senza stato di caricamento né pulsante', async () => {
    fetchMock.mockResolvedValue(conIngressoFuturo('2027-09-01'))
    const { container } = montaLaPagina()
    await waitFor(() => expect(screen.getByText(FRASE_DATA)).toBeTruthy())
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(annoFamiglia.nonVerificabileRiprova)).toBeNull()
  })
})

describe('GuardiaSenzaFigli — stato non determinabile', () => {
  it('la costante è 8 secondi', () => {
    expect(ATTESA_MAX_STATO_FIGLI_MS).toBe(8000)
  })

  it('nessuna risposta oltre l’attesa e nessun bambino noto ⇒ il messaggio con il pulsante, al posto della pagina', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchMock.mockReturnValue(new Promise(() => {})) // mai risolta
    montaLaPagina()
    // un istante prima della soglia: ancora la pagina (nessun lampo di messaggio)
    await act(async () => { vi.advanceTimersByTime(ATTESA_MAX_STATO_FIGLI_MS - 1) })
    expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy()
    expect(screen.queryByText(annoFamiglia.nonVerificabileTitolo)).toBeNull()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(screen.getByText(annoFamiglia.nonVerificabileTitolo)).toBeTruthy()
    expect(screen.getByText(annoFamiglia.nonVerificabileTesto)).toBeTruthy()
    expect(screen.getByText(annoFamiglia.nonVerificabileRiprova)).toBeTruthy()
    expect(screen.queryByText('CONTENUTO-DELLA-PAGINA')).toBeNull()
  })

  it('con un bambino già noto (cache del telefono) la pagina resta: l’attesa lunga non la copre', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    window.localStorage.setItem('kv_student_id', 'S1')
    fetchMock.mockReturnValue(new Promise(() => {}))
    montaLaPagina()
    await act(async () => { vi.advanceTimersByTime(ATTESA_MAX_STATO_FIGLI_MS * 3) })
    expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy()
    expect(screen.queryByText(annoFamiglia.nonVerificabileTitolo)).toBeNull()
  })

  it('rete giù (la lettura fallisce) e nessun bambino noto ⇒ subito il messaggio, non una rotella', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(annoFamiglia.nonVerificabileTitolo)).toBeTruthy())
    expect(screen.queryByText('CONTENUTO-DELLA-PAGINA')).toBeNull()
  })

  it('il profilo resta raggiungibile anche con lo stato incerto: da lì si esce', async () => {
    mockPathname = '/parent/profilo'
    fetchMock.mockRejectedValue(new Error('offline'))
    montaLaPagina()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy()
  })

  it('«Riprova» rilegge: se ora risponde un figlio, torna la pagina', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(annoFamiglia.nonVerificabileRiprova)).toBeTruthy())
    fetchMock.mockResolvedValue(risposta({ success: true, data: [{ id: 'A' }], senza_figli: false }))
    fireEvent.click(screen.getByText(annoFamiglia.nonVerificabileRiprova))
    await waitFor(() => expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy())
    expect(screen.queryByText(annoFamiglia.nonVerificabileTitolo)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('«Riprova» che trova una famiglia con la data ⇒ la frase vera', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(annoFamiglia.nonVerificabileRiprova)).toBeTruthy())
    fetchMock.mockResolvedValue(conIngressoFuturo('2027-09-01'))
    fireEvent.click(screen.getByText(annoFamiglia.nonVerificabileRiprova))
    await waitFor(() => expect(screen.getByText(FRASE_DATA)).toBeTruthy())
  })
})

describe('testoDataIngresso', () => {
  it('lingua e fuso espliciti: il giorno del database non scivola mai, in italiano e in inglese', () => {
    expect(testoDataIngresso('2027-09-01', 'it')).toBe('1 settembre 2027')
    expect(testoDataIngresso('2027-09-01', 'en')).toBe('1 September 2027')
    expect(testoDataIngresso('2027-12-31', 'it')).toBe('31 dicembre 2027')
  })
})
