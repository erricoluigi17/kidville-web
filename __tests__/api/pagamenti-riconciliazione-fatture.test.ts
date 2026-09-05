import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LO STATO DELLA FATTURA SULLE RIGHE DEL REGISTRO — e il mock che non è piatto.
 *
 * Il finto di `pagamenti-riconciliazione.test.ts` risponde `[]` a ogni tabella che non
 * conosce: con quello, un GET che non legge affatto `fatture_emesse` resterebbe VERDE e
 * direbbe «da fatturare» su ogni riga — cioè la risposta sbagliata, con l'aria di quella
 * giusta. Qui il finto distingue per TABELLA, registra le colonne chieste e i valori
 * dell'`.in()`, conta le chiamate, e su una tabella non prevista restituisce un errore
 * rumoroso invece di un elenco vuoto.
 */
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  movimenti: [] as Record<string, unknown>[],
  sedi: [] as Record<string, unknown>[],
  sediError: null as { code?: string; message?: string } | null,
  fatture: [] as Record<string, unknown>[],
  fattureError: null as { code?: string; message?: string } | null,
  from: [] as string[],
  fattureCols: [] as string[],
  fattureIn: [] as { colonna: string; valori: unknown[] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      h.from.push(table)
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => {
        if (table === 'fatture_emesse') h.fattureCols.push(cols ?? '')
        return b
      }
      b.eq = () => b
      b.in = (colonna: string, valori: unknown[]) => {
        if (table === 'fatture_emesse') h.fattureIn.push({ colonna, valori })
        return b
      }
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.limit = () => b
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'riconciliazione_movimenti') return resolve({ data: h.movimenti, error: null })
        if (table === 'pagamenti') return resolve({ data: h.sediError ? null : h.sedi, error: h.sediError })
        if (table === 'fatture_emesse') return resolve({ data: h.fattureError ? null : h.fatture, error: h.fattureError })
        // Tabella non pilotata dal test: è un difetto DEL TEST, e deve vedersi.
        return resolve({ data: null, error: { code: 'TEST', message: `tabella non pilotata: ${table}` } })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/riconciliazione/route'

