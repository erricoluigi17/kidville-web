import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

import itAdmin from '../../messages/it/adminComunicazioni.json'
import itShared from '../../messages/it/shared.json'
import { SEDE_A } from '../fixtures/sedi'

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

// IL TRASPORTO DEI BYTE È FINTO, IL RESTO NO. `@/lib/media/video/upload` ha i
// propri test (TUS, ripresa dall'offset, archivio su IndexedDB) e in jsdom non
// c'è nessuna rete da riprendere: qui si misura ciò che questo componente
// aggiunge — il preflight, le chiamate alla pipeline, ciò che una persona legge
// e il collegamento che finisce nell'articolo.
const accoda = vi.fn()
const carica = vi.fn()
const daSeguire = vi.fn()
const pota = vi.fn()
const annullaLocale = vi.fn()

vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: () => Promise.resolve({ elenca: () => daSeguire(), aggiorna: vi.fn(), eliminaByte: vi.fn(), elimina: vi.fn() }),
  accodaCaricamentoVideo: (...a: unknown[]) => accoda(...a),
  caricaVideo: (...a: unknown[]) => carica(...a),
  jobDaSeguire: (...a: unknown[]) => daSeguire(...a),
  potaArchivioCaricamenti: (...a: unknown[]) => pota(...a),
  annullaCaricamentoVideo: (...a: unknown[]) => annullaLocale(...a),
}))

import { NewsVideoAllegati } from '@/components/features/admin/news/NewsVideoAllegati'
import { MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import { DIMENSIONE_BLOCCO_TUS_BYTE, BUCKET_ORIGINALI_VIDEO } from '@/lib/media/video/contratto'

const UTENTE = '11111111-1111-4111-8111-111111111111'
const INTENTO = '33333333-3333-4333-8333-333333333333'
const JOB = '22222222-2222-4222-8222-222222222222'

const risposta = (stato: number, corpo: unknown): Response =>
  new Response(JSON.stringify(corpo), { status: stato, headers: { 'Content-Type': 'application/json' } })

const APERTURA = {
  intentId: INTENTO,
  revisione: 1,
  canale: 'news',
  scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
  job: [
    {
      jobId: JOB,
      chiaveIdempotenza: 'k',
      caricamento: {
        protocollo: 'tus',
        endpoint: 'https://esempio.supabase.co/storage/v1/upload/resumable/sign',
        bucket: BUCKET_ORIGINALI_VIDEO,
        percorso: `${UTENTE}/abc.mp4`,
        contentType: 'video/mp4',
        dimensioneBloccoByte: DIMENSIONE_BLOCCO_TUS_BYTE,
      },
      firma: 'firma-finta',
    },
  ],
}

const statoJob = (stato: string, codice: string | null = null) => ({
  intentId: INTENTO,
  revisione: 1,
  canale: 'news',
  statoIntent: 'confirmed',
  aggiornatoIl: '2026-09-18T10:00:00.000Z',
  job: [
    {
      jobId: JOB,
      intentId: INTENTO,
      canale: 'news',
      stato,
      avanzamento: stato === 'ready' ? 100 : 60,
      codice,
      aggiornatoIl: '2026-09-18T10:00:00.000Z',
    },
  ],
})

/** Lo stesso ritmo del componente: il battito si misura, non si indovina. */
const RITMO_DI_PROVA_MS = 6_000

const fetchMock = vi.fn()

/**
 * Il trasporto che NON finisce da solo.
 *
 * Serve a misurare ciò che una persona vede MENTRE i byte partono: con un
 * `caricaVideo` che risolve subito, lo stato «50 %» esisterebbe per un microtask
 * e l'asserzione passerebbe o meno a seconda di come React raggruppa i render —
 * cioè sarebbe un test che a volte è verde per caso.
 */
let sblocca: ((esito: unknown) => void) | null = null

function caricamentoSospeso() {
  carica.mockImplementation((_dip: unknown, jobId: string, opz: { alProgresso?: (a: number, b: number) => void }) => {
    opz?.alProgresso?.(50, 100)
    return new Promise((res) => {
      sblocca = () => res({ esito: 'caricato', jobId, byteCaricati: 1000 })
    })
  })
}

/**
 * LA MISURA DELLA DURATA, SPENTA QUASI DAPPERTUTTO — e il perché conta.
 *
 * `misuraDurata` crea un `<video>` da un object URL e aspetta `loadedmetadata`.
 * In jsdom quell'evento non arriva MAI, quindi ogni prova pagherebbe per intero
 * l'attesa di sicurezza: quattro test, quattro secondi e mezzo buttati, e — più
 * grave — un'attesa che nessuno guarda smette di essere misurata. Qui si spegne
 * l'object URL (è ciò che fa un browser in navigazione privata, o una WebView con
 * lo storage di sito chiuso) e si lascia UN test, l'ultimo, a pagare l'attesa vera
 * e a dimostrare che scaduta quella il caricamento parte lo stesso.
 */
let ripristinaObjectUrl: (() => void) | null = null

function spegniObjectUrl() {
  const bersaglio = globalThis.URL as unknown as { createObjectURL?: unknown }
  const originale = bersaglio.createObjectURL
  bersaglio.createObjectURL = undefined
  ripristinaObjectUrl = () => {
    bersaglio.createObjectURL = originale
  }
}

beforeEach(() => {
  spegniObjectUrl()
  fetchMock.mockReset()
  accoda.mockReset()
  carica.mockReset()
  daSeguire.mockReset()
  pota.mockReset()
  accoda.mockResolvedValue({ ok: true, riga: { jobId: JOB } })
  carica.mockImplementation((_dip: unknown, jobId: string, opz: { alProgresso?: (a: number, b: number) => void }) => {
    opz?.alProgresso?.(50, 100)
    return Promise.resolve({ esito: 'caricato', jobId, byteCaricati: 1000 })
  })
  sblocca = null
  daSeguire.mockResolvedValue([])
  pota.mockResolvedValue(0)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  ripristinaObjectUrl?.()
  ripristinaObjectUrl = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function monta(over: Partial<{ tuttiSedi: boolean }> = {}) {
  const onPronto = vi.fn()
  const r = render(
    <NewsVideoAllegati
      userId={UTENTE}
      scuolaId={SEDE_A}
      tuttiSedi={over.tuttiSedi ?? false}
      onPronto={onPronto}
    />,
  )
  return { ...r, onPronto }
}

function scegliVideo(container: HTMLElement, over: Partial<{ nome: string; tipo: string; byte: number }> = {}) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], over.nome ?? 'recita.mp4', { type: over.tipo ?? 'video/mp4' })
  Object.defineProperty(file, 'size', { value: over.byte ?? 12_345_678 })
  fireEvent.change(input, { target: { files: [file] } })
  return input
}

