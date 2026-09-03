import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PAUSA_FRA_PAGINE_MS, PAUSA_DOPO_429_MS } from '@/lib/aruba/client'

/**
 * DOPO L'ALLOCAZIONE DEL NUMERO NON DEVE PIÙ SUCCEDERE NIENTE DI IMPREVISTO.
 *
 * ─── LE TRE COSE CHE QUESTO FILE BLOCCA, e perché sono la stessa cosa ───────────────
 * `prossimo_numero_fattura_sezionale` SCRIVE il contatore: da quel momento il progressivo è
 * consumato e non torna indietro. Tutto ciò che accade dopo va gestito, perché non gestirlo
 * significa lasciare un buco nel registro fiscale — o, peggio, scrivere a registro
 * un'affermazione falsa su una tabella che non ammette il `DELETE`.
 *
 *  1. IL RITMO. L'upload partiva **subito** dopo l'ultima pagina di `findByUsername`, cioè
 *     dentro la stessa finestra del leaky bucket che aveva appena risposto a sette GET. Un
 *     `429` lì brucia un numero già allocato. Ora, quando il pavimento della serie è stato
 *     letto DAL VIVO in questa invocazione, l'upload aspetta `PAUSA_FRA_PAGINE_MS`. Se il
 *     pavimento arrivava dalla cache non è partita nessuna richiesta, e aspettare sarebbero
 *     cinque secondi buttati addosso a chi guarda lo schermo.
 *
 *  2. RIFIUTO DI TRASPORTO ≠ SCARTO DI MERITO. Su `!up.ok` si scriveva SEMPRE
 *     `sdi_stato: 2` «Errore upload» con dentro il motivo grezzo — che per un `429` di Aruba
 *     è una **pagina HTML**. `fatture_emesse` è WORM (il trigger vieta il `DELETE`): un
 *     limite di frequenza diventava un rifiuto fiscale permanente. Ora un rifiuto di
 *     trasporto va comunque a registro — il numero È consumato, e la riga lo documenta — ma
 *     dichiarato per quello che è: esito IGNOTO, da verificare sul pannello Aruba.
 *     ⚠️ E il caso «`0034` in risposta al NOSTRO ritentativo» — l'unico in cui il primo invio
 *     ERA arrivato — si legge dal campo `dopoRitentativo` del contratto del client, MAI dal
 *     solo `errorCode`: un `0034` compare identico dentro un rifiuto HTTP non-2xx, dove di
 *     ritentativi non ce n'è stato nessuno, e chiamarlo «dopo un 429» sarebbe una frase falsa
 *     scritta in una colonna WORM.
 *
 *  3. NESSUNA ECCEZIONE FUORI CONTROLLO COL NUMERO ALLOCATO. `ensureToken()` e
 *     `arubaUpload()` stavano fuori da ogni `try`: un `429` sul `signin`, il timeout di 30 s
 *     del provider o una rete caduta risalivano fino al `catch` della route, che rispondeva
 *     **500 «Internal Server Error»** — con il numero già consumato, nessuna riga a registro
 *     e, soprattutto, nessuno che sapesse se la fattura fosse partita.
 *
 * ─── COME SI OSSERVA ────────────────────────────────────────────────────────────────
 * Il client Aruba qui è QUELLO VERO: si finge la rete (`fetch`), non il client. Un mock del
 * client avrebbe dovuto inventare la forma di `ArubaUploadResult` — e un mock che inventa il
 * contratto del fornitore resta verde sia col difetto sia senza (è già successo in questo
 * repo, con le fatture di agosto). L'orologio è finto perché le attese sono di 5 e 90
 * secondi: aspettarle davvero non proverebbe niente di più e costerebbe un minuto e mezzo.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'

let appLog: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

/** Ricarica il grafo con la guardia SILENZIOSO spenta, `app_log` finto e il client VERO. */
async function carica() {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  return await import('@/lib/aruba/emissione')
}

