import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * MULTI-QUOTA: UNA RIGA VIVA CHE NON C'ENTRA CON LE QUOTE DI OGGI FERMA TUTTO.
 *
 * ─── IL DIFETTO, nella forma in cui costa davvero ────────────────────────────
 * La guardia contro il secondo documento (`gia_emessa_altro_intestatario`,
 * `emissione.ts`) vale SOLO nel caso a quota unica: `if (!multi && …)`. Nel ramo
 * multi-quota l'idempotenza confronta il solo `quota_adult_id`, quindi:
 *
 *   giorno 1 — il pagamento da 150 € è a quota unica e la fattura esce INTERA al
 *              genitore A (`quota_adult_id = A`, `importo = 150`);
 *   giorno 2 — la segreteria scopre che i genitori sono separati e ripartisce
 *              75/75 fra A e B. Si ripreme «Emetti»: la quota di A trova la riga
 *              di A e passa per «già fatto», la quota di B non trova niente e
 *              parte un SECONDO documento fiscale vero per la stessa retta.
 *
 * Alla fine, per un pagamento da 150 €, allo SDI risultano 150 + 75 = 225 € di
 * fatture — e la sola via d'uscita è una nota di variazione. Il database non lo
 * impedisce: la chiave di `fatture_emesse_pagamento_quota_uidx` contiene
 * `quota_adult_id`, quindi due intestatari sono due chiavi diverse.
 *
 * ─── LA REGOLA (decisa dal titolare, più stretta della sola presenza) ────────
 * Nel ramo multi, PRIMA del ciclo delle quote: si costruisce la mappa delle quote
 * correnti (adulto → importo di oggi) e si guarda ogni riga VIVA a registro. Una
 * riga è ESTRANEA se non dice a chi è intestata (`quota_adult_id` nullo), o se è
 * di un adulto che oggi non ha quota, **oppure** se è di un adulto corrente ma
 * col suo importo di ieri. Basta una riga estranea e si ferma TUTTO: 409 su ogni
 * quota, nessun numero consumato, nessun upload, nessuna riga a registro.
 *
 * Il fake qui sotto CONTA le chiamate a `rpc` (che alloca il numero) e gli
 * INSERT: «nessun numero è stato consumato» non è una frase di cortesia nel
 * messaggio d'errore, è un'asserzione.
 *
 * Tutti i dati sono SINTETICI (repository pubblico): nessun nome, nessun codice
 * fiscale, nessun uuid di famiglie vere.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'
/**
 * Un uuid, non `pag-1`: la redazione dei log è a LISTA BIANCA e lascia passare in
 * chiaro solo ciò che è auto-descrittivo. Con un id finto la riga di `app_log`
 * uscirebbe `[redatto:str/5]` e il test direbbe di aver verificato un campo che
 * in produzione ha tutt'altra forma.
 */
const PAGAMENTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

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

interface Cfg {
  quote: { adult_id: string; importo: number | string; etichetta: string | null }[]
  /** Le righe già a registro per questo pagamento (`fatture_emesse`). */
  esistenti?: Record<string, unknown>[]
  parentsByAuth?: Record<string, unknown>
}

/**
 * Il fake di `emissione-gate-numero.test.ts:49-71`, esteso con ciò che il ramo
 * multi-quota pretende: le tabelle si distinguono UNA PER UNA (un mock che
 * risponde uguale a tutte renderebbe verde un codice che non legge niente) e
 * `fatture_emesse`/`pagamenti_quote` sono THENABLE, perché il motore le legge
 * come elenco (`await …select().eq()`), non con `maybeSingle`.
 */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
  const lette: string[] = []
  let prossimo = 2328
  const rpc = vi.fn(async () => ({ data: prossimo++, error: null }))
  return {
    from(table: string) {
      lette.push(table)
      let eqCol: string | null = null
      let eqVal: string | null = null
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: string) => {
          eqCol = c
          eqVal = v
          return builder
        },
        in: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => ({ data: table === 'pagamenti' ? pagamentoSeparati : null, error: null }),
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: settingsConfig, error: null }
          if (table === 'divise_ordini') return { data: null, error: null }
          if (table === 'parents') {
            // `resolveParentRegistry` prova prima `id`, poi il ponte
            // `auth_user_id`: le quote parlano lo spazio degli account.
            const mappa = eqCol === 'auth_user_id' ? cfg.parentsByAuth ?? {} : {}
            return { data: (eqVal && mappa[eqVal]) ?? null, error: null }
          }
          return { data: null, error: null }
        },
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: (row: unknown) => ({
          eq: async () => {
            updates.push({ table, row })
            return { error: null }
          },
        }),
        then: (resolve: (v: unknown) => unknown) => {
          const data =
            table === 'pagamenti_quote' ? cfg.quote :
            table === 'fatture_emesse' ? cfg.esistenti ?? [] : []
          return resolve({ data, error: null })
        },
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _updates: updates,
    _lette: lette,
    _rpc: rpc,
  }
}

