import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity, loadAppUser } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { generaPagella } from '@/lib/primaria/pagella-store'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const getQuerySchema = z.object({
  scrutinioId: zUuid,
  alunnoId: zUuid,
  // Flag storico: attivo SOLO con '1' (qualsiasi altro valore = false).
  persist: z.string().optional(),
})

// GET /api/primaria/pagella?scrutinioId=&alunnoId=&userId=[&persist=1]
// Genera (e opzionalmente archivia) il PDF della pagella e lo restituisce.
export async function GET(request: NextRequest) {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scrutinioId, alunnoId } = q.data
    const persist = q.data.persist === '1'

    const supabase = await createAdminClient()

    // Gate visibilità: lo staff (admin/coordinator/segreteria) può generare/anteprima
    // anche prima della pubblicazione, ma SOLO per gli alunni del proprio plesso;
    // il genitore solo se pubblicato E dopo aver firmato la ricezione (OTP/FES).
    const appUser = await loadAppUser(userId)
    const isStaff = !!appUser && ['admin', 'coordinator', 'segreteria'].includes(appUser.role)
    if (isStaff) {
      const scopeErr = await assertAlunnoInScope(supabase, appUser, alunnoId)
      if (scopeErr) return scopeErr
      // Lo scrutinio deve essere quello della classe dell'alunno: blocca scrutinioId
      // di altre sezioni/plessi (leak dati nel PDF, persist incoerente).
      const { data: scr } = await supabase.from('scrutini').select('section_id').eq('id', scrutinioId).maybeSingle()
      if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
      const coerenzaErr = await assertAlunniInSezione(supabase, [alunnoId], scr.section_id as string)
      if (coerenzaErr) return coerenzaErr
    } else {
      const { data: scr } = await supabase.from('scrutini').select('pubblicato').eq('id', scrutinioId).maybeSingle()
      if (!scr?.pubblicato) return NextResponse.json({ error: 'Pagella non ancora pubblicata' }, { status: 403 })
      const { data: firma } = await supabase
        .from('pagella_ricezioni')
        .select('id')
        .eq('scrutinio_id', scrutinioId)
        .eq('alunno_id', alunnoId)
        .eq('genitore_id', userId)
        .maybeSingle()
      if (!firma) return NextResponse.json({ error: 'Firma di ricezione richiesta' }, { status: 403 })
    }

    const { pdf, error, status } = await generaPagella(supabase, scrutinioId, alunnoId, userId, persist)
    if (error) return NextResponse.json({ error }, { status: status ?? 500 })

    return new NextResponse(new Uint8Array(pdf!), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="pagella-${alunnoId.slice(0, 8)}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
