import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaUpload: vi.fn(), arubaUltimoNumeroFattura: vi.fn() }
})

import { emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { arubaSignin, arubaUpload, arubaUltimoNumeroFattura } from '@/lib/aruba/client'
import { ripartisci, determinaQuoteFatturazione } from '@/lib/pagamenti/intestatari'

const SCUOLA = '11111111-1111-1111-1111-111111111111'

interface Cfg {
  pagamento: unknown
  settings: unknown
  quote?: { adult_id: string; importo: number | string; etichetta: string | null }[]
  ordine?: { parent_id: string } | null
  esistenti?: Record<string, unknown>[]
  tutori?: { genitore_id: string }[]
  parentsByAuth?: Record<string, unknown>
  parentsById?: Record<string, unknown>
}

function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
  let rpc = 100
  const api = {
    from(table: string) {
      let eqCol: string | null = null
      let eqVal: string | null = null
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: string) => { eqCol = c; eqVal = v; return builder },
        in: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () => ({ data: table === 'pagamenti' ? cfg.pagamento : null, error: null }),
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: cfg.settings, error: null }
          if (table === 'divise_ordini') return { data: cfg.ordine ?? null, error: null }
          if (table === 'parents') {
            const map = eqCol === 'id' ? cfg.parentsById ?? {} : cfg.parentsByAuth ?? {}
            return { data: (eqVal && map[eqVal]) ?? null, error: null }
          }
          return { data: null, error: null }
        },
        insert: async (row: unknown) => { inserts.push({ table, row }); return { error: null } },
        update: (row: unknown) => ({ eq: async () => { updates.push({ table, row }); return { error: null } } }),
        then: (resolve: (v: unknown) => unknown) => {
          const data =
            table === 'pagamenti_quote' ? cfg.quote ?? [] :
            table === 'fatture_emesse' ? cfg.esistenti ?? [] :
            table === 'legame_genitori_alunni' ? cfg.tutori ?? [] : []
          return resolve({ data, error: null })
        },
      }
      return builder
    },
    rpc: async () => ({ data: rpc++, error: null }),
    _inserts: inserts,
    _updates: updates,
    get _rpcNext() { return rpc },
  }
  return api
}

// Nessun `fiscale_config` qui: il cedente arriva dal RIPIEGO `aruba_config.fiscal`,
// che è la configurazione delle sedi non ancora aggiornate. È completo, quindi la
// fattura parte — ed è il caso che tiene onesto il ripiego.
const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo',
    fiscal: { piva: '12345678903', ragione_sociale: 'Kidville Srl', regime: 'RF01', indirizzo: 'Via Roma 1', cap: '00100', comune: 'Roma', provincia: 'RM' },
  },
}
const reg = (first: string, cf: string | null) => ({
  id: `reg-${first}`, first_name: first, last_name: 'Rossi', fiscal_code: cf,
  residence_address: 'Via Milano 9', residence_city: 'Roma', zip_code: '00185',
})
const pagamentoSeparati = {
  id: 'pag-1', descrizione: 'Retta di Marzo', importo: 150, stato: 'pagato', scuola_id: SCUOLA,
  scadenza: '2026-03-10', periodo_competenza: '2026-03-01', categoria_id: null,
  fattura_causale: null, alunno_id: 'al-1', payment_categories: null,
  // La data di nascita decide la SERIE FISCALE: senza, l'emissione si blocca
  // prima ancora di guardare le quote. Dato sintetico, repository pubblico.
  alunni: {
    id: 'al-1', nome: 'Mario', cognome: 'Rossi', codice_fiscale: null, data_nascita: '2019-03-15',
    genitori_separati: true, retta_split_config: null, intestatario_fatture: { tipo: 'adult', adult_id: 'parent-x' },
  },
}

describe('ripartisci (arrotondamento, resto alla prima quota)', () => {
  it('50/50 su 150 → 75 / 75', () => {
    const r = ripartisci([{ adultId: 'a', peso: 1, label: 'M' }, { adultId: 'b', peso: 1, label: 'P' }], 150)
    expect(r.map((q) => q.importo)).toEqual([75, 75])
  })
  it('tre quote uguali su 100 → 33.34 / 33.33 / 33.33 (somma esatta)', () => {
    const r = ripartisci([{ adultId: 'a', peso: 1, label: '' }, { adultId: 'b', peso: 1, label: '' }, { adultId: 'c', peso: 1, label: '' }], 100)
    expect(r.map((q) => q.importo)).toEqual([33.34, 33.33, 33.33])
    expect(r.reduce((s, q) => s + q.importo, 0)).toBeCloseTo(100, 5)
  })
})

