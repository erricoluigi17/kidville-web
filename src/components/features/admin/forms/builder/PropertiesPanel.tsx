'use client'

import { Settings, Plus, X, Star } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { FormField, FormFieldOption } from '@/types/database.types'

const HAS_OPTIONS = new Set(['select', 'radio', 'checkbox'])

interface Props {
  field: FormField | null
  onChange: (updated: FormField) => void
}

export function PropertiesPanel({ field, onChange }: Props) {
  function patch(delta: Partial<FormField>) {
    if (!field) return
    onChange({ ...field, ...delta })
  }

  function setOptionLabel(idx: number, label: string) {
    if (!field?.options) return
    const options = field.options.map((o, i) =>
      i === idx ? { ...o, label, value: label.toLowerCase().replace(/\s+/g, '_') } : o
    )
    patch({ options })
  }

  function setOptionPoints(idx: number, points: number) {
    if (!field?.options) return
    const options = field.options.map((o, i) => (i === idx ? { ...o, points } : o))
    patch({ options })
  }

  function addOption() {
    if (!field) return
    const idx = (field.options?.length ?? 0) + 1
    const newOpt: FormFieldOption = { label: `Opzione ${idx}`, value: `opt${idx}` }
    patch({ options: [...(field.options ?? []), newOpt] })
  }

  function removeOption(idx: number) {
    if (!field?.options) return
    patch({ options: field.options.filter((_, i) => i !== idx) })
  }

  return (
    <aside
      className="w-72 flex-shrink-0 overflow-y-auto"
      style={{ background: 'rgba(15,20,40,0.7)', borderLeft: '1px solid rgba(255,255,255,0.07)' }}
    >
      <AnimatePresence mode="wait">
        {field ? (
          <motion.div
            key={field.id}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.18 }}
            className="p-4 space-y-5"
          >
            {/* Header */}
            <div className="flex items-center gap-2 pb-3 border-b border-white/[0.07]">
              <Settings className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Proprietà Campo</span>
            </div>

            {/* Label */}
            <section className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                Etichetta
              </label>
              <input
                value={field.label}
                onChange={e => patch({ label: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 focus:bg-indigo-500/5 transition-all"
                placeholder="Nome del campo…"
              />
            </section>

            {/* Placeholder */}
            {['text', 'textarea', 'number', 'email', 'phone'].includes(field.type) && (
              <section className="space-y-1.5">
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  Testo Segnaposto
                </label>
                <input
                  value={field.placeholder ?? ''}
                  onChange={e => patch({ placeholder: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 transition-all"
                  placeholder="Es: Inserisci il nome…"
                />
              </section>
            )}

            {/* Required */}
            <section className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium text-slate-300">Obbligatorio</p>
                <p className="text-[11px] text-slate-600 mt-0.5">Blocca il wizard se vuoto</p>
              </div>
              <button
                onClick={() => patch({ required: !field.required })}
                className={`relative w-10 h-5.5 rounded-full transition-all ${
                  field.required ? 'bg-indigo-500' : 'bg-white/10'
                }`}
                style={{ width: 40, height: 22 }}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform ${
                    field.required ? 'translate-x-[18px]' : 'translate-x-0'
                  }`}
                  style={{ width: 18, height: 18 }}
                />
              </button>
            </section>

            {/* Scoring */}
            {!HAS_OPTIONS.has(field.type) && (
              <section className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Star className="w-3.5 h-3.5 text-amber-400" />
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                    Punteggio Graduatoria
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={field.points ?? 0}
                    onChange={e => patch({ points: Number(e.target.value) })}
                    className="w-24 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-amber-500/60 transition-all text-right tabular-nums"
                  />
                  <span className="text-xs text-slate-600">punti</span>
                </div>
              </section>
            )}

            {/* Options (for select / radio / checkbox) */}
            {HAS_OPTIONS.has(field.type) && (
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 mb-2">
                  <Star className="w-3.5 h-3.5 text-amber-400" />
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                    Opzioni &amp; Punteggi
                  </label>
                </div>
                <div className="space-y-2">
                  {(field.options ?? []).map((opt, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        value={opt.label}
                        onChange={e => setOptionLabel(idx, e.target.value)}
                        placeholder={`Opzione ${idx + 1}`}
                        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 transition-all"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={opt.points ?? 0}
                        onChange={e => setOptionPoints(idx, Number(e.target.value))}
                        title="Punti graduatoria"
                        className="w-14 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-300 focus:outline-none focus:border-amber-500/60 transition-all text-center tabular-nums"
                      />
                      <button
                        onClick={() => removeOption(idx)}
                        className="flex-shrink-0 p-1 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-rose-400/10 transition-all"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addOption}
                  className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors mt-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Aggiungi opzione
                </button>
                <p className="text-[10px] text-slate-700 leading-relaxed">
                  Il numero in arancio è il punteggio assegnato se l&apos;utente sceglie quella voce.
                </p>
              </section>
            )}

            {/* Mapping ETL (read-only, solo se presente) */}
            {field.db_mapping && (
              <div className="pt-3 border-t border-white/[0.05]">
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  Mapping ETL
                </p>
                <p className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 rounded-lg">
                  {field.db_mapping}
                </p>
                <p className="text-[10px] text-slate-700 mt-1.5 leading-relaxed">
                  Aggiorna automaticamente l&apos;anagrafica alla compilazione.
                </p>
              </div>
            )}

            {/* Field type (read-only) */}
            <div className="pt-3 border-t border-white/[0.05]">
              <p className="text-[10px] text-slate-700">
                Tipo campo: <span className="text-slate-500 font-mono">{field.type}</span>
              </p>
              <p className="text-[10px] text-slate-700 mt-0.5">
                ID: <span className="font-mono text-slate-700">{field.id.slice(0, 8)}…</span>
              </p>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center mb-3">
              <Settings className="w-5 h-5 text-slate-600" />
            </div>
            <p className="text-sm font-medium text-slate-600">Nessun campo selezionato</p>
            <p className="text-xs text-slate-700 mt-1 leading-relaxed">
              Clicca su un campo nel canvas per modificarne le proprietà.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  )
}
