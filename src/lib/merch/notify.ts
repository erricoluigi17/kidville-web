import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { getGenitoriDiAlunno } from '@/lib/anagrafiche/legami'
import { logEvento } from '@/lib/logging/logger'

// Notifiche Merchandise ai genitori (arrivo/consegna). Best-effort: gli errori
// non bloccano il flusso logistico. Destinatari = tutori dell'alunno, risolti
// sull'UNIONE runtime (`legame_genitori_alunni`) + anagrafica
// (`student_parents` via ponte `parents.auth_user_id`): con la sola runtime il
// genitore di un bambino importato dal form pubblico non veniva mai avvisato che
// il materiale era arrivato — restava a scuola senza che nessuno lo sapesse.
// Il feed è bufferizzato e il push parte col cron di dispatch (pattern P1
// enqueueNotifiche). Link al genitore verso /parent/pagamenti (dove vede
// l'addebito dell'ordine).
//
// Gli errori di lettura NON si perdono: `getGenitoriDiAlunno` li logga da sé
// (PostgREST non lancia, ritorna `{ error }`), col conteggio e il codice.

async function genitoriDiAlunno(supabase: SupabaseClient, alunnoId: string): Promise<string[]> {
  try {
    return await getGenitoriDiAlunno(supabase, alunnoId)
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
