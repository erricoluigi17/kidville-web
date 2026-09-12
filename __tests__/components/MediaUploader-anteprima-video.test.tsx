import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import itServizi from '../../messages/it/teacherServizi.json'

/**
 * IL CARICAMENTO DELL'INSEGNANTE — un video si guarda con `<video>`, e la X si vede.
 *
 * ─── I DIFETTI, CONFERMATI DAL TITOLARE DALL'APP iOS (2026-09-11) ────────────
 *
 * 1. «L'anteprima di un video è l'icona di immagine rotta.» `MediaUploader`
 *    rendeva SEMPRE `<img src={objectURL}>`, anche quando il file scelto era un
 *    video — mentre `addFiles` accetta `video/` e l'input dichiara
 *    `accept="image/*,video/*"`. Un browser non sa disegnare un frame di MP4
 *    dentro un `<img>`: mostra il glifo del file rotto. Le stesse due righe
 *    esistevano TRE volte (l'uploader e le due miniature dello step 2), che è il
 *    motivo per cui la correzione nasce come componente unico
 *    (`AnteprimaMedia`) e non come tre toppe.
 *
 * 2. «Non riesco a togliere un file scelto per sbaglio.» Il bottone di rimozione
 *    era `w-5 h-5 opacity-0 group-hover:opacity-100`: su iPhone e su tablet
 *    l'hover NON ESISTE, quindi il bottone era invisibile — ed era l'unico modo
 *    di togliere un file. 20 px sono anche sotto il minimo di 24×24 di WCAG
 *    2.5.8 (Target Size, AA). Adesso è 32 px e si vede sempre, con un fondo che
 *    lo stacca dalla foto.
 *
 * ─── PERCHÉ IL TIPO MIME E NON L'ESTENSIONE ──────────────────────────────────
 * `file.type.startsWith('video/')` guarda ciò che il sistema operativo dichiara.
 * L'estensione del nome è un'altra cosa: su iOS la libreria consegna file con
 * nomi come `capacitor-…` o `image.jpg` anche per i filmati, e quel repo ha già
 * pagato una volta la lezione del MIME (`;codecs=avc1` di `MediaRecorder`).
 *
 * ─── PERCHÉ LE PRETESE SULLA X STANNO IN UNA FUNZIONE (giro 2) ───────────────
 * Al primo giro le tre asserzioni «si vede / non è hover / è abbastanza grande»
 * esistevano SOLO per la X dello step 1 — quella che c'era già. La X dello step 2
 * è la copia NUOVA, e il critico l'ha misurato: rimettendole
 * `opacity-0 group-hover:opacity-100 h-4 w-4` la suite restava verde 23/23. Un
 * test che conta i bottoni e ne verifica l'effetto è cieco al ramo: il difetto
 * della consegna rientrava dalla porta appena aperta. Adesso la pretesa è una
 * funzione sola, chiamata su TUTTE le copie, e ha un controllo positivo che
 * dimostra che ognuno dei suoi denti morde.
 */

// La fotocamera nativa non c'entra con questi collaudi: si sta su web, dove il
// drop-zone apre l'input. (Il modulo va comunque mockato: `useImagePicker` lo
// importa, e `fotocameraNativaDisponibile()` tocca il bridge Capacitor.)
vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(() => false),
  scegliFotoNativa: vi.fn(async () => []),
}))

const h = vi.hoisted(() => ({ logClient: vi.fn(), confirm: vi.fn(), alert: vi.fn() }))

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
  useSessionIdentity: () => ({ userId: 'aaaa1111-0000-4000-8000-000000000001', role: 'educator', ready: true }),
}))
vi.mock('@/lib/offline/syncEngine', () => ({
  saveLocalGalleryMedia: vi.fn(async () => undefined),
  syncPendingGalleryMedia: vi.fn(async () => undefined),
}))
vi.mock('@/lib/offline/db', () => ({}))

import { MediaUploader } from '@/components/features/gallery/MediaUploader'
import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page'

const SEZIONE = 'TEST Infanzia'
const ADA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Ada', cognome: 'Bianchi', consenso_privacy: true }

