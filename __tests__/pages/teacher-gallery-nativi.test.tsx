import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import itServizi from '../../messages/it/teacherServizi.json'
import { SEDE_A } from '../fixtures/sedi'

/**
 * LA GALLERIA DELL'INSEGNANTE CON UN VIDEO NATIVO (app 1.2, spec «caricamenti nativi» §7.3, compito J2): il
 * passo dei bambini e ciò che ne tocca la vita.
 *
 * Un video scelto dal selettore NATIVO non ha un `File`: il suo elemento è `{ file: null, nativo }` (spec §7.3).
 * Da lì ogni lettura di `f.file.…` ha dovuto decidere che cosa fare di lui, e questo file prova le decisioni che la
 * pagina prende dal momento in cui il video entra al passo dei bambini:
 *
 *  · la tessera della striscia e la riga «foto in configurazione» mostrano il video nativo (nome, miniatura);
 *  · la X del passo dei bambini, «Annulla» e lo SMONTAGGIO della pagina cancellano la copia dal telefono
 *    (`scartaScelti`): un video preparato è una copia da fino a 2 GB, e dopo di loro nessuno la porterà avanti;
 *  · una foto (un `File`) non passa dal plugin: la sua X non chiama niente;
 *  · il video non si scarta mai senza che qualcuno l'abbia lasciato (nessun id fuori dall'elenco).
 *
 * L'INVIO («Pubblica») dei video nativi (J3, `avviaVideoNativo`) si prova in fondo a questo file: l'apertura `put-nativo` con
 * `sha256`, il 422 che resta nel passo dei bambini, l'accodamento che fallisce, l'avviso del multitasking, e «Annulla» che
 * si spegne mentre il giro scorre l'elenco (non deve scartare le copie native già consegnate al plugin).
 *
 * Ogni caso è stato visto ROSSO rompendo il codice che prova (le mutazioni sono nel rapporto di J2).
 */

const h = vi.hoisted(() => ({
  logClient: vi.fn(),
  disponibili: vi.fn(),
  scegliMedia: vi.fn(),
  annullaScelta: vi.fn(),
  ascoltaPreparazione: vi.fn(),
  leggiFoto: vi.fn(),
  scartaScelti: vi.fn(),
  accodaVideo: vi.fn(),
  elenco: vi.fn(),
  annulla: vi.fn(),
  dimentica: vi.fn(),
  ascoltaCaricamenti: vi.fn(),
  // Le foto: in jsdom l'immagine del watermark non si carica mai (la elaborazione resterebbe appesa) e IndexedDB non c'è.
  // Qui interessa solo CHE la foto prenda la sua strada di sempre, accanto a un video nativo.
  elaboraFoto: vi.fn(),
  accodaFoto: vi.fn(),
  listaFoto: vi.fn(),
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
vi.mock('@/lib/media/processing', async (originale) => ({
  ...(await originale<typeof import('@/lib/media/processing')>()),
  processImageWithWatermark: h.elaboraFoto,
}))
vi.mock('@/lib/gallery/coda-foto', async (originale) => ({
  ...(await originale<typeof import('@/lib/gallery/coda-foto')>()),
  accodaFotoGalleria: h.accodaFoto,
  listaFotoInCoda: h.listaFoto,
}))
vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(() => true),
  scegliFotoNativa: vi.fn(async () => []),
}))
vi.mock('@/lib/native/caricamenti-nativi', async (originale) => ({
  ...(await originale<typeof import('@/lib/native/caricamenti-nativi')>()),
  caricamentiNativiDisponibili: h.disponibili,
  scegliMedia: h.scegliMedia,
  annullaScelta: h.annullaScelta,
  ascoltaPreparazione: h.ascoltaPreparazione,
  leggiFoto: h.leggiFoto,
  scartaScelti: h.scartaScelti,
  accodaVideo: h.accodaVideo,
  elenco: h.elenco,
  annulla: h.annulla,
  dimentica: h.dimentica,
  ascoltaCaricamenti: h.ascoltaCaricamenti,
}))
// framer-motion → render diretto (deterministico in jsdom: niente animazioni di ingresso e di uscita fra i passi)
vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, variants, transition, whileHover, whileTap, layout, ...rest } = props
    void initial; void animate; void exit; void variants; void transition; void whileHover; void whileTap; void layout
    return rest
  }
  // Un componente per TAG, creato una volta: se `motion.div` ne creasse uno nuovo a ogni accesso, ogni render
  // cambierebbe il TIPO dell'elemento e React smonterebbe e rimonterebbe tutto il sotto-albero (e con lui
  // gli effetti: una rilevazione che parte, viene scartata e riparte, all'infinito).
  const cache: Record<string, unknown> = {}
  const motion = new Proxy({}, {
    get: (_t, tag: string) => (cache[tag] ??= React.forwardRef(function M(
      { children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>,
    ) { return React.createElement(tag, { ...strip(props), ref }, children) })),
  })
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => children }
})
vi.mock('@/lib/offline/syncEngine', () => ({
  saveLocalGalleryMedia: vi.fn(async () => undefined),
  syncPendingGalleryMedia: vi.fn(async () => undefined),
}))
vi.mock('@/lib/offline/db', () => ({}))
vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: vi.fn(async () => ({
    leggi: async () => undefined, elenca: async () => [], scrivi: async () => undefined, aggiorna: async () => undefined,
    elimina: async () => undefined, leggiByte: async () => new Blob(['x']), scriviByte: async () => undefined, eliminaByte: async () => undefined,
  })),
  accodaCaricamentoVideo: vi.fn(),
  caricaVideo: vi.fn(),
  potaArchivioCaricamenti: vi.fn(async () => 0),
  annullaCaricamentoVideo: vi.fn(),
  concludiCaricamentoVideo: vi.fn(),
}))

