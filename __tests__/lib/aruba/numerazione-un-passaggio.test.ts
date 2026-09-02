import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { arubaUltimiNumeriFattura, arubaUltimoNumeroFattura } from '@/lib/aruba/client'

/**
 * UN SOLO PASSAGGIO PER TUTTE LE SERIE, E UN RITMO CHE ARUBA REGGE.
 *
 * ─── COSA SI È MISURATO, IL 2026-09-02 ──────────────────────────────────────────────
 * Il collaudo di sola lettura contro l'API vera ha preso `429`, ma NON alla prima
 * chiamata: `signin` era passato, l'intero scorrimento della serie «Asilo» era passato,
 * e il muro è arrivato sulla prima pagina di «FPR» — otto richieste accettate in
 * **4,2 secondi**, la nona no.
 *
 * Due conseguenze, ed è quello che questi test bloccano:
 *
 *  1. La richiesta a `findByUsername` NON contiene il sezionale. Leggere due serie
 *     scaricava **due volte le stesse pagine** per filtrarle in modo diverso: metà
 *     delle richieste erano un duplicato esatto. Ora si scorre una volta sola.
 *  2. Il limite di Aruba punisce la FREQUENZA, non un monte-ore. Le pagine partivano
 *     una attaccata all'altra, senza pause e senza ritentativi.
 *
 * ⚠️ Il difetto n. 1 riguarda la PRODUZIONE, non solo il collaudo: un lotto di rette
 * con dentro sia un bambino del nido sia uno della fascia FPR faceva la stessa raffica
 * di quattordici richieste, e `arubaUltimoNumeroFattura` LANCIA — quindi il lotto si
 * sarebbe fermato a metà, con parte delle famiglie fatturate e parte no.
 */

/** Una pagina di `findByUsername` nella forma MISURATA: documenti con `invoices` annidato. */
function pagina(numeri: string[], piena = false): Response {
  const content = numeri.map((n) => ({
    filename: 'IT00000000000_00000.xml.p7m',
    invoices: [{ number: n, status: 'DELIVERED' }],
  }))
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content, size: 500, numberOfElements: piena ? 500 : numeri.length }),
  } as Response
}

/** Una pagina PIENA (500 documenti): è ciò che fa continuare lo scorrimento. */
function paginaPiena(da: number, serie: string, anno: string): Response {
  return pagina(
    Array.from({ length: 500 }, (_, i) => `${serie} ${da + i}/${anno}`),
    true,
  )
}

/** Il `429` come arriva davvero da Aruba: una pagina HTML, non un JSON. */
function troppeRichieste(): Response {
  return {
    ok: false,
    status: 429,
    text: async () => '<html><head><title>Troppe richieste</title></head><body></body></html>',
  } as Response
}

describe('arubaUltimiNumeriFattura — le pagine si scaricano UNA volta sola', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const parametri = { username: 'utente@scuola.it', anno: 2026 } as const

  it('due serie, un solo scorrimento: le richieste NON raddoppiano', async () => {
    // Tre pagine: le prime due piene, la terza corta (che ferma lo scorrimento).
    // Dentro ci stanno mescolate entrambe le serie, esattamente come nell'elenco vero.
    fetchMock
      .mockResolvedValueOnce(paginaPiena(1, 'Asilo', '2026'))
      .mockResolvedValueOnce(paginaPiena(501, 'Asilo', '2026'))
      .mockResolvedValueOnce(pagina(['Asilo 2327/2026', 'FPR 1946/26', 'FPR 1900/26']))

    const massimi = await arubaUltimiNumeriFattura('demo', 'AT', {
      ...parametri,
      sezionali: ['Asilo', 'FPR'],
    })

    expect(massimi.get('Asilo')).toBe(2327)
    expect(massimi.get('FPR')).toBe(1946)
    // IL NUMERO CHE CONTA. Prima erano tre pagine PER SERIE, cioè sei richieste per
    // gli stessi identici dati; ed è la sesta che, in presa diretta, ha preso `429`.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('l\'anno precedente si guarda SOLO per la serie rimasta a zero', async () => {
    // «Asilo» ha documenti nel 2026, «FPR» no. Riscaricare il 2025 anche per «Asilo»
    // sarebbe un giro di pagine comprato per un dato che è già in mano.
    fetchMock
      .mockResolvedValueOnce(pagina(['Asilo 2327/2026']))
      .mockResolvedValueOnce(pagina(['FPR 1946/25', 'Asilo 9999/2025']))

    const massimi = await arubaUltimiNumeriFattura('demo', 'AT', {
      ...parametri,
      sezionali: ['Asilo', 'FPR'],
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain('startDate=2025-01-01')
    expect(massimi.get('FPR')).toBe(1946)
    // «Asilo» tiene il valore del 2026 e NON quello trovato per caso nella pagina
    // del 2025: quella pagina è stata chiesta per un'altra serie.
    expect(massimi.get('Asilo')).toBe(2327)
  })

  it('l\'involucro a una serie sola resta quello di prima', async () => {
    fetchMock.mockResolvedValue(pagina(['Asilo 2325/2026', 'FPR 1946/26', 'Asilo 2327/2026']))
    expect(await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' })).toBe(2327)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('il ritmo verso Aruba', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const parametri = { username: 'utente@scuola.it', anno: 2026 } as const

  it('fra una pagina e l\'altra ci passa del tempo (e la PRIMA non aspetta)', async () => {
    fetchMock
      .mockResolvedValueOnce(paginaPiena(1, 'Asilo', '2026'))
      .mockResolvedValueOnce(pagina(['Asilo 2327/2026']))

    const inizio = Date.now()
    await arubaUltimiNumeriFattura('demo', 'AT', { ...parametri, sezionali: ['Asilo'] })
    const trascorso = Date.now() - inizio

    // Due pagine ⇒ UNA pausa sola. Senza il ritmo questo valore è ~0, ed è la raffica
    // che Aruba rifiuta. La soglia sta sotto la pausa vera: qui si prova che una
    // pausa C'È, non quanto duri al millisecondo.
    expect(trascorso).toBeGreaterThan(500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('su 429 aspetta e ritenta UNA volta sola, poi restituisce il numero', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(troppeRichieste())
      .mockResolvedValueOnce(pagina(['FPR 1946/26']))

    const attesa = arubaUltimiNumeriFattura('demo', 'AT', { ...parametri, sezionali: ['FPR'] })
    await vi.advanceTimersByTimeAsync(120_000)
    const massimi = await attesa

    expect(massimi.get('FPR')).toBe(1946)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('due 429 di fila NON diventano tre tentativi: si lancia', async () => {
    // Insistere su un limite che punisce la frequenza è il modo di peggiorarlo. E
    // fermarsi è la risposta giusta: senza il progressivo lettovi non si emette.
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(troppeRichieste())

    const attesa = arubaUltimiNumeriFattura('demo', 'AT', { ...parametri, sezionali: ['FPR'] }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(120_000)
    const errore = await attesa

    expect(errore).toBeInstanceOf(Error)
    expect((errore as { code?: unknown }).code).toBe('429')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
