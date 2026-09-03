import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { arubaUltimoNumeroFattura, numeroSezionaleDaEtichetta, PAUSA_FRA_PAGINE_MS } from '@/lib/aruba/client'
import { progressivoInvioFattura } from '@/lib/aruba/emissione'

/**
 * L'ULTIMO NUMERO DI UNA SERIE FISCALE — il pezzo che, sbagliato, produce un illecito.
 *
 * ─── COSA C'ERA PRIMA, MISURATO ──────────────────────────────────────────────
 * `arubaUltimoNumeroFattura` faceva, su ogni etichetta:
 *     parseInt(String(inv.number).replace(/[^\d]/g, ''), 10)
 * Da `Asilo 2327/2026` ricavava **23272026**; da `FPR 1946/26` **194626**. Le due serie
 * finivano nello stesso mucchio e il «massimo» era un numero senza alcun rapporto con la
 * numerazione vera. L'unico test che esisteva passava un numero già nudo, quindi non poteva
 * accorgersene.
 *
 * ─── PERCHÉ IL VERSO DELL'ERRORE CONTA PIÙ DELL'ERRORE ───────────────────────
 * In produzione «Asilo» è a 2.327 documenti e «FPR» a 1.946: sono serie vere, tenute a mano
 * dalla segreteria sul gestionale di Aruba. Un numero LETTO TROPPO BASSO fa emettere un
 * documento con un numero già usato — che si corregge solo con una nota di variazione. Un
 * numero letto troppo alto lascia un buco, che è tollerabile. Perciò qui la severità è
 * deliberata: ciò che non si riconosce vale `null`, mai «zero».
 */
describe('numeroSezionaleDaEtichetta — legge la serie, non le cifre', () => {
  it('legge le due forme reali: «Asilo 2327/2026» (4 cifre) e «FPR 1946/26» (2 cifre)', () => {
    expect(numeroSezionaleDaEtichetta('Asilo 2327/2026', 'Asilo', 2026)).toBe(2327)
    expect(numeroSezionaleDaEtichetta('FPR 1946/26', 'FPR', 2026)).toBe(1946)
  })

  it('LA REGRESSIONE: non concatena più le cifre di numero e anno', () => {
    // 23272026 e 194626 sono i due valori che il vecchio codice restituiva.
    expect(numeroSezionaleDaEtichetta('Asilo 2327/2026', 'Asilo', 2026)).not.toBe(23272026)
    expect(numeroSezionaleDaEtichetta('FPR 1946/26', 'FPR', 2026)).not.toBe(194626)
  })

  it('LE DUE SERIE NON SI MESCOLANO: chiedendo «FPR» un documento «Asilo» non conta', () => {
    // È il difetto peggiore del vecchio parser: «Asilo» è quasi mille documenti più avanti,
    // e il suo massimo trascinato su FPR avrebbe bruciato in un colpo 380 numeri della serie
    // sbagliata — buchi su una serie e collisioni sull'altra.
    expect(numeroSezionaleDaEtichetta('Asilo 2327/2026', 'FPR', 2026)).toBeNull()
    expect(numeroSezionaleDaEtichetta('FPR 1946/26', 'Asilo', 2026)).toBeNull()
  })

  it('l\'ANNO deve tornare, nelle due scritture: 4 cifre esatte, oppure le ultime 2', () => {
    expect(numeroSezionaleDaEtichetta('Asilo 2327/2025', 'Asilo', 2026)).toBeNull()
    expect(numeroSezionaleDaEtichetta('FPR 1946/25', 'FPR', 2026)).toBeNull()
    expect(numeroSezionaleDaEtichetta('FPR 1946/06', 'FPR', 2006)).toBe(1946)
    // Il 2000 scritto a due cifre è «00»: senza il padding sarebbe stato «0» e non tornava.
    expect(numeroSezionaleDaEtichetta('FPR 12/00', 'FPR', 2000)).toBe(12)
  })

  it('tollera le sbavature di scrittura (maiuscole, spazi doppi, spazi attorno alla barra)', () => {
    expect(numeroSezionaleDaEtichetta('  asilo   2327 / 2026 ', 'Asilo', 2026)).toBe(2327)
    expect(numeroSezionaleDaEtichetta('FPR\t1946/26', 'FPR', 2026)).toBe(1946)
  })

  it('ciò che non si riconosce vale `null`, MAI zero', () => {
    // «zero» significherebbe «questa serie non è mai partita»: è esattamente
    // l'affermazione che fa emettere un «1» su una serie di duemila documenti.
    for (const etichetta of ['2327', 'Asilo 2327', '', null, undefined, 42, 'Fattura n. 12 del 2026', 'Asilo /2026']) {
      expect(numeroSezionaleDaEtichetta(etichetta, 'Asilo', 2026), String(etichetta)).toBeNull()
    }
  })

  it('un progressivo 0 o negativo non è un numero di fattura', () => {
    expect(numeroSezionaleDaEtichetta('Asilo 0/2026', 'Asilo', 2026)).toBeNull()
  })
})

