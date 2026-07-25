'use client'

import { useEffect } from 'react'
import { pulisciCacheScaduta } from '@/lib/offline/pulizia-cache'

// Fa scadere la cache di lettura offline (`cache_read`) una volta per avvio.
// Non renderizza nulla e non ha stato: la pulizia è manutenzione, non prodotto.
// Il modulo tiene la guardia (e non un ref) perché in StrictMode l'effetto gira
// due volte e non c'è motivo di interrogare IndexedDB due volte.
let eseguita = false

export function PuliziaCacheOffline() {
  useEffect(() => {
    if (eseguita) return
    eseguita = true
    // Nessun setState: solo effetto su IndexedDB. `pulisciCacheScaduta` non
    // lancia mai e logga da sé quando fallisce.
    void pulisciCacheScaduta()
  }, [])

  return null
}
