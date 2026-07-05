'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  UserPlus, Baby, Users, FileText, CheckCircle2, XCircle, Loader2,
  ChevronLeft, Clock, KeyRound, AlertTriangle, ExternalLink, Star,
  Inbox, Send, Copy, Link2, Pencil, Plus,
} from 'lucide-react'
import { ADULT_ROLE_LABELS } from '@/lib/forms/enrollment-template'
import type { EnrollmentSubmissionData, EnrollmentChild, EnrollmentAdult } from '@/types/database.types'
import { CockpitPage, PageHeader, StatCard, Tabs } from '@/components/ui/cockpit'
import { useSediAttive } from '@/lib/context/sede-context'
import { publicFormUrl } from '@/lib/forms/publish'

interface SubmissionRow {
  id: string
  data: EnrollmentSubmissionData
  status: 'pending' | 'approved' | 'rejected'
  assigned_classes?: Record<string, string>
  credentials?: { email: string; password: string } | null
  created_at: string
}

interface Section { id: string; name: string }

export default function IscrizioniPage() {
  const [tab, setTab] = useState<'ricevute' | 'moduli'>('ricevute')
  return (
    <CockpitPage max={1152}>
      <PageHeader
        icon={UserPlus}
        title="Iscrizioni"
        subtitle="Richieste ricevute e moduli d'iscrizione da inviare ai genitori tramite link."
        actions={
          <a
            href="/admin/sidi"
            className="inline-flex h-[46px] items-center gap-2 rounded-pill bg-kidville-green-soft px-5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green/20"
          >
            <ExternalLink size={16} /> Interoperabilità SIDI
          </a>
        }
      />
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as 'ricevute' | 'moduli')}
        options={[
          { id: 'ricevute', label: 'Ricevute', icon: Inbox },
          { id: 'moduli', label: 'Moduli inviabili', icon: Send },
        ]}
      />
      {tab === 'ricevute' ? <RicevuteTab /> : <ModuliTab />}
    </CockpitPage>
  )
}

interface FormModel {
  id: string
  title: string
  is_active?: boolean
  is_enrollment_form?: boolean
  published_at?: string | null
  public_token?: string | null
  access_mode?: string | null
}

