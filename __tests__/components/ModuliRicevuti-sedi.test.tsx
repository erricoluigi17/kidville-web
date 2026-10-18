import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

/**
 * A5 — La tendina delle classi mostrava le sezioni di TUTTE le sedi attive.
 * Con tre plessi (Giugliano, Aversa, Cesa) e sezioni quasi omonime, la segreteria
 * poteva assegnare a un bambino di Aversa una sezione di Giugliano: il trigger DB
 * non la trova nella sede giusta e lascia `section_id` NULL, in silenzio.
 * E senza il nome della sede scritto sulla riga, chi importa non sa nemmeno PER
 * QUALE scuola sta importando.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [
      { id: 'sc-giugliano', nome: 'Kidville Giugliano' },
      { id: 'sc-aversa', nome: 'Kidville Aversa' },
    ],
    selezionate: [],
    effettive: ['sc-giugliano', 'sc-aversa'],
    sedeCorrente: null,
    reFetchKey: 'sc-giugliano,sc-aversa',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

const INVII = [
  {
    id: 'sub-aversa',
    scuola_id: 'sc-aversa',
    status: 'pending',
    created_at: '2026-07-20T10:00:00Z',
    data: {
      children: [{ nome: 'Ada', cognome: 'Verdi', codice_fiscale: 'CF1', data_nascita: '2022-01-01' }],
      adults: [{ first_name: 'Anna', last_name: 'Verdi', ruolo: 'mother', email: 'a@example.test' }],
    },
  },
]

const SEZIONI = [
  { id: 'sez-g1', name: 'GIUGLIANO 3 ANNI', scuola_id: 'sc-giugliano' },
  { id: 'sez-a1', name: 'AVERSA 3 ANNI', scuola_id: 'sc-aversa' },
  { id: 'sez-a2', name: 'AVERSA 2 ANNI A', scuola_id: 'sc-aversa' },
]

// Dal 2026-08-04 (T11-F4) l'ELENCO non porta più il payload della domanda: la
// riga d'elenco ha un `riassunto`, e il `data` completo — codici fiscali,
// allergie, note mediche — arriva solo da `GET ?id=<uuid>`, cioè quando si apre
// quella domanda. Il finto server qui sotto rispetta la divisione: se il
// componente tornasse a leggere il payload dall'elenco, non lo troverebbe.
const ELENCO = [
  {
    id: 'sub-aversa',
    scuola_id: 'sc-aversa',
    status: 'pending',
    assigned_classes: null,
    created_at: '2026-07-20T10:00:00Z',
    riassunto: { bambini: 1, adulti: 1, primo_bambino: 'Ada Verdi' },
  },
]

function rispostaPer(url: string): unknown {
  const u = String(url)
  if (u.includes('/api/admin/sections')) return SEZIONI
  if (u.includes('?id=')) return { data: INVII[0] }
  return { data: ELENCO, total: ELENCO.length }
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve({ ok: true, status: 200, json: async () => rispostaPer(url) }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

import { ModuliRicevuti } from '@/components/features/admin/iscrizioni/ModuliRicevuti'

describe('ModuliRicevuti — sede della domanda', () => {
  it('la tendina delle classi mostra SOLO le sezioni della sede della domanda', async () => {
    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada Verdi'))

    // ⚠️ SI NOMINA LA TENDINA, non si prende «la prima». Dal 2026-09-01 questa
    // schermata ha anche le tendine della barra filtri, e `findByRole('combobox')`
    // risolve sulla PRIMA che compare — che è quella dei filtri, disegnata subito,
    // mentre il pannello di dettaglio sta ancora arrivando. Il test misurava le
    // opzioni del filtro «Sede» credendo di misurare le classi: verde o rosso,
    // non stava guardando ciò che dice di guardare.
    const select = await screen.findByLabelText(/Classe \/ Sezione/i)
    const opzioni = within(select).getAllByRole('option').map((o) => o.textContent)
    expect(opzioni).toContain('AVERSA 3 ANNI')
    expect(opzioni).toContain('AVERSA 2 ANNI A')
    expect(opzioni).not.toContain('GIUGLIANO 3 ANNI')
  })

  it('il nome della sede è scritto sulla riga della lista e nel dettaglio', async () => {
    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
    expect(screen.getAllByText(/Kidville Aversa/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Ada Verdi'))
    await waitFor(() => expect(screen.getAllByText(/Kidville Aversa/).length).toBeGreaterThan(1))
  })

  it('nessuna stringa cablata: le chiavi risolvono dal catalogo', async () => {
    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada Verdi'))
    await screen.findByRole('combobox')
    expect(screen.queryByText(/^adminAltro\./)).not.toBeInTheDocument()
  })

  // Il gate di scope (A5) fa rispondere 403 anche al rifiuto di una domanda di
  // un'altra sede. Il client NON controllava l'esito: ricaricava e chiudeva il
  // pannello, cioè si comportava esattamente come dopo un rifiuto riuscito. La
  // segreteria avrebbe giurato di aver rifiutato una domanda che è ancora lì.
  it('rifiuto respinto dal server → lo dice, non fa finta di niente', async () => {
    const alertMock = vi.fn()
    vi.stubGlobal('alert', alertMock)
    vi.stubGlobal('confirm', () => true)
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'Questa domanda appartiene a un\'altra sede.' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => rispostaPer(url) })
    })

    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada Verdi'))
    fireEvent.click(await screen.findByText('Rifiuta'))

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith(expect.stringMatching(/altra sede/i)))
    // Il pannello resta aperto sulla domanda: nessun falso "fatto".
    expect(screen.getByText('Rifiuta')).toBeInTheDocument()
  })

  it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
    for (const k of ['ricevutiSede', 'ricevutiSedeSconosciuta']) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
  })

  it('adminAltro: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(itAdminAltro).sort()).toEqual(Object.keys(enAdminAltro).sort())
  })
})

/**
 * IL DETTAGLIO RESTA DOV'È (2026-10-17). Stesso difetto delle candidature: il pannello stava
 * in cima alla colonna destra, quindi aprendo una domanda in fondo alla lista il dettaglio
 * compariva fuori dallo schermo; sul telefono finiva sotto tutto l'elenco.
 */