describe('determinaQuoteFatturazione (priorità)', () => {
  it('eccezione ordine divise → quota unica all\'ordinante', async () => {
    const sb = makeSupabase({ pagamento: pagamentoSeparati, settings: settingsConfig, ordine: { parent_id: 'u-ordinante' } })
    const quote = await determinaQuoteFatturazione(sb as never, { id: 'pag-1', importo: 150 }, { id: 'al-1', genitori_separati: true, intestatario_fatture: { adult_id: 'parent-x' } })
    expect(quote).toEqual([{ adultId: 'u-ordinante', importo: 150, label: 'Divise' }])
  })
  it('separati con pagamenti_quote → usa le quote esplicite', async () => {
    const sb = makeSupabase({ pagamento: pagamentoSeparati, settings: settingsConfig, quote: [{ adult_id: 'u-mamma', importo: 90, etichetta: 'Mamma' }, { adult_id: 'u-papa', importo: 60, etichetta: 'Papà' }] })
    const quote = await determinaQuoteFatturazione(sb as never, { id: 'pag-1', importo: 150 }, { id: 'al-1', genitori_separati: true, intestatario_fatture: { adult_id: 'parent-x' } })
    expect(quote).toEqual([{ adultId: 'u-mamma', importo: 90, label: 'Mamma' }, { adultId: 'u-papa', importo: 60, label: 'Papà' }])
  })
})

