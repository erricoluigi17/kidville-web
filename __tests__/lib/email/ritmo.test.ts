import { describe, it, expect, vi, afterEach } from 'vitest'
import { PAUSA_FRA_EMAIL_MS, pausaFraEmail } from '@/lib/email/ritmo'

// ─────────────────────────────────────────────────────────────────────────────
// IL PASSO FRA DUE EMAIL
//
// Il numero è stato 550 ms finché il piano Resend era Free (~2 richieste al
// secondo). Dal 2026-08-20 il piano è Pro: 10 richieste al secondo per team.
// 150 ms sono ~6,7/s, e il terzo che resta è per chi non fa parte del giro —
// una candidatura, un OTP, il digest: attingono alla stessa cordata.
// ─────────────────────────────────────────────────────────────────────────────
describe('il ritmo degli invii', () => {
  afterEach(() => vi.useRealTimers())

  it('sta sotto il limite del provider, con margine per gli altri giri', () => {
    const alSecondo = 1000 / PAUSA_FRA_EMAIL_MS
    expect(alSecondo).toBeLessThan(10)
    // e non così sotto da rendere impossibile un giro: sopra i 5/s
    expect(alSecondo).toBeGreaterThan(5)
  })

  it('la pausa aspetta davvero: a un millisecondo di meno non è ancora finita', async () => {
    vi.useFakeTimers()
    let finita = false
    const p = pausaFraEmail().then(() => { finita = true })
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_EMAIL_MS - 1)
    expect(finita).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(finita).toBe(true)
  })
})
