'use client'

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { motion, AnimatePresence } from 'framer-motion'
import { ShieldCheck, Loader2, AlertCircle, Mail, X, CheckCircle2, Users, RotateCcw } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'

interface Props {
  open: boolean
  submissionId: string
  email: string | null
  devCode?: string
  /** `joint` = firma congiunta: dopo il 1° genitore serve il 2° (DL-031). */
  signatureMode?: 'single' | 'joint'
  onClose: () => void
  onSigned: () => void
}

type Phase = 'code' | 'second-email'

export function OtpSignatureModal({
  open,
  submissionId,
  email,
  devCode,
  signatureMode = 'single',
  onClose,
  onSigned,
}: Props) {
  const t = useTranslations('parentForms')
  const [phase, setPhase] = useState<Phase>('code')
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // Firmatario corrente (1° = genitore loggato; 2° = email raccolta).
  const [signerEmail, setSignerEmail] = useState<string | null>(email)
  const [signerNumber, setSignerNumber] = useState(1)
  const [localDevCode, setLocalDevCode] = useState<string | undefined>(devCode)
  const [secondEmail, setSecondEmail] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      setPhase('code'); setCode(''); setError(null); setSuccess(false)
      setSignerEmail(email); setSignerNumber(1); setLocalDevCode(devCode); setSecondEmail('')
      setResendCooldown(0)
      inputRef.current?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [open, email, devCode])

  // Countdown del cooldown di reinvio.
  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  async function handleVerify() {
    if (code.length !== 6) {
      setError(t('inserisciCodice6'))
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
        // Niente prosa del server: è italiana per costruzione (T10-F1).
        setError(soloCatalogoDaCorpo(json, t('verificaFallita')))
        return
      }
      if (json.completed) {
        setSuccess(true)
        setTimeout(onSigned, 1400)
      } else {
        // Firma congiunta: serve il 2° firmatario.
        setPhase('second-email')
        setCode('')
      }
    } catch {
      setError(t('erroreRete'))
    } finally {
      setVerifying(false)
    }
  }

  // (Re)invia un codice OTP per la submission corrente — reinvio o 2° firmatario.
  async function sendCode(targetEmail?: string) {
    setError(null)
    try {
      const res = await fetch('/api/forms/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId, ...(targetEmail ? { signerEmail: targetEmail } : {}) }),
      })
      const json = await res.json()
      if (!res.ok) {
        // Niente prosa del server: è italiana per costruzione (T10-F1).
        setError(soloCatalogoDaCorpo(json, t('invioNonRiuscito')))
        return false
      }
      setLocalDevCode(json.devCode)
      if (targetEmail) setSignerEmail(targetEmail)
      setResendCooldown(30)
      return true
    } catch {
      setError(t('erroreRete'))
      return false
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return
    await sendCode(signerNumber === 2 ? signerEmail ?? undefined : undefined)
  }

  async function handleSecondSigner() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(secondEmail)) {
      setError(t('emailNonValida'))
      return
    }
    setVerifying(true)
    const ok = await sendCode(secondEmail)
    setVerifying(false)
    if (ok) {
      setSignerNumber(2)
      setPhase('code')
      setCode('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const requestClose = () => { if (!success) onClose() }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={t('firmaElettronica')}
      closeOnBackdrop={false}
      className="w-full max-w-sm rounded-3xl p-6 relative bg-white border border-kidville-green/10 shadow-2xl"
    >
      {!success && (
        <button
          onClick={onClose}
          aria-label={t('chiudi')}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all"
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
              className="w-16 h-16 rounded-2xl bg-kidville-green/10 flex items-center justify-center mb-4"
            >
              <CheckCircle2 className="w-8 h-8 text-kidville-green" />
            </motion.div>
            <h3 className="text-lg font-semibold text-kidville-green">{t('moduloFirmato')}</h3>
            <p className="text-sm text-kidville-muted mt-1">
              {t('firmaRegistrata')}
            </p>
          </motion.div>
        ) : phase === 'second-email' ? (
          <motion.div key="second" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <div className="w-12 h-12 rounded-2xl bg-kidville-green/10 flex items-center justify-center mb-4">
              <Users className="w-6 h-6 text-kidville-green" />
            </div>
            <h3 className="text-lg font-semibold text-kidville-green">{t('firmaCongiunta')}</h3>
            <p className="text-sm text-kidville-muted mt-1.5">
              {t.rich('firmaCongiuntaCorpo', { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <input
              type="email"
              value={secondEmail}
              onChange={e => setSecondEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSecondSigner()}
              placeholder={t('emailSecondoPlaceholder')}
              className="mt-4 w-full px-4 py-3 rounded-xl bg-kidville-cream border border-kidville-green/15 text-kidville-green placeholder-kidville-green/40 focus:outline-none focus:border-kidville-green transition-all"
            />
            {error && (
              <p className="flex items-center gap-1.5 text-xs text-kidville-error mt-2">
                <AlertCircle className="w-3.5 h-3.5" />{error}
              </p>
            )}
            <button
              onClick={handleSecondSigner}
              disabled={verifying}
              className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-kidville-green hover:opacity-90 disabled:opacity-40 text-kidville-yellow font-semibold transition-all"
            >
              {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              {t('inviaCodiceSecondo')}
            </button>
          </motion.div>
        ) : (
          <motion.div key="form" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="w-12 h-12 rounded-2xl bg-kidville-green/10 flex items-center justify-center mb-4">
              <ShieldCheck className="w-6 h-6 text-kidville-green" />
            </div>
            <h3 className="text-lg font-semibold text-kidville-green">
              {t('firmaElettronica')}
              {signatureMode === 'joint' && (
                <span className="ml-2 text-xs font-medium text-kidville-green/60">
                  {t('firmatarioNdi2', { n: signerNumber })}
                </span>
              )}
            </h3>
            <p className="flex items-center gap-1.5 text-sm text-kidville-muted mt-1.5">
              <Mail className="w-3.5 h-3.5 flex-shrink-0" />
              {t('codiceInviatoA')}{' '}
              <span className="text-kidville-green/80">{signerEmail ?? t('laTuaEmail')}</span>
            </p>

            {localDevCode && (
              <p className="mt-3 px-3 py-2 rounded-lg bg-kidville-yellow-light border border-kidville-yellow/40 text-xs text-kidville-green">
                Dev: codice <span className="font-mono font-bold tracking-widest">{localDevCode}</span>
              </p>
            )}

            <input
              ref={inputRef}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => e.key === 'Enter' && handleVerify()}
              inputMode="numeric"
              aria-label={t('ariaCodiceFirma')}
              placeholder="••••••"
              className="mt-5 w-full px-4 py-4 rounded-xl bg-kidville-cream border border-kidville-green/15 text-center text-2xl font-mono tracking-[0.5em] text-kidville-green placeholder-kidville-green/30 focus:outline-none focus:border-kidville-green transition-all"
            />

            {error && (
              <p className="flex items-center gap-1.5 text-xs text-kidville-error mt-2">
                <AlertCircle className="w-3.5 h-3.5" />{error}
              </p>
            )}

            <button
              onClick={handleVerify}
              disabled={verifying || code.length !== 6}
              className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-kidville-green hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-kidville-yellow font-semibold transition-all"
            >
              {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {t('firmaCompleta')}
            </button>

            <button
              onClick={handleResend}
              disabled={resendCooldown > 0}
              className="mt-3 w-full flex items-center justify-center gap-1.5 text-xs text-kidville-green/70 hover:text-kidville-green disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {resendCooldown > 0 ? t('reinviaCodiceTra', { s: resendCooldown }) : t('reinviaCodice')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  )
}
