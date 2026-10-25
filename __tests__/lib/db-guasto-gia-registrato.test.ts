// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
})

import { rispostaGuastoDb, rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'

beforeEach(() => vi.clearAllMocks())

describe('rispostaGuastoGiaRegistrato — la risposta del guasto, senza una seconda riga di log', () => {
  it('lettura (predefinita): 500 LETTURA_FALLITA, e nessuna riga', async () => {
    const res = rispostaGuastoGiaRegistrato()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' })
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('scrittura: 500 SCRITTURA_FALLITA', async () => {
    const res = rispostaGuastoGiaRegistrato('scrittura')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Scrittura sul database non riuscita', codice: 'SCRITTURA_FALLITA' })
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('rispostaGuastoDb risponde allo stesso modo, e in più scrive la riga col guasto', async () => {
    const guasto = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = rispostaGuastoDb('x:GET', 'db:t', guasto)
    expect(await res.json()).toEqual({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' })
    expect(h.logErrore).toHaveBeenCalledWith({ operazione: 'x:GET', stato: 500, evento: 'db:t' }, guasto)
  })
})
