import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser, type AppRole } from '@/lib/auth/require-staff'
import { loadMensaConfig, loadResolveOptions, resolveMenuConfigId, entroCutoff } from '@/lib/mensa/server'
import { resolveMenuGiorno } from '@/lib/mensa/resolveMenu'
import { notificaSaldoBasso } from '@/lib/mensa/notify'
import { controllaAllergie } from '@/lib/mensa/allergie-check'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { assertAlunnoNonSospeso } from '@/lib/pagamenti/sospensione'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Ruoli che possono FORZARE prenotazione/disdetta della mensa anche fuori orario
// (telefonate out-of-hours dei genitori dopo il cutoff), con saldo che può andare
// in negativo. La Segreteria è inclusa perché gestisce lo sportello (PRD §3:
// Segreteria↔Admin); dirigenza/FEA restano su liste esplicite altrove.
const STAFF_FORZA: readonly AppRole[] = ['admin', 'coordinator', 'segreteria']

const getQuerySchema = z.object({
  alunno_id: zUuid,
  // default dinamico (oggi) calcolato nell'handler
  from: zDataYMD.optional(),
  to: zDataYMD.optional(),
})

const postBodySchema = z.object({
  alunno_id: zUuid,
  // string singola o array non vuoto (comportamento attuale)
  date: z.union([zDataYMD, z.array(zDataYMD).min(1, 'date è obbligatorio')]),
})

const deleteQuerySchema = z.object({
  alunno_id: zUuid,
  data: zDataYMD,
})

// Verifica che un genitore sia legato all'alunno (union runtime+anagrafica).
async function genitoreDiAlunno(supabase: Awaited<ReturnType<typeof createAdminClient>>, genitoreId: string, alunnoId: string) {
  return genitoreHasFiglio(supabase, genitoreId, alunnoId)
}

async function saldoCorrente(supabase: Awaited<ReturnType<typeof createAdminClient>>, alunnoId: string): Promise<number> {
  const { data } = await supabase.from('ticket_mensa').select('saldo_ticket').eq('alunno_id', alunnoId).maybeSingle()
  return Number(data?.saldo_ticket ?? 0)
}

async function setSaldo(supabase: Awaited<ReturnType<typeof createAdminClient>>, alunnoId: string, saldo: number) {
  return supabase.from('ticket_mensa').upsert(
    { alunno_id: alunnoId, saldo_ticket: saldo, ultimo_carico: new Date().toISOString() },
    { onConflict: 'alunno_id' }
  )
}

// La RPC transazionale manca dal DB (E2E CI non migrato) quando PostgREST non la
// trova nel cache dello schema (PGRST202) o Postgres non la conosce (42883).
function rpcAssente(err: { code?: string } | null | undefined): boolean {
  return err?.code === 'PGRST202' || err?.code === '42883'
}

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>
type EsitoScalo = { ok: boolean; saldo: number; motivo?: string; fallback: boolean }
type OptsScalo = { alunnoId: string; scuolaId: string; data: string; origine: string; utenteId: string; saldoPrima: number }

// Scala 1 ticket + prenota + movimento di ledger in TRANSAZIONE atomica (RPC).
// Prima erano 3 scritture separate: se il movimento falliva, saldo e ledger
// divergevano in silenzio (findings m6). Se la RPC non c'è → fallback pulito.
async function scalaTicketPrenotaAtomico(supabase: SupabaseAdmin, opts: OptsScalo): Promise<EsitoScalo> {
  const { data: nuovoSaldo, error: rpcErr } = await supabase.rpc('scala_ticket_e_prenota', {
    p_alunno_id: opts.alunnoId, p_scuola_id: opts.scuolaId, p_data: opts.data,
    p_origine: opts.origine, p_utente_id: opts.utenteId,
  })
  if (!rpcErr) return { ok: true, saldo: Number(nuovoSaldo), fallback: false }
  if (rpcAssente(rpcErr)) return scalaTicketPrenotaFallback(supabase, opts)
  // Errore RPC "vero" (constraint, ecc.): la transazione ha fatto ROLLBACK, quindi
  // saldo e ledger NON divergono. Si logga e si segna la data come fallita.
  logEvento('db', 'error', { operazione: 'mensa/prenotazioni:POST', esito: 'rpc-scala-ticket-fallita' }, rpcErr)
  return { ok: false, saldo: opts.saldoPrima, motivo: 'Errore prenotazione', fallback: false }
}

