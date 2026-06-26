import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// GET /api/admin/forms/models — elenco modelli (id, title) per i filtri admin.
// Gated (Segreteria+Direzione); sostituisce la lettura anon di `form_models`.
export async function GET(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const supabase = await createAdminClient()
  const { data, error } = await supabase.from('form_models').select('id, title').order('title')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
