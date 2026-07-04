import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppRole } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'

/**
 * RBAC ristretto per il Fascicolo personale (PEI/PDP/documenti sanitari).
 *
 * Accesso ammesso a:
 *  - Dirigenza/Segreteria: ruoli 'admin' / 'coordinator' / 'segreteria', MA solo
 *    per gli alunni del proprio plesso (Direzione: dei plessi associati). Mai cross-tenant.
 *  - Docenti CONTITOLARI della sezione dell'alunno (utenti_sezioni / utenti_sezioni_materie).
 * Vietato ai docenti di altre classi e a chiunque altro.
 *
 * Enforcement APPLICATIVO (RLS non attiva — vedi require-staff). L'accesso ai
 * file passa sempre da queste API (service_role) con check qui sotto.
 */

export interface AccessoFascicolo {
  consentito: boolean
  ruolo: string | null
  motivo: 'staff' | 'contitolare' | 'negato' | 'no-section' | 'cross-tenant'
}

export async function puoAccedereFascicolo(
  supabase: SupabaseClient,
  utenteId: string,
  alunnoId: string
): Promise<AccessoFascicolo> {
  // Ruolo + plesso dell'utente.
  const { data: u } = await supabase
    .from('utenti')
    .select('id, ruolo, role, scuola_id')
    .eq('id', utenteId)
    .maybeSingle()
  const ruolo = (u?.role || u?.ruolo) as string | null
  if (!u) return { consentito: false, ruolo: null, motivo: 'negato' }

  // Sezione + plesso dell'alunno.
  const { data: alunno } = await supabase
    .from('alunni')
    .select('section_id, scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()

  // Dirigenza / Segreteria: ammessa solo entro il proprio/i plesso/i (no cross-tenant).
  if (ruolo === 'admin' || ruolo === 'coordinator' || ruolo === 'segreteria') {
    if (!alunno) return { consentito: false, ruolo, motivo: 'negato' }
    const plessi = await scuoleDiUtente(supabase, {
      id: u.id, role: ruolo as AppRole, scuola_id: u.scuola_id,
    })
    if (alunno.scuola_id && plessi.includes(alunno.scuola_id as string)) {
      return { consentito: true, ruolo, motivo: 'staff' }
    }
    return { consentito: false, ruolo, motivo: 'cross-tenant' }
  }

  const sectionId = alunno?.section_id
  if (!sectionId) return { consentito: false, ruolo, motivo: 'no-section' }

  // Contitolare: assegnazione alla sezione (per materia o diretta).
  const [{ data: usm }, { data: us }] = await Promise.all([
    supabase.from('utenti_sezioni_materie').select('utente_id').eq('utente_id', utenteId).eq('section_id', sectionId).limit(1),
    supabase.from('utenti_sezioni').select('utente_id').eq('utente_id', utenteId).eq('section_id', sectionId).limit(1),
  ])
  if ((usm && usm.length > 0) || (us && us.length > 0)) {
    return { consentito: true, ruolo, motivo: 'contitolare' }
  }

  return { consentito: false, ruolo, motivo: 'negato' }
}

export type AzioneFascicolo = 'list' | 'view' | 'download' | 'upload' | 'delete'

/** Registra un accesso al fascicolo nel log immodificabile. Best-effort. */
export async function logAccessoFascicolo(
  supabase: SupabaseClient,
  opts: {
    alunnoId: string
    utenteId: string | null
    azione: AzioneFascicolo
    documentoId?: string | null
    finalita?: string | null
    request?: Request
  }
): Promise<void> {
  try {
    const ip = opts.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
    const userAgent = opts.request?.headers.get('user-agent') || null
    await supabase.from('fascicolo_accessi_audit').insert({
      alunno_id: opts.alunnoId,
      documento_id: opts.documentoId ?? null,
      utente_id: opts.utenteId,
      azione: opts.azione,
      finalita: opts.finalita ?? null,
      ip,
      user_agent: userAgent,
    })
  } catch (e) {
    console.error('logAccessoFascicolo:', e)
  }
}
