'use client'

import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'

// Registrazione push NATIVA (Capacitor iOS/Android) lato client. Su web tutte le
// funzioni sono no-op: la push web resta gestita dal service worker (PushOptIn).
// L'identità è dalla sessione (cookie condiviso con la WebView); l'eventuale
// `userId` viaggia come header x-user-id di fallback legacy (identità
// localStorage del genitore) — il server preferisce comunque la sessione.

/** true se l'app gira nella shell nativa Capacitor. Su web/SSR → false. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

// Ultimo token nativo registrato in questa sessione (per la disattivazione).
let lastToken: string | null = null

/**
 * IL TOKEN SOPRAVVIVE ALLA SESSIONE JS, E DEVE.
 *
 * `lastToken` è stato di MODULO, e nella WebView Capacitor il modulo muore a ogni
 * navigazione dura — `doLogout()` finisce con `window.location.href`, e l'app che
 * riparte da un boot a freddo comincia con `lastToken = null`. Finché la
 * disattivazione guardava solo la variabile, «esci» su un'app appena aperta non
 * aveva NIENTE da cancellare: la `DELETE` non partiva, la riga in
 * `push_subscriptions` restava, e le notifiche sui bambini continuavano ad
 * arrivare su un telefono che nessuno stava più usando.
 *
 * Il token FCM/APNs è per INSTALLAZIONE, non per utente: non è un dato personale
 * di un minore, è l'indirizzo del dispositivo — lo stesso che viaggia già in
 * chiaro verso `/api/push/subscribe` e vive in `push_subscriptions.endpoint`.
 * Tenerne una copia locale è ciò che rende la disattivazione possibile dopo un
 * riavvio; la chiave sta FUORI da `LOCAL_KEYS` di `logout.ts` perché non è
 * identità, e va tolta solo quando il server conferma di aver rimosso la riga.
 */
const TOKEN_KEY = 'kv_push_token'

function ricordaToken(token: string): void {
  lastToken = token
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch (e) {
    // Storage negato (modalità privata, quota): la registrazione è comunque
    // riuscita, ma la disattivazione dopo un riavvio non avrà più l'indirizzo del
    // dispositivo. È esattamente il difetto che questa chiave chiude, quindi si
    // grida invece di tacere.
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `push-token-non-persistito: ${nomeErrore(e)}`,
    })
  }
}

/** Il token da disattivare: quello di questa sessione, o quello del riavvio precedente. */
function tokenDaDisattivare(): string | null {
  if (lastToken) return lastToken
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    // Storage illeggibile: non c'è niente da fare e non c'è niente da dire che
    // `ricordaToken` non abbia già detto quando ha provato a scriverlo.
    return null
  }
}

function dimenticaToken(): void {
  lastToken = null
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Idem: la copia locale è un ripiego, non la fonte di verità (che è il DB).
  }
}

/**
 * Richiede il permesso, registra la push nativa e invia il token a
 * /api/push/subscribe con la piattaforma. No-op (con esito) su web.
 */
export async function registerNativePush(userId?: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!isNativeApp()) return { ok: false, error: 'not_native' }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const perm = await PushNotifications.requestPermissions()
    if (perm.receive !== 'granted') return { ok: false, error: 'permission_denied' }

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false
      const done = (r: { ok: boolean; error?: string }) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      void PushNotifications.addListener('registration', (token) => {
        ricordaToken(token.value)
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
          body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
        })
          .then((res) => done(res.ok ? { ok: true } : { ok: false, error: 'subscribe_failed' }))
          .catch(() => done({ ok: false, error: 'subscribe_failed' }))
      })
      void PushNotifications.addListener('registrationError', (err) => {
        done({ ok: false, error: String((err as { error?: string })?.error ?? 'registration_error') })
      })
      void PushNotifications.register()
    })
  } catch {
    return { ok: false, error: 'plugin_error' }
  }
}

/**
 * Disattiva la push nativa di QUESTO dispositivo: rimuove la riga lato server e
 * i listener. La chiamano l'opt-in (il genitore che spegne i promemoria) e il
 * LOGOUT (`doLogout`), e i due casi non sono intercambiabili — vedi lì il perché
 * dell'ordine.
 *
 * ⚠️ `DELETE /api/push/subscribe` passa da `requireUser`: senza sessione risponde
 * 401 e il token resta registrato. Va quindi chiamata PRIMA di `auth.signOut()`.
 *
 * L'esito NON si butta via (regola 6 di AGENTS.md, e regola 3 sul corpo delle
 * risposte altrui): un `.catch(() => {})` qui significava «le notifiche di un
 * bambino continuano ad arrivare su un telefono non più autorizzato», in
 * silenzio. Il token locale si dimentica SOLO se il server ha confermato: se la
 * `DELETE` fallisce, la copia resta e il prossimo tentativo avrà ancora
 * l'indirizzo da cancellare.
 */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const token = tokenDaDisattivare()
    if (token) {
      let rimosso = false
      try {
        const res = await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(token)}`, {
          method: 'DELETE',
        })
        rimosso = res.ok
        if (!res.ok) {
          logClient({
            livello: 'error',
            evento: 'push',
            messaggio: 'push-token-non-rimosso: il server ha rifiutato la disattivazione',
            stato: res.status,
          })
        }
      } catch (e) {
        logClient({
          livello: 'error',
          evento: 'push',
          messaggio: `push-token-non-rimosso: ${nomeErrore(e)}`,
        })
      }
      if (rimosso) dimenticaToken()
    }
    await PushNotifications.removeAllListeners()
  } catch (e) {
    // best-effort: la disattivazione non deve mai lanciare — ma non deve nemmeno
    // sparire. Qui ci si arriva col plugin assente o rotto, cioè con un
    // dispositivo che continua a ricevere le push e nessuno che lo sappia.
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `push-disattivazione-fallita: ${nomeErrore(e)}`,
    })
  }
}
