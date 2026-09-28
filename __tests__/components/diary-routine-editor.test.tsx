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
/** La GET della configurazione fallisce (rete che si riconnette al risveglio). */
let configRotta = false
/** La GET dei bambini resta in volo finché il test non la rilascia. */
let trattieniBambini = false
let rilasciaBambini: (() => void) | null = null
/** La prossima POST resta in volo finché il test non la rilascia. */
let trattieniPost = false
let rilasciaPost: (() => void) | null = null
/** La GET dei bambini fallisce (rete). */
let bambiniRotti = false
/** Le POST finiscono davvero in archivio (la GET di dopo le restituisce). */
let persistiPost = false
/** La prossima GET della configurazione resta in volo; risponde con `config` com'è AL RILASCIO. */
let trattieniConfig = false
let rilasciaConfig: (() => void) | null = null

const BAMBINI = [
  { id: 'a1', nome: 'Ada', cognome: 'Bianchi', note_mediche: null },
  { id: 'b2', nome: 'Bruno', cognome: 'Verdi', note_mediche: null },
]

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) {
    if (configRotta) return jsonRes({ error: 'x' }, 503)
    if (trattieniConfig) { trattieniConfig = false; return new Promise<JsonRes>((ok) => { rilasciaConfig = () => ok(jsonRes(config)) }) }
    const sede = new URL(u, 'http://x').searchParams.get('scuola_id')
    return jsonRes(sede && configPerSede[sede] ? configPerSede[sede] : config)
  }
  if (u.includes('/api/diary/students')) {
    if (bambiniRotti) throw new TypeError('Failed to fetch')
    const soloPresenti = u.includes('onlyPresent=true')
    const risposta = jsonRes(soloPresenti && presenti ? BAMBINI.filter((b) => presenti!.includes(b.id)) : BAMBINI)
    if (trattieniBambini) {
      trattieniBambini = false
      return new Promise<JsonRes>((ok) => { rilasciaBambini = () => ok(risposta) })
    }
    return risposta
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') {
    postBody = JSON.parse(init.body ?? '[]')
    if (persistiPost) {
      for (const v of postBody ?? []) {
        entriesGet = (entriesGet as Array<Record<string, unknown>>).filter((e) => !(e.alunno_id === v.alunno_id && e.tipo_evento === v.tipo_evento))
        entriesGet.push({ alunno_id: v.alunno_id, tipo_evento: v.tipo_evento, orario_inizio: '2026-09-28T10:00:00Z', dettagli: v.dettagli, nota_bambino: v.nota_bambino ?? null })
      }
    }
    const risposta = postRisposta ? jsonRes(postRisposta.corpo, postRisposta.stato) : jsonRes([])
    if (trattieniPost) {
      trattieniPost = false
      return new Promise<JsonRes>((ok) => { rilasciaPost = () => ok(risposta) })
    }
    return risposta
  }
  if (u.includes('/api/diary/entries') && init?.method === 'DELETE') { deleteUrl = u; deleteUrls.push(u); return jsonRes({ eliminati: 1 }) }
  if (u.includes('/api/diary/entries')) return jsonRes(entriesGet)
  return jsonRes(null)
})

