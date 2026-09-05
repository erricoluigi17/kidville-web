import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * «NON LO SO» NON È «NO» — e fino a oggi, sul verso alunno → genitori, lo era.
 *
 * La catena, tutta e tre gli anelli, sta in questo file perché è tutta e tre che
 * si rompeva insieme:
 *
 *   `legame_genitori_alunni` non risponde  (PostgREST NON lancia: `{ error }`)
 *        └→ `getGenitoriDiAlunno` logga un warn e restituisce ciò che ha
 *              └→ `identitaGenitoriDiAlunno` calcolava `completo` SENZA quella lettura
 *                    └→ `adultoEGenitoreDi` rispondeva `false` invece di `null`
 *                          └→ l'emissione rispondeva **422** «l'intestatario scelto non
 *                             risulta fra i genitori di questo bambino»
 *
 * Cioè: un guasto del database usciva dallo schermo della Segreteria come
 * un'affermazione sull'anagrafica di una famiglia. Il 422 dice «hai scelto la
 * persona sbagliata, cambiala»; la verità era «riprova fra un minuto». Con la
 * lettura runtime giù, l'unico intestatario che l'anteprima poteva proporre — un
 * genitore noto al SOLO ponte runtime — è anche l'unico che l'emissione
 * rifiutava: l'app offre una scelta e poi dà la colpa a chi la preme.
 *
 * Il verdetto giusto è **503** (`legami-non-verificabili`), che nessun numero
 * consuma e che invita a riprovare. Qui si prova che ci arriva davvero.
 *
 * ⚠️ E SI PROVA ANCHE IL CONTRARIO, due volte, perché «rispondi sempre 503»
 * passerebbe metà di questo file:
 *  · `PGRST205` (DB E2E della CI, mai migrato) NON è un guasto → resta 422;
 *  · un intestatario che È un genitore passa il gate anche con la runtime giù.
 *
 * Il fake distingue per TABELLA e per COLONNA di filtro, e conta le chiamate a
 * `rpc`: `prossimo_numero_fattura_sezionale` SCRIVE il contatore, e «nessun
 * numero è stato consumato» non è una cortesia del messaggio, è un'asserzione.
 * Nomi e codici fiscali SINTETICI: il repository è pubblico.
 */

const { logEventoSpia } = vi.hoisted(() => ({ logEventoSpia: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => logEventoSpia(...a),
}))

import { adultoEGenitoreDi } from '@/lib/pagamenti/intestatari'

const SCUOLA = '11111111-1111-1111-1111-111111111111'
const ALUNNO = 'a1111111-1111-4111-8111-111111111111'

/** Il genitore che l'anagrafica conosce. */
const PARENT_FABBRI = 'parent-fabbri'
/** `utenti.id` dello stesso adulto: il ponte runtime parla QUESTO spazio. */
const ACCOUNT_FABBRI = 'account-fabbri'
/** Un adulto che NON risulta da nessuna delle sorgenti rimaste in piedi. */
const PARENT_PERLINI = 'parent-perlini'

/** `57014` = statement timeout: un guasto vero, non uno schema che non c'è. */
const GUASTO = { code: '57014', message: 'canceling statement due to statement timeout' }
/** `PGRST205` = tabella non in cache: il DB E2E della CI, che non è migrato. */
const SCHEMA_ASSENTE = { code: 'PGRST205', message: 'Could not find the table in the schema cache' }

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

async function carica(finto: ClientFinto) {
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog: vi.fn(async () => {}) }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

interface Cfg {
  pagamento?: unknown
  settings?: unknown
  /** Anagrafiche `parents` per `parents.id`. */
  parentsById?: Record<string, Record<string, unknown>>
  /** Le stesse righe indicizzate per `auth_user_id`: il ponte verso il registro. */
  parentsByAuth?: Record<string, Record<string, unknown>>
  /** `student_parents` del bambino: chi l'anagrafica conosce. */
  studentParents?: { student_id?: string; parent_id: string }[]
  /** Il ponte runtime (`legame_genitori_alunni`), quando risponde. */
  legami?: { alunno_id: string; genitore_id: string }[]
  /**
   * IL GUASTO PILOTATO, per tabella. PostgREST non lancia: l'errore arriva nel
   * RITORNO, ed è esattamente ciò che un `try/catch` non vedrebbe mai.
   */
  errori?: Record<string, { code: string; message: string }>
  esistenti?: Record<string, unknown>[]
  rpc?: number
}

