import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { loadMensaConfig, loadResolveOptions, resolveMenuConfigId, entroCutoff, DEFAULT_SCUOLA } from '@/lib/mensa/server'
import { resolveMenuGiorno } from '@/lib/mensa/resolveMenu'
import { notificaSaldoBasso } from '@/lib/mensa/notify'
import { controllaAllergie } from '@/lib/mensa/allergie-check'

// Verifica che un genitore sia legato all'alunno.
async function genitoreDiAlunno(supabase: Awaited<ReturnType<typeof createAdminClient>>, genitoreId: string, alunnoId: string) {
  const { data } = await supabase
    .from('legame_genitori_alunni').select('alunno_id')
    .eq('genitore_id', genitoreId).eq('alunno_id', alunnoId).maybeSingle()
  return !!data
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
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { searchParams } = new URL(request.url)
    const alunnoId = searchParams.get('alunno_id')
    if (!alunnoId) return NextResponse.json({ error: 'alunno_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const isStaff = user.role === 'admin' || user.role === 'coordinator'
    if (!isStaff && !(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const today = new Date().toISOString().slice(0, 10)
    const from = searchParams.get('from') ?? today
    const to = searchParams.get('to') ?? today

    const [{ data: pren }, saldo] = await Promise.all([
      supabase
        .from('mensa_prenotazioni')
        .select('data, stato, origine')
        .eq('alunno_id', alunnoId)
        .gte('data', from).lte('data', to)
        .order('data', { ascending: true }),
      saldoCorrente(supabase, alunnoId),
    ])

    return NextResponse.json({ success: true, data: { saldo, prenotazioni: pren ?? [] } })
  } catch (err) {
    console.error('Errore API GET mensa/prenotazioni:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/mensa/prenotazioni
// Body: { userId, alunno_id, date: string|string[], origine? }
//   genitore: origine='genitore', blocco se saldo <= 0; rispetta cutoff/giorni attivi.
//   staff: origine='segreteria', può forzare (saldo va negativo); rispetta solo giorni attivi.
export async function POST(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const body = await request.json()
    const alunnoId = body.alunno_id as string
    const dates: string[] = Array.isArray(body.date) ? body.date : body.date ? [body.date] : []
    if (!alunnoId || dates.length === 0) {
      return NextResponse.json({ error: 'alunno_id e date sono obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const isStaff = user.role === 'admin' || user.role === 'coordinator'
    const origine = isStaff ? 'segreteria' : 'genitore'
    if (!isStaff && !(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    // scuola dell'alunno + nome (per notifiche)
    const { data: al } = await supabase.from('alunni').select('scuola_id, nome, cognome, classe_sezione, section_id, allergies, allergeni').eq('id', alunnoId).single()
    const scuolaId = al?.scuola_id ?? DEFAULT_SCUOLA
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
      // cutoff: il genitore deve rispettarlo; la segreteria può forzare i giorni passati? no -> sì futuri/oggi
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

      const { error: pErr } = await supabase.from('mensa_prenotazioni').upsert(
        {
          alunno_id: alunnoId, scuola_id: scuolaId, data, stato: 'prenotato',
          origine, ticket_scalato: 1, prenotato_da: user.id,
        },
        { onConflict: 'alunno_id,data' }
      )
      if (pErr) { saldo = saldo + 1; await setSaldo(supabase, alunnoId, saldo); esiti.push({ data, ok: false, motivo: 'Errore prenotazione' }); continue }
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
    console.error('Errore API POST mensa/prenotazioni:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/mensa/prenotazioni?userId=&alunno_id=&data=
//   disdici: riaccredita il ticket se entro cutoff (genitore) o sempre (staff, entro cutoff giorni futuri).
export async function DELETE(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { searchParams } = new URL(request.url)
    const alunnoId = searchParams.get('alunno_id')
    const data = searchParams.get('data')
    if (!alunnoId || !data) return NextResponse.json({ error: 'alunno_id e data sono obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()
    const isStaff = user.role === 'admin' || user.role === 'coordinator'
    if (!isStaff && !(await genitoreDiAlunno(supabase, user.id, alunnoId))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).single()
    const scuolaId = al?.scuola_id ?? DEFAULT_SCUOLA
    const config = await loadMensaConfig(supabase, scuolaId)

    if (!entroCutoff(data, config.cutoffOra)) {
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

    return NextResponse.json({ success: true, data: { saldo } })
  } catch (err) {
    console.error('Errore API DELETE mensa/prenotazioni:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
