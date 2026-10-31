'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { useAdminIdentity } from '@/lib/context/admin-identity'
import { nomePersona } from './azioni-client'
import { RigaAzione, type Chiusura } from './RigaAzione'
import { useAzioni, usePersone } from './usa-richiami'

/**
 * CRM della segreteria · «DA RICHIAMARE» — i richiami di oggi e quelli rimasti indietro.
 *
 * La lista arriva già in ordine di scadenza (le scadute in cima) e la sede è quella dichiarata dalla
 * cornice: `GET /api/admin/crm/azioni?scuolaId=…`. Qui si ordina comunque un'altra volta, per scadenza:
 * l'ordine è una promessa del server e un test lo prova, ma una lista che mette un richiamo di
 * ieri sotto uno di oggi fa perdere una famiglia, e riordinare costa una riga.
 *
 * ── LA PERSONA PREDEFINITA È CHI USA LA SCHERMATA ───────────────────────────────────────────
 * Se è fra le persone della sede, si vedono i SUOI richiami; «Tutte le persone» è una scelta. Finché
 * l'elenco delle persone non è arrivato (bene o male) la lista NON parte: partirebbe con «tutte» e
 * un attimo dopo si rifarebbe con la persona giusta, mostrando per un istante i richiami di altri.
 * Se l'elenco delle persone non si carica, si vede tutto e lo si dice, invece di restare bloccati.
 *
 * ── DOPO L'ESITO LA RIGA RESTA ──────────────────────────────────────────────────────────────
 * Dice cosa è stato segnato e quale richiamo è nato («Secondo richiamo · martedì 3 novembre, 10:30»).
 * Una riga che sparisce fa scorrere la lista sotto il dito, e il clic dopo cade su un'altra famiglia.
 * «Aggiorna» la toglie.
 */

const TUTTE = ''

export function DaRichiamare({ scuolaId, onApriScheda }: { scuolaId: string; onApriScheda: (schedaId: string) => void }) {
  const t = useTranslations('crmFollowUp')
  const ts = useTranslations('shared')
  const { userId } = useAdminIdentity()
  const { persone, pronte, nonLette } = usePersone(scuolaId)

  // La scelta di chi guarda vale per la sede in cui l'ha fatta: un'altra sede ha altre persone.
  const [scelta, setScelta] = useState<{ scuolaId: string; persona: string } | null>(null)
  const predefinita = userId && persone.some((p) => p.id === userId) ? userId : TUTTE
  const persona = scelta && scelta.scuolaId === scuolaId ? scelta.persona : predefinita

  const { lettura, ricarica } = useAzioni({ scuolaId, responsabile: persona || null, attiva: pronte })
  const [chiuse, setChiuse] = useState<Record<string, Chiusura>>({})

  const cambiaPersona = (valore: string) => {
    setChiuse({})
    setScelta({ scuolaId, persona: valore })
  }
  const aggiorna = () => {
    setChiuse({})
    ricarica()
  }
  const chiudi = (azioneId: string, chiusura: Chiusura) => setChiuse((prima) => ({ ...prima, [azioneId]: chiusura }))

  const testi = testiStatoElenco(ts)

  return (
    <section className="flex flex-col gap-4">
      <p className="font-maven text-sm text-kidville-sub">{t('intro')}</p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-maven text-xs font-semibold text-kidville-sub">{t('filtroPersona')}</span>
          <select
            className="min-h-[44px] rounded-input border border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink"
            value={persona}
            disabled={!pronte}
            onChange={(e) => cambiaPersona(e.target.value)}
          >
            <option value={TUTTE}>{t('tuttePersone')}</option>
            {persone.map((p) => (
              <option key={p.id} value={p.id}>
                {nomePersona(p)}
              </option>
            ))}
          </select>
        </label>
        <Btn variant="secondary" size="md" onClick={aggiorna} disabled={!lettura}>
          <RefreshCw size={16} aria-hidden="true" />
          {t('aggiorna')}
        </Btn>
      </div>

      {nonLette && (
        <p role="status" className="font-maven text-sm text-kidville-sub">
          {t('personeNonLette')}
        </p>
      )}

      {!lettura && <StatoElenco stato="caricamento" testi={testi} />}
      {lettura?.tipo === 'errore' && (
        <StatoElenco
          stato="errore"
          testi={{ ...testi, erroreCorpo: lettura.testo ?? testi.erroreCorpo }}
          onRiprova={aggiorna}
        />
      )}
      {lettura?.tipo === 'pronta' && lettura.dati.length === 0 && (
        <StatoElenco
          stato="vuoto"
          testi={{ ...testi, vuotoTitolo: t('vuotoTitolo'), vuotoCorpo: t('vuotoCorpo') }}
        />
      )}
      {lettura?.tipo === 'pronta' && lettura.dati.length > 0 && (
        <ul className="flex flex-col gap-3">
          {[...lettura.dati]
            .sort((a, b) => Date.parse(a.scadenza) - Date.parse(b.scadenza))
            .map((azione) => (
              <RigaAzione
                key={azione.id}
                azione={azione}
                modo="elenco"
                persone={persone}
                chiusura={chiuse[azione.id]}
                onFatta={(id, risultato) => chiudi(id, { tipo: 'fatta', risultato })}
                onGiaFatta={(id, testo) => chiudi(id, { tipo: 'gia_fatta', testo })}
                onApriScheda={onApriScheda}
              />
            ))}
        </ul>
      )}
    </section>
  )
}