function risposta(corpo: string, stato = 200): Response {
  return { ok: stato >= 200 && stato < 300, status: stato, text: async () => corpo } as Response
}

/** Il `429` come arriva davvero da Aruba: una pagina HTML, non un JSON. */
const HTML_429 =
  '<html><head><title>429 Too Many Requests</title></head><body><h1>Rate limit exceeded</h1></body></html>'

const TOKEN = '{"access_token":"AT","refresh_token":"RT","expires_in":1799}'
/** Una pagina di `findByUsername` nella forma MISURATA: il numero sta in `invoices[].number`. */
const PAGINA_FPR =
  '{"content":[{"filename":"IT12345678903_0001.xml.p7m","invoices":[{"number":"FPR 1946/26"}]}],"numberOfElements":1}'
const UPLOAD_OK = '{"errorCode":"0000","uploadFileName":"IT12345678903_ab12.xml.p7m"}'

/** Instrada la finta rete per URL. `upload` decide come risponde (o se lancia) l'invio. */
function reteAruba(upload: () => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (url: unknown) => {
    const dove = String(url)
    if (dove.includes('/auth/signin')) return risposta(TOKEN)
    if (dove.includes('findByUsername')) return risposta(PAGINA_FPR)
    if (dove.includes('/services/invoice/upload')) return await upload()
    throw new Error(`URL Aruba non previsto nel test: ${dove}`)
  })
}

/** Quante richieste sono partite verso un certo pezzo di URL. */
function chiamate(pezzo: string): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes(pezzo)).length
}

function righeLog(): Riga[] {
  return appLog.mock.calls.map((c) => c[0] as Riga)
}

function rigaConEsito(esito: string): Riga | undefined {
  return righeLog().find((r) => (r.contesto as Riga | undefined)?.esito === esito || JSON.stringify(r).includes(`"${esito}"`))
}

/**
 * Il fake di Supabase dei test di emissione, con i contatori delle scritture — e con il
 * REGISTRO VIVO: le righe inserite in `fatture_emesse` tornano indietro alla lettura di
 * idempotenza. Senza, quella `select` risponderebbe sempre «nessuna fattura per questo
 * pagamento» e ogni caso qui sotto misurerebbe una prima emissione, anche la seconda.
 */
function makeSupabase(responses: Record<string, unknown> & { rpc?: number; erroreInsert?: unknown }) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
  return {
    from(table: string) {
      // `.eq('pagamento_id', …)` si RICORDA: senza il filtro, la riga del pagamento
      // precedente risponderebbe alla domanda di idempotenza del successivo — e il fake
      // misurerebbe un comportamento che in produzione non esiste.
      let pagamentoFiltrato: unknown
      const builder = {
        select: () => builder,
        eq: (colonna: string, valore: unknown) => {
          if (colonna === 'pagamento_id') pagamentoFiltrato = valore
          return builder
        },
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: responses[table] ?? null, error: null }),
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: table === 'fatture_emesse' ? (responses.erroreInsert ?? null) : null }
        },
        update: (row: unknown) => ({
          eq: async () => {
            updates.push({ table, row })
            return { error: null }
          },
        }),
        // La `select` senza `.single()` che `emissione.ts` usa per l'idempotenza.
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data:
              table === 'fatture_emesse'
                ? inserts
                    .filter((i) => i.table === 'fatture_emesse')
                    .map((i) => i.row as Record<string, unknown>)
                    .filter((r) => r.pagamento_id === pagamentoFiltrato)
                : [],
            error: null,
          }),
      }
      return builder
    },
    rpc: async () => ({ data: responses.rpc ?? 1947, error: null }),
    _inserts: inserts,
    _updates: updates,
  }
}

const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scadenza: '2026-03-10',
  periodo_competenza: '2026-03-01',
  scuola_id: SCUOLA,
  fattura_causale: null,
  categoria_id: null,
  alunno_id: 'al-1',
  payment_categories: null,
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Rossi',
    // Dato SINTETICO: decide solo la serie fiscale (nato nel 2019 ⇒ «FPR»).
    codice_fiscale: null,
    data_nascita: '2019-03-15',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}

