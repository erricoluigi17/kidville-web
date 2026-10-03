import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
 *    vede, una pubblicazione fallita offre «Riprova», un fallimento non resta lì per sempre;
 *  · (T11c) una risposta d'apertura arrivata a schermata cambiata ritira l'intento che ha creato (#132) —
 *    ma non quello che questo dispositivo ha già in mano —; lo stesso file rimandato in volo non riscrive
 *    la scheda (#134); «Rimuovi» su un trasferimento concluso non termina nessuna sessione TUS (#136);
 *    ogni ritiro non atteso ha il suo `.catch` che logga (#137); un intento si ricorda fra i tolti solo a
 *    ritiro riuscito, altrimenti la scheda torna (#141); la chiave dell'apertura è salata col sale del
 *    dispositivo (#131).
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
  aggiorna: vi.fn(),
  elimina: vi.fn(),
  log: vi.fn(),
  ordine: [] as string[],
  // Il plugin dei caricamenti NATIVI (app 1.2): finto SOLO nelle sue chiamate. `codiceDelPonte` e `ErroreCaricamentiNativi`
  // restano VERI — sono loro a ridurre un rifiuto a un codice dell'elenco chiuso, ed è quello che finisce nei log.
  nDisponibili: vi.fn(),
  nAccoda: vi.fn(),
  nElenco: vi.fn(),
  nAnnulla: vi.fn(),
  nDimentica: vi.fn(),
  nScarta: vi.fn(),
  nAscolta: vi.fn(),
  nTogliAscolto: vi.fn(),
  /** Il gestore degli eventi `caricamento` che l'hook ha registrato (lo chiama il test). */
  eventoNativo: null as null | ((voce: unknown) => void),
  /** L'archivio IndexedDB risponde quando questa promessa si risolve (di norma è già risolta). */
  attesaArchivio: Promise.resolve() as Promise<void>,
  /** Ogni lettura di una riga dell'archivio (per provare che un video nativo non la chiede mai). */
  leggiArchivio: vi.fn(),
}))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log, nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto') }))
vi.mock('@/lib/native/caricamenti-nativi', async (originale) => ({
  ...(await originale<typeof import('@/lib/native/caricamenti-nativi')>()),
  caricamentiNativiDisponibili: h.nDisponibili,
  accodaVideo: h.nAccoda,
  elenco: h.nElenco,
  annulla: h.nAnnulla,
  dimentica: h.nDimentica,
  scartaScelti: h.nScarta,
  ascoltaCaricamenti: h.nAscolta,
}))
vi.mock('@/lib/hooks/use-polling-visibile', () => ({ usePollingVisibile: vi.fn() }))
vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: async () => ({
    leggi: async (id: string) => { h.leggiArchivio(id); return h.righe.find((r) => r.jobId === id) },
    elenca: async () => { await h.attesaArchivio; return h.righe },
    aggiorna: h.aggiorna,
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
import { scegliTrasporto } from '@/lib/media/video/trasporto'
import { ErroreCaricamentiNativi } from '@/lib/native/caricamenti-nativi'
import { CODICI_RIFIUTO_PONTE, type CaricamentoNativo } from '@/lib/native/caricamenti-nativi-tipi'

const OWNER = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const ADA = '55555555-5555-4555-8555-555555555555'
const COORD = { protocollo: 'tus', endpoint: 'https://example.test/tus', bucket: 'video_originals', percorso: `${OWNER}/a.mp4`, contentType: 'video/mp4', dimensioneBloccoByte: 6291456 }
const ADESSO = '2026-10-02T10:00:00.000Z'

/** Due sali di dispositivo (128 bit, esadecimale minuscolo): la forma che `saleDelDispositivo` produce. */
const SALE_A = '0123456789abcdef0123456789abcdef'
const SALE_B = 'fedcba9876543210fedcba9876543210'

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
  h.aggiorna.mockImplementation(async (id: string, mod: object) => Object.assign(h.righe.find((r) => r.jobId === id) ?? {}, mod))
  h.elimina.mockImplementation(async (id: string) => { h.righe = h.righe.filter((r) => r.jobId !== id) })
  h.annullaLocale.mockImplementation(async () => { h.ordine.push('annullaCaricamento') })
  h.concludi.mockResolvedValue(undefined)
  // Il plugin dei caricamenti nativi: di default NON c'è (web, app 1.0/1.1), e i test di prima non cambiano.
  h.attesaArchivio = Promise.resolve()
  h.nDisponibili.mockResolvedValue(null)
  h.nElenco.mockResolvedValue({ caricamenti: [] })
  h.nAnnulla.mockResolvedValue({ annullato: true })
  h.nDimentica.mockResolvedValue({ dimenticati: 1 })
  h.nScarta.mockResolvedValue({ eliminati: 1 })
  h.nTogliAscolto.mockResolvedValue(undefined)
  h.eventoNativo = null
  h.nAscolta.mockImplementation(async (cb: typeof h.eventoNativo) => {
    h.eventoNativo = cb
    return h.nTogliAscolto
  })
  h.nAccoda.mockImplementation(async (richiesta: { jobId: string; intentId: string; utenteId: string; scuolaId: string }) =>
    voceNativa({ jobId: richiesta.jobId, intentId: richiesta.intentId, utenteId: richiesta.utenteId, scuolaId: richiesta.scuolaId }))
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

  it('…e se quel ritiro LANCIA l’errore si registra: nessuna promessa rifiutata che nessuno ascolta (#137)', async () => {
    h.accoda.mockResolvedValueOnce({ ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    const { result } = await montaAttendendo()
    // Il GET dello stato risponde con qualcosa che non è una `Response`: `chiama` lancia e `ritiraIntento` rifiuta.
    const base = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (
      /\/api\/video-uploads\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET'
        ? ({ ok: true, status: 200 } as unknown as Response)
        : base(url, init)
    )))
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreVideoOperazioneNonRiuscita })
    // Senza il `.catch` la promessa restava rifiutata e senza traccia (e vitest la segnala come errore non gestito).
    await waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-annullamento-interrotto' })))
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

  it('una risposta di apertura arrivata dopo un cambio di sede NON accoda niente nella sede sbagliata, e RITIRA l’intento che ha creato', async () => {
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
    // L'intento esiste già sul server, confermato e in attesa di byte che nessuno spedirà (#132): si ritira.
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.url).toBe(`/api/video-uploads/${uuid(201)}`)
  })

  it('dopo lo smontaggio una risposta tardiva non accoda niente, e RITIRA l’intento: niente intento fantasma (#132)', async () => {
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    const { result, unmount } = await montaAttendendo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(1))
    unmount()
    await act(async () => { risolvi(aperturaStandard(1)); await promessa })
    expect(h.accoda).not.toHaveBeenCalled()
    // Senza il ritiro restava un job `awaiting_upload` che nessuno avrebbe caricato, e al rientro la scheda
    // diceva «in caricamento da un altro dispositivo»: falso.
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.url).toBe(`/api/video-uploads/${uuid(201)}`)
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: `video-intento-orfano-ritirato: job=${uuid(101)}` }))
  })

  it('anche la SECONDA apertura (il primo intento ritrovato era concluso) ritira il proprio intento se arriva a schermata cambiata', async () => {
    // Il primo intento ritrovato è pubblicato: non è nostro e non si tocca. Ne nasce uno nuovo, con una chiave nuova:
    // se la sua risposta arriva a pagina chiusa, è quello il fantasma.
    let risolvi!: (r: Response) => void
    server.apertura = (n) => (n === 1
      ? aperturaStandard(1, { intent: 'published', job: { status: 'ready', needs_upload: false, firma: '' } })
      : new Promise<Response>((r) => { risolvi = r }))
    const { result, unmount } = await montaAttendendo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(2))
    unmount()
    await act(async () => { risolvi(aperturaStandard(2)); await promessa })

    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    // Quello del secondo intento (202), e solo quello: l'intento concluso (201) non si tocca.
    expect(chiamate.filter((c) => c.metodo === 'PATCH').map((c) => c.url)).toEqual([`/api/video-uploads/${uuid(202)}`])
    expect(h.accoda).not.toHaveBeenCalled()
  })

  it('un intento RITROVATO già concluso (job fallito) non è nostro: a schermata cambiata non si tocca', async () => {
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    const { result, unmount } = await montaAttendendo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(1))
    unmount()
    // L'intento è ancora «confermato» ma il suo job è fallito: è un intento morto, e il ritiro lo cambierebbe.
    await act(async () => { risolvi(aperturaStandard(1, { job: { status: 'failed', needs_upload: false, firma: '' } })); await promessa })
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(patchFatti()).toEqual([])
    expect(aperture()).toHaveLength(1)
  })

  it('l’intento RITROVATO dalla chiave e già in mano a questo dispositivo NON si ritira: sarebbe un caricamento buono ucciso', async () => {
    // Lo stesso file con gli stessi bambini, mandato due volte: il server ritrova lo stesso intento. Il primo
    // invio è in volo (ha la sua riga nell'archivio): se il secondo tocco arriva a schermata cambiata, il
    // fantasma non esiste — e ritirarlo ucciderebbe l'invio che riprenderebbe al rientro.
    h.carica.mockImplementation(() => new Promise(() => undefined)) // il primo trasferimento resta in volo
    const { result, unmount } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) }) // job 101, intento 201
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))

    // Il secondo invio: la risposta resta in sospeso, poi la pagina se ne va e la risposta arriva — con lo
    // STESSO job del primo, come quando la stessa chiave ritrova lo stesso intento.
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(2))
    unmount()
    await act(async () => { risolvi(aperturaStandard(1)); await promessa })

    // Si lascia al ritiro il tempo di partire, se dovesse: poi si guarda che non sia partito.
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(patchFatti()).not.toContain('annulla')
  })

  it('un guasto della RETE durante il ritiro dell’intento fantasma non diventa una promessa rifiutata: si registra', async () => {
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    const { result, unmount } = await montaAttendendo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(1))
    unmount()
    // Il ritiro non riesce (la rete cade): niente `annulla`, e il mancato ritiro si dice.
    server.patch = () => json({ error: 'x', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }, 500)
    await act(async () => { risolvi(aperturaStandard(1)); await promessa })
    await waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: `video-intento-orfano-non-ritirato: job=${uuid(101)}` })))
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

  it('la chiave porta il SALE del dispositivo: lo stesso file con gli stessi bambini, da un altro dispositivo, è un’altra chiave (#131)', async () => {
    // I bambini non restano in tabella nemmeno come impronta: la chiave scritta in `video_jobs.idempotency_key` è
    // salata con un valore casuale del dispositivo, tenuto in `localStorage` (`kv:video-galleria-sale`).
    server.apertura = aperturaSecondoIlServer()
    const { result } = await montaAttendendo()
    localStorage.setItem('kv:video-galleria-sale', SALE_A)
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    localStorage.setItem('kv:video-galleria-sale', SALE_B) // un altro dispositivo
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    localStorage.setItem('kv:video-galleria-sale', SALE_A) // il primo dispositivo, di nuovo
    await act(async () => { await result.current.avviaVideo(video(), scelta) })

    expect(chiaveDellApertura(1), 'un altro sale deve dare un’altra chiave').not.toBe(chiaveDellApertura(0))
    expect(chiaveDellApertura(2), 'lo stesso dispositivo ritrova la sua chiave').toBe(chiaveDellApertura(0))
  })

  it('la chiave che parte NON porta l’impronta di prima (senza sale) dei bambini né del nome, e non porta il sale', async () => {
    server.apertura = aperturaSecondoIlServer()
    const { result } = await montaAttendendo()
    localStorage.setItem('kv:video-galleria-sale', SALE_A)
    await act(async () => { await result.current.avviaVideo(video('recita.mp4'), scelta) })
    const chiave = chiaveDellApertura(0)
    // Valori misurati col codice senza sale (FNV a 32 bit del JSON dei bambini e del nome), scritti e non ricalcolati.
    expect(chiave).not.toContain('7014e1f0')
    expect(chiave).not.toContain('afbbf116')
    expect(chiave).not.toContain(SALE_A)
    expect(chiave).toMatch(/^gv2-12345-1726000000000-[0-9a-f]{12}-[0-9a-f]{12}$/)
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
// LO STESSO FILE RIMANDATO MENTRE IL SUO TRASFERIMENTO È IN VOLO (#134)
// ═══════════════════════════════════════════════════════════════════════════
//
// La stessa chiave (stesso file, stessi bambini, stesso dispositivo) ritrova lo stesso intento e lo stesso job:
// `accodaCaricamentoVideo` lo lascia com'era, e anche la scheda deve restare quella vera. Riscriverla a «in-fila»
// la faceva tornare a «in attesa del suo turno», senza barra, mentre i byte correvano.

describe('lo stesso file rimandato durante il suo trasferimento non ne riscrive lo stato', () => {
  /** Un trasferimento che non finisce mai, e il suo avanzamento in mano al test. */
  function trasferimentoInVolo() {
    const stato: { progresso: (fatti: number, totali: number) => void } = { progresso: () => undefined }
    h.carica.mockImplementation((_dip: unknown, _jobId: string, opzioni: { alProgresso?: (f: number, t: number) => void }) => {
      if (opzioni.alProgresso) stato.progresso = opzioni.alProgresso
      return new Promise(() => undefined)
    })
    return stato
  }

  it('la scheda resta «caricamento» con la sua barra — non torna a «in attesa del suo turno» — e il trasferimento è UNO', async () => {
    server.apertura = aperturaSecondoIlServer()
    const volo = trasferimentoInVolo()
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    act(() => volo.progresso(40, 100))
    await waitFor(() => expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', percentuale: 40 }))

    // Lo stesso file con gli stessi bambini: il server ritrova lo stesso intento e lo stesso job.
    let esito: unknown
    await act(async () => { esito = await result.current.avviaVideo(video(), scelta) })

    expect(esito).toEqual({ ok: true })
    expect(aperture()).toHaveLength(2)
    expect(result.current.righe, 'una scheda sola, non due').toHaveLength(1)
    expect(result.current.righe[0], 'la scheda è tornata a «in attesa del suo turno», senza barra').toMatchObject({ fase: 'caricamento', percentuale: 40 })
    expect(h.carica, 'il trasferimento è ripartito da capo').toHaveBeenCalledTimes(1)
  })

  it('anche in FILA (accodato dietro un altro video) resta in fila: nessun secondo accodamento', async () => {
    server.apertura = aperturaSecondoIlServer()
    trasferimentoInVolo()
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video('uno.mp4', 11), scelta) })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.avviaVideo(video('due.mp4', 22), scelta) })
    expect(result.current.righe.map((r) => r.fase)).toEqual(['caricamento', 'in-fila'])

    await act(async () => { await result.current.avviaVideo(video('due.mp4', 22), scelta) })
    expect(result.current.righe.map((r) => r.fase)).toEqual(['caricamento', 'in-fila'])
    expect(h.carica).toHaveBeenCalledTimes(1)
  })

  it('un trasferimento FERMO rimandato riparte: rimandare il file è chiedere di riprendere', async () => {
    // Il guard non deve diventare «mai più»: un job `interrotto` non è in coda, e rimandarlo lo riprende.
    server.apertura = aperturaSecondoIlServer()
    h.carica.mockResolvedValueOnce({ esito: 'interrotto', jobId: uuid(101), offsetByte: 0, codice: null })
    const { result } = await montaAttendendo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))
    expect(h.carica).toHaveBeenCalledTimes(1)

    h.carica.mockImplementationOnce(() => new Promise(() => undefined))
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(2))
    expect(h.carica.mock.calls[1][1]).toBe(uuid(101))
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

  it('un video coi byte GIÀ sul server (trasferimento concluso): niente terminazione TUS — la riga si marca annullata e si elimina (#136)', async () => {
    // Dopo un trasferimento riuscito la riga conserva l'URL della sessione TUS: `annullaCaricamentoVideo` lo
    // «terminerebbe» con una `DELETE` che passa da `/firma`, trova il job fuori da `awaiting_upload`, prende 409 e
    // lascia due `warn` che non dicono niente.
    h.righe = [rigaArchivio({ urlTus: 'https://example.test/tus/sessione-1' })] // stato `caricato`
    server.voci = [voce('in-coda')]
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))

    act(() => result.current.rimuovi(JOB))
    await waitFor(() => expect(h.elimina).toHaveBeenCalledWith(JOB))
    expect(h.annullaLocale, 'la DELETE TUS di una sessione che non esiste più prende 409 e due warn inutili').not.toHaveBeenCalled()
    expect(h.aggiorna).toHaveBeenCalledWith(JOB, expect.objectContaining({ stato: 'annullato' }))
    // Prima si marca annullato, poi si elimina; e l'intento si ritira lo stesso.
    expect(h.aggiorna.mock.invocationCallOrder[0]).toBeLessThan(h.elimina.mock.invocationCallOrder[0])
    expect(patchFatti()).toEqual(['annulla'])
  })

  it('…e se la riga locale non si marca (l’archivio non risponde) il ritiro dell’intento parte lo stesso, e il guasto si registra', async () => {
    // Non c'è nessun trasferimento da fermare: ciò che conta è che il server sappia che il video non si vuole più.
    h.righe = [rigaArchivio({ urlTus: 'https://example.test/tus/sessione-1' })]
    server.voci = [voce('in-coda')]
    h.aggiorna.mockRejectedValueOnce(new Error('archivio'))
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))

    act(() => result.current.rimuovi(JOB))
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    await waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-riga-locale-non-annullata' })))
    // E il ritiro è riuscito: la scheda resta tolta, anche dopo un ricaricamento.
    await waitFor(() => expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toContain(INTENT))
    expect(result.current.righe).toEqual([])
  })

  it('un ritiro che FALLISCE non rende la scheda «tolta»: torna, e l’intento NON entra fra i nascosti (#141)', async () => {
    server.voci = [voce('da-ricaricare')]
    server.patch = (azione) => (azione === 'annulla' ? json({ error: 'x', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }, 500) : null)
    const primo = await montaAttendendo()
    await waitFor(() => expect(primo.result.current.righe[0]?.fase).toBe('da-ricaricare'))

    act(() => primo.result.current.rimuovi(JOB))
    // A schermo sparisce subito: l'attesa del server non si vede.
    expect(primo.result.current.righe).toEqual([])
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    // Il server ha rifiutato: l'intento è ancora vivo (e, se fosse in preparazione, uscirebbe in galleria): la scheda TORNA.
    await waitFor(() => expect(primo.result.current.righe[0]?.fase).toBe('da-ricaricare'))
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: `video-ritiro-non-riuscito: job=${JOB}` }))
    // …e non è stato ricordato: nemmeno dopo un ricaricamento sparisce una scheda che il server non ha tolto.
    expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toBeNull()
    primo.unmount()
    const secondo = await montaAttendendo()
    await waitFor(() => expect(secondo.result.current.righe[0]?.fase).toBe('da-ricaricare'))
  })

  it('un ritiro che LANCIA (la rete cade a metà) si comporta come uno rifiutato: la scheda torna, e il guasto si registra', async () => {
    server.voci = [voce('da-ricaricare')]
    const { result } = await montaAttendendo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('da-ricaricare'))
    // Il GET dello stato risponde con qualcosa che non è una `Response`: `chiama` lancia, e `ritiraIntento` rifiuta.
    const base = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (
      /\/api\/video-uploads\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET'
        ? ({ ok: true, status: 200 } as unknown as Response)
        : base(url, init)
    )))

    act(() => result.current.rimuovi(JOB))
    await waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-annullamento-interrotto' })))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('da-ricaricare'))
    expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toBeNull()
  })

  it('una scheda tolta NON torna, nemmeno se il server la riporta ancora (e dopo un ricaricamento)', async () => {
    server.voci = [voce('da-ricaricare')]
    const primo = await montaAttendendo()
    await waitFor(() => expect(primo.result.current.righe[0]?.fase).toBe('da-ricaricare'))
    act(() => primo.result.current.rimuovi(JOB))
    expect(primo.result.current.righe).toEqual([])
    // Si ricorda solo quando il server ha confermato il ritiro (#141): si aspetta quel momento prima di leggere
    // l'elenco e prima di ricaricare, altrimenti il test dipenderebbe da quanto è veloce il finto server.
    await waitFor(() => expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toContain(INTENT))
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

// ═══════════════════════════════════════════════════════════════════════════
// L'APP 1.2: I VIDEO NATIVI (compito J3) — invio, elenco unito, «Rimuovi»
// ═══════════════════════════════════════════════════════════════════════════
//
// Un video scelto dal selettore NATIVO non è un `File`: i suoi byte stanno nel plugin, che li spedisce dal sistema
// operativo con una PUT sola. Questo hook non li trasferisce: apre l'intento, consegna al plugin ciò che gli serve e
// RACCONTA ciò che il plugin dice. Si prova qui:
//
//  · l'invio: apertura `put-nativo` con `sha256` e chiave `gn1-`, `accodaVideo` con i campi della risposta e gli id in
//    minuscolo, il 422 che resta alla schermata prima di un byte, l'accodamento fallito che ritira l'intento;
//  · l'elenco UNITO: le voci del plugin (anche senza rete, a ogni evento) si fondono con quelle del server, e una voce
//    di un'altra sede o di un altro utente non si vede;
//  · «caricato» UNA volta a `inviato`, la voce terminale che si dimentica, «Rimuovi» che ferma prima i byte;
//  · la ripresa automatica TUS che ignora le righe native, e `scegliTrasporto()` che resta `tus` per ogni `File`.
//
// Il plugin è finto SOLO nelle sue chiamate: i suoi rifiuti sono `ErroreCaricamentiNativi` veri, perché è il codice
// dell'elenco chiuso — e non il messaggio — ciò che deve finire nei log.

const SHA_NATIVO = createHash('sha256').update('contenuto del video nativo').digest('hex')
const NOME_PRIVATO = 'filmato-privato-di-ada.mov'
const INFO_PLUGIN = { protocollo: 1, piattaforma: 'ios', motore: 'urlsession' } as const
// L'host della PUT è quello del progetto Supabase del SITO (`caricamenti-nativi-tipi.ts`): sotto vitest, il banco locale.
const URL_PUT = 'https://localhost:54321/storage/v1/object/upload/sign/video_originals/percorso.mov?token=TOKEN-FINTO-DELLA-PUT'
/** `kvr_` più 43 caratteri base64url: la forma del token che il server conia. */
const TOKEN_RINNOVO = `kvr_${'Ab1_-'.repeat(8)}Ab1`
const SCADENZA_URL = '2026-10-03T12:00:00.000Z'
const SCADENZA_TOKEN = '2026-10-05T10:00:00.000Z'
/** Un token «ruotato»: la stessa forma, un valore diverso a ogni rotazione. */
const tokenRuotato = (k: number) => `kvr_${'A'.repeat(42)}${k}`

/** Un elemento video com'è consegnato dal selettore nativo (`ElementoVideoScelto`). */
function nativoVideo(extra: Record<string, unknown> = {}) {
  return {
    id: 'video-1', tipo: 'video' as const, nome: NOME_PRIVATO, byte: 73_000_000, mime: 'video/quicktime',
    durataSecondi: 52, miniatura: null, sha256: SHA_NATIVO, ...extra,
  }
}

/** Una voce della coda del plugin: i campi che il ponte rilegge con `schemaCaricamentoNativo`. */
function voceNativa(extra: Partial<CaricamentoNativo> = {}): CaricamentoNativo {
  return {
    jobId: uuid(101), intentId: uuid(201), utenteId: OWNER, scuolaId: SEDE, nome: NOME_PRIVATO,
    mime: 'video/quicktime', stato: 'in-coda', byteInviati: 0, byteTotali: 73_000_000, tentativi: 0, rinnovi: 0,
    codice: null, creatoIl: ADESSO, aggiornatoIl: ADESSO, ...extra,
  }
}

/** La risposta di un'apertura `put-nativo`: l'URL firmato nel job e il token di rinnovo accanto. */
function aperturaNativa(n: number, extra: { intent?: string; token?: string; job?: Record<string, unknown> } = {}) {
  return json(
    {
      intentId: uuid(200 + n),
      revisione: 1,
      canale: 'gallery',
      intent: { status: extra.intent ?? 'confirmed' },
      scadenzaCaricamentoIl: SCADENZA_URL,
      job: [{
        jobId: uuid(100 + n),
        chiaveIdempotenza: `gn1-prova-${n}`,
        caricamento: { protocollo: 'put', url: URL_PUT, metodo: 'PUT', intestazioni: { 'content-type': 'video/quicktime' } },
        firma: '',
        status: 'awaiting_upload',
        needs_upload: true,
        expires_at: SCADENZA_URL,
        rinnovo: { token: extra.token ?? TOKEN_RINNOVO, scadeIl: SCADENZA_TOKEN },
        ...extra.job,
      }],
    },
    201,
  )
}

/** I byte sono GIÀ sullo Storage: il server manda coordinate TUS di ripiego, nessun token, `needs_upload: false`. */
const GIA_ARRIVATO = { needs_upload: false, caricamento: COORD, rinnovo: undefined, expires_at: null }

/**
 * Il server finto con la semantica di `video_galleria_intent_apri` per il trasporto NATIVO (spec §5.3): la stessa chiave
 * con gli STESSI destinatari e lo stesso `sha256` è una ripetizione — ritrova lo stesso intento e RUOTA il token —, con
 * destinatari diversi è `IDEMPOTENCY_CONFLICT` (409 `VIDEO_RIPROVA`), altrimenti è un intento nuovo.
 */
function aperturaNativaSecondoIlServer() {
  const viste = new Map<string, { contenuto: string; n: number; rotazioni: number }>()
  return (n: number, corpo: Record<string, unknown>): Response => {
    const f = (corpo.file as Array<{ chiaveIdempotenza: string; sha256?: string }>)[0]
    const d = corpo.destinatari as { tagAlunni: string[]; broadcast: boolean; classi: string[] }
    const contenuto = JSON.stringify([[...new Set(d.tagAlunni)].sort(), d.broadcast, [...new Set(d.classi)].sort(), f.sha256, corpo.trasporto])
    const prima = viste.get(f.chiaveIdempotenza)
    if (prima && prima.contenuto !== contenuto) return json({ error: 'Qualcosa è cambiato.', codice: 'VIDEO_RIPROVA' }, 409)
    if (prima) {
      prima.rotazioni += 1
      return aperturaNativa(prima.n, { token: tokenRuotato(prima.rotazioni) })
    }
    viste.set(f.chiaveIdempotenza, { contenuto, n, rotazioni: 0 })
    return aperturaNativa(n)
  }
}

/** La voce del SERVER per il video che il plugin sta spedendo: lo stesso job e lo stesso intento di `voceNativa()`. */
const voceDelNativo = (fase: string, extra: Record<string, unknown> = {}) =>
  voce(fase, { trasporto: 'put-nativo', jobId: uuid(101), intentId: uuid(201), ...extra })

/** Il corpo della n-esima POST di apertura. */
const corpoApertura = (n = 0) => aperture()[n].corpo as Record<string, unknown> & {
  file: Array<{ chiaveIdempotenza: string; sha256?: string; nome: string; byte: number; mime: string }>
  destinatari: { tagAlunni: string[]; broadcast: boolean; classi: string[] }
}
const tutteLeRigheDiLog = () => JSON.stringify(h.log.mock.calls)
const richiestaAccodata = (n = 0) => h.nAccoda.mock.calls[n][0] as Record<string, unknown>
const logsDi = (prefisso: string) =>
  h.log.mock.calls.map((c) => c[0] as { livello: string; evento: string; messaggio: string; campi?: Record<string, unknown> })
    .filter((r) => r.messaggio.startsWith(prefisso))

/** Monta con il plugin PRESENTE e aspetta che l'ascolto degli eventi sia agganciato (l'hook ha finito di avviarsi). */
async function montaNativo(o: OpzioniVideoGalleria = opts) {
  h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
  const v = await montaAttendendo(o)
  if (o.utenteId && o.sede) await waitFor(() => expect(h.nAscolta).toHaveBeenCalled())
  return v
}

describe('«Invia» un video NATIVO: apre l’intento `put-nativo` e lo consegna al plugin, con i campi della risposta', () => {
  beforeEach(() => { server.apertura = (n) => aperturaNativa(n) })

  it('la POST dichiara `put-nativo`, lo `sha256`, i bambini e la chiave `gn1-`; poi `accodaVideo` coi campi della risposta e NIENTE TUS', async () => {
    const { result } = await montaNativo()
    let esito: unknown
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito).toEqual({ ok: true })

    const apertura = corpoApertura()
    expect(apertura).toMatchObject({ canale: 'gallery', azione: 'publish', scuolaId: SEDE, trasporto: 'put-nativo' })
    expect(apertura.destinatari).toEqual({ tagAlunni: [ADA], broadcast: false, classi: [] })
    expect(apertura.file[0]).toMatchObject({ nome: NOME_PRIVATO, byte: 73_000_000, mime: 'video/quicktime', sha256: SHA_NATIVO })
    expect(apertura.file[0].chiaveIdempotenza).toMatch(/^gn1-73000000-[0-9a-f]{12}-[0-9a-f]{12}$/)

    // `accodaVideo`: ESATTAMENTE ciò che il plugin vuole, dalla risposta del server e dall'origine della pagina.
    expect(h.nAccoda).toHaveBeenCalledTimes(1)
    expect(richiestaAccodata()).toEqual({
      idElemento: 'video-1',
      sha256: SHA_NATIVO,
      byteAttesi: 73_000_000,
      jobId: uuid(101),
      intentId: uuid(201),
      utenteId: OWNER,
      scuolaId: SEDE,
      caricamento: { url: URL_PUT, contentType: 'video/quicktime', scadeIl: SCADENZA_URL },
      rinnovo: { url: `${window.location.origin}/api/video-uploads/rinnovo`, token: TOKEN_RINNOVO, scadeIl: SCADENZA_TOKEN },
      registro: { url: `${window.location.origin}/api/logs` },
      testi: {
        titolo: itServizi.notificaCaricamentoTitolo,
        invio: itServizi.notificaCaricamentoInvio,
        attesaRete: itServizi.notificaCaricamentoAttesaRete,
        pausa: itServizi.notificaCaricamentoPausa,
      },
    })

    // Nessun byte passa dal TUS e nessuna riga nasce nell'archivio IndexedDB: l'invio è del plugin.
    expect(h.accoda).not.toHaveBeenCalled()
    expect(h.carica).not.toHaveBeenCalled()
    expect(h.concludi).not.toHaveBeenCalled()
    expect(h.aggiorna).not.toHaveBeenCalled()
    // E la scheda racconta ciò che il plugin ha risposto: accodato, in attesa del suo turno, con la nota dell'invio.
    await waitFor(() => expect(result.current.righe).toHaveLength(1))
    expect(result.current.righe[0]).toMatchObject({
      jobId: uuid(101), nome: NOME_PRIVATO, fase: 'in-fila', trasporto: 'nativo', messaggio: itServizi.galleryVideoNotaNativo,
    })
    // «Caricato» NON si dice all'accodamento: i byte non sono ancora partiti.
    expect(patchFatti()).toEqual([])
  })

  it('in broadcast i bambini non partono e le classi sì', async () => {
    const { result } = await montaNativo()
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), { tag: [ADA], broadcast: true, durataSecondi: 52 }) })
    expect(corpoApertura().destinatari).toEqual({ tagAlunni: [], broadcast: true, classi: ['3 ANNI'] })
  })

  it('gli id verso il plugin sono in MINUSCOLO: lo schema li rifiuta altrimenti, e la sede del cookie può avere le maiuscole (S1 n. 3)', async () => {
    // Id CON LETTERE esadecimali: uno fatto di sole cifre ha la stessa grafia in maiuscolo e in minuscolo, e un test così
    // resterebbe verde anche senza la normalizzazione.
    const JOB_MAIUSCOLO = 'ABCDEF01-0000-4000-8000-0000000000AB'
    const INTENTO_MAIUSCOLO = 'FEDCBA98-0000-4000-8000-0000000000CD'
    const UTENTE_MAIUSCOLO = 'ABCD1111-1111-4111-8111-111111111111'
    const SEDE_MAIUSCOLA = 'ABCD2222-2222-4222-8222-222222222222'
    server.apertura = () => json({
      intentId: INTENTO_MAIUSCOLO,
      revisione: 1,
      canale: 'gallery',
      intent: { status: 'confirmed' },
      scadenzaCaricamentoIl: SCADENZA_URL,
      job: [{
        jobId: JOB_MAIUSCOLO, chiaveIdempotenza: 'gn1-prova', status: 'awaiting_upload', needs_upload: true, firma: '', expires_at: SCADENZA_URL,
        caricamento: { protocollo: 'put', url: URL_PUT, metodo: 'PUT', intestazioni: { 'content-type': 'video/quicktime' } },
        rinnovo: { token: TOKEN_RINNOVO, scadeIl: SCADENZA_TOKEN },
      }],
    }, 201)
    const { result } = await montaNativo({ ...opts, utenteId: UTENTE_MAIUSCOLO, sede: SEDE_MAIUSCOLA })
    let esito: unknown
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito).toEqual({ ok: true })

    // Alla POST la sede va com'è (il server accetta l'uuid in ogni grafia); al plugin tutto in minuscolo.
    expect(corpoApertura().scuolaId).toBe(SEDE_MAIUSCOLA)
    const r = richiestaAccodata()
    expect(r).toMatchObject({
      jobId: JOB_MAIUSCOLO.toLowerCase(), intentId: INTENTO_MAIUSCOLO.toLowerCase(),
      utenteId: UTENTE_MAIUSCOLO.toLowerCase(), scuolaId: SEDE_MAIUSCOLA.toLowerCase(),
    })
    for (const campo of ['jobId', 'intentId', 'utenteId', 'scuolaId']) {
      expect(r[campo], campo).toBe(String(r[campo]).toLowerCase())
      expect(r[campo], campo).not.toBe(String(r[campo]).toUpperCase())
    }
    // Lo schema vero del ponte, quello che l'involucro applica a ogni richiesta, lo accetta: nessuna sorpresa a runtime.
    const { schemaRichiestaAccodaVideo } = await import('@/lib/native/caricamenti-nativi-tipi')
    expect(schemaRichiestaAccodaVideo.safeParse(r).success).toBe(true)
    // E la scheda c'è, sotto l'id in minuscolo: la voce del plugin è dell'utente e della sede, comunque siano scritti.
    await waitFor(() => expect(result.current.righe[0]?.jobId).toBe(JOB_MAIUSCOLO.toLowerCase()))
  })

  it('UN 422 RESTA ALLA SCHERMATA: messaggio e nomi, e ZERO byte — nessun `accodaVideo`, nessuna copia scartata', async () => {
    server.apertura = () => json({ error: 'Foto di gruppo non pubblicabile: alcuni bambini non hanno la liberatoria foto.', nomi: ['Ada B.'], ids: [ADA] }, 422)
    const { result } = await montaNativo()
    let esito: { ok: boolean; messaggio?: string; nomi?: string[] } | undefined
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })

    expect(esito).toMatchObject({ ok: false, nomi: ['Ada B.'] })
    expect(esito?.messaggio).toContain('Foto di gruppo non pubblicabile')
    expect(h.nAccoda).not.toHaveBeenCalled()
    // Il video resta nel passo dei bambini: la sua copia sul telefono NON si tocca.
    expect(h.nScarta).not.toHaveBeenCalled()
    expect(chiamate.filter((c) => c.url !== '/api/video-uploads' && !c.url.startsWith('/api/video-uploads?'))).toEqual([])
    expect(result.current.righe).toEqual([])
    expect(tutteLeRigheDiLog()).not.toContain('Ada')
  })

  it('un rifiuto con codice (403 di sede), «troppe richieste» (429) e una rete caduta restano alla schermata, senza accodare niente', async () => {
    const { result } = await montaNativo()
    server.apertura = () => json({ error: 'prosa', codice: 'TAG_FUORI_SEDE' }, 403)
    let esito: { ok: boolean; messaggio?: string; riprovaPiuTardi?: boolean } | undefined
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreTagFuoriSede })

    server.apertura = () => new Response(JSON.stringify({ error: 'x', codice: 'TROPPE_RICHIESTE' }), { status: 429, headers: { 'Retry-After': '60' } })
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito).toMatchObject({ ok: false, riprovaPiuTardi: true })

    server.apertura = () => { throw new TypeError('Failed to fetch') }
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itServizi.galleryErrRete })
    expect(h.nAccoda).not.toHaveBeenCalled()
  })

  it('oltre il tetto di peso o di durata non si apre nemmeno l’intento; senza sede non si indovina il plesso', async () => {
    const { result } = await montaNativo()
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo({ byte: 2_000_000_001 }), scelta) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreVideoTroppoGrande })
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), { ...scelta, durataSecondi: 301 }) })
    expect(esito).toEqual({ ok: false, messaggio: itShared.erroreVideoTroppoLungo })
    expect(aperture()).toHaveLength(0)

    const senzaSede = await montaNativo({ ...opts, sede: null })
    await act(async () => { esito = await senzaSede.result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito?.ok).toBe(false)
    expect(esito?.messaggio).toBe(itShared.erroreSedeDaSpecificare)
    expect(aperture()).toHaveLength(0)
  })

  it('un hook già smontato non apre intenti: li ritirerebbe subito', async () => {
    const { result, unmount } = await montaNativo()
    unmount()
    let esito: { ok: boolean } | undefined
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito?.ok).toBe(false)
    expect(aperture()).toHaveLength(0)
    expect(h.nAccoda).not.toHaveBeenCalled()
  })

  it('i byte GIÀ sul server (`needs_upload: false`): niente accodamento, copia scartata, riga «conclusa» e «caricato» una volta', async () => {
    server.apertura = (n) => aperturaNativa(n, { job: GIA_ARRIVATO })
    const { result } = await montaNativo()
    let esito: unknown
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(esito).toEqual({ ok: true })

    expect(h.nAccoda).not.toHaveBeenCalled()
    // La copia preparata non serve più: si cancella dal telefono (la chiede il passo dei bambini al plugin).
    expect(h.nScarta).toHaveBeenCalledWith({ ids: ['video-1'] })
    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.corpo).toMatchObject({ azione: 'caricato', jobId: uuid(101), byte: 73_000_000, mime: 'video/quicktime' })
    // La parola è del server: «in coda», con il nome del file che il telefono conosce.
    await waitFor(() => expect(result.current.righe[0]).toMatchObject({ fase: 'in-coda', nome: NOME_PRIVATO, trasporto: 'nativo' }))
    expect(h.carica).not.toHaveBeenCalled()
  })

  it('l’apertura ripetuta (stesso video, stessi bambini) ritrova lo STESSO intento e RUOTA il token: `accodaVideo` riceve quello nuovo, e la scheda è una sola', async () => {
    server.apertura = aperturaNativaSecondoIlServer()
    const { result } = await montaNativo()
    // Il plugin è idempotente su `jobId`: la seconda chiamata sostituisce i segreti e restituisce lo stato attuale.
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo({ id: 'video-2' }), scelta) })

    expect(aperture()).toHaveLength(2)
    expect(corpoApertura(1).file[0].chiaveIdempotenza).toBe(corpoApertura(0).file[0].chiaveIdempotenza)
    expect(h.nAccoda).toHaveBeenCalledTimes(2)
    expect(richiestaAccodata(0)).toMatchObject({ jobId: uuid(101), intentId: uuid(201) })
    expect(richiestaAccodata(1)).toMatchObject({ jobId: uuid(101), intentId: uuid(201) })
    expect((richiestaAccodata(0).rinnovo as { token: string }).token).toBe(TOKEN_RINNOVO)
    expect((richiestaAccodata(1).rinnovo as { token: string }).token).toBe(tokenRuotato(1))
    expect(result.current.righe).toHaveLength(1)
  })

  it('lo stesso video con ALTRI bambini (per esempio dopo «Rimuovi») apre un intento nuovo: una chiave diversa, e il server non risponde 409', async () => {
    server.apertura = aperturaNativaSecondoIlServer()
    const { result } = await montaNativo()
    let primo: unknown
    let secondo: unknown
    await act(async () => { primo = await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    await act(async () => { secondo = await result.current.avviaVideoNativo(nativoVideo(), { ...scelta, tag: [ADA, uuid(900)] }) })

    expect(primo).toEqual({ ok: true })
    expect(secondo, 'il reinvio con altri bambini è stato rifiutato').toEqual({ ok: true })
    expect(corpoApertura(1).file[0].chiaveIdempotenza).not.toBe(corpoApertura(0).file[0].chiaveIdempotenza)
    expect(richiestaAccodata(1).jobId).not.toBe(richiestaAccodata(0).jobId)
  })

  it('un intento ritrovato GIÀ CONCLUSO non si riapre: una chiave nuova (col suffisso), un intento nuovo, e il plugin riceve QUELLO', async () => {
    server.apertura = (n) => (n === 1
      ? aperturaNativa(1, { intent: 'published', job: { status: 'ready', ...GIA_ARRIVATO } })
      : aperturaNativa(n))
    const { result } = await montaNativo()
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), scelta) })

    expect(aperture()).toHaveLength(2)
    const k1 = corpoApertura(0).file[0].chiaveIdempotenza
    const k2 = corpoApertura(1).file[0].chiaveIdempotenza
    expect(k2.startsWith(`${k1}-`)).toBe(true)
    expect(k2.length).toBeLessThanOrEqual(128)
    expect(richiestaAccodata()).toMatchObject({ jobId: uuid(102), intentId: uuid(202) })
    // La storia di un video nativo sta tutta in `client:caricamento-nativo` (spec §8.1): una query sola la legge intera.
    expect(logsDi('video-nuovo-intento-dopo-concluso')[0]).toMatchObject({ livello: 'warn', evento: 'caricamento-nativo', campi: { tipo: 'put-nativo' } })
  })
})

