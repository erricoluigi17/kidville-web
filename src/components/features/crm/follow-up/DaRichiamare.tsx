'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 5 (elenco dei richiami). Le props sono il contratto: non si cambiano. */
export function DaRichiamare({ scuolaId }: { scuolaId: string; onApriScheda: (schedaId: string) => void }) {
  return <Segnaposto nome="DaRichiamare" dati={{ 'scuola-id': scuolaId }} />
}
