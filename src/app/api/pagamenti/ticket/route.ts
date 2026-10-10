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
  // intero: il saldo è in pasti, e `ricarica_ticket_mensa` prende un integer
  pezzi: z.coerce.number().refine((v) => Number.isInteger(v) && v > 0, 'pezzi deve essere un intero > 0'),
  costo: z.coerce.number().refine((v) => v >= 0, 'costo deve essere >= 0'),
  metodo: z.string().nullish(),
  // Conferma esplicita e NOMINATA di una ricarica già fatta oggi. Un booleano
  // sarebbe peggio: un client che mandasse `true` di default disattiverebbe la
  // guardia senza che nessuno se ne accorga leggendo il diff. Stessa forma di
  // `conferma_eccedenza` in `pagamenti/transazioni`.
  conferma_duplicato: z.enum(['gia_ricaricato_oggi']).optional(),
})

/** Esito di `ricarica_ticket_mensa` (supabase/migrations/…_ricarica_ticket_in_una_transazione.sql). */
type EsitoRicarica =
  | { esito: 'non_trovato' }
  | { esito: 'duplicato'; precedente: { creato_il: string; pezzi: number | null; importo: number | string | null } }
  | { esito: 'ok'; saldo: number; scuola_id: string | null; pagamento_id: string; incasso_id: string | null }

