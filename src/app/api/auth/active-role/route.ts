import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveIdentity, loadAppUser, type AppRole } from '@/lib/auth/require-staff'
import { getSessionProfili } from '@/lib/auth/profili'
import { ACTIVE_ROLE_COOKIE, areaForRole, RUOLI_APP } from '@/lib/auth/active-role'
import { parseBody } from '@/lib/validation/http'

// POST /api/auth/active-role — setta SERVER-SIDE il cookie `kv-active-role`
// (M4B.2): il ruolo attivo di chi ha più profili. Il valore è validato contro
// i profili REALI dell'utente (sessione → utenti + ponte parents), quindi il
// cookie non è mai un'escalation: al massimo seleziona uno dei propri ruoli.
// Lo leggono le guardie d'area nei layout (M4B.4).

const postSchema = z.object({
  ruolo: z.enum(RUOLI_APP as [AppRole, ...AppRole[]]),
})

export async function POST(request: Request) {
  const { userId } = await resolveIdentity(request)
  if (!userId) {
    return NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 })
  }

  const body = await parseBody(request, postSchema)
  if ('response' in body) return body.response
  const { ruolo } = body.data

  // Il ruolo richiesto deve appartenere all'utente: dalla sessione (profili
  // reali); sul percorso legacy senza sessione, dal ruolo della riga `utenti`.
  const sessione = await getSessionProfili()
  let ammesso: boolean
  if (sessione) {
    ammesso = sessione.profili.some((p) => p.ruolo === ruolo)
  } else {
    const user = await loadAppUser(userId)
    ammesso = user?.role === ruolo
  }
  if (!ammesso) {
    return NextResponse.json({ error: 'Ruolo non disponibile per questo utente' }, { status: 403 })
  }

  const res = NextResponse.json({ ok: true, ruolo, area: areaForRole(ruolo) })
  res.cookies.set(ACTIVE_ROLE_COOKIE, ruolo, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    // Persistente oltre la singola tab: alla login successiva viene comunque
    // ri-settato (o ri-scelto, per chi ha più profili).
    maxAge: 60 * 60 * 24 * 180,
  })
  return res
}
