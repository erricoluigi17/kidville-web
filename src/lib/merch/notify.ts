import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'

// Notifiche Merchandise ai genitori (arrivo/consegna). Best-effort: gli errori
// non bloccano il flusso logistico. Destinatari = tutori dell'alunno
// (legame_genitori_alunni.genitore_id = utenti.id). Il feed è bufferizzato e il
// push parte col cron di dispatch (pattern P1 enqueueNotifiche). Link al genitore
// verso /parent/pagamenti (dove vede l'addebito dell'ordine).

async function genitoriDiAlunno(supabase: SupabaseClient, alunnoId: string): Promise<string[]> {
  try {
    const { data } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id')
      .eq('alunno_id', alunnoId)
    return (data ?? []).map((l) => l.genitore_id as string).filter(Boolean)
  } catch {
    return []
  }
}

async function notifica(
  supabase: SupabaseClient,
  alunnoId: string,
  n: { tipo: string; titolo: string; corpo: string; ordineId?: string | null },
): Promise<void> {
  try {
    const genitori = await genitoriDiAlunno(supabase, alunnoId)
    if (genitori.length === 0) return
    await enqueueNotifiche(supabase, {
      utenteIds: genitori,
      tipo: n.tipo,
      titolo: n.titolo,
      corpo: n.corpo,
      link: '/parent/pagamenti',
      entitaTipo: 'merch_ordine',
      entitaId: n.ordineId ?? null,
    })
  } catch (err) {
    console.error('[merch/notify] fallita (non bloccante):', err)
  }
}

/** Notifica "articolo arrivato": pronto per il ritiro/consegna. */
export async function notificaMerchArrivato(
  supabase: SupabaseClient,
  opts: { alunnoId: string; nomeAlunno?: string | null; articoli: string[]; ordineId?: string | null },
): Promise<void> {
  const lista = opts.articoli.slice(0, 4).join(', ') + (opts.articoli.length > 4 ? '…' : '')
  await notifica(supabase, opts.alunnoId, {
    tipo: 'merch_arrivato',
    titolo: 'Merchandise arrivato',
    corpo: `È arrivato il materiale ordinato${lista ? `: ${lista}` : ''}. Sarà consegnato a scuola.`,
    ordineId: opts.ordineId,
  })
}

/** Notifica "consegnato": materiale consegnato all'alunno. */
export async function notificaMerchConsegnato(
  supabase: SupabaseClient,
  opts: { alunnoId: string; nomeAlunno?: string | null; articoli: string[]; ordineId?: string | null },
): Promise<void> {
  const lista = opts.articoli.slice(0, 4).join(', ') + (opts.articoli.length > 4 ? '…' : '')
  await notifica(supabase, opts.alunnoId, {
    tipo: 'merch_consegnato',
    titolo: 'Merchandise consegnato',
    corpo: `Il materiale è stato consegnato${lista ? `: ${lista}` : ''}.`,
    ordineId: opts.ordineId,
  })
}
