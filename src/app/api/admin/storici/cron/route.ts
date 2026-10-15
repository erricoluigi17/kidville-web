import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { parseBody } from '@/lib/validation/http'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { riprendiGenerazioni, pulisciGenerazioniScadute } from '@/lib/storici/generazioni'
import { rispostaErroreStorico } from '@/lib/storici/http'
export const maxDuration = 300
const bodySchema = z.object({})
export const POST = withRoute('admin/storici/cron:POST', async (request: NextRequest) => {
  if (!segretoCronValido(request.headers.get('x-cron-secret'))) return NextResponse.json({ error: 'Non autorizzato', codice: 'CRON_NON_AUTORIZZATO' }, { status: 401 })
  const b = await parseBody(request, bodySchema)
  if ('response' in b) return b.response
  try {
    const db = await createAdminClient()
    const rimossi = await pulisciGenerazioniScadute(db)
    const ripresi = await riprendiGenerazioni(db)
    logEvento('cron', 'info', { operazione: 'storici/cron', esito: 'giro-completato', n: ripresi, n_rimosse: rimossi })
    return NextResponse.json({ ripresi, rimossi })
  } catch (error) { return rispostaErroreStorico(error, 'admin/storici/cron:POST') }
})
