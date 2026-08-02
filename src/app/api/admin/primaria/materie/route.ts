import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ============================================================
// Materie (discipline) per sezione — catalogo editabile derivato dal preset.
// ============================================================

/**
 * Carica la SEZIONE di una materia per poterne verificare il plesso.
 *
 * PATCH e DELETE ricevevano solo `id` e agivano sulla riga di `materie` senza
 * mai chiedersi di chi fosse: la DELETE si porta dietro orario, obiettivi e
 * valutazioni collegati. La sezione è la stessa fonte di verità che il POST usa
 * per la sede, e deve esserlo anche qui.
 *
 * Ritorna la `NextResponse` di errore da restituire, oppure `null` se si può
 * procedere.
 */
async function assertMateriaInScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: Parameters<typeof assertSezioneInScope>[1],
  id: string,
  operazione: string,
): Promise<NextResponse | null> {
  const { data: materia, error } = await supabase
    .from('materie')
    .select('id, section_id')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    // PostgREST non lancia: un guasto di lettura non deve diventare un
    // «procedi comunque», che qui vorrebbe dire scrivere su una riga altrui.
    logEvento('db', 'error', { operazione, esito: 'materia-non-letta' }, error)
    return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
  }
  if (!materia) return NextResponse.json({ error: 'Materia non trovata' }, { status: 404 })
  return await assertSezioneInScope(supabase, user, materia.section_id as string)
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  sectionId: zUuid, // obbligatorio (sostituisce il 400 manuale)
})

const postQuerySchema = z.object({
  action: z.string().optional(), // solo 'apply-preset' ha effetto, come prima
})

// Il body del POST dipende dal ramo (?action=): base comune, poi schema per ramo.
// .loose() perché i campi del ramo vengono rivalidati da `body` dopo il lookup sezione.
const postBodyBaseSchema = z.object({
  sectionId: zUuid, // sostituisce il 400 manuale
}).loose()

// Ramo apply-preset: stessa semantica di `Number(body.livello)` + check 1-5.
const postPresetBodySchema = z.object({
  livello: z.coerce.number({ error: 'livello (1-5) obbligatorio' })
    .min(1, 'livello (1-5) obbligatorio')
    .max(5, 'livello (1-5) obbligatorio'),
})

// Ramo creazione materia singola.
const postMateriaBodySchema = z.object({
  nome: z.string().min(1, 'nome e codice obbligatori'),
  codice: z.string().min(1, 'nome e codice obbligatori'),
  e_civica: z.boolean().nullish(), // default false applicato nel codice (?? come prima)
  turno_mensa: z.boolean().nullish(), // default false applicato nel codice (?? come prima)
  ordine: z.coerce.number().nullish(), // default 0 applicato nel codice (?? come prima)
})

// Il body (meno id e chiavi di tenancy) va in update(updates): .loose() preserva le chiavi extra.
const patchBodySchema = z.object({
  id: zUuid, // sostituisce il 400 manuale
}).loose()

const deleteQuerySchema = z.object({
  id: zUuid, // obbligatorio (sostituisce il 400 manuale)
})

