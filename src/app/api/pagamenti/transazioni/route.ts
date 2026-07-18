import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Transazione unica di famiglia (slice S4 — Contabilità v2) ────────────────
// UN pagamento (bonifico/POS/…) che salda più voci di più figli, ricarica la
// mensa e — con conferma esplicita — accredita l'eccedenza a credito famiglia.
// L'atomicità è dell'RPC SECURITY DEFINER `registra_transazione_contabile(p jsonb)`
// (service-role): la route valida quadratura + eccedenza e delega la scrittura.

const round2 = (n: number) => Math.round(n * 100) / 100

const voceSchema = z.object({
  pagamento_id: zUuid,
  importo: z.coerce.number().positive('importo voce deve essere > 0'),
})
const ricaricaSchema = z.object({
  alunno_id: zUuid,
  // importo in EURO (per la quadratura), ticket INTERO (per il saldo mensa).
  importo: z.coerce.number().positive('importo ricarica deve essere > 0'),
  ticket: z.coerce.number().int().positive('ticket ricarica deve essere > 0'),
})

const postBodySchema = z.object({
  pagante_parent_id: zUuid,
  scuola_id: zUuid,
  metodo: z.string().min(1, 'metodo obbligatorio'),
  riferimento: z.string().nullish(),
  data_valuta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data valuta non valida (atteso YYYY-MM-DD)').nullish(),
  note: z.string().nullish(),
  importo_totale: z.coerce.number().positive('importo_totale deve essere > 0'),
  voci: z.array(voceSchema).default([]),
  ricariche_mensa: z.array(ricaricaSchema).default([]),
  eccedenza_a_credito: z.coerce.number().min(0, 'eccedenza non può essere negativa').default(0),
  // L'eccedenza non è MAI silenziosa: senza questa conferma un'eccedenza > 0 dà 409.
  conferma_eccedenza: z.enum(['credito_famiglia']).optional(),
})

const getQuerySchema = z.object({
  parent_id: zUuid.optional(),
})

/** Codici che indicano RPC assente (DB E2E CI non migrato) → 503 pulito. */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
/** Tabella nuova assente → degradazione lettura. */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

