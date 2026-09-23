import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MOTIVO_PARTITA_NON_REGISTRATA } from '@/lib/pagamenti/fattura-partita-non-registrata'

/**
 * TEST 5 (D1§12, esteso a CR1) — «LA FATTURA È PARTITA, MA NON È A REGISTRO?»
 *
 * `fatturaPartitaNonRegistrata` (predicato CR1, R1-1.3) sa RISPONDERE alla domanda,
 * ma `emettiFatturaPagamento` non la fa ancora: oggi un pagamento `in_attesa` senza
 * riga a registro passa dritto per l'emissione normale — numero allocato, XML
 * composto, documento caricato su Aruba. È esattamente il secondo documento fiscale
 * per lo stesso incasso che il predicato esiste per fermare.
 *
 * 🔴 ROSSO DICHIARATO fino a R1-2.1 (CONVENZIONI, scomposizione.md): qui deve
 * fallire solo per AssertionError — mai per un errore di caricamento — perché il
 * predicato e `MOTIVO_PARTITA_NON_REGISTRATA` esistono già (R1-1.3); manca solo il
 * cablaggio dentro `emissione.ts`.
 *
 * Casi che devono dare 409 `partita_non_registrata`:
 *  1. `in_attesa`, nessuna riga a registro (col file scritto sul pagamento);
 *  2. `in_attesa`, sola riga SCARTATA di un ALTRO file;
 *  3. (CR1) `in_attesa`, riga VIVA di un'altra quota, nessuna riga col file del
 *     pagamento — la quota B non dice niente sulla A.
 *
 * Negativi (il predicato NON deve fermare l'emissione normale):
 *  4. riga viva con lo STESSO file → risposta idempotente (non un secondo invio);
 *  5. riga scartata con lo STESSO file → la sostitutiva si emette;
 *  6. `non_richiesta` senza righe → emette;
 *  7. `scartata` senza righe → emette.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'

// Nomi file finti (sintetici, nessun dato reale): stesso alfabeto della fixture
// condivisa `casi-partita-non-registrata.ts`, ma questo file testa il CABLAGGIO in
// `emissione.ts`, non il predicato — le righe si costruiscono qui, non si importa
// la fixture.
const FILE_X = 'finto-emissione-file-x.xml.p7m'
const FILE_Y = 'finto-emissione-file-y.xml.p7m'
const SCARTO = 2 // «Errore di elaborazione» — uno dei codici di CODICI_SDI_SCARTO_REGISTRO
const VIVA = 7 // «Consegnata» — viva

let appLog: ReturnType<typeof vi.fn>

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

async function carica(finto: ClientFinto) {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

/** I `campi` di dominio di una riga `app_log`, cioè quello che `logEvento` NON promuove a
 * colonna (`livello`, `messaggio`): stesso accesso di
 * `pavimento-implausibile.test.ts:103` e `emissione-multi-quota-estranea.test.ts:571`. */
function campiDi(riga: Riga | undefined) {
  return (riga?.contestoExtra as { campi?: Record<string, unknown> } | undefined)?.campi ?? {}
}

/**
 * Aspetta la riga con QUEL `campi.esito` (livello `warn`) e la restituisce.
 *
 * La fixture di questo file non compila l'email della sede: `emettiFatturaPagamento`
 * emette PRIMA il warn `cedente-senza-email` (emissione.ts:962), indipendente e
 * legittimo, e SOLO DOPO — sul ramo §8.2 — quello del 409. Un conteggio su «tutti i
 * warn» li confonderebbe; si filtra per esito, come fa pavimento-implausibile.
 */
async function attendiRigaConEsito(esito: string): Promise<Riga> {
  await vi.waitFor(() => {
    const trovata = appLog.mock.calls.map((c) => c[0] as Riga).find((r) => String(campiDi(r).esito) === esito)
    expect(trovata, `nessuna riga app_log con esito ${esito}`).toBeDefined()
  }, { timeout: 500 })
  return appLog.mock.calls.map((c) => c[0] as Riga).find((r) => String(campiDi(r).esito) === esito) as Riga
}

interface Cfg {
  pagamento: Record<string, unknown>
  /** Le righe di `fatture_emesse` già a registro per QUESTO pagamento. */
  righeRegistro?: Record<string, unknown>[]
  rpc?: number
}

/**
 * Fake di Supabase con i contatori per tabella: è quello che dimostra «0 INSERT e
 * 0 UPDATE di pagamenti» quando il 409 deve fermare tutto prima di ogni scrittura.
 */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; payload: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: cfg.rpc ?? 2328, error: null }))
  const api = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        limit: () => builder,
        single: async () => ({
          data: table === 'pagamenti' ? cfg.pagamento : null,
          error: null,
        }),
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: settingsConfig, error: null }
          if (table === 'parents') return { data: parentCompleto, error: null }
          return { data: null, error: null }
        },
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: (payload: unknown) => ({
          eq: async () => {
            updates.push({ table, payload })
            return { error: null }
          },
        }),
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'fatture_emesse') return resolve({ data: cfg.righeRegistro ?? [], error: null })
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _updates: updates,
    _rpc: rpc,
  }
  return api
}

const pagamentoBase = {
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
    // Dati SINTETICI: repository pubblico, e sono dati di un minore.
    codice_fiscale: null,
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
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
      piva: '03394870616',
      ragione_sociale: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
      regime: 'RF01',
      indirizzo: 'Via Silvio Pellico 7',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
    },
  },
}

