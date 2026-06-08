import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { mediaGiudizi, type ScalaVoce } from '@/lib/primaria/media'

// GET /api/primaria/prospetto?alunnoId=&materiaId=&userId=
// Aggrega le valutazioni in itinere di un alunno in una materia, raggruppate per
// obiettivo. Calcola la media matematica dei giudizi sintetici (mappati su
// valore_numerico della scala configurata) — isolamento materia.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const alunnoId = sp.get('alunnoId')
    const materiaId = sp.get('materiaId')
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!alunnoId || !materiaId) return NextResponse.json({ error: 'alunnoId e materiaId obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: valutazioni, error } = await supabase
      .from('valutazioni')
      .select(`
        id, tipo, modalita, giudizio_sintetico, giudizio_testo, creato_il,
        valutazione_obiettivi(obiettivo_id, obiettivi_apprendimento(id, codice, descrizione))
      `)
      .eq('alunno_id', alunnoId)
      .eq('materia_id', materiaId)
      .not('modalita', 'is', null)
      .order('creato_il', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Scala giudizi della scuola dell'alunno → mappa per la media numerica.
    const { data: alunno } = await supabase.from('alunni').select('section_id').eq('id', alunnoId).single()
    let scala: ScalaVoce[] = []
    if (alunno?.section_id) {
      const { data: sez } = await supabase.from('sections').select('scuola_id').eq('id', alunno.section_id).single()
      if (sez?.scuola_id) {
        const { data: s } = await supabase
          .from('giudizi_sintetici_scala')
          .select('etichetta, valore_numerico')
          .eq('scuola_id', sez.scuola_id)
        scala = (s ?? []) as ScalaVoce[]
      }
    }
    const mediaMateria = mediaGiudizi(scala, (valutazioni ?? []).map((v) => v.giudizio_sintetico))

    // Raggruppa per obiettivo.
    const perObiettivo = new Map<string, { obiettivo: { id: string; codice: string | null; descrizione: string }; valutazioni: unknown[] }>()
    type ObiettivoRow = { id: string; codice: string | null; descrizione: string }
    for (const v of valutazioni ?? []) {
      const links = (v.valutazione_obiettivi ?? []) as unknown as { obiettivo_id: string; obiettivi_apprendimento: ObiettivoRow | ObiettivoRow[] | null }[]
      for (const link of links) {
        // La relazione FK può arrivare come oggetto o array a seconda dell'inferenza.
        const ob = (Array.isArray(link.obiettivi_apprendimento) ? link.obiettivi_apprendimento[0] : link.obiettivi_apprendimento) as ObiettivoRow | undefined
        if (!ob) continue
        if (!perObiettivo.has(ob.id)) perObiettivo.set(ob.id, { obiettivo: ob, valutazioni: [] })
        perObiettivo.get(ob.id)!.valutazioni.push({
          id: v.id, tipo: v.tipo, modalita: v.modalita,
          giudizio_sintetico: v.giudizio_sintetico, giudizio_testo: v.giudizio_testo, creato_il: v.creato_il,
        })
      }
    }

    return NextResponse.json({ success: true, data: Array.from(perObiettivo.values()), media: mediaMateria })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