describe('NewsVideoAllegati · il selettore', () => {
  it('accetta i video, e non con un elenco di tipi esatti', () => {
    const { container } = monta()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.getAttribute('accept')).toContain('video/*')
  })

  it('un file oltre i 2 GB si ferma sul dispositivo: nessun byte parte', async () => {
    const { container } = monta()
    scegliVideo(container, { byte: MAX_VIDEO_INPUT_BYTES + 1 })

    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreVideoTroppoGrande)
    expect(fetchMock, 'il rifiuto deve avvenire PRIMA di aprire l’intento').not.toHaveBeenCalled()
    expect(accoda).not.toHaveBeenCalled()
  })
})

describe('NewsVideoAllegati · il giro completo di un video', () => {
  it('carica, converte e consegna il collegamento all’articolo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))               // POST apertura
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))     // PATCH caricato
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))     // PATCH conferma
      .mockResolvedValueOnce(risposta(200, statoJob('processing'))) // GET
      .mockResolvedValue(risposta(200, statoJob('ready')))          // GET successivi

    caricamentoSospeso()
    const { container, onPronto } = monta()
    scegliVideo(container)

    // Durante il trasporto la persona vede quanto manca, non una rotella muta.
    await screen.findByText(/50%/)

    // I byte arrivano in fondo.
    await act(async () => {
      sblocca?.(null)
      await Promise.resolve()
    })

    // Finito il trasporto: il filmato è arrivato, la preparazione è del server.
    await screen.findByText(itAdmin.videoStatoConversione)

    // L'AVANZAMENTO DELLA CONVERSIONE LO DICE IL SERVER. I numeri delle fasi
    // stanno nel contratto (`avanzamentoDaStatoVideo`): tenere il 100 % dei byte
    // spediti mentre la conversione non è ancora finita direbbe «fatto» di un
    // lavoro che dura ancora minuti.
    await waitFor(() =>
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60'),
    )

    // L'intento è stato aperto con la sede dichiarata.
    const corpoApertura = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(corpoApertura.canale).toBe('news')
    expect(corpoApertura.scuolaId).toBe(SEDE_A)
    expect(corpoApertura.ambitoGlobale).toBe(false)

    // E la conferma è partita: da qui in poi si può chiudere la pagina.
    const azioni = fetchMock.mock.calls
      .filter((c) => c[1]?.method === 'PATCH')
      .map((c) => JSON.parse(String(c[1].body)).azione)
    expect(azioni).toContain('caricato')
    expect(azioni).toContain('conferma')

    // Il battito successivo trova il video pronto.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    await waitFor(() => expect(onPronto).toHaveBeenCalled())
    const [url, etichetta] = onPronto.mock.calls[0]
    expect(url).toContain(`/news_bozze/uploads/${UTENTE}/${JOB}.mp4`)
    expect(etichetta).toBe(itAdmin.videoEtichettaLink)
    expect(await screen.findByText(itAdmin.videoStatoPronto)).toBeInTheDocument()

    // Il battito dopo NON lo riattacca: due collegamenti allo stesso filmato
    // sarebbero due righe nell'articolo, e la seconda nessuno l'ha chiesta.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000)
    })
    expect(onPronto).toHaveBeenCalledTimes(1)
  })

  it('due battiti sovrapposti non collegano lo stesso filmato due volte', async () => {
    // IL CASO CHE IL SOLO «non interrogare più un job concluso» NON copre: il
    // battito che parte subito dopo la conferma e quello dell'orologio possono
    // essere in volo INSIEME, e allora entrambi vedono lo stesso `ready`. Senza
    // la guardia, nell'articolo finiscono due collegamenti allo stesso filmato e
    // il secondo non l'ha chiesto nessuno.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const gettoni: Array<() => void> = []
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockImplementation(
        () =>
          new Promise((res) => {
            gettoni.push(() => res(risposta(200, statoJob('ready'))))
          }),
      )

    const { container, onPronto } = monta()
    scegliVideo(container)

    // Il primo battito è partito ed è fermo sulla risposta.
    await waitFor(() => expect(gettoni).toHaveLength(1))
    // L'orologio ne fa partire un secondo mentre il primo non è ancora tornato.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RITMO_DI_PROVA_MS)
    })
    await waitFor(() => expect(gettoni.length).toBeGreaterThanOrEqual(2))

    await act(async () => {
      for (const apri of gettoni) apri()
      await Promise.resolve()
    })

    await waitFor(() => expect(onPronto).toHaveBeenCalled())
    expect(onPronto).toHaveBeenCalledTimes(1)
  })

  it('«tutte le sedi» apre l’intento senza plesso e con l’ambito globale', async () => {
    fetchMock.mockResolvedValue(risposta(200, APERTURA))
    const { container } = monta({ tuttiSedi: true })
    scegliVideo(container)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const corpo = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(corpo.scuolaId).toBeNull()
    expect(corpo.ambitoGlobale).toBe(true)
  })

  it('un video rifiutato dalla conversione dice PERCHÉ, col testo del catalogo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValue(risposta(200, statoJob('rejected', 'VIDEO_TROPPO_LUNGO')))

    const { container, onPronto } = monta()
    scegliVideo(container)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    expect(await screen.findByText(itShared.erroreVideoTroppoLungo)).toBeInTheDocument()
    expect(onPronto, 'un filmato rifiutato non entra nell’articolo').not.toHaveBeenCalled()
  })

  it('il rifiuto dell’apertura arriva a schermo tradotto, non come prosa del server', async () => {
    fetchMock.mockResolvedValue(
      risposta(413, { error: 'Questo video supera il limite.', codice: 'VIDEO_TROPPO_GRANDE' }),
    )
    const { container } = monta()
    scegliVideo(container)

    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreVideoTroppoGrande)
  })
})

