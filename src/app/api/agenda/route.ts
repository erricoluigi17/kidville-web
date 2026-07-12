import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, requireUser, type AppUser } from '@/lib/auth/require-staff'
import { assertSezioneInScope, scuoleDiUtente } from '@/lib/auth/scope'
import { sezioniDiUtente } from '@/lib/sezioni/docenti'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'
import { rateLimit } from '@/lib/security/rate-limit'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import type { SupabaseClient } from '@supabase/supabase-js'

// Agenda condivisa (M6, piano-app-100): eventi/uscite/scadenze/riunioni di
// plesso (section_id NULL) o di sezione, su eventi_agenda (migr. 20260762).
// - GET  staff → scope plesso/sezioni (educator solo proprie sezioni);
//        genitore → legame su alunno_id, eventi plesso + sezione del figlio
//        con visibile_genitori, limit 100.
// - POST requireDocente; educator solo proprie sezioni; evento di plesso
//        riservato a direzione/segreteria; notifiche best-effort ai genitori.
// - DELETE creatore-o-direzione (admin, nel proprio scope plessi).

const TIPI_EVENTO = ['evento', 'uscita', 'scadenza', 'riunione'] as const
const LIMITE_EVENTI = 100

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const zOrario = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Orario non valido (atteso HH:MM)')

const getQuerySchema = z.object({
  alunno_id: zUuid.optional(), // obbligatorio nel ramo genitore
  sezione: z.string().trim().min(1).optional(), // filtro staff per NOME sezione
  from: zDataYMD.optional(), // default: oggi
})

const postBodySchema = z.object({
  section_id: zUuid.nullable().optional(),
  sezione: z.string().trim().min(1).optional(), // alternativa a section_id (nome, risolto in scope)
  scuola_id: zUuid.optional(), // solo eventi di plesso della direzione multi-sede
  titolo: z.string().trim().min(1, 'Titolo mancante').max(200),
  descrizione: z.string().max(2000).nullable().optional(),
  tipo: z.enum(TIPI_EVENTO).default('evento'),
  data: zDataYMD,
  orario_inizio: zOrario.nullable().optional(),
  orario_fine: zOrario.nullable().optional(),
  visibile_genitori: z.boolean().default(true),
})

const deleteQuerySchema = z.object({ id: zUuid })

const TIPO_LABEL: Record<(typeof TIPI_EVENTO)[number], string> = {
  evento: 'Evento',
  uscita: 'Uscita',
  scadenza: 'Scadenza',
  riunione: 'Riunione',
}

function oggiYMD(): string {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD locale
}

/**
 * Risolve un NOME sezione entro i plessi dell'utente (i nomi sono unici solo
 * per scuola_id: mai risolvere fuori scope — pattern assertClasseNomeInScope).
 */
async function sezionePerNomeInScope(
  supabase: SupabaseClient,
  user: AppUser,
  nome: string
): Promise<{ id: string; scuola_id: string } | null> {
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length === 0) return null
  const { data } = await supabase
    .from('sections')
    .select('id, scuola_id')
    .eq('name', nome)
    .in('scuola_id', plessi)
    .limit(1)
  const row = (data ?? [])[0]
  return row ? { id: row.id as string, scuola_id: row.scuola_id as string } : null
}

// GET /api/agenda — genitore: ?alunno_id= ; staff: [?sezione=][&from=YYYY-MM-DD]
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const from = q.data.from ?? oggiYMD()

    if (user.role === 'genitore') {
      const alunnoId = q.data.alunno_id
      if (!alunnoId) {
        return NextResponse.json({ error: 'alunno_id obbligatorio' }, { status: 400 })
      }
      // Legame runtime genitore↔alunno (student_parents è solo ETL/anagrafica).
      const { data: legame } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
        .eq('alunno_id', alunnoId)
        .maybeSingle()
      if (!legame) {
        return NextResponse.json({ error: 'Accesso negato: alunno non associato' }, { status: 403 })
      }
      const { data: alunno } = await supabase
        .from('alunni')
        .select('id, section_id, scuola_id')
        .eq('id', alunnoId)
        .maybeSingle()
      if (!alunno?.scuola_id) {
        return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
      }
      // Eventi di plesso + eventi della sezione del figlio, solo visibili ai genitori.
      const sectionFilter = alunno.section_id
        ? `section_id.is.null,section_id.eq.${alunno.section_id}`
        : 'section_id.is.null'
      const { data: eventi, error } = await supabase
        .from('eventi_agenda')
        .select('id, section_id, titolo, descrizione, tipo, data, orario_inizio, orario_fine')
        .eq('scuola_id', alunno.scuola_id)
        .eq('visibile_genitori', true)
        .or(sectionFilter)
        .gte('data', from)
        .order('data', { ascending: true })
        .order('orario_inizio', { ascending: true, nullsFirst: false })
        .limit(LIMITE_EVENTI)
      if (error) throw error
      return NextResponse.json({ success: true, data: eventi ?? [] })
    }

    // Ramo staff: stessi ruoli di requireDocente (cuoca esclusa).
    if (!['educator', 'admin', 'coordinator', 'segreteria'].includes(user.role)) {
      return NextResponse.json({ error: 'Accesso negato: riservato al personale docente' }, { status: 403 })
    }

    const plessi = await scuoleDiUtente(supabase, user)
    if (plessi.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    let query = supabase
      .from('eventi_agenda')
      .select('id, scuola_id, section_id, titolo, descrizione, tipo, data, orario_inizio, orario_fine, visibile_genitori, creato_da')
      .in('scuola_id', plessi)
      .gte('data', from)

    if (q.data.sezione) {
      const sezione = await sezionePerNomeInScope(supabase, user, q.data.sezione)
      if (!sezione) {
        return NextResponse.json({ error: 'Classe fuori dal tuo plesso' }, { status: 403 })
      }
      if (user.role === 'educator') {
        const mie = await sezioniDiUtente(supabase, user.id)
        if (!mie.includes(sezione.id)) {
          return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
        }
      }
      query = query.or(`section_id.is.null,section_id.eq.${sezione.id}`)
    } else if (user.role === 'educator') {
      // Educator senza filtro: plesso + SOLO le proprie sezioni.
      const mie = await sezioniDiUtente(supabase, user.id)
      query = query.or(
        mie.length > 0
          ? `section_id.is.null,section_id.in.(${mie.join(',')})`
          : 'section_id.is.null'
      )
    }

    const { data: eventi, error } = await query
      .order('data', { ascending: true })
      .order('orario_inizio', { ascending: true, nullsFirst: false })
      .limit(LIMITE_EVENTI)
    if (error) throw error
    return NextResponse.json({ success: true, data: eventi ?? [] })
  } catch (error) {
    console.error('Errore GET /api/agenda:', error)
    return NextResponse.json({ error: 'Errore nel caricamento agenda' }, { status: 500 })
  }
}