import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page'

const DOCENTE = 'aaaa1111-0000-4000-8000-000000000001'
const SEZIONE = 'TEST Infanzia'
const ADA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Ada', cognome: 'Bianchi', consenso_privacy: true }
const INFO = { protocollo: 1, piattaforma: 'ios', motore: 'urlsession' } as const
const SHA = 'd'.repeat(64)
const MINIATURA = 'data:image/jpeg;base64,/9j/AAAA'
const FOTO_LETTA = { base64: 'AQID', mime: 'image/jpeg', byte: 3, larghezza: 1920, altezza: 1080 }

const videoNativo = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `video-${n}`, tipo: 'video' as const, nome: `filmato-${n}.mov`, byte: 73_000_000, mime: 'video/quicktime',
  durataSecondi: 52, miniatura: MINIATURA, sha256: SHA, ...extra,
})
const fotoNativa = (n: number) => ({ id: `foto-${n}`, tipo: 'foto' as const, nome: `IMG_00${n}.HEIC`, larghezza: 1920, altezza: 1080, byte: 3 })

const json = (corpo: unknown, stato = 200) =>
  ({ ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo }) as unknown as Response

interface Chiamata { url: string; init?: RequestInit }
let chiamate: Chiamata[] = []
/** Come risponde l'apertura dell'intento: ogni test cambia solo ciò che prova. */
let apertura: (n: number, corpo: { file: Array<{ nome: string; sha256?: string }> }) => Response | Promise<Response> = (n) => aperturaNativa(n)
let aperture = 0

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const URL_PUT = 'https://esempio.supabase.co/storage/v1/object/upload/sign/video_originals/percorso.mov?token=TOKEN-FINTO-DELLA-PUT'
const TOKEN_RINNOVO = `kvr_${'Ab1_-'.repeat(8)}Ab1`
const ADESSO = '2026-10-03T10:00:00.000Z'

/** La risposta di un'apertura `put-nativo`: l'URL firmato nel job e il token di rinnovo accanto. */
function aperturaNativa(n: number) {
  return json(
    {
      intentId: uuid(200 + n), revisione: 1, canale: 'gallery', intent: { status: 'confirmed' },
      scadenzaCaricamentoIl: '2026-10-03T12:00:00.000Z',
      job: [{
        jobId: uuid(100 + n), chiaveIdempotenza: `gn1-prova-${n}`, firma: '', status: 'awaiting_upload', needs_upload: true,
        expires_at: '2026-10-03T12:00:00.000Z',
        caricamento: { protocollo: 'put', url: URL_PUT, metodo: 'PUT', intestazioni: { 'content-type': 'video/quicktime' } },
        rinnovo: { token: TOKEN_RINNOVO, scadeIl: '2026-10-05T10:00:00.000Z' },
      }],
    },
    201,
  )
}

