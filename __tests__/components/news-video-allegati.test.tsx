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
const concludi = vi.fn()

vi.mock('@/lib/media/video/upload', () => ({
  creaArchivioCaricamenti: () => Promise.resolve({ elenca: () => daSeguire(), aggiorna: vi.fn(), eliminaByte: vi.fn(), elimina: vi.fn() }),
  accodaCaricamentoVideo: (...a: unknown[]) => accoda(...a),
  concludiCaricamentoVideo: (...a: unknown[]) => concludi(...a),
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

/**
 * Lo stato di un job come lo restituisce la route. `riprovaAutomatica` è il flag che la route
 * calcola da stato e `attempt`: il runner ha avuto un guasto NOSTRO e il job si sta ritentando
 * da solo. Falso per default, com'è per la maggior parte della vita di un job.
 */
const statoJob = (stato: string, codice: string | null = null, riprovaAutomatica = false) => ({
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
      riprovaAutomatica,
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
  concludi.mockReset()
  concludi.mockResolvedValue(undefined)
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

/**
 * «PROBLEMA NOSTRO, NON DEL VIDEO: RIPROVIAMO IN AUTOMATICO» — la riga di una comunicazione.
 *
 * Dal 29/09/2026 nessun video si convertiva, e a chi lo allegava a una comunicazione la riga
 * restava su «il filmato è in attesa» per sempre. Da quando il runner ritenta da solo i guasti
 * NOSTRI, il server dice `riprovaAutomatica` e la riga lo racconta al posto della frase di
 * fase. Ogni ASSENZA è provata DOPO una presenza (la frase giusta a schermo): un `waitFor` su
 * un'assenza passa prima che i dati arrivino, ed è verde con e senza il difetto.
 */
describe('NewsVideoAllegati · un ritentativo automatico dopo un guasto nostro', () => {
  it('la riga lo dice finché il server ritenta, e torna normale quando il filmato è pronto', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))                              // POST apertura
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))                    // PATCH caricato
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))                    // PATCH conferma
      .mockResolvedValueOnce(risposta(200, statoJob('queued', null, true)))        // GET: rimesso in coda
      .mockResolvedValueOnce(risposta(200, statoJob('processing', null, true)))    // GET: il ritentativo è partito
      .mockResolvedValue(risposta(200, statoJob('ready')))                         // GET successivi: riuscito
    const { container, onPronto } = monta()
    scegliVideo(container)

    // PRESENZA: il messaggio del ritentativo, al posto della frase di fase.
    const riga = await screen.findByText(itAdmin.videoStatoRiprovaAutomatica)
    expect(riga).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.videoStatoInCoda)).toBeNull()
    expect(screen.queryByText(itAdmin.videoStatoConversione)).toBeNull()
    // Annunciato senza interrompere: la riga di avanzamento è uno `status`, non un `alert`.
    expect(riga).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onPronto).not.toHaveBeenCalled()

    // Il ritentativo parte: il messaggio resta, e la barra è quella del server (60).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(await screen.findByText(itAdmin.videoStatoRiprovaAutomatica)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60'),
    )

    // Riesce: il filmato è pronto, il collegamento va nell'articolo, il messaggio sparisce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    await waitFor(() => expect(onPronto).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(itAdmin.videoStatoPronto)).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.videoStatoRiprovaAutomatica)).toBeNull()
  })

  it('senza il flag la riga dice la frase di fase di sempre', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValue(risposta(200, statoJob('processing')))
    const { container } = monta()
    scegliVideo(container)

    // Prima la PRESENZA della frase di fase, poi l'assenza del messaggio.
    expect(await screen.findByText(itAdmin.videoStatoConversione)).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.videoStatoRiprovaAutomatica)).toBeNull()
  })

  it('esauriti i tentativi la riga legge la frase FINALE del guasto nostro, non «riproviamo»', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValue(risposta(200, statoJob('failed', 'VIDEO_GUASTO_NOSTRO')))
    const { container, onPronto } = monta()
    scegliVideo(container)

    // Qui sì un errore, e annunciato come tale: il filmato non c'è e va ricaricato più tardi.
    const frase = await screen.findByText(itShared.erroreVideoGuastoNostro)
    expect(frase).toHaveAttribute('role', 'alert')
    expect(screen.queryByText(itAdmin.videoStatoRiprovaAutomatica)).toBeNull()
    expect(onPronto, 'un filmato non convertito non entra nell’articolo').not.toHaveBeenCalled()
    // Il codice interno non è mai a schermo.
    expect(screen.queryByText('VIDEO_GUASTO_NOSTRO')).toBeNull()
  })

  it('un intento ritirato mentre si ritentava NON lascia «riproviamo»: la riga è un errore, non un’attesa', async () => {
    // Per un giro lo stato può essere incoerente: job ancora `queued` col flag, intento già
    // `cancelled`. La riga diventa errore (com'era già) e non promette un lavoro che non c'è.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(risposta(200, APERTURA))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValueOnce(risposta(200, statoJob('queued')))
      .mockResolvedValue(risposta(200, { ...statoJob('queued', null, true), statoIntent: 'cancelled' }))
    const { container } = monta()
    scegliVideo(container)

    // PRESENZA: l'errore generico di sempre per un intento ritirato…
    expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreVideoOperazioneNonRiuscita)
    // …e nessuna promessa di ritentativo.
    expect(screen.queryByText(itAdmin.videoStatoRiprovaAutomatica)).toBeNull()
  })

  it('al rientro nella pagina a metà di un ritentativo la riga lo dice, senza ricaricare il filmato', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    daSeguire.mockResolvedValue([{ jobId: JOB, intentId: INTENTO, canale: 'news', ownerId: UTENTE, scuolaId: SEDE_A, stato: 'caricato', nome: 'sintetico.mp4', dimensioneByte: 3, mime: 'video/mp4', chiaveIdempotenza: 'k' }])
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? risposta(200, { ...APERTURA, intent: { status: 'confirmed' }, job: [{ ...APERTURA.job[0], status: 'queued', needs_upload: false, firma: '', expires_at: null }] })
      : risposta(200, statoJob('queued', null, true)))

    monta()

    expect(await screen.findByText(itAdmin.videoRiapertura)).toBeInTheDocument()
    expect(await screen.findByText(itAdmin.videoStatoRiprovaAutomatica)).toBeInTheDocument()
    expect(carica, 'i byte erano già arrivati: non si rispediscono').not.toHaveBeenCalled()
  })
})

