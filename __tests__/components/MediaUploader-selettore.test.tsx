import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

/**
 * IL RIQUADRO GRANDE DELLA GALLERIA — nell'app apre foto E video, la fotocamera è «Scatta una foto»,
 * e ogni apertura lascia le sue righe di log (spec video PR 2 §11.1, richiesta del titolare 02/10).
 *
 * ─── IL FATTO ────────────────────────────────────────────────────────────────
 * Dall'iPhone, nell'app: «Scegli file dal dispositivo» → Libreria foto → un video da 73 MB. Non è mai
 * arrivato alla pagina: nessuna miniatura, nessun errore, nessun log. Il riquadro grande apriva la
 * FOTOCAMERA nativa (che mostra solo foto, una alla volta) e i video stavano dietro un link piccolo.
 *
 * ─── COSA PROVA QUESTO FILE ──────────────────────────────────────────────────
 *  · il riquadro, nell'app: apre l'`<input>` (non la fotocamera) e parla di scegliere foto e video;
 *  · «Scatta una foto»: apre la fotocamera, ha un nome accessibile, e sostituisce il vecchio link;
 *  · sul web non cambia niente: il riquadro apre l'input, niente pulsante della fotocamera;
 *  · le tre righe di log, DAL COMPONENTE VERO (aperto, file ricevuti, chiuso senza file): la macchina a stati
 *    sta in `__tests__/lib/selettore-media.test.ts`, qui si prova che i gesti veri la guidino
 *    (click, `change`, `cancel`, ritorno della pagina, smontaggio);
 *  · il tetto dei 50 con l'avviso in linea — sempre montato, per VoiceOver — e il suo log di soli conteggi;
 *  · che dai log non esca MAI il nome di un file;
 *  · (T11c, secondario #150) il riquadro grande è un VERO comando: `role="button"`, `tabIndex`, Invio e
 *    Spazio, nome accessibile, e nessun controllo annidato per axe;
 *  · (T11c, secondario #145) il ritorno in primo piano parte SOLO dal ritorno vero: con `setInterval` finto e
 *    sessanta secondi di orologio, senza eventi di visibilità, resta la sola riga «aperto».
 *
 * Ogni caso è stato visto ROSSO rompendo il codice che prova: le mutazioni sono nei rapporti di T11b e T11c.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(() => true),
  scegliFotoNativa: vi.fn(),
}))

import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'
import { MediaUploader } from '@/components/features/gallery/MediaUploader'

const nativoMock = vi.mocked(fotocameraNativaDisponibile)
const scegliMock = vi.mocked(scegliFotoNativa)

interface RigaLog {
  livello: string
  evento: string
  messaggio: string
  campi?: Record<string, unknown>
}
const righe = (): RigaLog[] => h.logClient.mock.calls.map((c) => c[0] as RigaLog)
const messaggi = (): string[] => righe().map((r) => r.messaggio)
const quelle = (prefisso: string): RigaLog[] => righe().filter((r) => r.messaggio.startsWith(prefisso))

const NOME_BAMBINO = 'Pinco Pallino recita di Natale'

/**
 * I testi col tetto, dal CATALOGO e con il 50 al posto del segnaposto: se il componente passasse un altro
 * numero (o nessuno) il confronto cadrebbe. Il lock dei cataloghi vieta «{max} parola» fuori da un blocco
 * plural, per questo i due testi hanno il numero in fondo alla frase.
 */
const DETTAGLIO_CON_50 = itShared.mediaScegliFotoVideoDettaglio.replace('{max}', '50')
const AVVISO_CON_50 = itShared.mediaErroreTroppiElementi.replace('{max}', '50')

function video(nome = 'filmato.mov', byte = 73_000_000): File {
  const f = new File(['x'], nome, { type: 'video/quicktime' })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}
const foto = (nome = 'foto.jpg') => new File(['x'], nome, { type: 'image/jpeg' })

/** Mette i file nell'`<input>`: è la strada che fa il selettore del sistema. */
function consegna(container: HTMLElement, ...files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files } })
}

const riquadro = () => screen.getByTestId('gallery-selettore-riquadro')
const inputDi = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement

/** Lascia finire `addFiles` (asincrona): le anteprime compaiono dopo un giro di microtask. */
const asciuga = () => act(async () => { await Promise.resolve() })

/** La pagina se ne va e torna: lo stesso evento che manda un iPhone quando si cambia app. */
function paginaVaViaETorna() {
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  nativoMock.mockReturnValue(true)
  scegliMock.mockResolvedValue([])
  let n = 0
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => `blob:selettore-${++n}`), configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
})
afterEach(() => {
  vi.useRealTimers()
  // Ripristina il getter vero di `document.hidden` (il test lo ha ridefinito sull'istanza).
  delete (document as unknown as { hidden?: boolean }).hidden
})

describe('nell’app: il riquadro grande apre il selettore di FOTO E VIDEO, non la fotocamera', () => {
  it('parla di scegliere foto e video (non di trascinare) e dice il tetto dei 50', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    expect(screen.getByText(itShared.mediaScegliFotoVideo)).toBeInTheDocument()
    expect(screen.getByText(DETTAGLIO_CON_50)).toBeInTheDocument()
    expect(screen.queryByText(itShared.mediaTrascinaFotoVideo), 'nell’app non si trascina').not.toBeInTheDocument()
    expect(screen.queryByText(itShared.mediaOppureClicca)).not.toBeInTheDocument()
  })

  it('il click sul riquadro clicca l’<input> (accept image+video) e NON apre la fotocamera', () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    const input = inputDi(container)
    expect(input.accept).toBe('image/*,video/*')
    expect(input.multiple).toBe(true)
    const clickInput = vi.spyOn(input, 'click')

    fireEvent.click(riquadro())

    expect(clickInput).toHaveBeenCalledTimes(1)
    expect(scegliMock, 'il riquadro grande non deve più aprire la fotocamera nativa').not.toHaveBeenCalled()
  })

  it('«Scatta una foto» è un pulsante con nome accessibile, e apre la fotocamera (non l’input)', async () => {
    scegliMock.mockResolvedValue([foto('foto-1.jpg')])
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    const clickInput = vi.spyOn(inputDi(container), 'click')

    const scatta = screen.getByRole('button', { name: itShared.mediaScattaUnaFoto })
    expect(scatta).toHaveAccessibleName('Scatta una foto')
    expect(scatta.getAttribute('data-testid')).toBe('gallery-selettore-scatta-foto')
    // Il nome è il solo testo: l'icona è decorativa e non porta niente (né un `<title>`, né testo).
    expect(scatta.textContent).toBe('Scatta una foto')

    fireEvent.click(scatta)
    await waitFor(() => expect(scegliMock).toHaveBeenCalledTimes(1))
    expect(scegliMock).toHaveBeenCalledWith(expect.objectContaining({
      multiplo: true,
      etichette: expect.objectContaining({ scatta: 'Scatta una foto' }),
    }))
    expect(clickInput, '«Scatta una foto» non apre il selettore dei file').not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /1 file/i })).toBeInTheDocument()
  })

  it('il vecchio link «Scegli file dal dispositivo» non c’è più: lo sostituisce «Scatta una foto»', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /scegli file dal dispositivo/i })).not.toBeInTheDocument()
    // Due comandi, e nessun altro: il riquadro grande — dal #150 un vero pulsante — e «Scatta una foto».
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual([
      'gallery-selettore-riquadro',
      'gallery-selettore-scatta-foto',
    ])
  })

  it('il catalogo inglese ha le stesse parole (parità, e la chiave morta è sparita da entrambi)', () => {
    for (const chiave of ['mediaScegliFotoVideo', 'mediaScegliFotoVideoDettaglio', 'mediaScattaUnaFoto', 'mediaErroreTroppiElementi']) {
      expect((enShared as Record<string, string>)[chiave], `manca in inglese: ${chiave}`).toBeTruthy()
      expect((itShared as Record<string, string>)[chiave], `manca in italiano: ${chiave}`).toBeTruthy()
    }
    expect('mediaScegliFile' in itShared, 'chiave morta rimasta in italiano').toBe(false)
    expect('mediaScegliFile' in enShared, 'chiave morta rimasta in inglese').toBe(false)
  })
})

