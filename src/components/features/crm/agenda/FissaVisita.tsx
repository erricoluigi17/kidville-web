'use client'

import { Segnaposto } from '../Segnaposto'
import type { AppuntamentoRow } from '@/lib/crm/tipi'

/** Segnaposto della Sessione 3 (fissa o sposta una visita). Le props sono il contratto: non si cambiano. */
export function FissaVisita({
  scuolaId,
  schedaId,
}: {
  scuolaId: string
  schedaId?: string
  appuntamento?: AppuntamentoRow
  inizioProposto?: string
  assegnataProposta?: string
  onFatto: () => void
  onAnnulla: () => void
}) {
  return <Segnaposto nome="FissaVisita" dati={{ 'scuola-id': scuolaId, 'scheda-id': schedaId }} />
}
