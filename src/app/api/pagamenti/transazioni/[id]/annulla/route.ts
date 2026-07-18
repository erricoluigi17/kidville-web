import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { eseguiStornoIncasso } from '@/app/api/pagamenti/incassi/storno/route'
import { saldoCredito } from '@/lib/pagamenti/credito'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { annullaRicevutaTransazioneAttiva } from '@/lib/pagamenti/ricevute'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const postBodySchema = z.object({
  motivo: z.string().min(3, 'Il motivo dell\'annullo è obbligatorio (min 3 caratteri)'),
})

const round2 = (n: number) => Math.round(n * 100) / 100

// POST /api/pagamenti/transazioni/[id]/annulla  (staff) — annulla una transazione.
// Storna OGNI incasso collegato (contro-incassi tracciati), storna l'eventuale
// eccedenza accreditata a credito (409 se il credito è già stato speso), marca la
// transazione e annulla la ricevuta famiglia attiva. Il motivo è obbligatorio.
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

    const { data: tx, error: txErr } = await supabase
      .from('pagamenti_transazioni')
      .select('id, scuola_id, pagante_parent_id, importo_totale, annullata_il')
      .eq('id', id)
      .maybeSingle()
    if (txErr) {
      logErrore({ operazione: 'pagamenti/transazioni/[id]/annulla:POST', stato: 500, evento: 'db' }, txErr)
      return NextResponse.json({ error: 'Errore nel recupero della transazione' }, { status: 500 })
    }
    if (!tx) return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })

    // Scope di sede.
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sedi.includes(String((tx as { scuola_id: string }).scuola_id))) {
      return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })
    }

    if ((tx as { annullata_il?: string | null }).annullata_il) {
      return NextResponse.json({ error: 'Transazione già annullata' }, { status: 409 })
    }

    const parentId = (tx as { pagante_parent_id: string }).pagante_parent_id

    // 1) Eccedenza accreditata su questa transazione (causale 'eccedenza').
    //    Verifica PRIMA di stornare gli incassi: se il credito è già stato speso
    //    (saldo corrente < eccedenza) l'annullo lascerebbe il saldo negativo → 409.
    const { data: eccRows } = await supabase
      .from('crediti_famiglia')
      .select('importo')
      .eq('transazione_id', id)
      .eq('causale', 'eccedenza')
    const eccedenza = round2(((eccRows ?? []) as { importo: number | string }[]).reduce((s, r) => s + Number(r.importo), 0))
    let saldoDopoStorno = 0
    if (eccedenza > 0.005) {
      const saldo = await saldoCredito(supabase, parentId)
      if (saldo + 0.005 < eccedenza) {
        return NextResponse.json(
          { error: 'Il credito generato da questa transazione è già stato utilizzato: non è possibile annullarla. Registra prima una rettifica.' },
          { status: 409 },
        )
      }
      saldoDopoStorno = round2(saldo - eccedenza)
    }

    // 2) Storna ogni incasso originale collegato (i contro-incassi/storni si saltano).
    const { data: incassi } = await supabase
      .from('incassi')
      .select('id, importo, metodo, stornato_il')
      .eq('transazione_id', id)
    let stornati = 0
    for (const inc of (incassi ?? []) as { id: string; importo: number | string; metodo?: string | null; stornato_il?: string | null }[]) {
      if (Number(inc.importo) <= 0 || inc.metodo === 'storno' || inc.stornato_il) continue
      const esito = await eseguiStornoIncasso(supabase, { incassoId: inc.id, motivo: `Annullo transazione: ${motivo}`, userId: user.id })
      if (esito.status === 200) stornati += 1
      else {
        // 409 (già stornato) o altro: non blocca l'annullo, ma va tracciato.
        logEvento('pagamento', 'warn', {
          operazione: 'pagamenti/transazioni/[id]/annulla:POST',
          esito: 'storno_incasso_saltato',
          transazione_id: id,
          incasso_id: inc.id,
          stato: esito.status,
        })
      }
    }

    // 3) Storna l'eccedenza a credito (riga 'storno' con saldo_dopo aggiornato).
    if (eccedenza > 0.005) {
      await supabase.from('crediti_famiglia').insert({
        parent_id: parentId,
        scuola_id: (tx as { scuola_id: string }).scuola_id,
        causale: 'storno',
        importo: -eccedenza,
        saldo_dopo: saldoDopoStorno,
        transazione_id: id,
        creato_da: user.id,
      }).then(() => {}, () => {})
    }

    // 4) Marca la transazione annullata (il motivo vive in colonna, non nei log).
    await supabase
      .from('pagamenti_transazioni')
      .update({ annullata_il: new Date().toISOString(), annullo_motivo: motivo })
      .eq('id', id)
      .then(() => {}, () => {})

    // 5) Annulla la ricevuta famiglia attiva (numero bruciato).
    await annullaRicevutaTransazioneAttiva(supabase, id, { da: user.id, motivo: 'annullo transazione' })

    // 6) Audit col MOTIVO (registro, non log).
    await supabase.from('registro_modifiche').insert({
      azione: 'annulla_transazione',
      tabella_interessata: 'pagamenti_transazioni',
      record_id: id,
      nuovo_valore: { annullo_motivo: motivo, incassi_stornati: stornati, eccedenza_stornata: eccedenza },
      utente_id: user.id,
    }).then(() => {}, () => {})

    // Evento critico → SUCCESSO loggato (conteggi/uuid, MAI il motivo/PII).
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/transazioni/[id]/annulla:POST',
      esito: 'transazione_annullata',
      transazione_id: id,
      incassi_stornati: stornati,
      eccedenza: eccedenza,
    })

    // La sospensione può DIVENTARE dovuta di nuovo (lo storno riapre lo scaduto):
    // verificaRevoca non riattiva mai una sospensione, quindi qui è inerte ma
    // coerente col resto — nessun effetto indesiderato.
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

    return NextResponse.json({ success: true, data: { transazione_id: id, incassi_stornati: stornati, eccedenza_stornata: eccedenza } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni/[id]/annulla:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
