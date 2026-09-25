import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor, render, screen, fireEvent } from '@testing-library/react'
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor'

// SVUOTARE L'ORARIO E SALVARE CANCELLA LA REGISTRAZIONE (N1, decisione del 24/09).
//
// Il difetto: col salvataggio selettivo un campo vuoto ESCLUDE il bambino dal
// payload. La POST parte senza di lui (o non parte), la riga resta in archivio con
// l'orario di prima, e a schermo il campo è vuoto e il toast è verde. Il genitore
// continua a leggere «ha dormito dalle 13:05».
//
// La regola: chi AVEVA una registrazione salvata oggi di quel tipo e ora ha il
// campo vuoto esce dall'archivio con la DELETE di QUEL SOLO tipo. Nanna e Sveglia
// sono due righe, e svuotarne una non tocca l'altra.

vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown): JsonRes => ({ ok: true, status: 200, json: async () => data })
const erroreRes = (status: number): JsonRes => ({ ok: false, status, json: async () => ({ error: 'ko' }) })

let postBodies: Array<Array<Record<string, unknown>>> = []
let deleteUrls: string[] = []
let entriesGet: unknown[] = []
let esitoDelete: (url: string) => JsonRes = () => jsonRes({ eliminati: 1 })
/** Quante delle prossime GET di /api/diary/entries restano IN VOLO finché il test non le rilascia. */
let getDaTrattenere = 0
/** Le GET trattenute, in ordine: `rilascia(i)` le fa rispondere con l'archivio di oggi. */
let getTrattenute: Array<(r: JsonRes) => void> = []
const rilascia = (i: number) => getTrattenute[i](jsonRes(entriesGet))
/** Se vero, la prossima POST resta in volo finché il test non chiama `rilasciaPost`. */
let trattieniPost = false
let rilasciaPost: (() => void) | null = null
/** Se vero, la prossima DELETE resta in volo finché il test non chiama `rilasciaDelete`. */
let trattieniDelete = false
let rilasciaDelete: (() => void) | null = null

const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes({ routine_attive: [] })
  if (u.includes('/api/diary/students')) {
    return jsonRes([
      { id: 'a1', nome: 'Anna', cognome: 'Prova', note_mediche: null },
      { id: 'b2', nome: 'Bruno', cognome: 'Prova', note_mediche: null },
    ])
  }
  if (u.includes('/api/diary/entries') && init?.method === 'POST') {
    const body = JSON.parse(init.body ?? '[]') as Array<Record<string, unknown>>
    postBodies.push(body)
    const risposta = jsonRes(body.map((r) => ({ alunno_id: r.alunno_id })))
    if (trattieniPost) {
      trattieniPost = false
      return new Promise<JsonRes>((risolvi) => { rilasciaPost = () => risolvi(risposta) })
    }
    return risposta
  }
  if (u.includes('/api/diary/entries') && init?.method === 'DELETE') {
    deleteUrls.push(u)
    if (trattieniDelete) {
      trattieniDelete = false
      // L'esito si decide al rilascio, come per una risposta vera che arriva tardi.
      return new Promise<JsonRes>((risolvi) => { rilasciaDelete = () => risolvi(esitoDelete(u)) })
    }
    return esitoDelete(u)
  }
  if (u.includes('/api/diary/entries')) {
    if (getDaTrattenere > 0) {
      getDaTrattenere -= 1
      return new Promise<JsonRes>((risolvi) => { getTrattenute.push(risolvi) })
    }
    return jsonRes(entriesGet)
  }
  return jsonRes(null)
})

/** I parametri di ogni DELETE partita, letti come query e non come sottostringa. */
const deleteParams = () => deleteUrls.map((u) => new URL(u, 'http://x').searchParams)

const alertMock = vi.fn()

beforeEach(() => {
  postBodies = []
  deleteUrls = []
  entriesGet = []
  esitoDelete = () => jsonRes({ eliminati: 1 })
  getDaTrattenere = 0
  getTrattenute = []
  trattieniPost = false
  rilasciaPost = null
  trattieniDelete = false
  rilasciaDelete = null
  fetchMock.mockClear()
  alertMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', alertMock)
})
afterEach(() => { vi.unstubAllGlobals() })

