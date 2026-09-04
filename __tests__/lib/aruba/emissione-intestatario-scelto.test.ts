import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * SCEGLIERE L'INTESTATARIO — e la falla che la scelta rendeva raggiungibile in due clic.
 *
 * ─── 🔴 LA COSA PIÙ IMPORTANTE DI QUESTO FILE ────────────────────────────────
 * L'idempotenza per-quota confrontava `quota_adult_id`:
 *
 *     r.quota_adult_id === q.adultId || (!multi && r.quota_adult_id == null)
 *
 * Emetti per il genitore A (riga a registro con `quota_adult_id = A`), riapri il
 * modale, scegli B, premi «Emetti»: nessuna riga viva corrisponde più, e parte
 * una SECONDA FATTURA VERA per la stessa retta. La falla esisteva già — bastava
 * che l'anagrafica cambiasse fra due clic — ma il selettore la mette a portata di
 * mouse.
 *
 * ⚠️ E IL DATABASE NON LA FERMA. Misurato il 2026-09-04 su `pg_indexes`:
 * `fatture_emesse_pagamento_quota_uidx` È un indice unico parziale, ma la sua
 * chiave è `(pagamento_id, COALESCE(quota_adult_id, '00000000-…'))` — quindi
 * (pagamento P, quota A) e (pagamento P, quota B) sono DUE CHIAVI DIVERSE e
 * l'INSERT passa. E anche se rifiutasse, arriverebbe comunque tardi: l'INSERT
 * avviene DOPO l'upload ad Aruba, cioè a documento già partito. **La guardia di
 * codice è l'unica difesa che esista.**
 *
 * Le righe SCARTATE (sdi_stato 2/4/9) restano riemettibili: la guardia non deve
 * chiudere la riemissione dopo uno scarto, o l'unico rimedio a uno scarto
 * diventerebbe una nota di variazione.
 *
 * ─── L'ALTRA METÀ: FAIL-CLOSED ───────────────────────────────────────────────
 * Come in `emissione-gate-numero.test.ts`, il fake CONTA le chiamate a `rpc`:
 * `prossimo_numero_fattura_sezionale` SCRIVE il contatore, e «nessun numero è
 * stato consumato» non è una frase di cortesia nel messaggio, è un'asserzione.
 *
 * Nomi e codici fiscali SINTETICI: il repository è pubblico.
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'

const PARENT_FABBRI = 'parent-fabbri'
const PARENT_BIANCHI = 'parent-bianchi'
/** `utenti.id` dello stesso adulto: il ponte runtime parla QUESTO spazio. */
const ACCOUNT_BIANCHI = 'account-bianchi'

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
  /** Anagrafiche `parents` per id: il fake serve DUE genitori, non uno. */
  parentsById?: Record<string, unknown>
  /** Righe già a registro per questo pagamento. */
  esistenti?: Record<string, unknown>[]
  /** `student_parents` del bambino: chi PUÒ essere scelto come intestatario. */
  studentParents?: { parent_id: string }[]
  /** Il ponte runtime (`legame_genitori_alunni`), che porta `utenti.id`. */
  legami?: { alunno_id: string; genitore_id: string }[]
  /** Righe `parents` indicizzate per `auth_user_id`: il ponte verso il registro. */
  parentsByAuth?: Record<string, unknown>
  rpc?: number
}