beforeEach(() => {
  config = { routine_attive: null, routine_personalizzate: [CREMA, BIBERON, MERENDE, BIBERON_ORA, APPUNTO, SPENTA] }
  configPerSede = {}
  postBody = null; postRisposta = null; deleteUrl = null; deleteUrls = []; entriesGet = []; presenti = null
  configRotta = false; trattieniBambini = false; rilasciaBambini = null
  trattieniPost = false; rilasciaPost = null; bambiniRotti = false; persistiPost = false
  trattieniConfig = false; rilasciaConfig = null
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

  it('…l\'orario svuotato idem; e con una nota la riga resta, col valore tolto (terzo giro)', async () => {
    // Fino al terzo giro la riga usciva con la sua nota, come per la nanna. Per umore e routine
    // della scuola la nota resta: la maestra ha tolto il valore, non quello che ha scritto.
    entriesGet = [
      voceSalvata('a1', 'routine:b0b0b0b0', { nome: 'Latte', emoji: '🥛', risposta: 'orario', valore: '10:30' }, { nota_bambino: 'ha bevuto tutto' }),
      voceSalvata('b2', 'routine:b0b0b0b0', { nome: 'Latte', emoji: '🥛', risposta: 'orario', valore: '11:00' }),
    ]
    const result = await monta()
    await apriTipo(result, 'routine:b0b0b0b0')
    act(() => { result.current.updateStudent('a1', { valore: null }) })
    act(() => { result.current.updateStudent('b2', { valore: null }) })
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(1)
    expect(deleteUrl).toContain('alunno_id=b2')
    expect(postBody).toEqual([expect.objectContaining({ alunno_id: 'a1', azzera_valore: true, nota_bambino: 'ha bevuto tutto' })])
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
    // Si aspetta la LISTA di «Tutti», non il filtro: è la lista a schermo che decide (terzo giro).
    await waitFor(() => expect(result.current.listaSoloPresenti).toBe(false))
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

/** Nasconde e rimostra la pagina: il «ritorno in primo piano» di `usePollingVisibile`. */
function ritornoInPrimoPiano() {
  const nascosta = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  if (nascosta) Object.defineProperty(document, 'hidden', nascosta)
  else delete (document as unknown as Record<string, unknown>).hidden
}

describe('terzo giro della revisione — la maestra (2026-09-28)', () => {
  it('ALTA · una rilettura FALLITA al risveglio non butta la configurazione buona: il riquadro resta aperto, coi segni', async () => {
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('a1', { valore: true }) })
    configRotta = true
    ritornoInPrimoPiano()
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/diary/config')).length).toBeGreaterThan(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(result.current.selectedEvent).toBe('routine:a1b2c3d4')
    expect(result.current.eventTypes).toContain('routine:a1b2c3d4')
    expect(result.current.daSalvare).toBe(1)
  })

  it('«Fatto per tutti» non segna gli assenti nemmeno mentre la lista dei presenti sta arrivando', async () => {
    presenti = ['a1']
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(1))
    act(() => { result.current.toggleShowAll() })
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    await apriTipo(result, 'routine:a1b2c3d4')
    // Torna a «Solo presenti»: la lista nuova resta in volo, a schermo c'è ancora «Tutti».
    trattieniBambini = true
    act(() => { result.current.toggleShowAll() })
    act(() => { result.current.segnaTuttiFatto() })
    expect(result.current.daSalvare, 'ha segnato anche l\'assente').toBe(0)
    act(() => { rilasciaBambini?.() })
    await waitFor(() => expect(result.current.students).toHaveLength(1))
    act(() => { result.current.segnaTuttiFatto() })
    expect(result.current.daSalvare).toBe(1)
  })

  it('rinominata un\'opzione a riquadro aperto, il valore vecchio non blocca più ogni salvataggio', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] })]
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    // La segreteria rinomina «Poco»: il server rifiuta il lotto che contiene ancora ['Poco'].
    config = { routine_attive: null, routine_personalizzate: [{ ...BIBERON, opzioni: ['Un po\'', 'Metà', 'Tutto'] }] }
    act(() => { result.current.updateStudent('a1', { valore: ['Tutto'] }) })
    postRisposta = { corpo: { error: 'x', codice: 'ROUTINE_VALORE_NON_VALIDO' }, stato: 422 }
    await act(async () => { await result.current.handleSave() })
    // Riletta la configurazione, il valore di Bruno diventa «non più previsto» (col cestino), e il
    // salvataggio dopo non lo rimanda.
    await waitFor(() => expect(result.current.nonPiuValidi).toHaveProperty('b2'))
    postRisposta = null
    await act(async () => { await result.current.handleSave() })
    expect(postBody?.map((v) => v.alunno_id)).toEqual(['a1'])
    expect(deleteUrls, 'il valore non più previsto non si cancella da solo').toEqual([])
  })

  it('tolto il valore ma lasciata la nota: la nota resta, e il valore se ne va (niente DELETE)', async () => {
    entriesGet = [voceSalvata('b2', 'routine:a1b2c3d4', CREMA_FATTA, { nota_bambino: 'ha la pelle arrossata' })]
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('b2', { valore: null }) })
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toEqual([])
    expect(postBody).toEqual([expect.objectContaining({ alunno_id: 'b2', nota_bambino: 'ha la pelle arrossata', azzera_valore: true, dettagli: expect.objectContaining({ valore: null }) })])
  })

  it('cancellata l\'ultima voce di una routine spenta, il riquadro in sola lettura si chiude', async () => {
    config = { routine_attive: ['pasto'], routine_personalizzate: [] }
    entriesGet = [voceSalvata('b2', 'bagno', { pipi: 2 })]
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.tipiSpenti).toContain('bagno'))
    await act(async () => { await result.current.handleEventSelect('bagno') })
    entriesGet = []
    await act(async () => { await result.current.eliminaRegistrazione('b2') })
    await waitFor(() => expect(result.current.selectedEvent).toBeNull())
  })

  it('salvato un valore nuovo a chi aveva un valore «non più previsto», l\'avviso se ne va', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Doppio'] })]
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    expect(result.current.nonPiuValidi).toHaveProperty('b2')
    act(() => { result.current.updateStudent('b2', { valore: ['Tutto'] }) })
    postRisposta = { corpo: [{ alunno_id: 'b2' }], stato: 200 }
    await act(async () => { await result.current.handleSave() })
    expect(result.current.nonPiuValidi).not.toHaveProperty('b2')
  })
})

