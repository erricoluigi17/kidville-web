import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * `logEvento` FINTO, IL RESTO DEL LOGGER VERO (mock parziale via `originale`).
 *
 * Serve per una sola cosa, ed è la ragione per cui questo file lo monta: `arubaGetByFilename`
 * GRIDA quando incontra una dicitura di stato che non sa leggere, e quel grido è la premessa
 * su cui `src/app/api/pagamenti/fattura/sync/route.ts` si permette di lasciare lo 0 in coda.
 * Un segnale che nessuno osserva non è un segnale: senza questo spione, cancellare il blocco
 * d'allarme dal client lascerebbe l'intero repo verde (misurato: `grep -rn
 * 'stato-non-interpretato' __tests__` dava ZERO occorrenze prima di questo file).
 *
 * Parziale e non totale: `@/lib/logging/external` — la porta da cui passa ogni chiamata ad
 * Aruba — importa dallo stesso modulo, e sostituirlo per intero toglierebbe di mezzo pezzi che
 * qui devono restare veri. Le righe che `externalFetch` scrive di suo finiscono nello stesso
 * spione: per questo i filtri qui sotto scelgono per `esito`, non «l'ultima chiamata».
 */
const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})

import {
  arubaBaseUrls,
  resolveArubaCredentials,
  arubaSignin,
  arubaUpload,
  arubaGetByFilename,
} from '@/lib/aruba/client'
import { mapStatoAruba } from '@/lib/aruba/stato'

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response
}

describe('arubaBaseUrls', () => {
  it('production → host di produzione', () => {
    expect(arubaBaseUrls('production')).toEqual({
      auth: 'https://auth.fatturazioneelettronica.aruba.it',
      ws: 'https://ws.fatturazioneelettronica.aruba.it',
    })
  })
  it('demo/sandbox/default → host demo', () => {
    const demo = {
      auth: 'https://demoauth.fatturazioneelettronica.aruba.it',
      ws: 'https://demows.fatturazioneelettronica.aruba.it',
    }
    expect(arubaBaseUrls('demo')).toEqual(demo)
    expect(arubaBaseUrls('sandbox')).toEqual(demo)
    expect(arubaBaseUrls(undefined)).toEqual(demo)
  })
})

describe('resolveArubaCredentials', () => {
  afterEach(() => {
    delete process.env.ARUBA_PASSWORD
    delete process.env.ARUBA_USERNAME
  })
  it('risolve la password dalla env indicata da password_ref (mai in chiaro nel config)', () => {
    process.env.ARUBA_PASSWORD = 'segretissima'
    const creds = resolveArubaCredentials({ username: 'utente@scuola.it', password_ref: 'ARUBA_PASSWORD' })
    expect(creds).toEqual({ username: 'utente@scuola.it', password: 'segretissima' })
  })
  it('senza env/credenziali → null', () => {
    expect(resolveArubaCredentials({ username: 'u', password_ref: 'ARUBA_PASSWORD' })).toBeNull()
    expect(resolveArubaCredentials({})).toBeNull()
  })
})