/** Fake di Supabase coi CONTATORI: allocazioni di numero, insert, letture di `parents`. */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: cfg.rpc ?? 2328, error: null }))
  const parentsLetti = vi.fn()
  const api = {
    from(table: string) {
      let eqVal: string | null = null
      // I filtri si registrano per COLONNA: `parents` si interroga per `id` e per
      // `auth_user_id`, che sono due spazi d'identità diversi. Un fake che li
      // confondesse proverebbe un percorso che in produzione non esiste — ed è
      // esattamente l'errore che questo file conteneva.
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
        single: async () => ({ data: table === 'pagamenti' ? cfg.pagamento ?? null : null, error: null }),
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: cfg.settings ?? null, error: null }
          if (table === 'parents') {
            parentsLetti(eqVal)
            if (filtri.auth_user_id && typeof filtri.auth_user_id === 'string') {
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
          if (table === 'fatture_emesse') return resolve({ data: cfg.esistenti ?? [], error: null })
          if (table === 'student_parents')
            return resolve({ data: cfg.studentParents ?? [{ parent_id: PARENT_FABBRI }, { parent_id: PARENT_BIANCHI }], error: null })
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
    _parentsLetti: parentsLetti,
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
    cognome: 'Bianchi',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', adult_id: PARENT_FABBRI },
  },
}

/** Il pagamento degli 88 su 93: nessun intestatario risolvibile. */
const pagamentoSenzaIntestatario = {
  ...pagamentoSaldato,
  alunni: { ...pagamentoSaldato.alunni, intestatario_fatture: null },
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

/** Due intestatari SINTETICI e completi: entrambi passano il gate del cessionario. */
const parentsById = {
  [PARENT_FABBRI]: {
    id: PARENT_FABBRI,
    first_name: 'Giulia',
    last_name: 'Fabbri',
    fiscal_code: 'FBBGLI80A41H501Z',
    residence_address: 'Via delle Prove 9',
    residence_city: 'Cesa',
    zip_code: '81030',
  },
  [PARENT_BIANCHI]: {
    id: PARENT_BIANCHI,
    first_name: 'Luca',
    last_name: 'Bianchi',
    fiscal_code: 'BNCLCU80A01H501Z',
    residence_address: 'Via delle Verifiche 3',
    residence_city: 'Aversa',
    zip_code: '81031',
  },
}

const personaDigitata = {
  tipo: 'persona' as const,
  codice_fiscale: 'PRLCRL80A01H501Z',
  nome: 'Carlo',
  cognome: 'Perlini',
  indirizzo: 'Via delle Prove',
  cap: '81030',
  comune: 'Cesa',
  provincia: 'CE',
  numero_civico: '9',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }
const upload = () => vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))

