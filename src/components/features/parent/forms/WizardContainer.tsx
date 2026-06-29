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
import { campoVisibile, pulisciNascosti, type FormValues } from '@/lib/forms/conditional'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

interface Props {
  modelId: string
  title: string
  description: string | null
  schema: FormSchemaConfig
  requiresSignature: boolean
  /** Modalità firma del modello: `joint` = firma congiunta dei due genitori (DL-031). */
  signatureMode?: 'single' | 'joint'
  userId: string | null
  parentEmail: string | null
  /** Se valorizzato: modalità PUBBLICA (modello pubblicato) — submit/upload
   *  token-scoped e anonimi, firma OTP disattivata (DL-030). */
  publicToken?: string
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
  signatureMode = 'single',
  userId,
  parentEmail,
  publicToken,
}: Props) {
  const router = useRouter()
  const pages = schema.pages ?? []
  // In modalità pubblica la firma OTP è disattivata (nessuna identità/email).
  const useSignature = requiresSignature && !publicToken
  const uploadEndpoint = publicToken
    ? `/api/public/forms/${publicToken}/upload`
    : '/api/forms/upload'
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
    const values = getValues() as FormValues
    // Valida solo i campi non-decorativi e attualmente VISIBILI (DL-024):
    // un campo nascosto, anche se "obbligatorio", non blocca l'avanzamento.
    const fieldIds = currentPage.fields
      .filter(f => !['section_header', 'paragraph', 'signature'].includes(f.type))
      .filter(f => campoVisibile(f, values))
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
    // Rimuove i valori dei campi nascosti dalla logica condizionale (DL-024).
    const data = pulisciNascosti(pages, getValues() as FormValues) as FormSubmissionData

    try {
      if (useSignature) {
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
        // Nessuna firma: salva via endpoint server-role (l'insert client-side è
        // bloccato dalla RLS di form_submissions; il server registra anche lo
        // snapshot consensi — DL-029). In modalità pubblica → endpoint token-scoped
        // anonimo (DL-030).
        const endpoint = publicToken
          ? `/api/public/forms/${publicToken}/submit`
          : '/api/forms/submit'
        const body = publicToken ? { data } : { modelId, userId, data }
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Invio fallito')
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
      <div className="min-h-screen flex items-center justify-center bg-kidville-cream">
        <p className="font-maven text-kidville-muted">Questo modulo non contiene pagine.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-kidville-cream text-kidville-ink">
      {/* Progress bar */}
      <div className="h-1 w-full bg-kidville-cream-dark">
        <motion.div
          className="h-full bg-kidville-green"
          initial={false}
          animate={{ width: `${progress}%` }}
          transition={{ type: 'spring', damping: 30, stiffness: 200 }}
        />
      </div>

      <div className="flex-1 w-full max-w-2xl mx-auto px-5 py-8 flex flex-col">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-xs text-kidville-muted mb-2">
            <FileText className="w-3.5 h-3.5" />
            <span className="font-barlow uppercase tracking-widest font-bold text-kidville-green">{title}</span>
          </div>
          {!done && (
            <p className="font-maven text-xs text-kidville-yellow-dark font-semibold">
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
            <div className="w-16 h-16 rounded-2xl bg-kidville-success-soft flex items-center justify-center mb-4">
              <PartyPopper className="w-8 h-8 text-kidville-success" />
            </div>
            <h2 className="font-barlow text-xl font-black uppercase text-kidville-green">Modulo inviato!</h2>
            <p className="font-maven text-sm text-kidville-muted mt-1.5 max-w-xs">
              La tua compilazione è stata registrata correttamente.
            </p>
            <button
              onClick={() => router.push('/parent/modulistica')}
              className="mt-6 px-5 py-2.5 rounded-pill bg-kidville-green-soft text-kidville-green font-barlow font-bold text-sm uppercase tracking-wide hover:bg-kidville-green hover:text-kidville-yellow transition-all"
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
                    <h2 className="font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">{currentPage.title}</h2>
                    {currentPage.description && (
                      <p className="font-maven text-sm text-kidville-muted mt-1">{currentPage.description}</p>
                    )}
                  </div>
                  <StepRenderer
                    page={currentPage}
                    modelId={modelId}
                    register={register}
                    control={control}
                    errors={errors}
                    uploadEndpoint={uploadEndpoint}
                  />
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Navigation */}
            <div className="flex items-center justify-between gap-3 pt-6 mt-4 border-t border-kidville-line">
              <button
                onClick={goPrev}
                disabled={step === 0 || submitting}
                className="flex items-center gap-2 px-4 py-2.5 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm text-kidville-muted hover:text-kidville-green hover:bg-kidville-green-soft disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                Indietro
              </button>

              <button
                onClick={goNext}
                disabled={submitting}
                className="flex items-center gap-2 px-6 py-2.5 rounded-pill bg-kidville-green hover:bg-kidville-green-dark disabled:opacity-50 text-kidville-yellow font-barlow font-bold uppercase tracking-wide text-sm transition-all"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isLast ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <ArrowRight className="w-4 h-4 order-2" />
                )}
                <span className={isLast || submitting ? '' : 'order-1'}>
                  {submitting ? 'Invio…' : isLast ? (useSignature ? 'Firma il modulo' : 'Invia') : 'Avanti'}
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
          signatureMode={signatureMode}
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