// Percorso storico a 3 scritture (usato solo quando la RPC non esiste ancora).
async function scalaTicketPrenotaFallback(supabase: SupabaseAdmin, opts: OptsScalo): Promise<EsitoScalo> {
  const nuovo = opts.saldoPrima - 1
  const { error: sErr } = await setSaldo(supabase, opts.alunnoId, nuovo)
  if (sErr) return { ok: false, saldo: opts.saldoPrima, motivo: 'Errore saldo', fallback: true }

  const { data: pren, error: pErr } = await supabase.from('mensa_prenotazioni').upsert(
    { alunno_id: opts.alunnoId, scuola_id: opts.scuolaId, data: opts.data, stato: 'prenotato', origine: opts.origine, ticket_scalato: 1, prenotato_da: opts.utenteId },
    { onConflict: 'alunno_id,data' }
  ).select('id').single()
  if (pErr) {
    await setSaldo(supabase, opts.alunnoId, opts.saldoPrima) // ripristina il saldo
    return { ok: false, saldo: opts.saldoPrima, motivo: 'Errore prenotazione', fallback: true }
  }

  const { error: mErr } = await supabase.from('mensa_ticket_movimenti').insert({
    alunno_id: opts.alunnoId, scuola_id: opts.scuolaId, tipo: 'consumo', delta: -1,
    saldo_dopo: nuovo, prenotazione_id: pren?.id, origine: opts.origine, data: opts.data, creato_da: opts.utenteId,
  })
  if (mErr) {
    // Senza transazione il ticket È SCALATO ma il movimento non è nel ledger: divergenza
    // silenziosa (è esattamente il difetto che la RPC elimina). `error`, non `info`.
    logEvento('db', 'error', {
      operazione: 'mensa/prenotazioni:POST', esito: 'movimento-consumo-non-registrato', tipo: 'consumo',
    }, mErr)
  }
  return { ok: true, saldo: nuovo, fallback: true }
}

type EsitoDisdetta = { ok: boolean; saldo: number; fallback: boolean; error?: unknown }
type OptsDisdetta = { alunnoId: string; data: string; utenteId: string; scuolaId: string; prenId: string; ticket: number }

// Riaccredita il ticket + disdici + movimento in TRANSAZIONE atomica (RPC).
async function riaccreditaTicketDisdiciAtomico(supabase: SupabaseAdmin, opts: OptsDisdetta): Promise<EsitoDisdetta> {
  const { data: nuovoSaldo, error: rpcErr } = await supabase.rpc('riaccredita_ticket_e_disdici', {
    p_alunno_id: opts.alunnoId, p_data: opts.data, p_utente_id: opts.utenteId,
  })
  if (!rpcErr) return { ok: true, saldo: Number(nuovoSaldo), fallback: false }
  if (rpcAssente(rpcErr)) return riaccreditaTicketDisdiciFallback(supabase, opts)
  // Errore RPC "vero": ROLLBACK, nessuna divergenza → l'esito è un fallimento (500).
  return { ok: false, saldo: 0, fallback: false, error: rpcErr }
}