describe('sul web non cambia niente: il riquadro apre l’input, niente fotocamera', () => {
  beforeEach(() => nativoMock.mockReturnValue(false))

  it('i testi di sempre, nessun pulsante «Scatta una foto»', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    expect(screen.getByText(itShared.mediaTrascinaFotoVideo)).toBeInTheDocument()
    expect(screen.getByText(itShared.mediaOppureClicca)).toBeInTheDocument()
    expect(screen.queryByText(itShared.mediaScegliFotoVideo)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itShared.mediaScattaUnaFoto })).not.toBeInTheDocument()
  })

  it('il click sul riquadro clicca l’<input> e non tocca la fotocamera', () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    const clickInput = vi.spyOn(inputDi(container), 'click')
    fireEvent.click(riquadro())
    expect(clickInput).toHaveBeenCalledTimes(1)
    expect(scegliMock).not.toHaveBeenCalled()
  })
})

describe('il riquadro grande è un VERO comando: ruolo, tastiera, nome (#150)', () => {
  // Nell'app il riquadro è la scelta PRINCIPALE, e era un `<div onClick>` nudo: nessun ruolo, nessun
  // `tabIndex`, nessuna tastiera — da tastiera (e con VoiceOver o TalkBack) non si apriva in nessun modo.
  // Vale anche sul web, dove il comportamento non cambia: apre lo stesso `<input>`.
  const AMBIENTI = [
    ['nell’app', true, /scegli foto e video/i],
    ['sul web', false, /trascina foto o video/i],
  ] as const

  describe.each(AMBIENTI)('%s', (_nome, nativo, nomeAtteso) => {
    beforeEach(() => nativoMock.mockReturnValue(nativo))

    it('è un pulsante nell’albero di accessibilità, raggiungibile col Tab, col nome del suo testo visibile', () => {
      render(<MediaUploader onUpload={vi.fn()} />)
      const r = screen.getByRole('button', { name: nomeAtteso })
      expect(r).toBe(riquadro())
      expect(r.getAttribute('role')).toBe('button')
      expect(r.tabIndex, 'senza `tabIndex` il Tab non lo raggiunge').toBe(0)
      // WCAG 2.5.3 (Label in Name): il nome accessibile CONTIENE il testo che si legge a schermo.
      // Il testo visibile sono i due paragrafi, uno sotto l'altro: il nome li legge in fila.
      const visibile = Array.from(r.querySelectorAll('p')).map((p) => p.textContent).join(' ')
      expect(visibile).toBeTruthy()
      expect(r).toHaveAccessibleName(visibile)
    })

    it('Invio apre il selettore: lo stesso gesto del click (stesso <input>, stessa riga di log, mai la fotocamera)', () => {
      const { container } = render(<MediaUploader onUpload={vi.fn()} />)
      const clickInput = vi.spyOn(inputDi(container), 'click')
      riquadro().focus()
      expect(riquadro()).toHaveFocus()

      fireEvent.keyDown(riquadro(), { key: 'Enter' })

      expect(clickInput).toHaveBeenCalledTimes(1)
      expect(messaggi()).toEqual([`gallery-selettore-aperto strada=selettore-file ambiente=${nativo ? 'app' : 'web'}`])
      expect(scegliMock).not.toHaveBeenCalled()
    })

    it('Spazio fa lo stesso — e NON fa scorrere la pagina (il gesto è annullato)', () => {
      const { container } = render(<MediaUploader onUpload={vi.fn()} />)
      const clickInput = vi.spyOn(inputDi(container), 'click')

      // `fireEvent` risponde `false` quando l'evento è stato annullato con `preventDefault`.
      expect(fireEvent.keyDown(riquadro(), { key: ' ' }), 'lo Spazio scorre la pagina invece di aprire il selettore').toBe(false)

      expect(clickInput).toHaveBeenCalledTimes(1)
    })

    it('un altro tasto non fa niente e non viene annullato: il Tab deve poter passare oltre', () => {
      const { container } = render(<MediaUploader onUpload={vi.fn()} />)
      const clickInput = vi.spyOn(inputDi(container), 'click')
      for (const key of ['Tab', 'a', 'ArrowDown', 'Escape']) {
        expect(fireEvent.keyDown(riquadro(), { key }), key).toBe(true)
      }
      expect(clickInput).not.toHaveBeenCalled()
      expect(messaggi()).toEqual([])
    })

    it('il click di prima funziona ancora, una volta sola (il click dell’<input> non risale a riaprirlo)', () => {
      const { container } = render(<MediaUploader onUpload={vi.fn()} />)
      const input = inputDi(container)
      const clickInput = vi.spyOn(input, 'click')
      fireEvent.click(riquadro())
      expect(clickInput).toHaveBeenCalledTimes(1)
      // Il click che l'input riceve dal programma non deve riaprire il riquadro (si ciclerebbe all'infinito).
      fireEvent.click(input)
      expect(messaggi()).toEqual([`gallery-selettore-aperto strada=selettore-file ambiente=${nativo ? 'app' : 'web'}`])
    })

    it('è accessibile (axe): nessun controllo annidato, nome presente, ruolo ammesso', async () => {
      const { container } = render(<MediaUploader onUpload={vi.fn()} />)
      const { axe } = await import('jest-axe')
      const risultato = await axe(container, {
        rules: { region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
      })
      expect(risultato.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    })
  })

  it('un tasto premuto su un DISCENDENTE del riquadro non apre niente: conta solo il comando stesso', () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    const clickInput = vi.spyOn(inputDi(container), 'click')
    fireEvent.keyDown(container.querySelector('input[type="file"]') as HTMLElement, { key: 'Enter' })
    expect(clickInput).not.toHaveBeenCalled()
  })
})

describe('riga di log 1 — selettore aperto', () => {
  it('app, riquadro grande: strada=selettore-file ambiente=app', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    expect(messaggi()).toEqual(['gallery-selettore-aperto strada=selettore-file ambiente=app'])
    expect(righe()[0]).toMatchObject({ livello: 'warn', evento: 'js' })
  })

  it('app, «Scatta una foto»: strada=fotocamera-nativa ambiente=app', async () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: itShared.mediaScattaUnaFoto }))
    await waitFor(() => expect(scegliMock).toHaveBeenCalled())
    expect(quelle('gallery-selettore-aperto').map((r) => r.messaggio))
      .toEqual(['gallery-selettore-aperto strada=fotocamera-nativa ambiente=app'])
  })

  it('web: strada=selettore-file ambiente=web', () => {
    nativoMock.mockReturnValue(false)
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    expect(messaggi()).toEqual(['gallery-selettore-aperto strada=selettore-file ambiente=web'])
  })
})

