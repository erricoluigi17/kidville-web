'use client'

import { useId, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Card } from '@/components/ui/Card'
import { cx } from '@/lib/ui/cx'
import { formatData } from '@/lib/i18n/date'
import { testoCorrisponde } from '@/lib/ui/testo-ricerca'
import type { SchedaGenitore } from '@/lib/votazioni/tipi'
import { inviaVoto } from './chiamate'

/** Oltre questo numero di candidati compare il campo «Cerca un genitore». */
export const SOGLIA_RICERCA = 8

export interface SchedaVotoProps {
  scheda: SchedaGenitore
  /** L'identità di sessione: va nell'header della POST. L'elettore, per il server, è comunque la sessione. */
  parentId: string
  /**
   * La POST ha risposto 409 `VOTAZIONE_CHIUSA`. Il messaggio (già tradotto dal codice) lo mostra il
   * CONTENITORE, non la scheda: la scheda sparisce alla ricarica e si porterebbe via il messaggio.
   */
  onVotazioneChiusa: (messaggio: string) => void
}

/**
 * UNA SCHEDA DI VOTO: i candidati a scelta singola, la scadenza in ora di Roma, «Vota» / «Cambia voto».
 *
 * ── COSA NON C'È, ED È VOLUTO ───────────────────────────────────────────────────
 * Nessuna scritta sul fatto che la segreteria vede il voto (lo comunica la scuola nell'avviso: decisione
 * del titolare, 02/11/2026) e nessun risultato, nessun conteggio: il genitore vede i nomi dei genitori
 * della classe e la propria scelta, e basta.
 *
 * ── LO STATO ────────────────────────────────────────────────────────────────────
 *  · `selezione`: ciò che è spuntato adesso;
 *  · `votata`: ciò che il server ha confermato in questa visita (vince su `scheda.sceltaAttuale`, che è
 *    la fotografia di quando la pagina è stata letta);
 *  · il pulsante si accende solo se `selezione` è diversa da `sceltaAttuale`: «Cambia voto» sulla stessa
 *    scelta non avrebbe niente da cambiare.
 */
