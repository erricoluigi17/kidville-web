import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { getModuleConfig } from '@/lib/settings/module-config'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { enqueueNotifiche } from '@/lib/push/enqueue'

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

  // Delega l'insert al core generico del servizio push (buffer condiviso).
  await enqueueNotifiche(supabase, {
    utenteIds: genitori,
    tipo,
    titolo,
    corpo,
    link,
    entitaTipo,
    entitaId,
    bufferMin,
  })
}

/**
 * Notifica il genitore di un aggiornamento del Diario 0-6 (P4/DL-040).
 * Buffer 10' = anche **finestra di modifica**: con DEBOUNCE, ogni salvataggio
 * successivo entro i 10' rimuove la notifica diario ancora non inviata per quel
 * figlio e ne ri-accoda una sola → il genitore riceve un'unica notifica con lo
 * stato finale. Best-effort: non blocca il salvataggio del diario.
 */
export async function enqueueDiarioGenitori(
  supabase: SupabaseClient,
  { alunnoId, nome, bufferMin = 10 }: { alunnoId: string; nome?: string | null; bufferMin?: number },
): Promise<void> {
  if (!alunnoId) return
  // Debounce: elimina le notifiche diario pending (non inviate) di questo figlio.
  try {
    await supabase
      .from('notifiche')
      .delete()
      .eq('entita_tipo', 'diario')
      .eq('entita_id', alunnoId)
      .is('push_inviata_il', null)
  } catch (e) {
    console.error('[enqueueDiarioGenitori] debounce fallito (non bloccante):', e)
  }
  await enqueueNotifichePerAlunni(supabase, {
    alunnoIds: [alunnoId],
    tipo: 'diario',
    titolo: 'Diario aggiornato',
    corpo: `Nuovo aggiornamento nel diario di ${nome ?? 'tuo figlio'}`,
    entitaTipo: 'diario',
    entitaId: alunnoId,
    bufferMin,
  })
}

/**
 * Notifica i docenti TITOLARI di una sezione quando una scrittura è stata
 * effettuata da Segreteria/Direzione (non dal titolare stesso). Trasparenza
 * PRD §12. Configurabile per scuola via admin_settings.segreteria_config
 * (notifica_docente, default true). Best-effort: non blocca il flusso.
 */
export async function notificaTitolariScrittura(
  supabase: SupabaseClient,
  opts: {
    attore: AppUser
    sectionId: string
    scuolaId?: string | null
    area: string
    link?: string
  }
): Promise<void> {
  try {
    // Solo per scritture NON del docente titolare (segreteria/direzione/coordinator).
    if (opts.attore.role === 'educator') return

    const cfg = await getModuleConfig<{ notifica_docente?: boolean }>(
      supabase,
      'segreteria_config',
      opts.scuolaId ?? opts.attore.scuola_id,
    )
    if (cfg?.notifica_docente === false) return // default: notifica attiva

    const titolari = (await docentiDiSezione(supabase, opts.sectionId)).filter((id) => id !== opts.attore.id)
    if (titolari.length === 0) return

    const nome = [opts.attore.nome, opts.attore.cognome].filter(Boolean).join(' ').trim() || 'La Segreteria'
    await enqueueNotifiche(supabase, {
      utenteIds: titolari,
      tipo: 'segreteria_scrittura',
      titolo: `Aggiornamento Segreteria — ${opts.area}`,
      corpo: `${nome} ha aggiornato "${opts.area}" nella tua classe.`,
      link: opts.link ?? null,
      entitaTipo: opts.area,
      bufferMin: 0,
    })
  } catch (e) {
    console.error('notificaTitolariScrittura:', e)
  }
}