describe('quarto giro della revisione — la maestra (2026-09-28)', () => {
  const RINOMINATA = { ...BIBERON, opzioni: ['Un po\'', 'Metà', 'Tutto'] }

  it('la riconciliazione guarda l\'ARCHIVIO, non la spunta: toccata solo la nota, il valore salvato diventa «non più previsto»', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] })]
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    act(() => { result.current.updateNotaBambino('b2', 'ha bevuto dal bicchiere') })
    expect(result.current.savedStudentIds.has('b2')).toBe(false)
    config = { routine_attive: null, routine_personalizzate: [RINOMINATA] }
    ritornoInPrimoPiano()
    await waitFor(() => expect(result.current.nonPiuValidi).toHaveProperty('b2'))
    expect(result.current.daTogliere, 'niente DELETE di un valore che la maestra non ha toccato').toBe(0)
  })

  it('un valore NON salvato che non vale più torna a quello d\'archivio (se vale ancora), e lo si dice', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Metà'] })]
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    act(() => { result.current.updateStudent('b2', { valore: ['Poco'] }) })
    config = { routine_attive: null, routine_personalizzate: [RINOMINATA] }
    ritornoInPrimoPiano()
    await waitFor(() => expect(result.current.studentStates.b2?.valore).toEqual(['Metà']))
    expect(result.current.segniTolti).toBe(1)
    expect(result.current.nonPiuValidi).not.toHaveProperty('b2')
  })

  it('207 con errori: nessuna spunta a chi non è stato salvato, e la maestra lo sa', async () => {
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('a1', { valore: true }) })
    postRisposta = { corpo: { saved: [], errors: [{ alunno_id: 'a1', error: 'x' }] }, stato: 207 }
    await act(async () => { await result.current.handleSave() })
    expect(result.current.savedStudentIds.has('a1')).toBe(false)
    expect(avviso).toHaveBeenCalledWith(expect.stringMatching(/non è stata salvata|non sono state salvate/))
  })

  it('una rilettura che arriva MENTRE il salvataggio è in volo aspetta la fine: niente DELETE mai chiesta dopo', async () => {
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    act(() => { result.current.updateStudent('a1', { valore: ['Poco'] }) })
    trattieniPost = true
    persistiPost = true
    postRisposta = { corpo: [{ alunno_id: 'a1' }], stato: 200 }
    let salvataggio: Promise<void> = Promise.resolve()
    act(() => { salvataggio = result.current.handleSave() })
    await waitFor(() => expect(rilasciaPost).not.toBeNull())
    config = { routine_attive: null, routine_personalizzate: [RINOMINATA] }
    ritornoInPrimoPiano()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await act(async () => { rilasciaPost?.(); await salvataggio })
    await waitFor(() => expect(result.current.nonPiuValidi).toHaveProperty('a1'))
    expect(result.current.daTogliere).toBe(0)
  })

  it('una riga di SOLA nota, svuotata la nota, esce dall\'archivio', async () => {
    entriesGet = [voceSalvata('b2', 'routine:a1b2c3d4', { nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: null }, { nota_bambino: 'domani la crema' })]
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateNotaBambino('b2', '') })
    expect(result.current.daTogliere).toBe(1)
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrl).toContain('alunno_id=b2')
  })

  it('cambiata sezione e fallita la lettura dei bambini, non resta la lista della sezione di prima', async () => {
    const { result, rerender } = renderHook((p: { sez: string }) => useDiaryDay('u1', p.sez), { initialProps: { sez: 'Girasoli' } })
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    bambiniRotti = true
    rerender({ sez: 'Tulipani' })
    await waitFor(() => expect(result.current.students).toHaveLength(0))
  })
})

