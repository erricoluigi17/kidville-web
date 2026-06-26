import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { validaNomeScuola, normalizzaScuola } from '@/lib/scuole/validate'

// Multi-Sede CRUD (DL-033). Riservato alla Direzione (admin/coordinator).
// Aggiungi / rinomina / disattiva (soft) + config isolata per sede. Service-role
// + scoping app + audit, coerente col resto del progetto.

const DIREZIONE = ['admin', 'coordinator'] as const

export async function GET(request: Request) {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('scuole')
    .select('id, nome, citta, indirizzo, attiva, config, created_at')
    .order('nome', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(request: Request) {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  try {
    const body = await request.json()
    const check = validaNomeScuola(body?.nome)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

    const scuola = normalizzaScuola(body)
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('scuole')
      .insert({ nome: scuola.nome, citta: scuola.citta, indirizzo: scuola.indirizzo, attiva: true })
      .select('id, nome, citta, indirizzo, attiva')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Creazione fallita' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'multi_sede',
      entitaId: data.id,
      azione: 'insert',
      valoreDopo: scuola,
    })
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  try {
    const body = await request.json()
    const { id, nome, citta, indirizzo, attiva, config } = body ?? {}
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })
    if (nome !== undefined) {
      const check = validaNomeScuola(nome)
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data: existing } = await supabase
      .from('scuole')
      .select('id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Sede non trovata' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (nome !== undefined) updates.nome = String(nome).trim()
    if (citta !== undefined) updates.citta = citta ? String(citta).trim() : null
    if (indirizzo !== undefined) updates.indirizzo = indirizzo ? String(indirizzo).trim() : null
    if (attiva !== undefined) updates.attiva = !!attiva
    if (config !== undefined) updates.config = config

    const { data, error } = await supabase
      .from('scuole')
      .update(updates)
      .eq('id', id)
      .select('id, nome, citta, indirizzo, attiva, config')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'multi_sede',
      entitaId: id,
      azione: 'update',
      valoreDopo: updates,
    })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}
