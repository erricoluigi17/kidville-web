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
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }))

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
/** Configurazione per sede, quando un test ne vuole più d'una (`?scuola_id=`). */
let configPerSede: Record<string, Record<string, unknown>> = {}
let postBody: Array<Record<string, unknown>> | null = null
let postRisposta: { corpo: unknown; stato: number } | null = null
let deleteUrl: string | null = null
let deleteUrls: string[] = []
let entriesGet: unknown[] = []
/** `null` = tutti presenti. Altrimenti gli id dei presenti (il filtro «Solo presenti»). */
let presenti: string[] | null = null

const BAMBINI = [
  { id: 'a1', nome: 'Ada', cognome: 'Bianchi', note_mediche: null },
  { id: 'b2', nome: 'Bruno', cognome: 'Verdi', note_mediche: null },
]

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) {
    const sede = new URL(u, 'http://x').searchParams.get('scuola_id')
    return jsonRes(sede && configPerSede[sede] ? configPerSede[sede] : config)
  }
  if (u.includes('/api/diary/students')) {
    const soloPresenti = u.includes('onlyPresent=true')
    return jsonRes(soloPresenti && presenti ? BAMBINI.filter((b) => presenti!.includes(b.id)) : BAMBINI)
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') {
    postBody = JSON.parse(init.body ?? '[]')
    return postRisposta ? jsonRes(postRisposta.corpo, postRisposta.stato) : jsonRes([])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'DELETE') { deleteUrl = u; deleteUrls.push(u); return jsonRes({ eliminati: 1 }) }
  if (u.includes('/api/diary/entries')) return jsonRes(entriesGet)
  return jsonRes(null)
})

