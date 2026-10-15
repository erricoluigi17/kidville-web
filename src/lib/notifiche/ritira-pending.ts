import type { SupabaseClient } from '@supabase/supabase-js'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { getGenitoriDiAlunniEsito } from '@/lib/anagrafiche/legami'
import { logEvento } from '@/lib/logging/logger'
import { filtroGiornatePending } from './giornate-pending'
import { deveNotificareGenitori, type ContestoNotificaOperazione } from '@/lib/storici/retroattivita'

export interface RitiroNotifichePending {
  tipo: string
  entitaId?: string | null
  entitaTipo?: string | null
  /** Sede già verificata sul dato dal chiamante; le notifiche legacy non hanno scuola_id. */
  scuolaId?: string | null
  utenteIds?: readonly string[]
  alunnoIds?: readonly string[]
  giorniOriginali: readonly string[]
}

/** Ritira solo righe ancora pendenti dello stesso fatto e dei suoi genitori. */
export async function ritiraNotifichePending(supabase: SupabaseClient, params: RitiroNotifichePending): Promise<boolean> {
  try {
    if (!params.entitaId || !params.giorniOriginali.length) return false
    const destinatari = new Set((params.utenteIds ?? []).filter(Boolean))
    if (params.alunnoIds?.length) {
      const esito = await getGenitoriDiAlunniEsito(supabase, [...params.alunnoIds])
      if (!esito.completo) {
        logEvento('notifica', 'error', { operazione: 'ritiraNotifichePending', esito: 'ritiro-destinatari-incompleti', tipo: params.tipo, entitaId: params.entitaId })
        return false
      }
      for (const ids of esito.perAlunno.values()) for (const id of ids) destinatari.add(id)
    }
    if (!destinatari.size) {
      logEvento('notifica', 'warn', { operazione: 'ritiraNotifichePending', esito: 'ritiro-senza-destinatari', tipo: params.tipo, entitaId: params.entitaId })
      return false
    }
    let nRitirate = 0
    for (const blocco of aBlocchi([...destinatari], ID_PER_QUERY)) {
      const disponibili = { giornoCompetenza: true, politicaOperazione: true }
      const cancella = () => {
        let q = supabase.from('notifiche').delete().eq('tipo', params.tipo)
          .eq('entita_id', params.entitaId).in('utente_id', blocco).is('push_inviata_il', null)
        if (params.entitaTipo) q = q.eq('entita_tipo', params.entitaTipo)
        return q.or(filtroGiornatePending(params.giorniOriginali, disponibili)).select('id')
      }
      let risultato = await cancella()
      for (let n = 0; risultato.error && n < 2; n += 1) {
        if (!['42703', 'PGRST204'].includes(risultato.error.code ?? '')) break
        const assente = /\b(giorno_competenza|politica_operazione)\b/.exec(risultato.error.message ?? '')?.[1]
        const campo = assente === 'giorno_competenza' ? 'giornoCompetenza' : assente === 'politica_operazione' ? 'politicaOperazione' : null
        if (!campo || !disponibili[campo]) break
        disponibili[campo] = false
        logEvento('notifica', 'warn', { operazione: 'ritiraNotifichePending', esito: 'ritiro-schema-precedente', tipo: params.tipo }, risultato.error)
        risultato = await cancella()
      }
      if (risultato.error) {
        logEvento('notifica', 'error', { operazione: 'ritiraNotifichePending', esito: 'ritiro-pending-fallito', tipo: params.tipo, entitaId: params.entitaId }, risultato.error)
        return false
      }
      nRitirate += (risultato.data ?? []).length
    }
    logEvento('notifica', 'info', { operazione: 'ritiraNotifichePending', esito: 'pending-storiche-ritirate', tipo: params.tipo, entitaId: params.entitaId, n_ritirate: nRitirate })
    return true
  } catch (errore) {
    logEvento('notifica', 'error', { operazione: 'ritiraNotifichePending', esito: 'ritiro-pending-non-eseguito', tipo: params.tipo, entitaId: params.entitaId ?? null }, errore)
    return false
  }
}

/** La decisione proviene dall'operazione autenticata; il giorno di destinazione non identifica la vecchia coda. */
export async function ritiraPendingOperazione(supabase: SupabaseClient, params: Omit<RitiroNotifichePending, 'giorniOriginali'> & {
  operazione?: ContestoNotificaOperazione | null
  destinatario?: 'genitore' | 'personale'
}): Promise<boolean> {
  if (params.destinatario === 'personale' || deveNotificareGenitori(params.operazione) || !params.operazione) return false
  // La galleria aggrega più media per autore: il ritiro usa la RPC con provenienza.
  if (params.tipo === 'galleria') return false
  return ritiraNotifichePending(supabase, { ...params, giorniOriginali: [params.operazione.giornoOriginale ?? params.operazione.giornoCompetenza] })
}
