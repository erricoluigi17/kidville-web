import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import itServizi from '../../messages/it/teacherServizi.json'
import { SEDE_A } from '../fixtures/sedi'

/**
 * V11 · LA GALLERIA DELL'INSEGNANTE ACCETTA I VIDEO — il giro intero, dopo la PR 2 «server e web».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CHE COSA CAMBIA, E PERCHÉ NON È UN RITOCCO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prima i bambini vivevano nella memoria della pagina: «Pubblica» apriva l'intento senza dire per chi,
 * i byte partivano, e quando il video era pronto era il BROWSER a pubblicarlo — se la pagina c'era
 * ancora. Con la pagina chiusa il video restava convertito e mai pubblicato. Adesso:
 *
 *  · «Pubblica» manda SUBITO l'apertura di ogni video **con i bambini**, e un rifiuto (il 422 che
 *    nomina chi non ha la liberatoria) resta NEL PASSO DEI BAMBINI, con i file ancora lì e ZERO
 *    richieste verso lo Storage;
 *  · nessun `alert()` nel ramo di invio: esiti ed errori escono in una regione viva SEMPRE montata
 *    (secondario #36), che VoiceOver conosce già quando si riempie;
 *  · a pubblicare è il server: la pagina non ha più nessun pulsante «Pubblica» sulle schede, non
 *    richiede i bambini al rientro e non chiama più `POST /api/gallery` per un video.
 *
 * L'uploader TUS è finto ai suoi confini: ha i suoi collaudi, col `tus.Upload` vero, contro un server
 * che interrompe DAVVERO una `PATCH` a metà.
 */

const h = vi.hoisted(() => ({
  logClient: vi.fn(),
  accoda: vi.fn(),
  carica: vi.fn(),
  pota: vi.fn(),
  annulla: vi.fn(),
  concludi: vi.fn(),
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
// La misura della durata aspetta i metadati di un `<video>` che jsdom non decodifica mai: ogni file
// pagherebbe per intero l'attesa di sicurezza (4 s). Si misura da sé, nei suoi test
// (`gallery-video-flusso.test.ts`); qui la durata «non si sa», che è il caso normale di un telefono.
vi.mock('@/lib/gallery/video-galleria-flusso', async (originale) => ({
  ...(await originale<typeof import('@/lib/gallery/video-galleria-flusso')>()),
  durataVideoDalFile: vi.fn(async () => null),
}))
vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: vi.fn(async () => archivioFinto()),
  accodaCaricamentoVideo: h.accoda,
  caricaVideo: h.carica,
  potaArchivioCaricamenti: h.pota,
  annullaCaricamentoVideo: h.annulla,
  concludiCaricamentoVideo: h.concludi,
}))

import { MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page'

const DOCENTE = 'aaaa1111-0000-4000-8000-000000000001'
const SEZIONE = 'TEST Infanzia'
const ADA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Ada', cognome: 'Bianchi', consenso_privacy: true }
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function archivioFinto() {
  return {
    leggi: async (jobId: string) => h.righeArchivio.find((r) => r.jobId === jobId),
    elenca: async () => h.righeArchivio,
    scrivi: async (riga: Record<string, unknown>) => { h.righeArchivio.push(riga) },
    aggiorna: async (jobId: string, mod: object) => Object.assign(h.righeArchivio.find((r) => r.jobId === jobId) ?? {}, mod),
    elimina: async (jobId: string) => { h.righeArchivio = h.righeArchivio.filter((r) => r.jobId !== jobId) },
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

interface Chiamata { url: string; init?: RequestInit }
let chiamate: Chiamata[] = []
/** Le voci che l'elenco del server restituisce in questo momento del test. */
let voci: unknown[] = []
/** Come risponde l'apertura: per numero d'ordine e per nome del file (che sta nel corpo, mai nei log). */
let apertura: (n: number, nomeFile: string) => Response = (n) => rispostaApertura(n)
let aperture = 0

const json = (corpo: unknown, stato = 200) =>
  ({ ok: stato >= 200 && stato < 300, status: stato, json: async () => corpo }) as unknown as Response

function rispostaApertura(n: number) {
  return json(
    {
      intentId: uuid(200 + n),
      revisione: 1,
      canale: 'gallery',
      intent: { status: 'confirmed' },
      scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
      job: [{ jobId: uuid(100 + n), chiaveIdempotenza: `g-${n}`, caricamento: COORDINATE, firma: 'firma-finta', status: 'awaiting_upload', needs_upload: true, expires_at: new Date(Date.now() + 7_200_000).toISOString() }],
    },
    201,
  )
}

function voce(fase: string, extra: Record<string, unknown> = {}) {
  const conErrore = fase === 'fallito' || fase === 'non-pubblicato'
  return {
    intentId: uuid(201), jobId: uuid(101), fase,
    codice: conErrore ? (fase === 'fallito' ? 'VIDEO_TROPPO_LUNGO' : 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA') : null,
    creatoIl: '2026-10-02T10:00:00.000Z', aggiornatoIl: '2026-10-02T10:00:09.000Z',
    trasporto: 'tus', byte: 12_345, durataS: null, nBambini: 1, broadcast: false, mediaId: null,
    pubblicazioneAutomatica: fase !== 'da-ricaricare', riprovaPossibile: false, ...extra,
  }
}

const alertMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  chiamate = []
  voci = []
  aperture = 0
  apertura = (n) => rispostaApertura(n)
  h.righeArchivio = []
  h.pota.mockResolvedValue(0)
  h.concludi.mockResolvedValue(undefined)
  h.accoda.mockImplementation(async (_dip: unknown, ingresso: Record<string, unknown> & { jobId: string; file: File }) => {
    const riga = { ...ingresso, stato: 'da_caricare', dimensioneByte: ingresso.file.size, mime: ingresso.file.type, nome: ingresso.file.name, offsetByte: 0, creatoIl: '2026-10-02T10:00:00.000Z' }
    h.righeArchivio.push(riga)
    return { ok: true, riga }
  })
  h.carica.mockImplementation(async (_dip: unknown, jobId: string) => ({ esito: 'caricato', jobId, byteCaricati: 1234 }))

  vi.stubGlobal('alert', alertMock)
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
        const corpo = JSON.parse(String(init.body)) as { file: Array<{ nome: string }> }
        return apertura(aperture, corpo.file[0].nome)
      }
      if (u.startsWith('/api/video-uploads?')) return json({ voci })
      if (u.includes('/api/video-uploads/')) {
        const azione = init?.method === 'PATCH' ? JSON.parse(String(init.body)).azione : null
        return json({
          intentId: uuid(201), revisione: 3, canale: 'gallery', statoIntent: 'confirmed', aggiornatoIl: '2026-10-02T10:00:00.000Z',
          job: [{ jobId: uuid(101), intentId: uuid(201), canale: 'gallery', stato: azione === 'caricato' ? 'queued' : 'queued', avanzamento: 25, codice: null, riprovaAutomatica: false, aggiornatoIl: '2026-10-02T10:00:00.000Z' }],
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

const video = (nome = 'recita.mp4', byte = 12_345_678) => {
  const f = new File(['x'], nome, { type: 'video/mp4' })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}

/** Porta la schermata al passo «tag» con i file dati, e tagga Ada sul primo (e sugli altri con «Applica»). */
async function finoAlTag(...files: File[]) {
  const v = render(<TeacherGalleryPage />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }))
  await waitFor(() => expect(v.container.querySelector('input[type="file"]')).toBeTruthy())
  const input = v.container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files } })
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(itShared.galleryModificaTag) }))
  await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument())
  fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`))
  if (files.length > 1) fireEvent.click(screen.getByRole('button', { name: /Applica/ }))
  return v
}

const pulsantePubblica = () => screen.getByRole('button', { name: new RegExp(itServizi.galleryPubblica.split('{')[0].trim()) })
const avvisi = () => screen.getByTestId('avvisi-invio')

/** Il corpo JSON della n-esima apertura. */
const corpoApertura = (n = 0) => {
  const c = chiamate.filter((x) => x.url.endsWith('/api/video-uploads') && x.init?.method === 'POST')[n]
  return c?.init?.body ? (JSON.parse(String(c.init.body)) as Record<string, unknown>) : null
}
const patchFatti = () => chiamate.filter((c) => c.init?.method === 'PATCH').map((c) => JSON.parse(String(c.init!.body)).azione as string)

describe('«Pubblica» manda subito l’apertura di ogni video, con i bambini', () => {
  it('la POST porta i destinatari scelti, il trasporto e la sede; poi i byte partono e il video NON diventa una riga di galleria', async () => {
    await finoAlTag(video())
    fireEvent.click(pulsantePubblica())

    await waitFor(() => expect(corpoApertura()).not.toBeNull())
    const apertura = corpoApertura()!
    expect(apertura.canale).toBe('gallery')
    expect(apertura.azione).toBe('publish')
    expect(apertura.scuolaId).toBe(SEDE_A)
    expect(apertura.destinatari).toEqual({ tagAlunni: [ADA.id], broadcast: false, classi: [] })
    expect(apertura.trasporto).toBe('tus')

    await waitFor(() => expect(h.accoda).toHaveBeenCalled())
    await waitFor(() => expect(h.carica).toHaveBeenCalled())
    expect((h.accoda.mock.calls[0][1] as { canale: string }).canale).toBe('gallery')

    // La riga di galleria la scrive il server, a conversione finita: il browser non scrive niente.
    await waitFor(() => expect(patchFatti()).toEqual(['caricato']))
    expect(chiamate.some((c) => c.url.includes('/api/gallery') && c.init?.method === 'POST')).toBe(false)
    expect(patchFatti()).not.toContain('conferma')
  })

  it('torna alla galleria, e la scheda del video racconta il caricamento con la nota onesta del TUS', async () => {
    h.carica.mockImplementation(() => new Promise(() => undefined)) // il trasferimento è in volo
    await finoAlTag(video('recita.mp4'))
    fireEvent.click(pulsantePubblica())

    expect(await screen.findByText(itServizi.galleryVideoLavorazioneTitolo)).toBeInTheDocument()
    expect(screen.getByText('recita.mp4')).toBeInTheDocument()
    expect(screen.getByText(itServizi.galleryVideoFaseCaricamento)).toBeInTheDocument()
    // «Finché resti in Galleria»: con TUS «puoi chiudere l'app» sarebbe falso, e la scheda non lo dice.
    expect(screen.getByText(itServizi.galleryVideoCaricamentoTus)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('un video pronto non chiede i bambini e non ha un pulsante «Pubblica»: a pubblicare è il server', async () => {
    voci = [voce('pronto')]
    render(<TeacherGalleryPage />)
    expect(await screen.findByText(itServizi.galleryVideoFasePronto)).toBeInTheDocument()
    const sezione = screen.getByText(itServizi.galleryVideoLavorazioneTitolo).closest('section')!
    expect(within(sezione).queryByRole('button', { name: /pubblica/i })).toBeNull()
    expect(within(sezione).queryByText(/Scegli i bambini/)).toBeNull()
    expect(chiamate.some((c) => c.url.includes('/api/gallery') && c.init?.method === 'POST')).toBe(false)
  })
})

describe('un rifiuto resta NEL PASSO DEI BAMBINI, e non parte un solo byte', () => {
  const PRIVACY_LOCK = () =>
    json({ error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto.', nomi: ['Ada B.'], ids: [ADA.id] }, 422)

  it('il 422 mostra il messaggio coi NOMI in una regione viva, lascia il file e il passo dov’erano, e ZERO richieste TUS', async () => {
    apertura = () => PRIVACY_LOCK()
    await finoAlTag(video())
    fireEvent.click(pulsantePubblica())

    const banner = await within(avvisi()).findByText(/Foto di gruppo non pubblicabile/)
    expect(banner.textContent).toContain('(Ada B.)')
    // Il passo dei bambini c'è ancora (titolo, bambini, pulsante) e il file è ancora nell'elenco.
    expect(screen.getByText(itServizi.galleryStep2)).toBeInTheDocument()
    expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument()
    expect(pulsantePubblica()).toBeEnabled()
    // ZERO byte: né accodamento, né trasferimento, né una sola richiesta verso lo Storage.
    expect(h.accoda).not.toHaveBeenCalled()
    expect(h.carica).not.toHaveBeenCalled()
    expect(chiamate.some((c) => c.url.includes('/upload/resumable'))).toBe(false)
    expect(patchFatti()).toEqual([])
    // E niente `alert()`.
    expect(alertMock).not.toHaveBeenCalled()
    // I nomi stanno a schermo e basta.
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Ada')
  })

  it('corretti i bambini, lo stesso invio riparte: il file non si è perso, e il vecchio rifiuto non resta mentre si invia', async () => {
    let completa!: (r: Response) => void
    apertura = (n) => (n === 1 ? PRIVACY_LOCK() : (new Promise<Response>((r) => { completa = r }) as unknown as Response))
    await finoAlTag(video())
    fireEvent.click(pulsantePubblica())
    await within(avvisi()).findByText(/Foto di gruppo non pubblicabile/)

    fireEvent.click(pulsantePubblica())
    // Il secondo giro è in volo (la PRESENZA prima: c'è la rotella). Il vecchio rifiuto è già sparito:
    // non resta accanto a un invio che sta andando bene, dove direbbe una cosa che non è più vera.
    expect(await screen.findByText(itServizi.galleryCaricamentoUpload)).toBeInTheDocument()
    expect(within(avvisi()).queryByText(/Foto di gruppo non pubblicabile/)).toBeNull()

    completa(rispostaApertura(2))
    await waitFor(() => expect(h.accoda).toHaveBeenCalledTimes(1))
    expect(await within(avvisi()).findByText(/stato inviato/)).toBeInTheDocument()
    expect(aperture).toBe(2)
  })

  it('un rifiuto di sede (403 con codice) si legge dal catalogo, nello stesso posto', async () => {
    apertura = () => json({ error: 'prosa italiana del server', codice: 'TAG_FUORI_SEDE' }, 403)
    await finoAlTag(video())
    fireEvent.click(pulsantePubblica())
    expect(await within(avvisi()).findByText(itShared.erroreTagFuoriSede)).toBeInTheDocument()
    expect(h.accoda).not.toHaveBeenCalled()
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('con più file, il video rifiutato resta (col suo nome nell’avviso) e l’altro parte', async () => {
    apertura = (n, nome) => (nome === 'rifiutato.mp4' ? PRIVACY_LOCK() : rispostaApertura(n))
    await finoAlTag(video('rifiutato.mp4'), video('accettato.mp4', 22_222_222))
    fireEvent.click(pulsantePubblica())

    // Il rifiutato dice QUALE file è, e perché; l'altro è partito.
    const rifiuto = await within(avvisi()).findByText(/«rifiutato\.mp4»: Foto di gruppo non pubblicabile/)
    expect(rifiuto.textContent).toContain('(Ada B.)')
    await waitFor(() => expect(h.accoda).toHaveBeenCalledTimes(1))
    expect((h.accoda.mock.calls[0][1] as { file: File }).file.name).toBe('accettato.mp4')
    // Il passo dei bambini resta, con il file rifiutato ancora da sistemare.
    await waitFor(() => expect(screen.getByText(itServizi.galleryStep2)).toBeInTheDocument())
    // Il file rifiutato è l'UNICO rimasto nell'elenco («Foto 1 di 1»), non perso né duplicato.
    expect(screen.getByText(itServizi.galleryFotoNofM.replace('{index}', '1').replace('{totale}', '1'))).toBeInTheDocument()
    expect(within(avvisi()).getByText(/stato inviato/)).toBeInTheDocument()
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('«troppe richieste»: l’avviso è UNO, senza nome, e il giro si ferma — i file restano dove sono', async () => {
    apertura = () => json({ error: 'x', codice: 'TROPPE_RICHIESTE' }, 429)
    await finoAlTag(video('uno.mp4', 11_000_000), video('due.mp4', 22_000_000), video('tre.mp4', 33_000_000))
    fireEvent.click(pulsantePubblica())

    const avviso = await within(avvisi()).findByText(itShared.erroreTroppeRichieste)
    expect(within(avvisi()).getAllByText(itShared.erroreTroppeRichieste)).toHaveLength(1)
    expect(avviso.textContent).not.toMatch(/\.mp4/)
    // Si è fermato alla prima: una richiesta sola, non tre uguali.
    expect(aperture).toBe(1)
    expect(h.accoda).not.toHaveBeenCalled()
    expect(screen.getByText(itServizi.galleryStep2)).toBeInTheDocument()
    expect(screen.getByText(itServizi.galleryFotoNofM.replace('{index}', '1').replace('{totale}', '3'))).toBeInTheDocument()
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('offline il file resta, il messaggio è in linea e non parte nessuna richiesta di invio', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await finoAlTag(video('recita.mp4'))
    fireEvent.click(pulsantePubblica())

    expect(await within(avvisi()).findByText(itServizi.galleryAlertVideoOffline.replace('{nome}', 'recita.mp4'))).toBeInTheDocument()
    expect(aperture).toBe(0)
    expect(h.accoda).not.toHaveBeenCalled()
    expect(screen.getByText(itServizi.galleryStep2)).toBeInTheDocument()
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('un file oltre i limiti della pipeline si rifiuta in linea, PRIMA di aprire un intento', async () => {
    await finoAlTag(video('enorme.mp4', MAX_VIDEO_INPUT_BYTES + 1))
    fireEvent.click(pulsantePubblica())
    expect(await within(avvisi()).findByText(itShared.erroreVideoTroppoGrande)).toBeInTheDocument()
    expect(aperture).toBe(0)
    expect(h.accoda).not.toHaveBeenCalled()
    expect(alertMock).not.toHaveBeenCalled()
  })
})

describe('nessun `alert()` nel ramo di invio: gli esiti escono in una regione viva SEMPRE montata (#36)', () => {
  it('la regione c’è PRIMA di qualunque messaggio, è viva, e non lascia spazio finché è vuota', async () => {
    const { container } = render(<TeacherGalleryPage />)
    await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) })
    const regione = avvisi()
    expect(regione).toHaveAttribute('aria-live', 'polite')
    expect(regione).toHaveAttribute('role', 'status')
    expect(regione.textContent).toBe('')
    expect(container.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0)
  })

  it('l’avviso compare DENTRO la regione che c’era già: lo stesso nodo, non uno nuovo', async () => {
    const { container } = await finoAlTag(video())
    const prima = avvisi()
    fireEvent.click(pulsantePubblica())
    expect(await within(avvisi()).findByText(/stato inviato/)).toBeInTheDocument()
    // ⚠️ È QUESTO IL PUNTO: un elemento montato a condizione «entra nel DOM già pieno», e VoiceOver
    // spesso non lo annuncia. Lo stesso nodo che si riempie, sì.
    expect(container.querySelector('[data-testid="avvisi-invio"]')).toBe(prima)
  })

  it('l’esito dei video è onesto sul TUS e non promette «puoi chiudere l’app»', async () => {
    await finoAlTag(video())
    fireEvent.click(pulsantePubblica())
    const esito = await within(avvisi()).findByText(/stato inviato/)
    // Il trasferimento vive quanto la pagina Galleria (#133): «finché l'app è aperta» era la promessa falsa di prima.
    expect(esito.textContent).toMatch(/finché resti in Galleria/)
    expect(esito.textContent).toMatch(/riprende da solo/)
    expect(esito.textContent).not.toMatch(/app è aperta/)
    expect(esito.textContent).not.toMatch(/puoi chiudere/i)
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('con due video l’esito conta: «2 video sono stati inviati»', async () => {
    await finoAlTag(video('uno.mp4', 11_000_000), video('due.mp4', 22_000_000))
    fireEvent.click(pulsantePubblica())
    expect(await within(avvisi()).findByText(/2 video sono stati inviati/)).toBeInTheDocument()
    await waitFor(() => expect(h.accoda).toHaveBeenCalledTimes(2))
    expect(corpoApertura(0)!.destinatari).toEqual({ tagAlunni: [ADA.id], broadcast: false, classi: [] })
    expect(corpoApertura(1)!.destinatari).toEqual({ tagAlunni: [ADA.id], broadcast: false, classi: [] })
    expect(alertMock).not.toHaveBeenCalled()
  })

  it('premere «Carica» di nuovo svuota la regione: l’esito di ieri non resta accanto a quello di oggi', async () => {
    await finoAlTag(video())
    fireEvent.click(pulsantePubblica())
    await within(avvisi()).findByText(/stato inviato/)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }))
    await waitFor(() => expect(avvisi().textContent).toBe(''))
  })
})

describe('le schede raccontano ciò che il server sa, anche di un altro dispositivo', () => {
  it('un video che sta caricando un altro dispositivo si vede, senza nome, con la data', async () => {
    voci = [voce('da-caricare')]
    render(<TeacherGalleryPage />)
    expect(await screen.findByText(itServizi.galleryVideoFaseAltroDispositivo)).toBeInTheDocument()
    expect(screen.getByText(/^Video inviato il /)).toBeInTheDocument()
  })

  it('un video del flusso vecchio dice «va ricaricato», e «Togli» lo toglie e lo ricorda', async () => {
    voci = [voce('da-ricaricare')]
    const primo = render(<TeacherGalleryPage />)
    expect(await screen.findByText(itServizi.galleryVideoDaRicaricare)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoTogli }))
    await waitFor(() => expect(screen.queryByText(itServizi.galleryVideoDaRicaricare)).toBeNull())
    primo.unmount()

    // La persona riapre la galleria: il server lo riporta ancora, la scheda no.
    render(<TeacherGalleryPage />)
    await waitFor(() => expect(chiamate.filter((c) => c.url.startsWith('/api/video-uploads?')).length).toBeGreaterThan(1))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(itServizi.galleryVideoDaRicaricare)).toBeNull()
  })

  it('una pubblicazione fallita mostra il motivo e «Riprova», che fa il PATCH e non pubblica dal browser', async () => {
    voci = [voce('non-pubblicato', { riprovaPossibile: true })]
    render(<TeacherGalleryPage />)
    expect(await screen.findByText(itShared.erroreVideoPubblicazioneNonRiuscita)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoRiprova }))
    await waitFor(() => expect(patchFatti()).toEqual(['riprova-pubblicazione']))
    expect(chiamate.some((c) => c.url.includes('/api/gallery') && c.init?.method === 'POST')).toBe(false)
  })

  it('senza «riprovaPossibile» (nessuno dei bambini è più nella sede) il pulsante non c’è', async () => {
    voci = [voce('non-pubblicato', { codice: 'VIDEO_NESSUN_DESTINATARIO', riprovaPossibile: false })]
    render(<TeacherGalleryPage />)
    expect(await screen.findByText(itShared.erroreVideoNessunDestinatario)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itServizi.galleryVideoRiprova })).toBeNull()
    expect(screen.getByRole('button', { name: itServizi.galleryVideoTogli })).toBeInTheDocument()
  })

  it('un fallimento della conversione dice il suo motivo, in rosso, una volta sola', async () => {
    voci = [voce('fallito')]
    render(<TeacherGalleryPage />)
    const frase = await screen.findByText(itShared.erroreVideoTroppoLungo)
    expect(frase.className).toContain('text-kidville-error')
    expect(screen.getAllByText(itShared.erroreVideoTroppoLungo)).toHaveLength(1)
    expect(screen.queryByText('VIDEO_TROPPO_LUNGO')).toBeNull()
  })

  it('un ritentativo automatico si legge intero, e dice che non serve ricaricare', async () => {
    voci = [voce('in-riprova')]
    render(<TeacherGalleryPage />)
    expect(await screen.findByText(itServizi.galleryVideoRiprovaAutomatica)).toBeInTheDocument()
  })

  it('al rientro un caricamento a metà riprende da solo, senza che nessuno prema «Riprendi»', async () => {
    h.righeArchivio = [{
      jobId: uuid(101), intentId: uuid(201), canale: 'gallery', ownerId: DOCENTE, scuolaId: SEDE_A, chiaveIdempotenza: 'g-1',
      nome: 'sintetico.mp4', dimensioneByte: 1234, mime: 'video/mp4', stato: 'in_corso', offsetByte: 100, urlTus: null,
      coordinate: COORDINATE, codice: null, creatoIl: '2026-10-02T10:00:00.000Z', aggiornatoIl: '2026-10-02T10:00:00.000Z',
    }]
    voci = [voce('da-caricare')]
    render(<TeacherGalleryPage />)
    await waitFor(() => expect(h.carica).toHaveBeenCalledTimes(1))
    // Mai riaperto l'intento: la ripresa non crea niente.
    expect(aperture).toBe(0)
  })
})
