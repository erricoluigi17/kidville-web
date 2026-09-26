import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { renderHook, act, waitFor, render, screen, fireEvent } from '@testing-library/react'
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor'
import { ActivityDetailInline, type ActivityItem } from '@/components/features/teacher/diary/ActivityDetailInline'

// L'ORARIO DI CIASCUNA ATTIVITÀ (D2, 26/09).
//
// Ogni attività del diario ha un orario proprio, «Inizio» e «Fine», entrambi
// facoltativi. Contratto in
// docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/D1.md:
//  · nel jsonb come `ora_inizio` / `ora_fine` "HH:MM";
//  · un campo vuoto NON si scrive (niente `""` nel jsonb);
//  · fine < inizio ⇒ avviso in linea e salvataggio fermato prima della POST;
//  · un orario da solo non tiene in piedi un'attività vuota (`attivitaCompilata`).

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: unknown) => String(e) }))
import { logClient } from '@/lib/logging/client'
const logClientMock = vi.mocked(logClient)

const MSG_BLOCCATO = 'diario-attivita-orario-incoerente-salvataggio-bloccato'
/** Le chiamate a `logClient` del blocco sull'orario incoerente, e solo quelle. */
const logBlocco = () => logClientMock.mock.calls
  .map(([e]) => e)
  .filter(e => (e as { messaggio?: string }).messaggio === MSG_BLOCCATO)

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown, status = 200): JsonRes => ({ ok: status >= 200 && status < 300, status, json: async () => data })

let postBody: Array<Record<string, unknown>> | null = null
let entriesGet: unknown[] = []
let rispostaPost: () => JsonRes = () => jsonRes([])

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
    postBody = JSON.parse(init.body ?? '[]'); return rispostaPost()
  }
  if (u.includes('/api/diary/entries')) return jsonRes(entriesGet)
  return jsonRes(null)
})

const postEffettuate = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')

const alertMock = vi.fn()

beforeEach(() => {
  postBody = null; entriesGet = []; rispostaPost = () => jsonRes([])
  fetchMock.mockClear(); alertMock.mockClear(); logClientMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', alertMock)
})
afterEach(() => { vi.unstubAllGlobals() })

async function montaAttivita() {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
  await waitFor(() => expect(result.current.students).toHaveLength(2))
  await act(async () => { await result.current.handleEventSelect('attivita') })
  return result
}

const voce = (patch: Partial<ActivityItem>): ActivityItem => ({
  tipo: 'pittura', descrizione: 'tema autunno', studentPartecipazione: { a1: null, b2: null }, ...patch,
})

type Voce = Record<string, unknown>
const vociDi = (riga: Record<string, unknown> | undefined): Voce[] =>
  ((riga?.dettagli as { activities?: Voce[] } | undefined)?.activities) ?? []

describe('useDiaryDay — l\'orario entra nel salvataggio', () => {
  it('inizio e fine finiscono in ogni attività, a ciascuna il SUO', async () => {
    const result = await montaAttivita()
    act(() => {
      result.current.setActivities([
        voce({ oraInizio: '10:00', oraFine: '11:00' }),
        voce({ tipo: 'musica', descrizione: 'canzoni', oraInizio: '11:15', oraFine: '11:45' }),
      ])
    })
    await act(async () => { await result.current.handleSave() })

    expect(postBody).toHaveLength(2)
    for (const riga of postBody ?? []) {
      const [prima, seconda] = vociDi(riga)
      expect(prima).toMatchObject({ tipo: 'pittura', ora_inizio: '10:00', ora_fine: '11:00' })
      expect(seconda).toMatchObject({ tipo: 'musica', ora_inizio: '11:15', ora_fine: '11:45' })
    }
  })

  it('un campo vuoto NON si scrive: niente stringhe vuote nel jsonb', async () => {
    const result = await montaAttivita()
    act(() => {
      result.current.setActivities([
        voce({ oraInizio: '', oraFine: '' }),
        voce({ tipo: 'musica', oraInizio: '09:30', oraFine: '' }),
        voce({ tipo: 'gioco' }),
      ])
    })
    await act(async () => { await result.current.handleSave() })

    const [vuota, soloInizio, senzaCampi] = vociDi(postBody?.[0])
    expect(vuota).not.toHaveProperty('ora_inizio')
    expect(vuota).not.toHaveProperty('ora_fine')
    expect(soloInizio).toMatchObject({ ora_inizio: '09:30' })
    expect(soloInizio).not.toHaveProperty('ora_fine')
    expect(senzaCampi).not.toHaveProperty('ora_inizio')
    // E in tutto il corpo non c'è un orario vuoto da nessuna parte.
    expect(JSON.stringify(postBody)).not.toMatch(/"ora_(inizio|fine)":""/)
  })

  it('solo la fine, senza inizio, si salva da sola', async () => {
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ oraFine: '12:00' })]) })
    await act(async () => { await result.current.handleSave() })
    const [v] = vociDi(postBody?.[0])
    expect(v).toMatchObject({ ora_fine: '12:00' })
    expect(v).not.toHaveProperty('ora_inizio')
  })

  it('un orario da SOLO non fa salvare un\'attività altrimenti vuota', async () => {
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ descrizione: '', oraInizio: '10:00', oraFine: '11:00' })]) })
    expect(result.current.daSalvare).toBe(0)
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(0)
  })
})

