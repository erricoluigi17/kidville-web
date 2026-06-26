import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { publicFormUrl } from '@/lib/forms/publish'

// Pubblica / ritira un modello del Form Builder (DL-030). Gated alla Segreteria.
// publish: genera (o riusa) il public_token e imposta published_at → link /m/{token}.
// unpublish: azzera published_at (link disattivato) preservando il token.

export async function POST(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  try {
    const body = (await request.json()) as {
      id?: string
      action?: 'publish' | 'unpublish'
      access_mode?: 'public' | 'authenticated'
    }
    const { id, action, access_mode } = body
    if (!id || (action !== 'publish' && action !== 'unpublish')) {
      return NextResponse.json(
        { error: 'id e action (publish|unpublish) sono obbligatori' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()
    const { data: model, error: loadErr } = await supabase
      .from('form_models')
      .select('id, public_token, published_at, access_mode')
      .eq('id', id)
      .maybeSingle()

    if (loadErr || !model) {
      return NextResponse.json({ error: 'Modello non trovato' }, { status: 404 })
    }

    if (action === 'unpublish') {
      const { error } = await supabase
        .from('form_models')
        .update({ published_at: null })
        .eq('id', id)
        .select('id')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ published: false })
    }

    // publish
    const token = (model.public_token as string | null) ?? randomUUID()
    const mode = access_mode ?? (model.access_mode as string | null) ?? 'public'
    const { error } = await supabase
      .from('form_models')
      .update({
        published_at: new Date().toISOString(),
        public_token: token,
        access_mode: mode,
      })
      .eq('id', id)
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      published: true,
      public_token: token,
      access_mode: mode,
      url: publicFormUrl(token),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}
