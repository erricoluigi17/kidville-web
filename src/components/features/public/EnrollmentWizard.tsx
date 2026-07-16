'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { extractEnrollmentTemplates } from '@/lib/forms/enrollment-default-schema'
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { logClient } from '@/lib/logging/client'
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
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
    errors,
  )
}

export function EnrollmentWizard({ scuolaId = null }: { scuolaId?: string | null } = {}) {
  const [childCount, setChildCount] = useState(1)
  const [adultCount, setAdultCount] = useState(1)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  // Campi del modulo: default = template; se la segreteria ha modificato il
  // "Modulo d'iscrizione standard" nel builder, il wizard riflette lo schema.
  const [childFields, setChildFields] = useState<FormField[]>(CHILD_FIELDS)
  const [adultFields, setAdultFields] = useState<FormField[]>(ADULT_FIELDS)

  useEffect(() => {
    fetch('/api/iscrizione/model')
      .then(r => r.json())
      .then(d => {
        const { child, adult } = extractEnrollmentTemplates(d?.schema)
        setChildFields(child)
        setAdultFields(adult)
      })
      .catch(() => {})
  }, [])

  const {
    register, control, trigger, getValues, setValue, setFocus, setError,
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

  // Campi (namespacizzati) dell'istanza corrente. Le pagine bambino/adulto sono
  // template RIPETIBILI: ogni figlio/adulto ha i propri campi `children.i.*` /
  // `adults.i.*`, e la validazione va applicata all'istanza mostrata.
  function currentNsFields(): FormField[] {
    if (current.kind === 'child') return nsFields(`children.${current.index}`, childFields)
    if (current.kind === 'adult') return nsFields(`adults.${current.index}`, adultFields)
    return []
  }

  /**
   * Mappa gli errori per-campo del server (400 `{ campi: { children: { i: { id: msg } }, adults: {…} } }`)
   * sulla stessa UI degli errori client, e porta l'utente all'istanza in errore.
   */
  function mappaErroriServer(campi: unknown): boolean {
    if (campi === null || typeof campi !== 'object') return false
    const c = campi as {
      children?: Record<string, Record<string, string>>
      adults?: Record<string, Record<string, string>>
    }
    let primoStep = -1
    const applica = (
      gruppo: 'children' | 'adults',
      mappa: Record<string, Record<string, string>> | undefined,
      stepDi: (i: number) => number,
    ): void => {
      if (mappa === null || mappa === undefined || typeof mappa !== 'object') return
      for (const [idxStr, campiRec] of Object.entries(mappa)) {
        const i = Number(idxStr)
        if (!Number.isInteger(i) || campiRec === null || typeof campiRec !== 'object') continue
        for (const [campoId, msg] of Object.entries(campiRec)) {
          if (typeof msg !== 'string' || msg.length === 0) continue
          setError(`${gruppo}.${i}.${campoId}`, { type: 'server', message: msg })
          const s = stepDi(i)
          if (primoStep === -1 || s < primoStep) primoStep = s
        }
      }
    }
    applica('children', c.children, i => i)
    applica('adults', c.adults, i => childCount + i)
    if (primoStep === -1) return false
    if (primoStep !== step) {
      setDirection(primoStep < step ? -1 : 1)
      setStep(primoStep)
    }
    return true
  }

  async function goNext() {
    const fields = currentNsFields()
    // Provincia: normalizza i nomi riconosciuti in sigla PRIMA di validare
    // ("Napoli" → "NA"), così passa anche senza blur; l'irriconoscibile resta e
    // la validazione lo blocca.
    for (const f of fields) {
      if (!isProvinceField(f)) continue
      const raw = getValues(f.id)
      if (raw === null || raw === undefined || String(raw).trim() === '') continue
      const sigla = normalizzaProvincia(raw)
      if (sigla && sigla !== raw) setValue(f.id, sigla, { shouldValidate: false })
    }

    const valid = await trigger(fields.map(f => f.id))
    if (!valid) {
      const primo = fields.find(f => validateField(f, getValues(f.id)))
      if (primo) setFocus(primo.id)
      return
    }
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
        body: JSON.stringify({ data, scuola_id: scuolaId ?? undefined }),
      })
      const json = await res.json()
      if (!res.ok) {
        // Il server riverifica e risponde 400 con gli errori per campo: mappali
        // sui campi (stessa UI del client) e riporta l'utente all'istanza in errore,
        // invece di un alert generico.
        if (res.status === 400 && mappaErroriServer(json?.campi)) return
        throw new Error(json.error ?? 'Invio fallito')
      }
      setDone(true)
    } catch (err) {
      // Un catch che risponde con un alert deve loggare: `withRoute` è lato server
      // e non vede questa eccezione. `logClient` redige il path e non lancia.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `invio iscrizione fallito — ${err instanceof Error ? err.message : 'errore sconosciuto'}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
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
        {/* Brand header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-xs text-kidville-yellow-dark mb-2">
            <UserPlus className="w-3.5 h-3.5" />
            <span className="uppercase tracking-widest font-semibold">Iscrizione Nuovo Alunno</span>
          </div>
          {!done && (
            <p className="text-xs text-kidville-muted font-medium">
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
            <div className="w-16 h-16 rounded-2xl bg-kidville-success-soft flex items-center justify-center mb-4">
              <PartyPopper className="w-8 h-8 text-kidville-success" />
            </div>
            <h2 className="text-xl font-semibold text-kidville-green">Richiesta inviata!</h2>
            <p className="text-sm text-kidville-muted mt-1.5 max-w-sm">
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
                    <div className="w-9 h-9 rounded-xl bg-kidville-success-soft flex items-center justify-center flex-shrink-0">
                      <HeadIcon className="w-4.5 h-4.5 text-kidville-success" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-kidville-green leading-tight">{heading.title}</h2>
                      <p className="text-sm text-kidville-muted">{heading.sub}</p>
                    </div>
                  </div>

                  {/* CHILD step */}
                  {current.kind === 'child' && (
                    <div className="space-y-6">
                      {nsFields(`children.${current.index}`, childFields).map(f => (
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
                              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-kidville-success-soft border border-kidville-success/30 text-kidville-success text-sm font-medium hover:bg-kidville-success-soft transition-all"
                            >
                              <Plus className="w-4 h-4" /> Aggiungi un altro figlio
                            </button>
                          )}
                          {childCount > 1 && current.index === childCount - 1 && (
                            <button
                              type="button"
                              onClick={() => { setChildCount(c => c - 1); setStep(s => Math.max(0, s - 1)) }}
                              className="flex items-center gap-2 px-3 py-2 rounded-xl text-kidville-muted hover:text-kidville-error text-sm transition-all"
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
                        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-kidville-info-soft border border-kidville-info/20">
                          <Info className="w-4 h-4 text-kidville-info flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-kidville-info leading-relaxed">
                            È obbligatorio almeno un adulto. Se sei già genitore di un bambino iscritto,
                            usa lo stesso codice fiscale: il nuovo figlio verrà collegato automaticamente
                            alla tua anagrafica.
                          </p>
                        </div>
                      )}
                      {nsFields(`adults.${current.index}`, adultFields).map(f => (
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
                              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-kidville-success-soft border border-kidville-success/30 text-kidville-success text-sm font-medium hover:bg-kidville-success-soft transition-all"
                            >
                              <Plus className="w-4 h-4" /> Aggiungi adulto / tutore
                            </button>
                          )}
                          {adultCount > 1 && current.index === adultCount - 1 && (
                            <button
                              type="button"
                              onClick={() => { setAdultCount(a => a - 1); setStep(s => Math.max(0, s - 1)) }}
                              className="flex items-center gap-2 px-3 py-2 rounded-xl text-kidville-muted hover:text-kidville-error text-sm transition-all"
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
                      <div className="px-4 py-3 rounded-xl bg-white border border-kidville-line">
                        <p className="text-sm text-kidville-ink">
                          Stai iscrivendo <span className="text-kidville-success font-semibold">{childCount}</span>
                          {childCount === 1 ? ' bambino' : ' bambini'} con
                          <span className="text-kidville-success font-semibold"> {adultCount}</span>
                          {adultCount === 1 ? ' adulto' : ' adulti'} di riferimento.
                        </p>
                      </div>
                      <p className="text-xs text-kidville-muted leading-relaxed">
                        Premi <strong className="text-kidville-ink">Invia richiesta</strong> per trasmettere
                        i dati alla segreteria. Riceverai conferma e credenziali di accesso dopo la verifica.
                      </p>
                    </div>
                  )}
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
                <ArrowLeft className="w-4 h-4" /> Indietro
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
