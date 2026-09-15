'use client'

import { useEffect } from 'react'
import { logClient, type EventoNome } from '@/lib/logging/client'
import { richiediAperturaThread } from '@/lib/chat/apertura-thread'
import { PARAM_THREAD, leggiIdThread, leggiLinkChat } from '@/lib/chat/link-conversazione'

/**
 * Registra il Service Worker (`/sw.js`) su TUTTE le piattaforme — web e nativo
 * Capacitor (WebView) — per abilitare la cache offline del guscio app.
 *
 * Fino a oggi il SW veniva registrato solo dal flusso Web Push (PushOptIn), quindi
 * su nativo e sui genitori senza push non c'era alcuna cache. Qui la registrazione
 * è incondizionata e idempotente: registrare due volte lo stesso URL è un no-op per
 * il browser, quindi non entra in conflitto con PushOptIn.
 *
 * Hydration-safe: la registrazione avviene DENTRO useEffect (post-mount, solo client)
 * e non fa alcun setState → nessun rischio di mismatch SSR/CSR. Non renderizza nulla.
 *
 * Questo componente fa anche da PONTE DI LOG per il Service Worker (vedi
 * `public/sw.js`, funzione `avvisa`): il SW non può importare il logger, quindi
 * manda un `postMessage` e qui lo si traduce in `logClient`, dentro la pipeline
 * ufficiale (redazione, deduplica, `app_log`).
 *
 * E da PONTE PER IL CLIC SU UNA WEB PUSH DI CHAT (dal 2026-09-15): vedi
 * `apriThreadDalServiceWorker`.
 */

/** Quanto si aspetta prima di dichiarare che il SW non controlla la pagina. */
const ATTESA_CONTROLLO_MS = 10_000

interface MessaggioSW {
  tipo?: unknown
  evento?: unknown
  livello?: unknown
  bucket?: unknown
  /** Solo in `kv-apri-thread`: la conversazione da aprire. */
  threadId?: unknown
}

/**
 * IL CLIC SU UNA WEB PUSH DI CHAT, CON LA CHAT GIÀ APERTA (parte C della correzione chat).
 *
 * `public/sw.js` non naviga una finestra che è già su una pagina chat: le manda
 * `{ tipo: 'kv-apri-thread', threadId }` e la porta davanti, così la pagina resta montata
 * con la sua bozza e il suo scorrimento. Qui il messaggio diventa la stessa richiesta del
 * tocco su una push nativa (`richiediAperturaThread`): la pagina chat la tratta con le sue
 * regole, e ne registra l'esito.
 *
 * Se nessuna pagina ascolta — l'URL dice chat, ma l'ascoltatore non è ancora montato (una
 * navigazione appena confermata) — la richiesta non si butta: il thread va nell'URL con
 * `replaceState`, che in Next 16 aggiorna `useSearchParams` senza una richiesta al server,
 * e la pagina lo legge al montaggio. È il ripiego «si naviga al link con ?thread=» che
 * `richiediAperturaThread` chiede a chi riceve `false`; sulla voce corrente della
 * cronologia, perché nessuno ha cambiato pagina.
 *
 * Se la finestra nel frattempo non è più sulla chat, da qui non si naviga: il ponte non ha
 * un router, e a portarla via dalla chat è stato qualcos'altro, per esempio un rinvio al
 * login a sessione scaduta, che una navigazione verso la chat scavalcherebbe. La
 * conversazione non si apre, e lo si scrive. Nel log mai l'id della conversazione.
 *
 * Un `threadId` che non è un id si scarta in silenzio: il Service Worker lo ha già
 * controllato, quindi non arriva da questa app.
 */
function apriThreadDalServiceWorker(threadId: unknown): void {
  const id = leggiIdThread(threadId)
  if (!id) return
  if (richiediAperturaThread(id)) return
  if (!leggiLinkChat(window.location.pathname)) {
    logClient({ livello: 'warn', evento: 'push', messaggio: 'chat-apertura-da-notifica: nessuna-pagina-chat (sw)' })
    return
  }
  const parametri = new URLSearchParams(window.location.search)
  parametri.set(PARAM_THREAD, id)
  window.history.replaceState(null, '', `${window.location.pathname}?${parametri.toString()}${window.location.hash}`)
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    // Riferimento catturato una volta: la cleanup non deve dipendere da cosa c'è
    // su `navigator` al momento dello smontaggio.
    const sw = navigator.serviceWorker

    // Il `.catch(() => {})` di prima era un catch MUTO — vietato da AGENTS.md
    // (regola 6) — ed è la ragione per cui il difetto iOS è vissuto invisibile
    // per un'intera fase: dentro WKWebView, senza `WKAppBoundDomains`, la
    // registrazione falliva sempre e nessuno lo sapeva. Il gate era verde, i
    // test passavano, e l'offline semplicemente non esisteva.
    sw.register('/sw.js').then(
      () => {
        /* la registrazione è andata: il segnale utile è il controllo, sotto */
      },
      (err: unknown) => {
        const nome = err instanceof Error ? err.name : 'errore'
        logClient({
          livello: 'error',
          evento: 'offline',
          messaggio: `sw-registrazione-fallita: ${nome}`,
        })
      },
    )

    // Seconda sonda: il SW può essere registrato e non controllare la pagina —
    // che per l'offline equivale a non averlo. È l'altra metà del guasto.
    const sonda = window.setTimeout(() => {
      if (!sw.controller) {
        logClient({ livello: 'warn', evento: 'offline', messaggio: 'sw-senza-controllo' })
      }
    }, ATTESA_CONTROLLO_MS)

    // Ponte dal Service Worker: il clic su una web push di chat, e i log.
    const onMessage = (ev: MessageEvent) => {
      const m = (ev.data ?? {}) as MessaggioSW
      if (m.tipo === 'kv-apri-thread') {
        apriThreadDalServiceWorker(m.threadId)
        return
      }
      if (m.tipo !== 'kv-sw-log') return
      if (typeof m.evento !== 'string') return
      const livello = m.livello === 'error' ? 'error' : 'warn'
      const bucket = typeof m.bucket === 'string' ? m.bucket : ''
      logClient({
        livello,
        // `offline` è il valore già dichiarato in EventoNome per questo canale.
        evento: 'offline' satisfies EventoNome,
        // Solo slug e bucket: dal SW non arriva mai un URL, un id o un token.
        messaggio: bucket ? `${m.evento} ${bucket}` : m.evento,
      })
    }
    sw.addEventListener('message', onMessage)

    return () => {
      window.clearTimeout(sonda)
      sw.removeEventListener('message', onMessage)
    }
  }, [])

  return null
}