describe('NewsVideoAllegati · al rientro nella pagina', () => {
  it('ritrova i filmati che il server stava ancora preparando, senza ricaricarli', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    daSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'news', ownerId: UTENTE, scuolaId: SEDE_A, stato: 'caricato', nome: 'sintetico.mp4', dimensioneByte: 3, mime: 'video/mp4', chiaveIdempotenza: 'k' }])
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? risposta(200, { ...APERTURA, intent: { status: 'confirmed' }, job: [{ ...APERTURA.job[0], status: 'processing', needs_upload: false, firma: '', expires_at: null }] })
      : risposta(200, statoJob('processing')))

    monta()

    expect(await screen.findByText(itAdmin.videoRiapertura)).toBeInTheDocument()
    await screen.findByText(itAdmin.videoStatoConversione)
    expect(carica, 'i byte erano già arrivati: non si rispediscono').not.toHaveBeenCalled()
    // La potatura all'avvio non è un di più: senza, i Blob da due gigabyte
    // restano sul telefono di un genitore finché il browser non sfratta tutto.
    expect(pota).toHaveBeenCalled()
  })

  it.each(['caricato', 'conferma'])('riprende metadati senza Blob e riconcilia risposta persa: %s', async persa => {
    daSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'news', ownerId: UTENTE, scuolaId: SEDE_A,
      stato: 'caricato', chiaveIdempotenza: 'k', nome: 'sintetico.mp4', dimensioneByte: 3, mime: 'video/mp4' }])
    let intento = 'pending'; let stato = 'awaiting_upload'
    const azioni: string[] = []
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return risposta(200, { ...APERTURA, intent: { status: intento },
        job: [{ ...APERTURA.job[0], status: stato, needs_upload: false, firma: '', expires_at: null }] })
      if (init?.method === 'PATCH') {
        const azione = JSON.parse(String(init.body)).azione
        azioni.push(azione)
        if (azione === 'caricato') stato = 'queued'
        if (azione === 'conferma') intento = 'confirmed'
        if (azione === persa) throw new TypeError('risposta persa')
      }
      return risposta(200, { ...statoJob(stato), statoIntent: intento })
    })
    monta()
    await waitFor(() => expect(azioni).toEqual(['caricato', 'conferma']))
    expect(carica).not.toHaveBeenCalled()
  })
  it('ignora archivio di altro proprietario, altra sede e legacy', async () => {
    const riga = { jobId: JOB, intentId: INTENTO, canale: 'news', stato: 'caricato', ownerId: UTENTE, scuolaId: SEDE_A }
    daSeguire.mockResolvedValue([{ ...riga, ownerId: 'altro' }, { ...riga, scuolaId: 'altra' }, { ...riga, ownerId: undefined, scuolaId: undefined }])
    monta()
    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('un browser che non sa dire la durata non blocca il caricamento', async () => {
    // Qui l'object URL c'è ma `loadedmetadata` non arriverà mai: è il caso di una
    // WebView che non legge i metadati. Scaduta l'attesa di sicurezza il
    // caricamento deve partire lo stesso, dichiarando `durataSecondi: null` —
    // che il contratto ammette, perché la misura vera la fa il probe.
    ripristinaObjectUrl?.()
    ripristinaObjectUrl = null
    fetchMock.mockResolvedValue(risposta(200, APERTURA))

    const { container } = monta()
    scegliVideo(container)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 6000 })
    const corpo = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(corpo.file[0].durataSecondi).toBeNull()
  })

  it('un filmato di un ALTRO canale non compare fra gli allegati di una comunicazione', async () => {
    daSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'gallery' }])
    fetchMock.mockResolvedValue(risposta(200, statoJob('processing')))

    monta()

    await waitFor(() => expect(pota).toHaveBeenCalled())
    expect(screen.queryByText(itAdmin.videoRiapertura)).not.toBeInTheDocument()
  })
})
