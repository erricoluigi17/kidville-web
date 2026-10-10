import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { RUOLI_DIREZIONE } from '@/lib/auth/predicati-ruolo'
import { sediLetturaCassa, nomiSediCassa } from '@/lib/cassa/lettura-multisede'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import {
  componiReport,
  costruisciCsvReport,
  differenzeTotali,
  type ReportGrezzo,
} from '@/lib/cassa/report'

// Codici PostgREST/Postgres «schema cassa assente» (DB E2E CI non migrato). Copia
// locale della lista canonica di `@/lib/cassa/saldo` per tenere il report — e i suoi
// test — indipendenti dal join con gli altri esecutori; la semantica è identica.
const CASSA_SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])
function schemaAssente(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code
  return !!code && CASSA_SCHEMA_ASSENTE.has(code)
}

const zOpt = <S extends z.ZodType>(s: S) => z.preprocess((v) => v || undefined, s.optional())

const getQuerySchema = z.object({
  scuola_id: zOpt(zUuid),
  da: zOpt(zDataYMD),
  a: zOpt(zDataYMD),
  categoria_pagamento_id: zOpt(zUuid),
  format: z.preprocess((v) => v || undefined, z.enum(['csv']).optional()),
})

const reportVuoto = () =>
  NextResponse.json({ disponibile: false, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [], per_sede: [] })

// GET /api/pagamenti/cassa/report?scuola_id&da?&a?&categoria_pagamento_id?&format=csv?
// SOLO DIREZIONE (KPI economici). Entrate per categoria di PAGAMENTO (metodi reali,
// storni netti — copre «quota Saggio per intero» su più mesi); uscite per categoria
// cassa; riepilogo mensile; export CSV. Dal 2026-10-10 li calcola
// `public.report_cassa_aggregato` in SQL, e la route li verifica contro il SUM piatto.
//
// Dal 2026-09-26 (K3) la lettura è UNITA: senza scuola_id gli aggregati sono sommati
// su tutte le sedi attive e `per_sede` porta gli stessi tre aggregati sede per sede;
// con scuola_id solo quella (per_sede di lunghezza 1); sede non propria → 403. Il
// CSV resta quello degli aggregati in cima (cioè di tutte le sedi lette).
// Contratto: docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/K3.md.
export const GET = withRoute('pagamenti/cassa/report:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, RUOLI_DIREZIONE)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const scope = await sediLetturaCassa(request, supabase, auth.user, q.data.scuola_id, 'pagamenti/cassa/report:GET')
    if (scope.response) return scope.response
    const sedi = scope.sedi

    // Gli aggregati li calcola il database (fase 5 robustezza, 2026-10-10): prima la
    // route leggeva le RIGHE di incassi e movimenti, e PostgREST le taglia a 1000 in
    // silenzio — il 10/10 il report «tutte le sedi» doveva leggerne 1.672. Una RPC che
    // restituisce un valore solo non ha righe da tagliare. Con `sedi` vuoto la funzione
    // non trova niente (lock `scope-vuoto-nega`: lo scope vuoto nega, non allarga).
    const rpc = await supabase.rpc('report_cassa_aggregato', {
      p_scuola_ids: sedi,
      p_da: q.data.da ?? null,
      p_a: q.data.a ?? null,
      p_categoria: q.data.categoria_pagamento_id ?? null,
    })
    if (rpc.error) {
      if (schemaAssente(rpc.error)) {
        logEvento('cassa', 'info', { operazione: 'report:GET', esito: 'schema-assente', sedi: sedi.length })
        return reportVuoto()
      }
      logErrore({ operazione: 'pagamenti/cassa/report:GET', stato: 500, evento: 'db' }, rpc.error)
      return NextResponse.json({ error: 'Errore nel calcolo del report', codice: 'REPORT_CASSA_NON_CALCOLATO' }, { status: 500 })
    }
    const grezzo = rpc.data as ReportGrezzo

    const report = componiReport(grezzo, null)
    const perSedeReport = sedi.map((scuolaId) => ({ scuolaId, ...componiReport(grezzo, scuolaId) }))

    // I totali si verificano contro il SUM piatto della stessa funzione: un report che
    // non quadra non esce, né a schermo né in CSV. Un file incompleto che sembra intero
    // è peggio di un errore.
    const differenze = differenzeTotali(grezzo, report, perSedeReport)
    if (differenze.length > 0) {
      logErrore(
        { operazione: 'pagamenti/cassa/report:GET', stato: 500, evento: 'totali-non-quadrano' },
        new Error(`report di cassa: ${differenze.map((d) => `${d.voce} atteso ${d.atteso} trovato ${d.trovato}`).join('; ')}`),
      )
      return NextResponse.json({ error: 'I totali del report non quadrano', codice: 'REPORT_CASSA_NON_QUADRA' }, { status: 500 })
    }
    logEvento('cassa', 'info', {
      operazione: 'report:GET',
      esito: 'calcolato',
      sedi: sedi.length,
      incassi: Number(grezzo.controllo.incassi),
      movimenti: Number(grezzo.controllo.movimenti),
    })

    if (q.data.format === 'csv') {
      logEvento('cassa', 'info', { operazione: 'report:GET', esito: 'export-csv', sedi: sedi.length })
      return new NextResponse(costruisciCsvReport(report), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="report-cassa.csv"',
          'Cache-Control': 'no-store',
        },
      })
    }

    const nomi = await nomiSediCassa(supabase, sedi, 'pagamenti/cassa/report:GET')
    const per_sede = perSedeReport.map(({ scuolaId, ...aggregati }) => ({
      scuola_id: scuolaId,
      scuola_nome: nomi.get(scuolaId) ?? null,
      ...aggregati,
    }))

    return NextResponse.json({ disponibile: true, ...report, per_sede })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/report:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
