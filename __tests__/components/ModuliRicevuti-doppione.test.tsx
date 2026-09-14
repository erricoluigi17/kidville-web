import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

/**
 * «È LO STESSO BAMBINO: USA LA SCHEDA ESISTENTE» — il pulsante che risponde al doppione.
 *
 * Dal 2026-09-14 l'import a mano si ferma con `POSSIBILE_DOPPIONE` quando in sede c'è
 * già un bambino con lo stesso nome e la stessa data di nascita ma un codice fiscale
 * diverso (sette coppie di alunni doppi, sanate a mano quel giorno). Il pannello deve
 * offrire la seconda uscita — riusare la scheda — RIPETENDO l'import con
 * `abbinamenti` e con tutto ciò che la segreteria aveva già scelto: classe e retta.
 * Un pulsante che ripartisse da un modulo vuoto farebbe riscrivere la retta a memoria,
 * che è il modo in cui sono nati i 150 € di default.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'sc-giugliano', nome: 'Kidville Giugliano' }],
    selezionate: [],
    effettive: ['sc-giugliano'],
    sedeCorrente: null,
    reFetchKey: 'sc-giugliano',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const ETICHETTA = 'È lo stesso bambino: usa la scheda esistente'

const DOMANDA = {
  id: 'sub-1',
  scuola_id: 'sc-giugliano',
  status: 'pending',
  created_at: '2026-09-10T10:00:00Z',
  data: {
    children: [{ nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'XQQYKV19C07Z999A', data_nascita: '2019-03-07' }],
    adults: [{ first_name: 'Anna', last_name: 'Bianchi', ruolo: 'mother', email: 'anna@example.test' }],
  },
}
const ELENCO = [{
  id: 'sub-1',
  scuola_id: 'sc-giugliano',
  status: 'pending',
  assigned_classes: null,
  created_at: '2026-09-10T10:00:00Z',
  riassunto: { bambini: 1, adulti: 1, primo_bambino: 'Mario Rossi' },
}]
const SEZIONI = [{ id: 'sez-1', name: '3 ANNI', scuola_id: 'sc-giugliano' }]

const DOPPIONE = {
  dove: 'Bambino 1',
  messaggio: 'In questa sede esiste già un bambino con lo stesso nome e la stessa data di nascita, ma con un codice fiscale diverso.',
  codice: 'POSSIBILE_DOPPIONE',
  bambino: 0,
  alunno_esistente_id: ESISTENTE,
}

const fetchMock = vi.fn()
/** Le risposte alle PATCH, in ordine. */
let rispostePatch: unknown[] = []
/** I corpi delle PATCH mandate. */
let corpiPatch: Record<string, unknown>[] = []

beforeEach(() => {
  vi.clearAllMocks()
  corpiPatch = []
  rispostePatch = []
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PATCH') {
      corpiPatch.push(JSON.parse(String(init.body)))
      const risposta = rispostePatch.shift() ?? { success: true, warnings: [] }
      return Promise.resolve({ ok: true, status: 200, json: async () => risposta })
    }
    const u = String(url)
    const corpo = u.includes('/api/admin/sections') ? SEZIONI : u.includes('?id=') ? { data: DOMANDA } : { data: ELENCO, total: 1 }
    return Promise.resolve({ ok: true, status: 200, json: async () => corpo })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', vi.fn())
})

import { ModuliRicevuti } from '@/components/features/admin/iscrizioni/ModuliRicevuti'

async function apriECompila() {
  render(<ModuliRicevuti />)
  await waitFor(() => expect(screen.getByText('Mario Rossi')).toBeInTheDocument())
  fireEvent.click(screen.getByText('Mario Rossi'))
  const classe = await screen.findByLabelText(/Classe \/ Sezione/i)
  fireEvent.change(classe, { target: { value: '3 ANNI' } })
  fireEvent.change(screen.getByLabelText(/Retta mensile/i), { target: { value: '300' } })
  fireEvent.click(screen.getByRole('button', { name: /Importa nelle anagrafiche/i }))
}

