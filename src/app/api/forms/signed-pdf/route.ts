import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSessioneAuth, requireUserDaSessioneVerificata, type AppUser } from '@/lib/auth/require-staff'
import { haUnRuolo } from '@/lib/auth/predicati-ruolo'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { ensureSignedSubmissionPdf, downloadSignedSubmissionPdf } from '@/lib/forms/signed-archive'

const postBodySchema = z.object({ id: zUuid }).strict()
const getQuerySchema = z.object({ id: zUuid })
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
function privateResponse(response: NextResponse) { response.headers.set('Cache-Control', 'no-store'); return response }

/** Ownership is in the SQL predicate before reading responses/signature/bytes. */
async function authorizedSubmission(request: NextRequest, user: AppUser, id: string) {
  const supabase = await createAdminClient()
  const owned = await supabase.from('forms_submissions').select('*').eq('id', id).eq('parent_id', user.id).maybeSingle()
  if (owned.error) {
    logErrore({ operazione: 'forms/signed-pdf', stato: 500, evento: 'db' }, owned.error)
    return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_ACCESSO_NON_VERIFICATO' }, 503) }
  }
  if (owned.data) return { supabase, submission: owned.data }

  // Un'altra famiglia non può leggere neppure il titolo del modello. Lo staff
  // risolve le sedi attive prima di leggere firma/risposte per una riga altrui.
  if (!haUnRuolo(user, ['admin', 'coordinator', 'segreteria'])) {
    logEvento('auth', 'info', { operazione: 'forms/signed-pdf', esito: 'ruolo-negato', utente: user.id })
    return { response: json({ error: 'Accesso non consentito', codice: 'MODULO_FIRMATO_ACCESSO_NEGATO' }, 403) }
  }
  const schools = await resolveScuoleAttive(request, supabase, user)
  if (!schools.length) return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_NON_DISPONIBILE' }, 403) }
  const metadata = await supabase.from('forms_submissions').select('id, form_id').eq('id', id).maybeSingle()
  if (metadata.error) {
    logErrore({ operazione: 'forms/signed-pdf', stato: 500, evento: 'db' }, metadata.error)
    return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_ACCESSO_NON_VERIFICATO' }, 503) }
  }
  if (!metadata.data) return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_NON_DISPONIBILE' }, 404) }
  const template = await supabase.from('forms_templates').select('id, scuola_id').eq('id', metadata.data.form_id).in('scuola_id', schools).maybeSingle()
  if (template.error) {
    logErrore({ operazione: 'forms/signed-pdf', stato: 500, evento: 'db' }, template.error)
    return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_ACCESSO_NON_VERIFICATO' }, 503) }
  }
  if (!template.data) return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_NON_DISPONIBILE' }, 404) }
  const full = await supabase.from('forms_submissions').select('*').eq('id', id).eq('form_id', template.data.id).maybeSingle()
  if (full.error) {
    logErrore({ operazione: 'forms/signed-pdf', stato: 500, evento: 'db' }, full.error)
    return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_ACCESSO_NON_VERIFICATO' }, 503) }
  }
  if (!full.data) return { response: json({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_NON_DISPONIBILE' }, 404) }
  return { supabase, submission: full.data }
}

export const POST = withRoute('forms/signed-pdf:POST', async (request: NextRequest) => {
  try {
    const session = await requireSessioneAuth()
    if (session.response) return privateResponse(session.response)
    const auth = await requireUserDaSessioneVerificata(request, session.sessione.authUserId)
    if (auth.response) return privateResponse(auth.response)
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return privateResponse(b.response)
    const access = await authorizedSubmission(request, auth.user, b.data.id)
    if (access.response) return access.response
    const result = await ensureSignedSubmissionPdf(access.supabase, b.data.id)
    return json({
      ok: result.pdf_ready, submission: result.submission, pdf_ready: result.pdf_ready,
      pdf_error: result.pdf_error, pdf_message: result.pdf_message,
      ...(result.pdf_ready ? {} : { error: result.pdf_message, codice: result.pdf_error ?? 'MODULO_FIRMATO_NON_PREPARATO' }),
    }, result.status)
  } catch (error) {
    logErrore({ operazione: 'forms/signed-pdf:POST', stato: 500 }, error)
    return json({ error: 'Non è stato possibile preparare il documento', codice: 'MODULO_FIRMATO_NON_PREPARATO', pdf_ready: false }, 500)
  }
})

export const GET = withRoute('forms/signed-pdf:GET', async (request: NextRequest) => {
  try {
    const session = await requireSessioneAuth()
    if (session.response) return privateResponse(session.response)
    const auth = await requireUserDaSessioneVerificata(request, session.sessione.authUserId)
    if (auth.response) return privateResponse(auth.response)
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return privateResponse(q.response)
    const access = await authorizedSubmission(request, auth.user, q.data.id)
    if (access.response) return access.response
    const result = await downloadSignedSubmissionPdf(access.supabase, access.submission)
    if (!result.bytes) return json({ error: result.pdf_message, codice: result.pdf_error ?? 'MODULO_FIRMATO_NON_LETTO', pdf_error: result.pdf_error, pdf_ready: false }, result.status)
    const extensionByMime: Record<string, string> = {
      'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
      'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
    }
    const extension = extensionByMime[result.content_type ?? 'application/octet-stream'] ?? 'bin'
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        'Content-Type': result.content_type ?? 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="modulo-firmato-${q.data.id}.${extension}"`,
        'X-Kidville-Document-Status': 'signed', 'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    logErrore({ operazione: 'forms/signed-pdf:GET', stato: 500 }, error)
    return json({ error: 'Non è stato possibile leggere il documento', codice: 'MODULO_FIRMATO_NON_LETTO' }, 500)
  }
})
