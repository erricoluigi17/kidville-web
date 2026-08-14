'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { NativeInit } from '@/components/providers/NativeInit'
import { GlobalLoader } from '@/components/providers/GlobalLoader'
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister'
import { PuliziaCacheOffline } from '@/components/providers/PuliziaCacheOffline'
import { ChunkErrorBoundary } from '@/components/providers/ChunkErrorBoundary'
import { BiometricGate } from '@/components/providers/BiometricGate'

/** Compositore dei provider globali client-side (accessibilità, shell nativa). */
export function RootProviders({
  initialHighContrast,
  autenticato,
  children,
}: {
  initialHighContrast: boolean
  /** Sessione presente secondo i cookie (calcolata nel root layout server). */
  autenticato: boolean
  children: React.ReactNode
}) {
  return (
    <AccessibilityProvider initialHighContrast={initialHighContrast}>
      <NativeInit />
      {/* Registra il Service Worker (cache offline del guscio) su web e nativo. */}
      <ServiceWorkerRegister />
      {/* Scadenza della cache di lettura offline: gira una volta per avvio. */}
      <PuliziaCacheOffline />
      {/* Loader globale: overlay client fratello del contenuto (NON un boundary
          Suspense), così non interferisce con l'hydration delle pagine. */}
      <GlobalLoader />
      {/* Il pannello che parla quando un pezzo del programma non arriva. Sta QUI,
          accanto al loader, perché è esattamente il loader che senza di lui resta
          su «Caricamento…» per sempre: il codice che avrebbe dovuto toglierlo è
          nel file che non è arrivato.
          Non avvolge nulla — si installa da solo con listener globali in cattura
          e si disegna a 9998, cioè sopra ogni superficie dell'app e sotto il solo
          gate biometrico. L'ordine in questo JSX non decide il piano: lo decide
          lo z-index. Decide però QUANDO i listener sono attivi, e prima è meglio.
          ⚠️ Dal 2026-08-03 al 2026-08-14 questo componente è esistito, con 11 test
          verdi, senza essere montato da nessuna parte: i test lo istanziavano da
          soli e passavano mentre l'app non lo renderizzava mai. Il lock che
          impedisce che torni a scollegarsi è in
          `__tests__/architecture/gate-shell-nativa.test.ts`. */}
      <ChunkErrorBoundary />
      {/* Sblocco biometrico opt-in: passthrough puro su web, a opt-in spento e
          senza sessione; l'overlay scatta solo in useEffect (hydration-safe). */}
      <BiometricGate autenticato={autenticato}>{children}</BiometricGate>
    </AccessibilityProvider>
  )
}
