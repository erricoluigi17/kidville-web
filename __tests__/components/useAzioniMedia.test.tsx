import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, renderHook } from '@testing-library/react'
import { renderToString } from 'react-dom/server'

/**
 * SCARICA E CONDIVIDI, IN UN POSTO SOLO — `useAzioniMedia` e la riga `ComandiMedia`.
 *
 * Prima la guardia «un'azione alla volta» e gli `alert` d'esito stavano dentro `MediaGrid`
 * e servivano solo la galleria. Ora le usano anche il visore della chat (genitore, docente,
 * segreteria, supervisione): qui si fissa ciò che deve restare vero ovunque.
 *
 *  · UNA guardia per scarico E condivisione: due fogli di sistema insieme fanno sollevare
 *    iOS, e su nativo la seconda pressione riscriverebbe lo stesso file mentre lo si consegna;
 *  · gli avvisi a schermo sono dell'hook, il LOG dell'esito è dell'helper (`condividiMedia`
 *    logga da sé: una seconda riga sarebbe un contatore raddoppiato in `app_log`);
 *  · «Condividi» manda il FILE: l'hook non nomina mai `condividiLink`.
 */

type RispostaScarico = { esito: string; motivo?: string }
type RispostaCondivisione = { esito: string; motivo?: string; annullata?: boolean }

