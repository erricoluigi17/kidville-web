import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDiaryDay } from '@/components/features/teacher/diary/DiaryEventEditor'

// LA NANNA SI SEGNA A CHI HA DORMITO, NON A TUTTI.
//
// Il difetto, segnalato dal titolare e riprodotto qui: il filtro del salvataggio
// aveva UN SOLO ramo selettivo (`umore`), e «Nanna»/«Sveglia» cadevano nel ramo
// `else` — cioè l'intero elenco dei bambini presenti. Una riga in `eventi_diario`
// per ognuno, anche con `dettagli.orario_inizio = ''`, e il genitore di chi non
// aveva dormito leggeva «Ho fatto un bel sonnellino! 😴».
//
// Il pulsante «Tutti a nanna ora» RESTA, ma è un aiuto di COMPILAZIONE: riempie
// l'ora a tutti e non salva niente da sé. Chi non doveva dormire lo si toglie
// prima di salvare; chi è stato segnato per errore si cancella col cestino.

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: unknown) => String(e) }))

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown): JsonRes => ({ ok: true, status: 200, json: async () => data })
const erroreRes = (status: number): JsonRes => ({ ok: false, status, json: async () => ({ error: 'ko' }) })

let postBody: Array<Record<string, unknown>> | null = null
let deleteUrl: string | null = null
let entriesGet: unknown[] = []
let esitoDelete: JsonRes = jsonRes({ eliminati: 1 })

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
  if (u.includes('/api/diary/entries') && init?.method === 'DELETE') {
    deleteUrl = u
    return esitoDelete
  }
  if (u.includes('/api/diary/entries')) return jsonRes(entriesGet)
  return jsonRes(null)
})

const postEffettuate = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')

beforeEach(() => {
  postBody = null
  deleteUrl = null
  entriesGet = []
  esitoDelete = jsonRes({ eliminati: 1 })
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

async function montaSuEvento(evento: 'nanna_inizio' | 'nanna_fine') {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
  await waitFor(() => expect(result.current.students).toHaveLength(2))
  await act(async () => { await result.current.handleEventSelect(evento) })
  return result
}

describe.each([
  { evento: 'nanna_inizio' as const, campo: 'orario_inizio', ora: '13:05' },
  // La simmetria non è pedanteria: senza, la regola varrebbe per metà evento e la
  // «Sveglia» continuerebbe a segnare l'intera sezione.
  { evento: 'nanna_fine' as const, campo: 'orario_fine', ora: '15:30' },
])('useDiaryDay — $evento si salva solo a chi ha l\'orario', ({ evento, campo, ora }) => {
  it('salva SOLO il bambino con l\'orario compilato', async () => {
    const result = await montaSuEvento(evento)

    act(() => { result.current.updateStudent('a1', { [campo]: ora }) })
    await act(async () => { await result.current.handleSave() })

    expect(postBody).not.toBeNull()
    expect(postBody).toHaveLength(1)
    expect(postBody![0].alunno_id).toBe('a1')
  })

  it('nessun orario compilato ⇒ NESSUNA richiesta di salvataggio', async () => {
    const result = await montaSuEvento(evento)

    await act(async () => { await result.current.handleSave() })

    // Prima di questa correzione partivano due righe `{ orario: '' }`, e il
    // genitore di entrambi leggeva il sonnellino.
    expect(postEffettuate()).toHaveLength(0)
    expect(postBody).toBeNull()
  })

  it('riaprendo la schermata la ✅ è solo di chi ha davvero l\'orario', async () => {
    entriesGet = [
      { alunno_id: 'a1', tipo_evento: evento, orario_inizio: '2026-09-07T11:00:00Z', dettagli: { [campo]: '' } },
      { alunno_id: 'b2', tipo_evento: evento, orario_inizio: '2026-09-07T11:00:00Z', dettagli: { [campo]: ora } },
    ]

    const result = await montaSuEvento(evento)

    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.savedStudentIds.has('a1')).toBe(false)
    expect(result.current.studentStates.b2[campo]).toBe(ora)
  })
})

describe('useDiaryDay — «Tutti a nanna ora» compila, non salva', () => {
  it('riempie l\'ora a tutti senza far partire nessun salvataggio', async () => {
    const result = await montaSuEvento('nanna_inizio')

    act(() => { result.current.bulkNannaOra() })

    expect(String(result.current.studentStates.a1.orario_inizio)).toMatch(/^\d{2}:\d{2}$/)
    expect(String(result.current.studentStates.b2.orario_inizio)).toMatch(/^\d{2}:\d{2}$/)
    // È un aiuto di compilazione: da solo non scrive niente in archivio.
    expect(postEffettuate()).toHaveLength(0)
  })
})

describe('useDiaryDay — eliminare una nanna segnata per errore', () => {
  it('chiama la DELETE nominando bambino, tipo evento e giorno, poi toglie la ✅', async () => {
    entriesGet = [
      { alunno_id: 'b2', tipo_evento: 'nanna_inizio', orario_inizio: '2026-09-07T11:00:00Z', dettagli: { orario_inizio: '13:05' } },
    ]
    const result = await montaSuEvento('nanna_inizio')
    expect(result.current.savedStudentIds.has('b2')).toBe(true)

    await act(async () => { await result.current.eliminaRegistrazione('b2') })

    expect(deleteUrl).not.toBeNull()
    expect(deleteUrl).toContain('alunno_id=b2')
    expect(deleteUrl).toContain('tipo_evento=nanna_inizio')
    expect(deleteUrl).toMatch(/date=\d{4}-\d{2}-\d{2}/)

    expect(result.current.savedStudentIds.has('b2')).toBe(false)
    expect(result.current.studentStates.b2.orario_inizio).toBe('')
  })

  it('se la cancellazione fallisce, la ✅ RESTA: una spunta che sparisce mentre la riga resta è la bugia opposta', async () => {
    const { logClient } = await import('@/lib/logging/client')
    entriesGet = [
      { alunno_id: 'b2', tipo_evento: 'nanna_inizio', orario_inizio: '2026-09-07T11:00:00Z', dettagli: { orario_inizio: '13:05' } },
    ]
    esitoDelete = erroreRes(500)
    vi.stubGlobal('alert', vi.fn())

    const result = await montaSuEvento('nanna_inizio')
    await act(async () => { await result.current.eliminaRegistrazione('b2') })

    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.studentStates.b2.orario_inizio).toBe('13:05')
    expect(logClient).toHaveBeenCalled()
  })
})
