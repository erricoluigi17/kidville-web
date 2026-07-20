import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { externalFetch, type EsitoEsterno } from '@/lib/logging/external'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseInstagramUrl, buildEmbedUrl, esitoHealthCheck } from '@/lib/news/instagram'
import { notificaNewsPubblicata, type PostDaNotificare } from '@/lib/news/notifiche'
import { generaEInviaDigest } from '@/lib/news/digest'

// =============================================================================
// POST /api/news/cron/run — motore cron della sezione News (pattern solleciti/run).
// SERVICE-TO-SERVICE: header `x-cron-secret`. Due job:
//   · tick   (ogni 10'): promuove le programmate scadute a pubblicate (+ notifica)
//            e fa l'health-check degli embed Instagram (2 fallimenti CONSECUTIVI →
//            post nascosto; 429/403 → indeterminato, NESSUN incremento).
//   · digest (1° del mese): genera/invia il digest del MESE PRECEDENTE.
// Query fallita → riga cron `error` + 500, MAI il battito «ok».
// =============================================================================

const JOB = 'news-cron'

const bodySchema = z.object({ job: z.enum(['tick', 'digest']) })

/** Query fallita → riga d'errore parlante + 500, e NESSUN battito «ok». */
function queryFallita(azione: string, error: unknown, t0: number): NextResponse {
  logEvento('cron', 'error', { operazione: JOB, esito: 'query-fallita', azione, ms: Date.now() - t0, msg: `${JOB}: ${azione} fallita` }, error)
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

/** Corpo per l'health-check: su !ok c'è già in `corpo`; su ok lo si legge dalla Response. */
async function corpoDaFetch(r: EsitoEsterno): Promise<string> {
  if (r.corpo) return r.corpo
  const res = r.res as { text?: () => Promise<string> } | undefined
  if (res && typeof res.text === 'function') {
    try {
      return await res.text()
    } catch (err) {
      // Corpo non rileggibile (stream già consumato): NON è un guasto del prodotto,
      // l'esito degrada a 'indeterminato'. Si logga a info (regola 6: nessun catch muto).
      logEvento('news', 'info', { operazione: 'news/cron:ig-health', esito: 'corpo-illeggibile' }, err)
      return ''
    }
  }
  return ''
}

// ── Job «tick» ────────────────────────────────────────────────────────────────
async function eseguiTick(supabase: SupabaseClient, t0: number): Promise<NextResponse> {
  const now = new Date()
  const nowIso = now.toISOString()

  // 1) Promuovi le programmate scadute → pubblicate (+ notifica idempotente).
  const { data: prog, error: progErr } = await supabase
    .from('news_posts')
    .select('id, titolo, scuola_id, target_scope, target_gradi, target_classes, contenuto_testo, invia_notifica, notifica_inviata_il')
    .eq('stato', 'programmata')
    .lte('programmata_il', nowIso)
    .limit(100)
  if (progErr) {
    if (schemaAssente(progErr)) {
      logEvento('cron', 'info', { operazione: JOB, esito: 'schema-assente', ms: Date.now() - t0, msg: `${JOB}: schema-assente` })
      return NextResponse.json({ success: true, disponibile: false })
    }
    return queryFallita('lettura programmate', progErr, t0)
  }
  for (const p of (prog ?? []) as PostDaNotificare[]) {
    const { error: updErr } = await supabase
      .from('news_posts')
      .update({ stato: 'pubblicata', pubblicata_il: nowIso, nascosta_motivo: null, updated_at: nowIso })
      .eq('id', p.id)
    if (updErr) {
      logEvento('cron', 'error', { operazione: JOB, esito: 'promozione-fallita', post_id: p.id }, updErr)
      continue
    }
    await notificaNewsPubblicata(supabase, p)
  }

  // 2) Health-check Instagram: max 10/run, quelli mai controllati o più vecchi di 24h.
  const soglia24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const { data: igPosts, error: igErr } = await supabase
    .from('news_posts')
    .select('id, instagram_url, instagram_shortcode, ig_check_falliti')
    .eq('tipo', 'instagram')
    .eq('stato', 'pubblicata')
    .or(`ig_check_il.is.null,ig_check_il.lt.${soglia24h}`)
    .order('ig_check_il', { ascending: true, nullsFirst: true })
    .limit(10)
  if (igErr) {
    if (!schemaAssente(igErr)) return queryFallita('lettura instagram', igErr, t0)
  } else {
    for (const ig of (igPosts ?? []) as { id: string; instagram_url: string | null; instagram_shortcode: string | null; ig_check_falliti: number | null }[]) {
      const shortcode = ig.instagram_shortcode ?? parseInstagramUrl(ig.instagram_url ?? '')
      if (!shortcode) continue
      const r = await externalFetch('instagram', buildEmbedUrl(shortcode), { method: 'GET' }, { evento: 'news', campi: { operazione: 'ig-health' }, gravita: () => 'info' })
      const esito = esitoHealthCheck(await corpoDaFetch(r), r.stato)
      if (esito === 'fallito') {
        const falliti = (ig.ig_check_falliti ?? 0) + 1
        const upd: Record<string, unknown> = { ig_check_falliti: falliti, ig_check_il: nowIso }
        if (falliti >= 2) {
          // 2 fallimenti CONSECUTIVI: si nasconde (probabile post rimosso/privato).
          upd.stato = 'nascosta'
          upd.nascosta_motivo = 'instagram-non-raggiungibile'
        }
        // PostgREST non lancia: si controlla l'{error} anche se l'health-check è best-effort
        // (regola 7). Se l'UPDATE fallisce, ig_check_il non avanza → recuperabile al tick dopo.
        const { error: updErr } = await supabase.from('news_posts').update(upd).eq('id', ig.id)
        if (updErr) logEvento('news', 'warn', { operazione: 'news/cron:ig-health', esito: 'ig-update-fallita', post_id: ig.id }, updErr)
        else if (falliti >= 2) {
          logEvento('news', 'warn', { operazione: 'news/cron:ig-health', esito: 'nascosto', post_id: ig.id })
        }
      } else if (esito === 'ok') {
        // Embed realmente renderizzato: azzera il contatore dei fallimenti.
        const { error: updErr } = await supabase.from('news_posts').update({ ig_check_falliti: 0, ig_check_il: nowIso }).eq('id', ig.id)
        if (updErr) logEvento('news', 'warn', { operazione: 'news/cron:ig-health', esito: 'ig-update-fallita', post_id: ig.id }, updErr)
      } else {
        // Indeterminato (interstiziale consent 200 / 429 / 403 / 5xx): SOLO il timestamp di
        // controllo, mai il contatore. È il caso NORMALE server-side (auto-nascondimento best-effort).
        const { error: updErr } = await supabase.from('news_posts').update({ ig_check_il: nowIso }).eq('id', ig.id)
        if (updErr) logEvento('news', 'warn', { operazione: 'news/cron:ig-health', esito: 'ig-update-fallita', post_id: ig.id }, updErr)
      }
    }
  }

  logEvento('cron', 'info', { operazione: JOB, esito: 'ok', azione: 'tick', ms: Date.now() - t0, msg: `${JOB}: ok` })
  return NextResponse.json({ success: true })
}

// ── Job «digest» ────────────────────────────────────────────────────────────────
async function eseguiDigest(supabase: SupabaseClient, t0: number): Promise<NextResponse> {
  const now = new Date()
  // Mese PRECEDENTE: getUTCMonth() (0-based del mese corrente) è già il mese
  // precedente in 1-based, tranne gennaio → dicembre dell'anno prima.
  let mese = now.getUTCMonth()
  let anno = now.getUTCFullYear()
  if (mese === 0) {
    mese = 12
    anno -= 1
  }
  const { edizioni } = await generaEInviaDigest(supabase, { anno, mese })
  logEvento('cron', 'info', { operazione: JOB, esito: 'ok', azione: 'digest', anno, mese, edizioni: edizioni.length, ms: Date.now() - t0, msg: `${JOB}: ok` })
  return NextResponse.json({ success: true, anno, mese, edizioni })
}

export const POST = withRoute('news/cron/run:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      // Si grida SOLO se l'header c'è ma non torna (cron con la chiave sbagliata):
      // sul POST anonimo si tace (route pubblica, un `curl` non deve fabbricare rumore).
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET ? `${JOB}: x-cron-secret non corrispondente` : `${JOB}: CRON_SECRET non configurato`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    if (b.data.job === 'digest') return await eseguiDigest(supabase, t0)
    return await eseguiTick(supabase, t0)
  } catch (err) {
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
