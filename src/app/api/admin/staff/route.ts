import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { isRuoloAssegnabile } from '@/lib/auth/ruoli'

const DIREZIONE = ['admin', 'coordinator'] as const

// GET /api/admin/staff — elenco personale (esclude i genitori). Solo Direzione.
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('utenti')
      .select('id, nome, cognome, email, ruolo, scuola_id, gradi')
      .neq('ruolo', 'genitore')
      .order('cognome', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // contesto per la UI: sedi + classi + assegnazioni correnti
    const [{ data: schools }, { data: sections }, { data: asseg }] = await Promise.all([
      supabase.from('schools').select('id, nome'),
      supabase.from('sections').select('id, name, scuola_id, school_type').order('name'),
      supabase.from('utenti_sezioni').select('utente_id, section_id'),
    ])

    return NextResponse.json({
      success: true,
      data: data ?? [],
      schools: schools ?? [],
      sections: sections ?? [],
      assegnazioni: asseg ?? [],
    })
  } catch (err) {
    console.error('Errore GET admin/staff:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/staff — gestione RBAC (DL-028). Solo Direzione.
// Body: { id, ruolo?, scuola_id?, gradi?, section_ids? }
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response

    const body = await request.json()
    const id = body.id
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    if (body.ruolo !== undefined) {
      if (!isRuoloAssegnabile(body.ruolo)) {
        return NextResponse.json({ error: 'Ruolo non assegnabile' }, { status: 400 })
      }
      // self-lockout guard: la Direzione non può cambiare il proprio ruolo
      if (id === auth.user.id) {
        return NextResponse.json({ error: 'Non puoi modificare il tuo stesso ruolo' }, { status: 403 })
      }
    }

    const patch: Record<string, unknown> = {}
    if (body.ruolo !== undefined) patch.ruolo = body.ruolo
    if (body.scuola_id !== undefined) patch.scuola_id = body.scuola_id
    if (Array.isArray(body.gradi)) patch.gradi = body.gradi

    const supabase = await createAdminClient()

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('utenti').update(patch).eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // assegnazione classi: replace completo
    if (Array.isArray(body.section_ids)) {
      await supabase.from('utenti_sezioni').delete().eq('utente_id', id)
      if (body.section_ids.length > 0) {
        await supabase
          .from('utenti_sezioni')
          .insert(body.section_ids.map((sid: string) => ({ utente_id: id, section_id: sid })))
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'staff_rbac',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { ruolo: body.ruolo, scuola_id: body.scuola_id, section_ids: body.section_ids },
    })

    return NextResponse.json({ success: true, data: { id } })
  } catch (err) {
    console.error('Errore PATCH admin/staff:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