describe('quinto giro della revisione — la maestra (2026-09-28)', () => {
  const RINOMINATA = { ...BIBERON, opzioni: ['Un po\'', 'Metà', 'Tutto'] }

  it('una rilettura durante un salvataggio che FALLISCE non cancella i segni non salvati (pasti compresi)', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    // Un altro bambino ha il pranzo in archivio: un ripristino dall'archivio riscriverebbe lo stato.
    entriesGet = [voceSalvata('b2', 'pranzo', { corsi: { primo: 'tutto', secondo: null, contorno: null, frutta: null } })]
    const result = await monta()
    await apriTipo(result, 'pranzo')
    act(() => { result.current.updateMealCourse('a1', 'primo', 'meta') })
    trattieniPost = true
    postRisposta = { corpo: { error: 'boom' }, stato: 500 }
    let salvataggio: Promise<void> = Promise.resolve()
    act(() => { salvataggio = result.current.handleSave() })
    await waitFor(() => expect(rilasciaPost).not.toBeNull())
    ritornoInPrimoPiano()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await act(async () => { rilasciaPost?.(); await salvataggio })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect((result.current.studentStates.a1?.corsi as Record<string, unknown>)?.primo).toBe('meta')
  })

  it('valore «non più previsto» con una nota: salvare altro e poi togliere la nota NON cancella il valore; la nota se ne va', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] }, { nota_bambino: 'dal bicchiere' })]
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    config = { routine_attive: null, routine_personalizzate: [RINOMINATA] }
    ritornoInPrimoPiano()
    await waitFor(() => expect(result.current.nonPiuValidi).toHaveProperty('b2'))
    act(() => { result.current.updateStudent('a1', { valore: ['Tutto'] }) })
    await act(async () => { await result.current.handleSave() })
    act(() => { result.current.updateNotaBambino('b2', '') })
    expect(result.current.daTogliere).toBe(0)
    postBody = null
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toEqual([])
    // Ogni salvataggio rimanda anche chi è già salvato (a1): conta che parta b2, con la nota vuota
    // e SENZA `azzera_valore` — il valore «non più previsto» resta in archivio.
    const b2 = (postBody as Array<Record<string, unknown>> | null)?.find((v) => v.alunno_id === 'b2')
    // Col segnale `togli_nota` (quinto giro): senza, il server la trattava come voce muta e la
    // saltava, e il client la dava per salvata.
    expect(b2).toMatchObject({ nota_bambino: null, togli_nota: true })
    expect(b2).not.toHaveProperty('azzera_valore')
  })

  it('le righe salvate per la sola nota di SEZIONE non si cancellano svuotando la casella', async () => {
    config = { routine_attive: ['umore'], routine_personalizzate: [] }
    const result = await monta()
    await apriTipo(result, 'umore')
    act(() => { result.current.setNotaLibera('Oggi festa') })
    await act(async () => { await result.current.handleSave() })
    act(() => { result.current.setNotaLibera('') })
    act(() => { result.current.updateStudent('a1', { umore: 'felice' }) })
    expect(result.current.daTogliere).toBe(0)
  })

  it('un testo di soli spazi non conta come «segno tolto» a ogni rilettura', async () => {
    const result = await monta()
    await apriTipo(result, 'routine:d0d0d0d0')
    act(() => { result.current.updateStudent('a1', { valore: '   ' }) })
    ritornoInPrimoPiano()
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/diary/config')).length).toBeGreaterThan(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(result.current.segniTolti).toBe(0)
  })
})

