import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// Catalogo Merchandise (Fase B, move da /api/admin/divise/articoli) — CRUD staff.
// Service-role + scoping per plesso (scuoleDiUtente) + audit. Le colonne nuove
// (categoria/fornitore_id/prezzo_acquisto) degradano con grazia dove il DB non
// è migrato (DB e2e CI): SELECT 42703 → colonne base; INSERT/UPDATE PGRST204 →
// record legacy senza i campi nuovi.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const FULL_COLS = 'id, scuola_id, nome, descrizione, taglie, prezzo, attivo, ordine, categoria, fornitore_id, prezzo_acquisto, created_at'
const BASE_COLS = 'id, scuola_id, nome, descrizione, taglie, prezzo, attivo, ordine, created_at'
const CAMPI_NUOVI = ['categoria', 'fornitore_id', 'prezzo_acquisto'] as const

type Esito = { data: Record<string, unknown> | null; error: { code?: string; message: string } | null }
type EsitoLista = { data: Record<string, unknown>[] | null; error: { code?: string; message: string } | null }

/** Rimuove le chiavi delle colonne non ancora migrate da un record. */
function senzaCampiNuovi(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (!(CAMPI_NUOVI as readonly string[]).includes(k)) out[k] = v
  }
  return out
}

// Helper con degrade incapsulato (cols passate come `string` → overload untyped
// di supabase → un solo tipo di ritorno per FULL e BASE; cast finale a Esito).
async function listArticoli(supabase: SupabaseClient, plessi: string[]): Promise<EsitoLista> {
  const run = (cols: string) =>
    supabase.from('divise_articoli').select(cols).in('scuola_id', plessi)
      .order('ordine', { ascending: true }).order('nome', { ascending: true })
  let r = await run(FULL_COLS)
  if (r.error && SCHEMA_MANCANTE.has(r.error.code ?? '')) r = await run(BASE_COLS)
  return r as unknown as EsitoLista
}

async function insertArticolo(supabase: SupabaseClient, record: Record<string, unknown>): Promise<Esito> {
  const run = (row: Record<string, unknown>, cols: string) =>
    supabase.from('divise_articoli').insert(row).select(cols).single()
  let r = await run(record, FULL_COLS)
  if (r.error && SCHEMA_MANCANTE.has(r.error.code ?? '')) r = await run(senzaCampiNuovi(record), BASE_COLS)
  return r as unknown as Esito
}

async function updateArticolo(supabase: SupabaseClient, id: string, updates: Record<string, unknown>): Promise<Esito> {
  const run = (row: Record<string, unknown>, cols: string) =>
    supabase.from('divise_articoli').update(row).eq('id', id).select(cols).single()
  let r = await run(updates, FULL_COLS)
  if (r.error && SCHEMA_MANCANTE.has(r.error.code ?? '')) r = await run(senzaCampiNuovi(updates), BASE_COLS)
  return r as unknown as Esito
}

const getQuerySchema = z.object({}) // lista tutto il catalogo dei propri plessi

const zTaglie = z.array(z.string().trim().min(1)).default([])
const zPrezzo = z.coerce.number({ error: 'Prezzo non valido' }).min(0, 'Il prezzo non può essere negativo')
const zCategoria = z.enum(['divisa', 'materiale', 'libri', 'gadget', 'altro'])

const postBodySchema = z.object({
  nome: z.string().trim().min(1, 'Il nome è obbligatorio').max(120, 'Nome troppo lungo (max 120)'),
  descrizione: z.string().trim().max(500).nullish(),
  taglie: zTaglie,
  prezzo: zPrezzo,
  categoria: zCategoria.optional(),
  fornitore_id: zUuid.nullish(),
  prezzo_acquisto: z.coerce.number().min(0).nullish(),
  attivo: z.boolean().optional(),
  ordine: z.coerce.number().int().optional(),
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.string().trim().min(1).max(120).optional(),
  descrizione: z.string().trim().max(500).nullish(),
  taglie: z.array(z.string().trim().min(1)).optional(),
  prezzo: zPrezzo.optional(),
  categoria: zCategoria.optional(),
  fornitore_id: zUuid.nullish(),
  prezzo_acquisto: z.coerce.number().min(0).nullish(),
  attivo: z.boolean().optional(),
  ordine: z.coerce.number().int().optional(),
})

const deleteQuerySchema = z.object({ id: zUuid })

// GET /api/admin/merch/articoli — catalogo dei plessi dell'utente
export const GET = withRoute('admin/merch/articoli:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await listArticoli(supabase, plessi)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/merch/articoli:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/admin/merch/articoli — crea un articolo nel plesso dell'utente
export const POST = withRoute('admin/merch/articoli:POST', async (request: Request) => {
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

    const record: Record<string, unknown> = {
      scuola_id: scuolaId,
      nome: b.data.nome.trim(),
      descrizione: b.data.descrizione?.trim() || null,
      taglie: b.data.taglie,
      prezzo: b.data.prezzo,
      categoria: b.data.categoria ?? 'divisa',
      fornitore_id: b.data.fornitore_id ?? null,
      prezzo_acquisto: b.data.prezzo_acquisto ?? null,
      attivo: b.data.attivo ?? true,
      ordine: b.data.ordine ?? 0,
    }
    const { data, error } = await insertArticolo(supabase, record)
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Creazione fallita' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_articolo',
      entitaId: data.id as string,
      azione: 'insert',
      scuolaId,
      valoreDopo: record,
    })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/merch/articoli:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/admin/merch/articoli — aggiorna un articolo
export const PATCH = withRoute('admin/merch/articoli:PATCH', async (request: Request) => {
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
    if (rest.categoria !== undefined) updates.categoria = rest.categoria
    if (rest.fornitore_id !== undefined) updates.fornitore_id = rest.fornitore_id ?? null
    if (rest.prezzo_acquisto !== undefined) updates.prezzo_acquisto = rest.prezzo_acquisto ?? null
    if (rest.attivo !== undefined) updates.attivo = rest.attivo
    if (rest.ordine !== undefined) updates.ordine = rest.ordine

    const { data, error } = await updateArticolo(supabase, id, updates)
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_articolo',
      entitaId: id,
      azione: 'update',
      scuolaId: existing.scuola_id as string,
      valoreDopo: updates,
    })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'admin/merch/articoli:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/admin/merch/articoli?id= — rimuove un articolo dal catalogo.
// Gli ordini storici restano (righe.articolo_id → SET NULL, nome snapshot).
export const DELETE = withRoute('admin/merch/articoli:DELETE', async (request: Request) => {
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
      entitaTipo: 'merch_articolo',
      entitaId: id,
      azione: 'delete',
      scuolaId: existing.scuola_id as string,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'admin/merch/articoli:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
