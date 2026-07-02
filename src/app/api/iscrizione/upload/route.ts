import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseData } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il file si valida come presenza/istanza; dimensione e contenuto restano
// controlli manuali (non materia di zod). `folder` assente/null/'' ricade sul
// default 'generico' nel codice, come oggi.
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
  folder: z.string().nullish(),
})

// POST multipart: carica un documento nel bucket form_attachments (service-role).
// Usato dal form pubblico di iscrizione (utente non autenticato).
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData()
    const parsed = parseData(postFormSchema, {
      file: form.get('file'),
      folder: form.get('folder'),
    })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data
    const folder = parsed.data.folder || 'generico'

    // Limite dimensione: 8 MB
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'File troppo grande (max 8MB)' }, { status: 400 })
    }

    const safeFolder = folder.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `iscrizioni/${safeFolder}/${crypto.randomUUID()}-${safeName}`

    const supabase = await createAdminClient()
    const arrayBuffer = await file.arrayBuffer()
    const { error } = await supabase.storage
      .from('form_attachments')
      .upload(path, arrayBuffer, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'application/octet-stream',
      })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ path })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg || 'Errore interno' }, { status: 500 })
  }
}
