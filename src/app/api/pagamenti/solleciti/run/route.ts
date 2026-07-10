import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sollecitaPagamenti } from '@/lib/pagamenti/solleciti-invio'
import type { SollecitiConfig } from '@/lib/pagamenti/solleciti'

// Corpo vuoto ammesso: la route è service-to-service (zod per il lock di copertura).
const bodySchema = z.object({}).passthrough().optional()

// POST /api/pagamenti/solleciti/run — giro automatico dei solleciti.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret` (pattern fattura/sync).
// Sostituisce integralmente la vecchia genera_solleciti() SQL (deprecata,
// mai schedulata): prima aggiorna gli stati `scaduto`, poi invia i solleciti
// SOLO per le scuole con solleciti_config.enabled (default off), livelli 1-2
// (il 3° resta manuale), pagamenti obbligatori.
export async function POST(request: Request) {
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    // il body, se presente, non è usato: validato solo per coerenza
    bodySchema.parse(await request.json().catch(() => ({})))

    const supabase = await createAdminClient()
    const oggi = new Date().toISOString().slice(0, 10)

    // 1) refresh stati: gli aperti oltre scadenza diventano `scaduto`
    await supabase
      .from('pagamenti')
      .update({ stato: 'scaduto' })
      .in('stato', ['da_pagare', 'parziale'])
      .lt('scadenza', oggi)

    // 2) scuole con invio automatico attivo
    const { data: settingsRows, error } = await supabase
      .from('admin_settings')
      .select('scuola_id, solleciti_config')
    if (error) {
      // colonna assente (DB non migrato): niente da fare, mai crash
      return NextResponse.json({ success: true, inviati: 0, disponibile: false })
    }
    const abilitate = ((settingsRows || []) as { scuola_id: string; solleciti_config?: SollecitiConfig | null }[])
      .filter((r) => r.solleciti_config?.enabled)
      .map((r) => r.scuola_id)
    if (abilitate.length === 0) {
      return NextResponse.json({ success: true, inviati: 0 })
    }

    // 3) candidati: aperti oltre scadenza, obbligatori, niente contenitori padre
    const { data: candidati } = await supabase
      .from('pagamenti')
      .select('id')
      .in('scuola_id', abilitate)
      .in('stato', ['da_pagare', 'parziale', 'scaduto'])
      .lt('scadenza', oggi)
      .neq('tipo', 'padre')
      .eq('obbligatorio', true)
      .limit(500)
    const ids = ((candidati || []) as { id: string }[]).map((c) => c.id)
    if (ids.length === 0) return NextResponse.json({ success: true, inviati: 0 })

    const esiti = await sollecitaPagamenti(supabase, ids, { automatico: true })
    const inviati = esiti.filter((e) => e.ok).length
    return NextResponse.json({ success: true, inviati, esaminati: ids.length })
  } catch (err) {
    console.error('Errore API solleciti/run:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
