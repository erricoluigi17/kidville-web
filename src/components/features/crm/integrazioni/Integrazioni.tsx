'use client'

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Copy, KeyRound } from 'lucide-react'
import type { AuthChangeEvent } from '@supabase/supabase-js'
import { Modal } from '@/components/ui/Modal'
import { useDateFormat } from '@/lib/i18n/date'
import { logClient } from '@/lib/logging/client'
import { getSupabase } from '@/lib/supabase/browser-client'
import { erroreDaRisposta, type EsitoErrore } from '@/lib/ui/esito-fetch'

interface Riga {
  id: string
  nome: string
  coda: string
  revocataIl: string | null
  ultimoUsoIl: string | null
}
interface Elenco {
  data: Riga[]
  aiAttivo: boolean
  sedeAmmessa: boolean
}

type Risposta<T> = { ok: true; stato: number; dati: T } | { ok: false; errore: EsitoErrore }
type Metodo = 'GET' | 'POST' | 'DELETE'

const API = '/api/admin/crm/integrazioni'
const CARD = 'rounded-card border border-kidville-line bg-kidville-white p-5 font-maven text-sm'
const TITOLO = 'font-barlow text-lg font-black uppercase leading-tight text-kidville-green'
const BOTTONE = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 font-maven text-sm font-bold transition-colors disabled:opacity-60'
const PRIMARIO = `${BOTTONE} bg-kidville-green text-white hover:bg-kidville-green-dark`
const SECONDARIO = `${BOTTONE} border border-kidville-line bg-kidville-white text-kidville-ink hover:bg-kidville-green-soft`
const REVOCA = `${BOTTONE} border border-kidville-error/30 bg-kidville-error-soft text-kidville-error-strong`

function segnala(messaggio: string, stato?: number) {
  // Solo nomi fissi e stato HTTP. Mai corpo, eccezione, nome o chiave nel registro.
  logClient({ livello: 'error', evento: 'fetch', messaggio, route: '/admin/crm', stato })
}

async function chiedi<T>(
  metodo: Metodo, url: string, signal: AbortSignal, fallback: string, corpo?: { scuolaId: string; nome: string },
): Promise<Risposta<T>> {
  let stato: number | undefined
  try {
    const res = await fetch(url, {
      method: metodo,
      signal,
      cache: 'no-store',
      ...(corpo && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }),
    })
    signal.throwIfAborted()
    stato = res.status
    if (!res.ok) {
      const errore = await erroreDaRisposta(res, fallback)
      if (!signal.aborted) segnala(`crm-integrazioni-${metodo}-respinta`, stato)
      return { ok: false, errore }
    }
    return { ok: true, stato, dati: await res.json() as T }
  } catch {
    if (!signal.aborted) segnala(`crm-integrazioni-${metodo}-fallita`, stato)
    return { ok: false, errore: { testo: fallback, stato, codice: null, corpoLetto: false } }
  }
}

function soloDirezione(errore: EsitoErrore) {
  return errore.stato === 403 && errore.codice === 'SOLO_ADMIN'
}

export function Integrazioni({ scuolaId }: { scuolaId: string }) {
  const [sospesa, setSospesa] = useState(false)

  useEffect(() => {
    const sospendi = (evento: PageTransitionEvent) => {
      // Anche il documento congelato per «Indietro» deve perdere la chiave prima di lasciare la pagina.
      if (evento.persisted) flushSync(() => setSospesa(true))
    }
    const riprendi = (evento: PageTransitionEvent) => {
      if (evento.persisted) setSospesa(false)
    }
    window.addEventListener('pagehide', sospendi)
    window.addEventListener('pageshow', riprendi)
    return () => {
      window.removeEventListener('pagehide', sospendi)
      window.removeEventListener('pageshow', riprendi)
    }
  }, [])

  // Il cambio sede smonta l'intero pannello: nessun render intermedio con la chiave della sede precedente.
  return sospesa ? null : <PannelloSede key={scuolaId} scuolaId={scuolaId} />
}

