import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

/**
 * I DUE PULSANTI DELLA GALLERIA DEVONO ESSERE LO STESSO PULSANTE — e da app 1.1
 * passano dall'HELPER UNICO (`scaricaMedia` di `@/lib/native/scarica`, NAT2).
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 * «Scarica» e «Condividi» erano scritti DUE VOLTE in `MediaGrid`: una sulla card
 * e una nel visore. Le due copie erano già divergenti — quella della card non
 * aveva nemmeno un `logClient` — e questo è il motivo per cui in trenta giorni
 * di `app_log` esiste UNA sola riga sullo scarico, e viene dal visore.
 *
 * ─── APP 1.1 (spec 2026-09-24 §7) ───────────────────────────────────────────
 * Foto e video vanno DIRETTAMENTE in Galleria/Rullino. La strada la decide
 * l'helper (`scaricaMedia`), non `MediaGrid`: qui si verifica che la griglia lo
 * chiami — con il `tipo` giusto, perché un video passato come foto finirebbe in
 * `savePhoto` e la Galleria lo rifiuterebbe — e che il log dell'esito resti UNO
 * (l'helper logga da sé: una seconda riga da `MediaGrid` raddoppierebbe i
 * successi in `app_log`).
 *
 * E «Scarica» anche per docenti e Segreteria, con la prop dedicata `scaricabile`
 * — senza Condividi e senza «Segnala», che sono gesti del genitore.
 */

type ArgomentoScaricaMedia = {
  url: string
  nomeFile: string
  tipo: 'foto' | 'video'
  titolo?: string
  etichetta?: string
}

// I doppi sono TIPIZZATI: senza gli argomenti dichiarati, `mock.calls[0][0]` è
// una tupla vuota per TypeScript e il gate `tsc --noEmit` cade.
const scaricaMediaMock = vi.hoisted(() =>
  vi.fn<(input: ArgomentoScaricaMedia) => Promise<{ esito: string; motivo?: string }>>(),
)
const condividiLinkMock = vi.hoisted(() =>
  vi.fn<(input: { url?: string; title?: string; text?: string }) => Promise<string>>(),
)
type ArgomentoCondividiMedia = ArgomentoScaricaMedia & { chiave: string }
const condividiMediaMock = vi.hoisted(() =>
  vi.fn<(input: ArgomentoCondividiMedia) => Promise<{ esito: string; motivo?: string; annullata?: boolean }>>(),
)
/** Il dispositivo sa condividere un FILE? Sul web di jsdom no (`navigator.canShare` non esiste). */
const puoCondividereMock = vi.hoisted(() => vi.fn<() => boolean>())
const logClientMock = vi.hoisted(() => vi.fn())
/** L'helper VERO, per il caso che deve passare dal suo log e non da un finto. */
const vero = vi.hoisted(() => ({ scaricaMedia: null as null | ((i: ArgomentoScaricaMedia) => Promise<unknown>) }))

vi.mock('@/lib/native/scarica', async () => {
  // `nomeFileScarico` NON si finge: il nome del file è metà della correzione, e
  // un doppio finto lo direbbe giusto qualunque cosa faccia il vero.
  const modulo = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica')
  vero.scaricaMedia = modulo.scaricaMedia as unknown as (i: ArgomentoScaricaMedia) => Promise<unknown>
  // Anche `condividiMedia` e `puoCondividereFileMedia` sono finte: la griglia deve CHIAMARLE
  // con gli argomenti giusti, ciò che fanno lo prova `condividi-media.test.ts`.
  return {
    ...modulo,
    scaricaMedia: scaricaMediaMock,
    condividiMedia: condividiMediaMock,
    puoCondividereFileMedia: puoCondividereMock,
  }
})
// `condividiLink` resta DEFINITO e finto per una ragione sola: se un domani «Condividi» tornasse
// a mandare il link che scade, i test qui sotto lo vedrebbero chiamato.
vi.mock('@/lib/native/share', () => ({ condividiLink: condividiLinkMock, condividiFileLocale: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: logClientMock, nomeErrore: () => 'Error' }))
vi.mock('@/components/features/segnalazioni/SegnalaContenuto', () => ({
  // Un segnaposto VISIBILE, non `null`: il test sullo staff deve poter dire che
  // la segnalazione NON c'è, e un finto che non rende niente lo direbbe sempre.
  SegnalaContenuto: () => <span data-testid="segnala-contenuto" />,
}))