describe('riga di log 2 — file ricevuti', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
  })

  it('un video da 73 MB scelto dopo 7 s: mime=video attesa=5-30s tardivo=no, e compare la miniatura', async () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    act(() => { vi.advanceTimersByTime(7_000) })
    consegna(container, video())

    const [riga] = quelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toBe('gallery-selettore-file-ricevuti mime=video attesa=5-30s tardivo=no')
    expect(riga.campi).toEqual({ n: 1, n_video: 1, n_foto: 0, byte_totali: 73_000_000, ms_da_apertura: 7_000 })
    await asciuga()
    expect(container.querySelector('video')).toBeTruthy()
  })

  it('foto e video insieme: mime=misto con i due conteggi', () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    consegna(container, foto('a.jpg'), video('b.mov', 500), foto('c.jpg'))
    const [riga] = quelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toMatch(/mime=misto attesa=<1s tardivo=no$/)
    expect(riga.campi).toMatchObject({ n: 3, n_video: 1, n_foto: 2 })
  })

  it('una foto dalla fotocamera nativa scrive la stessa riga, mime=image', async () => {
    scegliMock.mockImplementation(async () => {
      vi.advanceTimersByTime(2_500)
      return [foto('foto-1.jpg')]
    })
    render(<MediaUploader onUpload={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaScattaUnaFoto }))
    })
    await asciuga()
    const [riga] = quelle('gallery-selettore-file-ricevuti')
    expect(riga.messaggio).toBe('gallery-selettore-file-ricevuti mime=image attesa=1-5s tardivo=no')
    expect(riga.campi).toMatchObject({ n: 1, n_foto: 1, ms_da_apertura: 2_500 })
  })

  it('un trascinamento sul riquadro (nessun selettore aperto) NON scrive la riga: i file entrano lo stesso', async () => {
    nativoMock.mockReturnValue(false)
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.drop(riquadro(), { dataTransfer: { files: [foto('trascinata.jpg')] } })
    await asciuga()
    // Sincrono: con `setTimeout` finto `findBy*` non finirebbe mai (l'`asyncWrapper` di RTL aspetta un timeout).
    expect(screen.getByRole('button', { name: /1 file/i })).toBeInTheDocument()
    expect(quelle('gallery-selettore-file-ricevuti')).toEqual([])
  })
})

