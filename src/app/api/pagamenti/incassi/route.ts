import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { applyOverpaymentSpill } from '@/lib/pagamenti/spill'
import { residuoEffettivo } from '@/lib/pagamenti/aging'
import { accreditaEccedenza, creditoDisponibile } from '@/lib/pagamenti/credito'
import { resolveParentRegistry } from '@/lib/pagamenti/intestatari'
import { eseguiStornoIncasso } from './storno/route'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  pagamento_id: zUuid,
})

const postBodySchema = z.object({
  pagamento_id: zUuid,
  // importo può arrivare come numero o stringa numerica; ≠ 0 come da check storico
  importo: z.coerce.number().refine((v) => v !== 0, 'importo deve essere ≠ 0'),
  data_incasso: z.string().nullish(),
  metodo: z.string().nullish(),
  note: z.string().nullish(),
  quota_id: zUuid.nullish(),
  // spill: qualunque valore ≠ false attiva lo spill (comportamento storico, solo rate)
  spill: z.unknown().optional(),
  // Eccedenza oltre il residuo (voce non-rata): richiede conferma esplicita
  // «credito famiglia» + il pagante (parents.id o utenti.id → resolveParentRegistry).
  conferma_eccedenza: z.enum(['credito_famiglia']).optional(),
  pagante_parent_id: zUuid.optional(),
  // «Salda con abbuono della differenza»: setta pagamenti.sconto sul non incassato.
  abbuono: z.object({ motivo: z.string().min(3, 'Il motivo dell\'abbuono è obbligatorio (min 3 caratteri)') }).optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
  motivo: z.string().optional(),
})

const round2 = (n: number) => Math.round(n * 100) / 100

