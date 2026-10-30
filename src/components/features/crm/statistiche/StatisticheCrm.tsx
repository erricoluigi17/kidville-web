'use client'

import { Segnaposto } from '../Segnaposto'

/** Segnaposto della Sessione 6 (statistiche del CRM). Le props sono il contratto: non si cambiano. */
export function StatisticheCrm({ scuolaId }: { scuolaId: string }) {
  return <Segnaposto nome="StatisticheCrm" dati={{ 'scuola-id': scuolaId }} />
}
