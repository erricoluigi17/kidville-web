import { describe, it, expect, beforeEach, vi } from 'vitest'
import { impostaBadgeNonLette } from '@/lib/native/badge'
import { isNativeApp } from '@/lib/push/native-register'

// Il badge dell'icona non aveva alcun test, ed è così che sono passati due
// difetti: restava il conteggio dell'utente precedente dopo il logout, e la sua
// richiesta di permesso competeva con quella della push.

const set = vi.hoisted(() => vi.fn(async () => undefined))
const clear = vi.hoisted(() => vi.fn(async () => undefined))
const checkPermissions = vi.hoisted(() => vi.fn(async () => ({ display: 'granted' })))
const requestPermissions = vi.hoisted(() => vi.fn(async () => ({ display: 'granted' })))
vi.mock('@capawesome/capacitor-badge', () => ({
  Badge: { set, clear, checkPermissions, requestPermissions },
}))
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn() }))

const mockNativo = vi.mocked(isNativeApp)

describe('badge dell’icona', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPermissions.mockResolvedValue({ display: 'granted' })
    mockNativo.mockReturnValue(true)
  })

  it('su web è un no-op puro', async () => {
    mockNativo.mockReturnValue(false)
    await impostaBadgeNonLette(3)
    expect(set).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('NON chiede MAI il permesso notifiche', async () => {
    // È il lock del difetto: su iOS `Badge.requestPermissions()` chiede la sola
    // autorizzazione BADGE, e partendo in parallelo con quella della push poteva
    // vincere — lasciando l'app autorizzata al solo badge, senza banner, e con
    // `PushNotifications.requestPermissions()` che rispondeva comunque `granted`.
    // Un guasto invisibile. L'unico a chiedere il permesso è `registerNativePush`.
    await impostaBadgeNonLette(5)
    await impostaBadgeNonLette(0)
    expect(requestPermissions).not.toHaveBeenCalled()
  })

  it('senza permesso non tocca il badge', async () => {
    checkPermissions.mockResolvedValue({ display: 'prompt' })
    await impostaBadgeNonLette(4)
    expect(set).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('con permesso e n > 0 imposta il conteggio', async () => {
    await impostaBadgeNonLette(7)
    expect(set).toHaveBeenCalledWith({ count: 7 })
  })

  it('n <= 0 pulisce il badge (è ciò che fa il logout)', async () => {
    await impostaBadgeNonLette(0)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
  })

  it('tronca i valori frazionari', async () => {
    await impostaBadgeNonLette(3.9)
    expect(set).toHaveBeenCalledWith({ count: 3 })
  })

  it('un plugin che lancia non propaga: il badge è cosmetico', async () => {
    set.mockRejectedValueOnce(new Error('plugin assente'))
    await expect(impostaBadgeNonLette(2)).resolves.toBeUndefined()
  })
})