describe('un `accodaVideo` RIFIUTATO ritira l’intento, lo scrive nei log col solo codice, e il video resta nel passo dei bambini', () => {
  beforeEach(() => { server.apertura = (n) => aperturaNativa(n) })

  it.each([...CODICI_RIFIUTO_PONTE])('rifiuto %s: errore nel log con job e solo il codice, PATCH `annulla`, messaggio generico', async (codice) => {
    h.nAccoda.mockRejectedValueOnce(new ErroreCaricamentiNativi(codice))
    const { result } = await montaNativo()
    let esito: { ok: boolean; messaggio?: string } | undefined
    await act(async () => { esito = await result.current.avviaVideoNativo(nativoVideo(), scelta) })

    expect(esito).toEqual({ ok: false, messaggio: itServizi.galleryErrCaricamentoGenerico })
    // L'intento esiste già sul server, confermato e in attesa di byte che non partiranno: si ritira.
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    expect(logsDi('video-nativo-accodamento-fallito')).toEqual([
      expect.objectContaining({ livello: 'error', evento: 'caricamento-nativo', messaggio: `video-nativo-accodamento-fallito: job=${uuid(101)} ${codice}` }),
    ])
    expect(result.current.righe).toEqual([])
    // Il file resta dov'è: la sua copia sul telefono non si cancella.
    expect(h.nScarta).not.toHaveBeenCalled()
  })

  it('un rifiuto che non è del ponte (un errore qualunque) vale `SCONOSCIUTO`: nel log mai il suo messaggio', async () => {
    h.nAccoda.mockRejectedValueOnce(new Error(`un messaggio che contiene ${NOME_PRIVATO} e ${URL_PUT}`))
    const { result } = await montaNativo()
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(logsDi('video-nativo-accodamento-fallito')[0].messaggio).toBe(`video-nativo-accodamento-fallito: job=${uuid(101)} SCONOSCIUTO`)
    expect(tutteLeRigheDiLog()).not.toContain(NOME_PRIVATO)
    expect(tutteLeRigheDiLog()).not.toContain('supabase.co')
  })

  it('…e se quel ritiro LANCIA l’errore si registra: nessuna promessa rifiutata che nessuno ascolta (#137)', async () => {
    h.nAccoda.mockRejectedValueOnce(new ErroreCaricamentiNativi('ELEMENTO_ASSENTE'))
    const { result } = await montaNativo()
    const base = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (
      /\/api\/video-uploads\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET'
        ? ({ ok: true, status: 200 } as unknown as Response)
        : base(url, init)
    )))
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    await waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-annullamento-interrotto' })))
  })
})

