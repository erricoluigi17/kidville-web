import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import itServizi from '../../messages/it/teacherServizi.json'
import itShared from '../../messages/it/shared.json'

/**
 * L'HOOK DEI VIDEO DELLA GALLERIA — invio, trasferimento, ripresa, elenco.
 *
 * ─── IL CRITERIO, PRIMA DEI TEST ────────────────────────────────────────────────────────────
 * Dopo la PR 2 «server e web» i bambini si scelgono UNA volta, prima dell'invio, e il video esce da
 * solo. Questo file tiene fermo il lato client di quel patto:
 *
 *  · «Invia» apre subito l'intento CON i bambini; un rifiuto resta alla schermata, con i nomi, e non
 *    fa partire un solo byte (zero `accodaCaricamentoVideo`, zero `caricaVideo`);
 *  · i trasferimenti partono UNO ALLA VOLTA;
 *  · una ripresa non riapre mai l'intento: la firma si rinnova con `/firma`, e la ripresa avviene da
 *    sola quando torna la rete;
 *  · «Rimuovi» ferma i byte PRIMA di ritirare l'intento;
 *  · i byte spariti sono un invio da rifare, e l'intento si annulla;
 *  · l'elenco del server si fonde con le righe locali: un video mandato da un altro dispositivo si
 *    vede, una pubblicazione fallita offre «Riprova», un fallimento non resta lì per sempre.
 *
 * L'uploader TUS è finto ai suoi confini (`@/lib/media/video/upload`) — ha i suoi collaudi, col
 * `tus.Upload` vero — e `fetch` è un server finto che registra ogni richiesta nell'ordine in cui
 * arriva: gli ordini si provano su quel registro, non sulle promesse.
 */

const h = vi.hoisted(() => ({
  righe: [] as Array<Record<string, unknown>>,
  carica: vi.fn(),
  accoda: vi.fn(),
  annullaLocale: vi.fn(),
  concludi: vi.fn(),
  elimina: vi.fn(),
  log: vi.fn(),
  ordine: [] as string[],
}))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log, nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto') }))
vi.mock('@/lib/hooks/use-polling-visibile', () => ({ usePollingVisibile: vi.fn() }))
vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: async () => ({
    leggi: async (id: string) => h.righe.find((r) => r.jobId === id),
    elenca: async () => h.righe,
    aggiorna: async (id: string, mod: object) => Object.assign(h.righe.find((r) => r.jobId === id) ?? {}, mod),
    elimina: h.elimina,
    eliminaByte: vi.fn(),
  }),
  accodaCaricamentoVideo: h.accoda,
  caricaVideo: h.carica,
  annullaCaricamentoVideo: h.annullaLocale,
  concludiCaricamentoVideo: h.concludi,
  potaArchivioCaricamenti: vi.fn(async () => 0),
}))

import { useVideoGalleria, type OpzioniVideoGalleria } from '@/components/features/gallery/use-video-galleria'
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile'

const OWNER = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const ADA = '55555555-5555-4555-8555-555555555555'
const COORD = { protocollo: 'tus', endpoint: 'https://example.test/tus', bucket: 'video_originals', percorso: `${OWNER}/a.mp4`, contentType: 'video/mp4', dimensioneBloccoByte: 6291456 }
const ADESSO = '2026-10-02T10:00:00.000Z'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const JOB = uuid(100)
const INTENT = uuid(200)

interface Chiamata { url: string; metodo: string; corpo: Record<string, unknown> | null }
let chiamate: Chiamata[] = []

/** Il server finto: ogni test cambia solo ciò che prova. */
const server = {
  voci: [] as unknown[],
  statoIntent: 'confirmed',
  revisione: 3,
  statoJob: 'queued',
  /** Le aperture già fatte: ogni chiave di idempotenza ha il suo job. */
  progressivo: 0,
  /** L'apertura: riceve il numero progressivo e il CORPO della POST (chiave e destinatari compresi). */
  apertura: null as null | ((n: number, corpo: Record<string, unknown>) => Response | Promise<Response>),
  patch: null as null | ((azione: string, corpo: Record<string, unknown>) => Response | null),
  firma: null as null | (() => Response),
}

function voce(fase: string, extra: Record<string, unknown> = {}) {
  const conErrore = fase === 'fallito' || fase === 'non-pubblicato'
  return {
    intentId: INTENT,
    jobId: JOB,
    fase,
    codice: conErrore ? (fase === 'fallito' ? 'VIDEO_TROPPO_LUNGO' : 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA') : null,
    creatoIl: ADESSO,
    aggiornatoIl: ADESSO,
    trasporto: 'tus',
    byte: 3,
    durataS: null,
    nBambini: 1,
    broadcast: false,
    mediaId: null,
    pubblicazioneAutomatica: fase !== 'da-ricaricare',
    riprovaPossibile: false,
    ...extra,
  }
}

const corpoStato = (intentId = INTENT) => ({
  intentId,
  revisione: server.revisione,
  canale: 'gallery',
  statoIntent: server.statoIntent,
  aggiornatoIl: ADESSO,
  job: [{ jobId: JOB, intentId, canale: 'gallery', stato: server.statoJob, codice: null, riprovaAutomatica: false, avanzamento: null, aggiornatoIl: ADESSO }],
})

const json = (corpo: unknown, stato = 200) => new Response(JSON.stringify(corpo), { status: stato, headers: { 'Content-Type': 'application/json' } })

function aperturaStandard(n: number, extra: { intent?: string; job?: Record<string, unknown> } = {}) {
  return json(
    {
      intentId: uuid(200 + n),
      revisione: 1,
      canale: 'gallery',
      intent: { status: extra.intent ?? 'confirmed' },
      scadenzaCaricamentoIl: '2026-10-02T12:00:00.000Z',
      job: [{ jobId: uuid(100 + n), chiaveIdempotenza: `k${n}`, caricamento: COORD, firma: 'firma-iniziale', status: 'awaiting_upload', needs_upload: true, expires_at: new Date(Date.now() + 7_200_000).toISOString(), ...extra.job }],
    },
    201,
  )
}

/**
 * Un server finto con la semantica di `video_galleria_intent_apri` (spec §5.3): quella che il server
 * finto di sopra NON ha — risponde 201 a qualunque chiave — e che rendeva questo file verde con la
 * chiave sbagliata.
 *  · una chiave già vista con ALTRI destinatari → 409 `VIDEO_RIPROVA` (è l'`IDEMPOTENCY_CONFLICT` della RPC);
 *  · una chiave del flusso VECCHIO (`g-…`) → lo stesso 409: quell'intento non si adotta;
 *  · una chiave già vista con gli STESSI destinatari → la ripetizione, che ritrova lo stesso intento;
 *  · altrimenti, un intento nuovo.
 * I destinatari si confrontano come INSIEMI, come fa la RPC: l'ordine e i doppioni non contano.
 */
function aperturaSecondoIlServer() {
  const viste = new Map<string, { destinatari: string; n: number }>()
  return (n: number, corpo: Record<string, unknown>): Response => {
    const chiave = (corpo.file as Array<{ chiaveIdempotenza: string }>)[0].chiaveIdempotenza
    const d = corpo.destinatari as { tagAlunni: string[]; broadcast: boolean; classi: string[] }
    const destinatari = JSON.stringify([[...new Set(d.tagAlunni)].sort(), d.broadcast, [...new Set(d.classi)].sort()])
    const conflitto = () => json({ error: 'Qualcosa è cambiato.', codice: 'VIDEO_RIPROVA' }, 409)
    if (chiave.startsWith('g-')) return conflitto()
    const prima = viste.get(chiave)
    if (prima && prima.destinatari !== destinatari) return conflitto()
    if (prima) return aperturaStandard(prima.n)
    viste.set(chiave, { destinatari, n })
    return aperturaStandard(n)
  }
}

function installaServer() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const metodo = init?.method ?? 'GET'
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    chiamate.push({ url, metodo, corpo })
    if (url === '/api/video-uploads' && metodo === 'POST') {
      h.ordine.push('POST:apertura')
      server.progressivo += 1
      return server.apertura ? server.apertura(server.progressivo, corpo ?? {}) : aperturaStandard(server.progressivo)
    }
    if (url.startsWith('/api/video-uploads?')) return json({ voci: server.voci })
    if (/\/firma$/.test(url)) {
      h.ordine.push('POST:firma')
      return server.firma ? server.firma() : json({ jobId: JOB, caricamento: COORD, firma: 'firma-rinnovata', scadeIl: new Date(Date.now() + 7_200_000).toISOString() })
    }
    const intentId = /\/api\/video-uploads\/([^/?]+)$/.exec(url)?.[1]
    if (intentId) {
      if (metodo === 'PATCH') {
        const azione = String(corpo?.azione)
        h.ordine.push(`PATCH:${azione}`)
        const deviata = server.patch?.(azione, corpo ?? {})
        if (deviata) return deviata
      }
      return json(corpoStato(intentId))
    }
    return json({})
  }))
}

