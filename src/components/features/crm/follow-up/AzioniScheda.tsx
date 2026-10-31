'use client'

import { useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { DateField } from '@/components/ui/DateField'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { addGiorni } from '@/lib/format/data'
import { dataCivile } from '@/i18n/config'
import { istanteCivile } from '@/lib/format/confini-giorno'
import { useAdminIdentity } from '@/lib/context/admin-identity'
import { creaRichiamo, formattaQuando, nomePersona } from './azioni-client'
import { RigaAzione, RiepilogoChiusura, type Chiusura } from './RigaAzione'
import { useAzioni, usePersone } from './usa-richiami'

/**
 * CRM della segreteria · «RICHIAMI» DENTRO LA SCHEDA — i richiami aperti di una famiglia.
 *
 * Tutti, non solo quelli di oggi: il prossimo follow-up sta quasi sempre nel futuro ed è proprio quello
 * che chi apre la scheda vuole vedere (`GET …/azioni?schedaId=…`, senza il tetto di oggi). Per ciascuno:
 * l'esito («fatta»), «Sposta» e «Cancella»; in testa «Aggiungi richiamo».
 *
 * ── DOPO UN'OPERAZIONE ──────────────────────────────────────────────────────────────────────
 * La lista si rilegge SENZA svuotarsi (la nuova azione compare da sola al posto di quella fatta) e un
 * riquadro sopra dice cosa è successo: cosa è stato segnato e qual è la prossima azione nata. Il
 * genitore viene avvisato con `onAggiornata` (la scheda cambia: l'esito dei bambini, lo storico).
 */

type Riquadro = Chiusura | { tipo: 'testo'; testo: string }

export function AzioniScheda({
  scuolaId,
  schedaId,
  onAggiornata,
}: {
  scuolaId: string
  schedaId: string
  onAggiornata: () => void
}) {
  const t = useTranslations('crmFollowUp')
  const ts = useTranslations('shared')
  const locale = useLocale()
  const { userId } = useAdminIdentity()
  const { persone, pronte, nonLette } = usePersone(scuolaId)
  const { lettura, ricarica } = useAzioni({ scuolaId, responsabile: null, schedaId, attiva: true })

  const [riquadro, setRiquadro] = useState<Riquadro | null>(null)
  const [aggiungendo, setAggiungendo] = useState(false)

  // «Aggiungi richiamo»
  const [giorno, setGiorno] = useState(() => addGiorni(dataCivile(), 1))
  const [scelta, setScelta] = useState('')
  const [errore, setErrore] = useState<string | null>(null)
  const [inviando, setInviando] = useState(false)
  const inCorso = useRef(false)

  // Chi richiama: chi sta usando la schermata, se è fra le persone; altrimenti si sceglie.
  const predefinito = userId && persone.some((p) => p.id === userId) ? userId : ''
  const responsabile = scelta && persone.some((p) => p.id === scelta) ? scelta : predefinito

  const dopo = (r: Riquadro) => {
    setRiquadro(r)
    ricarica(true)
    onAggiornata()
  }

  function aggiungi() {
    if (inCorso.current) return
    if (!giorno) {
      setErrore(t('giornoNonValido'))
      return
    }
    if (!responsabile) {
      setErrore(t('responsabileObbligatorio'))
      return
    }
    inCorso.current = true
    setInviando(true)
    setErrore(null)
    void creaRichiamo({ schedaId, giorno, responsabile })
      .then((r) => {
        if (r.tipo === 'ok') {
          const quando = formattaQuando(istanteCivile(giorno, '10:30') ?? '', locale)
          setAggiungendo(false)
          dopo({ tipo: 'testo', testo: t('richiamoAggiunto', { quando }) })
        } else {
          setErrore(r.testo ?? t('erroreInvio'))
        }
      })
      .finally(() => {
        inCorso.current = false
        setInviando(false)
      })
  }

  const testi = testiStatoElenco(ts)

  return (
    <section aria-labelledby={`richiami-${schedaId}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`richiami-${schedaId}`} className="font-barlow text-base font-extrabold uppercase text-kidville-green">
          {t('titoloRichiami')}
        </h3>
        {!aggiungendo && (
          <Btn variant="secondary" size="sm" disabled={!pronte} onClick={() => setAggiungendo(true)}>
            <Plus size={16} aria-hidden="true" />
            {t('aggiungiRichiamo')}
          </Btn>
        )}
      </div>

      {nonLette && (
        <p role="status" className="font-maven text-sm text-kidville-sub">
          {t('personeNonLette')}
        </p>
      )}

      {aggiungendo && (
        <div role="group" aria-label={t('aggiungiRichiamo')} className="flex flex-col gap-3 rounded-card bg-kidville-cream p-3 font-maven">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-kidville-sub">{t('nuovoGiorno')}</span>
              <DateField
                value={giorno}
                onChange={setGiorno}
                disabled={inviando}
                className="min-h-[44px] w-full rounded-input border border-kidville-line bg-kidville-white px-3 py-2 text-sm text-kidville-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-kidville-sub">{t('nuovoResponsabile')}</span>
              <select
                className="min-h-[44px] w-full rounded-input border border-kidville-line bg-kidville-white px-3 py-2 text-sm text-kidville-ink"
                value={responsabile}
                disabled={inviando}
                onChange={(e) => setScelta(e.target.value)}
              >
                <option value="">{t('nuovoResponsabile')}</option>
                {persone.map((p) => (
                  <option key={p.id} value={p.id}>
                    {nomePersona(p)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {errore && (
            <p role="alert" className="text-sm font-semibold text-kidville-error-strong">
              {errore}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Btn size="sm" disabled={inviando} onClick={aggiungi}>
              {t('nuovoConferma')}
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              disabled={inviando}
              onClick={() => {
                setErrore(null)
                setAggiungendo(false)
              }}
            >
              {t('motivoAnnulla')}
            </Btn>
          </div>
        </div>
      )}

      {riquadro &&
        (riquadro.tipo === 'testo' ? (
          <p role="status" className="rounded-card bg-kidville-green-soft p-3 font-maven text-sm text-kidville-ink">
            {riquadro.testo}
          </p>
        ) : (
          <RiepilogoChiusura chiusura={riquadro} />
        ))}

      {!lettura && <StatoElenco stato="caricamento" testi={testi} />}
      {lettura?.tipo === 'errore' && (
        <StatoElenco
          stato="errore"
          testi={{ ...testi, erroreCorpo: lettura.testo ?? testi.erroreCorpo }}
          onRiprova={() => ricarica()}
        />
      )}
      {lettura?.tipo === 'pronta' && lettura.dati.length === 0 && (
        <p className="font-maven text-sm text-kidville-sub">{t('nessunRichiamoScheda')}</p>
      )}
      {lettura?.tipo === 'pronta' && lettura.dati.length > 0 && (
        <ul className="flex flex-col gap-3">
          {[...lettura.dati]
            .sort((a, b) => Date.parse(a.scadenza) - Date.parse(b.scadenza))
            .map((azione) => (
              <RigaAzione
                key={azione.id}
                azione={azione}
                modo="scheda"
                persone={persone}
                onFatta={(_id, risultato) => dopo({ tipo: 'fatta', risultato })}
                onGiaFatta={(_id, testo) => dopo({ tipo: 'gia_fatta', testo })}
                onSpostata={(_id, scadenza) =>
                  dopo({ tipo: 'testo', testo: t('richiamoSpostato', { quando: formattaQuando(scadenza, locale) }) })
                }
                onCancellata={() => dopo({ tipo: 'testo', testo: t('richiamoCancellato') })}
              />
            ))}
        </ul>
      )}
    </section>
  )
}
