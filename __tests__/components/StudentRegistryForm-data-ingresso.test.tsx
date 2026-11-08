import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'

/**
 * PR 4.1 · 4.1.P — la data d'ingresso nel modulo anagrafica: parte dal giorno di ROMA (non dal giorno UTC),
 * dice in quale anno scolastico cade e, se la sede ha un calendario che non la contiene, blocca il salvataggio.
 *
 * Solo `Date` è finto (i timer restano veri per i `waitFor`). La sede del modulo è l'unica del contesto:
 * il modulo non invia `scuola_id`, la risolve il server (`resolveScuolaScrittura`).
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

import { StudentRegistryForm } from '@/components/features/admin/StudentRegistryForm'
import { CalendarioProvider } from '@/lib/context/calendario-context'

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

const COMUNI_NA = [{ belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true }]
const FUORI = 'La data non cade in nessun anno scolastico della sede'

let calendario: unknown[] = []
const corpiInviati: unknown[] = []

beforeEach(() => {
  calendario = []
  corpiInviati.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url), 'http://t.test')
      if (u.pathname === '/api/anno/calendario') {
        return new Response(JSON.stringify({ success: true, data: calendario, fonte: 'database' }), { status: 200 })
      }
      if (u.pathname === '/api/anagrafiche/comuni') {
        return { ok: true, json: async () => ({ comuni: COMUNI_NA }) }
      }
      if (u.pathname === '/api/admin/students') {
        corpiInviati.push(JSON.parse(String(init?.body ?? '{}')))
        return { ok: true, status: 200, json: async () => ({ id: 'nuovo' }) }
      }
      return { ok: true, json: async () => [] }
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function monta() {
  render(
    <CalendarioProvider>
      <StudentRegistryForm />
    </CalendarioProvider>,
  )
}

const campo = (nome: string) => document.querySelector(`input[name="${nome}"]`) as HTMLInputElement
const scrivi = (nome: string, valore: string) =>
  fireEvent.change(campo(nome), { target: { name: nome, value: valore } })

function apriTendina(elemento: HTMLElement) {
  const contenitore = elemento.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: new RegExp('^' + itShared.anagCommutaElenco) }))
}

/** Passo 1: l'anagrafica e il luogo di nascita dalla tendina (la data d'ingresso la decide il test). */
async function compilaPassoUno() {
  scrivi('nome', 'Ada')
  scrivi('cognome', 'Verdi')
  scrivi('data_nascita', '2022-01-01')
  apriTendina(screen.getByRole('combobox', { name: itShared.anagProvinciaEtichetta }))
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta })).toBeEnabled())
  apriTendina(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta }))
  fireEvent.click(screen.getByRole('option', { name: 'NAPOLI' }))
}

/** La residenza (passo 2), poi si arriva all'ultimo passo, dove sta «Salva Anagrafica». */
function compilaResidenzaEVaiInFondo() {
  fireEvent.click(screen.getByText('Residenza'))
  scrivi('indirizzo_residenza', 'Via delle Prove 10')
  scrivi('comune_residenza', 'Napoli')
  scrivi('cap', '80100')
  fireEvent.click(screen.getByText('Amministrazione'))
}

describe('StudentRegistryForm — data d\'ingresso e anno scolastico', () => {
  it('a cavallo del 1° novembre (23:30 UTC = 00:30 a Roma) parte dal 2026-11-01 e dice 2026/27', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T23:30:00Z') })
    monta()
    expect(campo('data_iscrizione').value).toBe('2026-11-01')
    expect(screen.getByText('Anno scolastico 2026/27')).toBeInTheDocument()
  })

  it('cambiando la data la riga cambia anno', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T23:30:00Z') })
    monta()
    scrivi('data_iscrizione', '2026-08-20')
    expect(screen.getByText('Anno scolastico 2025/26')).toBeInTheDocument()
  })

  it('con un calendario che non contiene la data: messaggio d\'errore e il salvataggio non parte', async () => {
    calendario = [
      {
        scuola_id: 's1',
        righe: [riga(2025, '2025-09-01', '2026-08-31'), riga(2026, '2026-09-01', '2027-08-31')],
      },
    ]
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T23:30:00Z') })
    monta()
    await compilaPassoUno()
    scrivi('data_iscrizione', '2028-01-10')
    // Il messaggio compare solo dopo l'arrivo del calendario: aspetto la sua PRESENZA.
    expect(await screen.findByText(FUORI)).toBeInTheDocument()
    expect(screen.queryByText(/^Anno scolastico /)).toBeNull()

    compilaResidenzaEVaiInFondo()
    fireEvent.click(screen.getByText('Salva Anagrafica'))
    await screen.findByText('Correggi gli errori evidenziati nel form.')
    expect(corpiInviati).toHaveLength(0)

    // Controllo: con una data dentro il calendario lo stesso modulo salva.
    fireEvent.click(screen.getByText('Dati Personali'))
    scrivi('data_iscrizione', '2026-10-01')
    await waitFor(() => expect(screen.getByText('Anno scolastico 2026/27')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Amministrazione'))
    fireEvent.click(screen.getByText('Salva Anagrafica'))
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
  })

  it('senza calendario (risposta vuota) non blocca niente, nemmeno per una data lontana', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T23:30:00Z') })
    monta()
    await compilaPassoUno()
    scrivi('data_iscrizione', '2028-01-10')
    expect(screen.getByText('Anno scolastico 2027/28')).toBeInTheDocument()
    compilaResidenzaEVaiInFondo()
    fireEvent.click(screen.getByText('Salva Anagrafica'))
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
  })
})
