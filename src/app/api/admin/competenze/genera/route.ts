import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { generaCertificato } from '@/lib/competenze/certificato-store'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Id permissivi (niente zUuid: nei test/dati seed circolano id non-UUID).
// Entrambi opzionali: la guardia truthy "almeno uno dei due" resta
// nell'handler (stringa vuota → 400 finale, come oggi).
const postBodySchema = z.object({
  sectionId: z.string().nullish(),
  certificatoId: z.string().nullish(),
})

// POST /api/admin/competenze/genera?userId=
// Genera e FIRMA (FEA applicativa dirigente) il Certificato delle Competenze.
// Riservato alla DIRIGENZA (esclusa la Segreteria), come la chiusura/pubblicazione
// scrutinio. body: { certificatoId } (singolo) | { sectionId } (intera classe quinta).
export const POST = withRoute('admin/competenze/genera:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const supabase = await createAdminClient()

    if (body.sectionId) {
      const { data: certs } = await supabase
        .from('certificati_competenze')
        .select('id')
        .eq('section_id', body.sectionId)
      const ids = ((certs ?? []) as { id: string }[]).map((c) => c.id)
      let generati = 0
      const errori: { certificatoId: string; error: string }[] = []
      for (const id of ids) {
        const { error } = await generaCertificato(supabase, id, auth.user.id, true)
        if (error) errori.push({ certificatoId: id, error })
        else generati++
      }
      return NextResponse.json({ success: true, generati, totale: ids.length, errori })
    }

    if (body.certificatoId) {
      const { pdf, error, status } = await generaCertificato(supabase, body.certificatoId, auth.user.id, true)
      if (error) return NextResponse.json({ error }, { status: status ?? 500 })
      return NextResponse.json({ success: true, bytes: pdf?.length ?? 0 })
    }

    return NextResponse.json({ error: 'certificatoId o sectionId obbligatorio' }, { status: 400 })
  } catch (err) {
    logErrore({ operazione: 'admin/competenze/genera:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