const fatture = (sb: ReturnType<typeof makeSupabase>) =>
  sb._inserts.filter((i) => i.table === 'fatture_emesse')

/** Il pagamento: genitori separati, così la cascata legge `pagamenti_quote`. */
const pagamentoSeparati = {
  id: PAGAMENTO,
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scuola_id: SCUOLA,
  scadenza: '2026-03-10',
  periodo_competenza: '2026-03-01',
  categoria_id: null,
  fattura_causale: null,
  alunno_id: 'al-1',
  payment_categories: null,
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Fabbri',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    genitori_separati: true,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', adult_id: 'parent-x' },
  },
}

const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
  },
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

/** Anagrafiche SINTETICHE e complete: nessun dato di famiglie vere nei test. */
const reg = (first: string, cf: string) => ({
  id: `reg-${first}`,
  first_name: first,
  last_name: 'Fabbri',
  fiscal_code: cf,
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
})

const DUE_GENITORI = {
  'u-mamma': reg('Giulia', 'FRNGLI80A41H501Z'),
  'u-papa': reg('Marco', 'FBBMRC80A01H501A'),
}

const QUOTE_75_75 = [
  { adult_id: 'u-mamma', importo: 75, etichetta: 'Mamma' },
  { adult_id: 'u-papa', importo: 75, etichetta: 'Papà' },
]

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

/** Il motore con Aruba che risponde a tutto: se qualcosa parte, si vede. */
async function motore(upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))) {
  const mod = await carica({
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => 2327),
    arubaUpload: upload,
  })
  return { emetti: mod.emettiFatturaPagamento, upload }
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