describe('ModuliRicevuti — il doppione e la scheda esistente', () => {
  it('su POSSIBILE_DOPPIONE compare il pulsante, e ripete l\'import con `abbinamenti` e le scelte già fatte', async () => {
    rispostePatch = [{ success: false, errors: [DOPPIONE], warnings: [] }, { success: true, warnings: [] }]
    await apriECompila()

    const pulsante = await screen.findByRole('button', { name: ETICHETTA })
    expect(corpiPatch).toHaveLength(1)
    expect(corpiPatch[0]).not.toHaveProperty('abbinamenti.0')

    fireEvent.click(pulsante)

    await waitFor(() => expect(corpiPatch).toHaveLength(2))
    expect(corpiPatch[1]).toMatchObject({
      id: 'sub-1',
      action: 'import',
      abbinamenti: { '0': ESISTENTE },
      // Ciò che la segreteria aveva già scelto non si perde.
      assignments: { '0': '3 ANNI' },
      rette: { '0': 300 },
    })
    await screen.findByText('Iscrizione importata')
  })

  it('con più schede gemelle (nessuna proposta) il pulsante NON c\'è: sceglierne una sarebbe indovinare', async () => {
    const { alunno_esistente_id: _tolto, ...senzaScheda } = DOPPIONE
    void _tolto
    rispostePatch = [{ success: false, errors: [{ ...senzaScheda, messaggio: 'In questa sede esistono già 2 bambini…' }], warnings: [] }]
    await apriECompila()

    await screen.findByText(/esistono già 2 bambini/)
    expect(screen.queryByRole('button', { name: ETICHETTA })).not.toBeInTheDocument()
  })

  it('un errore qualunque non offre il pulsante', async () => {
    rispostePatch = [{ success: false, errors: [{ dove: 'Bambino 1', messaggio: 'La sezione «3 ANNI» non esiste nella sede selezionata.' }], warnings: [] }]
    await apriECompila()

    await screen.findByText(/non esiste nella sede selezionata/)
    expect(screen.queryByRole('button', { name: ETICHETTA })).not.toBeInTheDocument()
  })

  it('due bambini doppi: il secondo abbinamento non fa dimenticare il primo', async () => {
    const due = {
      ...DOMANDA,
      data: {
        ...DOMANDA.data,
        children: [DOMANDA.data.children[0], { nome: 'Luca', cognome: 'Rossi', codice_fiscale: 'XQQYKV21A01Z999B', data_nascita: '2021-01-01' }],
      },
    }
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        corpiPatch.push(JSON.parse(String(init.body)))
        const risposta = rispostePatch.shift() ?? { success: true, warnings: [] }
        return Promise.resolve({ ok: true, status: 200, json: async () => risposta })
      }
      const u = String(url)
      const corpo = u.includes('/api/admin/sections') ? SEZIONI : u.includes('?id=') ? { data: due } : { data: ELENCO, total: 1 }
      return Promise.resolve({ ok: true, status: 200, json: async () => corpo })
    })
    const SECONDA = 'c3c3c3c3-0000-4000-8000-000000000004'
    rispostePatch = [
      { success: false, errors: [DOPPIONE, { ...DOPPIONE, dove: 'Bambino 2', bambino: 1, alunno_esistente_id: SECONDA }], warnings: [] },
      { success: false, errors: [{ ...DOPPIONE, dove: 'Bambino 2', bambino: 1, alunno_esistente_id: SECONDA }], warnings: [] },
      { success: true, warnings: [] },
    ]

    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Mario Rossi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Mario Rossi'))
    await screen.findAllByLabelText(/Classe \/ Sezione/i)
    fireEvent.click(screen.getByRole('button', { name: /Importa nelle anagrafiche/i }))

    const [primo] = await screen.findAllByRole('button', { name: ETICHETTA })
    fireEvent.click(primo)
    await waitFor(() => expect(corpiPatch).toHaveLength(2))
    expect(corpiPatch[1].abbinamenti).toEqual({ '0': ESISTENTE })

    fireEvent.click(await screen.findByRole('button', { name: ETICHETTA }))
    await waitFor(() => expect(corpiPatch).toHaveLength(3))
    expect(corpiPatch[2].abbinamenti).toEqual({ '0': ESISTENTE, '1': SECONDA })
  })

  it('la chiave del pulsante esiste in ENTRAMBI i cataloghi', () => {
    expect(itAdminAltro).toHaveProperty('ricevutiUsaSchedaEsistente', ETICHETTA)
    expect(enAdminAltro).toHaveProperty('ricevutiUsaSchedaEsistente')
  })
})
