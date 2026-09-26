import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ righe: [] as Array<Record<string, unknown>>, carica: vi.fn(), elimina: vi.fn(), log: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log, nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/hooks/use-polling-visibile', () => ({ usePollingVisibile: vi.fn() }))
vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: async () => ({
    leggi: async (id: string) => h.righe.find(r => r.jobId === id),
    elenca: async () => h.righe,
    aggiorna: async (id: string, mod: object) => Object.assign(h.righe.find(r => r.jobId === id) ?? {}, mod),
    elimina: h.elimina, eliminaByte: vi.fn(),
  }),
  caricaVideo: h.carica, accodaCaricamentoVideo: vi.fn(), annullaCaricamentoVideo: vi.fn(),
  caricamentiDaRiprendere: (righe: Array<{ stato: string }>) => righe.filter(r => ['da_caricare', 'in_corso'].includes(r.stato)),
  jobDaSeguire: async () => h.righe.filter(r => r.stato === 'caricato'),
  potaArchivioCaricamenti: vi.fn(),
}))
import { useVideoGalleria } from '@/components/features/gallery/use-video-galleria'
const OWNER = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const INTENT = '33333333-3333-4333-8333-333333333333'
const JOB = '44444444-4444-4444-8444-444444444444'
const COORD = { protocollo: 'tus', endpoint: 'https://example.test/tus', bucket: 'video_originals', percorso: `${OWNER}/a.mp4`, contentType: 'video/mp4', dimensioneBloccoByte: 6291456 }
let intentStatus: string
let jobStatus: string
let needsUpload: boolean
let perdeCaricato: boolean
let perdeConferma: boolean
let azioni: string[]
const stato = () => ({ intentId: INTENT, revisione: 1, statoIntent: intentStatus, aggiornatoIl: new Date().toISOString(),
  job: [{ jobId: JOB, intentId: INTENT, canale: 'gallery', stato: jobStatus, codice: null, avanzamento: null, aggiornatoIl: new Date().toISOString() }] })
