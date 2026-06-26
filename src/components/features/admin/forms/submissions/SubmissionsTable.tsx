'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  FileText, Table2, Search, ChevronDown, Download, Loader2, Inbox,
} from 'lucide-react'
import type { FormSubmissionStatus } from '@/types/database.types'
import {
  SubmissionDetailSidebar,
  type SubmissionRow,
} from './SubmissionDetailSidebar'

const STATUS_LABELS: Record<FormSubmissionStatus, string> = {
  draft: 'Bozza',
  pending_signature: 'In attesa firma',
  completed: 'Completato',
}

const STATUS_COLORS: Record<FormSubmissionStatus, string> = {
  draft: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
  pending_signature: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/20',
  completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
}

export function SubmissionsTable() {
  const userId = useSearchParams().get('userId') ?? ''
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([])
  const [formModels, setFormModels] = useState<{ id: string; title: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState<FormSubmissionStatus | ''>('')
  const [filterFormId, setFilterFormId] = useState('')
  const [filterDate, setFilterDate] = useState('')
  const [search, setSearch] = useState('')

  const selectedSubmission = submissions.find(s => s.id === selectedId) ?? null

  const fetchSubmissions = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterStatus) params.set('status', filterStatus)
      if (filterFormId) params.set('modelId', filterFormId)
      if (filterDate) params.set('date', filterDate)
      const res = await fetch(`/api/admin/forms/submissions?${params.toString()}`, {
        headers: userId ? { 'x-user-id': userId } : {},
      })
      const data = res.ok ? await res.json() : []
      if (Array.isArray(data)) setSubmissions(data as SubmissionRow[])
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterFormId, filterDate, userId])

  useEffect(() => {
    fetch('/api/admin/forms/models', { headers: userId ? { 'x-user-id': userId } : {} })
      .then(r => (r.ok ? r.json() : []))
      .then((data: { id: string; title: string }[]) => {
        if (Array.isArray(data)) setFormModels(data)
      })
      .catch(() => {})
  }, [userId])

  useEffect(() => {
    fetchSubmissions()
  }, [fetchSubmissions])

  const filtered = search
    ? submissions.filter(s => {
        const q = search.toLowerCase()
        return (
          s.id.toLowerCase().includes(q) ||
          (s.form_model?.title ?? '').toLowerCase().includes(q) ||
          Object.values(s.data).some(v => String(v ?? '').toLowerCase().includes(q))
        )
      })
    : submissions

  const handleBulkXLSX = () => {
    const ids = filtered.map(s => s.id).join(',')
    const a = document.createElement('a')
    a.href = `/api/forms/export/xlsx?ids=${ids}`
    a.download = 'compilazioni.xlsx'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleRowPDF = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const a = document.createElement('a')
    a.href = `/api/forms/export/pdf?id=${id}`
    a.download = `compilazione-${id.slice(0, 8)}.pdf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleRowXLSX = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const a = document.createElement('a')
    a.href = `/api/forms/export/xlsx?ids=${id}`
    a.download = `compilazione-${id.slice(0, 8)}.xlsx`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 mb-6 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-700 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cerca per modello o contenuto…"
            className="w-full pl-9 pr-4 py-2.5 rounded-xl text-slate-300 placeholder-slate-700 text-sm focus:outline-none transition-colors"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
            onFocus={e => {
              e.currentTarget.style.border = '1px solid rgba(99,102,241,0.45)'
            }}
            onBlur={e => {
              e.currentTarget.style.border = '1px solid rgba(255,255,255,0.07)'
            }}
          />
        </div>

        {/* Status filter */}
        <div className="relative">
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as FormSubmissionStatus | '')}
            className="appearance-none pl-4 pr-8 py-2.5 rounded-xl text-slate-400 text-sm focus:outline-none transition-colors cursor-pointer"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <option value="">Tutti gli stati</option>
            <option value="draft">Bozza</option>
            <option value="pending_signature">In attesa firma</option>
            <option value="completed">Completato</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-700" />
        </div>

        {/* Form model filter */}
        <div className="relative max-w-[220px]">
          <select
            value={filterFormId}
            onChange={e => setFilterFormId(e.target.value)}
            className="appearance-none pl-4 pr-8 py-2.5 rounded-xl text-slate-400 text-sm focus:outline-none transition-colors cursor-pointer w-full"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <option value="">Tutti i modelli</option>
            {formModels.map(m => (
              <option key={m.id} value={m.id}>{m.title}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-700" />
        </div>

        {/* Date filter */}
        <input
          type="date"
          value={filterDate}
          onChange={e => setFilterDate(e.target.value)}
          className="px-4 py-2.5 rounded-xl text-slate-400 text-sm focus:outline-none transition-colors"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.07)',
            colorScheme: 'dark',
          }}
        />

        {/* Bulk XLSX export */}
        {filtered.length > 0 && (
          <button
            onClick={handleBulkXLSX}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-slate-400 text-sm transition-all group ml-auto"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget
              el.style.background = 'rgba(99,102,241,0.1)'
              el.style.border = '1px solid rgba(129,140,248,0.25)'
              el.style.color = 'rgb(165,180,252)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget
              el.style.background = 'rgba(255,255,255,0.04)'
              el.style.border = '1px solid rgba(255,255,255,0.07)'
              el.style.color = 'rgb(148,163,184)'
            }}
          >
            <Table2 className="w-4 h-4" />
            Esporta tutto ({filtered.length})
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-28">
          <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-28 gap-3">
          <Inbox className="w-12 h-12 text-slate-800" />
          <p className="text-slate-700 text-sm">Nessuna compilazione trovata</p>
          {(filterStatus || filterFormId || filterDate || search) && (
            <button
              onClick={() => { setFilterStatus(''); setFilterFormId(''); setFilterDate(''); setSearch('') }}
              className="text-indigo-400 text-xs hover:underline"
            >
              Rimuovi filtri
            </button>
          )}
        </div>
      ) : (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {/* Header row */}
          <div
            className="grid items-center"
            style={{
              gridTemplateColumns: '140px 1fr 160px 110px 90px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            {['Data invio', 'Modello', 'Stato', 'Firma', 'Azioni'].map(col => (
              <div key={col} className="px-4 py-3 text-[10px] font-bold text-slate-700 uppercase tracking-widest">
                {col}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {filtered.map((sub, i) => (
            <motion.div
              key={sub.id}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.025, duration: 0.2 }}
              onClick={() => setSelectedId(sub.id)}
              className="grid items-center cursor-pointer transition-colors"
              style={{
                gridTemplateColumns: '140px 1fr 160px 110px 90px',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
              }}
              onMouseEnter={e => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)'
              }}
              onMouseLeave={e => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              {/* Date */}
              <div className="px-4 py-4 text-slate-600 text-xs tabular-nums">
                {new Date(sub.created_at).toLocaleDateString('it-IT', {
                  day: '2-digit', month: 'short', year: '2-digit',
                })}
                <br />
                <span className="text-slate-800">
                  {new Date(sub.created_at).toLocaleTimeString('it-IT', {
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>

              {/* Model title */}
              <div className="px-4 py-4 text-slate-300 text-sm truncate">
                {sub.form_model?.title ?? (
                  <span className="text-slate-700 italic text-xs">Modello rimosso</span>
                )}
              </div>

              {/* Status badge */}
              <div className="px-4 py-4">
                <span
                  className={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${STATUS_COLORS[sub.status]}`}
                >
                  {STATUS_LABELS[sub.status]}
                </span>
              </div>

              {/* Signed at */}
              <div className="px-4 py-4 text-xs">
                {sub.signed_at ? (
                  <span className="text-emerald-400">
                    {new Date(sub.signed_at).toLocaleDateString('it-IT', {
                      day: '2-digit', month: 'short',
                    })}
                  </span>
                ) : (
                  <span className="text-slate-800">—</span>
                )}
              </div>

              {/* Action buttons */}
              <div
                className="px-4 py-4 flex items-center gap-1.5"
                onClick={e => e.stopPropagation()}
              >
                <button
                  title="Scarica PDF"
                  onClick={e => handleRowPDF(e, sub.id)}
                  className="p-1.5 rounded-lg text-slate-700 transition-all"
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.color = 'rgb(165,180,252)'
                    el.style.background = 'rgba(99,102,241,0.12)'
                    el.style.filter = 'drop-shadow(0 0 6px rgba(99,102,241,0.5))'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.color = 'rgb(71,85,105)'
                    el.style.background = 'transparent'
                    el.style.filter = 'none'
                  }}
                >
                  <FileText className="w-4 h-4" />
                </button>
                <button
                  title="Esporta XLSX"
                  onClick={e => handleRowXLSX(e, sub.id)}
                  className="p-1.5 rounded-lg text-slate-700 transition-all"
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.color = 'rgb(165,180,252)'
                    el.style.background = 'rgba(99,102,241,0.12)'
                    el.style.filter = 'drop-shadow(0 0 6px rgba(99,102,241,0.5))'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.color = 'rgb(71,85,105)'
                    el.style.background = 'transparent'
                    el.style.filter = 'none'
                  }}
                >
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Sidebar detail */}
      <SubmissionDetailSidebar
        submission={selectedSubmission}
        onClose={() => setSelectedId(null)}
      />
    </>
  )
}
