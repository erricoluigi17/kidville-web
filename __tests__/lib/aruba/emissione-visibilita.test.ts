import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { logEventoSpia } = vi.hoisted(() => ({ logEventoSpia: vi.fn() }))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...args: unknown[]) => logEventoSpia(...args),
}))

vi.mock('@/lib/aruba/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/aruba/client')>()),
  arubaSignin: vi.fn(),
  arubaUpload: vi.fn(),
  arubaUltimoNumeroFattura: vi.fn(),
}))

import {
  emettiFatturaPagamento,
  svuotaCacheUltimoNumeroAruba,
} from '@/lib/aruba/emissione'
import {
  arubaSignin,
  arubaUltimoNumeroFattura,
  arubaUpload,
} from '@/lib/aruba/client'

const SCUOLA = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_MADRE = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_PADRE = '33333333-3333-4333-8333-333333333333'
const PARENT_MADRE = '44444444-4444-4444-8444-444444444444'
const PARENT_PADRE = '55555555-5555-4555-8555-555555555555'

type ErroreDb = { code: string; message: string }
type Riga = Record<string, unknown>

interface ConfigDb {
  pagamento?: Riga
  settings?: Riga
  quote?: Riga[]
  esistenti?: Riga[]
  tutori?: Riga[]
  studentParents?: Riga[]
  parentsById?: Record<string, Riga>
  parentsByAuth?: Record<string, Riga>
  erroreSchemaFatture?: ErroreDb
}

function supabaseFinto(cfg: ConfigDb) {
  const inserts: { table: string; row: Riga }[] = []
  const select: { table: string; columns: string }[] = []
  const rpc = vi.fn(async () => ({ data: 101 + rpc.mock.calls.length, error: null }))

  const api = {
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      let colonne = ''
      const builder: Record<string, unknown> = {
        select: (columns = '') => {
          colonne = columns
          select.push({ table, columns })
          return builder
        },
        eq: (column: string, value: unknown) => {
          filtri[column] = value
          return builder
        },
        in: (column: string, value: unknown) => {
          filtri[column] = value
          return builder
        },
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => ({
          data: table === 'pagamenti' ? cfg.pagamento ?? null : null,
          error: null,
        }),
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: cfg.settings ?? null, error: null }
          if (table === 'divise_ordini') return { data: null, error: null }
          if (table === 'parents') {
            const id = typeof filtri.id === 'string' ? filtri.id : null
            const auth = typeof filtri.auth_user_id === 'string' ? filtri.auth_user_id : null
            return {
              data:
                (id ? cfg.parentsById?.[id] : null)
                ?? (auth ? cfg.parentsByAuth?.[auth] : null)
                ?? null,
              error: null,
            }
          }
          return { data: null, error: null }
        },
        insert: async (row: Riga) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        then: (resolve: (value: unknown) => unknown) => {
          if (table === 'fatture_emesse') {
            if (cfg.erroreSchemaFatture && colonne.includes('modalita_emissione')) {
              return resolve({ data: null, error: cfg.erroreSchemaFatture })
            }
            return resolve({ data: cfg.esistenti ?? [], error: null })
          }
          if (table === 'pagamenti_quote') return resolve({ data: cfg.quote ?? [], error: null })
          if (table === 'legame_genitori_alunni') return resolve({ data: cfg.tutori ?? [], error: null })
          if (table === 'student_parents') return resolve({ data: cfg.studentParents ?? [], error: null })
          if (table === 'parents') {
            const ids = Array.isArray(filtri.id) ? filtri.id as string[] : []
            const authIds = Array.isArray(filtri.auth_user_id) ? filtri.auth_user_id as string[] : []
            return resolve({
              data: [
                ...ids.map((id) => cfg.parentsById?.[id]).filter(Boolean),
                ...authIds.map((id) => cfg.parentsByAuth?.[id]).filter(Boolean),
              ],
              error: null,
            })
          }
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _select: select,
  }

  return api
}

const settings = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
  },
  fiscale_config: {
    denominazione: 'Kidville Scuola Cooperativa',
    piva: '12345678903',
    codice_fiscale: '12345678903',
    indirizzo: 'Via Roma',
    numero_civico: '1',
    cap: '00100',
    comune: 'Roma',
    provincia: 'RM',
    regime_fiscale: 'RF01',
  },
}

const pagamento = {
  id: 'pag-1',
  descrizione: 'Retta di marzo',
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
    codice_fiscale: null,
    data_nascita: '2019-03-15',
    genitori_separati: true,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', adult_id: PARENT_MADRE },
  },
}

const genitore = (id: string, nome: string, codiceFiscale: string | null): Riga => ({
  id,
  first_name: nome,
  last_name: 'Rossi',
  fiscal_code: codiceFiscale,
  residence_address: 'Via Milano 9',
  residence_city: 'Roma',
  zip_code: '00185',
})

const madre = genitore(PARENT_MADRE, 'Giulia', 'FRNGLI80A41H501Z')
const padre = genitore(PARENT_PADRE, 'Marco', 'RSSMRC80A01H501A')

