import { after, NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { richiestaStoricoSchema } from '@/lib/storici/catalogo'
import { preparaContestoStorico } from '@/lib/storici/scope'
import { eseguiGenerazione } from '@/lib/storici/generazioni'
import { erroreQueryStorico } from '@/lib/storici/db'
import { conCacheStorico, rispostaErroreStorico } from '@/lib/storici/http'
import { firmaRuoliStorico, utenteStaffStorico } from '@/lib/storici/permessi'
export const maxDuration = 300
const getQuerySchema = z.object({})
export const GET = withRoute('admin/storici/generazioni:GET', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  try {
    const db = await createAdminClient()
    const sedi = await scuoleDiUtente(db, utenteStaffStorico(auth.user))
    if (!sedi.length) return NextResponse.json({ data: [] })
    const { data, error } = await db.from('storici_generazioni').select('id,stato,cursore,richiesta,creato_il,scade_il,titolo,avvisi,errore').eq('richiesto_da', auth.user.id).in('scuola_id', sedi).gt('scade_il', new Date().toISOString()).order('creato_il', { ascending: false }).limit(20)
    if (error) erroreQueryStorico('elenco-generazioni', error)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return rispostaErroreStorico(error, 'admin/storici/generazioni:GET') }
}))
export const POST = withRoute('admin/storici/generazioni:POST', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, richiestaStoricoSchema)
  if ('response' in b) return b.response
  try {
    const db = await createAdminClient()
    const ctx = await preparaContestoStorico(db, auth.user, b.data)
    const { data, error } = await db.from('storici_generazioni').insert({ scuola_id: b.data.scuolaId, richiesto_da: auth.user.id, ruolo_richiedente: firmaRuoliStorico(auth.user), alunni_ids: ctx.alunni.map(a => a.id), richiesta: b.data, titolo: ctx.titolo, avvisi: ctx.avvisi }).select('id,scade_il').single()
    if (error) erroreQueryStorico('crea-generazione', error)
    logEvento('registro', 'info', { operazione: 'storici/crea', esito: 'accodata', entita_id: data.id, n: b.data.categorie.length })
    after(() => eseguiGenerazione(db, data.id))
    return NextResponse.json({ id: data.id, stato: 'in_coda', scadeIl: data.scade_il }, { status: 202 })
  } catch (error) { return rispostaErroreStorico(error, 'admin/storici/generazioni:POST') }
}))