// GET /api/pagamenti/transazioni?parent_id=  (staff) — registro transazioni.
// Scope di sede come le altre route staff; parent_id opzionale.
export const GET = withRoute('pagamenti/transazioni:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)

    let query = supabase
      .from('pagamenti_transazioni')
      .select('id, scuola_id, pagante_parent_id, importo_totale, metodo, riferimento, data_valuta, note, annullata_il, annullo_motivo, creato_il, registrato_da')
      .in('scuola_id', sedi.length ? sedi : ['00000000-0000-0000-0000-000000000000'])
      .order('creato_il', { ascending: false })
      .limit(200)
    if (q.data.parent_id) query = query.eq('pagante_parent_id', q.data.parent_id)

    const { data, error } = await query
    if (error) {
      // Tabella assente sul DB non migrato: degrada in modo pulito.
      if (TABELLA_ASSENTE.has((error as { code?: string }).code ?? '')) {
        return NextResponse.json({ success: true, data: [], disponibile: false })
      }
      logErrore({ operazione: 'pagamenti/transazioni:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle transazioni', details: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data, disponibile: true })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/transazioni  (staff) — registra una transazione unica.
// Valida la quadratura (Σ voci + Σ ricariche + eccedenza = totale) e il gate
// eccedenza (409 senza conferma), poi delega alla RPC atomica.
export const POST = withRoute('pagamenti/transazioni:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const totale = round2(body.importo_totale)
    const sommaVoci = round2(body.voci.reduce((s, v) => s + Number(v.importo), 0))
    const sommaRicariche = round2(body.ricariche_mensa.reduce((s, r) => s + Number(r.importo), 0))
    const eccedenza = round2(body.eccedenza_a_credito)

    if (body.voci.length === 0 && body.ricariche_mensa.length === 0) {
      return NextResponse.json({ error: 'La transazione deve avere almeno una voce o una ricarica mensa.' }, { status: 400 })
    }

    // Quadratura: il totale dichiarato deve pareggiare l'allocato + l'eccedenza.
    const somma = round2(sommaVoci + sommaRicariche + eccedenza)
    if (somma !== totale) {
      return NextResponse.json(
        { error: 'Quadratura fallita: l\'allocato non pareggia il totale.', totale, allocato: round2(sommaVoci + sommaRicariche), eccedenza },
        { status: 400 },
      )
    }

    // Eccedenza mai silenziosa: serve la conferma esplicita «credito famiglia».
    if (eccedenza > 0.005 && body.conferma_eccedenza !== 'credito_famiglia') {
      return NextResponse.json(
        { error: 'C\'è un\'eccedenza da confermare come credito famiglia o da riallocare.', eccedenza },
        { status: 409 },
      )
    }

    const supabase = await createAdminClient()

    // Scope di sede: non registrare su un plesso fuori dall'ambito dello staff.
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sedi.includes(body.scuola_id)) {
      return NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 })
    }

    const payload = {
      pagante_parent_id: body.pagante_parent_id,
      scuola_id: body.scuola_id,
      metodo: body.metodo,
      riferimento: body.riferimento ?? null,
      data_valuta: body.data_valuta ?? null,
      note: body.note ?? null,
      importo_totale: totale,
      voci: body.voci.map((v) => ({ pagamento_id: v.pagamento_id, importo: round2(v.importo) })),
      ricariche_mensa: body.ricariche_mensa.map((r) => ({ alunno_id: r.alunno_id, importo: round2(r.importo), ticket: r.ticket })),
      eccedenza_a_credito: eccedenza,
      registrato_da: user.id,
    }

    const { data: rpcData, error: rpcErr } = await supabase.rpc('registra_transazione_contabile', { p: payload })
    if (rpcErr) {
      // RPC assente sul DB non migrato: 503 pulito, l'RPC è atomica → nessuna scrittura.
      if (RPC_ASSENTE.has((rpcErr as { code?: string }).code ?? '')) {
        return NextResponse.json({ error: 'Transazione contabile non disponibile su questo ambiente' }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/transazioni:POST', stato: 500, evento: 'db' }, rpcErr)
      return NextResponse.json({ error: 'Errore nella registrazione della transazione', details: rpcErr.message }, { status: 500 })
    }

    const esito = (rpcData ?? {}) as { transazione_id?: string; incassi?: number; ricariche?: number; eccedenza?: number }

    // Evento critico → SUCCESSO loggato (conteggi/uuid, MAI note/motivi/PII).
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/transazioni:POST',
      esito: 'transazione_registrata',
      transazione_id: esito.transazione_id ?? null,
      voci: payload.voci.length,
      ricariche: payload.ricariche_mensa.length,
      eccedenza,
    })

    // Audit (il motivo/nota vivono in colonna/registro, non nei log).
    await supabase.from('registro_modifiche').insert({
      azione: 'registra_transazione',
      tabella_interessata: 'pagamenti_transazioni',
      record_id: esito.transazione_id ?? null,
      nuovo_valore: { importo_totale: totale, voci: payload.voci.length, ricariche: payload.ricariche_mensa.length, eccedenza },
      utente_id: user.id,
    }).then(() => {}, () => {})

    // Alunni coinvolti: dalle voci (via pagamenti) + dalle ricariche mensa.
    const alunni = new Set<string>(payload.ricariche_mensa.map((r) => r.alunno_id))
    if (payload.voci.length > 0) {
      const { data: pagRows } = await supabase
        .from('pagamenti')
        .select('id, alunno_id')
        .in('id', payload.voci.map((v) => v.pagamento_id))
      for (const p of (pagRows ?? []) as { alunno_id?: string | null }[]) if (p.alunno_id) alunni.add(p.alunno_id)
    }
    const alunniIds = [...alunni]

    // Conferma al genitore (best-effort, debounce collassa le voci multiple).
    if (alunniIds.length > 0) {
      try {
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: body.scuola_id,
          alunnoIds: alunniIds,
          titolo: 'Pagamento registrato',
          corpo: 'È stato registrato un pagamento. La ricevuta è disponibile nella sezione Pagamenti.',
          link: '/parent/pagamenti',
          entitaTipo: 'transazione',
          entitaId: esito.transazione_id ?? null,
          debounce: true,
        })
      } catch (e) {
        logEvento('notifica', 'error', {
          operazione: 'pagamenti/transazioni:POST',
          tipo: 'pagamento_registrato',
          esito: 'notifica_non_inviata',
        }, e)
      }
    }

    // Revoca automatica della sospensione se lo scaduto famiglia è azzerato (best-effort).
    try {
      if (alunniIds.length > 0) await verificaRevocaSospensioneMorosita(supabase, alunniIds)
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/transazioni:POST', esito: 'revoca_non_verificata' }, e)
    }

    return NextResponse.json({ success: true, data: esito }, { status: 200 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
