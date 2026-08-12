'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useDateFormat } from '@/lib/i18n/date'
import {
  Baby, Users, FileText, CheckCircle2, XCircle, Loader2,
  ChevronLeft, Clock, KeyRound, AlertTriangle, ExternalLink, Star, MapPin,
} from 'lucide-react'
import { ADULT_ROLE_LABELS } from '@/lib/forms/enrollment-template'
import { LIMITE_ISCRIZIONI_DEFAULT } from '@/lib/api/paginazione'
import type { EnrollmentSubmissionData, EnrollmentChild, EnrollmentAdult } from '@/types/database.types'
import { StatCard } from '@/components/ui/cockpit'
import { useSediAttive } from '@/lib/context/sede-context'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { AVVISO_FINESTRA_BLOCCATA, apriDocumentoFirmato } from '@/lib/ui/apri-documento-firmato'

// Esito dell'import. `success:false` = almeno un errore BLOCCANTE (referente/figlio non
// creati): l'invio resta tra i "Da importare" e va mostrato il pannello d'errore in evidenza.
interface ImportResult {
  success?: boolean
  credentials?: { email: string; password: string } | null
  credentialsEmailSent?: boolean
  warnings?: string[]
  errors?: { dove: string; messaggio: string }[]
}

// "Moduli ricevuti": iscrizioni compilate via /iscrizione (enrollment_submissions)
// con import in anagrafica. Estratto da /admin/iscrizioni (tab "Ricevute").

// NB: niente `credentials` qui dentro. La GET non lo restituisce più (e la PATCH
// non lo archivia più): la password del genitore si vede UNA volta sola, nella
// risposta dell'import — vedi `ImportResult` qui sopra — e poi si rigenera da
// «Rigenera credenziali». Il campo era dichiarato e mai letto: toglierlo evita
// che qualcuno ci ricostruisca sopra un elenco di password.
//
// ⚠️ E dal 2026-08-04 (T11-F4) niente `data` NELL'ELENCO. La lista mostra il
// nome del primo bambino e due conteggi: prima, per disegnarli, si tirava giù
// il payload INTERO di ogni domanda — codici fiscali dei minori, ALLERGIE e
// NOTE MEDICHE in testo libero, recapiti degli adulti. Misurato in produzione:
// 299 domande, 514 kB verso il browser di ogni membro dello staff a ogni
// apertura della pagina, anche senza aprire nessun dettaglio. Ora l'elenco
// porta un `riassunto` e il payload arriva da `GET ?id=<uuid>`, cioè quando
// qualcuno APRE quella domanda: una alla volta, e per scelta.
interface RigaElenco {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  assigned_classes?: Record<string, string>
  created_at: string
  // Sede per cui la famiglia ha fatto domanda (scelta al passo 0 del wizard).
  scuola_id?: string | null
  riassunto?: { bambini: number; adulti: number; primo_bambino: string | null }
}

/** La domanda APERTA: la riga d'elenco più il payload, letto dal dettaglio. */
interface SubmissionRow extends RigaElenco {
  data: EnrollmentSubmissionData
}

interface Section { id: string; name: string; scuola_id?: string | null }

