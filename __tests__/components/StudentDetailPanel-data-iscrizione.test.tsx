import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

/**
 * PR 4.3 · 4.3.5 (consegna 8 della 4.1) — la data di iscrizione nella scheda anagrafica che la segreteria usa davvero
 * (`StudentDetailPanel`): dice in quale anno scolastico cade e, se la sede ha un calendario che non la contiene, blocca il
 * salvataggio. Era già nel modulo `StudentRegistryForm`, che nessuna pagina montava (tolto in questo compito).
 *
 * Si blocca solo una data CAMBIATA in questa sessione: una scheda con una data vecchia, non toccata, resta salvabile.
 * La sede della scheda è `s1`, quella del calendario finto. Solo uuid/id finti.
 */

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({ StudentEconomicSection: () => null }))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'
import { CalendarioProvider } from '@/lib/context/calendario-context'
import itAdmin from '../../messages/it/adminStudents.json'

const riga = (annoInizio: number, inizio: string, fine: string) => ({
  annoId: `a${annoInizio}`,
  annoSedeId: `r${annoInizio}`,
  annoInizio,
  inizio,
  fine,
  ultimoGiornoAperto: fine,
  preparaSuccessivoDal: inizio,
  stato: 'corrente',
  domandeAperte: false,
})

const FUORI = itAdmin.dataIscrizioneFuoriAnno // «dopo la fine dell'anno in corso»
let calendario: unknown[] = []
const patchInviate: unknown[] = []
const onSave = vi.fn((d: unknown) => { patchInviate.push(d) })

beforeEach(() => {
  calendario = []
  patchInviate.length = 0
  onSave.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), 'http://t.test')
      if (u.pathname === '/api/anno/calendario') {
        return new Response(JSON.stringify({ success: true, data: calendario, fonte: 'database' }), { status: 200 })
      }
      if (u.pathname === '/api/admin/students' && init?.method === 'PATCH') {
        patchInviate.push(JSON.parse(String(init.body ?? '{}')))
        return { ok: true, status: 200, json: async () => ({ success: true }) }
      }
      return { ok: true, json: async () => [] }
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ALUNNO = {
  id: 'al-1',
  nome: 'Aurora',
  cognome: 'Verdi',
  scuola_id: 's1',
  classe_sezione: null,
  stato: 'iscritto',
  data_iscrizione: '2020-01-10' as string | null,
}

function monta(alunno = ALUNNO) {
  render(
    <CalendarioProvider>
      <StudentDetailPanel
        student={alunno}
        onClose={() => {}}
        onSave={onSave}
        onArchive={async () => ({ ok: true })}
        onRiattiva={async () => ({ ok: true })}
      />
    </CalendarioProvider>,
  )
}

const campo = () => document.getElementById('dettaglio-data-iscrizione') as HTMLInputElement
const scrivi = (valore: string) => fireEvent.change(campo(), { target: { value: valore } })
const salva = () => screen.getByRole('button', { name: new RegExp(itAdmin.salvaModifiche) })

const CALENDARIO_DUE_ANNI = () => [
  { scuola_id: 's1', righe: [riga(2025, '2025-09-01', '2026-08-31'), riga(2026, '2026-09-01', '2027-08-31')] },
]

describe('StudentDetailPanel — data di iscrizione e anno scolastico', () => {
  it('cambiando la data la riga dice l’anno scolastico in cui cade', async () => {
    calendario = CALENDARIO_DUE_ANNI()
    monta()
    scrivi('2026-10-01')
    expect(await screen.findByText('Anno scolastico 2026/27')).toBeInTheDocument()
  })

  it('data PRIMA dell’inizio dell’anno attivo: accettata, la riga dice l’anno attivo e il giorno d’ingresso preso dal calendario', async () => {
    calendario = CALENDARIO_DUE_ANNI()
    monta()
    scrivi('2026-08-20')
    expect(await screen.findByText('Anno scolastico 2026/27 · ingresso dal 01/09/2026')).toBeInTheDocument()
    expect(screen.queryByText(FUORI)).toBeNull()
    expect(salva()).toBeEnabled()
    fireEvent.click(salva())
    await waitFor(() => expect(patchInviate).toHaveLength(1))
  })

  it('data DOPO la fine dell’anno attivo: messaggio chiaro e il salvataggio è spento', async () => {
    calendario = CALENDARIO_DUE_ANNI()
    monta()
    // Il messaggio compare solo dopo l'arrivo del calendario: si aspetta la sua PRESENZA.
    await waitFor(() => {
      scrivi('2028-01-10')
      expect(screen.getByText(FUORI)).toBeInTheDocument()
    })
    expect(screen.queryByText(/^Anno scolastico /)).toBeNull()
    expect(salva()).toBeDisabled()
    fireEvent.click(salva())
    expect(patchInviate).toHaveLength(0)

    // Controllo: con una data dentro il calendario lo stesso pannello salva.
    scrivi('2026-10-01')
    expect(await screen.findByText('Anno scolastico 2026/27')).toBeInTheDocument()
    expect(salva()).toBeEnabled()
    fireEvent.click(salva())
    await waitFor(() => expect(patchInviate).toHaveLength(1))
  })

  it('una data vecchia NON toccata non blocca: la scheda resta salvabile', async () => {
    calendario = CALENDARIO_DUE_ANNI()
    monta() // data_iscrizione 2020-01-10: prima di ogni anno del calendario
    // aspetto il calendario guardando una data cambiata e rimessa com'era
    scrivi('2026-10-01')
    await screen.findByText('Anno scolastico 2026/27')
    scrivi('2020-01-10')
    await waitFor(() => expect(screen.queryByText(/^Anno scolastico /)).not.toBeNull())
    expect(screen.queryByText(FUORI)).toBeNull()
    expect(salva()).toBeEnabled()
  })

  it('senza calendario (risposta vuota) non blocca niente, nemmeno per una data lontana', async () => {
    monta()
    scrivi('2028-01-10')
    expect(await screen.findByText('Anno scolastico 2027/28')).toBeInTheDocument()
    expect(screen.queryByText(FUORI)).toBeNull()
    expect(salva()).toBeEnabled()
  })
})
