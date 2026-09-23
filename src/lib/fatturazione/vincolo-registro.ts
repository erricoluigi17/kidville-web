/**
 * Riconosce QUALE vincolo unico di `fatture_emesse` ha rifiutato un INSERT con codice
 * Postgres `23505` — l'unico modo per distinguere, in `emissione.ts`, una DOPPIA
 * EMISSIONE (stessa quota o stesso numero già a registro) da un altro errore.
 *
 * Puro, senza import: nessun accesso a `@supabase/*`, nessun `err instanceof
 * PostgrestError`, solo lettura di `message`/`details`/`code`, così com'è comodo
 * costruirli anche in un test.
 *
 * Vedi D1§7.1 della spec `2026-09-22-coda-fatture-aruba/d1-correzione-urgente.md`.
 */

/** Indice unico `(sezionale, anno, numero)`, sulle righe con sezionale valorizzato. */
export const INDICE_NUMERO_SERIE = 'fatture_emesse_sezionale_anno_numero_uidx'
/** Indice unico `(pagamento_id, quota)`, sulle sole righe VIVE (non scartate dallo SdI). */
export const INDICE_PAGAMENTO_QUOTA = 'fatture_emesse_pagamento_quota_uidx'
/**
 * Vincolo storico `(scuola_id, anno, numero)`, nato nella baseline. La migrazione di D1
 * lo toglie (rimpiazzato dai due indici sopra, che non collidono fra sedi diverse):
 * questo nome vive ancora nei database NON migrati, come quello della CI.
 */
export const VINCOLO_NUMERO_PER_SEDE = 'fatture_emesse_scuola_id_anno_numero_key'

export type VincoloRegistro = 'pagamento-quota' | 'numero-serie' | 'numero-per-sede' | 'ignoto'

const VINCOLO_PER_NOME: Record<string, VincoloRegistro> = {
  [INDICE_PAGAMENTO_QUOTA]: 'pagamento-quota',
  [INDICE_NUMERO_SERIE]: 'numero-serie',
  [VINCOLO_NUMERO_PER_SEDE]: 'numero-per-sede',
}

/**
 * Prima colonna di ciascun vincolo, nell'ordine in cui Postgres la scrive nel `DETAIL`
 * (`Key (colonna, …)=(…) already exists.`). Basta la prima perché sui tre vincoli di
 * `fatture_emesse` è già univoca: `pagamento_id`, `sezionale`, `scuola_id`.
 */
const VINCOLO_PER_PRIMA_COLONNA: Record<string, VincoloRegistro> = {
  pagamento_id: 'pagamento-quota',
  sezionale: 'numero-serie',
  scuola_id: 'numero-per-sede',
}

/** Il vincolo che ha rifiutato l'INSERT, se lo si riesce a ricavare dall'errore. */
export interface EsitoVincoloRegistro {
  vincolo: VincoloRegistro
  /** Il nome del vincolo/indice, quando è stato letto dal `message`; `null` da `details`. */
  nome: string | null
}

/**
 * `null` quando l'errore non è una violazione di unicità (`code !== '23505'`): a chi
 * chiama serve poter distinguere «non è questo caso» da «è questo caso ma non riconosciuto»
 * (quest'ultimo è `{ vincolo: 'ignoto', nome: … }`).
 *
 * Il nome del vincolo si cerca prima nel `message` (`duplicate key value violates unique
 * constraint "…"`, la forma con cui PostgREST lo inoltra quasi sempre) e solo se assente
 * nel `details` (`Key (colonna, …)=(…) already exists.`), leggendo la prima colonna.
 */
export function vincoloDelRifiuto(err: unknown): EsitoVincoloRegistro | null {
  if (typeof err !== 'object' || err === null) return null
  const { code, message, details } = err as { code?: unknown; message?: unknown; details?: unknown }
  if (code !== '23505') return null

  const daMessaggio = typeof message === 'string' ? /constraint "([a-z0-9_]+)"/.exec(message) : null
  if (daMessaggio) {
    const nome = daMessaggio[1]
    return { vincolo: VINCOLO_PER_NOME[nome] ?? 'ignoto', nome }
  }

  const daDettagli = typeof details === 'string' ? /^Key \(([^)]+)\)/.exec(details) : null
  if (daDettagli) {
    const primaColonna = daDettagli[1].split(',')[0]?.trim().toLowerCase() ?? ''
    return { vincolo: VINCOLO_PER_PRIMA_COLONNA[primaColonna] ?? 'ignoto', nome: null }
  }

  return { vincolo: 'ignoto', nome: null }
}