describe('useDiaryDay — fine prima dell\'inizio', () => {
  it('ferma il salvataggio PRIMA della POST', async () => {
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ oraInizio: '11:00', oraFine: '10:00' })]) })
    expect(result.current.orariAttivitaIncoerenti).toBe(true)
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(0)
    // Il blocco si registra: warn, e SOLO il conteggio — niente orari, niente nomi.
    expect(logClientMock).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: MSG_BLOCCATO,
      campi: { n_voci_incoerenti: 1 },
    }))
    expect(logBlocco()).toHaveLength(1)
    const registrato = JSON.stringify(logBlocco())
    expect(registrato).not.toContain('11:00')
    expect(registrato).not.toContain('10:00')
    expect(registrato).not.toContain('Ada')
  })

  it('uguali sono ammessi (come sul server)', async () => {
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ oraInizio: '10:00', oraFine: '10:00' })]) })
    expect(result.current.orariAttivitaIncoerenti).toBe(false)
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(1)
  })

  it('una sola attività incoerente basta a fermare tutto il lotto', async () => {
    const result = await montaAttivita()
    act(() => {
      result.current.setActivities([
        voce({ oraInizio: '09:00', oraFine: '10:00' }),
        voce({ tipo: 'musica', oraInizio: '12:00', oraFine: '11:59' }),
      ])
    })
    expect(result.current.orariAttivitaIncoerenti).toBe(true)
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(0)
    // Una voce incoerente su due: il conteggio è 1, non 2 (né la lunghezza del lotto).
    expect(logClientMock).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: MSG_BLOCCATO,
      campi: { n_voci_incoerenti: 1 },
    }))
    const registrato = JSON.stringify(logBlocco())
    for (const ora of ['09:00', '10:00', '12:00', '11:59']) expect(registrato).not.toContain(ora)
  })

  it('un 422 del server mostra la SUA ragione, non il generico «errore di salvataggio»', async () => {
    rispostaPost = () => jsonRes({
      error: 'L\'ora di fine di un\'attività non può essere prima dell\'ora di inizio.',
      codice: 'ORARIO_ATTIVITA_INCOERENTE',
      details: [{ path: '0.dettagli.activities.0.ora_fine', message: 'x' }],
    }, 422)
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ oraInizio: '10:00', oraFine: '11:00' })]) })
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(1)
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock).toHaveBeenCalledWith('L’ora di fine non può essere prima dell’ora di inizio.')
    expect(result.current.savedStudentIds.size).toBe(0)
  })

  it('un 422 ORARIO_ATTIVITA_NON_VALIDO mostra la ragione del FORMATO', async () => {
    rispostaPost = () => jsonRes({
      error: 'Orario dell\'attività non valido.',
      codice: 'ORARIO_ATTIVITA_NON_VALIDO',
      details: [{ path: '0.dettagli.activities.0.ora_inizio', message: 'x' }],
    }, 422)
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ oraInizio: '10:00', oraFine: '11:00' })]) })
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(1)
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock).toHaveBeenCalledWith('Orario dell’attività non valido: usa il formato HH:MM (es. 09:30).')
    expect(result.current.savedStudentIds.size).toBe(0)
  })

  it.each([
    ['un altro codice', { error: 'Dati non validi', codice: 'ALTRO_CODICE' }],
    ['nessun codice', { error: 'Dati non validi' }],
  ])('un 422 con %s resta sul percorso generico di prima', async (_nome, corpo) => {
    rispostaPost = () => jsonRes(corpo, 422)
    const result = await montaAttivita()
    act(() => { result.current.setActivities([voce({ oraInizio: '10:00', oraFine: '11:00' })]) })
    await act(async () => { await result.current.handleSave() })
    expect(postEffettuate()).toHaveLength(1)
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock).toHaveBeenCalledWith('Errore nel salvataggio. Controlla la console.')
    expect(result.current.savedStudentIds.size).toBe(0)
  })
})

