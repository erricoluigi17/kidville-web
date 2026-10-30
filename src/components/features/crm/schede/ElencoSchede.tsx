'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 2 (elenco delle schede). Le props sono il contratto: non si cambiano. */
export function ElencoSchede({ scuolaId }: { scuolaId: string; onApri: (schedaId: string) => void }) {
  return <Segnaposto nome="ElencoSchede" dati={{ 'scuola-id': scuolaId }} />
}
