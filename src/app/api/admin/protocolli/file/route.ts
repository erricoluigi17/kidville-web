import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { firmaDownload, rispostaErroreProtocollo } from '@/lib/protocolli/server'

// Download dei file protocollati (decisione #10): SEMPRE via URL firmato a
// 300s, mai URL pubblici. Nessun tracciamento dei download (decisione #18).

const getQuerySchema = z
  .object({
    id: zUuid,
    versione: z.enum(['originale', 'timbrato', 'allegato']).default('timbrato'),
    allegatoId: z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional()),
  })
  .superRefine((v, ctx) => {
    if (v.versione === 'allegato' && !v.allegatoId) {
      ctx.addIssue({
        code: 'custom',
        path: ['allegatoId'],
        message: 'allegatoId è obbligatorio per scaricare un allegato',
      })
    }
  })

export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    const { data: record, error } = await supabase
      .from('protocolli')
      .select('id, scuola_id, anno, numero, file_originale, file_timbrato, file_nome_originale')
      .eq('id', q.data.id)
      .in('scuola_id', sedi)
      .maybeSingle()
    if (error) return rispostaErroreProtocollo(error)
    if (!record) {
      return NextResponse.json({ error: 'Registrazione non trovata' }, { status: 404 })
    }
    const r = record as {
      anno: number
      numero: number
      file_originale: string
      file_timbrato: string
      file_nome_originale: string | null
    }

    let path: string
    let nomeDownload: string
    if (q.data.versione === 'allegato') {
      const { data: allegato, error: eAll } = await supabase
        .from('protocolli_allegati')
        .select('path, nome')
        .eq('id', q.data.allegatoId as string)
        .eq('protocollo_id', q.data.id)
        .maybeSingle()
      if (eAll) return rispostaErroreProtocollo(eAll)
      if (!allegato) {
        return NextResponse.json({ error: 'Allegato non trovato' }, { status: 404 })
      }
      path = (allegato as { path: string }).path
      nomeDownload = (allegato as { nome: string }).nome
    } else if (q.data.versione === 'originale') {
      path = r.file_originale
      nomeDownload = r.file_nome_originale ?? `Prot-${String(r.numero).padStart(7, '0')}-${r.anno}-originale`
    } else {
      path = r.file_timbrato
      nomeDownload = `Prot-${String(r.numero).padStart(7, '0')}-${r.anno}.pdf`
    }

    const url = await firmaDownload(supabase, path, nomeDownload)
    return NextResponse.json({ success: true, data: { url } })
  } catch (err) {
    console.error('Errore API GET protocolli/file:', err)
    return rispostaErroreProtocollo(err)
  }
}
