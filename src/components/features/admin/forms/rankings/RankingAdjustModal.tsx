'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Plus, Minus, Loader2, ScrollText } from 'lucide-react'

export interface ManualAdjustment {
  delta: number
  reason: string
  by?: string | null
  at: string
}

export interface RankingRow {
  id: string
  data: Record<string, unknown>
  score: number
  signed_at: string | null
  manual_adjustments: ManualAdjustment[]
  esito_ammissione?: string | null
}

const ESITI = [
  { v: 'ammesso', label: 'Ammesso', color: 'rgba(52,211,153,0.85)' },
  { v: 'lista_attesa', label: "Lista d'attesa", color: 'rgba(251,191,36,0.85)' },
  { v: 'non_ammesso', label: 'Non ammesso', color: 'rgba(244,114,128,0.85)' },
] as const

interface Props {
  submission: RankingRow | null
  /** Etichetta leggibile del candidato (es. "Rossi Marco") */
  label: string
  onClose: () => void
  onApplied: () => void
}

export function RankingAdjustModal({ submission, label, onClose, onApplied }: Props) {
  const userId = useSearchParams().get('userId') ?? ''
  const [delta, setDelta] = useState(0)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [esitoSaving, setEsitoSaving] = useState(false)

  const existing = submission?.manual_adjustments ?? []

  // Override esito ammissione (DL-025) — forza l'esito di un singolo candidato.
  const setEsito = async (esito: string) => {
    if (!submission) return
    setEsitoSaving(true)
    setError(null)
    const res = await fetch('/api/forms/delibera', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
      body: JSON.stringify({ submissionId: submission.id, esito }),
    })
    setEsitoSaving(false)
    if (res.ok) onApplied()
    else {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Impossibile aggiornare l’esito')
    }
  }

  const reset = () => {
    setDelta(0)
    setReason('')
    setError(null)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const handleSave = async () => {
    if (!submission) return
    if (delta === 0) {
      setError('Inserisci un valore diverso da zero')
      return
    }
    if (!reason.trim()) {
      setError('La motivazione è obbligatoria')
      return
    }

    setSaving(true)
    setError(null)

    const newEntry: ManualAdjustment = {
      delta,
      reason: reason.trim(),
      by: userId || null,
      at: new Date().toISOString(),
    }

    const updated = [...existing, newEntry]

    // L'aggiornamento di manual_adjustments fa ricalcolare score dal trigger BEFORE UPDATE.
    // Via route server gated (requireStaff) + audit, non più dal client anon.
    const res = await fetch(`/api/admin/forms/submissions/${submission.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
      body: JSON.stringify({ manual_adjustments: updated }),
    })

    setSaving(false)

    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Aggiornamento non riuscito')
      return
    }

    reset()
    onApplied()
  }

  const manualTotal = existing.reduce((s, a) => s + a.delta, 0)
  const baseScore = (submission?.score ?? 0) - manualTotal

  return (
    <AnimatePresence>
      {submission && (
        <>
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={handleClose}
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(3, 5, 18, 0.6)' }}
          />

          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2"
          >
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: 'rgba(8, 11, 26, 0.97)',
                border: '1px solid rgba(255,255,255,0.07)',
                backdropFilter: 'blur(28px)',
                boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
              }}
            >
              {/* Header */}
              <div
                className="flex items-start justify-between px-6 py-5"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
              >
                <div>
                  <h2 className="text-white font-semibold text-base">Regola punteggio</h2>
                  <p className="text-slate-500 text-sm mt-0.5">{label}</p>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded-lg text-slate-600 hover:text-white hover:bg-white/[0.08] transition-all"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              {/* Score breakdown */}
              <div className="px-6 py-4 flex items-center justify-between text-sm">
                <span className="text-slate-500">Punteggio base</span>
                <span className="text-slate-300 tabular-nums">{baseScore}</span>
              </div>
              <div className="px-6 -mt-2 pb-2 flex items-center justify-between text-sm">
                <span className="text-slate-500">Modifiche manuali</span>
                <span
                  className={`tabular-nums ${manualTotal > 0 ? 'text-emerald-400' : manualTotal < 0 ? 'text-rose-400' : 'text-slate-500'}`}
                >
                  {manualTotal > 0 ? `+${manualTotal}` : manualTotal}
                </span>
              </div>
              <div
                className="px-6 py-3 flex items-center justify-between"
                style={{ borderTop: '1px solid rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <span className="text-slate-300 text-sm font-medium">Totale attuale</span>
                <span className="text-emerald-400 text-lg font-bold tabular-nums">
                  {submission.score}
                </span>
              </div>

              {/* Esito ammissione (override DL-025) */}
              <div className="px-6 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                  Esito ammissione
                </label>
                <div className="flex gap-2">
                  {ESITI.map(e => {
                    const active = submission.esito_ammissione === e.v
                    return (
                      <button
                        key={e.v}
                        onClick={() => setEsito(e.v)}
                        disabled={esitoSaving}
                        className="flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
                        style={{
                          background: active ? e.color : 'rgba(255,255,255,0.04)',
                          color: active ? '#0b0f1f' : 'rgba(203,213,225,0.9)',
                          border: `1px solid ${active ? e.color : 'rgba(255,255,255,0.08)'}`,
                        }}
                      >
                        {e.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Existing adjustments */}
              {existing.length > 0 && (
                <div className="px-6 py-3 space-y-2 max-h-36 overflow-y-auto">
                  {existing.map((adj, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span
                        className={`font-mono font-bold tabular-nums shrink-0 ${adj.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                      >
                        {adj.delta >= 0 ? `+${adj.delta}` : adj.delta}
                      </span>
                      <span className="text-slate-500 leading-snug">{adj.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* New adjustment form */}
              <div className="px-6 py-4 space-y-4" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                    Bonus / Malus
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setDelta(d => d - 1)}
                      className="p-2 rounded-lg text-slate-400 transition-all"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <input
                      type="number"
                      value={delta}
                      onChange={e => setDelta(parseInt(e.target.value || '0', 10))}
                      className="flex-1 text-center py-2 rounded-lg text-white text-lg font-bold tabular-nums focus:outline-none"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                    />
                    <button
                      onClick={() => setDelta(d => d + 1)}
                      className="p-2 rounded-lg text-slate-400 transition-all"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                    Motivazione
                  </label>
                  <div className="relative">
                    <ScrollText className="absolute left-3 top-3 w-4 h-4 text-slate-700 pointer-events-none" />
                    <textarea
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      rows={2}
                      placeholder="Es. Fratello già frequentante"
                      className="w-full pl-9 pr-3 py-2.5 rounded-lg text-slate-200 placeholder-slate-700 text-sm resize-none focus:outline-none"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                    />
                  </div>
                </div>

                {error && <p className="text-rose-400 text-xs">{error}</p>}
              </div>

              {/* Footer */}
              <div
                className="px-6 py-4 flex gap-3"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
              >
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 rounded-xl text-slate-400 text-sm font-medium transition-all"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  Annulla
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-medium transition-all disabled:opacity-50"
                  style={{ background: 'rgba(99,102,241,0.8)', border: '1px solid rgba(129,140,248,0.25)' }}
                >
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  Applica
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
