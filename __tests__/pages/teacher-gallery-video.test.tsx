import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import itServizi from '../../messages/it/teacherServizi.json'
import { SEDE_A } from '../fixtures/sedi'

/**
 * V11 · LA GALLERIA DELL'INSEGNANTE ACCETTA I VIDEO — il giro intero.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CHE COSA CAMBIA, E PERCHÉ NON È UN RITOCCO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fino a oggi un video di galleria passava dalla porta delle FOTO: conversione
 * dentro il browser del telefono, watermark disegnato su una `<canvas>`, e poi la
 * stessa `PUT` firmata delle immagini, con un tetto di 50 MiB scritto a mano nella
 * pagina. Tre limiti, tutti veri:
 *
 *  · un iPhone che converte un filmato di tre minuti impiega minuti e a volte non
 *    ci riesce affatto («questo video non può essere convertito su questo dispositivo»);
 *  · 50 MiB sono pochi per un video girato con un telefono moderno;
 *  · e finché la conversione gira nel browser, chiudere l'app butta via tutto.
 *
 * Adesso il file parte com'è verso un bucket privato (TUS, ripartibile), e la
 * conversione la fa il server. Quello che questo file tiene fermo è il patto con
 * chi carica: **nessun numero cablato**, **l'attesa raccontata per quello che è**,
 * e **il lavoro che sopravvive alla chiusura dell'app**.
 */

const h = vi.hoisted(() => ({
  logClient: vi.fn(),
  accoda: vi.fn(),
  carica: vi.fn(),
  jobDaSeguire: vi.fn(),
  pota: vi.fn(),
  annulla: vi.fn(),
  daRiprendere: vi.fn(),
  righeArchivio: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
  usePathname: () => '/teacher/gallery',
}))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: DOCENTE, role: 'educator', ready: true }),
}))
vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(() => false),
  scegliFotoNativa: vi.fn(async () => []),
}))
vi.mock('@/lib/offline/syncEngine', () => ({
  saveLocalGalleryMedia: vi.fn(async () => undefined),
  syncPendingGalleryMedia: vi.fn(async () => undefined),
}))
vi.mock('@/lib/offline/db', () => ({}))

/**
 * L'UPLOADER TUS È FINTO, IL PROTOCOLLO NO.
 *
 * `@/lib/media/video/upload` ha i suoi collaudi, che fanno girare il `tus.Upload`
 * vero contro un server che interrompe DAVVERO una `PATCH` a metà. Qui si collauda
 * l'altra metà: che la schermata gli dia le cose giuste e faccia le cose giuste con
 * ciò che restituisce. Il doppio è quindi sulla FRONTIERA del modulo, non dentro la
 * logica sotto esame — e i test qui sotto verificano le chiamate che ci passano,
 * non che il doppio sia stato costruito.
 */
vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: vi.fn(async () => archivioFinto()),
  accodaCaricamentoVideo: h.accoda,
  caricaVideo: h.carica,
  jobDaSeguire: h.jobDaSeguire,
  potaArchivioCaricamenti: h.pota,
  annullaCaricamentoVideo: h.annulla,
  caricamentiDaRiprendere: h.daRiprendere,
}))

import { MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page'

const DOCENTE = 'aaaa1111-0000-4000-8000-000000000001'
const INTENTO = '11111111-0000-4000-8000-000000000011'
const JOB = '22222222-0000-4000-8000-000000000022'
const SEZIONE = 'TEST Infanzia'
const ADA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Ada', cognome: 'Bianchi', consenso_privacy: true }

function archivioFinto() {
  return {
    leggi: async (jobId: string) => h.righeArchivio.find((r) => r.jobId === jobId),
    elenca: async () => h.righeArchivio,
    scrivi: async (riga: Record<string, unknown>) => {
      h.righeArchivio.push(riga)
    },
    aggiorna: async () => undefined,
    elimina: async (jobId: string) => {
      h.righeArchivio = h.righeArchivio.filter((r) => r.jobId !== jobId)
    },
    leggiByte: async () => new Blob(['x']),
    scriviByte: async () => undefined,
    eliminaByte: async () => undefined,
  }
}

const COORDINATE = {
  protocollo: 'tus',
  endpoint: 'https://esempio.supabase.co/storage/v1/upload/resumable/sign',
  bucket: 'video_originals',
  percorso: `${DOCENTE}/abc.mp4`,
  contentType: 'video/mp4',
  dimensioneBloccoByte: 6 * 1024 * 1024,
}

/** Lo stato che la route restituisce per l'intento, con il job nello stadio voluto. */
function statoIntento(stato: string, avanzamento: number | null, codice: string | null = null, revisione = 1) {
  return {
    intentId: INTENTO,
    revisione,
    canale: 'gallery',
    statoIntent: 'confirmed',
    aggiornatoIl: '2026-09-18T10:00:00.000Z',
    job: [
      {
        jobId: JOB,
        intentId: INTENTO,
        canale: 'gallery',
        stato,
        avanzamento,
        codice,
        aggiornatoIl: '2026-09-18T10:00:00.000Z',
      },
    ],
  }
}

/** Le chiamate `fetch` registrate, per poterle interrogare a posteriori. */
let chiamate: Array<{ url: string; init?: RequestInit }> = []
/** Lo stato che la GET dell'intento restituisce in questo momento del test. */
let statoCorrente = statoIntento('queued', 25)

function rispostaFinta(corpo: unknown, stato = 200): Response {
  return { ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo } as unknown as Response
}

const alertMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  chiamate = []
  h.righeArchivio = []
  statoCorrente = statoIntento('queued', 25)
  h.jobDaSeguire.mockResolvedValue([])
  h.daRiprendere.mockReturnValue([])
  h.pota.mockResolvedValue(0)
  h.accoda.mockImplementation(async (_dip: unknown, ingresso: { jobId: string }) => ({
    ok: true,
    riga: { jobId: ingresso.jobId },
  }))
  h.carica.mockImplementation(async (_dip: unknown, jobId: string) => ({
    esito: 'caricato',
    jobId,
    byteCaricati: 1234,
  }))

  vi.stubGlobal('alert', alertMock)
  vi.stubGlobal('confirm', vi.fn(() => true))
  let n = 0
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => `blob:anteprima-${++n}`, revokeObjectURL: vi.fn() }),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      chiamate.push({ url: u, init })
      if (u.includes('/api/educator-sections')) return rispostaFinta({ sectionNames: [SEZIONE] })
      if (u.includes('/api/diary/students')) return rispostaFinta([ADA])
      if (u.includes('/api/me')) return rispostaFinta({ ruolo: 'educator', scuola_id: SEDE_A })
      if (u.includes('/api/video-uploads/')) return rispostaFinta(statoCorrente)
      if (u.includes('/api/video-uploads')) {
        return rispostaFinta(
          {
            intentId: INTENTO,
            revisione: 1,
            canale: 'gallery',
            scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
            job: [{ jobId: JOB, chiaveIdempotenza: 'g-1', caricamento: COORDINATE, firma: 'firma-finta' }],
          },
          201,
        )
      }
      if (u.includes('/api/gallery')) {
        if (init?.method === 'POST') return rispostaFinta({ id: 'media-1' }, 201)
        return rispostaFinta({ media: [], total: 0 })
      }
      return rispostaFinta({})
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const video = (nome = 'recita.mp4', byte = 12_345_678) => {
  const f = new File(['x'], nome, { type: 'video/mp4' })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}