function ModuliTab() {
  const [models, setModels] = useState<FormModel[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () => {
    fetch('/api/admin/forms/models')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setModels(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

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

      {/* Modulo predefinito: wizard fisso /iscrizione */}
      <div className="rounded-card border border-kidville-line bg-kidville-white p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="font-barlow font-bold text-kidville-ink">Modulo d&apos;iscrizione standard
              <span className="ml-2 text-[10px] uppercase bg-kidville-cream px-2 py-0.5 rounded-full text-kidville-muted">predefinito</span>
            </p>
            <p className="font-maven text-xs text-kidville-muted">Wizard pubblico sempre attivo. Le richieste arrivano nel tab «Ricevute».</p>
          </div>
          <button onClick={() => copyLink(`${origin}/iscrizione`, 'std')} className="inline-flex items-center gap-1.5 rounded-pill border border-kidville-green/30 px-3 py-1.5 text-sm text-kidville-green">
            {copied === 'std' ? <><CheckCircle2 size={14} /> Copiato</> : <><Copy size={14} /> Copia link</>}
          </button>
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

function RicevuteTab() {
  const [rows, setRows] = useState<SubmissionRow[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SubmissionRow | null>(null)
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [referenteIndex, setReferenteIndex] = useState(0)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<{ credentials?: { email: string; password: string } | null; credentialsEmailSent?: boolean; warnings?: string[] } | null>(null)

  const { reFetchKey } = useSediAttive()

  // Fetch iniziale + re-fetch al cambio sedi attive. `load` è una function
  // semplice (non tracciata da react-hooks/set-state-in-effect) e riceve la
  // chiave sedi come argomento, così reFetchKey è referenziato nell'effect.
  useEffect(() => { load(reFetchKey) }, [reFetchKey])

  async function load(sediKey: string) {
    // Nessun setLoading(true) sincrono qui: lo stato parte già a `true`; al
    // re-fetch i dati si aggiornano senza rimettere lo spinner.
    try {
      // `x-sedi`: chiave di re-fetch (il server scopa dal cookie).
      const hdr = { 'x-sedi': sediKey }
      const [r, s] = await Promise.all([
        fetch('/api/admin/iscrizioni', { headers: hdr }).then(x => x.json()),
        fetch('/api/admin/sections', { headers: hdr }).then(x => x.json()),
      ])
      if (Array.isArray(r)) setRows(r)
      if (Array.isArray(s)) setSections(s)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  function openDetail(row: SubmissionRow) {
    setSelected(row)
    setAssignments(row.assigned_classes ?? {})
    setReferenteIndex(0)
    setResult(null)
  }

  async function viewDoc(path?: string) {
    if (!path) return
    const res = await fetch(`/api/admin/iscrizioni?doc=${encodeURIComponent(path)}`)
    const json = await res.json()
    if (json.url) window.open(json.url, '_blank')
  }

  async function doImport() {
    if (!selected) return
    setWorking(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/iscrizioni', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, action: 'import', assignments, referenteIndex }),
      })
      const json = await res.json()
      if (!res.ok) { alert(json.error ?? 'Import fallito'); return }
      setResult({ credentials: json.credentials, credentialsEmailSent: json.credentialsEmailSent, warnings: json.warnings })
      await load(reFetchKey)
    } catch (e) {
      console.error(e)
      alert('Errore durante l\'import')
    } finally {
      setWorking(false)
    }
  }

  async function doReject() {
    if (!selected) return
    if (!confirm('Rifiutare questa richiesta di iscrizione?')) return
    setWorking(true)
    try {
      await fetch('/api/admin/iscrizioni', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, action: 'reject' }),
      })
      await load(reFetchKey)
      setSelected(null)
    } finally {
      setWorking(false)
    }
  }

  const pending = rows.filter(r => r.status === 'pending')

  return (
    <>
      {!loading && rows.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Users} label="Totale richieste" value={rows.length} tone="green" />
          <StatCard icon={Clock} label="In attesa" value={pending.length} tone="warn" />
          <StatCard icon={CheckCircle2} label="Importate" value={rows.filter((r) => r.status === 'approved').length} tone="success" />
          <StatCard icon={XCircle} label="Rifiutate" value={rows.filter((r) => r.status === 'rejected').length} tone="error" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh] gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-kidville-green" />
          <span className="font-maven text-kidville-muted">Caricamento…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-kidville-white rounded-card p-10 text-center border border-kidville-line">
          <Clock className="w-10 h-10 text-kidville-neutral/50 mx-auto mb-3" />
          <p className="font-maven text-kidville-muted">Nessuna richiesta di iscrizione ricevuta.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-5">
          {/* Lista */}
          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted">
              In attesa ({pending.length}) · Totale {rows.length}
            </p>
            {rows.map(row => {
              const nChildren = row.data?.children?.length ?? 0
              const nAdults = row.data?.adults?.length ?? 0
              const firstChild = row.data?.children?.[0]
              return (
                <button
                  key={row.id}
                  onClick={() => openDetail(row)}
                  className={`w-full text-left bg-kidville-white rounded-card p-4 border transition-all ${
                    selected?.id === row.id ? 'border-kidville-green ring-1 ring-kidville-green/30' : 'border-kidville-line hover:border-kidville-line'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-barlow font-bold text-kidville-ink">
                      {firstChild ? `${firstChild.nome ?? ''} ${firstChild.cognome ?? ''}` : 'Iscrizione'}
                    </span>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-kidville-muted font-maven">
                    <span className="flex items-center gap-1"><Baby size={13} /> {nChildren}</span>
                    <span className="flex items-center gap-1"><Users size={13} /> {nAdults}</span>
                    <span>{new Date(row.created_at).toLocaleDateString('it-IT')}</span>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Dettaglio */}
          <div>
            {!selected ? (
              <div className="bg-kidville-white rounded-card p-10 text-center border border-kidville-line text-kidville-muted font-maven">
                Seleziona una richiesta per i dettagli.
              </div>
            ) : (
              <DetailPanel
                row={selected}
                sections={sections}
                assignments={assignments}
                setAssignments={setAssignments}
                referenteIndex={referenteIndex}
                setReferenteIndex={setReferenteIndex}
                working={working}
                result={result}
                onImport={doImport}
                onReject={doReject}
                onViewDoc={viewDoc}
                onBack={() => setSelected(null)}
              />
            )}
          </div>
        </div>
      )}
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: 'In attesa', cls: 'bg-kidville-warn-soft text-kidville-warn' },
    approved: { label: 'Importata', cls: 'bg-kidville-success-soft text-kidville-success' },
    rejected: { label: 'Rifiutata', cls: 'bg-kidville-error-soft text-kidville-error' },
  }
  const m = map[status] ?? map.pending
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>
}

function DetailPanel({
  row, sections, assignments, setAssignments, referenteIndex, setReferenteIndex,
  working, result, onImport, onReject, onViewDoc, onBack,
}: {
  row: SubmissionRow
  sections: Section[]
  assignments: Record<string, string>
  setAssignments: (a: Record<string, string>) => void
  referenteIndex: number
  setReferenteIndex: (n: number) => void
  working: boolean
  result: { credentials?: { email: string; password: string } | null; credentialsEmailSent?: boolean; warnings?: string[] } | null
  onImport: () => void
  onReject: () => void
  onViewDoc: (path?: string) => void
  onBack: () => void
}) {
  const children = row.data?.children ?? []
  const adults = row.data?.adults ?? []
  const done = row.status !== 'pending'

  return (
    <div className="bg-kidville-white rounded-card border border-kidville-line p-5 space-y-5">
      <button onClick={onBack} className="md:hidden flex items-center gap-1 text-sm text-kidville-muted">
        <ChevronLeft size={16} /> Indietro
      </button>

      {/* Bambini */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted mb-2 flex items-center gap-1.5">
          <Baby size={14} /> Bambini ({children.length})
        </p>
        <div className="space-y-3">
          {children.map((c: EnrollmentChild, i: number) => (
            <div key={i} className="rounded-xl border border-kidville-line p-3 bg-kidville-cream/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-kidville-ink">{c.nome} {c.cognome}</span>
                {c.documento_path && (
                  <button onClick={() => onViewDoc(c.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> Documento <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-kidville-muted font-mono mt-0.5">{c.codice_fiscale} · {c.data_nascita}</p>
              {!done && (
                <div className="mt-2">
                  <label className="text-[11px] font-semibold text-kidville-muted uppercase">Classe / Sezione *</label>
                  <select
                    value={assignments[String(i)] ?? ''}
                    onChange={e => setAssignments({ ...assignments, [String(i)]: e.target.value })}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                  >
                    <option value="">Seleziona sezione…</option>
                    {sections.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
              )}
              {done && assignments[String(i)] && (
                <p className="text-xs text-kidville-success mt-1">Classe: {assignments[String(i)]}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Adulti */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted mb-2 flex items-center gap-1.5">
          <Users size={14} /> Adulti ({adults.length})
        </p>
        <div className="space-y-3">
          {adults.map((a: EnrollmentAdult, i: number) => (
            <div key={i} className="rounded-xl border border-kidville-line p-3 bg-kidville-cream/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-kidville-ink">
                  {a.first_name} {a.last_name}
                  <span className="ml-2 text-[10px] font-semibold uppercase text-kidville-muted">
                    {ADULT_ROLE_LABELS[a.ruolo] ?? a.ruolo}
                  </span>
                </span>
                {a.documento_path && (
                  <button onClick={() => onViewDoc(a.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> Documento <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-kidville-muted font-mono mt-0.5">{a.fiscal_code}</p>
              <p className="text-xs text-kidville-muted mt-0.5">{a.email || 'Nessuna email'} · {a.phone || 'Nessun telefono'}</p>
              {!done && (
                <label className="flex items-center gap-2 mt-2 text-xs text-kidville-ink/70 cursor-pointer">
                  <input
                    type="radio"
                    name="referente"
                    checked={referenteIndex === i}
                    onChange={() => setReferenteIndex(i)}
                    className="accent-kidville-green"
                  />
                  <Star size={12} className={referenteIndex === i ? 'text-kidville-warn' : 'text-kidville-neutral/50'} />
                  Referente / intestatario (riceve l&apos;account di accesso)
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Risultato import */}
      {result && (
        <div className="rounded-xl border border-kidville-success/30 bg-kidville-success-soft p-3 space-y-2">
          <p className="text-sm font-semibold text-kidville-success flex items-center gap-1.5">
            <CheckCircle2 size={16} /> Iscrizione importata
          </p>
          {result.credentials && (
            <div className="text-xs text-kidville-success flex items-center gap-2">
              <KeyRound size={13} />
              <span>Credenziali: <strong>{result.credentials.email}</strong> / <code>{result.credentials.password}</code></span>
            </div>
          )}
          {result.credentials && (
            <p className="text-xs flex items-center gap-1.5">
              {result.credentialsEmailSent
                ? <><CheckCircle2 size={12} className="text-kidville-success" /> <span className="text-kidville-success">Credenziali inviate via email al referente.</span></>
                : <><AlertTriangle size={12} className="text-kidville-warn" /> <span className="text-kidville-warn">Email non inviata: comunicare le credenziali manualmente.</span></>}
            </p>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="text-xs text-kidville-warn">
              <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> Avvisi:</p>
              <ul className="list-disc ml-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* Azioni */}
      {!done && (
        <div className="flex items-center gap-3 pt-2 border-t border-kidville-line">
          <button
            onClick={onImport}
            disabled={working}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-kidville-green text-kidville-yellow font-semibold text-sm hover:opacity-90 disabled:opacity-50 transition-all"
          >
            {working ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            Importa nelle anagrafiche
          </button>
          <button
            onClick={onReject}
            disabled={working}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-kidville-error/30 text-kidville-error font-semibold text-sm hover:bg-kidville-error-soft disabled:opacity-50 transition-all"
          >
            <XCircle size={16} /> Rifiuta
          </button>
        </div>
      )}
    </div>
  )
}
