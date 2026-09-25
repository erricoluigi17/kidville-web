import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

import itAvvisi from '../../messages/it/avvisi.json'
import itChat from '../../messages/it/parentChat.json'
import itPrimaria from '../../messages/it/parentPrimaria.json'
import itShared from '../../messages/it/shared.json'

/**
 * I DOWNLOAD DEL GENITORE PASSANO DALL'HELPER (spec 2026-09-24, compito NAT3c).
 *
 * Nella WebView un `<a target="_blank">`, un `window.open` e un `<a download>` su `blob:`
 * non fanno niente e non lo dicono. Qui si misura, punto per punto:
 *  - nell'APP: il clic ferma la navigazione (`defaultPrevented`) e chiama l'helper giusto
 *    — `apriDocumento` per ciò che si GUARDA (allegati, pagella), `scaricaDocumento` per
 *    ciò che si SALVA (certificato) — con la sorgente, il nome e l'etichetta attesi;
 *  - sul WEB: l'ancora resta un'ancora (niente `preventDefault`, nessun helper);
 *  - un esito senza consegna si DICE a schermo; un gesto annullato no.
 *
 * L'helper è finto di proposito: il suo comportamento ha i suoi test
 * (`__tests__/lib/scarica-helper-nativo.test.ts`). Qui conta CHI lo chiama e COME.
 */

const h = vi.hoisted(() => ({
  nativo: false,
  apri: vi.fn(),
  scarica: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('@/lib/push/native-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/native-register')>()),
  isNativeApp: () => h.nativo,
}))

vi.mock('@/lib/native/scarica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native/scarica')>()),
  apriDocumento: h.apri,
  scaricaDocumento: h.scarica,
}))

const GENITORE = 'e0000000-0000-4000-8000-00000000000e'
const ALUNNO = 'a0000000-0000-4000-8000-00000000000a'
const SCRUTINIO = 'b0000000-0000-4000-8000-00000000000b'

vi.mock('@/lib/auth/use-parent-identity', () => ({
  useParentIdentity: () => ({ parentId: GENITORE, studentId: ALUNNO, ready: true }),
}))

import { LezioniList, type Lezione } from '@/components/features/parent/LezioniCompitiSections'
import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea'
import { AvvisoCard, type Avviso } from '@/components/features/avvisi/AvvisoCard'
import PagelleGenitorePage from '@/app/(dashboard)/parent/primaria/pagelle/page'
import {
  avvisoDocumento,
  esitoDaSegnalare,
  nomeDocumentoDa,
  pdfDaBase64,
} from '@/lib/native/documento-genitore'

const CONSEGNATO = { esito: 'nativo-anteprima' as const }

/**
 * Il verdetto dell'helper sul BINARIO 1.0: Filesystem assente, sorgente che non si può
 * condividere come link (`scarica.ts`, ramo dei plugin assenti). Lì riprovare non riuscirà
 * mai: il testo deve dire di aggiornare l'app, non «riprova fra qualche minuto».
 */
const BINARIO_1_0 = {
  esito: 'non-riuscito' as const,
  motivo: 'plugin-assenti:filesystem|link-non-condivisibile',
  binarioDaAggiornare: true,
}

/**
 * Il clic «sul web»: dice se QUALCUNO ha fermato la navigazione (il gestore React gira
 * prima di un ascoltatore sul `document`), e poi la ferma lui — jsdom non naviga.
 */
function clicSulWeb(link: HTMLElement): boolean | null {
  let fermato: boolean | null = null
  document.addEventListener(
    'click',
    (e) => {
      fermato = e.defaultPrevented
      e.preventDefault()
    },
    { once: true },
  )
  fireEvent.click(link)
  return fermato
}

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo = false
  h.apri.mockResolvedValue(CONSEGNATO)
  h.scarica.mockResolvedValue({ esito: 'nativo-file' })
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
})

afterEach(() => cleanup())

// ─── Il modulo di supporto ──────────────────────────────────────────────────────

