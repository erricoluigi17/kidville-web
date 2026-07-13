import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso (userId è consumato dal gate)

const patchBodySchema = z.object({
  student_id: zUuid,
  parent_id: zUuid,
  // Semantica attuale: qualunque valore ≠ false vale true (validato !== false),
  // quindi niente z.boolean(). z.unknown() deve essere .optional() (zod v4:
  // z.unknown() come chiave è required a runtime).
  validato: z.unknown().optional(),
})

// GET /api/admin/sidi/legami?userId=  — elenco associazioni Genitori-Alunni con
// stato di validazione (per la conferma Segreteria prima della Piattaforma Unica).
export const GET = withRoute('admin/sidi/legami:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    try {
      const supabase = await createAdminClient()
      const { data } = await supabase
        .from('student_parents')
        .select('student_id, parent_id, relation_type, is_primary, validato_sidi, alunni(nome, cognome), parents(first_name, last_name, fiscal_code)')
        .order('student_id', { ascending: true })
      return NextResponse.json({ success: true, data: data ?? [] })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/legami:GET', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})

// PATCH /api/admin/sidi/legami?userId=  — valida/invalida un legame (Segreteria).
// body: { student_id, parent_id, validato: boolean }
export const PATCH = withRoute('admin/sidi/legami:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    try {
      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response
      const { student_id, parent_id } = b.data

      const supabase = await createAdminClient()
      const validato = b.data.validato !== false
      const { error } = await supabase
        .from('student_parents')
        .update({ validato_sidi: validato, validato_il: validato ? new Date().toISOString() : null, validato_da: validato ? auth.user.id : null })
        .eq('student_id', student_id)
        .eq('parent_id', parent_id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'legame_sidi',
        entitaId: `${student_id}:${parent_id}`,
        azione: 'update',
        scuolaId: auth.user.scuola_id ?? null,
        valoreDopo: { validato_sidi: validato },
      })
      return NextResponse.json({ success: true })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/legami:PATCH', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})
