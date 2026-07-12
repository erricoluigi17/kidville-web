'use client'

import { useCallback, useEffect, useState } from 'react'
import { Award, Download, PenLine, Save, Stamp } from 'lucide-react'
import { COMPETENZE_CHIAVE, LIVELLI, COMPETENZE_SIGNIFICATIVE_CODICE } from '@/lib/competenze/modello'
import { cx } from '@/lib/ui/cx'
import { Badge } from '@/components/ui/Badge'

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

// Scala A/B/C/D del certificato (D.M. 14/2024) — legittima e DISTINTA dai
// giudizi sintetici della pagella. Colore crescente per livello.
const LEVEL_ACTIVE: Record<string, string> = {
  A: 'bg-kidville-success text-kidville-white',
  B: 'bg-kidville-info text-kidville-white',
  C: 'bg-kidville-warn text-kidville-white',
  D: 'bg-kidville-error text-kidville-white',
}
const LEVEL_DOT: Record<string, string> = {
  A: 'bg-kidville-success', B: 'bg-kidville-info', C: 'bg-kidville-warn', D: 'bg-kidville-error',
}

export function CompetenzePanel({ userId }: { userId: string }) {
  const hdr = useCallback(() => ({ 'Content-Type': 'application/json', 'x-user-id': userId }), [userId])
  const [sezioni, setSezioni] = useState<Sezione[]>([])
  const [sezioniLoaded, setSezioniLoaded] = useState(false)
  const [sectionId, setSectionId] = useState('')
  const [certs, setCerts] = useState<Cert[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
      .finally(() => setSezioniLoaded(true))
  }, [userId, hdr])

  const loadCerts = useCallback(async (sec: string) => {
    if (!sec) return
    const r = await fetch(`/api/admin/competenze?sectionId=${sec}&userId=${userId}`, { headers: hdr() })
    const d = await r.json()
    const list: Cert[] = d.data ?? []
    setCerts(list)
    setSelectedId((prev) => (list.some((c) => c.id === prev) ? prev : list[0]?.id ?? null))
  }, [userId, hdr])

  function selectSection(sec: string) {
    setSectionId(sec); setCerts([]); setSelectedId(null); setMsg(null); loadCerts(sec)
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

  // «Protocolla» (registro protocolli): registra il PDF già archiviato in
  // USCITA con numero e fascia di segnatura, senza scaricarlo e ricaricarlo.
  async function protocolla(c: Cert) {
    setBusy(`prot:${c.id}`); setMsg(null)
    try {
      const r = await fetch(`/api/admin/protocolli/da-documento?userId=${userId}`, {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ sorgente: 'certificato_competenze', id: c.id }),
      })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error ?? 'Protocollazione non riuscita'); return }
      setMsg(`Certificato protocollato in uscita: n. ${d.data?.numeroFormattato ?? ''}.`)
      if (d.data?.downloadTimbrato) window.open(d.data.downloadTimbrato, '_blank')
    } finally { setBusy(null) }
  }

  async function download(c: Cert) {
    const r = await fetch(`/api/admin/competenze/download?certificatoId=${c.id}&userId=${userId}`, { headers: hdr() })
    const d = await r.json()
    if (d.url) window.open(d.url, '_blank')
    else setMsg(d.error ?? 'PDF non disponibile')
  }

  const statoTone = (s: string) => (s === 'firmato' ? 'success' : s === 'generato' ? 'info' : 'read') as 'success' | 'info' | 'read'
  const selected = certs.find((c) => c.id === selectedId) ?? null
  const nomeOf = (c: Cert) => { const a = one(c.alunni); return `${a?.cognome ?? ''} ${a?.nome ?? ''}`.trim() || 'Alunno' }
  const ini = (c: Cert) => { const a = one(c.alunni); return `${a?.cognome?.[0] ?? ''}${a?.nome?.[0] ?? ''}`.toUpperCase() || 'AL' }

  // Nessuna classe quinta nei plessi consentiti: il Certificato delle Competenze
  // si compila solo a fine 5ª primaria, quindi non c'è nulla da mostrare.
  if (sezioniLoaded && sezioni.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-kidville-line bg-kidville-white/60 p-10 text-center">
        <Award size={30} className="mx-auto text-kidville-muted" />
        <h3 className="mt-3 font-barlow text-lg font-black uppercase text-kidville-green">Nessuna classe quinta</h3>
        <p className="mx-auto mt-2 max-w-md font-maven text-sm text-kidville-muted">
          Il Certificato delle Competenze (D.M. 14/2024) si rilascia a fine classe quinta di primaria.
          Nei tuoi plessi non risultano classi quinte: quando ce ne sarà una, comparirà qui per creare
          le bozze dallo scrutinio finale, assegnare i livelli A/B/C/D e firmare.
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-5">
      {/* toolbar: selettore classe + crea bozze + legenda livelli */}
      <section className="rounded-2xl border border-kidville-line bg-kidville-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <select value={sectionId} onChange={(e) => selectSection(e.target.value)} className="h-9 rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven text-sm text-kidville-ink">
            <option value="">Seleziona classe quinta…</option>
            {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={seed} disabled={!sectionId || busy === 'seed'} className="h-9 rounded-pill bg-kidville-green px-4 font-barlow text-xs font-black uppercase text-kidville-yellow disabled:opacity-50">
            {busy === 'seed' ? 'Creazione…' : 'Crea bozze dallo scrutinio finale'}
          </button>
        </div>
        {/* legenda scala A/B/C/D */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-kidville-line pt-3">
          <span className="font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-muted">Scala D.M. 14/2024</span>
          {LIVELLI.map((l) => (
            <span key={l.codice} className="inline-flex items-center gap-1.5 font-maven text-xs text-kidville-ink/80">
              <span className={cx('inline-flex h-5 w-5 items-center justify-center rounded-md font-barlow text-[11px] font-black text-kidville-white', LEVEL_DOT[l.codice])}>{l.codice}</span>
              {l.etichetta}
            </span>
          ))}
        </div>
        {msg && <p className="mt-3 font-maven text-sm text-kidville-ink/80">{msg}</p>}
      </section>

      {/* split lista/dettaglio */}
      {certs.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-kidville-line bg-kidville-white/60 p-10 text-center">
          <Award size={26} className="mx-auto text-kidville-muted" />
          <p className="mt-2 font-maven text-sm text-kidville-muted">Seleziona una classe quinta e crea le bozze per iniziare.</p>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr] lg:items-start">
          {/* lista alunni */}
          <aside className="rounded-2xl border border-kidville-line bg-kidville-white p-2">
            {certs.map((c) => {
              const on = c.id === selectedId
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors', on ? 'bg-kidville-green-soft' : 'hover:bg-kidville-cream')}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kidville-green/[0.10] font-barlow text-xs font-extrabold text-kidville-green">{ini(c)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-barlow text-sm font-extrabold uppercase text-kidville-green">{nomeOf(c)}</span>
                    <span className="mt-0.5 inline-flex"><Badge tone={statoTone(c.stato)}>{c.stato}</Badge></span>
                  </span>
                </button>
              )
            })}
          </aside>

          {/* dettaglio certificato selezionato */}
          {selected && (
            <section className="rounded-2xl border border-kidville-line bg-kidville-white p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 font-barlow text-lg font-black uppercase text-kidville-green">
                  <Award size={18} /> {nomeOf(selected)}
                </h3>
                <Badge tone={statoTone(selected.stato)}>{selected.stato}</Badge>
              </div>
              <div className="space-y-3">
                {COMPETENZE_CHIAVE.map((comp) => (
                  <div key={comp.codice} className="flex flex-col gap-2 border-b border-kidville-line pb-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                    <span className="flex-1 font-maven text-[13px] text-kidville-ink/80">{comp.etichetta}</span>
                    <div className="flex shrink-0 gap-1.5">
                      {LIVELLI.map((l) => {
                        const active = livelloOf(selected, comp.codice) === l.codice
                        return (
                          <button
                            key={l.codice}
                            title={`${l.codice} — ${l.etichetta}`}
                            onClick={() => setField(selected.id, comp.codice, active ? '' : l.codice)}
                            className={cx('h-9 w-9 rounded-lg font-barlow text-sm font-black transition-colors', active ? LEVEL_ACTIVE[l.codice] : 'bg-kidville-neutral-soft text-kidville-neutral hover:bg-kidville-green-soft hover:text-kidville-green')}
                          >
                            {l.codice}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
                <div>
                  <label className="mb-1 block font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-muted">Competenze significative (facoltativo)</label>
                  <textarea value={noteOf(selected)} onChange={(e) => setField(selected.id, COMPETENZE_SIGNIFICATIVE_CODICE, e.target.value)} placeholder="Es. eccellenza in ambito musicale…" className="w-full rounded-lg border border-kidville-line bg-kidville-white p-2.5 font-maven text-[13px] text-kidville-ink outline-none focus:border-kidville-green" rows={2} />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button onClick={() => save(selected)} disabled={busy === `save:${selected.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-kidville-green-soft px-3.5 font-barlow text-[11px] font-black uppercase text-kidville-green disabled:opacity-50"><Save size={13} /> Salva livelli</button>
                <button onClick={() => genera(selected)} disabled={busy === `gen:${selected.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-kidville-yellow px-3.5 font-barlow text-[11px] font-black uppercase text-kidville-green disabled:opacity-50"><PenLine size={13} /> Genera e firma</button>
                {(selected.stato === 'generato' || selected.stato === 'firmato') && (
                  <>
                    <button onClick={() => download(selected)} className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-kidville-green px-3.5 font-barlow text-[11px] font-black uppercase text-kidville-yellow"><Download size={13} /> Scarica PDF</button>
                    <button onClick={() => protocolla(selected)} disabled={busy === `prot:${selected.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-kidville-info-soft px-3.5 font-barlow text-[11px] font-black uppercase text-kidville-info disabled:opacity-50"><Stamp size={13} /> Protocolla</button>
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
