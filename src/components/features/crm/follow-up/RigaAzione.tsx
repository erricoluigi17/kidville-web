'use client'

import { useId, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Phone } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { DateField } from '@/components/ui/DateField'
import { dataCivile } from '@/i18n/config'
import { oraCivile } from '@/lib/format/confini-giorno'
import { ESITI_AZIONE, MOTIVI_PERDITA, type EsitoAzione, type MotivoPerdita } from '@/lib/crm/tipi'
import {
  cancellaAzione,
  formattaQuando,
  nomePersona,
  segnaFatta,
  spostaAzione,
  type AvvisoEsito,
  type AzioneElenco,
  type PersonaRichiamo,
  type RisultatoEsito,
} from './azioni-client'

/**
 * CRM della segreteria · UNA RIGA DI RICHIAMO, condivisa dall'elenco «Da richiamare» e dalla scheda.
 *
 * Due modi, un solo comportamento:
 *  · `elenco` — per chi ha davanti la lista della giornata: il telefono da toccare, l'apertura
 *    della scheda, i quattro esiti. Dopo l'esito la riga NON sparisce: dice cosa è stato segnato e
 *    qual è la prossima azione nata (la riga che salta via dal basso farebbe cliccare quella dopo);
 *  · `scheda` — per chi sta dentro una scheda: gli stessi esiti più «Sposta» e «Cancella». La riga
 *    avvisa il genitore (`onFatta`, `onSpostata`, `onCancellata`) e sarà lui a rileggere la lista.
 *
 * ── COSA PROTEGGE IL DOPPIO CLIC ─────────────────────────────────────────────────────────────
 * `inCorso` è un `useRef` e non uno stato: due clic nello stesso istante leggono lo stesso render e
 * lo stato non fa in tempo ad aggiornarsi. Il server tiene comunque la linea (un secondo `fatta`
 * risponde 409 `GIA_FATTA` e non pianifica niente): qui si evita solo di arrivarci per sbaglio.
 *
 * ⚠️ `non_interessato` NON parte al clic. Chiude la trattativa e porta i bambini a «perso»: serve il
 * motivo, e si sceglie PRIMA di inviare (la route risponderebbe 422 `MOTIVO_OBBLIGATORIO`).
 */

/** Come finisce una riga dell'elenco dopo che è stata trattata. */
export type Chiusura = { tipo: 'fatta'; risultato: RisultatoEsito } | { tipo: 'gia_fatta'; testo: string }

type Fase = 'riposo' | 'motivo' | 'sposta' | 'cancella'

const AVVISO_CHIAVE: Record<AvvisoEsito, string> = {
  PROSSIMA_NON_PIANIFICATA: 'avvisoProssimaNonPianificata',
  BAMBINI_NON_AGGIORNATI: 'avvisoBambiniNonAggiornati',
}

const CAMPO =
  'min-h-[44px] w-full rounded-input border border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink'
const ETICHETTA = 'font-maven text-xs font-semibold text-kidville-sub'

/** Solo cifre e «+»: `tel:` non vuole gli spazi con cui la segreteria scrive i numeri. */
const numeroPerChiamare = (telefono: string) => telefono.replace(/[^\d+]/g, '')

/** L'ora «HH:MM» di Roma di un istante, o '' se l'istante è illeggibile. */
function oraDi(iso: string): string {
  const ora = oraCivile(iso)
  return /^\d{2}:\d{2}$/.test(ora) ? ora : ''
}

