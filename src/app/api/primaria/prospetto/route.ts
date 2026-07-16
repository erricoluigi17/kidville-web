import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { mediaGiudizi, giudiziSintetici, type ScalaVoce } from '@/lib/primaria/media'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  alunnoId: zUuid,
  materiaId: zUuid.optional(),
})

// GET /api/primaria/prospetto?alunnoId=&materiaId=&userId=
// Con materiaId: valutazioni raggruppate per obiettivo + media per quella materia.
// Senza materiaId: panoramica medie per tutte le materie dell'alunno nella sezione.
//
// ⚠️ Endpoint RISERVATO AL PERSONALE DOCENTE: restituisce la media numerica, che
// per la primaria è uno strumento di lavoro del docente e NON deve MAI essere
// accessibile al genitore (O.M. 3/2025, PRD §4 #3 e §4.5). Senza un gate di ruolo
// un genitore — che possiede un userId valido — potrebbe leggerla chiamando
// direttamente questa route con l'id del proprio figlio.
export const GET = withRoute('primaria/prospetto:GET', async (request: NextRequest) => {
  try {
    // Gate di ruolo: solo docenti/segreteria/staff. Il genitore (role 'genitore')
    // è escluso, così la media numerica non gli è mai accessibile via API (vedi nota sopra).
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, materiaId } = q.data

    const supabase = await createAdminClient()

    // Scope per tenant/classe: educator solo sui propri alunni; staff/segreteria
    // su tutto il plesso; mai cross-tenant.
    const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId)
    if (scopeErr) return scopeErr

    // Recupera scala giudizi una sola volta (serve sia per materia singola sia per panoramica).
    const { data: alunno } = await supabase.from('alunni').select('section_id').eq('id', alunnoId).maybeSingle()
    let scala: ScalaVoce[] = []
    if (alunno?.section_id) {
      const { data: sez } = await supabase.from('sections').select('scuola_id').eq('id', alunno.section_id).maybeSingle()
      if (sez?.scuola_id) {
        const { data: s } = await supabase
          .from('giudizi_sintetici_scala')
          .select('etichetta, valore_numerico')
          .eq('scuola_id', sez.scuola_id)
        scala = (s ?? []) as ScalaVoce[]
      }
    }

    // ─── Panoramica tutte le materie (senza materiaId) ──────────────
    if (!materiaId) {
      const sectionId = alunno?.section_id
      if (!sectionId) return NextResponse.json({ error: 'Sezione non trovata per questo alunno' }, { status: 400 })

      const [{ data: materie }, { data: valutazioni }] = await Promise.all([
        supabase.from('materie').select('id, nome').eq('section_id', sectionId).eq('attiva', true).order('ordine'),
        supabase
          .from('valutazioni')
          .select('materia_id, giudizio_sintetico')
          .eq('alunno_id', alunnoId)
          .eq('modalita', 'sintetico')
          .not('giudizio_sintetico', 'is', null),
      ])

      const perMateria = new Map<string, string[]>()
      for (const v of valutazioni ?? []) {
        const arr = perMateria.get(v.materia_id) ?? []
        arr.push(v.giudizio_sintetico)
        perMateria.set(v.materia_id, arr)
      }

      const panoramica = (materie ?? []).map((m) => {
        const giudizi = perMateria.get(m.id) ?? []
        const media = mediaGiudizi(scala, giudizi)
        return { materiaId: m.id, nome: m.nome, media, nValutazioni: giudizi.length }
      })

      return NextResponse.json({ success: true, panoramica })
    }

    // ─── Singola materia (con materiaId) ────────────────────────────
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

    // Media coerente con la panoramica: si mediano SOLO i giudizi con modalità
    // 'sintetico' (la panoramica filtra .eq('modalita','sintetico') lato query).
    // La lista per-obiettivo qui sotto resta INVARIATA: mostra tutte le modalità.
    const mediaMateria = mediaGiudizi(scala, giudiziSintetici(valutazioni ?? []))

    const perObiettivo = new Map<string, { obiettivo: { id: string; codice: string | null; descrizione: string }; valutazioni: unknown[] }>()
    type ObiettivoRow = { id: string; codice: string | null; descrizione: string }
    for (const v of valutazioni ?? []) {
      const links = (v.valutazione_obiettivi ?? []) as unknown as { obiettivo_id: string; obiettivi_apprendimento: ObiettivoRow | ObiettivoRow[] | null }[]
      for (const link of links) {
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
    logErrore({ operazione: 'primaria/prospetto:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
