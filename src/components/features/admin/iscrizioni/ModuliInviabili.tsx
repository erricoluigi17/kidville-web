'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  CheckCircle2, Loader2, Copy, Link2, Pencil, Plus, RotateCcw,
} from 'lucide-react'
import { publicFormUrl } from '@/lib/forms/publish'
import { STANDARD_ENROLLMENT_MODEL_ID } from '@/lib/forms/enrollment-default-schema'

// "Moduli inviabili": moduli del form-builder + Modulo d'iscrizione standard,
// da inviare ai genitori tramite link. Estratto da /admin/iscrizioni.

interface FormModel {
  id: string
  title: string
  is_active?: boolean
  is_enrollment_form?: boolean
  published_at?: string | null
  public_token?: string | null
  access_mode?: string | null
}

export function ModuliInviabili() {
  const [models, setModels] = useState<FormModel[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const load = () => {
    // Assicura l'esistenza del modello standard editabile (seed idempotente).
    fetch('/api/iscrizione/model').catch(() => {})
    fetch('/api/admin/forms/models')
      .then((r) => r.json())
      // Il modulo standard ha la sua card dedicata: escludilo dalla lista generica.
      .then((d) => { if (Array.isArray(d)) setModels(d.filter((m: FormModel) => m.id !== STANDARD_ENROLLMENT_MODEL_ID)) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const resetStandard = async () => {
    if (!confirm('Reimpostare il Modulo d\'iscrizione standard ai valori di base? Le modifiche fatte verranno annullate.')) return
    setResetting(true)
    try {
      const res = await fetch('/api/admin/form-models/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: STANDARD_ENROLLMENT_MODEL_ID }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error || 'Errore'); return }
      alert('Modulo d\'iscrizione standard ripristinato ai valori di base.')
    } finally {
      setResetting(false)
    }
  }

  const togglePublish = async (m: FormModel) => {
    setBusy(m.id)
    try {
      const res = await fetch('/api/admin/form-models/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id, action: m.published_at ? 'unpublish' : 'publish' }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error || 'Errore'); return }
      load()
    } finally { setBusy(null) }
  }

  const copyLink = async (url: string, id: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(null), 2000) } catch { /* no-op */ }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="font-maven text-sm text-kidville-muted max-w-xl">Moduli personalizzabili da inviare ai genitori tramite link. Modificali nel builder e pubblicali per ottenere il link condivisibile.</p>
        <Link href="/admin/forms/builder" className="inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-bold uppercase text-kidville-yellow"><Plus size={15} /> Nuovo modulo</Link>
      </div>

      {/* Modulo predefinito: wizard /iscrizione, editabile dal builder */}
      <div className="rounded-card border border-kidville-line bg-kidville-white p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-barlow font-bold text-kidville-ink">Modulo d&apos;iscrizione standard
              <span className="ml-2 text-[10px] uppercase bg-kidville-cream px-2 py-0.5 rounded-full text-kidville-muted">predefinito</span>
            </p>
            <p className="font-maven text-xs text-kidville-muted">Wizard pubblico sempre attivo. Le richieste arrivano nel tab «Moduli ricevuti». Modificabile dal builder.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link href={`/admin/forms/builder?id=${STANDARD_ENROLLMENT_MODEL_ID}`} className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 text-sm text-kidville-muted hover:text-kidville-green">
              <Pencil size={14} /> Modifica
            </Link>
            <button onClick={resetStandard} disabled={resetting} className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-warn/30 px-3 py-1.5 text-sm text-kidville-warn disabled:opacity-50">
              {resetting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Reimposta
            </button>
            <button onClick={() => copyLink(`${origin}/iscrizione`, 'std')} className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 px-3 py-1.5 text-sm text-kidville-green">
              {copied === 'std' ? <><CheckCircle2 size={14} /> Copiato</> : <><Copy size={14} /> Copia link</>}
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-kidville-muted p-4"><Loader2 size={16} className="animate-spin" /> Caricamento…</div>
      ) : models.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted p-2">Nessun modulo personalizzato. Creane uno con «Nuovo modulo».</p>
      ) : models.map((m) => {
        const pub = !!m.published_at
        const url = m.public_token ? `${origin}${publicFormUrl(m.public_token)}` : ''
        return (
          <div key={m.id} className="rounded-card border border-kidville-line bg-kidville-white p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="font-barlow font-bold text-kidville-ink truncate">
                  {m.title}
                  {m.is_enrollment_form && <span className="ml-2 text-[10px] uppercase bg-kidville-green-soft px-2 py-0.5 rounded-full text-kidville-green">iscrizione</span>}
                  <span className={`ml-2 text-[10px] uppercase px-2 py-0.5 rounded-full ${pub ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-warn-soft text-kidville-warn'}`}>{pub ? 'pubblicato' : 'bozza'}</span>
                </p>
                {pub && url && <p className="font-maven text-xs text-kidville-muted truncate">{url}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link href={`/admin/forms/builder?id=${m.id}`} className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 text-sm text-kidville-muted hover:text-kidville-green"><Pencil size={14} /> Modifica</Link>
                {pub && url && (
                  <button onClick={() => copyLink(url, m.id)} className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 px-3 py-1.5 text-sm text-kidville-green">
                    {copied === m.id ? <><CheckCircle2 size={14} /> Copiato</> : <><Copy size={14} /> Copia link</>}
                  </button>
                )}
                <button onClick={() => togglePublish(m)} disabled={busy === m.id} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm ${pub ? 'border border-kidville-error/30 text-kidville-error' : 'bg-kidville-green text-kidville-yellow'}`}>
                  {busy === m.id ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                  {pub ? 'Ritira' : 'Pubblica'}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
