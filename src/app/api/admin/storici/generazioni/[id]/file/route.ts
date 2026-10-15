import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { leggiGenerazione } from '@/lib/storici/generazioni'
import { BUCKET_STORICI } from '@/lib/storici/tipi'
import { ErroreStorico, erroreQueryStorico } from '@/lib/storici/db'
import { conCacheStorico, rispostaErroreStorico } from '@/lib/storici/http'
export const GET = withRoute('admin/storici/generazioni/[id]/file:GET', conCacheStorico(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const p = parseData(zUuid, (await context.params).id)
  if ('response' in p) return p.response
  try {
    const db = await createAdminClient()
    const job = await leggiGenerazione(db, auth.user, p.data)
    if (!['completato', 'parziale'].includes(job.stato) || !job.file_path) throw new ErroreStorico(409, 'FILE_NON_PRONTO', 'Il file non è ancora pronto.')
    if (job.file_path !== `${job.scuola_id}/${job.id}/storico.${job.richiesta.formato}`) throw new ErroreStorico(403, 'FILE_NON_AUTORIZZATO', 'File non accessibile.')
    const { data, error } = await db.storage.from(BUCKET_STORICI).download(job.file_path)
    if (error || !data) erroreQueryStorico('download', error ?? new Error('File mancante'))
    logEvento('registro', 'info', { operazione: 'storici/download', esito: 'file-consegnato', entita_id: job.id, byte: data.size })
    return new NextResponse(new Uint8Array(await data.arrayBuffer()), { headers: { 'Content-Type': job.richiesta.formato === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `inline; filename="storico-${job.richiesta.dal}-${job.richiesta.al}.${job.richiesta.formato}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch (error) { return rispostaErroreStorico(error, 'admin/storici/generazioni/[id]/file:GET') }
}))
