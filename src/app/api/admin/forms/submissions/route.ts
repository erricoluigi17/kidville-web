import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// GET /api/admin/forms/submissions?status=&modelId=&date= — compilazioni con
// filtri. Gated; sostituisce la lettura anon di `form_submissions`.
export async function GET(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const modelId = searchParams.get('modelId')
  const date = searchParams.get('date')

  const supabase = await createAdminClient()
  let query = supabase
    .from('form_submissions')
    .select('id, model_id, user_id, data, status, signed_at, created_at, form_model:form_models(id, title, schema)')
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)
  if (modelId) query = query.eq('model_id', modelId)
  if (date) {
    const from = new Date(date); from.setHours(0, 0, 0, 0)
    const to = new Date(date); to.setHours(23, 59, 59, 999)
    query = query.gte('created_at', from.toISOString()).lte('created_at', to.toISOString())
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