/** Una voce della coda del plugin, come la restituisce `accodaVideo`. */
const voceNativa = (jobId: string, intentId: string, extra: Record<string, unknown> = {}) => ({
  jobId, intentId, utenteId: DOCENTE, scuolaId: SEDE_A, nome: 'filmato-1.mov', mime: 'video/quicktime', stato: 'in-coda',
  byteInviati: 0, byteTotali: 73_000_000, tentativi: 0, rinnovi: 0, codice: null, creatoIl: ADESSO, aggiornatoIl: ADESSO, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  chiamate = []
  aperture = 0
  apertura = (n) => aperturaNativa(n)
  h.accodaVideo.mockImplementation(async (r: { jobId: string; intentId: string }) => voceNativa(r.jobId, r.intentId))
  h.elenco.mockResolvedValue({ caricamenti: [] })
  h.annulla.mockResolvedValue({ annullato: true })
  h.dimentica.mockResolvedValue({ dimenticati: 1 })
  h.ascoltaCaricamenti.mockResolvedValue(async () => undefined)
  h.elaboraFoto.mockImplementation(async (f: File) => f)
  h.accodaFoto.mockResolvedValue(undefined)
  h.listaFoto.mockResolvedValue([])
  h.disponibili.mockResolvedValue(INFO)
  h.scegliMedia.mockResolvedValue({ annullato: true, elementi: [] })
  h.annullaScelta.mockResolvedValue({ annullata: true })
  h.scartaScelti.mockResolvedValue({ eliminati: 1 })
  h.leggiFoto.mockResolvedValue(FOTO_LETTA)
  h.ascoltaPreparazione.mockResolvedValue(async () => undefined)
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => true))
  let n = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:anteprima-${++n}`, revokeObjectURL: vi.fn() }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      chiamate.push({ url: u, init })
      if (u.includes('/api/educator-sections')) return json({ sectionNames: [SEZIONE] })
      if (u.includes('/api/diary/students')) return json([ADA])
      if (u.includes('/api/me')) return json({ ruolo: 'educator', scuola_id: SEDE_A })
      if (u.endsWith('/api/video-uploads') && init?.method === 'POST') {
        aperture += 1
        return apertura(aperture, JSON.parse(String(init.body)))
      }
      if (u.startsWith('/api/video-uploads?')) return json({ voci: [] })
      if (u.includes('/api/video-uploads/')) {
        return json({
          intentId: uuid(201), revisione: 3, canale: 'gallery', statoIntent: 'confirmed', aggiornatoIl: ADESSO,
          job: [{ jobId: uuid(101), intentId: uuid(201), canale: 'gallery', stato: 'queued', avanzamento: null, codice: null, riprovaAutomatica: false, aggiornatoIl: ADESSO }],
        })
      }
      if (u.includes('/api/gallery')) return init?.method === 'POST' ? json({ id: 'media-1' }, 201) : json({ media: [], total: 0 })
      return json({})
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Lascia passare qualche microtask e un giro di timer: serve a provare un'ASSENZA («non è stato chiamato niente»).
 * Niente `await act(async …)` qui: sulla pagina resta APPESA, già subito dopo il `render`, anche sulla pagina
 * web pura e senza nessun codice nativo. La causa, MISURATA: il mock di next-intl di `test/setup.ts` restituisce
 * un `t` NUOVO a ogni render, e `sincronizzaCoda` della pagina ha `t` fra le dipendenze — quindi il suo effetto
 * si rilancia a ogni render e la pagina rifà la GET della galleria in continuazione (3.641 GET in 1,2 s; con un
 * `t` stabile, come quello vero, sono 2). Un artefatto del mock, non della pagina in produzione. Le attese si
 * fanno con `waitFor`, che le aspetta senza passare da `act`.
 */
const asciuga = () => new Promise<void>((risolvi) => setTimeout(risolvi, 30))
const rimuoviFile = () => screen.queryAllByRole('button', { name: itShared.galleryRimuoviFile })

/** Apre il passo di scelta dell'app 1.2 (la rilevazione ha già risposto: i due pulsanti nativi sono disegnati). */
async function apriLaScelta() {
  const v = render(<TeacherGalleryPage />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }))
  await screen.findByTestId('gallery-selettore-galleria')
  return v
}

/** Sceglie dalla galleria nativa questi elementi, poi tocca «Modifica Tag»: si arriva al passo dei bambini. */
async function finoAlTagNativo(...elementi: unknown[]) {
  const v = await apriLaScelta()
  h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi })
  fireEvent.click(screen.getByTestId('gallery-selettore-galleria'))
  await waitFor(() => expect(rimuoviFile()).toHaveLength(elementi.length))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(itShared.galleryModificaTag) }))
  await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument())
  // Il passo dei bambini non ha più i pulsanti di scelta.
  expect(screen.queryByTestId('gallery-selettore-galleria')).not.toBeInTheDocument()
  return v
}

const striscia = () => document.querySelector('.overflow-x-auto') as HTMLElement
const tessere = () => Array.from(striscia().children) as HTMLElement[]

describe('il passo dei bambini mostra un video NATIVO', () => {
  it('la striscia ha una tessera per elemento, col suo <img> (la miniatura) e mai un <video>', async () => {
    await finoAlTagNativo(videoNativo(1), videoNativo(2))
    expect(tessere()).toHaveLength(2)
    for (const t of tessere()) {
      expect(t.querySelector('img')?.getAttribute('src')).toBe(MINIATURA)
      expect(t.querySelector('video')).toBeNull()
      // `solo-icona`: la parola «Video» resta per gli screen reader.
      expect(within(t).getByText(itShared.galleryVideo).className).toContain('sr-only')
    }
  })

  it('la riga «foto in configurazione» porta il NOME del video attivo, e cambia scegliendo un’altra tessera', async () => {
    await finoAlTagNativo(videoNativo(1), videoNativo(2))
    expect(screen.getByText('filmato-1.mov')).toBeInTheDocument()
    fireEvent.click(tessere()[1])
    expect(screen.getByText('filmato-2.mov')).toBeInTheDocument()
    expect(screen.queryByText('filmato-1.mov')).not.toBeInTheDocument()
  })

  it('un video nativo e una foto stanno insieme nella striscia: la foto è un `File` con il nome <nome>.jpg', async () => {
    await finoAlTagNativo(videoNativo(1), fotoNativa(1))
    expect(tessere()).toHaveLength(2)
    // I video entrano prima delle foto; la seconda tessera è la foto, con un <img> a blob e non a data URL.
    expect(tessere()[1].querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    fireEvent.click(tessere()[1])
    expect(screen.getByText('IMG_001.jpg')).toBeInTheDocument()
  })
})

describe('la X del passo dei bambini cancella la copia dal telefono (solo di un video nativo)', () => {
  it('la X di un video nativo chiama `scartaScelti` col SUO id e lo toglie dalla striscia', async () => {
    await finoAlTagNativo(videoNativo(1), videoNativo(2))
    expect(h.scartaScelti).not.toHaveBeenCalled()

    fireEvent.click(within(tessere()[0]).getByRole('button', { name: itShared.galleryRimuoviFile }))
    await waitFor(() => expect(tessere()).toHaveLength(1))
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1'] })
    // Il video che resta è il secondo, e la sua copia è ancora lì.
    expect(screen.getByText('filmato-2.mov')).toBeInTheDocument()
  })

  it('la X di una FOTO (un `File` già letto e cancellato dal plugin) non chiama niente e revoca il suo objectURL', async () => {
    await finoAlTagNativo(videoNativo(1), fotoNativa(1))
    fireEvent.click(within(tessere()[1]).getByRole('button', { name: itShared.galleryRimuoviFile }))
    await waitFor(() => expect(tessere()).toHaveLength(1))
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('togliere l’ULTIMO video riporta al passo di scelta, dopo aver scartato la copia', async () => {
    await finoAlTagNativo(videoNativo(1))
    fireEvent.click(within(tessere()[0]).getByRole('button', { name: itShared.galleryRimuoviFile }))
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1'] })
    await screen.findByTestId('gallery-selettore-galleria')
    expect(URL.revokeObjectURL, 'un video nativo non ha objectURL').not.toHaveBeenCalled()
  })

  it('un video di cui si è già fatto il giro non si scarta due volte: ogni id una volta sola', async () => {
    await finoAlTagNativo(videoNativo(1), videoNativo(2), videoNativo(3))
    fireEvent.click(within(tessere()[1]).getByRole('button', { name: itShared.galleryRimuoviFile }))
    await waitFor(() => expect(tessere()).toHaveLength(2))
    fireEvent.click(within(tessere()[0]).getByRole('button', { name: itShared.galleryRimuoviFile }))
    await waitFor(() => expect(tessere()).toHaveLength(1))
    expect(h.scartaScelti.mock.calls.map((c) => c[0])).toEqual([{ ids: ['video-2'] }, { ids: ['video-1'] }])
  })
})

describe('«Annulla» butta la scelta e con lei i video nativi', () => {
  it('dal passo dei bambini: `scartaScelti` con TUTTI gli id nativi (non quelli delle foto) e si torna alla galleria', async () => {
    await finoAlTagNativo(videoNativo(1), fotoNativa(1), videoNativo(2))
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryAnnulla }))

    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1', 'video-2'] })
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(itServizi.galleryCarica) })).toBeInTheDocument())
    expect(screen.queryByText(`${ADA.nome} ${ADA.cognome}`)).not.toBeInTheDocument()
  })

  it('con solo foto e file «Annulla» non tocca il plugin', async () => {
    await finoAlTagNativo(fotoNativa(1))
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryAnnulla }))
    await asciuga()
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })

  it('dal passo di SCELTA, con video scelti e non ancora consegnati, li scarta lo smontaggio di `MediaUploader`', async () => {
    await apriLaScelta()
    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: [videoNativo(1), videoNativo(2)] })
    fireEvent.click(screen.getByTestId('gallery-selettore-galleria'))
    await waitFor(() => expect(rimuoviFile()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryAnnulla }))
    await asciuga()
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1', 'video-2'] })
  })
})

describe('lo SMONTAGGIO della pagina scarta i video nativi non ancora partiti', () => {
  it('uscire dalla Galleria dal passo dei bambini cancella le copie (e solo i nativi)', async () => {
    const { unmount } = await finoAlTagNativo(videoNativo(1), fotoNativa(1), videoNativo(2))
    expect(h.scartaScelti).not.toHaveBeenCalled()

    unmount()
    await asciuga()
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1', 'video-2'] })
  })

  it('lo smontaggio vede l’elenco di ADESSO, non quello del primo render: un video già tolto con la X non si riscarta', async () => {
    const { unmount } = await finoAlTagNativo(videoNativo(1), videoNativo(2))
    fireEvent.click(within(tessere()[0]).getByRole('button', { name: itShared.galleryRimuoviFile }))
    await waitFor(() => expect(tessere()).toHaveLength(1))
    h.scartaScelti.mockClear()

    unmount()
    await asciuga()
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-2'] })
  })

  it('senza video nativi (solo web o solo foto) lo smontaggio non chiama il plugin', async () => {
    const { unmount } = await apriLaScelta()
    unmount()
    await asciuga()
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })

  it('nel passo della galleria (niente scelto) lo smontaggio non chiama niente', async () => {
    const { unmount } = render(<TeacherGalleryPage />)
    await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) })
    unmount()
    await asciuga()
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })
})

describe('un elenco con un video nativo non rompe la pagina sul web e nelle app 1.0/1.1', () => {
  it('sul web (nessun plugin) la scelta resta il riquadro con l’<input>, e un `File` va al passo dei bambini come sempre', async () => {
    h.disponibili.mockResolvedValue(null)
    const v = render(<TeacherGalleryPage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }))
    await screen.findByTestId('gallery-selettore-riquadro')
    const input = v.container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'foto.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itShared.galleryModificaTag) }))
    await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument())
    expect(screen.getByText('foto.jpg')).toBeInTheDocument()
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * L'INVIO («Pubblica») DEI VIDEO NATIVI — compito J3 (spec §7.4)
 *
 * «Pubblica» manda ogni video nativo a `videoGalleria.avviaVideoNativo`: l'apertura dell'intento col trasporto `put-nativo`
 * e i bambini scelti, poi `accodaVideo` al plugin, che spedisce i byte dal sistema operativo. Un rifiuto dell'apertura (il
 * 422 che nomina i bambini senza liberatoria) resta NEL PASSO DEI BAMBINI, con i file ancora lì e prima di un solo byte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const pulsantePubblica = () => screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) })
const avvisi = () => screen.getByTestId('avvisi-invio')
const aperture_ = () => chiamate.filter((c) => c.url.endsWith('/api/video-uploads') && c.init?.method === 'POST')
const corpoApertura = (n = 0) => JSON.parse(String(aperture_()[n].init!.body)) as {
  trasporto: string; file: Array<{ nome: string; sha256: string; byte: number; chiaveIdempotenza: string }>
  destinatari: { tagAlunni: string[]; broadcast: boolean; classi: string[] }
}
const patchFatti = () => chiamate.filter((c) => c.init?.method === 'PATCH').map((c) => JSON.parse(String(c.init!.body)).azione as string)
const scrittoNeiLog = () => JSON.stringify(h.logClient.mock.calls)

/** Arriva al passo dei bambini con questi elementi e sceglie Ada sul primo (e sugli altri con «Applica»). */
async function finoAPubblica(...elementi: unknown[]) {
  const v = await finoAlTagNativo(...elementi)
  fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`))
  if (elementi.length > 1) fireEvent.click(screen.getByRole('button', { name: /Applica/ }))
  return v
}

