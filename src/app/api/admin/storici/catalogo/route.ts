import { logEvento } from '@/lib/logging/logger'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { opzioniStorici } from '@/lib/storici/generazioni'
import { rispostaErroreStorico } from '@/lib/storici/http'
const querySchema = z.object({ scuolaId: zUuid })
export const GET = withRoute('admin/storici/catalogo:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  try { return NextResponse.json(await opzioniStorici(await createAdminClient(), auth.user, q.data.scuolaId), { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/catalogo:GET') }
})