describe('nomeDocumentoDa — il nome del file sul dispositivo', () => {
  const URL_FIRMATO = 'https://progetto.test/storage/v1/object/sign/registro/x/1727-scheda%20compiti.pdf?token=T'

  it('il nome mostrato senza estensione prende quella dell’indirizzo', () => {
    expect(nomeDocumentoDa('Scheda di matematica', URL_FIRMATO, 'kidville')).toBe('Scheda di matematica.pdf')
  })

  it('il nome mostrato che l’estensione ce l’ha già resta com’è', () => {
    expect(nomeDocumentoDa('foto.jpg', URL_FIRMATO, 'kidville')).toBe('foto.jpg')
  })

  it('senza nome mostrato: l’ultimo pezzo del percorso, decodificato e senza query', () => {
    expect(nomeDocumentoDa(null, URL_FIRMATO, 'kidville')).toBe('1727-scheda compiti.pdf')
  })

  it('un punto nel nome NON è un’estensione: «Compiti 24.09» prende il `.jpg` dell’indirizzo', () => {
    // Il `09` dopo il punto non è un tipo di file: senza il `.jpg` l'anteprima iOS non sa
    // che cosa mostrare (OS-PLUG-FLVW-0013), e per le immagini il `mime` non si passa.
    const urlFoto = 'https://progetto.test/storage/v1/object/sign/lezioni/x/1727-foto.jpg?token=T'
    expect(nomeDocumentoDa('Compiti 24.09', urlFoto, 'kidville')).toBe('Compiti 24.09.jpg')
    expect(nomeDocumentoDa('Ricevuta n.12', URL_FIRMATO, 'kidville')).toBe('Ricevuta n.12.pdf')
  })

  it('l’estensione si riconosce anche in maiuscolo, e non si raddoppia', () => {
    expect(nomeDocumentoDa('Scheda.PDF', URL_FIRMATO, 'kidville')).toBe('Scheda.PDF')
  })

  it('senza nome e senza pezzo: il predefinito', () => {
    expect(nomeDocumentoDa(null, 'https://progetto.test/', 'kidville-allegato')).toBe('kidville-allegato')
  })
})

describe('esitoDaSegnalare — quando il genitore va avvisato', () => {
  it('file, anteprima e foglio col link non si segnalano', () => {
    expect(esitoDaSegnalare({ esito: 'nativo-file' })).toBe(false)
    expect(esitoDaSegnalare({ esito: 'nativo-anteprima' })).toBe(false)
    expect(esitoDaSegnalare({ esito: 'web-blob' })).toBe(false)
    expect(esitoDaSegnalare({ esito: 'ripiego-condivisione', motivo: 'http-500' })).toBe(false)
  })

  it('niente consegnato (anche gli appunti, che sono muti) si segnala; l’annullato no', () => {
    expect(esitoDaSegnalare({ esito: 'non-riuscito', motivo: 'http-403' })).toBe(true)
    expect(esitoDaSegnalare({ esito: 'ripiego-appunti', motivo: 'http-500' })).toBe(true)
    expect(esitoDaSegnalare({ esito: 'non-riuscito', motivo: 'annullato' })).toBe(false)
  })
})

describe('avvisoDocumento — QUALE avviso', () => {
  it('niente da dire quando `esitoDaSegnalare` tace (consegnato, foglio col link, annullato)', () => {
    expect(avvisoDocumento({ esito: 'nativo-file' })).toBeNull()
    expect(avvisoDocumento({ esito: 'ripiego-condivisione', motivo: 'plugin-assenti:filesystem', binarioDaAggiornare: true })).toBeNull()
    expect(avvisoDocumento({ esito: 'non-riuscito', motivo: 'annullato', binarioDaAggiornare: true })).toBeNull()
  })

  it('«aggiorna» SOLO col binario da aggiornare; ogni altro guasto è «riprova»', () => {
    expect(avvisoDocumento(BINARIO_1_0)).toBe('aggiorna')
    expect(avvisoDocumento({ esito: 'ripiego-appunti', motivo: 'plugin-assenti:filesystem', binarioDaAggiornare: true })).toBe('aggiorna')
    // Il motivo da solo non basta: decide il flag dell'helper, come in `LinkDocumento`.
    expect(avvisoDocumento({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })).toBe('riprova')
    expect(avvisoDocumento({ esito: 'non-riuscito', motivo: 'http-500' })).toBe('riprova')
    expect(avvisoDocumento({ esito: 'non-riuscito', motivo: 'http-500', binarioDaAggiornare: false })).toBe('riprova')
  })
})

