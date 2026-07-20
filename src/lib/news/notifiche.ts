import type { SupabaseClient } from '@supabase/supabase-js'
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { logEvento, logErrore } from '@/lib/logging/logger'
import type { NewsGrado, NewsScope } from '@/lib/news/tipi'

// =============================================================================
// Notifiche della sezione «News».
//
// `genitoriDiGrado` vive QUI e non in src/lib/notifiche/destinatari.ts (perimetro
// chiuso dello Step 1): risolve i genitori dei bambini di un grado in una sede
// (il grado è school_type della sezione).
//
// `notificaNewsPubblicata` è il chokepoint di notifica alla pubblicazione:
// guardia idempotente su `notifica_inviata_il` + rispetto di `invia_notifica`,
// risoluzione destinatari per scope, invio via notificaEvento(tipo:'news') e
// marcatura `notifica_inviata_il` controllando `{ error }` (PostgREST non lancia).
// Il SUCCESSO si logga (canale news persistito): «nessun log» non deve poter
// significare tanto «tutto ok» quanto «non è mai partito niente».
// =============================================================================

/** Genitori dei bambini di uno o più GRADI (school_type della sezione) nella sede. */
export async function genitoriDiGrado(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  gradi: NewsGrado[] | null | undefined,
): Promise<string[]> {
  if (!scuolaId || !gradi || gradi.length === 0) return []
  const { data: sez, error: sezErr } = await supabase
    .from('sections')
    .select('id')
    .eq('scuola_id', scuolaId)
    .in('school_type', gradi)
  if (sezErr || !sez || sez.length === 0) return []
  const sezIds = (sez as { id: string }[]).map((s) => s.id)
  const { data: al, error } = await supabase
    .from('alunni')
    .select('id')
    .eq('scuola_id', scuolaId)
    .in('section_id', sezIds)
  if (error || !al) return []
  return genitoriDiAlunni(supabase, (al as { id: string }[]).map((a) => a.id))
}

export interface PostDaNotificare {
  id: string
  titolo: string
  scuola_id: string | null
  target_scope: NewsScope
  target_gradi: NewsGrado[] | null
  target_classes: string[] | null
  contenuto_testo: string | null
  invia_notifica: boolean
  notifica_inviata_il: string | null
}

/**
 * Notifica ai genitori destinatari la pubblicazione di un post. Idempotente:
 * non ri-notifica se `notifica_inviata_il` è già valorizzato. Rispetta il flag
 * `invia_notifica`. Best-effort (non lancia): l'esito si legge nei log.
 */
export async function notificaNewsPubblicata(supabase: SupabaseClient, post: PostDaNotificare): Promise<void> {
  if (post.notifica_inviata_il) return // già notificata: idempotenza
  if (!post.invia_notifica) return // notifiche disattivate per questo post

  let destinatari: string[] = []
  if (post.target_scope === 'classi') {
    destinatari = await genitoriDiClassi(supabase, post.scuola_id, post.target_classes ?? [])
  } else if (post.target_scope === 'grado') {
    destinatari = await genitoriDiGrado(supabase, post.scuola_id, post.target_gradi)
  } else {
    destinatari = await genitoriDiScuola(supabase, post.scuola_id)
  }

  const corpo = post.contenuto_testo && post.contenuto_testo.length > 140
    ? `${post.contenuto_testo.slice(0, 140)}…`
    : (post.contenuto_testo ?? null)

  await notificaEvento(supabase, {
    tipo: 'news',
    scuolaId: post.scuola_id,
    utenteIds: destinatari,
    titolo: `News: ${post.titolo}`,
    corpo,
    link: `/parent/news/${post.id}`,
    entitaTipo: 'news',
    entitaId: post.id,
    bufferMin: 10,
    debounce: true,
  })

  // Marca la notifica come partita (guardia idempotente contro doppi tick del cron).
  const { error } = await supabase
    .from('news_posts')
    .update({ notifica_inviata_il: new Date().toISOString() })
    .eq('id', post.id)
    .is('notifica_inviata_il', null)
  if (error) {
    // La notifica è (forse) partita ma la marca no: al prossimo tick si rischia un doppione.
    // `error`: è un dato perso sul canale critico, non un dettaglio.
    logErrore({ operazione: 'news/notifica:marca', stato: 500, evento: 'news' }, error)
    return
  }

  logEvento('news', 'info', {
    operazione: 'notifica-pubblicazione',
    esito: 'inviata',
    post_id: post.id,
    destinatari: destinatari.length,
  })
}
