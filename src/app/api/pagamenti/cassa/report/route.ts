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
import { applicaCartaIntestata } from '@/lib/carta'
import { costruisciConteggioPdf, differenzeConteggio } from '@/lib/cassa/stampa'
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
  format: z.preprocess((v) => v || undefined, z.enum(['csv', 'pdf']).optional()),
  scarica: zOpt(z.literal('1')),
  raggruppamento: zOpt(z.enum(['totale', 'categoria'])),
}).refine((q) => q.format !== 'pdf' || !!q.raggruppamento, { message: 'Scegli il tipo di conteggio', path: ['raggruppamento'] })
  .refine((q) => !q.da || !q.a || q.da <= q.a, { message: 'Periodo non valido', path: ['a'] })

const totaliConteggioSchema = z.object({
  entrate: z.number().finite(), uscite: z.number().finite(), prelievi: z.number().finite(), rettifiche: z.number().finite(), netto: z.number().finite(),
})
const conteggioSchema = z.object({
  righe: z.array(totaliConteggioSchema.extend({ scuola_id: zUuid, cassa_categoria_id: zUuid.nullable(), cassa_nome: z.string().nullable() }).refine((r) => r.cassa_categoria_id === null || !!r.cassa_nome?.trim(), { message: 'Nome categoria assente' })),
  totali: totaliConteggioSchema,
})

const reportVuoto = () =>
  NextResponse.json({ disponibile: false, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [], per_sede: [] })

// GET /api/pagamenti/cassa/report?scuola_id&da?&a?&categoria_pagamento_id?&format=csv|pdf
// PDF: raggruppamento=totale|categoria; conteggio CONTANTI per provenienza,
// senza fondo iniziale. La RPC cash gestisce gli originali fuori periodo negli storni.
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

    if (q.data.format === 'pdf') {
      const nomi = await nomiSediCassa(supabase, sedi, 'pagamenti/cassa/report:GET')
      // Nessun documento parziale quando il DB non è ancora migrato o i nomi
      // delle sedi non sono leggibili: l'utente deve poter identificare ogni cassa.
      const contanti = await supabase.rpc('conteggio_cassa_provenienza', {
        p_scuola_ids: sedi, p_da: q.data.da ?? null, p_a: q.data.a ?? null,
      })
      if (contanti.error) {
        logErrore({ operazione: 'pagamenti/cassa/report:GET', evento: 'conteggio-contanti-db', stato: schemaAssente(contanti.error) ? 503 : 500 }, contanti.error)
        return NextResponse.json({ error: 'Impossibile calcolare il conteggio contanti', codice: 'CONTEGGIO_CASSA_NON_DISPONIBILE' }, { status: schemaAssente(contanti.error) ? 503 : 500 })
      }
      const parsed = conteggioSchema.safeParse(contanti.data)
      // Verifica lo scope anche sul risultato: la service-role non applica RLS.
      const nonValido = !parsed.success || parsed.data.righe.some((r) => !sedi.includes(r.scuola_id))
      if (nonValido || (parsed.success && differenzeConteggio(parsed.data).length > 0)) {
        logErrore({ operazione: 'pagamenti/cassa/report:GET', evento: 'conteggio-non-quadra', stato: 500 }, new Error('Conteggio contanti non valido o non coerente'))
        return NextResponse.json({ error: 'I totali del conteggio non quadrano', codice: 'CONTEGGIO_CASSA_NON_QUADRA' }, { status: 500 })
      }
      if (!parsed.success) throw new Error('Conteggio non valido')
      if (sedi.some((id) => !nomi.get(id))) {
        logErrore({ operazione: 'pagamenti/cassa/report:GET', evento: 'conteggio-nomi-sedi', stato: 503 }, new Error('Nomi sedi non disponibili per la stampa'))
        return NextResponse.json({ error: 'Impossibile identificare le sedi del conteggio. Riprova.', codice: 'CONTEGGIO_SEDI_NON_DISPONIBILI' }, { status: 503 })
      }
      const categoriaId = q.data.raggruppamento === 'categoria' ? q.data.categoria_pagamento_id : undefined
      let categoriaNome = categoriaId ? parsed.data.righe.find((r) => r.cassa_categoria_id === categoriaId)?.cassa_nome ?? undefined : undefined
      // Una categoria senza flussi deve essere identificata anche sul PDF a zero.
      // Lookup singolo: non legge movimenti e non dipende dal limite PostgREST.
      if (categoriaId && !categoriaNome) {
        const categoria = await supabase.from('payment_categories').select('id, nome, scuola_id').eq('id', categoriaId).maybeSingle()
        if (categoria.error || !categoria.data?.nome) {
          logErrore({ operazione: 'pagamenti/cassa/report:GET', evento: 'conteggio-categoria-non-letta', stato: categoria.error ? 500 : 404 }, categoria.error ?? new Error('Categoria non trovata'))
          return NextResponse.json({ error: 'Categoria del conteggio non disponibile', codice: 'CONTEGGIO_CASSA_NON_DISPONIBILE' }, { status: categoria.error ? 500 : 404 })
        }
        if (categoria.data.scuola_id && !sedi.includes(categoria.data.scuola_id)) {
          logEvento('multi_sede', 'warn', { operazione: 'pagamenti/cassa/report:GET', esito: 'categoria-conteggio-fuori-scope', sedi: sedi.length })
          return NextResponse.json({ error: 'Categoria non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, { status: 403 })
        }
        categoriaNome = categoria.data.nome
      }
      const contenuto = costruisciConteggioPdf({
        conteggio: parsed.data,
        raggruppamento: q.data.raggruppamento!,
        categoriaId, categoriaNome,
        da: q.data.da, a: q.data.a,
        sedi: sedi.map((id) => ({ id, nome: nomi.get(id)! })),
      })
      const pdf = await applicaCartaIntestata(new Uint8Array(contenuto))
      logEvento('cassa', 'info', { operazione: 'report:GET', esito: 'export-pdf', sedi: sedi.length, quantita: pdf.byteLength })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `${q.data.scarica ? 'attachment' : 'inline'}; filename="conteggio-cassa.pdf"`,
          'Cache-Control': 'private, no-store',
        },
      })
    }


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
