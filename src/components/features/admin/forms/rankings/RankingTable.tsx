'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Trophy, Medal, ChevronDown, Search, Loader2, Inbox, Info,
  SlidersHorizontal, Gavel, FileDown,
} from 'lucide-react'
import { MEDAL } from '@/lib/ui/chart-colors'
const ESITO_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  ammesso: { label: 'Ammesso', bg: 'rgba(52,211,153,0.14)', color: 'rgb(52,211,153)' },
  lista_attesa: { label: "Lista d'attesa", bg: 'rgba(230,114,10,0.14)', color: 'rgb(251,191,36)' },
  non_ammesso: { label: 'Non ammesso', bg: 'rgba(244,114,128,0.14)', color: 'rgb(244,114,128)' },
}
import { RankingAdjustModal, type RankingRow, type ManualAdjustment } from './RankingAdjustModal'

/* ── helpers ───────────────────────────────────────────────── */

function candidateLabel(data: Record<string, unknown>): string {
  const nome =
    (data['nome_alunno'] as string) ??
    (data['child_first_name'] as string) ??
    (data['nome'] as string) ??
    ''
  const cognome =
    (data['cognome_alunno'] as string) ??
    (data['child_last_name'] as string) ??
    (data['cognome'] as string) ??
    ''
  if (nome || cognome) return `${cognome} ${nome}`.trim()
  // fallback: parent name
  const pn = (data['parent_first_name'] as string) ?? (data['nome_genitore'] as string) ?? ''
  const ps = (data['parent_last_name'] as string) ?? (data['cognome_genitore'] as string) ?? ''
  if (pn || ps) return `${ps} ${pn}`.trim()
  return 'Candidato'
}

// Podio graduatorie: le tinte oro/argento/bronzo sono "data colors" del ranking
// (non token di tema) e vivono in `chart-colors.ts` (unica casa degli hex del
// perimetro admin). Qui si aggancia solo l'icona lucide a ciascuna medaglia.
const MEDAL_STYLES: Record<number, { icon: typeof Trophy; color: string; glow: string; bg: string }> = {
  1: { icon: Trophy, ...MEDAL.gold },
  2: { icon: Medal, ...MEDAL.silver },
  3: { icon: Medal, ...MEDAL.bronze },
}

/* ── tooltip per manual_adjustments ────────────────────────── */