const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
    fiscal: {
      piva: '12345678903',
      ragione_sociale: 'Kidville Srl',
      regime: 'RF01',
      indirizzo: 'Via Roma 1',
      cap: '00100',
      comune: 'Roma',
      provincia: 'RM',
    },
  },
}

/** Intestatario SINTETICO e completo: nessun dato di famiglie vere nei test. */
const parent = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via Milano 9',
  residence_city: 'Roma',
  zip_code: '00185',
}

function scuola() {
  return makeSupabase({
    pagamenti: pagamentoSaldato,
    admin_settings: settingsConfig,
    parents: parent,
    rpc: 1947,
  })
}

/** La riga scritta (o non scritta) nel registro delle fatture. */
function rigaRegistro(sb: ReturnType<typeof makeSupabase>): Record<string, unknown> | undefined {
  return sb._inserts.find((i) => i.table === 'fatture_emesse')?.row as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
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

describe('il ritmo prima dell\'upload', () => {
  it('dopo una lettura DAL VIVO l\'upload aspetta; col pavimento in CACHE non aspetta', async () => {
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta(UPLOAD_OK))
    const sb = scuola()

    // ── Prima emissione: il pavimento si legge da Aruba, quindi il secchio è appena
    //    stato toccato e l'upload deve tenersi a distanza.
    const primo = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS - 1)
    expect(chiamate('findByUsername'), 'il pavimento non è stato letto').toBe(1)
    expect(chiamate('/services/invoice/upload'), 'l\'upload è partito dentro la finestra del 429').toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    const e1 = await primo
    expect(e1.ok).toBe(true)
    expect(chiamate('/services/invoice/upload')).toBe(1)

    // ── Seconda emissione entro il TTL: nessuna lettura ⇒ nessuna richiesta spesa ⇒
    //    nessuna ragione di aspettare. Cinque secondi buttati sono cinque secondi che
    //    la segreteria passa a guardare una rotellina.
    const secondo = emettiFatturaPagamento(sb as never, 'pag-2', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(chiamate('findByUsername'), 'il pavimento è stato riletto invece di usare la cache').toBe(1)
    expect(chiamate('/services/invoice/upload'), 'l\'upload ha aspettato senza motivo').toBe(2)
    const e2 = await secondo
    expect(e2.ok).toBe(true)
  })
})

