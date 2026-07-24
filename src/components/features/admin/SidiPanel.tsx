'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { UploadCloud, RefreshCw, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'

interface SyncState {
  fase_a_stato: string
  frequentanti_stato: string
  piattaforma_unica_stato: string
  fase_a_ts?: string | null
  frequentanti_ts?: string | null
  piattaforma_unica_ts?: string | null
}
interface Preview {
  batchId: string
  totale: number
  warnings: string[]
}

function statoColor(s: string): string {
  if (s === 'inviato') return 'bg-kidville-success-soft text-kidville-success'
  if (s === 'errore') return 'bg-kidville-error-soft text-kidville-error'
  if (s === 'in_corso') return 'bg-kidville-warn-soft text-kidville-warn'
  return 'bg-kidville-line text-kidville-muted'
}

export function SidiPanel({ userId }: { userId: string }) {
  const t = useTranslations('adminSettings')
  const statoLabel = (s: string): string => {
    if (s === 'non_inviato') return t('siStatoNonInviato')
    if (s === 'in_corso') return t('siStatoInCorso')
    if (s === 'inviato') return t('siStatoInviato')
    if (s === 'errore') return t('siStatoErrore')
    return s
  }
  const hdr = useCallback((json = true): Record<string, string> => (json ? { 'Content-Type': 'application/json', 'x-user-id': userId } : { 'x-user-id': userId }), [userId])
  const [sync, setSync] = useState<SyncState | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'gated' | 'err'; text: string } | null>(null)
  const [sidiGated, setSidiGated] = useState(false)

  const loadSync = useCallback(async () => {
    const d = await fetch(`/api/admin/sidi/sync-state?userId=${userId}`, { headers: hdr() })
      .then((r) => r.json())
      .catch(() => null)
    if (d?.success) setSync(d.data)
  }, [userId, hdr])

  useEffect(() => {
    fetch(`/api/admin/sidi/sync-state?userId=${userId}`, { headers: hdr() })
      .then((r) => r.json())
      .then((d) => { if (d.success) setSync(d.data) })
      .catch(() => { /* no-op */ })
  }, [userId, hdr])

  // Gating SIDI visibile (M2.4): badge quando l'integrazione non è configurata.
  useEffect(() => {
    fetch(`/api/admin/settings/sidi?userId=${userId}`, { headers: hdr() })
      .then((r) => r.json())
      .then((d) => { if (d.success) setSidiGated(!d.data?.abilitato) })
      .catch(() => { /* no-op */ })
  }, [userId, hdr])

  async function upload() {
    if (!file) return
    setBusy('upload'); setMsg(null); setPreview(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/admin/sidi/import?userId=${userId}`, { method: 'POST', headers: hdr(false), body: fd })
      const d = await r.json()
      if (!r.ok) { setMsg({ kind: 'err', text: d.error ?? t('siUploadFallito') }); return }
      setPreview({ batchId: d.batchId, totale: d.totale, warnings: d.warnings ?? [] })
    } finally { setBusy(null) }
  }

  async function applyBatch() {
    if (!preview) return
    setBusy('apply'); setMsg(null)
    try {
      const r = await fetch(`/api/admin/sidi/import?userId=${userId}`, { method: 'PATCH', headers: hdr(), body: JSON.stringify({ batchId: preview.batchId }) })
      const d = await r.json()
      if (!r.ok) { setMsg({ kind: 'err', text: d.error ?? t('siImportFallito') }); return }
      setMsg({ kind: 'ok', text: t('siImportCompletato', { matched: d.matched, creati: d.creati, aggiornati: d.aggiornati }) })
      setPreview(null); setFile(null)
    } finally { setBusy(null) }
  }

  async function transmit(flusso: 'fase-a' | 'frequentanti' | 'piattaforma-unica') {
    setBusy(flusso); setMsg(null)
    try {
      const r = await fetch(`/api/admin/sidi/${flusso}?userId=${userId}`, { method: 'POST', headers: hdr(), body: '{}' })
      const d = await r.json()
      if (r.status === 503) setMsg({ kind: 'gated', text: d.messaggio ?? d.error ?? t('siGatedDefault') })
      else if (!r.ok) setMsg({ kind: 'err', text: d.error ?? t('siErroreTrasmissione') })
      else setMsg({ kind: 'ok', text: t('siTrasmissioneAccettata') })
      await loadSync()
    } finally { setBusy(null) }
  }

  const faseA = sync?.fase_a_stato ?? 'non_inviato'
  const freq = sync?.frequentanti_stato ?? 'non_inviato'
  const pu = sync?.piattaforma_unica_stato ?? 'non_inviato'

  return (
    <div className="space-y-6">
      {/* Import ZIP */}
      <section className="bg-white rounded-2xl border border-kidville-line p-5">
        <h2 className="font-barlow font-black text-kidville-green uppercase text-sm mb-3 flex items-center gap-2">
          <UploadCloud size={18} /> {t('siImportTitolo')}
        </h2>
        <p className="font-maven text-xs text-kidville-muted mb-3">{t.rich('siImportDesc', { code: (c) => <code>{c}</code>, strong: (c) => <strong>{c}</strong> })}</p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex cursor-pointer items-center gap-2 h-9 px-4 rounded-pill border border-kidville-line bg-white font-maven text-sm text-kidville-ink hover:bg-kidville-cream">
            <UploadCloud size={15} /> {file ? file.name : t('siScegliZip')}
            <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="hidden" />
          </label>
          <button onClick={upload} disabled={!file || busy === 'upload'} className="h-9 px-4 rounded-pill bg-kidville-green text-white font-barlow font-black uppercase text-xs disabled:opacity-50">
            {busy === 'upload' ? t('siAnalisi') : t('siCaricaAnalizza')}
          </button>
        </div>
        {preview && (
          <div className="mt-4 rounded-xl bg-kidville-cream/50 p-4">
            <p className="font-maven text-sm text-kidville-ink">{t.rich('siAnteprima', { totale: preview.totale, strong: (c) => <strong>{c}</strong> })}</p>
            {preview.warnings.length > 0 && (
              <ul className="mt-2 text-xs text-kidville-warn list-disc pl-5">
                {preview.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <button onClick={applyBatch} disabled={busy === 'apply'} className="mt-3 h-9 px-4 rounded-pill bg-kidville-yellow text-kidville-green font-barlow font-black uppercase text-xs disabled:opacity-50">
              {busy === 'apply' ? t('siImportazione') : t('siConfermaImport')}
            </button>
          </div>
        )}
      </section>

      {/* Indicatore stato sincronizzazione */}
      <section className="bg-white rounded-2xl border border-kidville-line p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-barlow font-black text-kidville-green uppercase text-sm">{t('siStatoSincronizzazione')}</h2>
            {sidiGated && <Badge tone="warn">{t('siIntegrazioneNonConfigurata')}</Badge>}
          </div>
          <button onClick={loadSync} className="text-kidville-muted hover:text-kidville-green" aria-label={t('siAggiorna')}><RefreshCw size={16} /></button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { key: 'fase-a' as const, label: t('siFaseA'), stato: faseA, disabled: false },
            { key: 'frequentanti' as const, label: t('siFrequentanti'), stato: freq, disabled: faseA !== 'inviato' },
            { key: 'piattaforma-unica' as const, label: t('siPiattaformaUnica'), stato: pu, disabled: freq !== 'inviato' },
          ].map((step, i) => (
            <div key={step.key} className="flex items-center gap-2">
              {i > 0 && <ArrowRight size={14} className="text-kidville-muted" />}
              <div className="rounded-xl border border-kidville-line p-3 min-w-[150px]">
                <div className="font-maven text-xs text-kidville-ink mb-1">{step.label}</div>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${statoColor(step.stato)}`}>{statoLabel(step.stato)}</span>
                <button
                  onClick={() => transmit(step.key)}
                  disabled={step.disabled || busy === step.key}
                  className="mt-2 block w-full h-8 px-2 rounded-pill bg-kidville-green text-white font-barlow font-black uppercase text-[11px] disabled:opacity-40"
                >
                  {busy === step.key ? t('siInvio') : t('siInviaAlSidi')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {msg && (
        <div className={`rounded-xl p-4 flex items-start gap-2 font-maven text-sm ${msg.kind === 'ok' ? 'bg-kidville-success-soft text-kidville-success' : msg.kind === 'gated' ? 'bg-kidville-warn-soft text-kidville-warn' : 'bg-kidville-error-soft text-kidville-error'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{msg.text}</span>
        </div>
      )}
    </div>
  )
}
