'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Sblocco biometrico (Face ID / Touch ID / impronta) OPT-IN. La sessione
// Supabase è su cookie: la biometria NON ri-autentica, SBLOCCA l'accesso alla
// UI già autenticata. Tutto no-op su web. L'opt-in vive in localStorage.

const OPTIN_KEY = 'kv_biometric_optin'

/** true se il dispositivo espone una biometria utilizzabile. false su web. */
export async function biometriaDisponibile(): Promise<boolean> {
  if (!isNativeApp()) return false
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    const res = await BiometricAuth.checkBiometry()
    return !!res.isAvailable
  } catch {
    return false
  }
}

/**
 * Chiede all'utente la verifica biometrica. Ritorna true SOLO se l'utente
 * si autentica con successo; false su annullamento, fallimento o assenza del
 * plugin. Mai lancia. `motivo` è il testo mostrato nel prompt di sistema.
 */
export async function verificaBiometria(motivo: string): Promise<boolean> {
  if (!isNativeApp()) return false
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    // authenticate() risolve in caso di successo, lancia altrimenti.
    await BiometricAuth.authenticate({
      reason: motivo,
      cancelTitle: 'Annulla',
      allowDeviceCredential: true,
      androidTitle: 'Sblocco Kidville',
      iosFallbackTitle: 'Usa il codice',
    })
    return true
  } catch {
    return false
  }
}

/** true se l'utente ha attivato lo sblocco biometrico (opt-in in localStorage). */
export function biometriaAttiva(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(OPTIN_KEY) === '1'
  } catch {
    return false
  }
}

/** Attiva/disattiva l'opt-in dello sblocco biometrico. Best-effort su localStorage. */
export function impostaBiometria(on: boolean): void {
  try {
    if (typeof window === 'undefined') return
    if (on) window.localStorage.setItem(OPTIN_KEY, '1')
    else window.localStorage.removeItem(OPTIN_KEY)
  } catch {
    // localStorage non disponibile (modalità privata/quota): no-op silenzioso
  }
}
