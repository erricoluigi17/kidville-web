'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Inbox } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Modal } from '@/components/ui/Modal'
import type { SchedaRow } from '@/lib/crm/tipi'
import { leggiBambiniLiberi, type BambinoLibero, type EsitoChiamata } from './collegamento-client'
import { SceltaDomanda } from './SceltaDomanda'

/**
 * CRM della segreteria · «è arrivata una domanda»: l'avviso sulla scheda quando il sistema ha trovato la
 * famiglia ma non ha saputo da solo a quale bambino legare la domanda (`scheda.domanda_da_associare`).
 *
 * Senza `domanda_da_associare` non rende niente. Con, dice «È arrivata una domanda: associa il bambino»
 * e un pulsante apre la STESSA ricerca di `AssociaDomanda` (`SceltaDomanda`), già puntata su quella
 * domanda: la segreteria sceglie solo il figlio.
 *
 * ── 🔶 L'ACCOPPIAMENTO CON LA SESSIONE 2 ────────────────────────────────────────
 * La firma è fissata dal contratto (`{ scheda, onAggiornata }`): non riceve i bambini. Per sapere a quale
 * bambino legare la domanda li legge da `GET /api/admin/crm/schede/[id]` (`{ scheda, bambini, … }`, il
 * contratto della Sessione 2) alla pressione del pulsante, non prima: a vedere l'avviso non si paga una
 * lettura. Se quella route cambiasse forma, la lettura risponde «forma inattesa», lo dice a schermo e
 * lo scrive nel log — niente si collega a caso.
 *
 * Offre solo i bambini SENZA domanda. Se è uno solo si va dritti alla ricerca; se sono più d'uno si
 * chiede prima «per quale bambino?»; se non ce n'è nessuno lo si dice, e la strada è aggiungerne uno
 * alla scheda.
 *
 * `onAggiornata()` scatta a collegamento riuscito: la route azzera `domanda_da_associare`, quindi alla
 * ricarica della scheda l'avviso sparisce da solo.
 */
export function AvvisoDomandaDaAssociare({ scheda, onAggiornata }: { scheda: SchedaRow; onAggiornata: () => void }) {
  const t = useTranslations('crmCollegamento')
  const idTitolo = useId()
  const [aperta, setAperta] = useState(false)

  if (!scheda.domanda_da_associare) return null

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-kidville-warn/40 bg-kidville-warn-soft px-4 py-3">
        <div className="flex items-center gap-2">
          <Inbox size={18} aria-hidden className="shrink-0 text-kidville-warn-strong" />
          <p className="font-maven text-sm font-bold text-kidville-ink">{t('avvisoTesto')}</p>
        </div>
        <Btn variant="primary" size="sm" onClick={() => setAperta(true)}>
          {t('avvisoAzione')}
        </Btn>
      </div>
      {aperta && (
        <Modal open onClose={() => setAperta(false)} title={t('avvisoTitolo')} labelledBy={idTitolo} className="w-full max-w-lg">
          <div className="max-h-[85vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
            <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
              {t('avvisoTitolo')}
            </h2>
            <div className="mt-4">
              <ScegliBambinoEDomanda
                scuolaId={scheda.scuola_id}
                schedaId={scheda.id}
                domandaId={scheda.domanda_da_associare}
                onCollegato={() => {
                  setAperta(false)
                  onAggiornata()
                }}
              />
            </div>
            <div className="mt-5 flex justify-end">
              <Btn variant="ghost" onClick={() => setAperta(false)}>
                {t('ricercaChiudi')}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

/** I due passi dentro la finestra: i bambini senza domanda, poi la ricerca puntata sulla domanda. */
function ScegliBambinoEDomanda({
  scuolaId,
  schedaId,
  domandaId,
  onCollegato,
}: {
  scuolaId: string
  schedaId: string
  domandaId: string
  onCollegato: () => void
}) {
  const t = useTranslations('crmCollegamento')
  const [letti, setLetti] = useState<EsitoChiamata<BambinoLibero[]> | null>(null)
  const [sceltoId, setSceltoId] = useState<string | null>(null)

  useEffect(() => {
    let annullata = false
    void leggiBambiniLiberi(schedaId).then((esito) => {
      if (!annullata) setLetti(esito)
    })
    return () => {
      annullata = true
    }
  }, [schedaId])

  if (letti === null) {
    return (
      <p role="status" className="font-maven text-sm text-kidville-sub">
        {t('avvisoCaricamentoBambini')}
      </p>
    )
  }
  if (!letti.ok) {
    return (
      <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
        {letti.testo || t('avvisoBambiniErrore')}
      </p>
    )
  }
  const liberi = letti.dati
  if (liberi.length === 0) {
    return <p className="font-maven text-sm text-kidville-ink">{t('avvisoNessunBambino')}</p>
  }

  const bambino = liberi.find((b) => b.id === sceltoId) ?? (liberi.length === 1 ? liberi[0] : null)
  if (bambino !== null) {
    return (
      <SceltaDomanda
        scuolaId={scuolaId}
        schedaId={schedaId}
        bambino={bambino}
        domandaId={domandaId}
        onCollegato={onCollegato}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-maven text-sm font-bold text-kidville-ink">{t('avvisoPerChi')}</p>
      <ul className="flex flex-col gap-2">
        {liberi.map((b) => (
          <li key={b.id}>
            <Btn variant="ghost" className="w-full justify-start" onClick={() => setSceltoId(b.id)}>
              {b.nome ?? t('ricercaFiglioSenzaNome')}
            </Btn>
          </li>
        ))}
      </ul>
    </div>
  )
}
