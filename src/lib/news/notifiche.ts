import type { SupabaseClient } from '@supabase/supabase-js'
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato'
import { sediReali } from '@/lib/scuole/reali'
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

/**
 * Genitori dei bambini di uno o più GRADI (school_type della sezione) nella sede.
 *
 * ⚠️ ERA IL TERZO RAMO, ED ERA L'UNICO RIMASTO CIECO (corretto il 2026-08-13).
 * `destinatariDiSede`, venti righe più sotto, smista su tre strade: `classi` →
 * `genitoriDiClassi`, `scuola` → `genitoriDiScuola`, `grado` → questa. Il
 * 2026-08-12 le prime due hanno preso il filtro di stato e questa no, quindi una
 * News «per il nido» continuava ad arrivare alla famiglia di un bambino
 * ritirato: «il modo più visibile di dire a una famiglia che il sistema non si è
 * accorto che se n'è andata», scritto nel file accanto mentre qui succedeva.
 *
 * E NON POTEVA ACCORGERSENE NESSUN LOCK: questa query filtra `.in('section_id',
 * …)`, quindi per `elenchi-operativi-solo-iscritti` era esente per costruzione.
 * L'esenzione «per sezione» copre la strada dell'ARCHIVIAZIONE — che la classe
 * la sgancia — non quella della TENDINA della scheda alunno, che porta lo `stato`
 * a `'ritirato'` lasciando il bambino agganciato alla sezione. Le due strade
 * esistono entrambe oggi: da qui il filtro, anche dove «la sezione c'è già».
 *
 * I due rami di errore LOGGANO: PostgREST non lancia, quindi una lettura rotta
 * usciva da qui come `[]` e la news finiva sul ramo «nessun-destinatario» —
 * indistinguibile, nei log, da un grado senza bambini.
 */
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
  if (sezErr) {
    logEvento('notifica', 'error', {
      operazione: 'news/notifiche:genitoriDiGrado',
      esito: 'sezioni-non-lette',
      sede_id: scuolaId,
      n: gradi.length,
    }, sezErr)
    return []
  }
  if (!sez || sez.length === 0) return []
  const sezIds = (sez as { id: string }[]).map((s) => s.id)
  const { data: al, error } = await supabase
    .from('alunni')
    .select('id')
    .eq('scuola_id', scuolaId)
    .in('section_id', sezIds)
    .in('stato', [...STATI_CON_CANALE_FAMIGLIA])
  if (error) {
    logEvento('notifica', 'error', {
      operazione: 'news/notifiche:genitoriDiGrado',
      esito: 'alunni-non-letti',
      sede_id: scuolaId,
    }, error)
    return []
  }
  if (!al) return []
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

const OPERAZIONE = 'notifica-pubblicazione'

/** Il sottoinsieme di un post che basta a sapere CHI ne è destinatario. */
export type PostConTarget = Pick<PostDaNotificare, 'scuola_id' | 'target_scope' | 'target_gradi' | 'target_classes'>

/** Destinatari di UNA sede, secondo lo scope del post. */
async function destinatariDiSede(
  supabase: SupabaseClient,
  post: PostConTarget,
  scuolaId: string,
): Promise<string[]> {
  if (post.target_scope === 'classi') {
    return genitoriDiClassi(supabase, scuolaId, post.target_classes ?? [], {
      operazione: 'news/notifiche:genitoriDiClassi',
    })
  }
  if (post.target_scope === 'grado') {
    return genitoriDiGrado(supabase, scuolaId, post.target_gradi)
  }
  return genitoriDiScuola(supabase, scuolaId, { operazione: 'news/notifiche:genitoriDiScuola' })
}

/**
 * DESTINATARI DI UN POST — punto unico, per la notifica e per il denominatore
 * delle statistiche di lettura.
 *
 * `scuola_id === null` significa «TUTTE le sedi»: è una funzione esplicita e
 * riservata alla Direzione (news/route.ts:113-121). I risolutori di destinatari
 * leggono però lo stesso NULL con il significato OPPOSTO — «sede sconosciuta,
 * nega» — quindi una news per tutti i plessi usciva con ZERO destinatari. Qui il
 * caso globale si ESPANDE sull'elenco delle sedi REALI (la finta E2E la esclude
 * `sediReali`), sede per sede, e i destinatari si uniscono.
 *
 * `sediRisolte: false` distingue «non so quali sedi esistono» (lettura fallita)
 * da «lo so, e i destinatari sono zero»: sono due esiti con conseguenze diverse
 * per chi chiama.
 */
export async function destinatariNews(
  supabase: SupabaseClient,
  post: PostConTarget,
): Promise<{ destinatari: string[]; sediRisolte: boolean }> {
  if (post.scuola_id) {
    return { destinatari: await destinatariDiSede(supabase, post, post.scuola_id), sediRisolte: true }
  }
  const { reali, error } = await sediReali(supabase, 'news/notifiche:sediReali')
  if (error || reali.length === 0) return { destinatari: [], sediRisolte: false }
  const uniti = new Set<string>()
  for (const sede of reali) {
    for (const id of await destinatariDiSede(supabase, post, sede.id)) uniti.add(id)
  }
  return { destinatari: [...uniti], sediRisolte: true }
}

/**
 * Notifica ai genitori destinatari la pubblicazione di un post. Idempotente:
 * non ri-notifica se `notifica_inviata_il` è già valorizzato. Rispetta il flag
 * `invia_notifica`. Best-effort (non lancia): l'esito si legge nei log.
 *
 * `post.scuola_id === null` significa «TUTTE le sedi» — è una funzione esplicita
 * e riservata alla Direzione (news/route.ts:113-121). I risolutori di destinatari
 * leggono però lo stesso NULL con il significato OPPOSTO, «sede sconosciuta,
 * nega»: fino al 2026-07-31 una news per tutti i plessi usciva con ZERO
 * destinatari, `notificaEvento` taceva sulla lista vuota e `notifica_inviata_il`
 * veniva scritto lo stesso — la guardia di idempotenza chiudeva la porta per
 * sempre. Da qui in poi «tutte le sedi» si espande ESPLICITAMENTE sull'elenco
 * delle sedi REALI (la finta E2E esclusa da `sediReali`), sede per sede, e i
 * destinatari si uniscono.
 */
export async function notificaNewsPubblicata(supabase: SupabaseClient, post: PostDaNotificare): Promise<void> {
  if (post.notifica_inviata_il) return // già notificata: idempotenza
  if (!post.invia_notifica) return // notifiche disattivate per questo post

  const { destinatari, sediRisolte } = await destinatariNews(supabase, post)
  if (!sediRisolte) {
    // Senza l'elenco delle sedi non si sa a chi mandarla: si esce SENZA marcare,
    // così il prossimo tentativo (ri-pubblicazione, tick del cron) la ritrova.
    logEvento('news', 'error', {
      operazione: OPERAZIONE, esito: 'sedi-non-risolte', post_id: post.id,
    })
    return
  }

  if (destinatari.length === 0) {
    // NON si marca `notifica_inviata_il`: marcare una notifica mai partita è
    // l'unica mossa irreversibile di questa funzione. E si logga, perché
    // «inviata a tutti» e «inviata a nessuno» erano indistinguibili.
    logEvento('news', 'warn', {
      operazione: OPERAZIONE, esito: 'nessun-destinatario', post_id: post.id,
      tipo: post.target_scope, sede_id: post.scuola_id ?? null,
    })
    return
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
    operazione: OPERAZIONE,
    esito: 'inviata',
    post_id: post.id,
    destinatari: destinatari.length,
    sede_id: post.scuola_id ?? null,
  })
}
