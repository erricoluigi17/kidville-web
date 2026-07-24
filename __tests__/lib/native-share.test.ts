import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { condividi } from '@/lib/native/share'

// In ambiente jsdom (vitest) Capacitor.isNativePlatform() → false, quindi
// `condividi` prende SEMPRE il ramo web: Web Share API o fallback clipboard.
function stubNavigator(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true })
}

describe('condividi (fallback web)', () => {
  beforeEach(() => {
    stubNavigator('share', undefined)
    stubNavigator('clipboard', undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('usa navigator.share quando disponibile', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubNavigator('share', share)
    await condividi({ title: 'T', text: 'X', url: 'https://k.it/n/1' })
    expect(share).toHaveBeenCalledWith({ title: 'T', text: 'X', url: 'https://k.it/n/1' })
  })

  it('ripiega su clipboard.writeText (url) quando navigator.share manca', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigator('clipboard', { writeText })
    await condividi({ text: 'ciao', url: 'https://k.it/n/2' })
    expect(writeText).toHaveBeenCalledWith('https://k.it/n/2')
  })

  it('senza url ripiega su clipboard.writeText (text)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigator('clipboard', { writeText })
    await condividi({ text: 'solo testo' })
    expect(writeText).toHaveBeenCalledWith('solo testo')
  })

  it('non lancia se la condivisione viene annullata (AbortError)', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'))
    stubNavigator('share', share)
    await expect(condividi({ url: 'https://k.it/n/3' })).resolves.toBeUndefined()
  })
})