export function RigaAzione({
  azione,
  modo,
  persone,
  chiusura,
  onFatta,
  onGiaFatta,
  onSpostata,
  onCancellata,
  onApriScheda,
}: {
  azione: AzioneElenco
  modo: 'elenco' | 'scheda'
  persone: PersonaRichiamo[]
  /** Solo nell'elenco: la riga è già stata trattata e mostra com'è andata. */
  chiusura?: Chiusura
  onFatta: (azioneId: string, risultato: RisultatoEsito) => void
  /** Un collega (o un secondo clic) l'aveva già segnata: il testo è quello del catalogo del server. */
  onGiaFatta: (azioneId: string, testo: string) => void
  onSpostata?: (azioneId: string, scadenza: string) => void
  onCancellata?: (azioneId: string) => void
  onApriScheda?: (schedaId: string) => void
}) {
  const t = useTranslations('crmFollowUp')
  const locale = useLocale()
  const idRiga = useId()

  const [fase, setFase] = useState<Fase>('riposo')
  const [inviando, setInviando] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)
  const inCorso = useRef(false)

  // «non interessata»
  const [motivo, setMotivo] = useState<MotivoPerdita | ''>('')
  const [nota, setNota] = useState('')
  // «sposta»
  const [giorno, setGiorno] = useState(() => dataCivile(new Date(azione.scadenza)))
  const [ora, setOra] = useState(() => oraDi(azione.scadenza))
  const [responsabile, setResponsabile] = useState(azione.responsabile)

  const nome = azione.scheda.genitore_nome?.trim() || t('senzaNome')
  const telefono = azione.scheda.telefono1?.trim() || null
  const chi = persone.find((p) => p.id === azione.responsabile)

  /**
   * Una sola operazione alla volta per riga: il resto del clic viene scartato. Le funzioni di
   * `azioni-client` non rifiutano mai la promessa (l'esito è un valore); se `dopo` dovesse lanciare,
   * la riga si sblocca comunque (`finally`) e l'errore arriva al logger globale: niente `try`/`finally`
   * nel corpo, che spegnerebbe l'ottimizzazione del compilatore di React per tutto il componente.
   */
  function esegui<T>(operazione: () => Promise<T>, dopo: (esito: T) => void) {
    if (inCorso.current) return
    inCorso.current = true
    setInviando(true)
    setErrore(null)
    void operazione()
      .then(dopo)
      .finally(() => {
        inCorso.current = false
        setInviando(false)
      })
  }

  function inviaEsito(esito: EsitoAzione, motivoPerdita?: MotivoPerdita) {
    const motivoNota = nota.trim()
    void esegui(
      () =>
        segnaFatta(azione.id, {
          esito,
          ...(motivoPerdita ? { motivoPerdita } : {}),
          ...(motivoPerdita && motivoNota ? { motivoNota } : {}),
        }),
      (r) => {
        if (r.tipo === 'ok') {
          setFase('riposo')
          onFatta(azione.id, r.dati)
        } else if (r.codice === 'GIA_FATTA') {
          setFase('riposo')
          onGiaFatta(azione.id, r.testo ?? t('erroreInvio'))
        } else {
          setErrore(r.testo ?? t('erroreInvio'))
        }
      },
    )
  }

  function sceltoEsito(esito: EsitoAzione) {
    if (esito === 'non_interessato') {
      setErrore(null)
      setFase('motivo')
      return
    }
    inviaEsito(esito)
  }

  function confermaMotivo() {
    if (!motivo) {
      setErrore(t('motivoObbligatorio'))
      return
    }
    inviaEsito('non_interessato', motivo)
  }

  function confermaSposta() {
    if (!giorno) {
      setErrore(t('giornoNonValido'))
      return
    }
    void esegui(
      () =>
        spostaAzione(azione.id, {
          giorno,
          ...(ora ? { ora } : {}),
          ...(responsabile && responsabile !== azione.responsabile ? { responsabile } : {}),
        }),
      (r) => {
        if (r.tipo === 'ok') {
          setFase('riposo')
          onSpostata?.(azione.id, r.dati.scadenza)
        } else {
          setErrore(r.testo ?? t('erroreInvio'))
        }
      },
    )
  }

  function confermaCancella() {
    void esegui(
      () => cancellaAzione(azione.id),
      (r) => {
        if (r.tipo === 'ok') {
          setFase('riposo')
          onCancellata?.(azione.id)
        } else {
          setErrore(r.testo ?? t('erroreInvio'))
        }
      },
    )
  }

  const annulla = () => {
    setErrore(null)
    setFase('riposo')
  }

  return (
    <li
      data-azione-id={azione.id}
      data-in-ritardo={azione.in_ritardo ? 'true' : 'false'}
      aria-busy={inviando}
      className={`flex flex-col gap-3 rounded-card border bg-kidville-white p-4 font-maven ${
        azione.in_ritardo ? 'border-kidville-line border-l-4 border-l-kidville-error-strong' : 'border-kidville-line'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-kidville-ink">{nome}</p>
          <p className="text-sm text-kidville-sub">
            {t(`tipo_${azione.tipo}`)} · {formattaQuando(azione.scadenza, locale)}
          </p>
          {modo === 'scheda' && chi && <p className="text-sm text-kidville-sub">{t('responsabile', { nome: nomePersona(chi) })}</p>}
        </div>
        {azione.in_ritardo && <Badge tone="error">{t('inRitardo')}</Badge>}
      </div>

      {modo === 'elenco' && (
        <div className="flex flex-wrap items-center gap-2">
          {telefono ? (
            <a
              href={`tel:${numeroPerChiamare(telefono)}`}
              aria-label={t('chiamaTelefono', { telefono })}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-kidville-line px-4 text-sm font-semibold text-kidville-green"
            >
              <Phone size={16} aria-hidden="true" />
              {telefono}
            </a>
          ) : (
            <span className="text-sm text-kidville-sub">{t('senzaTelefono')}</span>
          )}
          {onApriScheda && (
            <Btn variant="secondary" size="sm" onClick={() => onApriScheda(azione.scheda.id)}>
              {t('apriScheda')}
            </Btn>
          )}
        </div>
      )}

      {chiusura ? (
        <RiepilogoChiusura chiusura={chiusura} />
      ) : (
        <>
          {fase === 'riposo' && (
            <div className="flex flex-col gap-2">
              <div role="group" aria-label={t('comeAndata')} className="flex flex-wrap gap-2">
                {ESITI_AZIONE.map((esito) => (
                  <Btn
                    key={esito}
                    variant="secondary"
                    size="sm"
                    disabled={inviando}
                    onClick={() => sceltoEsito(esito)}
                  >
                    {t(`esito_${esito}`)}
                  </Btn>
                ))}
              </div>
              {modo === 'scheda' && (
                <div className="flex flex-wrap gap-2">
                  <Btn variant="ghost" size="sm" disabled={inviando} onClick={() => setFase('sposta')}>
                    {t('sposta')}
                  </Btn>
                  <Btn variant="ghost" size="sm" disabled={inviando} onClick={() => setFase('cancella')}>
                    {t('cancella')}
                  </Btn>
                </div>
              )}
            </div>
          )}

          {fase === 'motivo' && (
            <div role="group" aria-labelledby={`${idRiga}-motivo`} className="flex flex-col gap-3 rounded-card bg-kidville-cream p-3">
              <p id={`${idRiga}-motivo`} className="text-sm font-semibold text-kidville-ink">
                {t('motivoTitolo')}
              </p>
              <label className="flex flex-col gap-1">
                <span className={ETICHETTA}>{t('motivoLabel')}</span>
                <select
                  className={CAMPO}
                  value={motivo}
                  disabled={inviando}
                  onChange={(e) => setMotivo(e.target.value as MotivoPerdita | '')}
                >
                  <option value="">{t('motivoScegli')}</option>
                  {MOTIVI_PERDITA.map((m) => (
                    <option key={m} value={m}>
                      {t(`motivo_${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={ETICHETTA}>{t('motivoNota')}</span>
                <textarea
                  className={`${CAMPO} min-h-[72px]`}
                  value={nota}
                  maxLength={500}
                  disabled={inviando}
                  onChange={(e) => setNota(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Btn size="sm" disabled={inviando} onClick={confermaMotivo}>
                  {t('motivoConferma')}
                </Btn>
                <Btn variant="ghost" size="sm" disabled={inviando} onClick={annulla}>
                  {t('motivoAnnulla')}
                </Btn>
              </div>
            </div>
          )}

          {fase === 'sposta' && (
            <div role="group" aria-label={t('sposta')} className="flex flex-col gap-3 rounded-card bg-kidville-cream p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1" htmlFor={`${idRiga}-giorno`}>
                  <span className={ETICHETTA}>{t('spostaGiorno')}</span>
                  <DateField id={`${idRiga}-giorno`} value={giorno} onChange={setGiorno} disabled={inviando} className={CAMPO} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={ETICHETTA}>{t('spostaOra')}</span>
                  <input
                    type="time"
                    className={CAMPO}
                    value={ora}
                    disabled={inviando}
                    onChange={(e) => setOra(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={ETICHETTA}>{t('spostaResponsabile')}</span>
                  <select
                    className={CAMPO}
                    value={responsabile}
                    disabled={inviando}
                    onChange={(e) => setResponsabile(e.target.value)}
                  >
                    {/* Se la persona non è (più) nell'elenco, il suo posto resta: cambiarla è una scelta, non un effetto. */}
                    {!persone.some((p) => p.id === azione.responsabile) && (
                      <option value={azione.responsabile}>{t('responsabileAttuale')}</option>
                    )}
                    {persone.map((p) => (
                      <option key={p.id} value={p.id}>
                        {nomePersona(p)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Btn size="sm" disabled={inviando} onClick={confermaSposta}>
                  {t('spostaConferma')}
                </Btn>
                <Btn variant="ghost" size="sm" disabled={inviando} onClick={annulla}>
                  {t('motivoAnnulla')}
                </Btn>
              </div>
            </div>
          )}

          {fase === 'cancella' && (
            <div role="group" aria-label={t('cancella')} className="flex flex-col gap-3 rounded-card bg-kidville-cream p-3">
              <p className="text-sm font-semibold text-kidville-ink">{t('cancellaChiedi')}</p>
              <div className="flex flex-wrap gap-2">
                <Btn variant="danger" size="sm" disabled={inviando} onClick={confermaCancella}>
                  {t('cancellaConferma')}
                </Btn>
                <Btn variant="ghost" size="sm" disabled={inviando} onClick={annulla}>
                  {t('cancellaAnnulla')}
                </Btn>
              </div>
            </div>
          )}

          {errore && (
            <p role="alert" className="text-sm font-semibold text-kidville-error-strong">
              {errore}
            </p>
          )}
        </>
      )}
    </li>
  )
}

/**
 * Com'è andata, dopo l'esito: cosa è stato segnato e qual è la prossima azione nata. Sta nella riga
 * dell'elenco e, nella scheda (dove la riga viene riletta e la nuova azione compare da sola), in un
 * riquadro sopra la lista.
 */
export function RiepilogoChiusura({ chiusura }: { chiusura: Chiusura }) {
  const t = useTranslations('crmFollowUp')
  const locale = useLocale()

  if (chiusura.tipo === 'gia_fatta') {
    return (
      <p role="status" className="rounded-card bg-kidville-cream p-3 text-sm text-kidville-ink">
        {chiusura.testo}
      </p>
    )
  }

  const r = chiusura.risultato
  const nonPianificata = r.avvisi.includes('PROSSIMA_NON_PIANIFICATA')
  return (
    <div role="status" className="flex flex-col gap-1 rounded-card bg-kidville-green-soft p-3 text-sm text-kidville-ink">
      <p className="font-semibold">{t('segnato', { esito: t(`esito_${r.esito}`) })}</p>
      {r.prossima && (
        <p>{t('prossimaAzione', { tipo: t(`tipo_${r.prossima.tipo}`), quando: formattaQuando(r.prossima.scadenza, locale) })}</p>
      )}
      {/* «Nessun altro richiamo» sarebbe falso se il prossimo andava creato e non c'è riuscito: lo dice l'avviso. */}
      {!r.prossima && !nonPianificata && <p>{t('nessunaProssima')}</p>}
      {r.bambiniAggiornati > 0 && <p>{t('bambiniAggiornati', { n: r.bambiniAggiornati })}</p>}
      {r.avvisi.map((a) => (
        <p key={a} role="alert" className="font-semibold text-kidville-error-strong">
          {t(AVVISO_CHIAVE[a])}
        </p>
      ))}
    </div>
  )
}
