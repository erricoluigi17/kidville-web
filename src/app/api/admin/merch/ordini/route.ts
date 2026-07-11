import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente, assertAlunnoInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { derivaStatoTestata } from '@/lib/merch/stati'

// Ordini Merchandise lato staff (Fase B) — creazione SOLO segreteria (il genitore
// vede l'addebito in /parent/pagamenti). Prezzi/snapshot SERVER-SIDE; parent_id
// NULL (intestatari.ts ricade su split/intestatario standard). Ogni riga ha uno
// stato logistico proprio (default da_ordinare); la testata resta nel vocabolario
// legacy ed è derivata. Service-role + scoping + audit; degrade su DB non migrato.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])
const RIGHE_FULL = 'id, articolo_id, articolo_nome, taglia, quantita, prezzo_unitario, stato, origine, ordine_fornitore_id, ordinato_il, arrivato_il, consegnato_il, nota'
const RIGHE_BASE = 'id, articolo_id, articolo_nome, taglia, quantita, prezzo_unitario'
const CAMPI_RIGA_NUOVI = ['stato', 'origine'] as const

const getQuerySchema = z.object({
  stato: z.enum(['inviato', 'confermato', 'consegnato', 'annullato']).optional(),
  stato_riga: z.enum(['da_ordinare', 'ordinato', 'arrivato', 'consegnato', 'annullato']).optional(),
  q: z.string().trim().max(120).optional(),
})

const postBodySchema = z.object({
  alunno_id: zUuid,
  righe: z
    .array(
      z.object({
        articolo_id: zUuid,
        taglia: z.string().trim().max(40).default(''),
        quantita: z.coerce.number().int().min(1, 'Quantità minima 1').max(200, 'Quantità massima 200'),
      }),
      { error: 'Aggiungi almeno una riga' }
    )
    .min(1, 'Aggiungi almeno una riga'),
  note: z.string().trim().max(500).nullish(),
})

const patchBodySchema = z.object({
  id: zUuid,
  stato: z.enum(['inviato', 'confermato', 'consegnato', 'annullato']),
})

function ordiniSelect(righeCols: string): string {
  return (
    'id, scuola_id, alunno_id, parent_id, stato, totale, pagamento_id, note, creato_il, ' +
    'alunni:alunno_id ( nome, cognome, classe_sezione ), ' +
    'pagamento:pagamento_id ( id, stato, importo, importo_pagato ), ' +
    `righe:divise_ordini_righe ( ${righeCols} )`
  )
}