const opts: OpzioniVideoGalleria = { utenteId: OWNER, sede: SEDE, classi: ['3 ANNI'], onPubblicato: vi.fn() }
const patchFatti = () => chiamate.filter((c) => c.metodo === 'PATCH').map((c) => String(c.corpo?.azione))
const aperture = () => chiamate.filter((c) => c.url === '/api/video-uploads' && c.metodo === 'POST')
const elenchi = () => chiamate.filter((c) => c.url.startsWith('/api/video-uploads?'))

function rigaArchivio(extra: Record<string, unknown> = {}) {
  return {
    jobId: JOB, intentId: INTENT, canale: 'gallery', ownerId: OWNER, scuolaId: SEDE, chiaveIdempotenza: 'key',
    nome: 'sintetico.mp4', dimensioneByte: 3, mime: 'video/mp4', stato: 'caricato', offsetByte: 3, urlTus: null,
    coordinate: COORD, codice: null, creatoIl: ADESSO, aggiornatoIl: ADESSO, ...extra,
  }
}

function video(nome = 'recita.mp4', byte = 12_345) {
  const f = new File(['x'], nome, { type: 'video/mp4', lastModified: 1_726_000_000_000 })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}
const scelta = { tag: [ADA], broadcast: false, durataSecondi: null as number | null }

/** Il polling dell'ELENCO e quello della RIPRESA, dell'ultimo render: l'elenco si registra per primo. */
const pollingElenco = () => vi.mocked(usePollingVisibile).mock.calls.at(-2)!
const giroDiElenco = async () => act(async () => { await (pollingElenco()[0] as () => unknown)() })

