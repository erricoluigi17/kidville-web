import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { dataCivile } from '@/i18n/config'
import { inizioGiornoCivile, fineGiornoCivile } from '@/lib/format/confini-giorno'

const getQuerySchema = z.object({
  alunno_id: zUuid,
})

const postBodySchema = z.object({
  alunno_id: zUuid,
  // pezzi/costo possono arrivare come numero o stringa numerica (come incassi);
  // i vincoli pezzi > 0 e costo >= 0 sono quelli del check storico
  pezzi: z.coerce.number().refine((v) => v > 0, 'pezzi deve essere > 0'),
  costo: z.coerce.number().refine((v) => v >= 0, 'costo deve essere >= 0'),
  metodo: z.string().nullish(),
  // Conferma esplicita e NOMINATA di una ricarica già fatta oggi. Un booleano
  // sarebbe peggio: un client che mandasse `true` di default disattiverebbe la
  // guardia senza che nessuno se ne accorga leggendo il diff. Stessa forma di
  // `conferma_eccedenza` in `pagamenti/transazioni`.
  conferma_duplicato: z.enum(['gia_ricaricato_oggi']).optional(),
})

// Codici che significano «la RPC non c'è» — e SOLO quelli. Il DB E2E della CI non
// è migrato: lì si degrada al percorso storico. Qualunque altro errore è un
// guasto vero e NON degrada, perché «la funzione non esiste» e «la funzione è
// fallita» sono due cose diverse e confonderle nasconde i guasti.
const RPC_ASSENTE = new Set(['PGRST202', '42883'])

type EsitoSaldo =
  | { ok: true; saldo: number; atomico: boolean }
  | { ok: false; messaggio: string }

