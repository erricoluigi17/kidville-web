import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sincronizzaTestata } from '@/lib/merch/stati'

// Ordini d'acquisto (PO) al fornitore — un PO per fornitore.
//  GET   lista PO dei plessi con righe collegate.
//  POST  { fornitore_id?, righe_ids[] } → se fornitore_id crea un PO numerato
//        (PO-AAAA-NNN) e marca le righe 'ordinato'; senza fornitore_id marca
//        solo 'ordinato' (bucket "Senza fornitore", nessun PO).
//  PATCH { id, stato:'annullato' } → annulla il PO; le righe tornano da_ordinare.
// Service-role + scoping + audit; degrada su DB non migrato.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])

const postBodySchema = z.object({
  fornitore_id: zUuid.nullish(),
  righe_ids: z.array(zUuid).min(1, 'Seleziona almeno una riga'),
})

const patchBodySchema = z.object({
  id: zUuid,
  stato: z.literal('annullato'),
})

async function syncTestate(supabase: SupabaseClient, ordineIds: string[]): Promise<void> {
  for (const id of [...new Set(ordineIds)]) await sincronizzaTestata(supabase, id)
}

// GET — lista PO dei plessi dell'utente (con righe collegate)
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('merch_ordini_fornitore')
      .select('id, scuola_id, fornitore_id, fornitore_nome, numero, anno, stato, note, creato_il, chiuso_il, ' +
        'righe:divise_ordini_righe ( id, articolo_nome, taglia, quantita, stato, ordine_id )')
      .in('scuola_id', plessi)
      .order('creato_il', { ascending: false })
      .limit(200)
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: [] })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('Errore API GET merch/ordini-fornitore:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST — genera un PO per un fornitore (o marca ordinato senza PO)
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { fornitore_id, righe_ids } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    // Righe: devono esistere, essere 'da_ordinare' e nello stesso plesso in scope.
    type R = { id: string; stato: string; ordine_id: string; ordine: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null }
    const { data: righeRaw, error: righeErr } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, ordine_id, ordine:ordine_id ( scuola_id )')
      .in('id', righe_ids)
    if (righeErr) {
      if (SCHEMA_MANCANTE.has(righeErr.code ?? '')) return NextResponse.json({ success: true, data: { po: null, righe: 0, degraded: true } })
      return NextResponse.json({ error: righeErr.message }, { status: 500 })
    }
    const righe = (righeRaw as unknown as R[]) ?? []
    if (righe.length !== righe_ids.length) {
      return NextResponse.json({ error: 'Alcune righe non esistono' }, { status: 400 })
    }
    const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))
    const scuole = new Set(righe.map((r) => uno(r.ordine)?.scuola_id ?? ''))
    if (scuole.size !== 1) return NextResponse.json({ error: 'Le righe appartengono a plessi diversi' }, { status: 400 })
    const scuolaId = [...scuole][0]
    if (!scuolaId || !plessi.includes(scuolaId)) {
      return NextResponse.json({ error: 'Righe fuori dal tuo plesso' }, { status: 403 })
    }
    if (righe.some((r) => r.stato !== 'da_ordinare')) {
      return NextResponse.json({ error: 'Alcune righe non sono più da ordinare' }, { status: 409 })
    }

    // PO numerato (solo se fornitore indicato).
    let po: { id: string; numero: string } | null = null
    if (fornitore_id) {
      const { data: forn } = await supabase.from('merch_fornitori').select('id, nome, scuola_id').eq('id', fornitore_id).maybeSingle()
      if (!forn || forn.scuola_id !== scuolaId) {
        return NextResponse.json({ error: 'Fornitore non valido per il plesso' }, { status: 400 })
      }
      const anno = new Date().getFullYear()
      const num = await supabase.rpc('prossimo_numero_po', { p_scuola: scuolaId, p_anno: anno })
      if (num.error || typeof num.data !== 'number') {
        if (SCHEMA_MANCANTE.has(num.error?.code ?? '')) return NextResponse.json({ success: true, data: { po: null, righe: 0, degraded: true } })
        return NextResponse.json({ error: num.error?.message ?? 'Numerazione PO fallita' }, { status: 500 })
      }
      const numero = `PO-${anno}-${String(num.data).padStart(3, '0')}`
      const { data: poRow, error: poErr } = await supabase
        .from('merch_ordini_fornitore')
        .insert({ scuola_id: scuolaId, fornitore_id: forn.id, fornitore_nome: forn.nome, numero, anno, stato: 'aperto', creato_da: auth.user.id })
        .select('id, numero')
        .single()
      if (poErr || !poRow) return NextResponse.json({ error: poErr?.message ?? 'Creazione PO fallita' }, { status: 500 })
      po = { id: poRow.id as string, numero: poRow.numero as string }
    }

    // Marca le righe ordinato + collega al PO (guard: solo quelle ancora da_ordinare).
    const now = new Date().toISOString()
    const { error: updErr } = await supabase
      .from('divise_ordini_righe')
      .update({ stato: 'ordinato', ordine_fornitore_id: po?.id ?? null, ordinato_il: now })
      .in('id', righe_ids)
      .eq('stato', 'da_ordinare')
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

    await syncTestate(supabase, righe.map((r) => r.ordine_id))

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_ordine_fornitore',
      entitaId: po?.id ?? scuolaId,
      azione: 'insert',
      scuolaId,
      valoreDopo: { numero: po?.numero ?? null, fornitore_id: fornitore_id ?? null, righe: righe_ids.length },
    })

    return NextResponse.json({ success: true, data: { po, righe: righe_ids.length } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST merch/ordini-fornitore:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH — annulla un PO: le righe collegate tornano 'da_ordinare'
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: po } = await supabase.from('merch_ordini_fornitore').select('id, scuola_id, stato').eq('id', id).maybeSingle()
    if (!po) return NextResponse.json({ error: 'PO non trovato' }, { status: 404 })
    if (!plessi.includes(po.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: PO fuori dal tuo plesso' }, { status: 403 })
    }

    // Righe ancora 'ordinato' collegate al PO → tornano da_ordinare.
    const { data: righe } = await supabase
      .from('divise_ordini_righe')
      .select('id, ordine_id')
      .eq('ordine_fornitore_id', id)
      .eq('stato', 'ordinato')
    const ordineIds = (righe ?? []).map((r) => r.ordine_id as string)
    await supabase
      .from('divise_ordini_righe')
      .update({ stato: 'da_ordinare', ordine_fornitore_id: null, ordinato_il: null })
      .eq('ordine_fornitore_id', id)
      .eq('stato', 'ordinato')

    await supabase.from('merch_ordini_fornitore').update({ stato: 'annullato', chiuso_il: new Date().toISOString() }).eq('id', id)
    await syncTestate(supabase, ordineIds)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_ordine_fornitore',
      entitaId: id,
      azione: 'update',
      scuolaId: po.scuola_id as string,
      valorePrima: { stato: po.stato },
      valoreDopo: { stato: 'annullato' },
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API PATCH merch/ordini-fornitore:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
