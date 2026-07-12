import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sha256Impronta } from '@/lib/protocolli/store'
import { rispostaErroreProtocollo, scaricaProtocolloBytes } from '@/lib/protocolli/server'

// «Verifica integrità» (decisione #11): ricalcola l'impronta del file
// originale archiviato e la confronta con quella registrata (art. 53).

const postBodySchema = z.object({ id: zUuid })

export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    const { data: record, error } = await supabase
      .from('protocolli')
      .select('id, file_originale, impronta_sha256')
      .eq('id', b.data.id)
      .in('scuola_id', sedi)
      .maybeSingle()
    if (error) return rispostaErroreProtocollo(error)
    if (!record) {
      return NextResponse.json({ error: 'Registrazione non trovata' }, { status: 404 })
    }
    const r = record as { file_originale: string; impronta_sha256: string }

    const bytes = await scaricaProtocolloBytes(supabase, r.file_originale)
    const improntaCalcolata = sha256Impronta(bytes)

    return NextResponse.json({
      success: true,
      data: {
        integro: improntaCalcolata === r.impronta_sha256,
        improntaRegistrata: r.impronta_sha256,
        improntaCalcolata,
      },
    })
  } catch (err) {
    console.error('Errore API POST protocolli/verifica:', err)
    return rispostaErroreProtocollo(err)
  }
}