/** next-intl con il catalogo VERO: le etichette devono esistere davvero. */
vi.mock('next-intl', async () => {
  const shared = (await import('../../messages/it/shared.json')).default as Record<string, string>
  const useTranslations = () => {
    const t = (chiave: string) => shared[chiave] ?? chiave
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  }
  return { useTranslations }
})

import { MediaGrid, type MediaItem } from '@/components/features/gallery/MediaGrid'

const URL_FIRMATO =
  'https://esempio.supabase.co/storage/v1/object/sign/gallery/uploads/abc/foto.jpg?token=xyz'
const URL_VIDEO =
  'https://esempio.supabase.co/storage/v1/object/sign/gallery/uploads/abc/clip.mp4?token=xyz'

const VOCE: MediaItem = {
  id: 'm1',
  file_url: URL_FIRMATO,
  file_type: 'foto',
  // Didascalia di fantasia: in questo repo non entrano nomi veri di bambini.
  caption: 'Laboratorio dei colori',
  tag_students: [],
  is_broadcast: false,
  created_at: new Date().toISOString(),
  uploader_name: 'Insegnante',
}

const VIDEO: MediaItem = {
  ...VOCE,
  id: 'm2',
  file_url: URL_VIDEO,
  file_type: 'video',
  caption: 'Recita di fine anno',
}

/** Apre il visore del media indicato (per la foto: la miniatura; per il video: la card). */
function apriVisore(etichettaCard: string) {
  fireEvent.click(screen.getByRole('button', { name: etichettaCard }))
  return screen.getByRole('dialog')
}