describe('sesto giro — la risposta del server decide chi è salvato', () => {
  it('una POST che risponde `[]` (voci saltate dal server) non dà spunte né «Salvato»', async () => {
    const result = await monta()
    await apriTipo(result, 'routine:a1b2c3d4')
    act(() => { result.current.updateStudent('a1', { valore: true }) })
    postRisposta = { corpo: [], stato: 200 }
    await act(async () => { await result.current.handleSave() })
    expect(result.current.savedStudentIds.has('a1')).toBe(false)
    expect(result.current.showSavedToast).toBe(false)
  })
})

describe('sesto giro — la rilettura fra la fine del salvataggio e il suo render', () => {
  it('il valore appena salvato non diventa «segno tolto» né una DELETE pronta (sonda del revisore)', async () => {
    const RINOMINATA = { ...BIBERON, opzioni: ['Un po\'', 'Metà', 'Tutto'] }
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    act(() => { result.current.updateStudent('a1', { valore: ['Poco'] }) })
    trattieniPost = true
    postRisposta = { corpo: [{ alunno_id: 'a1' }], stato: 200 }
    let salvataggio: Promise<void> = Promise.resolve()
    act(() => { salvataggio = result.current.handleSave() })
    await waitFor(() => expect(rilasciaPost).not.toBeNull())
    trattieniConfig = true
    ritornoInPrimoPiano()
    await waitFor(() => expect(rilasciaConfig).not.toBeNull())
    // Fuori da `act`: la POST torna e il `finally` gira nei microtask; il render è più tardi.
    rilasciaPost?.()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    config = { routine_attive: null, routine_personalizzate: [RINOMINATA] }
    rilasciaConfig?.()
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await act(async () => { await salvataggio })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(result.current.daTogliere, 'DELETE pronta sul valore appena salvato').toBe(0)
    expect(result.current.nonPiuValidi).toHaveProperty('a1')
  })
})

describe('settimo giro — valore nuovo e nota tolta insieme', () => {
  it('scelto un valore NUOVO e valido e tolta la nota: niente `togli_nota`, il valore nuovo si salva', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Doppio'] }, { nota_bambino: 'dal bicchiere' })]
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    expect(result.current.nonPiuValidi).toHaveProperty('b2')
    act(() => { result.current.updateStudent('b2', { valore: ['Tutto'] }) })
    act(() => { result.current.updateNotaBambino('b2', '') })
    await act(async () => { await result.current.handleSave() })
    const b2 = (postBody as Array<Record<string, unknown>> | null)?.find((v) => v.alunno_id === 'b2')
    expect(b2).not.toHaveProperty('togli_nota')
    expect(b2).toMatchObject({ dettagli: expect.objectContaining({ valore: ['Tutto'] }), nota_bambino: null })
  })

  it('tolta la sola nota di un valore «non più previsto», la ✅ non torna accanto all\'avviso', async () => {
    entriesGet = [voceSalvata('b2', 'routine:e5f6a7b8', { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Doppio'] }, { nota_bambino: 'dal bicchiere' })]
    const result = await monta()
    await apriTipo(result, 'routine:e5f6a7b8')
    act(() => { result.current.updateNotaBambino('b2', '') })
    postRisposta = { corpo: [{ alunno_id: 'b2' }], stato: 200 }
    await act(async () => { await result.current.handleSave() })
    expect(result.current.nonPiuValidi).toHaveProperty('b2')
    expect(result.current.savedStudentIds.has('b2')).toBe(false)
  })
})