const h = vi.hoisted(() => ({
  scaricaMedia: vi.fn<(input: Record<string, unknown>) => Promise<{ esito: string; motivo?: string }>>(),
  condividiMedia: vi.fn<
    (input: Record<string, unknown>) => Promise<{ esito: string; motivo?: string; annullata?: boolean }>
  >(),
  puoCondividere: vi.fn<() => boolean>(),
  condividiLink: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/native/scarica', async () => {
  // `nomeFileScarico` resta il VERO: il nome del file è metà della correzione, e un doppio
  // finto lo direbbe giusto qualunque cosa faccia il vero.
  const vero = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica')
  return {
    ...vero,
    scaricaMedia: h.scaricaMedia,
    condividiMedia: h.condividiMedia,
    puoCondividereFileMedia: h.puoCondividere,
  }
})
// Il link che scade: NON deve più essere raggiungibile da «Condividi».
vi.mock('@/lib/native/share', () => ({ condividiLink: h.condividiLink, condividiFileLocale: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

import { useAzioniMedia, type MediaAzionabile, type AzioniMedia } from '@/components/features/media/useAzioniMedia'
import { ComandiMedia } from '@/components/features/media/ComandiMedia'

// Dati di fantasia: nessun nome o uuid reale.
const URL_FIRMATO =
  'https://esempio.supabase.co/storage/v1/object/sign/chat-allegati/aaaa/bbbb/foto.jpg?token=xyz'
const FOTO: MediaAzionabile = {
  id: '11111111-1111-4111-8111-111111111111',
  url: URL_FIRMATO,
  tipo: 'foto',
  nomeFile: null,
}

/** Una promessa che si risolve quando lo decide il test: l'azione «al lavoro». */
function differita<T>() {
  let risolvi!: (valore: T) => void
  const promessa = new Promise<T>((r) => {
    risolvi = r
  })
  return { promessa, risolvi }
}

const MESSAGGIO_GIA_IN_CORSO = (messaggio: string) => ({ livello: 'warn', evento: 'fetch', messaggio })

describe('useAzioniMedia — la guardia «un’azione alla volta»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.puoCondividere.mockReturnValue(true)
    h.scaricaMedia.mockResolvedValue({ esito: 'web-blob' })
    h.condividiMedia.mockResolvedValue({ esito: 'nativo-foglio' })
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('due tocchi rapidi su Condividi: una sola condividiMedia e una riga azione-gia-in-corso', async () => {
    const lavoro = differita<RispostaCondivisione>()
    h.condividiMedia.mockReturnValue(lavoro.promessa)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat' }))

    let primo!: Promise<void>
    let secondo!: Promise<void>
    act(() => {
      primo = result.current.condividi(FOTO)
      secondo = result.current.condividi(FOTO)
    })
    await act(async () => {
      await secondo
    })

    expect(h.condividiMedia).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledTimes(1)
    // Il nome «gallery-scarico-gia-in-corso» è solo dello scarico in Foto: tutto il resto
    // porta la propria etichetta.
    expect(h.logClient).toHaveBeenCalledWith(MESSAGGIO_GIA_IN_CORSO('chat-azione-gia-in-corso'))

    await act(async () => {
      lavoro.risolvi({ esito: 'nativo-foglio' })
      await primo
    })
    // Finita la prima, la guardia si libera: il tocco successivo parte.
    await act(async () => {
      await result.current.condividi(FOTO)
    })
    expect(h.condividiMedia).toHaveBeenCalledTimes(2)
  })

  it('uno scarico in corso blocca anche Condividi', async () => {
    const lavoro = differita<RispostaScarico>()
    h.scaricaMedia.mockReturnValue(lavoro.promessa)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'gallery' }))

    let scarico!: Promise<void>
    act(() => {
      scarico = result.current.scarica(FOTO)
    })
    await act(async () => {
      await result.current.condividi(FOTO)
    })

    expect(h.condividiMedia).not.toHaveBeenCalled()
    // In Foto, una CONDIVISIONE scartata non prende il nome dello scarico.
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(MESSAGGIO_GIA_IN_CORSO('gallery-azione-gia-in-corso'))

    await act(async () => {
      lavoro.risolvi({ esito: 'web-blob' })
      await scarico
    })
  })

  it('e una condivisione in corso blocca lo scarico (il nome lo decide l’azione scartata)', async () => {
    const lavoro = differita<RispostaCondivisione>()
    h.condividiMedia.mockReturnValue(lavoro.promessa)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'gallery' }))

    let condivisione!: Promise<void>
    act(() => {
      condivisione = result.current.condividi(FOTO)
    })
    await act(async () => {
      await result.current.scarica(FOTO)
    })

    expect(h.scaricaMedia).not.toHaveBeenCalled()
    // La pressione scartata è uno SCARICO in Foto: il nome è quello che `app_log` conta già.
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(MESSAGGIO_GIA_IN_CORSO('gallery-scarico-gia-in-corso'))

    await act(async () => {
      lavoro.risolvi({ esito: 'nativo-foglio' })
      await condivisione
    })
  })

  it('due scarichi di fila in Foto lasciano il nome di sempre: gallery-scarico-gia-in-corso', async () => {
    // Il nome è già contato in `app_log`: cambiarlo spezzerebbe la serie storica.
    const lavoro = differita<RispostaScarico>()
    h.scaricaMedia.mockReturnValue(lavoro.promessa)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'gallery' }))

    let primo!: Promise<void>
    act(() => {
      primo = result.current.scarica(FOTO)
    })
    await act(async () => {
      await result.current.scarica(FOTO)
    })

    expect(h.scaricaMedia).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(MESSAGGIO_GIA_IN_CORSO('gallery-scarico-gia-in-corso'))
    await act(async () => {
      lavoro.risolvi({ esito: 'web-blob' })
      await primo
    })
  })

  it('fuori da Foto anche lo scarico scartato porta la propria etichetta', async () => {
    const lavoro = differita<RispostaScarico>()
    h.scaricaMedia.mockReturnValue(lavoro.promessa)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat-vigilanza' }))

    let primo!: Promise<void>
    act(() => {
      primo = result.current.scarica(FOTO)
    })
    await act(async () => {
      await result.current.scarica(FOTO)
    })

    expect(h.logClient).toHaveBeenCalledWith(MESSAGGIO_GIA_IN_CORSO('chat-vigilanza-azione-gia-in-corso'))
    await act(async () => {
      lavoro.risolvi({ esito: 'web-blob' })
      await primo
    })
  })

  it('la guardia si libera anche se l’helper lancia: il pulsante non resta incagliato', async () => {
    h.condividiMedia.mockRejectedValueOnce(new Error('imprevisto'))
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat' }))

    await act(async () => {
      await expect(result.current.condividi(FOTO)).rejects.toThrow('imprevisto')
    })
    await act(async () => {
      await result.current.condividi(FOTO)
    })

    expect(h.condividiMedia).toHaveBeenCalledTimes(2)
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

describe('useAzioniMedia — Condividi consegna il FILE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.puoCondividere.mockReturnValue(true)
    h.scaricaMedia.mockResolvedValue({ esito: 'web-blob' })
    h.condividiMedia.mockResolvedValue({ esito: 'nativo-foglio' })
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('chiama condividiMedia con la chiave = id del media, il nome con estensione e il titolo neutro', async () => {
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat' }))

    await act(async () => {
      await result.current.condividi(FOTO)
    })

    expect(h.condividiMedia).toHaveBeenCalledTimes(1)
    expect(h.condividiMedia.mock.calls[0][0]).toEqual({
      url: URL_FIRMATO,
      // Senza nome dichiarato lo ricava dal percorso: `foto.jpg` → base neutra + estensione.
      nomeFile: 'kidville-foto.jpg',
      tipo: 'foto',
      titolo: 'Foto da Kidville',
      etichetta: 'chat',
      // L'identità STABILE: l'URL cambia a ogni rifirma, e il file «pronto» del secondo
      // tocco si ritrova per questa chiave.
      chiave: FOTO.id,
    })
    expect(h.condividiLink).not.toHaveBeenCalled()
  })

  it('il titolo dichiarato dal chiamante vince su quello neutro; un video si dichiara video', async () => {
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'gallery' }))

    await act(async () => {
      await result.current.condividi({
        id: 'm2',
        url: 'https://esempio.supabase.co/storage/v1/object/sign/gallery/a/clip.mp4?token=xyz',
        tipo: 'video',
        nomeFile: 'Recita di fine anno',
        titolo: 'Recita di fine anno',
      })
    })

    expect(h.condividiMedia.mock.calls[0][0]).toMatchObject({
      nomeFile: 'Recita di fine anno.mp4',
      tipo: 'video',
      titolo: 'Recita di fine anno',
      etichetta: 'gallery',
      chiave: 'm2',
    })
  })

  it('l’hook non logga l’esito della condivisione: lo fa l’helper, e due righe raddoppiano i successi', async () => {
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat' }))

    for (const esito of ['nativo-foglio', 'web-foglio', 'web-gesto-scaduto', 'non-riuscita'] as const) {
      h.condividiMedia.mockResolvedValueOnce({ esito })
      await act(async () => {
        await result.current.condividi(FOTO)
      })
    }

    expect(h.logClient).not.toHaveBeenCalled()
  })

  const AVVISI: { nome: string; risposta: RispostaCondivisione; avviso: string | null }[] = [
    {
      nome: 'gesto scaduto → «tocca di nuovo»',
      risposta: { esito: 'web-gesto-scaduto' },
      avviso: 'Il file è pronto: tocca di nuovo «Condividi».',
    },
    {
      nome: 'app 1.0 → «aggiorna l’app»',
      risposta: { esito: 'app-da-aggiornare', motivo: 'plugin-assenti:filesystem' },
      avviso: 'Per condividere il file aggiorna l’app Kidville dallo store.',
    },
    {
      nome: 'non riuscita → avviso',
      risposta: { esito: 'non-riuscita', motivo: 'http-403' },
      avviso: 'Condivisione non riuscita. Riprova fra qualche minuto.',
    },
    {
      nome: 'non supportato → lo stesso avviso (il pulsante non dovrebbe esserci)',
      risposta: { esito: 'non-supportato', motivo: 'condivisione-file-assente' },
      avviso: 'Condivisione non riuscita. Riprova fra qualche minuto.',
    },
    // Il foglio è a schermo, o il gesto è stato ritirato da chi lo aveva chiesto: niente da dire.
    { nome: 'foglio nativo aperto → nessun avviso', risposta: { esito: 'nativo-foglio' }, avviso: null },
    { nome: 'foglio web aperto → nessun avviso', risposta: { esito: 'web-foglio' }, avviso: null },
    {
      nome: 'foglio web chiuso dall’utente → nessun avviso',
      risposta: { esito: 'web-foglio', annullata: true },
      avviso: null,
    },
    {
      nome: 'gesto ritirato col segnale → nessun avviso (non è un guasto)',
      risposta: { esito: 'non-riuscita', motivo: 'annullato' },
      avviso: null,
    },
  ]

  it.each(AVVISI)('$nome', async ({ risposta, avviso }) => {
    h.condividiMedia.mockResolvedValue(risposta)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat' }))

    await act(async () => {
      await result.current.condividi(FOTO)
    })

    if (avviso === null) {
      expect(window.alert).not.toHaveBeenCalled()
    } else {
      expect(window.alert).toHaveBeenCalledTimes(1)
      // Catalogo VERO (`messages/it/shared.json`): una chiave mancante direbbe `shared.<chiave>`.
      expect(window.alert).toHaveBeenCalledWith(avviso)
    }
    // Qualunque sia l'esito, il link che scade non c'entra mai.
    expect(h.condividiLink).not.toHaveBeenCalled()
  })
})

