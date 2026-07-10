import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { normalizzaScuola } from '@/lib/scuole/validate'
import { zAnagraficaSede, normalizzaAnagraficaSede } from '@/lib/scuole/anagrafica'
import { parseBody, parseQuery } from '@/lib/validation/http'

// Multi-Sede CRUD (DL-033). Riservato alla Direzione (admin/coordinator).
// Aggiungi / rinomina / disattiva (soft) + config isolata per sede. Service-role
// + scoping app + audit, coerente col resto del progetto.

const DIREZIONE = ['admin', 'coordinator'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

/** Stesse regole del vecchio validaNomeScuola: obbligatorio, ≤120 caratteri dopo trim. */
const zNomeScuola = z
  .string({ error: 'Il nome della sede è obbligatorio' })
  .refine((v) => v.trim().length > 0, 'Il nome della sede è obbligatorio')
  .refine((v) => v.trim().length <= 120, 'Il nome della sede è troppo lungo (max 120 caratteri)')

const postBodySchema = z.object({
  nome: zNomeScuola,
  citta: z.string().nullish(),
  indirizzo: z.string().nullish(),
})

// id come stringa libera e NON zUuid: la tabella scuole è un registry soft-ref
// (id non-uuid nei test/dev); un id sconosciuto continua a dare 404, come prima.
// citta/indirizzo/attiva/config oggi accettano qualunque tipo (String()/!!/pass-through).
const patchBodySchema = z.object({
  id: z.string().min(1, 'id obbligatorio'), // sostituisce il 400 manuale 'id obbligatorio'
  nome: zNomeScuola.optional(),
  citta: z.unknown().optional(),
  indirizzo: z.unknown().optional(),
  attiva: z.unknown().optional(),
  config: z.unknown().optional(),
  // Anagrafica di sede (multi-sede): merge server-side in config.anagrafica,
  // le altre chiavi di config sono preservate.
  anagrafica: zAnagraficaSede.optional(),
})

export async function GET(request: Request) {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

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

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response

  try {
    const scuola = normalizzaScuola(b.data)
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

  const b = await parseBody(request, patchBodySchema)
  if ('response' in b) return b.response
  const { id, nome, citta, indirizzo, attiva, config, anagrafica } = b.data

  try {
    const supabase = await createAdminClient()
    const { data: existing } = await supabase
      .from('scuole')
      .select('id, config')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Sede non trovata' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (nome !== undefined) updates.nome = String(nome).trim()
    if (citta !== undefined) updates.citta = citta ? String(citta).trim() : null
    if (indirizzo !== undefined) updates.indirizzo = indirizzo ? String(indirizzo).trim() : null
    if (attiva !== undefined) updates.attiva = !!attiva
    if (config !== undefined) updates.config = config
    if (anagrafica !== undefined) {
      // Merge server-side (pattern Settings Hub): preserva le altre chiavi di
      // config; se nel body arriva anche `config` grezza, l'anagrafica
      // normalizzata vince sulla chiave omonima.
      const base = updates.config ?? existing.config
      const existingConfig = base && typeof base === 'object' ? (base as Record<string, unknown>) : {}
      updates.config = { ...existingConfig, anagrafica: normalizzaAnagraficaSede(anagrafica) }
    }

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
