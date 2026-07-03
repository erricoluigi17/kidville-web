import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity } from '@/lib/auth/require-staff'
import { areaDiRuolo, getSessionProfili, type Profilo } from '@/lib/auth/profili'
import { parseQuery } from '@/lib/validation/http'

// GET /api/me — profilo dell'utente corrente (gated, service-role server-side).
// Sostituisce le letture anon dirette di `utenti` (gallery docente, modulistica
// genitore). Non espone mai segreti (password_segreta/password).
//
// M4B.1: espone anche `profili: [{ ruolo, area }]` (doppio profilo da `utenti`
// + ponte `parents.auth_user_id`) e garantisce `role` al top-level (contratto
// retro-compatibile). Il gate legge l'identità con `resolveIdentity` e cerca la
// riga in `utenti` POI in `parents`: un genitore reale non ha una riga in
// `utenti` (vedi src/lib/auth/profili.ts) e non deve prendere 401.
const SECRETS = ['password_segreta', 'password', 'auth_user_id']

const getQuerySchema = z.object({}) // nessun parametro in ingresso

export async function GET(request: Request) {
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 })
  }

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  // Staff e genitori-demo stanno in `utenti`; i genitori reali in `parents`.
  let { data } = await supabase.from('utenti').select('*').eq('id', userId).maybeSingle()
  let daParents = false
  if (!data) {
    const { data: parent } = await supabase.from('parents').select('*').eq('id', userId).maybeSingle()
    if (parent) {
      data = parent
      daParents = true
    }
  }
  if (!data) {
    return NextResponse.json({ error: 'Utente non trovato' }, { status: 401 })
  }

  const safe = { ...(data as Record<string, unknown>) }
  for (const k of SECRETS) delete safe[k]

  // `role` sempre presente al top-level (le righe `parents` non hanno ruolo).
  const role = (safe.role || safe.ruolo || (daParents ? 'genitore' : null)) as string | null

  // Profili disponibili: dalla sessione (auth.uid → utenti + ponte parents);
  // sul percorso legacy senza sessione (header/query) resta il profilo singolo.
  const sessione = await getSessionProfili()
  let profili: Profilo[] = sessione?.profili ?? []
  if (!profili.length && role) {
    profili = [{ ruolo: role as Profilo['ruolo'], area: areaDiRuolo(role) }]
  }

  return NextResponse.json({ ...safe, role, profili })
}
