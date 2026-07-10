import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import { parseAnagraficaSede, type AnagraficaSede } from '@/lib/scuole/anagrafica'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (requireUser), non dall'handler.
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/parent/students?userId=  — lista degli alunni collegati al genitore.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    // Unione runtime (legame_genitori_alunni) + anagrafica (student_parents via
    // parents.auth_user_id): risolve i figli anche se il legame è presente in una
    // sola delle due tabelle (fix contesto figlio per mensa/chat/pagamenti).
    const ids = await getFigliDiGenitore(supabase, auth.user.id)
    if (ids.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, scuola_id')
      .in('id', ids)

    if (error) throw error
    const rows = data ?? []

    // Arricchimento sede PER FIGLIO (multi-sede): scuola_id è soft-ref senza FK
    // → lookup separato sugli id distinti. Best-effort: un errore qui non fa
    // fallire la lista figli (campi a null) — regge anche il DB E2E CI non migrato.
    const scuolaIds = [...new Set(rows.map(r => r.scuola_id).filter(Boolean))] as string[]
    const scuolaById = new Map<string, { nome: string | null; citta: string | null; indirizzo: string | null; anagrafica: AnagraficaSede }>()
    if (scuolaIds.length > 0) {
      const { data: scuole } = await supabase
        .from('scuole')
        .select('id, nome, citta, indirizzo, config')
        .in('id', scuolaIds)
      for (const s of scuole ?? []) {
        scuolaById.set(s.id as string, {
          nome: (s.nome as string | null) ?? null,
          citta: (s.citta as string | null) ?? null,
          indirizzo: (s.indirizzo as string | null) ?? null,
          anagrafica: parseAnagraficaSede(s.config),
        })
      }
    }

    // Contratto additivo: shape esistente ({ success, data }) + campi scuola_*.
    const enriched = rows.map(r => {
      const info = r.scuola_id ? scuolaById.get(r.scuola_id) : undefined
      return {
        ...r,
        scuola_nome: info?.nome ?? null,
        scuola_citta: info?.citta ?? null,
        scuola_indirizzo: info?.indirizzo ?? null,
        scuola_cap: info?.anagrafica.cap ?? null,
        scuola_provincia: info?.anagrafica.provincia ?? null,
        scuola_codice_meccanografico: info?.anagrafica.codice_meccanografico ?? null,
      }
    })

    return NextResponse.json({ success: true, data: enriched })
  } catch (err) {
    console.error('GET /api/parent/students:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