beforeEach(() => {
  vi.clearAllMocks()
  h.confirm.mockReturnValue(true)
  vi.stubGlobal('confirm', h.confirm)
  vi.stubGlobal('alert', h.alert)
  // Un objectURL DIVERSO per file: se ne servisse uno solo per tutti, una
  // revoca sbagliata non si distinguerebbe da una giusta.
  let n = 0
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: () => `blob:anteprima-${++n}`,
    revokeObjectURL: vi.fn(),
  }))
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = String(url)
    if (u.includes('/api/educator-sections')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: [SEZIONE] }) })
    if (u.includes('/api/diary/students')) return Promise.resolve({ ok: true, status: 200, json: async () => [ADA] })
    if (u.includes('/api/me')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ruolo: 'educator' }) })
    if (u.includes('/api/gallery')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ media: [], total: 0 }) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Mette i file nell'input dell'uploader: è la strada che fanno sia il drag&drop sia la galleria. */
function scegli(container: HTMLElement, ...files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  expect(input, 'input[type=file] non trovato: l’uploader non è montato').toBeTruthy()
  fireEvent.change(input, { target: { files } })
}

const video = (nome = 'filmato.mp4') => new File(['x'], nome, { type: 'video/mp4' })
const foto = (nome = 'foto.jpg') => new File(['x'], nome, { type: 'image/jpeg' })

/** WCAG 2.5.8 (Target Size (Minimum), AA): il bersaglio non scende sotto 24×24 px CSS. */
const LATO_MINIMO_PX = 24

/** Il lato in px dichiarato da una classe `h-N`/`w-N` di Tailwind (1 unità = 0,25rem = 4 px). */
function latoPx(classi: string, asse: 'h' | 'w'): number {
  const trovato = classi.match(new RegExp(`(?:^|\\s)${asse}-(\\d+)(?=\\s|$)`))
  expect(
    trovato,
    `nessuna classe \`${asse}-N\` in «${classi}»: la dimensione del bersaglio non è dichiarata, ` +
      'quindi non è nemmeno verificabile',
  ).toBeTruthy()
  return Number(trovato![1]) * 4
}

/**
 * LA PRETESA SULLA X, UNA SOLA, PER TUTTE LE COPIE.
 *
 * Le quattro cose che rendevano il bottone inutilizzabile sul telefono del
 * titolare, e che qui diventano rosse una per una:
 *  · `opacity-0` → invisibile finché non si passa sopra col mouse;
 *  · `group-hover:` → e l'hover, su touch, NON ESISTE;
 *  · meno di 24 px → sotto il minimo di WCAG 2.5.8, si centra per sbaglio;
 *  · nessun fondo → la X bianca sparisce sopra una parete bianca.
 */
function pretendiXVisibileEGrande(bottone: HTMLElement) {
  const classi = bottone.className
  expect(classi, `invisibile finché non passa un mouse che su iPhone non esiste: «${classi}»`)
    .not.toMatch(/opacity-0(?!\d)/)
  expect(classi, `l’hover non esiste su touch: \`group-hover:\` è il difetto stesso: «${classi}»`)
    .not.toMatch(/group-hover:/)
  expect(latoPx(classi, 'h'), `altezza sotto i ${LATO_MINIMO_PX} px di WCAG 2.5.8: «${classi}»`)
    .toBeGreaterThanOrEqual(LATO_MINIMO_PX)
  expect(latoPx(classi, 'w'), `larghezza sotto i ${LATO_MINIMO_PX} px di WCAG 2.5.8: «${classi}»`)
    .toBeGreaterThanOrEqual(LATO_MINIMO_PX)
  expect(classi, 'senza un fondo la X sparisce sopra una foto chiara').toMatch(/bg-kidville-/)
  expect(classi, 'su touch serve anche togliere il ritardo dei 300 ms').toContain('touch-manipulation')
}