const fattureInserite = (sb: ReturnType<typeof supabaseFinto>) =>
  sb._inserts.filter((inserimento) => inserimento.table === 'fatture_emesse')

describe('emissione fattura · snapshot di visibilità', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    svuotaCacheUltimoNumeroAruba()
    vi.stubEnv('ARUBA_PASSWORD', 'segreto-di-test')
    vi.mocked(arubaSignin).mockResolvedValue({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: Date.now() + 60_000,
    })
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(0)
    vi.mocked(arubaUpload).mockResolvedValue({
      ok: true,
      uploadFileName: 'IT12345678903_test.xml.p7m',
      errorCode: '0000',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('split implicito da due tutori: ogni documento fotografa quote_separate', async () => {
    const sb = supabaseFinto({
      pagamento,
      settings,
      tutori: [
        { alunno_id: 'al-1', genitore_id: ACCOUNT_MADRE },
        { alunno_id: 'al-1', genitore_id: ACCOUNT_PADRE },
      ],
      parentsByAuth: {
        [ACCOUNT_MADRE]: madre,
        [ACCOUNT_PADRE]: padre,
      },
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    const righe = fattureInserite(sb)
    expect(righe).toHaveLength(2)
    expect(righe.map(({ row }) => row.modalita_emissione)).toEqual([
      'quote_separate',
      'quote_separate',
    ])
  })

  it('split parzialmente emesso: la sola riga valida conserva quote_separate', async () => {
    const sb = supabaseFinto({
      pagamento,
      settings,
      quote: [
        { adult_id: ACCOUNT_MADRE, importo: 75, etichetta: 'Madre' },
        { adult_id: ACCOUNT_PADRE, importo: 75, etichetta: 'Padre' },
      ],
      parentsByAuth: {
        [ACCOUNT_MADRE]: madre,
        [ACCOUNT_PADRE]: genitore(PARENT_PADRE, 'Marco', null),
      },
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    const righe = fattureInserite(sb)
    expect(righe).toHaveLength(1)
    expect(righe[0].row.modalita_emissione).toBe('quote_separate')
  })

  it('genitori separati con una sola quota effettiva: lo snapshot è ordinaria', async () => {
    const sb = supabaseFinto({
      pagamento,
      settings,
      quote: [{ adult_id: ACCOUNT_MADRE, importo: 150, etichetta: 'Madre' }],
      parentsByAuth: { [ACCOUNT_MADRE]: madre },
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(fattureInserite(sb)).toHaveLength(1)
    expect(fattureInserite(sb)[0].row.modalita_emissione).toBe('ordinaria')
  })

  it('intestatario terzo scelto dopo la cascata: ordinaria e parent_registry_id nullo', async () => {
    const sb = supabaseFinto({
      pagamento,
      settings,
      quote: [{ adult_id: ACCOUNT_MADRE, importo: 150, etichetta: 'Madre' }],
      parentsByAuth: { [ACCOUNT_MADRE]: madre },
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: {
        tipo: 'persona',
        codice_fiscale: 'PRLCRL80A01H501Z',
        nome: 'Carlo',
        cognome: 'Perlini',
        indirizzo: 'Via delle Prove',
        cap: '00100',
        comune: 'Roma',
        provincia: 'RM',
        numero_civico: '7',
      },
    })

    expect(esito.ok).toBe(true)
    const [fattura] = fattureInserite(sb)
    expect(fattura.row).toMatchObject({
      modalita_emissione: 'ordinaria',
      parent_registry_id: null,
      quota_adult_id: null,
    })
  })

  it('schema senza modalita_emissione: si ferma prima di numero e Aruba, con log', async () => {
    const erroreSchema = {
      code: '42703',
      message: 'column fatture_emesse.modalita_emissione does not exist',
    }
    const sb = supabaseFinto({
      pagamento,
      settings,
      quote: [{ adult_id: ACCOUNT_MADRE, importo: 150, etichetta: 'Madre' }],
      parentsByAuth: { [ACCOUNT_MADRE]: madre },
      erroreSchemaFatture: erroreSchema,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito).toMatchObject({ ok: false, motivo: 'errore', httpStatus: 503 })
    expect(sb._select.find(({ table }) => table === 'fatture_emesse')?.columns)
      .toContain('modalita_emissione')
    expect(sb.rpc).not.toHaveBeenCalled()
    expect(arubaUltimoNumeroFattura).not.toHaveBeenCalled()
    expect(arubaSignin).not.toHaveBeenCalled()
    expect(arubaUpload).not.toHaveBeenCalled()
    expect(fattureInserite(sb)).toHaveLength(0)
    expect(logEventoSpia).toHaveBeenCalledWith(
      'fattura',
      'error',
      expect.objectContaining({
        operazione: 'emettiFatturaPagamento:idempotenza',
        esito: 'idempotenza-non-verificabile',
      }),
      erroreSchema,
    )
  })
})