beforeEach(() => {
  config = { routine_attive: null, routine_personalizzate: [CREMA, BIBERON, MERENDE, BIBERON_ORA, APPUNTO, SPENTA] }
  configPerSede = {}
  postBody = null; postRisposta = null; deleteUrl = null; deleteUrls = []; entriesGet = []; presenti = null
  invalidaDiarioConfigCache()
  fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function monta(opts?: { scuolaId?: string | null }) {
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

/** La riga di un bambino nel pannello aperto: un gruppo col suo nome (non un `data-testid` con l'uuid). */
const NOMI: Record<string, string> = { Ada: 'Ada Bianchi', Bruno: 'Bruno Verdi' }
const rigaDi = (nome: string) => screen.getByRole('group', { name: NOMI[nome] })

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

const voceSalvata = (alunno: string, tipo: string, dettagli: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ alunno_id: alunno, tipo_evento: tipo, orario_inizio: '2026-09-28T09:00:00Z', dettagli, ...extra })
const CREMA_FATTA = { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: true }

async function apriTipo(result: { current: ReturnType<typeof useDiaryDay> }, tipo: string) {
  await waitFor(() => expect(result.current.eventTypes).toContain(tipo))
  await act(async () => { await result.current.handleEventSelect(tipo as never) })
}

describe('seconda revisione critica — la maestra (2026-09-28)', () => {
  it('ALTA · un bambino comparso con «Tutti» DOPO l\'apertura, segnato, si salva davvero', async () => {
    // Prima lo stato dei nuovi arrivati nasceva senza fotografia: `{valore:true}` senza
    // `risposta`, che `routineCompilata` non riconosce. Bottone premuto, toast verde, niente in archivio.
    presenti = ['a1']
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(1))
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.toggleShowAll() })
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    act(() => { result.current.updateStudent('b2', { valore: true }) })
    expect(result.current.daSalvare).toBe(1)
    await act(async () => { await result.current.handleSave() })
    expect(postBody).toEqual([expect.objectContaining({ alunno_id: 'b2', dettagli: CREMA_FATTA })])
  })

  it('svuota e salva = cancella, come per la nanna: «Fatto» spento su chi l\'aveva salvato manda la DELETE', async () => {
    entriesGet = [voceSalvata('b2', 'routine:a1b2c3d4', CREMA_FATTA)]
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('b2', { valore: null }) })
    expect(result.current.daTogliere).toBe(1)
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrl).toContain('alunno_id=b2')
    expect(deleteUrl).toContain('tipo_evento=routine%3Aa1b2c3d4')
    expect(postBody).toBeNull()
  })

  it('…anche con una nota: la riga esce con la sua nota, e l\'orario svuotato idem', async () => {
    entriesGet = [voceSalvata('a1', 'routine:b0b0b0b0', { nome: 'Latte', emoji: '🥛', risposta: 'orario', valore: '10:30' }, { nota_bambino: 'ha bevuto tutto' })]
    const result = await monta()
    await apriTipo(result, 'routine:b0b0b0b0')
    act(() => { result.current.updateStudent('a1', { valore: null }) })
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrl).toContain('alunno_id=a1')
  })

  it('un valore salvato che la routine non prevede più NON sparisce: si vede, col cestino, e non si cancella da solo', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Doppio'] })]
    render(<Editor />)
    fireEvent.click(await screen.findByRole('button', { name: /Registra Biberon/ }))
    const riga = await waitFor(() => rigaDi('Bruno'))
    expect(within(riga).getByText(/Doppio/)).toBeInTheDocument()
    expect(within(riga).getByRole('button', { name: /elimina/i })).toBeInTheDocument()
    // Segnare un ALTRO bambino e salvare non tocca quello di Bruno.
    fireEvent.click(within(rigaDi('Ada')).getByRole('button', { name: 'Poco' }))
    fireEvent.click(screen.getByRole('button', { name: /salva 1 bambino/i }))
    await waitFor(() => expect(postBody).toHaveLength(1))
    expect(deleteUrls).toEqual([])
  })

  it('«Fatto per tutti» c\'è solo col filtro «Solo presenti»: con «Tutti» segnerebbe anche gli assenti', async () => {
    function ConFiltro() {
      const day = useDiaryDay('u1', 'Girasoli')
      return (<>
        <button type="button" onClick={day.toggleShowAll}>filtro</button>
        <DiaryEventEditor day={day} sezione="Girasoli" />
      </>)
    }
    render(<ConFiltro />)
    fireEvent.click(await screen.findByRole('button', { name: /Registra Crema solare/ }))
    expect(await screen.findByRole('button', { name: /fatto per tutti/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'filtro' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /fatto per tutti/i })).not.toBeInTheDocument())
    expect(screen.getByText(/Solo presenti/)).toBeInTheDocument()
  })

  it('il gesto «Fatto per tutti» non fa niente con «Tutti» (cintura dell\'hook)', async () => {
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.toggleShowAll() })
    await waitFor(() => expect(result.current.showAll).toBe(true))
    act(() => { result.current.segnaTuttiFatto() })
    expect(result.current.daSalvare).toBe(0)
  })

  it('nel DOM non resta l\'uuid di un bambino', async () => {
    const { container } = render(<Editor />)
    fireEvent.click(await screen.findByRole('button', { name: /Registra Crema solare/ }))
    await screen.findByRole('group', { name: 'Ada Bianchi' })
    expect(container.innerHTML).not.toContain('a1"')
    expect(container.querySelector('[data-testid^="routine-riga-"]')).toBeNull()
  })

  it('422 ROUTINE_NON_DISPONIBILE: la configurazione si rilegge, la routine sparisce e il pannello si chiude', async () => {
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('a1', { valore: true }) })
    postRisposta = { corpo: { error: 'x', codice: 'ROUTINE_NON_DISPONIBILE' }, stato: 422 }
    config = { routine_attive: null, routine_personalizzate: [BIBERON] }
    const configPrima = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/diary/config')).length
    await act(async () => { await result.current.handleSave() })
    await waitFor(() => expect(result.current.eventTypes).not.toContain('routine:a1b2c3d4'))
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/diary/config')).length).toBeGreaterThan(configPrima)
    expect(result.current.selectedEvent).toBeNull()
    expect(avviso).toHaveBeenCalledWith(expect.stringMatching(/non è più disponibile/))
  })

  it('503 ROUTINE_NON_VERIFICATE: la maestra legge il perché, non «errore nel salvataggio»', async () => {
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('a1', { valore: true }) })
    postRisposta = { corpo: { error: 'x', codice: 'ROUTINE_NON_VERIFICATE' }, stato: 503 }
    await act(async () => { await result.current.handleSave() })
    expect(avviso).toHaveBeenCalledWith(expect.stringMatching(/verificare le routine/))
  })

  it('al ritorno in primo piano le routine della sede si rileggono', async () => {
    const result = await monta()
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    config = { routine_attive: null, routine_personalizzate: [CREMA, { ...BIBERON, id: 'c1c1c1c1', nome: 'Nuova' }] }
    const nascosta = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:c1c1c1c1'))
    if (nascosta) Object.defineProperty(document, 'hidden', nascosta)
    else delete (document as unknown as Record<string, unknown>).hidden
  })

  it('con la sede ancora da decidere (`null`) la configurazione non si chiede: niente lampo delle routine sbagliate', async () => {
    const { result, rerender } = renderHook((p: { sede: string | null }) => useDiaryDay('u1', 'Girasoli', { scuolaId: p.sede }), { initialProps: { sede: null as string | null } })
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/diary/config'))).toBe(false)
    expect(result.current.eventTypes).toEqual([])
    rerender({ sede: SEDE })
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    const chieste = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/diary/config'))
    expect(chieste).toHaveLength(1)
    expect(chieste[0]).toContain(`scuola_id=${SEDE}`)
  })

  it('cambiata la sede, restano le routine di quella nuova, e un pannello che lì non esiste si chiude', async () => {
    const ALTRA = 'bbbbbbbb-0000-4000-8000-00000000000b'
    configPerSede = { [SEDE]: { routine_attive: null, routine_personalizzate: [CREMA] }, [ALTRA]: { routine_attive: null, routine_personalizzate: [] } }
    const { result, rerender } = renderHook((p: { sede: string }) => useDiaryDay('u1', 'Girasoli', { scuolaId: p.sede }), { initialProps: { sede: SEDE } })
    await waitFor(() => expect(result.current.eventTypes).toContain('routine:a1b2c3d4'))
    await act(async () => { await result.current.handleEventSelect('routine:a1b2c3d4') })
    rerender({ sede: ALTRA })
    await waitFor(() => expect(result.current.eventTypes).toEqual(['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno']))
    expect(result.current.selectedEvent).toBeNull()
  })
})

