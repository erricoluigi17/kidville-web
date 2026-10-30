'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 2 (scheda di una famiglia). Le props sono il contratto: non si cambiano. */
export function DettaglioScheda({ schedaId }: { schedaId: string; onChiudi: () => void }) {
  return <Segnaposto nome="DettaglioScheda" dati={{ 'scheda-id': schedaId }} />
}
