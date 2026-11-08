import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * L'ANNO DELLA VOCE DECIDE LA SERIE, E AGOSTO NON È PIÙ AMBIGUO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * 1. L'ANNO DELLA VOCE (PR 4.1, compito 4.1.S3). Ogni voce di `pagamenti` ha il suo
 *    `anno_id`, calcolato dal database dalla competenza, altrimenti dalla scadenza,
 *    altrimenti dalla creazione. Una retta di maggio saldata a novembre ha l'anno
 *    2025/26: la serie fiscale si decide su quello, non sul giorno in cui si emette
 *    (che sarebbe il 2026/27 e sposterebbe di dodici mesi il confine dei tre anni).
 *    L'`anno_id` si traduce in `annoInizio` attraverso il calendario della sede.
 *    Sul database della CI la colonna non c'è (42703): si rifà la lettura senza e si va
 *    avanti, con un solo log `info`.
 *
 * 2. AGOSTO NON È PIÙ AMBIGUO. Prima la fatturazione faceva partire l'anno dal 1°
 *    SETTEMBRE e il resto del prodotto dal 1° AGOSTO: il ripiego sulla data del documento,
 *    ad agosto, per la coorte a cavallo del 30 aprile era una monetina e l'emissione si
 *    fermava con 422 `periodo_competenza_mancante`. Adesso la regola è una sola (il
 *    calendario della sede, o il predefinito del 1° settembre): la fattura parte.
 *
 * 3. IL DATO DI UN ADULTO NEL CAMPO DEL BAMBINO. `…85T10…` è un codice fiscale di forma
 *    perfetta che dice 10/12/1985: prima produceva una serie con tutte le bandiere a
 *    `false` e la fattura partiva muta. Ora è `anagrafica-minore-implausibile`, `error`.
 *
 * E in nessuna delle righe entra un dato del minore (AGENTS.md, regola 8).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COME SI OSSERVA: come in `emissione-log.test.ts` — `carica()` ricarica il grafo con
 * `VITEST=''` (il logger tace sotto vitest) e `app-log` MOCKATO.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'
const ALUNNO = '22222222-2222-2222-2222-222222222222'

/** Il giorno in cui si emette: **20 agosto 2026**, il mese che prima era «ambiguo». */
const ADESSO = new Date(2026, 7, 20, 10, 0, 0)

/** Il calendario della sede: il 2025/26 e il 2026/27, con i loro `anno_id`. */
const ANNO_2025 = 'aaaaaaaa-0000-0000-0000-000000002025'
const ANNO_2026 = 'aaaaaaaa-0000-0000-0000-000000002026'
const anniSede = [
  {
    id: 'bbbbbbbb-0000-0000-0000-000000002025', anno_id: ANNO_2025,
    inizio: '2025-09-01', fine: '2026-08-31', ultimo_giorno_aperto: '2026-07-31',
    prepara_successivo_dal: '2026-05-01', stato: 'chiuso', domande_aperte: false,
    anni_scolastici: { anno_inizio: 2025 },
  },
  {
    id: 'bbbbbbbb-0000-0000-0000-000000002026', anno_id: ANNO_2026,
    inizio: '2026-09-01', fine: '2027-08-31', ultimo_giorno_aperto: '2027-07-31',
    prepara_successivo_dal: '2027-05-01', stato: 'corrente', domande_aperte: false,
    anni_scolastici: { anno_inizio: 2026 },
  },
]

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