describe('un rifiuto di TRASPORTO non è uno scarto fiscale', () => {
  it('429 persistente: riga «Trasporto fallito», motivo breve, e NIENTE HTML a registro', async () => {
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta(HTML_429, 429))
    const sb = scuola()

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + PAUSA_DOPO_429_MS + 1_000)
    const esito = await lavoro

    // Il ritentativo c'è stato, e uno solo.
    expect(chiamate('/services/invoice/upload')).toBe(2)

    const riga = rigaRegistro(sb)
    expect(riga, 'il numero è consumato: senza riga a registro non lo documenta nessuno').toBeTruthy()
    expect(riga!.sdi_stato_label).toBe('Trasporto fallito')
    expect(String(riga!.sdi_scarto_motivo)).toMatch(/^TRASPORTO 429/)
    // ⚠️ Il blob HTML di Aruba NON entra in una colonna che la segreteria legge — e che il
    // trigger WORM non permette più di correggere.
    expect(String(riga!.sdi_scarto_motivo)).not.toContain('<html')
    expect(String(riga!.sdi_scarto_motivo).length).toBeLessThanOrEqual(200)
    // «Scartata» sarebbe un'affermazione FALSA: nessuno sa se il documento sia arrivato.
    expect(riga!.sdi_stato).not.toBe(2)

    const r = rigaConEsito('upload-trasporto')
    expect(r, 'nessuna riga `upload-trasporto` in app_log').toBeTruthy()
    expect(r!.livello).toBe('error')
    // LO STATUS DEVE ARRIVARE IN COLONNA, non solo dentro il JSONB dei campi.
    // `logger.ts` promuove a `RigaLog.statoHttp` (→ colonna `app_log.stato_http`) UNA sola
    // chiave, `stato` (`numeroDi(campi, 'stato')`): con qualunque altro nome il numero
    // resta sepolto in `contesto.campi`, e «quanti 429 sull'upload questo mese» smette di
    // essere una query e diventa una lettura a mano dei JSON.
    expect(r!.statoHttp, 'lo status non è finito nella colonna `stato_http`').toBe(429)

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      // 502 e non 500: il guasto è del gateway, non nostro — e la route non deve
      // rispondere «Internal Server Error» a un limite di frequenza.
      expect(esito.httpStatus).toBe(502)
      expect(esito.messaggio.toLowerCase()).toContain('non ripremere')
      expect(esito.messaggio).not.toContain('<html')
    }
  })

  it('la riga di trasporto NON lascia partire un secondo documento allo SdI', async () => {
    // ⚠️ QUESTA È LA PROPRIETÀ DI SICUREZZA, e vale la pena scrivere perché è così.
    // Prima della distinzione, un `429` scriveva `sdi_stato: 2` — cioè «scartata» — e
    // l'idempotenza esclude apposta le righe scartate, perché vanno ri-emesse. Risultato:
    // chi ripremeva «Emetti» dopo un limite di frequenza mandava allo SdI un SECONDO
    // documento per la stessa retta, che si corregge solo con una nota di variazione.
    //
    // Con `sdi_stato: null` («stato ignoto», che è la verità) la riga resta VIVA: la
    // seconda pressione non emette niente. È il verso giusto in cui sbagliare — una retta
    // che resta da fatturare si sistema a mano; una fattura doppia no.
    //
    // ⚠️ E LA RISPOSTA DEVE DIRLO. Non basta non emettere: la riga di trasporto cadeva nel
    // ramo `idempotente`, cioè `ok: true` — l'aggregato scriveva `fattura_stato='in_attesa'`
    // con `fattura_aruba_id = null`, uno stato che `fattura/sync` non ripesca mai (filtra
    // `sdi_stato in (1,3,5)` e `aruba_filename not null`) e che `aggregaFatturaStato`
    // terrebbe «in attesa» per sempre. Chi ripreme si sentiva rispondere «fatto» su una
    // fattura di cui nessuno sa se sia partita: deve risentirsi l'avviso, non un «già fatto».
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta(HTML_429, 429))
    const sb = scuola()

    const primo = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + PAUSA_DOPO_429_MS + 1_000)
    await primo
    const uploadDopoIlPrimo = chiamate('/services/invoice/upload')

    // La segreteria ripreme sullo STESSO pagamento.
    const secondo = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + PAUSA_DOPO_429_MS + 1_000)
    const e2 = await secondo

    expect(chiamate('/services/invoice/upload'), 'un secondo documento è partito verso lo SdI').toBe(
      uploadDopoIlPrimo,
    )
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(1)

    // La risposta racconta l'esito IGNOTO, non un «già fatto».
    expect(e2.ok).toBe(false)
    if (!e2.ok) {
      // 409 e non 502: il gateway non c'entra, il conflitto è con una riga che è già a
      // registro. E non 200, che è ciò che diceva prima.
      expect(e2.httpStatus).toBe(409)
      expect(e2.messaggio.toLowerCase()).toContain('non ripremere')
    }
    // ⚠️ IL FATTO CHE VALEVA IL DIFETTO: `fattura_stato='in_attesa'` con `fattura_aruba_id`
    // nullo è uno stato da cui il pagamento non esce più — nessun giro di `fattura/sync` lo
    // ripesca, perché quel filtro vuole `aruba_filename not null`.
    expect(
      sb._updates
        .filter((u) => u.table === 'pagamenti')
        .map((u) => (u.row as Record<string, unknown>).fattura_stato),
      'la seconda pressione ha messo il pagamento in un «in attesa» che nessuno chiuderà',
    ).not.toContain('in_attesa')
    expect(
      rigaConEsito('trasporto-in-sospeso'),
      'nessuna riga di log dice che qualcuno ha ripremuto su una fattura dall\'esito ignoto',
    ).toBeTruthy()
  })

  it('200 illeggibile: il motivo a registro dice «illeggibile», non «200»', async () => {
    // ⚠️ CHI LEGGE QUELLA COLONNA È LA SEGRETERIA, e deve decidere se ripremere «Emetti».
    // `TRASPORTO 200: esito ignoto…` mette un «200» dentro un motivo di FALLIMENTO: chi lo
    // legge lo associa a un successo, che è il contrario di quello che è successo. Il
    // numero da solo non basta a dire cosa è andato storto, e la colonna non ha spazio per
    // spiegarlo due volte.
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta('<html><body>manutenzione</body></html>', 200))
    const sb = scuola()

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    const esito = await lavoro

    // Un 2xx non si ritenta: il ritentativo è solo del 429.
    expect(chiamate('/services/invoice/upload')).toBe(1)

    const riga = rigaRegistro(sb)
    expect(riga, 'il numero è consumato: senza riga a registro non lo documenta nessuno').toBeTruthy()
    expect(riga!.sdi_stato_label).toBe('Trasporto fallito')
    expect(String(riga!.sdi_scarto_motivo)).toMatch(/^TRASPORTO 200 illeggibile/)
    // La pagina di manutenzione del proxy non entra nella colonna WORM che la segreteria
    // legge: il corpo intero è già in `app_log` per mano di `externalFetch`.
    expect(String(riga!.sdi_scarto_motivo)).not.toContain('<html')
    expect(String(riga!.sdi_scarto_motivo).length).toBeLessThanOrEqual(200)
    expect(riga!.sdi_stato).not.toBe(2)

    const r = rigaConEsito('upload-trasporto')
    expect(r, 'nessuna riga `upload-trasporto` in app_log').toBeTruthy()
    expect(r!.statoHttp).toBe(200)

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(502)
  })

  it('429 poi 0034: la riga dice «0034 dopo un 429», non «HTTP 200»', async () => {
    // ⚠️ LO STATUS, QUI, RACCONTA IL CONTRARIO DI QUELLO CHE È SUCCESSO. Il secondo invio ha
    // ricevuto un `200` con dentro `0034` («File già inviato di recente»): scrivere
    // «TRASPORTO 200» in una colonna che la segreteria legge per decidere se ripremere
    // metterebbe un numero da successo dentro un motivo di fallimento. La notizia non è lo
    // status: è che il PRIMO invio — quello tornato indietro come `429` — era stato ricevuto.
    // E «HTTP 0034» sarebbe la stessa specie di falsità al contrario: `0034` non è uno status.
    const { emettiFatturaPagamento } = await carica()
    let invii = 0
    reteAruba(() => {
      invii += 1
      return invii === 1
        ? risposta(HTML_429, 429)
        : risposta('{"errorCode":"0034","errorDescription":"File già inviato di recente"}')
    })
    const sb = scuola()

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + PAUSA_DOPO_429_MS + 1_000)
    const esito = await lavoro

    expect(chiamate('/services/invoice/upload'), 'il ritentativo dopo il 429 non è partito').toBe(2)

    const riga = rigaRegistro(sb)
    expect(riga, 'il numero è consumato: senza riga a registro non lo documenta nessuno').toBeTruthy()
    expect(riga!.sdi_stato_label).toBe('Trasporto fallito')
    expect(riga!.sdi_stato, '«scartata» su un documento che sta su Aruba').not.toBe(2)
    expect(String(riga!.sdi_scarto_motivo)).toMatch(/^TRASPORTO 0034 dopo un 429/)
    expect(String(riga!.sdi_scarto_motivo), '«HTTP 0034» dice che 0034 è uno status: non lo è').not.toContain(
      'HTTP 0034',
    )
    expect(String(riga!.sdi_scarto_motivo)).not.toContain('<html')
    expect(String(riga!.sdi_scarto_motivo).length).toBeLessThanOrEqual(200)

    const r = rigaConEsito('upload-trasporto')
    expect(r, 'nessuna riga `upload-trasporto` in app_log').toBeTruthy()
    expect(r!.livello).toBe('error')
    // Lo status vero resta in colonna — è un `200`, e in colonna non mente: dice solo che
    // una risposta c'è stata. È il MOTIVO, in chiaro, che deve nominare il guasto.
    expect(r!.statoHttp).toBe(200)
    expect(String(r!.messaggio)).toContain('0034 dopo un 429')
    expect(String(r!.messaggio)).not.toContain('HTTP 0034')

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(502)
      expect(esito.messaggio.toLowerCase()).toContain('non ripremere')
      expect(esito.messaggio).not.toContain('HTTP 0034')
    }
  })

  it('un 0034 dentro un rifiuto HTTP, senza nessun 429, NON è «dopo un 429»', async () => {
    // ⚠️ LA CONTROPROVA CHE COSTRINGE A GUARDARE IL CAMPO GIUSTO. Il ramo `!esito.ok` del
    // client copia nell'esito l'`errorCode` dell'envelope del rifiuto: un `400` con corpo
    // `{"errorCode":"0034"}` esce con `trasporto: true, statoHttp: 400, errorCode: '0034'`
    // — identico, per chi guarda il solo `errorCode`, al `0034` che segue un nostro
    // ritentativo. Ma qui di ritentativi non ce n'è stato NESSUNO: chiamarlo «0034 dopo un
    // 429» è una frase falsa, e finirebbe in `sdi_scarto_motivo`, dove il trigger WORM
    // vieta il `DELETE` e nessuno può più correggerla.
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta('{"errorCode":"0034","errorDescription":"File già inviato di recente"}', 400))
    const sb = scuola()

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    const esito = await lavoro

    expect(chiamate('/services/invoice/upload'), 'un 400 non è un 429: non si ritenta').toBe(1)

    const riga = rigaRegistro(sb)
    expect(riga, 'il numero è consumato: senza riga a registro non lo documenta nessuno').toBeTruthy()
    expect(riga!.sdi_stato_label).toBe('Trasporto fallito')
    expect(riga!.sdi_stato).not.toBe(2)
    expect(String(riga!.sdi_scarto_motivo)).toMatch(/^TRASPORTO 400: esito ignoto/)
    expect(
      String(riga!.sdi_scarto_motivo),
      'nessun 429 è mai arrivato: la colonna WORM racconta un fatto che non è successo',
    ).not.toContain('dopo un 429')

    const r = rigaConEsito('upload-trasporto')
    expect(r, 'nessuna riga `upload-trasporto` in app_log').toBeTruthy()
    expect(r!.statoHttp).toBe(400)
    expect(String(r!.messaggio)).toContain('HTTP 400')
    expect(String(r!.messaggio)).not.toContain('dopo un 429')

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(502)
  })

  it('uno scarto di MERITO (0092) resta «Errore upload» con `sdi_stato: 2`, come sempre', async () => {
    // La controprova che la distinzione non ha inghiottito il caso vero: un documento che
    // Aruba ha guardato e respinto è uno scarto, e a registro va scritto come tale.
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta('{"errorCode":"0092","errorDescription":"Errore validazione XSD"}'))
    const sb = scuola()

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    const esito = await lavoro

    expect(chiamate('/services/invoice/upload'), 'uno scarto di merito non si ritenta MAI').toBe(1)
    const riga = rigaRegistro(sb)
    expect(riga!.sdi_stato).toBe(2)
    expect(riga!.sdi_stato_label).toBe('Errore upload')
    expect(String(riga!.sdi_scarto_motivo)).toContain('XSD')
    expect(rigaConEsito('scartata'), 'lo scarto di merito ha perso la sua riga di log').toBeTruthy()

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('scartata')
  })
})