describe('un’apertura arrivata a SCHERMATA CAMBIATA: si ritira l’intento orfano — salvo che la coda nativa abbia già quel job', () => {
  beforeEach(() => { server.apertura = (n) => aperturaNativa(n) })
  const ALTRA_SEDE = '33333333-3333-4333-8333-333333333333'

  /** Avvia un invio la cui apertura resta sospesa, cambia sede, poi la lascia arrivare. */
  async function cambiaSedeDuranteLApertura() {
    let risolvi!: (r: Response) => void
    server.apertura = () => new Promise<Response>((r) => { risolvi = r })
    const { result, rerender } = await montaNativo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideoNativo(nativoVideo(), scelta) })
    await waitFor(() => expect(aperture()).toHaveLength(1))
    rerender({ ...opts, sede: ALTRA_SEDE })
    await act(async () => { risolvi(aperturaNativa(1)); return promessa })
    return { risultato: await promessa as { ok: boolean }, result }
  }

  it('la coda nativa NON ha quel job: nessun accodamento, e l’intento che l’apertura ha creato si RITIRA', async () => {
    const { risultato } = await cambiaSedeDuranteLApertura()
    expect(risultato.ok).toBe(false)
    expect(h.nAccoda).not.toHaveBeenCalled()
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    expect(logsDi('video-intento-orfano-ritirato')[0]).toMatchObject({
      livello: 'warn', evento: 'caricamento-nativo', messaggio: `video-intento-orfano-ritirato: job=${uuid(101)}`,
    })
  })

  it('la coda nativa HA già quel job (la stessa chiave ha ritrovato un invio in corso di questo telefono): NON si ritira, sarebbe un caricamento buono ucciso', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-invio', byteInviati: 5 })] })
    await cambiaSedeDuranteLApertura()
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).toEqual([])
    expect(h.nAccoda).not.toHaveBeenCalled()
  })

  it('se la coda nativa non si legge si resta prudenti: nel dubbio non si ritira (e si dice perché)', async () => {
    h.nElenco.mockRejectedValue(new ErroreCaricamentiNativi('INTERNO'))
    await cambiaSedeDuranteLApertura()
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).toEqual([])
    expect(logsDi('video-nativo-elenco-non-letto')[0]).toMatchObject({ livello: 'warn', messaggio: 'video-nativo-elenco-non-letto: INTERNO' })
  })

  it('smontato DOPO `accodaVideo` l’invio è del plugin e non si ritira niente: si risponde `ok`', async () => {
    let finisci!: (v: CaricamentoNativo) => void
    h.nAccoda.mockImplementationOnce(() => new Promise<CaricamentoNativo>((r) => { finisci = r }))
    const { result, unmount } = await montaNativo()
    let promessa!: Promise<unknown>
    act(() => { promessa = result.current.avviaVideoNativo(nativoVideo(), scelta) })
    await waitFor(() => expect(h.nAccoda).toHaveBeenCalledTimes(1))

    unmount()
    await act(async () => { finisci(voceNativa()); await promessa })
    expect(await promessa).toEqual({ ok: true })
    // Il plugin sta spedendo: ritirare l'intento ucciderebbe un caricamento buono.
    expect(patchFatti()).toEqual([])
  })
})