/** La riga che l'archivio locale conserva per un filmato già (in parte) caricato. */
const rigaLocale = (stato: 'caricato' | 'in_corso' = 'caricato') => ({
  jobId: JOB, intentId: INTENTO, canale: 'news', ownerId: UTENTE, scuolaId: SEDE_A,
  stato, nome: 'sintetico.mp4', dimensioneByte: 3, mime: 'video/mp4', chiaveIdempotenza: 'k',
})

/** La risposta dell'apertura di un intento che il server ha già portato avanti: niente da caricare. */
const aperturaGiaAvanti = (statoJob: string, statoIntent = 'confirmed') => ({
  ...APERTURA,
  intent: { status: statoIntent },
  job: [{ ...APERTURA.job[0], status: statoJob, needs_upload: false, firma: '', expires_at: null }],
})

/**
 * IL JOB CHE IL SERVER HA CHIUSO MALE, AL RIENTRO — e dice perché (secondario #39).
 *
 * Riaprendo la pagina, un filmato che il runner aveva ritentato fino in fondo per un guasto
 * NOSTRO si leggeva «ricarica la pagina e riprova: non è andato perso niente» — una frase che
 * dà a chi aveva allegato il filmato un compito che non era suo. Il codice vero lo conosce il
 * server (`codiceMostrabileDelJob`) e il client lo legge, come fa la galleria. Ogni ASSENZA è
 * provata DOPO una presenza: un `waitFor` su un'assenza passa prima che i dati arrivino.
 */
describe('NewsVideoAllegati · al rientro un job finito male dice perché', () => {
  const giro = (statoJob: 'failed' | 'rejected' | 'cancelled', letto: () => Response) => {
    daSeguire.mockResolvedValue([rigaLocale()])
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? risposta(200, aperturaGiaAvanti(statoJob)) : letto())
  }

  it('`failed` dopo i ritentativi: la frase del guasto nostro, non «ricarica e riprova»', async () => {
    giro('failed', () => risposta(200, statoJob('failed', 'VIDEO_GUASTO_NOSTRO')))

    monta()

    // PRESENZA: il guasto nostro, annunciato come errore.
    const frase = await screen.findByText(itShared.erroreVideoGuastoNostro)
    expect(frase).toHaveAttribute('role', 'alert')
    // E solo dopo l'assenza della frase generica di prima.
    expect(screen.queryByText(itShared.erroreVideoRiprova)).toBeNull()
    expect(carica, 'i byte erano già arrivati: non si rispediscono').not.toHaveBeenCalled()
    // Il codice interno non è mai a schermo.
    expect(screen.queryByText('VIDEO_GUASTO_NOSTRO')).toBeNull()
  })

  it('`rejected`: il difetto del suo file, col testo del catalogo', async () => {
    giro('rejected', () => risposta(200, statoJob('rejected', 'VIDEO_TROPPO_LUNGO')))

    monta()

    expect(await screen.findByText(itShared.erroreVideoTroppoLungo)).toBeInTheDocument()
    expect(screen.queryByText(itShared.erroreVideoRiprova)).toBeNull()
  })

  it('se lo stato non si legge il ripiego è «ricarica e riprova»', async () => {
    giro('failed', () => risposta(500, { error: 'x', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }))

    monta()

    expect(await screen.findByText(itShared.erroreVideoRiprova)).toBeInTheDocument()
    expect(screen.queryByText(itShared.erroreVideoGuastoNostro)).toBeNull()
  })

  it('un job annullato resta «ricarica e riprova» e non chiede nessun codice al server', async () => {
    giro('cancelled', () => risposta(200, statoJob('cancelled')))

    monta()

    expect(await screen.findByText(itShared.erroreVideoRiprova)).toBeInTheDocument()
    // Nessuna lettura dello stato: l'unica richiesta è la riapertura.
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true)
  })
})

