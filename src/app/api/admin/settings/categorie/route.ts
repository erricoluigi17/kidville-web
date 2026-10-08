import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope'
import { sediReali } from '@/lib/scuole/reali'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { rispostaServiziNonDisponibili } from '@/lib/pagamenti/generazione-server'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * scuola_id opzionale: qualunque valore falsy ('', null, assente) → "non fornito",
 * così il codice applica il fallback storico (`|| auth.user.scuola_id ...`).
 * Validarlo come uuid chiude anche l'interpolazione nel filtro PostgREST `.or()`.
 */
const zScuolaId = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaId })

/**
 * Servizio MENSILE (pomeridiano, doposcuola, pulmino…): la causale genera ogni mese una voce
 * per i bambini iscritti al servizio, con questo importo come proposta. Facoltativi, e nel
 * POST finiscono nell'insert SOLO se presenti nel body: il database degli E2E non ha ancora
 * le colonne e un insert con chiavi sconosciute risponderebbe PGRST204.
 */
const zServizioMensile = {
  mensile: z.boolean().optional(),
  importo_mensile_default: z.number().min(0).max(99999.99).nullable().optional(),
}

// slug/colore/icona/ordine: oggi pass-through senza vincoli (tipi enforced dal
// DB): schema volutamente permissivo. L'.optional() su z.unknown() è
// OBBLIGATORIO (in zod v4 z.unknown() nudo è required a runtime).
const postBodySchema = z.object({
  nome: z.string({ error: 'nome è obbligatorio' }).min(1, 'nome è obbligatorio'),
  scuola_id: zScuolaId,
  slug: z.unknown().optional(),
  colore: z.unknown().optional(),
  icona: z.unknown().optional(),
  ordine: z.unknown().optional(),
  ...zServizioMensile,
})

const patchBodySchema = z.object({
  id: zUuid, // sostituisce il 400 manuale 'id è obbligatorio'
  nome: z.unknown().optional(),
  colore: z.unknown().optional(),
  icona: z.unknown().optional(),
  ordine: z.unknown().optional(),
  attivo: z.unknown().optional(),
  ...zServizioMensile,
})

const deleteQuerySchema = z.object({
  id: zUuid, // sostituisce il 400 manuale 'id è obbligatorio'
})

/**
 * Gli errori di scrittura che hanno un significato per chi usa la schermata dei servizi.
 *
 *  · PGRST204 / 42703 — la colonna `mensile` / `importo_mensile_default` non c'è: database non
 *    ancora migrato (è il caso del DB degli E2E). 503, non un 500 generico.
 *  · 23514 — il CHECK che vieta `mensile` sulla causale con slug `retta` (la retta ha la sua
 *    generazione). Di fatto la retta è `is_sistema` e il PATCH la rifiuta prima con 409; resta
 *    la rete per una «retta» creata a mano dentro una sede.
 *
 * Ritorna la risposta pronta, oppure `null` per lasciar proseguire gli altri errori com'erano.
 */
