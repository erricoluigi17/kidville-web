import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'

/**
 * GET /api/admin/search?q=  — ricerca globale del cockpit (M7.1).
 *
 * Riservata allo staff (requireStaff) e scoped ai plessi dell'utente
 * (scuoleDiUtente): 4 query parallele ilike (limit 5) su alunni, utenti
 * (solo staff: schema legacy con doppia colonna role/ruolo), sections e
 * form_models (registro globale, senza plesso). Ogni gruppo restituisce
 * item uniformi { id, label, sub, href } pronti per il dropdown della TopBar.
 */

const getQuerySchema = z.object({
  q: z.string().trim().min(2, 'Inserisci almeno 2 caratteri'),
})

export interface SearchItem {
  id: string
  label: string
  sub: string
  href: string
}

export interface SearchGroups {
  alunni: SearchItem[]
  utenti: SearchItem[]
  sezioni: SearchItem[]
  moduli: SearchItem[]
}

const GRUPPI_VUOTI: SearchGroups = { alunni: [], utenti: [], sezioni: [], moduli: [] }

// Ruoli staff ammessi nel gruppo "utenti": esclude i genitori legacy presenti
// in `utenti`. Va filtrato su ENTRAMBE le colonne (role E ruolo): righe storiche
// hanno valorizzata solo una delle due.
const STAFF_ROLES = 'admin,coordinator,segreteria,educator,cuoca'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Direzione',
  coordinator: 'Coordinamento',
  segreteria: 'Segreteria',
  educator: 'Docente',
  cuoca: 'Cucina',
}

/**
 * Neutralizza i metacaratteri di ilike (%/_) e della sintassi or() di
 * PostgREST (virgole/parentesi), che altrimenti romperebbero il filtro.
 */
function sanitizeTerm(q: string): string {
  return q.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function GET(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const term = sanitizeTerm(q.data.q)
  if (term.length < 2) {
    return NextResponse.json({ success: true, data: GRUPPI_VUOTI })
  }

  const supabase = await createAdminClient()
  const plessi = await scuoleDiUtente(supabase, auth.user)
  if (plessi.length === 0) {
    return NextResponse.json({ success: true, data: GRUPPI_VUOTI })
  }

  const like = `%${term}%`
  const [alunniRes, utentiRes, sezioniRes, moduliRes] = await Promise.all([
    supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, codice_fiscale')
      .in('scuola_id', plessi)
      .or(`nome.ilike.${like},cognome.ilike.${like},codice_fiscale.ilike.${like}`)
      .limit(5),
    supabase
      .from('utenti')
      .select('id, nome, cognome, role, ruolo')
      .in('scuola_id', plessi)
      .or(`role.in.(${STAFF_ROLES}),ruolo.in.(${STAFF_ROLES})`)
      .or(`nome.ilike.${like},cognome.ilike.${like}`)
      .limit(5),
    supabase
      .from('sections')
      .select('id, name, school_type')
      .in('scuola_id', plessi)
      .ilike('name', like)
      .limit(5),
    supabase
      .from('form_models')
      .select('id, title, is_active')
      .ilike('title', like)
      .limit(5),
  ])

  // Degrado graceful: un errore su una query produce un gruppo vuoto,
  // non un 500 (il dropdown mostra il resto).
  const data: SearchGroups = {
    alunni: (alunniRes.data ?? []).map((a) => ({
      id: a.id as string,
      label: `${a.nome ?? ''} ${a.cognome ?? ''}`.trim() || 'Alunno',
      sub: (a.classe_sezione as string | null) || 'Alunno',
      href: '/admin/students',
    })),
    utenti: (utentiRes.data ?? []).map((u) => ({
      id: u.id as string,
      label: `${u.nome ?? ''} ${u.cognome ?? ''}`.trim() || 'Staff',
      sub: ROLE_LABEL[(u.role ?? u.ruolo) as string] ?? 'Staff',
      href: '/admin/staff',
    })),
    sezioni: (sezioniRes.data ?? []).map((s) => ({
      id: s.id as string,
      label: (s.name as string) || 'Classe',
      sub: (s.school_type as string | null) || 'Classe',
      href: '/admin/students',
    })),
    moduli: (moduliRes.data ?? []).map((m) => ({
      id: m.id as string,
      label: (m.title as string) || 'Modulo',
      sub: m.is_active ? 'Attivo' : 'Bozza',
      href: '/admin/modulistica',
    })),
  }

  return NextResponse.json({ success: true, data })
}
