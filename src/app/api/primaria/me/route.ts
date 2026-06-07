import { NextRequest, NextResponse } from 'next/server'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { loadGradoContext } from '@/lib/auth/require-grado'

// GET /api/primaria/me?userId=
// Riepilogo del contesto docente: gradi + funzioni abilitate (per gating UI).
export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    const ctx = await loadGradoContext(userId)
    if (!ctx) return NextResponse.json({ error: 'Utente non trovato' }, { status: 401 })

    return NextResponse.json({
      success: true,
      data: {
        userId: ctx.userId,
        gradi: ctx.gradi,
        funzioni: ctx.gradi.reduce<Record<string, Record<string, boolean>>>((acc, g) => {
          acc[g] = ctx.matrice?.[g] ?? {}
          return acc
        }, {}),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
