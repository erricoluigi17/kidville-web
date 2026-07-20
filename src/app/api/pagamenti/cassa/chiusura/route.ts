import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { getModuleConfig } from '@/lib/settings/module-config'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { caricaSaldoCassa, CASSA_SCHEMA_ASSENTE } from '@/lib/cassa/saldo'
import { verificaSogliaCassa } from '@/lib/cassa/notifiche'
import type { CassaChiusura } from '@/lib/cassa/tipi'

const getQuerySchema = z.object({
  scuola_id: z.preprocess((v) => v || undefined, zUuid.optional()),
})

// Il client manda SOLO il contato: il saldo atteso lo calcola il server (non ci si
// fida di un valore economico spedito dal browser).
const postBodySchema = z.object({
  scuola_id: z.preprocess((v) => v || undefined, zUuid.optional()),
  contato: z.coerce.number().min(0, 'Il totale contato non può essere negativo'),
  note: z.string().max(2000).nullish(),
})

function schemaAssente(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code
  return !!code && CASSA_SCHEMA_ASSENTE.has(code)
}

const round2 = (n: number) => Math.round(n * 100) / 100

// GET /api/pagamenti/cassa/chiusura?scuola_id=  — SOLO admin: storico svuotamenti.
export const GET = withRoute('pagamenti/cassa/chiusura:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin'])
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { data, error } = await supabase
      .from('cassa_chiusure')
      .select('*')
      .eq('scuola_id', scuolaId)
      .order('eseguita_il', { ascending: false })
    if (error) {
      if (schemaAssente(error)) {
        logEvento('cassa', 'info', { operazione: 'chiusura:GET', esito: 'schema-assente', scuola_id: scuolaId })
        return NextResponse.json({ disponibile: false, chiusure: [] })
      }
      logErrore({ operazione: 'pagamenti/cassa/chiusura:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle chiusure' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, chiusure: (data ?? []) as CassaChiusura[] })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/chiusura:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/cassa/chiusura  — SOLO admin: svuotamento con conteggio.
// Il saldo atteso è calcolato SERVER-side; la RPC atomica registra la chiusura +
// gli eventuali movimenti (rettifica di differenza + prelievo di svuotamento).
export const POST = withRoute('pagamenti/cassa/chiusura:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin'])
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    // Type-literal inline (non `CassaConfig`): un'interface non soddisfa il vincolo
    // `Record<string,unknown>` di getModuleConfig; qui serve solo il fondo.
    const config = await getModuleConfig<{ fondo?: number }>(supabase, 'cassa_config', scuolaId)
    const fondo = config.fondo ?? 0
    const contato = round2(body.contato)

    // Saldo atteso SERVER-side (fonte unica: caricaSaldoCassa). Schema assente → 503.
    const saldo = await caricaSaldoCassa(supabase, scuolaId, fondo)
    if (!saldo.disponibile) {
      return NextResponse.json({ disponibile: false }, { status: 503 })
    }
    const saldoAtteso = saldo.saldo_atteso

    const rpc = await supabase.rpc('registra_chiusura_cassa', {
      p_scuola_id: scuolaId,
      p_saldo_atteso: saldoAtteso,
      p_contato: contato,
      p_fondo: fondo,
      p_note: body.note ?? null,
      p_eseguita_da: user.id,
    })
    if (rpc.error) {
      if (schemaAssente(rpc.error)) {
        logEvento('cassa', 'info', { operazione: 'chiusura:POST', esito: 'schema-assente', scuola_id: scuolaId })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/cassa/chiusura:POST', stato: 500, evento: 'db' }, rpc.error)
      return NextResponse.json({ error: 'Errore durante la chiusura di cassa' }, { status: 500 })
    }

    const out = (rpc.data ?? {}) as { chiusura_id?: string; differenza?: number; prelevato?: number }
    const differenza = round2(Number(out.differenza ?? contato - saldoAtteso))
    const prelevato = round2(Number(out.prelevato ?? Math.max(contato - fondo, 0)))
    const fondoLasciato = round2(Math.min(contato, fondo))

    // Audit contabile — SOLO numeri (nessun testo libero: privacy).
    const { error: auditErr } = await supabase.from('registro_modifiche').insert({
      azione: 'cassa_chiusura',
      tabella_interessata: 'cassa_chiusure',
      record_id: out.chiusura_id ?? null,
      nuovo_valore: { saldo_atteso: saldoAtteso, contato, differenza, prelevato, fondo_lasciato: fondoLasciato },
      utente_id: user.id,
    })
    if (auditErr) {
      logEvento('cassa', 'warn', { operazione: 'chiusura:POST', esito: 'audit-non-scritto', scuola_id: scuolaId }, auditErr)
    }

    // Evento critico: logga il SUCCESSO (numeri whitelisted, MAI le note).
    logEvento('cassa', 'info', {
      operazione: 'chiusura:POST',
      esito: 'eseguita',
      chiusura_id: out.chiusura_id,
      scuola_id: scuolaId,
      saldo_atteso: saldoAtteso,
      contato,
      differenza,
      prelevato,
    })

    // Best-effort: dopo lo svuotamento il saldo riparte dal fondo → resetta il flag soglia.
    await verificaSogliaCassa(supabase, scuolaId)

    return NextResponse.json(
      { chiusura_id: out.chiusura_id, saldo_atteso: saldoAtteso, contato, differenza, prelevato, fondo_lasciato: fondoLasciato },
      { status: 201 },
    )
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/chiusura:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
