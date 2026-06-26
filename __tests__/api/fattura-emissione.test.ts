import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub delle chiamate di rete Aruba (mantengo reali resolveArubaCredentials/arubaBaseUrls).
vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaUpload: vi.fn() }
})

import { emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { arubaSignin, arubaUpload } from '@/lib/aruba/client'

const SCUOLA = '11111111-1111-1111-1111-111111111111'

function makeSupabase(responses: Record<string, unknown> & { rpc?: number }) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
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
        update: (row: unknown) => ({
          eq: async () => {
            updates.push({ table, row })
            return { error: null }
          },
        }),
      }
      return builder
    },
    rpc: async () => ({ data: responses.rpc ?? 1, error: null }),
    _inserts: inserts,
    _updates: updates,
  }
  return api
}

const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scuola_id: SCUOLA,
  fattura_causale: null,
  alunno_id: 'al-1',
  alunni: {
    nome: 'Mario',
    cognome: 'Rossi',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}
const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
    fiscal: { piva: '12345678903', ragione_sociale: 'Kidville Srl', regime: 'RF01', indirizzo: 'Via Roma 1', cap: '00100', comune: 'Roma', provincia: 'RM' },
  },
  fattura_causale_template: '{descrizione}',
}
const parent = {
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via Milano 9',
  residence_city: 'Roma',
  zip_code: '00185',
}

describe('emettiFatturaPagamento', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.ARUBA_PASSWORD
  })

  it('rifiuta un pagamento non saldato (400) senza chiamare Aruba', async () => {
    const sb = makeSupabase({ pagamenti: { ...pagamentoSaldato, stato: 'in_attesa' } })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_saldato')
      expect(esito.httpStatus).toBe(400)
    }
    expect(arubaUpload).not.toHaveBeenCalled()
  })

  it('Aruba non abilitato / credenziali assenti → non_configurato (503)', async () => {
    delete process.env.ARUBA_PASSWORD
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig })
    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_configurato')
      expect(esito.httpStatus).toBe(503)
    }
  })

  it('happy path: genera XML, fa upload base64, persiste e mette il pagamento in_attesa', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: true, uploadFileName: 'IT12345678903_a1b2.xml.p7m', errorCode: '0000' })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 7 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.numero).toBe(7)
      expect(esito.uploadFileName).toBe('IT12345678903_a1b2.xml.p7m')
    }

    // upload chiamato con dataFile base64 e P.IVA mittente
    const uploadArgs = vi.mocked(arubaUpload).mock.calls[0]
    const dataFile = (uploadArgs[2] as { dataFileBase64: string }).dataFileBase64
    const decoded = Buffer.from(dataFile, 'base64').toString('utf-8')
    expect(decoded).toContain('<FormatoTrasmissione>FPR12</FormatoTrasmissione>')
    expect(decoded).toContain('<Natura>N4</Natura>')

    // persistenza: riga fatture_emesse + pagamento in_attesa con aruba_filename
    const fattura = sb._inserts.find((i: { table: string }) => i.table === 'fatture_emesse')
    expect(fattura).toBeTruthy()
    expect((fattura!.row as { aruba_filename: string }).aruba_filename).toBe('IT12345678903_a1b2.xml.p7m')
    const pagUpd = sb._updates.find((u: { table: string }) => u.table === 'pagamenti')
    expect((pagUpd!.row as { fattura_stato: string }).fattura_stato).toBe('in_attesa')
    expect((pagUpd!.row as { fattura_aruba_id: string }).fattura_aruba_id).toBe('IT12345678903_a1b2.xml.p7m')
  })

  it('upload scartato da Aruba (errorCode != 0000) → scartata (502) e pagamento scartata', async () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaUpload).mockResolvedValue({ ok: false, errorCode: '0094', errorDescription: 'IdTrasmittente non valido' })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 8 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('scartata')
      expect(esito.httpStatus).toBe(502)
    }
    const pagUpd = sb._updates.find((u: { table: string }) => u.table === 'pagamenti')
    expect((pagUpd!.row as { fattura_stato: string }).fattura_stato).toBe('scartata')
  })
})
