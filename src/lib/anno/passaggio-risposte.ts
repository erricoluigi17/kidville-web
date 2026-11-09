import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { erroreAnno } from '@/lib/anno/errori'
import { impostazioniNonDisponibili, rispostaErroreImpostazioni, type ContestoRifiuto } from '@/lib/anno/impostazioni'
import { leggiPassaggio, type CodicePassaggio } from '@/lib/anno/passaggio'
import { logEvento } from '@/lib/logging/logger'

/**
 * LE RISPOSTE COMUNI DELLE SEI ROUTE DEL PASSAGGIO (PR 4.8, compito 4.8.8). Qui non si chiama nessuna funzione `passaggio_*`
 * (sono dentro `passaggio.ts`, l'unica porta) e non si legge né si scrive nessuna tabella: si traduce un esito della porta in una
 * risposta HTTP, e si trova il passaggio di un anno.
 */

/** Un esito della porta che NON è un successo: schema indietro, oppure un rifiuto con il suo codice (e i conteggi del DETAIL). */
type EsitoNonRiuscito =
  | { ok: true; saltata: 'schema-indietro' }
  | { ok: false; codice: CodicePassaggio; dettagli?: Record<string, number> }

/**
 * Esito non riuscito → risposta. Schema indietro → 503 con codice (`info`, mai 500). Un codice dell'anno → la risposta di
 * `erroreAnno` (409/422/404) con i conteggi numerici del DETAIL; per `PASSAGGIO_NON_ANNULLABILE` stanno sotto `conteggi` (uno per
 * tabella: il nome di una tabella non deve poter sovrapporsi a un altro campo). Ogni altro guasto → 500 `SCRITTURA_FALLITA`:
 * la porta ne ha già scritto il SQLSTATE nel log, qui non c'è niente da aggiungere ai dati.
 */
export function rispostaPassaggioNonRiuscito(esito: EsitoNonRiuscito, ctx: ContestoRifiuto): NextResponse {
  if (esito.ok) return impostazioniNonDisponibili({ code: 'PGRST202' }, ctx.operazione)
  const dettagli = esito.dettagli
    ? esito.codice === 'PASSAGGIO_NON_ANNULLABILE'
      ? { conteggi: esito.dettagli }
      : esito.dettagli
    : undefined
  return erroreAnno({ message: esito.codice }, ctx.operazione, dettagli) ?? rispostaErroreImpostazioni({ message: esito.codice }, ctx)
}

type Db = SupabaseClient

/**
 * Il passaggio NON annullato verso l'anno nuovo dell'URL: l'uuid lo decide il SERVER, mai il corpo. Una richiesta non può nominare
 * il passaggio di un'altra sede (la service role non lo impedirebbe): nomina un anno, e quell'anno ha già passato il perimetro.
 * Nessun passaggio → 404 `PASSAGGIO_NON_TROVATO`; schema indietro → 503.
 */
export async function passaggioDellAnno(
  supabase: Db,
  annoSedeId: string,
  ctx: ContestoRifiuto,
): Promise<{ passaggioId: string } | { response: NextResponse }> {
  const lettura = await leggiPassaggio(supabase, annoSedeId, { pagina: 1, tetto: 1 })
  if (!lettura.ok) return { response: rispostaPassaggioNonRiuscito(lettura, { ...ctx, lettura: true }) }
  if ('saltata' in lettura) return { response: rispostaPassaggioNonRiuscito(lettura, { ...ctx, lettura: true }) }
  if (!lettura.passaggio) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'passaggio-rifiutato',
      operazione: ctx.operazione,
      error_code: 'PASSAGGIO_NON_TROVATO',
      entita_id: annoSedeId,
    })
    return { response: rispostaPassaggioNonRiuscito({ ok: false, codice: 'PASSAGGIO_NON_TROVATO' }, ctx) }
  }
  return { passaggioId: lettura.passaggio.id }
}