/** Intestatario SINTETICO e completo: passa il gate del cessionario. */
const parentCompleto = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

function finto() {
  return {
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => 2327),
    arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: FILE_X, errorCode: '0000' })),
  }
}

beforeEach(() => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('emettiFatturaPagamento — 409 partita_non_registrata (CR1)', () => {
  it('caso 1 · in_attesa senza righe a registro → 409, niente RPC/signin/upload, 0 INSERT e 0 UPDATE, un warn', async () => {
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'in_attesa', fattura_aruba_id: FILE_X },
      righeRegistro: [],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'la fattura è partita ma non è a registro: NON si riemette').toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe(MOTIVO_PARTITA_NON_REGISTRATA)
      expect(esito.httpStatus).toBe(409)
    }
    expect(client.arubaSignin, 'nessun signin: il 409 sta prima di ogni chiamata Aruba').not.toHaveBeenCalled()
    expect(client.arubaUpload, 'un upload qui sarebbe un SECONDO documento allo SDI').not.toHaveBeenCalled()
    expect(sb._rpc, 'un numero consumato qui è un buco nel registro fiscale').not.toHaveBeenCalled()
    // 0 INSERT su QUALUNQUE tabella (non solo fatture_emesse): il 409 sta prima di ogni
    // scrittura, non solo prima di quella sul registro.
    expect(sb._inserts, 'nessun INSERT: il 409 sta prima di ogni scrittura').toHaveLength(0)
    expect(sb._updates.filter((u) => u.table === 'pagamenti'), '0 UPDATE di pagamenti').toHaveLength(0)

    // Un solo warn `partita-non-registrata-fermata` — filtrato per esito, non per
    // livello: la fixture (senza email di sede) emette anche `cedente-senza-email`,
    // un warn indipendente che un conteggio su «tutti i warn» confonderebbe col nostro.
    const rigaFermata = await attendiRigaConEsito('partita-non-registrata-fermata')
    expect(rigaFermata.livello).toBe('warn')
    const righeFermata = appLog.mock.calls
      .map((c) => c[0] as Riga)
      .filter((r) => String(campiDi(r).esito) === 'partita-non-registrata-fermata')
    expect(righeFermata, 'un solo warn: partita-non-registrata-fermata').toHaveLength(1)
  })

  it('caso 2 · in_attesa, sola riga SCARTATA di un ALTRO file → 409', async () => {
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'in_attesa', fattura_aruba_id: FILE_X },
      righeRegistro: [
        { id: 'f-1', numero: 2328, sezionale: null, aruba_filename: FILE_Y, sdi_stato: SCARTO, quota_adult_id: null },
      ],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'una scartata di un ALTRO file non registra nulla sul file del pagamento').toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe(MOTIVO_PARTITA_NON_REGISTRATA)
      expect(esito.httpStatus).toBe(409)
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(client.arubaUpload).not.toHaveBeenCalled()
  })

  it('caso 3 (CR1) · riga VIVA di un\'altra quota, nessuna riga col file del pagamento → 409', async () => {
    // La quota B non dice niente sulla A: senza CR1 il ramo «esistono righe» basterebbe
    // a far passare la quota A per «già fatta», nascondendo che il SUO documento non
    // è mai arrivato a registro.
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'in_attesa', fattura_aruba_id: FILE_X },
      righeRegistro: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: null,
          aruba_filename: FILE_Y,
          sdi_stato: VIVA,
          quota_adult_id: 'altro-adulto',
        },
      ],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe(MOTIVO_PARTITA_NON_REGISTRATA)
      expect(esito.httpStatus).toBe(409)
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(client.arubaUpload).not.toHaveBeenCalled()
  })

  it('negativo · riga viva con LO STESSO file → risposta idempotente, non un secondo invio', async () => {
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'in_attesa', fattura_aruba_id: FILE_X },
      righeRegistro: [
        { id: 'f-1', numero: 2328, sezionale: null, aruba_filename: FILE_X, sdi_stato: VIVA, quota_adult_id: null },
      ],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'il predicato non deve fermare una riga già registrata sullo stesso file').toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(client.arubaUpload).not.toHaveBeenCalled()
  })

  it('negativo · riga scartata con LO STESSO file → la sostitutiva si emette davvero', async () => {
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'in_attesa', fattura_aruba_id: FILE_X },
      righeRegistro: [
        { id: 'f-1', numero: 2328, sezionale: null, aruba_filename: FILE_X, sdi_stato: SCARTO, quota_adult_id: null },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'ritrasmissione legittima: lo scarto dello stesso file non registra nulla').toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2329)
    expect(client.arubaUpload).toHaveBeenCalledTimes(1)
  })

  it('negativo · non_richiesta senza righe → emette', async () => {
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'non_richiesta', fattura_aruba_id: null },
      righeRegistro: [],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'il predicato vale solo su in_attesa: non_richiesta non si ferma').toBe(true)
    expect(client.arubaUpload).toHaveBeenCalledTimes(1)
  })

  it('negativo · scartata senza righe → emette', async () => {
    const client = finto()
    const { emettiFatturaPagamento } = await carica(client)
    const sb = makeSupabase({
      pagamento: { ...pagamentoBase, fattura_stato: 'scartata', fattura_aruba_id: FILE_X },
      righeRegistro: [],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'il predicato vale solo su in_attesa: scartata non si ferma').toBe(true)
    expect(client.arubaUpload).toHaveBeenCalledTimes(1)
  })
})