describe('emettiFatturaPagamento — multi-quota', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ARUBA_PASSWORD = 'segretissima'
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    // Il progressivo si rilegge da Aruba PRIMA DI OGNI quota, e la lettura è
    // bloccante: senza questo mock nessuna delle emissioni qui sotto partirebbe.
    vi.mocked(arubaUltimoNumeroFattura).mockResolvedValue(0)
    vi.mocked(arubaUpload).mockImplementation(async (_amb, _tok, args) =>
      ({ ok: true, uploadFileName: `F_${(args as { dataFileBase64: string }).dataFileBase64.slice(0, 6)}.xml`, errorCode: '0000' }))
  })
  afterEach(() => { delete process.env.ARUBA_PASSWORD })

  it('2 quote → 2 fatture_emesse + 2 numeri distinti + pagamento in_attesa', async () => {
    const sb = makeSupabase({
      pagamento: pagamentoSeparati, settings: settingsConfig,
      quote: [{ adult_id: 'u-mamma', importo: 75, etichetta: 'Mamma' }, { adult_id: 'u-papa', importo: 75, etichetta: 'Papà' }],
      parentsByAuth: { 'u-mamma': reg('Giulia', 'FRNGLI80A41H501Z'), 'u-papa': reg('Marco', 'RSSMRC80A01H501A') },
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const fatture = sb._inserts.filter((i) => i.table === 'fatture_emesse')
    expect(fatture).toHaveLength(2)
    const numeri = fatture.map((f) => (f.row as { numero: number }).numero)
    expect(new Set(numeri).size).toBe(2)
    expect((fatture[0].row as { quota_adult_id: string; importo: number }).quota_adult_id).toBe('u-mamma')
    expect((fatture[0].row as { importo: number }).importo).toBe(75)
    expect((fatture[0].row as { causale: string }).causale).toContain('quota Mamma')
    expect(vi.mocked(arubaUpload)).toHaveBeenCalledTimes(2)
    const pagUpd = sb._updates.find((u) => u.table === 'pagamenti')
    expect((pagUpd!.row as { fattura_stato: string }).fattura_stato).toBe('in_attesa')
    if (esito.ok) expect(esito.quote).toHaveLength(2)
  })

  it('CF mancante su un genitore → una emessa + errore esplicito, l\'altra parte', async () => {
    const sb = makeSupabase({
      pagamento: pagamentoSeparati, settings: settingsConfig,
      quote: [{ adult_id: 'u-mamma', importo: 75, etichetta: 'Mamma' }, { adult_id: 'u-papa', importo: 75, etichetta: 'Papà' }],
      parentsByAuth: { 'u-mamma': reg('Giulia', 'FRNGLI80A41H501Z'), 'u-papa': reg('Marco', null) },
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true) // almeno una emessa
    const fatture = sb._inserts.filter((i) => i.table === 'fatture_emesse')
    expect(fatture).toHaveLength(1)
    expect(vi.mocked(arubaUpload)).toHaveBeenCalledTimes(1)
    if (esito.ok) {
      const papa = esito.quote!.find((q) => q.adultId === 'u-papa')!
      expect(papa.ok).toBe(false)
      expect(papa.motivo).toBe('intestatario_mancante')
      expect(papa.messaggio).toContain('Marco')
    }
  })

  it('re-run idempotente: quote già emesse (non scartate) → nessuna nuova emissione', async () => {
    const sb = makeSupabase({
      pagamento: pagamentoSeparati, settings: settingsConfig,
      quote: [{ adult_id: 'u-mamma', importo: 75, etichetta: 'Mamma' }, { adult_id: 'u-papa', importo: 75, etichetta: 'Papà' }],
      parentsByAuth: { 'u-mamma': reg('Giulia', 'FRNGLI80A41H501Z'), 'u-papa': reg('Marco', 'RSSMRC80A01H501A') },
      esistenti: [
        { id: 'f1', numero: 100, aruba_filename: 'x.xml', sdi_stato: 1, quota_adult_id: 'u-mamma' },
        { id: 'f2', numero: 101, aruba_filename: 'y.xml', sdi_stato: 7, quota_adult_id: 'u-papa' },
      ],
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
    expect(vi.mocked(arubaUpload)).not.toHaveBeenCalled()
    if (esito.ok) expect(esito.quote!.every((q) => q.motivo === 'idempotente')).toBe(true)
  })

  it('la causale della quota NON contiene il trattino lungo: fuori dal tracciato, scarto certo', async () => {
    // `${causaleBase} — quota ${label}` con «—» (U+2014) stava fuori da
    // `[\p{IsBasicLatin}\p{IsLatin-1Supplement}]`: OGNI fattura del ramo
    // multi-quota nasceva formalmente invalida, e nessun test lo diceva perché
    // tutti confrontavano sottostringhe. La validazione XSD l'ha misurato.
    const sb = makeSupabase({
      pagamento: pagamentoSeparati, settings: settingsConfig,
      quote: [{ adult_id: 'u-mamma', importo: 75, etichetta: 'Mamma' }, { adult_id: 'u-papa', importo: 75, etichetta: 'Papà' }],
      parentsByAuth: { 'u-mamma': reg('Giulia', 'FRNGLI80A41H501Z'), 'u-papa': reg('Marco', 'RSSMRC80A01H501A') },
    })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    for (const f of sb._inserts.filter((i) => i.table === 'fatture_emesse')) {
      const causale = (f.row as { causale: string }).causale
      expect(causale, 'trattino lungo nella causale').not.toContain('—')
      expect(causale).toContain(' - quota ')
      // «Papà» ha la à: è Latin-1 Supplement, e il tracciato la accetta. Il
      // controllo è sull'INTERO alfabeto ammesso, non su un carattere solo.
      expect(causale.replace(/[ -~¡-ÿ]/g, ''), 'caratteri fuori tracciato').toBe('')
    }
  })

  it('quota scartata in precedenza → viene RI-emessa (non è bloccante)', async () => {
    const sb = makeSupabase({
      pagamento: pagamentoSeparati, settings: settingsConfig,
      quote: [{ adult_id: 'u-mamma', importo: 150, etichetta: 'Mamma' }],
      parentsByAuth: { 'u-mamma': reg('Giulia', 'FRNGLI80A41H501Z') },
      esistenti: [{ id: 'f1', numero: 50, aruba_filename: null, sdi_stato: 4, quota_adult_id: 'u-mamma' }], // 4 = scartata SDI
    })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(1)
    expect(vi.mocked(arubaUpload)).toHaveBeenCalledTimes(1)
  })
})