beforeEach(() => {
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function motore(up = upload()) {
  const { emettiFatturaPagamento } = await carica({
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => 2327),
    arubaUpload: up,
  })
  return { emettiFatturaPagamento, up }
}

function rigaRegistro(sb: ReturnType<typeof makeSupabase>) {
  return sb._inserts.find((i) => i.table === 'fatture_emesse')?.row as Record<string, unknown> | undefined
}

describe('🔴 UNA SECONDA FATTURA PER LA STESSA RETTA — la guardia che il database non dà', () => {
  it('⛔ fattura VIVA intestata ad ALTRI + scelta di un intestatario diverso → 409, nessun secondo documento', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      // Il documento è già partito, intestato a Bianchi. Adesso si sceglie Fabbri.
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: PARENT_BIANCHI,
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(409)
      expect(esito.motivo).toBe('gia_emessa_altro_intestatario')
      // Il messaggio deve NOMINARE il documento che c'è già: senza il numero,
      // chi legge non sa dove andare a guardare.
      expect(esito.messaggio).toContain('Asilo 2328')
      expect(esito.messaggio).toContain('nota di variazione')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(sb._rpc, 'un numero consumato qui è un buco nel registro fiscale').not.toHaveBeenCalled()
    expect(up, 'un upload qui è una SECONDA fattura vera allo SDI').not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('⛔ la stessa cosa SENZA scelta: la falla non nasce col selettore, ci passa soltanto', async () => {
    // Se l'anagrafica cambia fra due clic (`intestatario_fatture` spostato su un
    // altro genitore), il secondo «Emetti» faceva partire il secondo documento
    // senza che nessuno avesse scelto niente.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: 'IT_gia.xml.p7m', sdi_stato: 1, quota_adult_id: PARENT_BIANCHI },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(409)
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
  })

  it('⛔ prima fattura con `quota_adult_id` NULL + scelta di un genitore → 409 (l’asimmetria)', async () => {
    // Il verso opposto era altrettanto rotto, e in modo speculare: con
    // `quota_adult_id = null` a registro, scegliere un genitore faceva passare la
    // quota per «già emessa» e NON riemetteva. Adesso entrambi i versi rispondono
    // la stessa cosa — c'è un documento vivo, si passa da una nota di variazione.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: 'IT_gia.xml.p7m', sdi_stato: 1, quota_adult_id: null },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_BIANCHI },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(409)
    expect(up).not.toHaveBeenCalled()
  })

  it('riga «trasporto fallito» + intestatario diverso → 409, e il messaggio NON parla di nota di variazione', async () => {
    // `sdi_stato` nullo E nessun nome file: nessuno sa se quel documento sia
    // partito. Dire «serve una nota di variazione» manderebbe dal commercialista
    // invece che sul pannello Aruba, che è dove si scopre com'è andata.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: null, sdi_stato: null, quota_adult_id: PARENT_BIANCHI },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(409)
      expect(esito.messaggio).toContain('esito di trasporto ignoto')
      expect(esito.messaggio).toContain('verifica su Aruba')
      expect(esito.messaggio).not.toContain('nota di variazione')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(up).not.toHaveBeenCalled()
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('una fattura SCARTATA (sdi_stato 2) si riemette: la guardia non chiude l’unica via d’uscita', async () => {
    // Senza questo caso, «non emette mai due volte» sarebbe soddisfatto anche da
    // «non emette mai più niente», e uno scarto SDI diventerebbe definitivo.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: 'IT_scartata.xml.p7m', sdi_stato: 2, quota_adult_id: PARENT_BIANCHI },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI },
    })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2329)
    expect(up).toHaveBeenCalledTimes(1)
  })

  it('⛔ la STESSA persona digitata due volte → «già fatto», non 409 (il registro sa CHI è)', async () => {
    // `quota_adult_id` è NULL per un intestatario digitato, ma `fatture_emesse.
    // intestatario` porta il CODICE FISCALE — misurato: 3 righe su 3 in produzione
    // ce l'hanno. È la prova d'identità che usa il fisco stesso, ed è già in mano
    // senza una lettura in più. Senza questo confronto, ogni riemissione di una
    // fattura `persona`/`altro` — per esempio dopo un timeout, se l'interfaccia
    // rimanda la scelta — prenderebbe un 409 che manda dal commercialista per un
    // documento che non è mai partito.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: null,
          intestatario: { nome: 'Carlo', cognome: 'Perlini', codice_fiscale: 'PRLCRL80A01H501Z' },
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: personaDigitata,
    })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(sb._rpc, 'un secondo numero su un documento già emesso è un buco nel registro').not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('⛔ riga viva senza adulto ma con CF X + `persona` Y → 409 «intestata a un’altra persona»', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: null,
          intestatario: { nome: 'Giulia', cognome: 'Fabbri', codice_fiscale: 'FBBGLI80A41H501Z' },
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: personaDigitata,
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(409)
      expect(esito.messaggio).toContain('intestata a un’altra persona')
      expect(esito.messaggio).toContain('nota di variazione')
    }
    expect(up).not.toHaveBeenCalled()
  })

  it('⛔ riga viva SENZA snapshot (legacy) + scelta → 409, e solo LÌ «non risulta a chi sia intestata»', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', anno: 2026, aruba_filename: 'IT_legacy.xml.p7m', sdi_stato: 1, quota_adult_id: null, intestatario: null },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: personaDigitata,
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(409)
      expect(esito.messaggio).toContain('non risulta a chi sia intestata')
      expect(esito.messaggio).not.toContain('un’altra persona')
    }
    expect(up).not.toHaveBeenCalled()
  })

  it('⛔ scheda `altro` cambiata fra due clic, SENZA scelta → 409 (non «già fatto»)', async () => {
    // Il ripiego storico diceva «già fatto» a qualunque riga viva con
    // `quota_adult_id` nullo, purché nessuno avesse scelto. Ma la scheda del
    // bambino può essere cambiata nel frattempo: il documento a registro è di X,
    // quello che si sta per emettere è di Y, e «già fatto» sarebbe falso.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: {
        ...pagamentoSaldato,
        alunni: {
          ...pagamentoSaldato.alunni,
          intestatario_fatture: {
            tipo: 'altro',
            dati: { nome: 'Carlo', cognome: 'Perlini', cf: 'PRLCRL80A01H501Z', indirizzo: 'Via delle Prove', cap: '81030', comune: 'Cesa' },
          },
        },
      },
      settings: settingsConfig,
      parentsById,
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: null,
          intestatario: { nome: 'Giulia', cognome: 'Fabbri', codice_fiscale: 'FBBGLI80A41H501Z' },
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(409)
    expect(up).not.toHaveBeenCalled()
  })

  it('⛔ riga muta E intestatario senza codice fiscale, senza scelta → «già fatto» (il commento lo prometteva)', async () => {
    // Il ripiego storico vale dove la RIGA non dice niente. Se vale con una riga
    // muta e un intestatario che il codice fiscale ce l'ha, a maggior ragione
    // vale quando non ce l'ha nessuno dei due: lì non c'è proprio niente da
    // confrontare. Il codice diceva il contrario del suo stesso commento — e un
    // commento che promette una cosa che il codice non fa è peggio di nessun
    // commento, perché chi legge si fida.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, intestatario_fatture: { tipo: 'adult', adult_id: 'parent-senza-anagrafica' } },
      },
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', anno: 2026, aruba_filename: 'IT_muta.xml.p7m', sdi_stato: 1, quota_adult_id: null, intestatario: null },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328)
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
  })

  it('la quarta frase compare SOLO quando il confronto non si può fare, e non è un ripiego', async () => {
    // Le tre frasi precedenti affermano qualcosa (trasporto ignoto · altra
    // persona · il registro non sa nulla). Questa dice l'unica cosa vera quando
    // il registro il codice fiscale ce l'ha e NOI no: che non si può stabilire.
    // Se diventasse il ripiego preso anche quando una delle due parti il CF ce
    // l'ha e sono confrontabili, sarebbe la stessa classe di difetto del
    // messaggio falso — un'affermazione senza misura.
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({
      pagamento: {
        ...pagamentoSaldato,
        // Punta a un adulto che in anagrafica non c'è: il NOSTRO codice fiscale
        // resta vuoto, quindi non c'è niente da confrontare da questo lato.
        alunni: { ...pagamentoSaldato.alunni, intestatario_fatture: { tipo: 'adult', adult_id: 'parent-senza-anagrafica' } },
      },
      settings: settingsConfig,
      parentsById,
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: null,
          intestatario: { nome: 'Giulia', cognome: 'Fabbri', codice_fiscale: 'FBBGLI80A41H501Z' },
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.messaggio).toContain('non è possibile stabilire')
      // E NESSUNA delle altre tre: sono esclusive, non gradazioni.
      expect(esito.messaggio).not.toContain('un’altra persona')
      expect(esito.messaggio).not.toContain('non risulta a chi sia intestata')
      expect(esito.messaggio).not.toContain('trasporto ignoto')
    }
  })

  it('quando ENTRAMBI i codici fiscali ci sono, la quarta frase NON si prende mai', async () => {
    // Il controllo che rende utile quello qui sopra: con due CF in mano il
    // verdetto è netto — o sono la stessa persona (idempotente) o non lo sono
    // («un'altra persona»), e non esiste una terza via prudente.
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: null,
          intestatario: { nome: 'Luca', cognome: 'Bianchi', codice_fiscale: 'BNCLCU80A01H501Z' },
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: personaDigitata,
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.messaggio).toContain('intestata a un’altra persona')
      expect(esito.messaggio).not.toContain('non è possibile stabilire')
    }
  })

  it('⛔ l’ANNO nel messaggio è quello della riga a registro, non quello di oggi', async () => {
    // `annoFiscale()` dice l'anno corrente: su una fattura del 2025 il messaggio
    // manderebbe a cercare un numero che in quel sezionale non esiste.
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        {
          id: 'f-1',
          numero: 2328,
          sezionale: 'Asilo',
          anno: 2025,
          aruba_filename: 'IT_gia.xml.p7m',
          sdi_stato: 1,
          quota_adult_id: PARENT_BIANCHI,
          intestatario: { nome: 'Luca', cognome: 'Bianchi', codice_fiscale: 'BNCLCU80A01H501Z' },
        },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.messaggio).toContain('Asilo 2328/2025')
  })

  it('la stessa quota già emessa resta IDEMPOTENTE: si risponde «già fatto», non 409', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      esistenti: [
        { id: 'f-1', numero: 2328, sezionale: 'Asilo', aruba_filename: 'IT_gia.xml.p7m', sdi_stato: 1, quota_adult_id: PARENT_FABBRI },
      ],
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI },
    })

    expect(esito.ok).toBe(true)
    expect(up).not.toHaveBeenCalled()
    expect(sb._rpc).not.toHaveBeenCalled()
  })
})