// GET /api/pagamenti/ticket?alunno_id=&userId=
//   staff -> saldo di qualsiasi alunno; genitore -> solo dei propri figli
export const GET = withRoute('pagamenti/ticket:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const alunnoId = q.data.alunno_id

    const supabase = await createAdminClient()
    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
    if (!isStaff) {
      // Unione runtime (`legame_genitori_alunni`) + anagrafica (`student_parents`
      // via ponte `parents.auth_user_id`): col solo runtime il genitore arrivato
      // dal form pubblico non vedeva il saldo mensa del PROPRIO figlio.
      const ok = await genitoreHasFiglio(supabase, user.id, alunnoId)
      if (!ok) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const { data } = await supabase
      .from('ticket_mensa').select('alunno_id, saldo_ticket, ultimo_carico').eq('alunno_id', alunnoId).maybeSingle()
    return NextResponse.json({ success: true, data: data ?? { alunno_id: alunnoId, saldo_ticket: 0, ultimo_carico: null } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ticket:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/ticket  (staff) — ricarica ticket mensa
// Body: { userId, alunno_id, pezzi, costo, metodo? }  (scuola_id derivato dall'alunno)
// Un'unica azione: incrementa saldo_ticket E crea un pagamento Mensa già saldato.
export const POST = withRoute('pagamenti/ticket:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { alunno_id, pezzi, costo } = body

    const supabase = await createAdminClient()

    // scoping: l'alunno deve stare nei plessi dello staff
    const scopeErr = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scopeErr) return scopeErr

    // scuola_id derivato SEMPRE dall'alunno (mai dal client)
    const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
    if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    const scuolaId = al.scuola_id

    /**
     * Unico modo corretto di muovere `ticket_mensa.saldo_ticket` da codice
     * applicativo. Sta QUI dentro, e non in un helper di modulo, per una ragione
     * che non è di stile: chiude su `alunno_id`, cioè sull'oggetto che
     * `assertAlunnoInScope` ha appena verificato. Un helper fuori dall'handler
     * riceverebbe un id qualunque, e chi legge — persona o lock di isolamento fra
     * sedi — non avrebbe modo di vedere che quel bambino è già stato controllato.
     *
     * Prima di questa funzione la route leggeva il saldo e lo riscriveva per
     * valore assoluto. Due scritture concorrenti — due click, o un click e una
     * transazione del wizard — leggevano lo stesso numero e scrivevano lo stesso
     * risultato: non «saldo doppio», ma **saldo singolo e incasso doppio**, cioè
     * una cassa che non quadra sotto un saldo che sembra a posto.
     */
    const variaSaldo = async (delta: number): Promise<EsitoSaldo> => {
      const { data, error } = await supabase.rpc('varia_saldo_ticket', { p_alunno_id: alunno_id, p_delta: delta })
      if (!error) return { ok: true, saldo: Number(data ?? 0), atomico: true }

      if (!RPC_ASSENTE.has(String((error as { code?: string }).code ?? ''))) {
        return { ok: false, messaggio: (error as { message?: string }).message ?? 'errore RPC saldo' }
      }

      // Percorso storico, non atomico: lo si usa solo dove la RPC non esiste, e lo
      // si dichiara nel log — altrimenti il giorno in cui la migrazione non fosse
      // applicata in produzione nessuno saprebbe che il saldo è tornato fragile.
      logEvento('db', 'warn', {
        operazione: 'pagamenti/ticket:POST',
        esito: 'saldo_non_atomico_rpc_assente',
        delta,
      }, error)

      const { data: cur } = await supabase
        .from('ticket_mensa').select('saldo_ticket').eq('alunno_id', alunno_id).maybeSingle()
      const nuovo = Number(cur?.saldo_ticket ?? 0) + delta
      const patch: Record<string, unknown> = { alunno_id, saldo_ticket: nuovo }
      if (delta > 0) patch.ultimo_carico = new Date().toISOString()
      const { error: uErr } = await supabase.from('ticket_mensa').upsert(patch, { onConflict: 'alunno_id' })
      if (uErr) return { ok: false, messaggio: uErr.message }
      return { ok: true, saldo: nuovo, atomico: false }
    }

    // 0) ha già ricaricato oggi? Si chiede conferma, non si vieta.
    //
    // Sta QUI, dopo `assertAlunnoInScope`: prima, il 409 direbbe a uno staff di un
    // altro plesso che quel bambino ha ricaricato oggi.
    //
    // Si filtra su `creato_il` e MAI sulla colonna `data`: quella ha
    // DEFAULT CURRENT_DATE e il giorno lo decide il fuso della sessione Postgres,
    // quindi fra mezzanotte e le due italiane nomina il giorno sbagliato. Misurato
    // il 2026-09-07: zero divergenze su 73 righe, ma solo perché nessuna ricarica è
    // mai caduta in quella finestra — la più vicina è delle 02:14. L'indice
    // `mtm_alunno_idx (alunno_id, creato_il DESC)` copre esattamente questa lettura.
    if (!body.conferma_duplicato) {
      const oggi = dataCivile()
      const dalle = inizioGiornoCivile(oggi)
      const alle = fineGiornoCivile(oggi)
      if (dalle && alle) {
        const { data: gia, error: gErr } = await supabase
          .from('mensa_ticket_movimenti')
          .select('creato_il, delta, pagamenti ( importo )')
          .eq('alunno_id', alunno_id)
          .eq('tipo', 'ricarica')
          .gte('creato_il', dalle)
          .lte('creato_il', alle)
          .order('creato_il', { ascending: false })
          .limit(1)

        if (gErr) {
          // Fail-open, e detto: il ledger è già dichiarato best-effort in questa
          // stessa route (il movimento del punto 5 si logga e non blocca). Una
          // guardia che fallisse CHIUSA su una tabella non autoritativa
          // rifiuterebbe incassi veri — e il duplicato l'operatore lo vede
          // comunque nello storico, mentre una ricarica rifiutata è un genitore
          // allo sportello che se ne va senza pasti.
          logEvento('db', 'warn', {
            operazione: 'pagamenti/ticket:POST',
            esito: 'guardia_duplicato_non_verificata',
            alunno_id,
          }, gErr)
        } else if (gia && gia.length > 0) {
          const r = gia[0] as { creato_il: string; delta: number | null; pagamenti?: { importo?: number | null } | null }
          logEvento('pagamento', 'info', {
            operazione: 'pagamenti/ticket:POST',
            esito: 'ricarica_duplicata_fermata',
            alunno_id, pezzi: Number(pezzi),
          })
          // Nel corpo solo ciò che serve a riconoscere la ricarica: l'ora, quanti
          // ticket, quanto. MAI `note` (testo libero), mai chi l'ha fatta.
          // `origine` è fuori di proposito: misurato, vale 'segreteria' su 73 righe
          // su 73, cioè un campo che direbbe sempre la stessa cosa.
          return NextResponse.json({
            error: 'Oggi a questo bambino è già stata registrata una ricarica.',
            codice: 'TICKET_RICARICA_DUPLICATA',
            precedente: {
              creato_il: r.creato_il,
              pezzi: Number(r.delta ?? 0),
              importo: r.pagamenti?.importo == null ? null : Number(r.pagamenti.importo),
            },
          }, { status: 409 })
        }
      }
    }

    // 1) incrementa il saldo ticket, in modo ATOMICO
    const esito = await variaSaldo(Number(pezzi))
    if (!esito.ok) {
      return NextResponse.json({ error: 'Errore aggiornamento saldo', details: esito.messaggio }, { status: 500 })
    }
    const nuovoSaldo = esito.saldo

    // 2) categoria mensa
    const { data: cat } = await supabase
      .from('payment_categories').select('id').eq('slug', 'mensa').is('scuola_id', null).maybeSingle()

    // 3) crea pagamento Mensa
    const { data: pag, error: pErr } = await supabase.from('pagamenti').insert({
      alunno_id, scuola_id: scuolaId, categoria_id: cat?.id,
      descrizione: `Ricarica mensa — ${pezzi} ticket`, importo: costo,
      scadenza: new Date().toISOString().slice(0, 10),
      tipo: 'singolo', obbligatorio: false, creato_da: user.id, stato: 'da_pagare',
    }).select().single()
    if (pErr || !pag) {
      // Rientro del saldo per DECREMENTO, non riscrivendo il valore letto prima:
      // fra l'incremento e qui può essere passata un'altra ricarica, e rimettere
      // il vecchio numero la cancellerebbe.
      const rientro = await variaSaldo(-Number(pezzi))
      if (!rientro.ok) {
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/ticket:POST',
          esito: 'saldo_non_rientrato_dopo_pagamento_fallito',
          alunno_id, pezzi: Number(pezzi),
        }, rientro.messaggio)
      }
      return NextResponse.json({ error: 'Errore creazione pagamento', details: pErr?.message }, { status: 500 })
    }

    // 4) incasso contestuale (saldato) — il trigger porta lo stato a 'pagato'
    //
    // PostgREST non lancia: ritorna `{ error }`. Prima questo insert non lo
    // guardava, e un suo fallimento era invisibile due volte — nei log, perché
    // nessuno lo scriveva; a schermo, perché la risposta era identica a quella di
    // un incasso riuscito. Il saldo era già salito, il pagamento restava
    // `da_pagare` e la famiglia compariva fra i morosi.
    //
    // `null` = nessun incasso da registrare (costo 0), che è diverso da «non è
    // stato registrato».
    let incassoRegistrato: boolean | null = null
    if (Number(costo) > 0) {
      const { error: iErr } = await supabase.from('incassi').insert({
        pagamento_id: pag.id, importo: costo, metodo: body.metodo ?? 'contanti',
        note: 'Ricarica ticket mensa', registrato_da: user.id,
      })
      incassoRegistrato = !iErr
      if (iErr) {
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/ticket:POST',
          esito: 'incasso_non_registrato',
          alunno_id, pagamento_id: pag.id, importo: Number(costo),
        }, iErr)
      }
    }

    // 5) movimento sul ledger ticket (best-effort: il saldo resta autoritativo)
    const { error: mErr } = await supabase.from('mensa_ticket_movimenti').insert({
      alunno_id, scuola_id: scuolaId, tipo: 'ricarica', delta: Number(pezzi),
      saldo_dopo: nuovoSaldo, pagamento_id: pag.id, origine: 'segreteria', creato_da: user.id,
    })
    // Il saldo resta autoritativo e la richiesta risponde 201, ma la riga di ledger è
    // persa per sempre: lo storico dei movimenti non tornerà più col saldo. `error`.
    if (mErr) {
      logEvento('db', 'error', {
        operazione: 'pagamenti/ticket:POST',
        esito: 'movimento_ledger_non_registrato',
        pezzi: Number(pezzi),
        saldo_dopo: nuovoSaldo,
      }, mErr)
    }

    // Conferma al genitore: ricarica registrata (best-effort).
    try {
      await notificaEvento(supabase, {
        tipo: 'mensa_ricarica',
        scuolaId: (scuolaId as string | undefined) ?? null,
        alunnoIds: [alunno_id],
        titolo: 'Ricarica mensa registrata',
        corpo: `Ricaricati ${pezzi} ticket mensa: il saldo è di ${nuovoSaldo} pasti.`,
        link: '/parent/mensa',
        entitaTipo: 'ticket_mensa',
        entitaId: alunno_id,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'pagamenti/ticket:POST',
        tipo: 'mensa_ricarica',
        esito: 'notifica_non_inviata',
      }, e)
    }

    // Evento critico: si logga anche il SUCCESSO. Con i soli errori, «nessun log»
    // non distingue «tutto ok» da «non è mai partito niente».
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/ticket:POST',
      esito: body.conferma_duplicato ? 'ricarica_duplicata_confermata' : 'ricarica_registrata',
      alunno_id, pagamento_id: pag.id, scuola_id: scuolaId,
      pezzi: Number(pezzi), importo: Number(costo), saldo_dopo: nuovoSaldo,
      saldo_atomico: esito.atomico, incasso_registrato: incassoRegistrato,
    })

    return NextResponse.json({
      success: true,
      data: { saldo_ticket: nuovoSaldo, pagamento_id: pag.id, incasso_registrato: incassoRegistrato },
    }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ticket:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
