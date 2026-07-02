import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { CERTIFICATI_BUCKET } from '@/lib/competenze/certificato-store'

// GET /api/admin/competenze/download?certificatoId=&userId=
// URL firmato del PDF del certificato (lato staff/dirigenza).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const certificatoId = new URL(request.url).searchParams.get('certificatoId')
    if (!certificatoId) return NextResponse.json({ error: 'certificatoId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: cert } = await supabase
      .from('certificati_competenze')
      .select('file_url')
      .eq('id', certificatoId)
      .maybeSingle()
    if (!cert?.file_url) return NextResponse.json({ error: 'Certificato non ancora generato' }, { status: 404 })

    const { data: signed } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(cert.file_url, 600)
    if (!signed?.signedUrl) return NextResponse.json({ error: 'URL non disponibile' }, { status: 500 })
    return NextResponse.json({ success: true, url: signed.signedUrl })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