function erroreServizioMensile(
  error: { code?: string | null },
  operazione: string,
  categoriaId?: string,
): NextResponse | null {
  if (error.code === 'PGRST204' || error.code === '42703') {
    logEvento('pagamento', 'error', {
      operazione, esito: 'servizi-non-disponibili', ...(categoriaId ? { categoria_id: categoriaId } : {}),
    }, error)
    return rispostaServiziNonDisponibili()
  }
  if (error.code === '23514') {
    logEvento('pagamento', 'warn', {
      operazione, esito: 'categoria-retta-non-mensile', ...(categoriaId ? { categoria_id: categoriaId } : {}),
    }, error)
    return NextResponse.json(
      { error: 'La categoria «Retta» non può essere un servizio mensile', codice: 'CATEGORIA_RETTA_NON_MENSILE' },
      { status: 409 },
    )
  }
  return null
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * La sede DICHIARATA dal client si VALIDA, non si ripiega.
 *
 * `resolveScuolaScrittura` ignora una `preferita` fuori scope e passa al ramo
 * successivo: per un utente con un solo plesso quel ramo risponde sempre, quindi
 * `?scuola_id=<altra sede>` non veniva rifiutato, veniva **sostituito in
 * silenzio**. Chi credeva di leggere (o configurare) Aversa leggeva Giugliano,
 * senza errore e senza log — la stessa forma del guasto che ha fatto archiviare
 * dati nel plesso sbagliato. Se la sede è nominata e non è fra quelle attive, la
 * risposta è 403.
 *
 * Il confronto è con `resolveScuoleAttive` (accessibili ∩ SedeSelector) e non con
 * le sole accessibili: i pannelli di configurazione girano dentro `SedeRequired`,
 * che manda esattamente la sede selezionata. Scrivere su una sede che l'operatore
 * ha appena tolto dal selettore è indistinguibile dal difetto che si sta chiudendo.
 *
 * NB: gemella della funzione omonima in `admin/settings/route.ts`. Non è ancora
 * un helper condiviso di proposito — `@/lib/auth/scope.ts` è in mano ad altri in
 * questo ciclo; l'estrazione è annotata per il consolidamento finale.
 */
async function sedeDichiarataFuoriScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  dichiarata: string | undefined,
  operazione: string,
): Promise<NextResponse | null> {
  if (!dichiarata) return null
  const sedi = await resolveScuoleAttive(request, supabase, user)
  if (sedi.includes(dichiarata)) return null
  // `warn` → persistito: una sede nominata e non posseduta è un segnale, non rumore.
  logEvento('multi_sede', 'warn', {
    tipo: 'sede-dichiarata-fuori-scope', azione: operazione,
    utente: user.id, ruolo: user.role, attive: sedi.length,
  })
  return rifiutoSede('SEDE_NON_ACCESSIBILE')
}

type CategoriaScope = { scuola_id: string | null; is_sistema: boolean }

/**
 * Legge la categoria per id e ne verifica lo SCOPE prima di ogni mutazione.
 *
 * `requireStaff` verifica il RUOLO, non il TENANT, e la route gira in
 * service-role (bypassa la RLS): senza questo controllo, PATCH e DELETE
 * lavoravano per solo `id`, e un id è indovinabile o riusabile.
 *
 * Due casi, con due regole diverse:
 *
 *  · categoria DI SEDE (`scuola_id` non-NULL): si tocca solo dalla sua sede
 *    (`resolveScuoleAttive`), altrimenti 403. È il caso latente: oggi in
 *    produzione non esiste ancora nessuna causale di plesso, ma il POST la sede
 *    la scrive già, e la prima che nascerà sarebbe modificabile da chiunque sia
 *    staff altrove.
 *
 *  · categoria GLOBALE (`scuola_id` NULL): è il caso ATTIVO. Tutte e cinque le
 *    causali di produzione sono globali, cioè valgono per tutti e tre i plessi:
 *    una segreteria di sede poteva rinominarle — e eliminare le due non di
 *    sistema — con ricaduta contabile su tutte le sedi. Regola (F5b dell'audit):
 *    una riga globale si LEGGE da tutte le sedi ma si MODIFICA solo da chi ha in
 *    scope TUTTE le sedi reali. Qui il confronto è con `scuoleDiUtente`, non con
 *    `resolveScuoleAttive`: la selezione del SedeSelector è un filtro di
 *    visualizzazione, non una rinuncia ai propri poteri — e il pannello gira
 *    dentro `SedeRequired`, cioè SEMPRE con una sola sede selezionata. Misurarla
 *    sulle sedi attive renderebbe le causali globali immodificabili da chiunque.
 *
 * La sede finta della CI non conta come sede reale (`sediReali` la esclude):
 * altrimenti nessun amministratore vero potrebbe mai essere «full-scope».
 *
 * Ritorna la riga oppure una NextResponse 4xx/5xx pronta.
 */
