'use client'

import { useState, useRef, useEffect } from 'react'
import { ShieldCheck, Loader2, AlertCircle, Mail, X, CheckCircle2 } from 'lucide-react'

interface Props {
  open: boolean
  email: string | null
  devCode?: string
  onClose: () => void
  /** Verifica il codice e finalizza la firma. Ritorna esito + eventuale errore. */
  onVerify: (code: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Modale di firma elettronica semplice (FES) tramite OTP via email.
 * Stile conforme a design.md (sfondi chiari, verde Kidville, niente scuri).
 */
export function OtpEmailModal({ open, email, devCode, onClose, onVerify }: Props) {
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset dello stato a ogni apertura del modale
  // (adjust-state-during-render, prior art: AvvisoForm.tsx / TaskForm.tsx)
  const [prevOpen, setPrevOpen] = useState(false)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setCode('')
      setError(null)
      setSuccess(false)
    }
  }

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 150)
    }
  }, [open])

  async function handleVerify() {
    if (code.length !== 6) {
      setError('Inserisci il codice a 6 cifre')
      return
    }
    setVerifying(true)
    setError(null)
    const res = await onVerify(code)
    setVerifying(false)
    if (!res.ok) {
      setError(res.error ?? 'Verifica fallita')
      return
    }
    setSuccess(true)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-kidville-green/30 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-sm rounded-card p-6 relative bg-white shadow-2xl border border-kidville-green/10">
        {!success && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-kidville-green hover:bg-kidville-cream transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {success ? (
          <div className="flex flex-col items-center text-center py-4">
            <div className="w-16 h-16 rounded-2xl bg-kidville-success/15 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-kidville-success" />
            </div>
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
              Modulo firmato!
            </h3>
            <p className="font-maven text-sm text-gray-500 mt-1">
              La firma elettronica è stata registrata con successo.
            </p>
          </div>
        ) : (
          <div>
            <div className="w-12 h-12 rounded-2xl bg-kidville-green/10 flex items-center justify-center mb-4">
              <ShieldCheck className="w-6 h-6 text-kidville-green" />
            </div>
            <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
              Firma elettronica
            </h3>
            <p className="flex items-center gap-1.5 font-maven text-sm text-gray-500 mt-1.5">
              <Mail className="w-3.5 h-3.5 flex-shrink-0" />
              Codice inviato a{' '}
              <span className="text-kidville-green font-semibold">{email ?? 'la tua email'}</span>
            </p>

            {devCode && (
              <p className="mt-3 px-3 py-2 rounded-lg bg-kidville-yellow-light border border-kidville-yellow/40 text-xs text-kidville-green">
                Dev: codice <span className="font-mono font-bold tracking-widest">{devCode}</span>
              </p>
            )}

            <input
              ref={inputRef}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleVerify()}
              inputMode="numeric"
              placeholder="••••••"
              className="mt-5 w-full px-4 py-4 rounded-xl bg-kidville-cream border-2 border-kidville-green/15 text-center text-2xl font-mono tracking-[0.5em] text-kidville-green placeholder-kidville-green/30 focus:outline-none focus:border-kidville-green transition-all"
            />

            {error && (
              <p className="flex items-center gap-1.5 text-xs text-kidville-error mt-2">
                <AlertCircle className="w-3.5 h-3.5" />
                {error}
              </p>
            )}

            <button
              onClick={handleVerify}
              disabled={verifying || code.length !== 6}
              className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all"
            >
              {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Firma e completa
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
