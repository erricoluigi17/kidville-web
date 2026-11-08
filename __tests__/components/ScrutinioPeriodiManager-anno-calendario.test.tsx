import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { ScrutinioPeriodiManager } from '@/components/features/admin/primaria/ScrutinioPeriodiManager'
import { CalendarioProvider, useCalendario } from '@/lib/context/calendario-context'

/**
 * PR 4.1 · COMPITO 4.1.S4b · l'anno proposto per i periodi di scrutinio viene dal calendario della sede.
 *
 * PRIMA: `annoCorrente()` — `getMonth() >= 8` nell'ora del BROWSER, soglia fissa al 1° settembre, uguale per
 * tutte le sedi. DOPO: `useAnnoDi(scuolaId)(oggi).etichetta`, con lo stato derivato (`scelto ?? proposto`):
 * il calendario non viene copiato nello stato da un effetto, e un valore scritto a mano non si sovrascrive.
 */

const SEDE = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const riga = (annoInizio: number, inizio: string, fine: string) => ({
  annoId: `a${annoInizio}`,
  annoSedeId: `s${annoInizio}`,
  annoInizio,
  inizio,
  fine,
  ultimoGiornoAperto: fine,
  preparaSuccessivoDal: inizio,
  stato: 'corrente',
  domandeAperte: false,
})
// Questa sede comincia il 2026/27 il 15 settembre: il 10 settembre è ancora il 2025/26.
const CAL = [riga(2025, '2025-09-01', '2026-09-14'), riga(2026, '2026-09-15', '2027-08-31')]

let rilascia: (() => void) | null = null
let urlLetti: string[] = []

function installaFetch(trattieniCalendario: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      urlLetti.push(u)
      if (u.startsWith('/api/anno/calendario')) {
        if (trattieniCalendario) await new Promise<void>((ok) => { rilascia = ok })
        return new Response(JSON.stringify({ success: true, data: [{ scuola_id: SEDE, righe: CAL }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
    }),
  )
}

function Sonda() {
  const { loading } = useCalendario()
  return <span data-testid="cal">{`loading:${loading}`}</span>
}

const montaggio = () =>
  render(
    <CalendarioProvider>
      <Sonda />
      <ScrutinioPeriodiManager scuolaId={SEDE} userId="u-1" />
    </CalendarioProvider>,
  )

describe('ScrutinioPeriodiManager — l’anno viene dal calendario della sede', () => {
  beforeEach(() => {
    urlLetti = []
    rilascia = null
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-09-10T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('con il calendario arrivato la casella propone l’etichetta del calendario (2025/2026, non 2026/2027)', async () => {
    installaFetch(false)
    montaggio()
    // Si aspetta la PRESENZA del valore del calendario.
    await waitFor(() => expect(screen.getByDisplayValue('2025/2026')).toBeInTheDocument())
    // E la lettura dei periodi parte con quell'anno (la GET dichiara sede E anno).
    await waitFor(() => expect(urlLetti.some((u) => u.includes('annoScolastico=2025/2026'))).toBe(true))
  })

  it('senza calendario (prima della risposta) vale il predefinito: il 10 settembre è già 2026/2027', async () => {
    installaFetch(true)
    montaggio()
    expect(screen.getByDisplayValue('2026/2027')).toBeInTheDocument()
    await act(async () => { rilascia?.() })
    await waitFor(() => expect(screen.getByTestId('cal').textContent).toBe('loading:false'))
  })

  it('un valore scritto a mano prima dell’arrivo del calendario non viene sovrascritto', async () => {
    installaFetch(true)
    montaggio()
    const casella = screen.getByDisplayValue('2026/2027')
    fireEvent.change(casella, { target: { value: '2030/2031' } })
    expect(screen.getByDisplayValue('2030/2031')).toBeInTheDocument()

    // Il calendario arriva: si aspetta la PRESENZA del suo arrivo, poi si guarda la casella.
    await act(async () => { rilascia?.() })
    await waitFor(() => expect(screen.getByTestId('cal').textContent).toBe('loading:false'))
    expect(screen.getByDisplayValue('2030/2031')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('2025/2026')).toBeNull()
  })
})
