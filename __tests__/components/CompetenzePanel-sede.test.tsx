import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * W3-B — Certificato delle Competenze: la tendina delle quinte.
 *
 * Con tre plessi la quinta primaria si chiama «5 A» in ognuno. La tendina
 * mostrava `{s.name}` e basta: due (o tre) voci IDENTICHE, e la scelta fra i
 * bambini di Aversa e quelli di Cesa diventava un tiro di dadi. Il valore
 * trasportato è già `s.id` — è l'ETICHETTA che mente, e la firma del certificato
 * di un minore non è un posto dove tirare a indovinare.
 *
 * Secondo difetto: l'elenco veniva caricato una volta sola. Cambiando sede nel
 * selettore del cockpit la tendina restava quella di prima.
 */

let sediAttive: { sedi: { id: string; nome: string }[]; reFetchKey: string } = { sedi: [], reFetchKey: '' }

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: sediAttive.sedi,
    selezionate: [],
    effettive: sediAttive.sedi.map((s) => s.id),
    sedeCorrente: sediAttive.sedi.length === 1 ? sediAttive.sedi[0].id : null,
    reFetchKey: sediAttive.reFetchKey,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

const SEZIONI = [
  { id: 'sez-a5', name: '5 A', school_type: 'primaria', scuola_id: SEDE_A },
  { id: 'sez-b5', name: '5 A', school_type: 'primaria', scuola_id: SEDE_B },
  { id: 'sez-b1', name: '1 A', school_type: 'primaria', scuola_id: SEDE_B },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  sediAttive = {
    sedi: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ],
    reFetchKey: `${SEDE_A},${SEDE_B}`,
  }
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/admin/sections')) {
      return Promise.resolve({ ok: true, json: async () => SEZIONI })
    }
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { CompetenzePanel } from '@/components/features/admin/CompetenzePanel'

const tendina = () => document.querySelector('select') as HTMLSelectElement
const voci = () => Array.from(tendina().options).map((o) => ({ value: o.value, label: o.textContent }))

describe('CompetenzePanel — due quinte omonime non possono avere la stessa etichetta', () => {
  it('con più sedi ogni quinta porta il nome della SUA sede', async () => {
    render(<CompetenzePanel userId="u-1" />)
    await waitFor(() => expect(voci().length).toBe(3)) // segnaposto + 2 quinte

    const etichette = voci().slice(1).map((v) => v.label)
    expect(etichette).toContain(`5 A — ${NOME_SEDE_A}`)
    expect(etichette).toContain(`5 A — ${NOME_SEDE_B}`)
    // E restano due voci distinguibili: nessuna coppia di etichette identiche.
    expect(new Set(etichette).size).toBe(2)
    // Il valore trasportato resta l'identità della sezione.
    expect(voci().slice(1).map((v) => v.value).sort()).toEqual(['sez-a5', 'sez-b5'])
  })

  it('con UNA sola sede l\'etichetta resta il solo nome (niente rumore inutile)', async () => {
    sediAttive = { sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }], reFetchKey: SEDE_A }
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/api/admin/sections')
        ? Promise.resolve({ ok: true, json: async () => [SEZIONI[0]] })
        : Promise.resolve({ ok: true, json: async () => ({ data: [] }) }),
    )
    render(<CompetenzePanel userId="u-1" />)
    await waitFor(() => expect(voci().length).toBe(2))
    expect(voci()[1].label).toBe('5 A')
  })

  it('la lista si ricarica quando cambiano le sedi attive', async () => {
    const { rerender } = render(<CompetenzePanel userId="u-1" />)
    await waitFor(() => expect(voci().length).toBe(3))
    const primaChiamate = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/admin/sections')).length

    sediAttive = { sedi: [{ id: SEDE_B, nome: NOME_SEDE_B }], reFetchKey: SEDE_B }
    rerender(<CompetenzePanel userId="u-1" />)

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/admin/sections')).length)
        .toBeGreaterThan(primaChiamate),
    )
  })
})
