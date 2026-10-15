import { logEvento } from '@/lib/logging/logger'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { haUnRuolo } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { logScrittura } from '@/lib/audit/scrittura'
import { ErroreStorico, erroreQueryStorico } from '@/lib/storici/db'
import { conCacheStorico, rispostaErroreStorico } from '@/lib/storici/http'
import { contenutoIscrizione, personeIscrizione } from '@/lib/storici/iscrizioni-collegate'
import { preparaContestoStorico } from '@/lib/storici/scope'
import { utenteStaffStorico } from '@/lib/storici/permessi'
const querySchema = z.object({ scuolaId: zUuid, tipo: z.enum(['iscrizione', 'modulo', 'protocollo']), alunnoId: zUuid.optional(), offset: z.coerce.number().int().min(0).default(0) })
const bodySchema = querySchema.extend({ alunnoId: zUuid, entitaId: zUuid, indiceFiglio: z.number().int().min(0).nullable().default(null), adultiIndici: z.array(z.number().int().min(0)).max(30).default([]), versione: z.number().int().min(0).default(0) })
const TABELLE = { iscrizione: 'enrollment_submissions', modulo: 'form_submissions', protocollo: 'protocolli' } as const
export const GET = withRoute('admin/storici/collegamenti:GET', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  try {
    const db = await createAdminClient()
    if (!(await scuoleDiUtente(db, utenteStaffStorico(auth.user))).includes(q.data.scuolaId) || (q.data.tipo === 'protocollo' && !haUnRuolo(auth.user, ['admin', 'segreteria']))) throw new ErroreStorico(403, 'ACCESSO_NEGATO', 'Documenti non accessibili.')
    const tabella = TABELLE[q.data.tipo]
    const colonne = q.data.tipo === 'protocollo' ? 'id,anno,numero,oggetto,data_registrazione' : q.data.tipo === 'modulo' ? 'id,created_at,status,form_models(title)' : 'id,created_at,status,data'
    const { data, error } = await db.from(tabella).select(colonne).eq('scuola_id', q.data.scuolaId).order(q.data.tipo === 'protocollo' ? 'data_registrazione' : 'created_at', { ascending: false }).order('id').range(q.data.offset, q.data.offset + 199)
    if (error) erroreQueryStorico('documenti-collegabili', error)
    const fonti = (data ?? []) as unknown as Array<Record<string, unknown>>
    const pubbliche: Array<Record<string, unknown>> = q.data.tipo === 'iscrizione' ? fonti.map(({ data: contenuto, ...meta }) => ({ ...meta, ...personeIscrizione(contenuto) })) : fonti
    let collegamenti: unknown[] = []
    if (q.data.alunnoId) {
      await preparaContestoStorico(db, auth.user, { scuolaId: q.data.scuolaId, alunnoId: q.data.alunnoId, dal: '1900-01-01', al: '2099-12-31', categorie: ['anagrafica_scheda'], formato: 'pdf', raggruppamento: 'alunno' })
      const { data: associati, error: errAssociati } = await db.from('storici_collegamenti').select('id,entita_id,indice_figlio,adulti_indici,versione').eq('scuola_id', q.data.scuolaId).eq('alunno_id', q.data.alunnoId).eq('tipo', q.data.tipo).in('entita_id', pubbliche.map(f => f.id))
      if (errAssociati) erroreQueryStorico('collegamenti-esistenti', errAssociati)
      collegamenti = associati ?? []
    }
    return NextResponse.json({ data: pubbliche, collegamenti }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/collegamenti:GET') }
}))
export const POST = withRoute('admin/storici/collegamenti:POST', conCacheStorico(async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, bodySchema)
  if ('response' in b) return b.response
  try {
    const db = await createAdminClient()
    if (!(await scuoleDiUtente(db, utenteStaffStorico(auth.user))).includes(b.data.scuolaId) || (b.data.tipo === 'protocollo' && !haUnRuolo(auth.user, ['admin', 'segreteria']))) throw new ErroreStorico(403, 'ACCESSO_NEGATO', 'Documenti non accessibili.')
    const { data: fonte, error: errFonte } = await db.from(TABELLE[b.data.tipo]).select(b.data.tipo === 'iscrizione' ? 'id,data' : 'id').eq('id', b.data.entitaId).eq('scuola_id', b.data.scuolaId).maybeSingle()
    if (errFonte) erroreQueryStorico('fonte-collegamento', errFonte)
    if (!fonte) throw new ErroreStorico(404, 'DOCUMENTO_NON_TROVATO', 'Documento non trovato nella sede scelta.')
    await preparaContestoStorico(db, auth.user, { scuolaId: b.data.scuolaId, alunnoId: b.data.alunnoId, dal: '1900-01-01', al: '2099-12-31', categorie: ['anagrafica_scheda'], formato: 'pdf', raggruppamento: 'alunno' })
    const contenuto = b.data.tipo === 'iscrizione' ? contenutoIscrizione((fonte as unknown as { data: unknown }).data, b.data.indiceFiglio, b.data.adultiIndici) : null
    if (b.data.tipo === 'iscrizione' && !contenuto) throw new ErroreStorico(400, 'FIGLIO_NON_IDENTIFICATO', 'Scegli il figlio della domanda e gli adulti pertinenti prima di collegarla.')
    const { data, error } = await db.rpc('storici_collega_documento', { p_scuola: b.data.scuolaId, p_alunno: b.data.alunnoId, p_tipo: b.data.tipo, p_entita: b.data.entitaId, p_attore: auth.user.id, p_figlio: contenuto ? b.data.indiceFiglio : null, p_adulti: contenuto ? b.data.adultiIndici : [], p_impronta: contenuto?.impronta ?? null, p_versione: b.data.versione })
    if (error) erroreQueryStorico('crea-collegamento', error)
    await logScrittura(db, { attore: auth.user, scuolaId: b.data.scuolaId, entitaTipo: 'storico_collegamento', entitaId: data as string, azione: 'insert', valoreDopo: { alunno_id: b.data.alunnoId, tipo: b.data.tipo, entita_id: b.data.entitaId } })
    return NextResponse.json({ id: data })
  } catch (error) { logEvento('registro', 'info', { operazione: 'storici/richiesta', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/storici/collegamenti:POST') }
}))
