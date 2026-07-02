import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { loadResolveOptions, DEFAULT_SCUOLA } from '@/lib/mensa/server'
import { controllaAllergie } from '@/lib/mensa/allergie-check'
import type { ResolveOptions } from '@/lib/mensa/resolveMenu'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zDataYMD } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// '' è ammesso per retro-compatibilità: ?data= (vuoto) equivale ad assente.
// Default dinamico (oggi) calcolato nell'handler.
const postQuerySchema = z.object({
  data: zDataYMD.or(z.literal('')).optional(),
})

// Body opzionale { data? }: letto solo se il query param è assente. Il body può
// mancare del tutto (il cron chiama senza body), quindi JSON assente/malformato
// resta tollerato come prima; se il JSON c'è, il campo `data` viene validato.
const postBodySchema = z.object({
  data: zDataYMD.nullish(),
})

interface AlunnoRow {
  id: string
  nome: string
  cognome: string
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
  allergies: string | null
  allergeni: string[] | null
}

// POST /api/mensa/allergie-check
//   Job giornaliero: per ogni prenotazione attiva di `data` (default: oggi),
//   verifica i conflitti allergia↔menu e avvisa segreteria/cuoca/insegnanti.
//   Auth: header `x-cron-secret` (chiamata dal cron) OPPURE staff (manuale).
//   Idempotente per (alunno, data) grazie al dedup in notificaAllergie.
export async function POST(request: Request) {
  try {
    const secret = request.headers.get('x-cron-secret')
    const isCron = !!secret && secret === process.env.CRON_SECRET
    if (!isCron) {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response
    }

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    let data: string | null = q.data.data || null
    if (!data) {
      let raw: unknown = null
      try { raw = await request.json() } catch { raw = null }
      if (raw !== null && raw !== undefined) {
        const b = parseData(postBodySchema, raw)
        if ('response' in b) return b.response
        data = b.data.data ?? null
      }
    }
    data = data ?? new Date().toISOString().slice(0, 10)

    const supabase = await createAdminClient()

    // prenotazioni attive per la data
    const { data: pren } = await supabase
      .from('mensa_prenotazioni')
      .select('alunno_id')
      .eq('data', data)
      .eq('stato', 'prenotato')
    const ids = [...new Set((pren ?? []).map(p => p.alunno_id as string))]
    if (ids.length === 0) {
      return NextResponse.json({ success: true, data: { data, prenotati: 0, alert: 0 } })
    }

    // anagrafica + allergie dei prenotati
    const { data: alunni } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, section_id, scuola_id, allergies, allergeni')
      .in('id', ids)
    const rows = (alunni ?? []) as AlunnoRow[]

    // opzioni menu per scuola (cache per evitare riletture)
    const optsCache = new Map<string, ResolveOptions>()
    let alert = 0
    for (const a of rows) {
      const scuolaId = a.scuola_id ?? DEFAULT_SCUOLA
      let opts = optsCache.get(scuolaId)
      if (!opts) { opts = await loadResolveOptions(supabase, scuolaId); optsCache.set(scuolaId, opts) }
      const inviata = await controllaAllergie(supabase, a, data, scuolaId, opts)
      if (inviata) alert++
    }

    return NextResponse.json({ success: true, data: { data, prenotati: rows.length, alert } })
  } catch (err) {
    console.error('Errore API POST mensa/allergie-check:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