async function montaAttendendo(o: OpzioniVideoGalleria = opts) {
  const v = renderHook((p: OpzioniVideoGalleria) => useVideoGalleria(p), { initialProps: o })
  // Il montaggio ha finito quando l'elenco è stato chiesto (se ci sono identità e sede).
  if (o.utenteId && o.sede) await waitFor(() => expect(elenchi().length).toBeGreaterThan(0))
  return v
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  chiamate = []
  h.ordine.length = 0
  h.righe = []
  Object.assign(server, { voci: [], statoIntent: 'confirmed', revisione: 3, statoJob: 'queued', progressivo: 0, apertura: null, patch: null, firma: null })
  h.accoda.mockImplementation(async (_dip: unknown, ingresso: Record<string, unknown> & { jobId: string; file: File }) => {
    const riga = rigaArchivio({
      jobId: ingresso.jobId, intentId: ingresso.intentId, chiaveIdempotenza: ingresso.chiaveIdempotenza,
      nome: ingresso.file.name, dimensioneByte: ingresso.file.size, stato: 'da_caricare', offsetByte: 0,
    })
    h.righe.push(riga)
    return { ok: true, riga }
  })
  h.carica.mockImplementation(async (_dip: unknown, jobId: string) => {
    const riga = h.righe.find((r) => r.jobId === jobId)
    if (riga) riga.stato = 'caricato'
    return { esito: 'caricato', jobId, byteCaricati: 3 }
  })
  h.elimina.mockImplementation(async (id: string) => { h.righe = h.righe.filter((r) => r.jobId !== id) })
  h.annullaLocale.mockImplementation(async () => { h.ordine.push('annullaCaricamento') })
  h.concludi.mockResolvedValue(undefined)
  installaServer()
})
afterEach(() => {
  vi.unstubAllGlobals()
  // Una `spyOn` su `navigator.onLine` che resta accesa farebbe girare tutti i test dopo di lei «offline»:
  // un test rosso non deve trascinarsi dietro gli altri.
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
// INVIARE — i bambini PRIMA, e un rifiuto resta alla schermata
// ═══════════════════════════════════════════════════════════════════════════

describe('«Invia» apre subito l’intento con i bambini, e poi parte il trasferimento', () => {
  it('la POST porta i destinatari e il trasporto; poi accoda, carica e dice «caricato» — mai «conferma», mai /api/gallery', async () => {
    const { result } = await montaAttendendo()
    let esito: unknown
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito).toEqual({ ok: true })

    const apertura = aperture()[0].corpo!
    expect(apertura.destinatari).toEqual({ tagAlunni: [ADA], broadcast: false, classi: [] })
    expect(apertura.trasporto).toBe('tus')
    expect(apertura.canale).toBe('gallery')
    expect(apertura.scuolaId).toBe(SEDE)

    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    const caricato = chiamate.find((c) => c.metodo === 'PATCH')!.corpo!
    expect(caricato).toMatchObject({ azione: 'caricato', jobId: uuid(101), byte: 3, mime: 'video/mp4' })
    expect(h.accoda).toHaveBeenCalledTimes(1)
    expect(h.accoda.mock.calls[0][1]).toMatchObject({ jobId: uuid(101), intentId: uuid(201), canale: 'gallery', ownerId: OWNER, scuolaId: SEDE })
    expect(h.carica).toHaveBeenCalledTimes(1)
    // Il client NON pubblica più: nessuna richiesta a /api/gallery, e «conferma» non esiste più.
    expect(chiamate.some((c) => c.url.includes('/api/gallery'))).toBe(false)
    expect(patchFatti()).not.toContain('conferma')
  })

  it('in broadcast i bambini non partono e le classi sì', async () => {
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), { tag: [ADA], broadcast: true, durataSecondi: null }) })
    expect(aperture()[0].corpo!.destinatari).toEqual({ tagAlunni: [], broadcast: true, classi: ['3 ANNI'] })
  })

  it('UN 422 RESTA ALLA SCHERMATA: messaggio e nomi, e ZERO byte — né accodamento né trasferimento', async () => {
    server.apertura = () => json({ error: 'Foto di gruppo non pubblicabile: alcuni bambini non hanno la liberatoria foto.', nomi: ['Ada B.'], ids: [ADA] }, 422)
    const { result } = await montaAttendendo()
    let esito: { ok: boolean; messaggio?: string; nomi?: string[] } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })

    expect(esito).toMatchObject({ ok: false, nomi: ['Ada B.'] })
    expect(esito?.messaggio).toContain('Foto di gruppo non pubblicabile')
    expect(h.accoda).not.toHaveBeenCalled()
    expect(h.carica).not.toHaveBeenCalled()
    // L'unica richiesta di invio è l'apertura rifiutata: niente PATCH, niente firma, niente TUS.
    expect(chiamate.filter((c) => c.url !== '/api/video-uploads' && !c.url.startsWith('/api/video-uploads?'))).toEqual([])
    expect(result.current.righe).toEqual([])
    // I nomi dei bambini stanno a schermo e basta.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('Ada')
  })

  it('un rifiuto con codice (403 di sede) si legge dal catalogo, e anche lui non fa partire niente', async () => {
    server.apertura = () => json({ error: 'prosa', codice: 'TAG_FUORI_SEDE' }, 403)
    const { result } = await montaAttendendo()
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreTagFuoriSede })
    expect(h.accoda).not.toHaveBeenCalled()
  })

  it('una rete caduta dice che il file non è partito, e il file resta dov’è', async () => {
    server.apertura = () => { throw new TypeError('Failed to fetch') }
    const { result } = await montaAttendendo()
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itServizi.galleryErrRete })
    expect(h.accoda).not.toHaveBeenCalled()
  })

  it('«troppe richieste» (429) dice di riprovare più tardi: chi invia più file si ferma, senza martellare', async () => {
    server.apertura = () => new Response(JSON.stringify({ error: 'x', codice: 'TROPPE_RICHIESTE' }), { status: 429, headers: { 'Retry-After': '60' } })
    const { result } = await montaAttendendo()
    let esito: { ok: boolean; messaggio?: string; riprovaPiuTardi?: boolean } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito).toMatchObject({ ok: false, riprovaPiuTardi: true })
    expect(esito?.messaggio).toBeTruthy()
    expect(h.accoda).not.toHaveBeenCalled()
  })

  it('oltre il tetto della pipeline non si apre nemmeno l’intento', async () => {
    const { result } = await montaAttendendo()
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video('enorme.mp4', 2_000_000_001), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreVideoTroppoGrande })
    expect(aperture()).toHaveLength(0)
  })

  it('senza sede non si indovina il plesso: `SEDE_DA_SPECIFICARE`, e nessuna richiesta', async () => {
    const { result } = await montaAttendendo({ ...opts, sede: null })
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito?.ok).toBe(false)
    expect(esito?.messaggio).toBeTruthy()
    expect(chiamate).toEqual([])
  })

  it('se la riga locale non si scrive (telefono pieno) il video non parte E l’intento già creato si ritira', async () => {
    h.accoda.mockResolvedValueOnce({ ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    const { result } = await montaAttendendo()
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreVideoOperazioneNonRiuscita })
    expect(h.carica).not.toHaveBeenCalled()
    // L'intento esiste già sul server, confermato e in attesa di byte che non partiranno: si annulla.
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
  })

  it('lo stesso file scelto di nuovo dopo che il suo intento è finito apre un intento NUOVO, con una chiave nuova', async () => {
    server.apertura = (n) => (n === 1
      ? aperturaStandard(1, { intent: 'published', job: { status: 'ready', needs_upload: false, firma: '' } })
      : aperturaStandard(n))
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })

    expect(aperture()).toHaveLength(2)
    const k1 = (aperture()[0].corpo!.file as Array<{ chiaveIdempotenza: string }>)[0].chiaveIdempotenza
    const k2 = (aperture()[1].corpo!.file as Array<{ chiaveIdempotenza: string }>)[0].chiaveIdempotenza
    expect(k2).not.toBe(k1)
    expect(h.accoda.mock.calls[0][1]).toMatchObject({ jobId: uuid(102) })
  })

  it('i byte già sul server (`needs_upload: false`) non si rispediscono: si conclude la riga e si dice «caricato»', async () => {
    server.apertura = (n) => aperturaStandard(n, { job: { needs_upload: false, status: 'awaiting_upload', firma: '' } })
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })

    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    expect(h.concludi).toHaveBeenCalledTimes(1)
    expect(h.concludi.mock.calls[0][1]).toBe(uuid(101))
    expect(h.carica).not.toHaveBeenCalled()
  })

  it('una risposta di apertura arrivata dopo un cambio di sede NON accoda niente nella sede sbagliata', async () => {
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    const { result, rerender } = await montaAttendendo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(1))

    rerender({ ...opts, sede: '33333333-3333-4333-8333-333333333333' })
    await act(async () => { risolvi(aperturaStandard(1)); await promessa })
    expect(h.accoda).not.toHaveBeenCalled()
    expect(h.carica).not.toHaveBeenCalled()
  })

  it('dopo lo smontaggio una risposta tardiva non accoda niente', async () => {
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    const { result, unmount } = await montaAttendendo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(1))
    unmount()
    await act(async () => { risolvi(aperturaStandard(1)); await promessa })
    expect(h.accoda).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA CHIAVE DI IDEMPOTENZA — lo stesso file rimandato non prende il 409 «ricarica e riprova»
// ═══════════════════════════════════════════════════════════════════════════

/** La chiave di idempotenza dell'apertura numero `n` (la prima è 0). */
const chiaveDellApertura = (n: number): string =>
  (aperture()[n].corpo!.file as Array<{ chiaveIdempotenza: string }>)[0].chiaveIdempotenza

describe('lo stesso file rimandato con altri bambini: il server non lo rifiuta più', () => {
  const ALTRO_BAMBINO = '77777777-7777-4777-8777-777777777777'

  it('il finto server HA la semantica del §5.3 (altrimenti i test qui sotto sarebbero verdi a vuoto)', async () => {
    const apri = aperturaSecondoIlServer()
    const corpo = (chiave: string, tag: string[]) => ({
      file: [{ chiaveIdempotenza: chiave }],
      destinatari: { tagAlunni: tag, broadcast: false, classi: [] },
    })
    expect((await apri(1, corpo('gv2-k', [ADA]))).status).toBe(201)
    // La ripetizione (stessi bambini, anche in un altro ordine) ritrova lo stesso intento.
    expect((await apri(2, corpo('gv2-k', [ADA, ADA]))).status).toBe(201)
    // La stessa chiave con altri bambini è il conflitto della RPC, e il server lo dice come la route.
    const conflitto = await apri(3, corpo('gv2-k', [ALTRO_BAMBINO]))
    expect(conflitto.status).toBe(409)
    expect(await conflitto.json()).toMatchObject({ codice: 'VIDEO_RIPROVA' })
    // Una chiave del flusso vecchio non si adotta, con qualunque bambino.
    expect((await apri(4, corpo('g-5000-1759400000000-83ce6643', [ADA]))).status).toBe(409)
  })

  it('«Invia» con un bambino, «Rimuovi», poi lo stesso file con un altro bambino: la seconda apertura RIESCE, con un’altra chiave', async () => {
    server.apertura = aperturaSecondoIlServer()
    const { result } = await montaAttendendo()

    let primo: unknown
    await act(async () => { primo = await result.current.avviaVideo(video(), scelta) })
    expect(primo).toEqual({ ok: true })

    act(() => result.current.rimuovi(uuid(101)))
    await waitFor(() => expect(patchFatti()).toContain('annulla'))

    // Stesso nome, stesso peso, stessa data: il browser da PC o da Android dà esattamente questo file.
    let secondo: unknown
    await act(async () => { secondo = await result.current.avviaVideo(video(), { ...scelta, tag: [ALTRO_BAMBINO] }) })

    expect(secondo, 'la seconda apertura è stata rifiutata: «ricarica e riprova» per un gesto che non può riuscire').toEqual({ ok: true })
    expect(aperture()).toHaveLength(2)
    expect(chiaveDellApertura(1)).not.toBe(chiaveDellApertura(0))
    expect(aperture()[1].corpo!.destinatari).toEqual({ tagAlunni: [ALTRO_BAMBINO], broadcast: false, classi: [] })
    // Il secondo video è un intento nuovo, col suo job: il primo è stato ritirato e non si tocca più.
    expect(h.accoda.mock.calls.map((c) => (c[1] as { jobId: string }).jobId)).toEqual([uuid(101), uuid(102)])
  })

  it('un file «da ricaricare» (già mandato col client di prima) si rimanda senza prendere il 409: la chiave non è del flusso vecchio', async () => {
    // La scheda «questo video va ricaricato: scegli di nuovo il file e invialo» chiede proprio questo
    // gesto. Il server finto rifiuta ogni chiave `g-…`, come fa la RPC con un intento del flusso vecchio.
    server.apertura = aperturaSecondoIlServer()
    server.voci = [voce('da-ricaricare')]
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('da-ricaricare'))

    let esito: unknown
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })

    expect(esito, 'il reinvio di un file «da ricaricare» è stato rifiutato').toEqual({ ok: true })
    expect(chiaveDellApertura(0).startsWith('g-')).toBe(false)
    expect(chiaveDellApertura(0)).toMatch(/^[a-z0-9-]+$/)
  })

  it('la chiave non contiene il nome del file né l’uuid del bambino: sono anagrafica di un minore', async () => {
    server.apertura = aperturaSecondoIlServer()
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video('recita-bambina-rossi.mov'), scelta) })
    const chiave = chiaveDellApertura(0)
    expect(chiave.toLowerCase()).not.toContain('rossi')
    expect(chiave).not.toContain(ADA)
    expect(chiave).not.toContain(ADA.slice(0, 8))
  })

  it('lo stesso file con gli STESSI bambini, rimandato (la risposta si era persa), non è un conflitto: ritrova il suo intento', async () => {
    server.apertura = aperturaSecondoIlServer()
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    let ripetuto: unknown
    await act(async () => { ripetuto = await result.current.avviaVideo(video(), scelta) })
    expect(ripetuto).toEqual({ ok: true })
    expect(chiaveDellApertura(1)).toBe(chiaveDellApertura(0))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// I TRASFERIMENTI VANNO UNO ALLA VOLTA (#53)
// ═══════════════════════════════════════════════════════════════════════════

describe('i trasferimenti partono in serie, non tutti insieme', () => {
  it('con due video il secondo `caricaVideo` parte solo quando il primo è finito', async () => {
    const finisci: Array<() => void> = []
    h.carica.mockImplementation((_dip: unknown, jobId: string) => new Promise((r) => {
      finisci.push(() => { const riga = h.righe.find((x) => x.jobId === jobId); if (riga) riga.stato = 'caricato'; r({ esito: 'caricato', jobId, byteCaricati: 3 }) })
    }))
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video('uno.mp4', 11), scelta) })
    await act(async () => { await result.current.avviaVideo(video('due.mp4', 22), scelta) })

    // Le DUE aperture sono già partite (il server conosce i bambini di entrambi), ma di byte ne corre UNO.
    expect(aperture()).toHaveLength(2)
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    expect(h.carica.mock.calls[0][1]).toBe(uuid(101))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(h.carica, 'il secondo video è partito mentre il primo girava').toHaveBeenCalledTimes(1)
    expect(result.current.righe.map((r) => r.fase)).toEqual(['caricamento', 'in-fila'])

    await act(async () => { finisci[0]() })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(2))
    expect(h.carica.mock.calls[1][1]).toBe(uuid(102))
  })
})