describe('useAzioniMedia — lo scarico', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.puoCondividere.mockReturnValue(true)
    h.scaricaMedia.mockResolvedValue({ esito: 'web-blob' })
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('passa all’helper l’etichetta del chiamante, con nome CON estensione', async () => {
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'chat' }))

    await act(async () => {
      await result.current.scarica({ ...FOTO, nomeFile: 'Gita al parco' })
    })

    expect(h.scaricaMedia.mock.calls[0][0]).toEqual({
      url: URL_FIRMATO,
      nomeFile: 'Gita al parco.jpg',
      tipo: 'foto',
      titolo: 'Foto da Kidville',
      etichetta: 'chat',
    })
  })

  it.each<{ nome: string; risposta: RispostaScarico; avviso: string | null }>([
    { nome: 'appunti', risposta: { esito: 'ripiego-appunti' }, avviso: 'Link copiato negli appunti!' },
    { nome: 'Galleria', risposta: { esito: 'nativo-galleria' }, avviso: 'Salvato nella Galleria del telefono' },
    { nome: 'non riuscito', risposta: { esito: 'non-riuscito', motivo: 'http-403' }, avviso: 'Scaricamento non riuscito, riprova' },
    { nome: 'annullato', risposta: { esito: 'non-riuscito', motivo: 'annullato' }, avviso: null },
    { nome: 'foglio di ripiego', risposta: { esito: 'ripiego-condivisione' }, avviso: null },
  ])('esito $nome', async ({ risposta, avviso }) => {
    h.scaricaMedia.mockResolvedValue(risposta)
    const { result } = renderHook(() => useAzioniMedia({ etichetta: 'gallery' }))

    await act(async () => {
      await result.current.scarica(FOTO)
    })

    if (avviso === null) expect(window.alert).not.toHaveBeenCalled()
    else expect(window.alert).toHaveBeenCalledWith(avviso)
    // Il log dell'esito è dell'helper.
    expect(h.logClient).not.toHaveBeenCalled()
  })
})

