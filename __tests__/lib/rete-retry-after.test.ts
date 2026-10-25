import { describe, it, expect } from 'vitest'
import { msDaRetryAfter } from '@/lib/rete/retry-after'

// Sessione 9 della seconda serie di robustezza. `Retry-After` arriva in due forme (RFC 9110,
// §10.2.3): secondi interi oppure una data HTTP. Lo leggono `send.ts` (Resend) e `claude.ts`
// (Anthropic). L'istante è passato a mano: nessun orologio vero nel test.
const ADESSO = Date.parse('2026-10-21T06:00:00Z')

describe('msDaRetryAfter', () => {
  it('secondi interi, anche con spazi intorno', () => {
    expect(msDaRetryAfter('2', ADESSO)).toBe(2_000)
    expect(msDaRetryAfter('0', ADESSO)).toBe(0)
    expect(msDaRetryAfter(' 30 ', ADESSO)).toBe(30_000)
  })

  it('data HTTP: la distanza da adesso, mai negativa', () => {
    expect(msDaRetryAfter('Wed, 21 Oct 2026 06:00:05 GMT', ADESSO)).toBe(5_000)
    expect(msDaRetryAfter('Wed, 21 Oct 2026 05:59:00 GMT', ADESSO)).toBe(0)
  })

  it('assente, vuoto o illeggibile: undefined, e chi chiama usa la propria scaletta', () => {
    expect(msDaRetryAfter(undefined, ADESSO)).toBeUndefined()
    expect(msDaRetryAfter('', ADESSO)).toBeUndefined()
    expect(msDaRetryAfter('presto', ADESSO)).toBeUndefined()
  })
})