describe('la scelta arriva davvero sul documento', () => {
  it('`adult` scelto → è QUEL cessionario nell’XML, non quello dell’anagrafica', async () => {
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_BIANCHI },
    })

    expect(esito.ok).toBe(true)
    const riga = rigaRegistro(sb)!
    expect(String(riga.xml_inviato)).toContain('<Cognome>Bianchi</Cognome>')
    expect(String(riga.xml_inviato)).toContain('<CodiceFiscale>BNCLCU80A01H501Z</CodiceFiscale>')
    expect(String(riga.xml_inviato)).not.toContain('Fabbri')
    expect(riga.quota_adult_id).toBe(PARENT_BIANCHI)
    expect(riga.parent_registry_id).toBe(PARENT_BIANCHI)
  })

  it('NESSUN intestatario in anagrafica + scelta → la fattura ESCE (gli 88 pagamenti su 93)', async () => {
    // È il caso che conta di più: senza questo, il 422 scatterebbe PRIMA della
    // scelta e il selettore non servirebbe a niente proprio dove serve.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSenzaIntestatario, settings: settingsConfig, parentsById, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_BIANCHI },
    })

    expect(esito.ok).toBe(true)
    expect(up).toHaveBeenCalledTimes(1)
    expect(Number(rigaRegistro(sb)!.importo)).toBe(150)
  })

  it('senza scelta, quel pagamento continua a rispondere 422 e non consuma niente', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSenzaIntestatario, settings: settingsConfig, parentsById, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(422)
      expect(esito.motivo).toBe('intestatario_mancante')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
  })

  it('`persona` digitata → `<Nome>`/`<Cognome>` nell’XML, `quota_adult_id` NULL, snapshot completo', async () => {
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: personaDigitata,
    })

    expect(esito.ok).toBe(true)
    const riga = rigaRegistro(sb)!
    const xml = String(riga.xml_inviato)
    expect(xml).toContain('<Nome>Carlo</Nome>')
    expect(xml).toContain('<Cognome>Perlini</Cognome>')
    expect(xml).toContain('<CodiceFiscale>PRLCRL80A01H501Z</CodiceFiscale>')
    expect(xml).toContain('<NumeroCivico>9</NumeroCivico>')
    expect(xml).toContain('<Provincia>CE</Provincia>')
    // Nessuna riga d'anagrafica dietro: le due colonne che la citerebbero sono nulle.
    expect(riga.quota_adult_id).toBeNull()
    expect(riga.parent_registry_id).toBeNull()
    // Lo snapshot a registro è la sola memoria di CHI era l'intestatario.
    expect(riga.intestatario).toEqual({
      nome: 'Carlo',
      cognome: 'Perlini',
      codice_fiscale: 'PRLCRL80A01H501Z',
    })
  })

  it('`persona` → `parents` non viene interrogata affatto (né registry, né residenza estesa)', async () => {
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, { intestatarioScelto: personaDigitata })

    expect(sb._parentsLetti, 'il payload È la fonte: non c’è nessuna riga da rileggere').not.toHaveBeenCalled()
  })

  it('scegliere lo STESSO genitore dell’anagrafica produce un XML identico a non scegliere niente', async () => {
    // La prova che il ramo nuovo non perturba il percorso di oggi: stesso
    // pagamento, stesso numero, due strade, stessa stringa.
    const a = await motore()
    const sbA = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })
    await a.emettiFatturaPagamento(sbA as never, 'pag-1', { id: 'staff-1' })

    const b = await motore()
    const sbB = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })
    await b.emettiFatturaPagamento(sbB as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_FABBRI },
    })

    expect(String(rigaRegistro(sbB)!.xml_inviato)).toBe(String(rigaRegistro(sbA)!.xml_inviato))
    expect(rigaRegistro(sbB)!.intestatario).toEqual(rigaRegistro(sbA)!.intestatario)
  })
})