describe('Aruba REST client (HTTP)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('arubaSignin: POST form-urlencoded grant_type=password e ritorna i token', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 1799 })
    )
    const tokens = await arubaSignin('demo', { username: 'u', password: 'p' })
    expect(tokens.accessToken).toBe('AT')
    expect(tokens.refreshToken).toBe('RT')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://demoauth.fatturazioneelettronica.aruba.it/auth/signin')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toContain('application/x-www-form-urlencoded')
    expect(init.body).toContain('grant_type=password')
    expect(init.body).toContain('username=u')
    expect(init.body).toContain('password=p')
  })

  it('arubaUpload: invia dataFile base64 + Bearer, ok quando errorCode 0000', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ uploadFileName: 'IT01879020517_abcde.xml.p7m', errorCode: '0000', errorDescription: 'OK' })
    )
    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'PGZhdHR1cmE+' })
    expect(res.ok).toBe(true)
    expect(res.uploadFileName).toBe('IT01879020517_abcde.xml.p7m')
    expect(res.errorCode).toBe('0000')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://demows.fatturazioneelettronica.aruba.it/services/invoice/upload')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer AT')
    const body = JSON.parse(init.body)
    expect(body.dataFile).toBe('PGZhdHR1cmE+')
    // SENZA `senderPIVA`: la doc lo lega ai soli TD26 e, «nel caso in cui venga utilizzato», lo
    // vuole come `IT` + P.IVA. Il 2026-09-03 alle 15:57 la prima fattura vera è stata respinta
    // con `0093` «deleghe non valide» perché lo mandavamo a 11 cifre nude su un TD01: Aruba lo
    // confrontava con l'utenza (`IT03394870616`) e non trovava nessun mittente delegato.
    expect('senderPIVA' in body).toBe(false)
  })

  it('arubaUpload: `senderPIVA`, se passato (TD26), viaggia nel corpo COME dato — codice nazione compreso', async () => {
    fetchMock.mockResolvedValue(mockResponse({ uploadFileName: 'IT01879020517_abcde.xml.p7m', errorCode: '0000' }))
    await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: 'IT12345678903' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.senderPIVA).toBe('IT12345678903')
  })

  it('arubaUpload: errorCode diverso da 0000 → ok=false con descrizione errore', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ errorCode: '0094', errorDescription: 'IdTrasmittente non valido' })
    )
    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: 'p' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('0094')
    expect(res.errorDescription).toContain('IdTrasmittente')
  })

  // ─── LA FORMA DELLA RISPOSTA È QUELLA MISURATA, non quella che avevamo in mente ──
  // Questo test montava `{ status: 7 }` al primo livello e passava, perché il codice
  // leggeva `Number(json.value?.status ?? json.status ?? 0)` — cioè lo stesso posto
  // sbagliato del codice. Un test scritto contro la propria implementazione non è un
  // test: era verde mentre in produzione 153 fatture si congelavano.
  //
  // La misura del 2026-09-11 contro l'API vera: nessun involucro `value`, nessuno
  // `status` in cima, lo stato dentro `invoices[0].status` come DICITURA italiana, e
  // `invoices[0]` con esattamente quattro chiavi (`invoiceDate`, `number`, `status`,
  // `statusDescription`).
  it('arubaGetByFilename: lo stato si legge da invoices[0].status come DICITURA, e il PDF resta in cima', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        invoices: [{ invoiceDate: '2026-09-01', number: '999999/2026', status: 'Consegnata', statusDescription: 'Ricevuta di consegna' }],
        pdfFile: 'JVBERi0=',
        errorCode: '0000',
      })
    )
    const st = await arubaGetByFilename('production', 'AT', 'IT01879020517_abcde.xml.p7m')
    expect(st.stato).toBe(7)
    // La parola di Aruba esce dal client: è quella che arriva fino a `sdi_stato_label`.
    expect(st.statoAruba).toBe('Consegnata')
    expect(st.descrizioneAruba).toBe('Ricevuta di consegna')
    expect(st.pdfBase64).toBe('JVBERi0=')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('https://ws.fatturazioneelettronica.aruba.it/services/invoice/out/getByFilename')
    expect(url).toContain('filename=IT01879020517_abcde.xml.p7m')
    expect(url).toContain('includePdf=true')
    expect(init.headers.Authorization).toBe('Bearer AT')
  })

  // Il caso NORMALE: 3.960 documenti su 4.000 rispondono così, e NON è «in attesa».
  //
  // ⚠️ È anche il contro-test del matcher, ed è QUESTO il test a cui la frase appartiene:
  // se qualcuno «migliorasse» il confronto con un `includes`, «Non consegnata»
  // conterrebbe «consegnata» e uscirebbe 7 invece di 6. Tutte e due le voci sono
  // `emessa`, quindi il `fatturaStato` non se ne accorgerebbe: il NUMERO asserito qui
  // sotto è l'unica cosa che lo vede. (Dove un `includes` si paga davvero è sullo
  // scarto, e quello lo tiene il test successivo.)
  it('arubaGetByFilename: «Non consegnata» → 6, che è uno stato EMESSO (deposito SDI)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ invoices: [{ status: 'Non consegnata', statusDescription: null }] }))
    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(6)
    expect(st.statoAruba).toBe('Non consegnata')
  })

  // ⚠️ «Scartata» è l'unica delle tre diciture che significa NON EMESSA: 4, e il
  // documento va corretto e RITRASMESSO. Qui si prova che il MOTIVO esce intero dal
  // client — `statusDescription` da `invoices[0]`, `errorCode`/`errorDescription` dal
  // primo livello dell'involucro. Sono i tre campi che dicono COSA correggere: senza,
  // il registro sa CHE una fattura è stata respinta e non saprà mai PERCHÉ, che è la
  // regola 3 di AGENTS.md violata nel punto in cui costa di più.
  it('arubaGetByFilename: il motivo dello scarto NON si butta via', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        invoices: [{ status: 'Scartata', statusDescription: 'Codice destinatario non valido' }],
        errorCode: '0093',
        errorDescription: 'deleghe non valide',
      })
    )
    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(4)
    expect(st.statoAruba).toBe('Scartata')
    expect(st.descrizioneAruba).toBe('Codice destinatario non valido')
    expect(st.errorCode).toBe('0093')
    expect(st.errorDescription).toBe('deleghe non valide')
  })

  // Una dicitura mai vista NON si indovina: 0, e lo 0 resta in coda (`STATI_IN_VOLO`).
  it('arubaGetByFilename: dicitura fuori tabella → 0, con la parola vera conservata', async () => {
    fetchMock.mockResolvedValue(mockResponse({ invoices: [{ status: 'Messa in quarantena' }] }))
    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(0)
    expect(st.statoAruba).toBe('Messa in quarantena')
  })

  // ⚠️ IL RIPIEGO `json.value` NON DEVE TORNARE. Un involucro `value` non esiste
  // (misurato): se qualcuno lo rimettesse «per sicurezza», una risposta di questa forma
  // tornerebbe a essere letta — ed è la forma che il codice rotto si aspettava.
  it('arubaGetByFilename: uno `status` di primo livello NON viene più letto', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 7, value: { status: 7 }, invoices: [] }))
    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(0)
    expect(st.statoAruba).toBeNull()
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * L'INVOLUCRO VERO, tutte e sedici le chiavi come le ha risposte l'API.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ QUESTO È L'INVOLUCRO CHE L'API HA DAVVERO RISPOSTO il 2026-09-11, letto su 4.000
 * documenti veri (anni 2026 e 2025). Sedici chiavi di primo livello, e fra quelle
 * SEDICI non c'è né `status` né `stato`, e non c'è nessun involucro `value`.
 *
 * Il test qui sopra monta un sotto-insieme; questo monta la forma intera apposta,
 * perché il difetto del 2026-09-11 non è stato «leggere male un campo»: è stato
 * leggere un campo CHE NON C'ERA e non accorgersene, perché `?? 0` ha un valore di
 * ripiego per tutto. Con l'involucro completo davanti, una riga che pesca al primo
 * livello ha sedici modi di sembrare plausibile e nessuno di essere giusto.
 *
 * I VALORI dentro la forma sono inventati, e il numero è scelto apposta fuori da qualunque
 * serie vera (`999999/2026`: i nostri sezionali stanno a quattro cifre). Fino al giro
 * precedente qui c'era il numero di una delle quattro fatture davvero scartate su Aruba —
 * un documento nostro, non un dato di una famiglia, ma pur sempre l'unico valore non
 * inventato dentro il commento che prometteva il contrario. I quattro numeri veri restano
 * dove servono e dove sono dichiarati per quello che sono (`src/lib/aruba/stato.ts`,
 * `__tests__/api/fattura-sync.test.ts`), non in un fixture che si spaccia per finto.
 *
 * La FORMA invece è misurata, ed è l'unica cosa di questo blocco che non si tocca.
 */