/** Fake di Supabase: distingue per tabella e per colonna, e CONTA le rpc. */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: cfg.rpc ?? 2328, error: null }))
  const err = (table: string) => cfg.errori?.[table] ?? null
  const api = {
    from(table: string) {
      let eqVal: string | null = null
      const filtri: Record<string, unknown> = {}
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: string) => {
          eqVal = v
          filtri[c] = v
          return builder
        },
        in: (c: string, v: unknown) => {
          filtri[c] = v
          return builder
        },
        limit: () => builder,
        single: async () => ({ data: table === 'pagamenti' ? cfg.pagamento ?? null : null, error: err(table) }),
        maybeSingle: async () => {
          if (err(table)) return { data: null, error: err(table) }
          if (table === 'admin_settings') return { data: cfg.settings ?? null, error: null }
          if (table === 'parents') {
            if (typeof filtri.auth_user_id === 'string') {
              return { data: (cfg.parentsByAuth ?? {})[filtri.auth_user_id] ?? null, error: null }
            }
            return { data: (eqVal && (cfg.parentsById ?? {})[eqVal]) ?? null, error: null }
          }
          return { data: null, error: null }
        },
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        then: (resolve: (v: unknown) => unknown) => {
          if (err(table)) return resolve({ data: null, error: err(table) })
          if (table === 'fatture_emesse') return resolve({ data: cfg.esistenti ?? [], error: null })
          if (table === 'student_parents') return resolve({ data: cfg.studentParents ?? [], error: null })
          if (table === 'legame_genitori_alunni') return resolve({ data: cfg.legami ?? [], error: null })
          if (table === 'parents') {
            const perAuth = Array.isArray(filtri.auth_user_id) ? (filtri.auth_user_id as string[]) : []
            const perId = Array.isArray(filtri.id) ? (filtri.id as string[]) : []
            const righe = [
              ...perAuth.map((a) => (cfg.parentsByAuth ?? {})[a]).filter(Boolean),
              ...perId.map((i) => (cfg.parentsById ?? {})[i]).filter(Boolean),
            ]
            return resolve({ data: righe, error: null })
          }
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

/** Anagrafiche SINTETICHE e complete: entrambe passerebbero il gate del cessionario. */
const registroFabbri = {
  id: PARENT_FABBRI,
  first_name: 'Giulia',
  last_name: 'Fabbri',
  fiscal_code: 'FBBGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
  auth_user_id: ACCOUNT_FABBRI,
}
const registroPerlini = {
  id: PARENT_PERLINI,
  first_name: 'Carlo',
  last_name: 'Perlini',
  fiscal_code: 'PRLCRL80A01H501Z',
  residence_address: 'Via delle Verifiche 3',
  residence_city: 'Aversa',
  zip_code: '81031',
  auth_user_id: null,
}

const parentsById = { [PARENT_FABBRI]: registroFabbri, [PARENT_PERLINI]: registroPerlini }
const parentsByAuth = { [ACCOUNT_FABBRI]: registroFabbri }

/** L'anagrafica conosce SOLO Fabbri: Perlini è l'estraneo di questo bambino. */
const soloFabbri = [{ student_id: ALUNNO, parent_id: PARENT_FABBRI }]

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
  alunno_id: ALUNNO,
  payment_categories: null,
  alunni: {
    id: ALUNNO,
    nome: 'Mario',
    cognome: 'Fabbri',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', adult_id: PARENT_FABBRI },
  },
}

const settingsConfig = {
  aruba_config: { username: 'utente@scuola.it', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' },
  fiscale_config: {
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    piva: '03394870616',
    codice_fiscale: '03394870616',
    indirizzo: 'Via Silvio Pellico',
    numero_civico: '7',
    cap: '81030',
    comune: 'Cesa',
    provincia: 'CE',
    regime_fiscale: 'RF01',
  },
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

async function motore(up = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))) {
  const { emettiFatturaPagamento } = await carica({
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => 2327),
    arubaUpload: up,
  })
  return { emettiFatturaPagamento, up }
}

