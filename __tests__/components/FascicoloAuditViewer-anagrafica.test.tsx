import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import primaria from '../../messages/it/adminPrimaria.json'
import { FascicoloAuditViewer } from '@/components/features/admin/primaria/FascicoloAuditViewer'

/**
 * Le aperture della scheda anagrafica si chiedono A PARTE (`conAnagrafica=1`): di
 * default il registro mostra le visioni del fascicolo, e un interruttore spento le
 * include. Qui si prova che l'interruttore cambia davvero la richiesta.
 */

const T = primaria as Record<string, string>

const fetchFinto = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [] as unknown[] }) }))
const urlChiamati = () => fetchFinto.mock.calls.map((c) => String((c as unknown[])[0]))

beforeEach(() => {
  fetchFinto.mockClear()
  vi.stubGlobal('fetch', fetchFinto)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FascicoloAuditViewer — l’interruttore delle aperture della scheda anagrafica', () => {
  it('è spento di default, e la prima lettura NON chiede le aperture della scheda', async () => {
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    const interruttore = screen.getByRole('checkbox', { name: T.fascicoloIncludiAnagrafica }) as HTMLInputElement
    expect(interruttore.checked).toBe(false)
    await waitFor(() => expect(fetchFinto).toHaveBeenCalledTimes(1))
    expect(urlChiamati()[0]).toContain('/api/admin/primaria/fascicolo-audit?')
    expect(urlChiamati()[0]).not.toContain('conAnagrafica')
  })

  it('acceso, rilancia la lettura con `conAnagrafica=1`; rispento, torna senza', async () => {
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    await waitFor(() => expect(fetchFinto).toHaveBeenCalledTimes(1))
    const interruttore = screen.getByRole('checkbox', { name: T.fascicoloIncludiAnagrafica }) as HTMLInputElement

    fireEvent.click(interruttore)
    await waitFor(() => expect(fetchFinto).toHaveBeenCalledTimes(2))
    expect(interruttore.checked).toBe(true)
    expect(new URL(urlChiamati()[1], 'http://localhost').searchParams.get('conAnagrafica')).toBe('1')

    fireEvent.click(interruttore)
    await waitFor(() => expect(fetchFinto).toHaveBeenCalledTimes(3))
    expect(urlChiamati()[2]).not.toContain('conAnagrafica')
  })

  it.each([
    ['la rete', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['un 500', async () => ({ ok: false, json: async () => ({ error: 'guasto' }) })],
  ])('lettura fallita (%s) dopo un cambio dell’interruttore: niente righe vecchie, e un messaggio d’errore', async (_nome, fallita) => {
    fetchFinto.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'r1',
            azione: 'view',
            finalita: null,
            ip: null,
            creato_il: '2026-10-04T08:00:00.000Z',
            utenti: { nome: 'Docente', cognome: 'Prova-E2E' },
            alunni: { nome: 'Bimbo', cognome: 'Vecchia-E2E' },
          },
        ],
      }),
    })
    fetchFinto.mockImplementationOnce(fallita as never)
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    expect(await screen.findByText(/Vecchia-E2E/)).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: T.fascicoloIncludiAnagrafica }))
    const errore = await screen.findByText(T.fascicoloErroreLettura)
    expect(within(errore.closest('table') as HTMLElement).queryByText(/Vecchia-E2E/)).toBeNull()
    expect(screen.queryByText(/Vecchia-E2E/)).toBeNull()
    // «Nessun accesso registrato» sarebbe falso: il registro non ha risposto.
    expect(screen.queryByText(T.fascicoloNessunAccesso)).toBeNull()
  })
})
