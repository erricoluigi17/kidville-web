import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { publicFormUrl } from '@/lib/forms/publish'
import { parseBody } from '@/lib/validation/http'

// Pubblica / ritira un modello del Form Builder (DL-030). Gated alla Segreteria.
// publish: genera (o riusa) il public_token e imposta published_at → link /m/{token}.
// unpublish: azzera published_at (link disattivato) preservando il token.

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Sostituisce il 400 manuale 'id e action (publish|unpublish) sono obbligatori'.
// `id` resta stringa libera come il truthy check odierno (nei test circolano
// id non-UUID tipo 'm-1'). `access_mode` oggi non ha validazione runtime
// (solo cast TS): resta libero, il fallback (modello → 'public') resta nel codice.
const postBodySchema = z.object({
  id: z.string().min(1, 'id obbligatorio'),
  action: z.enum(['publish', 'unpublish'], {
    error: "action deve essere 'publish' o 'unpublish'",
  }),
  access_mode: z.unknown().optional(),
})

export async function POST(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { id, action, access_mode } = b.data

  try {
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
