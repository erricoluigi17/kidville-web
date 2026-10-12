import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { controllaVoceEliminabile } from '@/lib/pagamenti/voce-eliminabile'

// GET /api/pagamenti/[id]/eliminabile  (admin e segreteria, 2026-10-12)
// Il verdetto per la zona «Elimina voce» della finestra Modifica: le STESSE guardie della
// DELETE, così il browser non ricalcola niente. Positivo o negativo, il verdetto è un 200;
// 404 e 500 restano tali. Sola lettura: niente log del successo (non è un evento critico),
// i guasti li logga `rispostaGuastoDb`.
export const GET = withRoute('pagamenti/[id]/eliminabile:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
    const c = await controllaVoceEliminabile(supabase, id, { sedi, perSostituzione: false, operazione: 'pagamenti/[id]/eliminabile:GET' })
    if (c.ok) return NextResponse.json({ success: true, eliminabile: true, rate: c.rate, ticket: c.ticket })
    if ('guasto' in c) return c.guasto
    if (c.stato === 404) return NextResponse.json({ error: c.error }, { status: 404 })
    return NextResponse.json({ success: true, eliminabile: false, codice: c.codice, error: c.error })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]/eliminabile:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
