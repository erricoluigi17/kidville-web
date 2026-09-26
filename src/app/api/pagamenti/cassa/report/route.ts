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
  aggregaEntratePerCategoria,
  aggregaUscitePerCategoria,
  aggregaMensile,
  costruisciCsvReport,
  type IncassoReportData,
  type UscitaReport,
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

interface IncassoRow {
  id: string
  importo: number | string
  metodo: string
  storno_di: string | null
  data_incasso: string | null
  pagamenti?: {
    scuola_id: string | null
    categoria_id: string | null
    payment_categories?: { id: string; nome: string } | null
  } | null
}

interface MovimentoRow {
  scuola_id: string | null
  importo: number | string
  metodo: string
  data: string | null
  categoria_id: string | null
  cassa_categorie?: { id: string; nome: string } | null
}

const reportVuoto = () =>
  NextResponse.json({ disponibile: false, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [], per_sede: [] })

type IncassoConSede = IncassoReportData & { scuola_id: string }
type UscitaConSede = UscitaReport & { data: string; scuola_id: string | null }

/** I tre aggregati del report su un insieme di righe (tutte le sedi, o una). */
function aggrega(incassi: IncassoReportData[], uscite: (UscitaReport & { data: string })[]) {
  return {
    entrate_per_categoria: aggregaEntratePerCategoria(incassi),
    uscite_per_categoria: aggregaUscitePerCategoria(uscite),
    mensile: aggregaMensile(incassi, uscite.map((u) => ({ importo: u.importo, data: u.data }))),
  }
}

// GET /api/pagamenti/cassa/report?scuola_id&da?&a?&categoria_pagamento_id?&format=csv?
// SOLO DIREZIONE (KPI economici). Entrate per categoria di PAGAMENTO (join incassi →
// pagamenti → payment_categories, tutti i metodi, storni netti — copre «quota Saggio
// per intero» su più mesi); uscite per categoria cassa; riepilogo mensile; export CSV.
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

    // I filtri di sede si applicano SEMPRE: con `sedi` vuoto `.in(…, [])` non
    // restituisce niente (lock `scope-vuoto-nega`: lo scope vuoto nega, non allarga).
    // ── Entrate: incassi delle sedi (via pagamenti!inner) con la categoria di pagamento.
    let incQuery = supabase
      .from('incassi')
      .select('id, importo, metodo, storno_di, data_incasso, pagamenti!inner ( scuola_id, categoria_id, payment_categories ( id, nome ) )')
      .in('pagamenti.scuola_id', sedi)
    if (q.data.da) incQuery = incQuery.gte('data_incasso', q.data.da)
    if (q.data.a) incQuery = incQuery.lte('data_incasso', q.data.a)
    if (q.data.categoria_pagamento_id) incQuery = incQuery.eq('pagamenti.categoria_id', q.data.categoria_pagamento_id)

    const inc = await incQuery
    if (inc.error) {
      if (schemaAssente(inc.error)) {
        logEvento('cassa', 'info', { operazione: 'report:GET', esito: 'schema-assente', sedi: sedi.length })
        return reportVuoto()
      }
      logErrore({ operazione: 'pagamenti/cassa/report:GET', stato: 500, evento: 'db' }, inc.error)
      return NextResponse.json({ error: 'Errore nel recupero delle entrate' }, { status: 500 })
    }

    // ── Uscite: movimenti cassa di tipo 'uscita' (storni inclusi, importo negato).
    let uscQuery = supabase
      .from('cassa_movimenti')
      .select('scuola_id, importo, metodo, data, categoria_id, cassa_categorie ( id, nome )')
      .in('scuola_id', sedi)
      .eq('tipo', 'uscita')
    if (q.data.da) uscQuery = uscQuery.gte('data', q.data.da)
    if (q.data.a) uscQuery = uscQuery.lte('data', q.data.a)

    const usc = await uscQuery
    if (usc.error) {
      if (schemaAssente(usc.error)) {
        logEvento('cassa', 'info', { operazione: 'report:GET', esito: 'schema-assente', sedi: sedi.length })
        return reportVuoto()
      }
      logErrore({ operazione: 'pagamenti/cassa/report:GET', stato: 500, evento: 'db' }, usc.error)
      return NextResponse.json({ error: 'Errore nel recupero delle uscite' }, { status: 500 })
    }

    // Un incasso il cui pagamento non ha sede (dato sporco che `.in('pagamenti.scuola_id', …)`
    // non dovrebbe lasciar passare) non si attribuisce a nessun cassetto: lo si scarta QUI,
    // prima di `aggrega`, così gli aggregati in cima e `per_sede` partono dallo stesso
    // insieme e la somma di `per_sede` coincide con la cima. Stessa regola di movimenti.
    const incassi: IncassoConSede[] = []
    let incassiSenzaSede = 0
    for (const r of (inc.data ?? []) as unknown as IncassoRow[]) {
      const sedeInc = r.pagamenti?.scuola_id
      if (!sedeInc) {
        incassiSenzaSede++
        continue
      }
      incassi.push({
        id: r.id,
        importo: Number(r.importo),
        metodo: r.metodo,
        storno_di: r.storno_di,
        data: r.data_incasso ?? '',
        categoria_id: r.pagamenti?.categoria_id ?? null,
        categoria_nome: r.pagamenti?.payment_categories?.nome ?? null,
        scuola_id: sedeInc,
      })
    }
    if (incassiSenzaSede > 0) {
      logEvento('cassa', 'warn', { operazione: 'pagamenti/cassa/report:GET', esito: 'incassi-senza-sede', quantita: incassiSenzaSede })
    }

    const usciteRows: UscitaConSede[] = ((usc.data ?? []) as unknown as MovimentoRow[]).map((r) => ({
      importo: Number(r.importo),
      metodo: r.metodo,
      data: r.data ?? '',
      categoria_id: r.categoria_id,
      categoria_nome: r.cassa_categorie?.nome ?? null,
      scuola_id: r.scuola_id,
    }))

    const report = aggrega(incassi, usciteRows)

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
    const per_sede = sedi.map((scuolaId) => ({
      scuola_id: scuolaId,
      scuola_nome: nomi.get(scuolaId) ?? null,
      ...aggrega(
        incassi.filter((i) => i.scuola_id === scuolaId),
        usciteRows.filter((u) => u.scuola_id === scuolaId),
      ),
    }))

    return NextResponse.json({ disponibile: true, ...report, per_sede })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/report:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
