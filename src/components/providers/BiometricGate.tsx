'use client'

import { useCallback, useEffect, useState } from 'react'
import { Fingerprint, Lock, Loader2 } from 'lucide-react'
import { isNativeApp } from '@/lib/push/native-register'
import { biometriaAttiva, verificaBiometria } from '@/lib/native/biometric'
import { doLogout } from '@/lib/auth/logout'

// Gate di sblocco biometrico OPT-IN. Su web è un passthrough puro. Su nativo,
// SOLO se l'opt-in è attivo, mostra un overlay bloccante all'avvio e ad ogni
// ritorno in foreground finché la verifica biometrica non passa.
//
// Hydration-safe: lo stato iniziale è "sbloccato" (server e primo render client
// mostrano i children identici); il blocco scatta esclusivamente in useEffect
// (lato client), quindi non c'è mismatch. Nessun setState sincrono nel corpo
// dell'effetto: il blocco passa da richiediSblocco() (pattern del repo).

const MOTIVO = 'Sblocca Kidville'

export function BiometricGate({ children }: { children: React.ReactNode }) {
  const [bloccato, setBloccato] = useState(false)
  const [verificaInCorso, setVerificaInCorso] = useState(false)

  const richiediSblocco = useCallback(async () => {
    // `await` prima del primo setState + try/finally: è il boundary async che
    // la regola react-hooks/set-state-in-effect accetta anche quando la funzione
    // è invocata dal corpo dell'effetto (il microtask precede il paint → nessun
    // flash del contenuto sotto l'overlay).
    try {
      await Promise.resolve()
      setBloccato(true)
      setVerificaInCorso(true)
      const ok = await verificaBiometria(MOTIVO)
      if (ok) setBloccato(false)
    } finally {
      setVerificaInCorso(false)
    }
  }, [])

  useEffect(() => {
    // Attivo solo nella shell nativa con opt-in acceso.
    if (!isNativeApp() || !biometriaAttiva()) return
    let disposed = false
    let remove: (() => void) | undefined

    // Blocca subito all'avvio e tenta lo sblocco.
    void richiediSblocco()

    // Ri-blocca ad ogni ritorno in foreground (setState nel callback della
    // subscription → esente dalla regola).
    void (async () => {
      try {
        const { App } = await import('@capacitor/app')
        const handle = await App.addListener('resume', () => {
          void richiediSblocco()
        })
        if (disposed) void handle.remove()
        else remove = () => void handle.remove()
      } catch {
        // plugin App assente: nessun re-lock in foreground (best-effort)
      }
    })()

    return () => {
      disposed = true
      remove?.()
    }
  }, [richiediSblocco])

  return (
    <>
      {children}
      {bloccato && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="App bloccata"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 bg-kidville-green px-8 text-center"
        >
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-white">
            <Lock size={34} strokeWidth={2} />
          </div>
          <div className="space-y-2">
            <h2 className="font-barlow text-2xl font-black uppercase tracking-wide text-white">
              Kidville è bloccato
            </h2>
            <p className="max-w-xs font-maven text-sm text-white/80">
              Sblocca con Face ID o l&apos;impronta per continuare.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void richiediSblocco()}
            disabled={verificaInCorso}
            className="inline-flex items-center gap-2 rounded-pill bg-kidville-yellow px-6 py-3 font-barlow text-sm font-black uppercase tracking-wide text-kidville-green active:scale-95 disabled:opacity-60"
          >
            {verificaInCorso ? (
              <Loader2 size={17} strokeWidth={2.4} className="animate-spin" />
            ) : (
              <Fingerprint size={17} strokeWidth={2.4} />
            )}
            Sblocca
          </button>

          {/* Anti-lockout: consente sempre l'uscita se la biometria non passa. */}
          <button
            type="button"
            onClick={() => void doLogout()}
            className="font-barlow text-xs font-extrabold uppercase tracking-wide text-white/70 underline active:scale-95"
          >
            Esci dall&apos;account
          </button>
        </div>
      )}
    </>
  )
}
