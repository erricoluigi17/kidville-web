import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SEDE_A } from '../fixtures/sedi'

/**
 * PR 4.6 · rilievo 18 · accanto al rimando verso «Anno scolastico → Rette» Impostazioni mostra la retta di base dell'anno in corso
 * letta dal LISTINO (la route della scheda Rette), non dallo specchio storico `admin_settings.retta_default_importo`.
 * Se la lettura non c'è, o non ha una riga «per tutte le fasce», non si scrive nessun numero.
 */

const S26 = '5ed00000-0000-4000-8000-000000002026'

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ children, href }: { children?: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }
})
vi.mock('@/lib/context/calendario-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/calendario-context')>()),
  useCalendarioDi: () => [
    { annoId: 'a26', annoSedeId: S26, annoInizio: 2026, inizio: '2026-09-01', fine: '2027-08-31', ultimoGiornoAperto: '2027-07-31', preparaSuccessivoDal: '2027-03-01', stato: 'corrente', domandeAperte: false },
  ],
}))

import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel'

let rette: unknown[]
const fetchMock = vi.fn()

beforeEach(() => {
  rette = [{ voce: 'retta', fascia: null, payment_category_id: null, importo: 275, mesi: null }]
  fetchMock.mockImplementation((url: string) => {
    const u = String(url)
    if (u.includes(`/api/admin/anni/${S26}/rette`)) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { rette, mesi_effettivi: { retta: [], servizio: [] }, fasce_in_uso: [] } }) })
    if (u.split('?')[0] === '/api/admin/settings') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { retta_default_importo: 180, retta_giorno_scadenza: 5, retta_giorno_visibilita: 25, retta_auto_enabled: true, insoluto_tolleranza_giorni: 10, ticket_pacchetti: [], solleciti_config: {}, fiscale_config: {} } }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('Impostazioni · retta di base accanto al rimando', () => {
  it('mostra l’importo del listino dell’anno in corso, non lo specchio storico (180)', async () => {
    render(<SettingsPanel userId="u1" scuolaId={SEDE_A} />)
    expect(await screen.findByText(/Retta di base dell’anno in corso: .*275/)).toBeInTheDocument()
    expect(screen.queryByText(/180/)).toBeNull()
  })

  it('senza una riga «per tutte le fasce» non scrive nessun numero', async () => {
    rette = [{ voce: 'retta', fascia: 'infanzia', payment_category_id: null, importo: 300, mesi: null }]
    render(<SettingsPanel userId="u1" scuolaId={SEDE_A} />)
    await screen.findByRole('link', { name: /Vai ad Anno scolastico/ })
    expect(screen.queryByText(/Retta di base dell’anno in corso/)).toBeNull()
  })
})
