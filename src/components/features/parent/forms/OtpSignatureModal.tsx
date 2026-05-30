'use client'

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ShieldCheck, Loader2, AlertCircle, Mail, X, CheckCircle2 } from 'lucide-react'

interface Props {
  open: boolean
  submissionId: string
  email: string | null
  devCode?: string
  onClose: () => void
  onSigned: () => void
}

export function OtpSignatureModal({
  open,
  submissionId,
  email,
  devCode,
  onClose,
  onSigned,
}: Props) {
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setCode('')
      setError(null)
      setSuccess(false)
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
    try {
      const res = await fetch('/api/forms/send-otp', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId, code }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Verifica fallita')
        return
      }
      setSuccess(true)
      setTimeout(onSigned, 1400)
    } catch {
      setError('Errore di rete. Riprova.')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          style={{ background: 'rgba(3,7,18,0.75)', backdropFilter: 'blur(8px)' }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ type: 'spring', damping: 24, stiffness: 300 }}
            className="w-full max-w-sm rounded-3xl p-6 relative"
            style={{
              background: 'rgba(15,23,42,0.9)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 30px 60px rgba(0,0,0,0.5)',
            }}
          >
            {!success && (
              <button
                onClick={onClose}
                className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            <AnimatePresence mode="wait">
              {success ? (
                <motion.div
                  key="ok"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex flex-col items-center text-center py-4"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', damping: 12, stiffness: 200 }}
                    className="w-16 h-16 rounded-2xl bg-emerald-500/15 flex items-center justify-center mb-4"
                  >
                    <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                  </motion.div>
                  <h3 className="text-lg font-semibold text-white">Modulo firmato!</h3>
                  <p className="text-sm text-slate-400 mt-1">
                    La firma elettronica è stata registrata con successo.
                  </p>
                </motion.div>
              ) : (
                <motion.div key="form" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 flex items-center justify-center mb-4">
                    <ShieldCheck className="w-6 h-6 text-emerald-400" />
                  </div>
                  <h3 className="text-lg font-semibold text-white">Firma elettronica</h3>
                  <p className="flex items-center gap-1.5 text-sm text-slate-400 mt-1.5">
                    <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                    Codice inviato a{' '}
                    <span className="text-slate-300">{email ?? 'la tua email'}</span>
                  </p>

                  {devCode && (
                    <p className="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
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
                    className="mt-5 w-full px-4 py-4 rounded-xl bg-white/5 border border-white/10 text-center text-2xl font-mono tracking-[0.5em] text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 transition-all"
                  />

                  {error && (
                    <p className="flex items-center gap-1.5 text-xs text-rose-400 mt-2">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {error}
                    </p>
                  )}

                  <button
                    onClick={handleVerify}
                    disabled={verifying || code.length !== 6}
                    className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold transition-all"
                  >
                    {verifying ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="w-4 h-4" />
                    )}
                    Firma e completa
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