// GET /api/admin/primaria/materie?sectionId=
export const GET = withRoute('admin/primaria/materie:GET', async (request: NextRequest) => {
  // Gate MANCANTE, non solo lo scope: questo GET rispondeva 200 a chiunque, senza
  // alcuna credenziale (verificato in produzione il 2026-07-30). Non espone dati
  // di minori — materie, orari e obiettivi sono configurazione — ma è un
  // endpoint amministrativo, e la POST gemella il gate ce l'aveva già.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { sectionId } = q.data
  try {
    const supabase = await createAdminClient()
    // Isolamento per sede: `sectionId` arrivava dal client senza verifica — si
    // leggevano e si scrivevano materie, orari, obiettivi e certificati delle
    // competenze su sezioni di un'altra sede.
    const fuoriScopeSez = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (fuoriScopeSez) return fuoriScopeSez

    const { data, error } = await supabase
      .from('materie')
      .select('*')
      .eq('section_id', sectionId)
      .order('ordine', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/materie:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/primaria/materie
//   body normale: { sectionId, nome, codice, e_civica?, turno_mensa?, ordine? }
//   apply-preset:  ?action=apply-preset  body: { sectionId, livello }
export const POST = withRoute('admin/primaria/materie:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const qp = parseQuery(request, postQuerySchema)
    if ('response' in qp) return qp.response
    const action = qp.data.action

    const base = await parseBody(request, postBodyBaseSchema)
    if ('response' in base) return base.response
    const body = base.data
    const supabase = await createAdminClient()

    // Isolamento per sede: il diff di PR #60 si esaurisce dentro il GET, e
    // questo POST — preset compreso — creava materie sulle sezioni delle altre
    // sedi. Derivare `scuola_id` dalla sezione NON è un presidio: scriveva la
    // sede giusta, cioè quella di un plesso non proprio. Serve il gate.
    const sectionId = body.sectionId
    const fuoriScopeSez = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (fuoriScopeSez) return fuoriScopeSez

    // Risolve la scuola dalla sezione (single source of truth).
    const { data: section, error: errSection } = await supabase
      .from('sections')
      .select('id, scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (errSection) {
      // PostgREST non lancia: senza controllo si finirebbe a inserire con
      // `scuola_id: undefined`, cioè una materia senza plesso.
      logEvento('db', 'error', { operazione: 'admin/primaria/materie:POST', esito: 'sezione-non-letta' }, errSection)
      return NextResponse.json({ error: 'Lettura della sezione non riuscita' }, { status: 500 })
    }
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    if (action === 'apply-preset') {
      const pv = parseData(postPresetBodySchema, body)
      if ('response' in pv) return pv.response
      const { livello } = pv.data
      const { data: preset, error: presetErr } = await supabase
        .from('materie_preset')
        .select('nome, codice, e_civica, turno_mensa, ordine')
        .eq('livello', livello)
        .eq('attivo', true)
      if (presetErr) return NextResponse.json({ error: presetErr.message }, { status: 500 })

      const rows = (preset ?? []).map((p) => ({
        scuola_id: section.scuola_id,
        section_id: sectionId,
        nome: p.nome,
        codice: p.codice,
        e_civica: p.e_civica,
        turno_mensa: p.turno_mensa,
        ordine: p.ordine,
      }))
      if (rows.length === 0) return NextResponse.json({ success: true, data: [] })

      // upsert idempotente su (section_id, codice)
      const { data, error } = await supabase
        .from('materie')
        .upsert(rows, { onConflict: 'section_id,codice', ignoreDuplicates: true })
        .select()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data: data ?? [] }, { status: 201 })
    }

    const mv = parseData(postMateriaBodySchema, body)
    if ('response' in mv) return mv.response
    const materia = mv.data
    const { data, error } = await supabase
      .from('materie')
      .insert({
        scuola_id: section.scuola_id,
        section_id: sectionId,
        nome: materia.nome,
        codice: materia.codice,
        e_civica: materia.e_civica ?? false,
        turno_mensa: materia.turno_mensa ?? false,
        ordine: materia.ordine ?? 0,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/materie:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/admin/primaria/materie  body: { id, ...updates }
export const PATCH = withRoute('admin/primaria/materie:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, ...updates } = b.data
    // Non si modificano chiavi di tenancy via PATCH.
    delete updates.scuola_id
    delete updates.section_id

    const supabase = await createAdminClient()
    const fuoriScope = await assertMateriaInScope(supabase, auth.user, id, 'admin/primaria/materie:PATCH')
    if (fuoriScope) return fuoriScope

    const { data, error } = await supabase
      .from('materie')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/materie:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// DELETE /api/admin/primaria/materie?id=
export const DELETE = withRoute('admin/primaria/materie:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const fuoriScope = await assertMateriaInScope(supabase, auth.user, id, 'admin/primaria/materie:DELETE')
    if (fuoriScope) return fuoriScope

    const { error } = await supabase.from('materie').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/materie:DELETE', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
