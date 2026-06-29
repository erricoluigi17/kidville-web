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
  { v: 'lista_attesa', label: "Lista d'attesa", color: 'rgba(230,114,10,0.85)' },
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
                border: '1px solid #EFE7DC',
                backdropFilter: 'blur(28px)',
                boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
              }}
            >
              {/* Header */}
              <div
                className="flex items-start justify-between px-6 py-5"
                style={{ borderBottom: '1px solid #EFE7DC' }}
              >
                <div>
                  <h2 className="text-kidville-green font-semibold text-base">Regola punteggio</h2>
                  <p className="text-kidville-muted text-sm mt-0.5">{label}</p>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded-lg text-kidville-muted hover:text-kidville-green hover:bg-white/[0.08] transition-all"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              {/* Score breakdown */}
              <div className="px-6 py-4 flex items-center justify-between text-sm">
                <span className="text-kidville-muted">Punteggio base</span>
                <span className="text-kidville-ink tabular-nums">{baseScore}</span>
              </div>
              <div className="px-6 -mt-2 pb-2 flex items-center justify-between text-sm">
                <span className="text-kidville-muted">Modifiche manuali</span>
                <span
                  className={`tabular-nums ${manualTotal > 0 ? 'text-kidville-success' : manualTotal < 0 ? 'text-kidville-error' : 'text-kidville-muted'}`}
                >
                  {manualTotal > 0 ? `+${manualTotal}` : manualTotal}
                </span>
              </div>
              <div
                className="px-6 py-3 flex items-center justify-between"
                style={{ borderTop: '1px solid #FFFFFF', borderBottom: '1px solid #FFFFFF' }}
              >
                <span className="text-kidville-ink text-sm font-medium">Totale attuale</span>
                <span className="text-kidville-success text-lg font-bold tabular-nums">
                  {submission.score}
                </span>
              </div>

              {/* Esito ammissione (override DL-025) */}
              <div className="px-6 py-3" style={{ borderBottom: '1px solid #FFFFFF' }}>
                <label className="block text-[11px] font-bold text-kidville-muted uppercase tracking-widest mb-2">
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
                          background: active ? e.color : '#FFFFFF',
                          color: active ? '#FEF1E4' : 'rgba(203,213,225,0.9)',
                          border: `1px solid ${active ? e.color : '#EFE7DC'}`,
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
                        className={`font-mono font-bold tabular-nums shrink-0 ${adj.delta >= 0 ? 'text-kidville-success' : 'text-kidville-error'}`}
                      >
                        {adj.delta >= 0 ? `+${adj.delta}` : adj.delta}
                      </span>
                      <span className="text-kidville-muted leading-snug">{adj.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* New adjustment form */}
              <div className="px-6 py-4 space-y-4" style={{ borderTop: '1px solid #EFE7DC' }}>
                <div>
                  <label className="block text-[11px] font-bold text-kidville-muted uppercase tracking-widest mb-2">
                    Bonus / Malus
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setDelta(d => d - 1)}
                      className="p-2 rounded-lg text-kidville-muted transition-all"
                      style={{ background: '#FFFFFF', border: '1px solid #EFE7DC' }}
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <input
                      type="number"
                      value={delta}
                      onChange={e => setDelta(parseInt(e.target.value || '0', 10))}
                      className="flex-1 text-center py-2 rounded-lg text-kidville-green text-lg font-bold tabular-nums focus:outline-none"
                      style={{ background: '#FFFFFF', border: '1px solid #EFE7DC' }}
                    />
                    <button
                      onClick={() => setDelta(d => d + 1)}
                      className="p-2 rounded-lg text-kidville-muted transition-all"
                      style={{ background: '#FFFFFF', border: '1px solid #EFE7DC' }}
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-kidville-muted uppercase tracking-widest mb-2">
                    Motivazione
                  </label>
                  <div className="relative">
                    <ScrollText className="absolute left-3 top-3 w-4 h-4 text-kidville-muted pointer-events-none" />
                    <textarea
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      rows={2}
                      placeholder="Es. Fratello già frequentante"
                      className="w-full pl-9 pr-3 py-2.5 rounded-lg text-kidville-ink placeholder-kidville-muted text-sm resize-none focus:outline-none"
                      style={{ background: '#FFFFFF', border: '1px solid #EFE7DC' }}
                    />
                  </div>
                </div>

                {error && <p className="text-kidville-error text-xs">{error}</p>}
              </div>

              {/* Footer */}
              <div
                className="px-6 py-4 flex gap-3"
                style={{ borderTop: '1px solid #EFE7DC' }}
              >
                <button
                  onClick={handleClose}
                  className="flex-1 px-4 py-2.5 rounded-xl text-kidville-muted text-sm font-medium transition-all"
                  style={{ background: '#FFFFFF', border: '1px solid #EFE7DC' }}
                >
                  Annulla
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-kidville-green text-sm font-medium transition-all disabled:opacity-50"
                  style={{ background: 'rgba(0,106,95,0.8)', border: '1px solid rgba(0,106,95,0.25)' }}
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
