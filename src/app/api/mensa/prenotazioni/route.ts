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
    if (!isStaff && !(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
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

      // scala 1 ticket + upsert prenotazione (stato prenotato)
      saldo = saldo - 1
      const { error: sErr } = await setSaldo(supabase, alunnoId, saldo)
      if (sErr) { saldo = saldo + 1; esiti.push({ data, ok: false, motivo: 'Errore saldo' }); continue }

      const { data: pren, error: pErr } = await supabase.from('mensa_prenotazioni').upsert(
        {
          alunno_id: alunnoId, scuola_id: scuolaId, data, stato: 'prenotato',
          origine, ticket_scalato: 1, prenotato_da: user.id,
        },
        { onConflict: 'alunno_id,data' }
      ).select('id').single()
      if (pErr) { saldo = saldo + 1; await setSaldo(supabase, alunnoId, saldo); esiti.push({ data, ok: false, motivo: 'Errore prenotazione' }); continue }
      // movimento ledger ticket (best-effort): consumo -1
      const { error: mErr } = await supabase.from('mensa_ticket_movimenti').insert({
        alunno_id: alunnoId, scuola_id: scuolaId, tipo: 'consumo', delta: -1,
        saldo_dopo: saldo, prenotazione_id: pren?.id, origine, data, creato_da: user.id,
      })
      if (mErr) {
        // `error` benché la prenotazione sia riuscita: il ticket È STATO SCALATO dal saldo ma il
        // movimento non è finito nel ledger. È esattamente una scrittura persa — il saldo e il
        // libro mastro divergono, e a fine mese i conti non torneranno senza che nulla, da
        // nessuna parte, dica perché.
        logEvento('db', 'error', {
          operazione: 'mensa/prenotazioni:POST',
          esito: 'movimento-consumo-non-registrato',
          tipo: 'consumo',
        }, mErr)
      }
      esiti.push({ data, ok: true })
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

    // riaccredito + stato disdetto
    const saldo = (await saldoCorrente(supabase, alunnoId)) + Number(existing.ticket_scalato ?? 1)
    await setSaldo(supabase, alunnoId, saldo)
    await supabase.from('mensa_prenotazioni')
      .update({ stato: 'disdetto', prenotato_da: user.id })
      .eq('id', existing.id)

    // movimento ledger ticket (best-effort): disdetta +ticket_scalato
    const { error: mErr } = await supabase.from('mensa_ticket_movimenti').insert({
      alunno_id: alunnoId, scuola_id: scuolaId, tipo: 'disdetta', delta: Number(existing.ticket_scalato ?? 1),
      saldo_dopo: saldo, prenotazione_id: existing.id, origine: 'disdetta', data, creato_da: user.id,
    })
    if (mErr) {
      // Come sopra: il ticket è stato RIACCREDITATO ma il movimento non è nel ledger. Saldo e
      // libro mastro divergono in silenzio → `error`, anche se la disdetta è andata a buon fine.
      logEvento('db', 'error', {
        operazione: 'mensa/prenotazioni:DELETE',
        esito: 'movimento-disdetta-non-registrato',
        tipo: 'disdetta',
      }, mErr)
    }

    return NextResponse.json({ success: true, data: { saldo } })
  } catch (err) {
    logErrore({ operazione: 'mensa/prenotazioni:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