function AdjustmentTooltip({ adjustments }: { adjustments: ManualAdjustment[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  if (!adjustments.length) return null

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        className="p-1 rounded-md transition-all"
        style={{ color: 'rgba(0,106,95,0.7)' }}
        onMouseOver={e => { (e.currentTarget as HTMLButtonElement).style.color = 'rgb(129,140,248)' }}
        onMouseOut={e => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(0,106,95,0.7)' }}
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 bottom-full mb-2 z-50 w-64 p-3 rounded-xl space-y-2 pointer-events-auto"
            style={{
              background: 'rgba(15, 18, 36, 0.97)',
              border: '1px solid var(--color-kidville-line)',
              backdropFilter: 'blur(24px)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            }}
          >
            <p className="text-[10px] font-bold text-kidville-muted uppercase tracking-widest mb-1.5">
              Modifiche manuali
            </p>
            {adjustments.map((adj, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span
                  className={`font-mono font-bold tabular-nums shrink-0 ${
                    adj.delta >= 0 ? 'text-kidville-success' : 'text-kidville-error'
                  }`}
                >
                  {adj.delta >= 0 ? `+${adj.delta}` : adj.delta}
                </span>
                <span className="text-kidville-muted leading-snug flex-1">{adj.reason}</span>
                <span className="text-kidville-muted tabular-nums shrink-0">
                  {adj.at ? new Date(adj.at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }) : ''}
                </span>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ── main component ────────────────────────────────────────── */

interface SubmissionWithModel extends RankingRow {
  form_model?: { id: string; title: string } | null
}

export function RankingTable() {
  const [submissions, setSubmissions] = useState<SubmissionWithModel[]>([])
  const [formModels, setFormModels] = useState<{ id: string; title: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [filterFormId, setFilterFormId] = useState('')
  const [search, setSearch] = useState('')

  // Modal state
  const [editingSub, setEditingSub] = useState<RankingRow | null>(null)
  const [editingLabel, setEditingLabel] = useState('')

  // Delibera (DL-025)
  const userId = useSearchParams().get('userId') ?? ''
  const [posti, setPosti] = useState(0)
  const [soglia, setSoglia] = useState(0)
  const [deliberando, setDeliberando] = useState(false)

  /* ── fetch form models (via route server gated) ── */
  useEffect(() => {
    fetch('/api/admin/forms/models', { headers: userId ? { 'x-user-id': userId } : {} })
      .then(r => (r.ok ? r.json() : []))
      .then((data: { id: string; title: string }[]) => {
        if (Array.isArray(data)) setFormModels(data)
      })
      .catch(() => {})
  }, [userId])

  /* ── fetch rankings (via route server gated) ── */
  const fetchRankings = useCallback(async () => {
    // niente setLoading(true) sincrono: loading parte true da useState(true)
    // (react-hooks set-state-in-effect); refetch senza spinner, accettato.
    try {
      const params = new URLSearchParams()
      if (filterFormId) params.set('modelId', filterFormId)
      const res = await fetch(`/api/admin/forms/rankings?${params.toString()}`, {
        headers: userId ? { 'x-user-id': userId } : {},
      })
      const data = res.ok ? await res.json() : []
      if (Array.isArray(data)) {
        setSubmissions(
          (data as SubmissionWithModel[]).map(s => ({
            ...s,
            manual_adjustments: Array.isArray(s.manual_adjustments) ? s.manual_adjustments : [],
          }))
        )
      }
    } finally {
      setLoading(false)
    }
  }, [filterFormId, userId])

  useEffect(() => {
    fetchRankings()
  }, [fetchRankings])

  /* ── delibera ammissioni (DL-025) ── */
  const applicaDelibera = async () => {
    if (!filterFormId) return
    if (!confirm(`Deliberare con ${posti} posti e soglia ${soglia}? Gli esiti verranno (ri)assegnati.`)) return
    setDeliberando(true)
    try {
      const res = await fetch('/api/forms/delibera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify({ modelId: filterFormId, posti, soglia }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        alert(j.error || 'Delibera non riuscita')
      } else {
        await fetchRankings()
      }
    } finally {
      setDeliberando(false)
    }
  }

  /* ── filter by search ── */
  const filtered = search
    ? submissions.filter(s => {
        const q = search.toLowerCase()
        const label = candidateLabel(s.data).toLowerCase()
        return (
          label.includes(q) ||
          (s.form_model?.title ?? '').toLowerCase().includes(q) ||
          String(s.score).includes(q)
        )
      })
    : submissions

  /* ── stats ── */
  const avgScore = filtered.length
    ? Math.round(filtered.reduce((a, s) => a + s.score, 0) / filtered.length)
    : 0
  const maxScore = filtered.length ? Math.max(...filtered.map(s => s.score)) : 0

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Candidati', value: filtered.length, accent: 'rgba(0,106,95,0.8)' },
          { label: 'Punteggio medio', value: avgScore, accent: 'rgba(52,211,153,0.8)' },
          { label: 'Punteggio massimo', value: maxScore, accent: 'rgba(230,114,10,0.8)' },
        ].map(card => (
          <div
            key={card.label}
            className="rounded-2xl px-5 py-4"
            style={{
              background: 'var(--color-kidville-line)',
              border: '1px solid var(--color-kidville-line)',
              backdropFilter: 'blur(12px)',
            }}
          >
            <p className="text-[10px] font-bold text-kidville-muted uppercase tracking-widest mb-1">{card.label}</p>
            <p className="text-2xl font-bold tabular-nums" style={{ color: card.accent }}>
              {card.value}
            </p>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 mb-6 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kidville-muted pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cerca candidato…"
            className="w-full pl-9 pr-4 py-2.5 rounded-xl text-kidville-ink placeholder-kidville-muted text-sm focus:outline-none transition-colors"
            style={{
              background: 'var(--color-kidville-white)',
              border: '1px solid var(--color-kidville-line)',
            }}
            onFocus={e => { e.currentTarget.style.border = '1px solid rgba(0,106,95,0.45)' }}
            onBlur={e => { e.currentTarget.style.border = '1px solid var(--color-kidville-line)' }}
          />
        </div>

        {/* Form model filter */}
        <div className="relative max-w-[260px]">
          <select
            value={filterFormId}
            onChange={e => setFilterFormId(e.target.value)}
            className="appearance-none pl-4 pr-8 py-2.5 rounded-xl text-kidville-muted text-sm focus:outline-none transition-colors cursor-pointer w-full"
            style={{
              background: 'var(--color-kidville-white)',
              border: '1px solid var(--color-kidville-line)',
            }}
          >
            <option value="">Tutti i moduli</option>
            {formModels.map(m => (
              <option key={m.id} value={m.id}>{m.title}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-kidville-muted" />
        </div>
      </div>

      {/* Delibera bar (solo con un modulo selezionato) — DL-025 */}
      {filterFormId && (
        <div
          className="flex flex-wrap items-end gap-3 mb-6 rounded-2xl px-4 py-3"
          style={{ background: 'rgba(0,106,95,0.06)', border: '1px solid rgba(0,106,95,0.18)' }}
        >
          <div className="flex items-center gap-1.5 text-kidville-info text-xs font-bold uppercase tracking-widest mr-1">
            <Gavel className="w-3.5 h-3.5" /> Delibera
          </div>
          <label className="text-[11px] text-kidville-muted">
            Posti
            <input
              type="number" min={0} value={posti}
              onChange={e => setPosti(Math.max(0, parseInt(e.target.value || '0', 10)))}
              className="block w-20 mt-1 px-2 py-1.5 rounded-lg text-kidville-green text-sm tabular-nums focus:outline-none"
              style={{ background: 'var(--color-kidville-line)', border: '1px solid var(--color-kidville-line)' }}
            />
          </label>
          <label className="text-[11px] text-kidville-muted">
            Soglia punti
            <input
              type="number" min={0} value={soglia}
              onChange={e => setSoglia(Math.max(0, parseInt(e.target.value || '0', 10)))}
              className="block w-24 mt-1 px-2 py-1.5 rounded-lg text-kidville-green text-sm tabular-nums focus:outline-none"
              style={{ background: 'var(--color-kidville-line)', border: '1px solid var(--color-kidville-line)' }}
            />
          </label>
          <button
            onClick={applicaDelibera}
            disabled={deliberando}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-kidville-green text-sm font-semibold transition-all disabled:opacity-50"
            style={{ background: 'rgba(0,106,95,0.85)', border: '1px solid rgba(0,106,95,0.3)' }}
          >
            {deliberando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gavel className="w-4 h-4" />}
            Applica delibera
          </button>
          <a
            href={`/api/forms/export/delibera?modelId=${filterFormId}${userId ? `&userId=${userId}` : ''}`}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-kidville-info text-sm font-semibold transition-all hover:text-kidville-green"
            style={{ background: 'var(--color-kidville-white)', border: '1px solid var(--color-kidville-line)' }}
          >
            <FileDown className="w-4 h-4" /> Esporta PDF
          </a>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-28">
          <Loader2 className="w-5 h-5 text-kidville-green animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-28 gap-3">
          <Inbox className="w-12 h-12 text-kidville-muted" />
          <p className="text-kidville-muted text-sm">Nessuna compilazione completata trovata</p>
          {(filterFormId || search) && (
            <button
              onClick={() => { setFilterFormId(''); setSearch('') }}
              className="text-kidville-green text-xs hover:underline"
            >
              Rimuovi filtri
            </button>
          )}
        </div>
      ) : (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid var(--color-kidville-line)' }}
        >
          {/* Header row */}
          <div
            className="grid items-center"
            style={{
              gridTemplateColumns: '56px 1fr 200px 120px 90px 48px',
              borderBottom: '1px solid var(--color-kidville-line)',
              background: 'var(--color-kidville-line)',
            }}
          >
            {['#', 'Candidato', 'Modulo', 'Firma', 'Punti', ''].map(col => (
              <div key={col} className="px-4 py-3 text-[10px] font-bold text-kidville-muted uppercase tracking-widest">
                {col}
              </div>
            ))}
          </div>

          {/* Data rows — layout animation for reordering */}
          <AnimatePresence mode="popLayout">
            {filtered.map((sub, i) => {
              const rank = i + 1
              const medal = MEDAL_STYLES[rank]
              const label = candidateLabel(sub.data)
              const manualTotal = (sub.manual_adjustments ?? []).reduce((s, a) => s + a.delta, 0)

              return (
                <motion.div
                  key={sub.id}
                  layout
                  layoutId={sub.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{
                    layout: { type: 'spring', stiffness: 350, damping: 32 },
                    opacity: { duration: 0.2 },
                  }}
                  onClick={() => {
                    setEditingSub(sub)
                    setEditingLabel(label)
                  }}
                  className="grid items-center cursor-pointer transition-colors"
                  style={{
                    gridTemplateColumns: '56px 1fr 200px 120px 90px 48px',
                    borderBottom: '1px solid var(--color-kidville-line)',
                    background: medal?.bg ?? 'transparent',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      medal ? `${medal.bg.replace(')', ', 0.14)')}` : 'var(--color-kidville-line)'
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.background = medal?.bg ?? 'transparent'
                  }}
                >
                  {/* Rank */}
                  <div className="px-4 py-4 flex items-center justify-center">
                    {medal ? (
                      <div
                        className="flex items-center justify-center w-8 h-8 rounded-full"
                        style={{
                          background: medal.bg,
                          boxShadow: `0 0 12px ${medal.glow}`,
                        }}
                      >
                        <medal.icon className="w-4 h-4" style={{ color: medal.color }} />
                      </div>
                    ) : (
                      <span className="text-kidville-muted text-sm font-medium tabular-nums">{rank}</span>
                    )}
                  </div>

                  {/* Candidate name */}
                  <div className="px-4 py-4">
                    <p className={`text-sm font-medium truncate ${rank <= 3 ? 'text-kidville-green' : 'text-kidville-ink'}`}>
                      {label}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-[11px] text-kidville-muted tabular-nums">{sub.id.slice(0, 8)}</p>
                      {sub.esito_ammissione && ESITO_BADGE[sub.esito_ammissione] && (
                        <span
                          className="px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                          style={{
                            background: ESITO_BADGE[sub.esito_ammissione].bg,
                            color: ESITO_BADGE[sub.esito_ammissione].color,
                          }}
                        >
                          {ESITO_BADGE[sub.esito_ammissione].label}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Model */}
                  <div className="px-4 py-4 text-kidville-muted text-sm truncate">
                    {sub.form_model?.title ?? '—'}
                  </div>

                  {/* Signed at */}
                  <div className="px-4 py-4 text-xs">
                    {sub.signed_at ? (
                      <span className="text-kidville-muted tabular-nums">
                        {new Date(sub.signed_at).toLocaleDateString('it-IT', {
                          day: '2-digit', month: 'short', year: '2-digit',
                        })}
                      </span>
                    ) : (
                      <span className="text-kidville-muted">—</span>
                    )}
                  </div>

                  {/* Score */}
                  <div className="px-4 py-4 flex items-center gap-1">
                    <span
                      className={`text-lg font-bold tabular-nums ${
                        rank === 1 ? 'text-kidville-warn' : 'text-kidville-success'
                      }`}
                    >
                      {sub.score}
                    </span>
                    {manualTotal !== 0 && (
                      <span
                        className={`text-[10px] font-mono tabular-nums ${
                          manualTotal > 0 ? 'text-kidville-success/60' : 'text-kidville-error/60'
                        }`}
                      >
                        {manualTotal > 0 ? `+${manualTotal}` : manualTotal}
                      </span>
                    )}
                  </div>

                  {/* Info icon for adjustments */}
                  <div className="px-2 py-4 flex items-center justify-center" onClick={e => e.stopPropagation()}>
                    <AdjustmentTooltip adjustments={sub.manual_adjustments ?? []} />
                    {!(sub.manual_adjustments ?? []).length && (
                      <SlidersHorizontal className="w-3.5 h-3.5 text-kidville-muted" />
                    )}
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Adjust modal */}
      <RankingAdjustModal
        submission={editingSub}
        label={editingLabel}
        onClose={() => setEditingSub(null)}
        onApplied={() => {
          setEditingSub(null)
          fetchRankings()
        }}
      />
    </>
  )
}
