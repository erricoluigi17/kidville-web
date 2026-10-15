import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDiaryDay } from '@/components/features/teacher/diary/DiaryEventEditor'

const h = vi.hoisted(() => ({ polling: null as null | (() => Promise<unknown>) }))
vi.mock('@/lib/hooks/use-polling-visibile', () => ({ usePollingVisibile: (callback: () => Promise<unknown>) => { h.polling = callback } }))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'ErroreFittizio' }))
const risposta = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const voce = (versione: number) => ({ id: 'evento', alunno_id: 'a1', tipo_evento: 'nanna_inizio', orario_inizio: '2020-01-01T12:00:00Z', dettagli: { orario_inizio: '13:00' }, storico_versione: versione })
let versioneLetta = 0
let versioneSalvata = 1
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return risposta({ routine_attive: null })
  if (u.includes('/api/diary/students')) return risposta([{ id: 'a1', nome: 'Nome fittizio', cognome: 'Cognome fittizio' }])
  if (init?.method === 'POST') return risposta([{ ...voce(versioneSalvata) }])
  if (init?.method === 'DELETE') return risposta({ eliminati: 1 })
  return risposta([voce(versioneLetta)])
})
beforeEach(() => {
  versioneLetta = 0
  versioneSalvata = 1
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())
async function apri() {
  const { result } = renderHook(() => useDiaryDay('operatore', 'Classe fittizia', { date: '2020-01-01', scuolaId: 'sede', sectionId: 'classe' }))
  await waitFor(() => expect(result.current.students).toHaveLength(1))
  await act(async () => { await result.current.handleEventSelect('nanna_inizio') })
  return result
}
const ultimoBody = () => JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').at(-1)?.[1]?.body)) as Array<{ versioneAttesa: number }>
describe('diario storico — la versione appartiene al contenuto del modulo', () => {
  it('il polling non avanza il token della bozza aperta prima di una modifica altrui', async () => {
    const result = await apri()
    versioneLetta = 9
    await act(async () => { await h.polling?.() })
    act(() => result.current.updateStudent('a1', { orario_inizio: '14:00' }))
    await act(async () => { await result.current.handleSave() })
    expect(ultimoBody()[0].versioneAttesa).toBe(0)
  })
  it('il secondo salvataggio usa il token della propria transazione, anche con polling più recente', async () => {
    const result = await apri()
    versioneLetta = 9
    await act(async () => { await result.current.handleSave() })
    act(() => result.current.updateStudent('a1', { orario_inizio: '14:00' }))
    await act(async () => { await result.current.handleSave() })
    expect(ultimoBody()[0].versioneAttesa).toBe(1)
  })
  it('la cancellazione usa il token aperto e il successivo inserimento dichiara la fonte assente', async () => {
    const result = await apri()
    versioneLetta = 9
    await act(async () => { await h.polling?.() })
    await act(async () => { await result.current.eliminaRegistrazione('a1') })
    const url = String(fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0])
    expect(JSON.parse(new URL(url, 'http://test').searchParams.get('versioniAttese')!)).toEqual({ evento: 0 })
    act(() => result.current.updateStudent('a1', { orario_inizio: '14:00' }))
    await act(async () => { await result.current.handleSave() })
    expect(ultimoBody()[0].versioneAttesa).toBeNull()
  })
})