describe('useDiaryDay — l\'orario si ripristina riaprendo', () => {
  it('riaprendo una registrazione salvata, ogni attività ritrova il suo orario', async () => {
    const dettagli = {
      activities: [
        { tipo: 'pittura', descrizione: 'autunno', partecipazione: 'autonomia', ora_inizio: '10:00', ora_fine: '11:00' },
        { tipo: 'musica', descrizione: 'canzoni', partecipazione: null, ora_inizio: '11:30' },
        { tipo: 'gioco', descrizione: 'palla', partecipazione: null },
      ],
    }
    entriesGet = [
      { alunno_id: 'a1', tipo_evento: 'attivita', orario_inizio: '2026-09-26T09:00:00Z', dettagli },
      { alunno_id: 'b2', tipo_evento: 'attivita', orario_inizio: '2026-09-26T09:00:00Z', dettagli },
    ]
    const result = await montaAttivita()
    const [a, b, c] = result.current.activities
    expect(a).toMatchObject({ tipo: 'pittura', oraInizio: '10:00', oraFine: '11:00' })
    expect(b).toMatchObject({ tipo: 'musica', oraInizio: '11:30', oraFine: '' })
    expect(c).toMatchObject({ tipo: 'gioco', oraInizio: '', oraFine: '' })

    // E risalvando senza toccare niente l'orario NON si perde.
    await act(async () => { await result.current.handleSave() })
    const [pa, pb, pc] = vociDi(postBody?.[0])
    expect(pa).toMatchObject({ ora_inizio: '10:00', ora_fine: '11:00' })
    expect(pb).toMatchObject({ ora_inizio: '11:30' })
    expect(pb).not.toHaveProperty('ora_fine')
    expect(pc).not.toHaveProperty('ora_inizio')
  })
})

// ─── Componente: i due campi e l'avviso in linea ──────────────────────────────

const STUDENTI = [{ id: 'a1', firstName: 'Ada', lastName: 'Bianchi' }]

function Inline({ iniziali, onCambio }: { iniziali: ActivityItem[]; onCambio?: (a: ActivityItem[]) => void }) {
  const [acts, setActs] = useState(iniziali)
  return (
    <ActivityDetailInline
      students={STUDENTI}
      activities={acts}
      onActivitiesChange={(a) => { setActs(a); onCambio?.(a) }}
      savedStudentIds={new Set()}
    />
  )
}

