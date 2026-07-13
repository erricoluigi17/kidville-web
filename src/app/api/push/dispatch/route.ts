import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendPush, vapidConfigured } from '@/lib/push/web-push'
import { sendNativePush, fcmConfigured } from '@/lib/push/native-push'
import { parseQuery } from '@/lib/validation/http'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'

const postQuerySchema = z.object({}) // nessun parametro in ingresso (il body eventuale del cron non viene letto)

/**
 * IL BATTITO CARDIACO DEL CRON — la spiegazione sta qui, gli altri quattro job la
 * richiamano in breve.
 *
 * pg_net invoca questa route in fire-and-forget, dentro un `EXCEPTION WHEN OTHERS THEN
 * null`. Conseguenza: se il secret è sbagliato, se il job non è schedulato o se l'URL
 * salvato nel Vault è vecchio, **non arriva niente** — e ciò che non arriva non si logga.
 * Un errore lo si vede; un job che non parte, no. L'unico modo di sorvegliare un guasto
 * così è sorvegliare l'ASSENZA: il job dichiara «sono partito» e «ho finito», e il giorno
 * in cui quelle righe non compaiono più è il silenzio stesso il sintomo.
 *
 * TRE DECISIONI, tutte e tre obbligate (e tutte e tre diverse da come verrebbe naturale):
 *
 * 1. `operazione`, NON `job`. `redact()` è a lista bianca PER CHIAVE: `operazione` è in
 *    lista, `job` no — in tabella uscirebbe come `[redatto:str/13]` e la riga non direbbe
 *    più QUALE job. È anche la stessa chiave con cui `withRoute` nomina le rotte, quindi
 *    una query sola le trova tutte.
 *
 * 2. Il nome del job sta ANCHE nel `msg`, e non è ridondanza. `app_log` deduplica per
 *    (fingerprint, giorno), e l'impronta è livello+evento+route+messaggio+codice+utente:
 *    `contesto` NON ne fa parte. Finché queste route non sono avvolte da `withRoute` la
 *    colonna `route` è NULL → i battiti «ok» dei cinque cron avrebbero impronta IDENTICA,
 *    collasserebbero in una riga sola con il `contesto` del primo arrivato, e il battito
 *    di quattro job su cinque semplicemente non esisterebbe. `msg` finisce nella colonna
 *    `messaggio` (via `testoEvento`), che è vera, in chiaro e dentro l'impronta.
 *
 * 3. Il battito di chiusura va su OGNI return di successo, non solo sull'ultimo. La
 *    notte in cui non c'è niente da inviare è il caso NORMALE: se lì mancasse l'«ok», la
 *    sorveglianza vedrebbe un job partito e mai finito e griderebbe al lupo ogni notte —
 *    finendo per essere ignorata proprio quando il lupo arriva davvero.
 *
 * `cron` è in `EVENTI_PERSISTITI`: anche i successi finiscono in `app_log`. È voluto —
 * con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai partito niente».
 */
const JOB = 'push-dispatch'

/**
 * IL BATTITO NON PUÒ MENTIRE — ed è per questo che ogni query si controlla.
 *
 * **PostgREST NON LANCIA: ritorna `{ data, error }`** (regola 7 di AGENTS.md). Il `try/catch`
 * che avvolge questo handler NON scatta su una query fallita — scatta solo su un guasto di
 * rete. Quindi un `const { data: pendenti } = await supabase.from(…)` che ignora `error` (RLS
 * cambiata, statement timeout, 503) lascia `pendenti` a `null`, il codice scivola nel ramo
 * «zero elementi» e il battito di chiusura scrive `esito: 'ok', inviate: 0`. Chi sorveglia i
 * cron li vedrebbe VERDI ogni notte mentre nessuna push parte più: è lo STESSO guasto muto
 * delle email di credenziali, ricreato dal codice che doveva prevenirlo. E stavolta è peggio —
 * senza battito il bug era latente; **con un battito che non controlla `error` diventa una
 * bugia attiva**, cioè il contrario esatto dell'osservabilità.
 *
 * Sulla lettura di `push_subscriptions` l'esito è addirittura DISTRUTTIVO: `subsByUser`
 * resterebbe vuota (nessuna push spedita), ma `inviateIds` si riempirebbe lo stesso e le
 * notifiche verrebbero marcate `push_inviata_il` → **perse per sempre**, con il log che dice ok.
 *
 * Da qui la regola, identica in tutti e cinque i cron: `error` si destruttura SEMPRE, e se è
 * valorizzato il giro finisce lì — riga `error` (in tabella, perché `cron` è in
 * `EVENTI_PERSISTITI`), 500, e **nessun effetto collaterale a valle**.
 */
