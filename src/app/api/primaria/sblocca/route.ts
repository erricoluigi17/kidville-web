import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// POST /api/primaria/sblocca?userId=
// Override diretto del dirigente sul vincolo temporale. Riservato allo staff
// (admin/coordinator = dirigenza). Registra la motivazione in sblocchi_audit.
// body: { entitaTipo: 'registro'|'valutazione'|'nota', entitaId, motivazione }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const { entitaTipo, entitaId, motivazione } = await request.json()
    if (!['registro', 'valutazione', 'nota'].includes(entitaTipo) || !entitaId || !motivazione) {
      return NextResponse.json({ error: 'entitaTipo, entitaId e motivazione obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('sblocchi_audit')
      .insert({ entita_tipo: entitaTipo, entita_id: entitaId, dirigente_id: auth.user.id, motivazione })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Azzera l'eventuale lock persistito (il blocco effettivo è comunque calcolato
    // in API: l'esistenza di questa riga di audit funge da override).
    const table = entitaTipo === 'registro' ? 'registro_orario' : entitaTipo === 'valutazione' ? 'valutazioni' : null
    if (table) await supabase.from(table).update({ locked_il: null }).eq('id', entitaId)

    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
