import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * W3-B — Scheda anagrafica dell'alunno: la tendina «Classe / Sezione».
 *
 * Il difetto: `fetch('/api/admin/sections')` senza `scuola_id`, cioè le sezioni
 * di TUTTE le sedi attive, offerte come destinazioni per un bambino che sta in
 * UNA sola. Con «3 ANNI» presente in tutti e tre i plessi la tendina mostrava tre
 * voci identiche e sceglierne una sbagliata era la cosa più facile del mondo.
 *
 * Da W2-C il server RIFIUTA la classe fuori sede (400), quindi il danno non è più
 * silenzioso — ma è comunque un errore che l'interfaccia induce e che nessuno
 * capisce. La tendina deve contenere solo ciò che è lecito scegliere.
 */

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
  StudentEconomicSection: () => null,
}))

const SEZIONI: Record<string, { id: string; name: string; school_type: string; scuola_id: string }[]> = {
  [SEDE_A]: [{ id: 'sez-a1', name: 'GIRASOLI', school_type: 'infanzia', scuola_id: SEDE_A }],
  [SEDE_B]: [{ id: 'sez-b1', name: 'LEONI', school_type: 'infanzia', scuola_id: SEDE_B }],
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sections') {
      const sede = u.searchParams.get('scuola_id')
      return Promise.resolve({
        ok: true,
        json: async () => (sede ? (SEZIONI[sede] ?? []) : Object.values(SEZIONI).flat()),
      })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'

const ALUNNO_B = {
  id: 'al-b1',
  nome: 'Bea',
  cognome: 'Bianchi',
  scuola_id: SEDE_B,
  classe_sezione: 'LEONI',
}

const tendinaClasse = () => document.querySelector('select[name="classe_sezione"]') as HTMLSelectElement

const opzioni = () => Array.from(tendinaClasse().options).map((o) => o.textContent)
const urlChiamate = () => fetchMock.mock.calls.map((c) => String(c[0]))

describe('StudentDetailPanel — le classi offerte sono quelle della SEDE del bambino', () => {
  it('le sezioni si chiedono per la sede dell\'alunno, e le altre non compaiono', async () => {
    render(<StudentDetailPanel student={ALUNNO_B} onClose={() => {}} onSave={() => {}} onDelete={() => {}} />)

    await waitFor(() => expect(opzioni()).toContain('LEONI (infanzia)'))
    expect(urlChiamate()).toContain(`/api/admin/sections?scuola_id=${SEDE_B}`)
    expect(opzioni()).not.toContain('GIRASOLI (infanzia)')
  })

  it('alunno senza sede: nessuna classe da offrire, e NON si chiedono sezioni', async () => {
    render(
      <StudentDetailPanel
        student={{ id: 'al-x', nome: 'Ics', cognome: 'Ipsilon' }}
        onClose={() => {}}
        onSave={() => {}}
        onDelete={() => {}}
      />,
    )
    await waitFor(() => expect(tendinaClasse()).toBeTruthy())
    expect(urlChiamate().filter((u) => u.startsWith('/api/admin/sections'))).toHaveLength(0)
    expect(opzioni()).toHaveLength(1) // solo «— Nessuna —»
  })

  it('la classe ATTUALE resta visibile anche se non è più fra le sezioni della sede', async () => {
    render(
      <StudentDetailPanel
        student={{ ...ALUNNO_B, classe_sezione: 'CLASSE STORICA' }}
        onClose={() => {}}
        onSave={() => {}}
        onDelete={() => {}}
      />,
    )
    await waitFor(() => expect(opzioni()).toContain('LEONI (infanzia)'))
    // Senza questa voce la tendina apparirebbe VUOTA e l'operatore crederebbe
    // che il bambino non abbia classe: un invito a riassegnarla a caso.
    expect(opzioni()).toContain('CLASSE STORICA')
    expect(tendinaClasse().value).toBe('CLASSE STORICA')
  })
})
