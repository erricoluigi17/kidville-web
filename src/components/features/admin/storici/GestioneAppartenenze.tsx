'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Btn } from '@/components/ui/Btn'
import { logClient, nomeErrore } from '@/lib/logging/client'
interface Riga { id: string; section_id: string; dal: string; al: string | null }
const INPUT = 'min-h-11 w-full rounded-xl border border-kidville-line bg-white px-3 py-2'
export function GestioneAppartenenze({ scuolaId, alunni, sezioni, identita }: {
  scuolaId: string; alunni: Array<{ id: string; nome: string; cognome: string }>; sezioni: Array<{ id: string; name: string }>; identita: (url: string) => string
}) {
  const t = useTranslations('storici')
  const [alunnoId, setAlunnoId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [dal, setDal] = useState('')
  const [al, setAl] = useState('')
  const [righe, setRighe] = useState<Riga[]>([])
  const [messaggio, setMessaggio] = useState('')
  const [inCorso, setInCorso] = useState(false)
  const operazione = async (azione: 'leggi' | 'salva' | 'rimuovi', id?: string) => {
    setInCorso(true); setMessaggio('')
    try {
      if (azione !== 'leggi') {
        const precedente = righe.find(r => r.id === id)
        const res = await fetch(identita('/api/admin/storici/appartenenze'), { method: azione === 'salva' ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(azione === 'salva' ? { scuolaId, alunnoId, sectionId, dal, al: al || null } : { scuolaId, id, dal: precedente?.dal, al: precedente?.al ?? null }) })
        const r = await res.json()
        if (!res.ok) throw new Error(r.error)
        setMessaggio(t('appartenenzaSalvata'))
      }
      const res = await fetch(identita(`/api/admin/storici/appartenenze?scuolaId=${scuolaId}&alunnoId=${alunnoId}`), { cache: 'no-store' })
      const r = await res.json()
      if (!res.ok) throw new Error(r.error)
      setRighe(r.data)
    } catch (error) {
      setMessaggio(error instanceof Error ? error.message : 'Operazione non riuscita')
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `storici-appartenenze: ${nomeErrore(error)}` })
    } finally { setInCorso(false) }
  }
  return <details className="mt-6 rounded-card bg-white p-5 shadow-sm" key={scuolaId}>
    <summary className="min-h-11 cursor-pointer font-barlow text-lg font-bold text-kidville-green">{t('appartenenze')}</summary>
    <p className="my-3 text-sm">{t('appartenenzeHint')}</p>
    <div className="grid gap-3 font-maven text-sm md:grid-cols-2">
      <label>{t('alunno')}<select className={INPUT} value={alunnoId} onChange={e => { setAlunnoId(e.target.value); setRighe([]) }}><option value="">{t('scegli')}</option>{alunni.map(a => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}</select></label>
      <label>{t('classe')}<select className={INPUT} value={sectionId} onChange={e => setSectionId(e.target.value)}><option value="">{t('scegli')}</option>{sezioni.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>{t('dal')}<input className={INPUT} type="date" value={dal} onChange={e => setDal(e.target.value)} /></label>
      <label>{t('al')}<input className={INPUT} type="date" value={al} onChange={e => setAl(e.target.value)} /></label>
    </div>
    <div className="my-3 flex flex-wrap gap-3"><Btn type="button" disabled={!alunnoId || inCorso} onClick={() => void operazione('leggi')}>{t('caricaPeriodi')}</Btn><Btn type="button" disabled={!alunnoId || !sectionId || !dal || inCorso} onClick={() => void operazione('salva')}>{t('salvaAppartenenza')}</Btn></div>
    {messaggio && <p role="status">{messaggio}</p>}
    <ul className="mt-3 space-y-2">{righe.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-kidville-line py-2"><span>{sezioni.find(s => s.id === r.section_id)?.name ?? t('classe')} · {r.dal} / {r.al ?? t('aperto')}</span><Btn type="button" disabled={inCorso} onClick={() => void operazione('rimuovi', r.id)}>{t('rimuoviAppartenenza')}</Btn></li>)}</ul>
  </details>
}
