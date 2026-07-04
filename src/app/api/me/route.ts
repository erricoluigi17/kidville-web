import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { areaForRole } from '@/lib/auth/active-role'
import type { Profilo } from '@/lib/auth/profili'
import { parseQuery } from '@/lib/validation/http'

// GET /api/me — profilo dell'utente corrente (gated, service-role server-side).
// Sostituisce le letture anon dirette di `utenti` (gallery docente, modulistica
// genitore). Non espone mai segreti (password_segreta/password).
//
// M4B.1: espone anche `profili: [{ ruolo, area }]` (doppio profilo da `utenti`
// + ponte `parents.auth_user_id`) e garantisce `role` al top-level (contratto
// retro-compatibile). Un genitore reale non ha una riga in `utenti` (vedi
// src/lib/auth/profili.ts) e non deve prendere 401.
//
// M9 (dedup M4B): la route faceva 6-8 round-trip (resolveIdentity: getUser +
// utenti + parents; poi utenti + parents di nuovo; getSessionProfili: getUser +
// utenti + parents). Ora sul percorso sessione: 1 getUser + 2 query PARALLELE
// (utenti per id=auth.uid, parents per auth_user_id=auth.uid) e i profili sono
// derivati dalle stesse due righe (stessa logica di getProfiliForAuthUid).
// Contratto e semantica dei 401 invariati.
const SECRETS = ['password_segreta', 'password', 'auth_user_id']

const getQuerySchema = z.object({}) // nessun parametro in ingresso

export async function GET(request: Request) {
  // 1) Sessione reale (stessa semantica di resolveIdentity: header ignorato se
  //    esiste una sessione). try/catch: cookies() lancia fuori da un contesto
  //    di richiesta o nei unit test senza mock.
  let authUid: string | null = null
  try {
    const sessionClient = await createClient()
    const { data } = await sessionClient.auth.getUser()
    authUid = data?.user?.id ?? null
  } catch {
    authUid = null
  }

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  let data: Record<string, unknown> | null = null
  let daParents = false
  let profili: Profilo[] = []

  if (authUid) {
    // Percorso sessione: 2 query parallele, niente lookup ripetuti.
    const [{ data: staff }, { data: parent }] = await Promise.all([
      supabase.from('utenti').select('*').eq('id', authUid).maybeSingle(),
      supabase.from('parents').select('*').eq('auth_user_id', authUid).maybeSingle(),
    ])
    data = (staff ?? parent) as Record<string, unknown> | null
    daParents = !staff && !!parent

    // Profili derivati dalle stesse righe (logica di getProfiliForAuthUid:
    // ruolo staff + genitore dal ponte, dedup sul ruolo genitore).
    const ruoloStaff = (staff?.role || staff?.ruolo) as Profilo['ruolo'] | undefined
    if (ruoloStaff) profili.push({ ruolo: ruoloStaff, area: areaForRole(ruoloStaff) })
    if (parent && !profili.some((p) => p.ruolo === 'genitore')) {
      profili.push({ ruolo: 'genitore', area: 'parent' })
    }
  } else {
    // 2) Fallback legacy (header/query), salvo disabilitazione esplicita —
    //    stessa semantica di resolveIdentity, lookup per id applicativo.
    const headerId = process.env.ALLOW_HEADER_IDENTITY !== 'false' ? getRequestUserId(request) : null
    if (!headerId) {
      return NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 })
    }
    console.warn('[auth][header-fallback] identità da header/query (nessuna sessione) path=/api/me')

    const { data: staff } = await supabase.from('utenti').select('*').eq('id', headerId).maybeSingle()
    data = staff as Record<string, unknown> | null
    if (!data) {
      const { data: parent } = await supabase.from('parents').select('*').eq('id', headerId).maybeSingle()
      if (parent) {
        data = parent as Record<string, unknown>
        daParents = true
      }
    }
  }

  if (!data) {
    return NextResponse.json({ error: 'Utente non trovato' }, { status: 401 })
  }

  const safe = { ...data }
  for (const k of SECRETS) delete safe[k]

  // `role` sempre presente al top-level (le righe `parents` non hanno ruolo).
  const role = (safe.role || safe.ruolo || (daParents ? 'genitore' : null)) as string | null

  // Percorso legacy senza sessione: profilo singolo dal ruolo della riga.
  if (!profili.length && role) {
    profili = [{ ruolo: role as Profilo['ruolo'], area: areaForRole(role) }]
  }

  return NextResponse.json({ ...safe, role, profili })
}
