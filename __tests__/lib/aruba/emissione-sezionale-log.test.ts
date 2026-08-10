import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA SERIE FISCALE LASCIA UNA TRACCIA — anche quando la fattura parte lo stesso.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * DUE CASI CHE FINO AL 2026-08-10 ATTRAVERSAVANO L'EMISSIONE IN SILENZIO.
 *
 * 1. CODICE FISCALE (o data di nascita) VALORIZZATO MA ILLEGGIBILE. `sezionalePerMinore`
 *    scartava il valore e ripiegava sull'altra fonte restituendo un esito byte per byte
 *    identico a quello di un campo ASSENTE; `emettiFatturaPagamento` loggava solo la
 *    `discordanza`, quindi non scriveva niente. Misurato in produzione il 2026-08-10:
 *    su 32 alunni, 14 hanno un codice fiscale valorizzato e **solo 3 di forma valida**.
 *    Non è un dettaglio d'anagrafica: quel codice sbagliato finisce **verbatim** nella
 *    descrizione della riga di fattura (segnaposto `{codice_fiscale}`), cioè nell'unico
 *    punto del documento in cui il minore è identificato e da cui dipende la detrazione
 *    del genitore — su un documento irreversibile verso lo SDI.
 *
 * 2. ANNO SCOLASTICO PRESO DALLA DATA DI EMISSIONE. Il pagamento senza
 *    `periodo_competenza` (71 su 98 in produzione al 2026-08-10) fa ripiegare la scelta
 *    sul giorno in cui si preme il bottone: una retta di maggio fatturata a settembre
 *    cambia serie. Il ripiego resta — bloccare tre quarti delle fatture sarebbe peggio —
 *    ma va scritto, perché è l'unico modo di ricostruirlo dopo.
 *
 * E in nessuna delle due righe entra un dato del minore (AGENTS.md, regola 8).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COME SI OSSERVA: come in `emissione-log.test.ts` — `carica()` ricarica il grafo con
 * `VITEST=''` (il logger tace sotto vitest) e `app-log` MOCKATO.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'
const ALUNNO = '22222222-2222-2222-2222-222222222222'

/** Il giorno in cui si emette: 30 settembre 2026 → anno scolastico 2026/2027. */
const ADESSO = new Date(2026, 8, 30, 10, 0, 0)

let appLog: ReturnType<typeof vi.fn>

async function carica() {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return {
      ...actual,
      arubaSignin: vi.fn(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    }
  })
  return await import('@/lib/aruba/emissione')
}

async function righe(): Promise<Riga[]> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(1))
  return appLog.mock.calls.map((c) => c[0] as Riga)
}

/** Le righe con quell'`esito` nel contesto: è la chiave con cui si interrogano in tabella. */
async function righeConEsito(esito: string): Promise<Riga[]> {
  return (await righe()).filter((r) => JSON.stringify(r).includes(esito))
}

function makeSupabase(responses: Record<string, unknown> & { rpc?: number }) {
  const inserts: { table: string; row: unknown }[] = []
  const api = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: responses[table] ?? null, error: null }),
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }
      return builder
    },
    rpc: async () => ({ data: responses.rpc ?? 1, error: null }),
    _inserts: inserts,
  }
  return api
}

/**
 * ⚠️ Tutti i dati sono SINTETICI: il repository è pubblico e il dominio sono minori.
 * Il codice fiscale «buono» del bambino è impossibile (terna `XXXYYY`, catastale `Z999`,
 * carattere di controllo qualsiasi).
 */
const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta di Maggio',
  importo: 150,
  stato: 'pagato',
  scadenza: '2026-05-10',
  periodo_competenza: '2026-05-01',
  scuola_id: SCUOLA,
  fattura_causale: null,
  categoria_id: null,
  alunno_id: ALUNNO,
  payment_categories: null,
  alunni: {
    id: ALUNNO,
    nome: 'Mario',
    cognome: 'Rossi',
    codice_fiscale: 'XXXYYY24D30Z999X', // 30/04/2024
    data_nascita: '2024-04-30',
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

const parent = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via Milano 9',
  residence_city: 'Roma',
  zip_code: '00185',
}

beforeEach(() => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
})

