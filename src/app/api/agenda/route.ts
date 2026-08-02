import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, requireUser, type AppUser } from '@/lib/auth/require-staff'
import {
  assertSezioneInScope,
  resolveScuoleAttive,
  resolveScuolaScrittura,
  scuoleDiUtente,
} from '@/lib/auth/scope'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { sezioniDiUtente } from '@/lib/sezioni/docenti'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'
import { rateLimit } from '@/lib/security/rate-limit'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dataCivile } from '@/i18n/config'

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
  // Filtro staff per IDENTITÀ di sezione: è la forma da preferire — il nome non
  // identifica più nulla («2 ANNI» esiste ad Aversa e a Cesa).
  section_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
  sezione: z.string().trim().min(1).optional(), // ripiego: filtro per NOME sezione
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
  return dataCivile() // YYYY-MM-DD nel fuso della scuola
}

type EsitoSezione = { sezione: { id: string; scuola_id: string } } | { response: NextResponse }

/**
 * Risolve un NOME sezione entro le sedi ATTIVE dell'utente — e se il nome non
 * identifica UNA sola sezione, NEGA.
 *
 * ⚠️ Fino al 2026-07-31 qui c'era `.limit(1)` su `scuoleDiUtente`, e faceva due
 * danni insieme. (1) `LIMIT 1` senza `ORDER BY` non è «la prima»: è «una
 * qualsiasi», e con «2 ANNI» presente ad Aversa e a Cesa l'evento — con la sua
 * notifica alle famiglie — veniva archiviato in un plesso scelto dal
 * pianificatore di query. (2) `scuoleDiUtente` IGNORA il SedeSelector, mentre
 * `educator-sections`, che disegna le chip da cui parte la richiesta, usa
 * `resolveScuoleAttive`: l'admin che aveva selezionato la sola Cesa cliccava una
 * chip di Cesa e scriveva ad Aversa. Ora il perimetro è lo stesso delle chip, e
 * l'omonimia residua si risolve chiedendo la sede (400), non tirando a sorte.
 */
async function sezionePerNomeInScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  nome: string
): Promise<EsitoSezione> {
  const plessi = await resolveScuoleAttive(request, supabase, user)
  const fuoriPlesso = () =>
    NextResponse.json({ error: 'Classe fuori dal tuo plesso' }, { status: 403 })
  if (plessi.length === 0) return { response: fuoriPlesso() }

  const { data, error } = await supabase
    .from('sections')
    .select('id, scuola_id')
    .eq('name', nome)
    .in('scuola_id', plessi)
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un 403 muto, indistinguibile da un tentativo cross-sede.
    logEvento('agenda', 'error', {
      operazione: 'agenda:sezionePerNomeInScope', esito: 'sezione-non-risolta', sezione: nome,
    }, error)
    return { response: NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 }) }
  }
  if (data.length === 0) {
    logEvento('agenda', 'warn', {
      tipo: 'classe-fuori-sede', azione: 'agenda:sezionePerNomeInScope',
      utente: user.id, ruolo: user.role, sezione: nome, sedi: plessi.length,
    })
    return { response: fuoriPlesso() }
  }
  if (data.length > 1) {
    logEvento('agenda', 'warn', {
      tipo: 'classe-omonima-ambigua', azione: 'agenda:sezionePerNomeInScope',
      utente: user.id, ruolo: user.role, sezione: nome, candidate: data.length,
    })
    // Il dettaglio dell'omonimia («usare section_id») resta nella riga di log
    // qui sopra: all'operatore serve sapere cosa fare — scegliere la sede — non
    // il nome del parametro con cui il client glielo dirà.
    return { response: rifiutoSede('SEDE_DA_SPECIFICARE') }
  }
  return { sezione: { id: data[0].id as string, scuola_id: data[0].scuola_id as string } }
}

