import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDiaryDay } from '@/components/features/teacher/diary/DiaryEventEditor'

// IL BAGNO SI SEGNA A CHI CI È ANDATO, NON A TUTTI.
//
// Segnalazione del titolare (2026-09-08): «se aggiungo una pipì e una cacca per un
// bambino, poi risulta a tutti anche a chi non l'ha fatta». Il filtro del
// salvataggio aveva due rami selettivi (umore e nanna) e bagno/pasti cadevano nel
// ramo `else` — l'intero elenco dei presenti. `buildInitialState` mette d'ufficio
// {pipi:0, cacca:0, vasino:0} a tutti, quindi in archivio finiva una riga anche per
// chi non era stato toccato, e il genitore leggeva «🚿 Sono stato/a al bagno oggi!».
//
// Misurato in produzione dal 1° settembre: 323 righe di bagno su 514 completamente
// vuote (63%), più 40 pranzi e 26 merende senza nessuna portata.

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: unknown) => String(e) }))

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown): JsonRes => ({ ok: true, status: 200, json: async () => data })

let postBody: Array<Record<string, unknown>> | null = null
let deleteUrl: string | null = null
let entriesGet: unknown[] = []

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes({ routine_attive: [] })
  if (u.includes('/api/diary/students')) {
    return jsonRes([
      { id: 'a1', nome: 'Ada', cognome: 'Bianchi', note_mediche: null },
      { id: 'b2', nome: 'Bruno', cognome: 'Verdi', note_mediche: null },
    ])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') {
    postBody = JSON.parse(init.body ?? '[]'); return jsonRes([])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'DELETE') { deleteUrl = u; return jsonRes({ eliminati: 1 }) }
  if (u.includes('/api/diary/entries')) return jsonRes(entriesGet)
  return jsonRes(null)
})

const postEffettuate = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')

beforeEach(() => {
  postBody = null; deleteUrl = null; entriesGet = []
  fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

async function montaSuEvento(evento: 'bagno' | 'pranzo' | 'merenda') {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
  await waitFor(() => expect(result.current.students).toHaveLength(2))
  await act(async () => { await result.current.handleEventSelect(evento) })
  return result
}

describe('il bagno finisce solo nel diario di chi ci è andato', () => {
  it('una pipì e una cacca ad Ada NON finiscono addosso a Bruno', async () => {
    // È il caso del titolare, letterale.
    const result = await montaSuEvento('bagno')
    act(() => { result.current.counter('a1', 'pipi', 1) })
    act(() => { result.current.counter('a1', 'cacca', 1) })
    await act(async () => { await result.current.handleSave() })

    expect(postBody).toHaveLength(1)
    expect(postBody?.[0]).toMatchObject({ alunno_id: 'a1' })
    expect(postBody?.[0].dettagli).toMatchObject({ pipi: 1, cacca: 1, vasino: 0 })
  })

  it('nessuno toccato ⇒ nessuna POST (oggi ne partiva una con due righe a zero)', async () => {
    const result = await montaSuEvento('bagno')
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(0)
  })

  it('riaprendo la schermata la ✅ è solo di chi ha una registrazione VERA', async () => {
    // È questo che rende inerti le 323 righe già in archivio, senza migrazione:
    // oggi la maestra riapre e vede la spunta su tutta la sezione.
    entriesGet = [
      { alunno_id: 'a1', tipo_evento: 'bagno', orario_inizio: '2026-09-08T09:00:00Z', dettagli: { pipi: 0, cacca: 0, vasino: 0 } },
      { alunno_id: 'b2', tipo_evento: 'bagno', orario_inizio: '2026-09-08T09:00:00Z', dettagli: { pipi: 1, cacca: 0, vasino: 0 } },
    ]
    const result = await montaSuEvento('bagno')
    expect([...result.current.savedStudentIds]).toEqual(['b2'])
  })

  it('svuotare i contatori e risalvare NON cancella: per quello c\'è il cestino', async () => {
    // La trappola del no-op: i contatori sono a zero a schermo, la ✅ è sparita, il
    // toast è verde — e la riga resta in archivio con {pipi:2}. È il difetto chiuso,
    // riaperto dal suo stesso rimedio, ed è il motivo per cui serve `eliminaRegistrazione`.
    entriesGet = [{ alunno_id: 'a1', tipo_evento: 'bagno', orario_inizio: '2026-09-08T09:00:00Z', dettagli: { pipi: 2 } }]
    const result = await montaSuEvento('bagno')
    act(() => { result.current.counter('a1', 'pipi', -1) })
    act(() => { result.current.counter('a1', 'pipi', -1) })
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(0)
  })

  it('il cestino esiste anche per il bagno, e passa dalla DELETE che possiede la risorsa', async () => {
    entriesGet = [{ alunno_id: 'a1', tipo_evento: 'bagno', orario_inizio: '2026-09-08T09:00:00Z', dettagli: { pipi: 2 } }]
    const result = await montaSuEvento('bagno')
    await act(async () => { await result.current.eliminaRegistrazione('a1') })
    expect(deleteUrl).toContain('tipo_evento=bagno')
    expect(deleteUrl).toContain('alunno_id=a1')
    expect([...result.current.savedStudentIds]).not.toContain('a1')
    // Lo stato torna a com'è fatto un bagno vuoto, non a una forma cablata a mano.
    expect(result.current.studentStates.a1).toEqual({ pipi: 0, cacca: 0, vasino: 0 })
  })
})

describe.each(['pranzo', 'merenda'] as const)('%s — «niente» è una registrazione, il vuoto no', (evento) => {
  const corso = evento === 'merenda' ? 'merenda' : 'primo'

  it('salva solo chi ha una portata segnata', async () => {
    const result = await montaSuEvento(evento)
    act(() => { result.current.updateMealCourse('a1', corso, 'meta') })
    await act(async () => { await result.current.handleSave() })
    expect(postBody).toHaveLength(1)
    expect(postBody?.[0]).toMatchObject({ alunno_id: 'a1' })
  })

  it('«niente» SALVA: è il bambino che non ha mangiato, ed è ciò che il genitore vuole sapere', async () => {
    const result = await montaSuEvento(evento)
    act(() => { result.current.updateMealCourse('b2', corso, 'niente') })
    await act(async () => { await result.current.handleSave() })
    expect(postBody).toHaveLength(1)
    expect(postBody?.[0]).toMatchObject({ alunno_id: 'b2' })
  })

  it('nessuna portata toccata ⇒ nessuna POST', async () => {
    const result = await montaSuEvento(evento)
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(0)
  })
})

describe('l\'attività resta di CLASSE, e non va filtrata per bambino', () => {
  it('si salva a tutti anche senza partecipazione: l\'attività c\'è stata per tutti', async () => {
    // Filtrarla farebbe sparire dal diario di tutti un'attività realmente svolta e
    // non valutata bambino per bambino: sarebbe l'errore dei 29 bambini, rifatto.
    const result = await montaSuEvento('attivita' as 'bagno')
    await act(async () => { await result.current.handleSave() })
    expect(postBody).toHaveLength(2)
  })
})
