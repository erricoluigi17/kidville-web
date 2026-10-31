'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { useDateFormat } from '@/lib/i18n/date'
import {
  collegaDomanda,
  leggiDomande,
  type EsitoChiamata,
  type RigaDomanda,
} from './collegamento-client'

/**
 * CRM della segreteria · la ricerca fra le domande di iscrizione e la scelta del figlio da collegare.
 * Il CONTENUTO di una finestra, non la finestra: a darle la cornice (`Modal`) sono `AssociaDomanda` e
 * `AvvisoDomandaDaAssociare`, che hanno titoli e chiusure diversi. Si monta quando la finestra si apre
 * e si smonta quando si chiude: lo stato di una ricerca non sopravvive a un'altra.
 *
 * ── LE DUE FORME ─────────────────────────────────────────────────────────────
 *  · libera (`domandaId` assente): un campo di testo e le ultime domande della sede;
 *  · puntata (`domandaId` presente): è come l'avviso «è arrivata una domanda» apre la ricerca. La
 *    domanda è già decisa, quindi niente campo di testo: si sceglie solo il figlio.
 *
 * ── 🔴 DATI DI MINORI ────────────────────────────────────────────────────────
 * Le righe portano il minimo per scegliere (nome, nascita, genitore, data di ricevimento): lo decide la
 * route, non questo file. Qui niente va nei log e niente resta fuori dallo schermo.
 *
 * ── LE DUE TRAPPOLE DELLA RICERCA ────────────────────────────────────────────
 *  · Una risposta lenta di una ricerca VECCHIA non deve coprire quella nuova: ogni effetto ha la sua
 *    bandierina `annullata`, alzata alla pulizia.
 *  · «Sto caricando» non è uno stato da impostare nell'effetto (`set-state-in-effect`): si DERIVA —
 *    il risultato porta con sé la ricerca a cui risponde, e se non è quella corrente si sta caricando.
 *    `scuolaId` e `domandaId` non cambiano per tutta la vita del componente (la finestra si rimonta),
 *    per questo bastano `ricerca` a fare da chiave.
 *
 * Il doppio clic su «Collega» non spedisce due PUT: un `ref` chiude la porta nello stesso istante del
 * clic, prima che lo `state` faccia in tempo a disabilitare il pulsante.
 */
export function SceltaDomanda({
  scuolaId,
  schedaId,
  bambino,
  domandaId,
  onCollegato,
}: {
  scuolaId: string
  schedaId: string
  bambino: { id: string; nome: string | null }
  domandaId?: string
  onCollegato: () => void
}) {
  const t = useTranslations('crmCollegamento')
  const { dataBreve } = useDateFormat()
  const idCerca = useId()

  const [testo, setTesto] = useState('')
  const [ricerca, setRicerca] = useState('')
  const [risultato, setRisultato] = useState<{ ricerca: string; esito: EsitoChiamata<RigaDomanda[]> } | null>(null)
  const [inCorso, setInCorso] = useState<string | null>(null)
  const [errore, setErrore] = useState('')
  const inVolo = useRef(false)

  useEffect(() => {
    let annullata = false
    void leggiDomande(scuolaId, ricerca, domandaId).then((esito) => {
      if (!annullata) setRisultato({ ricerca, esito })
    })
    return () => {
      annullata = true
    }
  }, [scuolaId, ricerca, domandaId])

  const inCaricamento = risultato === null || risultato.ricerca !== ricerca

  const collega = async (r: RigaDomanda) => {
    if (inVolo.current) return
    inVolo.current = true
    setInCorso(`${r.domandaId}:${r.figlio}`)
    setErrore('')
    const esito = await collegaDomanda(schedaId, bambino.id, r.domandaId, r.figlio)
    inVolo.current = false
    setInCorso(null)
    if (esito.ok) onCollegato()
    else setErrore(esito.testo || t('ricercaCollegaErrore'))
  }

  const nomeBambino = bambino.nome ?? t('associaSenzaNome')

  return (
    <div className="flex flex-col gap-4">
      <p className="font-maven text-sm text-kidville-sub">{t('ricercaPerBambino', { nome: nomeBambino })}</p>

      {!domandaId && (
        <form
          role="search"
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setRicerca(testo.trim())
          }}
        >
          <label htmlFor={idCerca} className="sr-only">
            {t('ricercaEtichetta')}
          </label>
          <input
            id={idCerca}
            type="search"
            value={testo}
            onChange={(e) => setTesto(e.target.value)}
            className="h-[44px] min-w-0 flex-1 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
          />
          <Btn type="submit" variant="ghost">
            {t('ricercaCerca')}
          </Btn>
        </form>
      )}

      {errore !== '' && (
        <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
          {errore}
        </p>
      )}

      {inCaricamento ? (
        <p role="status" className="font-maven text-sm text-kidville-sub">
          {t('ricercaCaricamento')}
        </p>
      ) : !risultato.esito.ok ? (
        <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
          {risultato.esito.testo || t('ricercaErrore')}
        </p>
      ) : risultato.esito.dati.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">{domandaId ? t('ricercaVuotoAvviso') : t('ricercaVuoto')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {risultato.esito.dati.map((r) => {
            const chiave = `${r.domandaId}:${r.figlio}`
            const nome = [r.nome, r.cognome].filter(Boolean).join(' ') || t('ricercaFiglioSenzaNome')
            const nascita = dataBreve(r.dataNascita)
            const ricevuta = dataBreve(r.ricevutaIl)
            const dettagli = [
              nascita !== '' ? t('ricercaNascita', { data: nascita }) : '',
              r.genitore ? t('ricercaGenitore', { nome: r.genitore }) : '',
              ricevuta !== '' ? t('ricercaRicevuta', { data: ricevuta }) : '',
            ].filter((p) => p !== '')
            return (
              <li
                key={chiave}
                className="flex items-start justify-between gap-3 rounded-card border border-kidville-line bg-kidville-white p-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-maven text-sm font-bold text-kidville-ink [overflow-wrap:anywhere]">{nome}</p>
                  {dettagli.length > 0 && (
                    <p className="font-maven text-xs text-kidville-sub [overflow-wrap:anywhere]">{dettagli.join(' · ')}</p>
                  )}
                  {r.stato === 'rejected' && (
                    <span>
                      <Badge tone="warn">{t('ricercaRespinta')}</Badge>
                    </span>
                  )}
                  {r.giaCollegato && <p className="font-maven text-xs text-kidville-sub">{t('ricercaGiaCollegata')}</p>}
                </div>
                <Btn
                  size="sm"
                  disabled={r.giaCollegato || inCorso !== null}
                  aria-label={t('ricercaScegliPer', { nome })}
                  onClick={() => void collega(r)}
                >
                  {inCorso === chiave ? t('ricercaCollegamento') : t('ricercaScegli')}
                </Btn>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
