'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Sblocco biometrico (Face ID / Touch ID / impronta) OPT-IN. La sessione
// Supabase è su cookie: la biometria NON ri-autentica, SBLOCCA l'accesso alla
// UI già autenticata. Tutto no-op su web. L'opt-in vive in localStorage.
//
// Questo modulo è una LIB, non un componente: non può usare `useTranslations`.
// I testi mostrati dal prompt di sistema arrivano quindi come PARAMETRO
// (`TestiBiometria`), forniti dai componenti che il contesto i18n ce l'hanno.
// La firma è un oggetto e non una lista di stringhe di proposito: aggiungere un
// testo non cambia l'ordine degli argomenti in silenzio.

const OPTIN_KEY = 'kv_biometric_optin'

/** Testi del prompt NATIVO, tutti localizzati dal chiamante. */
export interface TestiBiometria {
  /** `reason`: il motivo mostrato nel prompt (iOS e descrizione Android). */
  motivo: string
  /** `cancelTitle`. Vedi nota sotto: su Android oggi il plugin lo ignora. */
  annulla: string
  /** `androidTitle`: il titolo del BiometricPrompt Android. */
  titoloAndroid: string
  /** `androidSubtitle`: opzionale. */
  sottotitoloAndroid?: string
  /** `iosFallbackTitle`: l'etichetta del ripiego al codice del dispositivo. */
  fallbackIos: string
}

/**
 * Esito della verifica. NON è un booleano nudo: il `codice` (uno di
 * `BiometryErrorType`) serve a due cose che senza di esso sono impossibili —
 * distinguere un blocco TEMPORANEO (`biometryLockout`) da uno PERMANENTE
 * (`biometryNotEnrolled`), e non loggare come guasto ciò che è un annullamento.
 */
export interface EsitoBiometria {
  ok: boolean
  codice?: string
}

/** Disponibilità della biometria, con il motivo quando manca. */
export interface StatoBiometria {
  disponibile: boolean
  /** Uno di `BiometryErrorType`, `''` quando è disponibile. */
  codice: string
}

/**
 * I codici che descrivono una scelta dell'utente, non un guasto. Non vanno
 * loggati: chi tocca «Annulla» non è un incidente.
 */
export const ANNULLAMENTI_BIOMETRIA: ReadonlySet<string> = new Set([
  'userCancel',
  'userFallback',
  'appCancel',
  'systemCancel',
  'authenticationFailed',
  'notInteractive',
])

/** Stato della biometria del dispositivo, col codice del perché quando manca. */
export async function statoBiometria(): Promise<StatoBiometria> {
  if (!isNativeApp()) return { disponibile: false, codice: 'biometryNotAvailable' }
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    const res = await BiometricAuth.checkBiometry()
    return { disponibile: !!res.isAvailable, codice: res.code ?? '' }
  } catch {
    return { disponibile: false, codice: 'biometryNotAvailable' }
  }
}

/** true se il dispositivo espone una biometria utilizzabile. false su web. */
export async function biometriaDisponibile(): Promise<boolean> {
  return (await statoBiometria()).disponibile
}

/**
 * Chiede all'utente la verifica biometrica. `ok: true` SOLO se l'utente si
 * autentica con successo; altrimenti `ok: false` col codice del motivo. Mai
 * lancia.
 *
 * NOTA Android: quando `allowDeviceCredential` è true il plugin non applica
 * `setNegativeButtonText`, quindi `annulla` viene ignorato e l'etichetta la
 * mette il sistema. Lo si passa comunque perché è corretto su iOS e perché
 * tornerebbe rilevante se `allowDeviceCredential` cambiasse.
 */
export async function verificaBiometria(t: TestiBiometria): Promise<EsitoBiometria> {
  if (!isNativeApp()) return { ok: false, codice: 'biometryNotAvailable' }
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    // authenticate() risolve in caso di successo, lancia altrimenti.
    await BiometricAuth.authenticate({
      reason: t.motivo,
      cancelTitle: t.annulla,
      // ANTI-LOCKOUT: senza il ripiego al PIN/codice del dispositivo, un dito
      // che non viene più riconosciuto chiuderebbe l'utente fuori dall'app.
      allowDeviceCredential: true,
      androidTitle: t.titoloAndroid,
      ...(t.sottotitoloAndroid ? { androidSubtitle: t.sottotitoloAndroid } : {}),
      iosFallbackTitle: t.fallbackIos,
    })
    return { ok: true }
  } catch (err) {
    const codice = (err as { code?: string } | null)?.code
    return { ok: false, codice: typeof codice === 'string' && codice ? codice : 'errore' }
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
