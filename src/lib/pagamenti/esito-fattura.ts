'use client'

import { logClient, nomeErrore } from '@/lib/logging/client'

export type EsitoFattura =
  | 'visualizzata'
  | 'annullata'
  | 'browser_avviato'
  | 'salvataggio_avviato'

export interface RegistraEsitoFatturaInput {
  pagamentoId: string
  fatturaId: string
  esito: EsitoFattura
}

export async function registraEsitoFattura({
  pagamentoId,
  fatturaId,
  esito,
}: RegistraEsitoFatturaInput): Promise<void> {
  try {
    const risposta = await fetch('/api/pagamenti/fattura/esito', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pagamento_id: pagamentoId,
        fattura_id: fatturaId,
        esito,
      }),
    })
    if (!risposta.ok) {
      logClient({
        livello: risposta.status >= 500 ? 'error' : 'warn',
        evento: 'fetch',
        messaggio: 'fattura-esito-non-registrato',
        stato: risposta.status,
        campi: { error_code: 'RispostaHttp' },
      })
    }
  } catch (errore) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'fattura-esito-non-registrato',
      stato: 0,
      campi: { error_code: nomeErrore(errore) },
    })
  }
}
