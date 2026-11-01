import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor, render, screen, fireEvent } from '@testing-library/react'
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor'

// IL RIQUADRO È SPENTO FINCHÉ IL RIPRISTINO LEGGE L'ARCHIVIO (01/11/2026).
//
// Il difetto: aprire un tipo fa partire la GET delle voci di oggi, e quando torna il
// ripristino riscrive `studentStates` per intero. Un tocco dato mentre la GET era in volo
// spariva, sovrascritto da ciò che diceva il server; e su un umore già salvato il tocco
// (un interruttore) lo spegneva appena il ripristino l'aveva acceso. È l'E2E
// `teacher-diary.spec.ts` che cadeva a caso dal 5 ottobre: leggeva `aria-pressed` fra la
// risposta e il ridisegno.
//
// La regola: finché il ripristino legge, il riquadro è un fieldset spento e `aria-busy`.
// Lo riaccende solo il ripristino che l'ha spento: uno superato non lo riaccende mentre il
// suo successore legge ancora, e non lo lascia spento per sempre se nessuno gli succede.

vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown): JsonRes => ({ ok: true, status: 200, json: async () => data })

let entriesGet: unknown[] = []
/** Quante delle prossime GET di ripristino restano IN VOLO finché il test non le rilascia. */
let getDaTrattenere = 0
let getTrattenute: Array<(r: JsonRes) => void> = []
const rilascia = (i: number) => getTrattenute[i](jsonRes(entriesGet))

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes({ routine_attive: ['pasto', 'sonno', 'cambio', 'attivita', 'umore'] })
  if (u.includes('/api/diary/students')) {
    return jsonRes([
      { id: 'a1', nome: 'Anna', cognome: 'Prova', note_mediche: null },
      { id: 'b2', nome: 'Bruno', cognome: 'Prova', note_mediche: null },
    ])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') {
    const body = JSON.parse(init.body ?? '[]') as Array<Record<string, unknown>>
    return jsonRes(body.map((r) => ({ alunno_id: r.alunno_id })))
  }
  // Le voci delle routine spente: non è il ripristino, risponde subito.
  if (u.includes('/api/diary/entries') && u.includes('scopo=spente')) return jsonRes([])
  if (u.includes('/api/diary/entries')) {
    if (getDaTrattenere > 0) {
      getDaTrattenere -= 1
      return new Promise<JsonRes>((risolvi) => { getTrattenute.push(risolvi) })
    }
    return jsonRes(entriesGet)
  }
  return jsonRes(null)
})

beforeEach(() => {
  entriesGet = []
  getDaTrattenere = 0
  getTrattenute = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const riga = (alunno: string, tipo: string, dettagli: Record<string, unknown>) =>
  ({ alunno_id: alunno, tipo_evento: tipo, orario_inizio: '2026-11-01T09:00:00Z', dettagli })

function Schermata() {
  const day = useDiaryDay('u1', 'Girasoli')
  return <DiaryEventEditor day={day} sezione="Girasoli" />
}

describe('DiaryEventEditor — il riquadro mentre il ripristino legge l\'archivio', () => {
  it('i bottoni sono spenti finché la lettura non torna, poi mostrano ciò che è salvato', async () => {
    entriesGet = [riga('a1', 'umore', { umore: 'felice' })]
    getDaTrattenere = 1
    render(<Schermata />)
    fireEvent.click(await screen.findByRole('button', { name: /Registra Umore/ }))

    const felice = await screen.findByRole('button', { name: 'Anna: Felice' })
    await waitFor(() => expect(getTrattenute).toHaveLength(1))
    // In volo: lo schermo mostra ancora lo stato vuoto, e toccarlo non deve essere possibile.
    expect(felice).toHaveAttribute('aria-pressed', 'false')
    expect(felice).toBeDisabled()
    expect(screen.getByRole('button', { name: /Bruno: Felice/ })).toBeDisabled()
    expect(felice.closest('fieldset')).toHaveAttribute('aria-busy', 'true')

    await act(async () => { rilascia(0) })

    // La PRESENZA dello stato ripristinato, non l'assenza dello spegnimento.
    await waitFor(() => expect(felice).toHaveAttribute('aria-pressed', 'true'))
    expect(felice).toBeEnabled()
    expect(felice.closest('fieldset')).toHaveAttribute('aria-busy', 'false')
    // E ora il tocco attecchisce: è un interruttore, quindi spegne.
    fireEvent.click(felice)
    expect(felice).toHaveAttribute('aria-pressed', 'false')
  })

  it('la X per chiudere resta viva anche mentre il ripristino legge', async () => {
    getDaTrattenere = 1
    render(<Schermata />)
    fireEvent.click(await screen.findByRole('button', { name: /Registra Umore/ }))
    await screen.findByRole('button', { name: 'Anna: Felice' })
    await waitFor(() => expect(getTrattenute).toHaveLength(1))
    expect(document.querySelector('fieldset[aria-busy="true"]')).not.toBeNull()

    const chiudi = screen.getByRole('button', { name: /chiudi/i })
    expect(chiudi).toBeEnabled()
    await act(async () => { rilascia(0) })
  })
})

describe('useDiaryDay — chi riaccende il riquadro', () => {
  async function monta() {
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    return result
  }

  it('un ripristino SUPERATO non riaccende il riquadro mentre il successore legge ancora', async () => {
    getDaTrattenere = 2
    const result = await monta()
    act(() => { void result.current.handleEventSelect('nanna_inizio') })
    await waitFor(() => expect(getTrattenute).toHaveLength(1))
    act(() => { void result.current.handleEventSelect('nanna_fine') })
    await waitFor(() => expect(getTrattenute).toHaveLength(2))
    expect(result.current.inRipristino).toBe(true)

    // Torna la lettura della Nanna, che nessuno aspetta più: il riquadro aperto è la Sveglia.
    await act(async () => { rilascia(0) })
    expect(result.current.inRipristino).toBe(true)

    await act(async () => { rilascia(1) })
    expect(result.current.inRipristino).toBe(false)
  })

  it('chiudere il riquadro durante la lettura non lo lascia spento per sempre', async () => {
    getDaTrattenere = 1
    const result = await monta()
    act(() => { void result.current.handleEventSelect('umore') })
    await waitFor(() => expect(getTrattenute).toHaveLength(1))
    expect(result.current.inRipristino).toBe(true)

    // Lo stesso tipo toccato di nuovo chiude il riquadro e supera la lettura in volo.
    await act(async () => { await result.current.handleEventSelect('umore') })
    await act(async () => { rilascia(0) })
    expect(result.current.inRipristino).toBe(false)

    // Riaperto, legge e si riaccende come sempre.
    await act(async () => { await result.current.handleEventSelect('umore') })
    expect(result.current.inRipristino).toBe(false)
  })
})
