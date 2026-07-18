import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { annullaRicevutaTransazioneAttiva } from '@/lib/pagamenti/ricevute'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const postBodySchema = z.object({
  motivo: z.string().min(3, 'Il motivo dell\'annullo è obbligatorio (min 3 caratteri)'),
})

/** La funzione RPC non esiste su questo ambiente (DB E2E CI non migrato). */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
/** Tabella non presente (DB non migrato) sulla lettura di pre-check. */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205', 'PGRST204', '42703'])

// POST /api/pagamenti/transazioni/[id]/annulla  (staff) — annulla una transazione.
//
// L'annullo è ATOMICO e delegato alla RPC `annulla_transazione_contabile`, gemella
// speculare di `registra_transazione_contabile`: in UNA transazione storna gli
// incassi (contro-incassi tracciati), le RICARICHE MENSA (movimento inverso +
// saldo ticket, mai negativo) e l'eventuale eccedenza a credito. La vecchia
// enumerazione manuale dimenticava le ricariche mensa → i ticket restavano
// regalati alla famiglia (bug corretto). Il motivo è obbligatorio.
export const POST = withRoute('pagamenti/transazioni/[id]/annulla:POST', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { motivo } = b.data

    const supabase = await createAdminClient()

    // Pre-check applicativo: esistenza + scope di sede + già-annullata. Lo scope
    // NON può stare nella RPC (gira a service-role, non conosce la sede del chiamante).
    const { data: tx, error: txErr } = await supabase
      .from('pagamenti_transazioni')
      .select('id, scuola_id, pagante_parent_id, annullata_il')
      .eq('id', id)
      .maybeSingle()
    if (txErr) {
      // Ambiente non migrato (tabella assente) → 503 pulito, coerente con la RPC.
      if (TABELLA_ASSENTE.has((txErr as { code?: string }).code ?? '')) {
        logEvento('pagamento', 'warn', { operazione: 'pagamenti/transazioni/[id]/annulla:POST', esito: 'ambiente-non-migrato' }, txErr)
        return NextResponse.json({ error: 'Annullo non disponibile su questo ambiente' }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/transazioni/[id]/annulla:POST', stato: 500, evento: 'db' }, txErr)
      return NextResponse.json({ error: 'Errore nel recupero della transazione' }, { status: 500 })
    }
    if (!tx) return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })

    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sedi.includes(String((tx as { scuola_id: string }).scuola_id))) {
      return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })
    }

    if ((tx as { annullata_il?: string | null }).annullata_il) {
      return NextResponse.json({ error: 'Transazione già annullata' }, { status: 409 })
    }

    // Annullo atomico: incassi + ricariche mensa + eccedenza a credito, tutto o niente.
    const { data: esito, error: rpcErr } = await supabase.rpc('annulla_transazione_contabile', {
      p: { transazione_id: id, motivo, annullato_da: user.id },
    })

    if (rpcErr) {
      const code = (rpcErr as { code?: string }).code ?? ''
      // RPC assente (DB non migrato) → 503 SENZA storni parziali (nulla è stato scritto).
      if (RPC_ASSENTE.has(code)) {
        logEvento('pagamento', 'warn', { operazione: 'pagamenti/transazioni/[id]/annulla:POST', esito: 'rpc-assente' }, rpcErr)
        return NextResponse.json({ error: 'Funzione di annullo non disponibile su questo ambiente' }, { status: 503 })
      }
      // Transazione già annullata (race col pre-check) → 409.
      if (code === 'KV409') {
        return NextResponse.json({ error: 'Transazione già annullata' }, { status: 409 })
      }
      // Credito eccedenza già speso: l'annullo lascerebbe il saldo negativo → 409.
      if (code === 'KV410') {
        return NextResponse.json(
          { error: 'Il credito generato da questa transazione è già stato utilizzato: non è possibile annullarla. Recupera prima il credito speso.' },
          { status: 409 },
        )
      }
      // Transazione sparita fra pre-check e RPC → 404.
      if (code === 'KV404') {
        return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })
      }
      logErrore({ operazione: 'pagamenti/transazioni/[id]/annulla:POST', stato: 500, evento: 'db' }, rpcErr)
      return NextResponse.json({ error: 'Errore durante l\'annullo della transazione' }, { status: 500 })
    }

    const conteggi = (esito ?? {}) as {
      incassi_stornati?: number
      ricariche_stornate?: number
      credito_stornato?: number
      ticket_gia_consumati?: boolean
    }

    // Annulla la ricevuta famiglia attiva (numero bruciato) — come oggi.
    await annullaRicevutaTransazioneAttiva(supabase, id, { da: user.id, motivo: 'annullo transazione' })

    // Audit col MOTIVO (registro DB, non log). PostgREST non lancia → best-effort.
    await supabase.from('registro_modifiche').insert({
      azione: 'annulla_transazione',
      tabella_interessata: 'pagamenti_transazioni',
      record_id: id,
      nuovo_valore: {
        annullo_motivo: motivo,
        incassi_stornati: conteggi.incassi_stornati ?? 0,
        ricariche_stornate: conteggi.ricariche_stornate ?? 0,
        credito_stornato: conteggi.credito_stornato ?? 0,
      },
      utente_id: user.id,
    }).then(() => {}, () => {})

    // Evento critico → SUCCESSO loggato (conteggi/uuid, MAI il motivo/PII).
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/transazioni/[id]/annulla:POST',
      esito: 'transazione_annullata',
      transazione_id: id,
      incassi_stornati: conteggi.incassi_stornati ?? 0,
      ricariche_stornate: conteggi.ricariche_stornate ?? 0,
      ticket_gia_consumati: conteggi.ticket_gia_consumati === true,
    })

    // Lo storno riapre lo scaduto: verificaRevoca non riattiva mai una sospensione,
    // qui è coerente col resto (best-effort, non blocca la risposta).
    try {
      const alunni = new Set<string>()
      const { data: pagRows } = await supabase
        .from('incassi')
        .select('pagamento_id')
        .eq('transazione_id', id)
      const pids = [...new Set(((pagRows ?? []) as { pagamento_id?: string | null }[]).map((r) => r.pagamento_id).filter(Boolean) as string[])]
      if (pids.length > 0) {
        const { data: pr } = await supabase.from('pagamenti').select('alunno_id').in('id', pids)
        for (const p of (pr ?? []) as { alunno_id?: string | null }[]) if (p.alunno_id) alunni.add(p.alunno_id)
      }
      if (alunni.size > 0) await verificaRevocaSospensioneMorosita(supabase, [...alunni])
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/transazioni/[id]/annulla:POST', esito: 'revoca_non_verificata' }, e)
    }

    return NextResponse.json({
      success: true,
      data: {
        transazione_id: id,
        incassi_stornati: conteggi.incassi_stornati ?? 0,
        ricariche_stornate: conteggi.ricariche_stornate ?? 0,
        credito_stornato: conteggi.credito_stornato ?? 0,
        ticket_gia_consumati: conteggi.ticket_gia_consumati === true,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni/[id]/annulla:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
