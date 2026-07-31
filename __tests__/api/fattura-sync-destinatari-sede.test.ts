import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// FATTURA SCARTATA DALLO SDI — l'avviso si perde UNA VOLTA SOLA.
//
// Audit 2026-07-31 (F6, R85). Sul ramo di scarto la route cercava chi avvisare
// con `from('utenti').eq('scuola_id', f.scuola_id)`: per una fattura di una sede
// aperta il 2026-07-29 quella query torna zero righe, `enqueueNotifiche` esce
// muto (`if (utenti.length === 0) return`, enqueue.ts:42) e il battito chiude
// con `esito: 'ok', scartate: 1`.
//
// Qui la particolarità che alza la posta: lo stato terminale della fattura viene
// scritto PRIMA della notifica, quindi la fattura esce da `STATI_IN_VOLO` e il
// giro successivo NON la ripesca. L'avviso non si ripete mai più — perciò il
// ramo a zero destinatari è `error`, non `warn`.
// =============================================================================

const logEvento = vi.fn()
const enqueueNotifiche = vi.fn()

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => enqueueNotifiche(...a) }))
vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaGetByFilename: vi.fn() }
})

const stato = vi.hoisted(() => ({ db: {} as DBFinto }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(stato.db),
}))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'
import { arubaSignin, arubaGetByFilename } from '@/lib/aruba/client'

/** La fattura è della sede B: lì lo staff esiste SOLO attraverso il ponte. */
function dbBase(): DBFinto {
  return {
    fatture_emesse: [{
      id: 'f-1', pagamento_id: 'pag-1', scuola_id: SEDE_B, numero: 7,
      aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1, pdf_path: null,
    }],
    pagamenti: [{ id: 'pag-1', scuola_id: SEDE_B, fattura_stato: 'in_attesa' }],
    admin_settings: [{
      scuola_id: SEDE_B,
      aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' },
    }],
    utenti: [
      { id: 'segr-a', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
      { id: 'admin-x', ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    ],
    utenti_scuole: [{ utente_id: 'admin-x', scuola_id: SEDE_B }],
  }
}

const req = () =>
  new Request('http://localhost/api/pagamenti/fattura/sync', {
    method: 'POST',
    headers: { 'x-cron-secret': 'topsecret' },
  })

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'topsecret'
  process.env.ARUBA_PASSWORD = 'non-un-segreto-vero'
  stato.db = dbBase()
  vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
  vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 4 }) // 4 = Scartata (NS)
})
afterEach(() => {
  delete process.env.CRON_SECRET
  delete process.env.ARUBA_PASSWORD
})

describe('POST /api/pagamenti/fattura/sync — destinatari dello scarto', () => {
  it('avvisa lo staff che copre la sede DAL PONTE (prima: nessuno)', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data.scartate).toBe(1)

    expect(enqueueNotifiche).toHaveBeenCalledTimes(1)
    const args = enqueueNotifiche.mock.calls[0][1] as { utenteIds: string[]; tipo: string; scuolaId: string }
    // `segr-a` è di un'ALTRA sede: fuori. `admin-x` copre la B dal ponte.
    expect(args.utenteIds).toEqual(['admin-x'])
    expect(args.tipo).toBe('fattura_scartata')
    expect(args.scuolaId).toBe(SEDE_B)
    // Lo stato terminale è stato scritto: la fattura non è più in volo.
    expect(stato.db.fatture_emesse[0]).toMatchObject({ sdi_stato: 4 })
    expect(logDi('scarto-senza-destinatari')).toBeUndefined()
  })

  it('NESSUN destinatario ⇒ log `error`: quell\'avviso non si ripeterà mai più', async () => {
    stato.db.utenti_scuole = []
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data.scartate).toBe(1)

    // `.mock.calls.length` e non `.not.toHaveBeenCalled()`: gli argomenti
    // registrati contengono il finto client, e stamparli fa esplodere il proxy.
    expect(enqueueNotifiche.mock.calls.length).toBe(0)
    const riga = logDi('scarto-senza-destinatari')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('cron')
    expect(riga?.[1]).toBe('error')
    expect((riga?.[2] as { scuola_id?: string }).scuola_id).toBe(SEDE_B)
  })
})
