import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { buildReceiptPdf } from '@/lib/fea/receipt-pdf'
import { parseQuery } from '@/lib/validation/http'
import type { ReceiptPayload, SignatureLog } from '@/lib/fea/types'

// GET /api/fea/receipt?entita=pagella|giustifica|forms&id=<entitaId>&userId=
// Ricevuta di firma inattaccabile on-demand (FEA in-house, DL-001). Servita solo
// al firmatario. Nessuna persistenza: il PDF è rigenerato deterministicamente.

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `id` resta stringa libera (min 1): oggi un id malformato non produce 400 ma
// 404 "Firma non trovata" (la query non trova righe) — zUuid sarebbe più
// severo del comportamento attuale.
const getQuerySchema = z.object({
  entita: z.enum(['pagella', 'giustifica', 'forms'], { error: 'Parametro entita non valido' }),
  id: z.string({ error: 'Parametro id obbligatorio' }).min(1, 'Parametro id obbligatorio'),
})

type Entita = z.infer<typeof getQuerySchema>['entita']

interface Resolved {
  signerId: string | null
  signature: SignatureLog | null
  documentPayload: unknown
  title: string
}

async function resolveEntita(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  entita: Entita,
  id: string
): Promise<Resolved | null> {
  if (entita === 'pagella') {
    const { data } = await supabase.from('pagella_ricezioni').select('*').eq('id', id).maybeSingle()
    if (!data) return null
    return {
      signerId: data.genitore_id ?? null,
      signature: (data.firma as SignatureLog) ?? null,
      documentPayload: { scrutinio_id: data.scrutinio_id, alunno_id: data.alunno_id },
      title: 'Ricevuta di firma — Pagella',
    }
  }
  if (entita === 'giustifica') {
    const { data } = await supabase.from('presenze').select('*').eq('id', id).maybeSingle()
    if (!data) return null
    return {
      signerId: data.giustificata_da ?? null,
      signature: (data.giustificazione_firma as SignatureLog) ?? null,
      documentPayload: { alunno_id: data.alunno_id, data: data.data, motivo: data.giustificazione_testo },
      title: 'Ricevuta di firma — Giustifica assenza',
    }
  }
  // forms
  const { data } = await supabase.from('forms_submissions').select('*').eq('id', id).maybeSingle()
  if (!data) return null
  return {
    signerId: data.parent_id ?? null,
    signature: (data.signature_log as SignatureLog) ?? null,
    documentPayload: data.answers,
    title: 'Ricevuta di firma — Modulo',
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { entita, id } = q.data

    const supabase = await createAdminClient()
    const resolved = await resolveEntita(supabase, entita, id)
    if (!resolved || !resolved.signature) {
      return NextResponse.json({ error: 'Firma non trovata' }, { status: 404 })
    }

    // Scope: solo il firmatario può scaricare la propria ricevuta.
    if (resolved.signerId && resolved.signerId !== userId) {
      return NextResponse.json({ error: 'Accesso non consentito' }, { status: 403 })
    }

    const payload: ReceiptPayload = {
      title: resolved.title,
      entitaTipo: entita,
      entitaId: id,
      signer: { email: resolved.signature.email },
      signature: resolved.signature,
      documentPayload: resolved.documentPayload,
    }
    const pdf = buildReceiptPdf(payload)

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ricevuta-${entita}-${id.slice(0, 8)}.pdf"`,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