describe('su un binario 1.2 un `File` va SEMPRE in TUS: `scegliTrasporto()` non sa niente del plugin', () => {
  it('con il plugin presente un `File` apre un intento `tus` e parte dal TUS; il plugin non viene chiamato per i byte', async () => {
    server.apertura = null
    const { result } = await montaNativo()
    expect(scegliTrasporto().nome).toBe('tus')
    await act(async () => { await result.current.avviaVideo(video(), scelta) })

    expect(aperture()[0].corpo!.trasporto).toBe('tus')
    expect(corpoApertura().file[0].sha256).toBeUndefined()
    expect(h.accoda).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    expect(h.nAccoda).not.toHaveBeenCalled()
    expect(scegliTrasporto().nome).toBe('tus')
  })

  it('un elemento nativo e un `File` nella stessa sessione prendono due strade, e l’una non tocca l’altra', async () => {
    server.apertura = (n, corpo) => (corpo.trasporto === 'put-nativo' ? aperturaNativa(n) : aperturaStandard(n))
    const { result } = await montaNativo()
    await act(async () => { await result.current.avviaVideo(video(), scelta) })
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    expect(aperture().map((a) => a.corpo!.trasporto)).toEqual(['tus', 'put-nativo'])
    expect(h.accoda).toHaveBeenCalledTimes(1)
    expect(h.nAccoda).toHaveBeenCalledTimes(1)
    // Ogni scheda dice come viaggiano i suoi byte: da qui dipende ciò che offre («Riprendi» solo al TUS).
    await waitFor(() => expect(result.current.righe).toHaveLength(2))
    const trasporti = Object.fromEntries(result.current.righe.map((r) => [r.jobId, r.trasporto]))
    expect(trasporti).toEqual({ [uuid(101)]: 'tus', [uuid(102)]: 'nativo' })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// L'ELENCO UNITO: la coda del plugin e quella del server in una lista sola
// ───────────────────────────────────────────────────────────────────────────

describe('l’elenco UNITO: le voci del plugin si fondono con quelle del server', () => {
  it('al montaggio chiede la coda nativa per QUELL’utente (id in minuscolo), e ogni stato ha la sua scheda e la sua nota', async () => {
    // Un utente con lettere esadecimali nell'id (con sole cifre maiuscolo e minuscolo coincidono, e il test non proverebbe niente).
    const UTENTE = 'abcd1111-1111-4111-8111-111111111111'
    const voci = [
      voceNativa({ utenteId: UTENTE, jobId: uuid(1), intentId: uuid(11), stato: 'in-coda' }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(2), intentId: uuid(12), stato: 'in-invio', byteInviati: 25 }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(3), intentId: uuid(13), stato: 'in-attesa', codice: 'RETE' }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(4), intentId: uuid(14), stato: 'in-pausa', codice: 'FGS_NON_AVVIABILE' }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(5), intentId: uuid(15), stato: 'inviato', byteInviati: 73_000_000 }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(6), intentId: uuid(16), stato: 'fallito', codice: 'TOKEN_SCADUTO' }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(7), intentId: uuid(17), stato: 'fallito', codice: 'TROPPO_GRANDE' }),
      voceNativa({ utenteId: UTENTE, jobId: uuid(8), intentId: uuid(18), stato: 'annullato' }),
    ]
    h.nElenco.mockResolvedValue({ caricamenti: voci })
    const { result } = await montaNativo({ ...opts, utenteId: UTENTE.toUpperCase() })
    await waitFor(() => expect(result.current.righe).toHaveLength(8))

    expect(h.nElenco).toHaveBeenCalledWith({ utenteId: UTENTE })
    const per = (n: number) => result.current.righe.find((r) => r.jobId === uuid(n))!
    expect(per(1)).toMatchObject({ fase: 'in-fila', percentuale: null, messaggio: itServizi.galleryVideoNotaNativo })
    expect(per(2)).toMatchObject({ fase: 'caricamento', percentuale: 0, messaggio: itServizi.galleryVideoNotaNativo })
    expect(per(3)).toMatchObject({ fase: 'interrotto', percentuale: null, messaggio: itServizi.galleryVideoAttesaRete })
    expect(per(4)).toMatchObject({ fase: 'interrotto', percentuale: null, messaggio: itServizi.galleryVideoInPausa })
    expect(per(5)).toMatchObject({ fase: 'in-coda', percentuale: null })
    expect(per(6)).toMatchObject({ fase: 'da-ricaricare', messaggio: null })
    expect(per(7)).toMatchObject({ fase: 'fallito', messaggio: itShared.erroreVideoTroppoGrande })
    expect(per(8)).toMatchObject({ fase: 'annullato' })
    for (const r of result.current.righe) {
      expect(r.trasporto).toBe('nativo')
      expect(r.nome).toBe(NOME_PRIVATO)
    }
  })

  it('la percentuale è quella VERA: byte inviati sui totali, intera', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-invio', byteInviati: 18_250_000, byteTotali: 73_000_000 })] })
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))
    expect(result.current.righe[0].percentuale).toBe(25)
  })

  it('una voce di un’ALTRA sede o di un ALTRO utente non si vede (l’elenco del plugin è dell’utente, non della sede)', async () => {
    h.nElenco.mockResolvedValue({
      caricamenti: [
        voceNativa({ jobId: uuid(1), intentId: uuid(11) }),
        voceNativa({ jobId: uuid(2), intentId: uuid(12), scuolaId: '33333333-3333-4333-8333-333333333333' }),
        voceNativa({ jobId: uuid(3), intentId: uuid(13), utenteId: '44444444-4444-4444-8444-444444444444' }),
      ],
    })
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe).toHaveLength(1))
    expect(result.current.righe[0].jobId).toBe(uuid(1))
  })

  it('SENZA RETE la coda nativa si legge lo stesso (è una chiamata al plugin, e dice «in attesa»), e il server non si chiede', async () => {
    const spia = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-attesa', codice: 'RETE' })] })
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('interrotto'))
    expect(result.current.righe[0].messaggio).toBe(itServizi.galleryVideoAttesaRete)
    expect(elenchi()).toHaveLength(0)
    spia.mockRestore()
  })

  it('SENZA PLUGIN (web, app 1.0/1.1, interruttore spento) il plugin non si chiama mai e non si scrive niente: è il caso normale', async () => {
    h.nDisponibili.mockResolvedValue(null)
    const { result } = await montaAttendendo()
    await giroDiElenco()
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(h.nElenco).not.toHaveBeenCalled()
    expect(h.nAscolta).not.toHaveBeenCalled()
    expect(h.nAnnulla).not.toHaveBeenCalled()
    expect(h.nDimentica).not.toHaveBeenCalled()
    expect(logsDi('video-nativo')).toEqual([])
    expect(result.current.righe).toEqual([])
  })

  it('una lettura RIFIUTATA dal plugin non rompe l’elenco del server: warn col solo codice, e le schede del server restano', async () => {
    server.voci = [voce('in-coda')]
    h.nElenco.mockRejectedValue(new ErroreCaricamentiNativi('RISPOSTA_NON_VALIDA'))
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))
    expect(logsDi('video-nativo-elenco-non-letto')[0]).toMatchObject({
      livello: 'warn', evento: 'caricamento-nativo', messaggio: 'video-nativo-elenco-non-letto: RISPOSTA_NON_VALIDA',
    })
  })

  describe('una chiamata al plugin che non risponde non ferma l’elenco del server', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    })
    afterEach(() => {
      vi.useRealTimers()
      Reflect.deleteProperty(document, 'hidden')
    })

    it('dopo il tetto la lettura si abbandona (`video-nativo-elenco-scaduto`) e il server riconcilia comunque', async () => {
      server.voci = [voce('in-coda')]
      h.nElenco.mockImplementation(() => new Promise(() => undefined)) // il bridge non risponde mai
      h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
      const { result } = renderHook(() => useVideoGalleria(opts))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      // La richiesta al server è già partita, ma la riconciliazione aspetta la coda nativa: finché non scade, niente schede.
      expect(elenchi().length).toBeGreaterThan(0)
      expect(result.current.righe).toEqual([])

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
      expect(logsDi('video-nativo-elenco-scaduto')[0]).toMatchObject({ livello: 'warn', evento: 'caricamento-nativo' })
      expect(result.current.righe[0]?.fase).toBe('in-coda')
    })
  })
})

