import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from './require-staff'
import { sezioniDiUtente } from '@/lib/sezioni/docenti'

// =============================================================================
// Scoping per tenant (plesso) e per classe delle funzioni docente.
//
// Modello (decisione di prodotto, PRD §3/§12):
//  - educator   → SOLO le sezioni assegnate (utenti_sezioni), nel proprio plesso.
//  - segreteria → TUTTE le classi del PROPRIO plesso (utenti.scuola_id).
//  - coordinator→ come oggi: tutte le classi del proprio plesso.
//  - admin      → Direzione: tutti i plessi in utenti_scuole (fallback scuola_id).
// Mai cross-tenant. Da usare SEMPRE dopo `requireDocente` (che verifica il ruolo
// ma non lo scope). Le funzioni "assert*" tornano una NextResponse 4xx pronta
// oppure null se l'accesso è consentito.
// =============================================================================

/** Plessi (schools.id) su cui l'utente può operare. */
export async function scuoleDiUtente(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[]> {
  const own = user.scuola_id ? [user.scuola_id] : []
  // Solo la Direzione (admin) può essere multi-plesso via utenti_scuole.
  if (user.role !== 'admin') return own
  const { data } = await supabase
    .from('utenti_scuole')
    .select('scuola_id')
    .eq('utente_id', user.id)
  const extra = (data ?? []).map((r) => r.scuola_id as string)
  const set = new Set<string>([...own, ...extra])
  return [...set]
}

// =============================================================================
// Sedi attive (selezione del SedeSelector → cookie). La selezione è una
// preferenza UI: viene SEMPRE ri-validata server-side contro le sedi accessibili
// (scuoleDiUtente), quindi manometterla non dà accesso a plessi non propri.
// =============================================================================

const COOKIE_SEDI = 'sedi_attive'

function sediDalCookie(request: NextRequest): string[] {
  // Difensivo: in test l'oggetto request può non avere `.cookies`.
  const raw = request.cookies?.get?.(COOKIE_SEDI)?.value
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * LETTURE: insieme di plessi su cui filtrare (`scuola_id IN (...)`). Sono le sedi
 * selezionate nel SedeSelector (cookie) INTERSECATE con quelle accessibili. Cookie
 * assente o intersezione vuota → tutte le accessibili. Mai vuoto se l'utente ha
 * almeno un plesso.
 */
export async function resolveScuoleAttive(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[]> {
  const accessibili = await scuoleDiUtente(supabase, user)
  const selezionate = sediDalCookie(request)
  if (selezionate.length === 0) return accessibili
  const set = new Set(accessibili)
  const inter = selezionate.filter((id) => set.has(id))
  return inter.length > 0 ? inter : accessibili
}

/**
 * SCRITTURE (create/update che settano `scuola_id`): UNA sola sede. Ordine:
 * `preferita`/body.scuola_id se accessibile → l'unica sede attiva (cookie) →
 * l'unica sede accessibile → la sede primaria dell'utente. Se resta ambiguo
 * (più sedi accessibili, nessuna indicata) ritorna una NextResponse 400.
 */
export async function resolveScuolaScrittura(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  preferita?: string | null,
): Promise<{ scuolaId?: string; response?: NextResponse }> {
  const accessibili = await scuoleDiUtente(supabase, user)
  if (accessibili.length === 0) {
    return { response: NextResponse.json({ error: 'Nessun plesso associato all\'utente' }, { status: 403 }) }
  }
  const set = new Set(accessibili)
  if (preferita && set.has(preferita)) return { scuolaId: preferita }
  const attive = sediDalCookie(request).filter((id) => set.has(id))
  if (attive.length === 1) return { scuolaId: attive[0] }
  if (accessibili.length === 1) return { scuolaId: accessibili[0] }
  if (user.scuola_id && set.has(user.scuola_id)) return { scuolaId: user.scuola_id }
  return { response: NextResponse.json({ error: 'Specificare la sede (scuola_id) per questa operazione' }, { status: 400 }) }
}

/** True se l'utente ha visibilità su TUTTE le classi del proprio/i plesso/i. */
function vedeTutteLeClassi(user: AppUser): boolean {
  return user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
}

/**
 * Verifica che `sectionId` sia nello scope dell'utente. Per `educator` richiede
 * anche che la sezione sia assegnata (utenti_sezioni). 403/404 se fuori scope.
 */
export async function assertSezioneInScope(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!sectionId) {
    return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
  }
  const { data: section } = await supabase
    .from('sections')
    .select('id, scuola_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) {
    return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!section.scuola_id || !plessi.includes(section.scuola_id as string)) {
    return NextResponse.json({ error: 'Accesso negato: classe fuori dal tuo plesso' }, { status: 403 })
  }

  if (!vedeTutteLeClassi(user)) {
    const mie = await sezioniDiUtente(supabase, user.id)
    if (!mie.includes(sectionId)) {
      return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
    }
  }
  return null
}

/**
 * Verifica che una classe identificata per NOME (es. 'Girasoli') appartenga a un
 * plesso dell'utente. Per i moduli 0-6/trasversali keyed sul nome sezione: il
 * nome viene risolto SOLO entro i plessi consentiti, così non porta mai
 * cross-tenant (i nomi sono unici solo per scuola_id). 403 se fuori scope.
 */
export async function assertClasseNomeInScope(
  supabase: SupabaseClient,
  user: AppUser,
  classeNome: string | null | undefined,
): Promise<NextResponse | null> {
  if (!classeNome) {
    return NextResponse.json({ error: 'classe (nome) obbligatoria' }, { status: 400 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length === 0) {
    return NextResponse.json({ error: 'Nessun plesso associato' }, { status: 403 })
  }
  const { data } = await supabase
    .from('sections')
    .select('id')
    .eq('name', classeNome)
    .in('scuola_id', plessi)
    .limit(1)
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Classe fuori dal tuo plesso' }, { status: 403 })
  }
  return null
}

/**
 * Verifica batched che TUTTI gli alunni indicati appartengano alla sezione data.
 * Per gli handler che ricevono array di alunno_id dentro una sezione GIÀ asserita
 * con assertSezioneInScope (appello, note, destinatari registro, giudizi scrutinio):
 * impedisce scritture/notifiche verso alunni di altre sezioni/plessi. 403 se anche
 * un solo id è estraneo alla sezione.
 */
export async function assertAlunniInSezione(
  supabase: SupabaseClient,
  alunnoIds: (string | null | undefined)[],
  sectionId: string,
): Promise<NextResponse | null> {
  const ids = [...new Set(alunnoIds.filter(Boolean) as string[])]
  if (ids.length === 0) return null
  const { data } = await supabase
    .from('alunni')
    .select('id')
    .in('id', ids)
    .eq('section_id', sectionId)
  const inSezione = new Set((data ?? []).map((r) => r.id as string))
  const estranei = ids.filter((id) => !inSezione.has(id))
  if (estranei.length > 0) {
    return NextResponse.json(
      { error: `Alunni non appartenenti alla sezione: ${estranei.join(', ')}` },
      { status: 403 }
    )
  }
  return null
}

/**
 * Verifica che l'alunno (`alunnoId`) sia nello scope dell'utente, risolvendo la
 * sua sezione/plesso. Per gli endpoint che ricevono alunnoId e non sectionId
 * (valutazioni, prospetto, fascicolo, diario, ...). 403/404 se fuori scope.
 */
export async function assertAlunnoInScope(
  supabase: SupabaseClient,
  user: AppUser,
  alunnoId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!alunnoId) {
    return NextResponse.json({ error: 'alunnoId obbligatorio' }, { status: 400 })
  }
  const { data: alunno } = await supabase
    .from('alunni')
    .select('id, section_id, scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()
  if (!alunno) {
    return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!alunno.scuola_id || !plessi.includes(alunno.scuola_id as string)) {
    return NextResponse.json({ error: 'Accesso negato: alunno fuori dal tuo plesso' }, { status: 403 })
  }

  if (!vedeTutteLeClassi(user)) {
    const mie = await sezioniDiUtente(supabase, user.id)
    if (!alunno.section_id || !mie.includes(alunno.section_id as string)) {
      return NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 })
    }
  }
  return null
}
