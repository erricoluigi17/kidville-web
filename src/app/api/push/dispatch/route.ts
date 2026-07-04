import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendPush, vapidConfigured } from '@/lib/push/web-push'
import { sendNativePush, fcmConfigured } from '@/lib/push/native-push'
import { parseQuery } from '@/lib/validation/http'

const postQuerySchema = z.object({}) // nessun parametro in ingresso (il body eventuale del cron non viene letto)

// POST /api/push/dispatch — invio Web Push delle notifiche non ancora inviate.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret`. NON chiamabile dal browser.
// Lo invoca il cron (pg_net) dopo aver inserito le notifiche, oppure manualmente.
export async function POST(request: Request) {
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    // Senza NESSUN canale configurato (né VAPID web né FCM native) il push non
    // può partire: esito visibile (non_configurato) e notifiche NON marcate come
    // inviate, così partiranno appena un canale sarà configurato.
    const webOk = vapidConfigured()
    const nativeOk = fcmConfigured()
    if (!webOk && !nativeOk) {
      console.warn('[PUSH] dispatch saltato: nessun canale push configurato (VAPID/FCM)')
      return NextResponse.json({ success: true, data: { inviate: 0, non_configurato: true } })
    }

    const supabase = await createAdminClient()

    // notifiche da inviare (push non ancora spedita E buffer scaduto)
    const nowIso = new Date().toISOString()
    const { data: pendenti } = await supabase
      .from('notifiche')
      .select('id, utente_id, titolo, corpo, link')
      .is('push_inviata_il', null)
      .or(`invio_programmato_il.is.null,invio_programmato_il.lte.${nowIso}`)
      .order('creato_il', { ascending: true })
      .limit(500)

    if (!pendenti || pendenti.length === 0) {
      return NextResponse.json({ success: true, data: { inviate: 0 } })
    }

    const utenti = [...new Set(pendenti.map((n) => n.utente_id))]
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, utente_id, endpoint, p256dh, auth, platform')
      .in('utente_id', utenti)

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

    if (inviateIds.length) {
      await supabase.from('notifiche').update({ push_inviata_il: new Date().toISOString() }).in('id', inviateIds)
    }
    if (toRemove.length) {
      await supabase.from('push_subscriptions').delete().in('id', toRemove)
    }

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
    console.error('Errore API POST dispatch:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
