import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// ============================================================
// Configurazione giudizi: scala sintetica + template descrittivi.
// ============================================================

// GET /api/admin/primaria/giudizi?scuolaId=
export async function GET(request: NextRequest) {
  try {
    const scuolaId = new URL(request.url).searchParams.get('scuolaId')
    if (!scuolaId) return NextResponse.json({ error: 'scuolaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const [{ data: scala }, { data: template }] = await Promise.all([
      supabase.from('giudizi_sintetici_scala').select('*').eq('scuola_id', scuolaId).order('ordine'),
      supabase
        .from('giudizio_template')
        .select('*')
        .or(`scuola_id.eq.${scuolaId},scuola_id.is.null`)
        .order('dimensione'),
    ])
    return NextResponse.json({ success: true, data: { scala: scala ?? [], template: template ?? [] } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/giudizi?action=scala|template
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const action = new URL(request.url).searchParams.get('action')
    const body = await request.json()
    const supabase = await createAdminClient()

    if (action === 'scala') {
      const { scuolaId, etichetta, ordine, valoreNumerico, giudizioDescrittivo, attivo } = body
      if (!scuolaId || !etichetta) return NextResponse.json({ error: 'scuolaId ed etichetta obbligatori' }, { status: 400 })
      const row: Record<string, unknown> = { scuola_id: scuolaId, etichetta, ordine: ordine ?? 0 }
      if (valoreNumerico !== undefined) row.valore_numerico = valoreNumerico === null || valoreNumerico === '' ? null : Number(valoreNumerico)
      if (giudizioDescrittivo !== undefined) row.giudizio_descrittivo = giudizioDescrittivo || null
      if (attivo !== undefined) row.attivo = !!attivo
      const { data, error } = await supabase
        .from('giudizi_sintetici_scala')
        .upsert(row, { onConflict: 'scuola_id,etichetta' })
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    if (action === 'scala-rename') {
      const { scuolaId, id, etichetta } = body
      if (!scuolaId || !id || !etichetta) return NextResponse.json({ error: 'scuolaId, id ed etichetta obbligatori' }, { status: 400 })

      // Etichetta vecchia: serve per propagare la rinomina ai giudizi descrittivi
      // configurati (referenziati per testo via etichetta_voto).
      const { data: prev } = await supabase
        .from('giudizi_sintetici_scala')
        .select('etichetta')
        .eq('id', id)
        .eq('scuola_id', scuolaId)
        .maybeSingle()
      if (!prev) return NextResponse.json({ error: 'Giudizio non trovato' }, { status: 404 })

      const { data, error } = await supabase
        .from('giudizi_sintetici_scala')
        .update({ etichetta })
        .eq('id', id)
        .eq('scuola_id', scuolaId)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      // Cascade: scrutinio_giudizio_descrittivo.etichetta_voto referenzia l'etichetta
      // per testo. Senza questo update i giudizi descrittivi resterebbero orfani.
      if (prev.etichetta !== etichetta) {
        const { error: cascadeErr } = await supabase
          .from('scrutinio_giudizio_descrittivo')
          .update({ etichetta_voto: etichetta })
          .eq('scuola_id', scuolaId)
          .eq('etichetta_voto', prev.etichetta)
        if (cascadeErr) return NextResponse.json({ error: cascadeErr.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, data })
    }

    if (action === 'template') {
      const { scuolaId, dimensione, valore, frammento } = body
      if (!scuolaId || !dimensione || !valore || !frammento) {
        return NextResponse.json({ error: 'scuolaId, dimensione, valore, frammento obbligatori' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('giudizio_template')
        .upsert({ scuola_id: scuolaId, dimensione, valore, frammento }, { onConflict: 'scuola_id,dimensione,valore' })
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    return NextResponse.json({ error: 'action non riconosciuta' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/admin/primaria/giudizi?tipo=scala|template&id=
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const sp = new URL(request.url).searchParams
    const tipo = sp.get('tipo')
    const id = sp.get('id')
    if (!id || !tipo) return NextResponse.json({ error: 'tipo e id obbligatori' }, { status: 400 })

    const table = tipo === 'scala' ? 'giudizi_sintetici_scala' : 'giudizio_template'
    const supabase = await createAdminClient()
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