afterEach(() => {
  vi.useRealTimers()
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('un dato del minore VALORIZZATO ma illeggibile non passa più muto', () => {
  it('CODICE FISCALE spazzatura: riga `error`, la fattura parte, e il CF non è nel log', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      // 14 caratteri: è la forma di dieci dei quattordici codici valorizzati in produzione
      pagamenti: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: 'XXXYYY24D30Z99' },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 21,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    // La serie si decide con l'altra fonte: la fattura parte, non si blocca nulla.
    expect(esito.ok).toBe(true)

    const trovate = await righeConEsito('anagrafica-minore-illeggibile')
    expect(trovate, 'il caso più frequente non può restare senza una riga').toHaveLength(1)
    const r = trovate[0]
    expect(r.livello).toBe('error') // il documento verso lo SDI è irreversibile
    expect(r.evento).toBe('fattura')
    expect(String(r.messaggio)).toMatch(/codice fiscale del minore è valorizzato ma NON è leggibile/i)
    // Gli uuid restano in chiaro: sono la chiave per trovare il bambino da correggere.
    expect(JSON.stringify(r)).toContain(ALUNNO)
    // Il VALORE sbagliato no: è un dato di un minore, e non entra nemmeno mascherato male.
    expect(JSON.stringify(r)).not.toContain('XXXYYY24D30Z99')
  })

  it('DATA DI NASCITA illeggibile: stessa riga, e la data non compare', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, data_nascita: '30/04/2024' },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 22,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)

    const trovate = await righeConEsito('anagrafica-minore-illeggibile')
    expect(trovate).toHaveLength(1)
    expect(String(trovate[0].messaggio)).toMatch(/data di nascita del minore è valorizzata ma NON è leggibile/i)
    expect(JSON.stringify(trovate[0])).not.toContain('30/04/2024')
  })

  it('anagrafica PULITA: nessuna riga di illeggibilità (un allarme che grida sempre non si guarda)', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 23,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    expect(await righeConEsito('anagrafica-minore-illeggibile')).toHaveLength(0)
    expect(await righeConEsito('sezionale-discordanza')).toHaveLength(0)
  })

  /**
   * `char(16)` significa che PostgREST consegna il campo mai compilato come SEDICI SPAZI.
   * Se contasse come «illeggibile», ogni fattura di ogni bambino senza codice fiscale
   * scriverebbe un `error` — e in produzione i bambini senza codice fiscale sono 18 su 32.
   */
  it('un codice fiscale di soli spazi è ASSENTE, non illeggibile', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: '                ' },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 24,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    expect(await righeConEsito('anagrafica-minore-illeggibile')).toHaveLength(0)
  })
})

describe("l'anno scolastico viene dal periodo fatturato, non dal giorno in cui si emette", () => {
  /** 30/04/2024: FPR sull'anno scolastico 2026, Asilo sul 2025. */
  const NASCITA_AL_CONFINE = '2024-04-30'

  it('retta di MAGGIO fatturata a SETTEMBRE: vince maggio, e la serie è «Asilo»', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        periodo_competenza: '2026-05-01', // anno scolastico 2025/2026
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: null, data_nascita: NASCITA_AL_CONFINE },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 31,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    // Con la data di EMISSIONE (settembre 2026) sarebbe uscita «FPR»: numero bruciato
    // sulla serie sbagliata, e si rimedia solo con una nota di variazione.
    expect((riga.row as { sezionale: string }).sezionale).toBe('Asilo')
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(0)
  })

  it('senza periodo di competenza si ripiega su oggi — e lo si SCRIVE, a livello warn', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        periodo_competenza: null,
        alunni: { ...pagamentoSaldato.alunni, codice_fiscale: null, data_nascita: NASCITA_AL_CONFINE },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 32,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect((riga.row as { sezionale: string }).sezionale).toBe('FPR')

    const trovate = await righeConEsito('anno-scolastico-da-data-documento')
    expect(trovate, 'il ripiego è la maggioranza dei pagamenti: deve restare ricostruibile').toHaveLength(1)
    // `warn` e non `error`: il ripiego è previsto e quasi sempre coincide col periodo vero.
    expect(trovate[0].livello).toBe('warn')
    expect(String(trovate[0].messaggio)).toMatch(/periodo di competenza/i)
  })
})
