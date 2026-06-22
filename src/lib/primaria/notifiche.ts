import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { getModuleConfig } from '@/lib/settings/module-config'
import { docentiDiSezione } from '@/lib/sezioni/docenti'

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
    const rows = titolari.map((uid) => ({
      utente_id: uid,
      tipo: 'segreteria_scrittura',
      titolo: `Aggiornamento Segreteria — ${opts.area}`,
      corpo: `${nome} ha aggiornato "${opts.area}" nella tua classe.`,
      link: opts.link ?? null,
      entita_tipo: opts.area,
      invio_programmato_il: new Date().toISOString(),
    }))
    await supabase.from('notifiche').insert(rows)
  } catch (e) {
    console.error('notificaTitolariScrittura:', e)
  }
}
