import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  annoScolastico: z.string().optional(),
})

const postBodySchema = z.object({
  annoScolastico: z.string().min(1),
  nome: z.string().min(1),
  ordine: z.union([z.number(), z.string()]).nullish(),
  dataInizio: z.string().nullish(),
  dataFine: z.string().nullish(),
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.string().nullish(),
  ordine: z.union([z.number(), z.string()]).nullish(),
  dataInizio: z.string().nullish(),
  dataFine: z.string().nullish(),
  attivo: z.boolean().nullish(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/admin/primaria/scrutinio-periodi?annoScolastico=&userId=
// Elenca i periodi di scrutinio configurati per la scuola dello staff.
export const GET = withRoute('admin/primaria/scrutinio-periodi:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    if (!auth.user.scuola_id) return NextResponse.json({ error: 'Scuola non associata' }, { status: 400 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const anno = q.data.annoScolastico

    const supabase = await createAdminClient()
    let query = supabase
      .from('scrutinio_periodi')
      .select('*')
      .eq('scuola_id', auth.user.scuola_id)
      .order('ordine')
    if (anno) query = query.eq('anno_scolastico', anno)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/primaria/scrutinio-periodi?userId=
// body: { annoScolastico, nome, ordine?, dataInizio?, dataFine? }
export const POST = withRoute('admin/primaria/scrutinio-periodi:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    if (!auth.user.scuola_id) return NextResponse.json({ error: 'Scuola non associata' }, { status: 400 })

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { annoScolastico, nome, ordine, dataInizio, dataFine } = b.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .insert({
        scuola_id: auth.user.scuola_id,
        anno_scolastico: annoScolastico,
        nome,
        ordine: ordine ?? 0,
        data_inizio: dataInizio ?? null,
        data_fine: dataFine ?? null,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/admin/primaria/scrutinio-periodi?userId=
// body: { id, nome?, ordine?, dataInizio?, dataFine?, attivo? }
export const PATCH = withRoute('admin/primaria/scrutinio-periodi:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, nome, ordine, dataInizio, dataFine, attivo } = b.data

    const patch: Record<string, unknown> = {}
    if (nome !== undefined) patch.nome = nome
    if (ordine !== undefined) patch.ordine = ordine
    if (dataInizio !== undefined) patch.data_inizio = dataInizio
    if (dataFine !== undefined) patch.data_fine = dataFine
    if (attivo !== undefined) patch.attivo = attivo

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .update(patch)
      .eq('id', id)
      .eq('scuola_id', auth.user.scuola_id ?? '')
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// DELETE /api/admin/primaria/scrutinio-periodi?id=&userId=
export const DELETE = withRoute('admin/primaria/scrutinio-periodi:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const { error } = await supabase
      .from('scrutinio_periodi')
      .delete()
      .eq('id', id)
      .eq('scuola_id', auth.user.scuola_id ?? '')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:DELETE', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
