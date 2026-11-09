import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 4.5.7-bis · il tetto di attesa sull'elenco degli anni del modulo pubblico.
 *
 * Con il link `?scuola=` la forma dei passi aspetta questo elenco: una `fetch` che non risponde mai (misurato: 150 s)
 * non deve tenere ferma la famiglia sul primo passo. Allo scadere del tetto l'esito è lo stesso di un 500: nessuna
 * scelta, log `warn` con un messaggio SUO, e il modulo procede. Una risposta arrivata dopo non conta.
 * Uuid e dati finti. Timer finti: il tetto è un `setTimeout`, così il tempo si governa dalla prova.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import {
  useAnniPubblici,
  ATTESA_MAX_ANNI_PUBBLICI_MS,
} from '@/components/features/public/wizard/use-anni-pubblici'

const SEDE = SEDE_A
const A1 = { anno_id: 'a2222222-2222-4222-8222-222222222222', etichetta_breve: '2026/27', ingresso: 'durante' as const }
const A2 = { anno_id: 'a3333333-3333-4333-8333-333333333333', etichetta_breve: '2027/28', ingresso: 'inizio' as const }

function rispostaOk(anni: unknown[], scelta: boolean) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { anni, scelta, chiuso: false } }) }
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useAnniPubblici · il tetto di attesa', () => {
  it('una fetch che non risponde mai: prima del tetto resta in caricamento, allo scadere procede senza scelta e logga', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useAnniPubblici({ sedeId: SEDE }))

    let esitoAttendi: { scelta: boolean; chiuso: boolean } | null = null
    void result.current.attendi().then((e) => { esitoAttendi = e })

    await act(async () => { await vi.advanceTimersByTimeAsync(ATTESA_MAX_ANNI_PUBBLICI_MS - 1) })
    expect(result.current.inCaricamento).toBe(true)
    expect(esitoAttendi).toBeNull()
    expect(h.logClient).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.current.inCaricamento).toBe(false)
    expect(result.current.scelta).toBe(false)
    expect(result.current.chiuso).toBe(false)
    expect(result.current.anni).toEqual([])
    expect(esitoAttendi).toEqual({ scelta: false, chiuso: false })
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', messaggio: 'iscrizione-anni-tetto-scaduto' }),
    )
  })

  it('la scadenza si distingue nel log dalla rete giù (messaggi diversi)', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const rete = renderHook(() => useAnniPubblici({ sedeId: SEDE }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(rete.result.current.inCaricamento).toBe(false)
    const messaggioRete = String(h.logClient.mock.calls[0][0].messaggio)
    expect(messaggioRete).toMatch(/^iscrizione-anni-non-caricati/)
    expect(messaggioRete).not.toContain('tetto-scaduto')
  })

  it('una risposta arrivata DOPO la scadenza non conta: la forma dei passi non cambia sotto le mani della famiglia', async () => {
    let rispondi: (v: unknown) => void = () => {}
    fetchMock.mockImplementation(() => new Promise((ok) => { rispondi = ok }))
    const { result } = renderHook(() => useAnniPubblici({ sedeId: SEDE }))

    await act(async () => { await vi.advanceTimersByTimeAsync(ATTESA_MAX_ANNI_PUBBLICI_MS) })
    expect(result.current.inCaricamento).toBe(false)

    await act(async () => { rispondi(rispostaOk([A1, A2], true)); await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.scelta).toBe(false)
    expect(result.current.anni).toEqual([])
  })

  it('una risposta in tempo vince sul tetto: nessun log di scadenza, nemmeno dopo', async () => {
    fetchMock.mockResolvedValue(rispostaOk([A1, A2], true))
    const { result } = renderHook(() => useAnniPubblici({ sedeId: SEDE }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.scelta).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(ATTESA_MAX_ANNI_PUBBLICI_MS * 2) })
    expect(result.current.scelta).toBe(true)
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('un effetto annullato (cambio di sede) non conta: la risposta della sede vecchia non vale', async () => {
    let rispondi: (v: unknown) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((ok) => { rispondi = ok }))
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { result, rerender } = renderHook(({ sede }) => useAnniPubblici({ sedeId: sede }), {
      initialProps: { sede: SEDE },
    })
    rerender({ sede: SEDE_B })
    await act(async () => { rispondi(rispostaOk([A1, A2], true)); await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.inCaricamento).toBe(true)
    expect(result.current.scelta).toBe(false)
  })

  it('RICARICA che fallisce o scade: l\'elenco vecchio resta, e `letture` dice che la lettura è finita', async () => {
    fetchMock.mockResolvedValueOnce(rispostaOk([A1, A2], true))
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    const { result } = renderHook(() => useAnniPubblici({ sedeId: SEDE }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.scelta).toBe(true)
    const prima = result.current.letture

    act(() => { result.current.ricarica() })
    await act(async () => { await vi.advanceTimersByTimeAsync(ATTESA_MAX_ANNI_PUBBLICI_MS) })

    expect(result.current.letture).toBe(prima + 1)
    expect(result.current.scelta).toBe(true)
    expect(result.current.anni).toEqual([A1, A2])
    expect(result.current.inCaricamento).toBe(false)
  })

  it('RICARICA che riesce: l\'elenco nuovo prende il posto del vecchio', async () => {
    fetchMock.mockResolvedValueOnce(rispostaOk([A1, A2], true))
    fetchMock.mockResolvedValueOnce(rispostaOk([A2], false))
    const { result } = renderHook(() => useAnniPubblici({ sedeId: SEDE }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => { result.current.ricarica() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.anni).toEqual([A2])
    expect(result.current.scelta).toBe(false)
  })
})
