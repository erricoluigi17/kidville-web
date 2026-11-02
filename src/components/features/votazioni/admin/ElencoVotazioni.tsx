'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/Badge'
import { TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit'
import { formatData } from '@/lib/i18n/date'
import type { RiepilogoVotazione } from '@/lib/votazioni/tipi'

/**
 * VOTAZIONI · L'ELENCO DELLA SEGRETERIA.
 *
 * Una riga per votazione: titolo, stato, scadenza (ora di Roma), le schede (i nomi delle classi, più
 * «+ istituto») e i votanti. Il comando che apre il dettaglio è il TITOLO, un vero `<button>` dentro la cella:
 * la riga non porta nessun `onClick` (lock `righe-tabella-con-comando`), così la tastiera e lo screen reader
 * arrivano dove arriva il mouse.
 */

const COMANDO_TITOLO =
  'text-left font-maven text-sm font-bold text-kidville-green underline-offset-2 hover:underline focus-visible:underline'

export function ElencoVotazioni({
  votazioni,
  onApri,
}: {
  votazioni: RiepilogoVotazione[]
  onApri: (id: string) => void
}) {
  const t = useTranslations('votazioniAdmin')
  const locale = useLocale()

  // Le schede, nell'ordine delle classi che il server ha già messo; l'istituto in coda, come sulla scheda.
  const schede = (v: RiepilogoVotazione): string => {
    if (v.classi.length === 0) return t('soloIstituto')
    const classi = v.classi.map((c) => c.nome).join(', ')
    return v.rappresentanteIstituto ? `${classi} ${t('piuIstituto')}` : classi
  }

  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <caption className="sr-only">{t('elencoCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>{t('colTitolo')}</th>
            <th scope="col" className={TH}>{t('colStato')}</th>
            <th scope="col" className={TH}>{t('colScadenza')}</th>
            <th scope="col" className={TH}>{t('colClassi')}</th>
            <th scope="col" className={TH}>{t('colVotanti')}</th>
          </tr>
        </thead>
        <tbody>
          {votazioni.map((v) => (
            <tr key={v.id} className={TROW}>
              <td className={TD}>
                <button type="button" onClick={() => onApri(v.id)} className={COMANDO_TITOLO}>
                  {v.titolo}
                </button>
              </td>
              <td className={TD}>
                <Badge tone={v.stato === 'aperta' ? 'success' : 'neutral'}>
                  {v.stato === 'aperta' ? t('statoAperta') : t('statoChiusa')}
                </Badge>
              </td>
              <td className={`${TD} font-maven text-sm text-kidville-ink`}>{formatData(v.scadenza, locale, 'dataOra')}</td>
              <td className={`${TD} font-maven text-sm text-kidville-ink`}>{schede(v)}</td>
              <td className={`${TD} font-maven text-sm text-kidville-ink`}>{v.votanti}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
