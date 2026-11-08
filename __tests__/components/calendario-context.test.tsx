import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

/** PR 4.1 · COMPITO 4.1.4 · il contesto del calendario: predefinito sempre, calendario della sede dopo l'arrivo. */

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({ logClient }))

import { CalendarioProvider, useAnnoDi, useCalendario, useCalendarioDi } from '@/lib/context/calendario-context'

const riga = (id: string, inizio: string, fine: string, annoInizio: number) => ({
  annoId: `a${annoInizio}`,
  annoSedeId: id,
  annoInizio,
  inizio,
  fine,
  ultimoGiornoAperto: fine,
  preparaSuccessivoDal: inizio,
  stato: 'corrente',
  domandeAperte: false,
})
const CAL_S1 = [riga('r25', '2025-09-01', '2026-09-14', 2025), riga('r26', '2026-09-15', '2027-08-31', 2026)]

const risposta = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data, fonte: 'database' }), { status }))

function Sonda({ sede = 's1' }: { sede?: string | null }) {
  const { loading, errore, ricarica } = useCalendario()
  const annoDi = useAnnoDi(sede)
  const a = annoDi('2026-09-10')
  return (
    <div>
      <span data-testid="stato">{`loading:${loading}`}</span>
      <span data-testid="errore">{`errore:${errore}`}</span>
      <span data-testid="anno">{`${a.annoInizio}/${a.fonte}`}</span>
      <button onClick={ricarica}>ricarica</button>
    </div>
  )
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  logClient.mockClear()
  fetchMock = vi.fn(() => risposta([{ scuola_id: 's1', righe: CAL_S1 }]))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('CalendarioProvider / useAnnoDi', () => {
  it('senza provider risponde col predefinito e non lancia', () => {
    function Fuori() {
      return <span data-testid="fuori">{useAnnoDi()('2026-08-15').annoInizio}</span>
    }
    render(<Fuori />)
    expect(screen.getByTestId('fuori').textContent).toBe('2025')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prima dell\'arrivo vale il predefinito, dopo il calendario della sede', async () => {
    render(
      <CalendarioProvider>
        <Sonda />
      </CalendarioProvider>,
    )
    expect(screen.getByTestId('anno').textContent).toBe('2026/predefinito')
    await screen.findByText('loading:false')
    expect(screen.getByTestId('anno').textContent).toBe('2025/sede')
  })

  it('una sede che il calendario non contiene resta sul predefinito', async () => {
    render(
      <CalendarioProvider>
        <Sonda sede="s9" />
      </CalendarioProvider>,
    )
    await screen.findByText('loading:false')
    expect(screen.getByTestId('anno').textContent).toBe('2026/predefinito')
  })

  it('fetch rifiutata: errore vero, predefinito, un solo warn', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    render(
      <CalendarioProvider>
        <Sonda />
      </CalendarioProvider>,
    )
    await screen.findByText('errore:true')
    expect(screen.getByTestId('stato').textContent).toBe('loading:false')
    expect(screen.getByTestId('anno').textContent).toBe('2026/predefinito')
    expect(logClient).toHaveBeenCalledTimes(1)
    expect(logClient.mock.calls[0][0].livello).toBe('warn')
  })

  it('risposta 500: errore vero e predefinito', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })))
    render(
      <CalendarioProvider>
        <Sonda />
      </CalendarioProvider>,
    )
    await screen.findByText('errore:true')
    expect(screen.getByTestId('anno').textContent).toBe('2026/predefinito')
    expect(logClient.mock.calls[0][0].stato).toBe(500)
  })

  it('una fetch per montaggio, una in più con ricarica()', async () => {
    render(
      <CalendarioProvider>
        <Sonda />
      </CalendarioProvider>,
    )
    await screen.findByText('loading:false')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    act(() => screen.getByText('ricarica').click())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await screen.findByText('loading:false')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('con userId la fetch porta x-user-id; senza, nessuna intestazione', async () => {
    const { unmount } = render(
      <CalendarioProvider userId="U1">
        <Sonda />
      </CalendarioProvider>,
    )
    await screen.findByText('loading:false')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-user-id': 'U1' })
    unmount()
    fetchMock.mockClear()
    render(
      <CalendarioProvider>
        <Sonda />
      </CalendarioProvider>,
    )
    await screen.findByText('loading:false')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeUndefined()
  })

  it('la funzione di useAnnoDi è la stessa fra due render senza cambi di calendario', async () => {
    const viste: Array<(g: string) => unknown> = []
    function Raccogli() {
      const f = useAnnoDi('s1')
      const { loading } = useCalendario()
      viste.push(f)
      return <span>{`pronto:${!loading}`}</span>
    }
    const { rerender } = render(
      <CalendarioProvider>
        <Raccogli />
      </CalendarioProvider>,
    )
    await screen.findByText('pronto:true')
    const dopo = viste[viste.length - 1]
    rerender(
      <CalendarioProvider>
        <Raccogli />
      </CalendarioProvider>,
    )
    expect(viste[viste.length - 1]).toBe(dopo)
    expect(viste[0]).not.toBe(dopo)
  })
})