// GET /api/agenda — genitore: ?alunno_id= ; staff: [?sezione=][&from=YYYY-MM-DD]
export const GET = withRoute('agenda:GET', async (request: NextRequest) => {
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
      // Legame genitore↔alunno dall'UNIONE delle due sorgenti storiche: runtime
      // (`legame_genitori_alunni`) e anagrafica (`student_parents` via ponte
      // `parents.auth_user_id`). Con la sola runtime i genitori arrivati
      // dall'import iscrizioni ricevevano 403 sull'agenda del PROPRIO figlio.
      const collegato = await genitoreHasFiglio(supabase, user.id, alunnoId)
      if (!collegato) {
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

    // Sedi ATTIVE (SedeSelector ∩ accessibili), non tutte le accessibili: la
    // lettura deve avere lo stesso perimetro della scrittura, altrimenti si
    // crea un evento che poi non si rivede (o si rivede quello di un'altra sede).
    const plessi = await resolveScuoleAttive(request, supabase, user)
    if (plessi.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    let query = supabase
      .from('eventi_agenda')
      .select('id, scuola_id, section_id, titolo, descrizione, tipo, data, orario_inizio, orario_fine, visibile_genitori, creato_da')
      .in('scuola_id', plessi)
      .gte('data', from)

    // Filtro per sezione: `section_id` (identità) o, per i chiamanti vecchi, il
    // NOME risolto in scope. In entrambi i casi la lettura si stringe anche
    // sulla SEDE di quella sezione: gli eventi di plesso non hanno `section_id`,
    // quindi senza questo vincolo comparivano quelli di TUTTE le sedi attive,
    // etichettati solo «evento di plesso» e indistinguibili fra loro.
    let sezioneFiltro: { id: string; scuola_id: string } | null = null
    if (q.data.section_id) {
      const scopeErr = await assertSezioneInScope(supabase, user, q.data.section_id)
      if (scopeErr) return scopeErr
      const { data: sez, error: errSez } = await supabase
        .from('sections')
        .select('id, scuola_id')
        .eq('id', q.data.section_id)
        .maybeSingle()
      if (errSez) {
        logEvento('agenda', 'error', {
          operazione: 'agenda:GET', esito: 'sezione-non-risolta',
        }, errSez)
        return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
      }
      if (!sez) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })
      sezioneFiltro = { id: sez.id as string, scuola_id: sez.scuola_id as string }
    } else if (q.data.sezione) {
      const esito = await sezionePerNomeInScope(request, supabase, user, q.data.sezione)
      if ('response' in esito) return esito.response
      const { sezione } = esito
      if (user.role === 'educator') {
        const mie = await sezioniDiUtente(supabase, user.id)
        if (!mie.includes(sezione.id)) {
          return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
        }
      }
      sezioneFiltro = sezione
    }

    if (sezioneFiltro) {
      query = query
        .eq('scuola_id', sezioneFiltro.scuola_id)
        .or(`section_id.is.null,section_id.eq.${sezioneFiltro.id}`)
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
    logErrore({ operazione: 'agenda:GET', stato: 500 }, error)
    return NextResponse.json({ error: 'Errore nel caricamento agenda' }, { status: 500 })
  }
})

// POST /api/agenda — crea un evento (staff; educator solo proprie sezioni).
export const POST = withRoute('agenda:POST', async (request: NextRequest) => {
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
      const esito = await sezionePerNomeInScope(request, supabase, user, body.sezione)
      if ('response' in esito) return esito.response
      sectionId = esito.sezione.id
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
      // Ogni scrittura dichiara la sua sede. Prima qui c'era
      // `body.scuola_id ?? user.scuola_id ?? plessi[0]`: la sede primaria
      // dell'operatore scattava SEMPRE (`utenti.scuola_id` è NOT NULL ed è il
      // primo elemento di `scuoleDiUtente`), quindi un evento «di plesso»
      // finiva a Giugliano anche mentre l'admin guardava Aversa.
      const sw = await resolveScuolaScrittura(request, supabase, user, body.scuola_id)
      if (sw.response) return sw.response
      scuolaId = sw.scuolaId as string
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
        // `error` e non `warn` benché la richiesta risponda 201: qui non è «saltato un
        // dettaglio», è una SCRITTURA PERSA — le notifiche non sono mai finite in coda, quindi
        // dei genitori non sapranno mai dell'uscita o della riunione. L'evento è salvo, il suo
        // annuncio no: senza questa riga la differenza sarebbe invisibile (l'evento c'è, in
        // agenda si vede, e nessuno collega il silenzio a un guasto).
        logEvento('notifica', 'error', {
          operazione: 'agenda:POST',
          esito: 'notifiche-genitori-non-accodate',
          tipo: body.tipo,
        }, e)
      }
    }

    return NextResponse.json({ success: true, data: evento }, { status: 201 })
  } catch (error) {
    logErrore({ operazione: 'agenda:POST', stato: 500 }, error)
    return NextResponse.json({ error: 'Errore nella creazione evento' }, { status: 500 })
  }
})

// DELETE /api/agenda?id= — creatore-o-direzione (admin, nei propri plessi).
export const DELETE = withRoute('agenda:DELETE', async (request: Request) => {
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
    logErrore({ operazione: 'agenda:DELETE', stato: 500 }, error)
    return NextResponse.json({ error: "Errore nell'eliminazione evento" }, { status: 500 })
  }
})
