import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import {
  calcolaOreAssenza,
  calcolaOreAssenzaPerMateria,
  giornataDaCampanelle,
  type PresenzaInput,
  type PresenzaConData,
} from '@/lib/primaria/oreAssenza'
import { parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'

const getQuerySchema = z.object({
  sectionId: zUuid,
  // '' ammesso sui filtri opzionali: ?from=&to=&alunnoId= (vuoti) equivalgono ad assenti,
  // come oggi (la UI invia i filtri anche quando i campi data sono svuotati).
  from: zDataYMD.or(z.literal('')).optional(),
  to: zDataYMD.or(z.literal('')).optional(),
  alunnoId: zUuid.or(z.literal('')).optional(),
  // Semantica storica: solo il literal 'true' attiva il breakdown per materia.
  includiMaterie: z.string().optional(),
})

// GET /api/primaria/ore-assenza?sectionId=&from=&to=&alunnoId=&userId=&includiMaterie=true
// Monte ore di assenza (assenze intere + ritardi + permessi) per alunno.
// Con includiMaterie=true aggiunge il breakdown per materia.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, from, to, alunnoId } = q.data
    const includiMaterie = q.data.includiMaterie === 'true'

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    if (alunnoId) {
      const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
      if (alunnoErr) return alunnoErr
    }

    // Campanelle della sezione (con id per il calcolo per materia).
    const { data: campanelle } = await supabase
      .from('campanelle')
      .select('id, giorno_settimana, ordine, ora_inizio, ora_fine, tipo')
      .eq('section_id', sectionId)
    const giornata = giornataDaCampanelle(campanelle ?? [])

    // Alunni della sezione.
    let alunniQuery = supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome')
    if (alunnoId) alunniQuery = alunniQuery.eq('id', alunnoId)
    const { data: alunni } = await alunniQuery

    // Presenze nel periodo.
    let presQuery = supabase
      .from('presenze')
      .select('alunno_id, data, stato, orario_entrata, orario_uscita')
      .eq('section_id', sectionId)
      .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
    if (from) presQuery = presQuery.gte('data', from)
    if (to) presQuery = presQuery.lte('data', to)
    if (alunnoId) presQuery = presQuery.eq('alunno_id', alunnoId)
    const { data: presenze } = await presQuery

    const perAlunnoBase = new Map<string, PresenzaInput[]>()
    const perAlunnoConData = new Map<string, PresenzaConData[]>()
    for (const p of presenze ?? []) {
      const base = perAlunnoBase.get(p.alunno_id) ?? []
      base.push({ stato: p.stato, orario_entrata: p.orario_entrata, orario_uscita: p.orario_uscita })
      perAlunnoBase.set(p.alunno_id, base)

      const conData = perAlunnoConData.get(p.alunno_id) ?? []
      conData.push({ stato: p.stato, orario_entrata: p.orario_entrata, orario_uscita: p.orario_uscita, data: p.data })
      perAlunnoConData.set(p.alunno_id, conData)
    }

    // Dati per il calcolo per materia (solo se richiesto).
    let orario: { campanella_id: string; giorno_settimana: number; materia_id: string | null }[] = []
    let materie: { id: string; nome: string }[] = []
    if (includiMaterie) {
      const [orarioRes, materieRes] = await Promise.all([
        supabase
          .from('orario_settimanale')
          .select('campanella_id, giorno_settimana, materia_id')
          .eq('section_id', sectionId),
        supabase
          .from('materie')
          .select('id, nome')
          .eq('section_id', sectionId)
          .eq('attiva', true),
      ])
      orario = orarioRes.data ?? []
      materie = materieRes.data ?? []
    }

    const data = (alunni ?? []).map((a) => {
      const riepilogo = calcolaOreAssenza(perAlunnoBase.get(a.id) ?? [], giornata)
      const entry: Record<string, unknown> = { alunnoId: a.id, nome: a.nome, cognome: a.cognome, ...riepilogo }
      if (includiMaterie) {
        const perMateria = calcolaOreAssenzaPerMateria(
          perAlunnoConData.get(a.id) ?? [],
          campanelle ?? [],
          orario,
          materie,
        )
        entry.perMateria = perMateria.perMateria
      }
      return entry
    })

    return NextResponse.json({ success: true, data, giornata })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