describe('multi-quota — una riga viva estranea alle quote di oggi ferma l’emissione', () => {
  it('fattura INTERA ad A (150) e poi split A/B 75/75 → 409 su ENTRAMBE, nessun numero consumato', async () => {
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      // La riga di ieri: intestata ad A, ma per l'INTERO importo. Oggi la quota
      // di A vale 75: quella fattura non è la fattura di questa quota.
      esistenti: [
        {
          id: 'f1',
          numero: 2327,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'x.xml',
          sdi_stato: 1,
          quota_adult_id: 'u-mamma',
          importo: 150,
          intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    // ⚠️ QUESTE TRE PRIMA DI TUTTO, ed è il punto del test: senza la guardia la
    // quota di A passa per «già fatto» e quella di B ALLOCA UN NUMERO e MANDA UN
    // SECONDO DOCUMENTO allo SDI. È il danno, e si vede prima di ogni altra cosa.
    expect(sb._rpc, 'un numero consumato qui è un buco nel registro fiscale').not.toHaveBeenCalled()
    expect(upload, 'nessun documento deve partire verso lo SDI').not.toHaveBeenCalled()
    expect(fatture(sb)).toHaveLength(0)

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('quota_estranea')
      expect(esito.httpStatus).toBe(409)
      // Il numero della riga che blocca: senza, chi legge non sa quale documento
      // andare a guardare su Aruba.
      expect(esito.messaggio).toContain('Asilo 2327/2026')
      expect(esito.messaggio).toContain('nota di variazione')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
      // 409 su TUTTE le quote, non solo su quella che non trovava riscontro:
      // finché quella fattura è viva, nessuna delle due si può emettere.
      expect(esito.quote).toHaveLength(2)
      for (const q of esito.quote!) {
        expect(q.ok).toBe(false)
        expect(q.motivo).toBe('quota_estranea')
        expect(q.httpStatus).toBe(409)
      }
      expect(esito.quote!.map((q) => q.adultId).sort()).toEqual(['u-mamma', 'u-papa'])
    }
    // ⚠️ LIMITE DICHIARATO, non un'approvazione. L'unica scrittura che resta è
    // quella dell'aggregato di fondo, che con zero quote emesse scrive
    // `fattura_stato: 'scartata'` — lo stesso che fa oggi la guardia a quota
    // unica (`gia_emessa_altro_intestatario`), e in questo caso è impreciso: la
    // fattura di ieri è viva, non scartata. `fattura/sync` lo ricalcola da
    // `fatture_emesse` solo per le righe ancora IN VOLO (`sdi_stato` 1/3/5); su
    // una riga terminale (6/7/8/10) quello stato resta finché non lo si tocca.
    // Il test lo fissa perché il giorno in cui cambierà lo dica un test e non un
    // pagamento in lista.
    expect(sb._updates.map((u) => u.table)).toEqual(['pagamenti'])
    expect((sb._updates[0].row as { fattura_stato: string }).fattura_stato).toBe('scartata')
  })

  it('riga viva SENZA `quota_adult_id` (non dice a chi è intestata) → 409', async () => {
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      // L'importo COMBACIA con una quota: a fermare non è la cifra, è che di
      // questa riga non si sa a chi sia intestata. `null` non è una prova
      // d'identità: è l'assenza della prova.
      esistenti: [
        {
          id: 'f1',
          numero: 2327,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'x.xml',
          sdi_stato: 1,
          quota_adult_id: null,
          importo: 75,
          intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('quota_estranea')
      expect(esito.httpStatus).toBe(409)
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(fatture(sb)).toHaveLength(0)
  })

  it('riga viva di un TERZO adulto, che oggi non ha quota → 409', async () => {
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1',
          numero: 2327,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'x.xml',
          sdi_stato: 1,
          quota_adult_id: 'u-nonno',
          importo: 75,
          intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('quota_estranea')
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(fatture(sb)).toHaveLength(0)
  })

  it('riga viva dell’adulto GIUSTO ma con l’importo di ieri (75 → 90) → 409', async () => {
    // Il caso che la sola presenza di `quota_adult_id` non vede: le quote si
    // modificano (90/60 → 75/75) e la fattura di ieri resta a registro con la
    // cifra vecchia. Emettere la quota nuova significa due documenti per la
    // stessa persona e la stessa retta.
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1',
          numero: 2327,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'x.xml',
          sdi_stato: 1,
          quota_adult_id: 'u-mamma',
          importo: 90,
          intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('quota_estranea')
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(fatture(sb)).toHaveLength(0)
  })

  it('LO SCARTO NON BLOCCA: A viva a 75, B scartata → B si riemette, un numero solo', async () => {
    // La controprova che tiene onesta la guardia: senza di lei, «non emette mai
    // niente» supererebbe tutti i casi qui sopra. Una riga scartata (SDI 4) non è
    // un documento in circolazione, e riemettere è l'unica via d'uscita.
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1',
          numero: 2327,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: 'x.xml',
          sdi_stato: 1,
          quota_adult_id: 'u-mamma',
          importo: 75,
          intestatario: null,
        },
        {
          id: 'f2',
          numero: 2326,
          sezionale: 'Asilo',
          anno: 2026,
          aruba_filename: null,
          // 4 = scartata dallo SDI: non è viva, e non entra nel confronto.
          sdi_stato: 4,
          quota_adult_id: 'u-papa',
          importo: 150,
          intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(sb._rpc, 'un solo numero: quello della quota da riemettere').toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(fatture(sb)).toHaveLength(1)
    expect((fatture(sb)[0].row as { quota_adult_id: string }).quota_adult_id).toBe('u-papa')
    if (esito.ok) {
      expect(esito.quote!.find((q) => q.adultId === 'u-mamma')!.motivo).toBe('idempotente')
      expect(esito.quote!.find((q) => q.adultId === 'u-papa')!.ok).toBe(true)
    }
  })

  it('le due righe CORRISPONDONO alle quote di oggi → idempotente, come prima', async () => {
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1', numero: 2327, sezionale: 'Asilo', anno: 2026, aruba_filename: 'x.xml',
          sdi_stato: 1, quota_adult_id: 'u-mamma', importo: 75, intestatario: null,
        },
        {
          id: 'f2', numero: 2328, sezionale: 'Asilo', anno: 2026, aruba_filename: 'y.xml',
          sdi_stato: 1, quota_adult_id: 'u-papa', importo: 75, intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.quote!.every((q) => q.motivo === 'idempotente')).toBe(true)
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(fatture(sb)).toHaveLength(0)
  })

  it('l’importo a registro arriva come STRINGA («75.00») e vale lo stesso: nessun falso 409', async () => {
    // `fatture_emesse.importo` è `numeric(10,2)`, e un numerico può arrivare da
    // PostgREST come stringa (lo stesso repo scrive `Number(q.importo)` sulle
    // quote per questo motivo). Confrontare senza convertire trasformerebbe una
    // riemissione legittima in un 409, cioè in un giro dal commercialista.
    const { emetti } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1', numero: 2327, sezionale: 'Asilo', anno: 2026, aruba_filename: 'x.xml',
          sdi_stato: 1, quota_adult_id: 'u-mamma', importo: '75.00', intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    // La quota di A resta «già fatto», quella di B parte: nessuna delle due è
    // fermata, perché a registro non c'è niente di estraneo.
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.quote!.find((q) => q.adultId === 'u-mamma')!.motivo).toBe('idempotente')
      expect(esito.quote!.find((q) => q.adultId === 'u-papa')!.ok).toBe(true)
    }
    expect(sb._rpc).toHaveBeenCalledTimes(1)
  })

  it('riga SENZA importo (colonna non letta) → non si inventa una divergenza', async () => {
    // `importo` è NOT NULL a schema (`baseline.sql:1497`): una riga viva senza
    // importo non esiste in produzione. E il caso «la colonna non c'è» è già
    // coperto altrove e nel verso giusto — la SELECT intera fallisce con `42703`
    // e l'emissione si ferma a 503 (`idempotenza-non-verificabile`). Qui, quindi,
    // non c'è niente da confrontare: la riga resta la fattura di quella quota, ed
    // è il comportamento che `fattura-emissione-split.test.ts` fissa dal 2026-08.
    const { emetti } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        { id: 'f1', numero: 2327, aruba_filename: 'x.xml', sdi_stato: 1, quota_adult_id: 'u-mamma' },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.quote!.find((q) => q.adultId === 'u-mamma')!.motivo).toBe('idempotente')
  })

  it('la QUOTA UNICA non cambia comportamento: resta la guardia di sempre', async () => {
    // La regola nuova vive solo nel ramo multi. Con una quota sola la riga viva
    // di un altro intestatario ha già il suo 409 (`gia_emessa_altro_intestatario`)
    // e quel messaggio non deve essere sostituito da quello nuovo.
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      quote: [{ adult_id: 'u-mamma', importo: 150, etichetta: 'Mamma' }],
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1', numero: 2327, sezionale: 'Asilo', anno: 2026, aruba_filename: 'x.xml',
          sdi_stato: 1, quota_adult_id: 'u-papa', importo: 150, intestatario: null,
        },
      ],
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('gia_emessa_altro_intestatario')
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('multi-quota — la riga fermata lascia traccia in `app_log`', () => {
  it('un `warn` con l’esito interrogabile, e nei campi solo uuid e numeri', async () => {
    const { emetti } = await motore()
    const sb = makeSupabase({
      quote: QUOTE_75_75,
      parentsByAuth: DUE_GENITORI,
      esistenti: [
        {
          id: 'f1', numero: 2327, sezionale: 'Asilo', anno: 2026, aruba_filename: 'x.xml',
          sdi_stato: 1, quota_adult_id: 'u-mamma', importo: 150, intestatario: null,
        },
      ],
    })

    await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(0))
    const righe = appLog.mock.calls.map((c) => c[0] as Riga)
    const campiDi = (r: Riga) => (r.contestoExtra as { campi?: Record<string, unknown> })?.campi ?? {}
    const riga = righe.find(
      (r) => r.evento === 'fattura' && r.livello === 'warn' && campiDi(r).esito === 'riga-viva-estranea-fermata',
    )
    expect(riga, 'nessuna riga `fattura/warn` con esito `riga-viva-estranea-fermata`').toBeTruthy()
    const campi = campiDi(riga!)
    expect(campi.operazione).toBe('emettiFatturaPagamento:multi-quota')
    expect(campi.provider).toBe('aruba')
    expect(campi.scuola_id).toBe(SCUOLA)
    expect(campi.pagamento_id).toBe(PAGAMENTO)
    // Il numero della riga che blocca e quante quote sono state fermate: senza,
    // in tabella non si distingue un caso dall'altro.
    expect(campi.numero).toBe(2327)
    expect(campi.n_quote).toBe(2)
    // Nessun dato personale: la riga racconta numeri e uuid tecnici, mai una
    // persona. `n_quote` è un conteggio, `numero` il progressivo del documento.
    const testo = JSON.stringify(riga)
    for (const vietato of ['Giulia', 'Marco', 'Fabbri', 'FRNGLI80A41H501Z', 'FBBMRC80A01H501A']) {
      expect(testo, `dato personale nel log: ${vietato}`).not.toContain(vietato)
    }
  })
})
