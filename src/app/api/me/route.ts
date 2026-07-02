import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'

// GET /api/me — profilo dell'utente corrente (gated, service-role server-side).
// Sostituisce le letture anon dirette di `utenti` (gallery docente, modulistica
// genitore). Non espone mai segreti (password_segreta/password).
const SECRETS = ['password_segreta', 'password', 'auth_user_id']

const getQuerySchema = z.object({}) // nessun parametro in ingresso

export async function GET(request: Request) {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  // Staff e genitori-demo stanno in `utenti`; i genitori reali in `parents`.
  let { data } = await supabase.from('utenti').select('*').eq('id', auth.user.id).maybeSingle()
  if (!data) {
    const { data: parent } = await supabase.from('parents').select('*').eq('id', auth.user.id).maybeSingle()
    if (parent) data = parent
  }
  if (!data) {
    return NextResponse.json({ id: auth.user.id, role: auth.user.role })
  }

  const safe = { ...(data as Record<string, unknown>) }
  for (const k of SECRETS) delete safe[k]
  return NextResponse.json(safe)
}
