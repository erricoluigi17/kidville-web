import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A } from '../fixtures/sedi'

/**
 * La scheda di un bambino «IN ARRIVO» (4.5.15, C2).
 *
 * Non frequenta ancora: lo stato si legge «In arrivo» e non si cambia da qui, la classe non esiste (la tendina è spenta, con la
 * ragione scritta). Chi frequenta, accanto, resta com'era: il controllo positivo che le tendine non si spengono per tutti.
 * I nomi sono finti: il repository è PUBBLICO.
 */

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({ StudentEconomicSection: () => null }))

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sections') {
      return Promise.resolve({ ok: true, json: async () => [{ id: 'sez-a1', name: 'GIRASOLI', school_type: 'infanzia', scuola_id: SEDE_A }] })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'

const IN_ARRIVO = { id: 'al-arr', nome: 'Piccolo', cognome: 'InArrivoProva', scuola_id: SEDE_A, stato: 'in_arrivo', classe_sezione: null }
const ISCRITTO = { id: 'al-isc', nome: 'Grande', cognome: 'IscrittoProva', scuola_id: SEDE_A, stato: 'iscritto', classe_sezione: 'GIRASOLI' }

const monta = (student: Record<string, unknown>) =>
  render(
    <StudentDetailPanel
      student={student}
      onClose={() => {}}
      onSave={() => {}}
      onArchive={async () => ({ ok: true })}
      onRiattiva={async () => ({ ok: true })}
    />,
  )
const tendinaClasse = () => document.querySelector('select[name="classe_sezione"]') as HTMLSelectElement
const tendinaStato = () => document.getElementById('dettaglio-stato') as HTMLSelectElement & HTMLInputElement

describe('StudentDetailPanel — un bambino in arrivo', () => {
  it('lo stato si legge «In arrivo» e non si cambia; la classe è spenta con la ragione scritta', async () => {
    monta(IN_ARRIVO)
    await waitFor(() => expect(tendinaClasse()).toBeTruthy())
    // Lo stato è in sola lettura e dice «In arrivo»: non è una tendina, quindi non offre di diventare altro.
    expect(tendinaStato().tagName).toBe('INPUT')
    expect(tendinaStato().readOnly).toBe(true)
    expect(tendinaStato().value).toBe(itAdmin.statoInArrivo)
    expect(tendinaClasse().disabled).toBe(true)
    expect(screen.getByText(itAdmin.detailClasseInArrivo)).toBeInTheDocument()
    expect(screen.getByText(itAdmin.detailStatoInArrivo)).toBeInTheDocument()
    expect(tendinaClasse().getAttribute('aria-describedby')).toBe('dettaglio-classe-in-arrivo')
  })

  it('CONTROLLO POSITIVO — chi frequenta ha le tendine accese, senza la voce «In arrivo» e senza spiegazioni', async () => {
    monta(ISCRITTO)
    await waitFor(() => expect(Array.from(tendinaClasse().options).map((o) => o.textContent)).toContain('GIRASOLI (infanzia)'))
    expect(tendinaStato().tagName).toBe('SELECT')
    expect(tendinaStato().disabled).toBe(false)
    expect(tendinaClasse().disabled).toBe(false)
    expect(Array.from(tendinaStato().options).map((o) => o.value)).not.toContain('in_arrivo')
    expect(screen.queryByText(itAdmin.detailClasseInArrivo)).toBeNull()
  })
})
