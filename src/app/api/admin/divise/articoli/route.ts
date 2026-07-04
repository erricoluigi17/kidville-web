import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// Catalogo divise (step 13) — CRUD riservato allo staff. Service-role + scoping
// applicativo per plesso (scuoleDiUtente) + audit. Tutte le rotte con zod.

const getQuerySchema = z.object({}) // nessun parametro: lista tutto il catalogo dei propri plessi

const zTaglie = z.array(z.string().trim().min(1)).default([])
const zPrezzo = z.coerce.number({ error: 'Prezzo non valido' }).min(0, 'Il prezzo non può essere negativo')

const postBodySchema = z.object({
  nome: z.string().trim().min(1, 'Il nome è obbligatorio').max(120, 'Nome troppo lungo (max 120)'),
  descrizione: z.string().trim().max(500).nullish(),
  taglie: zTaglie,
  prezzo: zPrezzo,
  attivo: z.boolean().optional(),
  ordine: z.coerce.number().int().optional(),
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.string().trim().min(1).max(120).optional(),
  descrizione: z.string().trim().max(500).nullish(),
  taglie: z.array(z.string().trim().min(1)).optional(),
  prezzo: zPrezzo.optional(),
  attivo: z.boolean().optional(),
  ordine: z.coerce.number().int().optional(),
})

const deleteQuerySchema = z.object({ id: zUuid })

// GET /api/admin/divise/articoli — catalogo dei plessi dell'utente
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('divise_articoli')
      .select('id, scuola_id, nome, descrizione, taglie, prezzo, attivo, ordine, created_at')
      .in('scuola_id', plessi)
      .order('ordine', { ascending: true })
      .order('nome', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('Errore API GET divise/articoli:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/admin/divise/articoli — crea un articolo nel plesso dell'utente
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const scuolaId = auth.user.scuola_id && plessi.includes(auth.user.scuola_id) ? auth.user.scuola_id : plessi[0]
    if (!scuolaId) {
      return NextResponse.json({ error: 'Nessun plesso associato al tuo profilo' }, { status: 400 })
    }

    const record = {
      scuola_id: scuolaId,
      nome: b.data.nome.trim(),
      descrizione: b.data.descrizione?.trim() || null,
      taglie: b.data.taglie,
      prezzo: b.data.prezzo,
      attivo: b.data.attivo ?? true,
      ordine: b.data.ordine ?? 0,
    }
    const { data, error } = await supabase
      .from('divise_articoli')
      .insert(record)
      .select('id, scuola_id, nome, descrizione, taglie, prezzo, attivo, ordine, created_at')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Creazione fallita' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'divise_articolo',
      entitaId: data.id,
      azione: 'insert',
      scuolaId,
      valoreDopo: record,
    })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST divise/articoli:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/divise/articoli — aggiorna un articolo (nome/prezzo/taglie/attivo/…)
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, ...rest } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: existing } = await supabase
      .from('divise_articoli')
      .select('id, scuola_id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Articolo non trovato' }, { status: 404 })
    if (!plessi.includes(existing.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: articolo fuori dal tuo plesso' }, { status: 403 })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (rest.nome !== undefined) updates.nome = rest.nome.trim()
    if (rest.descrizione !== undefined) updates.descrizione = rest.descrizione?.trim() || null
    if (rest.taglie !== undefined) updates.taglie = rest.taglie
    if (rest.prezzo !== undefined) updates.prezzo = rest.prezzo
    if (rest.attivo !== undefined) updates.attivo = rest.attivo
    if (rest.ordine !== undefined) updates.ordine = rest.ordine

    const { data, error } = await supabase
      .from('divise_articoli')
      .update(updates)
      .eq('id', id)
      .select('id, scuola_id, nome, descrizione, taglie, prezzo, attivo, ordine, created_at')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'divise_articolo',
      entitaId: id,
      azione: 'update',
      scuolaId: existing.scuola_id as string,
      valoreDopo: updates,
    })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH divise/articoli:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/admin/divise/articoli?id= — rimuove un articolo dal catalogo.
// Gli ordini storici restano (righe.articolo_id → SET NULL, nome snapshot preservato).
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: existing } = await supabase
      .from('divise_articoli')
      .select('id, scuola_id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Articolo non trovato' }, { status: 404 })
    if (!plessi.includes(existing.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: articolo fuori dal tuo plesso' }, { status: 403 })
    }

    const { error } = await supabase.from('divise_articoli').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'divise_articolo',
      entitaId: id,
      azione: 'delete',
      scuolaId: existing.scuola_id as string,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE divise/articoli:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