describe('ActivityDetailInline — Inizio e Fine per ogni attività', () => {
  it('ogni attività ha i SUOI due campi orario, con un nome accessibile', () => {
    render(<Inline iniziali={[voce({}), voce({ tipo: 'musica' })]} />)
    const inizio1 = screen.getByLabelText('Ora di inizio dell’attività 1')
    const fine2 = screen.getByLabelText('Ora di fine dell’attività 2')
    expect(inizio1).toHaveAttribute('type', 'time')
    expect(fine2).toHaveAttribute('type', 'time')
    // Niente `step` sui secondi: il formato resta HH:MM (D1).
    expect(inizio1).not.toHaveAttribute('step')
    expect(screen.getAllByText('Inizio')).toHaveLength(2)
    expect(screen.getAllByText('Fine')).toHaveLength(2)
  })

  it('scrivere un orario lo mette nella SOLA attività toccata', () => {
    const onCambio = vi.fn()
    render(<Inline iniziali={[voce({}), voce({ tipo: 'musica' })]} onCambio={onCambio} />)
    fireEvent.change(screen.getByLabelText('Ora di inizio dell’attività 2'), { target: { value: '10:30' } })
    const ultimo = onCambio.mock.calls.at(-1)?.[0] as ActivityItem[]
    expect(ultimo[1].oraInizio).toBe('10:30')
    expect(ultimo[0].oraInizio ?? '').toBe('')
    expect(screen.getByLabelText('Ora di inizio dell’attività 2')).toHaveValue('10:30')
  })

  it('fine prima dell\'inizio ⇒ avviso in linea e campo segnato invalido', () => {
    render(<Inline iniziali={[voce({ oraInizio: '11:00', oraFine: '10:00' })]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('L’ora di fine non può essere prima dell’ora di inizio.')
    expect(screen.getByLabelText('Ora di fine dell’attività 1')).toHaveAttribute('aria-invalid', 'true')
  })

  it('correggendo la fine l\'avviso se ne va', () => {
    render(<Inline iniziali={[voce({ oraInizio: '11:00', oraFine: '10:00' })]} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Ora di fine dell’attività 1'), { target: { value: '12:00' } })
    // Il render è sincrono: nessun waitFor su un'assenza.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Ora di fine dell’attività 1')).not.toHaveAttribute('aria-invalid', 'true')
  })
})

// ─── L'editor intero, come lo usano teacher/diary e admin/diary ───────────────

function Editor() {
  const day = useDiaryDay('u1', 'Girasoli')
  return (
    <>
      <span data-testid="n-studenti">{day.students.length}</span>
      <DiaryEventEditor day={day} sezione="Girasoli" />
    </>
  )
}

describe('DiaryEventEditor — l\'orario dal campo al payload', () => {
  async function apriAttivita() {
    render(<Editor />)
    await waitFor(() => expect(screen.getByTestId('n-studenti')).toHaveTextContent('2'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Registra Attivit/i })) })
    await screen.findByLabelText('Ora di inizio dell’attività 1')
  }

  const pulsanteSalva = () => screen.getByRole('button', { name: /Salva/i })

  it('descrizione + orario scritti nei campi arrivano nella POST', async () => {
    await apriAttivita()
    fireEvent.change(screen.getByPlaceholderText(/Descrivi/i), { target: { value: 'foglie' } })
    fireEvent.change(screen.getByLabelText('Ora di inizio dell’attività 1'), { target: { value: '10:00' } })
    fireEvent.change(screen.getByLabelText('Ora di fine dell’attività 1'), { target: { value: '11:00' } })
    await act(async () => { fireEvent.click(pulsanteSalva()) })
    await waitFor(() => expect(postBody).not.toBeNull())
    expect(vociDi(postBody?.[0])[0]).toMatchObject({ descrizione: 'foglie', ora_inizio: '10:00', ora_fine: '11:00' })
  })

  it('con fine prima dell\'inizio il pulsante è spento e lo dice', async () => {
    await apriAttivita()
    fireEvent.change(screen.getByPlaceholderText(/Descrivi/i), { target: { value: 'foglie' } })
    fireEvent.change(screen.getByLabelText('Ora di inizio dell’attività 1'), { target: { value: '11:00' } })
    fireEvent.change(screen.getByLabelText('Ora di fine dell’attività 1'), { target: { value: '10:00' } })
    expect(pulsanteSalva()).toBeDisabled()
    expect(screen.getByText('Correggi l’orario delle attività: la fine è prima dell’inizio.')).toBeInTheDocument()
    // Il motivo è COLLEGATO al pulsante, non solo vicino: un lettore di schermo
    // che arriva sul Salva spento sente perché.
    expect(pulsanteSalva()).toHaveAccessibleDescription('Correggi l’orario delle attività: la fine è prima dell’inizio.')
    fireEvent.click(pulsanteSalva())
    expect(postEffettuate()).toHaveLength(0)
  })
})
