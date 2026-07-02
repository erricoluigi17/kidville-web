import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { CERTIFICATI_BUCKET } from '@/lib/competenze/certificato-store'
import { parseQuery } from '@/lib/validation/http'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (getRequestUserId), non qui.
// studentId permissivo (stringa non vuota): oggi nessun vincolo di formato
// (in dev/test circolano id non-UUID).
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

// Verifica che il figlio sia collegato al genitore (modello autoritativo
// student_parents + ponte legacy legame_genitori_alunni). Scoping app-level
// coerente con le altre letture parent (identità via header finché S13 non sigilla).
async function parentOwnsStudent(supabase: SupabaseClient, userId: string, studentId: string): Promise<boolean> {
  const { data: leg } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', userId)
    .eq('alunno_id', studentId)
  if ((leg ?? []).length > 0) return true
  const { data: sp } = await supabase
    .from('student_parents')
    .select('student_id')
    .eq('parent_id', userId)
    .eq('student_id', studentId)
  return (sp ?? []).length > 0
}

// GET /api/parent/competenze?studentId=&userId=
// Certificati delle Competenze del figlio (solo generati/firmati), con URL di
// download firmato. Nessun leak: se il figlio non è collegato, lista vuota.
export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const supabase = await createAdminClient()
    if (!(await parentOwnsStudent(supabase, userId, studentId))) {
      return NextResponse.json({ success: true, data: [] })
    }

    const { data: certs } = await supabase
      .from('certificati_competenze')
      .select('id, stato, anno_scolastico, file_url')
      .eq('alunno_id', studentId)
      .in('stato', ['generato', 'firmato'])
      .order('created_at', { ascending: false })

    const out = []
    for (const c of (certs ?? []) as { id: string; stato: string; anno_scolastico: string; file_url: string | null }[]) {
      let downloadUrl: string | null = null
      if (c.file_url) {
        const { data: signed } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(c.file_url, 600)
        downloadUrl = signed?.signedUrl ?? null
      }
      out.push({ id: c.id, anno: c.anno_scolastico, stato: c.stato, downloadUrl })
    }
    return NextResponse.json({ success: true, data: out })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
