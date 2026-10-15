import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'
import { filtroGiornatePending } from '@/lib/notifiche/giornate-pending'
import { politicaRettificaServizio } from '@/lib/storici/notifiche-servizi'
import { deveNotificareGenitori, type ContestoNotificaOperazione } from '@/lib/storici/retroattivita'

/** Una riga letta e autorizzata dal gate della route, prima della modifica. */
export interface MediaOriginaleNotifica {
  id: string
  uploaded_by: string
  scuola_id: string
  giorno_competenza?: string | null
  politica_operazione?: ContestoNotificaOperazione | null
  created_at?: string | null
}

/** Il batch viene modificato soltanto dalla RPC atomica, mai da delete per autore. */
export async function ritiraNotificheMediaStorico(supabase: SupabaseClient, input: {
  attore: AppUser
  media: MediaOriginaleNotifica
  operazione: string
}): Promise<boolean> {
  const m = input.media
  const politica = politicaRettificaServizio(input.attore, m.giorno_competenza ?? m.politica_operazione?.giornoCompetenza ?? m.created_at)
  if (deveNotificareGenitori(politica)) return false
  try {
    const giorno = politica.giornoOriginale!
    // Le righe prive di provenienza non sono attribuibili a questa foto/sede.
    // La lettura misura l'ambiguità, senza modificarle né ricostruire origini ipotetiche.
    try {
      const legacy = await supabase.from('notifiche').select('id', { count: 'exact', head: true })
        .eq('tipo', 'galleria').eq('entita_id', m.uploaded_by).is('push_inviata_il', null)
        .or('politica_operazione.is.null,politica_operazione->galleria.is.null')
        .or(filtroGiornatePending([giorno]))
      if (legacy.error) {
        logEvento('notifica', 'warn', { operazione: input.operazione, esito: 'galleria-legacy-non-contata', sede_id: m.scuola_id }, legacy.error)
      } else if (legacy.count) {
        logEvento('notifica', 'warn', { operazione: input.operazione, esito: 'galleria-legacy-origini-ambigue', sede_id: m.scuola_id, n: legacy.count })
      }
    } catch (errore) {
      // La sola misura non deve impedire il ritiro comprovato nella RPC.
      logEvento('notifica', 'warn', { operazione: input.operazione, esito: 'galleria-legacy-conteggio-non-eseguito', sede_id: m.scuola_id }, errore)
    }
    const { data, error } = await supabase.rpc('notifiche_galleria_ritira', {
      p_scuola_id: m.scuola_id,
      p_uploaded_by: m.uploaded_by,
      p_media_id: m.id,
      p_giorno: giorno,
    })
    if (error) {
      logEvento('notifica', 'error', { operazione: input.operazione, esito: 'galleria-ritiro-origine-fallito', sede_id: m.scuola_id }, error)
      return false
    }
    if (typeof data !== 'number') throw new Error('Risposta ritiro galleria non valida')
    logEvento('notifica', 'info', { operazione: input.operazione, esito: 'galleria-origine-ritirata', sede_id: m.scuola_id, n: data })
    return true
  } catch (errore) {
    logEvento('notifica', 'error', { operazione: input.operazione, esito: 'galleria-ritiro-origine-non-eseguito', sede_id: m.scuola_id }, errore)
    return false
  }
}