async function montaSuEvento(evento: 'nanna_inizio' | 'nanna_fine') {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
  await waitFor(() => expect(result.current.students).toHaveLength(2))
  await act(async () => { await result.current.handleEventSelect(evento) })
  return result
}

const riga = (alunno: string, tipo: string, dettagli: Record<string, unknown>) =>
  ({ alunno_id: alunno, tipo_evento: tipo, orario_inizio: '2026-09-24T11:00:00Z', dettagli })

describe.each([
  { evento: 'nanna_inizio' as const, campo: 'orario_inizio', altro: 'nanna_fine', ora: '13:05' },
  { evento: 'nanna_fine' as const, campo: 'orario_fine', altro: 'nanna_inizio', ora: '15:30' },
])('useDiaryDay — $evento svuotato e salvato', ({ evento, campo, altro, ora }) => {
  it('cancella la registrazione di QUEL bambino e di QUEL SOLO tipo; gli altri si salvano come oggi', async () => {
    entriesGet = [
      riga('a1', evento, { [campo]: '13:10' }),
      riga('b2', evento, { [campo]: ora }),
      // La riga dell'altro tipo, stesso bambino: non deve essere toccata.
      riga('b2', altro, { [altro === 'nanna_fine' ? 'orario_fine' : 'orario_inizio']: '15:00' }),
    ]
    const result = await montaSuEvento(evento)
    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.daTogliere).toBe(0)

    act(() => { result.current.updateStudent('b2', { [campo]: '' }) })
    // La ✅ se n'è già andata, ma la riga da togliere è ancora contata.
    expect(result.current.savedStudentIds.has('b2')).toBe(false)
    expect(result.current.daTogliere).toBe(1)

    await act(async () => { await result.current.handleSave() })

    // a1 si salva come oggi, b2 NON entra nella POST.
    expect(postBodies).toHaveLength(1)
    expect(postBodies[0].map((r) => r.alunno_id)).toEqual(['a1'])

    // Una DELETE sola: b2, del tipo svuotato, di oggi.
    const params = deleteParams()
    expect(params).toHaveLength(1)
    expect(params[0].get('alunno_id')).toBe('b2')
    expect(params[0].get('tipo_evento')).toBe(evento)
    expect(params[0].getAll('tipo_evento')).toEqual([evento])
    expect(params[0].get('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // L'esito si vede: spunta tolta, campo vuoto, messaggio.
    expect(result.current.savedStudentIds.has('b2')).toBe(false)
    expect(result.current.savedStudentIds.has('a1')).toBe(true)
    expect(result.current.studentStates.b2[campo]).toBe('')
    expect(result.current.esitoSalvataggio).toEqual({ salvati: 1, tolti: 1 })
    expect(result.current.showSavedToast).toBe(true)
    // E non resta niente da togliere: un secondo Salva non ricancella.
    expect(result.current.daTogliere).toBe(0)
  })

  it('con il SOLO campo svuotato: nessuna POST, una DELETE, e il pulsante non è un no-op', async () => {
    entriesGet = [riga('b2', evento, { [campo]: ora })]
    const result = await montaSuEvento(evento)

    act(() => { result.current.updateStudent('b2', { [campo]: '' }) })
    expect(result.current.daSalvare).toBe(0)
    expect(result.current.daTogliere).toBe(1)

    await act(async () => { await result.current.handleSave() })

    expect(postBodies).toHaveLength(0)
    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['b2', evento]])
    expect(result.current.esitoSalvataggio).toEqual({ salvati: 0, tolti: 1 })
  })

  it('un bambino MAI registrato col campo vuoto non genera nessuna DELETE', async () => {
    entriesGet = [riga('b2', evento, { [campo]: ora })]
    const result = await montaSuEvento(evento)

    await act(async () => { await result.current.handleSave() })

    // b2 ha ancora l'orario → POST; a1 non è mai stato registrato → niente.
    expect(postBodies).toHaveLength(1)
    expect(deleteUrls).toHaveLength(0)
  })

  it('una riga d\'archivio già VUOTA (mai mostrata con la ✅) non si cancella al posto della maestra', async () => {
    entriesGet = [riga('a1', evento, { [campo]: '' }), riga('b2', evento, { [campo]: ora })]
    const result = await montaSuEvento(evento)
    expect(result.current.daTogliere).toBe(0)

    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(0)
  })

  it('se la DELETE fallisce: avviso, log con il codice, e lo schermo torna a mostrare ciò che c\'è in archivio', async () => {
    const { logClient } = await import('@/lib/logging/client')
    vi.mocked(logClient).mockClear()
    entriesGet = [riga('b2', evento, { [campo]: ora })]
    esitoDelete = () => erroreRes(500)
    const result = await montaSuEvento(evento)

    act(() => { result.current.updateStudent('b2', { [campo]: '' }) })
    await act(async () => { await result.current.handleSave() })

    expect(deleteUrls).toHaveLength(1)
    expect(alertMock).toHaveBeenCalledTimes(1)
    const chiamata = vi.mocked(logClient).mock.calls.find(([e]) => String(e.messaggio).includes('nanna-svuotata'))
    expect(chiamata).toBeDefined()
    expect(chiamata![0].livello).toBe('error')
    expect(String(chiamata![0].messaggio)).toContain('HTTP500')
    // Nessun nome nel log: solo tipo, conteggi e codice.
    expect(JSON.stringify(chiamata![0])).not.toMatch(/Bruno|Prova/)

    // Lo stato non finge il successo: orario d'archivio e ✅ tornano, niente toast.
    expect(result.current.studentStates.b2[campo]).toBe(ora)
    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.showSavedToast).toBe(false)

    // E al prossimo tentativo la riga è ancora da togliere: si ritenta.
    esitoDelete = () => jsonRes({ eliminati: 1 })
    act(() => { result.current.updateStudent('b2', { [campo]: '' }) })
    expect(result.current.daTogliere).toBe(1)
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(2)
    expect(result.current.studentStates.b2[campo]).toBe('')
    expect(result.current.savedStudentIds.has('b2')).toBe(false)
  })

  it('la NOTA DEL BAMBINO non salva la riga: campo vuoto ⇒ DELETE, e il bambino resta fuori dalla POST', async () => {
    entriesGet = [
      riga('a1', evento, { [campo]: '13:10' }),
      { ...riga('b2', evento, { [campo]: ora }), nota_bambino: 'nota di prova' },
    ]
    const result = await montaSuEvento(evento)
    expect(result.current.notaBambino.b2).toBe('nota di prova')

    act(() => { result.current.updateStudent('b2', { [campo]: '' }) })
    expect(result.current.daTogliere).toBe(1)
    expect(result.current.daSalvare).toBe(1)
    await act(async () => { await result.current.handleSave() })

    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['b2', evento]])
    expect(postBodies).toHaveLength(1)
    expect(postBodies.flat().map((r) => r.alunno_id)).toEqual(['a1'])
    // La riga è uscita con la sua nota: lo schermo non la mostra più.
    expect(result.current.notaBambino.b2 ?? '').toBe('')
    expect(result.current.esitoSalvataggio).toEqual({ salvati: 1, tolti: 1 })
  })

  it('la NOTA DI SEZIONE (che vale per tutti) non salva nessuna riga svuotata', async () => {
    entriesGet = [riga('a1', evento, { [campo]: '13:10' }), riga('b2', evento, { [campo]: ora })]
    const result = await montaSuEvento(evento)

    act(() => { result.current.setNotaLibera('nota di sezione') })
    act(() => { result.current.updateStudent('b2', { [campo]: '' }) })
    expect(result.current.daTogliere).toBe(1)
    expect(result.current.daSalvare).toBe(1)
    await act(async () => { await result.current.handleSave() })

    // DELETE per b2, del SOLO tipo aperto.
    const params = deleteParams()
    expect(params).toHaveLength(1)
    expect(params[0].get('alunno_id')).toBe('b2')
    expect(params[0].getAll('tipo_evento')).toEqual([evento])
    // b2 fuori da ogni POST; a1 salvato come oggi, con la nota di sezione.
    expect(postBodies).toHaveLength(1)
    expect(postBodies.flat().map((r) => r.alunno_id)).toEqual(['a1'])
    expect(postBodies[0][0].nota_libera).toBe('nota di sezione')
    expect((postBodies[0][0].dettagli as Record<string, unknown>)[campo]).toBe('13:10')
  })

  it('una riga d\'archivio col campo GIÀ vuoto e la sola nota non si cancella a un Salva qualsiasi', async () => {
    entriesGet = [
      { ...riga('a1', evento, { [campo]: '' }), nota_bambino: 'solo nota' },
      riga('b2', evento, { [campo]: ora }),
    ]
    const result = await montaSuEvento(evento)
    expect(result.current.daTogliere).toBe(0)

    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(0)
    // Come prima dell'intervento: la voce con la nota si risalva.
    expect(postBodies[0].map((r) => r.alunno_id).sort()).toEqual(['a1', 'b2'])
  })
})

