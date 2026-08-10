import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * L'IDEMPOTENZA È L'UNICA COSA FRA UN CLIC E UNA SECONDA FATTURA ALLO SDI.
 *
 * ─── IL DIFETTO, PASSO PER PASSO ─────────────────────────────────────────────
 * `emissione.ts` decide se un pagamento è già stato fatturato leggendo le righe di
 * `fatture_emesse`. Quella lettura era destrutturata come `const { data: esistenti }`:
 * l'`error` non lo guardava nessuno. PostgREST NON LANCIA (AGENTS.md, regola 7),
 * quindi una SELECT fallita dava `esistenti = null` → elenco vuoto → «non è mai
 * stata emessa» → numero nuovo, XML nuovo, upload nuovo. In silenzio.
 *
 * E il caso non è ipotetico: quella SELECT chiede la colonna `sezionale`, che
 * esiste solo dopo la migrazione `20260809233000`. Codice in produzione prima della
 * migrazione (o sul DB E2E della CI, che non è migrato) = `42703` su OGNI chiamata.
 * Prima pressione: numero allocato, documento caricato, INSERT in `PGRST204`, riga a
 * registro assente. La segreteria vede il pagamento ancora «da fatturare» e ripreme:
 * secondo documento fiscale allo SDI per la stessa retta, che si corregge solo con
 * una nota di variazione.
 *
 * Perciò FAIL-CLOSED, come il cedente e come il cessionario: se l'idempotenza non è
 * VERIFICABILE non si emette. Un'emissione mancata si rifà con un clic; una fattura
 * doppia no.
 *
 * Gli altri due casi qui sotto sono la stessa regola sugli altri due `{ error }`
 * scartati del file (`pagamenti` e `admin_settings`): lì l'esito era già fail-closed,
 * ma il MESSAGGIO mentiva sulla causa — un guasto di lettura usciva come «Pagamento
 * non trovato» (404) o «Fatturazione Aruba non configurata» (503), e mandava chi
 * indaga a controllare le credenziali invece del database.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'

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

async function righe(minimo = 1): Promise<Riga[]> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(minimo))
  return appLog.mock.calls.map((c) => c[0] as Riga)
}

async function rigaCon(evento: string, livello: string): Promise<Riga> {
  await vi.waitFor(async () => {
    const trovate = (await righe(1)).filter((r) => r.evento === evento && r.livello === livello)
    expect(trovate.length, `nessuna riga ${evento}/${livello} in app_log`).toBeGreaterThan(0)
  })
  return (await righe()).find((r) => r.evento === evento && r.livello === livello) as Riga
}

interface Cfg {
  /** Righe già a registro per questo pagamento (l'elenco che decide l'idempotenza). */
  esistenti?: Record<string, unknown>[]
  /** L'errore di QUELLA lettura: è il cuore di questo file. */
  erroreEsistenti?: unknown
  errorePagamento?: unknown
  erroreSettings?: unknown
  erroreInsert?: unknown
  pagamento?: unknown
  settings?: unknown
  parents?: unknown
  rpc?: number
}

/**
 * Fake di Supabase con l'errore di OGNI lettura pilotabile, e i contatori.
 * `fatture_emesse` è thenable perché il codice fa `await …select().eq()` senza
 * `single()`: è lì che si misura se l'errore viene guardato.
 */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: cfg.rpc ?? 2328, error: null }))
  const api = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        limit: () => builder,
        single: async () => ({
          data: cfg.errorePagamento ? null : (cfg as Record<string, unknown>)[table] ?? null,
          error: table === 'pagamenti' ? (cfg.errorePagamento ?? null) : null,
        }),
        maybeSingle: async () => {
          if (table === 'admin_settings')
            return { data: cfg.erroreSettings ? null : cfg.settings ?? null, error: cfg.erroreSettings ?? null }
          if (table === 'parents') return { data: cfg.parents ?? null, error: null }
          return { data: null, error: null }
        },
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: table === 'fatture_emesse' ? (cfg.erroreInsert ?? null) : null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'fatture_emesse')
            return resolve({ data: cfg.erroreEsistenti ? null : cfg.esistenti ?? [], error: cfg.erroreEsistenti ?? null })
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _rpc: rpc,
  }
  return api
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

