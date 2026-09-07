import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { arubaUltimiNumeriFattura, PAGINA_SIZE, PAUSA_FRA_PAGINE_MS } from '@/lib/aruba/client'

/**
 * L'INVOLUCRO DELLA PAGINA SI LEGGE, E QUANDO NON TORNA SI LANCIA.
 *
 * ─── LA MISURA, 2026-09-07 ──────────────────────────────────────────────────────────
 * Contro l'API vera (`scripts/collaudo/aruba-pagina-grande.collaudo.ts`), chiedendo
 * `size=5000` e poi `size=3500`, Aruba ha risposto **HTTP 200** con:
 *
 *     { content: [], errorCode: "0001", size: 0, totalElements: 0, last: false, ... }
 *
 * Cioè: **un rifiuto travestito da successo.** Il codice di allora leggeva `content`,
 * lo trovava vuoto, e concludeva «la serie non ha documenti» — che per
 * `leggiPavimentoSerie` significa **pavimento ZERO**, e per la RPC significa emettere
 * «Asilo 1/2026» su una serie che ne ha duemilatrecento. Nessuna eccezione, nessun log.
 *
 * Con `size=2000` la stessa API risponde `errorCode: "0000"`, `size: 2000`,
 * `totalElements: 3327`, `totalPages: 2`, `number: 1`, `first: true`. Da lì tre fatti
 * che questi test incidono nel codice:
 *
 *  · **l'involucro sta IN CIMA**, non sotto `value` — `paginaUltimoNumero` fa
 *    `(json.value) ?? json` e cade sul secondo ramo. Le fixture qui sotto rispettano
 *    quel livello, perché una fixture al livello sbagliato è verde e cieca: è
 *    letteralmente l'incidente del 2026-09-02;
 *  · **`page` è 1-BASED** (`page=1` → `number: 1`, `first: true`);
 *  · **il tetto vero della `size` sta fra 2000 e 3500**, non a 100 come dichiara la
 *    documentazione né a 500 come chiedevamo.
 *
 * ─── PERCHÉ LA GUARDIA STA SULLA `size` ECHEGGIATA E NON SU `last` ──────────────────
 * L'asimmetria è tutto: `last` sbagliato **fallisce APERTO** — chiude lo scorrimento e
 * restituisce un massimo basso senza dire niente — mentre un confronto sui conteggi
 * **fallisce CHIUSO**: lancia, e nessuna fattura esce. Su un documento fiscale
 * irreversibile si sbaglia dalla parte del non emettere. Perciò `last` si usa solo per
 * FERMARE prima, mai per decidere che il lavoro è finito.
 */

/** Quanti documenti finge di restituire il server quando tappa la `size` di nascosto. */
const SIZE_TAPPATA = 500

/**
 * ⚠️ AUTOCONTROLLO. Se qualcuno riportasse `PAGINA_SIZE` a 500, questo file resterebbe
 * verde senza collaudare più niente — il «cap» finto coinciderebbe con la richiesta.
 * Stessa disciplina di `logging-coverage.test.ts`: un test che può autoingannarsi lo
 * dichiara e si rompe da solo.
 */
it('la size finta del server deve stare SOTTO quella che chiediamo, o questo file non prova niente', () => {
  expect(SIZE_TAPPATA).toBeLessThan(PAGINA_SIZE)
})

/** Un documento nella forma vera: il numero sta in `invoices[].number`, non sul documento. */
function doc(numero: string): unknown {
  return { filename: 'IT00000000000_00000.xml.p7m', invoices: [{ number: numero, status: 'DELIVERED' }] }
}

/**
 * Una risposta di `findByUsername` nella forma MISURATA: involucro in cima, `content`
 * accanto agli altri campi, nessun `value`.
 */
function busta(campi: {
  documenti?: unknown[]
  size?: number
  totalElements?: number
  totalPages?: number
  number?: number
  first?: boolean
  last?: boolean
  errorCode?: string
}): Response {
  const documenti = campi.documenti ?? []
  const corpo: Record<string, unknown> = {
    content: documenti,
    errorCode: campi.errorCode ?? '0000',
    errorDescription: '',
    first: campi.first ?? true,
    last: campi.last ?? true,
    number: campi.number ?? 1,
    numberOfElements: documenti.length,
    size: campi.size ?? PAGINA_SIZE,
    totalElements: campi.totalElements ?? documenti.length,
    totalPages: campi.totalPages ?? 1,
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(corpo) } as Response
}

/** Il rifiuto travestito da successo, copiato dalla misura del 2026-09-07. */
function rifiutoTravestito(): Response {
  return busta({ documenti: [], errorCode: '0001', size: 0, totalElements: 0, totalPages: 0, number: 0, first: false, last: false })
}

/** Una pagina PIENA quanto la `size` che abbiamo chiesto. */
function paginaPiena(da: number, serie: string, anno: string, extra: Parameters<typeof busta>[0] = {}): Response {
  return busta({
    documenti: Array.from({ length: PAGINA_SIZE }, (_, i) => doc(`${serie} ${da + i}/${anno}`)),
    ...extra,
  })
}

/** Fa scattare tutte le pause senza aspettarle davvero. */
async function finoInFondo<T>(lavoro: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS * 25)
  return await lavoro
}