function PannelloSede({ scuolaId }: { scuolaId: string }) {
  const t = useTranslations('crmShell')
  const fmt = useDateFormat()
  const id = useId()
  const [esito, setEsito] = useState<Risposta<Elenco> | null>(null)
  const [nome, setNome] = useState(() => t('tabIntegrazioni'))
  const [token, setToken] = useState<string | null>(null)
  const [daRevocare, setDaRevocare] = useState<string | null>(null)
  const [inCorso, setInCorso] = useState(false)
  const [erroreAzione, setErroreAzione] = useState('')
  const [sessioneTerminata, setSessioneTerminata] = useState(false)
  const attivo = useRef<AbortController | null>(null)
  const erroreLettura = t('integrazioniErroreLettura')

  const leggi = useCallback((signal: AbortSignal) => {
    const q = new URLSearchParams({ scuolaId })
    return chiedi<Elenco>('GET', `${API}?${q}`, signal, erroreLettura).then((risultato) => {
      if (signal.aborted) return
      if (risultato.ok && (!Array.isArray(risultato.dati?.data) ||
        typeof risultato.dati.aiAttivo !== 'boolean' || typeof risultato.dati.sedeAmmessa !== 'boolean')) {
        segnala('crm-integrazioni-GET-risposta-incompleta', risultato.stato)
        setEsito({ ok: false, errore: { testo: erroreLettura, stato: risultato.stato, codice: null, corpoLetto: true } })
        return
      }
      if (!risultato.ok && (risultato.errore.stato === 401 || risultato.errore.stato === 403)) {
        setToken(null)
        setDaRevocare(null)
      }
      setEsito(risultato)
    })
  }, [scuolaId, erroreLettura])

  useEffect(() => {
    const controller = new AbortController()
    attivo.current = controller
    const { data: { subscription } } = getSupabase().auth.onAuthStateChange((evento: AuthChangeEvent) => {
      if (evento !== 'SIGNED_OUT' || controller.signal.aborted) return
      controller.abort()
      setToken(null)
      setDaRevocare(null)
      setEsito(null)
      setSessioneTerminata(true)
    })
    if (!controller.signal.aborted) void leggi(controller.signal)
    return () => {
      controller.abort()
      subscription.unsubscribe()
      attivo.current = null
    }
  }, [leggi])

  const riprova = () => {
    const signal = attivo.current?.signal
    if (!signal || signal.aborted) return
    setEsito(null)
    setErroreAzione('')
    void leggi(signal)
  }

  const rifiutoAzione = (errore: EsitoErrore) => {
    if (errore.stato === 401 || soloDirezione(errore)) {
      setToken(null)
      setDaRevocare(null)
      setEsito({ ok: false, errore })
    } else {
      setErroreAzione(errore.testo)
    }
  }

  const crea = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const signal = attivo.current?.signal
    const nomeChiave = nome.trim()
    if (!signal || signal.aborted || inCorso || !nomeChiave || nomeChiave.length > 80) return
    setInCorso(true)
    setErroreAzione('')
    const fallback = t('integrazioniErroreCrea')
    const risultato = await chiedi<{ id: string; token: string }>('POST', API, signal, fallback, { scuolaId, nome: nomeChiave })
    if (signal.aborted) return
    if (risultato.ok && risultato.stato === 201 && typeof risultato.dati?.token === 'string' && risultato.dati.token) {
      setToken(risultato.dati.token)
      // Il riquadro resta aperto anche se la rilettura ha un problema di rete.
      setEsito(null)
      await leggi(signal)
    } else if (!risultato.ok) {
      rifiutoAzione(risultato.errore)
      // Un altro amministratore può avere creato la chiave nel frattempo.
      if (risultato.errore.stato === 409 && risultato.errore.codice === 'INTEGRAZIONE_ESISTENTE') {
        await leggi(signal)
      }
    } else {
      segnala('crm-integrazioni-POST-risposta-incompleta')
      setErroreAzione(fallback)
      await leggi(signal)
    }
    if (!signal.aborted) setInCorso(false)
  }

  const revoca = async () => {
    const signal = attivo.current?.signal
    if (!signal || signal.aborted || inCorso || !daRevocare) return
    setInCorso(true)
    setErroreAzione('')
    const risultato = await chiedi('DELETE', `${API}/${encodeURIComponent(daRevocare)}`, signal, t('integrazioniErroreRevoca'))
    if (signal.aborted) return
    if (risultato.ok) {
      setDaRevocare(null)
      setEsito(null)
      await leggi(signal)
    } else {
      rifiutoAzione(risultato.errore)
    }
    if (!signal.aborted) setInCorso(false)
  }

  if (sessioneTerminata || (esito && !esito.ok && esito.errore.stato === 401)) {
    return <p className={CARD} role="status">{t('integrazioniSessioneTerminata')}</p>
  }
  if (esito && !esito.ok && soloDirezione(esito.errore)) {
    return <p className={CARD} role="status">{t('integrazioniSoloDirezione')}</p>
  }

  const elenco = esito?.ok ? esito.dati : null
  const spento = elenco && (!elenco.aiAttivo || !elenco.sedeAmmessa)
  const nessunaAttiva = elenco?.data.every((riga) => riga.revocataIl !== null)
  const avvisoAzione = erroreAzione && <p role="alert" className="text-kidville-error-strong">{erroreAzione}</p>

  return (
    <section aria-labelledby={`${id}-titolo`} className={`${CARD} space-y-5`}>
      <header className="space-y-2">
        <h2 id={`${id}-titolo`} className={`${TITOLO} flex items-center gap-2`}>
          <KeyRound size={18} aria-hidden="true" />
          {t('integrazioniTitolo')}
        </h2>
        <p className="text-kidville-sub">{t('integrazioniSpiegazione')}</p>
      </header>

      {esito === null && <p role="status" className="text-kidville-sub">{t('integrazioniCaricamento')}</p>}
      {esito && !esito.ok && (
        <div className="space-y-2">
          <p role="alert" className="text-kidville-error-strong">{esito.errore.testo}</p>
          {esito.errore.stato !== 503 && (
            <button type="button" onClick={riprova} className={SECONDARIO}>{t('integrazioniRiprova')}</button>
          )}
        </div>
      )}
      {spento && (
        <p role="status" className="rounded-xl bg-kidville-warn-soft p-3 text-kidville-ink">
          {t('integrazioniSpento')}
        </p>
      )}
      {nessunaAttiva && <p className="text-kidville-sub">{t('integrazioniNessuna')}</p>}
      {elenco && elenco.data.length > 0 && (
        <ul className="divide-y divide-kidville-line rounded-xl border border-kidville-line">
          {elenco.data.map((riga) => (
            <li key={riga.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <p className="break-words font-bold text-kidville-ink">{riga.nome}</p>
                <p className={riga.revocataIl ? 'text-kidville-sub' : 'font-semibold text-kidville-green'}>
                  {riga.revocataIl
                    ? t('integrazioniRevocata', { data: fmt.dataBreve(riga.revocataIl) })
                    : t('integrazioniAttiva', { coda: riga.coda })}
                </p>
                <p className="text-kidville-sub">
                  {riga.ultimoUsoIl
                    ? t('integrazioniUltimoUso', { data: fmt.dataOra(riga.ultimoUsoIl) })
                    : t('integrazioniMaiUsata')}
                </p>
              </div>
              {riga.revocataIl === null && (
                <button type="button" disabled={inCorso} className={REVOCA} onClick={() => {
                  setErroreAzione('')
                  setDaRevocare(riga.id)
                }}>
                  {t('integrazioniRevoca')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {elenco && !spento && nessunaAttiva && (
        <form onSubmit={(e) => void crea(e)} className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs space-y-1">
            <label htmlFor={`${id}-nome`} className="block font-semibold text-kidville-ink">{t('integrazioniNome')}</label>
            <input
              id={`${id}-nome`}
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              required
              maxLength={80}
              autoComplete="off"
              className="min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 text-base text-kidville-ink"
            />
          </div>
          <button type="submit" disabled={inCorso || nome.trim() === ''} className={PRIMARIO}>
            {inCorso ? t('integrazioniAttendi') : t('integrazioniCrea')}
          </button>
        </form>
      )}
      {daRevocare === null && avvisoAzione}
      {daRevocare !== null && (
        <Modal open onClose={() => { if (!inCorso) setDaRevocare(null) }} title={t('integrazioniRevoca')} className="w-full max-w-md">
          <div className={`${CARD} space-y-4 shadow-2xl`}>
            <h2 className={TITOLO}>{t('integrazioniRevoca')}</h2>
            <p className="text-kidville-ink">{t('integrazioniRevocaConferma')}</p>
            {avvisoAzione}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARIO} disabled={inCorso} onClick={() => setDaRevocare(null)}>
                {t('integrazioniAnnulla')}
              </button>
              <button type="button" className={REVOCA} disabled={inCorso} onClick={() => void revoca()}>
                {inCorso ? t('integrazioniAttendi') : t('integrazioniRevoca')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {token !== null && <ChiaveCreata token={token} onChiudi={() => setToken(null)} />}
    </section>
  )
}

function ChiaveCreata({ token, onChiudi }: { token: string; onChiudi: () => void }) {
  const t = useTranslations('crmShell')
  const shared = useTranslations('shared')
  const [copia, setCopia] = useState<'copiata' | 'errore' | null>(null)

  const copiaChiave = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopia('copiata')
    } catch {
      segnala('crm-integrazioni-copia-fallita')
      setCopia('errore')
    }
  }

  return (
    <Modal open closeOnBackdrop={false} title={t('integrazioniTitolo')} onClose={onChiudi} className="w-full max-w-md">
      <div className={`${CARD} space-y-4 shadow-2xl`}>
        <h2 className={TITOLO}>{t('integrazioniTitolo')}</h2>
        <p className="font-semibold text-kidville-ink">{t('integrazioniCopiaOra')}</p>
        <code className="block select-all break-all rounded-xl border border-kidville-line bg-kidville-green-soft p-3 text-kidville-ink">
          {token}
        </code>
        {copia === 'copiata' && <p role="status" className="text-kidville-green">{t('integrazioniCopiata')}</p>}
        {copia === 'errore' && <p role="alert" className="text-kidville-error-strong">{t('integrazioniErroreCopia')}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => void copiaChiave()} className={PRIMARIO}>
            <Copy size={16} aria-hidden="true" />
            {t('integrazioniCopia')}
          </button>
          <button type="button" onClick={onChiudi} className={SECONDARIO}>{shared('chiudi')}</button>
        </div>
      </div>
    </Modal>
  )
}