describe('la scelta passa dagli STESSI gate fail-closed, e nessuno di essi consuma un numero', () => {
  it('CAP di quattro cifre → 422, e la RPC del numero non viene MAI chiamata', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { ...personaDigitata, cap: '8103' },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(422)
      expect(esito.messaggio).toContain('CAP (formato)')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
  })

  it('senza comune → 422 senza numero, e il messaggio dice DOVE si corregge (non «nell’anagrafica del genitore»)', async () => {
    const { emettiFatturaPagamento } = await motore()
    const sb = makeSupabase({ pagamento: pagamentoSaldato, settings: settingsConfig, parentsById, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { ...personaDigitata, comune: '   ' },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.messaggio).toContain('comune di residenza')
      expect(esito.messaggio).toContain('Intestatario fatture')
      expect(esito.messaggio).not.toContain('anagrafica del genitore')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('⛔ `adult` che NON è genitore di questo bambino → rifiutato PRIMA del numero', async () => {
    // Contro un operatore che vuole sbagliare non protegge niente (col ramo
    // `persona` digita chiunque). Contro un BUG DEL CLIENT — il modale che
    // rimanda l'`adult_id` del pagamento precedente — è l'unica rete: la fattura
    // partirebbe col codice fiscale e la residenza di un'altra famiglia, e si
    // corregge solo con una nota di variazione.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      // L'anagrafica di questa persona ESISTE ed è completa: se il gate mancasse,
      // la fattura uscirebbe senza il minimo attrito. È il punto del test.
      parentsById: {
        ...parentsById,
        'parent-di-un-altra-famiglia': {
          id: 'parent-di-un-altra-famiglia',
          first_name: 'Tommaso',
          last_name: 'Perlini',
          fiscal_code: 'PRLTMS80A01H501Z',
          residence_address: 'Via delle Verifiche 1',
          residence_city: 'Aversa',
          zip_code: '81031',
        },
      },
      studentParents: [{ parent_id: PARENT_FABBRI }, { parent_id: PARENT_BIANCHI }],
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: 'parent-di-un-altra-famiglia' },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('intestatario_non_del_bambino')
      expect(esito.httpStatus).toBe(422)
      expect(esito.messaggio).toContain('genitori di questo bambino')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
  })

  it('il gate vale SOLO sulla scelta: la cascata continua a fatturare chi dice lei', async () => {
    // L'ordinante di un ordine divise, o una quota esplicita dei genitori
    // separati, vengono dai NOSTRI dati: rifiutarli perché la tabella dei legami
    // è incompleta spegnerebbe l'emissione su una nostra lacuna d'archivio.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      studentParents: [],
      legami: [],
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(up).toHaveBeenCalledTimes(1)
  })

  it('un `adult` genitore ma SENZA riga in anagrafica → 422 «non trovato» (l’altro ramo resta)', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      studentParents: [{ parent_id: PARENT_FABBRI }, { parent_id: 'parent-senza-anagrafica' }],
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: 'parent-senza-anagrafica' },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(422)
      expect(esito.motivo).toBe('intestatario_mancante')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
  })

  it('⛔ `adult` noto solo dal PONTE, scelto con l’id che l’ANTEPRIMA espone → accettato', async () => {
    // ⚠️ QUESTO TEST PRIMA MENTIVA, ed è la ragione per cui vale la pena leggerlo.
    // Usava la STESSA stringa come `genitore_id` del ponte e come `adult_id`
    // scelto: schiacciava i due spazi d'identità in uno e provava un percorso che
    // in produzione non esiste. Il ponte porta `utenti.id`; l'anteprima espone
    // `parents.id` (risolto via `auth_user_id`). Con gli id distinti, l'emissione
    // rifiutava con 422 un intestatario che l'anteprima aveva appena proposto —
    // un'app che offre una scelta e poi dà la colpa a chi l'ha premuta.
    // In produzione sono 4 legami su 2 alunni, ed è la forma delle famiglie
    // create dal modulo pubblico: cresce.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById,
      parentsByAuth: { [ACCOUNT_BIANCHI]: { ...parentsById[PARENT_BIANCHI], auth_user_id: ACCOUNT_BIANCHI } },
      studentParents: [],
      legami: [{ alunno_id: 'al-1', genitore_id: ACCOUNT_BIANCHI }],
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      // L'id che l'anteprima mette nei `candidati`: `parents.id`, non l'account.
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_BIANCHI },
    })

    expect(esito.ok, 'l’emissione rifiuta ciò che l’anteprima propone').toBe(true)
    expect(up).toHaveBeenCalledTimes(1)
  })

  it('lo stesso genitore scelto con l’id dell’ACCOUNT resta accettato', async () => {
    // Una chiamata a mano, o un client che abbia in mano l'altro spazio: i due
    // id sono la stessa persona e devono valere entrambi.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: pagamentoSaldato,
      settings: settingsConfig,
      parentsById: { ...parentsById, [ACCOUNT_BIANCHI]: parentsById[PARENT_BIANCHI] },
      parentsByAuth: { [ACCOUNT_BIANCHI]: { ...parentsById[PARENT_BIANCHI], auth_user_id: ACCOUNT_BIANCHI } },
      studentParents: [],
      legami: [{ alunno_id: 'al-1', genitore_id: ACCOUNT_BIANCHI }],
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: ACCOUNT_BIANCHI },
    })

    expect(esito.ok).toBe(true)
    expect(up).toHaveBeenCalledTimes(1)
  })

  it('scelta su un pagamento RIPARTITO → 409, nessun numero, nessuna chiamata ad Aruba', async () => {
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: {
        ...pagamentoSaldato,
        alunni: {
          ...pagamentoSaldato.alunni,
          genitori_separati: true,
          retta_split_config: {
            quote: [
              { adult_id: PARENT_FABBRI, importo: 90, etichetta: 'Mamma' },
              { adult_id: PARENT_BIANCHI, importo: 60, etichetta: 'Papà' },
            ],
          },
        },
      },
      settings: settingsConfig,
      parentsById,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: PARENT_BIANCHI },
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(409)
      expect(esito.motivo).toBe('intestatario_in_conflitto')
      // Il messaggio deve indicare la via d'uscita, che esiste già.
      expect(esito.messaggio).toContain('quote')
    }
    expect(sb._rpc, 'la ripartizione si rifiuta PRIMA di toccare il contatore').not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('lo stesso pagamento ripartito, SENZA scelta, continua a emettere le due quote', async () => {
    // Senza questo, il 409 potrebbe essere «non emette più i separati» e nessuno
    // se ne accorgerebbe: sono tre alunni in produzione.
    const { emettiFatturaPagamento, up } = await motore()
    const sb = makeSupabase({
      pagamento: {
        ...pagamentoSaldato,
        alunni: {
          ...pagamentoSaldato.alunni,
          genitori_separati: true,
          retta_split_config: {
            quote: [
              { adult_id: PARENT_FABBRI, importo: 90, etichetta: 'Mamma' },
              { adult_id: PARENT_BIANCHI, importo: 60, etichetta: 'Papà' },
            ],
          },
        },
      },
      settings: settingsConfig,
      parentsById,
      rpc: 2328,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(up).toHaveBeenCalledTimes(2)
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(2)
  })
})
