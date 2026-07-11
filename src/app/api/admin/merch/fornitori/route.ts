import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// Anagrafica fornitori Merchandise (Fase B, step B3) — CRUD riservato allo staff.
// Service-role + scoping per plesso + audit. GET degrada a lista vuota dove la
// tabella non esiste (DB e2e CI non migrato).

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const COLS = 'id, scuola_id, nome, referente, email, telefono, piva, indirizzo, note, attivo, creato_il'

const getQuerySchema = z.object({})

const zEmail = z.string().trim().email('Email non valida').max(160).nullish()
const postBodySchema = z.object({
  nome: z.string().trim().min(1, 'Il nome del fornitore è obbligatorio').max(160),
  referente: z.string().trim().max(160).nullish(),
  email: zEmail,
  telefono: z.string().trim().max(60).nullish(),
  piva: z.string().trim().max(40).nullish(),
  indirizzo: z.string().trim().max(300).nullish(),
  note: z.string().trim().max(500).nullish(),
  attivo: z.boolean().optional(),
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.string().trim().min(1).max(160).optional(),
  referente: z.string().trim().max(160).nullish(),
  email: zEmail,
  telefono: z.string().trim().max(60).nullish(),
  piva: z.string().trim().max(40).nullish(),
  indirizzo: z.string().trim().max(300).nullish(),
  note: z.string().trim().max(500).nullish(),
  attivo: z.boolean().optional(),
})

const deleteQuerySchema = z.object({ id: zUuid })

const trimOrNull = (v: string | null | undefined) => (v == null ? null : v.trim() || null)

// GET /api/admin/merch/fornitori — anagrafica dei plessi dell'utente
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
      .from('merch_fornitori')
      .select(COLS)
      .in('scuola_id', plessi)
      .order('attivo', { ascending: false })
      .order('nome', { ascending: true })
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: [] })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('Errore API GET merch/fornitori:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/admin/merch/fornitori — crea un fornitore
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const scuolaId = auth.user.scuola_id && plessi.includes(auth.user.scuola_id) ? auth.user.scuola_id : plessi[0]
    if (!scuolaId) return NextResponse.json({ error: 'Nessun plesso associato al tuo profilo' }, { status: 400 })

    const record = {
      scuola_id: scuolaId,
      nome: b.data.nome.trim(),
      referente: trimOrNull(b.data.referente),
      email: trimOrNull(b.data.email),
      telefono: trimOrNull(b.data.telefono),
      piva: trimOrNull(b.data.piva),
      indirizzo: trimOrNull(b.data.indirizzo),
      note: trimOrNull(b.data.note),
      attivo: b.data.attivo ?? true,
      creato_da: auth.user.id,
    }
    const { data, error } = await supabase.from('merch_fornitori').insert(record).select(COLS).single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Creazione fallita' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_fornitore',
      entitaId: data.id as string,
      azione: 'insert',
      scuolaId,
      valoreDopo: record,
    })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST merch/fornitori:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/merch/fornitori — aggiorna un fornitore
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, ...rest } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: existing } = await supabase.from('merch_fornitori').select('id, scuola_id').eq('id', id).maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Fornitore non trovato' }, { status: 404 })
    if (!plessi.includes(existing.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: fornitore fuori dal tuo plesso' }, { status: 403 })
    }

    const updates: Record<string, unknown> = {}
    if (rest.nome !== undefined) updates.nome = rest.nome.trim()
    if (rest.referente !== undefined) updates.referente = trimOrNull(rest.referente)
    if (rest.email !== undefined) updates.email = trimOrNull(rest.email)
    if (rest.telefono !== undefined) updates.telefono = trimOrNull(rest.telefono)
    if (rest.piva !== undefined) updates.piva = trimOrNull(rest.piva)
    if (rest.indirizzo !== undefined) updates.indirizzo = trimOrNull(rest.indirizzo)
    if (rest.note !== undefined) updates.note = trimOrNull(rest.note)
    if (rest.attivo !== undefined) updates.attivo = rest.attivo

    const { data, error } = await supabase.from('merch_fornitori').update(updates).eq('id', id).select(COLS).single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_fornitore',
      entitaId: id,
      azione: 'update',
      scuolaId: existing.scuola_id as string,
      valoreDopo: updates,
    })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH merch/fornitori:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/admin/merch/fornitori?id= — rimuove un fornitore (articoli/PO che
// lo referenziano → fornitore_id SET NULL; il fornitore_nome snapshot dei PO resta).
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: existing } = await supabase.from('merch_fornitori').select('id, scuola_id').eq('id', id).maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Fornitore non trovato' }, { status: 404 })
    if (!plessi.includes(existing.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: fornitore fuori dal tuo plesso' }, { status: 403 })
    }

    const { error } = await supabase.from('merch_fornitori').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_fornitore',
      entitaId: id,
      azione: 'delete',
      scuolaId: existing.scuola_id as string,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE merch/fornitori:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
