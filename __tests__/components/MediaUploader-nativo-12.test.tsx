import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'

/**
 * `MediaUploader` NELL'APP 1.2 (spec «app 1.2: caricamenti nativi in background» §7.2-§7.3, compito J2).
 *
 * ─── COSA CAMBIA, E COSA NO ──────────────────────────────────────────────────────────────────────
 * Tre ambienti, tre impaginati, e la rilevazione del plugin decide fra gli ultimi due:
 *
 *   · WEB                       → il riquadro «trascina o clicca» di sempre (nessuna rilevazione);
 *   · APP 1.0/1.1 (o 1.2 con l'interruttore spento) → il riquadro della PR 2, «Scatta una foto» secondario;
 *   · APP 1.2 COL PLUGIN        → due pulsanti principali («Scatta una foto», «Scegli foto e video dalla
 *                                  galleria») e il link «Scegli da File»; nessun riquadro.
 *
 * Finché la rilevazione non ha risposto (nell'app) l'area di scelta NON si disegna: niente sfarfallio fra i due
 * impaginati. E «Scatta una foto» apre la fotocamera DIRETTA su ogni binario nativo (chiude #194).
 *
 * ─── COME SONO FATTI I FINTI ─────────────────────────────────────────────────────────────────────
 * Il plugin non gira in jsdom: `@/lib/native/caricamenti-nativi` è finto SOLO nelle sue chiamate (rilevazione,
 * `scegliMedia`, `leggiFoto`, …), e tiene VERI `codiceDelPonte` e `ErroreCaricamentiNativi` — sono loro a
 * ridurre un rifiuto a un codice dell'elenco chiuso, ed è quello che finisce nei log. Ogni chiamata è una
 * promise che il test risolve a mano: «Preparo i file», «Annulla» e lo smontaggio nel mezzo di una scelta si
 * provano solo se la scelta può restare aperta.
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
  togliAscolto: vi.fn(),
  /** Il gestore degli avanzamenti che `MediaUploader` ha registrato (lo chiama il test). */
  avanzamento: null as null | ((e: { fatti: number; totali: number; byteCopiati: number; byteTotali: number | null }) => void),
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))
vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(() => true),
  scegliFotoNativa: vi.fn(),
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
// framer-motion → render diretto (deterministico in jsdom: niente animazioni di uscita)
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

import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'
import { ErroreCaricamentiNativi } from '@/lib/native/caricamenti-nativi'
import { opzioniScegliMedia } from '@/lib/native/caricamenti-nativi-tipi'
import { MediaUploader } from '@/components/features/gallery/MediaUploader'

const nativoMock = vi.mocked(fotocameraNativaDisponibile)
const scattoMock = vi.mocked(scegliFotoNativa)

interface RigaLog {
  livello: string
  evento: string
  messaggio: string
  campi?: Record<string, unknown>
}
const righe = (): RigaLog[] => h.logClient.mock.calls.map((c) => c[0] as RigaLog)
const messaggi = (): string[] => righe().map((r) => r.messaggio)
const quelle = (prefisso: string): RigaLog[] => righe().filter((r) => r.messaggio.startsWith(prefisso))

/** Una promise che si risolve (o si rifiuta) quando lo dice il test. */
function differita<T>() {
  let ok!: (v: T) => void
  let ko!: (e: unknown) => void
  const promessa = new Promise<T>((a, b) => { ok = a; ko = b })
  return { promessa, ok, ko }
}

const INFO_IOS = { protocollo: 1, piattaforma: 'ios', motore: 'urlsession' } as const
const SHA = 'a'.repeat(64)
const MINIATURA = 'data:image/jpeg;base64,/9j/AAAA'

/** I nomi di un bambino (immaginario): stanno a schermo e non devono finire in NESSUN log. */
const NOME_BAMBINO = 'Pinco Pallino recita di Natale'

const videoNativo = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `video-${n}`, tipo: 'video' as const, nome: `filmato-${n}.mov`, byte: 73_000_000, mime: 'video/quicktime',
  durataSecondi: 52, miniatura: MINIATURA, sha256: SHA, ...extra,
})
const fotoNativa = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `foto-${n}`, tipo: 'foto' as const, nome: `IMG_00${n}.HEIC`, larghezza: 1920, altezza: 1080, byte: 3, ...extra,
})
const rifiutato = (n: number, motivo: string, origine = 'video', extra: Record<string, unknown> = {}) => ({
  id: `rif-${n}`, tipo: 'rifiutato' as const, nome: `grande-${n}.mov`, origine, motivo, ...extra,
})
const FOTO_LETTA = { base64: 'AQID', mime: 'image/jpeg', byte: 3, larghezza: 1920, altezza: 1080 }

const asciuga = () => act(async () => { await Promise.resolve() })

/** Monta e lascia rispondere la rilevazione. `info` assente = nessun plugin (app 1.0/1.1). */
async function monta(info: unknown = INFO_IOS, onUpload = vi.fn()) {
  h.disponibili.mockResolvedValue(info)
  const v = render(<MediaUploader onUpload={onUpload} />)
  await asciuga()
  return { ...v, onUpload }
}

const tid = (id: string) => screen.queryByTestId(id)
const galleria = () => screen.getByTestId('gallery-selettore-galleria') as HTMLButtonElement
const daFile = () => screen.getByTestId('gallery-selettore-file') as HTMLButtonElement
const scatta = () => screen.getByTestId('gallery-selettore-scatta-foto') as HTMLButtonElement
const rimuovi = () => screen.queryAllByRole('button', { name: itShared.galleryRimuoviFile })
const inputDi = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement

/** Tocca «Scegli foto e video dalla galleria» e lascia partire la catena fino alla promise di `scegliMedia`. */
async function tocca(el: HTMLElement) {
  await act(async () => { fireEvent.click(el) })
}

/** Una scelta nativa che resta aperta finché il test non la chiude. */
function sceltaAperta() {
  const d = differita<unknown>()
  h.scegliMedia.mockReturnValue(d.promessa)
  return d
}