/**
 * I BYTE GIÀ SUL SERVER — e la copia in background che `accodaCaricamentoVideo` ha avviato.
 *
 * Quando l'apertura risponde «non c'è niente da caricare», il lavoro locale non serve più. Chiudere
 * la riga a mano (`aggiorna` + `eliminaByte`) metterebbe l'`eliminaByte` in fila dietro una copia
 * di due gigabyte, che sull'archivio vero dovrebbe finire prima di essere cancellata: qui si passa
 * da `concludiCaricamentoVideo`, che prima la ferma.
 */
describe('NewsVideoAllegati · i byte sono già sul server', () => {
  it('un video nuovo il cui intento non ha niente da caricare chiude il lavoro locale e non rispedisce niente', async () => {
    fetchMock
      .mockResolvedValueOnce(risposta(200, aperturaGiaAvanti('queued', 'pending')))
      .mockImplementation(async () => risposta(200, statoJob('queued')))
    const { container } = monta()
    scegliVideo(container)

    await waitFor(() => expect(concludi).toHaveBeenCalledTimes(1))
    expect(concludi.mock.calls[0][1]).toBe(JOB)
    expect(carica, 'non c’è niente da caricare').not.toHaveBeenCalled()
  })

  it('al rientro, una riga non ancora «caricato» il cui job ha già i byte si chiude con la stessa funzione', async () => {
    daSeguire.mockResolvedValue([rigaLocale('in_corso')])
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? risposta(200, aperturaGiaAvanti('queued'))
      : risposta(200, statoJob('queued')))

    monta()

    await waitFor(() => expect(concludi).toHaveBeenCalledTimes(1))
    expect(concludi.mock.calls[0][1]).toBe(JOB)
    expect(carica).not.toHaveBeenCalled()
  })

  it('una riga già «caricato» non la tocca nessuno: i byte erano già stati liberati', async () => {
    daSeguire.mockResolvedValue([rigaLocale('caricato')])
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? risposta(200, aperturaGiaAvanti('queued'))
      : risposta(200, statoJob('queued')))

    monta()

    // PRIMA la presenza (la riga è tornata a schermo), poi l'assenza della chiusura.
    expect(await screen.findByText(itAdmin.videoRiapertura)).toBeInTheDocument()
    expect(concludi).not.toHaveBeenCalled()
  })
})

/**
 * LA FIRMA CHE SI RINNOVA — `POST /api/video-uploads/[id]/firma`, collegato alla libreria.
 *
 * Una firma vale due ore, e un originale da un gigabyte su rete mobile ne dura di più. La libreria,
 * se lo Storage la rifiuta a metà trasferimento, chiama `rinnovaFirma`; per le News il rinnovo (secondario
 * #55) non è più la riapertura dell'intento con la stessa chiave — un'apertura intera per ogni firma, 190
 * aperture per 44 job misurate prima della PR 2 — ma la route che firma di nuovo il percorso del job. Il test
 * prende le dipendenze che il componente passa alla libreria e le usa come farebbe lei.
 */