describe('«Pubblica» con un video NATIVO: apertura `put-nativo`, poi `accodaVideo`, e il video esce dall’elenco', () => {
  it('la POST porta `put-nativo`, lo `sha256` e Ada; `accodaVideo` riceve i campi della risposta; l’avviso dice del multitasking', async () => {
    await finoAPubblica(videoNativo(1))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(h.accodaVideo).toHaveBeenCalledTimes(1))
    const apertura = corpoApertura()
    expect(apertura.trasporto).toBe('put-nativo')
    expect(apertura.destinatari).toEqual({ tagAlunni: [ADA.id], broadcast: false, classi: [] })
    // La durata è quella che il plugin ha misurato (il nativo non passa dal browser per saperla).
    expect(apertura.file[0]).toMatchObject({ nome: 'filmato-1.mov', sha256: SHA, byte: 73_000_000, durataSecondi: 52 })
    expect(apertura.file[0].chiaveIdempotenza).toMatch(/^gn1-73000000-[0-9a-f]{12}-[0-9a-f]{12}$/)
    expect(h.accodaVideo.mock.calls[0][0]).toMatchObject({
      idElemento: 'video-1', sha256: SHA, byteAttesi: 73_000_000, jobId: uuid(101), intentId: uuid(201), utenteId: DOCENTE, scuolaId: SEDE_A,
      caricamento: { url: URL_PUT, contentType: 'video/quicktime' },
      rinnovo: { token: TOKEN_RINNOVO },
    })

    // L'AVVISO BREVE del titolare: si può bloccare il telefono, ma non chiudere Kidville dal multitasking.
    await waitFor(() => expect(avvisi()).toHaveTextContent('Il video è in invio.'))
    expect(avvisi()).toHaveTextContent(/non chiudere Kidville dal multitasking finché non è inviato/)
    // «Caricato» non si dice: i byte non sono ancora partiti.
    expect(patchFatti()).toEqual([])
  })

  it('il video esce dall’elenco e si torna alla galleria, dove la sua scheda racconta l’invio; la copia NON si scarta (è del plugin)', async () => {
    await finoAPubblica(videoNativo(1))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(itServizi.galleryCarica) })).toBeInTheDocument())
    expect(screen.queryByText(`${ADA.nome} ${ADA.cognome}`)).not.toBeInTheDocument()
    // La scheda «Video in preparazione»: il nome, la fase «in attesa del suo turno» e la nota del multitasking.
    await waitFor(() => expect(screen.getByText(itServizi.galleryVideoLavorazioneTitolo)).toBeInTheDocument())
    expect(screen.getByText('filmato-1.mov')).toBeInTheDocument()
    expect(screen.getByText(itServizi.galleryVideoFaseInFila)).toBeInTheDocument()
    expect(screen.getByText(itServizi.galleryVideoNotaNativo)).toBeInTheDocument()
    // Né «Annulla» né lo smontaggio hanno toccato il plugin: il video consegnato non sta più fra i preparati.
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })

  it('dopo l’invio lo SMONTAGGIO della pagina non scarta il video consegnato al plugin (e nemmeno uno che ne ha preso il posto)', async () => {
    const { unmount } = await finoAPubblica(videoNativo(1))
    fireEvent.click(pulsantePubblica())
    await waitFor(() => expect(h.accodaVideo).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(itServizi.galleryCarica) })).toBeInTheDocument())

    unmount()
    await asciuga()
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })

  it('più video: ognuno apre il SUO intento, in serie, e l’avviso conta quanti sono; i bambini di ciascuno restano i suoi', async () => {
    await finoAPubblica(videoNativo(1), videoNativo(2, { sha256: 'e'.repeat(64) }))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(h.accodaVideo).toHaveBeenCalledTimes(2))
    expect(corpoApertura(0).file[0].nome).toBe('filmato-1.mov')
    expect(corpoApertura(1).file[0].nome).toBe('filmato-2.mov')
    expect(corpoApertura(1).file[0].sha256).toBe('e'.repeat(64))
    expect(corpoApertura(0).file[0].chiaveIdempotenza).not.toBe(corpoApertura(1).file[0].chiaveIdempotenza)
    expect(h.accodaVideo.mock.calls.map((c) => c[0].idElemento)).toEqual(['video-1', 'video-2'])
    await waitFor(() => expect(avvisi()).toHaveTextContent('2 video sono in invio.'))
  })

  it('un video nativo e una FOTO insieme: la foto prende la sua strada di sempre, e il video la sua', async () => {
    await finoAPubblica(videoNativo(1), fotoNativa(1))
    fireEvent.click(pulsantePubblica())
    await waitFor(() => expect(h.accodaVideo).toHaveBeenCalledTimes(1))
    expect(aperture_()).toHaveLength(1)
    await waitFor(() => expect(avvisi()).toHaveTextContent('Il video è in invio.'))
    // La foto (un `File` JPEG già letto dal plugin) va alla coda delle foto con il watermark, come sempre.
    expect(h.accodaFoto).toHaveBeenCalledTimes(1)
    expect(h.accodaFoto.mock.calls[0][0]).toMatchObject({ caption: 'IMG_001.jpg', tag_students: [ADA.id], uploaded_by: DOCENTE })
    expect(h.elaboraFoto).toHaveBeenCalledTimes(1)
    // E il video nativo NON passa dalla porta delle foto, né il suo `sha256` finisce lì.
    expect(JSON.stringify(h.accodaFoto.mock.calls)).not.toContain(SHA)
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(itServizi.galleryCarica) })).toBeInTheDocument())
  })
})