function makeSupabase(responses: Record<string, unknown> & { rpc?: number; erroreAnnoId?: boolean }) {
  const inserts: { table: string; row: unknown }[] = []
  /** Le liste di colonne chiesta a `pagamenti`, nell'ordine: serve a vedere la seconda lettura. */
  const selectPagamenti: string[] = []
  const api = {
    from(table: string) {
      let colonne = ''
      const builder = {
        select: (c?: string) => {
          colonne = c ?? ''
          if (table === 'pagamenti') selectPagamenti.push(colonne)
          return builder
        },
        eq: () => builder,
        // il calendario della sede: `.select().eq().order()` e basta
        order: async () => ({ data: responses[table] ?? [], error: null }),
        single: async () => {
          if (table === 'pagamenti' && responses.erroreAnnoId && colonne.includes('anno_id')) {
            return { data: null, error: { code: '42703', message: 'column pagamenti.anno_id does not exist' } }
          }
          return { data: responses[table] ?? null, error: null }
        },
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
    _selectPagamenti: selectPagamenti,
  }
  return api
}

/**
 * ⚠️ Tutti i dati sono SINTETICI: il repository è pubblico e il dominio sono minori.
 * I codici fiscali sono impossibili (terna `XXXYYY`, catastale `Z999`, carattere di
 * controllo qualsiasi) e nessuno può appartenere a una persona reale.
 *
 * **Senza `periodo_competenza`**: è il caso dei 71 pagamenti su 98 misurati in produzione,
 * ed è la condizione che rende il mese d'emissione decisivo.
 */
const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta',
  importo: 150,
  stato: 'pagato',
  scadenza: '2026-05-10',
  periodo_competenza: null,
  scuola_id: SCUOLA,
  fattura_causale: null,
  categoria_id: null,
  alunno_id: ALUNNO,
  payment_categories: null,
  alunni: {
    id: ALUNNO,
    nome: 'Mario',
    cognome: 'Rossi',
    codice_fiscale: null,
    // 15/06/2023: «Asilo» sull'anno scolastico 2025, «FPR» sul 2026. È la coorte.
    data_nascita: '2023-06-15',
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

describe('emissione in agosto senza periodo di competenza: non è più ambiguo', () => {
  it('la coorte a cavallo del 30 aprile PARTE, sulla serie del 2025/26 (prima: 422)', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 41,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok, 'ad agosto la serie si decide: nessun 422 periodo_competenza_mancante').toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    // 15/06/2023 sull'anno 2025/26: compie 3 anni DOPO il 30/04/2026 → «Asilo»
    expect((riga.row as { sezionale: string }).sezionale).toBe('Asilo')
    expect(await righeConEsito('anno-scolastico-ambiguo')).toHaveLength(0)
    // il ripiego sulla data del documento resta tracciato, come in ogni altro mese
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(1)
  })

  it('fuori dalla coorte la fattura parte come sempre', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        // nato nel 2019: «FPR» su qualunque anno
        alunni: { ...pagamentoSaldato.alunni, data_nascita: '2019-03-10' },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 43,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect((riga.row as { sezionale: string }).sezionale).toBe('FPR')
  })

  it('col periodo di competenza dichiarato la serie è quella del periodo', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: { ...pagamentoSaldato, periodo_competenza: '2026-05-01' },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 44,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    // maggio 2026 = anno scolastico 2025/2026 → il bambino del 15/06/2023 sta su «Asilo»
    expect((riga.row as { sezionale: string }).sezionale).toBe('Asilo')
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(0)
  })
})

/**
 * Una retta di MAGGIO (2025/26) saldata a NOVEMBRE 2026. Il bambino nato il 30/04/2024
 * compie 3 anni «entro il 30 aprile» del 2027 (→ FPR sull'anno 2026/27) ma non del 2026
 * (→ Asilo sull'anno 2025/26): la serie giusta per quella retta è «Asilo».
 */
