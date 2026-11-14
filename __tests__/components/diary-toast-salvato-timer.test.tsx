import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

import { useDiaryDay } from '@/components/features/teacher/diary/DiaryEventEditor'
import { invalidaDiarioConfigCache } from '@/lib/diary/config-cache'

// IL TOAST «SALVATO» NON LASCIA UN TIMER APPESO (collaudo CI, PR 314).
//
// `setTimeout(() => setShowSavedToast(false), 2500)` non veniva mai annullato: se il componente
// si smontava prima, il timer scattava dopo e chiamava `setState` su un componente morto (in CI,
// a ambiente di test già chiuso: `ReferenceError: window is not defined`). E due salvataggi di
// fila facevano chiudere il secondo toast in anticipo, col timer del primo.

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: unknown) => String(e) }))
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }))

const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data })
const CREMA = { id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true }
const BAMBINI = [{ id: 'a1', nome: 'Ada', cognome: 'Bianchi', note_mediche: null }]

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes({ routine_attive: null, routine_personalizzate: [CREMA] })
  if (u.includes('/api/diary/students')) return jsonRes(BAMBINI)
  if (u.includes('/api/diary/entries') && init?.method === 'POST') return jsonRes(JSON.parse(init.body ?? '[]').map((v: { alunno_id: string }) => ({ alunno_id: v.alunno_id })))
  if (u.includes('/api/diary/entries')) return jsonRes([])
  return jsonRes(null)
})

beforeEach(() => { invalidaDiarioConfigCache(); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function salvaUnaVolta(result: { current: ReturnType<typeof useDiaryDay> }) {
  await act(async () => { await result.current.handleEventSelect('routine:a1b2c3d4') })
  act(() => { result.current.updateStudent('a1', { valore: true }) })
  await act(async () => { await result.current.handleSave() })
}

describe('il timer del toast «salvato»', () => {
  it('🔴 allo smontaggio non resta pendente', async () => {
    const { result, unmount } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(1))
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await salvaUnaVolta(result)
    expect(result.current.showSavedToast).toBe(true)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('🔴 due salvataggi di fila: parte un solo timer, quello del secondo', async () => {
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(1))
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await salvaUnaVolta(result)
    act(() => { result.current.updateStudent('a1', { valore: false }) })
    act(() => { result.current.updateStudent('a1', { valore: true }) })
    await act(async () => { await result.current.handleSave() })
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(result.current.showSavedToast).toBe(false)
  })
})
