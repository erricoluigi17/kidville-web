import { describe, it, expect, beforeEach } from 'vitest'
import {
  biometriaAttiva,
  impostaBiometria,
  biometriaDisponibile,
  verificaBiometria,
} from '@/lib/native/biometric'

// La logica opt-in vive in localStorage (chiave kv_biometric_optin) ed è pura,
// quindi testabile in jsdom. Su web (non nativo) disponibilità e verifica → false.
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
  it('biometriaDisponibile() → false', async () => {
    expect(await biometriaDisponibile()).toBe(false)
  })
  it('verificaBiometria() → false', async () => {
    expect(await verificaBiometria('motivo')).toBe(false)
  })
})