// GET /api/admin/merch/ordini — ordini dei plessi (alunno + righe + pagamento).
// Filtri: stato (testata), stato_riga (≥1 riga in quello stato), q (nome alunno).
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const p = parseQuery(request, getQuerySchema)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

    const run = (righeCols: string) => {
      let query = supabase
        .from('divise_ordini')
        .select(ordiniSelect(righeCols))
        .in('scuola_id', plessi)
        .order('creato_il', { ascending: false })
        .limit(200)
      if (p.data.stato) query = query.eq('stato', p.data.stato)
      return query
    }
    let r = await run(RIGHE_FULL)
    if (r.error && SCHEMA_MANCANTE.has(r.error.code ?? '')) r = await run(RIGHE_BASE)
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 })

    type Riga = { stato?: string | null }
    type Ordine = { righe?: Riga[] | null; alunni?: { nome?: string; cognome?: string } | null }
    let data = ((r.data as unknown as Ordine[]) ?? [])

    if (p.data.stato_riga) {
      data = data.filter((o) => (o.righe ?? []).some((rg) => (rg.stato ?? 'da_ordinare') === p.data.stato_riga))
    }
    if (p.data.q) {
      const term = p.data.q.toLowerCase()
      data = data.filter((o) => {
        const nome = `${o.alunni?.nome ?? ''} ${o.alunni?.cognome ?? ''}`.toLowerCase()
        return nome.includes(term)
      })
    }
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API GET merch/ordini:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/admin/merch/ordini — la segreteria crea un ordine per un alunno.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { alunno_id, righe, note } = b.data

    const supabase = await createAdminClient()
    const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunno_id)
    if (scopeErr) return scopeErr

    const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
    const scuolaId = (al?.scuola_id as string) ?? null
    if (!scuolaId) return NextResponse.json({ error: 'Alunno senza plesso' }, { status: 400 })

    // Articoli richiesti: caricati dal DB, validati (attivi, stessa scuola).
    const articoloIds = [...new Set(righe.map((r) => r.articolo_id))]
    const { data: articoli } = await supabase
      .from('divise_articoli')
      .select('id, nome, prezzo, taglie, attivo, scuola_id')
      .in('id', articoloIds)
    const byId = new Map((articoli ?? []).map((a) => [a.id as string, a]))

    const righeOrdine: { articolo_id: string; articolo_nome: string; taglia: string; quantita: number; prezzo_unitario: number }[] = []
    let totale = 0
    for (const r of righe) {
      const a = byId.get(r.articolo_id)
      if (!a || a.attivo !== true || a.scuola_id !== scuolaId) {
        return NextResponse.json({ error: 'Articolo non disponibile' }, { status: 400 })
      }
      const taglie = (a.taglie as string[]) ?? []
      // Taglia obbligatoria SOLO se l'articolo ha taglie (fix del bug latente).
      if (taglie.length > 0 && !taglie.includes(r.taglia)) {
        return NextResponse.json({ error: `Taglia "${r.taglia || '—'}" non valida per ${a.nome}` }, { status: 400 })
      }
      const prezzo = Number(a.prezzo)
      totale += prezzo * r.quantita
      righeOrdine.push({
        articolo_id: r.articolo_id,
        articolo_nome: a.nome as string,
        taglia: taglie.length > 0 ? r.taglia : '',
        quantita: r.quantita,
        prezzo_unitario: prezzo,
      })
    }
    totale = Math.round(totale * 100) / 100

    // 1) ordine (testata legacy: tutte le righe da_ordinare → 'inviato')
    const statoTestata = derivaStatoTestata(righeOrdine.map(() => 'da_ordinare'))
    const { data: ordine, error: ordErr } = await supabase
      .from('divise_ordini')
      .insert({ scuola_id: scuolaId, alunno_id, parent_id: null, stato: statoTestata, totale, note: note ?? null })
      .select('id')
      .single()
    if (ordErr || !ordine) {
      return NextResponse.json({ error: ordErr?.message ?? 'Creazione ordine fallita' }, { status: 500 })
    }

    // 2) righe con stato logistico (degrade: PGRST204 → senza stato/origine)
    const righeRows = righeOrdine.map((r) => ({ ordine_id: ordine.id, ...r, stato: 'da_ordinare', origine: 'fornitore' }))
    let righeErr = (await supabase.from('divise_ordini_righe').insert(righeRows)).error
    if (righeErr && SCHEMA_MANCANTE.has(righeErr.code ?? '')) {
      const legacy = righeRows.map((r) => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) if (!(CAMPI_RIGA_NUOVI as readonly string[]).includes(k)) out[k] = v
        return out
      })
      righeErr = (await supabase.from('divise_ordini_righe').insert(legacy)).error
    }
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

    // 4) pagamento da saldare (offline), descrizione "Merchandise: …"
    const descrizione = 'Merchandise: ' + righeOrdine.map((r) => `${r.quantita}× ${r.articolo_nome}${r.taglia ? ` (${r.taglia})` : ''}`).join(', ')
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
        creato_da: auth.user.id,
        stato: 'da_pagare',
      })
      .select('id')
      .single()
    if (pagErr || !pagamento) {
      return NextResponse.json({ error: pagErr?.message ?? 'Addebito non creato' }, { status: 500 })
    }

    // 5) collega il pagamento all'ordine
    await supabase.from('divise_ordini').update({ pagamento_id: pagamento.id }).eq('id', ordine.id)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_ordine',
      entitaId: ordine.id,
      azione: 'insert',
      scuolaId,
      valoreDopo: { alunno_id, totale, righe: righeOrdine.length, pagamento_id: pagamento.id },
    })

    return NextResponse.json(
      { success: true, data: { ordine_id: ordine.id, pagamento_id: pagamento.id, totale } },
      { status: 201 }
    )
  } catch (err) {
    console.error('Errore API POST merch/ordini:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/merch/ordini — avanza lo stato della testata (legacy fallback)
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, stato } = b.data

    const supabase: SupabaseClient = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: existing } = await supabase
      .from('divise_ordini')
      .select('id, scuola_id, stato')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Ordine non trovato' }, { status: 404 })
    if (!plessi.includes(existing.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: ordine fuori dal tuo plesso' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from('divise_ordini')
      .update({ stato })
      .eq('id', id)
      .select('id, stato')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_ordine',
      entitaId: id,
      azione: 'update',
      scuolaId: existing.scuola_id as string,
      valorePrima: { stato: existing.stato },
      valoreDopo: { stato },
    })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH merch/ordini:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
