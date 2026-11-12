'use client'

import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'

/**
 * LA RIGA FISSA DELL'ANNO CHE SI STA CHIUDENDO (PR 4.9, chiusura A).
 *
 * In agosto l'anno è `in_chiusura`: la Direzione e la segreteria scrivono senza dare un motivo, e non c'è nessun dialogo. Questa riga
 * dice solo di che anno si tratta e che si può ancora correggere. Non decide niente: la monta chi sa che l'anno è `in_chiusura`
 * (il server lo dice con `SEZIONE_IN_CHIUSURA`/`ANNO_CHIUSO`). È una nota, non un allarme: `role="note"`, mai `alert`.
 */
export function AvvisoAnnoInChiusura({ etichetta }: { etichetta?: string }) {
  const t = useTranslations('annoChiusura')
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-lg border border-kidville-info/30 bg-kidville-info-soft px-3 py-2 text-sm text-kidville-info-strong"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{etichetta ? t('rigaFissa', { etichetta }) : t('rigaFissaSenzaAnno')}</span>
    </p>
  )
}
