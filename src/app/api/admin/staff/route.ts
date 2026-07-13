import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppRole } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { RUOLI_VALIDI } from '@/lib/auth/ruoli'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const DIREZIONE = ['admin', 'coordinator'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// PATCH — body: { id, ruolo?, scuola_id?, gradi?, section_ids? }.
// gradi/section_ids non-array oggi vengono ignorati in silenzio (Array.isArray
// nel codice): restano z.unknown() per non respingere richieste che oggi passano.
const patchBodySchema = z.object({
  id: zUuid, // obbligatorio (sostituisce il 400 manuale 'id è obbligatorio')
  // Stessi valori ammessi di isRuoloAssegnabile (sostituisce il 400 manuale).
  ruolo: z.enum(RUOLI_VALIDI as [AppRole, ...AppRole[]], { error: 'Ruolo non assegnabile' }).optional(),
  scuola_id: zUuid.nullish(), // null oggi arriva al DB così com'è: preservato
  gradi: z.unknown().optional(),
  section_ids: z.unknown().optional(),
})

// GET /api/admin/staff — elenco personale (esclude i genitori). Solo Direzione.
export const GET = withRoute('admin/staff:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('utenti')
      .select('id, nome, cognome, email, ruolo, scuola_id, gradi')
      .neq('ruolo', 'genitore')
      .order('cognome', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // contesto per la UI: sedi + classi + assegnazioni correnti
    const [{ data: schools }, { data: sections }, { data: asseg }] = await Promise.all([
      supabase.from('schools').select('id, nome'),
      supabase.from('sections').select('id, name, scuola_id, school_type').order('name'),
      supabase.from('utenti_sezioni').select('utente_id, section_id'),
    ])

    return NextResponse.json({
      success: true,
      data: data ?? [],
      schools: schools ?? [],
      sections: sections ?? [],
      assegnazioni: asseg ?? [],
    })
  } catch (err) {
    logErrore({ operazione: 'admin/staff:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/admin/staff — gestione RBAC (DL-028). Solo Direzione.
// Body: { id, ruolo?, scuola_id?, gradi?, section_ids? }
export const PATCH = withRoute('admin/staff:PATCH', async (request: Request) => {
  try {
    const auth = await requireStaff(request, [...DIREZIONE])
    if (auth.response) return auth.response

    const parsed = await parseBody(request, patchBodySchema)
    if ('response' in parsed) return parsed.response
    const body = parsed.data
    const id = body.id

    // self-lockout guard: la Direzione non può cambiare il proprio ruolo
    if (body.ruolo !== undefined && id === auth.user.id) {
      return NextResponse.json({ error: 'Non puoi modificare il tuo stesso ruolo' }, { status: 403 })
    }

    const supabase = await createAdminClient()

    const patch: Record<string, unknown> = {}
    if (body.ruolo !== undefined) patch.ruolo = body.ruolo
    if (body.scuola_id !== undefined) {
      // MAI fidarsi dello scuola_id dal client: la sede destinazione deve
      // essere tra i plessi della Direzione. (null resta consentito e passa.)
      if (body.scuola_id !== null) {
        const plessi = await scuoleDiUtente(supabase, auth.user)
        if (!plessi.includes(body.scuola_id)) {
          return NextResponse.json({ error: 'Sede non consentita' }, { status: 403 })
        }
      }
      patch.scuola_id = body.scuola_id
    }
    if (Array.isArray(body.gradi)) patch.gradi = body.gradi

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('utenti').update(patch).eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // assegnazione classi: replace completo
    if (Array.isArray(body.section_ids)) {
      await supabase.from('utenti_sezioni').delete().eq('utente_id', id)
      if (body.section_ids.length > 0) {
        await supabase
          .from('utenti_sezioni')
          .insert(body.section_ids.map((sid) => ({ utente_id: id, section_id: sid })))
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'staff_rbac',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { ruolo: body.ruolo, scuola_id: body.scuola_id, section_ids: body.section_ids },
    })

    return NextResponse.json({ success: true, data: { id } })
  } catch (err) {
    logErrore({ operazione: 'admin/staff:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