export function SchedaVoto({ scheda, parentId, onVotazioneChiusa }: SchedaVotoProps) {
  const t = useTranslations('votazioniGenitore')
  const locale = useLocale()
  const idTitolo = useId()
  const idRicerca = useId()
  const nomeGruppo = useId()

  const [votata, setVotata] = useState<string | null>(null)
  const [selezione, setSelezione] = useState<string | null>(scheda.sceltaAttuale)
  const [ricerca, setRicerca] = useState('')
  const [inInvio, setInInvio] = useState(false)
  const [registrato, setRegistrato] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)
  const [chiusa, setChiusa] = useState(false)
  // La guardia sta in un ref e non nello stato: due tocchi nello stesso istante leggerebbero lo stesso
  // `inInvio` e manderebbero due POST.
  const inVolo = useRef(false)

  const sceltaAttuale = votata ?? scheda.sceltaAttuale
  const nomeVotato = scheda.candidati.find((c) => c.utenteId === sceltaAttuale)?.nome ?? null

  const titolo =
    scheda.ambito === 'istituto'
      ? t('schedaTitoloIstituto', { nomeSede: scheda.sedeNome })
      : scheda.classeNome
        ? t('schedaTitoloClasse', { classe: scheda.classeNome })
        : t('schedaTitoloClasseSenzaNome')

  const data = formatData(scheda.scadenza, locale, 'lunga')
  const ora = formatData(scheda.scadenza, locale, 'ora')

  const conRicerca = scheda.candidati.length > SOGLIA_RICERCA
  const visibili = conRicerca
    ? scheda.candidati.filter((c) => testoCorrisponde([c.nome], ricerca))
    : scheda.candidati

  const scegli = (utenteId: string) => {
    setSelezione(utenteId)
    // Il messaggio di prima parlava della scelta di prima.
    setRegistrato(false)
    setErrore(null)
  }

  const invia = async () => {
    if (inVolo.current || chiusa || selezione === null || selezione === sceltaAttuale) return
    inVolo.current = true
    setInInvio(true)
    setErrore(null)
    setRegistrato(false)
    const esito = await inviaVoto(parentId, scheda, selezione, t('erroreVoto'))
    inVolo.current = false
    setInInvio(false)
    if (esito.tipo === 'registrato') {
      setVotata(esito.sceltaAttuale)
      setSelezione(esito.sceltaAttuale)
      setRegistrato(true)
    } else if (esito.tipo === 'chiusa') {
      setChiusa(true)
      onVotazioneChiusa(esito.messaggio)
    } else {
      setErrore(esito.messaggio)
    }
  }

  // Mentre la richiesta è in volo il pulsante è un MESSAGGIO («Invio in corso…»), non un controllo
  // spento: `aria-disabled` e non `disabled`, che farebbe perdere il fuoco (vedi `Btn`).
  const spento = !inInvio && (chiusa || selezione === null || selezione === sceltaAttuale)
  const etichetta = inInvio ? t('invioInCorso') : sceltaAttuale ? t('cambiaVoto') : t('votaAzione')

  return (
    <section aria-labelledby={idTitolo}>
      <Card className="p-4">
        <h2
          id={idTitolo}
          className="font-barlow text-[17px] font-extrabold uppercase leading-tight tracking-[0.02em] text-kidville-green"
        >
          {titolo}
        </h2>
        {data !== '' && ora !== '' && (
          <p className="mt-1 font-maven text-[12.5px] text-kidville-sub">{t('schedaScadenza', { data, ora })}</p>
        )}

        {sceltaAttuale && (
          <p className="mt-3 flex items-center gap-2 font-maven text-[13.5px] font-semibold text-kidville-green">
            <Check size={16} strokeWidth={2.2} aria-hidden="true" className="flex-shrink-0" />
            <span>{nomeVotato ? t('haiVotato', { nome: nomeVotato }) : t('haiVotatoAltro')}</span>
          </p>
        )}

        {conRicerca && (
          <div className="mt-3">
            <label htmlFor={idRicerca} className="sr-only">
              {t('cercaGenitore')}
            </label>
            <input
              id={idRicerca}
              type="search"
              value={ricerca}
              onChange={(e) => setRicerca(e.target.value)}
              placeholder={t('cercaGenitore')}
              autoComplete="off"
              className="h-11 w-full rounded-xl border border-kidville-neutral bg-white px-3 font-maven text-[14px] text-kidville-ink placeholder:text-kidville-sub"
            />
          </div>
        )}

        <div role="radiogroup" aria-labelledby={idTitolo} className="mt-3 flex flex-col gap-2">
          {visibili.map((c) => {
            const scelto = selezione === c.utenteId
            return (
              <label
                key={c.utenteId}
                className={cx(
                  'flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 font-maven text-[14px] text-kidville-ink',
                  scelto ? 'border-kidville-green bg-kidville-green-soft' : 'border-kidville-line bg-white',
                )}
              >
                <input
                  type="radio"
                  name={nomeGruppo}
                  value={c.utenteId}
                  checked={scelto}
                  onChange={() => scegli(c.utenteId)}
                  className="h-5 w-5 flex-shrink-0 accent-kidville-green"
                />
                <span className="min-w-0 break-words">{c.nome}</span>
              </label>
            )
          })}
        </div>
        {conRicerca && visibili.length === 0 && (
          <p className="mt-2 font-maven text-[13px] text-kidville-sub">{t('nessunRisultato')}</p>
        )}

        {errore && (
          <p
            role="alert"
            className="mt-3 rounded-xl border border-kidville-error bg-kidville-error-soft px-3 py-2 font-maven text-[13px] text-kidville-error-strong"
          >
            {errore}
          </p>
        )}
        {/* La regione è sempre nel DOM: un annuncio si legge se il contenitore c'era prima del testo. */}
        <div role="status">
          {registrato && (
            <p className="mt-3 font-maven text-[13.5px] font-semibold text-kidville-green">{t('votoRegistrato')}</p>
          )}
        </div>

        <Btn
          className="mt-4 w-full"
          disabled={spento}
          aria-disabled={inInvio || undefined}
          aria-busy={inInvio || undefined}
          onClick={() => void invia()}
        >
          {etichetta}
        </Btn>
      </Card>
    </section>
  )
}
