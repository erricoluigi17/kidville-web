import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/primaria/obiettivi?materiaId=&sectionId=&userId=
// Obiettivi disponibili per la materia (e livello dedotto dalla classe), usati
// dal docente nella valutazione in itinere. Restituisce anche la scala giudizi.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const materiaId = sp.get('materiaId')
    const sectionId = sp.get('sectionId')
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!materiaId) return NextResponse.json({ error: 'materiaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: materia } = await supabase
      .from('materie')
      .select('codice, scuola_id')
      .eq('id', materiaId)
      .single()
    if (!materia) return NextResponse.json({ error: 'Materia non trovata' }, { status: 404 })

    // Livello dedotto dal nome sezione (es. "3A" → 3).
    let livello: number | null = null
    if (sectionId) {
      const { data: sez } = await supabase.from('sections').select('name').eq('id', sectionId).single()
      const m = sez?.name?.match(/[1-5]/)
      if (m) livello = Number(m[0])
    }

    let q = supabase
      .from('obiettivi_apprendimento')
      .select('id, codice, descrizione, livello')
      .eq('scuola_id', materia.scuola_id)
      .eq('materia_codice', materia.codice)
      .eq('attivo', true)
      .order('codice')
    if (livello) q = q.eq('livello', livello)

    const [{ data: obiettivi }, { data: scala }] = await Promise.all([
      q,
      supabase
        .from('giudizi_sintetici_scala')
        .select('etichetta, valore_numerico, ordine')
        .eq('scuola_id', materia.scuola_id)
        .eq('attivo', true)
        .order('ordine'),
    ])

    return NextResponse.json({
      success: true,
      data: {
        obiettivi: obiettivi ?? [],
        scala: (scala ?? []).map((s) => s.etichetta),
        // Scala con valore numerico nascosto: usata SOLO lato docente per suggerire
        // un giudizio dall'annotazione numerica privata (mai esposta al genitore).
        scalaValori: (scala ?? []).map((s) => ({ etichetta: s.etichetta, valore_numerico: s.valore_numerico })),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
