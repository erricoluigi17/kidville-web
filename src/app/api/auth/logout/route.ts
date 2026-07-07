import { NextResponse } from 'next/server'
import { ACTIVE_ROLE_COOKIE } from '@/lib/auth/active-role'

// POST /api/auth/logout — azzera i cookie server-side dell'identità applicativa.
// I cookie di sessione Supabase (sb-*) li rimuove il client con auth.signOut();
// qui si eliminano il ruolo attivo (kv-active-role) e lo scope sedi (sedi_attive),
// che sono httpOnly/server-managed e sopravviverebbero al signOut client.
// Nessun gate: è un'operazione di uscita, sempre sicura (non è un'escalation).

const COOKIE_SEDI = 'sedi_attive'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  const clear = { path: '/', maxAge: 0 as const }
  res.cookies.set(ACTIVE_ROLE_COOKIE, '', { httpOnly: true, sameSite: 'lax', ...clear })
  res.cookies.set(COOKIE_SEDI, '', { ...clear })
  return res
}
