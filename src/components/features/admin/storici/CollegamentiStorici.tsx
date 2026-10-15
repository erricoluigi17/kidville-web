'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Btn } from '@/components/ui/Btn'
import { logClient, nomeErrore } from '@/lib/logging/client'
interface Persona { indice: number; nome: string; ruolo: string }
interface Fonte { id: string; anno?: number; numero?: number; oggetto?: string; data_registrazione?: string; created_at?: string; status?: string; form_models?: { title?: string }; figli?: Persona[]; adulti?: Persona[] }
interface Collegamento { entita_id: string; indice_figlio: number | null; adulti_indici: number[]; versione: number }
const INPUT = 'min-h-11 w-full rounded-xl border border-kidville-line bg-white px-3 py-2'
export function CollegamentiStorici({ scuolaId, alunni, identita }: { scuolaId: string; alunni: Array<{ id: string; nome: string; cognome: string }>; identita: (url: string) => string }) {
  const t = useTranslations('storici')
  const [alunnoId, setAlunnoId] = useState('')
  const [tipo, setTipo] = useState('iscrizione')
  const [fonti, setFonti] = useState<Fonte[]>([])
  const [entitaId, setEntitaId] = useState('')
  const [indiceFiglio, setIndiceFiglio] = useState('')
  const [adultiIndici, setAdultiIndici] = useState<number[]>([])
  const [collegamenti, setCollegamenti] = useState<Collegamento[]>([])
  const fonte = fonti.find(f => f.id === entitaId)
  const selezionaFonte = (id: string) => {
    const link = collegamenti.find(l => l.entita_id === id)
    setEntitaId(id); setIndiceFiglio(link?.indice_figlio == null ? '' : String(link.indice_figlio)); setAdultiIndici(link?.adulti_indici ?? [])
  }
  const [messaggio, setMessaggio] = useState('')
  const [inCorso, setInCorso] = useState(false)
  const esegui = async (salva: boolean) => {
    setInCorso(true); setMessaggio('')
    try {
      if (salva) {
        const res = await fetch(identita('/api/admin/storici/collegamenti'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scuolaId, alunnoId, tipo, entitaId, indiceFiglio: indiceFiglio === '' ? null : Number(indiceFiglio), adultiIndici, versione: collegamenti.find(l => l.entita_id === entitaId)?.versione ?? 0 }) })
        const r = await res.json()
        if (!res.ok) throw new Error(r.error)
        setMessaggio(t('collegamentoSalvato'))
        setCollegamenti(v => [...v.filter(l => l.entita_id !== entitaId), { entita_id: entitaId, indice_figlio: indiceFiglio === '' ? null : Number(indiceFiglio), adulti_indici: adultiIndici, versione: (v.find(l => l.entita_id === entitaId)?.versione ?? 0) + 1 }])
      } else {
        const raccolta: Fonte[] = []
        const associati: Collegamento[] = []
        for (let offset = 0; ; offset += 200) {
          const res = await fetch(identita(`/api/admin/storici/collegamenti?scuolaId=${scuolaId}&tipo=${tipo}&alunnoId=${alunnoId}&offset=${offset}`), { cache: 'no-store' })
          const r = await res.json()
          if (!res.ok) throw new Error(r.error)
          raccolta.push(...r.data)
          associati.push(...r.collegamenti)
          if (r.data.length < 200) break
        }
        setFonti(raccolta)
        setCollegamenti(associati); setEntitaId(''); setIndiceFiglio(''); setAdultiIndici([])
      }
    } catch (error) {
      setMessaggio(error instanceof Error ? error.message : 'Operazione non riuscita')
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `storici-collegamenti: ${nomeErrore(error)}` })
    } finally { setInCorso(false) }
  }
  return <details className="mt-6 rounded-card bg-white p-5 shadow-sm" key={scuolaId}>
    <summary className="min-h-11 cursor-pointer font-barlow text-lg font-bold text-kidville-green">{t('collegamenti')}</summary><p className="my-3 text-sm">{t('collegamentiHint')}</p>
    <div className="grid gap-3 font-maven text-sm md:grid-cols-2">
      <label>{t('alunno')}<select className={INPUT} value={alunnoId} onChange={e => { setAlunnoId(e.target.value); setFonti([]); setEntitaId(''); setCollegamenti([]) }}><option value="">{t('scegli')}</option>{alunni.map(a => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}</select></label>
      <label>{t('tipoDocumento')}<select className={INPUT} value={tipo} onChange={e => { setTipo(e.target.value); setFonti([]); setEntitaId('') }}>{['iscrizione', 'modulo', 'protocollo'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select></label>
      <Btn type="button" disabled={!alunnoId || inCorso} onClick={() => void esegui(false)}>{t('cercaDocumenti')}</Btn>
      <label>{t('documento')}<select className={INPUT} value={entitaId} onChange={e => selezionaFonte(e.target.value)}><option value="">{t('scegli')}</option>{fonti.map(f => <option key={f.id} value={f.id}>{f.numero ? `${f.numero}/${f.anno} — ${f.oggetto}` : `${f.form_models?.title ?? t(tipo)} — ${(f.created_at ?? f.data_registrazione ?? '').slice(0, 10)} — ${f.status ?? ''}`}</option>)}</select></label>
      {tipo === 'iscrizione' && fonte && <><label>{t('figlioDomanda')}<select className={INPUT} value={indiceFiglio} onChange={e => setIndiceFiglio(e.target.value)}><option value="">{t('scegli')}</option>{fonte.figli?.map(f => <option key={f.indice} value={f.indice}>{f.nome || `${t('alunno')} ${f.indice + 1}`}</option>)}</select></label><fieldset><legend>{t('adultiDomanda')}</legend>{fonte.adulti?.map(a => <label key={a.indice} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={adultiIndici.includes(a.indice)} onChange={e => setAdultiIndici(v => e.target.checked ? [...v, a.indice] : v.filter(i => i !== a.indice))} />{a.nome} {a.ruolo}</label>)}</fieldset><p className="md:col-span-2">{t('attribuzioneHint')}</p></>}
    </div><div className="my-3"><Btn type="button" disabled={!alunnoId || !entitaId || (tipo === 'iscrizione' && indiceFiglio === '') || inCorso} onClick={() => void esegui(true)}>{t('collega')}</Btn></div>{messaggio && <p role="status">{messaggio}</p>}
  </details>
}
