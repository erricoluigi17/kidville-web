'use client'

import { Segnaposto } from '../Segnaposto'
import type { SchedaRow } from '@/lib/crm/tipi'

/** Segnaposto della Sessione 4 (avviso «domanda da associare»). Le props sono il contratto: non si cambiano. */
export function AvvisoDomandaDaAssociare({ scheda }: { scheda: SchedaRow; onAggiornata: () => void }) {
  return <Segnaposto nome="AvvisoDomandaDaAssociare" dati={{ 'scheda-id': scheda.id }} />
}