describe('nessuna eccezione fuori controllo con il numero già allocato', () => {
  it('l\'upload non riceve risposta (rete/timeout): riga «Trasporto fallito», e NESSUN 500', async () => {
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => {
      throw new TypeError('fetch failed: ECONNRESET')
    })
    const sb = scuola()

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    // Se questa `await` lanciasse, il `catch` della route risponderebbe 500 con il numero
    // bruciato e nessuna traccia: è esattamente il difetto che questo caso chiude.
    const esito = await lavoro

    const riga = rigaRegistro(sb)
    expect(riga, 'numero consumato e nessuna riga: la fattura sparisce dai radar').toBeTruthy()
    expect(riga!.sdi_stato_label).toBe('Trasporto fallito')
    expect(String(riga!.sdi_scarto_motivo)).toMatch(/^TRASPORTO /)

    const r = rigaConEsito('upload-esito-ignoto')
    expect(r, 'nessuna riga `upload-esito-ignoto` in app_log').toBeTruthy()
    expect(r!.livello).toBe('error')

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(502)
      expect(esito.messaggio.toLowerCase()).toContain('non ripremere')
    }
  })

  it('se anche l\'INSERT fallisce, il motivo di Aruba NON viene buttato via: due righe, non una', async () => {
    // ⚠️ IL DIFETTO CHE QUESTO CASO CHIUDE, ed era mio. La prima stesura passava a
    // `logEvento` l'errore di PostgREST al posto dell'eccezione di Aruba quando l'INSERT
    // falliva — e `logEvento` fa VINCERE l'errore sui campi. Il corpo della risposta del
    // provider esiste solo dentro quell'eccezione: sostituirlo con «duplicate key value
    // violates unique constraint» è, alla lettera, il difetto delle email di credenziali
    // (AGENTS.md, regola 3). Due fatti diversi vogliono due righe.
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => {
      throw new TypeError('fetch failed: ECONNRESET dal gateway')
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 1947,
      erroreInsert: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })

    const lavoro = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    await lavoro

    const provider = rigaConEsito('upload-esito-ignoto')
    expect(provider, 'la riga col motivo di Aruba è sparita').toBeTruthy()
    expect(String(provider!.messaggio)).toContain('ECONNRESET')

    const registro = rigaConEsito('trasporto-non-registrato')
    expect(registro, 'nessuno dice che il numero è consumato e non lo documenta niente').toBeTruthy()
    expect(registro!.codice).toBe('23505')
  })

  it('il `signin` prende 429 col pavimento in cache: l\'eccezione NON esce dalla funzione', async () => {
    // Il caso di §3.3 alla lettera: `ensureToken()` viene chiamato per la PRIMA volta subito
    // prima dell'upload, perché il pavimento non è stato riletto. Un `429` lì risaliva fino
    // alla route — 500, numero consumato, nessuna riga.
    const { emettiFatturaPagamento } = await carica()
    reteAruba(() => risposta(UPLOAD_OK))
    const sb = scuola()

    const primo = emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    expect((await primo).ok).toBe(true)

    // Da qui il pavimento è in cache: la seconda emissione non legge, ma DEVE autenticarsi.
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/auth/signin')) return risposta(HTML_429, 429)
      throw new Error('nessun\'altra chiamata doveva partire dopo il 429 sul signin')
    })

    const secondo = emettiFatturaPagamento(sb as never, 'pag-2', { id: 'staff-1' })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS + 1_000)
    const esito = await secondo

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(502)
    const righe = sb._inserts.filter((i) => i.table === 'fatture_emesse')
    expect(righe).toHaveLength(2)
    expect((righe[1].row as Record<string, unknown>).sdi_stato_label).toBe('Trasporto fallito')
    expect(rigaConEsito('upload-esito-ignoto')).toBeTruthy()
  })
})
