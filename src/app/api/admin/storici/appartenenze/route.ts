import { logEvento } from '@/lib/logging/logger'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { logScrittura } from '@/lib/audit/scrittura'
import { ErroreStorico, erroreQueryStorico, leggiTutte } from '@/lib/storici/db'
import { conCacheStorico, rispostaErroreStorico } from '@/lib/storici/http'
import { utenteStaffStorico } from '@/lib/storici/permessi'
const querySchema = z.object({ scuolaId: zUuid, alunnoId: zUuid })
const bodySchema = querySchema.extend({ sectionId: zUuid, dal: zDataYMD, al: zDataYMD.nullable() }).refine(v => !v.al || v.dal < v.al, 'La data finale deve essere successiva a quella iniziale')
const deleteSchema = z.object({ scuolaId: zUuid, id: zUuid, dal: zDataYMD, al: zDataYMD.nullable() })
export const GET = withRoute('admin/storici/appartenenze:GET', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  try {
    const db = await createAdminClient()
    const sedi = await scuoleDiUtente(db, utenteStaffStorico(auth.user))
    if (!sedi.includes(q.data.scuolaId)) throw new ErroreStorico(403, 'SEDE_NON_AUTORIZZATA', 'Sede non accessibile.')
    const data = await leggiTutte((dal, al) => db.from('alunni_classi_storico').select('id,section_id,dal,al,fonte,creato_il').eq('scuola_id', q.data.scuolaId).eq('alunno_id', q.data.alunnoId).order('dal').order('id').range(dal, al), 'elenco-appartenenze')
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/appartenenze:GET') }
}))
export const POST = withRoute('admin/storici/appartenenze:POST', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, bodySchema)
  if ('response' in b) return b.response
  try {
    const db = await createAdminClient()
    const sedi = await scuoleDiUtente(db, utenteStaffStorico(auth.user))
    if (!sedi.includes(b.data.scuolaId)) throw new ErroreStorico(403, 'SEDE_NON_AUTORIZZATA', 'Sede non accessibile.')
    const { data, error } = await db.rpc('storici_salva_appartenenza', { p_alunno: b.data.alunnoId, p_scuola: b.data.scuolaId, p_sezione: b.data.sectionId, p_dal: b.data.dal, p_al: b.data.al, p_attore: auth.user.id })
    if (error) {
      if (error.code === '23P01') throw new ErroreStorico(409, 'PERIODO_SOVRAPPOSTO', 'Il periodo si sovrappone a un’altra classe. Verifica le appartenenze registrate.')
      erroreQueryStorico('salva-appartenenza', error)
    }
    await logScrittura(db, { attore: auth.user, scuolaId: b.data.scuolaId, sectionId: b.data.sectionId, entitaTipo: 'appartenenza_storica', entitaId: data, azione: 'insert', valoreDopo: b.data })
    return NextResponse.json({ id: data })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/appartenenze:POST') }
}))
export const DELETE = withRoute('admin/storici/appartenenze:DELETE', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, deleteSchema)
  if ('response' in b) return b.response
  try {
    const db = await createAdminClient()
    if (!(await scuoleDiUtente(db, utenteStaffStorico(auth.user))).includes(b.data.scuolaId)) throw new ErroreStorico(403, 'SEDE_NON_AUTORIZZATA', 'Sede non accessibile.')
    let cancellazione = db.from('alunni_classi_storico').delete().eq('id', b.data.id).eq('scuola_id', b.data.scuolaId).eq('dal', b.data.dal)
    cancellazione = b.data.al === null ? cancellazione.is('al', null) : cancellazione.eq('al', b.data.al)
    const { data, error } = await cancellazione.select('id,alunno_id,section_id,dal,al').maybeSingle()
    if (error) erroreQueryStorico('rimuovi-appartenenza', error)
    if (!data) throw new ErroreStorico(409, 'APPARTENENZA_MODIFICATA', 'Appartenenza cambiata o già rimossa. Ricarica i periodi prima di correggerla.')
    await logScrittura(db, { attore: auth.user, scuolaId: b.data.scuolaId, sectionId: data.section_id, entitaTipo: 'appartenenza_storica', entitaId: data.id, azione: 'delete', valorePrima: data })
    return NextResponse.json({ success: true })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/appartenenze:DELETE') }
}))