describe('«Pubblica» con un video NATIVO rifiutato: il file resta nel passo dei bambini, e non è partito un byte', () => {
  it('il 422 della liberatoria: i NOMI a schermo (mai nei log), nessun `accodaVideo`, il video resta, e la sua copia non si cancella', async () => {
    apertura = () => json({ error: 'Foto di gruppo non pubblicabile: alcuni bambini non hanno la liberatoria foto.', nomi: ['Ada B.'], ids: [ADA.id] }, 422)
    await finoAPubblica(videoNativo(1))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(avvisi()).toHaveTextContent('Foto di gruppo non pubblicabile'))
    expect(avvisi()).toHaveTextContent('Ada B.')
    expect(h.accodaVideo).not.toHaveBeenCalled()
    expect(h.scartaScelti).not.toHaveBeenCalled()
    // Il passo dei bambini è ancora lì, col suo video (la X per toglierlo, il pulsante «Pubblica» per riprovare).
    expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument()
    expect(tessere()).toHaveLength(1)
    expect(pulsantePubblica()).toBeEnabled()
    expect(scrittoNeiLog()).not.toContain('Ada')
    expect(scrittoNeiLog()).not.toContain('filmato-1')
  })

  it('con DUE video e un 422 sul primo: il primo resta (col suo nome nell’avviso), il secondo parte comunque', async () => {
    apertura = (n) => (n === 1 ? json({ error: 'Foto di gruppo non pubblicabile.', nomi: ['Ada B.'] }, 422) : aperturaNativa(n))
    await finoAPubblica(videoNativo(1), videoNativo(2, { sha256: 'e'.repeat(64) }))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(h.accodaVideo).toHaveBeenCalledTimes(1))
    expect(h.accodaVideo.mock.calls[0][0].idElemento).toBe('video-2')
    await waitFor(() => expect(avvisi()).toHaveTextContent('«filmato-1.mov»: Foto di gruppo non pubblicabile.'))
    // Resta nel passo dei bambini il solo video rifiutato.
    await waitFor(() => expect(tessere()).toHaveLength(1))
    expect(screen.getByText('filmato-1.mov')).toBeInTheDocument()
  })

  it('un video più lungo di cinque minuti (la durata la misura il plugin) si rifiuta SUBITO, senza aprire nessun intento', async () => {
    await finoAPubblica(videoNativo(1, { durataSecondi: 301 }))
    fireEvent.click(pulsantePubblica())
    await waitFor(() => expect(avvisi()).toHaveTextContent(itShared.erroreVideoTroppoLungo))
    expect(aperture_()).toHaveLength(0)
    expect(h.accodaVideo).not.toHaveBeenCalled()
    expect(tessere()).toHaveLength(1)
  })

  it('«troppe richieste» (429) ferma il giro: il secondo video non viene nemmeno tentato, e tutti restano dov’erano', async () => {
    apertura = () => new Response(JSON.stringify({ error: 'x', codice: 'TROPPE_RICHIESTE' }), { status: 429, headers: { 'Retry-After': '60' } })
    await finoAPubblica(videoNativo(1), videoNativo(2, { sha256: 'e'.repeat(64) }))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(avvisi()).toHaveTextContent(/\S/))
    expect(aperture_()).toHaveLength(1)
    expect(h.accodaVideo).not.toHaveBeenCalled()
    expect(tessere()).toHaveLength(2)
  })

  it('un `accodaVideo` rifiutato (ELEMENTO_ASSENTE): errore a schermo, l’intento si ritira, il video resta, e nei log il solo codice', async () => {
    const { ErroreCaricamentiNativi } = await import('@/lib/native/caricamenti-nativi')
    h.accodaVideo.mockRejectedValueOnce(new ErroreCaricamentiNativi('ELEMENTO_ASSENTE'))
    await finoAPubblica(videoNativo(1))
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(avvisi()).toHaveTextContent(itServizi.galleryErrCaricamentoGenerico))
    await waitFor(() => expect(patchFatti()).toEqual(['annulla']))
    expect(tessere()).toHaveLength(1)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error', evento: 'caricamento-nativo', messaggio: `video-nativo-accodamento-fallito: job=${uuid(101)} ELEMENTO_ASSENTE`,
    }))
    expect(scrittoNeiLog()).not.toContain('filmato-1')
    expect(scrittoNeiLog()).not.toContain('supabase.co')
    expect(scrittoNeiLog()).not.toContain(SHA)
  })

  it('SENZA RETE un video nativo non si invia: l’apertura è una richiesta, il file resta con la sua copia, e il messaggio dice quale', async () => {
    await finoAPubblica(videoNativo(1))
    const spia = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    // Un `online`/`offline` fa rileggere lo stato alla pagina (`useOnlineStatus`).
    act(() => { window.dispatchEvent(new Event('offline')) })
    await waitFor(() => expect(screen.getByText(itServizi.galleryOffline)).toBeInTheDocument())

    fireEvent.click(pulsantePubblica())
    await waitFor(() => expect(avvisi()).toHaveTextContent('Il video «filmato-1.mov» non può essere inviato senza connessione'))
    expect(aperture_()).toHaveLength(0)
    expect(h.accodaVideo).not.toHaveBeenCalled()
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(tessere()).toHaveLength(1)
    spia.mockRestore()
  })
})