beforeEach(() => {
  vi.clearAllMocks()
  nativoMock.mockReturnValue(true)
  scattoMock.mockResolvedValue([])
  h.disponibili.mockResolvedValue(INFO_IOS)
  h.scegliMedia.mockResolvedValue({ annullato: true, elementi: [] })
  h.annullaScelta.mockResolvedValue({ annullata: true })
  h.scartaScelti.mockResolvedValue({ eliminati: 0 })
  h.leggiFoto.mockResolvedValue(FOTO_LETTA)
  h.togliAscolto.mockResolvedValue(undefined)
  h.avanzamento = null
  h.ascoltaPreparazione.mockImplementation(async (cb: typeof h.avanzamento) => {
    h.avanzamento = cb
    return h.togliAscolto
  })
  let n = 0
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => `blob:nativo-${++n}`), configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
})
afterEach(() => {
  vi.useRealTimers()
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * I TRE AMBIENTI, E LA PRESENZA E L'ASSENZA DI OGNI COMANDO
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('i tre ambienti: ogni comando c’è dove deve e NON c’è dove non deve', () => {
  const COMANDI = {
    riquadro: 'gallery-selettore-riquadro',
    scatta: 'gallery-selettore-scatta-foto',
    galleria: 'gallery-selettore-galleria',
    file: 'gallery-selettore-file',
    browser: 'gallery-selettore-browser',
  } as const

  /** Per ogni ambiente: quali comandi esistono. Sono ESATTAMENTE questi, e nessun altro. */
  const AMBIENTI: Array<[string, 'web' | 'senza-plugin' | 'con-plugin', Record<keyof typeof COMANDI, boolean>]> = [
    ['web', 'web', { riquadro: true, scatta: false, galleria: false, file: false, browser: false }],
    ['app 1.0/1.1 (il plugin non c’è)', 'senza-plugin', { riquadro: true, scatta: true, galleria: false, file: false, browser: false }],
    ['app 1.2 (il plugin c’è)', 'con-plugin', { riquadro: false, scatta: true, galleria: true, file: true, browser: false }],
  ]

  it.each(AMBIENTI)('%s', async (_nome, ambiente, attesi) => {
    nativoMock.mockReturnValue(ambiente !== 'web')
    await monta(ambiente === 'con-plugin' ? INFO_IOS : null)

    for (const [comando, testid] of Object.entries(COMANDI)) {
      const presente = tid(testid) !== null
      expect(presente, `${comando} (${testid}) in ${ambiente}: ${attesi[comando as keyof typeof COMANDI] ? 'manca' : 'NON doveva esserci'}`)
        .toBe(attesi[comando as keyof typeof COMANDI])
    }
    // I soli pulsanti dell'albero di accessibilità sono quelli attesi: l'`<input>` è nascosto, e nessun comando fantasma.
    const idPresenti = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))
    expect(idPresenti.sort()).toEqual(
      Object.entries(COMANDI).filter(([c]) => attesi[c as keyof typeof COMANDI]).map(([, id]) => id).sort(),
    )
  })

  it('sul web la rilevazione NON parte: non c’è niente da aspettare e l’area si disegna subito', () => {
    nativoMock.mockReturnValue(false)
    render(<MediaUploader onUpload={vi.fn()} />)
    // Sincrono, senza `await`: è proprio questo il punto.
    expect(screen.getByTestId('gallery-selettore-riquadro')).toBeInTheDocument()
    expect(h.disponibili).not.toHaveBeenCalled()
  })

  it('a interruttore spento la rilevazione risponde `null` e l’app 1.2 si comporta come la 1.1', async () => {
    await monta(null)
    expect(tid('gallery-selettore-riquadro')).toBeInTheDocument()
    expect(tid('gallery-selettore-galleria')).not.toBeInTheDocument()
    expect(screen.getByText(itShared.mediaScegliFotoVideo)).toBeInTheDocument()
  })

  it('FINCHÉ LA RILEVAZIONE NON HA RISPOSTO l’area di scelta non si disegna (niente sfarfallio), poi sì', async () => {
    const d = differita<unknown>()
    h.disponibili.mockReturnValue(d.promessa)
    render(<MediaUploader onUpload={vi.fn()} />)
    await asciuga()
    // Né l'uno né l'altro impaginato, e nessun comando: un riquadro che poi diventa due pulsanti è lo sfarfallio.
    for (const id of Object.values(COMANDI)) expect(tid(id), `${id} disegnato prima della risposta`).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toEqual([])
    // La regione viva del tetto, invece, c'è già: è sempre montata (#36).
    expect(screen.getByTestId('gallery-selettore-tetto')).toBeInTheDocument()

    await act(async () => { d.ok(INFO_IOS) })
    expect(tid('gallery-selettore-galleria')).toBeInTheDocument()
    expect(tid('gallery-selettore-riquadro')).not.toBeInTheDocument()
  })

  it('una rilevazione che RIFIUTA (non deve, per contratto) ripiega sull’impaginato della PR 2 e lo scrive nel log', async () => {
    h.disponibili.mockRejectedValue(new TypeError('boom: /percorso/privato/bambino.mov'))
    render(<MediaUploader onUpload={vi.fn()} />)
    await asciuga()
    expect(tid('gallery-selettore-riquadro'), 'schermata vuota: nessun ripiego').toBeInTheDocument()
    const [riga] = quelle('caricamenti-nativi-incompleti: errore-imprevisto')
    expect(riga).toMatchObject({ livello: 'error', evento: 'caricamento-nativo', campi: { error_code: 'TypeError' } })
    expect(JSON.stringify(h.logClient.mock.calls), 'il messaggio dell’errore non esce').not.toContain('bambino')
  })

  it('un comando in meno per ogni ambiente di prima: nell’app 1.2 il riquadro NON c’è e il nome accessibile dei pulsanti è il loro testo', async () => {
    await monta()
    expect(scatta()).toHaveAccessibleName(itShared.mediaScattaUnaFoto)
    expect(galleria()).toHaveAccessibleName('Scegli foto e video dalla galleria')
    expect(daFile()).toHaveAccessibleName('Scegli da File')
    // Il testo è il solo nome: l'icona è decorativa.
    expect(galleria().textContent).toBe(itShared.mediaScegliDallaGalleria)
    expect(daFile().textContent).toBe(itShared.mediaScegliDaFile)
  })

  it('è accessibile (axe) nell’app 1.2: nessun controllo annidato, nomi presenti', async () => {
    const { container } = await monta()
    const { axe } = await import('jest-axe')
    const risultato = await axe(container, {
      rules: { region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
    })
    expect(risultato.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * «SCATTA UNA FOTO»: LA FOTOCAMERA DIRETTA, SU OGNI BINARIO NATIVO (chiude #194)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('«Scatta una foto» apre la fotocamera DIRETTA, lato 1920, su ogni binario nativo', () => {
  it.each([
    ['app 1.0/1.1', null],
    ['app 1.2', INFO_IOS],
  ])('%s', async (_nome, info) => {
    scattoMock.mockResolvedValue([new File(['x'], 'foto-1.jpg', { type: 'image/jpeg' })])
    await monta(info)
    await tocca(scatta())
    await waitFor(() => expect(scattoMock).toHaveBeenCalledTimes(1))
    expect(scattoMock.mock.calls[0][0]).toMatchObject({ sorgente: 'fotocamera', latoMassimo: 1920, multiplo: true })
    expect(h.scegliMedia, 'la fotocamera non apre il selettore nativo').not.toHaveBeenCalled()
    // La foto scattata confluisce nelle anteprime come un file qualunque, e la riga di log è quella della fotocamera.
    expect(await screen.findByRole('button', { name: /1 file/i })).toBeInTheDocument()
    expect(messaggi()).toContain('gallery-selettore-aperto strada=fotocamera-nativa ambiente=app')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * LA SCELTA NATIVA: i due pulsanti, i limiti passati al plugin, le tre righe del selettore
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('«Scegli foto e video dalla galleria» e «Scegli da File» chiamano il plugin coi limiti di una fonte sola', () => {
  it('la galleria: `scegliMedia` con la sorgente giusta e il tetto dei 50 (i limiti vengono da `limiti.ts`, non da qui)', async () => {
    await monta()
    await tocca(galleria())
    await waitFor(() => expect(h.scegliMedia).toHaveBeenCalledTimes(1))
    expect(h.scegliMedia).toHaveBeenCalledWith(opzioniScegliMedia('galleria', 50))
    expect(h.scegliMedia.mock.calls[0][0]).toMatchObject({
      sorgente: 'galleria', massimoElementi: 50, latoMassimoFoto: 1920, qualitaFoto: 0.85,
      byteMassimiVideo: 2_000_000_000, durataMassimaVideoSecondi: 300,
    })
    expect(messaggi()[0]).toBe('gallery-selettore-aperto strada=selettore-nativo ambiente=app')
    expect(righe()[0]).toMatchObject({ livello: 'warn', evento: 'js' })
  })

  it('«Scegli da File»: la stessa chiamata con `sorgente: file`, e la strada `file-nativo` nel log', async () => {
    await monta()
    await tocca(daFile())
    await waitFor(() => expect(h.scegliMedia).toHaveBeenCalledTimes(1))
    expect(h.scegliMedia.mock.calls[0][0]).toMatchObject({ sorgente: 'file', massimoElementi: 50 })
    expect(messaggi()[0]).toBe('gallery-selettore-aperto strada=file-nativo ambiente=app')
  })

  it('i posti restano: con 20 già scelti il massimo passato al plugin è 30 (il tetto è sul TOTALE)', async () => {
    await monta()
    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: Array.from({ length: 20 }, (_, i) => videoNativo(i + 1)) })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(20))

    await tocca(daFile())
    await waitFor(() => expect(h.scegliMedia).toHaveBeenCalledTimes(2))
    expect(h.scegliMedia.mock.calls[1][0]).toMatchObject({ massimoElementi: 30 })
  })

  it('un secondo tocco mentre la scelta è in corso non apre una seconda scelta (e i comandi si spengono)', async () => {
    await monta()
    sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.scegliMedia).toHaveBeenCalledTimes(1))

    expect(galleria()).toBeDisabled()
    expect(daFile()).toBeDisabled()
    expect(scatta(), 'durante la preparazione nemmeno la fotocamera').toBeDisabled()
    fireEvent.click(galleria())
    fireEvent.click(daFile())
    await asciuga()
    expect(h.scegliMedia).toHaveBeenCalledTimes(1)
  })
})

describe('A ZERO POSTI i comandi si spengono e la frase del tetto dice perché', () => {
  async function conCinquanta() {
    const v = await monta()
    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: Array.from({ length: 50 }, (_, i) => videoNativo(i + 1)) })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(50))
    return v
  }

  it('con 50 scelti i tre comandi sono spenti, la frase del tetto è visibile e legata ai pulsanti', async () => {
    await conCinquanta()
    for (const comando of [scatta(), galleria(), daFile()]) {
      expect(comando).toBeDisabled()
      expect(comando.getAttribute('aria-describedby')).toBe(screen.getByTestId('gallery-selettore-tetto').id)
    }
    const tetto = screen.getByTestId('gallery-selettore-tetto')
    expect(tetto).toHaveTextContent(itShared.mediaErroreTroppiElementi.replace('{max}', '50'))
    expect(tetto.className).not.toContain('sr-only')
  })

  it('un clic su un pulsante spento non chiama il plugin (che rifiuterebbe un massimo sotto 1)', async () => {
    await conCinquanta()
    h.scegliMedia.mockClear()
    fireEvent.click(galleria())
    fireEvent.click(daFile())
    await asciuga()
    expect(h.scegliMedia).not.toHaveBeenCalled()
  })

  it('togliendo un’anteprima si libera un posto: i comandi si riaccendono e la frase sparisce', async () => {
    await conCinquanta()
    fireEvent.click(rimuovi()[0])
    await waitFor(() => expect(rimuovi()).toHaveLength(49))
    expect(galleria()).toBeEnabled()
    expect(daFile()).toBeEnabled()
    expect(scatta()).toBeEnabled()
    expect(screen.getByTestId('gallery-selettore-tetto')).toBeEmptyDOMElement()
    expect(galleria().getAttribute('aria-describedby')).toBeNull()
  })

  it('con 49 scelti il massimo passato è 1', async () => {
    await monta()
    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: Array.from({ length: 49 }, (_, i) => videoNativo(i + 1)) })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(49))
    await tocca(daFile())
    await waitFor(() => expect(h.scegliMedia).toHaveBeenCalledTimes(2))
    expect(h.scegliMedia.mock.calls[1][0]).toMatchObject({ massimoElementi: 1 })
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * LA PREPARAZIONE: «Preparo i file: N di M» e «Annulla»
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('la preparazione: avanzamento in una regione viva sempre montata, e «Annulla»', () => {
  it('la regione dell’avanzamento è SEMPRE montata (VoiceOver non annuncia una regione viva che entra già piena)', async () => {
    await monta()
    const prima = screen.getByTestId('gallery-selettore-preparazione')
    expect(prima).toHaveAttribute('role', 'status')
    expect(prima).toBeEmptyDOMElement()

    sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())
    act(() => { h.avanzamento?.({ fatti: 2, totali: 5, byteCopiati: 10, byteTotali: 50 }) })
    const dopo = screen.getByTestId('gallery-selettore-preparazione')
    expect(dopo, 'è lo STESSO nodo: cambia il testo, non il montaggio').toBe(prima)
    expect(dopo).toHaveTextContent('Preparo i file: 2 di 5')
  })

  it('l’avanzamento si aggiorna; per UN solo file dice solo che lo prepara (0 di 1 non informa)', async () => {
    await monta()
    sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())

    act(() => { h.avanzamento?.({ fatti: 0, totali: 5, byteCopiati: 0, byteTotali: null }) })
    expect(screen.getByTestId('gallery-selettore-preparazione')).toHaveTextContent('Preparo i file: 0 di 5')
    act(() => { h.avanzamento?.({ fatti: 4, totali: 5, byteCopiati: 9, byteTotali: null }) })
    expect(screen.getByTestId('gallery-selettore-preparazione')).toHaveTextContent('Preparo i file: 4 di 5')
    act(() => { h.avanzamento?.({ fatti: 0, totali: 1, byteCopiati: 0, byteTotali: null }) })
    expect(screen.getByTestId('gallery-selettore-preparazione')).toHaveTextContent('Preparo il file')
    expect(screen.getByTestId('gallery-selettore-preparazione').textContent).not.toMatch(/\d/)
  })

  it('un avanzamento con zero totali non fa comparire «Preparo i file: 0 di 0»', async () => {
    await monta()
    sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())
    act(() => { h.avanzamento?.({ fatti: 0, totali: 0, byteCopiati: 0, byteTotali: null }) })
    expect(screen.getByTestId('gallery-selettore-preparazione')).toBeEmptyDOMElement()
    expect(tid('gallery-selettore-annulla-preparazione')).not.toBeInTheDocument()
  })

  it('un avanzamento IN RITARDO, a scelta già finita, non fa ricomparire «Preparo i file» né «Annulla»', async () => {
    await monta()
    const d = sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())
    const ascoltatore = h.avanzamento as NonNullable<typeof h.avanzamento>
    act(() => { ascoltatore({ fatti: 1, totali: 4, byteCopiati: 1, byteTotali: 4 }) })
    expect(screen.getByTestId('gallery-selettore-preparazione')).toHaveTextContent('Preparo i file: 1 di 4')

    await act(async () => { d.ok({ annullato: true, elementi: [] }) })
    act(() => { ascoltatore({ fatti: 4, totali: 4, byteCopiati: 4, byteTotali: 4 }) })
    expect(screen.getByTestId('gallery-selettore-preparazione')).toBeEmptyDOMElement()
    expect(tid('gallery-selettore-annulla-preparazione')).not.toBeInTheDocument()
  })

  it('«Annulla» c’è SOLO durante la preparazione, FUORI dalla regione viva, e chiama `annullaScelta` una volta sola', async () => {
    await monta()
    expect(tid('gallery-selettore-annulla-preparazione'), 'prima della scelta').not.toBeInTheDocument()

    const d = sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())
    expect(tid('gallery-selettore-annulla-preparazione'), 'a selettore aperto, prima del primo avanzamento').not.toBeInTheDocument()

    act(() => { h.avanzamento?.({ fatti: 1, totali: 4, byteCopiati: 1, byteTotali: 4 }) })
    const annulla = screen.getByTestId('gallery-selettore-annulla-preparazione')
    expect(annulla).toHaveAccessibleName('Annulla')
    expect(screen.getByTestId('gallery-selettore-preparazione').contains(annulla), 'un comando dentro l’annuncio verrebbe riletto a ogni avanzamento').toBe(false)

    fireEvent.click(annulla)
    fireEvent.click(annulla)
    await asciuga()
    expect(h.annullaScelta).toHaveBeenCalledTimes(1)
    expect(annulla).toBeDisabled()

    // Il plugin risponde `annullato`: la preparazione sparisce da sola e i comandi tornano.
    await act(async () => { d.ok({ annullato: true, elementi: [] }) })
    expect(tid('gallery-selettore-annulla-preparazione')).not.toBeInTheDocument()
    expect(screen.getByTestId('gallery-selettore-preparazione')).toBeEmptyDOMElement()
    expect(galleria()).toBeEnabled()
    expect(rimuovi()).toHaveLength(0)
  })

  it('«Annulla» scrive «chiuso senza file motivo=annullato-nativo» (e non «file ricevuti»)', async () => {
    await monta()
    const d = sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())
    act(() => { h.avanzamento?.({ fatti: 1, totali: 4, byteCopiati: 1, byteTotali: 4 }) })
    fireEvent.click(screen.getByTestId('gallery-selettore-annulla-preparazione'))
    await act(async () => { d.ok({ annullato: true, elementi: [] }) })

    expect(messaggi()).toEqual([
      'gallery-selettore-aperto strada=selettore-nativo ambiente=app',
      expect.stringMatching(/^gallery-selettore-chiuso-senza-file motivo=annullato-nativo attesa=<1s$/),
    ])
    expect(quelle('gallery-selettore-file-ricevuti')).toEqual([])
  })

  it('il selettore di sistema chiuso senza scegliere vale lo stesso `annullato-nativo` (e «Scegli da File» pure)', async () => {
    await monta()
    h.scegliMedia.mockResolvedValue({ annullato: true, elementi: [] })
    await tocca(daFile())
    await waitFor(() => expect(quelle('gallery-selettore-chiuso-senza-file')).toHaveLength(1))
    expect(quelle('gallery-selettore-chiuso-senza-file')[0].messaggio).toMatch(/motivo=annullato-nativo/)
    expect(messaggi()[0]).toBe('gallery-selettore-aperto strada=file-nativo ambiente=app')
  })

  it('l’ascolto dell’avanzamento si toglie a scelta finita, e se NON si riesce ad agganciarlo la scelta va avanti (con un log)', async () => {
    await monta()
    await tocca(galleria())
    await waitFor(() => expect(h.togliAscolto).toHaveBeenCalledTimes(1))

    h.ascoltaPreparazione.mockRejectedValueOnce(new ErroreCaricamentiNativi('NON_DISPONIBILE'))
    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: [videoNativo(1)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))
    expect(quelle('selettore-nativo-ascolto-fallito')).toHaveLength(1)
    expect(quelle('selettore-nativo-ascolto-fallito')[0]).toMatchObject({
      livello: 'warn', evento: 'caricamento-nativo', messaggio: 'selettore-nativo-ascolto-fallito: NON_DISPONIBILE',
    })
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * IL RISULTATO: video nativi, foto lette una alla volta, rifiutati, tetto sul totale
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('l’esito di una scelta: video come anteprime native, foto come `File` JPEG, rifiutati in linea', () => {
  it('un VIDEO diventa un’anteprima nativa: miniatura, nome, durata e peso (e nessun <video>)', async () => {
    const { container } = await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))

    // La miniatura è un <img> con la data URL del plugin; nessun <video>: i byte non sono in JavaScript.
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(MINIATURA)
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByText('filmato-1.mov')).toBeInTheDocument()
    expect(screen.getByTestId('gallery-anteprima-dati')).toHaveTextContent('0:52 · 70 MB')
    // La pastiglia «Video» con la sua parola, come per ogni filmato.
    expect(within(container).getByText(itShared.galleryVideo)).toBeInTheDocument()
    // Il video non passa dalle foto: `leggiFoto` non si chiama.
    expect(h.leggiFoto).not.toHaveBeenCalled()
  })

  it('durata sconosciuta (`null`) e miniatura assente: si omette la durata e il riquadro neutro sostituisce l’immagine rotta', async () => {
    const { container } = await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1, { durataSecondi: null, miniatura: null })] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))
    expect(screen.getByTestId('gallery-anteprima-dati').textContent).toBe('70 MB')
    expect(container.querySelector('img'), 'un <img> senza sorgente è il glifo del file rotto').toBeNull()
  })

  it('le FOTO si leggono UNA ALLA VOLTA (`leggiFoto` consegna e cancella) e diventano `File` JPEG con il nome <nome>.jpg', async () => {
    const { onUpload } = await monta()
    let inVolo = 0
    let massimoInVolo = 0
    h.leggiFoto.mockImplementation(async () => {
      inVolo++
      massimoInVolo = Math.max(massimoInVolo, inVolo)
      await Promise.resolve()
      inVolo--
      return FOTO_LETTA
    })
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [fotoNativa(1), fotoNativa(2), fotoNativa(3)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(3))

    expect(h.leggiFoto.mock.calls.map((c) => c[0])).toEqual([{ id: 'foto-1' }, { id: 'foto-2' }, { id: 'foto-3' }])
    expect(massimoInVolo, 'due foto in base64 insieme').toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /3 file/i }))
    const consegnati = onUpload.mock.calls[0][0] as Array<{ file: File | null; nativo?: unknown; preview: string }>
    expect(consegnati.map((c) => c.file?.name)).toEqual(['IMG_001.jpg', 'IMG_002.jpg', 'IMG_003.jpg'])
    expect(consegnati.every((c) => c.file instanceof File && c.file.type === 'image/jpeg' && c.nativo === undefined)).toBe(true)
    // I byte sono quelli del base64 (AQID = 1, 2, 3), non un segnaposto.
    const byte = new Uint8Array(await (consegnati[0].file as File).arrayBuffer())
    expect(Array.from(byte)).toEqual([1, 2, 3])
  })

  it('l’elemento consegnato al passo dei bambini ha la forma dell’unione: un `File` oppure `{ file: null, nativo }`', async () => {
    const { onUpload } = await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1), fotoNativa(1)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: /2 file/i }))

    const consegnati = onUpload.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(consegnati).toHaveLength(2)
    const nativo = consegnati.find((c) => c.file === null) as { file: null; preview: string; nativo: Record<string, unknown> }
    const file = consegnati.find((c) => c.file instanceof File) as { file: File; nativo?: undefined }
    expect(nativo.preview).toBe(MINIATURA)
    expect(nativo.nativo).toMatchObject({ id: 'video-1', tipo: 'video', sha256: SHA, byte: 73_000_000, durataSecondi: 52 })
    expect(file.nativo).toBeUndefined()
  })

  it('i RIFIUTATI danno un avviso in linea: il conteggio (plurale) e, per ognuno, il NOME e il suo motivo', async () => {
    await monta()
    h.scegliMedia.mockResolvedValue({
      annullato: false,
      elementi: [
        videoNativo(1),
        rifiutato(1, 'troppo-grande', 'video', { nome: 'enorme.mov' }),
        rifiutato(2, 'troppo-lungo', 'video', { nome: 'lungo.mov' }),
        rifiutato(3, 'icloud-non-disponibile', 'video', { nome: 'nuvola.mov' }),
      ],
    })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))

    const avviso = screen.getByTestId('gallery-selettore-rifiutati')
    expect(avviso).toHaveAttribute('role', 'status')
    expect(avviso).toHaveTextContent('3 elementi non sono stati aggiunti')
    const voci = within(avviso).getAllByRole('listitem').map((li) => li.textContent)
    expect(voci).toEqual([
      'enorme.mov: supera i 2 GB',
      'lungo.mov: dura più di 5 minuti',
      'nuvola.mov: non si riesce a scaricarlo da iCloud adesso',
    ])
  })

  it('un SOLO rifiutato usa il singolare, e ognuno dei sei motivi ha la sua frase', async () => {
    await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [rifiutato(1, 'illeggibile', 'video', { nome: 'rotto.mov' })] })
    await tocca(galleria())
    await waitFor(() => expect(screen.getByTestId('gallery-selettore-rifiutati')).toHaveTextContent('Un elemento non è stato aggiunto'))
    expect(within(screen.getByTestId('gallery-selettore-rifiutati')).getByRole('listitem')).toHaveTextContent('rotto.mov: non si riesce a leggere')

    const sei = ['troppo-grande', 'troppo-lungo', 'formato-non-supportato', 'illeggibile', 'spazio-insufficiente', 'icloud-non-disponibile']
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: sei.map((m, i) => rifiutato(i + 10, m, 'altro', { nome: `f-${i}.bin` })) })
    await tocca(galleria())
    await waitFor(() => expect(screen.getByTestId('gallery-selettore-rifiutati')).toHaveTextContent('6 elementi'))
    const testi = within(screen.getByTestId('gallery-selettore-rifiutati')).getAllByRole('listitem').map((li) => li.textContent)
    expect(new Set(testi).size, 'due motivi con la stessa frase').toBe(6)
    expect(testi.join('|')).toContain('formato non supportato')
    expect(testi.join('|')).toContain('non c’è abbastanza spazio sul telefono')
  })

  it('il log dei rifiutati porta UN NUMERO PER MOTIVO (snake_case) e nessun nome', async () => {
    await monta()
    h.scegliMedia.mockResolvedValue({
      annullato: false,
      elementi: [
        rifiutato(1, 'troppo-grande', 'video', { nome: `${NOME_BAMBINO}.mov` }),
        rifiutato(2, 'troppo-grande', 'video'),
        rifiutato(3, 'formato-non-supportato', 'foto', { nome: `${NOME_BAMBINO}.png` }),
        videoNativo(1),
      ],
    })
    await tocca(galleria())
    await waitFor(() => expect(quelle('selettore-nativo-rifiutati')).toHaveLength(1))
    expect(quelle('selettore-nativo-rifiutati')[0]).toEqual({
      livello: 'warn', evento: 'caricamento-nativo', messaggio: 'selettore-nativo-rifiutati',
      campi: {
        troppo_grande: 2, troppo_lungo: 0, formato_non_supportato: 1, illeggibile: 0, spazio_insufficiente: 0, icloud_non_disponibile: 0,
      },
    })
  })

  it('la riga dei file ricevuti conta ciò che il plugin ha CONSEGNATO (rifiutati compresi) e usa la stessa forma di sempre', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
    await monta()
    h.scegliMedia.mockImplementation(async () => {
      vi.advanceTimersByTime(7_000)
      return { annullato: false, elementi: [videoNativo(1), fotoNativa(1), rifiutato(1, 'troppo-grande', 'video')] }
    })
    await tocca(galleria())
    await asciuga()
    await asciuga()

    const [riga] = quelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toBe('gallery-selettore-file-ricevuti mime=misto attesa=5-30s tardivo=no')
    expect(riga).toMatchObject({ livello: 'warn', evento: 'js' })
    // n = 3 consegnati; il video e il rifiutato (origine video) sono 2 video, la foto 1; i byte sono quelli degli ACCETTATI.
    expect(riga.campi).toEqual({ n: 3, n_video: 2, n_foto: 1, byte_totali: 73_000_003, ms_da_apertura: 7_000 })
  })
})

