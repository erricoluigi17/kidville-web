import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: log.logClient,
  nomeErrore: (errore: unknown) => errore instanceof Error ? errore.name : 'errore',
}))

import { registraEsitoFattura } from '@/lib/pagamenti/esito-fattura'

const PAGAMENTO = '10000000-0000-4000-8000-000000000001'
const FATTURA = '20000000-0000-4000-8000-000000000002'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registraEsitoFattura', () => {
  it('invia solo UUID ed enum con credenziali same-origin e keepalive', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await registraEsitoFattura({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'browser_avviato',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/pagamenti/fattura/esito', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pagamento_id: PAGAMENTO,
        fattura_id: FATTURA,
        esito: 'browser_avviato',
      }),
    })
    expect(log.logClient).not.toHaveBeenCalled()
  })

  it('resta fail-open su risposta HTTP e logga soltanto status e codice sintetico', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'https://storage.test/fattura.pdf?token=segreto',
      { status: 503 },
    )))

    await expect(registraEsitoFattura({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'visualizzata',
    })).resolves.toBeUndefined()

    expect(log.logClient).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'fattura-esito-non-registrato',
      stato: 503,
      campi: { error_code: 'RispostaHttp' },
    })
    expect(JSON.stringify(log.logClient.mock.calls)).not.toContain('storage.test')
    expect(JSON.stringify(log.logClient.mock.calls)).not.toContain('segreto')
  })

  it('resta fail-open su eccezione e non logga message, URL o token', async () => {
    const errore = new TypeError('https://storage.test/fattura.pdf?token=segreto')
    vi.stubGlobal('fetch', vi.fn(async () => { throw errore }))

    await expect(registraEsitoFattura({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'annullata',
    })).resolves.toBeUndefined()

    expect(log.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'fattura-esito-non-registrato',
      stato: 0,
      campi: { error_code: 'TypeError' },
    })
    expect(JSON.stringify(log.logClient.mock.calls)).not.toContain('storage.test')
    expect(JSON.stringify(log.logClient.mock.calls)).not.toContain('segreto')
  })
})