describe('la parola «video» viene dal CATALOGO, non da un letterale nel sorgente', () => {
  const SORGENTE = readFileSync(join(process.cwd(), 'src/components/features/gallery/AnteprimaMedia.tsx'), 'utf8')
  /**
   * IL SORGENTE SENZA I COMMENTI, e non è un vezzo: la prima stesura di questo
   * test è passata SUBITO, prima della correzione, perché il vecchio commento
   * conteneva la chiamata alla chiave dentro un periodo che diceva «quando la
   * chiave esisterà». Un lock che si accontenta del proprio commento in questo
   * repo si è già visto, e il PRD lo racconta. Qui si guarda il CODICE.
   */
  const CODICE = SORGENTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  it('la prende da `shared.galleryVideo`, che esiste in tutte e due le lingue', () => {
    expect(CODICE, 'la parola non arriva dal catalogo').toMatch(/t\('galleryVideo'\)/)
    expect(itShared.galleryVideo, 'la chiave manca in italiano').toBeTruthy()
    expect(enShared.galleryVideo, 'la chiave manca in inglese').toBeTruthy()
  })

  it('e NON tiene una seconda copia della parola cablata nel sorgente', () => {
    // Al giro 2 la parola era una costante esportata da questo componente, con
    // quattro commenti che sostenevano «nei cataloghi non c'è». Il critico ha
    // misurato i timestamp: la chiave era in `messages/en/shared.json` da sei
    // minuti prima che il file fosse scritto, e `MediaGrid` la consumava già con
    // `t('galleryVideo')` — anzi, l'aveva appena TOLTA dal proprio sorgente per
    // quel motivo. Due sorgenti di verità per una parola sola: se domani l'inglese
    // diventa «Movie», la galleria dice «Movie» e l'anteprima no.
    expect(
      SORGENTE.match(/ETICHETTA_VIDEO|['"]Video['"]/g),
      'la parola è di nuovo cablata qui dentro: il catalogo è uno, e sta in `messages/`',
    ).toBeNull()
  })
})

describe('la pretesa sulla X morde davvero (controllo positivo)', () => {
  /** Un bottone finto con le classi che gli si danno: serve solo a far fallire la pretesa. */
  const finto = (classi: string) => {
    const b = document.createElement('button')
    b.className = classi
    return b
  }
  const BUONO = 'absolute top-1 right-1 h-8 w-8 rounded-full bg-kidville-ink/70 touch-manipulation'

  it('passa sul bottone corretto', () => {
    expect(() => pretendiXVisibileEGrande(finto(BUONO))).not.toThrow()
  })

  // Un dente alla volta: senza questi cinque, la funzione qui sopra potrebbe
  // essere verde per un motivo qualunque — ed è esattamente com'è rientrato il
  // difetto allo step 2 al primo giro.
  it('fallisce se torna `opacity-0`', () => {
    expect(() => pretendiXVisibileEGrande(finto(`${BUONO} opacity-0`))).toThrow()
  })
  it('fallisce se torna `group-hover:`', () => {
    expect(() => pretendiXVisibileEGrande(finto(`${BUONO} group-hover:opacity-100`))).toThrow()
  })
  it('fallisce sotto i 24 px (`h-4 w-4` sono 16)', () => {
    expect(() => pretendiXVisibileEGrande(finto(BUONO.replace('h-8 w-8', 'h-4 w-4')))).toThrow()
  })
  it('fallisce se la dimensione non è dichiarata', () => {
    expect(() => pretendiXVisibileEGrande(finto(BUONO.replace('h-8 w-8 ', '')))).toThrow()
  })
  it('fallisce senza un fondo che la stacchi dalla foto', () => {
    expect(() => pretendiXVisibileEGrande(finto(BUONO.replace('bg-kidville-ink/70 ', '')))).toThrow()
  })
  it('NON si autoassolve su `disabled:opacity-40`, che non è `opacity-0`', () => {
    expect(() => pretendiXVisibileEGrande(finto(`${BUONO} disabled:opacity-40`))).not.toThrow()
  })
})

describe('MediaUploader · l’anteprima di un video non è un’immagine rotta', () => {
  it('un file `video/mp4` produce un <video> e NESSUN <img>', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, video())

    await waitFor(() => expect(v.container.querySelector('video')).toBeTruthy())
    const elemento = v.container.querySelector('video') as HTMLVideoElement
    // `muted` + `playsInline` + `preload="metadata"`: su iOS un video senza
    // `playsinline` va a schermo pieno da solo, e senza `preload` la tessera
    // resta nera perché nessun frame è stato scaricato.
    expect(elemento.getAttribute('src')).toMatch(/^blob:/)
    expect(elemento.hasAttribute('playsinline') || elemento.playsInline).toBe(true)
    expect(elemento.getAttribute('preload')).toBe('metadata')
    expect(elemento.muted).toBe(true)

    expect(
      Array.from(v.container.querySelectorAll('img')).map((i) => i.getAttribute('src')),
      'un <img> con dentro un MP4 è il glifo del file rotto che il titolare ha visto su iPhone',
    ).toEqual([])
  })

  it('la tessella DICE «video» a parole, non solo con un glifo', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, video())

    await waitFor(() => expect(v.container.querySelector('video')).toBeTruthy())
    // Un triangolino non si legge ad alta voce: senza la parola, per chi usa uno
    // screen reader la tessella di un filmato è indistinguibile da quella di una
    // foto. È la stessa parola che `MediaGrid` mostra sulle sue miniature, e viene
    // dalla stessa chiave: `shared.galleryVideo`.
    const parola = screen.getByText(itShared.galleryVideo)
    expect(parola).toBeInTheDocument()
    // …e ALLO STEP 1 si vede. Qui la tessella è di ~98 px e in basso a sinistra
    // non c'è nient'altro: la pastiglia intera ci sta. (Sulla striscia da 64 px
    // dello step 2 no, e là la parola resta solo per gli screen reader — c'è un
    // test apposta più sotto.)
    expect(parola.className, 'la parola è nascosta anche dove lo spazio c’è').not.toContain('sr-only')
  })

  it('la tessella dice anche QUALE file è, e non solo che è un video', async () => {
    // La sola cosa che risponde alla domanda del titolare — «non so quale video ho
    // scelto» — senza dipendere da un'euristica di Safari. `preload="metadata"` è
    // la condizione NECESSARIA perché compaia il primo frame, non quella
    // sufficiente: su iOS il precaricamento è un suggerimento che il browser può
    // ignorare (Risparmio Energetico, storicamente la rete cellulare), e in jsdom
    // un `<video>` non carica mai niente — nessun test di questo file dimostra che
    // si veda un fotogramma. Il nome, invece, c'è sempre.
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, video('recita-di-fine-anno.mp4'))

    expect(await screen.findByText('recita-di-fine-anno.mp4')).toBeInTheDocument()
  })

  it('CONTROLLO POSITIVO: una foto resta un <img>, non diventa un <video> e non dice «video»', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, foto())

    await waitFor(() => expect(v.container.querySelector('img')).toBeTruthy())
    expect(v.container.querySelector('video')).toBeNull()
    expect(screen.queryByText(itShared.galleryVideo)).toBeNull()
  })

  it('discrimina sul TIPO MIME, non sull’estensione del nome', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    // Nome da foto, contenuto da video: è ciò che consegna la libreria di iOS.
    scegli(v.container, new File(['x'], 'IMG_0042.jpg', { type: 'video/quicktime' }))

    await waitFor(() => expect(v.container.querySelector('video')).toBeTruthy())
    expect(v.container.querySelectorAll('img')).toHaveLength(0)
  })
})

