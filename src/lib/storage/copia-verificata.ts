import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * COPIARE PRIMA DI TOGLIERE, E SAPERE SE LA COPIA C'È.
 *
 * `storage.from(b).copy(da, a)` risponde `{ data, error }` e non lancia sui 4xx; l'errore porta
 * `statusCode` come stringa ('404', '409') e `status` come numero. Tre esiti NON sono guasti e
 * restano separati, perché il chiamante decide su di essi:
 *  · copiato               → la copia c'è;
 *  · destinazione già lì   → la copia c'è (l'ha fatta un tentativo precedente);
 *  · sorgente assente      → non c'è niente da conservare: un `info`, non un errore.
 * Tutto il resto è un guasto, e il chiamante NON deve togliere l'originale. «Bucket not found»
 * porta anch'esso 404 ma è un guasto: si riconosce dal testo e si esclude.
 *
 * Si prosegue su tutte le coppie anche dopo un guasto: il chiamante deve sapere QUALI copie
 * sono arrivate, per toglierle se annulla. Nei log mai i percorsi (uuid di alunni, nomi scelti
 * dalle famiglie): solo conteggi.
 */

export type CoppiaCopia = { da: string; a: string }

export type EsitoCopia = {
  copiati: CoppiaCopia[]
  giaPresenti: CoppiaCopia[]
  sorgentiAssenti: CoppiaCopia[]
  falliti: CoppiaCopia[]
  primoErrore: unknown
}

function campi(e: unknown): { messaggio: string; stato: string } {
  const o = (e ?? {}) as { message?: unknown; statusCode?: unknown; status?: unknown }
  return {
    messaggio: typeof o.message === 'string' ? o.message : '',
    stato: String(o.statusCode ?? o.status ?? ''),
  }
}

/** L'OGGETTO non c'è. Un bucket assente non vale: è un guasto di configurazione. */
export function oggettoAssente(e: unknown): boolean {
  if (!e) return false
  const { messaggio, stato } = campi(e)
  if (/bucket/i.test(messaggio)) return false
  return stato === '404' || /object not found/i.test(messaggio)
}

/** La destinazione esiste già. */
export function destinazioneGiaPresente(e: unknown): boolean {
  if (!e) return false
  const { messaggio, stato } = campi(e)
  return stato === '409' || /already exists/i.test(messaggio)
}

export async function copiaNelBucket(
  supabase: SupabaseClient,
  bucket: string,
  coppie: CoppiaCopia[],
  op: string,
): Promise<EsitoCopia> {
  const esito: EsitoCopia = { copiati: [], giaPresenti: [], sorgentiAssenti: [], falliti: [], primoErrore: null }

  const viste = new Set<string>()
  const unici: CoppiaCopia[] = []
  for (const c of coppie) {
    const da = typeof c?.da === 'string' ? c.da.trim() : ''
    const a = typeof c?.a === 'string' ? c.a.trim() : ''
    if (!da || !a || da === a) continue
    const chiave = `${da}\n${a}`
    if (viste.has(chiave)) continue
    viste.add(chiave)
    unici.push({ da, a })
  }
  if (unici.length === 0) return esito

  const archivio = supabase.storage.from(bucket)
  for (const c of unici) {
    try {
      const { error } = await archivio.copy(c.da, c.a)
      if (!error) esito.copiati.push(c)
      else if (destinazioneGiaPresente(error)) esito.giaPresenti.push(c)
      else if (oggettoAssente(error)) esito.sorgentiAssenti.push(c)
      else {
        esito.falliti.push(c)
        esito.primoErrore ??= error
      }
    } catch (e) {
      // Guasto di TRASPORTO: `copy()` non ritorna, lancia. Stesso trattamento dell'errore restituito.
      esito.falliti.push(c)
      esito.primoErrore ??= e
    }
  }

  if (esito.falliti.length > 0) {
    logEvento(
      'storage',
      'error',
      {
        operazione: op,
        esito: 'copie-non-riuscite',
        tipo: 'copia-verificata',
        bucket,
        n_file: unici.length,
        n_copiati: esito.copiati.length + esito.giaPresenti.length,
        n_falliti: esito.falliti.length,
      },
      esito.primoErrore,
    )
  }
  if (esito.sorgentiAssenti.length > 0) {
    logEvento('storage', 'info', {
      operazione: op,
      esito: 'copie-sorgente-assente',
      tipo: 'copia-verificata',
      bucket,
      n_file: unici.length,
      n_sorgenti_assenti: esito.sorgentiAssenti.length,
    })
  }
  return esito
}
