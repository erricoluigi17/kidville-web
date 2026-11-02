'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import type { GenitoreScheda } from '@/lib/votazioni/tipi'
import { cercaGenitori, type RicercaGenitori } from './chiamate'

/**
 * VOTAZIONI · LA SCELTA DEI CANDIDATI DELL'ISTITUTO.
 *
 * Si CERCA sul server (`GET /api/admin/votazioni/genitori?scuolaId=&q=`, al massimo 50 risultati): i genitori di
 * una sede sono centinaia e non si caricano tutti per filtrarli nel browser. Per questo non è un `Combobox`, che
 * filtra una lista già in mano e non avvisa quando si scrive; è un campo di ricerca, i risultati come pulsanti e i
 * candidati scelti come chip rimovibili.
 *
 * ── LA RICERCA ──────────────────────────────────────────────────────────────────────
 *  · parte da 2 lettere, dopo una pausa di scrittura (`PAUSA_MS`): una digitazione veloce è UNA richiesta;
 *  · «in corso» si deduce dalla chiave (sede + testo) del risultato, mai da un `setState` sincrono nell'effetto:
 *    un risultato arrivato per un testo che non è più quello scritto è scartato (`vivo`) e non si vede mai;
 *  · chi è già fra i candidati non compare fra i risultati;
 *  · scegliere un risultato svuota il campo e rimette il fuoco lì, per aggiungerne un altro.
 *
 * ── I NOMI ──────────────────────────────────────────────────────────────────────────
 * Sono nomi di genitori (dato personale): stanno a schermo e nel corpo della richiesta come `utenteId`, mai nei
 * log del client, che non ricevono il testo cercato.
 */

const LUNGHEZZA_MIN = 2
const PAUSA_MS = 250

const CAMPO =
  'min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven text-kidville-ink'

type Lettura = { chiave: string; ricerca: RicercaGenitori }

export function SceltaCandidati({
  scuolaId,
  scelti,
  onChange,
}: {
  scuolaId: string
  scelti: GenitoreScheda[]
  onChange: (scelti: GenitoreScheda[]) => void
}) {
  const t = useTranslations('votazioniAdmin')
  const idBase = useId()
  const idCerca = `${idBase}-cerca`
  const idAiuto = `${idBase}-aiuto`
  const idLista = `${idBase}-lista`
  const campoRef = useRef<HTMLInputElement>(null)

  const [domanda, setDomanda] = useState('')
  const [lettura, setLettura] = useState<Lettura | null>(null)

  const q = domanda.trim()
  const attiva = q.length >= LUNGHEZZA_MIN
  const chiave = `${scuolaId}|${q}`

  useEffect(() => {
    if (!attiva) return
    let vivo = true
    const pausa = window.setTimeout(() => {
      void cercaGenitori(scuolaId, q).then((ricerca) => {
        if (vivo) setLettura({ chiave, ricerca })
      })
    }, PAUSA_MS)
    return () => {
      vivo = false
      window.clearTimeout(pausa)
    }
  }, [attiva, scuolaId, q, chiave])

  // Il risultato vale solo per il testo che l'ha chiesto: per un altro, si sta ancora cercando.
  const corrente = attiva && lettura?.chiave === chiave ? lettura.ricerca : null
  const inCorso = attiva && corrente === null
  const giaScelti = new Set(scelti.map((g) => g.utenteId))
  const risultati = corrente?.esito === 'ok' ? corrente.genitori.filter((g) => !giaScelti.has(g.utenteId)) : []

  const aggiungi = (g: GenitoreScheda) => {
    onChange([...scelti, g])
    setDomanda('')
    campoRef.current?.focus()
  }
  const rimuovi = (id: string) => onChange(scelti.filter((g) => g.utenteId !== id))

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={idCerca} className="block font-maven text-xs font-semibold text-kidville-sub">
          {t('cercaGenitore')}
        </label>
        <input
          ref={campoRef}
          id={idCerca}
          type="search"
          value={domanda}
          onChange={(e) => setDomanda(e.target.value)}
          placeholder={t('cercaSegnaposto')}
          aria-describedby={idAiuto}
          autoComplete="off"
          style={{ fontSize: '16px' }}
          className={CAMPO}
        />
        <div id={idAiuto} className="font-maven text-xs text-kidville-sub">
          {!attiva && <p>{t('cercaMinimo')}</p>}
          {inCorso && <p role="status">{t('cercaInCorso')}</p>}
          {corrente?.esito === 'errore' && (
            <p role="alert" className="text-kidville-error-strong">
              {t('cercaErrore')}
            </p>
          )}
          {corrente?.esito === 'ok' && risultati.length === 0 && <p role="status">{t('cercaNessuno')}</p>}
        </div>
        {risultati.length > 0 && (
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {risultati.map((g) => (
              <li key={g.utenteId}>
                <button
                  type="button"
                  onClick={() => aggiungi(g)}
                  className="w-full rounded-xl border border-kidville-line px-3 py-2 text-left font-maven text-sm font-semibold text-kidville-ink transition-colors hover:border-kidville-green"
                >
                  {g.nome}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <p id={idLista} className="font-maven text-xs font-semibold text-kidville-sub">
          {t('candidatiLegenda')}
        </p>
        {scelti.length === 0 ? (
          <p className="font-maven text-sm text-kidville-sub">{t('candidatiNessuno')}</p>
        ) : (
          <ul aria-labelledby={idLista} className="flex flex-wrap gap-2">
            {scelti.map((g) => (
              <li
                key={g.utenteId}
                className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft py-1 pl-3 pr-1 font-maven text-sm font-semibold text-kidville-green"
              >
                <span>{g.nome}</span>
                <button
                  type="button"
                  onClick={() => rimuovi(g.utenteId)}
                  aria-label={t('rimuoviCandidato', { nome: g.nome })}
                  className="flex h-7 w-7 items-center justify-center rounded-pill text-kidville-green transition-colors hover:bg-kidville-white focus-visible:ring-2 focus-visible:ring-kidville-green"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