describe('seconda revisione critica — routine spente con voci di oggi: sola lettura, col cestino', () => {
  it('una routine BASE spenta con un bagno di oggi: tessera «spenta», pannello senza Salva, cestino che cancella', async () => {
    config = { routine_attive: ['pasto'], routine_personalizzate: [] }
    entriesGet = [voceSalvata('b2', 'bagno', { pipi: 2, cacca: 0, vasino: 0 })]
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Editor />)
    fireEvent.click(await screen.findByRole('button', { name: /Bagno.*spenta/i }))
    const riga = await screen.findByRole('group', { name: 'Bruno Verdi' })
    expect(within(riga).getByText(/💧\s*2/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^salva/i })).not.toBeInTheDocument()
    fireEvent.click(within(riga).getByRole('button', { name: /elimina/i }))
    await waitFor(() => expect(deleteUrl).toContain('tipo_evento=bagno'))
    expect(deleteUrl).toContain('alunno_id=b2')
  })

  it('una routine della SCUOLA cancellata dal pannello, con voci di oggi: nome e icona dalla fotografia', async () => {
    config = { routine_attive: null, routine_personalizzate: [] }
    entriesGet = [voceSalvata('a1', 'routine:a1b2c3d4', CREMA_FATTA)]
    render(<Editor />)
    fireEvent.click(await screen.findByRole('button', { name: /Crema solare.*spenta/i }))
    const riga = await screen.findByRole('group', { name: 'Ada Bianchi' })
    expect(within(riga).getByText('Fatto')).toBeInTheDocument()
  })

  it('senza voci di oggi, una routine spenta non compare affatto', async () => {
    config = { routine_attive: ['pasto'], routine_personalizzate: [] }
    render(<Editor />)
    await screen.findByRole('button', { name: /Registra Pranzo/ })
    expect(screen.queryByRole('button', { name: /spenta/i })).not.toBeInTheDocument()
  })
})