const INVOLUCRO_MISURATO = {
  id: 987654,
  sender: 'IT01879020517',
  receiver: 'IT00000000000',
  filename: 'IT01879020517_00abc.xml.p7m',
  invoices: [
    {
      invoiceDate: '2026-09-01',
      number: '999999/2026',
      status: 'Non consegnata',
      statusDescription: 'Impossibilità di recapito',
    },
  ],
  username: 'utenza@example.invalid',
  lastUpdate: '2026-09-02T04:11:07.000+0000',
  idSdi: '1234567890',
  creationDate: '2026-09-01T18:22:41.000+0000',
  signed: true,
  unsignedFile: null,
  errorCode: '0000',
  errorDescription: null,
  pddAvailable: false,
  invoiceType: 'FPR12',
  docType: 'TD01',
}

describe('arubaGetByFilename — la risposta MISURATA, non quella immaginata', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('legge lo stato da invoices[0].status con l\'involucro COMPLETO delle sedici chiavi', async () => {
    fetchMock.mockResolvedValue(mockResponse(INVOLUCRO_MISURATO))

    const st = await arubaGetByFilename('production', 'AT', 'IT01879020517_00abc.xml.p7m')

    // 6 = «Recapito impossibile (depositata)» → `emessa`. È il caso del 99% dei nostri
    // documenti: genitori privati senza cassetto fiscale, lo SDI DEPOSITA.
    expect(st.stato).toBe(6)
    expect(st.statoAruba).toBe('Non consegnata')
    expect(st.descrizioneAruba).toBe('Impossibilità di recapito')
  })

  /**
   * ⚠️ IL CONTRO-TEST DELLA FORMA. Le sedici chiavi di primo livello ci sono TUTTE, e
   * nessuna deve poter essere scambiata per lo stato — nemmeno `id` (un numero, che è
   * proprio ciò che il codice rotto cercava di leggere), nemmeno `idSdi` (una stringa
   * di cifre, che `Number()` converte volentieri).
   *
   * Si toglie `invoices` e si lascia tutto il resto: se il client legge lo stato da
   * qualunque altro posto, qui esce un numero diverso da `0` e il test diventa rosso.
   *
   * ─── PERCHÉ DUE INVOLUCRI E NON UNO ──────────────────────────────────────────
   * Con i soli valori del percorso felice l'esclusione NON sarebbe completa, ed è un
   * dettaglio che vale la pena scrivere invece di lasciarlo scoprire: `Number('0000')`
   * (`errorCode`) fa 0 e `Number(false)` (`pddAvailable`) fa 0. Su quelle due chiavi un
   * codice che pescasse al primo livello darebbe **esattamente lo stesso 0** del codice
   * giusto, e questo test resterebbe verde per coincidenza — cioè sarebbe la stessa
   * specie di test che il 2026-09-11 stava coprendo un difetto vero.
   *
   * Perciò la seconda passata rimonta lo stesso involucro con `errorCode: '0093'`,
   * `pddAvailable: true` e `unsignedFile` valorizzato: adesso ognuna delle quindici
   * chiavi, se letta, produce qualcosa che non è 0 (un numero, un `1`, o `NaN` dalle
   * stringhe). Solo così il titolo di questo test è vero alla lettera.
   */
  it('senza `invoices` NESSUNA delle altre quindici chiavi finisce nello stato', async () => {
    const involucri = [
      INVOLUCRO_MISURATO,
      // Stessa forma, valori che NON collassano su 0 se qualcuno li leggesse.
      { ...INVOLUCRO_MISURATO, errorCode: '0093', errorDescription: 'deleghe non valide', pddAvailable: true, unsignedFile: 'JVBERi0=' },
    ]
    for (const involucro of involucri) {
      const senzaInvoices: Record<string, unknown> = { ...involucro }
      delete senzaInvoices.invoices
      fetchMock.mockResolvedValue(mockResponse(senzaInvoices))

      const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')

      // `id` è 987654, `idSdi` è '1234567890', `signed` è true: se una qualunque di
      // queste finisse nello stato, qui non ci sarebbe 0. E 0 non è «in attesa»: è
      // «non interpretato», e resta in coda.
      expect(st.stato, `errorCode ${String(involucro.errorCode)}`).toBe(0)
      expect(st.statoAruba).toBeNull()
      expect(st.descrizioneAruba).toBeNull()
    }
  })

  /**
   * `invoices` presente ma VUOTO — cioè un documento che Aruba conosce ma su cui non
   * ha (ancora) nessuna riga di stato. Stessa conclusione, ed è quella prudente: resta
   * in coda. Un `invoices[0]` letto senza controllo darebbe `undefined.status`, cioè
   * un'eccezione dentro un cron che gira ogni trenta minuti.
   */
  it('`invoices` vuoto → 0, e non lancia', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ...INVOLUCRO_MISURATO, invoices: [] }))
    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(0)
    expect(st.statoAruba).toBeNull()
  })

  /**
   * Le tre diciture misurate, dentro l'involucro vero, fino al `fatturaStato` finale.
   *
   * Il client restituisce un CODICE; chi decide se una fattura è emessa è
   * `mapStatoAruba`. Fermarsi al codice lascerebbe scoperto il pezzo che conta per la
   * contabilità — ed è per questo che qui si asserisce anche il `fatturaStato`: due
   * codici diversi (6 e 7) danno lo stesso `emessa`, e uno solo (4) dà `scartata`, che
   * è il verdetto su cui si decide se una fattura va corretta e ritrasmessa.
   */
  it('le tre diciture misurate escono con codice E `fatturaStato` giusti dall\'involucro vero', async () => {
    for (const [dicitura, atteso, statoFattura] of [
      ['Consegnata', 7, 'emessa'],
      ['Non consegnata', 6, 'emessa'],
      ['Scartata', 4, 'scartata'],
    ] as const) {
      fetchMock.mockResolvedValue(
        mockResponse({ ...INVOLUCRO_MISURATO, invoices: [{ ...INVOLUCRO_MISURATO.invoices[0], status: dicitura }] }),
      )
      const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
      expect(st.stato, `dicitura «${dicitura}»`).toBe(atteso)
      expect(mapStatoAruba(st.stato).fatturaStato, `dicitura «${dicitura}»`).toBe(statoFattura)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * L'ALLARME: una dicitura che non sappiamo leggere non è una curiosità.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ QUESTO BLOCCO NON ESISTEVA, e la sua assenza era misurabile: `grep -rn
 * 'stato-non-interpretato' __tests__` dava ZERO occorrenze in tutto il repo. Cancellando
 * l'`if (stato === CODICE_NON_INTERPRETATO)` da `src/lib/aruba/client.ts` i test restavano
 * verdi tutti quanti — cioè l'unica cosa che direbbe «Aruba ha introdotto una parola nuova»
 * non era coperta da nessuna asserzione, esattamente come lo stato letto dal posto sbagliato
 * non lo era fino al 2026-09-11.
 *
 * ─── PERCHÉ È PIÙ DI UNA RIGA DI LOG ────────────────────────────────────────────
 * È la PREMESSA di una decisione presa altrove. La route del cron
 * (`src/app/api/pagamenti/fattura/sync/route.ts`) tiene lo 0 dentro `STATI_IN_VOLO`, cioè
 * accetta apposta che una riga non interpretata rientri in coda a ogni giro, e si giustifica
 * scrivendo che è «un caso raro e già gridato a livello `error` dal client». Se il grido non
 * parte, quella frase diventa falsa e la coda cresce in silenzio consumando quota Aruba —
 * peggio: se la parola nuova significasse «scartata», nessuno avviserebbe la Segreteria, che
 * è il danno da cui è nato tutto questo lavoro.
 *
 * La PAROLA VERA dev'essere dentro il messaggio: senza, chi legge il log vede uno 0 e non ha
 * modo di sapere cosa aggiungere alla tabella di `stato.ts`. Non è un dato personale, è il
 * vocabolario di stato del provider — e viaggia in `msg`, dove `redact` non lo taglia.
 */
describe('arubaGetByFilename — la dicitura mai vista GRIDA', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    h.logEvento.mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  /**
   * Le righe d'allarme si scelgono per `esito`, NON per livello: così il livello resta una
   * cosa da asserire invece di nascondersi dentro il filtro. (`externalFetch` scrive righe
   * `'fattura'` di suo a ogni chiamata: «l'ultima riga» non sarebbe un criterio.)
   */
  const allarmi = () =>
    h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: unknown } | undefined)?.esito === 'stato-non-interpretato',
    )

  it('una dicitura fuori tabella → UNA riga `error` con dentro la parola vera', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ...INVOLUCRO_MISURATO,
        invoices: [{ ...INVOLUCRO_MISURATO.invoices[0], status: 'Messa in quarantena' }],
      }),
    )

    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(0)

    const righe = allarmi()
    expect(righe).toHaveLength(1)
    const [evento, livello, campi] = righe[0] as [string, string, Record<string, unknown>]
    // `error`, non `warn`: una fattura che nessuno sa più leggere è un incidente, e in questo
    // repo il livello è la differenza fra una riga che qualcuno guarda e una che nessuno apre.
    expect(evento).toBe('fattura')
    expect(livello).toBe('error')
    expect(campi.operazione).toBe('aruba:getByFilename')
    expect(campi.provider).toBe('aruba')
    expect(campi.dicitura_presente).toBe(true)
    // LA PAROLA VERA e DOVE SI RIPARA. Sono le due cose che rendono la riga azionabile: senza
    // la prima non si sa cosa mappare, senza la seconda non si sa dove.
    expect(String(campi.msg)).toContain('Messa in quarantena')
    expect(String(campi.msg)).toContain('src/lib/aruba/stato.ts')
  })

  it("senza `invoices` l'allarme parte lo stesso, e dice che la dicitura MANCA", async () => {
    const senzaInvoices: Record<string, unknown> = { ...INVOLUCRO_MISURATO }
    delete senzaInvoices.invoices
    fetchMock.mockResolvedValue(mockResponse(senzaInvoices))

    const st = await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
    expect(st.stato).toBe(0)

    const righe = allarmi()
    expect(righe).toHaveLength(1)
    const campi = righe[0][2] as Record<string, unknown>
    // Due guasti diversi, due messaggi diversi — e `dicitura_presente` è il campo su cui si
    // separano in SQL. «Parola nuova» si ripara aggiungendo una voce in tabella; «la risposta
    // non porta lo stato» no: lì o l'involucro di Aruba è cambiato, o quel documento non ha
    // ancora una riga di stato, e la fattura resta in coda in attesa che ne compaia una.
    expect(campi.dicitura_presente).toBe(false)
    expect(String(campi.msg)).toContain('non porta nessun invoices[0].status')
    // Nessuna parola fra virgolette: non c'era nessuna parola da riportare.
    expect(String(campi.msg)).not.toContain('«')
  })

  it('le tre diciture conosciute NON fanno rumore', async () => {
    // «Scartata» compresa: quella è una fattura respinta, non un vocabolario che non capiamo.
    // Se finisse anche lei in questo canale, l'allarme suonerebbe 31 volte su 4.000 documenti
    // per un fatto normale e nessuno lo guarderebbe più — che è il modo in cui un segnale
    // muore senza che nessuno lo spenga.
    for (const dicitura of ['Consegnata', 'Non consegnata', 'Scartata'] as const) {
      h.logEvento.mockClear()
      fetchMock.mockResolvedValue(
        mockResponse({
          ...INVOLUCRO_MISURATO,
          invoices: [{ ...INVOLUCRO_MISURATO.invoices[0], status: dicitura }],
        }),
      )
      await arubaGetByFilename('production', 'AT', 'f.xml.p7m')
      expect(allarmi(), `dicitura «${dicitura}»`).toEqual([])
    }
  })
})
