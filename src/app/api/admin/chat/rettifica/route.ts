import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit'
import { conservaRevisione } from '@/lib/storici/revisioni'
import { oggiRoma } from '@/lib/storici/retroattivita'
import { ErroreStorico, erroreQueryStorico } from '@/lib/storici/db'
import { rispostaErroreStorico } from '@/lib/storici/http'
const bodySchema = z.object({ id: zUuid, testo: z.string().trim().min(1).max(20000), versione: z.number().int().min(0) })
export const PATCH = withRoute('admin/chat/rettifica:PATCH', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, bodySchema)
  if ('response' in b) return b.response
  try {
    const db = await createAdminClient()
    const { data: meta, error: errMeta } = await db.from('chat_messages').select('id,thread_id,created_at').eq('id', b.data.id).maybeSingle()
    if (errMeta) erroreQueryStorico('messaggio-rettifica', errMeta)
    if (!meta) throw new ErroreStorico(404, 'MESSAGGIO_NON_TROVATO', 'Messaggio non trovato.')
    const { data: thread, error: errThread } = await db.from('chat_threads').select('student_id').eq('id', meta.thread_id).maybeSingle()
    if (errThread) erroreQueryStorico('thread-rettifica', errThread)
    if (!thread?.student_id) throw new ErroreStorico(403, 'CONVERSAZIONE_NON_ACCESSIBILE', 'Conversazione non attribuibile a un alunno autorizzato.')
    const scope = await assertAlunnoInScope(db, auth.user, thread.student_id)
    if (scope) return scope
    const { data: alunno, error: errAlunno } = await db.from('alunni').select('scuola_id,section_id').eq('id', thread.student_id).maybeSingle()
    if (errAlunno) erroreQueryStorico('sede-rettifica-chat', errAlunno)
    if (!alunno?.scuola_id) throw new ErroreStorico(403, 'SEDE_NON_ATTRIBUIBILE', 'Sede della conversazione non disponibile.')
    const { tracciato } = await registraAccessoVigilanza(db, { operatore: auth.user, azione: 'lettura', threadId: meta.thread_id, alunnoId: thread.student_id, scuolaId: alunno.scuola_id, nMessaggi: 1, request })
    if (!tracciato) throw new ErroreStorico(503, 'VIGILANZA_NON_TRACCIABILE', 'La lettura della conversazione non si è potuta registrare.')
    const { data: originale, error: errOriginale } = await db.from('chat_messages').select('id,thread_id,sender_id,content,attachment_url,attachment_type,created_at,rettifica_staff,rettifica_staff_il,rettifica_versione').eq('id', b.data.id).single()
    if (errOriginale) erroreQueryStorico('originale-chat', errOriginale)
    if (originale.rettifica_versione !== b.data.versione) throw new ErroreStorico(409, 'MESSAGGIO_MODIFICATO', 'La rettifica è stata modificata da un altro operatore. Riapri la conversazione.')
    await conservaRevisione(db, { attore: auth.user, scuolaId: alunno.scuola_id, alunnoId: thread.student_id, sectionId: alunno.section_id, modulo: 'chat', entitaId: originale.id, giornoCompetenza: oggiRoma(new Date(originale.created_at)), contenuto: originale })
    const ora = new Date().toISOString()
    const { data, error } = await db.from('chat_messages').update({ rettifica_staff: b.data.testo, rettifica_staff_il: ora, rettifica_staff_da: auth.user.id, rettifica_versione: b.data.versione + 1 }).eq('id', originale.id).eq('rettifica_versione', b.data.versione).select('id,rettifica_staff,rettifica_staff_il,rettifica_versione').maybeSingle()
    if (error) erroreQueryStorico('salva-rettifica-chat', error)
    if (!data) throw new ErroreStorico(409, 'MESSAGGIO_MODIFICATO', 'Un altro operatore ha modificato la rettifica. Riapri la conversazione.')
    logEvento('chat', 'info', { operazione: 'chat/rettifica', esito: 'rettifica-conservata', entita_id: originale.id })
    // L'originale, il mittente e il momento del messaggio restano intatti; nessun nuovo messaggio o avviso.
    return NextResponse.json({ success: true, data })
  } catch (error) { logEvento('chat', 'info', { operazione: 'chat/rettifica', esito: 'richiesta-non-completata' }); return rispostaErroreStorico(error, 'admin/chat/rettifica:PATCH') }
})
