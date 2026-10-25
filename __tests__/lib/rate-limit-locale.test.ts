// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Se il contatore in memoria aprisse il client service role, questa spia lo vedrebbe.
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

import { rateLimitLocale, resetRateLimit } from '@/lib/security/rate-limit'

/**
 * IL TETTO PER ISTANZA, SENZA DATABASE (sessione 7 della seconda serie di robustezza).
 *
 * Lo usa solo la porta dei tre endpoint di salute (`src/lib/health/porta.ts`): una salute che
 * scrive su Postgres a ogni richiesta misura il database dopo averlo caricato. Qui si prova che
 * conta, che la finestra scorre al millisecondo e che non tocca mai il client.
 */

const T0 = 1_760_000_000_000
const TETTO = { limit: 30, windowMs: 60_000 }

beforeEach(() => {
    vi.clearAllMocks()
    resetRateLimit()
})

describe('rateLimitLocale', () => {
    it('lascia passare 30 colpi nello stesso minuto e ferma il 31°, con l’attesa giusta', () => {
        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0)).toEqual({ ok: true, remaining: 29, retryAfterMs: 0 })
        for (let i = 1; i < 30; i++) expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + i).ok).toBe(true)

        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 30)).toEqual({
            ok: false,
            remaining: 0,
            retryAfterMs: 59_970,
        })
    })

    it('la finestra scorre: a 59.999 ms dal primo colpo è ancora piena, a 60.000 no', () => {
        for (let i = 0; i < 30; i++) rateLimitLocale('health:203.0.113.9', TETTO, T0 + i)

        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 59_999).ok).toBe(false)
        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 60_000).ok).toBe(true)
    })

    it('chiavi diverse hanno contatori diversi', () => {
        for (let i = 0; i < 30; i++) rateLimitLocale('health:203.0.113.9', TETTO, T0 + i)

        expect(rateLimitLocale('health:203.0.113.9', TETTO, T0 + 31).ok).toBe(false)
        expect(rateLimitLocale('health:198.51.100.7', TETTO, T0 + 31).ok).toBe(true)
        expect(rateLimitLocale('health-vivo:203.0.113.9', TETTO, T0 + 31).ok).toBe(true)
    })

    it('non apre mai il client del database', () => {
        for (let i = 0; i < 40; i++) rateLimitLocale('health:203.0.113.9', TETTO, T0 + i)

        expect(supa.createAdminClient).not.toHaveBeenCalled()
    })
})
