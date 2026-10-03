import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

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
 * L'INVIO («Pubblica») dei video nativi è di J3 (`avviaVideoNativo`): qui se ne prova solo il segnaposto di J2, in
 * un blocco a parte che J3 toglie quando l'invio vero esiste.
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

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  chiamate = []
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
      if (u.startsWith('/api/video-uploads?')) return json({ voci: [] })
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
 * SEGNAPOSTO DI J2 — J3 TOGLIE QUESTO BLOCCO quando `avviaVideoNativo` esiste (spec §7.4).
 *
 * Fino a J3 un video nativo NON parte da «Pubblica»: lo dice un avviso (mai in silenzio) e il video resta
 * nell'elenco con la sua copia sul telefono. Si prova solo che il segnaposto non faccia danni: nessuna
 * apertura dell'intento, nessuna copia cancellata, nessun file perso.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */
describe('SEGNAPOSTO J2: «Pubblica» con un video nativo (l’invio vero è di J3)', () => {
  it('non parte niente, lo dice, e il video resta nell’elenco con la sua copia', async () => {
    await finoAlTagNativo(videoNativo(1))
    fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) }))

    await waitFor(() => expect(screen.getByTestId('avvisi-invio')).toHaveTextContent(itServizi.galleryErrCaricamentoGenerico))
    expect(chiamate.some((c) => c.url.endsWith('/api/video-uploads') && c.init?.method === 'POST'), 'nessuna apertura dell’intento').toBe(false)
    expect(h.scartaScelti, 'la copia non si cancella: il video è ancora lì').not.toHaveBeenCalled()
    expect(tessere()).toHaveLength(1)
  })
})
