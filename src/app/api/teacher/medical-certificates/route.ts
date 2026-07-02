import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { periodoValido, isEsitoValidazione } from '@/lib/certificati/stato'

// GET /api/teacher/medical-certificates — elenco certificati per la Segreteria.
// Filtri opzionali: ?stato=in_validazione | ?class_name=
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const stato = searchParams.get('stato')
    const className = searchParams.get('class_name')

    const supabase = await createAdminClient()
    let query = supabase
      .from('certificati_medici')
      .select('id, alunno_id, file_path, data_inizio, data_fine, stato, note, nota_validazione, validato_il, creato_il, alunno:alunni(nome, cognome, classe_sezione)')
      .order('creato_il', { ascending: false })
    if (stato) query = query.eq('stato', stato)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    let rows = (data ?? []) as Record<string, unknown>[]
    if (className) {
      rows = rows.filter((c) => {
        const a = c.alunno as { classe_sezione?: string } | null
        return a?.classe_sezione === className
      })
    }
    // appiattisce nome/cognome alunno per retro-compat con la UI
    rows = rows.map((c) => {
      const a = c.alunno as { nome?: string; cognome?: string } | null
      return { ...c, nome_alunno: a?.nome ?? '', cognome_alunno: a?.cognome ?? '' }
    })
    return NextResponse.json({ success: true, data: rows })
  } catch (err) {
    console.error('Errore GET teacher/medical-certificates:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/teacher/medical-certificates — validazione Segreteria (DL-027).
// Body: { id, esito: 'validato'|'rifiutato', data_inizio?, data_fine?, nota_validazione? }
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const body = await request.json()
    const id = body.id
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })
    if (!isEsitoValidazione(body.esito)) {
      return NextResponse.json({ error: 'esito non valido (validato|rifiutato)' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {
      stato: body.esito,
      validato_da: auth.user.id,
      validato_il: new Date().toISOString(),
      nota_validazione: typeof body.nota_validazione === 'string' ? body.nota_validazione : null,
    }
    // la Segreteria può correggere il periodo in fase di validazione
    if (body.data_inizio || body.data_fine) {
      if (!periodoValido({ data_inizio: body.data_inizio, data_fine: body.data_fine })) {
        return NextResponse.json({ error: 'Periodo di copertura non valido' }, { status: 400 })
      }
      patch.data_inizio = body.data_inizio
      patch.data_fine = body.data_fine
    }

    const supabase = await createAdminClient()
    const { error } = await supabase.from('certificati_medici').update(patch).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'certificato_medico',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { stato: body.esito },
    })

    return NextResponse.json({ success: true, data: { id, stato: body.esito } })
  } catch (err) {
    console.error('Errore PATCH teacher/medical-certificates:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