// GET /api/pagamenti/incassi?pagamento_id=xxx&userId=yyy
// Ledger di un pagamento (staff). I genitori leggono gli incassi tramite il
// dettaglio pagamento (route [id]) con scoping RLS-equivalente.
export const GET = withRoute('pagamenti/incassi:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const pagamentoId = q.data.pagamento_id

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('incassi')
      .select('id, pagamento_id, importo, data_incasso, metodo, note, quota_id, registrato_da, creato_il')
      .eq('pagamento_id', pagamentoId)
      .order('creato_il', { ascending: true })

    if (error) {
      return NextResponse.json({ error: 'Errore nel recupero del ledger', details: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// Riga di pagamento letta per l'incasso (SELECT con retry senza `sconto`).
interface PagIncassoRow {
  id: string
  importo: number | string
  importo_pagato: number | string | null
  sconto?: number | string | null
  parent_payment_id: string | null
  alunno_id: string | null
  scuola_id: string | null
  descrizione: string | null
}

// POST /api/pagamenti/incassi  (staff) — registra una ricevuta
// Body: { userId, pagamento_id, importo, ..., conferma_eccedenza?, pagante_parent_id?, abbuono? }
// Confronta SEMPRE l'importo col residuo effettivo (importo − sconto − già incassato).
// Voce non-rata sovraincassata → 409 { eccedenza } finché non arriva la conferma
// «credito famiglia» + pagante: in quel caso incassa il residuo e accredita il resto.
// Le rate restano gestite dallo spill (invariato).
export const POST = withRoute('pagamenti/incassi:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { pagamento_id } = body

    const supabase = await createAdminClient()

    // Verifica esistenza pagamento + legge `sconto` (retry senza su DB non migrato).
    let pag: PagIncassoRow | null = null
    const selCols = 'id, importo, importo_pagato, sconto, parent_payment_id, alunno_id, scuola_id, descrizione'
    const selBase = 'id, importo, importo_pagato, parent_payment_id, alunno_id, scuola_id, descrizione'
    const sel = await supabase.from('pagamenti').select(selCols).eq('id', pagamento_id).maybeSingle()
    if (sel.error && (sel.error as { code?: string }).code === '42703') {
      const retry = await supabase.from('pagamenti').select(selBase).eq('id', pagamento_id).maybeSingle()
      pag = retry.data as unknown as PagIncassoRow | null
      if (retry.error) {
        logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500, evento: 'db' }, retry.error)
        return NextResponse.json({ error: 'Errore nel recupero del pagamento' }, { status: 500 })
      }
    } else if (sel.error) {
      logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500, evento: 'db' }, sel.error)
      return NextResponse.json({ error: 'Errore nel recupero del pagamento' }, { status: 500 })
    } else {
      pag = sel.data as unknown as PagIncassoRow | null
    }
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    // Residuo EFFETTIVO (fonte unica S1): importo − sconto − già incassato, clampato a 0.
    const residuo = round2(residuoEffettivo({
      importo: pag.importo,
      importo_pagato: pag.importo_pagato ?? null,
      sconto: pag.sconto ?? null,
      stato: 'da_pagare',
    }))
    const isRata = !!pag.parent_payment_id
    const importoBody = round2(Number(body.importo))

    let importoIncasso = importoBody
    let eccedenzaCredito: { parentId: string; importo: number } | null = null

    // Gate eccedenza: solo per le voci NON-rata (le rate usano lo spill, invariato)
    // e solo per un sovraincasso positivo.
    if (!isRata && importoBody > residuo + 0.005) {
      if (body.conferma_eccedenza !== 'credito_famiglia' || !body.pagante_parent_id) {
        return NextResponse.json(
          { error: 'Incasso oltre il residuo: conferma l\'eccedenza come credito famiglia o annulla.', eccedenza: round2(importoBody - residuo) },
          { status: 409 },
        )
      }
      // pagante_parent_id può essere parents.id o utenti.id → riga parents canonica.
      const reg = await resolveParentRegistry(supabase, body.pagante_parent_id)
      if (!reg?.id) {
        return NextResponse.json({ error: 'Pagante non risolvibile: nessun profilo anagrafico collegato.' }, { status: 400 })
      }
      // Verifica disponibilità del credito PRIMA di scrivere l'incasso: DB non
      // migrato → 503 pulito, nessuna scrittura parziale.
      if (!(await creditoDisponibile(supabase))) {
        return NextResponse.json({ error: 'Credito famiglia non disponibile su questo ambiente' }, { status: 503 })
      }
      importoIncasso = residuo
      eccedenzaCredito = { parentId: reg.id, importo: round2(importoBody - residuo) }
    }

    // Registra l'incasso (per il residuo, in caso di eccedenza). Se il residuo è 0
    // non si inserisce nulla (violazione del CHECK importo <> 0): tutto a credito.
    let incasso: { id: string } | null = null
    if (Math.abs(importoIncasso) > 0.005) {
      const ins = await supabase
        .from('incassi')
        .insert({
          pagamento_id,
          importo: importoIncasso,
          data_incasso: body.data_incasso ?? undefined,
          metodo: body.metodo ?? 'contanti',
          note: body.note ?? null,
          quota_id: body.quota_id ?? null,
          registrato_da: user.id,
        })
        .select()
        .single()
      if (ins.error) {
        logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500, evento: 'db' }, ins.error)
        return NextResponse.json({ error: 'Errore nella registrazione', details: ins.error.message }, { status: 500 })
      }
      incasso = ins.data as { id: string }

      // audit
      await supabase.from('registro_modifiche').insert({
        azione: 'registra_incasso',
        tabella_interessata: 'incassi',
        record_id: incasso.id,
        nuovo_valore: incasso,
        utente_id: user.id,
      }).then(() => {}, () => {})
    }

    // Accredita l'eccedenza in credito famiglia.
    let credito: { saldoDopo: number; id: string } | { errore: true } | null = null
    if (eccedenzaCredito) {
      const acc = await accreditaEccedenza(supabase, {
        parentId: eccedenzaCredito.parentId,
        scuolaId: String(pag.scuola_id),
        importo: eccedenzaCredito.importo,
        incassoId: incasso?.id ?? null,
        creatoDa: user.id,
      })
      if (acc.ok) {
        credito = { saldoDopo: acc.saldoDopo, id: acc.id }
        // Evento critico: logga il SUCCESSO (importo, MAI PII).
        logEvento('pagamento', 'info', {
          operazione: 'pagamenti/incassi:POST',
          esito: 'eccedenza_a_credito',
          pagamento_id,
          importo: eccedenzaCredito.importo,
        })
      } else {
        // La probe è passata: qui è un errore inatteso. L'incasso del residuo resta
        // valido; segnaliamo l'eccedenza non accreditata (logga, mai in silenzio).
        credito = { errore: true }
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/incassi:POST',
          esito: 'eccedenza_non_accreditata',
          pagamento_id,
        }, acc.motivo === 'errore' ? acc.error : undefined)
      }
    }

    // Abbuono della differenza: setta pagamenti.sconto = sconto + (residuo − incassato)
    // così la voce risulta saldata. Best-effort: colonna assente → warn, flusso invariato.
    if (body.abbuono && !eccedenzaCredito && importoIncasso < residuo - 0.005) {
      const scontoEsistente = Number(pag.sconto ?? 0)
      const nuovoSconto = round2(scontoEsistente + (residuo - importoIncasso))
      const upd = await supabase
        .from('pagamenti')
        .update({ sconto: nuovoSconto, sconto_motivo: body.abbuono.motivo, aggiornato_il: new Date().toISOString() })
        .eq('id', pagamento_id)
        .select('id')
        .single()
      if (upd.error) {
        if ((upd.error as { code?: string }).code === 'PGRST204') {
          // DB non migrato: l'abbuono non si applica, ma l'incasso base resta valido.
          logEvento('pagamento', 'warn', {
            operazione: 'pagamenti/incassi:POST',
            esito: 'abbuono_non_disponibile',
            pagamento_id,
          })
        } else {
          logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500, evento: 'db' }, upd.error)
        }
      } else {
        await supabase.rpc('ricalcola_stato_pagamento', { p_id: pagamento_id }).then(() => {}, () => {})
        await supabase.from('registro_modifiche').insert({
          azione: 'abbuono_incasso',
          tabella_interessata: 'pagamenti',
          record_id: pagamento_id,
          nuovo_valore: { sconto: nuovoSconto, sconto_motivo: body.abbuono.motivo },
          utente_id: user.id,
        }).then(() => {}, () => {})
        // Evento critico: logga il SUCCESSO (importo dell'abbuono, MAI il motivo).
        logEvento('pagamento', 'info', {
          operazione: 'pagamenti/incassi:POST',
          esito: 'abbuono_applicato',
          pagamento_id,
          sconto: nuovoSconto,
        })
      }
    }

    // Overpayment spill-over (solo per le rate, opzionale)
    let spills = undefined
    if (incasso && body.spill !== false && pag.parent_payment_id) {
      spills = await applyOverpaymentSpill(supabase, pagamento_id, user.id)
    }

    // stato aggiornato dal trigger
    const { data: aggiornato } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, stato, data_incasso')
      .eq('id', pagamento_id)
      .maybeSingle()

    // Conferma al genitore: pagamento registrato (best-effort). Il debounce
    // per pagamento collassa gli incassi multipli ravvicinati.
    try {
      if (pag.alunno_id && incasso) {
        const saldato = (aggiornato as { stato?: string } | null)?.stato === 'pagato'
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: (pag.scuola_id as string | undefined) ?? null,
          alunnoIds: [pag.alunno_id as string],
          titolo: saldato ? 'Pagamento registrato' : 'Acconto registrato',
          corpo: `${pag.descrizione ?? 'Pagamento'}: registrato un incasso di ${importoIncasso} €.${saldato ? ' La ricevuta è disponibile.' : ''}`,
          link: '/parent/pagamenti',
          entitaTipo: 'pagamento',
          entitaId: pagamento_id,
          debounce: true,
        })
      }
    } catch (e) {
      // La richiesta risponde 201, ma la conferma al genitore NON è mai stata accodata:
      // è una scrittura persa, e senza riavvii. Perciò `error`, non `warn`.
      logEvento('notifica', 'error', {
        operazione: 'pagamenti/incassi:POST',
        tipo: 'pagamento_registrato',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, data: { incasso, pagamento: aggiornato, spills, credito } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/incassi?id=xxx&motivo=yyy  (staff) — storno TRACCIATO
// Non cancella più fisicamente: crea un contro-incasso e marca l'originale.
// Il motivo è obbligatorio (query ?motivo= o body), min 3 caratteri.
export const DELETE = withRoute('pagamenti/incassi:DELETE', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    let motivo = q.data.motivo?.trim()
    if (!motivo || motivo.length < 3) {
      try {
        const parsed = await request.json()
        const m = (parsed as { motivo?: string } | null)?.motivo?.trim()
        if (m) motivo = m
      } catch {
        // nessun body JSON: il motivo doveva arrivare in query
      }
    }
    if (!motivo || motivo.length < 3) {
      return NextResponse.json({ error: 'Motivo dello storno obbligatorio (min 3 caratteri)' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const esito = await eseguiStornoIncasso(supabase, { incassoId: id, motivo, userId: user.id })
    return NextResponse.json(esito.body, { status: esito.status })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
