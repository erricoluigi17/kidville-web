import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { mediaGiudizi, type ScalaVoce } from '@/lib/primaria/media'

// GET /api/parent/primaria/valutazioni?studentId=&userId=
// Valutazioni in itinere del figlio con medie per materia.
// Rispetta il buffer di visibilità configurato dalla scuola.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const studentId = sp.get('studentId')
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('section_id, scuola_id')
      .eq('id', studentId)
      .single()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Buffer visibilità
    const { data: settings } = await supabase
      .from('admin_settings')
      .select('notif_buffer_valutazioni_min')
      .eq('scuola_id', alunno.scuola_id)
      .maybeSingle()
    const bufferMin = settings?.notif_buffer_valutazioni_min ?? 10
    const soglia = new Date(Date.now() - bufferMin * 60_000).toISOString()

    const [{ data: valutazioni }, { data: materie }, { data: scala }] = await Promise.all([
      supabase
        .from('valutazioni')
        .select('id, materia_id, tipo, modalita, giudizio_sintetico, giudizio_testo, creato_il, argomento')
        .eq('alunno_id', studentId)
        .eq('pubblicato', true)
        .lte('creato_il', soglia)
        .order('creato_il', { ascending: false }),
      supabase
        .from('materie')
        .select('id, nome')
        .eq('section_id', alunno.section_id)
        .eq('attiva', true)
        .order('ordine'),
      supabase
        .from('giudizi_sintetici_scala')
        .select('etichetta, valore_numerico')
        .eq('scuola_id', alunno.scuola_id),
    ])

    const scalaVoci = (scala ?? []) as ScalaVoce[]

    // Raggruppa per materia e calcola medie
    const perMateria = new Map<string, { giudizi: string[]; valutazioni: unknown[] }>()
    for (const v of valutazioni ?? []) {
      const entry = perMateria.get(v.materia_id) ?? { giudizi: [], valutazioni: [] }
      if (v.giudizio_sintetico) entry.giudizi.push(v.giudizio_sintetico)
      entry.valutazioni.push(v)
      perMateria.set(v.materia_id, entry)
    }

    const data = (materie ?? [])
      .filter((m) => perMateria.has(m.id))
      .map((m) => {
        const entry = perMateria.get(m.id)!
        return {
          materiaId: m.id,
          nome: m.nome,
          media: mediaGiudizi(scalaVoci, entry.giudizi),
          valutazioni: entry.valutazioni,
        }
      })

    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
