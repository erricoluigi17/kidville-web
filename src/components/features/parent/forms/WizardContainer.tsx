'use client'

import { useState } from 'react'
import { useForm, FieldValues } from 'react-hook-form'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, ArrowRight, Check, Loader2, PartyPopper, FileText,
} from 'lucide-react'
import { StepRenderer } from './StepRenderer'
import { OtpSignatureModal } from './OtpSignatureModal'
import { getSupabase } from '@/lib/supabase/browser-client'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

interface Props {
  modelId: string
  title: string
  description: string | null
  schema: FormSchemaConfig
  requiresSignature: boolean
  userId: string | null
  parentEmail: string | null
}

const slide = {
  enter: (dir: number) => ({ x: dir > 0 ? 64 : -64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -64 : 64, opacity: 0 }),
}

export function WizardContainer({
  modelId,
  title,
  description,
  schema,
  requiresSignature,
  userId,
  parentEmail,
}: Props) {
  const router = useRouter()
  const pages = schema.pages ?? []
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [otp, setOtp] = useState<{ submissionId: string; devCode?: string } | null>(null)

  const {
    register,
    control,
    trigger,
    getValues,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })

  const isLast = step === pages.length - 1
  const progress = pages.length > 0 ? ((step + 1) / pages.length) * 100 : 0
  const currentPage = pages[step]

  async function goNext() {
    const fieldIds = currentPage.fields
      .filter(f => !['section_header', 'paragraph', 'signature'].includes(f.type))
      .map(f => f.id)
    const valid = await trigger(fieldIds)
    if (!valid) return

    if (isLast) {
      await handleSubmit()
    } else {
      setDirection(1)
      setStep(s => s + 1)
    }
  }

  function goPrev() {
    setDirection(-1)
    setStep(s => Math.max(0, s - 1))
  }

  async function handleSubmit() {
    setSubmitting(true)
    const data = getValues() as FormSubmissionData

    try {
      if (requiresSignature) {
        // Crea submission (pending_signature) + invia OTP via API server-side
        const res = await fetch('/api/forms/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, userId, data }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Invio OTP fallito')
        setOtp({ submissionId: json.submissionId, devCode: json.devCode })
      } else {
        // Nessuna firma: salva direttamente come completed
        const supabase = getSupabase()
        const { error } = await supabase.from('form_submissions').insert({
          model_id: modelId,
          user_id: userId,
          data,
          status: 'completed',
        })
        if (error) throw error
        setDone(true)
      }
    } catch (err) {
      console.error('Errore invio modulo:', err)
      alert('Si è verificato un errore durante l\'invio. Riprova.')
    } finally {
      setSubmitting(false)
    }
  }

  if (pages.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0b0f1f' }}>
        <p className="text-slate-500">Questo modulo non contiene pagine.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0b0f1f', color: '#f1f5f9' }}>
      {/* Progress bar */}
      <div className="h-1 w-full bg-white/5">
        <motion.div
          className="h-full"
          style={{ background: '#047857' }}
          initial={false}
          animate={{ width: `${progress}%` }}
          transition={{ type: 'spring', damping: 30, stiffness: 200 }}
        />
      </div>

      <div className="flex-1 w-full max-w-2xl mx-auto px-5 py-8 flex flex-col">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
            <FileText className="w-3.5 h-3.5" />
            <span className="uppercase tracking-widest font-medium">{title}</span>
          </div>
          {!done && (
            <p className="text-xs text-emerald-400/70 font-medium">
              Passo {step + 1} di {pages.length}
            </p>
          )}
        </div>

        {done ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 flex flex-col items-center justify-center text-center"
          >
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 flex items-center justify-center mb-4">
              <PartyPopper className="w-8 h-8 text-emerald-400" />
            </div>
            <h2 className="text-xl font-semibold text-white">Modulo inviato!</h2>
            <p className="text-sm text-slate-400 mt-1.5 max-w-xs">
              La tua compilazione è stata registrata correttamente.
            </p>
            <button
              onClick={() => router.push('/parent/modulistica')}
              className="mt-6 px-5 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm font-medium transition-all"
            >
              Torna ai moduli
            </button>
          </motion.div>
        ) : (
          <>
            {/* Animated step */}
            <div className="flex-1 relative overflow-hidden">
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={currentPage.id}
                  custom={direction}
                  variants={slide}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ type: 'spring', damping: 30, stiffness: 260, opacity: { duration: 0.2 } }}
                >
                  <div className="mb-5">
                    <h2 className="text-xl font-semibold text-white">{currentPage.title}</h2>
                    {currentPage.description && (
                      <p className="text-sm text-slate-400 mt-1">{currentPage.description}</p>
                    )}
                  </div>
                  <StepRenderer
                    page={currentPage}
                    modelId={modelId}
                    register={register}
                    control={control}
                    errors={errors}
                  />
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Navigation */}
            <div className="flex items-center justify-between gap-3 pt-6 mt-4 border-t border-white/[0.07]">
              <button
                onClick={goPrev}
                disabled={step === 0 || submitting}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                Indietro
              </button>

              <button
                onClick={goNext}
                disabled={submitting}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold transition-all"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isLast ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <ArrowRight className="w-4 h-4 order-2" />
                )}
                <span className={isLast || submitting ? '' : 'order-1'}>
                  {submitting ? 'Invio…' : isLast ? (requiresSignature ? 'Firma il modulo' : 'Invia') : 'Avanti'}
                </span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* OTP modal */}
      {otp && (
        <OtpSignatureModal
          open={!!otp}
          submissionId={otp.submissionId}
          email={parentEmail}
          devCode={otp.devCode}
          onClose={() => setOtp(null)}
          onSigned={() => {
            setOtp(null)
            setDone(true)
          }}
        />
      )}
    </div>
  )
}