async function caricaCategoriaConScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  id: string,
): Promise<{ cat?: CategoriaScope; response?: NextResponse }> {
  const { data, error } = await supabase
    .from('payment_categories')
    .select('scuola_id, is_sistema')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe una scrittura senza verifica di scope.
    logErrore({ operazione: 'admin/settings/categorie:scope', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 }) }
  }
  if (!data) return { response: NextResponse.json({ error: 'Categoria non trovata' }, { status: 404 }) }
  const cat = data as CategoriaScope

  if (cat.scuola_id != null) {
    const sedi = await resolveScuoleAttive(request, supabase, user)
    if (!sedi.includes(cat.scuola_id)) {
      logEvento('multi_sede', 'warn', {
        tipo: 'categoria-fuori-sede', azione: 'admin/settings/categorie',
        utente: user.id, ruolo: user.role, attive: sedi.length,
      })
      return { response: NextResponse.json({ error: 'Categoria fuori dal tuo plesso' }, { status: 403 }) }
    }
    return { cat }
  }

  const accessibili = await scuoleDiUtente(supabase, user)
  const { reali, error: erroreSedi } = await sediReali(supabase, 'admin/settings/categorie:scope')
  if (erroreSedi) {
    // Senza l'elenco delle sedi non si può stabilire chi è full-scope: si nega
    // (già loggato `error` da `sediReali`).
    return { response: NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 }) }
  }
  const mancanti = reali.filter((s) => !accessibili.includes(s.id))
  if (mancanti.length > 0) {
    logEvento('multi_sede', 'warn', {
      tipo: 'categoria-globale-senza-tutte-le-sedi', azione: 'admin/settings/categorie',
      utente: user.id, ruolo: user.role, accessibili: accessibili.length, mancanti: mancanti.length,
    })
    return {
      response: NextResponse.json(
        { error: 'Questa causale vale per tutte le sedi: può modificarla solo chi le gestisce tutte' },
        { status: 403 },
      ),
    }
  }
  return { cat }
}

