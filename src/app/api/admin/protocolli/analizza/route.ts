import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import {
  MIME_AMMESSI,
  PROTOCOLLO_MAX_BYTES,
  PROTOCOLLO_MAX_MB,
  SCHEMA_MANCANTE,
  sha256Impronta,
} from '@/lib/protocolli/store'
import { estraiTesto, suggerisciCampi, type CampiSuggeriti } from '@/lib/protocolli/estrai'
import { formatNumeroProtocollo } from '@/lib/protocolli/segnatura'
import {
  pareUnPdf,
  rispostaErroreProtocollo,
  scaricaProtocolloBytes,
  zStagingPath,
} from '@/lib/protocolli/server'

// Analisi del file in staging PRIMA della registrazione (decisioni #8 e #17):
// impronta SHA-256, avviso duplicato NON bloccante, campi suggeriti dalle
// euristiche sul testo del PDF. Mai un 500 per un'estrazione fallita: le
// scansioni restituiscono semplicemente suggerimenti vuoti.

const postBodySchema = z.object({
  stagingPath: zStagingPath,
  mime: z.enum(MIME_AMMESSI),
})

export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const bytes = await scaricaProtocolloBytes(supabase, b.data.stagingPath)
    if (bytes.byteLength > PROTOCOLLO_MAX_BYTES) {
      return NextResponse.json(
        { error: `File troppo grande (max ${PROTOCOLLO_MAX_MB} MB)` },
        { status: 400 }
      )
    }

    const impronta = sha256Impronta(bytes)

    // Duplicato (decisione #17): avviso informativo, mai bloccante.
    let duplicato: {
      id: string
      numeroFormattato: string
      dataRegistrazione: string
      oggetto: string
    } | null = null
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    if (sedi.length > 0) {
      const { data, error } = await supabase
        .from('protocolli')
        .select('id, anno, numero, data_registrazione, oggetto')
        .in('scuola_id', sedi)
        .eq('impronta_sha256', impronta)
        .order('data_registrazione', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!error && data) {
        const d = data as {
          id: string
          anno: number
          numero: number
          data_registrazione: string
          oggetto: string
        }
        duplicato = {
          id: d.id,
          numeroFormattato: formatNumeroProtocollo(d.numero, d.anno),
          dataRegistrazione: d.data_registrazione,
          oggetto: d.oggetto,
        }
      } else if (error && !SCHEMA_MANCANTE.has(error.code ?? '')) {
        console.error('Controllo duplicati protocollo non riuscito:', error.message)
      }
    }

    // Suggerimenti (decisione #8): solo sui PDF con testo; scansioni → {}.
    let suggerimenti: CampiSuggeriti = {}
    if (b.data.mime === 'application/pdf' && pareUnPdf(bytes)) {
      suggerimenti = suggerisciCampi(await estraiTesto(bytes))
    }

    return NextResponse.json({ success: true, data: { impronta, duplicato, suggerimenti } })
  } catch (err) {
    console.error('Errore API POST protocolli/analizza:', err)
    return rispostaErroreProtocollo(err)
  }
}
