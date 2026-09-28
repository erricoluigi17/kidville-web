import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, act, waitFor, screen, fireEvent, within } from '@testing-library/react'

import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor'
import { invalidaDiarioConfigCache } from '@/lib/diary/config-cache'

// LE ROUTINE DEL DIARIO FUNZIONANO (richiesta del titolare, 2026-09-28).
//
// Fino a oggi spegnere «Pasto» dalle impostazioni non toglieva il pasto a nessuno: il codice
// leggeva della configurazione solo l'umore. E le routine che la scuola voleva aggiungere (crema
// solare, biberon…) non avevano dove stare. Qui: i bottoni della maestra seguono la sede, e le
// routine della scuola si segnano, si salvano solo a chi è stato segnato e si cancellano.

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: unknown) => String(e) }))

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown, status = 200): JsonRes => ({ ok: status < 400, status, json: async () => data })

const CREMA = { id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true }
const BIBERON = { id: 'e5f6a7b8', nome: 'Biberon', emoji: '🍼', risposta: 'scelta', opzioni: ['Poco', 'Metà', 'Tutto'], multipla: false, attiva: true }
const MERENDE = { id: 'c9d0e1f2', nome: 'Frutta', emoji: '🍓', risposta: 'scelta', opzioni: ['Mela', 'Pera', 'Banana'], multipla: true, attiva: true }
const BIBERON_ORA = { id: 'b0b0b0b0', nome: 'Latte', emoji: '🥛', risposta: 'orario', opzioni: [], multipla: false, attiva: true }
const APPUNTO = { id: 'd0d0d0d0', nome: 'Com\'è andata', emoji: '📝', risposta: 'testo', opzioni: [], multipla: false, attiva: true }
const SPENTA = { id: 'f0f0f0f0', nome: 'Spenta', emoji: '💤', risposta: 'spunta', opzioni: [], multipla: false, attiva: false }

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'

let config: Record<string, unknown> = {}
let postBody: Array<Record<string, unknown>> | null = null
let deleteUrl: string | null = null
let entriesGet: unknown[] = []

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes(config)
  if (u.includes('/api/diary/students')) {
    return jsonRes([
      { id: 'a1', nome: 'Ada', cognome: 'Bianchi', note_mediche: null },
      { id: 'b2', nome: 'Bruno', cognome: 'Verdi', note_mediche: null },
    ])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') { postBody = JSON.parse(init.body ?? '[]'); return jsonRes([]) }
  if (u.includes('/api/diary/entries') && init?.method === 'DELETE') { deleteUrl = u; return jsonRes({ eliminati: 1 }) }
  if (u.includes('/api/diary/entries')) return jsonRes(entriesGet)
  return jsonRes(null)
})