describe('l’anno della voce decide la serie', () => {
  const NOVEMBRE = new Date(2026, 10, 8, 10, 0, 0)
  const voceDiMaggio = {
    ...pagamentoSaldato,
    anno_id: ANNO_2025,
    periodo_competenza: null,
    alunni: { ...pagamentoSaldato.alunni, data_nascita: '2024-04-30' },
  }

  it('voce del 2025/26, senza competenza, emessa a novembre: serie sul 2025, nessun ripiego', async () => {
    vi.setSystemTime(NOVEMBRE)
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: voceDiMaggio, anni_sede: anniSede,
      admin_settings: settingsConfig, parents: parent, rpc: 50,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    // sull'anno della data del documento (2026) sarebbe «FPR»: la retta è del 2025 → «Asilo»
    expect((riga.row as { sezionale: string }).sezionale).toBe('Asilo')
    // l'anno della voce non è un ripiego: nessun warn
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(0)
  })

  it('un anno_id che il calendario della sede non conosce ripiega sulla regola di sempre', async () => {
    vi.setSystemTime(NOVEMBRE)
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: { ...voceDiMaggio, anno_id: 'cccccccc-0000-0000-0000-000000000000' },
      anni_sede: anniSede, admin_settings: settingsConfig, parents: parent, rpc: 51,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect((riga.row as { sezionale: string }).sezionale).toBe('FPR')
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(1)
  })

  it('sul database senza `anno_id` (42703) rilegge senza la colonna, logga info una volta e la fattura parte', async () => {
    vi.setSystemTime(NOVEMBRE)
    const { emettiFatturaPagamento } = await carica()
    const { anno_id: _scartato, ...voceSenzaColonna } = voceDiMaggio
    void _scartato
    const sb = makeSupabase({
      pagamenti: voceSenzaColonna, erroreAnnoId: true,
      admin_settings: settingsConfig, parents: parent, rpc: 52,
    })

    // un uuid vero: il logger redige gli id che non hanno la forma di un uuid
    const PAGAMENTO = '33333333-3333-3333-3333-333333333333'
    expect((await emettiFatturaPagamento(sb as never, PAGAMENTO, { id: 'staff-1' })).ok).toBe(true)
    // due letture della voce: la prima con `anno_id`, la seconda senza
    expect(sb._selectPagamenti).toHaveLength(2)
    expect(sb._selectPagamenti[0]).toContain('anno_id')
    expect(sb._selectPagamenti[1]).not.toContain('anno_id')

    const info = await righeConEsito('anno-della-voce-non-disponibile')
    expect(info).toHaveLength(1)
    expect(info[0].livello).toBe('info')
    expect(JSON.stringify(info[0])).toContain(SCUOLA)
    expect(JSON.stringify(info[0])).toContain(PAGAMENTO)
    // la serie si decide dalla data del documento (novembre 2026 → anno 2026 → «FPR»)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect((riga.row as { sezionale: string }).sezionale).toBe('FPR')
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(1)
  })
})

describe('un codice fiscale che si legge benissimo ma è di un adulto', () => {
  it('non decide la serie, e lascia una riga `error` senza il valore', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        periodo_competenza: '2026-05-01', // tolgo di mezzo l'ambiguità d'agosto
        alunni: {
          ...pagamentoSaldato.alunni,
          codice_fiscale: 'XXXYYY85T10Z999X', // 10/12/1985: forma perfetta, persona sbagliata
          data_nascita: '2023-06-15',
        },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 45,
    })

    // La fattura parte: l'anagrafica basta a scegliere la serie.
    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)

    const trovate = await righeConEsito('anagrafica-minore-implausibile')
    expect(trovate, 'un dato di un adulto sul documento di un minore non può restare muto').toHaveLength(1)
    expect(trovate[0].livello).toBe('error')
    expect(String(trovate[0].messaggio)).toMatch(/un alunno non può avere/i)
    expect(JSON.stringify(trovate[0])).toContain(ALUNNO)
    expect(JSON.stringify(trovate[0])).not.toContain('XXXYYY85T10Z999X')
    // «impossibile» non è «illeggibile»: la forma del codice è giusta
    expect(await righeConEsito('anagrafica-minore-illeggibile')).toHaveLength(0)
    // e non è nemmeno una discordanza: una sola delle due fonti era utilizzabile
    expect(await righeConEsito('sezionale-discordanza')).toHaveLength(0)
  })

  it('se è l’UNICA fonte, l’emissione si ferma e non numera niente', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        periodo_competenza: '2026-05-01',
        alunni: {
          ...pagamentoSaldato.alunni,
          codice_fiscale: 'XXXYYY85T10Z999X',
          data_nascita: null,
        },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 46,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.motivo).toBe('dati_minore_mancanti')
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
    expect(await righeConEsito('sezionale-non-determinabile')).toHaveLength(1)
  })
})
