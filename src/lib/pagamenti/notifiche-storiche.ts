import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContestoNotificaOperazione } from '@/lib/storici/retroattivita'
import { ritiraPendingOperazione } from '@/lib/notifiche/ritira-pending'

/** Una modifica contabile può non emettere un nuovo evento: ritira comunque il vecchio avviso. */
export async function ritiraPendingPagamento(supabase: SupabaseClient, p: {
  pagamentoId: string; alunnoId?: string | null; scuolaId?: string | null; operazione: ContestoNotificaOperazione
}): Promise<void> {
  if (!p.alunnoId) return
  for (const tipo of ['pagamento_registrato', 'pagamento_emesso']) {
    await ritiraPendingOperazione(supabase, { tipo, entitaTipo: 'pagamento', entitaId: p.pagamentoId,
      alunnoIds: [p.alunnoId], scuolaId: p.scuolaId, operazione: p.operazione, destinatario: 'genitore' })
  }
}