describe('riga di log 3 — chiuso senza file', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('motivo=cancel: l’evento `cancel` dell’input (React non lo inoltra a onCancel: va agganciato a mano)', () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    act(() => { vi.advanceTimersByTime(2_000) })
    fireEvent(inputDi(container), new Event('cancel'))

    const [riga] = quelle('gallery-selettore-chiuso-senza-file')
    expect(riga.messaggio).toBe('gallery-selettore-chiuso-senza-file motivo=cancel attesa=1-5s')
    expect(riga.livello).toBe('warn')
    expect(riga.campi).toEqual({ ms_da_apertura: 2_000 })
  })

  it('motivo=ritorno-senza-file: la pagina torna in primo piano e dopo 15 s non è arrivato niente', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    act(() => { vi.advanceTimersByTime(2_000) })
    paginaVaViaETorna()

    act(() => { vi.advanceTimersByTime(14_999) })
    expect(quelle('gallery-selettore-chiuso-senza-file'), 'a 14.999 ms non è ancora partito').toEqual([])
    act(() => { vi.advanceTimersByTime(1) })

    const [riga] = quelle('gallery-selettore-chiuso-senza-file')
    expect(riga.messaggio).toBe('gallery-selettore-chiuso-senza-file motivo=ritorno-senza-file attesa=1-5s')
    expect(riga.campi).toEqual({ ms_da_apertura: 2_000 })
  })

  it('…e se i file arrivano DOPO, la riga dei file è `tardivo=si` con ms_da_ritorno (la firma di WebKit/iCloud)', () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    act(() => { vi.advanceTimersByTime(2_000) })
    paginaVaViaETorna()
    act(() => { vi.advanceTimersByTime(15_000) })
    act(() => { vi.advanceTimersByTime(20_000) })
    consegna(container, video())

    expect(messaggi()).toEqual([
      'gallery-selettore-aperto strada=selettore-file ambiente=app',
      'gallery-selettore-chiuso-senza-file motivo=ritorno-senza-file attesa=1-5s',
      'gallery-selettore-file-ricevuti mime=video attesa=30s-2m tardivo=si',
    ])
    expect(quelle('gallery-selettore-file-ricevuti')[0].campi).toMatchObject({ ms_da_apertura: 37_000, ms_da_ritorno: 35_000 })
  })

  it('motivo=annullato-fotocamera: il foglio nativo chiuso senza foto', async () => {
    scegliMock.mockImplementation(async () => {
      vi.advanceTimersByTime(3_500)
      return []
    })
    render(<MediaUploader onUpload={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaScattaUnaFoto }))
    })

    const [riga] = quelle('gallery-selettore-chiuso-senza-file')
    expect(riga.messaggio).toBe('gallery-selettore-chiuso-senza-file motivo=annullato-fotocamera attesa=1-5s')
    expect(riga.campi).toEqual({ ms_da_apertura: 3_500 })
  })

  it('un guasto della fotocamera (permesso negato) ha il suo log e il suo avviso: NON è «annullato»', async () => {
    scegliMock.mockImplementation(async (opts) => {
      opts?.onErrore?.('permesso_negato', 'permission_denied_camera')
      return []
    })
    render(<MediaUploader onUpload={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaScattaUnaFoto }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/permesso/i)
    expect(quelle('gallery-selettore-chiuso-senza-file'), 'un errore non è un annullamento').toEqual([])
  })

  it('lo smontaggio spegne il timer e l’ascoltatore: nessuna riga a componente morto', () => {
    const { container, unmount } = render(<MediaUploader onUpload={vi.fn()} />)
    const input = inputDi(container)
    fireEvent.click(riquadro())
    paginaVaViaETorna()
    unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    input.dispatchEvent(new Event('cancel'))
    expect(quelle('gallery-selettore-chiuso-senza-file')).toEqual([])
  })
})