describe('ModuliRicevuti — il dettaglio accanto alla lista, o sopra di essa', () => {
  it('computer: il dettaglio sta nella colonna ferma accanto alla lista', async () => {
    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada Verdi'))
    const select = await screen.findByLabelText(/Classe \/ Sezione/i)
    const colonna = select.closest('[aria-busy]') as HTMLElement | null
    expect(colonna, 'il dettaglio non sta in una colonna con `aria-busy`').toBeTruthy()
    expect(colonna?.className).toContain('lg:sticky')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('telefono: il dettaglio si apre in un foglio, e «Indietro» lo chiude', async () => {
    const originale = window.matchMedia
    window.matchMedia = vi.fn((q: string) => ({
      matches: q === '(max-width: 1023.98px)',
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
    try {
      render(<ModuliRicevuti />)
      await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Ada Verdi'))
      const foglio = await screen.findByRole('dialog')
      expect(await within(foglio).findByLabelText(/Classe \/ Sezione/i)).toBeInTheDocument()
      fireEvent.click(within(foglio).getByRole('button', { name: itAdminAltro.ricevutiIndietro }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } finally {
      window.matchMedia = originale
    }
  })

  it('telefono: chiuso mentre il dettaglio arriva, il foglio non si riapre da solo', async () => {
    const originale = window.matchMedia
    window.matchMedia = vi.fn((q: string) => ({
      matches: q === '(max-width: 1023.98px)',
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
    let rispondi: (v: unknown) => void = () => {}
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('?id=')
        ? new Promise((r) => { rispondi = r })
        : Promise.resolve({ ok: true, status: 200, json: async () => rispostaPer(url) }),
    )
    try {
      render(<ModuliRicevuti />)
      await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Ada Verdi'))
      await screen.findByRole('dialog')
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      rispondi({ ok: true, status: 200, json: async () => ({ data: INVII[0] }) })
      await waitFor(() => expect(screen.getByText('Ada Verdi')).toBeInTheDocument())
      await new Promise((r) => setTimeout(r, 0))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByLabelText(/Classe \/ Sezione/i)).toBeNull()
    } finally {
      window.matchMedia = originale
    }
  })
})