describe('progressivoInvioFattura — un nome file diverso per ogni serie', () => {
  it('la stessa 2328 su due serie NON produce lo stesso progressivo', () => {
    // Lo SdI costruisce il nome del file sul ProgressivoInvio: due uguali e Aruba
    // risponde «00404 File già inviato con lo stesso nome» su una fattura valida.
    expect(progressivoInvioFattura('Asilo', 2328, 2026)).toBe('A26002328')
    expect(progressivoInvioFattura('FPR', 2328, 2026)).toBe('F26002328')
    expect(progressivoInvioFattura('Asilo', 2328, 2026)).not.toBe(progressivoInvioFattura('FPR', 2328, 2026))
  })

  it('sta nei 10 caratteri di `String10Type`, anche a numeri alti', () => {
    expect(progressivoInvioFattura('Asilo', 999999, 2026).length).toBeLessThanOrEqual(10)
  })

  it('anni diversi, progressivi diversi: la serie che riparte non ricicla un nome file', () => {
    expect(progressivoInvioFattura('Asilo', 1, 2026)).not.toBe(progressivoInvioFattura('Asilo', 1, 2027))
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * La lettura vera, con la rete finta.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Una pagina di `findByUsername` nella forma MISURATA il 2026-09-02.
 *
 * ─── PERCHÉ QUESTO HELPER È STATO RISCRITTO ──────────────────────────────────
 * Fino a quel giorno produceva `{ invoices: [{ number }, …] }`: un elenco piatto di
 * fatture, cioè **la stessa forma sbagliata che il codice si aspettava**. Mock e parser
 * si davano ragione a vicenda, e i dieci test che passano di qui restavano verdi anche
 * col parser rotto — misurato: rimettendo il vecchio `etichetteDellElemento` fallivano
 * 2 casi su 24, e nessuno era di questi dieci.
 * Oggi, con questa fixture, la stessa rottura fa fallire 8 dei dieci casi che passano di qui
 * (10 su 24 nell'intero file, misurato il 2026-09-03: i due che restano verdi asseriscono
 * un'eccezione o uno zero, che il parser rotto produce comunque).
 *
 * La forma vera è una PAGINA Spring Data i cui elementi non sono fatture ma DOCUMENTI
 * (`filename`, `idSdi`, `sender`, `receiver`), ognuno con le proprie fatture in un array
 * ANNIDATO. Il numero sta lì:
 *
 *     json.content[i].invoices[j].number  ===  «Asilo 2327/2026»
 *
 * ⚠️ La busta ha una chiave `number`, ma è il NUMERO DI PAGINA di Spring — sulla prima
 * pagina, misurata, valeva `0`. Sta qui apposta: chi la leggesse da lì otterrebbe
 * «pagina zero» e la scambierebbe per un progressivo.
 *
 * `totalElements` e `totalPages` sono calcolati come se le pagine precedenti fossero
 * state piene, perché una fixture conosce solo la propria pagina. Il codice non li
 * guarda: lo scorrimento si ferma sulla prima pagina non piena, contando i documenti.
 */
function rispostaConNumeri(numeri: (string | number | null)[], pagina = 0): Response {
  /** = `PAGINA_SIZE` in `src/lib/aruba/client.ts`: sotto questa soglia lo scorrimento si ferma. */
  const SIZE = 500
  const content = numeri.map((n, i) => ({
    filename: `IT01879020517_${String(i).padStart(5, '0')}.xml.p7m`,
    idSdi: '17898673698',
    invoices: [{ number: n, invoiceDate: '2026-09-01T00:00:00.000+0000', status: 'DELIVERED' }],
  }))
  const piena = content.length >= SIZE
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        content,
        number: pagina, // ← numero di PAGINA, non di fattura
        size: SIZE,
        numberOfElements: content.length,
        totalElements: pagina * SIZE + content.length,
        totalPages: pagina + (piena ? 2 : 1),
        first: pagina === 0,
        last: !piena,
      }),
  } as Response
}

/**
 * Le pause fra una pagina e l'altra scattano tutte, senza che nessuno le aspetti davvero:
 * qui si misura il RISULTATO, e la durata ha già il suo caso in `numerazione-un-passaggio.test.ts`.
 * Il gestore agganciato PRIMA di muovere l'orologio serve a una cosa sola: un rifiuto che
 * arriva mentre i timer avanzano non deve diventare un «Unhandled Rejection» in più nel
 * referto (col parser rotto ne comparivano tre, accanto ai dieci test rossi veri). L'esito
 * lo legge comunque l'`await` sotto, che rilancia.
 */
async function finoInFondo<T>(lavoro: Promise<T>): Promise<T> {
  void lavoro.catch(() => undefined)
  await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS * 25)
  return await lavoro
}

describe('arubaUltimoNumeroFattura — massimo della SERIE, non del mucchio', () => {
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

  it('prende il massimo della serie richiesta e ignora l\'altra', async () => {
    fetchMock.mockResolvedValue(
      rispostaConNumeri(['Asilo 2325/2026', 'FPR 1946/26', 'Asilo 2327/2026', 'FPR 1900/26', 'Asilo 2326/2026']),
    )
    expect(await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' })).toBe(2327)
    fetchMock.mockClear()
    expect(await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'FPR' })).toBe(1946)
  })

  it('la finestra è l\'anno, e il filtro sul mittente arriva alla query', async () => {
    fetchMock.mockResolvedValue(rispostaConNumeri(['Asilo 10/2026']))
    await arubaUltimoNumeroFattura('production', 'AT', { ...parametri, sezionale: 'Asilo', vatcodeSender: '03394870616' })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('https://ws.fatturazioneelettronica.aruba.it/services/invoice/out/findByUsername')
    expect(url).toContain('startDate=2026-01-01')
    expect(url).toContain('endDate=2026-12-31')
    expect(url).toContain('vatcodeSender=03394870616')
  })

  it('SCORRE LE PAGINE: con 2.327 documenti il massimo non sta nei primi 500', async () => {
    // Il vecchio codice chiedeva `page=1&size=500` e prendeva il massimo di quei 500,
    // senza che nessuno avesse mai verificato in che ORDINE Aruba li restituisce. Su una
    // serie da 2.327 documenti è il massimo di un pezzo qualunque dell'elenco.
    const paginaPiena = (da: number, pagina: number) =>
      rispostaConNumeri(Array.from({ length: 500 }, (_, i) => `Asilo ${da + i}/2026`), pagina)
    fetchMock
      .mockResolvedValueOnce(paginaPiena(1, 0))
      .mockResolvedValueOnce(paginaPiena(501, 1))
      .mockResolvedValueOnce(rispostaConNumeri(['Asilo 1001/2026', 'Asilo 2327/2026'], 2))

    expect(await finoInFondo(arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' }))).toBe(2327)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2][0])).toContain('page=3')
  })

  it('si ferma alla prima pagina non piena (nessuna richiesta di troppo)', async () => {
    fetchMock.mockResolvedValue(rispostaConNumeri(['Asilo 7/2026']))
    await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('anno senza documenti → guarda l\'anno PRECEDENTE, per non ricominciare da 1', async () => {
    // Non sappiamo se le due serie ripartano da 1 a gennaio: 2.327 documenti in un anno
    // solo, per una scuola con una trentina di bambini, dicono di no. Nel dubbio si sbaglia
    // nel verso che lascia un BUCO invece di un doppione.
    fetchMock
      .mockResolvedValueOnce(rispostaConNumeri([]))
      .mockResolvedValueOnce(rispostaConNumeri(['Asilo 2327/2025']))

    expect(await finoInFondo(arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' }))).toBe(2327)
    expect(String(fetchMock.mock.calls[1][0])).toContain('startDate=2025-01-01')
  })

  it('nessun documento in due anni → 0 (la serie è davvero nuova)', async () => {
    fetchMock.mockResolvedValue(rispostaConNumeri([]))
    expect(await finoInFondo(arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'FPR' }))).toBe(0)
  })

  it('ARUBA RISPONDE 200 E NON SE NE CAPISCE UN\'ETICHETTA → LANCIA, non «serie nuova»', async () => {
    // IL DIFETTO CHE QUESTO CASO CHIUDE, ed è quello che nessun errore segnalava.
    // `numeroSezionaleDaEtichetta` è severa e fa bene: ciò che non riconosce vale
    // `null`. Ma la funzione aggregata sommava quei `null` a zero e restituiva 0 —
    // che significa «la serie non è mai partita». Con `findByUsername` che risponde
    // 200 e duemila documenti, il risultato era `p_min = 0` → «Asilo 1/2026» su una
    // serie da 2.327 documenti.
    //
    // Basta che il campo `number` contenga il progressivo NUDO — ed è proprio la
    // forma che `docs/fatturazione/tracciato-di-riferimento.md` documenta per il
    // `ProgressivoInvio`. Nessuno in questo repo ha mai MISURATO cosa contenga quel
    // campo: è un'assunzione, e un'assunzione non può valere un numero di fattura.
    fetchMock.mockResolvedValue(rispostaConNumeri(['2325', '2326', '2327']))
    const errore = await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' }).catch((e) => e)
    expect(errore, 'zero qui significherebbe emettere il numero 1 su una serie viva').toBeInstanceOf(Error)
    expect((errore as Error).name).toBe('ArubaNumerazioneError')
    // Il campione serve a chi legge il log per capire in che forma Aruba parla adesso.
    expect((errore as Error).message).toContain('2325')
  })

  it('etichette LEGGIBILI ma di un\'altra serie → 0 è una risposta VERA, e non lancia', async () => {
    // La distinzione è tutto il punto: «non ho capito niente» è un guasto, «ho capito
    // e questa serie non ha documenti» è un fatto. Qui `FPR` non ha nulla nel 2026 e
    // nemmeno nel 2025: la serie è davvero nuova e deve poter partire da 1.
    fetchMock.mockResolvedValue(rispostaConNumeri(['Asilo 2325/2026', 'Asilo 2327/2026']))
    expect(await finoInFondo(arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'FPR' }))).toBe(0)
  })

  it('anche UNA SOLA etichetta capita basta a non lanciare (il resto è rumore del gestionale)', async () => {
    // Una riga storta fra mille — una nota di credito, un documento importato — non
    // deve bloccare l'emissione: si blocca solo quando NON SE NE CAPISCE NEMMENO UNA.
    fetchMock.mockResolvedValue(rispostaConNumeri(['boh', 'n. 12', 'Asilo 2327/2026', null]))
    expect(await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' })).toBe(2327)
  })

  it('l\'anno PRECEDENTE illeggibile lancia anche lui: il ripiego non è una scorciatoia', async () => {
    fetchMock
      .mockResolvedValueOnce(rispostaConNumeri([]))
      .mockResolvedValueOnce(rispostaConNumeri([1946, 1947]))
    const errore = await finoInFondo(arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'FPR' }).catch((e) => e))
    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).name).toBe('ArubaNumerazioneError')
  })

  it('LA FORMA VERA DI ARUBA: il numero sta nelle fatture DENTRO il documento', async () => {
    // ─── QUESTO CASO NASCE DA UN GUASTO IN PRODUZIONE, NON DA UN'IDEA ──────────────
    // Il 2026-09-02, da Kidville Aversa, un'emissione si è fermata con «Impossibile
    // leggere l'ultimo numero della serie FPR». Il log diceva: signin 200,
    // findByUsername 200, 3.311 documenti nell'anno, e NESSUNA etichetta riconosciuta —
    // primo valore non riconosciuto «(vuoto)».
    //
    // Misurato lo stesso giorno contro l'API vera (scripts/aruba-forma-elenco.mjs, sola
    // lettura, 100/100 elementi): `findByUsername` restituisce una PAGINA Spring, i cui
    // elementi sono DOCUMENTI — `filename`, `idSdi`, `sender`, `receiver` — e ogni
    // documento contiene le sue fatture in un array annidato. Il numero sta LÌ:
    //
    //     json.content[i].invoices[j].number === «Asilo 2327/2026»
    //
    // Il codice leggeva `.number` sul DOCUMENTO, che quel campo non ce l'ha.
    //
    // ⚠️ Due trappole che questa fixture riproduce apposta:
    //  1. la busta ha una chiave `number` a livello alto, ma è il NUMERO DI PAGINA di
    //     Spring Data (`number: 0`), non un numero di fattura. Chi lo legge per sbaglio
    //     ottiene «pagina zero» e lo scambia per un progressivo;
    //  2. `invoices` è un ARRAY: un file FatturaPA può contenere più fatture. Si scorrono
    //     tutte, non solo la prima — sul campione vero era sempre 1, e fermarsi lì
    //     sarebbe stato assumere di nuovo qualcosa che non si è misurato.
    const paginaAruba = (numeri: string[]): Response => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          number: 0, // ← numero di PAGINA, non di fattura
          size: 500,
          totalElements: numeri.length,
          content: numeri.map((n, i) => ({
            filename: `IT01879020517_0000${i}.xml.p7m`,
            idSdi: '17898673698',
            docType: 'FAT',
            invoiceType: 'FPR12',
            sender: { fiscalCode: '03394870616', vatCode: '03394870616' },
            receiver: { fiscalCode: 'AAAAAA00A00A000A' },
            invoices: [{ number: n, invoiceDate: '2026-09-01T00:00:00.000+0000', status: 'DELIVERED' }],
          })),
        }),
    }) as Response

    fetchMock.mockResolvedValue(paginaAruba(['Asilo 2325/2026', 'FPR 1946/26', 'Asilo 2327/2026']))
    expect(await arubaUltimoNumeroFattura('production', 'AT', { ...parametri, sezionale: 'Asilo' })).toBe(2327)
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(paginaAruba(['Asilo 2325/2026', 'FPR 1946/26', 'Asilo 2327/2026']))
    expect(await arubaUltimoNumeroFattura('production', 'AT', { ...parametri, sezionale: 'FPR' })).toBe(1946)
  })

  it('un documento con PIÙ fatture dentro: si guardano tutte, non solo la prima', async () => {
    // `invoices` è un array e il tracciato FatturaPA ammette più `FatturaElettronicaBody`
    // nello stesso file. Se si leggesse solo `invoices[0]`, il massimo della serie
    // potrebbe restare nascosto dentro un documento già letto — e sarebbe di nuovo un
    // numero più basso del vero, cioè un doppione.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [
            { filename: 'a.p7m', invoices: [{ number: 'Asilo 10/2026' }, { number: 'Asilo 4000/2026' }] },
          ],
        }),
    } as Response)
    expect(await arubaUltimoNumeroFattura('production', 'AT', { ...parametri, sezionale: 'Asilo' })).toBe(4000)
  })

  it('documenti SENZA fatture dentro → LANCIA, e il log dice quali chiavi sono arrivate', async () => {
    // Il caso che verrebbe dopo, se Aruba cambiasse ancora forma: l'array
    // annidato sparisce o si svuota. Il verso in cui si sbaglia dev'essere
    // sempre lo stesso — non emettere — perché uno zero qui significa «la serie
    // non è mai partita», ed è la frase che fa uscire «Asilo 1/2026».
    //
    // E il messaggio deve portare le CHIAVI del primo elemento: il 2026-09-02
    // diceva solo «(vuoto)», che non distingue «il campo è vuoto» da «il campo
    // non esiste più» — ed era la seconda. Nomi di campo, mai valori: dentro
    // quegli elementi c'è `receiver.fiscalCode`, cioè un genitore vero.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [
            { filename: 'a.p7m', idSdi: '17898673698', invoices: [] },
            { filename: 'b.p7m', idSdi: '17898673699' },
          ],
        }),
    } as Response)
    const errore = await arubaUltimoNumeroFattura('production', 'AT', { ...parametri, sezionale: 'Asilo' }).catch((e) => e)
    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).name).toBe('ArubaNumerazioneError')
    expect((errore as Error).message).toContain('filename')
    expect((errore as Error).message).toContain('idSdi')
  })

  it('un rifiuto HTTP LANCIA, col corpo del provider: non si degrada a zero', async () => {
    // Zero vorrebbe dire «serie nuova», e su una serie viva è un numero già usato.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"errorDescription":"User not enabled for outgoing invoices"}',
    } as Response)
    const errore = await arubaUltimoNumeroFattura('demo', 'AT', { ...parametri, sezionale: 'Asilo' }).catch((e) => e)
    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).message).toContain('User not enabled for outgoing invoices')
  })
})
