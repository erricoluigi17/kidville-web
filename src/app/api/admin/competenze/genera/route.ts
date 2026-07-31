import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { generaCertificato } from '@/lib/competenze/certificato-store'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

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
      // Isolamento per sede. PR #60 aveva messo `assertSezioneInScope` nelle due
      // letture (`admin/competenze` e `admin/competenze/download`) e aveva
      // dimenticato PROPRIO questa, che è la sola delle tre che SCRIVE e FIRMA:
      // conoscendo l'uuid di una quinta di un altro plesso, la Direzione ne
      // generava i certificati delle competenze e ci apponeva la firma
      // elettronica del dirigente. Il gate va PRIMA della query, non dopo.
      const fuoriScopeSez = await assertSezioneInScope(supabase, auth.user, body.sectionId)
      if (fuoriScopeSez) return fuoriScopeSez

      const { data: certs, error: errCerts } = await supabase
        .from('certificati_competenze')
        .select('id')
        .eq('section_id', body.sectionId)
      if (errCerts) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // diventerebbe «0 certificati generati», indistinguibile da «la classe
        // non ne ha».
        logEvento('db', 'error', { operazione: 'admin/competenze/genera:POST', esito: 'elenco-non-letto' }, errCerts)
        return NextResponse.json({ error: 'Lettura dei certificati non riuscita' }, { status: 500 })
      }
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
      // Stesso gate sul ramo singolo, risolvendo la sezione DAL certificato —
      // com'è già in `admin/competenze/download/route.ts:39`.
      const { data: cert, error: errCert } = await supabase
        .from('certificati_competenze')
        .select('id, section_id')
        .eq('id', body.certificatoId)
        .maybeSingle()
      if (errCert) {
        logEvento('db', 'error', { operazione: 'admin/competenze/genera:POST', esito: 'certificato-non-letto' }, errCert)
        return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
      }
      if (!cert) return NextResponse.json({ error: 'Certificato non trovato' }, { status: 404 })
      const fuoriScopeCert = await assertSezioneInScope(supabase, auth.user, cert.section_id as string)
      if (fuoriScopeCert) return fuoriScopeCert

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