describe('MediaUploader · la X di rimozione si vede anche senza mouse', () => {
  it('il bottone è nel DOM, si vede sempre ed è abbastanza grande', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, foto())

    const x = await screen.findByRole('button', { name: itShared.galleryRimuoviFile })
    pretendiXVisibileEGrande(x)
    // Nella griglia dello step 1 la tessella è di ~98 px: 32 ci stanno comodi.
    expect(latoPx(x.className, 'h')).toBe(32)
  })

  it('premerla toglie DAVVERO il file e revoca il suo objectURL', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, foto('a.jpg'), video('b.mp4'))

    await waitFor(() => expect(v.container.querySelectorAll('img, video')).toHaveLength(2))
    const xs = screen.getAllByRole('button', { name: itShared.galleryRimuoviFile })
    expect(xs).toHaveLength(2)

    fireEvent.click(xs[1])
    await waitFor(() => expect(v.container.querySelectorAll('img, video')).toHaveLength(1))
    expect(v.container.querySelector('video'), 'è stato rimosso il video, non la foto').toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:anteprima-2')
  })
})

describe('MediaUploader · la griglia e l’etichetta del bottone', () => {
  it('tre colonne fisse: sei tessere in una colonna da 460 px sono 66 px l’una', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, foto())

    await waitFor(() => expect(v.container.querySelector('img')).toBeTruthy())
    const griglia = Array.from(v.container.querySelectorAll('div')).find((d) => d.className.includes('grid-cols-'))
    expect(griglia, 'nessuna griglia di anteprime trovata').toBeTruthy()
    expect(griglia!.className).toContain('grid-cols-3')
    expect(griglia!.className).not.toContain('sm:grid-cols-6')
  })

  it('il bottone non dice «Carica» — e dice comunque che cosa fa', async () => {
    const v = render(<MediaUploader onUpload={vi.fn()} />)
    scegli(v.container, foto('a.jpg'), foto('b.jpg'))

    await waitFor(() => expect(v.container.querySelectorAll('img')).toHaveLength(2))
    const avanti = screen.getByRole('button', { name: new RegExp(`2 ${itShared.mediaFilePlurale}`) })
    const nome = avanti.textContent ?? ''

    // (1) NON dice «Carica»: il caricamento vero parte solo dopo i tag, e
    //     annunciare un'azione irreversibile sulle foto di bambini mentre se ne
    //     fa una reversibile è la bugia da togliere.
    //     La parola si legge dal catalogo, e il `if` non è pigrizia: con lo
    //     spinner è morta anche l'ultima chiamata a `mediaCaricaVerbo`, quindi
    //     chi possiede `messages/` la cancellerà. Se la chiave non c'è più, la
    //     pretesa è soddisfatta a maggior ragione — mentre un
    //     `new RegExp(undefined)` è `/(?:)/`, che combacia con QUALUNQUE testo e
    //     renderebbe questo test rosso per la correzione di qualcun altro.
    const verboCarica: string | undefined = (itShared as Record<string, string>).mediaCaricaVerbo
    if (verboCarica) expect(nome, 'diceva «Carica 2 file» e non caricava niente').not.toMatch(new RegExp(verboCarica, 'i'))
    // (1-bis) …e lo dice con una chiave del catalogo, non con un letterale.
    expect(nome, 'l’etichetta non viene da `shared`').toContain(itShared.galleryModificaTag)
    // (2) …ma DICE il suo scopo. Al primo giro l'etichetta era rimasta il solo
    //     conteggio («2 file»): un nome accessibile senza verbo non dice a che
    //     serve il bottone (WCAG 2.4.6 Headings and Labels, AA), ed è un difetto
    //     nuovo messo al posto di quello vecchio.
    expect(
      nome.replace(/[\s·•\d]/g, ''),
      `il nome accessibile è il solo conteggio («${nome.trim()}»): non dice che cosa fa il bottone`,
    ).not.toBe(itShared.mediaFilePlurale)
  })
})

