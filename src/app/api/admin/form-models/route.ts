import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// POST: crea un nuovo modello form (bypassa RLS via service-role)
export async function POST(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const body = await request.json()
    const { title, schema, is_active, requires_signature, description, signature_mode } = body

    if (!title || !schema) {
      return NextResponse.json({ error: 'title e schema sono obbligatori' }, { status: 400 })
    }

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}

// PATCH: aggiorna un modello form esistente
export async function PATCH(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const body = await request.json()
    const { id, ...updates } = body

    if (!id) {
      return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })
    }

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}
