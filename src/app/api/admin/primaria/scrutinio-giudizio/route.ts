import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ============================================================
// Giudizio descrittivo di scrutinio per voto.
// Granularità: livello × materia (codice) × periodo × voto (etichetta scala).
// In pagella il testo si associa in automatico al voto assegnato.
// ============================================================

const getQuerySchema = z.object({
  scuolaId: zUuid,
  // conversione Number() nell'handler come oggi
  livello: z.string().min(1),
  periodoId: zUuid,
})

const postBodySchema = z.object({
  scuolaId: zUuid,
  // oggi: check truthy sul valore grezzo, poi Number() — replicato con refine
  livello: z.union([z.number(), z.string()]).refine((v) => !!v, 'livello obbligatorio'),
  materiaCodice: z.string().min(1),
  periodoId: zUuid,
  etichettaVoto: z.string().min(1),
  // testo vuoto/null/non-stringa → rimuove la riga (gestito nell'handler)
  testo: z.unknown().optional(),
})

// GET /api/admin/primaria/scrutinio-giudizio?scuolaId=&livello=&periodoId=
// Ritorna le righe (materia_codice × etichetta_voto → testo) per livello+periodo.
export const GET = withRoute('admin/primaria/scrutinio-giudizio:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuolaId, livello, periodoId } = q.data

    const supabase = await createAdminClient()

    const sede = await resolveScuolaScrittura(request, supabase, auth.user, scuolaId)
    if (sede.response) return sede.response

    const { data, error } = await supabase
      .from('scrutinio_giudizio_descrittivo')
      .select('materia_codice, etichetta_voto, giudizio_descrittivo')
      .eq('scuola_id', sede.scuolaId)
      .eq('livello', Number(livello))
      .eq('periodo_id', periodoId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-giudizio:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/primaria/scrutinio-giudizio
//   body: { scuolaId, livello, materiaCodice, periodoId, etichettaVoto, testo }
// testo vuoto/null → rimuove la riga.
export const POST = withRoute('admin/primaria/scrutinio-giudizio:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scuolaId, livello, materiaCodice, periodoId, etichettaVoto, testo } = b.data

    const supabase = await createAdminClient()

    const sede = await resolveScuolaScrittura(request, supabase, auth.user, scuolaId)
    if (sede.response) return sede.response

    const testoPulito = typeof testo === 'string' ? testo.trim() : ''
    if (!testoPulito) {
      const { error } = await supabase
        .from('scrutinio_giudizio_descrittivo')
        .delete()
        .eq('scuola_id', sede.scuolaId)
        .eq('livello', Number(livello))
        .eq('materia_codice', materiaCodice)
        .eq('periodo_id', periodoId)
        .eq('etichetta_voto', etichettaVoto)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data: null })
    }

    const { data, error } = await supabase
      .from('scrutinio_giudizio_descrittivo')
      .upsert(
        {
          scuola_id: sede.scuolaId,
          livello: Number(livello),
          materia_codice: materiaCodice,
          periodo_id: periodoId,
          etichetta_voto: etichettaVoto,
          giudizio_descrittivo: testoPulito,
        },
        { onConflict: 'scuola_id,livello,materia_codice,periodo_id,etichetta_voto' }
      )
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-giudizio:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
