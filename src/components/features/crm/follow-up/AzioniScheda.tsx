'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 5 (richiami di una scheda). Le props sono il contratto: non si cambiano. */
export function AzioniScheda({
  scuolaId,
  schedaId,
}: {
  scuolaId: string
  schedaId: string
  onAggiornata: () => void
}) {
  return <Segnaposto nome="AzioniScheda" dati={{ 'scuola-id': scuolaId, 'scheda-id': schedaId }} />
}
