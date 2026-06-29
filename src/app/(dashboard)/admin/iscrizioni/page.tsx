'use client'

import { useEffect, useState } from 'react'
import {
  UserPlus, Baby, Users, FileText, CheckCircle2, XCircle, Loader2,
  ChevronLeft, Clock, KeyRound, AlertTriangle, ExternalLink, Star,
} from 'lucide-react'
import { ADULT_ROLE_LABELS } from '@/lib/forms/enrollment-template'
import type { EnrollmentSubmissionData, EnrollmentChild, EnrollmentAdult } from '@/types/database.types'

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111'

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
  const [rows, setRows] = useState<SubmissionRow[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SubmissionRow | null>(null)
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [referenteIndex, setReferenteIndex] = useState(0)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<{ credentials?: { email: string; password: string } | null; credentialsEmailSent?: boolean; warnings?: string[] } | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [r, s] = await Promise.all([
        fetch('/api/admin/iscrizioni').then(x => x.json()),
        fetch(`/api/admin/sections?scuola_id=${SCUOLA_ID}`).then(x => x.json()),
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
      await load()
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
      await load()
      setSelected(null)
    } finally {
      setWorking(false)
    }
  }

  const pending = rows.filter(r => r.status === 'pending')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus className="text-kidville-green" size={22} />
        <h1 className="font-barlow font-bold text-2xl uppercase tracking-wide">Iscrizioni Nuovi Alunni</h1>
      </div>
      <p className="font-maven text-gray-500 mb-3">
        Richieste ricevute dal form pubblico. Assegna la classe e importa nelle anagrafiche.
      </p>
      <a
        href="/admin/sidi"
        className="inline-flex items-center gap-2 mb-6 rounded-pill bg-kidville-green/10 px-4 py-2 font-maven text-sm text-kidville-green hover:bg-kidville-green/20"
      >
        <ExternalLink size={15} /> Interoperabilità SIDI — import ZIP ministeriale, Fase A, frequentanti, Piattaforma Unica
      </a>

      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh] gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-kidville-green" />
          <span className="font-maven text-gray-500">Caricamento…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-card p-10 text-center border border-gray-100">
          <Clock className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="font-maven text-gray-500">Nessuna richiesta di iscrizione ricevuta.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-5">
          {/* Lista */}
          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
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
                  className={`w-full text-left bg-white rounded-card p-4 border transition-all ${
                    selected?.id === row.id ? 'border-kidville-green ring-1 ring-kidville-green/30' : 'border-gray-100 hover:border-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-barlow font-bold text-gray-800">
                      {firstChild ? `${firstChild.nome ?? ''} ${firstChild.cognome ?? ''}` : 'Iscrizione'}
                    </span>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500 font-maven">
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
              <div className="bg-white rounded-card p-10 text-center border border-gray-100 text-gray-400 font-maven">
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
    </div>
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
    <div className="bg-white rounded-card border border-gray-100 p-5 space-y-5">
      <button onClick={onBack} className="md:hidden flex items-center gap-1 text-sm text-gray-500">
        <ChevronLeft size={16} /> Indietro
      </button>

      {/* Bambini */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2 flex items-center gap-1.5">
          <Baby size={14} /> Bambini ({children.length})
        </p>
        <div className="space-y-3">
          {children.map((c: EnrollmentChild, i: number) => (
            <div key={i} className="rounded-xl border border-gray-100 p-3 bg-gray-50/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-gray-800">{c.nome} {c.cognome}</span>
                {c.documento_path && (
                  <button onClick={() => onViewDoc(c.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> Documento <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 font-mono mt-0.5">{c.codice_fiscale} · {c.data_nascita}</p>
              {!done && (
                <div className="mt-2">
                  <label className="text-[11px] font-semibold text-gray-500 uppercase">Classe / Sezione *</label>
                  <select
                    value={assignments[String(i)] ?? ''}
                    onChange={e => setAssignments({ ...assignments, [String(i)]: e.target.value })}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-kidville-green"
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
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2 flex items-center gap-1.5">
          <Users size={14} /> Adulti ({adults.length})
        </p>
        <div className="space-y-3">
          {adults.map((a: EnrollmentAdult, i: number) => (
            <div key={i} className="rounded-xl border border-gray-100 p-3 bg-gray-50/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-gray-800">
                  {a.first_name} {a.last_name}
                  <span className="ml-2 text-[10px] font-semibold uppercase text-gray-400">
                    {ADULT_ROLE_LABELS[a.ruolo] ?? a.ruolo}
                  </span>
                </span>
                {a.documento_path && (
                  <button onClick={() => onViewDoc(a.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> Documento <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 font-mono mt-0.5">{a.fiscal_code}</p>
              <p className="text-xs text-gray-500 mt-0.5">{a.email || 'Nessuna email'} · {a.phone || 'Nessun telefono'}</p>
              {!done && (
                <label className="flex items-center gap-2 mt-2 text-xs text-gray-600 cursor-pointer">
                  <input
                    type="radio"
                    name="referente"
                    checked={referenteIndex === i}
                    onChange={() => setReferenteIndex(i)}
                    className="accent-kidville-green"
                  />
                  <Star size={12} className={referenteIndex === i ? 'text-kidville-warn' : 'text-gray-300'} />
                  Referente / intestatario (riceve l'account di accesso)
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
        <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
          <button
            onClick={onImport}
            disabled={working}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-kidville-green text-white font-semibold text-sm hover:opacity-90 disabled:opacity-50 transition-all"
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