describe('useDiaryDay — «aveva una registrazione» non dipende dalla ✅', () => {
  it('dopo «Tutti a nanna ora» (che toglie tutte le ✅) svuotare un orario registrato lo cancella', async () => {
    entriesGet = [riga('b2', 'nanna_inizio', { orario_inizio: '13:05' })]
    const result = await montaSuEvento('nanna_inizio')

    act(() => { result.current.bulkNannaOra() })
    expect(result.current.savedStudentIds.size).toBe(0)
    act(() => { result.current.updateStudent('b2', { orario_inizio: '' }) })
    await act(async () => { await result.current.handleSave() })

    expect(postBodies[0].map((r) => r.alunno_id)).toEqual(['a1'])
    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['b2', 'nanna_inizio']])
  })

  it('un orario salvato in QUESTA sessione e poi svuotato si cancella anch\'esso', async () => {
    const result = await montaSuEvento('nanna_fine')

    act(() => { result.current.updateStudent('a1', { orario_fine: '15:10' }) })
    await act(async () => { await result.current.handleSave() })
    expect(postBodies).toHaveLength(1)

    act(() => { result.current.updateStudent('a1', { orario_fine: '' }) })
    expect(result.current.daTogliere).toBe(1)
    await act(async () => { await result.current.handleSave() })

    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['a1', 'nanna_fine']])
  })

  it('una voce salvata con la sola nota di sezione e il campo vuoto non si cancella al Salva dopo', async () => {
    entriesGet = [riga('b2', 'nanna_inizio', { orario_inizio: '13:05' })]
    const result = await montaSuEvento('nanna_inizio')

    // a1 non ha mai avuto un orario: la nota di sezione lo porta nella POST col campo vuoto.
    act(() => { result.current.setNotaLibera('nota di sezione') })
    await act(async () => { await result.current.handleSave() })
    expect(postBodies[0].map((r) => r.alunno_id).sort()).toEqual(['a1', 'b2'])

    // Nessuno ha «svuotato» a1: il Salva successivo non deve toglierlo da solo.
    expect(result.current.daTogliere).toBe(0)
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(0)
  })

  it('le altre routine non cambiano: bagno azzerato e salvato NON chiama la DELETE', async () => {
    entriesGet = [riga('b2', 'bagno', { pipi: 1, cacca: 0, vasino: 0 })]
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(2))
    await act(async () => { await result.current.handleEventSelect('bagno') })

    act(() => { result.current.updateStudent('b2', { pipi: 0 }) })
    expect(result.current.daTogliere).toBe(0)
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(0)
  })
})

