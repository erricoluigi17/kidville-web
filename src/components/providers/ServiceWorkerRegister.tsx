'use client'

import { useEffect } from 'react'

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
 */
export function ServiceWorkerRegister() {
    useEffect(() => {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(() => {
                // Registrazione fallita (contesto non sicuro, permessi, WebView senza
                // supporto): l'app funziona comunque online, si degrada in silenzio.
            })
        }
    }, [])

    return null
}