describe('«Annulla» si spegne mentre «Pubblica» scorre l’elenco: non deve scartare le copie native che il giro non ha ancora consegnato', () => {
  it('con l’apertura in volo «Annulla» è spento, un clic non scarta niente, e a giro finito la pagina torna alla galleria', async () => {
    let completa!: (r: Response) => void
    apertura = () => new Promise<Response>((r) => { completa = r })
    await finoAPubblica(videoNativo(1), videoNativo(2, { sha256: 'e'.repeat(64) }))
    const annulla = screen.getByRole('button', { name: itServizi.galleryAnnulla })
    expect(annulla, 'prima di «Pubblica» è premibile').toBeEnabled()

    fireEvent.click(pulsantePubblica())
    await waitFor(() => expect(aperture_()).toHaveLength(1))
    expect(annulla).toBeDisabled()
    fireEvent.click(annulla)
    await asciuga()
    // Il secondo video non è ancora stato consegnato al plugin: «Annulla» ne avrebbe cancellato la copia sotto i piedi del giro.
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument()

    // Il giro prosegue e finisce: tutti e due i video partono, e «Annulla» sparisce con il passo dei bambini.
    apertura = (n) => aperturaNativa(n)
    completa(aperturaNativa(1))
    await waitFor(() => expect(h.accodaVideo).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(itServizi.galleryCarica) })).toBeInTheDocument())
    expect(h.scartaScelti).not.toHaveBeenCalled()
  })

  it('controprova: a giro finito (un rifiuto lascia il video nel passo dei bambini) «Annulla» torna premibile e scarta la copia', async () => {
    apertura = () => json({ error: 'Foto di gruppo non pubblicabile.', nomi: ['Ada B.'] }, 422)
    await finoAPubblica(videoNativo(1))
    fireEvent.click(pulsantePubblica())
    await waitFor(() => expect(avvisi()).toHaveTextContent('Foto di gruppo non pubblicabile'))

    const annulla = screen.getByRole('button', { name: itServizi.galleryAnnulla })
    await waitFor(() => expect(annulla).toBeEnabled())
    fireEvent.click(annulla)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1'] })
  })
})
