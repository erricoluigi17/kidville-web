import type { SupabaseClient } from '@supabase/supabase-js'

interface EnqueueParams {
  alunnoIds: string[]
  tipo: string
  titolo: string
  corpo?: string
  link?: string
  entitaTipo?: string
  entitaId?: string
  bufferMin?: number
}

/**
 * Crea notifiche in-app (e push, via dispatch) per i genitori degli alunni dati.
 * Con buffer: la notifica diventa inviabile solo dopo `bufferMin` minuti
 * (decisione: tutte le notifiche del registro primaria hanno buffer).
 * Best-effort: gli errori non devono bloccare il flusso chiamante.
 */
export async function enqueueNotifichePerAlunni(
  supabase: SupabaseClient,
  { alunnoIds, tipo, titolo, corpo, link, entitaTipo, entitaId, bufferMin = 10 }: EnqueueParams
): Promise<void> {
  if (!alunnoIds || alunnoIds.length === 0) return

  const { data: legami } = await supabase
    .from('legame_genitori_alunni')
    .select('genitore_id, alunno_id')
    .in('alunno_id', alunnoIds)

  const genitori = [...new Set((legami ?? []).map((l) => l.genitore_id as string))]
  if (genitori.length === 0) return

  const programmato = new Date(Date.now() + bufferMin * 60_000).toISOString()
  const rows = genitori.map((gid) => ({
    utente_id: gid,
    tipo,
    titolo,
    corpo: corpo ?? null,
    link: link ?? null,
    entita_tipo: entitaTipo ?? null,
    entita_id: entitaId ?? null,
    invio_programmato_il: programmato,
  }))

  await supabase.from('notifiche').insert(rows)
}
