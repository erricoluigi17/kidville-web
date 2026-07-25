import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ANNULLAMENTI_BIOMETRIA,
  biometriaAttiva,
  impostaBiometria,
  biometriaDisponibile,
  statoBiometria,
  verificaBiometria,
} from '@/lib/native/biometric'
import { isNativeApp } from '@/lib/push/native-register'

// Il plugin è caricato con `await import()` dietro il gate nativo: in jsdom quel
// ramo non si prendeva MAI, ed è il motivo per cui la biometria non aveva
// nessuna copertura oltre all'opt-in. Qui si mocka il plugin e si finge il
// nativo, così il ramo esiste anche nei test.
const checkBiometry = vi.hoisted(() => vi.fn())
const authenticate = vi.hoisted(() => vi.fn())
vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: { checkBiometry, authenticate },
}))
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn() }))

const mockNativo = vi.mocked(isNativeApp)

const TESTI = {
  motivo: 'Sblocca Kidville',
  annulla: 'Annulla',
  titoloAndroid: 'Sblocco Kidville',
  sottotitoloAndroid: 'Usa l’impronta',
  fallbackIos: 'Usa il codice',
}

describe('opt-in biometria', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('è disattivata di default', () => {
    expect(biometriaAttiva()).toBe(false)
  })

  it('impostaBiometria(true) scrive il flag e attiva', () => {
    impostaBiometria(true)
    expect(window.localStorage.getItem('kv_biometric_optin')).toBe('1')
    expect(biometriaAttiva()).toBe(true)
  })

  it('impostaBiometria(false) rimuove il flag e disattiva', () => {
    impostaBiometria(true)
    impostaBiometria(false)
    expect(window.localStorage.getItem('kv_biometric_optin')).toBeNull()
    expect(biometriaAttiva()).toBe(false)
  })
})

describe('biometria su web (non nativo)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNativo.mockReturnValue(false)
  })

  it('biometriaDisponibile() → false', async () => {
    expect(await biometriaDisponibile()).toBe(false)
  })

  it('verificaBiometria() → ok false, e non chiama il plugin', async () => {
    const esito = await verificaBiometria(TESTI)
    expect(esito.ok).toBe(false)
    expect(authenticate).not.toHaveBeenCalled()
  })
})

describe('biometria su nativo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNativo.mockReturnValue(true)
  })

  it('passa al prompt nativo i testi LOCALIZZATI, non stringhe cablate', async () => {
    authenticate.mockResolvedValue(undefined)
    await verificaBiometria(TESTI)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(authenticate.mock.calls[0][0]).toMatchObject({
      reason: TESTI.motivo,
      cancelTitle: TESTI.annulla,
      androidTitle: TESTI.titoloAndroid,
      androidSubtitle: TESTI.sottotitoloAndroid,
      iosFallbackTitle: TESTI.fallbackIos,
    })
  })

  it('tiene acceso allowDeviceCredential: è l’anti-lockout', async () => {
    authenticate.mockResolvedValue(undefined)
    await verificaBiometria(TESTI)
    expect(authenticate.mock.calls[0][0].allowDeviceCredential).toBe(true)
  })

  it('successo → { ok: true }', async () => {
    authenticate.mockResolvedValue(undefined)
    expect(await verificaBiometria(TESTI)).toEqual({ ok: true })
  })

  it('fallimento → propaga il CODICE, che il gate usa per decidere', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('x'), { code: 'biometryLockout' }))
    expect(await verificaBiometria(TESTI)).toEqual({ ok: false, codice: 'biometryLockout' })
  })

  it('errore senza codice → codice generico, mai undefined', async () => {
    authenticate.mockRejectedValue(new Error('boom'))
    expect(await verificaBiometria(TESTI)).toEqual({ ok: false, codice: 'errore' })
  })

  it('statoBiometria() riporta disponibilità e motivo', async () => {
    checkBiometry.mockResolvedValue({ isAvailable: false, code: 'biometryNotEnrolled' })
    expect(await statoBiometria()).toEqual({
      disponibile: false,
      codice: 'biometryNotEnrolled',
    })
  })

  it('plugin che lancia → non disponibile, mai un throw', async () => {
    checkBiometry.mockRejectedValue(new Error('plugin assente'))
    expect(await statoBiometria()).toEqual({
      disponibile: false,
      codice: 'biometryNotAvailable',
    })
  })
})

describe('classificazione degli esiti', () => {
  it('gli annullamenti dell’utente NON sono guasti (non vanno loggati)', () => {
    expect(ANNULLAMENTI_BIOMETRIA.has('userCancel')).toBe(true)
    expect(ANNULLAMENTI_BIOMETRIA.has('userFallback')).toBe(true)
    expect(ANNULLAMENTI_BIOMETRIA.has('authenticationFailed')).toBe(true)
  })

  it('i motivi di SISTEMA invece lo sono', () => {
    expect(ANNULLAMENTI_BIOMETRIA.has('biometryLockout')).toBe(false)
    expect(ANNULLAMENTI_BIOMETRIA.has('biometryNotEnrolled')).toBe(false)
    expect(ANNULLAMENTI_BIOMETRIA.has('passcodeNotSet')).toBe(false)
  })
})
