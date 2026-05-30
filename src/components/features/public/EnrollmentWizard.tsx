'use client'

import { useMemo, useState } from 'react'
import { useForm, FieldValues } from 'react-hook-form'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Check, Loader2, PartyPopper, Baby, Users,
  Plus, Trash2, UserPlus, Info,
} from 'lucide-react'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import {
  CHILD_FIELDS, ADULT_FIELDS, ENROLLMENT_LIMITS,
} from '@/lib/forms/enrollment-template'
import type { FormField, EnrollmentSubmissionData } from '@/types/database.types'

const UPLOAD_ENDPOINT = '/api/iscrizione/upload'

const slide = {
  enter: (dir: number) => ({ x: dir > 0 ? 64 : -64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -64 : 64, opacity: 0 }),
}

type Step =
  | { kind: 'child'; index: number }
  | { kind: 'adult'; index: number }
  | { kind: 'review' }

function nsFields(prefix: string, fields: FormField[]): FormField[] {
  return fields.map(f => ({ ...f, id: `${prefix}.${f.id}` }))
}

function resolveError(errors: FieldValues, path: string): unknown {
  return path.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), errors)
}

export function EnrollmentWizard() {
  const [childCount, setChildCount] = useState(1)
  const [adultCount, setAdultCount] = useState(1)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const {
    register, control, trigger, getValues,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })

  const steps: Step[] = useMemo(() => {
    const s: Step[] = []
    for (let i = 0; i < childCount; i++) s.push({ kind: 'child', index: i })
    for (let i = 0; i < adultCount; i++) s.push({ kind: 'adult', index: i })
    s.push({ kind: 'review' })
    return s
  }, [childCount, adultCount])

  const current = steps[Math.min(step, steps.length - 1)]
  const isLast = step === steps.length - 1
  const progress = ((step + 1) / steps.length) * 100

  function currentFieldNames(): string[] {
    if (current.kind === 'child') return nsFields(`children.${current.index}`, CHILD_FIELDS).map(f => f.id)
    if (current.kind === 'adult') return nsFields(`adults.${current.index}`, ADULT_FIELDS).map(f => f.id)
    return []
  }

  async function goNext() {
    const valid = await trigger(currentFieldNames())
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
    try {
      const all = getValues()
      const children = (all.children ?? []).slice(0, childCount).filter(Boolean)
      const adults = (all.adults ?? []).slice(0, adultCount).filter(Boolean)
      const data: EnrollmentSubmissionData = { children, adults }

      const res = await fetch('/api/iscrizione', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Invio fallito')
      setDone(true)
    } catch (err) {
      console.error('Errore invio iscrizione:', err)
      alert('Si è verificato un errore durante l\'invio. Controlla i dati e riprova.')
    } finally {
      setSubmitting(false)
    }
  }

  function addChild() {
    if (childCount >= ENROLLMENT_LIMITS.maxChildren) return
    setChildCount(c => c + 1)
    setDirection(1)
    setStep(childCount) // vai alla nuova pagina figlio (inserita in coda ai figli)
  }
  function addAdult() {
    if (adultCount >= ENROLLMENT_LIMITS.maxAdults) return
    setAdultCount(a => a + 1)
    setDirection(1)
    setStep(childCount + adultCount) // nuova pagina adulto
  }

  // Header dinamico
  const heading =
    current.kind === 'child'
      ? { icon: Baby, title: `Bambino ${current.index + 1}`, sub: 'Dati anagrafici del minore' }
      : current.kind === 'adult'
      ? { icon: Users, title: `Adulto ${current.index + 1}${current.index === 0 ? ' (obbligatorio)' : ''}`, sub: 'Genitore, tutore o delegato' }
      : { icon: Check, title: 'Riepilogo', sub: 'Controlla e invia la richiesta' }

  const HeadIcon = heading.icon

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
        {/* Brand header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-xs text-emerald-400/80 mb-2">
            <UserPlus className="w-3.5 h-3.5" />
            <span className="uppercase tracking-widest font-semibold">Iscrizione Nuovo Alunno</span>
          </div>
          {!done && (
            <p className="text-xs text-slate-500 font-medium">
              Passo {step + 1} di {steps.length}
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
            <h2 className="text-xl font-semibold text-white">Richiesta inviata!</h2>
            <p className="text-sm text-slate-400 mt-1.5 max-w-sm">
              La tua richiesta di iscrizione è stata ricevuta. La segreteria la esaminerà e ti
              contatterà con le credenziali di accesso.
            </p>
          </motion.div>
        ) : (
          <>
            <div className="flex-1 relative overflow-hidden">
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={`${current.kind}-${current.kind === 'review' ? 'r' : current.index}`}
                  custom={direction}
                  variants={slide}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ type: 'spring', damping: 30, stiffness: 260, opacity: { duration: 0.2 } }}
                >
                  {/* Step header */}
                  <div className="mb-5 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
                      <HeadIcon className="w-4.5 h-4.5 text-emerald-400" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-white leading-tight">{heading.title}</h2>
                      <p className="text-sm text-slate-400">{heading.sub}</p>
                    </div>
                  </div>

                  {/* CHILD step */}
                  {current.kind === 'child' && (
                    <div className="space-y-6">
                      {nsFields(`children.${current.index}`, CHILD_FIELDS).map(f => (
                        <FieldRenderer
                          key={f.id}
                          field={f}
                          modelId="iscrizioni"
                          register={register}
                          control={control}
                          error={resolveError(errors, f.id)}
                          uploadEndpoint={UPLOAD_ENDPOINT}
                        />
                      ))}
                      {current.index === childCount - 1 && (
                        <div className="flex items-center gap-3 pt-2">
                          {childCount < ENROLLMENT_LIMITS.maxChildren && (
                            <button
                              type="button"
                              onClick={addChild}
                              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-sm font-medium hover:bg-emerald-500/15 transition-all"
                            >
                              <Plus className="w-4 h-4" /> Aggiungi un altro figlio
                            </button>
                          )}
                          {childCount > 1 && current.index === childCount - 1 && (
                            <button
                              type="button"
                              onClick={() => { setChildCount(c => c - 1); setStep(s => Math.max(0, s - 1)) }}
                              className="flex items-center gap-2 px-3 py-2 rounded-xl text-slate-500 hover:text-rose-400 text-sm transition-all"
                            >
                              <Trash2 className="w-4 h-4" /> Rimuovi
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ADULT step */}
                  {current.kind === 'adult' && (
                    <div className="space-y-6">
                      {current.index === 0 && (
                        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-sky-500/[0.07] border border-sky-500/20">
                          <Info className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-sky-200/80 leading-relaxed">
                            È obbligatorio almeno un adulto. Se sei già genitore di un bambino iscritto,
                            usa lo stesso codice fiscale: il nuovo figlio verrà collegato automaticamente
                            alla tua anagrafica.
                          </p>
                        </div>
                      )}
                      {nsFields(`adults.${current.index}`, ADULT_FIELDS).map(f => (
                        <FieldRenderer
                          key={f.id}
                          field={f}
                          modelId="iscrizioni"
                          register={register}
                          control={control}
                          error={resolveError(errors, f.id)}
                          uploadEndpoint={UPLOAD_ENDPOINT}
                        />
                      ))}
                      {current.index === adultCount - 1 && (
                        <div className="flex items-center gap-3 pt-2">
                          {adultCount < ENROLLMENT_LIMITS.maxAdults && (
                            <button
                              type="button"
                              onClick={addAdult}
                              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-sm font-medium hover:bg-emerald-500/15 transition-all"
                            >
                              <Plus className="w-4 h-4" /> Aggiungi adulto / tutore
                            </button>
                          )}
                          {adultCount > 1 && current.index === adultCount - 1 && (
                            <button
                              type="button"
                              onClick={() => { setAdultCount(a => a - 1); setStep(s => Math.max(0, s - 1)) }}
                              className="flex items-center gap-2 px-3 py-2 rounded-xl text-slate-500 hover:text-rose-400 text-sm transition-all"
                            >
                              <Trash2 className="w-4 h-4" /> Rimuovi
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* REVIEW step */}
                  {current.kind === 'review' && (
                    <div className="space-y-4">
                      <div className="px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10">
                        <p className="text-sm text-slate-300">
                          Stai iscrivendo <span className="text-emerald-400 font-semibold">{childCount}</span>
                          {childCount === 1 ? ' bambino' : ' bambini'} con
                          <span className="text-emerald-400 font-semibold"> {adultCount}</span>
                          {adultCount === 1 ? ' adulto' : ' adulti'} di riferimento.
                        </p>
                      </div>
                      <p className="text-xs text-slate-500 leading-relaxed">
                        Premi <strong className="text-slate-300">Invia richiesta</strong> per trasmettere
                        i dati alla segreteria. Riceverai conferma e credenziali di accesso dopo la verifica.
                      </p>
                    </div>
                  )}
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
                <ArrowLeft className="w-4 h-4" /> Indietro
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
                  {submitting ? 'Invio…' : isLast ? 'Invia richiesta' : 'Avanti'}
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