function queryFallita(azione: string, error: unknown, t0: number): NextResponse {
  // `esito` e `azione` sono nella lista bianca di `redact`: escono in chiaro anche nella riga
  // PERSISTITA, quindi in SQL si legge quale job e QUALE query è caduta. Il `msg` è distinto
  // per query e non è ridondante: `app_log` deduplica per (fingerprint, giorno) e l'impronta
  // contiene il messaggio, non il `contesto` — senza, tutte le query fallite di tutti i cron
  // collasserebbero in una riga sola. Il 4° argomento porta codice, `details` e `hint` di
  // PostgREST: uno status senza il corpo dell'errore è il bug, non un dettaglio.
  logEvento(
    'cron',
    'error',
    { operazione: JOB, esito: 'query-fallita', azione, ms: Date.now() - t0, msg: `${JOB}: ${azione} fallita` },
    error,
  )
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

// POST /api/push/dispatch — invio Web Push delle notifiche non ancora inviate.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret`. NON chiamabile dal browser.
// Lo invoca il cron (pg_net) dopo aver inserito le notifiche, oppure manualmente.
export const POST = withRoute('push/dispatch:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      // SI GRIDA SOLO SE L'HEADER C'È MA NON TORNA. Quello è un cron che bussa con la chiave
      // sbagliata: il guasto invisibile, e il motivo per cui questa riga esiste (da fuori è
      // indistinguibile da un cron che non gira). Il POST ANONIMO, invece, tace: la route è
      // pubblica e senza rate-limit, e un `curl -X POST /api/push/dispatch` scriverebbe una
      // riga `error` in tabella — cioè fabbricherebbe dal nulla il segnale «il cron è rotto»,
      // che è precisamente il segnale che questa riga porta. Un bot che bussa 10.000 volte
      // renderebbe l'allarme vero indistinguibile dal rumore, e l'unico modo di difendersi da
      // un allarme rumoroso è smettere di guardarlo.
      // (Il caso «CRON_SECRET non configurato» è coperto a monte dal preflight di
      // `src/instrumentation.ts`, che lo grida all'avvio: qui resta nel messaggio perché
      // separa i due incidenti veri, che si riparano in due posti diversi — la chiave nel
      // Vault del DB, la env var su Vercel.)
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    logEvento('cron', 'info', { operazione: JOB, esito: 'avviato', msg: `${JOB}: avviato` })

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    // Senza NESSUN canale configurato (né VAPID web né FCM native) il push non
    // può partire: esito visibile (non_configurato) e notifiche NON marcate come
    // inviate, così partiranno appena un canale sarà configurato.
    const webOk = vapidConfigured()
    const nativeOk = fcmConfigured()
    if (!webOk && !nativeOk) {
      // Configurazione mancante = `error`, mai `info`. Qui il giro si chiude con un 200
      // «success» mentre in realtà non ha spedito niente e non spedirà niente finché le
      // chiavi non arrivano: è il guasto muto per eccellenza — quello che le regole di
      // questo progetto esistono per rendere rumoroso.
      logEvento('cron', 'error', {
        operazione: JOB,
        esito: 'non-configurato',
        ms: Date.now() - t0,
        msg: `${JOB}: nessun canale push configurato (VAPID/FCM), notifiche lasciate in coda`,
      })
      return NextResponse.json({ success: true, data: { inviate: 0, non_configurato: true } })
    }

    const supabase = await createAdminClient()

    // notifiche da inviare (push non ancora spedita E buffer scaduto)
    const nowIso = new Date().toISOString()
    const { data: pendenti, error: errPendenti } = await supabase
      .from('notifiche')
      .select('id, utente_id, titolo, corpo, link')
      .is('push_inviata_il', null)
      .or(`invio_programmato_il.is.null,invio_programmato_il.lte.${nowIso}`)
      .order('creato_il', { ascending: true })
      .limit(500)
    // Senza questo controllo una lettura fallita è indistinguibile da «nessuna notifica in
    // coda»: si cadrebbe nel ramo qui sotto e si scriverebbe «ok, inviate 0».
    if (errPendenti) return queryFallita('lettura notifiche', errPendenti, t0)

    if (!pendenti || pendenti.length === 0) {
      // Il caso normale della stragrande maggioranza dei giri: niente da spedire. Ha
      // comunque bisogno del suo «ok» — vedi il punto 3 della doc in testa al file.
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'ok',
        ms: Date.now() - t0,
        notifiche: 0,
        inviate: 0,
        msg: `${JOB}: ok`,
      })
      return NextResponse.json({ success: true, data: { inviate: 0 } })
    }

    const utenti = [...new Set(pendenti.map((n) => n.utente_id))]
    const { data: subs, error: errSubs } = await supabase
      .from('push_subscriptions')
      .select('id, utente_id, endpoint, p256dh, auth, platform')
      .in('utente_id', utenti)
    // LA LETTURA PIÙ PERICOLOSA DEL FILE. Se fallisce e si tira dritto, `subsByUser` è vuota →
    // nessuna push parte, MA il ciclo qui sotto riempie `inviateIds` lo stesso e le notifiche
    // finiscono marcate `push_inviata_il`: **perse per sempre**, e il battito direbbe «ok».
    // Si esce PRIMA di qualunque invio e PRIMA di qualunque marcatura: le notifiche restano in
    // coda e partiranno al giro successivo, quando il DB avrà smesso di affannarsi.
    if (errSubs) return queryFallita('lettura push_subscriptions', errSubs, t0)

    const subsByUser = new Map<string, typeof subs>()
    for (const s of subs || []) {
      const arr = subsByUser.get(s.utente_id) || []
      arr.push(s)
      subsByUser.set(s.utente_id, arr as typeof subs)
    }

    let inviate = 0
    let nativeInviate = 0
    const toRemove: string[] = []
    const inviateIds: string[] = []

    for (const n of pendenti) {
      const userSubs = subsByUser.get(n.utente_id) || []
      const payload = { title: n.titolo, body: n.corpo ?? undefined, url: n.link ?? '/', tag: n.id }
      for (const s of userSubs!) {
        if (s.platform === 'ios' || s.platform === 'android') {
          // Canale nativo (FCM/APNs) — gated: se non configurato, saltato pulito.
          if (!nativeOk) continue
          const res = await sendNativePush(s.endpoint, s.platform, payload)
          if (res.ok) nativeInviate++
          else if (res.gone) toRemove.push(s.id)
        } else {
          // Canale web (VAPID). platform 'web' o legacy null.
          if (!webOk) continue
          const res = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload)
          if (res.ok) inviate++
          else if (res.gone) toRemove.push(s.id)
        }
      }
      // marca inviata comunque (anche senza subs o con canali gated: evita ritentativi infiniti)
      inviateIds.push(n.id)
    }

    // Anche le SCRITTURE ritornano `{ error }` senza lanciare, e anche il loro fallimento è
    // muto: se la marcatura non passa, le stesse notifiche verranno rispedite al giro
    // successivo (push doppie ai genitori) e nessuno lo saprebbe. Il 500 non annulla le push
    // già partite — non c'è nulla da annullare — ma impedisce al battito di dire «ok» su un
    // giro che ok non è stato: è tutta la differenza fra un log e un log che mente.
    if (inviateIds.length) {
      const { error } = await supabase
        .from('notifiche')
        .update({ push_inviata_il: new Date().toISOString() })
        .in('id', inviateIds)
      if (error) return queryFallita('marcatura notifiche inviate', error, t0)
    }
    if (toRemove.length) {
      // Le subscription «gone» (410/404) che non si riesce a cancellare restano lì e ogni notte
      // riprovano a ricevere una push che non arriverà mai: un errore silenzioso e permanente.
      const { error } = await supabase.from('push_subscriptions').delete().in('id', toRemove)
      if (error) return queryFallita('rimozione push_subscriptions', error, t0)
    }

    // I contatori sono NUMERI: `redact()` li lascia passare in chiaro anche in tabella,
    // qualunque sia la chiave. Sono la seconda metà del battito — non solo «gira», ma
    // «gira e sta facendo qualcosa»: un dispatch che parte ogni notte e invia sempre 0
    // è rotto tanto quanto uno che non parte.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: 'ok',
      ms: Date.now() - t0,
      inviate,
      native_inviate: nativeInviate,
      notifiche: inviateIds.length,
      subs_rimosse: toRemove.length,
      msg: `${JOB}: ok`,
    })
    return NextResponse.json({
      success: true,
      data: {
        inviate,
        native_inviate: nativeInviate,
        notifiche: inviateIds.length,
        subs_rimosse: toRemove.length,
      },
    })
  } catch (err) {
    // `evento: 'cron'` (e non il 'route' di default): il guasto deve stare nello STESSO
    // flusso dei battiti, perché chi sorveglia i cron interroga `where evento = 'cron'` e
    // non deve dover sapere che il fallimento totale del job si cerca da un'altra parte.
    // `logErrore` emette anche l'Error nativo con lo stack VERO, che un `console.error`
    // sul solo messaggio non dava.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