describe('la coda aspetta i byte, non le risposte', () => {
  it('una risposta di «caricato» appesa (rete mobile) non ferma il video successivo', async () => {
    // Il PATCH «caricato» del primo video non risponde mai: i byte, però, sono arrivati.
    server.patch = (azione) => (azione === 'caricato' ? (new Promise<Response>(() => undefined) as unknown as Response) : null)
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video('uno.mp4', 11), scelta) })
    await act(async () => { await result.current.avviaVideo(video('due.mp4', 22), scelta) })

    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(2))
    expect(h.carica.mock.calls.map((c) => c[1])).toEqual([uuid(101), uuid(102)])
    // Il primo PATCH è partito (e resta appeso): la coda non lo ha aspettato.
    expect(patchFatti()[0]).toBe('caricato')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA FIRMA — si rinnova con /firma, e non si riapre mai l'intento (#58)
// ═══════════════════════════════════════════════════════════════════════════

describe('la firma si rinnova con `/firma`, mai riaprendo l’intento', () => {
  it('`rinnovaFirma` chiama `POST /api/video-uploads/<intento>/firma` col job, e l’apertura resta UNA', async () => {
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(h.accoda).toHaveBeenCalled())
    const dip = h.accoda.mock.calls[0][0] as { rinnovaFirma: (j: string) => Promise<Record<string, string>> }

    expect(await dip.rinnovaFirma(uuid(101))).toEqual({ 'x-signature': 'firma-rinnovata' })
    const firma = chiamate.find((c) => c.url.endsWith('/firma'))!
    expect(firma.url).toBe(`/api/video-uploads/${uuid(201)}/firma`)
    expect(firma.metodo).toBe('POST')
    expect(firma.corpo).toEqual({ jobId: uuid(101) })
    // ⚠️ La vecchia strada riapriva l'intento: 190 aperture per 44 job. Adesso l'apertura è una sola.
    expect(aperture()).toHaveLength(1)
  })

  it('la prima firma è quella dell’apertura: costa zero richieste finché vale', async () => {
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(h.accoda).toHaveBeenCalled())
    const dip = h.accoda.mock.calls[0][0] as { intestazioni: () => Promise<Record<string, string>> }
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-iniziale' })
    expect(chiamate.some((c) => c.url.endsWith('/firma'))).toBe(false)
  })

  it.each(['smontaggio', 'logout'])('una firma rinnovata che arriva dopo %s NON viene consegnata a TUS', async (evento) => {
    let completa!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      chiamate.push({ url, metodo: init?.method ?? 'GET', corpo: init?.body ? JSON.parse(String(init.body)) : null })
      if (url === '/api/video-uploads' && init?.method === 'POST') return aperturaStandard(1)
      if (url.endsWith('/firma')) return new Promise<Response>((r) => { completa = r })
      if (url.startsWith('/api/video-uploads?')) return json({ voci: [] })
      return json(corpoStato(INTENT))
    }))
    h.carica.mockImplementation(async () => ({ esito: 'interrotto', jobId: uuid(101), offsetByte: 0, codice: null }))
    const { result, unmount, rerender } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(h.accoda).toHaveBeenCalled())
    const dip = h.accoda.mock.calls[0][0] as { rinnovaFirma: (j: string) => Promise<Record<string, string>> }

    const inVolo = dip.rinnovaFirma(uuid(101))
    const esito = inVolo.then((v) => ({ consegnata: v }), (e: Error) => ({ negata: e.message }))
    await waitFor(() => expect(completa).toBeDefined())
    if (evento === 'smontaggio') unmount()
    else rerender({ ...opts, utenteId: null })
    await act(async () => { completa(json({ jobId: uuid(101), caricamento: COORD, firma: 'FIRMA-TARDIVA', scadeIl: new Date(Date.now() + 7_200_000).toISOString() })) })

    expect(await esito).toEqual({ negata: 'FirmaNonDisponibile' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// RIMUOVERE — prima i byte, poi l'intento (#58)
// ═══════════════════════════════════════════════════════════════════════════

describe('«Rimuovi» ferma prima il trasferimento e poi ritira l’intento', () => {
  it('`annullaCaricamentoVideo` viene PRIMA del ritiro dell’intento, che usa la revisione di ADESSO', async () => {
    h.carica.mockImplementation(() => new Promise(() => undefined)) // il trasferimento è in volo
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))

    server.revisione = 7
    act(() => result.current.rimuovi(uuid(101)))
    // La scheda sparisce SUBITO.
    expect(result.current.righe).toEqual([])
    await waitFor(() => expect(patchFatti()).toContain('annulla'))

    const ordine = h.ordine
    expect(ordine.indexOf('annullaCaricamento'), 'i byte non sono stati fermati').toBeGreaterThanOrEqual(0)
    expect(ordine.indexOf('annullaCaricamento')).toBeLessThan(ordine.indexOf('PATCH:annulla'))
    // La revisione è quella letta ADESSO (7), non quella con cui l'intento era nato (1).
    expect(chiamate.find((c) => c.corpo?.azione === 'annulla')!.corpo).toEqual({ azione: 'annulla', revisione: 7 })
    await waitFor(() => expect(h.elimina).toHaveBeenCalledWith(uuid(101)))
  })

  it('una revisione che cambia fra la lettura e il ritiro (409) si riprova UNA volta, con quella nuova', async () => {
    let tentativi = 0
    server.patch = (azione) => {
      if (azione !== 'annulla') return null
      tentativi += 1
      if (tentativi === 1) { server.revisione = 9; return json({ error: 'x', codice: 'REVISION_MISMATCH' }, 409) }
      return null
    }
    h.righe = [rigaArchivio()]
    server.voci = [voce('in-coda')]
    server.revisione = 4
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))

    act(() => result.current.rimuovi(JOB))
    await waitFor(() => expect(chiamate.filter((c) => c.corpo?.azione === 'annulla')).toHaveLength(2))
    expect(chiamate.filter((c) => c.corpo?.azione === 'annulla').map((c) => c.corpo!.revisione)).toEqual([4, 9])
  })

  it('un intento già concluso non si tocca: nessun ritiro', async () => {
    server.statoIntent = 'published'
    h.righe = [rigaArchivio()]
    server.voci = [voce('in-coda')]
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe).toHaveLength(1))
    act(() => result.current.rimuovi(JOB))
    await waitFor(() => expect(h.elimina).toHaveBeenCalled())
    expect(patchFatti()).not.toContain('annulla')
  })

  it('una scheda tolta NON torna, nemmeno se il server la riporta ancora (e dopo un ricaricamento)', async () => {
    server.voci = [voce('da-ricaricare')]
    const primo = await montaAttendendo()
    await waitFor(() => expect(primo.result.current.righe[0]?.fase).toBe('da-ricaricare'))
    act(() => primo.result.current.rimuovi(JOB))
    expect(primo.result.current.righe).toEqual([])
    await giroDiElenco()
    expect(primo.result.current.righe, 'la scheda è ricomparsa alla lettura successiva').toEqual([])
    primo.unmount()

    // Un nuovo montaggio — la persona riapre la galleria — non la riporta.
    const secondo = await montaAttendendo()
    await act(async () => { await Promise.resolve() })
    expect(secondo.result.current.righe).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// IL RIENTRO E LA RIPRESA
// ═══════════════════════════════════════════════════════════════════════════

describe('al rientro: ciò che era a metà riprende da solo, e non riapre niente', () => {
  it('una riga con byte ancora da spedire riprende SENZA clic, con il motivo nel log, e senza aprire l’intento', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    renderHook(() => useVideoGalleria(opts))

    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    expect(h.carica.mock.calls[0][1]).toBe(JOB)
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: `video-ripresa-automatica: job=${JOB} motivo=rientro`,
    }))
    // ⚠️ Nessuna apertura: la ripresa non crea e non riapre intenti — la firma è `/firma`.
    expect(aperture()).toHaveLength(0)
    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
  })

  it('il nome del file non entra nei log della ripresa', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', nome: 'recita-bambina-rossi.mov' })]
    server.voci = [voce('da-caricare')]
    renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(h.carica).toHaveBeenCalled())
    expect(JSON.stringify(h.log.mock.calls).toLowerCase()).not.toContain('rossi')
  })

  it('una riga «caricato» il cui job è già in coda mostra la fase giusta e non rifà niente', async () => {
    h.righe = [rigaArchivio()]
    server.voci = [voce('in-coda')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))
    expect(result.current.righe[0].nome).toBe('sintetico.mp4')
    expect(h.carica).not.toHaveBeenCalled()
    expect(patchFatti()).toEqual([])
  })

  it('una riga «caricato» che il server vede ancora «da caricare» riceve «caricato» UNA volta (rete di sicurezza)', async () => {
    h.righe = [rigaArchivio()]
    server.voci = [voce('da-caricare')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.corpo).toMatchObject({ azione: 'caricato', jobId: JOB, byte: 3, mime: 'video/mp4' })
    // E una seconda lettura dell'elenco non lo ripete.
    await giroDiElenco()
    expect(patchFatti()).toEqual(['caricato'])
    // Intanto la scheda NON dice «da un altro dispositivo»: i byte li ha mandati questo.
    expect(result.current.righe[0].fase).toBe('in-coda')
  })

  it('una riga ancora a metà il cui job ha GIÀ i byte sul server non si rispedisce: si conclude', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('in-conversione')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('conversione'))
    expect(h.concludi).toHaveBeenCalledTimes(1)
    expect(h.concludi.mock.calls[0][1]).toBe(JOB)
    expect(h.carica).not.toHaveBeenCalled()
  })

  it('i BYTE SPARITI (app chiusa a metà copia): «da ricaricare» E l’intento si annulla (#56)', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 0 })]
    server.voci = [voce('da-caricare')]
    h.carica.mockImplementation(async () => ({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_RIPROVA' }))
    const { result } = renderHook(() => useVideoGalleria(opts))

    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('da-ricaricare'))
    // L'intento non resta in attesa di byte che non arriveranno: si ritira.
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    expect(patchFatti()).not.toContain('caricato')
  })

  it('un fallimento definitivo del trasferimento dice il suo codice e annulla l’intento', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 0 })]
    server.voci = [voce('da-caricare')]
    h.carica.mockImplementation(async () => ({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_TROPPO_GRANDE' }))
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('fallito'))
    expect(result.current.righe[0].messaggio).toBe(itShared.erroreVideoTroppoGrande)
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
  })

  it('un fallimento di una sessione precedente si mostra, ma non si ri-annulla a ogni apertura', async () => {
    h.righe = [rigaArchivio({ stato: 'fallito', codice: 'VIDEO_TROPPO_GRANDE' }), rigaArchivio({ jobId: uuid(150), stato: 'annullato' })]
    server.voci = []
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('fallito'))
    // Un annullato l'ha chiesto la persona: non si racconta.
    expect(result.current.righe).toHaveLength(1)
    expect(h.carica).not.toHaveBeenCalled()
    expect(patchFatti()).toEqual([])
  })

  it('un trasferimento interrotto riprende da solo quando torna la rete (`online`)', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    h.carica.mockResolvedValueOnce({ esito: 'interrotto', jobId: JOB, offsetByte: 1, codice: null })
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))
    expect(h.carica).toHaveBeenCalledTimes(1)

    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(2))
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: `video-ripresa-automatica: job=${JOB} motivo=online` }))
  })

  it('senza rete al rientro NON si tenta (nessuna riga d’errore per la firma che non si può chiedere); torna la rete e riprende', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    const spia = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { result } = renderHook(() => useVideoGalleria(opts))
    // La PRESENZA prima: la scheda c'è (la riga è stata letta), ferma.
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(h.carica).not.toHaveBeenCalled()
    expect(h.log).not.toHaveBeenCalledWith(expect.objectContaining({ messaggio: expect.stringContaining('video-ripresa-automatica') }))

    spia.mockReturnValue(true)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    spia.mockRestore()
  })

  it('«Riprendi» a mano riprende lo stesso, e un secondo tocco non ne fa partire un secondo', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    h.carica.mockResolvedValueOnce({ esito: 'interrotto', jobId: JOB, offsetByte: 1, codice: null })
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))

    let finisci!: () => void
    h.carica.mockImplementationOnce(() => new Promise((r) => { finisci = () => r({ esito: 'caricato', jobId: JOB, byteCaricati: 3 }) }))
    act(() => { result.current.riprendi(JOB); result.current.riprendi(JOB) })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(2))
    await act(async () => finisci())
    expect(h.carica).toHaveBeenCalledTimes(2)
  })

  it('un «non autorizzato» senza rete non si legge come un rifiuto', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso' })]
    server.voci = [voce('da-caricare')]
    h.carica.mockResolvedValue({ esito: 'interrotto', jobId: JOB, offsetByte: 0, codice: 'VIDEO_NON_AUTORIZZATO' })
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))
    expect(result.current.righe[0].messaggio).toBe(itShared.erroreVideoNonAutorizzato)

    const spia = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    await waitFor(() => expect(result.current.righe[0].messaggio).toBeNull())
    spia.mockRestore()
  })

  it('esclude altri autori, sedi, canali e righe legacy senza attribuzione', async () => {
    h.righe = [
      rigaArchivio({ ownerId: 'altro' }), rigaArchivio({ scuolaId: 'altra' }),
      rigaArchivio({ canale: 'news' }), rigaArchivio({ ownerId: undefined, scuolaId: undefined }),
    ]
    const { result } = await montaAttendendo()
    await act(async () => {})
    expect(result.current.righe).toEqual([])
    expect(h.carica).not.toHaveBeenCalled()
    expect(patchFatti()).toEqual([])
  })

  it('attende sia identità che sede prima di interrogare qualunque cosa', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso' })]
    const { rerender } = renderHook((p: OpzioniVideoGalleria) => useVideoGalleria(p), { initialProps: { ...opts, utenteId: null as string | null, sede: null as string | null } })
    await act(async () => {})
    expect(chiamate).toEqual([])
    server.voci = [voce('da-caricare')]
    rerender(opts)
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA RIPRESA AUTOMATICA: L'ATTESA CRESCE, ANCHE QUANDO LA RIGA PASSA PER «CARICAMENTO»
// ═══════════════════════════════════════════════════════════════════════════
//
// Nell'hook composto ogni tentativo porta la riga a «caricamento» e poi di nuovo a «interrotto»: la
// ripresa smette di essere attiva e poi lo torna. Se il conto dei tentativi vivesse dentro l'effetto
// che dipende da `attiva`, ripartirebbe da zero a ogni giro e l'attesa resterebbe a 5 secondi per
// sempre: un telefono senza campo martellerebbe la firma e i log ogni 7 secondi, non ogni 5, 15, 30, 60.

describe('la ripresa automatica nell’hook composto: l’attesa cresce (5, 15, 30, 60 secondi)', () => {
  beforeEach(() => {
    // Solo i timer che servono: il resto (microtask, macrotask di React, flussi di `Response`) resta vero.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // jsdom non promette `document.hidden === false`: la ripresa tace a pagina nascosta.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'hidden')
  })

  /** Fa passare `ms` di tempo finto e lascia a React il tempo di rimontare gli effetti: un `act` per passo. */
  const passa = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  it('un trasferimento che la rete interrompe SEMPRE aspetta sempre di più fra un tentativo e il successivo', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    const partenze: number[] = []
    const fini: number[] = []
    // Ogni tentativo dura 2 secondi e poi la rete lo interrompe: la riga va a «caricamento» e torna «interrotta».
    h.carica.mockImplementation((_dip: unknown, jobId: string) => new Promise((risolvi) => {
      partenze.push(Date.now())
      setTimeout(() => {
        fini.push(Date.now())
        risolvi({ esito: 'interrotto', jobId, offsetByte: 1, codice: null })
      }, 2_000)
    }))
    renderHook(() => useVideoGalleria(opts))

    // 130 passi da un secondo: il quinto tentativo parte dopo 5 + 15 + 30 + 60 secondi più i quattro da 2.
    for (let secondo = 0; secondo < 130 && partenze.length < 6; secondo++) await passa(1_000)

    expect(partenze.length, 'la ripresa non ha mai ritentato').toBeGreaterThanOrEqual(5)
    // L'attesa conta dalla FINE di ogni tentativo.
    const attese = partenze.slice(1).map((partenza, i) => partenza - fini[i])
    expect(attese.slice(0, 4)).toEqual([5_000, 15_000, 30_000, 60_000])
  })

  it('un trasferimento che ARRIVA (un video nuovo) riporta a 5 secondi l’attesa dell’altro: è una buona notizia della rete', async () => {
    // Il video di un'altra sessione, che la rete interrompe sempre.
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    const partenzeDelFermo: number[] = []
    let arrivoDelNuovo = 0
    h.carica.mockImplementation((_dip: unknown, jobId: string) => new Promise((risolvi) => {
      if (jobId === JOB) partenzeDelFermo.push(Date.now())
      setTimeout(() => {
        if (jobId === JOB) {
          risolvi({ esito: 'interrotto', jobId, offsetByte: 1, codice: null })
          return
        }
        // Il video nuovo, mandato adesso, arriva in fondo.
        arrivoDelNuovo = Date.now()
        const riga = h.righe.find((r) => r.jobId === jobId)
        if (riga) riga.stato = 'caricato'
        risolvi({ esito: 'caricato', jobId, byteCaricati: 3 })
      }, 2_000)
    }))
    const { result } = renderHook(() => useVideoGalleria(opts))

    // L'attesa del fermo cresce: partenze a 0, 7 e 24 secondi, e la quarta aspetterebbe 30 secondi di più.
    for (let secondo = 0; secondo < 60 && partenzeDelFermo.length < 3; secondo++) await passa(1_000)
    expect(partenzeDelFermo.length, 'la ripresa non ha ritentato abbastanza').toBe(3)
    await passa(2_000) // il terzo tentativo finisce, la riga torna «interrotta»: ora aspetta 30 secondi

    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    for (let secondo = 0; secondo < 20 && arrivoDelNuovo === 0; secondo++) await passa(1_000)
    expect(arrivoDelNuovo, 'il video nuovo non è arrivato').toBeGreaterThan(0)

    // Dopo l'arrivo il fermo riparte entro 5 secondi — non dopo i ~30 che aveva davanti.
    for (let secondo = 0; secondo < 40 && partenzeDelFermo.length < 4; secondo++) await passa(1_000)
    expect(partenzeDelFermo.length, 'il fermo non è più ripartito').toBeGreaterThanOrEqual(4)
    expect(partenzeDelFermo[3] - arrivoDelNuovo).toBeLessThanOrEqual(5_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// L'ELENCO DEL SERVER
// ═══════════════════════════════════════════════════════════════════════════

describe('l’elenco del server si fonde con le righe locali', () => {
  it('chiede l’elenco della SEDE, una volta al montaggio', async () => {
    await montaAttendendo()
    expect(elenchi()[0].url).toBe(`/api/video-uploads?canale=gallery&scuolaId=${SEDE}`)
  })

  it('un video senza riga locale è «da un altro dispositivo», senza nome', async () => {
    server.voci = [voce('da-caricare')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('altro-dispositivo'))
    expect(result.current.righe[0].nome).toBeNull()
    expect(h.carica).not.toHaveBeenCalled()
  })

  it('un job fallito di un intento automatico (#96) è «fallito» col motivo, e «Togli» lo ANNULLA', async () => {
    server.voci = [voce('fallito')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('fallito'))
    expect(result.current.righe[0].messaggio).toBe(itShared.erroreVideoTroppoLungo)

    act(() => result.current.rimuovi(JOB))
    expect(result.current.righe).toEqual([])
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    // Un video senza riga locale: nessun lavoro locale da fermare.
    expect(h.annullaLocale).not.toHaveBeenCalled()
  })

  it('un video del flusso vecchio dice «va ricaricato»', async () => {
    server.voci = [voce('da-ricaricare')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('da-ricaricare'))
  })

  it('«Riprova» fa il PATCH `riprova-pubblicazione` e rilegge l’elenco', async () => {
    server.voci = [voce('non-pubblicato', { riprovaPossibile: true })]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.riprovaPossibile).toBe(true))
    expect(result.current.righe[0].messaggio).toBe(itShared.erroreVideoPubblicazioneNonRiuscita)

    const prima = elenchi().length
    server.voci = [voce('pronto')]
    await act(async () => { result.current.riprova(JOB) })
    await waitFor(() => expect(patchFatti()).toEqual(['riprova-pubblicazione']))
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.url).toBe(`/api/video-uploads/${INTENT}`)
    await waitFor(() => expect(elenchi().length).toBeGreaterThan(prima))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('pronto'))
  })

  it('un «Riprova» negato dice perché, sulla scheda', async () => {
    server.voci = [voce('non-pubblicato', { riprovaPossibile: true })]
    server.patch = () => json({ error: 'x', codice: 'VIDEO_RIPROVA_NON_POSSIBILE' }, 409)
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.riprovaPossibile).toBe(true))
    await act(async () => { result.current.riprova(JOB) })
    await waitFor(() => expect(result.current.righe[0].messaggio).toBe(itShared.erroreVideoRiprovaNonPossibile))
  })

  it('«Riprova» non parte se il server non l’ha offerto, e non parte due volte insieme', async () => {
    server.voci = [voce('non-pubblicato', { riprovaPossibile: false })]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('non-pubblicato'))
    act(() => result.current.riprova(JOB))
    await act(async () => {})
    expect(patchFatti()).toEqual([])
  })

  it('un video pubblicato esce dalle schede, la riga locale si butta e la galleria si ricarica UNA volta', async () => {
    h.righe = [rigaArchivio()]
    server.voci = [voce('in-coda')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))

    server.voci = [voce('pubblicato', { mediaId: '66666666-6666-4666-8666-666666666666' })]
    await giroDiElenco()
    await waitFor(() => expect(result.current.righe).toEqual([]))
    expect(h.elimina).toHaveBeenCalledWith(JOB)
    expect(opts.onPubblicato).toHaveBeenCalledTimes(1)
    // Una lettura successiva non ricarica di nuovo.
    await giroDiElenco()
    expect(opts.onPubblicato).toHaveBeenCalledTimes(1)
  })

  it('un video già pubblicato al primo sguardo NON ricarica la galleria: c’è già, la pagina l’ha appena letta', async () => {
    server.voci = [voce('pubblicato', { mediaId: '66666666-6666-4666-8666-666666666666' })]
    const { result } = await montaAttendendo()
    await act(async () => {})
    expect(result.current.righe).toEqual([])
    expect(opts.onPubblicato).not.toHaveBeenCalled()
  })

  it('un video che passa da «in coda» a «pubblicato» fra due letture, mandato da un altro dispositivo, ricarica la galleria', async () => {
    server.voci = [voce('in-coda')]
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))
    server.voci = [voce('pubblicato')]
    await giroDiElenco()
    await waitFor(() => expect(opts.onPubblicato).toHaveBeenCalledTimes(1))
  })

  it('«annullato» altrove: la scheda con la riga locale lo dice, e il server-only non compare', async () => {
    h.righe = [rigaArchivio()]
    server.voci = [voce('annullato'), voce('annullato', { jobId: uuid(500), intentId: uuid(600) })]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('annullato'))
    expect(result.current.righe).toHaveLength(1)
  })
})