describe('la guardia sull\'involucro di findByUsername', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const parametri = { username: 'utente@scuola.it', anno: 2026 } as const
  const leggi = (sezionali: readonly ('Asilo' | 'FPR')[] = ['Asilo']) =>
    arubaUltimiNumeriFattura('demo', 'AT', { ...parametri, sezionali })

  it('un 200 con errorCode «0001» NON è una serie vuota: lancia invece di restituire zero', async () => {
    // È la risposta vera di Aruba a `size=5000`, misurata il 2026-09-07. Prima di
    // questa guardia usciva `0`, e uno zero qui è il numero che fa ripartire da 1
    // una serie viva.
    fetchMock.mockResolvedValue(rifiutoTravestito())

    const errore = await finoInFondo(leggi().catch((e: unknown) => e))

    expect(errore).toBeInstanceOf(Error)
    expect((errore as { code?: string }).code).toBe('involucro-errore')
    expect((errore as Error).message).toContain('0001')
  })

  it('la size tappata in silenzio si vede dall\'eco, e ferma tutto', async () => {
    // Chiediamo PAGINA_SIZE, il server ne concede SIZE_TAPPATA e lo dichiara
    // nell'involucro. Senza questa guardia, `ricevuti < PAGINA_SIZE` direbbe
    // «finito» dopo una pagina: il massimo dei primi 500 documenti su 3.327.
    fetchMock.mockResolvedValue(
      busta({
        documenti: Array.from({ length: SIZE_TAPPATA }, (_, i) => doc(`Asilo ${1 + i}/2026`)),
        size: SIZE_TAPPATA,
        totalElements: 3327,
        totalPages: 7,
        last: false,
      }),
    )

    const errore = await finoInFondo(leggi().catch((e: unknown) => e))

    expect(errore).toBeInstanceOf(Error)
    expect((errore as { code?: string }).code).toBe('size-tappata')
  })

  it('se totalElements dice più di quanto abbiamo analizzato, lo scorrimento è incompleto: lancia', async () => {
    // L'invariante numerica. Non dipende da `last`, non dipende dall'ordinamento:
    // o abbiamo visto tutti i documenti che l'involucro dichiara, o non lo sappiamo.
    fetchMock
      .mockResolvedValueOnce(paginaPiena(1, 'Asilo', '2026', { totalElements: 9999, totalPages: 5, last: false }))
      .mockResolvedValueOnce(busta({ documenti: [doc('Asilo 2327/2026')], totalElements: 9999, totalPages: 5, last: true }))

    const errore = await finoInFondo(leggi().catch((e: unknown) => e))

    expect(errore).toBeInstanceOf(Error)
    expect((errore as { code?: string }).code).toBe('scorrimento-incompleto')
  })

  it('zero documenti in ENTRAMBI gli anni non è «serie a zero»: è «non misurato», e lancia', async () => {
    // `nessunaEtichettaCapita` non copre questo caso — richiede `ricevutiTotali > 0`.
    // Con zero documenti taceva, e il ripiego sull'anno precedente taceva a sua volta:
    // usciva `0` da due letture mute. Il 1° gennaio, quando la riga del contatore per
    // l'anno nuovo non esiste ancora, quello zero è l'unica cosa fra noi e «Asilo 1».
    fetchMock.mockResolvedValue(busta({ documenti: [], totalElements: 0 }))

    const errore = await finoInFondo(leggi().catch((e: unknown) => e))

    expect(errore).toBeInstanceOf(Error)
    expect((errore as { code?: string }).code).toBe('serie-vuota')
    // Due letture: l'anno chiesto e quello prima. La seconda è il ripiego che c'è già.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('una pagina PIENA con last:true FERMA lo scorrimento: non si chiede la pagina dopo', async () => {
    // IL CASO ROVESCIATO, ed è quello che smaschera un'implementazione che non legge
    // l'involucro: senza `last`, `ricevuti === PAGINA_SIZE` fa chiedere la pagina 2.
    fetchMock.mockResolvedValueOnce(
      paginaPiena(1, 'Asilo', '2026', { totalElements: PAGINA_SIZE, totalPages: 1, last: true }),
    )

    const massimi = await finoInFondo(leggi())

    expect(massimi.get('Asilo')).toBe(PAGINA_SIZE)
    expect(fetchMock, 'l\'involucro diceva che era l\'ultima pagina').toHaveBeenCalledTimes(1)
  })

  it('il massimo che sta nella SECONDA pagina non si perde', async () => {
    // Senza questo caso, un\'implementazione che si ferma alla prima pagina passerebbe
    // tutti i test qui sopra: il massimo vero deve stare dove solo lo scorrimento lo trova.
    fetchMock
      .mockResolvedValueOnce(paginaPiena(1, 'Asilo', '2026', { totalElements: PAGINA_SIZE + 1, totalPages: 2, last: false }))
      .mockResolvedValueOnce(
        busta({ documenti: [doc('Asilo 9001/2026')], totalElements: PAGINA_SIZE + 1, totalPages: 2, number: 2, first: false, last: true }),
      )

    const massimi = await finoInFondo(leggi())

    expect(massimi.get('Asilo')).toBe(9001)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('un involucro SENZA last e SENZA totalElements resta gestito come prima: pagina corta ⇒ fine', async () => {
    // Il ripiego. Aruba oggi manda tutti i campi, ma il codice non deve rompersi se un
    // giorno ne mandasse meno: la lunghezza torna a essere l'unico segnale disponibile.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [doc('Asilo 2327/2026')] }),
    } as Response)

    const massimi = await finoInFondo(leggi())

    expect(massimi.get('Asilo')).toBe(2327)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
