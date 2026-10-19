import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { arubaUltimiNumeriFattura, PAGINA_SIZE, PAUSA_FRA_PAGINE_MS } from '@/lib/aruba/client'
import { NUMERI_FUORI_SERIE, numeroFuoriSerie } from '@/lib/fatturazione/numeri-fuori-serie'

/**
 * «ASILO 2826/2026»: UN DOCUMENTO FUORI APP CHE NON DEVE PIÙ SPOSTARE LA SERIE.
 *
 * Il 16/10/2026 sul pannello Aruba è nata «Asilo 2826/2026» con il numero della serie FPR,
 * mentre Asilo era a 2775. Il tetto sul pavimento (50) l'ha fermata per un numero, e da lì
 * ogni fattura Asilo dell'app è rimasta ferma. Il titolare l'ha stornata con nota di
 * credito: la serie deve riprendere da 2776, e il 2826 — che su Aruba c'è — va SCAVALCATO
 * quando il contatore ci arriva, mai riusato.
 *
 * Due prove, una per metà: il pavimento (client) e l'allocazione (emissione).
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'

describe('numeroFuoriSerie', () => {
  it('riconosce solo la terna esatta: serie, anno e numero', () => {
    expect(numeroFuoriSerie('Asilo', 2026, 2826)).toBe(true)
    // Stesso numero, altra serie: FPR 2826 è una fattura dell'app, viva e regolare.
    expect(numeroFuoriSerie('FPR', 2026, 2826)).toBe(false)
    // Stessa serie, altro anno: la serie riparte, e il 2826 del 2027 sarà un numero normale.
    expect(numeroFuoriSerie('Asilo', 2027, 2826)).toBe(false)
    expect(numeroFuoriSerie('Asilo', 2026, 2825)).toBe(false)
  })

  it("ogni voce dell'elenco dice perché è lì", () => {
    for (const v of NUMERI_FUORI_SERIE) expect(v.motivo.length).toBeGreaterThan(40)
  })
})

/** Una pagina di `findByUsername` nella forma misurata: documenti con `invoices` annidato. */
function pagina(numeri: string[]): Response {
  const content = numeri.map((n) => ({
    filename: 'IT00000000000_00000.xml.p7m',
    invoices: [{ number: n, status: 'DELIVERED' }],
  }))
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content, size: PAGINA_SIZE, numberOfElements: numeri.length }),
  } as Response
}

describe('il pavimento letto da Aruba ignora i numeri fuori serie', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('con «Asilo 2826/2026» nell\'elenco il massimo di Asilo resta 2775; FPR non cambia', async () => {
    fetchMock.mockResolvedValueOnce(
      pagina(['Asilo 2774/2026', 'Asilo 2775/2026', 'Asilo 2826/2026', 'FPR 2826/26', 'FPR 2829/26']),
    )
    const lavoro = arubaUltimiNumeriFattura('demo', 'AT', {
      username: 'utente@scuola.it',
      anno: 2026,
      sezionali: ['Asilo', 'FPR'],
    })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS * 5)
    const massimi = await lavoro

    expect(massimi.get('Asilo')).toBe(2775)
    expect(massimi.get('FPR')).toBe(2829)
  })

  it('un 2826 di Asilo nel 2025 conta ancora: l\'eccezione vale per un anno solo', async () => {
    // Serie Asilo vuota nel 2026 ⇒ si guarda il 2025, dove un «2826» è un numero normale.
    fetchMock
      .mockResolvedValueOnce(pagina(['FPR 10/26']))
      .mockResolvedValueOnce(pagina(['Asilo 2826/2025']))
    const lavoro = arubaUltimiNumeriFattura('demo', 'AT', {
      username: 'utente@scuola.it',
      anno: 2026,
      sezionali: ['Asilo'],
    })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS * 5)
    expect((await lavoro).get('Asilo')).toBe(2826)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * L'allocazione: quando il contatore arriva a 2825, il prossimo è 2827.
 * ──────────────────────────────────────────────────────────────────────────── */

let righeLog: Record<string, unknown>[] = []

async function carica(finto: Record<string, unknown>) {
  righeLog = []
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({
    appLog: vi.fn(async (riga: Record<string, unknown>) => {
      righeLog.push(riga)
    }),
  }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

/**
 * Supabase finto con un CONTATORE vero: la RPC fa `GREATEST(contatore, p_min) + 1` come
 * quella di produzione. Un finto che restituisce sempre lo stesso numero sarebbe verde con
 * lo scavalco e senza.
 */
function makeSupabase(responses: Record<string, unknown>, contatoreIniziale: number) {
  let contatore = contatoreIniziale
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async (_nome: string, args: { p_min?: number }) => {
    contatore = Math.max(contatore, args.p_min ?? 0) + 1
    return { data: contatore, error: null }
  })
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () => ({
          data: table === 'fatture_numerazione_sezionale' ? { ultimo_numero: contatore } : (responses[table] ?? null),
          error: null,
        }),
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        then: (ok: (v: unknown) => void) => ok({ data: [], error: null }),
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _rpc: rpc,
  }
}

const pagamentoNido = {
  id: 'pag-1',
  descrizione: 'Retta di Ottobre',
  importo: 300,
  stato: 'pagato',
  scadenza: '2026-10-10',
  periodo_competenza: '2026-10-01',
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
    // Dato SINTETICO: un bambino che compie 3 anni DOPO il 30 aprile 2027 ⇒ serie Asilo.
    data_nascita: '2025-01-15',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
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

/** Intestatario SINTETICO: nessun dato di famiglie vere nei test. */
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

describe("l'allocazione scavalca il numero fuori serie", () => {
  beforeEach(() => {
    vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
    vi.stubEnv('VITEST', '')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'))
  })
  afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log')
    vi.doUnmock('@/lib/aruba/client')
    vi.unstubAllEnvs()
    vi.useRealTimers()
    vi.resetModules()
  })

  async function emetti(contatore: number, pavimento: number) {
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT01879020517_abcde.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => pavimento),
      arubaUpload: upload,
    })
    const sb = makeSupabase(
      { pagamenti: pagamentoNido, admin_settings: settingsConfig, parents: parentCompleto },
      contatore,
    )
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    return { esito, sb, upload }
  }

  it('contatore a 2825: il numero assegnato è 2827, non 2826', async () => {
    const { esito, sb } = await emetti(2825, 2825)
    expect(esito.ok).toBe(true)
    // Due chiamate: la prima propone il 2826, che è occupato; la seconda dà il 2827.
    expect(sb._rpc).toHaveBeenCalledTimes(2)
    expect(sb._rpc.mock.calls[1][1]).toMatchObject({ p_sezionale: 'Asilo', p_min: 2826 })
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')?.row as { numero?: number } | undefined
    expect(riga?.numero).toBe(2827)
    const scavalco = righeLog.find(
      (r) => (r.contestoExtra as { campi?: { esito?: string } } | undefined)?.campi?.esito === 'numero-fuori-serie-scavalcato',
    )
    expect(scavalco).toBeDefined()
  })

  it('contatore a 2775: il numero è 2776 e la RPC si chiama una volta sola', async () => {
    const { esito, sb } = await emetti(2775, 2775)
    expect(esito.ok).toBe(true)
    expect(sb._rpc).toHaveBeenCalledTimes(1)
    const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')?.row as { numero?: number } | undefined
    expect(riga?.numero).toBe(2776)
  })
})