// POST /api/agenda — crea un evento (staff; educator solo proprie sezioni).
export async function POST(request: Request) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    // Anti-abuso: la creazione fa fan-out di notifiche ai genitori (conv. M5).
    const rl = rateLimit(`agenda-post:${user.id}`, { limit: 20, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppi eventi creati. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()

    // Risoluzione sezione: section_id esplicito o nome (risolto SOLO in scope).
    let sectionId: string | null = body.section_id ?? null
    if (!sectionId && body.sezione) {
      const sezione = await sezionePerNomeInScope(supabase, user, body.sezione)
      if (!sezione) {
        return NextResponse.json({ error: 'Classe fuori dal tuo plesso' }, { status: 403 })
      }
      sectionId = sezione.id
    }

    let scuolaId: string | null = null
    if (sectionId) {
      const scopeErr = await assertSezioneInScope(supabase, user, sectionId)
      if (scopeErr) return scopeErr
      const { data: section } = await supabase
        .from('sections')
        .select('id, scuola_id')
        .eq('id', sectionId)
        .maybeSingle()
      scuolaId = (section?.scuola_id as string) ?? null
    } else {
      // Evento di plesso: riservato a direzione/segreteria/coordinator.
      if (user.role === 'educator') {
        return NextResponse.json(
          { error: 'Gli eventi di plesso sono riservati a direzione e segreteria' },
          { status: 403 }
        )
      }
      const plessi = await scuoleDiUtente(supabase, user)
      scuolaId = body.scuola_id && plessi.includes(body.scuola_id) ? body.scuola_id : user.scuola_id ?? plessi[0] ?? null
    }
    if (!scuolaId) {
      return NextResponse.json({ error: 'Nessun plesso associato' }, { status: 400 })
    }

    const { data: evento, error } = await supabase
      .from('eventi_agenda')
      .insert({
        scuola_id: scuolaId,
        section_id: sectionId,
        titolo: body.titolo,
        descrizione: body.descrizione ?? null,
        tipo: body.tipo,
        data: body.data,
        orario_inizio: body.orario_inizio ?? null,
        orario_fine: body.orario_fine ?? null,
        visibile_genitori: body.visibile_genitori,
        creato_da: user.id,
      })
      .select()
      .single()
    if (error) throw error

    // Notifiche best-effort ai genitori (sezione, o intero plesso se evento di plesso).
    if (body.visibile_genitori) {
      try {
        let alunniQuery = supabase.from('alunni').select('id').eq('scuola_id', scuolaId)
        if (sectionId) alunniQuery = alunniQuery.eq('section_id', sectionId)
        const { data: alunni } = await alunniQuery
        await enqueueNotifichePerAlunni(supabase, {
          alunnoIds: (alunni ?? []).map((a) => a.id as string),
          tipo: 'agenda_evento',
          titolo: `${TIPO_LABEL[body.tipo]} in agenda: ${body.titolo}`,
          corpo: `${body.data}${body.orario_inizio ? ` · ore ${body.orario_inizio.slice(0, 5)}` : ''}`,
          link: '/parent',
          entitaTipo: 'agenda',
          entitaId: evento?.id as string | undefined,
          scuolaId,
        })
      } catch (e) {
        console.error('Notifiche agenda fallite (non bloccante):', e)
      }
    }

    return NextResponse.json({ success: true, data: evento }, { status: 201 })
  } catch (error) {
    console.error('Errore POST /api/agenda:', error)
    return NextResponse.json({ error: 'Errore nella creazione evento' }, { status: 500 })
  }
}

// DELETE /api/agenda?id= — creatore-o-direzione (admin, nei propri plessi).
export async function DELETE(request: Request) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const { data: evento } = await supabase
      .from('eventi_agenda')
      .select('id, scuola_id, creato_da')
      .eq('id', q.data.id)
      .maybeSingle()
    if (!evento) {
      return NextResponse.json({ error: 'Evento non trovato' }, { status: 404 })
    }

    const isCreatore = evento.creato_da === user.id
    let isDirezione = false
    if (!isCreatore && user.role === 'admin') {
      const plessi = await scuoleDiUtente(supabase, user)
      isDirezione = plessi.includes(evento.scuola_id as string)
    }
    if (!isCreatore && !isDirezione) {
      return NextResponse.json(
        { error: 'Solo il creatore o la direzione possono eliminare un evento' },
        { status: 403 }
      )
    }

    const { error } = await supabase.from('eventi_agenda').delete().eq('id', q.data.id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Errore DELETE /api/agenda:', error)
    return NextResponse.json({ error: "Errore nell'eliminazione evento" }, { status: 500 })
  }
}
