import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ============================================================
// Configurazione giudizi: scala sintetica + template descrittivi.
// ============================================================

const getQuerySchema = z.object({
  scuolaId: zUuid,
})

const postQuerySchema = z.object({
  action: z.enum(['scala', 'scala-rename', 'template']),
})

// I campi opzionali sono pass-through verso il DB (conversioni fatte nel codice):
// schema permissivo per non alterare il comportamento attuale.
const scalaBodySchema = z.object({
  scuolaId: zUuid,
  etichetta: z.string().min(1),
  ordine: z.unknown().optional(),
  valoreNumerico: z.unknown().optional(),
  giudizioDescrittivo: z.unknown().optional(),
  attivo: z.unknown().optional(),
})

const scalaRenameBodySchema = z.object({
  scuolaId: zUuid,
  id: zUuid,
  etichetta: z.string().min(1),
})

const templateBodySchema = z.object({
  scuolaId: zUuid,
  dimensione: z.string().min(1),
  valore: z.string().min(1),
  frammento: z.string().min(1),
})

const deleteQuerySchema = z.object({
  // qualunque valore diverso da 'scala' oggi ricade su 'template': niente enum
  tipo: z.string().min(1),
  id: zUuid,
})

// GET /api/admin/primaria/giudizi?scuolaId=
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuolaId } = q.data

    const supabase = await createAdminClient()
    const [{ data: scala }, { data: template }] = await Promise.all([
      supabase.from('giudizi_sintetici_scala').select('*').eq('scuola_id', scuolaId).order('ordine'),
      supabase
        .from('giudizio_template')
        .select('*')
        .or(`scuola_id.eq.${scuolaId},scuola_id.is.null`)
        .order('dimensione'),
    ])
    return NextResponse.json({ success: true, data: { scala: scala ?? [], template: template ?? [] } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/giudizi?action=scala|template
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response
    const action = q.data.action
    const supabase = await createAdminClient()

    if (action === 'scala') {
      const b = await parseBody(request, scalaBodySchema)
      if ('response' in b) return b.response
      const { scuolaId, etichetta, ordine, valoreNumerico, giudizioDescrittivo, attivo } = b.data
      const row: Record<string, unknown> = { scuola_id: scuolaId, etichetta, ordine: ordine ?? 0 }
      if (valoreNumerico !== undefined) row.valore_numerico = valoreNumerico === null || valoreNumerico === '' ? null : Number(valoreNumerico)
      if (giudizioDescrittivo !== undefined) row.giudizio_descrittivo = giudizioDescrittivo || null
      if (attivo !== undefined) row.attivo = !!attivo
      const { data, error } = await supabase
        .from('giudizi_sintetici_scala')
        .upsert(row, { onConflict: 'scuola_id,etichetta' })
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    if (action === 'scala-rename') {
      const b = await parseBody(request, scalaRenameBodySchema)
      if ('response' in b) return b.response
      const { scuolaId, id, etichetta } = b.data

      // Etichetta vecchia: serve per propagare la rinomina ai giudizi descrittivi
      // configurati (referenziati per testo via etichetta_voto).
      const { data: prev } = await supabase
        .from('giudizi_sintetici_scala')
        .select('etichetta')
        .eq('id', id)
        .eq('scuola_id', scuolaId)
        .maybeSingle()
      if (!prev) return NextResponse.json({ error: 'Giudizio non trovato' }, { status: 404 })

      const { data, error } = await supabase
        .from('giudizi_sintetici_scala')
        .update({ etichetta })
        .eq('id', id)
        .eq('scuola_id', scuolaId)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      // Cascade: scrutinio_giudizio_descrittivo.etichetta_voto referenzia l'etichetta
      // per testo. Senza questo update i giudizi descrittivi resterebbero orfani.
      if (prev.etichetta !== etichetta) {
        const { error: cascadeErr } = await supabase
          .from('scrutinio_giudizio_descrittivo')
          .update({ etichetta_voto: etichetta })
          .eq('scuola_id', scuolaId)
          .eq('etichetta_voto', prev.etichetta)
        if (cascadeErr) return NextResponse.json({ error: cascadeErr.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, data })
    }

    if (action === 'template') {
      const b = await parseBody(request, templateBodySchema)
      if ('response' in b) return b.response
      const { scuolaId, dimensione, valore, frammento } = b.data
      const { data, error } = await supabase
        .from('giudizio_template')
        .upsert({ scuola_id: scuolaId, dimensione, valore, frammento }, { onConflict: 'scuola_id,dimensione,valore' })
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    return NextResponse.json({ error: 'action non riconosciuta' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/admin/primaria/giudizi?tipo=scala|template&id=
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { tipo, id } = q.data

    const table = tipo === 'scala' ? 'giudizi_sintetici_scala' : 'giudizio_template'
    const supabase = await createAdminClient()
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