const logDi = (esito: string) =>
  logEventoSpia.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  logEventoSpia.mockClear()
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('`adultoEGenitoreDi` — il terzo esito esiste anche quando a cadere è la lettura runtime', () => {
  const base: Cfg = { studentParents: soloFabbri, parentsById, parentsByAuth }

  it('lettura pulita: l’estraneo è `false` (senza questa riga, «sempre null» passerebbe il resto)', async () => {
    const sb = makeSupabase(base)
    expect(await adultoEGenitoreDi(sb as never, ALUNNO, PARENT_PERLINI)).toBe(false)
  })

  it('lettura pulita: il genitore dell’anagrafica è `true`', async () => {
    const sb = makeSupabase(base)
    expect(await adultoEGenitoreDi(sb as never, ALUNNO, PARENT_FABBRI)).toBe(true)
  })

  it('⛔ `legame_genitori_alunni` non risponde → `null`, non `false`', async () => {
    const sb = makeSupabase({ ...base, errori: { legame_genitori_alunni: GUASTO } })
    expect(
      await adultoEGenitoreDi(sb as never, ALUNNO, PARENT_PERLINI),
      'con la runtime giù, «non è un genitore» è un’affermazione senza misura',
    ).toBeNull()
  })

  it('un genitore NOTO resta `true` anche con la runtime giù: il dubbio non cancella un fatto', async () => {
    const sb = makeSupabase({ ...base, errori: { legame_genitori_alunni: GUASTO } })
    expect(await adultoEGenitoreDi(sb as never, ALUNNO, PARENT_FABBRI)).toBe(true)
  })

  it('`PGRST205` (DB della CI non migrato) → `false`, non `null`', async () => {
    const sb = makeSupabase({ ...base, errori: { legame_genitori_alunni: SCHEMA_ASSENTE } })
    expect(
      await adultoEGenitoreDi(sb as never, ALUNNO, PARENT_PERLINI),
      'in CI quella tabella non esiste: trattarla da guasto spegnerebbe ogni emissione',
    ).toBe(false)
  })

  it('la lettura fallita LASCIA LA SUA RIGA, con il codice e senza dati personali', async () => {
    const sb = makeSupabase({ ...base, errori: { legame_genitori_alunni: GUASTO } })
    await adultoEGenitoreDi(sb as never, ALUNNO, PARENT_PERLINI)
    const riga = logDi('genitori-runtime-non-letti')
    expect(riga, 'un guasto muto è il difetto che questo repo ha già pagato').toBeDefined()
    expect(riga?.[1]).toBe('warn')
    expect((riga?.[2] as { error_code?: string }).error_code).toBe('57014')
    expect(JSON.stringify(riga?.[2])).not.toContain('Fabbri')
  })
})

describe('l’emissione risponde 503 «non lo so», non 422 «non è un genitore»', () => {
  it('⛔ runtime giù + intestatario scelto estraneo alle sorgenti rimaste → 503, nessun numero consumato', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      parentsByAuth,
      studentParents: soloFabbri,
      errori: { legame_genitori_alunni: GUASTO },
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(
      sb as never,
      'pag-1',
      { id: 'staff-1' },
      { intestatarioScelto: { tipo: 'adult', adult_id: PARENT_PERLINI } },
    )

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus, 'un guasto del database non si dice «hai scelto la persona sbagliata»').toBe(503)
      expect(esito.motivo).toBe('errore')
      expect(esito.messaggio).toContain('verificare')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(sb._rpc, 'un numero consumato qui è un buco nel registro fiscale').not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)

    const riga = logDi('legami-non-verificabili')
    expect(riga, 'senza riga, «non lo so» è indistinguibile da «non è mai partito niente»').toBeDefined()
    expect(riga?.[1]).toBe('error')
    expect((riga?.[2] as { pagamento_id?: string }).pagamento_id).toBe('pag-1')
  })

  it('`PGRST205` sulla stessa lettura → resta 422: la CI non migrata non degrada', async () => {
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      parentsByAuth,
      studentParents: soloFabbri,
      errori: { legame_genitori_alunni: SCHEMA_ASSENTE },
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(
      sb as never,
      'pag-1',
      { id: 'staff-1' },
      { intestatarioScelto: { tipo: 'adult', adult_id: PARENT_PERLINI } },
    )

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(422)
      expect(esito.motivo).toBe('intestatario_non_del_bambino')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('con la runtime giù, l’intestatario che È un genitore passa: il 503 non è indiscriminato', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      parentsByAuth,
      studentParents: soloFabbri,
      errori: { legame_genitori_alunni: GUASTO },
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(
      sb as never,
      'pag-1',
      { id: 'staff-1' },
      { intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI } },
    )

    expect(esito.ok, 'un dubbio sulla runtime non deve fermare una scelta che l’anagrafica conferma').toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(up).toHaveBeenCalledTimes(1)
    expect(logDi('legami-non-verificabili')).toBeUndefined()
  })
})
