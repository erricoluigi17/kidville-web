import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  supabase: null as unknown,
  enqueue: vi.fn(),
}))

vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaGetByFilename: vi.fn() }
})
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.supabase }))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'
import { arubaSignin, arubaGetByFilename } from '@/lib/aruba/client'
import { aggregaFatturaStato } from '@/lib/aruba/stato'

const SCUOLA = '11111111-1111-1111-1111-111111111111'

// Fake supabase "thenable": ogni catena risolve a { data, error } per tabella.
function makeSupabase(byTable: Record<string, unknown>) {
  const updates: { table: string; row: unknown }[] = []
  const uploads: { path: string }[] = []
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'not', 'limit', 'order', 'gte', 'lte']) b[m] = chain
    b.single = async () => ({ data: arr(byTable[table])[0] ?? null, error: null })
    b.maybeSingle = async () => ({ data: byTable[table] ?? null, error: null })
    b.update = (row: unknown) => ({ eq: async () => { updates.push({ table, row }); return { error: null } } })
    b.then = (resolve: (v: unknown) => void) => resolve({ data: byTable[table] ?? [], error: null })
    return b
  }
  function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : v == null ? [] : [v]
  }
  return {
    from: (t: string) => builder(t),
    storage: { from: () => ({ upload: async (path: string) => { uploads.push({ path }); return {} } }) },
    _updates: updates,
    _uploads: uploads,
  } as never
}

function req(secret?: string) {
  return new Request('http://localhost/api/pagamenti/fattura/sync', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('POST /api/pagamenti/fattura/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
  })

  it('rifiuta senza x-cron-secret valido (401)', async () => {
    h.supabase = makeSupabase({})
    const res = await POST(req('sbagliato'))
    expect(res.status).toBe(401)
  })

  it('su scarto SDI aggiorna lo stato e notifica la Segreteria', async () => {
    h.supabase = makeSupabase({
      fatture_emesse: [
        { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
      ],
      admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
      utenti: [{ id: 'seg-1' }, { id: 'dir-1' }],
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 4 }) // 4 = Scartata (NS)

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.scartate).toBe(1)

    // fatture_emesse aggiornata a scartata
    const fUpd = (h.supabase as { _updates: { table: string; row: { sdi_stato: number } }[] })._updates.find(
      (u) => u.table === 'fatture_emesse'
    )
    expect(fUpd!.row.sdi_stato).toBe(4)
    // pagamento → scartata
    const pUpd = (h.supabase as { _updates: { table: string; row: { fattura_stato: string } }[] })._updates.find(
      (u) => u.table === 'pagamenti'
    )
    expect(pUpd!.row.fattura_stato).toBe('scartata')
    // notifica accodata alla Segreteria (entrambi gli utenti)
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    const params = h.enqueue.mock.calls[0][1]
    expect(params.utenteIds).toEqual(['seg-1', 'dir-1'])
    expect(params.tipo).toBe('fattura_scartata')
  })

  it('stato consegnato con PDF → copia di cortesia PER-RIGA e pagamento emesso', async () => {
    h.supabase = makeSupabase({
      fatture_emesse: [
        { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
      ],
      admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 7, pdfBase64: Buffer.from('PDF').toString('base64') }) // 7 = Consegnata

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    const sb = h.supabase as { _updates: { table: string; row: Record<string, unknown> }[]; _uploads: { path: string }[] }
    // PDF caricato con chiave PER-RIGA ${pagamento}-${numero}.pdf (non ${pagamento}.pdf)
    expect(sb._uploads[0].path).toBe('pag-1-7.pdf')
    const fUpd = sb._updates.find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.pdf_path).toBe('pag-1-7.pdf')
    // pagamento aggregato → emessa, con fattura_pdf_path (fattura singola)
    const pUpd = sb._updates.find((u) => u.table === 'pagamenti')!
    expect(pUpd.row.fattura_stato).toBe('emessa')
    expect(pUpd.row.fattura_pdf_path).toBe('pag-1-7.pdf')
  })
})

describe('aggregaFatturaStato (matrice quote)', () => {
  it('nessuna riga → in_attesa', () => {
    expect(aggregaFatturaStato([])).toBe('in_attesa')
  })
  it('uno scarto domina → scartata', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 7, numero: 1, quota_adult_id: 'a' },
      { sdi_stato: 4, numero: 2, quota_adult_id: 'b' },
    ])).toBe('scartata')
  })
  it('tutte consegnate/accettate → emessa', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 7, numero: 1, quota_adult_id: 'a' },
      { sdi_stato: 8, numero: 2, quota_adult_id: 'b' },
    ])).toBe('emessa')
  })
  it('una in volo → in_attesa', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 7, numero: 1, quota_adult_id: 'a' },
      { sdi_stato: 3, numero: 2, quota_adult_id: 'b' },
    ])).toBe('in_attesa')
  })
  it('quota scartata poi RI-emessa (numero maggiore) non blocca l\'aggregato', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 4, numero: 1, quota_adult_id: 'a' }, // vecchia scartata
      { sdi_stato: 7, numero: 5, quota_adult_id: 'a' }, // ri-emissione consegnata
    ])).toBe('emessa')
  })
})
