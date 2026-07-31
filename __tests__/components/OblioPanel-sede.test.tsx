import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * W3-E · R72 — Il pannello «Diritto all'oblio» non diceva la sede.
 *
 * È la lista di persone più pericolosa che abbiamo: la riga si clicca, si digita
 * un nominativo e un minore (più i suoi genitori) viene ANONIMIZZATO in modo
 * IRREVERSIBILE. Fino al 2026-07-31 la riga mostrava cognome, nome, classe e
 * genitori — e basta. Con tre plessi e classi omonime («2 ANNI» esiste in due
 * sedi), la Direzione multi-sede vedeva in un'unica lista i candidati di tutte
 * le sedi senza alcun modo di distinguerli.
 *
 * Qui si asserisce che la sede è scritta DOVE si decide: sulla riga della lista
 * e nel riquadro di conferma, quello con la casella da digitare.
 */

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => h.sedi(),
}))

const h = vi.hoisted(() => ({
  sedi: () => ({
    sedi: [] as { id: string; nome: string }[],
    selezionate: [] as string[],
    effettive: [] as string[],
    sedeCorrente: null as string | null,
    reFetchKey: '',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

function conSedi(elenco: { id: string; nome: string }[]) {
  h.sedi = () => ({
    sedi: elenco,
    selezionate: [],
    effettive: elenco.map((s) => s.id),
    sedeCorrente: elenco.length === 1 ? elenco[0].id : null,
    reFetchKey: elenco.map((s) => s.id).join(','),
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  })
}

const CANDIDATI = [
  { id: 'alu-a', nome: 'Alfa', cognome: 'Rossi', classe_sezione: '2 ANNI', stato: 'ritirato', scuola_id: SEDE_A, genitori: [{ id: 'p-a', nome: 'Anna Rossi' }] },
  { id: 'alu-b', nome: 'Beta', cognome: 'Rossi', classe_sezione: '2 ANNI', stato: 'ritirato', scuola_id: SEDE_B, genitori: [{ id: 'p-b', nome: 'Bruna Rossi' }] },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  conSedi([
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ])
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/admin/gdpr/erase')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ alunno: 1, parents: 1, parents_non_anonimizzati: 0, file_da_rimuovere: 0, nominativo_conferma: 'ROSSI BETA' }),
      })
    }
    return Promise.resolve({ ok: true, json: async () => CANDIDATI })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { OblioPanel } from '@/components/features/admin/settings/OblioPanel'

describe('OblioPanel — la sede accanto al candidato', () => {
  it('con due sedi attive OGNI riga porta il nome del suo plesso', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())

    const righe = Array.from(container.querySelectorAll('aside button'))
    expect(righe).toHaveLength(2)
    // Le due righe sono omonime (Rossi/Rossi, «2 ANNI»/«2 ANNI»): l'UNICA cosa
    // che le distingue è la sede.
    expect(within(righe[0] as HTMLElement).getByText(NOME_SEDE_A)).toBeInTheDocument()
    expect(within(righe[1] as HTMLElement).getByText(NOME_SEDE_B)).toBeInTheDocument()
  })

  it('il riquadro di conferma dice la sede del bambino che si sta per anonimizzare', async () => {
    const { container } = render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Beta/)).toBeInTheDocument())

    fireEvent.click(screen.getByText(/Rossi Beta/))
    const dettaglio = await waitFor(() => {
      const s = container.querySelector('section')
      expect(s?.textContent).toContain('ROSSI BETA') // il dry-run è arrivato
      return s as HTMLElement
    })
    expect(within(dettaglio).getByText(NOME_SEDE_B)).toBeInTheDocument()
    expect(within(dettaglio).queryByText(NOME_SEDE_A)).not.toBeInTheDocument()
  })

  it('con una sola sede accessibile la sede non compare: sarebbe solo rumore', async () => {
    conSedi([{ id: SEDE_A, nome: NOME_SEDE_A }])
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => [CANDIDATI[0]] }))
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Alfa/)).toBeInTheDocument())
    expect(screen.queryByText(NOME_SEDE_A)).not.toBeInTheDocument()
  })

  it('sede sconosciuta (uuid non fra le accessibili): lo dice, non tace', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => [{ ...CANDIDATI[0], scuola_id: null }] }),
    )
    render(<OblioPanel userId="dir-1" />)
    await waitFor(() => expect(screen.getByText(/Rossi Alfa/)).toBeInTheDocument())
    expect(screen.getByText(itAdminAltro.ricevutiSedeSconosciuta)).toBeInTheDocument()
  })

  it('le chiavi usate esistono in ENTRAMBI i cataloghi', () => {
    for (const k of ['oblioSede', 'ricevutiSedeSconosciuta']) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
    expect(Object.keys(itAdminAltro).sort()).toEqual(Object.keys(enAdminAltro).sort())
  })
})
