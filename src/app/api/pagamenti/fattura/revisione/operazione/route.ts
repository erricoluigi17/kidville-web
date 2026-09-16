import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const OPERAZIONE = 'pagamenti/fattura/revisione/operazione:POST'
const CODICI_SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])

const salvaSchema = z.object({
  azione: z.literal('salva'),
  scuola_id: zUuid,
  fattura_id: zUuid,
  modalita: z.enum(['ordinaria', 'quote_separate', 'irrisolta']),
  parent_registry_id: zUuid.nullable(),
}).strict()

const attivaSchema = z.object({
  azione: z.literal('attiva'),
  scuola_id: zUuid,
  irrisolte_previste: z.array(zUuid),
}).strict()

const bodySchema = z.discriminatedUnion('azione', [salvaSchema, attivaSchema])
  .superRefine((body, ctx) => {
    if (body.azione === 'salva'
      && body.modalita === 'quote_separate'
      && body.parent_registry_id === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['parent_registry_id'],
        message: 'Il genitore è obbligatorio per le quote separate',
      })
    }
  })

function noStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function codiceErrore(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
}

function messaggioErrore(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message.toLowerCase()
    : ''
}

function erroreLettura(error: unknown, status: 500 | 503): NextResponse {
  logErrore({ operazione: OPERAZIONE, stato: status, evento: 'db' }, error)
  return json(
    {
      error: 'Non siamo riusciti a leggere i dati. Riprova fra poco.',
      codice: 'LETTURA_FALLITA',
    },
    status,
  )
}

function erroreRpc(error: unknown): NextResponse {
  const messaggio = messaggioErrore(error)
  if (messaggio.includes('fattura già finalizzata') || messaggio.includes('sede già attiva')) {
    return json({
      error: 'Questa revisione non è più modificabile: ricarica lo stato delle fatture.',
      codice: 'FATTURA_REVISIONE_IMMUTABILE',
    }, 409)
  }
  if (messaggio.includes('anteprima irrisolte cambiata')
    || messaggio.includes('finalizzazione concorrente non riuscita')) {
    return json({
      error: 'L’anteprima delle fatture irrisolte è cambiata: ricaricala prima di attivare.',
      codice: 'FATTURA_ANTEPRIMA_CAMBIATA',
    }, 409)
  }
  if (messaggio.includes('fatture null senza revisione verificata')) {
    return json({
      error: 'La verifica dello storico non è completa: classifica tutte le fatture prima di attivare.',
      codice: 'FATTURA_REVISIONI_INCOMPLETE',
    }, 409)
  }
  return erroreLettura(error, CODICI_SCHEMA_ASSENTE.has(codiceErrore(error)) ? 503 : 500)
}

function stessoUuid(a: unknown, b: unknown): boolean {
  return typeof a === 'string'
    && typeof b === 'string'
    && a.toLowerCase() === b.toLowerCase()
}

export const POST = withRoute('pagamenti/fattura/revisione/operazione:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria'])
    if (auth.response) return noStore(auth.response)

    const parsed = await parseBody(request, bodySchema)
    if ('response' in parsed) return noStore(parsed.response)
    const body = parsed.data

    const supabase = await createAdminClient()
    const sede = await resolveScuolaScrittura(
      request as NextRequest,
      supabase,
      auth.user,
      body.scuola_id,
    )
    if (sede.response) return noStore(sede.response)
    const scuolaId = sede.scuolaId as string

    if (body.azione === 'salva') {
      const { data: fattura, error: erroreFattura } = await supabase
        .from('fatture_emesse')
        .select('id, pagamento_id, scuola_id')
        .eq('id', body.fattura_id)
        .maybeSingle()

      if (erroreFattura) {
        return erroreLettura(
          erroreFattura,
          CODICI_SCHEMA_ASSENTE.has(codiceErrore(erroreFattura)) ? 503 : 500,
        )
      }
      if (!fattura || !stessoUuid(fattura.scuola_id, scuolaId)) {
        return json({
          error: 'Nessuna fattura corrisponde a questa richiesta: ricarica l’elenco delle fatture e riprova.',
          codice: 'FATTURA_NON_TROVATA',
        }, 404)
      }

      const fuoriScope = await assertPagamentoInScope(
        supabase,
        auth.user,
        fattura.pagamento_id as string,
      )
      if (fuoriScope) return noStore(fuoriScope)

      const { data, error } = await supabase.rpc('fatture_visibilita_salva_revisione', {
        p_scuola_id: scuolaId,
        p_fattura_id: body.fattura_id,
        p_modalita: body.modalita,
        p_parent_registry_id: body.parent_registry_id,
        p_verificata_da: auth.user.id,
      })
      if (error) return erroreRpc(error)

      const esitoRpc = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {}
      logEvento('fattura', 'info', {
        operazione: OPERAZIONE,
        esito: 'revisione-salvata',
        scuola_id: scuolaId,
        fattura_id: body.fattura_id,
        modalita: body.modalita,
        finalizzata: esitoRpc.finalizzata === true,
      })
      return json({ success: true, data })
    }

    const { data, error } = await supabase.rpc('fatture_visibilita_attiva', {
      p_scuola_id: scuolaId,
      p_irrisolte_previste: body.irrisolte_previste,
      p_verificata_da: auth.user.id,
    })
    if (error) return erroreRpc(error)

    const esitoRpc = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {}
    logEvento('fattura', 'info', {
      operazione: OPERAZIONE,
      esito: 'visibilita-attivata',
      scuola_id: scuolaId,
      irrisolte_previste: body.irrisolte_previste.length,
      finalizzate: typeof esitoRpc.finalizzate === 'number' ? esitoRpc.finalizzate : null,
      irrisolte: typeof esitoRpc.irrisolte === 'number' ? esitoRpc.irrisolte : null,
    })
    return json({ success: true, data })
  } catch (error) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, error)
    return json({ error: 'Internal Server Error' }, 500)
  }
})
