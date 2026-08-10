import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * AGOSTO — IL MESE IN CUI LA SERIE FISCALE SI TIRAVA A SORTE, E IL CAMPO CHE SI LEGGE
 * BENISSIMO MA È DI UN'ALTRA PERSONA.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * 1. IL RIPIEGO D'AGOSTO. `annoScolasticoDiCompetenza` fa partire l'anno scolastico dal
 *    1° SETTEMBRE; `annoScolasticoCorrente()` — con cui ragiona tutto il resto del
 *    prodotto — dal 1° AGOSTO. Le due regole coincidono undici mesi su dodici. Nel
 *    dodicesimo, per un pagamento SENZA `periodo_competenza` (71 su 98 in produzione al
 *    2026-08-10), l'anno viene dedotto dalla data del documento e la deduzione è una
 *    monetina: lo stesso pagamento emesso il 31 agosto esce su `Asilo` e il 1° settembre
 *    su `FPR`, per la coorte a cavallo del 30 aprile — cioè proprio la coorte che la
 *    regola dei tre anni esiste per separare. Numero già consumato sul sezionale
 *    sbagliato → nota di variazione verso lo SDI.
 *
 *    Non si blocca agosto: si blocca **dove la differenza esiste**. Se i due anni
 *    candidati portano il bambino sulla stessa serie, la fattura parte come sempre.
 *
 * 2. IL DATO DI UN ADULTO NEL CAMPO DEL BAMBINO. `…85T10…` è un codice fiscale di forma
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

/** Il giorno in cui si emette: **10 agosto 2026**, dentro il mese della divergenza. */
const ADESSO = new Date(2026, 7, 10, 10, 0, 0)

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

describe('emissione in agosto senza periodo di competenza', () => {
  it('la coorte a cavallo del 30 aprile NON viene numerata: 422 e nessun numero bruciato', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 41,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.motivo).toBe('periodo_competenza_mancante')
    expect(esito.httpStatus).toBe(422)
    // Il messaggio manda dove sta il dato mancante — il PAGAMENTO — non sull'anagrafica
    // del bambino, che è già a posto.
    expect(esito.messaggio).toMatch(/periodo di competenza/i)
    expect(esito.messaggio).not.toMatch(/anagrafica/i)
    // E soprattutto: nessuna riga in `fatture_emesse`, cioè nessun numero consumato.
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('lascia una riga `error` con `anno-scolastico-ambiguo`, senza la data di nascita', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 42,
    })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const trovate = await righeConEsito('anno-scolastico-ambiguo')
    expect(trovate).toHaveLength(1)
    expect(trovate[0].livello).toBe('error')
    expect(trovate[0].evento).toBe('fattura')
    expect(String(trovate[0].messaggio)).toMatch(/periodo di competenza/i)
    // l'uuid serve a trovare la pratica; la data di nascita del minore non entra mai
    expect(JSON.stringify(trovate[0])).toContain(ALUNNO)
    expect(JSON.stringify(trovate[0])).not.toContain('2023-06-15')
    // e non si spaccia per un'anagrafica incompleta: sono due riparazioni diverse
    expect(await righeConEsito('sezionale-non-determinabile')).toHaveLength(0)
  })

  it('fuori dalla coorte la fattura parte lo stesso: si blocca dove la differenza esiste', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: {
        ...pagamentoSaldato,
        // nato nel 2019: «FPR» su entrambi gli anni candidati, l'ambiguità non conta
        alunni: { ...pagamentoSaldato.alunni, data_nascita: '2019-03-10' },
      },
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 43,
    })

    expect((await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })).ok).toBe(true)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')!
    expect((riga.row as { sezionale: string }).sezionale).toBe('FPR')
    expect(await righeConEsito('anno-scolastico-ambiguo')).toHaveLength(0)
    // il ripiego resta comunque tracciato, come in ogni altro mese
    expect(await righeConEsito('anno-scolastico-da-data-documento')).toHaveLength(1)
  })

  it('col periodo di competenza dichiarato non c’è nessuna ambiguità, nemmeno in agosto', async () => {
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
    expect(await righeConEsito('anno-scolastico-ambiguo')).toHaveLength(0)
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