describe('il ritorno in primo piano parte SOLO dal ritorno vero, mai da un orologio (#145)', () => {
  // `useTracciaSelettore` aggancia `traccia.ritorno()` a `usePollingVisibile(…, null)`: «null» è «solo al ritorno»,
  // nessun intervallo. Con un intervallo al posto di `null` il ritorno scatterebbe a vuoto, la pagina non se
  // ne sarebbe mai andata, e la riga `ritorno-senza-file` direbbe che il selettore si è chiuso quando è ancora
  // aperto — cioè la misura che il titolare vuole leggere sarebbe sporcata da un orologio. Il file non lo
  // provava: la mutazione restava verde perché `setInterval` non era finto e nessun test faceva passare il tempo.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('selettore aperto, pagina SEMPRE in primo piano, sessanta secondi di orologio: resta la sola riga «aperto»', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    act(() => { vi.advanceTimersByTime(60_000) })

    expect(messaggi()).toEqual(['gallery-selettore-aperto strada=selettore-file ambiente=app'])
  })

  it('anche senza aprire niente l’orologio non scrive: nessun ritorno, nessun timer dei 15 secondi', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(messaggi()).toEqual([])
    expect(vi.getTimerCount(), 'un orologio o un timer è rimasto armato').toBe(0)
  })

  it('CONTROLLO POSITIVO: con un ritorno vero (la pagina se ne va e torna) la riga arriva, a 15 secondi', () => {
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro())
    act(() => { vi.advanceTimersByTime(2_000) })
    paginaVaViaETorna()
    act(() => { vi.advanceTimersByTime(15_000) })

    expect(messaggi()).toEqual([
      'gallery-selettore-aperto strada=selettore-file ambiente=app',
      'gallery-selettore-chiuso-senza-file motivo=ritorno-senza-file attesa=1-5s',
    ])
  })
})