describe('senza rete l’elenco non si chiede', () => {
  it('offline nessuna lettura (ogni giro a vuoto lascerebbe una riga d’errore); online la prima lettura arriva', async () => {
    const spia = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderHook(() => useVideoGalleria(opts))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(elenchi()).toHaveLength(0)
    spia.mockRestore()

    // La prova che l'assenza è merito del controllo: a rete tornata, lo stesso montaggio la chiede.
    renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(elenchi().length).toBeGreaterThan(0))
  })
})

describe('il polling dell’elenco: ogni 10 secondi, solo se c’è qualcosa di attivo', () => {
  it('con una scheda attiva il ritmo è di 10 secondi; senza, solo al ritorno in primo piano (`null`)', async () => {
    server.voci = [voce('in-coda')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))
    expect(pollingElenco()[1]).toBe(10_000)
    expect(pollingElenco()[2]).toMatchObject({ attivo: true })

    server.voci = [voce('pubblicato')]
    await giroDiElenco()
    await waitFor(() => expect(result.current.righe).toEqual([]))
    // Nulla di attivo: l'orologio si ferma. Resta il ritorno in primo piano, che non costa niente.
    expect(pollingElenco()[1]).toBeNull()
  })

  it('un video che ha finito male non tiene vivo il polling', async () => {
    server.voci = [voce('fallito')]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('fallito'))
    expect(pollingElenco()[1]).toBeNull()
  })

  it('senza identità e sede il polling non è armato', async () => {
    renderHook(() => useVideoGalleria({ ...opts, utenteId: null, sede: null }))
    await act(async () => {})
    expect(pollingElenco()[2]).toMatchObject({ attivo: false })
  })

  it('un giro dell’orologio chiede l’elenco, e due giri insieme ne fanno una richiesta sola', async () => {
    let completa!: (r: Response) => void
    const { result } = await montaAttendendo()
    const prima = elenchi().length
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      chiamate.push({ url, metodo: init?.method ?? 'GET', corpo: null })
      return new Promise<Response>((r) => { completa = r })
    }))
    await act(async () => { void (pollingElenco()[0] as () => unknown)(); void (pollingElenco()[0] as () => unknown)(); await Promise.resolve() })
    expect(elenchi().length).toBe(prima + 1)
    await act(async () => { completa(json({ voci: [] })) })
    expect(result.current.righe).toEqual([])
  })

  it('una voce che non rispetta il contratto non fa sparire le altre schede', async () => {
    server.voci = [voce('in-coda'), { jobId: 'non-un-uuid', fase: '???' }]
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe).toHaveLength(1))
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-galleria-voci-fuori-contratto' }))
  })
})