// GET /api/admin/settings/categorie?userId=&scuola_id=  (staff)
// Ritorna le categorie globali + quelle della scuola.
export const GET = withRoute('admin/settings/categorie:GET', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response

      const supabase = await createAdminClient()
      // Sede risolta server-side: lo scuola_id del client è SOLO una preferenza,
      // validata contro i plessi accessibili (mai fidarsi del client) — e se è
      // fuori scope si NEGA, non si ripiega su un'altra sede.
      const fuori = await sedeDichiarataFuoriScope(
        request, supabase, auth.user, q.data.scuola_id ?? undefined, 'admin/settings/categorie:GET',
      )
      if (fuori) return fuori

      // K2 (2026-09-26) — LETTURA MULTI-SEDE. Senza `scuola_id` e con più sedi
      // attive, fino a ieri `resolveScuolaScrittura` rispondeva 400: giusto per
      // una scrittura, sbagliato per questa lettura. Lo Scadenzario con due o tre
      // sedi selezionate restava senza causali, in silenzio. Ora si legge
      // l'UNIONE: globali (`scuola_id` NULL) + le causali di ogni sede attiva.
      // Ogni riga porta il proprio `scuola_id` (select '*'), così il client sa
      // di quale plesso è — e le omonime («Gita» di Aversa e di Cesa) restano
      // distinguibili. Con una sola sede attiva, o con la sede dichiarata, il
      // percorso è quello di prima, 403 compresi (cookie manomesso → `[]` qui,
      // e il 403 lo dà `resolveScuolaScrittura` più sotto).
      if (!q.data.scuola_id) {
        const attive = await resolveScuoleAttive(request, supabase, auth.user)
        if (attive.length > 1) {
          // `attive` è la forma CANONICA del database (uuid da `scuoleDiUtente`),
          // mai una stringa del client: l'interpolazione in `.or()` è sicura.
          const { data, error } = await supabase
            .from('payment_categories')
            .select('*')
            .or(`scuola_id.is.null,scuola_id.in.(${attive.join(',')})`)
            .order('ordine', { ascending: true })
          if (error) {
            logErrore({ operazione: 'admin/settings/categorie:GET', stato: 500, evento: 'db' }, error)
            return NextResponse.json({ error: 'Errore nel recupero delle categorie', codice: 'LETTURA_FALLITA' }, { status: 500 })
          }
          const righe = (data ?? []) as { scuola_id: string | null }[]
          logEvento('multi_sede', 'info', {
            tipo: 'categorie-multi-sede', azione: 'admin/settings/categorie:GET',
            utente: auth.user.id, ruolo: auth.user.role, attive: attive.length,
            n: righe.length, globali: righe.filter((r) => r.scuola_id == null).length,
          })
          return NextResponse.json({ success: true, data: righe })
        }
      }

      const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId

      let query = supabase.from('payment_categories').select('*').order('ordine', { ascending: true })
      // globali (scuola_id NULL) + della scuola
      if (scuolaId) query = query.or(`scuola_id.is.null,scuola_id.eq.${scuolaId}`)
      else query = query.is('scuola_id', null)

      const { data, error } = await query
      if (error) {
        // PostgREST non lancia: senza questo log una lettura fallita con la sede
        // dichiarata non lasciava traccia applicativa. Status e corpo invariati.
        logErrore({ operazione: 'admin/settings/categorie:GET', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ success: true, data })
    } catch (err) {
      logErrore({ operazione: 'admin/settings/categorie:GET', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})

// POST /api/admin/settings/categorie  (staff) — crea categoria personalizzata
// Body: { userId, nome, scuola_id?, colore?, icona?, ordine? }
export const POST = withRoute('admin/settings/categorie:POST', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const b = await parseBody(request, postBodySchema)
      if ('response' in b) return b.response
      const body = b.data

      const supabase = await createAdminClient()
      // Sede derivata server-side: lo scuola_id del body è una DICHIARAZIONE, e
      // se è fuori scope si nega (mai creare la causale in un altro plesso).
      const fuori = await sedeDichiarataFuoriScope(
        request, supabase, auth.user, body.scuola_id ?? undefined, 'admin/settings/categorie:POST',
      )
      if (fuori) return fuori
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id ?? undefined)
      if (sw.response) return sw.response

      const record = {
        scuola_id: sw.scuolaId ?? null,
        nome: body.nome,
        slug: body.slug || slugify(body.nome),
        colore: body.colore ?? '#006A5F',
        icona: body.icona ?? '💶',
        is_sistema: false,
        ordine: body.ordine ?? 99,
        // Solo se dichiarati: il database non migrato non ha le colonne (PGRST204).
        ...(body.mensile !== undefined ? { mensile: body.mensile } : {}),
        ...(body.importo_mensile_default !== undefined ? { importo_mensile_default: body.importo_mensile_default } : {}),
      }
      const { data, error } = await supabase.from('payment_categories').insert(record).select().single()
      if (error) {
        const speciale = erroreServizioMensile(error, 'admin/settings/categorie:POST')
        if (speciale) return speciale
        logErrore({ operazione: 'admin/settings/categorie:POST', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ success: true, data }, { status: 201 })
    } catch (err) {
      logErrore({ operazione: 'admin/settings/categorie:POST', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})

// PATCH /api/admin/settings/categorie  (staff) — rinomina/colore/icona/ordine/attivo
// Body: { userId, id, nome?, colore?, icona?, ordine?, attivo? }
export const PATCH = withRoute('admin/settings/categorie:PATCH', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response
      const body = b.data as Record<string, unknown>

      const allowed = ['nome', 'colore', 'icona', 'ordine', 'attivo', 'mensile', 'importo_mensile_default']
      const updates: Record<string, unknown> = {}
      for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]
      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
      }

      const supabase = await createAdminClient()

      // Scope di sede + guard is_sistema PRIMA di scrivere. Il guard mancava del
      // tutto: la DELETE proteggeva Retta/Iscrizione/Mensa, la PATCH le lasciava
      // rinominare e perfino disattivare (`attivo:false`) a qualunque staff.
      const sc = await caricaCategoriaConScope(request, supabase, auth.user, b.data.id)
      if (sc.response) return sc.response
      if (sc.cat!.is_sistema) {
        return NextResponse.json({ error: 'Le categorie di sistema non si modificano' }, { status: 409 })
      }

      // ⚠️ Lo slug NON si rigenera sulla rinomina (differenza VOLUTA dai due
      // cloni cassa/news): `genera_rette_mensili` risolve la causale per
      // `slug='retta'`. Rigenerarlo spegnerebbe la generazione delle rette.
      const { data, error } = await supabase.from('payment_categories').update(updates).eq('id', b.data.id).select().single()
      if (error) {
        const speciale = erroreServizioMensile(error, 'admin/settings/categorie:PATCH', b.data.id)
        if (speciale) return speciale
        logErrore({ operazione: 'admin/settings/categorie:PATCH', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      // Cambiare cos'è una causale (e quanto vale il servizio) muove le voci dei mesi a venire:
      // l'esito si vede anche quando va bene. Mai nome o testo libero: solo id e interruttore.
      logEvento('pagamento', 'info', {
        operazione: 'admin/settings/categorie:PATCH', esito: 'categoria-aggiornata',
        categoria_id: b.data.id,
        ...(typeof updates.mensile === 'boolean' ? { mensile: updates.mensile } : {}),
      })
      return NextResponse.json({ success: true, data })
    } catch (err) {
      logErrore({ operazione: 'admin/settings/categorie:PATCH', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})

// DELETE /api/admin/settings/categorie?id=xxx&userId=yyy  (staff)
// Bloccato per le categorie di sistema (is_sistema=true).
export const DELETE = withRoute('admin/settings/categorie:DELETE', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const q = parseQuery(request, deleteQuerySchema)
      if ('response' in q) return q.response
      const id = q.data.id

      const supabase = await createAdminClient()

      // Scope di sede + guard is_sistema PRIMA di eliminare. Il guard c'era già
      // ma rispondeva 403 (un problema di PERMESSI): lo stato giusto è 409, come
      // nei due cloni — la categoria di sistema non si elimina nemmeno avendone
      // tutti i diritti, è un CONFLITTO con lo stato della risorsa.
      const sc = await caricaCategoriaConScope(request, supabase, auth.user, id)
      if (sc.response) return sc.response
      if (sc.cat!.is_sistema) {
        return NextResponse.json({ error: 'Le categorie di sistema non possono essere eliminate' }, { status: 409 })
      }
      const { error } = await supabase.from('payment_categories').delete().eq('id', id)
      if (error) {
        // FK (23503): la causale è usata da voci di pagamento o da iscrizioni ai servizi.
        // Non è un guasto: è un conflitto con lo stato della risorsa, e c'è una via d'uscita.
        if (error.code === '23503') {
          logEvento('pagamento', 'warn', {
            operazione: 'admin/settings/categorie:DELETE', esito: 'categoria-in-uso', categoria_id: id,
          }, error)
          return NextResponse.json(
            {
              error: 'La categoria è usata da voci di pagamento o da iscrizioni ai servizi: disattivala invece di eliminarla',
              codice: 'CATEGORIA_IN_USO',
            },
            { status: 409 },
          )
        }
        logErrore({ operazione: 'admin/settings/categorie:DELETE', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ success: true })
    } catch (err) {
      logErrore({ operazione: 'admin/settings/categorie:DELETE', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})
