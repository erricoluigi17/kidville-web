'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Btn } from '@/components/ui/Btn'
import { Modal } from '@/components/ui/Modal'
import type { BambinoRow } from '@/lib/crm/tipi'
import { scollegaDomanda } from './collegamento-client'
import { SceltaDomanda } from './SceltaDomanda'

/**
 * CRM della segreteria · associare a mano un bambino a una domanda di iscrizione, o toglierla.
 *
 * Un solo pulsante alla volta, scelto da `bambino.domanda_id`:
 *  · senza domanda → «Associa al bambino»: apre la ricerca (`SceltaDomanda`) in una finestra; si sceglie
 *    il figlio, parte `PUT …/collegamento` con `{ domandaId, figlio }` e poi `onCollegato()`;
 *  · con una domanda → «Scollega»: chiede conferma e fa `DELETE …/collegamento`, poi `onCollegato()`.
 *    La conferma c'è perché il gesto cambia il badge e lascia una riga nello storico: un clic distratto
 *    non deve farlo da solo. L'esito del bambino NON cambia mai (lo garantisce la route).
 *
 * `onCollegato` è il nome del contratto (vedi `contratto-segnaposto.test.tsx`) e vale per entrambi i
 * versi: chi lo riceve ricarica la scheda, che è tutto ciò che deve fare in entrambi i casi.
 *
 * La sede (`scuolaId`) serve alla ricerca; il PUT e il DELETE non la mandano: la decide il server dalla
 * scheda, e una domanda di un'altra sede viene respinta là.
 */
export function AssociaDomanda({
  scuolaId,
  schedaId,
  bambino,
  onCollegato,
}: {
  scuolaId: string
  schedaId: string
  bambino: BambinoRow
  onCollegato: () => void
}) {
  const t = useTranslations('crmCollegamento')
  const idTitolo = useId()
  const [aperta, setAperta] = useState(false)
  const [conferma, setConferma] = useState(false)
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')

  const scollega = async () => {
    setInCorso(true)
    setErrore('')
    const esito = await scollegaDomanda(schedaId, bambino.id)
    setInCorso(false)
    if (esito.ok) {
      setConferma(false)
      onCollegato()
    } else {
      setErrore(esito.testo || t('associaScollegaErrore'))
    }
  }

  if (bambino.domanda_id) {
    return (
      <div className="flex flex-col items-start gap-2">
        {conferma ? (
          <div className="flex flex-col gap-2 rounded-card border border-kidville-line bg-kidville-white p-3">
            <p className="font-maven text-sm font-bold text-kidville-ink">{t('associaScollegaDomanda')}</p>
            <p className="font-maven text-xs text-kidville-sub">{t('associaScollegaDettaglio')}</p>
            <div className="flex flex-wrap gap-2">
              <Btn variant="danger" size="sm" disabled={inCorso} onClick={() => void scollega()}>
                {t('associaScollegaConferma')}
              </Btn>
              <Btn variant="ghost" size="sm" disabled={inCorso} onClick={() => setConferma(false)}>
                {t('associaAnnulla')}
              </Btn>
            </div>
          </div>
        ) : (
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => {
              setErrore('')
              setConferma(true)
            }}
          >
            {t('associaScollega')}
          </Btn>
        )}
        {errore !== '' && (
          <p role="alert" className="font-maven text-xs text-kidville-error-strong">
            {errore}
          </p>
        )}
      </div>
    )
  }

  return (
    <>
      <Btn variant="secondary" size="sm" onClick={() => setAperta(true)}>
        {t('associaApri')}
      </Btn>
      {aperta && (
        <Modal open onClose={() => setAperta(false)} title={t('ricercaTitolo')} labelledBy={idTitolo} className="w-full max-w-lg">
          <div className="max-h-[85vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
            <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
              {t('ricercaTitolo')}
            </h2>
            <div className="mt-4">
              <SceltaDomanda
                scuolaId={scuolaId}
                schedaId={schedaId}
                bambino={bambino}
                onCollegato={() => {
                  setAperta(false)
                  onCollegato()
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
