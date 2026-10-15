import { logEvento } from '@/lib/logging/logger'
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody } from '@/lib/validation/http'
import { CATALOGO_STORICI, espandiCategorie, richiestaStoricoSchema } from '@/lib/storici/catalogo'
import { preparaContestoStorico } from '@/lib/storici/scope'
import { conCacheStorico, rispostaErroreStorico } from '@/lib/storici/http'
export const POST = withRoute('admin/storici/anteprima:POST', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, richiestaStoricoSchema)
  if ('response' in b) return b.response
  try {
    const ctx = await preparaContestoStorico(await createAdminClient(), auth.user, b.data)
    const ids = espandiCategorie(b.data.categorie)
    return NextResponse.json({ titolo: ctx.titolo, scuolaNome: ctx.scuolaNome, alunni: ctx.alunni.length, avvisi: ctx.avvisi, sezioni: CATALOGO_STORICI.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, titolo: c.titolo })) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/anteprima:POST') }
}))
