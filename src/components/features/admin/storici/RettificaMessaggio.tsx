'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { logClient, nomeErrore } from '@/lib/logging/client'
export interface RettificaChat { rettifica_staff?: string | null; rettifica_staff_il?: string | null; rettifica_versione?: number }
export function NotaRettificaChat({ testo }: { testo?: string | null }) {
  const t = useTranslations('storici')
  return testo ? <div className="mt-2 rounded-lg border border-current p-2"><p className="text-xs font-bold">{t('rettificaStaff')}</p><p className="whitespace-pre-wrap break-words text-sm">{testo}</p></div> : null
}
export function RettificaMessaggio({ messaggio, onSaved }: { messaggio: RettificaChat & { id: string }; onSaved: (r: RettificaChat) => void }) {
  const t = useTranslations('storici')
  const [aperto, setAperto] = useState(false)
  const [testo, setTesto] = useState(messaggio.rettifica_staff ?? '')
  const [errore, setErrore] = useState('')
  const [inCorso, setInCorso] = useState(false)
  if (messaggio.rettifica_versione === undefined) return <NotaRettificaChat testo={messaggio.rettifica_staff} />
  const salva = async () => {
    setInCorso(true); setErrore('')
    try {
      const res = await fetch('/api/admin/chat/rettifica', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: messaggio.id, versione: messaggio.rettifica_versione, testo }) })
      const r = await res.json()
      if (!res.ok) throw new Error(r.error)
      onSaved(r.data); setAperto(false)
    } catch (error) {
      setErrore(error instanceof Error ? error.message : 'Operazione non riuscita')
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `rettifica-chat: ${nomeErrore(error)}` })
    } finally { setInCorso(false) }
  }
  return <div className="mt-2"><NotaRettificaChat testo={messaggio.rettifica_staff} /><button type="button" className="min-h-11 text-xs font-semibold underline" onClick={() => setAperto(v => !v)}>{t('rettificaMessaggio')}</button>{aperto && <div><label className="block text-xs">{t('rettificaTesto')}<textarea className="mt-1 min-h-24 w-full rounded-lg border border-kidville-line bg-white p-2 text-kidville-ink" maxLength={20000} value={testo} onChange={e => setTesto(e.target.value)} /></label><p className="my-2 text-xs">{t('rettificaOriginale')}</p><button className="min-h-11 rounded-pill bg-white px-3 text-sm font-semibold text-kidville-green" type="button" disabled={!testo.trim() || inCorso} onClick={() => void salva()}>{t('salvaRettifica')}</button></div>}{errore && <p role="alert" className="text-sm">{errore}</p>}</div>
}
