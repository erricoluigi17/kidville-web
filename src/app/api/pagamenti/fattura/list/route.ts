import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// GET /api/pagamenti/fattura/list?pagamento_id=  — elenco delle fatture (quote)
// emesse per un pagamento. Usato dalla UI quando un pagamento ha PIÙ fatture
// (genitori separati) per offrire un download per intestatario. Staff o genitore
// del bambino (scoping legame_genitori_alunni).

const getQuerySchema = z.object({ pagamento_id: zUuid })

interface RigaFattura {
  id: string
  numero: number
  anno: number
  quota_label: string | null
  quota_adult_id: string | null
  intestatario: { nome?: string; cognome?: string } | null
  pdf_path: string | null
  sdi_stato: number | null
  sdi_stato_label: string | null
}

export const GET = withRoute('pagamenti/fattura/list:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id } = q.data

    const supabase = await createAdminClient()
    const { data: pag } = await supabase
      .from('pagamenti')
      .select('id, alunno_id')
      .eq('id', pagamento_id)
      .maybeSingle()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
    if (!isStaff) {
      const { data: legame } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
        .eq('alunno_id', pag.alunno_id)
        .maybeSingle()
      if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from('fatture_emesse')
      .select('id, numero, anno, quota_label, quota_adult_id, intestatario, pdf_path, sdi_stato, sdi_stato_label')
      .eq('pagamento_id', pagamento_id)
      .order('numero', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Una riga per quota: tengo la più recente (numero massimo), così una quota
    // scartata e poi ri-emessa non compare due volte.
    const perQuota = new Map<string, RigaFattura>()
    for (const r of (data ?? []) as RigaFattura[]) {
      const key = r.quota_adult_id ?? '__single__'
      const cur = perQuota.get(key)
      if (!cur || r.numero >= cur.numero) perQuota.set(key, r)
    }

    const fatture = [...perQuota.values()]
      .sort((a, b) => a.numero - b.numero)
      .map((r) => {
        const intest = r.intestatario ?? {}
        const nome = `${intest.nome ?? ''} ${intest.cognome ?? ''}`.trim()
        return {
          id: r.id,
          numero: r.numero,
          anno: r.anno,
          quota_label: r.quota_label,
          intestatario: nome || r.quota_label || 'Intestatario',
          pdf_disponibile: !!r.pdf_path,
          sdi_stato_label: r.sdi_stato_label,
        }
      })

    return NextResponse.json({ success: true, data: fatture })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura/list:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