// UN RIPRISTINO ARRIVATO IN RITARDO NON DECIDE NESSUNA CANCELLAZIONE.
//
// La maestra tocca «Nanna» e subito dopo «Sveglia», e la GET partita per la Nanna
// risponde DOPO quella della Sveglia. Se la risposta vecchia scrive lo stato, il
// riquadro Sveglia si ritrova con i `dettagli` della Nanna (`{orario_inizio}`), e
// per il tipo aperto quel campo `orario_fine` è «vuoto»: il Salva cancellerebbe le
// Sveglie vere di ogni bambino con la Nanna registrata.
describe('useDiaryDay — le risposte fuori ordine', () => {
  async function montaConGetTrattenuta(primo: 'nanna_inizio' | 'bagno') {
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(2))

    // La GET del primo tipo resta in volo.
    getDaTrattenere = 1
    let primaSelezione: Promise<void> = Promise.resolve()
    act(() => { primaSelezione = result.current.handleEventSelect(primo) })
    await waitFor(() => expect(getTrattenute).toHaveLength(1))
    expect(result.current.selectedEvent).toBe(primo)

    // La Sveglia si apre e la sua GET risponde SUBITO.
    await act(async () => { await result.current.handleEventSelect('nanna_fine') })
    expect(result.current.selectedEvent).toBe('nanna_fine')
    expect(result.current.studentStates.b2.orario_fine).toBe('15:30')

    // Solo ora arriva la risposta del primo tipo.
    await act(async () => { rilascia(0); await primaSelezione })
    return result
  }

  it('la GET della Nanna arrivata dopo quella della Sveglia non fa partire DELETE di nanna_fine', async () => {
    entriesGet = [
      riga('a1', 'nanna_inizio', { orario_inizio: '13:05' }),
      riga('b2', 'nanna_inizio', { orario_inizio: '13:10' }),
      riga('b2', 'nanna_fine', { orario_fine: '15:30' }),
    ]
    const result = await montaConGetTrattenuta('nanna_inizio')

    // Lo stato è ancora quello della Sveglia: la risposta vecchia è stata scartata.
    expect(result.current.selectedEvent).toBe('nanna_fine')
    expect(result.current.studentStates.b2.orario_fine).toBe('15:30')
    expect(result.current.studentStates.b2.orario_inizio).toBeUndefined()
    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.savedStudentIds.has('a1')).toBe(false)
    expect(result.current.daTogliere).toBe(0)

    // La maestra compila un orario (il pulsante direbbe «Salva N bambini») e salva.
    act(() => { result.current.updateStudent('a1', { orario_fine: '15:40' }) })
    expect(result.current.daTogliere).toBe(0)
    await act(async () => { await result.current.handleSave() })

    expect(deleteUrls).toHaveLength(0)
    expect(postBodies).toHaveLength(1)
    const inviati = Object.fromEntries(postBodies[0].map((r) => [r.alunno_id, r]))
    expect(Object.keys(inviati).sort()).toEqual(['a1', 'b2'])
    expect(inviati.a1.tipo_evento).toBe('nanna_fine')
    expect(inviati.a1.dettagli).toMatchObject({ orario_fine: '15:40' })
    expect(inviati.b2.dettagli).toMatchObject({ orario_fine: '15:30' })
  })

  it('una GET VUOTA arrivata in ritardo non azzera ciò che la Sveglia ha in archivio', async () => {
    // Nessuna riga di bagno: la risposta in ritardo del bagno è «nessuna registrazione».
    entriesGet = [riga('b2', 'nanna_fine', { orario_fine: '15:30' })]
    const result = await montaConGetTrattenuta('bagno')

    expect(result.current.selectedEvent).toBe('nanna_fine')
    expect(result.current.savedStudentIds.has('b2')).toBe(true)

    // Svuotare la Sveglia registrata deve ancora cancellarla (il difetto N1).
    act(() => { result.current.updateStudent('b2', { orario_fine: '' }) })
    expect(result.current.daTogliere).toBe(1)
    await act(async () => { await result.current.handleSave() })

    expect(postBodies).toHaveLength(0)
    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['b2', 'nanna_fine']])
  })

  it('una POST della Nanna che finisce DOPO l\'apertura della Sveglia non le presta le sue righe', async () => {
    // Solo b2 ha una Sveglia in archivio; a1 non ha niente.
    entriesGet = [riga('b2', 'nanna_fine', { orario_fine: '15:30' })]
    const result = await montaSuEvento('nanna_inizio')

    // Salva la Nanna di a1, ma la POST resta in volo…
    act(() => { result.current.updateStudent('a1', { orario_inizio: '13:05' }) })
    trattieniPost = true
    let salvataggio: Promise<void> = Promise.resolve()
    act(() => { salvataggio = result.current.handleSave() })
    await waitFor(() => expect(rilasciaPost).not.toBeNull())

    // …mentre la maestra apre la Sveglia, e solo dopo la POST risponde.
    await act(async () => { await result.current.handleEventSelect('nanna_fine') })
    expect(result.current.studentStates.b2.orario_fine).toBe('15:30')
    expect(result.current.studentStates.a1.orario_fine).toBe('')
    await act(async () => { rilasciaPost?.(); await salvataggio })

    // Le ✅ della POST della Nanna non finiscono sulla Sveglia: b2 tiene la sua,
    // a1 (che una Sveglia non ce l'ha) non ne riceve una.
    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.savedStudentIds.has('a1')).toBe(false)
    // La Nanna di a1 appena salvata NON diventa «una Sveglia registrata e svuotata»:
    // il Salva dopo non manda nessuna DELETE di nanna_fine per a1.
    expect(result.current.daTogliere).toBe(0)
    act(() => { result.current.updateStudent('b2', { orario_fine: '15:45' }) })
    await act(async () => { await result.current.handleSave() })
    expect(deleteUrls).toHaveLength(0)
  })

  // La DELETE della Nanna svuotata risponde DOPO l'apertura della Sveglia: i suoi
  // «tolti» (o «falliti») non si scrivono nello stato del riquadro Sveglia.
  async function svuotaNannaEApriSvegliaConDeleteInVolo() {
    entriesGet = [
      riga('a1', 'nanna_inizio', { orario_inizio: '13:05' }),
      riga('a1', 'nanna_fine', { orario_fine: '15:00' }),
      riga('b2', 'nanna_fine', { orario_fine: '15:30' }),
    ]
    const result = await montaSuEvento('nanna_inizio')
    expect(result.current.savedStudentIds.has('a1')).toBe(true)

    act(() => { result.current.updateStudent('a1', { orario_inizio: '' }) })
    expect(result.current.daTogliere).toBe(1)
    trattieniDelete = true
    let salvataggio: Promise<void> = Promise.resolve()
    act(() => { salvataggio = result.current.handleSave() })
    await waitFor(() => expect(rilasciaDelete).not.toBeNull())

    // La Sveglia si apre e la sua GET risponde subito, con a1 alle 15:00.
    await act(async () => { await result.current.handleEventSelect('nanna_fine') })
    expect(result.current.studentStates.a1.orario_fine).toBe('15:00')
    expect(result.current.savedStudentIds.has('a1')).toBe(true)

    await act(async () => { rilasciaDelete?.(); await salvataggio })
    return result
  }

  it('una DELETE della Nanna che finisce DOPO l\'apertura della Sveglia non svuota la Sveglia di quel bambino', async () => {
    const result = await svuotaNannaEApriSvegliaConDeleteInVolo()

    // La Sveglia di a1 è ancora lì, con la sua ✅, e non c'è niente da togliere.
    expect(result.current.selectedEvent).toBe('nanna_fine')
    expect(result.current.studentStates.a1.orario_fine).toBe('15:00')
    expect(result.current.studentStates.a1.orario_inizio).toBeUndefined()
    expect(result.current.savedStudentIds.has('a1')).toBe(true)
    expect(result.current.daTogliere).toBe(0)
    // L'esito di QUEL salvataggio si dice comunque.
    expect(result.current.esitoSalvataggio).toEqual({ salvati: 0, tolti: 1 })

    // La maestra compila la Sveglia di b2 e salva: nessuna DELETE di nanna_fine.
    act(() => { result.current.updateStudent('b2', { orario_fine: '15:45' }) })
    await act(async () => { await result.current.handleSave() })
    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['a1', 'nanna_inizio']])
    const inviati = Object.fromEntries(postBodies[0].map((r) => [r.alunno_id, r]))
    expect(inviati.a1.dettagli).toEqual({ orario_fine: '15:00' })
    expect(inviati.b2.dettagli).toMatchObject({ orario_fine: '15:45' })
  })

  it('e se quella DELETE FALLISCE: avviso, ma nessun orario_inizio finisce nello stato della Sveglia', async () => {
    esitoDelete = () => erroreRes(500)
    const result = await svuotaNannaEApriSvegliaConDeleteInVolo()

    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(result.current.selectedEvent).toBe('nanna_fine')
    expect(result.current.studentStates.a1).toEqual({ orario_fine: '15:00' })
    expect(result.current.savedStudentIds.has('a1')).toBe(true)
    expect(result.current.savedStudentIds.has('b2')).toBe(true)
    expect(result.current.daTogliere).toBe(0)
    expect(result.current.showSavedToast).toBe(false)

    esitoDelete = () => jsonRes({ eliminati: 1 })
    act(() => { result.current.updateStudent('b2', { orario_fine: '15:45' }) })
    await act(async () => { await result.current.handleSave() })
    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['a1', 'nanna_inizio']])
  })

  // LO STESSO riquadro chiuso e riaperto mentre la DELETE è in volo: la GET della
  // riapertura è servita PRIMA che la DELETE arrivi in archivio, e porta a1 alle
  // 13:05. Se lo schermo restasse a quella GET, a1 comparirebbe con la ✅ e il
  // Salva successivo (anche solo per b2) riscriverebbe la nanna appena tolta.
  describe.each([
    { caso: 'con b2 ancora in archivio', b2InArchivio: true },
    { caso: 'con l\'archivio della Nanna ormai VUOTO', b2InArchivio: false },
  ])('Nanna chiusa e riaperta con la DELETE in volo ($caso)', ({ b2InArchivio }) => {
    const b2 = riga('b2', 'nanna_inizio', { orario_inizio: '13:10' })
    const prima = [riga('a1', 'nanna_inizio', { orario_inizio: '13:05' }), ...(b2InArchivio ? [b2] : [])]
    const dopo = b2InArchivio ? [b2] : []

    async function svuotaA1ERiapriConDeleteInVolo(opzioni: { getRiaperturaTrattenuta: boolean }) {
      entriesGet = prima
      const result = await montaSuEvento('nanna_inizio')
      expect(result.current.savedStudentIds.has('a1')).toBe(true)

      act(() => { result.current.updateStudent('a1', { orario_inizio: '' }) })
      expect(result.current.daTogliere).toBe(1)
      trattieniDelete = true
      let salvataggio: Promise<void> = Promise.resolve()
      act(() => { salvataggio = result.current.handleSave() })
      await waitFor(() => expect(rilasciaDelete).not.toBeNull())

      // Doppio tocco sulla tessera: chiude e riapre la Nanna.
      await act(async () => { await result.current.handleEventSelect('nanna_inizio') })
      expect(result.current.selectedEvent).toBeNull()
      let riapertura: Promise<void> = Promise.resolve()
      if (opzioni.getRiaperturaTrattenuta) {
        getDaTrattenere = 1
        act(() => { riapertura = result.current.handleEventSelect('nanna_inizio') })
        await waitFor(() => expect(getTrattenute).toHaveLength(1))
      } else {
        // La GET della riapertura risponde SUBITO, con a1 ancora in archivio.
        await act(async () => { await result.current.handleEventSelect('nanna_inizio') })
        expect(result.current.studentStates.a1.orario_inizio).toBe('13:05')
        expect(result.current.savedStudentIds.has('a1')).toBe(true)
      }
      expect(result.current.selectedEvent).toBe('nanna_inizio')

      // Solo ora la DELETE arriva in archivio: da qui le GET non vedono più a1.
      entriesGet = dopo
      await act(async () => { rilasciaDelete?.(); await salvataggio })

      if (opzioni.getRiaperturaTrattenuta) {
        // La GET della riapertura, servita quando a1 c'era ancora, risponde per ULTIMA.
        await act(async () => { getTrattenute[0](jsonRes(prima)); await riapertura })
      }
      return result
    }

    it.each([
      { ordine: 'la GET della riapertura risponde prima della DELETE', getRiaperturaTrattenuta: false },
      { ordine: 'la GET della riapertura (vecchia) risponde dopo il salvataggio', getRiaperturaTrattenuta: true },
    ])('$ordine: a1 resta tolta a schermo e il Salva dopo non la riscrive', async ({ getRiaperturaTrattenuta }) => {
      const result = await svuotaA1ERiapriConDeleteInVolo({ getRiaperturaTrattenuta })

      expect(result.current.selectedEvent).toBe('nanna_inizio')
      expect(result.current.studentStates.a1.orario_inizio).toBe('')
      expect(result.current.savedStudentIds.has('a1')).toBe(false)
      expect(result.current.daTogliere).toBe(0)
      // b2, col campo pieno, ripartiva nella POST di quel salvataggio (come oggi).
      expect(result.current.esitoSalvataggio).toEqual({ salvati: b2InArchivio ? 1 : 0, tolti: 1 })
      if (b2InArchivio) {
        expect(result.current.studentStates.b2.orario_inizio).toBe('13:10')
        expect(result.current.savedStudentIds.has('b2')).toBe(true)
      }

      // La maestra compila b2 e salva: nella POST c'è SOLO b2, e nessuna DELETE nuova.
      const postPrima = postBodies.length
      act(() => { result.current.updateStudent('b2', { orario_inizio: '13:20' }) })
      await act(async () => { await result.current.handleSave() })
      expect(postBodies).toHaveLength(postPrima + 1)
      const ultima = postBodies[postBodies.length - 1]
      expect(ultima.map((r) => r.alunno_id)).toEqual(['b2'])
      expect(ultima[0].dettagli).toMatchObject({ orario_inizio: '13:20' })
      expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['a1', 'nanna_inizio']])
    })
  })

  it('una POST in volo col riquadro chiuso e riaperto: lo schermo mostra l\'orario NUOVO, e il Salva dopo non rimette il vecchio', async () => {
    const vecchio = [riga('a1', 'nanna_inizio', { orario_inizio: '13:05' })]
    entriesGet = vecchio
    const result = await montaSuEvento('nanna_inizio')

    act(() => { result.current.updateStudent('a1', { orario_inizio: '13:30' }) })
    trattieniPost = true
    let salvataggio: Promise<void> = Promise.resolve()
    act(() => { salvataggio = result.current.handleSave() })
    await waitFor(() => expect(rilasciaPost).not.toBeNull())

    // Chiude e riapre: la GET risponde con l'archivio di PRIMA della POST.
    await act(async () => { await result.current.handleEventSelect('nanna_inizio') })
    await act(async () => { await result.current.handleEventSelect('nanna_inizio') })
    expect(result.current.studentStates.a1.orario_inizio).toBe('13:05')

    entriesGet = [riga('a1', 'nanna_inizio', { orario_inizio: '13:30' })]
    await act(async () => { rilasciaPost?.(); await salvataggio })

    expect(result.current.studentStates.a1.orario_inizio).toBe('13:30')
    expect(result.current.savedStudentIds.has('a1')).toBe(true)

    act(() => { result.current.updateStudent('b2', { orario_inizio: '13:20' }) })
    await act(async () => { await result.current.handleSave() })
    const inviati = Object.fromEntries(postBodies[1].map((r) => [r.alunno_id, r]))
    expect(inviati.a1.dettagli).toMatchObject({ orario_inizio: '13:30' })
    expect(inviati.b2.dettagli).toMatchObject({ orario_inizio: '13:20' })
    expect(deleteUrls).toHaveLength(0)
  })
})

function Schermata() {
  const day = useDiaryDay('u1', 'Girasoli')
  return <DiaryEventEditor day={day} sezione="Girasoli" />
}

describe('DiaryEventEditor — il pulsante e il messaggio', () => {
  it('con un orario svuotato il pulsante dice «Togli 1 orario», è attivo, e il toast dice cosa è successo', async () => {
    entriesGet = [riga('b2', 'nanna_fine', { orario_fine: '15:30' })]
    render(<Schermata />)
    // Il testo d'invito compare solo con i bambini caricati: si aspetta una PRESENZA.
    await screen.findByText(/Seleziona un evento/)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /sveglia/i })) })
    const campo = await waitFor(() => {
      const c = document.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
      expect(c.value).toBe('15:30')
      return c
    })

    fireEvent.change(campo, { target: { value: '' } })
    const salva = await screen.findByRole('button', { name: /Togli 1 orario/ })
    expect(salva).not.toBeDisabled()

    await act(async () => { fireEvent.click(salva) })

    expect(await screen.findByText('Orario tolto a 1 bambino')).toBeInTheDocument()
    expect(deleteParams().map((p) => [p.get('alunno_id'), p.get('tipo_evento')])).toEqual([['b2', 'nanna_fine']])
  })
})
