import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId, loadAppUser } from '@/lib/auth/require-staff'
import { generaPagella } from '@/lib/primaria/pagella-store'

// GET /api/primaria/pagella?scrutinioId=&alunnoId=&userId=[&persist=1]
// Genera (e opzionalmente archivia) il PDF della pagella e lo restituisce.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const scrutinioId = sp.get('scrutinioId')
    const alunnoId = sp.get('alunnoId')
    const persist = sp.get('persist') === '1'
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!scrutinioId || !alunnoId) return NextResponse.json({ error: 'scrutinioId e alunnoId obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()

    // Gate visibilità: lo staff (admin/coordinator) può generare/anteprima anche
    // prima della pubblicazione; gli altri (genitori) solo se pubblicato.
    const appUser = await loadAppUser(userId)
    const isStaff = appUser?.role === 'admin' || appUser?.role === 'coordinator'
    if (!isStaff) {
      const { data: scr } = await supabase.from('scrutini').select('pubblicato').eq('id', scrutinioId).single()
      if (!scr?.pubblicato) return NextResponse.json({ error: 'Pagella non ancora pubblicata' }, { status: 403 })
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
