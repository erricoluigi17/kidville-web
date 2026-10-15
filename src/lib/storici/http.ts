import { NextResponse } from 'next/server'
import { logErrore } from '@/lib/logging/logger'
import { ErroreStorico } from './db'

/** Copre anche gate e validazione, mantenendo firma dinamica e corpo in streaming. */
export function conCacheStorico<A extends [Request, ...unknown[]]>(
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    let risposta: Response
    try {
      risposta = await handler(...args)
    } catch (error) {
      risposta = rispostaErroreStorico(error, 'storici/http')
    }
    // Copiare le intestazioni funziona anche con Response a header immutabili.
    // Lo stream non viene letto né duplicato: PDF/XLSX mantengono gli stessi byte.
    const headers = new Headers(risposta.headers)
    headers.set('Cache-Control', 'private, no-store')
    return new Response(risposta.body, { status: risposta.status, statusText: risposta.statusText, headers })
  }
}

export function rispostaErroreStorico(error: unknown, operazione: string): NextResponse {
  if (error instanceof ErroreStorico) {
    if (error.stato === 410) return NextResponse.json({ error: error.message, codice: 'STORICO_SCADUTO', motivo: error.codice }, { status: 410 })
    if (error.stato === 503) return NextResponse.json({ error: error.message, codice: 'STORICO_NON_DISPONIBILE', motivo: error.codice }, { status: 503 })
    return NextResponse.json({ error: error.message, codice: 'STORICO_RICHIESTA_RIFIUTATA', motivo: error.codice }, { status: error.stato })
  }
  logErrore({ operazione, stato: 500 }, error)
  return NextResponse.json({ error: 'Operazione sugli storici non riuscita.', codice: 'STORICO_NON_RIUSCITO' }, { status: 500 })
}
