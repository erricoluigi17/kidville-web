import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` resta stringa permissiva (il DB accetta anche formati non YYYY-MM-DD,
// come nella route parent gemella); `motivo` permissivo: oggi qualunque tipo è
// accettato (i non-string diventano null nell'insert).
const getQuerySchema = z.object({
  sectionId: zUuid,
  data: z.string().optional(),
})

const postBodySchema = z.object({
  sectionId: zUuid,
  alunnoId: zUuid,
  data: z.string().min(1),
  motivo: z.unknown().optional(),
  materiaId: zUuid.nullable().optional(),
})

// GET /api/primaria/giustifiche-didattiche?sectionId=&data=&userId=
// Elenco delle giustifiche didattiche (impreparato) per la classe/giorno.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const parsed = parseQuery(request, getQuerySchema)
    if ('response' in parsed) return parsed.response
    const { sectionId, data } = parsed.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    let q = supabase
      .from('giustifiche_didattiche')
      .select('id, alunno_id, materia_id, data, motivo, origine, creato_il, alunni(nome, cognome)')
      .eq('section_id', sectionId)
      .order('data', { ascending: false })
    if (data) q = q.eq('data', data)

    const { data: rows, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: rows ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/giustifiche-didattiche?userId=
// body: { sectionId, alunnoId, data, motivo?, materiaId? }
// Il docente registra "impreparato giustificato" durante la lezione.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { sectionId, alunnoId, data, motivo, materiaId } = b.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
    if (alunnoErr) return alunnoErr
    const { data: inserted, error } = await supabase
      .from('giustifiche_didattiche')
      .insert({
        alunno_id: alunnoId,
        section_id: sectionId,
        materia_id: materiaId ?? null,
        data,
        motivo: typeof motivo === 'string' ? motivo.trim() || null : null,
        origine: 'docente',
        creato_da: userId,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: inserted }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
