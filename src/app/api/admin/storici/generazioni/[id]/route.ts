import { logEvento } from '@/lib/logging/logger'
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { espandiCategorie } from '@/lib/storici/catalogo'
import { leggiGenerazione } from '@/lib/storici/generazioni'
import { rispostaErroreStorico } from '@/lib/storici/http'
export const GET = withRoute('admin/storici/generazioni/[id]:GET', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const p = parseData(zUuid, (await context.params).id)
  if ('response' in p) return p.response
  try {
    const job = await leggiGenerazione(await createAdminClient(), auth.user, p.data)
    return NextResponse.json({ id: job.id, stato: job.stato, completate: job.cursore, totale: espandiCategorie(job.richiesta.categorie).length, titolo: job.titolo, avvisi: job.avvisi, errore: job.errore, scadeIl: job.scade_il, formato: job.richiesta.formato }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/generazioni/[id]:GET') }
})