describe('una riga nativa scritta MENTRE si legge l’archivio IndexedDB non si perde', () => {
  it('l’evento arriva prima che l’archivio risponda: alla fine la scheda c’è ancora (l’archivio non conosce i video nativi)', async () => {
    let apriArchivio!: () => void
    h.attesaArchivio = new Promise<void>((r) => { apriArchivio = r })
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    const { result } = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(h.eventoNativo).not.toBeNull())

    act(() => { h.eventoNativo?.(voceNativa({ stato: 'in-invio', byteInviati: 36_500_000 })) })
    await waitFor(() => expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', percentuale: 50 }))
    // L'archivio risponde adesso, con le sole sue righe (nessuna): riscrivere tutto cancellerebbe la scheda appena nata.
    await act(async () => { apriArchivio() })
    await waitFor(() => expect(elenchi().length).toBeGreaterThan(0))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', trasporto: 'nativo' })
  })
})

describe('gli EVENTI del plugin aggiornano la scheda senza aspettare il giro dell’elenco', () => {
  const evento = (extra: Partial<CaricamentoNativo>) => act(() => { h.eventoNativo?.(voceNativa(extra)) })

  it('un evento `caricamento` muove la percentuale, e un «in attesa» compare quando la rete cade', async () => {
    const { result } = await montaNativo()
    expect(result.current.righe).toEqual([])

    evento({ stato: 'in-invio', byteInviati: 36_500_000, aggiornatoIl: '2026-10-02T10:00:10.000Z' })
    await waitFor(() => expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', percentuale: 50 }))
    evento({ stato: 'in-attesa', codice: 'RETE', aggiornatoIl: '2026-10-02T10:00:20.000Z' })
    expect(result.current.righe[0]).toMatchObject({ fase: 'interrotto', messaggio: itServizi.galleryVideoAttesaRete })
    evento({ stato: 'in-pausa', codice: 'FGS_NON_AVVIABILE', aggiornatoIl: '2026-10-02T10:00:30.000Z' })
    expect(result.current.righe[0]).toMatchObject({ fase: 'interrotto', messaggio: itServizi.galleryVideoInPausa })
    evento({ stato: 'in-invio', byteInviati: 73_000_000, aggiornatoIl: '2026-10-02T10:00:40.000Z' })
    expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', percentuale: 100 })
  })

  it('un evento che non cambia niente non rifà il disegno: le righe restano lo stesso oggetto', async () => {
    const { result } = await montaNativo()
    evento({ stato: 'in-invio', byteInviati: 36_500_000 })
    await waitFor(() => expect(result.current.righe).toHaveLength(1))
    const prima = result.current.righe
    // Un avanzamento di pochi byte che non sposta la percentuale intera: stessa scheda, stesso disegno.
    evento({ stato: 'in-invio', byteInviati: 36_600_000, aggiornatoIl: '2026-10-02T10:00:01.000Z' })
    expect(result.current.righe).toBe(prima)
  })

  it('un evento di un’altra sede o di un altro utente non arriva alla scheda', async () => {
    const { result } = await montaNativo()
    evento({ jobId: uuid(2), intentId: uuid(12), scuolaId: '33333333-3333-4333-8333-333333333333' })
    evento({ jobId: uuid(3), intentId: uuid(13), utenteId: '44444444-4444-4444-8444-444444444444' })
    await act(async () => { await Promise.resolve() })
    expect(result.current.righe).toEqual([])
  })

  it('un evento arrivato in RITARDO (più vecchio di quello già visto) non fa tornare indietro la scheda', async () => {
    const { result } = await montaNativo()
    evento({ stato: 'in-invio', byteInviati: 36_500_000, aggiornatoIl: '2026-10-02T10:00:10.000Z' })
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))
    evento({ stato: 'in-coda', byteInviati: 0, aggiornatoIl: '2026-10-02T10:00:05.000Z' })
    expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', percentuale: 50 })
  })

  it('l’ascolto si toglie allo smontaggio, e un ascolto agganciato dopo lo smontaggio si toglie subito', async () => {
    const { unmount } = await montaNativo()
    expect(h.nAscolta).toHaveBeenCalledTimes(1)
    unmount()
    await waitFor(() => expect(h.nTogliAscolto).toHaveBeenCalledTimes(1))

    // Smontato mentre il plugin ancora rispondeva: l'ascolto appena agganciato non resta vivo.
    h.nTogliAscolto.mockClear()
    let aggancia!: (togli: () => Promise<void>) => void
    h.nAscolta.mockImplementationOnce(() => new Promise((r) => { aggancia = r as typeof aggancia }))
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    const tardo = renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(h.nAscolta).toHaveBeenCalledTimes(2))
    tardo.unmount()
    await act(async () => { aggancia(h.nTogliAscolto) })
    await waitFor(() => expect(h.nTogliAscolto).toHaveBeenCalledTimes(1))
  })

  it('senza utente e sede non si ascolta niente; un ascolto che il plugin rifiuta lascia un warn col solo codice', async () => {
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    renderHook(() => useVideoGalleria({ ...opts, utenteId: null, sede: null }))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(h.nAscolta).not.toHaveBeenCalled()

    h.nAscolta.mockRejectedValueOnce(new ErroreCaricamentiNativi('NON_DISPONIBILE'))
    renderHook(() => useVideoGalleria(opts))
    await waitFor(() => expect(logsDi('video-nativo-ascolto-fallito')).toHaveLength(1))
    expect(logsDi('video-nativo-ascolto-fallito')[0]).toMatchObject({ livello: 'warn', messaggio: 'video-nativo-ascolto-fallito: NON_DISPONIBILE' })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// «CARICATO» UNA VOLTA, E LA VOCE TERMINALE CHE SI DIMENTICA
// ───────────────────────────────────────────────────────────────────────────

describe('a `inviato` si dice «caricato» al server UNA volta; la voce terminale si dimentica quando il server è oltre `da-caricare`', () => {
  it('quando il video PASSA a `inviato` davanti alla schermata, `PATCH caricato` coi byte e il MIME del plugin — una volta, anche se l’evento si ripete', async () => {
    const { result } = await montaNativo()
    act(() => { h.eventoNativo?.(voceNativa({ stato: 'in-invio', byteInviati: 70_000_000, aggiornatoIl: '2026-10-02T10:00:05.000Z' })) })
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))
    expect(patchFatti(), '«caricato» non si dice finché i byte non sono tutti arrivati').toEqual([])

    const inviato = { stato: 'inviato' as const, byteInviati: 73_000_000, aggiornatoIl: '2026-10-02T10:00:10.000Z' }
    act(() => { h.eventoNativo?.(voceNativa(inviato)) })
    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    expect(chiamate.find((c) => c.metodo === 'PATCH')!.corpo).toMatchObject({ azione: 'caricato', jobId: uuid(101), byte: 73_000_000, mime: 'video/quicktime' })

    act(() => { h.eventoNativo?.(voceNativa({ ...inviato, aggiornatoIl: '2026-10-02T10:00:11.000Z' })) })
    await giroDiElenco()
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).toEqual(['caricato'])
    expect(result.current.righe[0]).toMatchObject({ fase: 'in-coda', trasporto: 'nativo' })
  })

  it('una voce che si TROVA già `inviato` (l’app era chiusa) dice «caricato» solo se il server dice ancora «da caricare»: mai per un video già avanti', async () => {
    // Il server è già oltre `da-caricare` (il trigger d'arrivo se n'è accorto): niente richiesta in più, e niente rifiuto nei log.
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'inviato', byteInviati: 73_000_000 })] })
    server.voci = [voceDelNativo('pronto')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('pronto'))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).toEqual([])
    // Un evento `inviato` senza una voce viva prima (ripetuto, in ritardo) non lo fa scattare da sé.
    act(() => { h.eventoNativo?.(voceNativa({ stato: 'inviato', byteInviati: 73_000_000, aggiornatoIl: '2026-10-02T10:00:10.000Z' })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).toEqual([])
  })

  it('anche una voce già `inviato` trovata alla lettura dell’elenco (l’app era chiusa) dice «caricato», una volta', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'inviato', byteInviati: 73_000_000 })] })
    server.voci = [voceDelNativo('da-caricare')]
    await montaNativo()
    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    await giroDiElenco()
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).toEqual(['caricato'])
  })

  it('la voce `inviato` si DIMENTICA quando il server è oltre `da-caricare`, e non prima', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'inviato', byteInviati: 73_000_000 })] })
    server.voci = [voceDelNativo('da-caricare')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('in-coda'))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(h.nDimentica, 'il server dice ancora «da caricare»: la voce serve').not.toHaveBeenCalled()

    server.voci = [voceDelNativo('in-conversione')]
    await giroDiElenco()
    await waitFor(() => expect(h.nDimentica).toHaveBeenCalledTimes(1))
    expect(h.nDimentica).toHaveBeenCalledWith({ jobIds: [uuid(101)] })
    // Una volta sola, anche se la lettura si ripete.
    await giroDiElenco()
    expect(h.nDimentica).toHaveBeenCalledTimes(1)
  })

  it('una voce NON terminale (sta ancora spedendo) non si dimentica, anche se il server è già oltre `da-caricare`', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-invio', byteInviati: 10 })] })
    server.voci = [voceDelNativo('in-conversione')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe.length).toBeGreaterThan(0))
    await giroDiElenco()
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(h.nDimentica).not.toHaveBeenCalled()
  })

  it('un video PUBBLICATO esce dalle schede, la voce si dimentica, la riga IndexedDB non si tocca e la galleria si ricarica UNA volta', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'inviato', byteInviati: 73_000_000 })] })
    server.voci = [voceDelNativo('in-conversione')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('conversione'))

    server.voci = [voceDelNativo('pubblicato', { mediaId: '66666666-6666-4666-8666-666666666666' })]
    await giroDiElenco()
    await waitFor(() => expect(result.current.righe).toEqual([]))
    expect(h.nDimentica).toHaveBeenCalledWith({ jobIds: [uuid(101)] })
    expect(h.elimina, 'un video nativo non ha una riga IndexedDB').not.toHaveBeenCalled()
    expect(opts.onPubblicato).toHaveBeenCalledTimes(1)
  })

  it('una `dimentica` che il plugin rifiuta lascia un warn col solo codice, e si riprova alla lettura dopo', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'inviato', byteInviati: 73_000_000 })] })
    server.voci = [voceDelNativo('in-conversione')]
    h.nDimentica.mockRejectedValueOnce(new ErroreCaricamentiNativi('INTERNO'))
    await montaNativo()
    await waitFor(() => expect(logsDi('video-nativo-dimentica-fallito')).toHaveLength(1))
    expect(logsDi('video-nativo-dimentica-fallito')[0]).toMatchObject({ livello: 'warn', messaggio: 'video-nativo-dimentica-fallito: INTERNO' })
    await giroDiElenco()
    await waitFor(() => expect(h.nDimentica).toHaveBeenCalledTimes(2))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// «RIMUOVI» — prima i byte (`annulla` del plugin), poi l'intento
