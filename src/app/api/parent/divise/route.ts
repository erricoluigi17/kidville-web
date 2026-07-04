import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// Shop divise lato genitore (step 14). GET: articoli attivi della scuola del
// figlio + ordini passati del genitore. POST: crea un ordine con PREZZI/TOTALE
// RICALCOLATI SERVER-SIDE (mai fidarsi del client) e genera un pagamento
// "da_pagare" da saldare offline (categoria 'divisa'), collegato all'ordine.

const getQuerySchema = z.object({ alunno_id: zUuid })

const postBodySchema = z.object({
  alunno_id: zUuid,
  righe: z
    .array(
      z.object({
        articolo_id: zUuid,
        taglia: z.string().trim().min(1, 'Taglia obbligatoria'),
        quantita: z.coerce.number().int().min(1, 'Quantità minima 1').max(20, 'Quantità massima 20'),
      }),
      { error: 'Il carrello è vuoto' }
    )
    .min(1, 'Il carrello è vuoto'),
})

/** Verifica che l'utente sia genitore dell'alunno; ritorna la scuola dell'alunno o null. */
async function scuolaSeGenitore(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  genitoreId: string,
  alunnoId: string
): Promise<string | null> {
  const { data: legame } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', genitoreId)
    .eq('alunno_id', alunnoId)
    .maybeSingle()
  if (!legame) return null
  const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle()
  return (al?.scuola_id as string) ?? null
}

// GET /api/parent/divise?alunno_id= — catalogo attivo + ordini del genitore
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunno_id } = q.data

    const supabase = await createAdminClient()
    const scuolaId = await scuolaSeGenitore(supabase, user.id, alunno_id)
    if (!scuolaId) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

    const [{ data: articoli }, { data: ordini }] = await Promise.all([
      supabase
        .from('divise_articoli')
        .select('id, nome, descrizione, taglie, prezzo')
        .eq('scuola_id', scuolaId)
        .eq('attivo', true)
        .order('ordine', { ascending: true })
        .order('nome', { ascending: true }),
      supabase
        .from('divise_ordini')
        .select('id, stato, totale, pagamento_id, creato_il, righe:divise_ordini_righe ( id, articolo_nome, taglia, quantita, prezzo_unitario )')
        .eq('parent_id', user.id)
        .eq('alunno_id', alunno_id)
        .order('creato_il', { ascending: false })
        .limit(50),
    ])

    return NextResponse.json({ success: true, data: { articoli: articoli ?? [], ordini: ordini ?? [] } })
  } catch (err) {
    console.error('Errore API GET parent/divise:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/parent/divise — crea ordine + pagamento da saldare
export async function POST(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { alunno_id, righe } = b.data

    const supabase = await createAdminClient()
    const scuolaId = await scuolaSeGenitore(supabase, user.id, alunno_id)
    if (!scuolaId) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

    // Articoli richiesti: caricati dal DB, validati (attivi, stessa scuola, taglia valida).
    const articoloIds = [...new Set(righe.map((r) => r.articolo_id))]
    const { data: articoli } = await supabase
      .from('divise_articoli')
      .select('id, nome, prezzo, taglie, attivo, scuola_id')
      .in('id', articoloIds)
    const byId = new Map((articoli ?? []).map((a) => [a.id as string, a]))

    // Righe ordine con prezzi SERVER-SIDE + totale.
    const righeOrdine: { articolo_id: string; articolo_nome: string; taglia: string; quantita: number; prezzo_unitario: number }[] = []
    let totale = 0
    for (const r of righe) {
      const a = byId.get(r.articolo_id)
      if (!a || a.attivo !== true || a.scuola_id !== scuolaId) {
        return NextResponse.json({ error: 'Articolo non disponibile' }, { status: 400 })
      }
      const taglie = (a.taglie as string[]) ?? []
      if (taglie.length > 0 && !taglie.includes(r.taglia)) {
        return NextResponse.json({ error: `Taglia "${r.taglia}" non disponibile per ${a.nome}` }, { status: 400 })
      }
      const prezzo = Number(a.prezzo)
      totale += prezzo * r.quantita
      righeOrdine.push({
        articolo_id: r.articolo_id,
        articolo_nome: a.nome as string,
        taglia: r.taglia,
        quantita: r.quantita,
        prezzo_unitario: prezzo,
      })
    }
    totale = Math.round(totale * 100) / 100

    // 1) ordine
    const { data: ordine, error: ordErr } = await supabase
      .from('divise_ordini')
      .insert({ scuola_id: scuolaId, alunno_id, parent_id: user.id, stato: 'inviato', totale })
      .select('id')
      .single()
    if (ordErr || !ordine) {
      return NextResponse.json({ error: ordErr?.message ?? 'Creazione ordine fallita' }, { status: 500 })
    }

    // 2) righe
    const { error: righeErr } = await supabase
      .from('divise_ordini_righe')
      .insert(righeOrdine.map((r) => ({ ordine_id: ordine.id, ...r })))
    if (righeErr) {
      await supabase.from('divise_ordini').delete().eq('id', ordine.id) // rollback best-effort
      return NextResponse.json({ error: righeErr.message }, { status: 500 })
    }

    // 3) categoria 'divisa' (preferisci quella della scuola, altrimenti globale)
    const { data: cats } = await supabase
      .from('payment_categories')
      .select('id, scuola_id')
      .eq('slug', 'divisa')
      .or(`scuola_id.is.null,scuola_id.eq.${scuolaId}`)
    const cat = (cats ?? []).find((c) => c.scuola_id === scuolaId) ?? (cats ?? []).find((c) => c.scuola_id === null)

    // 4) pagamento da saldare (offline)
    const descrizione =
      'Divise: ' + righeOrdine.map((r) => `${r.quantita}× ${r.articolo_nome} (${r.taglia})`).join(', ')
    const scadenza = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const { data: pagamento, error: pagErr } = await supabase
      .from('pagamenti')
      .insert({
        alunno_id,
        scuola_id: scuolaId,
        descrizione: descrizione.slice(0, 300),
        importo: totale,
        scadenza,
        categoria_id: cat?.id ?? null,
        tipo: 'singolo',
        obbligatorio: false,
        creato_da: user.id,
        stato: 'da_pagare',
      })
      .select('id')
      .single()
    if (pagErr || !pagamento) {
      // l'ordine resta valido anche senza addebito automatico; segnala l'errore
      return NextResponse.json({ error: pagErr?.message ?? 'Addebito non creato' }, { status: 500 })
    }

    // 5) collega il pagamento all'ordine
    await supabase.from('divise_ordini').update({ pagamento_id: pagamento.id }).eq('id', ordine.id)

    return NextResponse.json(
      { success: true, data: { ordine_id: ordine.id, pagamento_id: pagamento.id, totale } },
      { status: 201 }
    )
  } catch (err) {
    console.error('Errore API POST parent/divise:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