// GET /api/pagamenti/ticket?alunno_id=&userId=
//   staff -> solo alunni dei propri plessi (assertAlunnoInScope: 403 fuori perimetro,
//            404 inesistente); genitore -> solo dei propri figli
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
    if (isStaff) {
      // ⚠️ FINO AL 2026-09-26 (K5) QUI NON C'ERA NIENTE: lo staff leggeva il saldo di
      // QUALUNQUE bambino di cui avesse l'uuid, anche di un altro plesso — il client è
      // service-role, la RLS non c'è, e il gate applicativo è l'unico presidio. Ora vale la
      // stessa regola della POST qui sotto: l'alunno deve stare nei plessi dello staff
      // (403 fuori perimetro, 404 se non esiste, 5xx se lo scope non si risolve).
      const scopeErr = await assertAlunnoInScope(supabase, user, alunnoId)
      if (scopeErr) return scopeErr
    } else {
      // Unione runtime (`legame_genitori_alunni`) + anagrafica (`student_parents`
      // via ponte `parents.auth_user_id`): col solo runtime il genitore arrivato
      // dal form pubblico non vedeva il saldo mensa del PROPRIO figlio.
      const ok = await genitoreHasFiglio(supabase, user.id, alunnoId)
      if (!ok) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    // PostgREST non lancia: un errore qui, ignorato, diventava «saldo 0» — un numero falso
    // mostrato come vero, a un genitore o alla cassa. «Nessuna riga» invece è un dato vero
    // (mai ricaricato) e resta il saldo zero di ripiego.
    const { data, error } = await supabase
      .from('ticket_mensa').select('alunno_id, saldo_ticket, ultimo_carico').eq('alunno_id', alunnoId).maybeSingle()
    if (error) {
      logErrore({ operazione: 'pagamenti/ticket:GET', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore nel caricamento del saldo ticket', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data ?? { alunno_id: alunnoId, saldo_ticket: 0, ultimo_carico: null } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ticket:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/ticket  (staff) — ricarica ticket mensa
// Body: { userId, alunno_id, pezzi, costo, metodo?, conferma_duplicato? }  (sede = quella dell'alunno)
// Dal 2026-10-10 una sola RPC, `ricarica_ticket_mensa`: saldo, pagamento Mensa,
// incasso e movimento del ledger nella stessa transazione, con le ricariche dello
// stesso bambino serializzate e la guardia «già ricaricato oggi» letta dopo il
// blocco. Prima erano quattro scritture separate, e ognuna poteva fallire dopo le
// precedenti (saldo salito senza pagamento, pagamento senza incasso, movimento perso).
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

    // scoping: l'alunno deve stare nei plessi dello staff. Sta PRIMA della guardia
    // del duplicato: un 409 direbbe a uno staff di un altro plesso che quel bambino
    // ha ricaricato oggi.
    const scopeErr = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scopeErr) return scopeErr

    // Confini del giorno CIVILE (Europe/Rome): la RPC filtra su `creato_il` dentro
    // questi limiti, MAI sulla colonna `data`, che ha DEFAULT CURRENT_DATE e segue il
    // fuso della sessione Postgres (fra mezzanotte e le due nomina il giorno sbagliato).
    const oggi = dataCivile()
    const dalle = inizioGiornoCivile(oggi)
    const alle = fineGiornoCivile(oggi)
    if (!body.conferma_duplicato && (!dalle || !alle)) {
      // Senza confini la guardia non si fa: lo si dice, non si tace.
      logEvento('db', 'warn', { operazione: 'pagamenti/ticket:POST', esito: 'guardia_duplicato_non_verificata', alunno_id })
    }

    const rpc = await supabase.rpc('ricarica_ticket_mensa', {
      p_alunno_id: alunno_id,
      p_pezzi: Number(pezzi),
      p_costo: Number(costo),
      p_operatore: user.id,
      p_metodo: body.metodo ?? null,
      p_conferma_duplicato: !!body.conferma_duplicato,
      p_giorno_dalle: dalle ?? null,
      p_giorno_alle: alle ?? null,
    })
    if (rpc.error) {
      const code = (rpc.error as { code?: string }).code
      if (code === 'PGRST202' || code === '42883') {
        // Funzione assente: database non migrato. Nessuna scrittura è avvenuta.
        logErrore({ operazione: 'pagamenti/ticket:POST', stato: 503, evento: 'config' }, rpc.error)
        return NextResponse.json({ error: 'Ricarica ticket non disponibile su questo ambiente', codice: 'TICKET_RICARICA_NON_DISPONIBILE' }, { status: 503 })
      }
      if (code === '22P02' || code === '22023') {
        // Metodo fuori elenco, pezzi o costo non validi: errore dell'input.
        logEvento('pagamento', 'warn', { operazione: 'pagamenti/ticket:POST', esito: 'input_rifiutato', alunno_id, codice: code })
        return NextResponse.json({ error: 'Dati della ricarica non validi', codice: 'TICKET_RICARICA_NON_VALIDA' }, { status: 400 })
      }
      // Niente è stato scritto: la transazione è annullata per intero.
      logErrore({ operazione: 'pagamenti/ticket:POST', stato: 500, evento: 'db' }, rpc.error)
      return NextResponse.json({ error: 'Errore nella ricarica dei ticket' }, { status: 500 })
    }

    const esito = rpc.data as EsitoRicarica | null
    if (!esito || esito.esito === 'non_trovato') {
      return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    }
    if (esito.esito === 'duplicato') {
      const r = esito.precedente
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/ticket:POST',
        esito: 'ricarica_duplicata_fermata',
        alunno_id, pezzi: Number(pezzi),
      })
      // Nel corpo solo ciò che serve a riconoscere la ricarica: l'ora, quanti
      // ticket, quanto. MAI `note` (testo libero), mai chi l'ha fatta.
      return NextResponse.json({
        error: 'Oggi a questo bambino è già stata registrata una ricarica.',
        codice: 'TICKET_RICARICA_DUPLICATA',
        precedente: {
          creato_il: r.creato_il,
          pezzi: Number(r.pezzi ?? 0),
          importo: r.importo == null ? null : Number(r.importo),
        },
      }, { status: 409 })
    }

    const nuovoSaldo = Number(esito.saldo)
    const scuolaId = esito.scuola_id
    const pag = { id: esito.pagamento_id }
    // `null` = nessun incasso da registrare (costo 0). Con la transazione unica un
    // incasso dovuto o c'è o la ricarica intera non è avvenuta.
    const incassoRegistrato: boolean | null = Number(costo) > 0 ? !!esito.incasso_id : null

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
      incasso_registrato: incassoRegistrato,
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