async function riaccreditaTicketDisdiciFallback(supabase: SupabaseAdmin, opts: OptsDisdetta): Promise<EsitoDisdetta> {
  const saldo = (await saldoCorrente(supabase, opts.alunnoId)) + opts.ticket
  await setSaldo(supabase, opts.alunnoId, saldo)
  await supabase.from('mensa_prenotazioni')
    .update({ stato: 'disdetto', prenotato_da: opts.utenteId })
    .eq('id', opts.prenId)

  const { error: mErr } = await supabase.from('mensa_ticket_movimenti').insert({
    alunno_id: opts.alunnoId, scuola_id: opts.scuolaId, tipo: 'disdetta', delta: opts.ticket,
    saldo_dopo: saldo, prenotazione_id: opts.prenId, origine: 'disdetta', data: opts.data, creato_da: opts.utenteId,
  })
  if (mErr) {
    // Come sopra: il ticket è RIACCREDITATO ma il movimento non è nel ledger → divergenza.
    logEvento('db', 'error', {
      operazione: 'mensa/prenotazioni:DELETE', esito: 'movimento-disdetta-non-registrato', tipo: 'disdetta',
    }, mErr)
  }
  return { ok: true, saldo, fallback: true }
}

// GET /api/mensa/prenotazioni?userId=&alunno_id=&from=&to=
//   genitore -> solo propri figli; staff -> qualsiasi alunno.
//   Ritorna { saldo, prenotazioni: [{data, stato, origine}] }.
export const GET = withRoute('mensa/prenotazioni:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const alunnoId = q.data.alunno_id

    const supabase = await createAdminClient()
    const isStaff = STAFF_FORZA.includes(user.role)
    if (!isStaff && !(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const today = new Date().toISOString().slice(0, 10)
    const from = q.data.from ?? today
    const to = q.data.to ?? today

    const [{ data: pren }, saldo, { data: al }] = await Promise.all([
      supabase
        .from('mensa_prenotazioni')
        .select('data, stato, origine')
        .eq('alunno_id', alunnoId)
        .gte('data', from).lte('data', to)
        .order('data', { ascending: true }),
      saldoCorrente(supabase, alunnoId),
      supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle(),
    ])

    // Orario limite (cutoff) per prenotare/disdire "oggi": mostrato in UI così
    // il genitore lo conosce prima di provare (config per scuola, default 09:30).
    let cutoffOra: string | null = null
    if (al?.scuola_id) {
      const config = await loadMensaConfig(supabase, al.scuola_id as string)
      cutoffOra = config.cutoffOra
    }

    return NextResponse.json({ success: true, data: { saldo, prenotazioni: pren ?? [], cutoffOra } })
  } catch (err) {
    logErrore({ operazione: 'mensa/prenotazioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/mensa/prenotazioni
// Body: { userId, alunno_id, date: string|string[], origine? }
//   genitore: origine='genitore', blocco se saldo <= 0; rispetta cutoff/giorni attivi.
//   staff (admin/coordinator/segreteria): origine='segreteria', può forzare le richieste
//     arrivate fuori orario (telefonata del genitore dopo il cutoff) — salta cutoff e blocco
//     saldo, che può andare in negativo; rispetta solo i giorni attivi.
export const POST = withRoute('mensa/prenotazioni:POST', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const alunnoId = b.data.alunno_id
    const dates: string[] = Array.isArray(b.data.date) ? b.data.date : [b.data.date]

    const supabase = await createAdminClient()
    const isStaff = STAFF_FORZA.includes(user.role)
    const origine = isStaff ? 'segreteria' : 'genitore'
    if (!isStaff) {
      if (!(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
        return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
      }
      // Morosità (B4/M4): un genitore con figlio SOSPESO non può prenotare — è
      // un'azione di servizio. La sospensione NON tocca login/letture (sicurezza
      // del minore); lo staff (STAFF_FORZA) resta abilitato a forzare allo sportello.
      const sospesoErr = await assertAlunnoNonSospeso(supabase, alunnoId)
      if (sospesoErr) return sospesoErr
    }

    // scuola dell'alunno + nome (per notifiche)
    const { data: al } = await supabase.from('alunni').select('scuola_id, nome, cognome, classe_sezione, section_id, allergies, allergeni').eq('id', alunnoId).maybeSingle()
    if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    const scuolaId = al.scuola_id as string
    const config = await loadMensaConfig(supabase, scuolaId)
    // Usa la prima data richiesta per determinare il menu attivo (approx per range)
    const primaData = dates[0]
    const menuConfigId = await resolveMenuConfigId(supabase, scuolaId, al?.classe_sezione, primaData)
    const options = await loadResolveOptions(supabase, scuolaId, config, menuConfigId)

    let saldo = await saldoCorrente(supabase, alunnoId)
    const esiti: { data: string; ok: boolean; motivo?: string }[] = []
    let fallbackUsato = false

    for (const data of dates) {
      const menu = resolveMenuGiorno(data, options)
      if (!menu.attivo || menu.chiuso) {
        esiti.push({ data, ok: false, motivo: 'Giorno non attivo o mensa chiusa' }); continue
      }
      // cutoff: solo il genitore lo rispetta; lo staff lo salta (anche date passate)
      if (!isStaff && !entroCutoff(data, config.cutoffOra)) {
        esiti.push({ data, ok: false, motivo: 'Oltre l\'orario limite (cutoff)' }); continue
      }
      // già prenotato attivo?
      const { data: existing } = await supabase
        .from('mensa_prenotazioni').select('id, stato').eq('alunno_id', alunnoId).eq('data', data).maybeSingle()
      if (existing?.stato === 'prenotato') {
        esiti.push({ data, ok: true, motivo: 'Già prenotato' }); continue
      }
      // blocco saldo per il genitore
      if (!isStaff && saldo <= 0) {
        esiti.push({ data, ok: false, motivo: 'Saldo ticket esaurito' }); continue
      }

      // scala 1 ticket + prenotazione + movimento ledger, TUTTO-O-NIENTE (RPC).
      const esito = await scalaTicketPrenotaAtomico(supabase, {
        alunnoId, scuolaId, data, origine, utenteId: user.id, saldoPrima: saldo,
      })
      if (esito.fallback) fallbackUsato = true
      if (!esito.ok) { esiti.push({ data, ok: false, motivo: esito.motivo }); continue }
      saldo = esito.saldo
      esiti.push({ data, ok: true })
    }

    // La RPC transazionale non c'era (DB E2E CI non migrato): si è degradato al
    // percorso storico a 3 scritture. Warn una volta per richiesta (non per data).
    if (fallbackUsato) {
      logEvento('mensa', 'warn', { operazione: 'mensa/prenotazioni:POST', esito: 'rpc-mensa-assente-fallback' })
    }

    // notifica saldo basso (best-effort) se sceso sotto soglia per effetto degli scali
    if (saldo < config.sogliaSaldoBasso && esiti.some(e => e.ok)) {
      await notificaSaldoBasso(supabase, { alunnoId, saldo, nomeAlunno: al ? `${al.nome} ${al.cognome}` : null })
    }

    // alert allergie (best-effort): se il menu di una data prenotata contiene
    // allergeni dell'alunno → avvisa segreteria/cuoca/insegnanti.
    if (al) {
      const alunnoAllergie = {
        id: alunnoId, nome: al.nome, cognome: al.cognome,
        classe_sezione: al.classe_sezione ?? null, section_id: (al.section_id as string | null) ?? null,
        scuola_id: scuolaId,
        allergies: al.allergies ?? null, allergeni: (al.allergeni as string[] | null) ?? null,
      }
      for (const e of esiti) {
        if (e.ok && e.motivo !== 'Già prenotato') {
          await controllaAllergie(supabase, alunnoAllergie, e.data, scuolaId, options)
        }
      }
    }

    // Evento critico (movimento ticket) → si logga anche il SUCCESSO: solo
    // conteggi/saldo/origine, nessun dato personale.
    const esitiOk = esiti.filter((e) => e.ok).length
    const esitiKo = esiti.length - esitiOk
    logEvento('mensa', 'info', {
      operazione: 'mensa/prenotazioni:POST',
      esito: 'prenotazione',
      esitiOk,
      esitiKo,
      saldoDopo: saldo,
      origine,
    })
    // Lo staff ha forzato una prenotazione portando il saldo in NEGATIVO (l'alunno
    // confluisce nei morosi): segnale dedicato. `alunno_id` è uuid → in chiaro per
    // la lista bianca; nessun nome né dato personale.
    if (isStaff && saldo < 0 && esitiOk > 0) {
      logEvento('mensa', 'info', {
        operazione: 'mensa/prenotazioni:POST',
        tipo: 'saldo-negativo',
        alunno_id: alunnoId,
        saldo,
        origine,
      })
    }

    return NextResponse.json({ success: true, data: { saldo, esiti } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'mensa/prenotazioni:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/mensa/prenotazioni?userId=&alunno_id=&data=
//   disdici: riaccredita il ticket. Il genitore solo entro cutoff; lo staff può forzare
//   anche fuori orario / su date passate (telefonata out-of-hours per disdire).
export const DELETE = withRoute('mensa/prenotazioni:DELETE', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { alunno_id: alunnoId, data } = q.data

    const supabase = await createAdminClient()
    const isStaff = STAFF_FORZA.includes(user.role)
    if (!isStaff && !(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle()
    if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    const scuolaId = al.scuola_id as string
    const config = await loadMensaConfig(supabase, scuolaId)

    // Lo staff (STAFF_FORZA) può disdire anche fuori orario / su date passate:
    // rettifica con riaccredito del ticket, simmetrica al POST (dove lo staff può
    // prenotare date passate). Il genitore resta vincolato al cutoff.
    if (!isStaff && !entroCutoff(data, config.cutoffOra)) {
      return NextResponse.json({ error: 'Oltre l\'orario limite: disdetta non più possibile' }, { status: 400 })
    }

    const { data: existing } = await supabase
      .from('mensa_prenotazioni').select('id, stato, ticket_scalato').eq('alunno_id', alunnoId).eq('data', data).maybeSingle()
    if (!existing || existing.stato !== 'prenotato') {
      return NextResponse.json({ error: 'Nessuna prenotazione attiva per questa data' }, { status: 404 })
    }

    // riaccredito + stato disdetto + movimento in TRANSAZIONE atomica (RPC).
    const ticket = Number(existing.ticket_scalato ?? 1)
    const esito = await riaccreditaTicketDisdiciAtomico(supabase, {
      alunnoId, data, utenteId: user.id, scuolaId, prenId: existing.id as string, ticket,
    })
    if (esito.fallback) {
      logEvento('mensa', 'warn', { operazione: 'mensa/prenotazioni:DELETE', esito: 'rpc-mensa-assente-fallback' })
    }
    if (!esito.ok) {
      // Errore RPC "vero" (ROLLBACK, nessuna divergenza): 500 con log esplicito —
      // `withRoute` non vede questo ritorno anticipato, quindi il log è d'obbligo.
      logErrore({ operazione: 'mensa/prenotazioni:DELETE', stato: 500 }, esito.error)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
    const saldo = esito.saldo

    // Evento critico (riaccredito ticket) → si logga anche il SUCCESSO: saldo dopo
    // il riaccredito + origine (staff che forza fuori orario vs genitore). No PII.
    logEvento('mensa', 'info', {
      operazione: 'mensa/prenotazioni:DELETE',
      esito: 'disdetta',
      saldoDopo: saldo,
      origine: isStaff ? 'segreteria' : 'genitore',
    })

    return NextResponse.json({ success: true, data: { saldo } })
  } catch (err) {
    logErrore({ operazione: 'mensa/prenotazioni:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
