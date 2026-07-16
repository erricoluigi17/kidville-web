import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireKitchenRead } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, assertAlunnoInScope } from '@/lib/auth/scope'
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti'
import { parseQuery, parseBody } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione ───────────────────────────────────────────────────
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

const getQuerySchema = z.object({
  data: zDataYMD.optional(),
  scuola_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
  sezione: z.string().optional(),
})

const postBodySchema = z.object({
  alunno_id: zUuid,
  data: zDataYMD,
  richiesta: z.string().trim().min(1, 'La richiesta non può essere vuota').max(500),
  origine: z.enum(['segreteria', 'genitore']).optional().default('segreteria'),
})

const deleteQuerySchema = z.object({
  alunno_id: zUuid,
  data: zDataYMD,
})

// La tabella `mensa_alternative` può non esistere in alcuni ambienti (DB E2E CI
// non migrato): in quel caso GET degrada a vuoto, POST/DELETE a un errore chiaro
// invece di un 500 grezzo. PostgREST: 42P01 (tabella assente) / PGRST205 (schema cache).
function tabellaMancante(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204') return true
  return /does not exist|schema cache|could not find/i.test(error.message ?? '')
}

interface AlternativaRow {
  id: string
  alunno_id: string
  data: string
  richiesta: string
  origine: string
  created_at: string
}
interface AlunnoNome {
  id: string
  nome: string
  cognome: string
  classe_sezione: string | null
}

// ============================================================================
// GET /api/mensa/alternative?data=&scuola_id=&sezione=
//   Alternative MANUALI del giorno (richieste inserite dalla segreteria). Le
//   alternative AUTOMATICHE per allergia sono derivate dal report, non qui.
//   Lettura: cucina/staff/docente (requireKitchenRead). L'educator è vincolato
//   alla propria sezione (stesso enforcement A8 del report).
// ============================================================================
export const GET = withRoute('mensa/alternative:GET', async (request: NextRequest) => {
  try {
    const auth = await requireKitchenRead(request)
    if (auth.response) return auth.response
    const { user } = auth

    const qp = parseQuery(request, getQuerySchema)
    if ('response' in qp) return qp.response
    const data = qp.data.data ?? new Date().toISOString().slice(0, 10)
    const sezione = qp.data.sezione

    const supabase = await createAdminClient()

    // Enforcement sezione docente (A8): l'educator vede SOLO le proprie sezioni.
    if (user.role === 'educator') {
      if (!sezione) {
        return NextResponse.json({ error: 'Parametro sezione obbligatorio per il ruolo insegnante' }, { status: 400 })
      }
      const mie = await nomiSezioniDiUtente(supabase, user.id)
      if (!mie.includes(sezione)) {
        logEvento('mensa', 'warn', { tipo: 'sezione-fuori-scope', utente: user.id, sezione })
        return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
      }
    }

    const sw = await resolveScuolaScrittura(request, supabase, user, qp.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { data: alts, error } = await supabase
      .from('mensa_alternative')
      .select('id, alunno_id, data, richiesta, origine, created_at')
      .eq('scuola_id', scuolaId)
      .eq('data', data)
      .order('created_at', { ascending: true })

    if (error) {
      if (tabellaMancante(error)) {
        // Degrade pulito su DB non migrato: lista vuota, tracciato a info (niente rumore).
        logEvento('mensa', 'info', { tipo: 'alternative-degrade', esito: 'tabella-assente' })
        return NextResponse.json({ success: true, data: { data, alternative: [] } })
      }
      logErrore({ operazione: 'mensa/alternative:GET', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore nel caricamento delle alternative' }, { status: 500 })
    }

    const rows = (alts ?? []) as AlternativaRow[]
    if (rows.length === 0) {
      return NextResponse.json({ success: true, data: { data, alternative: [] } })
    }

    // Nomi degli alunni (per la UI). Query separata: robusta al degrade dell'embed.
    const alunnoIds = [...new Set(rows.map(r => r.alunno_id))]
    const { data: alunni, error: alunniErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione')
      .in('id', alunnoIds)
    if (alunniErr) {
      logErrore({ operazione: 'mensa/alternative:GET', stato: 500 }, alunniErr)
      return NextResponse.json({ error: 'Errore nel caricamento degli alunni' }, { status: 500 })
    }
    const byId = new Map<string, AlunnoNome>((alunni ?? []).map((a) => [a.id as string, a as AlunnoNome]))

    let alternative = rows.map((r) => {
      const a = byId.get(r.alunno_id)
      return {
        id: r.id,
        alunno_id: r.alunno_id,
        nome: a ? `${a.nome} ${a.cognome}`.trim() : '—',
        classe: a?.classe_sezione ?? '—',
        richiesta: r.richiesta,
        origine: r.origine,
        created_at: r.created_at,
      }
    })
    if (sezione) alternative = alternative.filter((x) => x.classe === sezione)

    return NextResponse.json({ success: true, data: { data, alternative } })
  } catch (err) {
    logErrore({ operazione: 'mensa/alternative:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// ============================================================================
// POST /api/mensa/alternative
//   Registra (UPSERT su alunno_id+data) l'alternativa manuale per un alunno.
//   La nuova nota SOVRASCRIVE quella del giorno. Solo staff (requireStaff).
// ============================================================================
export const POST = withRoute('mensa/alternative:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const body = await parseBody(request, postBodySchema)
    if ('response' in body) return body.response
    const { alunno_id, data, richiesta, origine } = body.data

    const supabase = await createAdminClient()

    const scope = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scope) return scope

    const sw = await resolveScuolaScrittura(request, supabase, user)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { error } = await supabase
      .from('mensa_alternative')
      .upsert(
        { scuola_id: scuolaId, alunno_id, data, richiesta, origine, created_by: user.id },
        { onConflict: 'alunno_id,data' }
      )

    if (error) {
      if (tabellaMancante(error)) {
        logEvento('mensa', 'info', { tipo: 'alternative-degrade', esito: 'tabella-assente' })
        return NextResponse.json({ error: 'Funzione non ancora disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'mensa/alternative:POST', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore nel salvataggio dell\'alternativa' }, { status: 500 })
    }

    // Successo loggato: SOLO uuid alunno + data. Mai il testo della richiesta né nomi.
    logEvento('mensa', 'info', { tipo: 'alternativa-salvata', esito: 'salvata', alunno: alunno_id, data })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'mensa/alternative:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// ============================================================================
// DELETE /api/mensa/alternative?alunno_id=&data=
//   Elimina l'alternativa manuale del giorno per un alunno. Solo staff.
// ============================================================================
export const DELETE = withRoute('mensa/alternative:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const qp = parseQuery(request, deleteQuerySchema)
    if ('response' in qp) return qp.response
    const { alunno_id, data } = qp.data

    const supabase = await createAdminClient()

    const scope = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scope) return scope

    const sw = await resolveScuolaScrittura(request, supabase, user)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { error } = await supabase
      .from('mensa_alternative')
      .delete()
      .eq('scuola_id', scuolaId)
      .eq('alunno_id', alunno_id)
      .eq('data', data)

    if (error) {
      if (tabellaMancante(error)) {
        logEvento('mensa', 'info', { tipo: 'alternative-degrade', esito: 'tabella-assente' })
        return NextResponse.json({ error: 'Funzione non ancora disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'mensa/alternative:DELETE', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore nell\'eliminazione dell\'alternativa' }, { status: 500 })
    }

    logEvento('mensa', 'info', { tipo: 'alternativa-eliminata', esito: 'eliminata', alunno: alunno_id, data })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'mensa/alternative:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
