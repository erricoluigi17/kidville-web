import { logEvento } from '@/lib/logging/logger'
import { STATI_ATTIVI, codaAssente, type StatoCodaAttivo } from './api'

/** `max_rows` di PostgREST: oltre, la risposta si tronca SENZA dirlo (v. `MAX_ROWS_POSTGREST` in riconciliazione). */
export const MAX_RIGHE_CODA = 1000

function attivo(v: unknown): v is StatoCodaAttivo {
  return typeof v === 'string' && (STATI_ATTIVI as readonly string[]).includes(v)
}

/**
 * La voce ATTIVA della coda fatture per ogni pagamento (consegna 2a, rilievo e).
 *
 * La query la scrive l'HANDLER, dentro `chiedi`: `isolamento-sede-coverage` ragiona per
 * handler, e una `.from()` qui sarebbe invisibile al lock (stessa scelta di `aBlocchi`).
 * Non lancia mai: il chip è un'informazione, e la sua assenza non può costare la lista.
 * Mappa vuota = nessuna voce attiva OPPURE coda non letta: lo distinguono i log.
 */
export async function leggiCodaAttiva(
  chiedi: () => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  operazione: string,
): Promise<Map<string, StatoCodaAttivo>> {
  const vuota = new Map<string, StatoCodaAttivo>()
  let esito: { data: unknown[] | null; error: unknown }
  try {
    esito = await chiedi()
  } catch (err) {
    logEvento('fattura', 'warn', { operazione, esito: 'coda-badge-eccezione' }, err)
    return vuota
  }
  // PostgREST non lancia: l'errore sta nel valore di ritorno.
  if (esito.error || !esito.data) {
    if (codaAssente(esito.error)) logEvento('fattura', 'info', { operazione, esito: 'coda-assente' }, esito.error)
    else logEvento('fattura', 'warn', { operazione, esito: 'coda-badge-non-letta' }, esito.error)
    return vuota
  }
  const perPagamento = new Map<string, StatoCodaAttivo>()
  for (const r of esito.data as ({ pagamento_id?: unknown; stato?: unknown } | null)[]) {
    if (typeof r?.pagamento_id === 'string' && attivo(r.stato)) perPagamento.set(r.pagamento_id, r.stato)
  }
  if (esito.data.length >= MAX_RIGHE_CODA) {
    logEvento('fattura', 'warn', { operazione, esito: 'coda-badge-troncato', n: esito.data.length })
  }
  return perPagamento
}
