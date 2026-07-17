import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDiaryDay } from '@/components/features/teacher/diary/DiaryEventEditor'

// E1 — Il hook useDiaryDay costruisce il payload del diario 0-6 con:
//  · nota_libera  → nota di SEZIONE, identica per ogni bambino (broadcast)
//  · nota_bambino → nota per SINGOLO bambino, solo per quel bambino
// Così un genitore non legge mai la nota riservata a un altro bambino.

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown): JsonRes => ({ ok: true, status: 200, json: async () => data })

let postBody: Array<Record<string, unknown>> | null = null

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes({ routine_attive: [] })
  if (u.includes('/api/diary/students')) {
    return jsonRes([
      { id: 'a1', nome: 'Bruna', cognome: 'Bianchi', note_mediche: null },
      { id: 'b2', nome: 'Bruno', cognome: 'Verdi', note_mediche: null },
    ])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') {
    postBody = JSON.parse(init.body ?? '[]')
    return jsonRes([])
  }
  if (u.includes('/api/diary/entries')) return jsonRes([]) // restore GET: nessun evento salvato
  return jsonRes(null)
})

beforeEach(() => {
  postBody = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('useDiaryDay — nota per-bambino', () => {
  it('handleSave: nota di sezione a tutti, nota per-bambino solo a quel bambino', async () => {
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))

    await waitFor(() => expect(result.current.students).toHaveLength(2))

    await act(async () => { await result.current.handleEventSelect('pranzo') })

    act(() => {
      result.current.setNotaLibera('comunicazione per tutti')
      result.current.updateNotaBambino('a1', 'Bruna oggi era un po\' stanca')
    })

    await act(async () => { await result.current.handleSave() })

    expect(postBody).not.toBeNull()
    expect(postBody).toHaveLength(2)
    const a = postBody!.find(e => e.alunno_id === 'a1')!
    const b = postBody!.find(e => e.alunno_id === 'b2')!

    // Nota di sezione: identica per entrambi.
    expect(a.nota_libera).toBe('comunicazione per tutti')
    expect(b.nota_libera).toBe('comunicazione per tutti')

    // Nota per-bambino: solo per Bruna; su Bruno resta null (non trapela).
    expect(a.nota_bambino).toBe('Bruna oggi era un po\' stanca')
    expect(b.nota_bambino).toBeNull()
  })

  it('updateNotaBambino aggiorna solo la riga indicata', async () => {
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    await act(async () => { await result.current.handleEventSelect('pranzo') })

    act(() => {
      result.current.updateNotaBambino('a1', 'nota A')
      result.current.updateNotaBambino('b2', 'nota B')
    })
    expect(result.current.notaBambino.a1).toBe('nota A')
    expect(result.current.notaBambino.b2).toBe('nota B')

    act(() => { result.current.updateNotaBambino('a1', 'nota A modificata') })
    expect(result.current.notaBambino.a1).toBe('nota A modificata')
    expect(result.current.notaBambino.b2).toBe('nota B') // invariata
  })
})
