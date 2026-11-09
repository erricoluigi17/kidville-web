import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/db/guasto'
import { eInArrivo } from '@/lib/alunni/stato'

/** L'incorporata `alunni!inner` è un oggetto; per prudenza si accetta anche un elenco di uno. */
function unoSolo<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined
}
function senzaStato(v: unknown): unknown {
  const uno = unoSolo<Record<string, unknown>>(v)
  if (!uno || typeof uno !== 'object') return v
  const { stato: _stato, ...resto } = uno
  void _stato
  return resto
}

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
      // Isolamento per sede: l'elenco porta nome e cognome dei minori e CODICE
      // FISCALE dei genitori. `!inner` perché il filtro sull'alunno embedded
      // scarti davvero la riga di legame.
      const plessi = await resolveScuoleAttive(request, supabase, auth.user)
      const { data, error } = await supabase
        .from('student_parents')
        .select('student_id, parent_id, relation_type, is_primary, validato_sidi, alunni!inner(nome, cognome, scuola_id, stato), parents(first_name, last_name, fiscal_code)')
        .in('alunni.scuola_id', plessi)
        .order('student_id', { ascending: true })
      // È l'elenco da confermare prima della Piattaforma Unica: un guasto non è «nessun legame».
      if (error) return rispostaGuastoDb('admin/sidi/legami:GET', 'db:student_parents', error)
      // Al Ministero si comunicano i frequentanti: i genitori di un bambino «in arrivo» (la domanda è per l'anno dopo) non sono
      // da confermare adesso. Il filtro è qui e non in query perché uno stato vuoto (NULL) deve restare. Lo stato serve a
      // questo e non alla segreteria: non esce.
      const legami = ((data ?? []) as unknown as Array<{ alunni: unknown }>)
        .filter((r) => !eInArrivo(unoSolo<{ stato?: string | null }>(r.alunni)?.stato))
        .map((r) => ({ ...r, alunni: senzaStato(r.alunni) }))
      return NextResponse.json({ success: true, data: legami })
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

      // Isolamento per sede sulla SCRITTURA: `student_id` arriva dal client, e
      // senza verifica si validava (o invalidava) il legame genitore↔figlio di
      // una famiglia di un'altra sede.
      const fuoriScope = await assertAlunnoInScope(supabase, auth.user, student_id)
      if (fuoriScope) return fuoriScope

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
        entitaId: student_id,
        azione: 'update',
        scuolaId: auth.user.scuola_id ?? null,
        valoreDopo: { student_id, parent_id, validato_sidi: validato },
      })
      return NextResponse.json({ success: true })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/legami:PATCH', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})
