import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// m3 (feed unificato avvisi): useParentIdentity deve esporre l'elenco COMPLETO dei
// figli (figliIds), non solo il primo — SENZA rompere `studentId` singolo (che gli
// altri consumatori usano ancora). Guard di regressione per il collasso su figliIds[0].

const mockReplace = vi.fn()
const mockRouter = { replace: mockReplace, refresh: vi.fn() }
let mockSearch = new URLSearchParams()
let mockPathname = '/parent/avvisi'

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => mockPathname,
}))

import { useParentIdentity } from '@/lib/auth/use-parent-identity'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockSearch = new URLSearchParams()
  mockPathname = '/parent/avvisi'
  vi.stubGlobal('fetch', fetchMock)
})

function studentsOk(ids: string[]) {
  return { ok: true, json: async () => ({ success: true, data: ids.map((id) => ({ id })) }) }
}

describe('useParentIdentity — elenco figli (m3)', () => {
  it('espone figliIds con TUTTI i figli, studentId resta il primo', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(studentsOk(['A', 'B']))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.figliIds).toEqual(['A', 'B'])
    expect(result.current.studentId).toBe('A')
  })

  it('lista non determinabile (rete giù) → figliIds vuoto, degrada al noto', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    window.localStorage.setItem('kv_student_id', 'noto')
    fetchMock.mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.figliIds).toEqual([])
    expect(result.current.studentId).toBe('noto')
  })

  it('una sola fetch a /api/parent/students per mount (nessun doppio giro)', async () => {
    window.localStorage.setItem('kv_user_id', 'P1')
    fetchMock.mockResolvedValue(studentsOk(['A', 'B']))

    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))

    const chiamate = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/api/parent/students'),
    )
    expect(chiamate).toHaveLength(1)
  })
})
