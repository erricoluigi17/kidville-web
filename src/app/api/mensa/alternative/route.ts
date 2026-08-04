import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireKitchenRead } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, assertAlunnoInScope } from '@/lib/auth/scope'
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti'
import { parseQuery, parseBody } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { tabellaMancante } from '@/lib/db/tolleranza-schema'

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
  // Sede della scrittura, come già fa la GET. Facoltativa nello schema: chi ha
  // un solo plesso non ha nulla da scegliere, chi ne ha più d'uno riceve 400 da
  // `resolveScuolaScrittura` finché non la dichiara.
  scuola_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
})

const deleteQuerySchema = z.object({
  alunno_id: zUuid,
  data: zDataYMD,
  scuola_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
})

// La tabella `mensa_alternative` può non esistere in alcuni ambienti (DB E2E CI
// non migrato): in quel caso GET degrada a vuoto, POST/DELETE a un errore chiaro
// invece di un 500 grezzo.
//
// ⚠️ `tabellaMancante` ARRIVA DA UN MODULO CONDIVISO (`@/lib/db/tolleranza-schema`)
// e non si riscrive qui. La copia che stava in queste righe accettava anche
// `PGRST204` (colonna assente in INSERT/UPDATE) e qualunque messaggio contenente
// «does not exist» — cioè pure `42703` (colonna assente in SELECT). Su
// `mensa_alternative`, che in produzione ESISTE ed è viva, questo significava
// rispondere «nessuna alternativa oggi» alla cucina e «funzione non ancora
// disponibile» alla segreteria mentre la tabella era lì, con una colonna in meno.
// Su questo endpoint una lista vuota che dovrebbe avere righe è un bambino
// intollerante che riceve il piatto sbagliato: la tolleranza vale solo per «la
// tabella non c'è», e la discriminante è il CODICE, non la prosa del messaggio.

/**
 * La sede della scrittura deve essere QUELLA DELL'ALUNNO.
 *
 * `mensa_alternative.scuola_id` non è un'etichetta: è il filtro con cui la
 * cucina legge le richieste del giorno (GET, `.eq('scuola_id', …)`). Una riga
 * archiviata in un plesso mentre il bambino sta in un altro sparisce
 * dall'elenco di chi gli cucina e compare in quello di chi non lo conosce —
 * cioè un'allergia che non si vede. Con un plesso solo il caso non esisteva;
 * con tre, `assertAlunnoInScope` ammette per l'admin gli alunni di TUTTE le sue
 * sedi, mentre `resolveScuolaScrittura` ne sceglie UNA: le due possono
 * legittimamente non coincidere, e allora si rifiuta invece di scrivere.
 *
 * Ritorna la NextResponse d'errore, oppure `null` se le sedi concordano.
 */
async function sedeDiscordeDallAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  scuolaId: string,
  operazione: string,
): Promise<NextResponse | null> {
  // PostgREST non lancia: si controlla `{ error }`.
  const { data, error } = await supabase
    .from('alunni')
    .select('scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error) {
    logErrore({ operazione, stato: 500 }, error)
    return NextResponse.json({ error: 'Verifica della sede non riuscita' }, { status: 500 })
  }
  const sedeAlunno = (data?.scuola_id as string | null | undefined) ?? null
  if (sedeAlunno !== scuolaId) {
    // `warn` → persistito: una scrittura rifiutata deve lasciare traccia del
    // perché. Solo uuid e ruoli: nessun nome, nessuna richiesta alimentare.
    logEvento('mensa', 'warn', {
      operazione,
      esito: 'sede-discorde-dall-alunno',
      alunno: alunnoId,
      sede_id: scuolaId,
    })
    return NextResponse.json({ error: 'La sede indicata non è quella dell\'alunno' }, { status: 400 })
  }
  return null
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

    // La sede si DICHIARA (`scuola_id` nel body), come già nella GET. Senza, per
    // chi ha più plessi il resolver risponde 400 nominando il parametro.
    const sw = await resolveScuolaScrittura(request, supabase, user, body.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const discorde = await sedeDiscordeDallAlunno(supabase, alunno_id, scuolaId, 'mensa/alternative:POST')
    if (discorde) return discorde

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

    // Gemella della POST: la sede si dichiara in query (`?scuola_id=`), e deve
    // essere quella dell'alunno — altrimenti la DELETE non troverebbe la riga e
    // risponderebbe «fatto» senza aver cancellato niente.
    const sw = await resolveScuolaScrittura(request, supabase, user, qp.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const discorde = await sedeDiscordeDallAlunno(supabase, alunno_id, scuolaId, 'mensa/alternative:DELETE')
    if (discorde) return discorde

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
