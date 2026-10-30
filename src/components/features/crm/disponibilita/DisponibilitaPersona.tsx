'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 3 (disponibilità di una persona). Le props sono il contratto: non si cambiano. */
export function DisponibilitaPersona({ scuolaId }: { scuolaId: string }) {
  return <Segnaposto nome="DisponibilitaPersona" dati={{ 'scuola-id': scuolaId }} />
}