describe('useAzioniMedia — puoCondividere', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('segue puoCondividereFileMedia, in un colpo solo e senza effetti', () => {
    h.puoCondividere.mockReturnValue(true)
    expect(renderHook(() => useAzioniMedia({ etichetta: 'chat' })).result.current.puoCondividere).toBe(true)

    h.puoCondividere.mockReturnValue(false)
    expect(renderHook(() => useAzioniMedia({ etichetta: 'chat' })).result.current.puoCondividere).toBe(false)
  })

  it('al render del SERVER vale false: la pagina non dichiara un pulsante che il browser potrebbe non avere', () => {
    h.puoCondividere.mockReturnValue(true)
    // Il valore visto dal server si legge nell'HTML che produce: niente variabili fuori dal componente.
    function Sonda() {
      const { puoCondividere } = useAzioniMedia({ etichetta: 'chat' })
      return <span data-puo-condividere={String(puoCondividere)} />
    }
    expect(renderToString(<Sonda />)).toContain('data-puo-condividere="false"')
  })
})

describe('ComandiMedia', () => {
  /** Le azioni come le consegna l'hook, ma finte: qui si prova la riga, non l'helper. */
  function azioniFinte(sovrascrivi: Partial<AzioniMedia> = {}): AzioniMedia {
    return {
      scarica: vi.fn(async () => {}),
      condividi: vi.fn(async () => {}),
      puoCondividere: true,
      ...sovrascrivi,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
  })

  it('col pulsante al lavoro è disabled, aria-busy e dice «Preparo…»', async () => {
    const lavoro = differita<void>()
    const azioni = azioniFinte({ condividi: vi.fn(() => lavoro.promessa) })
    render(<ComandiMedia media={FOTO} azioni={azioni} conScarica conCondividi />)

    fireEvent.click(screen.getByRole('button', { name: 'Condividi' }))

    const alLavoro = await screen.findByRole('button', { name: 'Preparo…' })
    expect(alLavoro).toBeDisabled()
    expect(alLavoro.getAttribute('aria-busy')).toBe('true')
    // L'altro pulsante non può partire (la guardia lo scarterebbe in silenzio): è spento,
    // ma non dice «Preparo…» perché non è lui che lavora.
    const scarica = screen.getByRole('button', { name: 'Scarica' })
    expect(scarica).toBeDisabled()
    expect(scarica.getAttribute('aria-busy')).toBeNull()

    await act(async () => {
      lavoro.risolvi()
      await lavoro.promessa
    })

    const condividi = screen.getByRole('button', { name: 'Condividi' })
    expect(condividi).not.toBeDisabled()
    expect(condividi.getAttribute('aria-busy')).toBeNull()
    expect(screen.getByRole('button', { name: 'Scarica' })).not.toBeDisabled()
    expect(screen.queryByText('Preparo…')).toBeNull()
  })

  it('Scarica e Condividi chiamano ciascuno la propria azione, con lo STESSO media', async () => {
    const azioni = azioniFinte()
    render(<ComandiMedia media={FOTO} azioni={azioni} conScarica conCondividi />)

    // Un'azione alla volta: si aspetta che la prima finisca prima di premere l'altra.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    })
    expect(azioni.scarica).toHaveBeenCalledWith(FOTO)
    expect(azioni.condividi).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Condividi' }))
    })
    expect(azioni.condividi).toHaveBeenCalledWith(FOTO)
    expect(azioni.scarica).toHaveBeenCalledTimes(1)
  })

  it('il doppio tocco su Scarica non arriva alla seconda azione: il pulsante è già spento', () => {
    const lavoro = differita<void>()
    const azioni = azioniFinte({ scarica: vi.fn(() => lavoro.promessa) })
    render(<ComandiMedia media={FOTO} azioni={azioni} conScarica conCondividi={false} />)

    const bottone = screen.getByRole('button', { name: 'Scarica' })
    fireEvent.click(bottone)
    fireEvent.click(bottone)

    expect(azioni.scarica).toHaveBeenCalledTimes(1)
  })

  it('senza puoCondividere Condividi non c’è, Scarica sì', () => {
    render(
      <ComandiMedia media={FOTO} azioni={azioniFinte({ puoCondividere: false })} conScarica conCondividi />,
    )

    expect(screen.getByRole('button', { name: 'Scarica' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Condividi' })).toBeNull()
  })

  it('con conCondividi spento Condividi non c’è nemmeno se il dispositivo saprebbe condividere', () => {
    render(<ComandiMedia media={FOTO} azioni={azioniFinte()} conScarica conCondividi={false} />)

    expect(screen.getByRole('button', { name: 'Scarica' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Condividi' })).toBeNull()
  })

  it('senza indirizzo (firma non riuscita) non ci sono né Scarica né Condividi; l’extra resta', () => {
    const { container, rerender } = render(
      <ComandiMedia media={{ ...FOTO, url: '' }} azioni={azioniFinte()} conScarica conCondividi />,
    )
    // Niente da mostrare: nemmeno una riga vuota con il suo margine.
    expect(container.firstChild).toBeNull()

    rerender(
      <ComandiMedia
        media={{ ...FOTO, url: '' }}
        azioni={azioniFinte()}
        conScarica
        conCondividi
        extra={<span data-testid="extra">Segnala</span>}
      />,
    )
    const riga = screen.getByTestId('visore-comandi')
    expect(riga.contains(screen.getByTestId('extra'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Scarica' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Condividi' })).toBeNull()
  })

  it('la riga porta il test-id del visore e va a capo invece di farsi tagliare', () => {
    render(
      <ComandiMedia
        media={FOTO}
        azioni={azioniFinte()}
        conScarica
        conCondividi
        extra={<span data-testid="extra">Segnala</span>}
      />,
    )
    const riga = screen.getByTestId('visore-comandi')
    expect(riga.className).toContain('flex-wrap')
    // Scarica, Condividi, poi l'extra: l'ordine di sempre.
    expect(Array.from(riga.children).map((n) => n.textContent)).toEqual(['Scarica', 'Condividi', 'Segnala'])
  })

  it('onScarica SOSTITUISCE lo scarico dell’hook, e il doppio tocco lo ferma lo stato del pulsante', async () => {
    const lavoro = differita<void>()
    const onScarica = vi.fn(() => lavoro.promessa)
    const azioni = azioniFinte()
    render(<ComandiMedia media={FOTO} azioni={azioni} conScarica conCondividi={false} onScarica={onScarica} />)

    const bottone = screen.getByRole('button', { name: 'Scarica' })
    fireEvent.click(bottone)
    fireEvent.click(bottone)

    expect(onScarica).toHaveBeenCalledTimes(1)
    expect(onScarica).toHaveBeenCalledWith(FOTO)
    expect(azioni.scarica).not.toHaveBeenCalled()
    const alLavoro = screen.getByRole('button', { name: 'Preparo…' })
    expect(alLavoro).toBeDisabled()

    await act(async () => {
      lavoro.risolvi()
      await lavoro.promessa
    })
    // Finita la promessa il pulsante torna premibile.
    expect(screen.getByRole('button', { name: 'Scarica' })).not.toBeDisabled()
  })

  it('un onScarica che lancia non lascia il pulsante incagliato: si logga e si ripristina', async () => {
    const onScarica = vi.fn(async () => {
      throw new Error('imprevisto')
    })
    render(<ComandiMedia media={FOTO} azioni={azioniFinte()} conScarica conCondividi={false} onScarica={onScarica} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scarica' }))
    })

    expect(screen.getByRole('button', { name: 'Scarica' })).not.toBeDisabled()
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch', messaggio: 'media-comando-lanciato' }),
    )
    // Il testo dell'errore non finisce nel log: solo il nome.
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('imprevisto')
  })
})