describe('NewsVideoAllegati · la firma si rinnova su richiesta della libreria', () => {
  const futura = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  /** L'apertura di un intento: una POST su `/api/video-uploads` (le News ci aggiungono `?userId=`). */
  const eAperturaNews = ([url, init]: unknown[]) =>
    String(url).startsWith('/api/video-uploads?') && (init as { method?: string } | undefined)?.method === 'POST'
  const rispostaFirma = (firma: string) => risposta(200, { jobId: JOB, caricamento: APERTURA.job[0].caricamento, firma, scadeIl: futura() })

  it('`rinnovaFirma` chiama `/firma` col job — NON riapre l’intento — e da quel momento le intestazioni sono quelle nuove', async () => {
    const aperturaConScadenza = { ...APERTURA, job: [{ ...APERTURA.job[0], expires_at: futura() }] }
    fetchMock
      .mockResolvedValueOnce(risposta(200, aperturaConScadenza))
      .mockImplementation(async () => risposta(200, statoJob('queued')))
    caricamentoSospeso()
    const { container } = monta()
    scegliVideo(container)
    await waitFor(() => expect(accoda).toHaveBeenCalled())
    const dip = accoda.mock.calls[0][0] as {
      intestazioni: () => Promise<Record<string, string>>
      rinnovaFirma?: (jobId: string) => Promise<Record<string, string>>
    }

    // La libreria deve avere il rinnovo: senza, il rifiuto dello Storage resterebbe «interrotto».
    expect(dip.rinnovaFirma).toBeTypeOf('function')
    // Finché la firma vale, le intestazioni non costano una richiesta.
    const dopoApertura = fetchMock.mock.calls.length
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-finta' })
    expect(fetchMock.mock.calls.length).toBe(dopoApertura)

    // Il rinnovo: `POST /api/video-uploads/<intento>/firma` col job nel corpo.
    fetchMock.mockImplementationOnce(async () => rispostaFirma('firma-nuova'))
    expect(await dip.rinnovaFirma!(JOB)).toEqual({ 'x-signature': 'firma-nuova' })
    const [url, init] = fetchMock.mock.calls[dopoApertura]
    expect(url).toBe(`/api/video-uploads/${INTENTO}/firma`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ jobId: JOB })
    // ⚠️ L'apertura resta UNA: la vecchia strada ne faceva una per ogni firma, con la stessa chiave.
    expect(fetchMock.mock.calls.filter(eAperturaNews)).toHaveLength(1)

    // Da ora la firma è la nuova, e anche quella costa una sola richiesta.
    expect(await dip.intestazioni()).toEqual({ 'x-signature': 'firma-nuova' })
    expect(fetchMock.mock.calls.length).toBe(dopoApertura + 1)
    // Un rinnovo chiesto per un altro job non si consegna a questo.
    await expect(dip.rinnovaFirma!('99999999-9999-4999-8999-999999999999')).rejects.toThrow('JobDiverso')

    await act(async () => {
      sblocca?.(null)
      await Promise.resolve()
    })
  })

  it('anche il RIENTRO nella pagina (la ripresa di una riga rimasta a metà) rinnova da `/firma`, senza riaprire', async () => {
    daSeguire.mockResolvedValue([rigaLocale('in_corso')])
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? risposta(200, { ...APERTURA, job: [{ ...APERTURA.job[0], expires_at: futura() }] })
      : risposta(200, statoJob('queued')))
    carica.mockResolvedValue({ esito: 'interrotto', jobId: JOB, offsetByte: 0, codice: null })

    monta()
    await waitFor(() => expect(carica).toHaveBeenCalled())
    const dip = carica.mock.calls[0][0] as { rinnovaFirma: (jobId: string) => Promise<Record<string, string>> }
    const aperture = () => fetchMock.mock.calls.filter(eAperturaNews).length
    const prima = aperture()

    fetchMock.mockImplementationOnce(async () => rispostaFirma('firma-di-ripresa'))
    expect(await dip.rinnovaFirma(JOB)).toEqual({ 'x-signature': 'firma-di-ripresa' })
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`/api/video-uploads/${INTENTO}/firma`)
    expect(aperture(), 'il rinnovo ha riaperto l’intento').toBe(prima)
  })

  it('se il job non aspetta più i byte (`/firma` risponde 409) il rinnovo rifiuta, e la libreria ricade nel rifiuto di sempre', async () => {
    const aperturaConScadenza = { ...APERTURA, job: [{ ...APERTURA.job[0], expires_at: futura() }] }
    fetchMock
      .mockResolvedValueOnce(risposta(200, aperturaConScadenza))
      .mockImplementation(async () => risposta(200, statoJob('queued')))
    caricamentoSospeso()
    const { container } = monta()
    scegliVideo(container)
    await waitFor(() => expect(accoda).toHaveBeenCalled())
    const dip = accoda.mock.calls[0][0] as { rinnovaFirma: (jobId: string) => Promise<Record<string, string>> }

    // Il job non aspetta più i byte: non c'è una firma da dare.
    fetchMock.mockImplementationOnce(async () => risposta(409, { error: 'x', codice: 'VIDEO_GIA_CONCLUSO' }))
    await expect(dip.rinnovaFirma(JOB)).rejects.toThrow('FirmaNonDisponibile')

    await act(async () => {
      sblocca?.(null)
      await Promise.resolve()
    })
  })
})
