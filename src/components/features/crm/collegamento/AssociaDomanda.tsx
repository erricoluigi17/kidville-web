'use client'

import { Segnaposto } from '../Segnaposto'
import type { BambinoRow } from '@/lib/crm/tipi'

/** Segnaposto della Sessione 4 (associa un bambino a una domanda). Le props sono il contratto: non si cambiano. */
export function AssociaDomanda({
  scuolaId,
  schedaId,
}: {
  scuolaId: string
  schedaId: string
  bambino: BambinoRow
  onCollegato: () => void
}) {
  return <Segnaposto nome="AssociaDomanda" dati={{ 'scuola-id': scuolaId, 'scheda-id': schedaId }} />
}