const opts = { utenteId: OWNER, sede: SEDE, classi: [], onPubblicato: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  intentStatus = 'pending'; jobStatus = 'awaiting_upload'; needsUpload = false; perdeCaricato = false; perdeConferma = false; azioni = []
  h.righe = [{ jobId: JOB, intentId: INTENT, ownerId: OWNER, scuolaId: SEDE, canale: 'gallery', chiaveIdempotenza: 'key', stato: 'caricato', nome: 'sintetico.mp4', dimensioneByte: 3, mime: 'video/mp4', coordinate: COORD }]
  h.carica.mockResolvedValue({ esito: 'caricato', jobId: JOB, byteCaricati: 3 })
  h.elimina.mockImplementation(async (id: string) => { h.righe = h.righe.filter(r => r.jobId !== id) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/video-uploads') return Response.json({ intentId: INTENT, revisione: 1, intent: { status: intentStatus },
      job: [{ jobId: JOB, chiaveIdempotenza: 'key', caricamento: COORD, firma: needsUpload ? 'fresh' : '', status: jobStatus, needs_upload: needsUpload, expires_at: new Date(Date.now() + 7200000).toISOString() }] })
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string)
      azioni.push(body.azione)
      if (body.azione === 'caricato') { jobStatus = 'queued'; if (perdeCaricato) { perdeCaricato = false; throw new TypeError('risposta persa') } }
      if (body.azione === 'conferma') { intentStatus = 'confirmed'; if (perdeConferma) { perdeConferma = false; throw new TypeError('risposta persa') } }
    }
    return Response.json(stato())
  }))
})
afterEach(() => vi.unstubAllGlobals())
describe('recupero video galleria', () => {
  it('caricato senza Blob completa metadata e conferma al rientro', async () => {
    renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(azioni).toEqual(['caricato', 'conferma']))
    expect(h.carica).not.toHaveBeenCalled()
  })
  it.each(['caricato', 'conferma'])('riconcilia una risposta persa dopo %s', async fase => {
    perdeCaricato = fase === 'caricato'; perdeConferma = fase === 'conferma'
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))
    expect(intentStatus).toBe('confirmed')
    expect(azioni).toEqual(['caricato', 'conferma'])
  })
  it('originale presente dopo perdita risposta TUS conclude senza ritrasferire', async () => {
    h.righe[0].stato = 'in_corso'
    renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(azioni).toEqual(['caricato', 'conferma']))
    expect(h.carica).not.toHaveBeenCalled()
    expect(h.righe[0].stato).toBe('caricato')
  })
  it('sessione scaduta mantiene il lavoro interrotto senza trasferire o confermare', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ codice: 'VIDEO_NON_AUTORIZZATO' }, { status: 401 })))
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))
    expect(h.carica).not.toHaveBeenCalled()
    expect(azioni).toEqual([])
    expect(h.righe).toHaveLength(1)
  })
  it('due riprese sullo stesso job durante il trasferimento condividono il lavoro', async () => {
    h.righe[0].stato = 'in_corso'; needsUpload = true
    let chiudi!: (r: unknown) => void
    h.carica.mockImplementation(() => new Promise(r => { chiudi = r }))
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    act(() => { result.current.riprendi(JOB); result.current.riprendi(JOB) })
    await act(async () => chiudi({ esito: 'caricato', byteCaricati: 3 }))
    await waitFor(() => expect(azioni).toEqual(['caricato', 'conferma']))
    expect(h.carica).toHaveBeenCalledTimes(1)
  })
  it('attende sia identità che sede prima di interrogare lavori locali', async () => {
    const { rerender } = renderHook(p => useVideoGalleria(p), { initialProps: { ...opts, utenteId: null as string | null, sede: null as string | null } })
    await act(async () => {})
    expect(fetch).not.toHaveBeenCalled()
    rerender(opts)
    await waitFor(() => expect(azioni).toEqual(['caricato', 'conferma']))
  })
  it('esclude altri autori, sedi, canali e righe legacy senza attribuzione', async () => {
    h.righe = [
      { ...h.righe[0], ownerId: 'altro' }, { ...h.righe[0], scuolaId: 'altra' },
      { ...h.righe[0], canale: 'news' }, { ...h.righe[0], ownerId: undefined, scuolaId: undefined },
    ]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await act(async () => {})
    expect(fetch).not.toHaveBeenCalled()
    expect(result.current.righe).toEqual([])
  })
  it('riconosce published e rimuove il riferimento locale senza ripubblicare', async () => {
    intentStatus = 'published'; jobStatus = 'ready'
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(h.elimina).toHaveBeenCalledWith(JOB))
    expect(result.current.righe).toEqual([])
    expect(azioni).toEqual([])
  })
  it.each(['cancelled', 'superseded'])('%s non viene confermato o trasferito nuovamente', async status => {
    intentStatus = status
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('annullato'))
    expect(azioni).toEqual([])
    expect(h.carica).not.toHaveBeenCalled()
  })
  it.each(['utenteId', 'sede'])('una risposta di apertura tardiva dopo cambio %s non conferma il vecchio lavoro', async campo => {
    let risolvi!: (r: Response) => void
    const originale = fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url === '/api/video-uploads'
      ? new Promise<Response>(r => { risolvi = r }) : originale(url, init)))
    const { rerender, result } = renderHook(p => useVideoGalleria(p), { initialProps: opts })
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    rerender({ ...opts, [campo]: '55555555-5555-4555-8555-555555555555' })
    await act(async () => risolvi(await originale('/api/video-uploads')))
    expect(azioni).toEqual([])
    expect(result.current.righe).toEqual([])
  })
  it('dopo unmount non prosegue con PATCH né pubblicazione', async () => {
    let risolvi!: (r: Response) => void
    const originale = fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url === '/api/video-uploads'
      ? new Promise<Response>(r => { risolvi = r }) : originale(url, init)))
    const { unmount } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    unmount()
    await act(async () => risolvi(await originale('/api/video-uploads')))
    expect(azioni).toEqual([])
  })
  it('riconcilia la pubblicazione riuscita con risposta persa senza richiedere un secondo invio', async () => {
    intentStatus = 'confirmed'; jobStatus = 'ready'
    const originale = fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/gallery') { intentStatus = 'published'; throw new TypeError('risposta persa') }
      return originale(url, init)
    }))
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('pronto'))
    await act(async () => result.current.cambiaTag(JOB, 'alunno'))
    await act(async () => result.current.pubblica(JOB))
    await waitFor(() => expect(result.current.righe).toEqual([]))
    expect(opts.onPubblicato).toHaveBeenCalledTimes(1)
  })
  it('un video pronto ritrovato richiede tag anche chiamando pubblica direttamente', async () => {
    intentStatus = 'confirmed'; jobStatus = 'ready'
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('pronto'))
    await act(async () => { result.current.pubblica(JOB) })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/gallery')).toBe(false)
  })
})


it.each(['unmount', 'logout'])('un rinnovo firma tardivo dopo %s non consegna credenziali a TUS', async evento => {
  h.righe[0].stato = 'in_corso'; needsUpload = true
  const originale = fetch
  let aperture = 0
  let completa!: (r: Response) => void
  let intestazioni: unknown = null
  let negato = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/video-uploads') return originale(url, init)
    aperture++
    if (aperture === 2) return new Promise<Response>(r => { completa = r })
    const r = await originale(url, init); const body = await r.json()
    body.job[0].expires_at = '2020-01-01T00:00:00.000Z'
    return Response.json(body)
  }))
  h.carica.mockImplementation(async (dip: { intestazioni: () => Promise<unknown> }) => {
    try { intestazioni = await dip.intestazioni() } catch { negato = true }
    return { esito: 'interrotto', jobId: JOB, offsetByte: 0 }
  })
  const { unmount, rerender } = renderHook(p => useVideoGalleria(p), { initialProps: { ...opts, utenteId: OWNER as string | null } })
  await waitFor(() => expect(completa).toBeDefined())
  if (evento === 'unmount') unmount()
  else rerender({ ...opts, utenteId: null })
  await act(async () => completa(await originale('/api/video-uploads')))
  expect(intestazioni).toBeNull()
  expect(negato).toBe(true)
  expect(azioni).toEqual([])
})