export function ModuliRicevuti() {
  const t = useTranslations('adminAltro')
  const f = useDateFormat()
  const [rows, setRows] = useState<RigaElenco[]>([])
  const [totale, setTotale] = useState(0)
  const [caricandoAltre, setCaricandoAltre] = useState(false)
  const [sections, setSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SubmissionRow | null>(null)
  const [aprendo, setAprendo] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [referenteIndex, setReferenteIndex] = useState(0)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  /** La URL firmata che il browser ha rifiutato di aprire: si offre come link. */
  const [docBloccato, setDocBloccato] = useState<string | null>(null)

  const { reFetchKey, sedi } = useSediAttive()

  // Con tre plessi la domanda va letta insieme alla sua sede: importare "alla cieca"
  // significa archiviare un bambino di Aversa a Giugliano. L'uuid non dice niente a
  // nessuno, quindi si risolve nel nome del plesso.
  const nomeSede = (scuolaId?: string | null) =>
    sedi.find((s) => s.id === scuolaId)?.nome ?? t('ricevutiSedeSconosciuta')

  useEffect(() => { load(reFetchKey) }, [reFetchKey])

  async function load(sediKey: string) {
    try {
      const hdr = { 'x-sedi': sediKey }
      const [r, s] = await Promise.all([
        fetch(`/api/admin/iscrizioni?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=0`, { headers: hdr }).then(x => x.json()),
        fetch('/api/admin/sections', { headers: hdr }).then(x => x.json()),
      ])
      // La risposta è `{ data, total }`: `total` è il conteggio ESATTO lato
      // database, non la lunghezza della pagina. Serve a dire all'operatore
      // quante domande ci sono davvero, e non solo quante gliene sono arrivate.
      if (Array.isArray(r?.data)) {
        setRows(r.data as RigaElenco[])
        setTotale(typeof r.total === 'number' ? r.total : r.data.length)
      }
      if (Array.isArray(s)) setSections(s)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `moduli-iscrizione-caricamento-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
    } finally {
      setLoading(false)
    }
  }

  /** Pagina successiva, in coda a quelle già mostrate. */
  async function caricaAltre() {
    setCaricandoAltre(true)
    try {
      const r = await fetch(
        `/api/admin/iscrizioni?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=${rows.length}`,
        { headers: { 'x-sedi': reFetchKey } },
      ).then(x => x.json())
      if (Array.isArray(r?.data)) {
        setRows(prec => [...prec, ...(r.data as RigaElenco[])])
        if (typeof r.total === 'number') setTotale(r.total)
      }
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `moduli-iscrizione-pagina-fallita: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
    } finally {
      setCaricandoAltre(false)
    }
  }

  /**
   * Apre una domanda: è QUI che il payload viene chiesto, per una riga sola.
   * L'esito non si butta via — il server risponde 404 anche quando la domanda
   * è di un'altra sede, e un pannello che resta vuoto senza dire niente è
   * peggio di un errore.
   */
  async function openDetail(row: RigaElenco) {
    setSelected(null)
    setAprendo(row.id)
    setAssignments(row.assigned_classes ?? {})
    setReferenteIndex(0)
    setResult(null)
    try {
      const res = await fetch(`/api/admin/iscrizioni?id=${encodeURIComponent(row.id)}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const json = await res.json()
      if (!res.ok || !json?.data) {
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `iscrizione-dettaglio-non-aperto: http ${res.status}`,
          route: '/admin/iscrizioni',
        })
        alert(json?.error ?? t('ricevutiDettaglioNonAperto'))
        return
      }
      setSelected(json.data as SubmissionRow)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `iscrizione-dettaglio-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
      alert(t('ricevutiDettaglioNonAperto'))
    } finally {
      setAprendo(null)
    }
  }

  /**
   * La scansione allegata alla domanda: URL firmata dal server, scheda nuova.
   *
   * ⚠️ QUESTA FUNZIONE ERA ROTTA IN TRE PUNTI, e il difetto si vedeva solo su
   * Safari e dentro la WebView Capacitor — cioè proprio dove la segreteria apre
   * l'app dal telefono. Apriva la finestra DOPO l'`await`, quindi il popup
   * blocker la fermava; non guardava `res.ok`, quindi un 403 finiva in un
   * `json.url` assente e in nessun messaggio; e faceva `await res.json()` senza
   * rete di protezione, cioè una promise rifiutata non gestita su un corpo non
   * JSON. Il gesto era lo stesso di `CandidatureInsegnanti`, ma la copia aveva
   * già smesso di somigliare all'originale: adesso il COME sta in un posto solo
   * (`@/lib/ui/apri-documento-firmato`) e qui resta solo cosa dire.
   */
  async function viewDoc(path?: string) {
    if (!path) return
    setDocBloccato(null)
    const esito = await apriDocumentoFirmato({
      endpoint: '/api/admin/iscrizioni',
      path,
      headers: { 'x-sedi': reFetchKey },
      route: '/admin/iscrizioni',
      etichetta: 'iscrizione-documento',
    })
    if (esito.esito === 'bloccato') setDocBloccato(esito.url)
    else if (esito.esito === 'errore') alert(t('ricevutiDocumentoErrore'))
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
      if (!res.ok) { alert(json.error ?? t('ricevutiImportFallito')); return }
      // `success:false` = errori bloccanti: l'invio resta 'pending' (nessun cambio di stato
      // lato server), quindi resta tra i "Da importare" e i pulsanti Importa/Rifiuta restano
      // disponibili per riprovare. Il pannello d'errore lo mostra in evidenza.
      setResult({
        success: json.success !== false,
        credentials: json.credentials,
        credentialsEmailSent: json.credentialsEmailSent,
        warnings: json.warnings,
        errors: json.errors,
      })
      await load(reFetchKey)
    } catch (e) {
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `iscrizione-import-fallito: ${nomeErrore(e)}`,
        route: '/admin/iscrizioni',
      })
      alert(t('ricevutiErroreImport'))
    } finally {
      setWorking(false)
    }
  }

  async function doReject() {
    if (!selected) return
    if (!confirm(t('ricevutiConfermaRifiuto'))) return
    setWorking(true)
    try {
      const res = await fetch('/api/admin/iscrizioni', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, action: 'reject' }),
      })
      // L'esito NON si butta via: il server può rispondere 403 (domanda di un'altra
      // sede). Ricaricare e chiudere il pannello senza guardare significherebbe dire
      // all'operatore "fatto" su un rifiuto che non è mai avvenuto.
      if (!res.ok) {
        // Un corpo illeggibile non deve far sparire l'avviso all'operatore: si
        // ripiega sul messaggio generico, ma l'anomalia si logga (mai un catch muto).
        const json = await res.json().catch((e: unknown) => {
          logClient({
            livello: 'warn',
            evento: 'react',
            messaggio: `iscrizione-rifiuto-corpo-illeggibile: ${nomeErrore(e)}`,
            route: '/admin/iscrizioni',
          })
          return {} as { error?: string }
        })
        alert(json.error ?? t('ricevutiImportFallito'))
        return
      }
      await load(reFetchKey)
      setSelected(null)
    } finally {
      setWorking(false)
    }
  }

  const pending = rows.filter(r => r.status === 'pending')
  const tutteCaricate = rows.length >= totale

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <p className="font-maven text-sm text-kidville-muted max-w-xl">{t('ricevutiIntro')}</p>
        <a
          href="/admin/sidi"
          className="inline-flex h-[40px] items-center gap-2 rounded-pill bg-kidville-green-soft px-4 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green/20"
        >
          <ExternalLink size={16} /> {t('ricevutiSidi')}
        </a>
      </div>

      {!loading && rows.length > 0 && (
        // «Totale» viene dal conteggio ESATTO del server; i tre riquadri per
        // stato contano le righe CARICATE, quindi si mostrano solo quando sono
        // tutte. Un conteggio parziale presentato come totale sarebbe una
        // bugia scritta in grande — meglio un riquadro in meno.
        <div className={`mb-6 grid grid-cols-2 gap-3 ${tutteCaricate ? 'sm:grid-cols-4' : 'sm:grid-cols-1'}`}>
          <StatCard icon={Users} label={t('ricevutiStatTotale')} value={totale} tone="green" />
          {tutteCaricate && (
            <>
              <StatCard icon={Clock} label={t('ricevutiStatAttesa')} value={pending.length} tone="warn" />
              <StatCard icon={CheckCircle2} label={t('ricevutiStatImportate')} value={rows.filter((r) => r.status === 'approved').length} tone="success" />
              <StatCard icon={XCircle} label={t('ricevutiStatRifiutate')} value={rows.filter((r) => r.status === 'rejected').length} tone="error" />
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh] gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-kidville-green" />
          <span className="font-maven text-kidville-muted">{t('caricamento')}</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-kidville-white rounded-card p-10 text-center border border-kidville-line">
          <Clock className="w-10 h-10 text-kidville-neutral/50 mx-auto mb-3" />
          <p className="font-maven text-kidville-muted">{t('ricevutiVuoto')}</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-5">
          {/* Lista */}
          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted">
              {t('ricevutiListaHeader', { attesa: pending.length, totale: rows.length })}
            </p>
            {/* `sub` e non `muted`: la riga qui sotto È l'avviso che l'elenco è troncato —
                l'unico segnale che dice all'operatore che ci sono domande che non sta
                vedendo. Scriverla nel grigio a basso contrasto renderebbe poco leggibile
                proprio la frase che esiste per farsi leggere. (lock `testo-muted-allowlist`) */}
            {!tutteCaricate && (
              <p className="text-xs text-kidville-sub font-maven">
                {t('ricevutiMostrate', { n: rows.length, totale })}
              </p>
            )}
            {rows.map(row => {
              const nChildren = row.riassunto?.bambini ?? 0
              const nAdults = row.riassunto?.adulti ?? 0
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
                      {row.riassunto?.primo_bambino ?? t('ricevutiFallbackNome')}
                    </span>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-kidville-muted font-maven flex-wrap">
                    <span className="flex items-center gap-1"><Baby size={13} /> {nChildren}</span>
                    <span className="flex items-center gap-1"><Users size={13} /> {nAdults}</span>
                    <span>{f.dataBreve(row.created_at)}</span>
                    <span className="flex items-center gap-1 text-kidville-green font-semibold">
                      <MapPin size={13} /> {nomeSede(row.scuola_id)}
                    </span>
                  </div>
                </button>
              )
            })}
            {!tutteCaricate && (
              <button
                onClick={caricaAltre}
                disabled={caricandoAltre}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green-soft disabled:opacity-50"
              >
                {caricandoAltre && <Loader2 size={14} className="animate-spin" />}
                {t('ricevutiMostraAltre')}
              </button>
            )}
          </div>

          {/* Dettaglio */}
          <div>
            {aprendo ? (
              <div className="bg-kidville-white rounded-card p-10 flex items-center justify-center gap-3 border border-kidville-line">
                <Loader2 className="w-5 h-5 animate-spin text-kidville-green" />
                <span className="font-maven text-kidville-sub">{t('caricamento')}</span>
              </div>
            ) : !selected ? (
              <div className="bg-kidville-white rounded-card p-10 text-center border border-kidville-line text-kidville-muted font-maven">
                {t('ricevutiSelezionaDettagli')}
              </div>
            ) : (
              <DetailPanel
                row={selected}
                sections={sections}
                nomeSede={nomeSede(selected.scuola_id)}
                assignments={assignments}
                setAssignments={setAssignments}
                referenteIndex={referenteIndex}
                setReferenteIndex={setReferenteIndex}
                working={working}
                result={result}
                onImport={doImport}
                onReject={doReject}
                onViewDoc={viewDoc}
                docBloccato={docBloccato}
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
  const t = useTranslations('adminAltro')
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: t('ricevutiStatAttesa'), cls: 'bg-kidville-warn-soft text-kidville-warn' },
    approved: { label: t('badgeImportata'), cls: 'bg-kidville-success-soft text-kidville-success' },
    rejected: { label: t('badgeRifiutata'), cls: 'bg-kidville-error-soft text-kidville-error' },
  }
  const m = map[status] ?? map.pending
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>
}

function DetailPanel({
  row, sections, nomeSede, assignments, setAssignments, referenteIndex, setReferenteIndex,
  working, result, onImport, onReject, onViewDoc, docBloccato, onBack,
}: {
  row: SubmissionRow
  sections: Section[]
  nomeSede: string
  assignments: Record<string, string>
  setAssignments: (a: Record<string, string>) => void
  referenteIndex: number
  setReferenteIndex: (n: number) => void
  working: boolean
  result: ImportResult | null
  onImport: () => void
  onReject: () => void
  onViewDoc: (path?: string) => void
  /** URL firmata che il browser ha bloccato: sta in cima, non accanto al bottone
      premuto — i pulsanti «Documento» sono uno per bambino e uno per adulto, e
      l'avviso è uno solo. */
  docBloccato: string | null
  onBack: () => void
}) {
  const t = useTranslations('adminAltro')
  const ts = useTranslations('shared')
  const children = row.data?.children ?? []
  const adults = row.data?.adults ?? []
  const done = row.status !== 'pending'
  // Le sezioni sono per plesso e i nomi si ripetono fra sedi ("3 ANNI" esiste in
  // tutte e tre): offrire quelle delle altre sedi porta dritti a un `section_id`
  // NULL, perché il trigger DB risolve il nome SOLO dentro la scuola dell'alunno.
  // Se l'invio non ha sede (storico) non c'è niente su cui filtrare: si mostrano tutte.
  const sezioniSede = row.scuola_id
    ? sections.filter((s) => s.scuola_id === row.scuola_id)
    : sections

  return (
    <div className="bg-kidville-white rounded-card border border-kidville-line p-5 space-y-5">
      <button onClick={onBack} className="md:hidden flex items-center gap-1 text-sm text-kidville-muted">
        <ChevronLeft size={16} /> {t('ricevutiIndietro')}
      </button>

      {/* Per quale scuola si sta importando: prima di ogni altro dato. */}
      <p className="flex items-center gap-1.5 rounded-xl bg-kidville-green-soft px-3 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
        <MapPin size={14} /> {t('ricevutiSede')} <strong>{nomeSede}</strong>
      </p>

      {docBloccato && (
        <p role="alert" className={AVVISO_FINESTRA_BLOCCATA}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {ts('docFinestraBloccata')}{' '}
          <a href={docBloccato} target="_blank" rel="noopener noreferrer" className="font-bold text-kidville-green underline">
            {ts('docApriManuale')}
          </a>
        </p>
      )}

      {/* Bambini */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted mb-2 flex items-center gap-1.5">
          <Baby size={14} /> {t('ricevutiBambini', { count: children.length })}
        </p>
        <div className="space-y-3">
          {children.map((c: EnrollmentChild, i: number) => (
            <div key={i} className="rounded-xl border border-kidville-line p-3 bg-kidville-cream/50">
              <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-kidville-ink">{c.nome} {c.cognome}</span>
                {c.documento_path && (
                  <button onClick={() => onViewDoc(c.documento_path)} className="text-xs text-kidville-green flex items-center gap-1 hover:underline">
                    <FileText size={13} /> {t('ricevutiDocumento')} <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-kidville-muted font-mono mt-0.5">{c.codice_fiscale} · {c.data_nascita}</p>
              {!done && (
                <div className="mt-2">
                  <label className="text-[11px] font-semibold text-kidville-muted uppercase">{t('ricevutiClasseSezione')}</label>
                  <select
                    value={assignments[String(i)] ?? ''}
                    onChange={e => setAssignments({ ...assignments, [String(i)]: e.target.value })}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-kidville-line text-sm bg-white focus:outline-none focus:border-kidville-green"
                  >
                    <option value="">{t('ricevutiSelezionaSezione')}</option>
                    {sezioniSede.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
              )}
              {done && assignments[String(i)] && (
                <p className="text-xs text-kidville-success mt-1">{t('ricevutiClasseAssegnata', { classe: assignments[String(i)] })}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Adulti */}
      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-kidville-muted mb-2 flex items-center gap-1.5">
          <Users size={14} /> {t('ricevutiAdulti', { count: adults.length })}
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
                    <FileText size={13} /> {t('ricevutiDocumento')} <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <p className="text-xs text-kidville-muted font-mono mt-0.5">{a.fiscal_code}</p>
              <p className="text-xs text-kidville-muted mt-0.5">{a.email || t('ricevutiNessunaEmail')} · {a.phone || t('ricevutiNessunTelefono')}</p>
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
                  {t('ricevutiReferente')}
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Esito import — errore bloccante (in evidenza) */}
      {result && result.success === false && (
        <div className="rounded-xl border-2 border-kidville-error/40 bg-kidville-error-soft p-4 space-y-2">
          <p className="text-sm font-bold text-kidville-error-strong flex items-center gap-1.5">
            <XCircle size={16} /> {t('ricevutiImportNonCompletato')}
          </p>
          <p className="text-xs text-kidville-error-strong">
            {t('ricevutiImportNonCompletatoDesc')}
          </p>
          {result.errors && result.errors.length > 0 && (
            <ul className="text-xs text-kidville-error-strong list-disc ml-5 space-y-0.5">
              {result.errors.map((er, i) => (
                <li key={i}><strong>{er.dove}:</strong> {er.messaggio}</li>
              ))}
            </ul>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="text-xs text-kidville-warn-strong mt-1">
              <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> {t('ricevutiAvvisi')}</p>
              <ul className="list-disc ml-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* Esito import — successo */}
      {result && result.success !== false && (
        <div className="rounded-xl border border-kidville-success/30 bg-kidville-success-soft p-3 space-y-2">
          <p className="text-sm font-semibold text-kidville-success flex items-center gap-1.5">
            <CheckCircle2 size={16} /> {t('ricevutiImportata')}
          </p>
          {result.credentials && (
            <div className="text-xs text-kidville-success flex items-center gap-2">
              <KeyRound size={13} />
              <span>{t('ricevutiCredenziali')} <strong>{result.credentials.email}</strong> / <code>{result.credentials.password}</code></span>
            </div>
          )}
          {result.credentials && (
            <p className="text-xs flex items-center gap-1.5">
              {result.credentialsEmailSent
                ? <><CheckCircle2 size={12} className="text-kidville-success" /> <span className="text-kidville-success">{t('ricevutiCredInviate')}</span></>
                : <><AlertTriangle size={12} className="text-kidville-warn" /> <span className="text-kidville-warn-strong">{t('ricevutiCredNonInviate')}</span></>}
            </p>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="text-xs text-kidville-warn-strong">
              <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> {t('ricevutiAvvisi')}</p>
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
            {t('ricevutiImporta')}
          </button>
          <button
            onClick={onReject}
            disabled={working}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-kidville-error/30 text-kidville-error font-semibold text-sm hover:bg-kidville-error-soft disabled:opacity-50 transition-all"
          >
            <XCircle size={16} /> {t('ricevutiRifiuta')}
          </button>
        </div>
      )}
    </div>
  )
}
