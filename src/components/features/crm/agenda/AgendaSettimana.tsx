'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 3 (agenda della settimana). Le props sono il contratto: non si cambiano. */
export function AgendaSettimana({ scuolaId }: { scuolaId: string; onApriScheda: (schedaId: string) => void }) {
  return <Segnaposto nome="AgendaSettimana" dati={{ 'scuola-id': scuolaId }} />
}