describe('ricarica(): le referenze stabili per le sedi che non sono cambiate', () => {
  const CAL_S2 = [riga('q26', '2026-09-01', '2027-08-31', 2026)]
  const rispostaDue = (s1: unknown[]) => () =>
    risposta([
      { scuola_id: 's1', righe: s1 },
      { scuola_id: 's2', righe: CAL_S2 },
    ])

  function Raccogli({ viste }: { viste: Record<string, unknown[]> }) {
    const { loading, ricarica } = useCalendario()
    viste.a1.push(useAnnoDi('s1'))
    viste.a2.push(useAnnoDi('s2'))
    viste.c1.push(useCalendarioDi('s1'))
    viste.c2.push(useCalendarioDi('s2'))
    return (
      <div>
        <span>{`pronto:${!loading}`}</span>
        <button onClick={ricarica}>ricarica</button>
      </div>
    )
  }
  const ultimo = (v: unknown[]) => v[v.length - 1]

  it('stessa risposta: useAnnoDi e useCalendarioDi restituiscono la STESSA referenza (toBe)', async () => {
    fetchMock.mockImplementation(rispostaDue(CAL_S1))
    const viste: Record<string, unknown[]> = { a1: [], a2: [], c1: [], c2: [] }
    render(
      <CalendarioProvider>
        <Raccogli viste={viste} />
      </CalendarioProvider>,
    )
    await screen.findByText('pronto:true')
    const prima = { a1: ultimo(viste.a1), a2: ultimo(viste.a2), c1: ultimo(viste.c1), c2: ultimo(viste.c2) }
    act(() => screen.getByText('ricarica').click())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await screen.findByText('pronto:true')
    expect(ultimo(viste.a1)).toBe(prima.a1)
    expect(ultimo(viste.a2)).toBe(prima.a2)
    expect(ultimo(viste.c1)).toBe(prima.c1)
    expect(ultimo(viste.c2)).toBe(prima.c2)
  })

  it('una riga cambiata in s1: s1 nuova, s2 la stessa', async () => {
    fetchMock.mockImplementation(rispostaDue(CAL_S1))
    const viste: Record<string, unknown[]> = { a1: [], a2: [], c1: [], c2: [] }
    render(
      <CalendarioProvider>
        <Raccogli viste={viste} />
      </CalendarioProvider>,
    )
    await screen.findByText('pronto:true')
    const prima = { a1: ultimo(viste.a1), a2: ultimo(viste.a2), c1: ultimo(viste.c1), c2: ultimo(viste.c2) }
    const cambiato = [CAL_S1[0], { ...CAL_S1[1], fine: '2027-09-10' }]
    fetchMock.mockImplementation(rispostaDue(cambiato))
    act(() => screen.getByText('ricarica').click())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(ultimo(viste.c1)).not.toBe(prima.c1))
    await screen.findByText('pronto:true')
    expect(ultimo(viste.a1)).not.toBe(prima.a1)
    expect(ultimo(viste.a2)).toBe(prima.a2)
    expect(ultimo(viste.c2)).toBe(prima.c2)
  })
})
