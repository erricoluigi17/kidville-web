import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { obiettiviDisponibili } from '@/lib/primaria/obiettivi'

// GET /api/primaria/obiettivi?materiaId=&sectionId=&userId=
// Obiettivi disponibili per la materia (e livello dedotto dalla classe), usati
// dal docente nella valutazione in itinere. Restituisce anche la scala giudizi.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const materiaId = sp.get('materiaId')
    const sectionId = sp.get('sectionId')
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    if (!materiaId) return NextResponse.json({ error: 'materiaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: materia } = await supabase
      .from('materie')
      .select('codice, scuola_id, section_id')
      .eq('id', materiaId)
      .maybeSingle()
    if (!materia) return NextResponse.json({ error: 'Materia non trovata' }, { status: 404 })

    // Scope sulla sezione della materia (tenant + assegnazione educator): protegge
    // anche scalaValori (annotazioni numeriche private, mai esposte al genitore).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, materia.section_id)
    if (scopeErr) return scopeErr
    if (sectionId && sectionId !== materia.section_id) {
      return NextResponse.json({ error: 'sectionId non coerente con la materia' }, { status: 403 })
    }

    // Obiettivi disponibili: stesso filtro (materia, livello) usato dall'enforcement
    // "≥1 obiettivo" nella POST valutazioni (sorgente unica: obiettiviDisponibili).
    const [obiettivi, { data: scala }] = await Promise.all([
      obiettiviDisponibili(supabase, { codice: materia.codice, scuola_id: materia.scuola_id }, sectionId),
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
