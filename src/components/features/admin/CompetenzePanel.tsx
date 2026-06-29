'use client'

import { useCallback, useEffect, useState } from 'react'
import { Award, Download, PenLine } from 'lucide-react'
import { COMPETENZE_CHIAVE, LIVELLI, COMPETENZE_SIGNIFICATIVE_CODICE } from '@/lib/competenze/modello'

interface Livello { competenza_codice: string; livello: string | null; note: string | null }
interface Cert {
  id: string
  stato: string
  anno_scolastico: string
  alunni?: { nome?: string; cognome?: string } | { nome?: string; cognome?: string }[] | null
  certificato_competenza_livelli?: Livello[]
}
interface Sezione { id: string; name: string; school_type: string }

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)

export function CompetenzePanel({ userId }: { userId: string }) {
  const hdr = useCallback(() => ({ 'Content-Type': 'application/json', 'x-user-id': userId }), [userId])
  const [sezioni, setSezioni] = useState<Sezione[]>([])
  const [sectionId, setSectionId] = useState('')
  const [certs, setCerts] = useState<Cert[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({})
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/admin/sections?userId=${userId}`, { headers: hdr() })
      .then((r) => r.json())
      .then((d) => {
        const arr: Sezione[] = Array.isArray(d) ? d : d.data ?? []
        setSezioni(arr.filter((s) => s.school_type === 'primaria' && /5/.test(s.name ?? '')))
      })
      .catch(() => { /* no-op */ })
  }, [userId, hdr])

  const loadCerts = useCallback(async (sec: string) => {
    if (!sec) return
    const r = await fetch(`/api/admin/competenze?sectionId=${sec}&userId=${userId}`, { headers: hdr() })
    const d = await r.json()
    setCerts(d.data ?? [])
  }, [userId, hdr])

  function selectSection(sec: string) {
    setSectionId(sec); setCerts([]); setMsg(null); loadCerts(sec)
  }

  async function seed() {
    if (!sectionId) return
    setBusy('seed'); setMsg(null)
    try {
      const r = await fetch(`/api/admin/competenze?userId=${userId}`, { method: 'POST', headers: hdr(), body: JSON.stringify({ sectionId }) })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error ?? 'Errore nella creazione delle bozze'); return }
      setMsg(`Bozze create/riallineate: ${d.creati}.`)
      await loadCerts(sectionId)
    } finally { setBusy(null) }
  }

  function livelloOf(c: Cert, codice: string): string {
    const e = edit[c.id]?.[codice]
    if (e !== undefined) return e
    return c.certificato_competenza_livelli?.find((l) => l.competenza_codice === codice)?.livello ?? ''
  }
  function noteOf(c: Cert): string {
    const e = edit[c.id]?.[COMPETENZE_SIGNIFICATIVE_CODICE]
    if (e !== undefined) return e
    return c.certificato_competenza_livelli?.find((l) => l.competenza_codice === COMPETENZE_SIGNIFICATIVE_CODICE)?.note ?? ''
  }
  function setField(certId: string, codice: string, val: string) {
    setEdit((p) => ({ ...p, [certId]: { ...(p[certId] ?? {}), [codice]: val } }))
  }

  async function save(c: Cert) {
    setBusy(`save:${c.id}`); setMsg(null)
    try {
      const livelli = COMPETENZE_CHIAVE.map((comp) => ({ competenza_codice: comp.codice, livello: livelloOf(c, comp.codice) || null }))
      const r = await fetch(`/api/admin/competenze?userId=${userId}`, { method: 'PATCH', headers: hdr(), body: JSON.stringify({ certificatoId: c.id, livelli, competenzeSignificative: noteOf(c) }) })
      if (!r.ok) { const d = await r.json(); setMsg(d.error ?? 'Salvataggio fallito'); return }
      setMsg('Livelli salvati (certificato riportato in bozza).')
      await loadCerts(sectionId)
    } finally { setBusy(null) }
  }

  async function genera(c: Cert) {
    setBusy(`gen:${c.id}`); setMsg(null)
    try {
      const r = await fetch(`/api/admin/competenze/genera?userId=${userId}`, { method: 'POST', headers: hdr(), body: JSON.stringify({ certificatoId: c.id }) })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error ?? 'Generazione fallita'); return }
      setMsg('Certificato generato e firmato.')
      await loadCerts(sectionId)
    } finally { setBusy(null) }
  }

  async function download(c: Cert) {
    const r = await fetch(`/api/admin/competenze/download?certificatoId=${c.id}&userId=${userId}`, { headers: hdr() })
    const d = await r.json()
    if (d.url) window.open(d.url, '_blank')
    else setMsg(d.error ?? 'PDF non disponibile')
  }

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center gap-3 flex-wrap">
          <select value={sectionId} onChange={(e) => selectSection(e.target.value)} className="h-9 px-3 rounded-xl border border-gray-200 font-maven text-sm">
            <option value="">Seleziona classe quinta…</option>
            {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={seed} disabled={!sectionId || busy === 'seed'} className="h-9 px-4 rounded-pill bg-kidville-green text-white font-barlow font-black uppercase text-xs disabled:opacity-50">
            {busy === 'seed' ? 'Creazione…' : 'Crea bozze dalla scrutinio finale'}
          </button>
        </div>
        {msg && <p className="mt-3 font-maven text-sm text-gray-600">{msg}</p>}
      </section>

      {certs.map((c) => {
        const a = one(c.alunni)
        return (
          <section key={c.id} className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-barlow font-black text-kidville-green flex items-center gap-2">
                <Award size={18} /> {a?.cognome} {a?.nome}
              </h3>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${c.stato === 'firmato' ? 'bg-green-100 text-green-700' : c.stato === 'generato' ? 'bg-kidville-info-soft text-kidville-info' : 'bg-gray-100 text-gray-500'}`}>{c.stato}</span>
            </div>
            <div className="space-y-2">
              {COMPETENZE_CHIAVE.map((comp) => (
                <div key={comp.codice} className="flex items-center justify-between gap-3">
                  <span className="font-maven text-xs text-gray-600 flex-1">{comp.etichetta}</span>
                  <select value={livelloOf(c, comp.codice)} onChange={(e) => setField(c.id, comp.codice, e.target.value)} className="h-8 px-2 rounded-lg border border-gray-200 font-maven text-xs">
                    <option value="">—</option>
                    {LIVELLI.map((l) => <option key={l.codice} value={l.codice}>{l.codice} — {l.etichetta}</option>)}
                  </select>
                </div>
              ))}
              <textarea value={noteOf(c)} onChange={(e) => setField(c.id, COMPETENZE_SIGNIFICATIVE_CODICE, e.target.value)} placeholder="Competenze significative (facoltativo)…" className="w-full mt-2 p-2 rounded-lg border border-gray-200 font-maven text-xs" rows={2} />
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button onClick={() => save(c)} disabled={busy === `save:${c.id}`} className="h-8 px-3 rounded-pill bg-gray-100 text-gray-700 font-barlow font-black uppercase text-[11px]">Salva livelli</button>
              <button onClick={() => genera(c)} disabled={busy === `gen:${c.id}`} className="h-8 px-3 rounded-pill bg-kidville-yellow text-kidville-green font-barlow font-black uppercase text-[11px] flex items-center gap-1"><PenLine size={12} /> Genera e firma</button>
              {(c.stato === 'generato' || c.stato === 'firmato') && (
                <button onClick={() => download(c)} className="h-8 px-3 rounded-pill bg-kidville-green text-white font-barlow font-black uppercase text-[11px] flex items-center gap-1"><Download size={12} /> Scarica</button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