describe('idempotenza NON verificabile → non si emette (e non in silenzio)', () => {
  it('la SELECT su `fatture_emesse` fallisce (42703, colonna `sezionale` assente) → nessun numero, nessun upload', async () => {
    // È lo stato ESATTO della produzione finché la migrazione 20260809233000 non è
    // applicata, ed è lo stato permanente del DB E2E della CI, che non è migrato.
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_doppia.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      settings: settingsConfig,
      parents: parentCompleto,
      erroreEsistenti: { message: 'column fatture_emesse.sezionale does not exist', code: '42703' },
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'senza sapere se è già stata emessa, non si emette').toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(503)
      expect(esito.messaggio).toContain('già stato fatturato')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    // Le tre prove che il documento NON è partito, in ordine di gravità crescente.
    expect(sb._rpc, 'un numero consumato qui è un buco nel registro fiscale').not.toHaveBeenCalled()
    expect(upload, 'un upload qui è una SECONDA fattura allo SDI').not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)

    const r = await rigaCon('fattura', 'error')
    // `esito` è in lista bianca: `where contesto->>'esito' = '…'` si può interrogare.
    expect(JSON.stringify(r)).toContain('idempotenza-non-verificabile')
    // Il messaggio di PostgREST vince sui campi e dice QUALE colonna manca.
    expect(String(r.messaggio)).toContain('sezionale')
    expect(r.codice).toBe('42703')
  })

  it('la stessa lettura RIUSCITA e vuota → la fattura parte (la difesa non blocca il caso buono)', async () => {
    // Senza questo caso, «non emette mai niente» supererebbe il test qui sopra.
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_ok.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      settings: settingsConfig,
      parents: parentCompleto,
      esistenti: [],
      rpc: 2328,
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('una riga VIVA già a registro → idempotente: nessun numero nuovo, nessun upload', async () => {
    // L'altra metà della stessa difesa: quando la lettura riesce e dice «c'è già»,
    // il secondo clic della segreteria non deve produrre niente.
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_mai.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      settings: settingsConfig,
      parents: parentCompleto,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: 'IT_gia.xml.p7m', sdi_stato: 1, quota_adult_id: null },
      ],
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('una riga SCARTATA non vale: la sostitutiva si emette davvero', async () => {
    // `sdi_stato: 4` = scartata dallo SdI. Se il vincolo (qui e sul database)
    // valesse anche su di lei, il documento sostitutivo non partirebbe mai.
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_sost.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      settings: settingsConfig,
      parents: parentCompleto,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: null, sdi_stato: 4, quota_adult_id: null },
      ],
      rpc: 2329,
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2329)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('IL 23505 A REGISTRO viene chiamato col suo nome: DOPPIA EMISSIONE, non «riga persa»', async () => {
    // L'indice unico parziale su (pagamento_id, quota_adult_id) è l'ultima difesa e
    // scatta TARDI — sull'INSERT, cioè dopo che il documento è partito. È l'unico
    // momento in cui un essere umano può accorgersene: la riga deve dirlo.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_dup.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      settings: settingsConfig,
      parents: parentCompleto,
      esistenti: [],
      erroreInsert: {
        message: 'duplicate key value violates unique constraint "fatture_emesse_pagamento_quota_uidx"',
        code: '23505',
      },
    } as Cfg & Record<string, unknown>)

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const r = await rigaCon('fattura', 'error')
    expect(String(r.messaggio)).toContain('DOPPIA EMISSIONE')
    // Il nome file resta leggibile: è l'unico appiglio per ritrovarla su Aruba.
    expect(String(r.messaggio)).toContain('IT_dup.xml.p7m')
    expect(JSON.stringify(r)).toContain('registro-doppione-rifiutato')
  })
})

describe('un guasto di lettura non si traveste da «non trovato» né da «non configurato»', () => {
  it('`pagamenti` illeggibile (42501) → 503 che dice «lettura fallita», NON 404', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      settings: settingsConfig,
      parents: parentCompleto,
      errorePagamento: { message: 'permission denied for table pagamenti', code: '42501' },
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus, 'un 404 manderebbe a cercare un pagamento che esiste').toBe(503)
      expect(esito.messaggio).not.toContain('Pagamento non trovato')
      expect(esito.messaggio).toContain('lettura fallita')
    }

    const r = await rigaCon('fattura', 'error')
    expect(JSON.stringify(r)).toContain('pagamento-non-letto')
    expect(r.codice).toBe('42501')
  })

  it('ZERO RIGHE (PGRST116) resta un 404 vero: la distinzione è tutto il punto', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      settings: settingsConfig,
      errorePagamento: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(404)
      expect(esito.messaggio).toBe('Pagamento non trovato')
    }
  })

  it('`admin_settings` illeggibile → 503 che NON accusa le credenziali Aruba', async () => {
    // Il messaggio vecchio («Fatturazione Aruba non configurata») mandava la
    // segreteria a ricontrollare utenza e password, che sono a posto.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2327),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      parents: parentCompleto,
      erroreSettings: { message: 'permission denied for table admin_settings', code: '42501' },
    } as Cfg & Record<string, unknown>)

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(503)
      expect(esito.messaggio).not.toContain('non configurata')
      expect(esito.messaggio).toContain('lettura dal database')
    }

    const r = await rigaCon('fattura', 'error')
    expect(JSON.stringify(r)).toContain('configurazione-non-letta')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * IL LOCK SULLA MIGRAZIONE: la difesa vive in DUE posti, e il file lo deve dire.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('la migrazione porta il vincolo, e non promette ciò che non fa', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260809233000_fatture_numerazione_sezionale.sql'),
    'utf-8',
  )

  it('esiste l\'indice UNICO parziale su (pagamento_id, quota_adult_id)', () => {
    // `idx_fatture_emesse_pagamento_quota` della baseline è sulle stesse colonne ma
    // NON è unico: è un indice di ricerca, e non ha mai impedito niente.
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS fatture_emesse_pagamento_quota_uidx')
    // Il NULL della quota unica va normalizzato: in Postgres due NULL sono
    // DISTINTI, quindi sulle colonne nude il caso più frequente resterebbe scoperto.
    expect(sql).toMatch(/fatture_emesse_pagamento_quota_uidx[\s\S]{0,200}COALESCE\(quota_adult_id/)
    // Le righe scartate (2/4/9) restano fuori: la sostitutiva deve poter entrare.
    expect(sql).toMatch(/fatture_emesse_pagamento_quota_uidx[\s\S]{0,300}sdi_stato NOT IN \(2, 4, 9\)/)
  })

  it('NON dichiara più che `p_min` è riletto «subito prima di ogni emissione»', () => {
    // Era scritto due volte — nel commento del lock e nel `COMMENT ON FUNCTION`, che
    // finisce DENTRO il database — ed era falso da quando la lettura è per lotto con
    // cache di cinque minuti (`TTL_ULTIMO_NUMERO_MS`). Un documento che descrive una
    // protezione che non c'è è peggio di nessun documento.
    expect(sql).not.toContain('subito prima di')
    expect(sql).not.toContain('subito prima dell')
    expect(sql).toContain('UNA VOLTA PER LOTTO')
  })
})
