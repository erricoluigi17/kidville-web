'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Printer, Download, Eye, Loader2, AlertTriangle } from 'lucide-react'
import { CockpitPage, PageHeader } from '@/components/ui/cockpit'
import { Btn } from '@/components/ui/Btn'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { apriDocumento, scaricaDocumento } from '@/lib/native/scarica'
import { CATALOGO_STORICI, espandiCategorie, type CategoriaStorico, type RichiestaStorico } from '@/lib/storici/catalogo'
import { oggiRoma } from '@/lib/storici/retroattivita'
import { periodoStorico, type PeriodoStorico } from '@/lib/storici/periodi'
import type { StatoGenerazione } from '@/lib/storici/tipi'
import { GestioneAppartenenze } from './GestioneAppartenenze'
import { CollegamentiStorici } from './CollegamentiStorici'

interface Scuola { scuolaId: string; scuolaNome: string; sezioni: Array<{ id: string; name: string }> }
interface Alunno { id: string; nome: string; cognome: string; archiviato_il: string | null }
interface Lavoro { id: string; stato: StatoGenerazione; cursore: number; richiesta: RichiestaStorico; titolo: string | null; avvisi: string[]; errore: string | null }
const INPUT = 'min-h-11 w-full rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: 'no-store' })
  const body = await res.json()
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Operazione non riuscita')
  return body as T
}

