import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { logEvento } from '@/lib/logging/logger'

// Notifiche Merchandise ai genitori (arrivo/consegna). Best-effort: gli errori
// non bloccano il flusso logistico. Destinatari = tutori dell'alunno
// (legame_genitori_alunni.genitore_id = utenti.id). Il feed è bufferizzato e il
// push parte col cron di dispatch (pattern P1 enqueueNotifiche). Link al genitore
// verso /parent/pagamenti (dove vede l'addebito dell'ordine).

async function genitoriDiAlunno(supabase: SupabaseClient, alunnoId: string): Promise<string[]> {
  try {
    // PostgREST NON lancia: l'errore sta in `{ error }`. Senza questo controllo
    // "nessun destinatario" e "lettura fallita" erano indistinguibili, ed è la
    // differenza fra «l'alunno non ha tutori a sistema» e «la notifica non è
    // partita per un guasto».
    const { data, error } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id')
      .eq('alunno_id', alunnoId)
    if (error) {
      logEvento(
        'notifica',
        'error',
        { operazione: 'merch/notify:genitoriDiAlunno', esito: 'destinatari-non-letti', alunno_id: alunnoId },
        error,
      )
      return []
    }
    return (data ?? []).map((l) => l.genitore_id as string).filter(Boolean)
  } catch (err) {
    // Un catch muto è un bug (AGENTS.md): qui si degrada a "nessun destinatario",
    // ma la ragione va scritta da qualche parte.
    logEvento(
      'notifica',
      'error',
      { operazione: 'merch/notify:genitoriDiAlunno', esito: 'destinatari-non-letti', alunno_id: alunnoId },
      err,
    )
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
    // Scuola dell'alunno per il gate dei toggle notifiche (best-effort).
    const { data: alunno } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle()
    await enqueueNotifiche(supabase, {
      utenteIds: genitori,
      tipo: n.tipo,
      titolo: n.titolo,
      corpo: n.corpo,
      link: '/parent/pagamenti',
      entitaTipo: 'merch_ordine',
      entitaId: n.ordineId ?? null,
      scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
    })
  } catch (err) {
    // `titolo`/`corpo` restano fuori dal log: contengono il nome dell'alunno e
    // l'elenco degli articoli. A log solo il tipo di notifica e l'esito.
    logEvento(
      'notifica',
      'error',
      { operazione: 'merch/notify', tipo: n.tipo, esito: 'notifica-non-accodata', alunno_id: alunnoId },
      err,
    )
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
