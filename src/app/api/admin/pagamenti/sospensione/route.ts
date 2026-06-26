import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'

// POST /api/admin/pagamenti/sospensione  (Direzione) — sospende/riattiva un alunno
// per morosità (DL-021). Body: { userId, alunno_id, sospeso: boolean, motivo? }.
// Azione manuale e consapevole, riservata alla Direzione (admin/coordinator).
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const body = await request.json()
    const alunnoId = body.alunno_id
    if (!alunnoId) return NextResponse.json({ error: 'alunno_id è obbligatorio' }, { status: 400 })
    const sospeso = body.sospeso === true

    const supabase = await createAdminClient()

    const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId)
    if (scopeErr) return scopeErr

    const patch = sospeso
      ? {
          sospeso: true,
          sospeso_motivo: typeof body.motivo === 'string' ? body.motivo : null,
          sospeso_il: new Date().toISOString(),
          sospeso_da: auth.user.id,
        }
      : { sospeso: false, sospeso_motivo: null, sospeso_il: null, sospeso_da: auth.user.id }

    const { error } = await supabase.from('alunni').update(patch).eq('id', alunnoId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sospensione',
      entitaId: alunnoId,
      azione: sospeso ? 'insert' : 'delete',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { sospeso, motivo: patch.sospeso_motivo },
    })

    return NextResponse.json({ success: true, data: { alunno_id: alunnoId, sospeso } })
  } catch (err) {
    console.error('Errore API POST sospensione:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
