import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'

// POST multipart: carica un documento nel bucket form_attachments (service-role).
// Usato dal form pubblico di iscrizione (utente non autenticato).
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData()
    const file = form.get('file') as File | null
    const folder = (form.get('folder') as string | null) || 'generico'

    if (!file) {
      return NextResponse.json({ error: 'Nessun file ricevuto' }, { status: 400 })
    }

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
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 })
  }
}
