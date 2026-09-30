import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { vapidConfigured } from '@/lib/push/web-push'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// L'eventuale `userId` nel body/header e' ignorato: si usa sempre l'utente autenticato.
// Due varianti: Web Push (subscription VAPID) oppure token NATIVO (Capacitor iOS/Android).
const webSchema = z.object({
  subscription: z.object(
    {
      endpoint: z.string().min(1, 'subscription non valida'),
      keys: z.object(
        {
          p256dh: z.string().min(1, 'subscription non valida'),
          auth: z.string().min(1, 'subscription non valida'),
        },
        { error: 'subscription non valida' }
      ),
    },
    { error: 'subscription non valida' }
  ),
})
const nativeSchema = z.object({
  token: z.string().min(1, 'token non valido'),
  platform: z.enum(['ios', 'android']),
})
const postBodySchema = z.union([webSchema, nativeSchema])

const deleteQuerySchema = z.object({
  endpoint: z.string({ error: 'endpoint è obbligatorio' }).min(1, 'endpoint è obbligatorio'),
})

/**
 * La query del GET: un `userId` eventuale è TOLLERATO e IGNORATO.
 *
 * Tollerato perché i chiamanti del genitore lo attaccano da sempre (l'identità legacy del
 * `localStorage`, vedi la testata di `native-register.ts`) e una 400 su quel parametro
 * spegnerebbe la lettura per loro. Ignorato perché l'identità la decide il GATE: se decidesse
 * la query, chiunque autenticato potrebbe contare i dispositivi di chiunque altro passando il
 * suo uuid. Resta un uuid e non un `string()` perché lo schema è una lista bianca anche per
 * ciò che butta: un parametro fuori forma è un chiamante che sta sbagliando, e lo si dice.
 *
 * ⚠️ `zUuid` (`z.guid()`) e NON `z.string().uuid()`: quest'ultimo applica lo strict RFC 9562 e
 * rifiuterebbe gli identificativi SEMINATI — la sede di collaudo della CI è `e2e00000-…`, e gli
 * account di prova sono `aaaaaaaa-aaaa-…`. Il perché sta nella testata di
 * `src/lib/validation/common.ts`, ed è il motivo per cui in questo repo non si scrive `uuid()`.
 */
const getQuerySchema = z.object({
  userId: zUuid.optional(),
})

/**
 * «Non si è potuto leggere lo stato», in un posto solo.
 *
 * Il `message` di PostgREST NON entra nel corpo: riecheggia il filtro, cioè l'uuid
 * dell'utente. Il codice lo traduce il client (`CODICI_ERRORE`), la prosa resta il ripiego
 * per chi legge la risposta grezza.
 */
function statoNonLetto(): NextResponse {
  return NextResponse.json(
    {
      error: 'Non è stato possibile verificare i dispositivi iscritti alle notifiche',
      codice: 'PUSH_STATO_NON_LETTO',
    },
    { status: 500 }
  )
}

/**
 * GET /api/push/subscribe — QUANTI dispositivi dell'utente autenticato sono iscritti.
 *
 * ─── PERCHÉ (segnalazione del 2026-09-29, compito C1) ───────────────────────────
 *
 * «I messaggi dei genitori non arrivano alle maestre». Fra le cause misurate: le docenti che
 * hanno rifiutato il permesso delle notifiche (`push-nativa-permesso-negato: denied` nei log
 * da inizio settembre) non ricevono NESSUNA push, e nessuno lo sa — né loro né la Direzione.
 * Una maestra su Android ha ricevuto 137 messaggi in 30 giorni senza una sola notifica.
 *
 * SI CONTANO LE RIGHE, NON SI CHIEDE IL PERMESSO AL SISTEMA. Il permesso lo sa solo il
 * dispositivo, e non basta: su iOS può essere `granted` mentre il token APNs non è mai
 * arrivato al server (è il caso che `ATTESA_REGISTRAZIONE_MS` esiste per scoprire). La sola
 * risposta alla domanda «mi arriveranno?» è una riga in `push_subscriptions`.
 *
 * Head-query: torna il numero, non gli endpoint. Un endpoint è l'indirizzo del dispositivo,
 * e per decidere se mostrare un avviso serve solo sapere se sono zero.
 *
 * L'identità è quella del gate (vedi `getQuerySchema`). Nessuna sede: il perimetro di questa
 * lettura è l'identità stessa, e `push_subscriptions` non ha `scuola_id` — un dispositivo
 * appartiene a una persona, non a un plesso.
 */