/** Porta la schermata al passo «tag» col file dato, e tagga Ada. */
async function finoAlTag(file: File) {
  const v = render(<TeacherGalleryPage />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }))
  await waitFor(() => expect(v.container.querySelector('input[type="file"]')).toBeTruthy())
  const input = v.container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(itShared.galleryModificaTag) }))
  await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument())
  fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`))
  return v
}

/** Il corpo JSON della prima chiamata verso `url` con quel metodo. */
function corpoDi(url: string, metodo = 'POST'): Record<string, unknown> | null {
  const c = chiamate.find((x) => x.url.includes(url) && (x.init?.method ?? 'GET') === metodo)
  return c?.init?.body ? (JSON.parse(String(c.init.body)) as Record<string, unknown>) : null
}

describe('un video non passa più dalla porta delle foto', () => {
  it('apre l’intento, accoda i byte e NON scrive una riga di galleria con `file_url`', async () => {
    await finoAlTag(video())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))

    await waitFor(() => expect(corpoDi('/api/video-uploads')).not.toBeNull())
    const apertura = corpoDi('/api/video-uploads')!
    expect(apertura.canale).toBe('gallery')
    expect(apertura.azione).toBe('publish')

    // I byte NON attraversano nessuna nostra route: vanno allo Storage in TUS.
    await waitFor(() => expect(h.accoda).toHaveBeenCalled())
    expect(h.carica).toHaveBeenCalled()
    const ingresso = h.accoda.mock.calls[0][1] as { jobId: string; intentId: string; canale: string }
    expect(ingresso.jobId).toBe(JOB)
    expect(ingresso.intentId).toBe(INTENTO)
    expect(ingresso.canale).toBe('gallery')

    // E la riga di galleria non si scrive adesso: il video non è ancora convertito.
    const galleria = chiamate.find((c) => c.url.includes('/api/gallery') && c.init?.method === 'POST')
    expect(galleria, 'un video non convertito non può diventare una riga di galleria').toBeUndefined()
  })

  it('la SEDE viaggia con la richiesta, e non la si lascia indovinare al server', async () => {
    await finoAlTag(video())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))
    await waitFor(() => expect(corpoDi('/api/video-uploads')).not.toBeNull())
    expect(corpoDi('/api/video-uploads')!.scuolaId).toBe(SEDE_A)
  })

  it('finiti i byte, il job entra in coda e l’intento si CONFERMA: da lì si può chiudere l’app', async () => {
    // ⚠️ REVISIONE 3, non 1: la conferma deve portare la revisione CORRENTE, quella
    // che il server ha appena dichiarato rispondendo a «caricato». Indovinarla — la
    // prima stesura passava l'1 con cui l'intento era nato — significa un
    // `REVISION_MISMATCH` su ogni caricamento ripreso dopo una modifica, cioè un
    // video bloccato con un messaggio che non nomina la causa.
    statoCorrente = statoIntento('queued', 25, null, 3)
    await finoAlTag(video())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))

    await waitFor(() => {
      const patch = chiamate.filter((c) => c.init?.method === 'PATCH').map((c) => JSON.parse(String(c.init!.body)))
      expect(patch.map((p) => p.azione)).toEqual(['caricato', 'conferma'])
    })
    const patch = chiamate.filter((c) => c.init?.method === 'PATCH').map((c) => JSON.parse(String(c.init!.body)))
    expect(patch[0].jobId).toBe(JOB)
    expect(patch[0].byte).toBe(1234)
    expect(patch[1].revisione).toBe(3)
  })

  it('e a schermo compare l’attesa vera, non un «caricamento» che dura otto minuti', async () => {
    statoCorrente = statoIntento('processing', 60)
    await finoAlTag(video())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))

    expect(await screen.findByText(itServizi.galleryVideoFaseConversione)).toBeInTheDocument()
    expect(alertMock).toHaveBeenCalledWith(itServizi.galleryVideoAvviato)
  })
})

describe('i limiti sono quelli della pipeline, e si applicano PRIMA di spedire', () => {
  it('un file oltre i due gigabyte non apre nemmeno l’intento', async () => {
    await finoAlTag(video('enorme.mp4', MAX_VIDEO_INPUT_BYTES + 1))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))

    await waitFor(() => expect(alertMock).toHaveBeenCalledWith(itShared.erroreVideoTroppoGrande))
    expect(chiamate.some((c) => c.url.includes('/api/video-uploads'))).toBe(false)
    expect(h.accoda).not.toHaveBeenCalled()
  })
})

describe('l’app chiusa non perde il video', () => {
  it('al rientro ritrova i job da seguire e ne interroga lo stato', async () => {
    h.jobDaSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'gallery' }])
    statoCorrente = statoIntento('processing', 60)

    render(<TeacherGalleryPage />)

    expect(await screen.findByText(itServizi.galleryVideoFaseConversione)).toBeInTheDocument()
    await waitFor(() =>
      expect(chiamate.some((c) => c.url.includes(`/api/video-uploads/${INTENTO}`))).toBe(true),
    )
  })

  it('quando il video è pronto CHIEDE i bambini, perché i tag non sono sopravvissuti', async () => {
    h.jobDaSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'gallery' }])
    statoCorrente = statoIntento('ready', 100)

    render(<TeacherGalleryPage />)

    expect(await screen.findByText(itServizi.galleryVideoChiediTag)).toBeInTheDocument()
    // E non pubblica da sé: senza destinatari il video non lo vedrebbe nessuno.
    const galleria = chiamate.find((c) => c.url.includes('/api/gallery') && c.init?.method === 'POST')
    expect(galleria).toBeUndefined()
    expect(screen.getByRole('button', { name: itServizi.galleryVideoPubblica })).toBeDisabled()
  })

  it('scelti i bambini, la pubblicazione parte con l’intento e la sua revisione', async () => {
    h.jobDaSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'gallery' }])
    statoCorrente = statoIntento('ready', 100)

    render(<TeacherGalleryPage />)
    await screen.findByText(itServizi.galleryVideoChiediTag)

    fireEvent.click(await screen.findByText(`${ADA.nome} ${ADA.cognome}`))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: itServizi.galleryVideoPubblica })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoPubblica }))

    await waitFor(() => expect(corpoDi('/api/gallery')).not.toBeNull())
    const corpo = corpoDi('/api/gallery')!
    expect(corpo.video_intent_id).toBe(INTENTO)
    expect(corpo.video_revisione).toBe(1)
    expect(corpo.file_url).toBeUndefined()
    expect(corpo.tag_students).toEqual([ADA.id])
  })
})

describe('una pubblicazione rifiutata NON si ripete da sola', () => {
  it('il Privacy Lock ferma il giro: una sola richiesta, e i nomi a schermo', async () => {
    // ⚠️ QUESTO CASO È NATO DA UN DIFETTO VERO DI QUESTO CODICE, trovato rileggendo
    // il ciclo invece che eseguendolo: la pubblicazione automatica scatta quando un
    // job diventa «pronto» e i tag sono noti. Se il server rifiuta (un 422 del
    // Privacy Lock: un bambino senza liberatoria), la scheda torna a «pronto» — e
    // l'effetto che guarda le voci la vede pronta di nuovo e ripubblica. In
    // produzione sarebbe un ciclo di richieste contro `/api/gallery` finché la
    // pagina resta aperta, con dentro gli id di minori.
    statoCorrente = statoIntento('ready', 100)
    let tentativi = 0
    const originale = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.includes('/api/gallery') && init?.method === 'POST') {
          tentativi++
          chiamate.push({ url: u, init })
          return rispostaFinta(
            { error: 'Foto di gruppo non pubblicabile: …', nomi: ['Ada B.'], ids: [ADA.id] },
            422,
          )
        }
        return originale(url, init)
      }),
    )

    await finoAlTag(video())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))

    // Si aspetta che il primo tentativo sia partito…
    await waitFor(() => expect(tentativi).toBe(1))
    // …e che il messaggio del rifiuto arrivi a schermo, coi nomi da togliere.
    expect(await screen.findByText(/Foto di gruppo non pubblicabile/)).toBeInTheDocument()

    // …poi si lascia girare il ciclo di React: se ripubblicasse, qui sarebbero due.
    await new Promise((r) => setTimeout(r, 120))
    expect(tentativi, 'la pubblicazione rifiutata è ripartita da sola').toBe(1)

    // ⚠️ E LA PERSONA DEVE POTER RIPROVARE. Il guardiano ferma il TENTATIVO
    // AUTOMATICO, non il gesto: se togliesse anche quello, chi ha appena letto
    // «togli Ada dai tag» si troverebbe un pulsante inerte — cioè un difetto
    // peggiore di quello che si stava chiudendo.
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoPubblica }))
    await waitFor(() => expect(tentativi).toBe(2))
  })
})

describe('un fallimento della conversione si legge, e non resta lì per sempre', () => {
  it('mostra la frase del catalogo che corrisponde al codice, non il codice', async () => {
    h.jobDaSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'gallery' }])
    statoCorrente = statoIntento('failed', null, 'VIDEO_TROPPO_LUNGO')

    render(<TeacherGalleryPage />)

    expect(await screen.findByText(itShared.erroreVideoTroppoLungo)).toBeInTheDocument()
    expect(screen.queryByText('VIDEO_TROPPO_LUNGO')).toBeNull()
  })
})