describe('Step 2 · un file scelto per sbaglio si può ancora togliere', () => {
  /** Porta la schermata al passo «tag» con `n` file. */
  async function apri(...files: File[]) {
    const v = render(<TeacherGalleryPage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }))
    await waitFor(() => expect(v.container.querySelector('input[type="file"]')).toBeTruthy())
    scegli(v.container, ...files)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`${files.length} ${itShared.mediaFilePlurale}`) }))
    await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument())
    return v
  }

  /** Le miniature della striscia: `w-16` le distingue dall’anteprima grande. */
  const miniature = (v: ReturnType<typeof render>) =>
    Array.from(v.container.querySelectorAll('div')).filter((d) => d.className.includes('w-16'))

  it('la striscia porta una X per miniatura, e toglie quella giusta', async () => {
    const v = await apri(foto('a.jpg'), foto('b.jpg'), foto('c.jpg'))
    expect(miniature(v)).toHaveLength(3)

    const xs = screen.getAllByRole('button', { name: itShared.galleryRimuoviFile })
    expect(xs, 'una X per miniatura: allo step 2 non c’era NESSUN gesto di rimozione').toHaveLength(3)

    fireEvent.click(xs[1])
    await waitFor(() => expect(miniature(v)).toHaveLength(2))
    // Nessuna conferma: il gesto è reversibile (si riscegli il file), e una
    // conferma su un gesto innocuo è quella che si impara a premere senza
    // leggere — la ragione è già scritta in `handleApplyToAll`.
    expect(h.confirm).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:anteprima-2')
  })

  it('anche QUESTA X si vede e si prende: è la copia nuova, e il difetto rientrava qui', async () => {
    const v = await apri(foto('a.jpg'), foto('b.jpg'))
    const xs = screen.getAllByRole('button', { name: itShared.galleryRimuoviFile })
    expect(xs).toHaveLength(2)
    // Le stesse pretese dello step 1, sulla copia che al primo giro non ne aveva
    // nessuna: rimettendole `opacity-0 group-hover:opacity-100 h-4 w-4` la suite
    // passava 23/23, cioè il difetto della consegna tornava con il gate verde.
    for (const x of xs) pretendiXVisibileEGrande(x)
    // 28 px e non 32: qui la tessella è di 64 px e il resto della sua superficie
    // serve a SELEZIONARLA, quindi il bersaglio della rimozione non la mangia.
    expect(latoPx(xs[0].className, 'h')).toBe(28)
    expect(miniature(v)).toHaveLength(2)
  })

  it('togliendo la miniatura attiva l’indice rientra invece di puntare nel vuoto', async () => {
    const v = await apri(foto('a.jpg'), foto('b.jpg'))
    // Attiva la SECONDA, poi la toglie: `activeFileIndex` resterebbe a 1 su un
    // elenco di uno, e la scheda dei tag sparirebbe.
    fireEvent.click(miniature(v)[1])
    fireEvent.click(screen.getAllByRole('button', { name: itShared.galleryRimuoviFile })[1])

    await waitFor(() => expect(miniature(v)).toHaveLength(1))
    expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument()
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
  })

  it('togliendo una miniatura PRIMA dell’attiva, in configurazione resta LO STESSO file', async () => {
    // Il ramo `indice < prev ? prev - 1` — quello che il primo giro non
    // esercitava: sostituendo `prev - 1` con `prev` gli undici test restavano
    // tutti verdi. È il caso dell'insegnante che sta configurando la foto 3 di 3
    // e toglie la 1: senza il rientro, `activeFileIndex` punta fuori elenco,
    // `activeFile` è `null` e la scheda dei tag SPARISCE senza dire perché.
    const v = await apri(foto('a.jpg'), foto('b.jpg'), foto('c.jpg'))
    fireEvent.click(miniature(v)[2])
    expect(screen.getByText('c.jpg')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: itShared.galleryRimuoviFile })[0])

    await waitFor(() => expect(miniature(v)).toHaveLength(2))
    expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`), 'la scheda dei tag è sparita: l’indice punta nel vuoto').toBeInTheDocument()
    expect(screen.getByText('c.jpg'), 'in configurazione è finito un altro file: l’indice non è rientrato').toBeInTheDocument()
    // E il contatore lo dice: «Foto 2 di 2», non «Foto 3 di 2».
    expect(screen.getByText(itServizi.galleryFotoNofM.replace('{index}', '2').replace('{totale}', '2'))).toBeInTheDocument()
  })

  it('svuotando l’elenco si torna al passo di scelta, non a una schermata vuota', async () => {
    const v = await apri(foto('a.jpg'))
    fireEvent.click(screen.getByRole('button', { name: itShared.galleryRimuoviFile }))

    await waitFor(() => expect(screen.getByText(itShared.mediaTrascinaFotoVideo)).toBeInTheDocument())
    expect(miniature(v)).toHaveLength(0)
  })

  it('anche nella striscia un video è un <video>: era la terza copia dello stesso difetto', async () => {
    const v = await apri(video('b.mp4'))
    // DUE `<video>`: la miniatura della striscia e l'anteprima da 40 px della
    // foto in configurazione. Erano la seconda e la terza copia del difetto.
    expect(v.container.querySelectorAll('video')).toHaveLength(2)
    // Solo gli `<img>` che mostrano un file SCELTO: la mascotte dell'intestazione
    // di pagina è un `<img>` legittimo e non c'entra con le anteprime.
    expect(
      Array.from(v.container.querySelectorAll('img'))
        .map((i) => i.getAttribute('src') ?? '')
        .filter((src) => src.startsWith('blob:')),
      'la miniatura e l’anteprima della foto in configurazione rendevano DUE <img> con dentro un MP4',
    ).toEqual([])
    // La parola compare UNA volta: sulla miniatura. Sull'anteprima da 40 px la
    // pastiglia è spenta di proposito — a quella dimensione coprirebbe l'immagine
    // invece di descriverla, e il tipo è già detto dalla miniatura selezionata.
    const parola = screen.getAllByText(itShared.galleryVideo)
    expect(parola).toHaveLength(1)
    // …e su QUESTA superficie la parola non occupa pixel. L'aritmetica del critico
    // sulle classi vere: la tessella è `w-16` (64 px, e diventa 80 solo da `sm:`,
    // cioè su nessun telefono); la pastiglia intera parte da 4 px e arriva a ~52
    // (px-1.5 ×2 + icona 8 + gap 2 + «Video» in 9 px bold ≈ 26); il badge dello
    // stato dei tag sta `bottom-1 right-1`, finisce a 60 e comincia fra ~43 e ~50
    // secondo il contenuto. Sono ~2-9 px di sovrapposizione, e il badge — che è
    // l'informazione per cui lo step 2 esiste — sta DOPO nell'ordine del documento
    // con un fondo opaco, quindi copre il bordo destro della parola.
    // Spegnere la pastiglia l'avrebbe tolta anche a chi usa uno screen reader,
    // per cui resta, `sr-only`: l'icona misura ~20 px e non arriva al badge.
    expect(
      parola[0].className,
      'la parola occupa pixel su una tessella da 64 px e il badge dei tag le finisce sopra',
    ).toContain('sr-only')
  })
})
