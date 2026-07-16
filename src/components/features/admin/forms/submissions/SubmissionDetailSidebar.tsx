'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  X, FileText, Download, Clock, CheckCircle2, Hash, CheckCheck,
} from 'lucide-react'
import type { FormSchemaConfig, FormSubmissionStatus } from '@/types/database.types'

export interface SubmissionRow {
  id: string
  model_id: string
  user_id: string | null
  data: Record<string, unknown>
  status: FormSubmissionStatus
  signed_at: string | null
  created_at: string
  /** Presa in carico dallo staff (M5.2) */
  gestita_il: string | null
  gestita_da: string | null
  form_model: {
    id: string
    title: string
    schema: FormSchemaConfig
  } | null
}

interface Props {
  submission: SubmissionRow | null
  onClose: () => void
  /** PATCH gestita: ritorna false se il salvataggio fallisce (rollback a monte) */
  onToggleGestita: (id: string, gestita: boolean) => Promise<boolean>
}

const STATUS_MAP: Record<FormSubmissionStatus, { label: string; cls: string }> = {
  draft: { label: 'Bozza', cls: 'bg-kidville-warn-soft text-kidville-warn border-kidville-warn/30' },
  pending_signature: { label: 'In attesa firma', cls: 'bg-kidville-info-soft text-kidville-info border-kidville-info/30' },
  completed: { label: 'Completato', cls: 'bg-kidville-success-soft text-kidville-success border-kidville-success/30' },
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Sì' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function SubmissionDetailSidebar({ submission, onClose, onToggleGestita }: Props) {
  const [savingGestita, setSavingGestita] = useState(false)

  const fieldMap: Record<string, { label: string; type: string }> = {}
  if (submission?.form_model?.schema?.pages) {
    for (const page of submission.form_model.schema.pages) {
      for (const field of page.fields) {
        fieldMap[field.id] = { label: field.label, type: field.type }
      }
    }
  }

  const visibleEntries = submission
    ? Object.entries(submission.data).filter(([fieldId, value]) => {
        const meta = fieldMap[fieldId]
        if (meta?.type === 'file' || meta?.type === 'signature') return false
        return value !== null && value !== undefined && value !== ''
      })
    : []

  const handleDownloadPDF = () => {
    if (!submission) return
    const a = document.createElement('a')
    a.href = `/api/forms/export/pdf?id=${submission.id}`
    a.download = `compilazione-${submission.id.slice(0, 8)}.pdf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleDownloadXLSX = () => {
    if (!submission) return
    const a = document.createElement('a')
    a.href = `/api/forms/export/xlsx?ids=${submission.id}`
    a.download = `compilazione-${submission.id.slice(0, 8)}.xlsx`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <AnimatePresence>
      {submission && (
        <>
          {/* Scrim */}
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(3, 5, 18, 0.55)' }}
          />

          {/* Slide-over */}
          <motion.aside
            key="panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 340, damping: 36 }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full max-w-[460px]"
            style={{
              background: 'rgba(8, 11, 26, 0.97)',
              borderLeft: '1px solid var(--color-kidville-line)',
              backdropFilter: 'blur(28px)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-start justify-between px-6 py-5"
              style={{ borderBottom: '1px solid var(--color-kidville-line)' }}
            >
              <div className="flex-1 min-w-0 pr-4">
                <h2 className="text-kidville-green font-semibold text-base leading-snug truncate">
                  {submission.form_model?.title ?? 'Compilazione'}
                </h2>
                <p className="text-kidville-muted text-[11px] mt-0.5 font-mono flex items-center gap-1">
                  <Hash className="w-3 h-3" />
                  {submission.id.slice(0, 8).toUpperCase()}
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-kidville-muted hover:text-kidville-green hover:bg-white/[0.08] transition-all flex-shrink-0"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* Meta strip */}
            <div
              className="px-6 py-3 flex flex-wrap items-center gap-2.5"
              style={{ borderBottom: '1px solid var(--color-kidville-white)' }}
            >
              <span
                className={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${STATUS_MAP[submission.status].cls}`}
              >
                {STATUS_MAP[submission.status].label}
              </span>

              <span className="text-kidville-muted text-[11px] flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(submission.created_at).toLocaleString('it-IT', {
                  day: '2-digit', month: 'short', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>

              {submission.signed_at && (
                <span className="text-kidville-success text-[11px] flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  Firmato {new Date(submission.signed_at).toLocaleDateString('it-IT', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                </span>
              )}
            </div>

            {/* Field list */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-2.5">
              {visibleEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <FileText className="w-10 h-10 text-kidville-muted" />
                  <p className="text-kidville-muted text-sm">Nessun dato da visualizzare</p>
                </div>
              ) : (
                visibleEntries.map(([fieldId, value]) => {
                  const meta = fieldMap[fieldId]
                  return (
                    <div
                      key={fieldId}
                      className="rounded-xl px-4 py-3"
                      style={{
                        background: 'var(--color-kidville-line)',
                        border: '1px solid var(--color-kidville-line)',
                      }}
                    >
                      <p className="text-[10px] font-bold text-kidville-muted uppercase tracking-widest mb-1.5">
                        {meta?.label ?? fieldId}
                      </p>
                      <p className="text-kidville-ink text-sm leading-relaxed break-words">
                        {renderValue(value)}
                      </p>
                    </div>
                  )
                })
              )}
            </div>

            {/* Footer */}
            <div
              className="px-6 py-4 flex flex-col gap-3"
              style={{ borderTop: '1px solid var(--color-kidville-line)' }}
            >
              {/* "Segna gestita" (M5.2): PATCH gestita con stato ottimista —
                  la riga viene aggiornata a monte in SubmissionsTable e questa
                  sidebar la rilegge da props; rollback se il PATCH fallisce. */}
              <button
                type="button"
                title={submission.gestita_il ? 'Riporta a non gestita' : 'Segna come gestita'}
                disabled={savingGestita}
                onClick={async () => {
                  setSavingGestita(true)
                  try {
                    await onToggleGestita(submission.id, !submission.gestita_il)
                  } finally {
                    setSavingGestita(false)
                  }
                }}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-kidville-yellow font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green disabled:opacity-60"
              >
                <CheckCheck className="w-4 h-4" /> {submission.gestita_il ? 'Gestita' : 'Segna gestita'}
                {submission.gestita_il && (
                  <span className="rounded-pill bg-kidville-green/[0.12] px-2 py-0.5 font-maven text-[10px] font-semibold normal-case tracking-normal text-kidville-green">
                    {new Date(submission.gestita_il).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
                  </span>
                )}
              </button>

              <div className="flex gap-3">
              <button
                onClick={handleDownloadPDF}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-kidville-green transition-all"
                style={{
                  background: 'rgba(0,106,95,0.75)',
                  border: '1px solid rgba(0,106,95,0.2)',
                }}
                onMouseEnter={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.boxShadow =
                    '0 0 22px rgba(0,106,95,0.35)'
                }}
                onMouseLeave={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'
                }}
              >
                <FileText className="w-4 h-4" />
                Scarica PDF
              </button>

              <button
                onClick={handleDownloadXLSX}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-kidville-ink transition-all"
                style={{
                  background: 'var(--color-kidville-white)',
                  border: '1px solid var(--color-kidville-line)',
                }}
                onMouseEnter={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.background =
                    'var(--color-kidville-line)'
                }}
                onMouseLeave={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.background =
                    'var(--color-kidville-white)'
                }}
              >
                <Download className="w-4 h-4" />
                Esporta XLSX
              </button>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
