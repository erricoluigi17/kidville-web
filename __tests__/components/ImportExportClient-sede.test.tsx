import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AdminIdentityProvider } from '@/lib/context/admin-identity'
import { SedeProvider } from '@/lib/context/sede-context'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// Import anagrafiche — il cockpit DICHIARA la sede in cui sta importando.
//
// Dal 2026-07-31 `resolveScuolaScrittura` risponde davvero 400 quando la sede è
// ambigua (prima ripiegava in silenzio sulla sede primaria dell'utente: l'admin
// che nel selettore aveva scelto Aversa si vedeva archiviare l'import a
// Giugliano). Il caricamento del foglio partiva senza `scuola_id`: da qui in
// avanti o la sede è UNA — e viaggia nel corpo — oppure il caricamento non si
// offre nemmeno.
//
// Secondo pezzo: il server spiega perché una riga è stata bloccata («risulta già
// iscritto in un'altra sede: serve un trasferimento»), e la scheda mostrava i
// soli NUMERI di riga. Un messaggio che nessuno legge non è un messaggio.
//
// I provider sono quelli VERI (`SedeProvider` + `SedeRequired`): è il loro
// comportamento che si sta provando. Finta è solo la rete.
// =============================================================================

const RIGHE = [{ 'Nome alunno': 'Alfa', 'Cognome alunno': 'Rossidiprova' }]

const h = vi.hoisted(() => ({
  sedi: [] as { id: string; nome: string }[],
  esitoImport: {} as Record<string, unknown>,
}))

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: () => ({ from: () => ({ select: async () => ({ data: [], error: null }) }) }),
}))
vi.mock('xlsx', () => ({
  read: () => ({ SheetNames: ['Foglio1'], Sheets: { Foglio1: {} } }),
  utils: {
    sheet_to_json: () => RIGHE,
    json_to_sheet: () => ({}),
    book_new: () => ({}),
    book_append_sheet: () => undefined,
  },
  writeFile: () => undefined,
}))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
  h.esitoImport = { totale: 1, alunniCreati: 1, genitoriCreati: 1, legami: 1, errori: [] }
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => (String(url).includes('/api/admin/sedi') ? h.sedi : h.esitoImport),
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

import { ImportExportClient } from '@/components/features/admin/ImportExportClient'

const montaConSedi = async () => {
  render(
    <AdminIdentityProvider>
      <SedeProvider>
        <ImportExportClient />
      </SedeProvider>
    </AdminIdentityProvider>,
  )
  // Il provider carica le sedi accessibili: prima di allora la scheda è in
  // caricamento e non c'è nulla da cliccare.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/sedi', expect.anything()))
}

/** Sceglie il foglio: è l'unico `input[type=file]` della scheda. */
function caricaFoglio() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  fireEvent.change(input as HTMLInputElement, {
    target: { files: [new File(['col\n1'], 'anagrafiche.csv', { type: 'text/csv' })] },
  })
}

const chiamateImport = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/admin/import/anagrafiche'))

describe('ImportExportClient — la sede dell\'import si dichiara', () => {
  it('con UNA sede attiva il POST porta `scuola_id`', async () => {
    await montaConSedi()
    await waitFor(() => expect(document.querySelector('input[type="file"]')).not.toBeNull())
    caricaFoglio()

    await waitFor(() => expect(chiamateImport()).toHaveLength(1))
    const [, init] = chiamateImport()[0] as [string, { body: string }]
    expect(JSON.parse(init.body)).toMatchObject({ scuola_id: SEDE_A, rows: RIGHE })
  })

  it('con DUE sedi attive (sede ambigua) il caricamento non si offre: c\'è l\'avviso, non l\'input', async () => {
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }]
    await montaConSedi()

    expect(await screen.findByText('Seleziona una sede')).toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
    // Il prestampato resta scaricabile: non è una scrittura.
    expect(screen.getByText(/Scarica prestampato/i)).toBeInTheDocument()
  })

  it('i messaggi del server sono visibili, non solo i numeri di riga', async () => {
    h.esitoImport = {
      totale: 1, alunniCreati: 0, genitoriCreati: 0, legami: 0,
      errori: [{
        riga: 2,
        messaggio: "alunno: questo codice fiscale risulta già iscritto in un'altra sede: serve un trasferimento, non una nuova iscrizione.",
      }],
    }
    await montaConSedi()
    await waitFor(() => expect(document.querySelector('input[type="file"]')).not.toBeNull())
    caricaFoglio()

    expect(await screen.findByText(/serve un trasferimento/i)).toBeInTheDocument()
    expect(screen.getByText(/altra sede/i)).toBeInTheDocument()
  })
})