export const GET = withRoute('push/subscribe:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    // PostgREST non lancia: ritorna `{ error }` (regola 7 di AGENTS.md). Un `try/catch`
    // attorno a questa riga non scatterebbe mai, quindi si guarda il valore di ritorno.
    const { count, error, status } = await supabase
      .from('push_subscriptions')
      .select('endpoint', { count: 'exact', head: true })
      .eq('utente_id', auth.user.id)

    // ⚠️ `count === null` VALE COME ERRORE, e non è teoria: su una HEAD il corpo è VUOTO per
    // HTTP, quindi il driver non ha da cosa costruire un `error`. Su un 404 — la tabella fuori
    // dalla schema cache, `PGRST205` — `postgrest-js` restituisce `error: null`, `count: null`
    // e riscrive lo stato in **204 No Content** (`dist/index.cjs`: «if (res.status === 404 &&
    // body === "")»). Con un `count ?? 0` la route risponderebbe «zero dispositivi» a TUTTE le
    // docenti, e l'avviso comparirebbe a tutte insieme: «non lo so» travestito da misura.
    // Un conteggio che non è un numero non è uno zero.
    if (error || count === null) {
      // `error` e non `warn`: senza questo numero l'avviso in home tace, e una maestra senza
      // notifiche continua a non saperlo — che è esattamente il guasto da chiudere.
      //
      // LO `stato` È LA DIAGNOSI QUI DISPONIBILE, e va detto per esteso perché è controintuitivo:
      // su una HEAD l'errore, quando c'è, arriva con `message` VUOTO — niente details, niente
      // hint, niente code, perché il corpo non esiste. Resta il codice, ed è l'unica cosa che
      // distingue i casi: **204** (il 404 riscritto dal driver: tabella non in cache), 401
      // (la chiave di servizio rifiutata — non le RLS, che questo client scavalca), 5xx.
      // L'errore si passa comunque come quarto argomento, per i casi in cui il driver riesca
      // a riempirlo.
      // Al client non arriva niente di tutto questo (vedi `statoNonLetto`): il `message` di
      // PostgREST riecheggia il filtro, e il filtro è l'identità dell'utente.
      logEvento('push', 'error', {
        operazione: 'push/subscribe:GET',
        esito: 'stato-non-letto',
        utente_id: auth.user.id,
        stato: typeof status === 'number' ? status : 0,
      }, error ?? undefined)
      return statoNonLetto()
    }

    return NextResponse.json({ success: true, dispositivi: count })
  } catch (err) {
    // `withRoute` NON vede le eccezioni catturate: il log lo scrive questo ramo.
    logErrore({ operazione: 'push/subscribe:GET', stato: 500 }, err)
    // LO STESSO CODICE del ramo qui sopra, e non un «Internal Server Error» nudo: per chi
    // chiede il conteggio i due casi sono lo stesso fatto — «non si è potuto leggere» — e il
    // client si comporta identico (non mostra l'avviso). Un codice riusato è un difetto
    // quando racconta un'altra operazione (vedi `NEWS_FILE_NON_RIMOSSI` in `esito-fetch.ts`):
    // qui l'operazione è la medesima.
    return statoNonLetto()
  }
})

// POST /api/push/subscribe  — registra la subscription push dell'utente autenticato.
// Body web:    { subscription: { endpoint, keys: { p256dh, auth } } }
// Body nativo: { token, platform: 'ios' | 'android' }
export const POST = withRoute('push/subscribe:POST', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const userAgent = request.headers.get('user-agent') ?? null

    if ('token' in body) {
      // Token nativo (FCM/APNs). Il gating dell'INVIO e' a dispatch time: qui
      // registriamo sempre il token, cosi' e' pronto quando FCM sara' configurato.
      // Il token nativo occupa la colonna `endpoint` (chiave di upsert); p256dh/auth
      // (specifici del Web Push) restano NULL.
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          utente_id: user.id,
          endpoint: body.token,
          p256dh: null,
          auth: null,
          platform: body.platform,
          user_agent: userAgent,
        },
        { onConflict: 'endpoint' }
      )
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, platform: body.platform }, { status: 201 })
    }

    // Web Push (VAPID). Registrare una subscription che non potra' mai ricevere
    // push e' fuorviante: 503 chiaro finche' le chiavi VAPID non sono configurate.
    if (!vapidConfigured()) {
      return NextResponse.json(
        { error: 'configurazione mancante: VAPID (push web non configurato)' },
        { status: 503 }
      )
    }

    const sub = body.subscription
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        utente_id: user.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        platform: 'web',
        user_agent: userAgent,
      },
      { onConflict: 'endpoint' }
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'push/subscribe:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/push/subscribe?endpoint=...  — rimuove la subscription (web o nativa:
// per i token nativi `endpoint` contiene il token stesso).
export const DELETE = withRoute('push/subscribe:DELETE', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { endpoint } = q.data

    const supabase = await createAdminClient()
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('utente_id', auth.user.id)
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'push/subscribe:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
