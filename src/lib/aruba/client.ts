/**
 * Aruba — client di fatturazione elettronica (SCAFFOLD / STUB).
 *
 * In produzione qui andrà la chiamata reale alle API Aruba (SDI/XML):
 * autenticazione (username + password recuperata da `password_ref` via env/vault),
 * generazione XML FatturaPA, invio, polling stato (emessa/scartata).
 *
 * In questa fase è un mock deterministico: NESSUNA chiamata di rete, nessuna
 * credenziale usata. Serve a far funzionare l'intero flusso UI/DB (stati
 * emessa/scartata, download) in attesa dell'attivazione reale.
 */

export interface ArubaConfig {
  username?: string
  password_ref?: string
  abilitato?: boolean
  ambiente?: string
  fiscal?: Record<string, string>
  iva?: { causale: string; aliquota: number; natura?: string }[]
}

export interface FatturaInput {
  pagamento_id: string
  descrizione: string
  importo: number
  intestatario?: { tipo?: string; nome?: string; dati?: Record<string, string> } | null
}

export interface FatturaResult {
  ok: boolean
  stato: 'emessa' | 'scartata'
  fattura_id?: string
  pdf_path?: string
  errore?: string
}

/**
 * Emette una fattura (STUB). Ritorna sempre un esito mock "emessa" con id e path
 * fittizi. La logica reale Aruba sostituirà questa funzione.
 */
export async function emettiFattura(input: FatturaInput, _config: ArubaConfig): Promise<FatturaResult> {
  // Validazione minima coerente con quanto servirà al chiamante reale.
  if (!input.pagamento_id || input.importo <= 0) {
    return { ok: false, stato: 'scartata', errore: 'Dati fattura non validi' }
  }

  // MOCK: id e path deterministici basati sul pagamento.
  const shortId = input.pagamento_id.replace(/-/g, '').slice(0, 12).toUpperCase()
  const fatturaId = `MOCK-${shortId}`
  const pdfPath = `fatture/${input.pagamento_id}.pdf` // path logico (storage in produzione)

  return { ok: true, stato: 'emessa', fattura_id: fatturaId, pdf_path: pdfPath }
}
