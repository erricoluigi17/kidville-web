'use client'

import { Segnaposto } from '../Segnaposto'
import type { BambinoRow } from '@/lib/crm/tipi'

/** Segnaposto della Sessione 4 (stato del collegamento con la domanda). Le props sono il contratto: non si cambiano. */
export function BadgeCollegamento({ bambino }: { bambino: BambinoRow }) {
  return <Segnaposto nome="BadgeCollegamento" dati={{ 'bambino-id': bambino.id }} />
}
