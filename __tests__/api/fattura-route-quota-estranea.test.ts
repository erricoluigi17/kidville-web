import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/pagamenti/fattura — il rifiuto della riga viva ESTRANEA alle quote.
 *
 * Il motore ferma l'emissione quando, nel ramo multi-quota, a registro c'è una
 * fattura viva che non corrisponde alle quote di oggi (intestatario ignoto, un
 * adulto che oggi non ha quota, o l'importo di ieri). Quel rifiuto esce con
 * `motivo: 'quota_estranea'`, ed è un 409: la richiesta è ben formata, è la
 * SITUAZIONE che la rifiuta.
 *
 * Qui si sorveglia la sola cosa che la route deve garantire: che quel rifiuto
 * arrivi al client con un `codice`, dichiarato in `CODICI_ERRORE` e tradotto in
 * entrambe le lingue. Senza, chi lavora con l'interfaccia in inglese leggerebbe
 * la prosa italiana del server — il difetto che il lock `errori-con-codice`
 * esiste per impedire — e questa risposta finirebbe a ingrossare il debito
 * dell'allowlist invece di nascere già pagata.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  emetti: vi.fn(),
}))

vi.mock('@/lib/auth/scope', () => ({
  assertPagamentoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: null, error: null })
      b.update = () => ({ eq: async () => ({ error: null }) })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
    storage: { from: () => ({ download: async () => ({ data: null }) }) },
  }),
}))
vi.mock('@/lib/aruba/emissione', () => ({ emettiFatturaPagamento: h.emetti }))

import { POST } from '@/app/api/pagamenti/fattura/route'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CODICE = 'FATTURA_RIGA_VIVA_ESTRANEA_ALLE_QUOTE'

function post(body: unknown) {
  return new Request('http://localhost/api/pagamenti/fattura', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const rifiutoDelMotore = {
  ok: false as const,
  motivo: 'quota_estranea' as const,
  messaggio:
    'Questo pagamento ha già una fattura viva (Asilo 2327/2026) che non corrisponde alle quote ' +
    'di oggi… Nessun numero è stato consumato.',
  httpStatus: 409,
  quote: [
    { adultId: 'u-mamma', label: 'Mamma', ok: false, motivo: 'quota_estranea' as const, httpStatus: 409 },
    { adultId: 'u-papa', label: 'Papà', ok: false, motivo: 'quota_estranea' as const, httpStatus: 409 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('POST /api/pagamenti/fattura — riga viva estranea alle quote', () => {
  it('il rifiuto del motore esce 409 con `FATTURA_RIGA_VIVA_ESTRANEA_ALLE_QUOTE`', async () => {
    h.emetti.mockResolvedValue(rifiutoDelMotore)

    const res = await POST(post({ pagamento_id: PID }))
    const j = await res.json()

    expect(res.status).toBe(409)
    expect(j.codice).toBe(CODICE)
    expect(j.data.motivo).toBe('quota_estranea')
    // La prosa del server resta accanto al codice: dice QUALE documento c'è già,
    // e quel dettaglio nessun catalogo lo può contenere.
    expect(j.error).toContain('Asilo 2327/2026')
  })

  it('il codice è DICHIARATO e tradotto in italiano e in inglese', async () => {
    const catIt = itShared as Record<string, string>
    const catEn = enShared as Record<string, string>
    const chiave = (CODICI_ERRORE as Record<string, string>)[CODICE]
    expect(chiave, `${CODICE} non è dichiarato in CODICI_ERRORE`).toBeTruthy()
    expect(catIt[chiave]?.trim(), `${CODICE} senza voce italiana`).toBeTruthy()
    expect(catEn[chiave]?.trim(), `${CODICE} senza voce inglese`).toBeTruthy()
    // La frase tradotta non nomina una colonna del database: è la regola che il
    // lock `errori-con-codice` applica ai cataloghi.
    expect(catIt[chiave]).not.toMatch(/scuola_id|quota_adult_id/)
    expect(catEn[chiave]).not.toMatch(/scuola_id|quota_adult_id/)
  })

  it('gli altri rifiuti non cambiano forma: il codice è SOLO di questo motivo', async () => {
    // Senza questa riga, un `codice` appiccicato a ogni risposta d'errore
    // passerebbe il test qui sopra dicendo la cosa sbagliata a chi legge.
    h.emetti.mockResolvedValue({
      ok: false,
      motivo: 'intestatario_mancante',
      messaggio: 'Intestatario fattura non impostato sull’anagrafica',
      httpStatus: 422,
    })

    const res = await POST(post({ pagamento_id: PID }))
    const j = await res.json()

    expect(res.status).toBe(422)
    expect(j.codice).toBeUndefined()
    expect(j.data.motivo).toBe('intestatario_mancante')
  })
})
