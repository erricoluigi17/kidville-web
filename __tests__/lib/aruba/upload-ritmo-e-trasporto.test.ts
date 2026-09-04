import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * L'UPLOAD HA UN RITMO, E UN RIFIUTO DI TRASPORTO NON È UNO SCARTO FISCALE.
 *
 * ─── LA MISURA CHE COMANDA ──────────────────────────────────────────────────────────
 * La documentazione Aruba (SLA §3, https://fatturazioneelettronica.aruba.it/apidoc/docs.html)
 * dichiara **12 richieste al minuto per IP** sulla ricerca delle fatture inviate e **1 al
 * minuto** sull'autenticazione, con un leaky bucket che «rifiuta istantaneamente con HTTP 429»
 * e «non accoda». Un'emissione costa 1 `signin` + 7 `findByUsername` + 1 `upload`: nove
 * richieste. Il 2026-09-02, in presa diretta, la NONA ha preso `429` dopo 4,2 secondi.
 *
 * ─── I DUE DIFETTI CHE QUESTI TEST CHIUDONO ─────────────────────────────────────────
 *  1. `arubaUpload` NON ritentava mai. Un `429` sull'upload arriva DOPO che la RPC ha già
 *     allocato il numero: il progressivo resta consumato e la fattura non parte. Il limite
 *     punisce la frequenza, quindi la risposta giusta è aspettare — UNA volta sola, perché
 *     insistere è il modo di peggiorare esattamente ciò che si vuole risolvere.
 *  2. RIFIUTO DI TRASPORTO ≠ SCARTO DI MERITO. Un `429` di Aruba è una **pagina HTML**: senza
 *     `errorCode` nell'envelope, `errorCode` diventava la stringa `'429'` e la descrizione il
 *     blob HTML, che il chiamante scriveva in `fatture_emesse.sdi_scarto_motivo` con
 *     `sdi_stato: 2` — su una tabella WORM, dove il `DELETE` è vietato dal trigger. Un limite
 *     di frequenza diventava un **rifiuto fiscale permanente**. Stessa cosa per un `401`, un
 *     `5xx`, o un `200` con un corpo che non si riesce a leggere: in nessuno di quei casi si
 *     sa se il documento sia arrivato allo SdI, e «scartata» è un'affermazione FALSA.
 *
 * ⚠️ Un rifiuto di MERITO — `0092` XSD, `0094` IdTrasmittente, `0034` doppione — non si
 * ritenta MAI: ripetere una fattura che Aruba ha respinto nel merito produce lo stesso
 * rifiuto, e il secondo tentativo costa una richiesta al secchio di tutti.
 */

let appLog: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

/** Ricarica il client con la guardia SILENZIOSO spenta e il sink `app_log` finto. */
async function carica() {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  return await import('@/lib/aruba/client')
}

/** Il `429` come arriva davvero da Aruba: una pagina HTML, non un JSON. */
function troppeRichieste(): Response {
  return {
    ok: false,
    status: 429,
    text: async () => '<html><head><title>429 Too Many Requests</title></head><body>Rate limit</body></html>',
  } as Response
}

function risposta(corpo: string, stato = 200): Response {
  return { ok: stato >= 200 && stato < 300, status: stato, text: async () => corpo } as Response
}

const ACCETTATA = '{"errorCode":"0000","errorDescription":"Operazione effettuata","uploadFileName":"IT12345678903_ab12.xml.p7m"}'

const PARAMS = { dataFileBase64: 'eA==', senderPIVA: '12345678903' }

beforeEach(() => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('il ritmo fra le pagine è la misura di Aruba, non una prudenza', () => {
  it('PAUSA_FRA_PAGINE_MS regge le 12 richieste/minuto per IP dichiarate nella SLA §3', async () => {
    const { PAUSA_FRA_PAGINE_MS } = await carica()
    // 12 richieste al minuto ⇒ una ogni 5 secondi. Con 1.100 ms si stava a ~54 al minuto,
    // cioè quattro volte e mezzo il limite documentato: la raffica che ha preso il `429`.
    expect(PAUSA_FRA_PAGINE_MS).toBeGreaterThanOrEqual(60_000 / 12)
  })

  it('la pausa dopo un 429 è più lunga di quella ordinaria (il secchio va lasciato svuotare)', async () => {
    const { PAUSA_FRA_PAGINE_MS, PAUSA_DOPO_429_MS } = await carica()
    expect(PAUSA_DOPO_429_MS).toBeGreaterThan(PAUSA_FRA_PAGINE_MS)
  })
})

describe('arubaUpload — UN solo ritentativo, e solo sul 429', () => {
  it('429 poi 0000: due tentativi, e fra i due passa ESATTAMENTE PAUSA_DOPO_429_MS', async () => {
    vi.useFakeTimers()
    const { arubaUpload, PAUSA_DOPO_429_MS } = await carica()
    fetchMock.mockResolvedValueOnce(troppeRichieste()).mockResolvedValueOnce(risposta(ACCETTATA))

    const attesa = arubaUpload('demo', 'AT', PARAMS)

    // Un millisecondo PRIMA della scadenza il secondo tentativo non è ancora partito: senza
    // questa mezza asserzione «ritenta» sarebbe indistinguibile da «ritenta subito», che è
    // precisamente ciò che il leaky bucket punisce.
    await vi.advanceTimersByTimeAsync(PAUSA_DOPO_429_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    const res = await attesa

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(true)
    expect(res.uploadFileName).toBe('IT12345678903_ab12.xml.p7m')
    // È la risposta al NOSTRO secondo invio, ma non è un `0034`: il campo resta assente.
    expect(res.dopoRitentativo).toBeUndefined()
  })

  it('prima di aspettare LO DICE: riga `warn` con esito `limite-richieste`', async () => {
    vi.useFakeTimers()
    const { arubaUpload, PAUSA_DOPO_429_MS } = await carica()
    fetchMock.mockResolvedValueOnce(troppeRichieste()).mockResolvedValueOnce(risposta(ACCETTATA))

    const attesa = arubaUpload('demo', 'AT', PARAMS)
    await vi.advanceTimersByTimeAsync(PAUSA_DOPO_429_MS)
    await attesa

    // Novanta secondi di silenzio dentro una richiesta HTTP sono indistinguibili da un
    // blocco: senza questa riga, chi guarda i log vede solo una funzione lentissima.
    const righe = appLog.mock.calls.map((c) => c[0] as Record<string, unknown>)
    const avviso = righe.find((r) => JSON.stringify(r).includes('limite-richieste'))
    expect(avviso, 'nessuna riga che annuncia l\'attesa dopo il 429').toBeTruthy()
    expect(avviso!.evento).toBe('fattura')
    expect(avviso!.livello).toBe('warn')
    expect(JSON.stringify(avviso)).toContain('upload')
  })

  it('uno scarto di MERITO (0092 XSD) non si ritenta mai: un solo tentativo', async () => {
    const { arubaUpload } = await carica()
    fetchMock.mockResolvedValue(risposta('{"errorCode":"0092","errorDescription":"Errore validazione XSD"}'))

    const res = await arubaUpload('demo', 'AT', PARAMS)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('0092')
    // Il merito NON è trasporto: questa riga va a registro come scarto vero.
    expect(res.trasporto).toBeFalsy()
  })

  it('un 500 non è un 429: non si ritenta, ma è comunque TRASPORTO (esito ignoto)', async () => {
    const { arubaUpload } = await carica()
    fetchMock.mockResolvedValue(risposta('<html>502 Bad Gateway</html>', 500))

    const res = await arubaUpload('demo', 'AT', PARAMS)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.trasporto).toBe(true)
    expect(res.statoHttp).toBe(500)
    // Nessun ritentativo è partito: il campo che lo dichiara deve tacere.
    expect(res.dopoRitentativo).toBeFalsy()
  })

  it('due 429 di fila NON diventano tre tentativi, e NON lanciano: tornano un rifiuto di trasporto', async () => {
    vi.useFakeTimers()
    const { arubaUpload, PAUSA_DOPO_429_MS } = await carica()
    fetchMock.mockResolvedValue(troppeRichieste())

    const attesa = arubaUpload('demo', 'AT', PARAMS)
    await vi.advanceTimersByTimeAsync(PAUSA_DOPO_429_MS * 3)
    const res = await attesa

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(false)
    expect(res.trasporto).toBe(true)
    expect(res.statoHttp).toBe(429)
    // Un secondo 429 è la risposta al secondo invio, ma «dopo il ritentativo» vale SOLO per
    // il 0034: qui il chiamante deve raccontare un 429, non un file già ricevuto.
    expect(res.dopoRitentativo).toBeUndefined()
  })

  it('un esito RIUSCITO non si ritenta (guardia contro il doppione fiscale)', async () => {
    const { arubaUpload } = await carica()
    fetchMock.mockResolvedValue(risposta(ACCETTATA))

    const res = await arubaUpload('demo', 'AT', PARAMS)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(true)
  })
})

describe('un «0034» DOPO un ritentativo racconta il primo tentativo, non il secondo', () => {
  it('429 poi 0034: è TRASPORTO — il primo file ERA stato ricevuto', async () => {
    // ⚠️ LA RIGA FALSA CHE QUESTO CASO IMPEDISCE. `0034` («File già inviato di recente») è
    // il dedup di Aruba sul file. Se arriva alla PRIMA risposta è uno scarto di merito e
    // basta; se arriva alla SECONDA, dopo che abbiamo ritentato noi, dice una cosa sola:
    // il primo tentativo — quello che ci era tornato indietro come `429` — era stato
    // ricevuto. Scriverlo a registro come `sdi_stato 2` sarebbe FALSO su una tabella WORM,
    // e peggio: le righe scartate sono escluse dall'idempotenza apposta (vanno ri-emesse),
    // quindi la pressione successiva manderebbe allo SdI un SECONDO documento per la
    // stessa retta.
    vi.useFakeTimers()
    const { arubaUpload, PAUSA_DOPO_429_MS } = await carica()
    fetchMock
      .mockResolvedValueOnce(troppeRichieste())
      .mockResolvedValueOnce(risposta('{"errorCode":"0034","errorDescription":"File già inviato di recente"}'))

    const attesa = arubaUpload('demo', 'AT', PARAMS)
    await vi.advanceTimersByTimeAsync(PAUSA_DOPO_429_MS)
    const res = await attesa

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.ok).toBe(false)
    expect(res.trasporto, 'un 0034 dopo un nostro ritentativo NON è uno scarto di merito').toBe(true)
    // Il codice del provider non si butta via (AGENTS.md, regola 3): è l'unica cosa che
    // spiega a chi legge PERCHÉ l'esito è ignoto invece che «Aruba non ha risposto».
    expect(res.errorCode).toBe('0034')
    expect(String(res.errorDescription)).toContain('già inviato')
    // ⚠️ E IL CHIAMANTE DEVE POTERLO SAPERE, non dedurlo. `errorCode === '0034'` NON basta:
    // un `0034` compare identico anche dentro un rifiuto HTTP non-2xx (il ramo `!esito.ok`
    // copia nell'esito l'envelope del rifiuto), dove di ritentativi non ce n'è stato nessuno.
    // Solo questo campo distingue «il primo invio ERA arrivato» da «Aruba ha rifiutato».
    expect(
      res.dopoRitentativo,
      'il chiamante non può sapere che il 0034 è la risposta al nostro secondo invio',
    ).toBe(true)
  })

  it('0034 alla PRIMA risposta resta uno scarto di MERITO (nessun ritentativo di mezzo)', async () => {
    // La controprova: senza un `429` prima, nessuno ha mandato niente due volte. Il dedup
    // parla di un invio PRECEDENTE, non nostro di adesso, e la riga di scarto è vera.
    const { arubaUpload } = await carica()
    fetchMock.mockResolvedValue(risposta('{"errorCode":"0034","errorDescription":"File già inviato di recente"}'))

    const res = await arubaUpload('demo', 'AT', PARAMS)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('0034')
    expect(res.trasporto, 'uno scarto di merito è diventato un rifiuto di trasporto').toBeFalsy()
    expect(res.dopoRitentativo, 'nessun secondo invio è partito: il campo non può dire di sì').toBeFalsy()
  })
})

describe('arubaUpload — un 2xx che non si sa leggere non è un successo', () => {
  it('200 con la pagina HTML di un proxy → trasporto, non «inviata senza nome file»', async () => {
    // Prima tornava `ok: true` con `uploadFileName` indefinito: il chiamante scriveva a
    // registro «Presa in carico» senza il nome file, e il `sync` non poteva più ritrovarla.
    // Un documento fiscale che nessuno può più rintracciare è peggio di un errore.
    const { arubaUpload } = await carica()
    fetchMock.mockResolvedValue(risposta('<html><body>manutenzione</body></html>', 200))

    const res = await arubaUpload('demo', 'AT', PARAMS)

    expect(res.ok).toBe(false)
    expect(res.trasporto).toBe(true)
    expect(res.statoHttp).toBe(200)
    expect(res.dopoRitentativo).toBeUndefined()
  })

  it('rete giù → LANCIA ancora, come prima (una fattura mai partita non va a registro)', async () => {
    const { arubaUpload } = await carica()
    fetchMock.mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'))

    const errore = await arubaUpload('demo', 'AT', PARAMS).catch((e: unknown) => e)

    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).message).toContain('ECONNREFUSED')
  })
})