export function StoriciPanel() {
  const t = useTranslations('storici')
  const search = useSearchParams()
  const { userId } = useSessionIdentity()
  const [scuole, setScuole] = useState<Scuola[]>([])
  const [scuolaId, setScuolaId] = useState(search.get('scuolaId') ?? '')
  const [alunni, setAlunni] = useState<Alunno[]>([])
  const [classiStoriche, setClassiStoriche] = useState<Array<{ id: string; name: string }>>([])
  const [tipo, setTipo] = useState<'alunno' | 'classe'>(search.get('alunnoId') ? 'alunno' : 'classe')
  const [destinatario, setDestinatario] = useState(search.get('alunnoId') ?? search.get('sectionId') ?? '')
  const [periodo, setPeriodo] = useState(() => /^\d{4}-\d{2}-\d{2}$/.test(search.get('dal') ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(search.get('al') ?? '') ? { dal: search.get('dal')!, al: search.get('al')! } : periodoStorico('mese', oggiRoma()))
  const [categorie, setCategorie] = useState<CategoriaStorico[]>(() => {
    const gruppo = search.get('gruppo')
    return gruppo ? CATALOGO_STORICI.filter(c => c.gruppo === gruppo && c.id !== 'dossier_completo').map(c => c.id) : ['diario_completo']
  })
  const [disponibili, setDisponibili] = useState<string[]>([])
  const [formato, setFormato] = useState<'pdf' | 'xlsx'>('pdf')
  const [raggruppamento, setRaggruppamento] = useState<'classe' | 'alunno'>('classe')
  const [lavori, setLavori] = useState<Lavoro[]>([])
  const [errore, setErrore] = useState('')
  const [impegnato, setImpegnato] = useState(false)
  const [caricamento, setCaricamento] = useState(true)
  const [anteprima, setAnteprima] = useState<{ titolo: string; alunni: number; avvisi: string[]; sezioni: Array<{ id: string; titolo: string }> } | null>(null)
  const sedeCorrente = scuole.find(s => s.scuolaId === scuolaId)
  const sede = sedeCorrente ? { ...sedeCorrente, sezioni: [...new Map([...classiStoriche, ...sedeCorrente.sezioni].map(s => [s.id, s])).values()] } : undefined
  const identita = useCallback((url: string) => `${url}${url.includes('?') ? '&' : '?'}userId=${encodeURIComponent(userId ?? '')}`, [userId])
  const segnala = useCallback((error: unknown) => {
    setErrore(error instanceof Error ? error.message : 'Operazione non riuscita')
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `storici: ${nomeErrore(error)}` })
  }, [])
  useEffect(() => {
    if (!userId) return
    let attivo = true
    json<{ data: Scuola[] }>(identita('/api/admin/sections/scoped')).then(r => {
      if (!attivo) return
      setScuole(r.data)
      setScuolaId(id => id || r.data.find(s => s.sezioni.some(c => c.id === search.get('sectionId')))?.scuolaId || r.data[0]?.scuolaId || '')
    }).catch(segnala).finally(() => { if (attivo) setCaricamento(false) })
    return () => { attivo = false }
  }, [userId, identita, segnala, search])
  useEffect(() => {
    if (!userId || !scuolaId) return
    let attivo = true
    json<{ alunni: Alunno[]; classiStoriche: Array<{ id: string; name: string }>; categorie: Array<{ id: string; disponibile: boolean }> }>(identita(`/api/admin/storici/catalogo?scuolaId=${scuolaId}`)).then(r => {
      if (!attivo) return
      setAlunni(r.alunni)
      setClassiStoriche(r.classiStoriche)
      setDisponibili(r.categorie.filter(c => c.disponibile).map(c => c.id))
    }).catch(segnala)
    return () => { attivo = false }
  }, [userId, scuolaId, identita, segnala])
  const aggiornaLavori = useCallback(async () => {
    const r = await json<{ data: Lavoro[] }>(identita('/api/admin/storici/generazioni'))
    setLavori(r.data)
  }, [identita])
  useEffect(() => {
    if (!userId) return
    let attivo = true
    let timer: ReturnType<typeof setTimeout>
    const aggiorna = async () => {
      try {
        const r = await json<{ data: Lavoro[] }>(identita('/api/admin/storici/generazioni'))
        if (attivo) { setLavori(r.data); timer = setTimeout(aggiorna, r.data.some(j => ['in_coda', 'in_corso'].includes(j.stato)) ? 4000 : 20000) }
      } catch (error) { if (attivo) { segnala(error); timer = setTimeout(aggiorna, 20000) } }
    }
    void aggiorna()
    return () => { attivo = false; clearTimeout(timer) }
  }, [userId, identita, segnala])
  const richiesta = useMemo(() => ({ scuolaId, ...(tipo === 'alunno' ? { alunnoId: destinatario } : { sectionId: destinatario }), ...periodo, categorie, formato, raggruppamento }), [scuolaId, tipo, destinatario, periodo, categorie, formato, raggruppamento])
  const pronta = !!scuolaId && !!destinatario && categorie.length > 0 && periodo.dal <= periodo.al && !impegnato
  const invia = async (genera: boolean) => {
    setImpegnato(true); setErrore('')
    try {
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(richiesta) }
      if (genera) { await json(identita('/api/admin/storici/generazioni'), init); await aggiornaLavori() }
      else setAnteprima(await json(identita('/api/admin/storici/anteprima'), init))
    } catch (error) { segnala(error) } finally { setImpegnato(false) }
  }
  const file = async (lavoro: Lavoro, apri: boolean) => {
    const input = { sorgente: identita(`/api/admin/storici/generazioni/${lavoro.id}/file`), nomeFile: `storico-${lavoro.richiesta.dal}-${lavoro.richiesta.al}.${lavoro.richiesta.formato}`, mime: lavoro.richiesta.formato === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', titolo: t('titolo'), etichetta: 'storici' }
    const esito = await (apri ? apriDocumento(input) : scaricaDocumento(input))
    if (esito.esito === 'non-riuscito') setErrore(t('erroreFile'))
  }
  const gruppi = [...new Set(CATALOGO_STORICI.map(c => c.gruppo))]
  return <CockpitPage max={1200}>
    <PageHeader icon={Printer} title={t('titolo')} subtitle={t('sottotitolo')} />
    {errore && <div role="alert" className="mb-4 rounded-xl bg-kidville-error-soft p-4 font-maven text-sm text-kidville-error">{errore}</div>}
    {caricamento ? <p role="status"><Loader2 className="animate-spin" aria-label={t('caricamento')} /></p> : <>
      <div className="grid gap-4 rounded-card bg-white p-5 shadow-sm md:grid-cols-3">
        <div className="font-maven text-sm"><label htmlFor="storici-sede">{t('sede')}</label><select id="storici-sede" className={INPUT} value={scuolaId} onChange={e => { setScuolaId(e.target.value); setDestinatario(''); setAlunni([]); setClassiStoriche([]); setDisponibili([]); setAnteprima(null) }}><option value="">{t('scegli')}</option>{scuole.map(s => <option key={s.scuolaId} value={s.scuolaId}>{s.scuolaNome}</option>)}</select></div>
        <div className="font-maven text-sm"><label htmlFor="storici-tipo">{t('destinatario')}</label><select id="storici-tipo" className={INPUT} value={tipo} onChange={e => { setTipo(e.target.value as typeof tipo); setDestinatario(''); setAnteprima(null) }}><option value="classe">{t('classe')}</option><option value="alunno">{t('alunno')}</option></select></div>
        <div className="font-maven text-sm"><label htmlFor="storici-destinatario">{tipo === 'alunno' ? t('alunno') : t('classe')}</label><select id="storici-destinatario" className={INPUT} value={destinatario} onChange={e => { setDestinatario(e.target.value); setAnteprima(null) }}><option value="">{t('scegli')}</option>{tipo === 'alunno' ? alunni.map(a => <option key={a.id} value={a.id}>{a.cognome} {a.nome}{a.archiviato_il ? ` (${t('archiviato')})` : ''}</option>) : sede?.sezioni.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <label className="font-maven text-sm">{t('dal')}<input className={INPUT} type="date" value={periodo.dal} onChange={e => setPeriodo(p => ({ ...p, dal: e.target.value }))} /></label>
        <label className="font-maven text-sm">{t('al')}<input className={INPUT} type="date" value={periodo.al} onChange={e => setPeriodo(p => ({ ...p, al: e.target.value }))} /></label>
        <div className="font-maven text-sm"><label htmlFor="storici-formato">{t('formato')}</label><select id="storici-formato" className={INPUT} value={formato} onChange={e => setFormato(e.target.value as typeof formato)}><option value="pdf">PDF</option><option value="xlsx">Excel</option></select></div>
        <div className="flex flex-wrap gap-2 md:col-span-3">{(['giorno', 'settimana', 'mese', 'anno', 'tutto'] as PeriodoStorico[]).map(p => <button key={p} type="button" className="min-h-11 rounded-pill border border-kidville-line px-3 text-sm" onClick={() => setPeriodo(periodoStorico(p, oggiRoma()))}>{t(`periodi.${p}`)}</button>)}</div>
        {tipo === 'classe' && <div className="font-maven text-sm md:col-span-3"><label htmlFor="storici-raggruppamento">{t('raccolta')}</label><select id="storici-raggruppamento" className={INPUT} value={raggruppamento} onChange={e => setRaggruppamento(e.target.value as typeof raggruppamento)}><option value="classe">{t('riepilogoClasse')}</option><option value="alunno">{t('schedeIndividuali')}</option></select></div>}
      </div>
      <div className="my-5 flex flex-wrap gap-3"><Btn type="button" onClick={() => setCategorie(CATALOGO_STORICI.filter(c => disponibili.includes(c.id)).map(c => c.id))}>{t('selezionaTutto')}</Btn><Btn type="button" onClick={() => setCategorie([])}>{t('deseleziona')}</Btn></div>
      <div className="grid gap-4 md:grid-cols-2">{gruppi.map(gruppo => <fieldset key={gruppo} className="rounded-card bg-white p-5 shadow-sm"><legend className="px-2 font-barlow text-lg font-bold text-kidville-green">{t(`gruppi.${gruppo}`)}</legend>{CATALOGO_STORICI.filter(c => c.gruppo === gruppo).map(c => <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-3 font-maven text-sm"><input type="checkbox" className="h-5 w-5 accent-kidville-green" checked={categorie.includes(c.id)} disabled={!disponibili.includes(c.id)} onChange={e => setCategorie(v => e.target.checked ? [...v, c.id] : v.filter(id => id !== c.id))} />{t(`categorie.${c.id}`)}{!disponibili.includes(c.id) && <span className="text-kidville-sub">{t('riservato')}</span>}</label>)}</fieldset>)}</div>
      <div className="my-5 flex flex-wrap gap-3"><Btn type="button" disabled={!pronta} onClick={() => void invia(false)}>{t('verificaSelezione')}</Btn><Btn type="button" disabled={!pronta} onClick={() => void invia(true)}>{impegnato ? <Loader2 className="animate-spin" size={16} /> : <Printer size={16} />}{t('genera')}</Btn></div>
      {anteprima && <section className="mb-5 rounded-card bg-white p-5"><h2 className="font-barlow text-lg font-bold">{anteprima.titolo}</h2><p>{t('riepilogoSelezione', { alunni: anteprima.alunni, sezioni: anteprima.sezioni.length })}</p>{anteprima.avvisi.map((a, i) => <p key={i} className="mt-2 text-kidville-warn">{a}</p>)}</section>}
      <section className="mt-6"><h2 className="font-barlow text-xl font-bold text-kidville-green">{t('generazioni')}</h2><p className="mb-3 font-maven text-sm text-kidville-sub">{t('scadenza')}</p>{lavori.length === 0 && <p>{t('nessunLavoro')}</p>}<div className="grid gap-3">{lavori.map(j => <article key={j.id} className="rounded-card bg-white p-5 shadow-sm"><h3 className="font-maven font-semibold">{j.titolo} · {j.richiesta.dal} / {j.richiesta.al} · {j.richiesta.formato.toUpperCase()}</h3><p role="status">{t(`stati.${j.stato}`)} · {j.cursore}/{espandiCategorie(j.richiesta.categorie).length}</p>{j.errore && <p role="alert" className="text-kidville-error">{j.errore}</p>}{j.avvisi.length > 0 && <details className="my-2"><summary className="flex min-h-11 cursor-pointer items-center gap-2"><AlertTriangle size={16} />{t('avvertenze')}</summary>{j.avvisi.map((a, i) => <p key={i} className="mb-2 text-sm">{a}</p>)}</details>}{['completato', 'parziale'].includes(j.stato) && <div className="mt-3 flex gap-3">{j.richiesta.formato === 'pdf' && <Btn type="button" onClick={() => void file(j, true)}><Eye size={16} />{t('apri')}</Btn>}<Btn type="button" onClick={() => void file(j, false)}><Download size={16} />{t('scarica')}</Btn></div>}</article>)}</div></section>
      {scuolaId && <><GestioneAppartenenze key={`appartenenze-${scuolaId}`} scuolaId={scuolaId} alunni={alunni} sezioni={sede?.sezioni ?? []} identita={identita} /><CollegamentiStorici key={`collegamenti-${scuolaId}`} scuolaId={scuolaId} alunni={alunni} identita={identita} /></>}
    </>}
  </CockpitPage>
}
