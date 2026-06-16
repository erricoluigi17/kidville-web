import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendPush } from '@/lib/push/web-push'

// POST /api/push/dispatch — invio Web Push delle notifiche non ancora inviate.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret`. NON chiamabile dal browser.
// Lo invoca il cron (pg_net) dopo aver inserito le notifiche, oppure manualmente.
export async function POST(request: Request) {
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
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
      .select('id, utente_id, endpoint, p256dh, auth')
      .in('utente_id', utenti)

    const subsByUser = new Map<string, typeof subs>()
    for (const s of subs || []) {
      const arr = subsByUser.get(s.utente_id) || []
      arr.push(s)
      subsByUser.set(s.utente_id, arr as typeof subs)
    }

    let inviate = 0
    const toRemove: string[] = []
    const inviateIds: string[] = []

    for (const n of pendenti) {
      const userSubs = subsByUser.get(n.utente_id) || []
      let anySent = false
      for (const s of userSubs!) {
        const res = await sendPush(
          { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
          { title: n.titolo, body: n.corpo ?? undefined, url: n.link ?? '/', tag: n.id }
        )
        if (res.ok) { anySent = true; inviate++ }
        else if (res.gone) toRemove.push(s.id)
      }
      // marca inviata (anche se l'utente non ha subs: evita ritentativi infiniti)
      inviateIds.push(n.id)
      if (anySent) { /* ok */ }
    }

    if (inviateIds.length) {
      await supabase.from('notifiche').update({ push_inviata_il: new Date().toISOString() }).in('id', inviateIds)
    }
    if (toRemove.length) {
      await supabase.from('push_subscriptions').delete().in('id', toRemove)
    }

    return NextResponse.json({ success: true, data: { inviate, notifiche: inviateIds.length, subs_rimosse: toRemove.length } })
  } catch (err) {
    console.error('Errore API POST dispatch:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
