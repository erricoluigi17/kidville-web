'use client'

import { useCallback, useEffect, useState } from 'react'
import { UploadCloud, RefreshCw, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react'

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

const STATO_LABEL: Record<string, string> = {
  non_inviato: 'Non inviato',
  in_corso: 'In corso',
  inviato: 'Inviato',
  errore: 'Errore',
}
function statoColor(s: string): string {
  if (s === 'inviato') return 'bg-green-100 text-green-700'
  if (s === 'errore') return 'bg-red-100 text-red-700'
  if (s === 'in_corso') return 'bg-kidville-warn-soft text-kidville-warn'
  return 'bg-gray-100 text-gray-500'
}

export function SidiPanel({ userId }: { userId: string }) {
  const hdr = useCallback((json = true): Record<string, string> => (json ? { 'Content-Type': 'application/json', 'x-user-id': userId } : { 'x-user-id': userId }), [userId])
  const [sync, setSync] = useState<SyncState | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'gated' | 'err'; text: string } | null>(null)

  const loadSync = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/sidi/sync-state?userId=${userId}`, { headers: hdr() })
      const d = await r.json()
      if (d.success) setSync(d.data)
    } catch { /* no-op */ }
  }, [userId, hdr])

  useEffect(() => { loadSync() }, [loadSync])

  async function upload() {
    if (!file) return
    setBusy('upload'); setMsg(null); setPreview(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/admin/sidi/import?userId=${userId}`, { method: 'POST', headers: hdr(false), body: fd })
      const d = await r.json()
      if (!r.ok) { setMsg({ kind: 'err', text: d.error ?? 'Upload fallito' }); return }
      setPreview({ batchId: d.batchId, totale: d.totale, warnings: d.warnings ?? [] })
    } finally { setBusy(null) }
  }

  async function applyBatch() {
    if (!preview) return
    setBusy('apply'); setMsg(null)
    try {
      const r = await fetch(`/api/admin/sidi/import?userId=${userId}`, { method: 'PATCH', headers: hdr(), body: JSON.stringify({ batchId: preview.batchId }) })
      const d = await r.json()
      if (!r.ok) { setMsg({ kind: 'err', text: d.error ?? 'Import fallito' }); return }
      setMsg({ kind: 'ok', text: `Import completato: ${d.matched} agganciati su numero domanda, ${d.creati} creati, ${d.aggiornati} aggiornati.` })
      setPreview(null); setFile(null)
    } finally { setBusy(null) }
  }

  async function transmit(flusso: 'fase-a' | 'frequentanti' | 'piattaforma-unica') {
    setBusy(flusso); setMsg(null)
    try {
      const r = await fetch(`/api/admin/sidi/${flusso}?userId=${userId}`, { method: 'POST', headers: hdr(), body: '{}' })
      const d = await r.json()
      if (r.status === 503) setMsg({ kind: 'gated', text: d.messaggio ?? d.error ?? 'Trasmissione SIDI non disponibile: accreditamento in corso.' })
      else if (!r.ok) setMsg({ kind: 'err', text: d.error ?? 'Errore di trasmissione' })
      else setMsg({ kind: 'ok', text: 'Trasmissione accettata.' })
      await loadSync()
    } finally { setBusy(null) }
  }

  const faseA = sync?.fase_a_stato ?? 'non_inviato'
  const freq = sync?.frequentanti_stato ?? 'non_inviato'
  const pu = sync?.piattaforma_unica_stato ?? 'non_inviato'

  return (
    <div className="space-y-6">
      {/* Import ZIP */}
      <section className="bg-white rounded-2xl border border-gray-100 p-5">
        <h2 className="font-barlow font-black text-kidville-green uppercase text-sm mb-3 flex items-center gap-2">
          <UploadCloud size={18} /> Importazione nuovi iscritti (flusso SIDI)
        </h2>
        <p className="font-maven text-xs text-gray-500 mb-3">Carica il file <code>.zip</code> ministeriale senza rinominarlo. Il matching avviene sul <strong>Numero di domanda</strong> (fallback codice fiscale); i genitori sono sincronizzati per CF.</p>
        <div className="flex items-center gap-3 flex-wrap">
          <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="font-maven text-sm" />
          <button onClick={upload} disabled={!file || busy === 'upload'} className="h-9 px-4 rounded-pill bg-kidville-green text-white font-barlow font-black uppercase text-xs disabled:opacity-50">
            {busy === 'upload' ? 'Analisi…' : 'Carica e analizza'}
          </button>
        </div>
        {preview && (
          <div className="mt-4 rounded-xl bg-kidville-cream/50 p-4">
            <p className="font-maven text-sm text-gray-700">Anteprima: <strong>{preview.totale}</strong> domande riconosciute.</p>
            {preview.warnings.length > 0 && (
              <ul className="mt-2 text-xs text-kidville-warn list-disc pl-5">
                {preview.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <button onClick={applyBatch} disabled={busy === 'apply'} className="mt-3 h-9 px-4 rounded-pill bg-kidville-yellow text-kidville-green font-barlow font-black uppercase text-xs disabled:opacity-50">
              {busy === 'apply' ? 'Importazione…' : 'Conferma import nelle anagrafiche'}
            </button>
          </div>
        )}
      </section>

      {/* Indicatore stato sincronizzazione */}
      <section className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-barlow font-black text-kidville-green uppercase text-sm">Stato sincronizzazione SIDI</h2>
          <button onClick={loadSync} className="text-gray-400 hover:text-kidville-green" aria-label="Aggiorna"><RefreshCw size={16} /></button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { key: 'fase-a' as const, label: 'Fase A — Struttura', stato: faseA, disabled: false },
            { key: 'frequentanti' as const, label: 'Frequentanti', stato: freq, disabled: faseA !== 'inviato' },
            { key: 'piattaforma-unica' as const, label: 'Piattaforma Unica', stato: pu, disabled: freq !== 'inviato' },
          ].map((step, i) => (
            <div key={step.key} className="flex items-center gap-2">
              {i > 0 && <ArrowRight size={14} className="text-gray-300" />}
              <div className="rounded-xl border border-gray-100 p-3 min-w-[150px]">
                <div className="font-maven text-xs text-gray-600 mb-1">{step.label}</div>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${statoColor(step.stato)}`}>{STATO_LABEL[step.stato] ?? step.stato}</span>
                <button
                  onClick={() => transmit(step.key)}
                  disabled={step.disabled || busy === step.key}
                  className="mt-2 block w-full h-8 px-2 rounded-pill bg-kidville-green text-white font-barlow font-black uppercase text-[11px] disabled:opacity-40"
                >
                  {busy === step.key ? 'Invio…' : 'Invia al SIDI'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {msg && (
        <div className={`rounded-xl p-4 flex items-start gap-2 font-maven text-sm ${msg.kind === 'ok' ? 'bg-green-50 text-green-800' : msg.kind === 'gated' ? 'bg-kidville-warn-soft text-kidville-warn' : 'bg-red-50 text-red-800'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{msg.text}</span>
        </div>
      )}
    </div>
  )
}