describe('MediaGrid — lo scarico lato genitore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scaricaMediaMock.mockResolvedValue({ esito: 'web-blob' })
    condividiMediaMock.mockResolvedValue({ esito: 'nativo-foglio' })
    puoCondividereMock.mockReturnValue(true)
    condividiLinkMock.mockResolvedValue('foglio')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('la card e il visore chiamano la STESSA funzione con lo STESSO argomento', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    // 1) Il pulsante sulla card (si distingue per il `title`, prima che il
    //    visore esista: dopo ce ne sarebbero due con lo stesso nome).
    const sullaCard = screen.getByTitle('Scarica')
    fireEvent.click(sullaCard)
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))

    // 2) Si apre il visore e si preme il suo «Scarica», che è un ALTRO elemento.
    fireEvent.click(screen.getByAltText('Laboratorio dei colori'))
    const tutti = await screen.findAllByRole('button', { name: 'Scarica' })
    const nelVisore = tutti.find((b) => b !== sullaCard)
    expect(nelVisore).toBeDefined()
    fireEvent.click(nelVisore!)
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(2))

    // È il lock: due punti, un solo comportamento.
    expect(scaricaMediaMock.mock.calls[1][0]).toEqual(scaricaMediaMock.mock.calls[0][0])
  })

  it('passa dall’helper 1.1 con nome CON estensione, tipo `foto` ed etichetta `gallery`', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))

    expect(scaricaMediaMock.mock.calls[0][0]).toEqual({
      url: URL_FIRMATO,
      nomeFile: 'Laboratorio dei colori.jpg',
      tipo: 'foto',
      titolo: 'Laboratorio dei colori',
      etichetta: 'gallery',
    })
  })

  it('un VIDEO si dichiara `video`: con `foto` finirebbe in `savePhoto` e la Galleria lo rifiuterebbe', async () => {
    render(<MediaGrid items={[VIDEO]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))

    expect(scaricaMediaMock.mock.calls[0][0]).toMatchObject({
      url: URL_VIDEO,
      nomeFile: 'Recita di fine anno.mp4',
      tipo: 'video',
    })
  })

  it('il log dell’esito lo scrive l’helper: `MediaGrid` non aggiunge una seconda riga', async () => {
    // Qualunque esito: se `MediaGrid` rilogga, qui compare una riga sua.
    scaricaMediaMock.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-403|condivisione-non-riuscita' })
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))
    // Si aspetta che la promessa sia risolta (il `finally` rilascia la guardia):
    // un secondo clic che riparte prova che il primo è arrivato in fondo.
    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(2))

    expect(logClientMock).not.toHaveBeenCalled()
  })

  it('con l’helper VERO sul web: UNA sola riga in `app_log`, successo compreso, coi campi dell’helper', async () => {
    // Il web vero di jsdom: `fetch` → `blob:` → ancora `download`.
    scaricaMediaMock.mockImplementation((input) => vero.scaricaMedia!(input) as Promise<{ esito: string }>)
    // ⚠️ Il corpo è un Uint8Array, MAI un `new Blob(...)`: in jsdom il Blob non ha
    // `stream()`, e `new Response(<Blob di jsdom>)` in Node 22 (la CI) lancia
    // `object.stream is not a function` — l'helper finiva nel ripiego e l'ancora non
    // partiva — mentre in Node 24 usciva il TESTO «[object Blob]» al posto della foto.
    // Per questo sotto si asseriscono i BYTE e il tipo arrivati a `createObjectURL`.
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const fetchMock = vi.fn(async () => new Response(JPEG, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const creaIndirizzo = vi.fn((oggetto: Blob) => {
      void oggetto
      return 'blob:kidville/1'
    })
    const revoca = vi.fn()
    const originaleCrea = URL.createObjectURL
    const originaleRevoca = URL.revokeObjectURL
    URL.createObjectURL = creaIndirizzo as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revoca as unknown as typeof URL.revokeObjectURL
    const clic = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      render(<MediaGrid items={[VOCE]} showActions />)
      fireEvent.click(screen.getByTitle('Scarica'))
      await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))

      expect(fetchMock).toHaveBeenCalledWith(URL_FIRMATO)
      // Il file che l'ancora scarica è la FOTO: byte e tipo, non «[object Blob]».
      expect(creaIndirizzo).toHaveBeenCalledTimes(1)
      const file = creaIndirizzo.mock.calls[0][0]
      expect(file.type).toBe('image/jpeg')
      expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(JPEG))
      expect(clic).toHaveBeenCalledTimes(1)
      const ancora = clic.mock.contexts[0] as HTMLAnchorElement
      expect(ancora.getAttribute('href')).toBe('blob:kidville/1')
      expect(ancora.download).toBe('Laboratorio dei colori.jpg')
      // ⚠️ NESSUN campo `route`: `logClient` la rotta se la legge da sé, e una
      // costante renderebbe indistinguibili le quattro superfici della galleria.
      expect(logClientMock).toHaveBeenCalledWith({
        livello: 'warn',
        evento: 'fetch',
        messaggio: 'gallery-scarico-riuscito:web-blob',
        campi: { esito: 'web-blob', operazione: 'scarico', piattaforma: 'web' },
      })
    } finally {
      URL.createObjectURL = originaleCrea
      URL.revokeObjectURL = originaleRevoca
      vi.unstubAllGlobals()
    }
  })

  it('il ripiego sul foglio NON avvisa: il foglio è già a schermo', async () => {
    scaricaMediaMock.mockResolvedValue({ esito: 'ripiego-condivisione', motivo: 'plugin-assenti:media' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    expect(avviso).not.toHaveBeenCalled()
  })

  it('lo scarico finito NEGLI APPUNTI avvisa: una copia muta si legge come un pulsante rotto', async () => {
    scaricaMediaMock.mockResolvedValue({ esito: 'ripiego-appunti', motivo: 'http-403' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))

    // Il testo viene dal catalogo VERO (`messages/it/shared.json`).
    expect(avviso).toHaveBeenCalledWith('Link copiato negli appunti!')
  })

  it('app 1.1: il salvataggio DIRETTO in Galleria conferma, perché non apre nessun foglio', async () => {
    scaricaMediaMock.mockResolvedValue({ esito: 'nativo-galleria' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))

    // Catalogo VERO: senza la chiave `t` restituirebbe il nome della chiave.
    expect(avviso).toHaveBeenCalledWith('Salvato nella Galleria del telefono')
  })

  it('lo scarico NON RIUSCITO lo dice: l’utente non ha niente e altrimenti nessuno glielo direbbe', async () => {
    scaricaMediaMock.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-403|condivisione-non-riuscita' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))

    expect(avviso).toHaveBeenCalledWith('Scaricamento non riuscito, riprova')
  })

  it('un gesto ANNULLATO non è un guasto: niente avviso d’errore', async () => {
    scaricaMediaMock.mockResolvedValue({ esito: 'non-riuscito', motivo: 'annullato' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))
    // Si aspetta una PRESENZA: il secondo clic riparte solo dopo il `finally`
    // del primo, cioè dopo che il ramo degli avvisi è già stato valutato.
    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(2))

    expect(avviso).not.toHaveBeenCalled()
  })

  it('la pressione scartata perché uno scarico è già in corso lascia una riga', async () => {
    // L'helper può NON RISOLVERE (fetch cross-origin muta nella WebView): da quel
    // momento ogni pressione esce dalla guardia, e deve dirlo.
    scaricaMediaMock.mockReturnValue(new Promise<{ esito: string }>(() => {}))
    render(<MediaGrid items={[VOCE]} showActions />)

    const bottone = screen.getByTitle('Scarica')
    fireEvent.click(bottone)
    fireEvent.click(bottone)

    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))
    expect(scaricaMediaMock).toHaveBeenCalledTimes(1)
    expect(logClientMock).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-scarico-gia-in-corso',
    })
  })

  it('la condivisione consegna il FILE: condividiMedia con chiave = id del media, mai condividiLink', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Condividi'))
    await waitFor(() => expect(condividiMediaMock).toHaveBeenCalledTimes(1))

    expect(condividiMediaMock.mock.calls[0][0]).toEqual({
      url: URL_FIRMATO,
      // Con estensione: il nome finisce nel foglio di condivisione e nel file temporaneo.
      nomeFile: 'Laboratorio dei colori.jpg',
      tipo: 'foto',
      titolo: 'Laboratorio dei colori',
      etichetta: 'gallery',
      // L'identità STABILE del media: l'URL firmato cambia a ogni ricarico dell'elenco.
      chiave: 'm1',
    })
    // Il link firmato scade dopo 10 minuti: chi lo riceve su WhatsApp mezz'ora dopo trova un
    // errore. «Condividi» non lo manda MAI.
    expect(condividiLinkMock).not.toHaveBeenCalled()
  })

  it('card e visore condividono con la stessa funzione e lo stesso argomento', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    // 1) Il pulsante sulla card (si distingue per il `title`, prima che il visore esista).
    const sullaCard = screen.getByTitle('Condividi')
    fireEvent.click(sullaCard)
    await waitFor(() => expect(condividiMediaMock).toHaveBeenCalledTimes(1))

    // 2) Il visore, dalla sua riga dei comandi: è un ALTRO elemento.
    const visore = apriVisore('Foto: Laboratorio dei colori')
    const nelVisore = within(within(visore).getByTestId('visore-comandi')).getByRole('button', { name: 'Condividi' })
    expect(nelVisore).not.toBe(sullaCard)
    fireEvent.click(nelVisore)
    await waitFor(() => expect(condividiMediaMock).toHaveBeenCalledTimes(2))

    // È il lock: due punti, un solo comportamento.
    expect(condividiMediaMock.mock.calls[1][0]).toEqual(condividiMediaMock.mock.calls[0][0])
    expect(condividiLinkMock).not.toHaveBeenCalled()
  })

  it('una condivisione NON riuscita lo dice, e non ripiega mai sul link: altrimenti sembra rotto', async () => {
    // Era «la copia negli appunti è muta»: il ripiego sul link che scade è sparito, ma il
    // difetto da cui nasceva resta in agguato — un pulsante che non fa niente e non dice perché.
    condividiMediaMock.mockResolvedValueOnce({ esito: 'non-riuscita', motivo: 'http-403' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Condividi'))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))

    expect(avviso).toHaveBeenCalledWith('Condivisione non riuscita. Riprova fra qualche minuto.')
    expect(condividiLinkMock).not.toHaveBeenCalled()
  })

  it('la card e il visore usano UNA guardia sola: un’azione in corso su una card ferma anche le altre', async () => {
    // Due card, un solo foglio di sistema alla volta: su iOS presentarne un secondo mentre il
    // primo è aperto solleva. La guardia è della griglia, non della singola card.
    const seconda: MediaItem = { ...VOCE, id: 'm3', caption: 'Orto in giardino' }
    condividiMediaMock.mockReturnValue(new Promise(() => {}))
    render(<MediaGrid items={[VOCE, seconda]} showActions />)

    const [primaCard, secondaCard] = screen.getAllByTitle('Condividi')
    fireEvent.click(primaCard)
    fireEvent.click(secondaCard)

    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))
    expect(condividiMediaMock).toHaveBeenCalledTimes(1)
    expect(logClientMock).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-azione-gia-in-corso',
    })
  })

  /** L'indicatore «in preparazione» sulla card: spinner al posto dell'icona + `aria-busy` + testo per chi non vede. */
  function indicatore(bottone: HTMLElement) {
    return {
      occupato: bottone.getAttribute('aria-busy') === 'true',
      spinner: bottone.querySelector('svg.animate-spin') !== null,
      testo: within(bottone).queryByText('Preparo…') !== null,
    }
  }

  it('sulla card Condividi mostra «in preparazione» mentre il file si prepara, SENZA spegnersi: il secondo tocco arriva alla guardia', async () => {
    // Per un video sono parecchi secondi: senza un segnale la card sembra rotta, ed è il difetto
    // da cui nasce questo lavoro. Il pulsante NON è `disabled` (né `aria-disabled` con il click
    // ignorato): la guardia dell'hook resta l'unica a scartare il secondo tocco, e a loggarlo.
    let risolviCondivisione!: () => void
    const lavoro = new Promise<{ esito: string }>((risolvi) => {
      risolviCondivisione = () => risolvi({ esito: 'nativo-foglio' })
    })
    condividiMediaMock.mockReturnValue(lavoro)
    const seconda: MediaItem = { ...VOCE, id: 'm3', caption: 'Orto in giardino' }
    render(<MediaGrid items={[VOCE, seconda]} showActions />)

    const [primaCard, secondaCard] = screen.getAllByTitle('Condividi')
    expect(indicatore(primaCard)).toEqual({ occupato: false, spinner: false, testo: false })

    fireEvent.click(primaCard)
    await waitFor(() => expect(indicatore(primaCard).occupato).toBe(true))
    expect(indicatore(primaCard)).toEqual({ occupato: true, spinner: true, testo: true })
    expect(primaCard).not.toBeDisabled()
    expect(primaCard.getAttribute('aria-disabled')).toBeNull()
    // Il `title` resta quello di sempre (l'individuano i test e chi passa il mouse), e solo la
    // card che lavora cambia: le altre non si accorgono di niente.
    expect(primaCard.getAttribute('title')).toBe('Condividi')
    expect(indicatore(secondaCard)).toEqual({ occupato: false, spinner: false, testo: false })

    // Il secondo tocco SULLA STESSA card passa alla guardia: nessuna seconda condivisione, una riga.
    fireEvent.click(primaCard)
    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))
    expect(condividiMediaMock).toHaveBeenCalledTimes(1)
    expect(logClientMock).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-azione-gia-in-corso',
    })
    // E la pressione scartata NON spegne l'indicatore della prima, che sta ancora lavorando.
    expect(indicatore(primaCard)).toEqual({ occupato: true, spinner: true, testo: true })

    // Finito il lavoro l'indicatore sparisce, e il pulsante è quello di prima.
    risolviCondivisione()
    await waitFor(() => expect(indicatore(primaCard).occupato).toBe(false))
    expect(indicatore(primaCard)).toEqual({ occupato: false, spinner: false, testo: false })
  })

  it('anche Scarica sulla card mostra l’indicatore, senza spegnersi, e il secondo tocco si logga come sempre', async () => {
    let risolviScarico!: () => void
    scaricaMediaMock.mockReturnValue(new Promise<{ esito: string }>((risolvi) => {
      risolviScarico = () => risolvi({ esito: 'web-blob' })
    }))
    render(<MediaGrid items={[VOCE]} showActions />)

    const bottone = screen.getByTitle('Scarica')
    fireEvent.click(bottone)
    await waitFor(() => expect(indicatore(bottone).occupato).toBe(true))
    expect(indicatore(bottone)).toEqual({ occupato: true, spinner: true, testo: true })
    expect(bottone).not.toBeDisabled()
    // Condividi, sulla stessa card, non dice «Preparo…»: non è lui che lavora.
    expect(indicatore(screen.getByTitle('Condividi'))).toEqual({ occupato: false, spinner: false, testo: false })

    fireEvent.click(bottone)
    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))
    expect(scaricaMediaMock).toHaveBeenCalledTimes(1)
    expect(logClientMock).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-scarico-gia-in-corso',
    })
    expect(indicatore(bottone).occupato).toBe(true)

    risolviScarico()
    await waitFor(() => expect(indicatore(bottone).occupato).toBe(false))
  })

  it('senza condivisione di file (web senza canShare) Condividi non c’è né sulla card né nel visore; Scarica sì', () => {
    // Un «Condividi» che manda un link da 10 minuti è il difetto che si toglie, e uno che
    // scarica dicendo «Condividi» mentirebbe: il pulsante non compare.
    puoCondividereMock.mockReturnValue(false)
    render(<MediaGrid items={[VOCE]} showActions />)

    expect(screen.getByTitle('Scarica')).toBeTruthy()
    expect(screen.queryByTitle('Condividi')).toBeNull()
    const visore = apriVisore('Foto: Laboratorio dei colori')
    const comandi = within(visore).getByTestId('visore-comandi')
    expect(within(comandi).getByRole('button', { name: 'Scarica' })).toBeTruthy()
    expect(within(comandi).queryByRole('button', { name: 'Condividi' })).toBeNull()
    // «Segnala» è del genitore e non dipende dal foglio di sistema.
    expect(within(comandi).getByTestId('segnala-contenuto')).toBeTruthy()
  })

  it('col genitore il visore porta anche Condividi e «Segnala»', () => {
    render(<MediaGrid items={[VOCE]} showActions />)
    const visore = apriVisore('Foto: Laboratorio dei colori')

    expect(visore.querySelector('[data-testid="segnala-contenuto"]')).not.toBeNull()
    // Solo dentro i comandi del VISORE: il Condividi della card resta nel DOM (è
    // `inert`, e testing-library non esclude i nodi `inert`), quindi un conteggio
    // su tutto lo schermo sarebbe verde anche senza Condividi nel visore.
    const comandi = within(visore).getByTestId('visore-comandi')
    expect(within(comandi).getByRole('button', { name: 'Condividi' })).toBeTruthy()
  })
})

