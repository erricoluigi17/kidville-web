'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { NativeInit } from '@/components/providers/NativeInit'
import { GlobalLoader } from '@/components/providers/GlobalLoader'
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister'
import { PuliziaCacheOffline } from '@/components/providers/PuliziaCacheOffline'
import { ChunkErrorBoundary } from '@/components/providers/ChunkErrorBoundary'
import { BiometricGate } from '@/components/providers/BiometricGate'
import { AvvisoAggiornamentoApp } from '@/components/providers/AvvisoAggiornamentoApp'
import { ControlloVersione } from '@/components/providers/ControlloVersione'

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
          senza sessione; l'overlay scatta solo in useEffect (hydration-safe).
          Il pop-up «Aggiorna l'app» (solo sul binario sotto la versione minima dello
          store) sta FRA I FIGLI del gate, non accanto: legge `useBloccoBiometrico()`
          e non si apre sopra lo sblocco, che la sua Modal renderebbe inerte. Qui, e
          non nei layout, copre genitore, docente, segreteria e login. Il lock è in
          `__tests__/architecture/gate-shell-nativa.test.ts`. */}
      <BiometricGate autenticato={autenticato}>
        {children}
        <AvvisoAggiornamentoApp />
        {/* Il bundle vecchio in memoria (robustezza, S7-B): al ritorno in primo piano dopo
            un'assenza lunga chiede al server quale rilascio stia servendo, e se è un altro
            ricarica. Sta QUI, accanto al pop-up dello store, perché la ragione è la stessa —
            un posto solo che copre genitore, docente, segreteria e la WebView nativa — ma le
            due cose sono diverse: quello riguarda il BINARIO dello store e chiede all'utente di
            aggiornarlo, questo riguarda il bundle web e si risolve da sé.
            `attivo={autenticato}`: sulla schermata di accesso non c'è niente da tenere fresco,
            e una ricarica lì porterebbe via le credenziali appena digitate per guadagnare
            nulla. Il lock che impedisce che si scolleghi è in
            `__tests__/architecture/gate-shell-nativa.test.ts`. */}
        <ControlloVersione attivo={autenticato} />
      </BiometricGate>
    </AccessibilityProvider>
  )
}
