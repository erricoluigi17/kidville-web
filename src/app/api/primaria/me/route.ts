import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveIdentity, loadAppUser } from '@/lib/auth/require-staff'
import { loadGradoContext } from '@/lib/auth/require-grado'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (resolveIdentity), non dall'handler.
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/primaria/me
// Riepilogo del contesto docente: gradi + funzioni abilitate (per gating UI).
// Identità session-first (resolveIdentity); header/query solo come fallback legacy.
export const GET = withRoute('primaria/me:GET', async (request: NextRequest) => {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const ctx = await loadGradoContext(userId)
    if (!ctx) return NextResponse.json({ error: 'Utente non trovato' }, { status: 401 })

    const appUser = await loadAppUser(userId)
    const isDirigente = appUser?.role === 'admin' || appUser?.role === 'coordinator'

    return NextResponse.json({
      success: true,
      data: {
        userId: ctx.userId,
        gradi: ctx.gradi,
        ruolo: appUser?.role ?? null,
        isDirigente,
        funzioni: ctx.gradi.reduce<Record<string, Record<string, boolean>>>((acc, g) => {
          acc[g] = ctx.matrice?.[g] ?? {}
          return acc
        }, {}),
      },
    })
  } catch (err) {
    logErrore({ operazione: 'primaria/me:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