describe('il tetto dei 50 — si tengono i primi, e si avvisa in linea', () => {
  const sessanta = () => Array.from({ length: 60 }, (_, i) => foto(`${NOME_BAMBINO} ${i + 1}.jpg`))
  const miniature = () => screen.queryAllByRole('button', { name: itShared.galleryRimuoviFile })

  it('60 scelte → 50 anteprime, avviso in linea e log col SOLO conteggio', async () => {
    const onUpload = vi.fn()
    const { container } = render(<MediaUploader onUpload={onUpload} />)
    fireEvent.click(riquadro())
    consegna(container, ...sessanta())
    await waitFor(() => expect(miniature()).toHaveLength(50))

    expect(screen.getByRole('status')).toHaveTextContent(
      AVVISO_CON_50,
    )
    const [riga] = quelle('gallery-selezione-oltre-il-massimo')
    expect(riga.livello).toBe('warn')
    expect(riga.campi).toEqual({ scelti: 60, aggiunti: 50, massimo: 50 })

    // Il pulsante che porta ai bambini dice 50, e il passo successivo riceve 50 file: i PRIMI 50.
    fireEvent.click(screen.getByRole('button', { name: /50 file/i }))
    const consegnati = onUpload.mock.calls[0][0] as { file: File }[]
    expect(consegnati).toHaveLength(50)
    expect(consegnati[0].file.name).toBe(`${NOME_BAMBINO} 1.jpg`)
    expect(consegnati[49].file.name).toBe(`${NOME_BAMBINO} 50.jpg`)
  })

  it('esattamente 50 entrano tutti: nessun avviso e nessuna riga', async () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    consegna(container, ...sessanta().slice(0, 50))
    await waitFor(() => expect(miniature()).toHaveLength(50))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(quelle('gallery-selezione-oltre-il-massimo')).toEqual([])
  })

  it('il tetto vale sul TOTALE: 30 + 30 fanno 50, e la seconda scelta ne aggiunge 20', async () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    consegna(container, ...sessanta().slice(0, 30))
    await waitFor(() => expect(miniature()).toHaveLength(30))
    consegna(container, ...sessanta().slice(30, 60))
    await waitFor(() => expect(miniature()).toHaveLength(50))

    expect(quelle('gallery-selezione-oltre-il-massimo')[0].campi).toEqual({ scelti: 30, aggiunti: 20, massimo: 50 })
    expect(screen.getByRole('status')).toHaveTextContent(AVVISO_CON_50)
  })

  it('l’avviso è un elemento SEMPRE MONTATO (VoiceOver non annuncia una regione viva che entra già piena)', async () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    const prima = screen.getByRole('status')
    expect(prima, 'vuoto e invisibile finché non serve').toBeEmptyDOMElement()
    expect(prima.className).toContain('sr-only')

    consegna(container, ...sessanta())
    await waitFor(() => expect(miniature()).toHaveLength(50))
    const dopo = screen.getByRole('status')
    expect(dopo, 'è lo STESSO nodo: cambia il testo, non il montaggio').toBe(prima)
    expect(dopo.className).not.toContain('sr-only')
    expect(dopo.textContent).toBeTruthy()
  })

  it('togliere un’anteprima libera un posto e spegne l’avviso', async () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    consegna(container, ...sessanta())
    await waitFor(() => expect(miniature()).toHaveLength(50))

    fireEvent.click(miniature()[0])
    await waitFor(() => expect(miniature()).toHaveLength(49))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    // E il posto liberato si riempie davvero: ne entra UNO solo.
    consegna(container, foto('ultima.jpg'), foto('di-troppo.jpg'))
    await waitFor(() => expect(miniature()).toHaveLength(50))
    expect(quelle('gallery-selezione-oltre-il-massimo').at(-1)?.campi).toEqual({ scelti: 2, aggiunti: 1, massimo: 50 })
  })

  it('con 50 già scelti una nuova scelta non aggiunge niente e lo dice', async () => {
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    consegna(container, ...sessanta().slice(0, 50))
    await waitFor(() => expect(miniature()).toHaveLength(50))
    consegna(container, foto('una-in-piu.jpg'))
    await asciuga()
    expect(miniature()).toHaveLength(50)
    expect(screen.getByRole('status')).toHaveTextContent(AVVISO_CON_50)
  })
})

describe('MAI il nome del file: dal componente vero non esce in nessun log', () => {
  it('video, foto, un file rifiutato e il tetto: nessun log contiene il nome del bambino', async () => {
    nativoMock.mockReturnValue(true)
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(riquadro()) // riga 1
    const illeggibile = new File([new Uint8Array([1, 2, 3])], `${NOME_BAMBINO}.jpg`) // senza MIME e senza firma
    const tanti = Array.from({ length: 52 }, (_, i) => foto(`${NOME_BAMBINO} ${i}.jpg`))
    consegna(container, video(`${NOME_BAMBINO}.mov`), illeggibile, ...tanti) // riga 2 + rifiuto + tetto
    await waitFor(() => expect(screen.getAllByRole('button', { name: itShared.galleryRimuoviFile })).toHaveLength(50))
    fireEvent.click(riquadro())
    fireEvent(inputDi(container), new Event('cancel')) // riga 3

    // Tutti i log del percorso sono stati scritti davvero (altrimenti il test sarebbe verde su un log muto).
    expect(quelle('gallery-selettore-aperto')).toHaveLength(2)
    expect(quelle('gallery-selettore-file-ricevuti')).toHaveLength(1)
    expect(quelle('gallery-selettore-chiuso-senza-file')).toHaveLength(1)
    expect(quelle('gallery-file-selezione-rifiutata')).toHaveLength(1)
    expect(quelle('gallery-selezione-oltre-il-massimo')).toHaveLength(1)

    const tutto = JSON.stringify(h.logClient.mock.calls)
    for (const pezzo of [NOME_BAMBINO, 'Pinco', 'Pallino', 'Natale', '.mov', '.jpg']) {
      expect(tutto, `«${pezzo}» è finito in un log`).not.toContain(pezzo)
    }
  })
})
