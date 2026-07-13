import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// POST — sostituisce il 400 manuale 'title e schema sono obbligatori'.
// `schema` è il JSON libero del Form Builder: oggi basta che sia truthy.
// I campi con fallback nel codice (`?? false`, confronto === 'joint')
// restano liberi: oggi accettano qualunque valore.
const postBodySchema = z.object({
  title: z.string().min(1, 'title obbligatorio'),
  schema: z.unknown().refine((v) => Boolean(v), 'schema obbligatorio'),
  description: z.unknown().optional(),
  is_active: z.unknown().optional(),
  requires_signature: z.unknown().optional(),
  signature_mode: z.unknown().optional(),
})

// PATCH — il resto del body viene spalmato nell'update (...updates):
// .loose() preserva le chiavi extra. `id` resta stringa libera come il
// truthy check odierno (nei test circolano id non-UUID tipo 'm-1').
const patchBodySchema = z
  .object({
    id: z.string().min(1, 'id obbligatorio'),
  })
  .loose()

// POST: crea un nuovo modello form (bypassa RLS via service-role)
export const POST = withRoute('admin/form-models:POST', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  try {
    const { title, schema, is_active, requires_signature, description, signature_mode } = b.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('form_models')
      .insert({
        title,
        description: description ?? null,
        schema,
        is_active: is_active ?? false,
        requires_signature: requires_signature ?? false,
        signature_mode: signature_mode === 'joint' ? 'joint' : 'single',
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/form-models:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})

// PATCH: aggiorna un modello form esistente
export const PATCH = withRoute('admin/form-models:PATCH', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, patchBodySchema)
  if ('response' in b) return b.response
  try {
    const { id, ...updates } = b.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('form_models')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    logErrore({ operazione: 'admin/form-models:PATCH', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