const M1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const M2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'
const M3 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3'
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const P3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const QA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const QB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/pagamenti/riconciliazione${qs}`) as never)

/** Quante volte è stata interrogata la tabella delle fatture in questa richiesta. */
const letturaFatture = () => h.from.filter((t) => t === 'fatture_emesse').length

interface RigaConFattura {
  id: string
  pagamento_id?: string | null
  fattura?: { stato: string; numeri: string[] } | null
}

beforeEach(() => {
  vi.clearAllMocks()
  h.movimenti = []
  h.sedi = []
  h.sediError = null
  h.fatture = []
  h.fattureError = null
  h.from = []
  h.fattureCols = []
  h.fattureIn = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('GET /api/pagamenti/riconciliazione — stato della fattura sulle righe abbinate', () => {
  it('riga abbinata con fattura viva → stato «emessa» e il numero completo di sezionale', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [{ pagamento_id: P1, numero: 1947, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: null }]

    const res = await get()
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 1947/26'] })
  })

  it('fattura non ancora tornata dallo SDI (sdi_stato null) → resta «emessa»: il numero è già bruciato', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [{ pagamento_id: P1, numero: 2328, anno: 2026, sezionale: 'Asilo', sdi_stato: null, quota_adult_id: null }]

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['Asilo 2328/2026'] })
  })

  it('riga storica senza sezionale → «numero/anno», senza far lanciare formattaNumeroFattura', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [{ pagamento_id: P1, numero: 12, anno: 2025, sezionale: null, sdi_stato: 7, quota_adult_id: null }]

    const res = await get()
    expect(res.status).toBe(200) // un throw qui diventerebbe un 500 sull'intera lista
    const j = (await res.json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['12/2025'] })
  })

  it('pagamento ripartito su due quote → un numero per quota, in ordine di numero', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [
      { pagamento_id: P1, numero: 12, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: QB },
      { pagamento_id: P1, numero: 7, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: QA },
    ]

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 7/26', 'FPR 12/26'] })
  })

  it('stessa quota riemessa → un numero solo, il massimo (mai due righe per la stessa quota)', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [
      { pagamento_id: P1, numero: 5, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: QA },
      { pagamento_id: P1, numero: 9, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: QA },
    ]

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 9/26'] })
  })

  it('quota scartata e poi RIEMESSA → «emessa» col numero nuovo (lo scarto non blocca)', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [
      { pagamento_id: P1, numero: 5, anno: 2026, sezionale: 'FPR', sdi_stato: 4, quota_adult_id: QA },
      { pagamento_id: P1, numero: 9, anno: 2026, sezionale: 'FPR', sdi_stato: 8, quota_adult_id: QA },
    ]

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 9/26'] })
  })

  it('solo righe scartate (2/4/9) → «scartata», e nessun numero: un documento scartato non esiste', async () => {
    h.movimenti = [
      { id: M1, stato: 'confermato', pagamento_id: P1 },
      { id: M2, stato: 'confermato', pagamento_id: P2 },
      { id: M3, stato: 'confermato', pagamento_id: P3 },
    ]
    h.fatture = [
      { pagamento_id: P1, numero: 5, anno: 2026, sezionale: 'FPR', sdi_stato: 2, quota_adult_id: null },
      { pagamento_id: P2, numero: 6, anno: 2026, sezionale: 'FPR', sdi_stato: 4, quota_adult_id: null },
      { pagamento_id: P3, numero: 7, anno: 2026, sezionale: 'FPR', sdi_stato: 9, quota_adult_id: null },
    ]

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data.map((r) => r.fattura)).toEqual([
      { stato: 'scartata', numeri: [] },
      { stato: 'scartata', numeri: [] },
      { stato: 'scartata', numeri: [] },
    ])
  })

  it('nessuna riga in fatture_emesse per quel pagamento → «da_fatturare»', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fatture = [{ pagamento_id: P2, numero: 3, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: null }]

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'da_fatturare', numeri: [] })
  })

  it('UNA sola lettura di fatture_emesse per pagina, con tutti i pagamenti abbinati in un .in()', async () => {
    h.movimenti = [
      { id: M1, stato: 'confermato', pagamento_id: P1 },
      { id: M2, stato: 'confermato', pagamento_id: P2 },
      { id: M3, stato: 'confermato', pagamento_id: P1 }, // stesso pagamento: non si chiede due volte
      { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', stato: 'da_abbinare', pagamento_id: null },
    ]
    h.fatture = [{ pagamento_id: P1, numero: 1, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: null }]

    await get()
    expect(letturaFatture()).toBe(1)
    expect(h.fattureIn).toHaveLength(1)
    expect(h.fattureIn[0].colonna).toBe('pagamento_id')
    expect([...(h.fattureIn[0].valori as string[])].sort()).toEqual([P1, P2])
    // le colonne chieste sono solo quelle che servono al chip (nessun intestatario, nessun XML)
    expect(h.fattureCols[0]).toContain('pagamento_id')
    expect(h.fattureCols[0]).toContain('sezionale')
    expect(h.fattureCols[0]).toContain('sdi_stato')
    expect(h.fattureCols[0]).toContain('quota_adult_id')
    expect(h.fattureCols[0]).not.toContain('intestatario')
  })

  it('nessuna riga abbinata → fatture_emesse non viene interrogata affatto', async () => {
    h.movimenti = [
      { id: M1, stato: 'da_abbinare', pagamento_id: null },
      { id: M2, stato: 'suggerito' },
    ]

    const res = await get()
    expect(res.status).toBe(200)
    expect(letturaFatture()).toBe(0)
  })

  it('le righe NON abbinate non portano il campo fattura (assente ≠ «da fatturare»)', async () => {
    h.movimenti = [
      { id: M1, stato: 'confermato', pagamento_id: P1 },
      { id: M2, stato: 'da_abbinare', pagamento_id: null },
    ]
    h.fatture = []

    const j = (await (await get()).json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toEqual({ stato: 'da_fatturare', numeri: [] })
    expect('fattura' in j.data[1]).toBe(false)
  })

  it('lettura di fatture_emesse fallita → fattura null («non lo so»), 200, e un warn coi soli conteggi', async () => {
    h.movimenti = [
      { id: M1, stato: 'confermato', pagamento_id: P1 },
      { id: M2, stato: 'da_abbinare', pagamento_id: null },
    ]
    h.fattureError = { code: '08006', message: 'connection failure' }

    const res = await get()
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toBeNull()
    expect('fattura' in j.data[1]).toBe(false)

    const chiamata = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'fatture_movimenti_non_risolte')
    expect(chiamata, 'il degrado deve lasciare un log: senza, «nessun chip» non si distingue da «nessuna fattura»').toBeTruthy()
    expect(chiamata![1]).toBe('warn')
    const campi = chiamata![2] as Record<string, unknown>
    expect(campi.operazione).toBe('pagamenti/riconciliazione:GET')
    expect(campi.n).toBe(1)
    // nessun dato personale nei campi loggati: solo operazione, esito e conteggi
    expect(Object.keys(campi).sort()).toEqual(['esito', 'n', 'operazione'])
  })

  it('DB CI non migrato (42703 / PGRST204) → livello info con esito «schema assente», non un warn', async () => {
    h.movimenti = [{ id: M1, stato: 'confermato', pagamento_id: P1 }]
    h.fattureError = { code: '42703', message: 'column fatture_emesse.sezionale does not exist' }

    const res = await get()
    expect(res.status).toBe(200)
    const j = (await res.json()) as { data: RigaConFattura[] }
    expect(j.data[0].fattura).toBeNull()

    const chiamata = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'fatture_movimenti_schema_assente')
    expect(chiamata).toBeTruthy()
    expect(chiamata![1]).toBe('info')
    expect(h.logEvento.mock.calls.some((c) => (c[2] as { esito?: string })?.esito === 'fatture_movimenti_non_risolte')).toBe(false)
  })

  it('l’arricchimento avviene ANCHE nel ramo dei suggerimenti, e la minimizzazione cross-sede resta', async () => {
    h.movimenti = [{
      id: M1, stato: 'confermato', pagamento_id: P1,
      suggerimenti: [
        { pagamento_id: 'pay-own', score: 80, label: 'Etichetta di sede propria' },
        { pagamento_id: 'pay-other', score: 80, label: 'Etichetta di altra sede' },
      ],
    }]
    h.sedi = [{ id: 'pay-own', scuola_id: 'sc-1' }, { id: 'pay-other', scuola_id: 'sc-99' }]
    h.fatture = [{ pagamento_id: P1, numero: 1947, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: null }]

    const j = (await (await get()).json()) as { data: (RigaConFattura & { suggerimenti: { pagamento_id: string }[] })[] }
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 1947/26'] })
    expect(j.data[0].suggerimenti).toHaveLength(1)
    expect(j.data[0].suggerimenti[0].pagamento_id).toBe('pay-own')
  })

  it('l’arricchimento sopravvive al degrado prudente dei suggerimenti (query sedi fallita)', async () => {
    h.movimenti = [{
      id: M1, stato: 'confermato', pagamento_id: P1,
      suggerimenti: [{ pagamento_id: 'pay-own', score: 80, label: 'Etichetta di sede propria' }],
    }]
    h.sediError = { code: 'XX', message: 'boom' }
    h.fatture = [{ pagamento_id: P1, numero: 1947, anno: 2026, sezionale: 'FPR', sdi_stato: 7, quota_adult_id: null }]

    const j = (await (await get()).json()) as { data: (RigaConFattura & { suggerimenti: { label: string | null }[] })[] }
    expect(j.data[0].suggerimenti[0].label).toBeNull()
    expect(j.data[0].fattura).toEqual({ stato: 'emessa', numeri: ['FPR 1947/26'] })
  })
})