describe('il tetto dei 50 vale sul TOTALE scelto, e ciò che sta fuori si scarta dal telefono', () => {
  it('60 elementi (40 video + 20 foto): ne entrano 50, gli ultimi 10 si SCARTANO e le foto fuori tetto non si leggono', async () => {
    await monta()
    const video = Array.from({ length: 40 }, (_, i) => videoNativo(i + 1))
    const foto = Array.from({ length: 20 }, (_, i) => fotoNativa(i + 1))
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [...video, ...foto] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(50))

    // I 40 video e le prime 10 foto: i PRIMI nell'ordine in cui il selettore li ha consegnati.
    expect(h.leggiFoto).toHaveBeenCalledTimes(10)
    expect(h.leggiFoto.mock.calls.at(-1)?.[0]).toEqual({ id: 'foto-10' })
    // Le 10 foto in più NON si leggono (leggere = cancellare) ma si scartano esplicitamente.
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: Array.from({ length: 10 }, (_, i) => `foto-${i + 11}`) })

    expect(screen.getByTestId('gallery-selettore-tetto')).toHaveTextContent(itShared.mediaErroreTroppiElementi.replace('{max}', '50'))
    const [riga] = quelle('gallery-selezione-oltre-il-massimo')
    expect(riga).toMatchObject({ livello: 'warn', evento: 'js', campi: { scelti: 60, aggiunti: 50, massimo: 50 } })
  })

  it('con 30 già scelti, una scelta di 30 video ne tiene 20 e scarta 10 (30 + 30 non aggira il tetto)', async () => {
    await monta()
    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: Array.from({ length: 30 }, (_, i) => videoNativo(i + 1)) })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(30))

    h.scegliMedia.mockResolvedValueOnce({ annullato: false, elementi: Array.from({ length: 30 }, (_, i) => videoNativo(i + 101)) })
    await tocca(daFile())
    await waitFor(() => expect(rimuovi()).toHaveLength(50))
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: Array.from({ length: 10 }, (_, i) => `video-${i + 121}`) })
    expect(quelle('gallery-selezione-oltre-il-massimo')[0].campi).toEqual({ scelti: 30, aggiunti: 20, massimo: 50 })
  })

  it('i rifiutati NON contano per il tetto: 50 accettati + 5 rifiutati entrano tutti i 50', async () => {
    await monta()
    h.scegliMedia.mockResolvedValue({
      annullato: false,
      elementi: [...Array.from({ length: 50 }, (_, i) => videoNativo(i + 1)), ...Array.from({ length: 5 }, (_, i) => rifiutato(i + 1, 'troppo-grande'))],
    })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(50))
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(quelle('gallery-selezione-oltre-il-massimo')).toEqual([])
    expect(screen.getByTestId('gallery-selettore-rifiutati')).toHaveTextContent('5 elementi non sono stati aggiunti')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `scartaScelti`: sulla X, allo smontaggio, e MAI su ciò che è stato consegnato alla pagina
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('i preparati che nessuno porterà avanti si cancellano dal telefono', () => {
  it('la X su un video NATIVO chiama `scartaScelti` con il suo id; la X su una foto no (è già stata letta e cancellata)', async () => {
    await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1), fotoNativa(1)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(2))

    // Prima: la tessera della foto (la seconda, perché i video entrano prima delle foto).
    fireEvent.click(rimuovi()[1])
    await waitFor(() => expect(rimuovi()).toHaveLength(1))
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL, 'la foto ha un objectURL da revocare').toHaveBeenCalledTimes(1)

    fireEvent.click(rimuovi()[0])
    await waitFor(() => expect(rimuovi()).toHaveLength(0))
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1'] })
    expect(URL.revokeObjectURL, 'un video nativo non ha objectURL: la miniatura è un data URL').toHaveBeenCalledTimes(1)
  })

  it('lo SMONTAGGIO prima di «continua» scarta i video nativi che la pagina non ha ricevuto (e non le foto)', async () => {
    const { unmount } = await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1), videoNativo(2), fotoNativa(1)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(3))
    expect(h.scartaScelti).not.toHaveBeenCalled()

    unmount()
    await asciuga()
    expect(h.scartaScelti).toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1', 'video-2'] })
  })

  it('DOPO «continua» lo smontaggio NON scarta niente: da lì i video nativi sono della pagina', async () => {
    const { unmount, onUpload } = await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /1 file/i }))
    expect(onUpload).toHaveBeenCalledTimes(1)

    unmount()
    await asciuga()
    expect(h.scartaScelti, 'scartare qui cancellerebbe il video che la pagina sta per spedire').not.toHaveBeenCalled()
  })

  it('senza video nativi lo smontaggio non chiama il plugin (e sul web nemmeno)', async () => {
    const { unmount } = await monta()
    unmount()
    await asciuga()
    expect(h.scartaScelti).not.toHaveBeenCalled()
    expect(h.annullaScelta).not.toHaveBeenCalled()
  })

  it('lo smontaggio NEL MEZZO della preparazione ferma il plugin; ciò che arriva comunque a componente morto si scarta', async () => {
    const { unmount } = await monta()
    const d = sceltaAperta()
    await tocca(galleria())
    await waitFor(() => expect(h.avanzamento).not.toBeNull())
    act(() => { h.avanzamento?.({ fatti: 1, totali: 3, byteCopiati: 1, byteTotali: 3 }) })

    unmount()
    await asciuga()
    expect(h.annullaScelta, 'la preparazione non si lascia andare avanti').toHaveBeenCalledTimes(1)

    // Il plugin consegna lo stesso (una gara): i video e le foto preparati non li vedrà nessuno → si scartano, foto
    // comprese (leggerle vorrebbe dire cancellarle senza averne fatto niente).
    await act(async () => { d.ok({ annullato: false, elementi: [videoNativo(1), fotoNativa(1), rifiutato(1, 'troppo-grande')] }) })
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['video-1', 'foto-1'] })
    expect(h.leggiFoto, 'a componente morto una foto non si legge').not.toHaveBeenCalled()
    expect(quelle('gallery-selettore-file-ricevuti'), 'nessuna riga a componente morto').toEqual([])
  })

  it('lo smontaggio mentre si leggono le foto lascia indietro le non lette e le scarta', async () => {
    const { unmount } = await monta()
    const prima = differita<typeof FOTO_LETTA>()
    h.leggiFoto.mockReturnValueOnce(prima.promessa).mockResolvedValue(FOTO_LETTA)
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [fotoNativa(1), fotoNativa(2), fotoNativa(3)] })
    await tocca(galleria())
    await waitFor(() => expect(h.leggiFoto).toHaveBeenCalledTimes(1))

    unmount()
    await act(async () => { prima.ok(FOTO_LETTA) })
    await asciuga()
    expect(h.leggiFoto, 'la seconda e la terza foto non si leggono più').toHaveBeenCalledTimes(1)
    expect(h.scartaScelti).toHaveBeenCalledWith({ ids: ['foto-2', 'foto-3'] })
  })

  it('un `scartaScelti` che il plugin rifiuta non rompe niente: `warn` con il CODICE, mai un id né un nome', async () => {
    const { unmount } = await monta()
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [videoNativo(1, { nome: `${NOME_BAMBINO}.mov` })] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))
    h.scartaScelti.mockRejectedValue(new ErroreCaricamentiNativi('INTERNO'))

    fireEvent.click(rimuovi()[0])
    await asciuga()
    unmount()
    expect(quelle('selettore-nativo-scarto-fallito')[0]).toMatchObject({
      livello: 'warn', evento: 'caricamento-nativo', messaggio: 'selettore-nativo-scarto-fallito: INTERNO',
    })
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('video-1')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Pinco')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * GLI ERRORI: il selettore che non si apre, la foto che non si legge, il ripiego del browser
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('quando il selettore nativo fallisce: messaggio, ripiego sul browser, nessun log mentitore', () => {
  it('`scegliMedia` rifiutato: avviso, log d’errore col CODICE (mai il messaggio) e il link «Usa il selettore del browser»', async () => {
    await monta()
    expect(tid('gallery-selettore-browser'), 'il ripiego compare SOLO dopo un errore').not.toBeInTheDocument()

    h.scegliMedia.mockRejectedValue(Object.assign(new Error('/var/mobile/Media/DCIM/IMG_pinco-pallino.MOV non apribile'), { code: 'SELETTORE_NON_DISPONIBILE' }))
    await tocca(galleria())
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    expect(screen.getByRole('alert')).toHaveTextContent(itShared.mediaErroreSelettoreNativo)
    expect(screen.getByTestId('gallery-selettore-browser')).toHaveAccessibleName('Usa il selettore del browser')
    const [riga] = quelle('selettore-nativo-errore')
    expect(riga).toMatchObject({ livello: 'error', evento: 'caricamento-nativo', messaggio: 'selettore-nativo-errore: SELETTORE_NON_DISPONIBILE' })
    expect(typeof (riga.campi as { ms: number }).ms).toBe('number')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toMatch(/pinco|DCIM|mobile/i)
    // Non è «chiuso senza file»: ha il suo log d'errore, e dichiararlo annullato falserebbe il conteggio.
    expect(quelle('gallery-selettore-chiuso-senza-file')).toEqual([])
    // I comandi tornano premibili: si può riprovare.
    expect(galleria()).toBeEnabled()
  })

  it('un rifiuto che non è del ponte (un’eccezione qualunque) vale `SCONOSCIUTO`, e il messaggio non esce', async () => {
    await monta()
    h.scegliMedia.mockRejectedValue(new Error('IMG_privata.MOV'))
    await tocca(daFile())
    await waitFor(() => expect(quelle('selettore-nativo-errore')).toHaveLength(1))
    expect(quelle('selettore-nativo-errore')[0].messaggio).toBe('selettore-nativo-errore: SCONOSCIUTO')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('privata')
  })

  it('«Usa il selettore del browser» apre l’<input> (quei file vanno in TUS), con la sua riga di log, e poi sparisce', async () => {
    const { container } = await monta()
    h.scegliMedia.mockRejectedValue(new ErroreCaricamentiNativi('INTERNO'))
    await tocca(galleria())
    await waitFor(() => expect(tid('gallery-selettore-browser')).toBeInTheDocument())

    const clickInput = vi.spyOn(inputDi(container), 'click')
    fireEvent.click(screen.getByTestId('gallery-selettore-browser'))
    expect(clickInput).toHaveBeenCalledTimes(1)
    expect(messaggi()).toContain('gallery-selettore-aperto strada=selettore-file ambiente=app')
    expect(tid('gallery-selettore-browser')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // I file del browser sono `File`: entrano come sempre, senza toccare il plugin.
    fireEvent.change(inputDi(container), { target: { files: [new File(['x'], 'dal-browser.jpg', { type: 'image/jpeg' })] } })
    expect(await screen.findByRole('button', { name: /1 file/i })).toBeInTheDocument()
    expect(h.leggiFoto).not.toHaveBeenCalled()
  })

  it('una foto che NON si legge: log d’errore col codice, avviso del formato, e le altre foto restano', async () => {
    await monta()
    h.leggiFoto
      .mockRejectedValueOnce(new ErroreCaricamentiNativi('ELEMENTO_ASSENTE'))
      .mockResolvedValue(FOTO_LETTA)
    h.scegliMedia.mockResolvedValue({ annullato: false, elementi: [fotoNativa(1, { nome: `${NOME_BAMBINO}.HEIC` }), fotoNativa(2)] })
    await tocca(galleria())
    await waitFor(() => expect(rimuovi()).toHaveLength(1))

    expect(screen.getByRole('alert')).toHaveTextContent(itShared.mediaErroreFormato)
    const [riga] = quelle('foto-nativa-non-letta')
    expect(riga).toEqual({ livello: 'error', evento: 'caricamento-nativo', messaggio: 'foto-nativa-non-letta: ELEMENTO_ASSENTE' })
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Pinco')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * MAI il nome del file, un id, un hash o un percorso: dal componente vero non esce in nessun log
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('MAI il nome del file nei log: dalla scelta nativa vera non esce niente di personale', () => {
  it('video, foto, rifiutati, tetto, errore del selettore e scarto: nessun log contiene nomi, id, hash o miniature', async () => {
    const { container, unmount } = await monta()
    const nomi = (n: number, est: string) => `${NOME_BAMBINO} ${n}.${est}`

    // Una scelta ricca: 49 video + 3 foto (la prima non si legge) + 2 rifiutati → tetto, rifiutati, foto non letta.
    h.leggiFoto.mockRejectedValueOnce(new ErroreCaricamentiNativi('ELEMENTO_ASSENTE')).mockResolvedValue(FOTO_LETTA)
    h.scegliMedia.mockResolvedValueOnce({
      annullato: false,
      elementi: [
        ...Array.from({ length: 49 }, (_, i) => videoNativo(i + 1, { nome: nomi(i, 'mov') })),
        fotoNativa(1, { nome: nomi(100, 'HEIC') }), fotoNativa(2, { nome: nomi(101, 'HEIC') }), fotoNativa(3, { nome: nomi(102, 'HEIC') }),
        rifiutato(1, 'troppo-grande', 'video', { nome: nomi(200, 'mov') }), rifiutato(2, 'illeggibile', 'foto', { nome: nomi(201, 'png') }),
      ],
    })
    await tocca(galleria())
    // 49 video e la prima foto dentro il tetto (50): la foto non si legge, quindi le anteprime sono 49.
    await waitFor(() => expect(quelle('foto-nativa-non-letta')).toHaveLength(1))
    await waitFor(() => expect(rimuovi()).toHaveLength(49))

    // Un errore del selettore e uno scarto, per completare il giro.
    h.scegliMedia.mockRejectedValueOnce(Object.assign(new Error(`${NOME_BAMBINO}.mov`), { code: 'INTERNO' }))
    fireEvent.click(rimuovi()[0])
    await waitFor(() => expect(rimuovi()).toHaveLength(48))
    await tocca(daFile())
    await waitFor(() => expect(quelle('selettore-nativo-errore')).toHaveLength(1))
    unmount()
    await asciuga()
    void container

    // Tutti i percorsi sono stati scritti davvero (altrimenti il test sarebbe verde su un log muto).
    for (const prefisso of [
      'gallery-selettore-aperto', 'gallery-selettore-file-ricevuti', 'gallery-selezione-oltre-il-massimo',
      'selettore-nativo-rifiutati', 'foto-nativa-non-letta', 'selettore-nativo-errore',
    ]) expect(quelle(prefisso).length, `la riga «${prefisso}» non è stata scritta`).toBeGreaterThan(0)

    const tutto = JSON.stringify(h.logClient.mock.calls)
    for (const pezzo of [NOME_BAMBINO, 'Pinco', 'Pallino', 'Natale', '.mov', '.HEIC', '.png', SHA, 'video-1', 'foto-1', 'rif-1', MINIATURA, 'base64']) {
      expect(tutto, `«${pezzo}» è finito in un log`).not.toContain(pezzo)
    }
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * L'<input> DEL BROWSER STA SEMPRE NEL DOCUMENTO (altrimenti `cancel` non si aggancia mai)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('l’<input> del browser è montato anche prima che la rilevazione risponda', () => {
  it('con la rilevazione che risponde DOPO il montaggio, l’evento `cancel` dell’input scrive comunque la sua riga', async () => {
    // `useTracciaSelettore` aggancia `cancel` UNA volta, al montaggio: se l'input stesse dentro l'area di scelta, che
    // si disegna solo a rilevazione finita, in quel momento non ci sarebbe e la riga `motivo=cancel` non uscirebbe mai.
    const d = differita<unknown>()
    h.disponibili.mockReturnValue(d.promessa)
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    await asciuga()
    expect(inputDi(container), 'l’input deve esserci già, a rilevazione aperta').toBeTruthy()
    await act(async () => { d.ok(null) })

    // Impaginato della PR 2: il riquadro apre l'input; poi l'utente chiude il selettore senza scegliere.
    fireEvent.click(screen.getByTestId('gallery-selettore-riquadro'))
    fireEvent(inputDi(container), new Event('cancel'))
    expect(quelle('gallery-selettore-chiuso-senza-file')).toHaveLength(1)
    expect(quelle('gallery-selettore-chiuso-senza-file')[0].messaggio).toMatch(/^gallery-selettore-chiuso-senza-file motivo=cancel /)
  })

  it('nell’app 1.2 l’input non è dentro nessun pulsante: nessun controllo annidato', async () => {
    const { container } = await monta()
    const input = inputDi(container)
    expect(input.closest('button, [role="button"]')).toBeNull()
    expect(input.hidden).toBe(true)
  })
})