beforeEach(() => {
  config = { routine_attive: null, routine_personalizzate: [CREMA, BIBERON, MERENDE, BIBERON_ORA, APPUNTO, SPENTA] }
  postBody = null; deleteUrl = null; entriesGet = []
  invalidaDiarioConfigCache()
  fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

async function monta(opts?: { scuolaId?: string }) {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli', opts))
  await waitFor(() => expect(result.current.students).toHaveLength(2))
  return result
}

describe('i bottoni della maestra seguono le routine della sede', () => {
  it('spento il pasto e il sonno, restano attività e bagno — più le routine della scuola attive', async () => {
    config = { routine_attive: ['attivita', 'cambio'], routine_personalizzate: [CREMA, SPENTA] }
    const result = await monta()
    await waitFor(() => expect(result.current.eventTypes).toEqual(['attivita', 'bagno', 'routine:a1b2c3d4']))
  })

  it('configurazione assente (sede nuova): i sei bottoni di sempre', async () => {
    config = { routine_attive: null }
    const result = await monta()
    await waitFor(() => expect(result.current.eventTypes).toEqual(['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno']))
  })

  it('la configurazione si chiede per la SEDE che si sta compilando (cockpit di segreteria)', async () => {
    await monta({ scuolaId: SEDE })
    const chiesta = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/api/diary/config'))
    expect(chiesta).toContain(`scuola_id=${SEDE}`)
  })
})

describe('una routine della scuola si segna, si salva e si cancella', () => {
  it('si salva SOLO a chi è stato segnato, con la fotografia della routine', async () => {
    const result = await monta()
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    await act(async () => { await result.current.handleEventSelect('routine:a1b2c3d4') })
    expect(result.current.daSalvare).toBe(0)

    act(() => { result.current.updateStudent('a1', { valore: true }) })
    expect(result.current.daSalvare).toBe(1)
    await act(async () => { await result.current.handleSave() })

    expect(postBody).toHaveLength(1)
    expect(postBody?.[0]).toMatchObject({
      alunno_id: 'a1',
      tipo_evento: 'routine:a1b2c3d4',
      dettagli: { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: true },
    })
  })

  it('riaprendo, la ✅ è solo di chi ha una registrazione vera', async () => {
    entriesGet = [
      { alunno_id: 'a1', tipo_evento: 'routine:a1b2c3d4', orario_inizio: '2026-09-28T09:00:00Z', dettagli: { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: null } },
      { alunno_id: 'b2', tipo_evento: 'routine:a1b2c3d4', orario_inizio: '2026-09-28T09:00:00Z', dettagli: { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: true } },
    ]
    const result = await monta()
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    await act(async () => { await result.current.handleEventSelect('routine:a1b2c3d4') })
    expect([...result.current.savedStudentIds]).toEqual(['b2'])
  })

  it('il cestino cancella la sola registrazione di quella routine', async () => {
    entriesGet = [
      { alunno_id: 'b2', tipo_evento: 'routine:a1b2c3d4', orario_inizio: '2026-09-28T09:00:00Z', dettagli: { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: true } },
    ]
    const result = await monta()
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    await act(async () => { await result.current.handleEventSelect('routine:a1b2c3d4') })
    await act(async () => { await result.current.eliminaRegistrazione('b2') })

    expect(deleteUrl).toContain('tipo_evento=routine%3Aa1b2c3d4')
    expect(deleteUrl).toContain('alunno_id=b2')
    expect(result.current.savedStudentIds.has('b2')).toBe(false)
  })
})

function Editor() {
  const day = useDiaryDay('u1', 'Girasoli')
  return <DiaryEventEditor day={day} sezione="Girasoli" />
}

async function apri(nome: string) {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Registra ${nome}`) }))
  await screen.findByRole('heading', { name: nome })
}

/** La riga di un bambino nel pannello aperto. */
const ID_DI: Record<string, string> = { Ada: 'a1', Bruno: 'b2' }
const rigaDi = (nome: string) => screen.getByTestId(`routine-riga-${ID_DI[nome]}`)

describe('il pannello di una routine della scuola, per ogni tipo di risposta', () => {
  it('spunta: «Fatto» si accende e si spegne, e «Fatto per tutti» segna l\'intera classe', async () => {
    await apri('Crema solare')
    const fatto = within(rigaDi('Ada')).getByRole('button', { name: /fatto/i })
    expect(fatto).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(fatto)
    expect(fatto).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /fatto per tutti/i }))
    fireEvent.click(screen.getByRole('button', { name: /salva 2 bambini/i }))
    await waitFor(() => expect(postBody).toHaveLength(2))
  })

  it('scelta singola: una opzione per bambino; toccarne un\'altra la sostituisce', async () => {
    await apri('Biberon')
    fireEvent.click(within(rigaDi('Ada')).getByRole('button', { name: 'Poco' }))
    fireEvent.click(within(rigaDi('Ada')).getByRole('button', { name: 'Tutto' }))
    fireEvent.click(screen.getByRole('button', { name: /salva 1 bambino/i }))
    await waitFor(() => expect(postBody).toHaveLength(1))
    expect(postBody?.[0].dettagli).toMatchObject({ risposta: 'scelta', valore: ['Tutto'] })
  })

  it('scelta multipla: più opzioni per lo stesso bambino', async () => {
    await apri('Frutta')
    fireEvent.click(within(rigaDi('Bruno')).getByRole('button', { name: 'Mela' }))
    fireEvent.click(within(rigaDi('Bruno')).getByRole('button', { name: 'Banana' }))
    fireEvent.click(screen.getByRole('button', { name: /salva 1 bambino/i }))
    await waitFor(() => expect(postBody).toHaveLength(1))
    expect(postBody?.[0].dettagli).toMatchObject({ valore: ['Mela', 'Banana'] })
  })

  it('orario: un\'ora per bambino', async () => {
    await apri('Latte')
    fireEvent.change(within(rigaDi('Ada')).getByLabelText(/Latte.*Ada/), { target: { value: '10:30' } })
    fireEvent.click(screen.getByRole('button', { name: /salva 1 bambino/i }))
    await waitFor(() => expect(postBody).toHaveLength(1))
    expect(postBody?.[0].dettagli).toMatchObject({ risposta: 'orario', valore: '10:30' })
  })

  it('testo libero: una riga per bambino', async () => {
    await apri('Com\'è andata')
    fireEvent.change(within(rigaDi('Bruno')).getByLabelText(/Com'è andata.*Bruno/), { target: { value: 'ha giocato col trenino' } })
    fireEvent.click(screen.getByRole('button', { name: /salva 1 bambino/i }))
    await waitFor(() => expect(postBody).toHaveLength(1))
    expect(postBody?.[0].dettagli).toMatchObject({ risposta: 'testo', valore: 'ha giocato col trenino' })
  })
})
