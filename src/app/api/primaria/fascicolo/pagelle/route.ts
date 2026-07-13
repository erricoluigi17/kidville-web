import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  alunnoId: zUuid,
})

// GET /api/primaria/fascicolo/pagelle?alunnoId=&userId=
// Elenco pagelle pubblicate per un alunno, raggruppate per anno scolastico.
// Richiede accesso al fascicolo (docente contitolare o dirigenza).
export const GET = withRoute('primaria/fascicolo/pagelle:GET', async (request: NextRequest) => {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId } = q.data

    const supabase = await createAdminClient()

    // Controllo RBAC fascicolo
    const access = await puoAccedereFascicolo(supabase, userId, alunnoId)
    if (!access.consentito) return NextResponse.json({ error: 'Accesso al fascicolo non autorizzato' }, { status: 403 })

    // Recupera scrutini pubblicati che contengono l'alunno, con il periodo
    const { data: righe, error } = await supabase
      .from('scrutini')
      .select(`
        id,
        chiuso_il,
        pubblicato,
        pubblicato_il,
        scrutinio_periodi(id, anno_scolastico, nome),
        scrutinio_giudizi!inner(alunno_id)
      `)
      .eq('pubblicato', true)
      .eq('scrutinio_giudizi.alunno_id', alunnoId)
      .order('chiuso_il', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    type PeriodoRow = { id: string; anno_scolastico: string; nome: string }
    const pagelle = (righe ?? []).map((r) => {
      const periodo = (Array.isArray(r.scrutinio_periodi) ? r.scrutinio_periodi[0] : r.scrutinio_periodi) as PeriodoRow | undefined
      return {
        scrutinioId: r.id,
        annoScolastico: periodo?.anno_scolastico ?? '—',
        periodoNome: periodo?.nome ?? '—',
        dataChiusura: r.chiuso_il,
        dataPubblicazione: r.pubblicato_il,
      }
    })

    // Raggruppa per anno scolastico
    const perAnno: Record<string, typeof pagelle> = {}
    for (const p of pagelle) {
      if (!perAnno[p.annoScolastico]) perAnno[p.annoScolastico] = []
      perAnno[p.annoScolastico].push(p)
    }

    const anniOrdinati = Object.keys(perAnno).sort((a, b) => b.localeCompare(a))
    const data = anniOrdinati.map((anno) => ({ annoScolastico: anno, pagelle: perAnno[anno] }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'primaria/fascicolo/pagelle:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