describe('MediaGrid — «Scarica» per docenti e Segreteria (`scaricabile`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scaricaMediaMock.mockResolvedValue({ esito: 'nativo-galleria' })
    // Il dispositivo SAPREBBE condividere: così «Condividi non c'è» dipende dal ruolo (lo staff ha
    // il solo «Scarica»), non da un dispositivo che non può.
    puoCondividereMock.mockReturnValue(true)
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('anche per lo staff il salvataggio in Galleria si conferma a schermo', async () => {
    render(<MediaGrid items={[VIDEO]} scaricabile />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1))

    expect(window.alert).toHaveBeenCalledWith('Salvato nella Galleria del telefono')
  })

  it('sulla card: «Scarica» c’è, Condividi NO', async () => {
    render(<MediaGrid items={[VOCE]} scaricabile onDelete={async () => {}} />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))
    expect(scaricaMediaMock.mock.calls[0][0]).toEqual({
      url: URL_FIRMATO,
      nomeFile: 'Laboratorio dei colori.jpg',
      tipo: 'foto',
      titolo: 'Laboratorio dei colori',
      etichetta: 'gallery',
    })
    expect(screen.queryByTitle('Condividi')).toBeNull()
  })

  it('nel visore: «Scarica» c’è (e scarica il VIDEO come video), Condividi e «Segnala» NO', async () => {
    render(<MediaGrid items={[VIDEO]} scaricabile onDelete={async () => {}} />)
    const visore = apriVisore('Video: Recita di fine anno')

    const comandi = screen.getByTestId('visore-comandi')
    expect(visore.contains(comandi)).toBe(true)
    const nelVisore = Array.from(comandi.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Scarica'),
    )
    expect(nelVisore).toBeDefined()
    fireEvent.click(nelVisore!)
    await waitFor(() => expect(scaricaMediaMock).toHaveBeenCalledTimes(1))
    expect(scaricaMediaMock.mock.calls[0][0]).toMatchObject({ url: URL_VIDEO, tipo: 'video' })

    expect(screen.queryByRole('button', { name: 'Condividi' })).toBeNull()
    expect(screen.queryByTestId('segnala-contenuto')).toBeNull()
    // Elimina resta dov'era: il solo scarico non toglie niente allo staff.
    expect(screen.getByRole('button', { name: /Elimina Media/ })).toBeTruthy()
  })

  it('senza `scaricabile` né `showActions` non c’è nessuno «Scarica» (il default non cambia)', () => {
    render(<MediaGrid items={[VOCE]} onDelete={async () => {}} />)
    expect(screen.queryByTitle('Scarica')).toBeNull()
    apriVisore('Foto: Laboratorio dei colori')
    expect(screen.queryByRole('button', { name: 'Scarica' })).toBeNull()
    expect(screen.queryByTestId('visore-comandi')).toBeNull()
  })

  it('senza indirizzo firmato non resta una riga di comandi vuota nel visore', () => {
    render(<MediaGrid items={[{ ...VOCE, file_url: null }]} scaricabile />)
    expect(screen.queryByTitle('Scarica')).toBeNull()
    apriVisore('Foto: Laboratorio dei colori')
    expect(screen.queryByTestId('visore-comandi')).toBeNull()
  })
})
