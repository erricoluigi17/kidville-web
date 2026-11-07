import { describe, it, expect, vi, beforeEach } from 'vitest'

// `rispostaGuastoDb` (Compito 3.4): una scrittura rifiutata dall'anno non e' un guasto. Esplicito
// dove il codice e' gia' scritto, e copre l'handler che chiude con un `try/finally`. Le due copie
// (`db/guasto` e `pagamenti/guasto-db`) hanno lo stesso contratto.
vi.mock('@/lib/logging/logger', async (orig) => {
  const reale = await orig<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }
})

import { logErrore } from '@/lib/logging/logger'
import { rispostaGuastoDb as generale } from '@/lib/db/guasto'
import { rispostaGuastoDb as pagamenti } from '@/lib/pagamenti/guasto-db'

const ERRORE_ANNO = { code: 'P0001', message: 'ANNO_CHIUSO' }

beforeEach(() => {
  vi.mocked(logErrore).mockClear()
})

describe.each([
  ['src/lib/db/guasto', generale, 'SCRITTURA_FALLITA'],
  ['src/lib/pagamenti/guasto-db', pagamenti, 'PAGAMENTI_SCRITTURA_FALLITA'],
] as const)('rispostaGuastoDb di %s', (_nome, rispostaGuastoDb, codiceGuasto) => {
  it("'scrittura' con ANNO_CHIUSO -> 409, e nessun logErrore", async () => {
    const res = rispostaGuastoDb('t/x:POST', 'db:sections', ERRORE_ANNO, 'scrittura')
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    expect(logErrore).not.toHaveBeenCalled()
  })

  it("'lettura' con lo stesso errore resta 500, con il suo logErrore", async () => {
    const res = rispostaGuastoDb('t/x:GET', 'db:sections', ERRORE_ANNO, 'lettura')
    expect(res.status).toBe(500)
    expect(logErrore).toHaveBeenCalledTimes(1)
  })

  it("'scrittura' con un errore che non e' dell'anno resta il guasto di prima", async () => {
    const res = rispostaGuastoDb('t/x:POST', 'db:sections', { code: '23505', message: 'duplicate key' }, 'scrittura')
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe(codiceGuasto)
    expect(logErrore).toHaveBeenCalledTimes(1)
  })

  it("'scrittura' con error null o stringa non lancia", () => {
    expect(rispostaGuastoDb('t/x:POST', 'db:sections', null, 'scrittura').status).toBe(500)
    expect(rispostaGuastoDb('t/x:POST', 'db:sections', 'boom', 'scrittura').status).toBe(500)
  })
})
