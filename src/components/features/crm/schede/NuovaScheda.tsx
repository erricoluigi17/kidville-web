'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 2 (nuova famiglia). Le props sono il contratto: non si cambiano. */
export function NuovaScheda({
  scuolaId,
}: {
  scuolaId: string
  onCreata: (schedaId: string) => void
  onAnnulla: () => void
}) {
  return <Segnaposto nome="NuovaScheda" dati={{ 'scuola-id': scuolaId }} />
}
