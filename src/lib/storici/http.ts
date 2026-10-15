import { NextResponse } from 'next/server'
import { logErrore } from '@/lib/logging/logger'
import { ErroreStorico } from './db'

export function rispostaErroreStorico(error: unknown, operazione: string): NextResponse {
  if (error instanceof ErroreStorico) {
    if (error.stato === 410) return NextResponse.json({ error: error.message, codice: 'STORICO_SCADUTO', motivo: error.codice }, { status: 410 })
    if (error.stato === 503) return NextResponse.json({ error: error.message, codice: 'STORICO_NON_DISPONIBILE', motivo: error.codice }, { status: 503 })
    return NextResponse.json({ error: error.message, codice: 'STORICO_RICHIESTA_RIFIUTATA', motivo: error.codice }, { status: error.stato })
  }
  logErrore({ operazione, stato: 500 }, error)
  return NextResponse.json({ error: 'Operazione sugli storici non riuscita.', codice: 'STORICO_NON_RIUSCITO' }, { status: 500 })
}
