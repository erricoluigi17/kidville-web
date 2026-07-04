'use client'

import { Settings, Plus, X, Star, GitBranch } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { FormField, FormFieldOption, FormFieldCondition } from '@/types/database.types'

const HAS_OPTIONS = new Set(['select', 'radio', 'checkbox'])

const OPERATORI: { value: FormFieldCondition['operator']; label: string }[] = [
  { value: 'eq', label: 'è uguale a' },
  { value: 'neq', label: 'è diverso da' },
  { value: 'contains', label: 'contiene' },
  { value: 'gt', label: 'è maggiore di' },
  { value: 'lt', label: 'è minore di' },
]

interface Props {
  field: FormField | null
  onChange: (updated: FormField) => void
  /** Altri campi del form referenziabili in una condizione (esclude se stesso). */
  campiDisponibili?: { id: string; label: string }[]
}

export function PropertiesPanel({ field, onChange, campiDisponibili = [] }: Props) {
  function patch(delta: Partial<FormField>) {
    if (!field) return
    onChange({ ...field, ...delta })
  }

  function patchCondition(delta: Partial<FormFieldCondition>) {
    if (!field?.condition) return
    patch({ condition: { ...field.condition, ...delta } })
  }

  function toggleCondition() {
    if (!field) return
    patch({
      condition: field.condition
        ? undefined
        : { field_id: campiDisponibili[0]?.id ?? '', operator: 'eq', value: '' },
    })
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
      style={{ background: '#FFFFFF', borderLeft: '1px solid #EFE7DC' }}
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
            <div className="flex items-center gap-2 pb-3 border-b border-kidville-line">
              <Settings className="w-4 h-4 text-kidville-green" />
              <span className="text-xs font-bold text-kidville-muted uppercase tracking-widest">Proprietà Campo</span>
            </div>

            {/* Label */}
            <section className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                Etichetta
              </label>
              <input
                value={field.label}
                onChange={e => patch({ label: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 focus:bg-kidville-green/5 transition-all"
                placeholder="Nome del campo…"
              />
            </section>

            {/* Placeholder */}
            {['text', 'textarea', 'number', 'email', 'phone'].includes(field.type) && (
              <section className="space-y-1.5">
                <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                  Testo Segnaposto
                </label>
                <input
                  value={field.placeholder ?? ''}
                  onChange={e => patch({ placeholder: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 transition-all"
                  placeholder="Es: Inserisci il nome…"
                />
              </section>
            )}

            {/* Required */}
            <section className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium text-kidville-ink">Obbligatorio</p>
                <p className="text-[11px] text-kidville-muted mt-0.5">Blocca il wizard se vuoto</p>
              </div>
              <button
                onClick={() => patch({ required: !field.required })}
                className={`relative w-10 h-5.5 rounded-full transition-all ${
                  field.required ? 'bg-kidville-green' : 'bg-kidville-cream-dark'
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
            {!HAS_OPTIONS.has(field.type) && field.type !== 'consent' && (
              <section className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Star className="w-3.5 h-3.5 text-kidville-warn" />
                  <label className="text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
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
                    className="w-24 px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green focus:outline-none focus:border-kidville-warn/60 transition-all text-right tabular-nums"
                  />
                  <span className="text-xs text-kidville-muted">punti</span>
                </div>
              </section>
            )}

            {/* Options (for select / radio / checkbox) */}
            {HAS_OPTIONS.has(field.type) && (
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 mb-2">
                  <Star className="w-3.5 h-3.5 text-kidville-warn" />
                  <label className="text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
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
                        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 transition-all"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={opt.points ?? 0}
                        onChange={e => setOptionPoints(idx, Number(e.target.value))}
                        title="Punti graduatoria"
                        className="w-14 px-2 py-1.5 rounded-lg bg-kidville-success-soft border border-kidville-warn/20 text-sm text-kidville-warn focus:outline-none focus:border-kidville-warn/60 transition-all text-center tabular-nums"
                      />
                      <button
                        onClick={() => removeOption(idx)}
                        className="flex-shrink-0 p-1 rounded-lg text-kidville-muted hover:text-kidville-error hover:bg-kidville-error/10 transition-all"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addOption}
                  className="flex items-center gap-1.5 text-xs text-kidville-green hover:text-kidville-info transition-colors mt-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Aggiungi opzione
                </button>
                <p className="text-[10px] text-kidville-muted leading-relaxed">
                  Il numero in arancio è il punteggio assegnato se l&apos;utente sceglie quella voce.
                </p>
              </section>
            )}

            {/* Blocco Consensi (DL-029): testo + link informativa */}
            {field.type === 'consent' && (
              <section className="space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                    Testo del consenso
                  </label>
                  <textarea
                    rows={3}
                    value={field.text ?? ''}
                    onChange={e => patch({ text: e.target.value })}
                    placeholder="Es: Acconsento al trattamento dei dati…"
                    className="w-full px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 transition-all resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                    Link informativa (URL)
                  </label>
                  <input
                    value={field.link ?? ''}
                    onChange={e => patch({ link: e.target.value })}
                    placeholder="https://…/informativa-privacy"
                    className="w-full px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                    Etichetta del link
                  </label>
                  <input
                    value={field.link_label ?? ''}
                    onChange={e => patch({ link_label: e.target.value })}
                    placeholder="Leggi l’informativa"
                    className="w-full px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 transition-all"
                  />
                </div>
              </section>
            )}

            {/* Blocco Allegati (DL-029): tipi ammessi + dimensione max */}
            {field.type === 'file' && (
              <section className="space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                    Tipi di file ammessi
                  </label>
                  <input
                    value={field.accept ?? ''}
                    onChange={e => patch({ accept: e.target.value })}
                    placeholder=".pdf,.jpg,.png"
                    className="w-full px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60 transition-all"
                  />
                  <p className="text-[10px] text-kidville-muted">Estensioni separate da virgola. Vuoto = PDF e immagini.</p>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                    Dimensione massima (MB)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={field.max_size_mb ?? ''}
                    onChange={e => patch({ max_size_mb: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="8"
                    className="w-24 px-3 py-2 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green focus:outline-none focus:border-kidville-green/60 transition-all text-right tabular-nums"
                  />
                </div>
              </section>
            )}

            {/* Mapping ETL (read-only, solo se presente) */}
            {field.db_mapping && (
              <div className="pt-3 border-t border-white/[0.05]">
                <p className="text-[10px] font-semibold text-kidville-muted uppercase tracking-wider mb-1.5">
                  Mapping ETL
                </p>
                <p className="text-xs font-mono text-kidville-success bg-kidville-success-soft border border-kidville-success/20 px-2.5 py-1.5 rounded-lg">
                  {field.db_mapping}
                </p>
                <p className="text-[10px] text-kidville-muted mt-1.5 leading-relaxed">
                  Aggiorna automaticamente l&apos;anagrafica alla compilazione.
                </p>
              </div>
            )}

            {/* Logica condizionale (DL-024) */}
            <section className="space-y-2 pt-3 border-t border-white/[0.05]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-kidville-green" />
                  <label className="text-[11px] font-semibold text-kidville-muted uppercase tracking-wider">
                    Logica condizionale
                  </label>
                </div>
                <button
                  onClick={toggleCondition}
                  className={`relative rounded-full transition-all ${field.condition ? 'bg-kidville-green' : 'bg-kidville-cream-dark'}`}
                  style={{ width: 40, height: 22 }}
                  title="Mostra il campo solo se una condizione è soddisfatta"
                >
                  <span
                    className={`absolute top-0.5 left-0.5 rounded-full bg-white shadow transition-transform ${field.condition ? 'translate-x-[18px]' : 'translate-x-0'}`}
                    style={{ width: 18, height: 18 }}
                  />
                </button>
              </div>

              {field.condition && (
                campiDisponibili.length === 0 ? (
                  <p className="text-[10px] text-kidville-muted leading-relaxed">
                    Aggiungi un altro campo al modulo per poter definire una condizione.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] text-kidville-muted">Mostra questo campo se:</p>
                    <select
                      value={field.condition.field_id}
                      onChange={e => patchCondition({ field_id: e.target.value })}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green focus:outline-none focus:border-kidville-green/60"
                    >
                      {campiDisponibili.map(c => (
                        <option key={c.id} value={c.id} className="bg-kidville-ink">{c.label}</option>
                      ))}
                    </select>
                    <select
                      value={field.condition.operator}
                      onChange={e => patchCondition({ operator: e.target.value as FormFieldCondition['operator'] })}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green focus:outline-none focus:border-kidville-green/60"
                    >
                      {OPERATORI.map(o => (
                        <option key={o.value} value={o.value} className="bg-kidville-ink">{o.label}</option>
                      ))}
                    </select>
                    <input
                      value={String(field.condition.value ?? '')}
                      onChange={e => patchCondition({ value: e.target.value })}
                      placeholder="valore di confronto…"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-kidville-cream border border-kidville-line text-sm text-kidville-green placeholder-kidville-muted focus:outline-none focus:border-kidville-green/60"
                    />
                  </div>
                )
              )}
            </section>

            {/* Field type (read-only) */}
            <div className="pt-3 border-t border-white/[0.05]">
              <p className="text-[10px] text-kidville-muted">
                Tipo campo: <span className="text-kidville-muted font-mono">{field.type}</span>
              </p>
              <p className="text-[10px] text-kidville-muted mt-0.5">
                ID: <span className="font-mono text-kidville-muted">{field.id.slice(0, 8)}…</span>
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
            <div className="w-10 h-10 rounded-2xl bg-kidville-cream flex items-center justify-center mb-3">
              <Settings className="w-5 h-5 text-kidville-muted" />
            </div>
            <p className="text-sm font-medium text-kidville-muted">Nessun campo selezionato</p>
            <p className="text-xs text-kidville-muted mt-1 leading-relaxed">
              Clicca su un campo nel canvas per modificarne le proprietà.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  )
}
