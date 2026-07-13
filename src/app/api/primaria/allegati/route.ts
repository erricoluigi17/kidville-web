import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  registroId: zUuid,
})

const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'file obbligatorio' }),
  registroId: zUuid,
  ambito: z.string().default('argomento'),
})

// Risolve registroId → section_id della riga di registro e ne verifica lo scope.
async function assertRegistroInScope(
  supabase: SupabaseClient,
  user: AppUser,
  registroId: string,
): Promise<NextResponse | null> {
  const { data: registro } = await supabase
    .from('registro_orario')
    .select('id, section_id')
    .eq('id', registroId)
    .maybeSingle()
  if (!registro) return NextResponse.json({ error: 'Registro non trovato' }, { status: 404 })
  return assertSezioneInScope(supabase, user, registro.section_id as string)
}

const BUCKET = 'registro-allegati'
const MAX_PDF = 10 * 1024 * 1024 // 10MB
const MAX_IMG = 3 * 1024 * 1024 // 3MB
const IMG_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']

// GET /api/primaria/allegati?registroId=&userId=
export const GET = withRoute('primaria/allegati:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { registroId } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertRegistroInScope(supabase, auth.user, registroId)
    if (scopeErr) return scopeErr
    const { data, error } = await supabase
      .from('allegati_registro')
      .select('*')
      .eq('registro_id', registroId)
      .order('creato_il')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/allegati:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/allegati  (multipart: file, registroId, ambito?, userId)
export const POST = withRoute('primaria/allegati:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    // Identità dal gate (sessione o header legacy), MAI dal formData:
    // il campo multipart 'userId' permetterebbe di impersonare chiunque.
    const userId = auth.user.id

    const formData = await request.formData()
    const f = parseData(postFormSchema, {
      file: formData.get('file'),
      registroId: formData.get('registroId'),
      // formData.get restituisce null se assente: normalizza per il default zod
      ambito: formData.get('ambito') ?? undefined,
    })
    if ('response' in f) return f.response
    const { file, registroId, ambito } = f.data

    const isPdf = file.type === 'application/pdf'
    const isImg = IMG_TYPES.includes(file.type)
    if (!isPdf && !isImg) return NextResponse.json({ error: 'Formato non ammesso (PDF o immagine)' }, { status: 400 })
    if (isPdf && file.size > MAX_PDF) return NextResponse.json({ error: 'PDF oltre 10MB' }, { status: 400 })
    if (isImg && file.size > MAX_IMG) return NextResponse.json({ error: 'Immagine oltre 3MB' }, { status: 400 })

    const supabase = await createAdminClient()
    const scopeErr = await assertRegistroInScope(supabase, auth.user, registroId)
    if (scopeErr) return scopeErr

    // Assicura il bucket.
    try {
      const { data: buckets } = await supabase.storage.listBuckets()
      const opts = {
        public: true,
        allowedMimeTypes: ['application/pdf', ...IMG_TYPES],
        fileSizeLimit: MAX_PDF,
      }
      if (!buckets?.some((b) => b.name === BUCKET)) await supabase.storage.createBucket(BUCKET, opts)
    } catch (e) {
      console.error('bucket allegati:', e)
    }

    const ext = file.name.split('.').pop() || ''
    const path = `registro/${registroId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
    const buf = await file.arrayBuffer()
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, Buffer.from(buf), {
      contentType: file.type,
      upsert: true,
    })
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)

    const { data, error } = await supabase
      .from('allegati_registro')
      .insert({
        registro_id: registroId,
        ambito,
        tipo: isPdf ? 'pdf' : 'immagine',
        file_url: pub.publicUrl,
        file_name: file.name,
        dimensione_byte: file.size,
        caricato_da: userId,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'primaria/allegati:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
