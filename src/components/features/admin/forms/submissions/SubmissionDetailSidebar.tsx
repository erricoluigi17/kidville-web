'use client'

import { AnimatePresence, motion } from 'framer-motion'
import {
  X, FileText, Download, Clock, CheckCircle2, Hash,
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
  form_model: {
    id: string
    title: string
    schema: FormSchemaConfig
  } | null
}

interface Props {
  submission: SubmissionRow | null
  onClose: () => void
}

const STATUS_MAP: Record<FormSubmissionStatus, { label: string; cls: string }> = {
  draft: { label: 'Bozza', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/20' },
  pending_signature: { label: 'In attesa firma', cls: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/20' },
  completed: { label: 'Completato', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' },
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Sì' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function SubmissionDetailSidebar({ submission, onClose }: Props) {
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
              borderLeft: '1px solid rgba(255,255,255,0.06)',
              backdropFilter: 'blur(28px)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-start justify-between px-6 py-5"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
            >
              <div className="flex-1 min-w-0 pr-4">
                <h2 className="text-white font-semibold text-base leading-snug truncate">
                  {submission.form_model?.title ?? 'Compilazione'}
                </h2>
                <p className="text-slate-600 text-[11px] mt-0.5 font-mono flex items-center gap-1">
                  <Hash className="w-3 h-3" />
                  {submission.id.slice(0, 8).toUpperCase()}
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-slate-600 hover:text-white hover:bg-white/[0.08] transition-all flex-shrink-0"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* Meta strip */}
            <div
              className="px-6 py-3 flex flex-wrap items-center gap-2.5"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
            >
              <span
                className={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${STATUS_MAP[submission.status].cls}`}
              >
                {STATUS_MAP[submission.status].label}
              </span>

              <span className="text-slate-600 text-[11px] flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(submission.created_at).toLocaleString('it-IT', {
                  day: '2-digit', month: 'short', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>

              {submission.signed_at && (
                <span className="text-emerald-400 text-[11px] flex items-center gap-1">
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
                  <FileText className="w-10 h-10 text-slate-800" />
                  <p className="text-slate-700 text-sm">Nessun dato da visualizzare</p>
                </div>
              ) : (
                visibleEntries.map(([fieldId, value]) => {
                  const meta = fieldMap[fieldId]
                  return (
                    <div
                      key={fieldId}
                      className="rounded-xl px-4 py-3"
                      style={{
                        background: 'rgba(255,255,255,0.027)',
                        border: '1px solid rgba(255,255,255,0.05)',
                      }}
                    >
                      <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1.5">
                        {meta?.label ?? fieldId}
                      </p>
                      <p className="text-slate-200 text-sm leading-relaxed break-words">
                        {renderValue(value)}
                      </p>
                    </div>
                  )
                })
              )}
            </div>

            {/* Footer */}
            <div
              className="px-6 py-4 flex gap-3"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
            >
              <button
                onClick={handleDownloadPDF}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-all"
                style={{
                  background: 'rgba(99,102,241,0.75)',
                  border: '1px solid rgba(129,140,248,0.2)',
                }}
                onMouseEnter={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.boxShadow =
                    '0 0 22px rgba(99,102,241,0.35)'
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
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-300 transition-all"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
                onMouseEnter={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.background =
                    'rgba(255,255,255,0.07)'
                }}
                onMouseLeave={e => {
                  ;(e.currentTarget as HTMLButtonElement).style.background =
                    'rgba(255,255,255,0.04)'
                }}
              >
                <Download className="w-4 h-4" />
                Esporta XLSX
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