describe('pdfDaBase64', () => {
  it('ricostruisce i byte, come PDF', async () => {
    const blob = pdfDaBase64(btoa('%PDF-1.4'))
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBe(8)
  })
})

// ─── Gli allegati da GUARDARE ───────────────────────────────────────────────────

const URL_ALLEGATO = 'https://progetto.test/storage/v1/object/sign/allegati/x/scheda.pdf?token=T'

function lezioneConAllegato(): Lezione {
  return {
    id: 'lez-1',
    data: '2026-09-22',
    ora_lezione: 1,
    materia: 'Matematica',
    argomento: 'Le addizioni',
    compiti: null,
    allegati: [{ id: 'all-1', tipo: 'pdf', file_url: URL_ALLEGATO, file_name: 'Scheda addizioni' }],
    individualizzate: [],
  }
}

describe('allegati delle lezioni', () => {
  it('nell’app: anteprima con l’helper, e la navigazione si ferma', () => {
    h.nativo = true
    render(<LezioniList lezioni={[lezioneConAllegato()]} />)
    const link = screen.getByRole('link', { name: /Scheda addizioni/ })

    const nonFermato = fireEvent.click(link)

    expect(nonFermato).toBe(false)
    expect(h.scarica).not.toHaveBeenCalled()
    expect(h.apri).toHaveBeenCalledTimes(1)
    expect(h.apri).toHaveBeenCalledWith({
      sorgente: URL_ALLEGATO,
      nomeFile: 'Scheda addizioni.pdf',
      mime: 'application/pdf',
      etichetta: 'allegato-lezione',
    })
  })

  it('nell’app, l’anteprima che non si apre lo DICE accanto all’allegato; riaperta, l’avviso sparisce', async () => {
    // 🔴 Senza `onEsito` il ramo nativo era il «pulsante muto» spostato di un ramo: il
    // tocco fermava la navigazione, l'helper falliva, e a schermo non cambiava niente.
    h.nativo = true
    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    render(<LezioniList lezioni={[lezioneConAllegato()]} />)
    const link = screen.getByRole('link', { name: /Scheda addizioni/ })

    fireEvent.click(link)
    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.documentoNonAperto)

    fireEvent.click(link) // stavolta `nativo-anteprima` (beforeEach)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(2))
    await act(async () => {
      await h.apri.mock.results[1].value
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('nell’app col binario 1.0: il testo dice di AGGIORNARE, non di riprovare', async () => {
    h.nativo = true
    h.apri.mockResolvedValueOnce(BINARIO_1_0)
    render(<LezioniList lezioni={[lezioneConAllegato()]} />)
    fireEvent.click(screen.getByRole('link', { name: /Scheda addizioni/ }))
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.documentoAppDaAggiornare)
    expect(avviso).not.toHaveTextContent(itShared.documentoNonAperto)
  })

  it('nell’app, la copia muta negli appunti si segnala anche lei', async () => {
    h.nativo = true
    h.apri.mockResolvedValueOnce({ esito: 'ripiego-appunti', motivo: 'foglio-file-non-aperto' })
    render(<LezioniList lezioni={[lezioneConAllegato()]} />)
    fireEvent.click(screen.getByRole('link', { name: /Scheda addizioni/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.documentoNonAperto)
  })

  it('nell’app, un’anteprima aperta non inventa nessun avviso', async () => {
    h.nativo = true
    render(<LezioniList lezioni={[lezioneConAllegato()]} />)
    fireEvent.click(screen.getByRole('link', { name: /Scheda addizioni/ }))
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(1))
    await act(async () => {
      await h.apri.mock.results[0].value
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('sul web: il collegamento resta com’era e l’helper non entra', () => {
    render(<LezioniList lezioni={[lezioneConAllegato()]} />)
    const link = screen.getByRole('link', { name: /Scheda addizioni/ })
    expect(link).toHaveAttribute('href', URL_ALLEGATO)
    expect(link).toHaveAttribute('target', '_blank')
    expect(clicSulWeb(link)).toBe(false)
    expect(h.apri).not.toHaveBeenCalled()
  })
})

function messaggioConDocumento(): ChatMessage {
  return {
    id: 'm-1',
    thread_id: 'th-1',
    sender_id: 'doc-1',
    content: 'Ecco il modulo',
    attachment_url: URL_ALLEGATO,
    attachment_type: 'document',
    read_at: '2026-09-22T08:00:00.000Z',
    created_at: '2026-09-22T07:59:00.000Z',
  }
}

describe('allegati della chat', () => {
  it('nell’app: anteprima con l’helper, etichetta della chat', () => {
    h.nativo = true
    render(<ChatMessageArea messages={[messaggioConDocumento()]} currentUserId="gen-1" otherUserName="Maestra" />)
    const link = screen.getByRole('link', { name: new RegExp(itChat.documentAttachment) })

    expect(fireEvent.click(link)).toBe(false)
    expect(h.apri).toHaveBeenCalledWith({
      sorgente: URL_ALLEGATO,
      nomeFile: 'scheda.pdf',
      etichetta: 'allegato-chat',
    })
  })

  it('nell’app, il documento che non si apre lo DICE nella bolla', async () => {
    h.nativo = true
    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    render(<ChatMessageArea messages={[messaggioConDocumento()]} currentUserId="gen-1" otherUserName="Maestra" />)
    fireEvent.click(screen.getByRole('link', { name: new RegExp(itChat.documentAttachment) }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.documentoNonAperto)
  })

  it('nell’app col binario 1.0: la bolla dice di AGGIORNARE, non di riprovare', async () => {
    h.nativo = true
    h.apri.mockResolvedValueOnce(BINARIO_1_0)
    render(<ChatMessageArea messages={[messaggioConDocumento()]} currentUserId="gen-1" otherUserName="Maestra" />)
    fireEvent.click(screen.getByRole('link', { name: new RegExp(itChat.documentAttachment) }))
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.documentoAppDaAggiornare)
    expect(avviso).not.toHaveTextContent(itShared.documentoNonAperto)
  })

  it('nell’app, un’anteprima aperta non inventa nessun avviso nella bolla', async () => {
    h.nativo = true
    render(<ChatMessageArea messages={[messaggioConDocumento()]} currentUserId="gen-1" otherUserName="Maestra" />)
    fireEvent.click(screen.getByRole('link', { name: new RegExp(itChat.documentAttachment) }))
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(1))
    await act(async () => {
      await h.apri.mock.results[0].value
    })
    expect(screen.queryByText(itShared.documentoNonAperto)).not.toBeInTheDocument()
  })

  it('sul web: nessun helper', () => {
    render(<ChatMessageArea messages={[messaggioConDocumento()]} currentUserId="gen-1" otherUserName="Maestra" />)
    const link = screen.getByRole('link', { name: new RegExp(itChat.documentAttachment) })
    expect(clicSulWeb(link)).toBe(false)
    expect(h.apri).not.toHaveBeenCalled()
    expect(link).toHaveAttribute('href', URL_ALLEGATO)
  })
})

function avvisoConAllegato(): Avviso {
  return {
    id: 'avv-1',
    author_id: 'aut-1',
    titolo: 'Gita al parco',
    contenuto: 'Si parte alle 9.',
    tipo: 'presa_visione',
    target_scope: 'globale',
    target_classes: null,
    scadenza: null,
    attachment_url: JSON.stringify({ file: URL_ALLEGATO, link: null }),
    created_at: '2026-09-22T08:00:00.000Z',
    author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
  }
}

async function allegatoAvviso(): Promise<HTMLElement> {
  render(<AvvisoCard avviso={avvisoConAllegato()} index={0} />)
  const apri = screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))
  if (apri && apri.getAttribute('aria-expanded') !== 'true') fireEvent.click(apri)
  return screen.findByRole('link', { name: itAvvisi.allegatoFile })
}

describe('allegati degli avvisi', () => {
  it('nell’app: anteprima con l’helper, etichetta dell’avviso', async () => {
    h.nativo = true
    const link = await allegatoAvviso()
    expect(fireEvent.click(link)).toBe(false)
    expect(h.apri).toHaveBeenCalledWith({
      sorgente: URL_ALLEGATO,
      nomeFile: 'scheda.pdf',
      etichetta: 'allegato-avviso',
    })
  })

  it('nell’app, l’allegato che non si apre lo DICE sulla card; riaperto, l’avviso sparisce', async () => {
    h.nativo = true
    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'condivisione-non-riuscita' })
    const link = await allegatoAvviso()
    fireEvent.click(link)
    expect(await screen.findByText(itShared.documentoNonAperto)).toHaveAttribute('role', 'alert')

    fireEvent.click(link) // stavolta `nativo-anteprima` (beforeEach)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(2))
    await act(async () => {
      await h.apri.mock.results[1].value
    })
    expect(screen.queryByText(itShared.documentoNonAperto)).not.toBeInTheDocument()
  })

  it('nell’app col binario 1.0: la card dice di AGGIORNARE, non di riprovare', async () => {
    h.nativo = true
    h.apri.mockResolvedValueOnce(BINARIO_1_0)
    const link = await allegatoAvviso()
    fireEvent.click(link)
    expect(await screen.findByText(itShared.documentoAppDaAggiornare)).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(itShared.documentoNonAperto)).not.toBeInTheDocument()
  })

  it('nell’app, un’anteprima aperta non inventa nessun avviso sulla card', async () => {
    h.nativo = true
    const link = await allegatoAvviso()
    fireEvent.click(link)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(1))
    await act(async () => {
      await h.apri.mock.results[0].value
    })
    expect(screen.queryByText(itShared.documentoNonAperto)).not.toBeInTheDocument()
  })

  it('sul web: nessun helper', async () => {
    const link = await allegatoAvviso()
    expect(clicSulWeb(link)).toBe(false)
    expect(h.apri).not.toHaveBeenCalled()
    expect(link).toHaveAttribute('href', URL_ALLEGATO)
  })
})