// ───────────────────────────────────────────────────────────────────────────

describe('«Rimuovi» un video NATIVO: `annulla` del plugin PRIMA, poi il ritiro dell’intento, poi `dimentica`', () => {
  /** La coda del plugin con UN invio in corso, che dopo `annulla` risulta annullato. */
  function codaConUnInvio() {
    let stato: CaricamentoNativo['stato'] = 'in-invio'
    h.nElenco.mockImplementation(async () => ({ caricamenti: [voceNativa({ stato, byteInviati: 10 })] }))
    h.nAnnulla.mockImplementation(async () => {
      h.ordine.push('annullaNativo')
      stato = 'annullato'
      return { annullato: true }
    })
  }

  it('l’ORDINE: `annulla` viene PRIMA di `PATCH annulla`, che usa la revisione di ADESSO; la scheda sparisce subito e non torna', async () => {
    codaConUnInvio()
    server.voci = [voceDelNativo('da-caricare')]
    server.revisione = 7
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))

    act(() => result.current.rimuovi(uuid(101)))
    // La scheda sparisce SUBITO.
    expect(result.current.righe).toEqual([])
    await waitFor(() => expect(patchFatti()).toContain('annulla'))

    expect(h.nAnnulla).toHaveBeenCalledWith({ jobId: uuid(101) })
    expect(h.ordine.indexOf('annullaNativo'), 'i byte non sono stati fermati').toBeGreaterThanOrEqual(0)
    expect(h.ordine.indexOf('annullaNativo')).toBeLessThan(h.ordine.indexOf('PATCH:annulla'))
    expect(chiamate.find((c) => c.corpo?.azione === 'annulla')!.corpo).toEqual({ azione: 'annulla', revisione: 7 })
    // Ritiro riuscito: la voce (annullata) si dimentica, e la scheda non torna nemmeno alla lettura dopo.
    await waitFor(() => expect(h.nDimentica).toHaveBeenCalledWith({ jobIds: [uuid(101)] }))
    await waitFor(() => expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toContain(uuid(201)))
    await giroDiElenco()
    expect(result.current.righe).toEqual([])
    // Nessun lavoro del TUS: né terminazione di una sessione né riga IndexedDB da eliminare.
    expect(h.annullaLocale).not.toHaveBeenCalled()
    expect(h.elimina).not.toHaveBeenCalled()
  })

  it('se `annulla` RIFIUTA (i byte potrebbero ancora correre) l’intento NON si ritira, si scrive l’errore col solo codice, e la scheda TORNA', async () => {
    codaConUnInvio()
    h.nAnnulla.mockRejectedValueOnce(new ErroreCaricamentiNativi('INTERNO'))
    server.voci = [voceDelNativo('da-caricare')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))

    act(() => result.current.rimuovi(uuid(101)))
    expect(result.current.righe).toEqual([])
    await waitFor(() => expect(logsDi('video-nativo-annulla-fallito')).toHaveLength(1))
    expect(logsDi('video-nativo-annulla-fallito')[0]).toMatchObject({
      livello: 'error', evento: 'caricamento-nativo', messaggio: `video-nativo-annulla-fallito: job=${uuid(101)} INTERNO`,
    })
    // Il verdetto manca: nessun ritiro, e la scheda torna col racconto del plugin (l'invio corre ancora).
    await waitFor(() => expect(result.current.righe[0]).toMatchObject({ fase: 'caricamento', trasporto: 'nativo' }))
    expect(patchFatti()).not.toContain('annulla')
    expect(h.nDimentica).not.toHaveBeenCalled()
    expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toBeNull()
  })

  it('se il server RIFIUTA il ritiro la scheda torna (annullata sul telefono, l’intento è ancora vivo) e la voce NON si dimentica', async () => {
    codaConUnInvio()
    server.voci = [voceDelNativo('da-caricare')]
    server.patch = (azione) => (azione === 'annulla' ? json({ error: 'x', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }, 500) : null)
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))

    act(() => result.current.rimuovi(uuid(101)))
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    await waitFor(() => expect(result.current.righe[0]).toMatchObject({ fase: 'annullato', trasporto: 'nativo' }))
    expect(logsDi('video-ritiro-non-riuscito')).toHaveLength(1)
    expect(logsDi('video-ritiro-non-riuscito')[0]).toMatchObject({ livello: 'warn', evento: 'caricamento-nativo' })
    expect(h.nDimentica).not.toHaveBeenCalled()
    expect(localStorage.getItem(`kv:video-galleria-nascosti:${OWNER}`)).toBeNull()
  })

  it('«Togli» su un invio nativo FALLITO: `annulla` non ha niente da annullare (la voce è terminale) e il ritiro prosegue lo stesso', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'fallito', codice: 'TOKEN_SCADUTO' })] })
    h.nAnnulla.mockResolvedValue({ annullato: false })
    server.voci = [voceDelNativo('da-caricare')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('da-ricaricare'))

    act(() => result.current.rimuovi(uuid(101)))
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    await waitFor(() => expect(h.nDimentica).toHaveBeenCalledWith({ jobIds: [uuid(101)] }))
    expect(result.current.righe).toEqual([])
  })

  it('un evento che arriva dopo «Rimuovi» (lo `annullato` che l’annullamento produce) NON fa risorgere la scheda', async () => {
    codaConUnInvio()
    server.voci = [voceDelNativo('da-caricare')]
    const { result } = await montaNativo()
    await waitFor(() => expect(result.current.righe[0]?.fase).toBe('caricamento'))
    // Il ritiro resta sospeso: la scheda è nascosta ma «in ritiro».
    server.patch = () => new Promise<Response>(() => undefined) as unknown as Response

    act(() => result.current.rimuovi(uuid(101)))
    await waitFor(() => expect(h.nAnnulla).toHaveBeenCalled())
    // Un `inviato` arrivato per un pelo (i byte erano già partiti): per un video che la persona ha tolto non si dice «caricato»
    // al server mentre il suo intento si sta ritirando, e la sua voce non rientra fra quelle che la schermata racconta.
    act(() => { h.eventoNativo?.(voceNativa({ stato: 'inviato', byteInviati: 73_000_000, aggiornatoIl: '2026-10-02T10:00:50.000Z' })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(patchFatti()).not.toContain('caricato')
    expect(result.current.righe).toEqual([])

    // Poi lo `annullato` che l'annullamento stesso produce.
    act(() => { h.eventoNativo?.(voceNativa({ stato: 'annullato', aggiornatoIl: '2026-10-02T10:01:00.000Z' })) })
    await act(async () => { await Promise.resolve() })
    expect(result.current.righe).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// LA RIPRESA AUTOMATICA TUS IGNORA LE RIGHE NATIVE
// ───────────────────────────────────────────────────────────────────────────

describe('la ripresa automatica del TUS ignora le righe native: il nativo riprende da solo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'hidden')
  })
  const passa = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  it('un invio nativo FERMO non arma nessun orologio, non riprende con `online` né col pulsante, e il TUS non parte', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-attesa', codice: 'RETE' })] })
    server.voci = [voceDelNativo('da-caricare')]
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    const { result } = renderHook(() => useVideoGalleria(opts))
    await passa(100)
    expect(result.current.righe[0]).toMatchObject({ fase: 'interrotto', trasporto: 'nativo' })

    // Né il rientro, né la rete che torna, né l'attesa crescente (5, 15, 30, 60 secondi): niente di tutto questo lo muove.
    act(() => { window.dispatchEvent(new Event('online')) })
    await passa(120_000)
    h.leggiArchivio.mockClear()
    act(() => result.current.riprendi(uuid(101)))
    await passa(100)
    expect(h.carica).not.toHaveBeenCalled()
    expect(h.accoda).not.toHaveBeenCalled()
    // «Riprendi» a mano è del TUS: per un video nativo non si accoda nemmeno un trasferimento (che andrebbe a cercare una riga
    // dell'archivio che non esiste).
    expect(h.leggiArchivio).not.toHaveBeenCalledWith(uuid(101))
    expect(logsDi('video-ripresa-automatica')).toEqual([])
    // E il plugin non è stato scomodato per «riprendere»: non ha un metodo per farlo.
    expect(h.nAnnulla).not.toHaveBeenCalled()
  })

  it('con soli invii nativi fermi NESSUN timer di ripresa è armato: un orologio che non può fare niente si pagherebbe a ogni giro', async () => {
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-pausa', codice: 'FGS_NON_AVVIABILE' })] })
    server.voci = [voceDelNativo('da-caricare')]
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    const { result } = renderHook(() => useVideoGalleria(opts))
    await passa(100)
    expect(result.current.righe[0]).toMatchObject({ fase: 'interrotto', trasporto: 'nativo' })
    expect(vi.getTimerCount(), 'un timer pendente: la ripresa del TUS si è armata per una riga che non è sua').toBe(0)
  })

  it('…e la controprova del conteggio: un trasferimento TUS che la rete interrompe sì, arma l’orologio', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1 })]
    server.voci = [voce('da-caricare')]
    h.carica.mockImplementation(async (_dip: unknown, jobId: string) => ({ esito: 'interrotto', jobId, offsetByte: 1, codice: null }))
    const { result } = renderHook(() => useVideoGalleria(opts))
    await passa(100)
    expect(h.carica).toHaveBeenCalledTimes(1)
    expect(result.current.righe[0]?.fase).toBe('interrotto')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('controprova: un trasferimento TUS fermo, accanto a uno nativo, riprende come sempre', async () => {
    h.righe = [rigaArchivio({ stato: 'in_corso', offsetByte: 1, jobId: uuid(500), intentId: uuid(600) })]
    h.nElenco.mockResolvedValue({ caricamenti: [voceNativa({ stato: 'in-attesa', codice: 'RETE' })] })
    server.voci = [voceDelNativo('da-caricare'), voce('da-caricare', { jobId: uuid(500), intentId: uuid(600) })]
    h.nDisponibili.mockResolvedValue(INFO_PLUGIN)
    renderHook(() => useVideoGalleria(opts))
    await passa(100)
    expect(h.carica).toHaveBeenCalledTimes(1)
    expect(h.carica.mock.calls[0][1]).toBe(uuid(500))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// PRIVACY E USCITA DALL'ACCOUNT
// ───────────────────────────────────────────────────────────────────────────

describe('nei log di un invio nativo non finisce mai un nome, un URL, un token, un hash o un bambino', () => {
  it('apertura, accodamento, rifiuto, elenco, eventi, `inviato`, «Rimuovi»: tutto passa da uuid, conteggi e codici dell’elenco chiuso', async () => {
    server.apertura = (n) => aperturaNativa(n)
    h.nAnnulla.mockRejectedValueOnce(new ErroreCaricamentiNativi('INTERNO'))
    const { result } = await montaNativo()
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo(), scelta) })
    act(() => { h.eventoNativo?.(voceNativa({ stato: 'in-invio', byteInviati: 5, aggiornatoIl: '2026-10-02T10:00:05.000Z' })) })
    act(() => { h.eventoNativo?.(voceNativa({ stato: 'inviato', byteInviati: 73_000_000, aggiornatoIl: '2026-10-02T10:00:09.000Z' })) })
    await waitFor(() => expect(patchFatti()).toContain('caricato'))
    act(() => result.current.rimuovi(uuid(101)))
    await waitFor(() => expect(logsDi('video-nativo-annulla-fallito')).toHaveLength(1))
    h.nAccoda.mockRejectedValueOnce(new ErroreCaricamentiNativi('HOST_NON_AMMESSO'))
    server.apertura = (n) => aperturaNativa(n + 10)
    await act(async () => { await result.current.avviaVideoNativo(nativoVideo({ id: 'video-2' }), { ...scelta, tag: [ADA, uuid(901)] }) })

    const scritto = tutteLeRigheDiLog()
    expect(scritto.length).toBeGreaterThan(100)
    for (const segreto of [NOME_PRIVATO, 'filmato-privato', SHA_NATIVO, SHA_NATIVO.slice(0, 16), 'supabase.co', 'TOKEN-FINTO', 'kvr_', TOKEN_RINNOVO, ADA, uuid(901), 'localhost:']) {
      expect(scritto, segreto).not.toContain(segreto)
    }
    // Solo livelli ammessi dal canale (`/api/logs` non accetta `info`) e solo l'evento nativo o quelli già in uso.
    for (const [riga] of h.log.mock.calls) expect(['warn', 'error']).toContain((riga as { livello: string }).livello)
  })
})

describe('all’uscita dall’account l’invio CONTINUA: `logout.ts` non nomina il modulo dei caricamenti nativi (spec §7.7)', () => {
  it('né un import né un riferimento: il plugin non viene mai fermato da un logout', () => {
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/auth/logout.ts'), 'utf8')
    expect(sorgente).not.toMatch(/caricamenti-nativi/)
    expect(sorgente).not.toMatch(/KidvilleCaricamenti/)
    // Controllo positivo: il file letto è davvero il logout (e gli altri plugin sì, li ferma).
    expect(sorgente).toMatch(/unregisterNativePush/)
  })
})
