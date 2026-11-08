import type { SupabaseClient } from '@supabase/supabase-js'
import { leggiVisibilita } from '@/lib/anno/visibilita-genitore'
import { soloVive } from '@/lib/gallery/cestino'
import { logErrore } from '@/lib/logging/logger'

/**
 * PR 4.4 · LA PAGINA DI GALLERIA DI UNA FAMIGLIA: quali foto, nel loro ordine e col loro totale, lo decide
 * `galleria_pagina_genitore` (`20261108221856_anno_galleria_pagina_genitore.sql`). Qui si leggono soltanto le righe di quegli id.
 *
 * Gli id sono al massimo cento, perché la pagina la taglia la funzione: nessun `.in()` con le diecimila foto di una sede, e nessun
 * passaggio per il tetto di righe di PostgREST.
 *
 * `indietro` è il database che non ha ancora lo schema dell'anno (la CI): la route resta sul filtro di oggi. `guasto` non cade mai
 * su quel filtro, che è la lista larga: la route risponde errore.
 *
 * La lettura delle righe dichiara `soloVive` anche se la funzione le ha già tolte: una foto buttata nel cestino fra le due letture
 * non deve uscire, e il totale di quel giro resta uno in più.
 */

interface OpzioniPagina {
  /** Il filtro della data di oggi, con gli stessi estremi: l'istante di caricamento in UTC. */
  date?: string
  limit: number
  offset: number
}

type RigaPagina = { media_id: string | null; totale: number | string }

export async function paginaGalleriaFamiglia(
  supabase: SupabaseClient,
  utente: string,
  alunno: string,
  { date, limit, offset }: OpzioniPagina,
) {
  const esito = await leggiVisibilita<RigaPagina>(supabase, 'galleria_pagina_genitore', utente, {
    p_alunno: alunno,
    p_dal: date ? `${date}T00:00:00.000Z` : null,
    p_al: date ? `${date}T23:59:59.999Z` : null,
    p_limit: limit,
    p_offset: offset,
  })
  if (esito.stato === 'indietro') return { stato: 'indietro' as const }
  if (esito.stato === 'guasto') return { stato: 'guasto' as const }

  const totale = Number(esito.righe[0]?.totale ?? 0)
  const ids = esito.righe.map((r) => r.media_id).filter((id): id is string => id !== null)
  if (ids.length === 0) return { stato: 'ok' as const, media: [], totale }

  const { data, error } = await soloVive(supabase.from('galleria_media_v2').select('*')).in('id', ids)
  if (error) {
    logErrore({ operazione: 'gallery:GET', stato: 500, evento: 'db' }, error)
    return { stato: 'guasto' as const }
  }
  // `.in()` non conserva l'ordine: quello buono è della funzione.
  const posizione = new Map(ids.map((id, i) => [id, i]))
  const media = (data ?? []).sort((a, b) => (posizione.get(a.id) ?? 0) - (posizione.get(b.id) ?? 0))
  return { stato: 'ok' as const, media, totale }
}