// ─── La pagina delle pagelle ─────────────────────────────────────────────────────

const URL_CERTIFICATO = 'https://progetto.test/storage/v1/object/sign/competenze/x/cert.pdf?token=T'

function armaPagelle(): void {
  h.fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/parent/primaria/pagella')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ scrutinioId: SCRUTINIO, periodo: 'Primo quadrimestre', anno: '2025/2026', chiusoIl: null, firmato: true }],
        }),
      })
    }
    if (url.startsWith('/api/parent/competenze')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: 'c-1', anno: '2025/2026', stato: 'emesso', downloadUrl: URL_CERTIFICATO }],
        }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', h.fetchMock)
}

describe('parent/primaria/pagelle — pagella da consultare, certificato da salvare', () => {
  beforeEach(() => armaPagelle())
  afterEach(() => vi.unstubAllGlobals())

  it('«PDF» apre la pagella con `apriDocumento` — la route e il chi, non un `window.open` nudo', async () => {
    const apertura = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<PagelleGenitorePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itPrimaria.pagellePdf) }))

    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(1))
    const input = h.apri.mock.calls[0][0]
    expect(input.sorgente).toBe(
      `/api/primaria/pagella?scrutinioId=${SCRUTINIO}&alunnoId=${ALUNNO}&userId=${GENITORE}`,
    )
    expect(input).toMatchObject({ mime: 'application/pdf', etichetta: 'pagella' })
    expect(input.nomeFile).toMatch(/^pagella-.*\.pdf$/)
    // La scheda (sul web) la apre l'helper: la pagina non ne apre una seconda.
    expect(apertura).not.toHaveBeenCalled()
  })

  it('la pagella che non si apre lo DICE; il gesto annullato no', async () => {
    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
    render(<PagelleGenitorePage />)
    const pdf = await screen.findByRole('button', { name: new RegExp(itPrimaria.pagellePdf) })

    fireEvent.click(pdf)
    // Per RUOLO: un lettore di schermo deve annunciare che il tocco su «PDF» non ha aperto niente.
    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.documentoNonAperto)

    cleanup()
    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'annullato' })
    render(<PagelleGenitorePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itPrimaria.pagellePdf) }))
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(2))
    // L'assenza si guarda DOPO che il `.then` della pagina ha girato: prima sarebbe vera
    // comunque (trappola n. 3 di `.claude/rules/test.md`).
    await act(async () => {
      await h.apri.mock.results[1].value
    })
    expect(screen.getByText(itPrimaria.pagelleCertificatoTitolo)).toBeInTheDocument()
    expect(screen.queryByText(itShared.documentoNonAperto)).not.toBeInTheDocument()
  })

  it('la pagella col binario 1.0: il testo dice di AGGIORNARE, e un’apertura riuscita lo toglie', async () => {
    h.apri.mockResolvedValueOnce(BINARIO_1_0)
    render(<PagelleGenitorePage />)
    const pdf = await screen.findByRole('button', { name: new RegExp(itPrimaria.pagellePdf) })

    fireEvent.click(pdf)
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.documentoAppDaAggiornare)
    expect(avviso).not.toHaveTextContent(itShared.documentoNonAperto)

    fireEvent.click(pdf) // stavolta `nativo-anteprima` (beforeEach)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(2))
    await act(async () => {
      await h.apri.mock.results[1].value
    })
    expect(screen.queryByText(itShared.documentoAppDaAggiornare)).not.toBeInTheDocument()
  })

  it('prima non si apre, poi sì: l’avviso del primo tentativo SPARISCE', async () => {
    // Un avviso rimasto a schermo dopo un'apertura riuscita smentisce l'esito: il
    // certificato lo toglieva già, la pagella no.
    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
    render(<PagelleGenitorePage />)
    const pdf = await screen.findByRole('button', { name: new RegExp(itPrimaria.pagellePdf) })

    fireEvent.click(pdf)
    expect(await screen.findByText(itShared.documentoNonAperto)).toBeInTheDocument()

    fireEvent.click(pdf) // stavolta `nativo-anteprima` (beforeEach)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(2))
    await act(async () => {
      await h.apri.mock.results[1].value
    })
    expect(screen.queryByText(itShared.documentoNonAperto)).not.toBeInTheDocument()
  })

  it('certificato nell’app: `scaricaDocumento` col file, e il fallimento si dice', async () => {
    h.nativo = true
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
    render(<PagelleGenitorePage />)
    const link = await screen.findByRole('link', { name: new RegExp(itPrimaria.pagelleScarica) })

    expect(fireEvent.click(link)).toBe(false)
    expect(h.apri).not.toHaveBeenCalled()
    expect(h.scarica).toHaveBeenCalledWith({
      sorgente: URL_CERTIFICATO,
      nomeFile: 'certificato-competenze-2025-2026.pdf',
      mime: 'application/pdf',
      etichetta: 'certificato-competenze',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.documentoNonSalvato)
  })

  it('certificato nell’app col binario 1.0: il testo dice di AGGIORNARE, non di riprovare', async () => {
    h.nativo = true
    h.scarica.mockResolvedValueOnce(BINARIO_1_0)
    render(<PagelleGenitorePage />)
    fireEvent.click(await screen.findByRole('link', { name: new RegExp(itPrimaria.pagelleScarica) }))
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.documentoAppDaAggiornare)
    expect(avviso).not.toHaveTextContent(itShared.documentoNonSalvato)
  })

  it('certificato sul web: il collegamento resta com’era', async () => {
    render(<PagelleGenitorePage />)
    const link = await screen.findByRole('link', { name: new RegExp(itPrimaria.pagelleScarica) })
    expect(clicSulWeb(link)).toBe(false)
    expect(h.scarica).not.toHaveBeenCalled()
    expect(link).toHaveAttribute('href', URL_CERTIFICATO)
  })
})
