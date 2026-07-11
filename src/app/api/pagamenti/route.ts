import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive, assertAlunnoInScope } from '@/lib/auth/scope'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Uuid opzionale da query string: stringa vuota trattata come assente
// (preserva i check truthy `if (alunnoId)` pre-esistenti).
const zUuidQueryOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  zUuid.optional()
)

// Filtri del ramo staff (il ramo genitore li ignora, come oggi).
const getQuerySchema = z.object({
  alunno_id: zUuidQueryOpzionale,
  stato: z.string().optional(),
  categoria_id: zUuidQueryOpzionale,
  scuola_id: zUuidQueryOpzionale,
  gruppo: z.string().optional(),
  periodo: z.string().optional(),
  scadenza_da: z.string().optional(),
  scadenza_a: z.string().optional(),
  fattura_stato: z.enum(['non_richiesta', 'in_attesa', 'emessa', 'scartata']).or(z.literal('')).optional(),
  solo_aperti: z.enum(['true', 'false']).optional(),
})

const postBodySchema = z.object({
  alunno_id: zUuid,
  descrizione: z.string().min(1, 'alunno_id, descrizione, importo e scadenza sono obbligatori'),
  // numero o stringa numerica (Postgres casta la stringa); il vincolo > 0 resta il check sotto
  importo: z.union([z.number(), z.string()], {
    error: 'alunno_id, descrizione, importo e scadenza sono obbligatori',
  }),
  scadenza: z.string().min(1, 'alunno_id, descrizione, importo e scadenza sono obbligatori'),
  scuola_id: z.string().nullish(), // assente/vuota → derivata dall'alunno (come oggi)
  categoria_id: zUuid.nullish(),
  tipo: z.string().nullish(), // default 'singolo' applicato nel codice
  obbligatorio: z.boolean().nullish(), // default true applicato nel codice
  periodo_competenza: z.string().nullish(),
  gruppo: z.string().nullish(),
})

const SELECT = `
  id, alunno_id, scuola_id, descrizione, importo, importo_pagato, scadenza, stato,
  tipo, obbligatorio, categoria_id, parent_payment_id, gruppo, periodo_competenza,
  fattura_stato, fattura_pdf_path, fattura_aruba_id, fattura_emessa_il,
  data_incasso, ultimo_sollecito_il, creato_il, aggiornato_il,
  payment_categories ( id, nome, slug, colore, icona ),
  alunni ( id, nome, cognome, classe_sezione, sospeso )
`

// GET /api/pagamenti
//   staff  -> tutti i pagamenti (filtri: alunno_id, stato, categoria_id, scuola_id, gruppo, periodo)
//   parent -> solo i pagamenti dei propri figli; per gli split, solo se ha una quota
// Query: ?userId=<id> (modello auth app-level) + filtri opzionali
export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const supabase = await createAdminClient()

    let query = supabase.from('pagamenti').select(SELECT).order('scadenza', { ascending: false })

    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'

    if (isStaff) {
      // I filtri sono validati solo nel ramo staff: il ramo genitore li ignora (come oggi).
      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response
      const { alunno_id: alunnoId, stato, categoria_id: categoriaId, scuola_id: scuolaId, gruppo, periodo } = q.data
      // Scoping multi-tenant: limita SEMPRE ai plessi accessibili; lo scuola_id
      // del client serve solo a restringere DENTRO quell'insieme, mai ad allargarlo.
      const sediAttive = await resolveScuoleAttive(request, supabase, user)
      query = query.in('scuola_id', sediAttive)
      if (alunnoId) query = query.eq('alunno_id', alunnoId)
      if (stato) query = query.eq('stato', stato)
      if (categoriaId) query = query.eq('categoria_id', categoriaId)
      if (scuolaId && sediAttive.includes(scuolaId)) query = query.eq('scuola_id', scuolaId)
      if (gruppo) query = query.eq('gruppo', gruppo)
      if (periodo) query = query.eq('periodo_competenza', periodo)
      if (q.data.scadenza_da) query = query.gte('scadenza', q.data.scadenza_da)
      if (q.data.scadenza_a) query = query.lte('scadenza', q.data.scadenza_a)
      if (q.data.fattura_stato) query = query.eq('fattura_stato', q.data.fattura_stato)
      if (q.data.solo_aperti === 'true') query = query.in('stato', ['da_pagare', 'parziale', 'scaduto'])
    } else {
      // genitore: solo i propri figli
      const { data: legami } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
      const figli = (legami || []).map((l) => l.alunno_id)
      if (figli.length === 0) return NextResponse.json({ success: true, data: [] })
      query = query.in('alunno_id', figli)
      // visibilità ritardata: nasconde i pagamenti non ancora "pubblicati" (es. retta del mese futuro)
      const oggi = new Date().toISOString().slice(0, 10)
      query = query.or(`visibile_dal.is.null,visibile_dal.lte.${oggi}`)
    }

    const { data, error } = await query
    if (error) {
      console.error('Errore GET pagamenti:', error)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti', details: error.message }, { status: 500 })
    }

    let rows = data || []

    // Proiezione lato genitore: nasconde i container rateali (padre); le rate
    // figlie (tipo='rata') restano visibili come voci separate con la propria scadenza.
    if (user.role === 'genitore') {
      rows = rows.filter((r) => r.tipo !== 'padre')
      const splitIds = rows.filter((r) => r.tipo === 'split').map((r) => r.id)
      const quoteByPagamento: Record<string, { importo: number; quota_id: string } | undefined> = {}
      if (splitIds.length > 0) {
        const { data: quote } = await supabase
          .from('pagamenti_quote')
          .select('id, pagamento_id, importo')
          .in('pagamento_id', splitIds)
          .eq('adult_id', user.id)
        for (const q of quote || []) {
          quoteByPagamento[q.pagamento_id] = { importo: Number(q.importo), quota_id: q.id }
        }
      }
      rows = rows
        .filter((r) => r.tipo !== 'split' || quoteByPagamento[r.id]) // nasconde split senza propria quota
        .map((r) => {
          if (r.tipo === 'split' && quoteByPagamento[r.id]) {
            const q = quoteByPagamento[r.id]!
            return { ...r, importo: q.importo, quota_id: q.quota_id, importo_totale_famiglia: r.importo }
          }
          return r
        })
    }

    return NextResponse.json({ success: true, data: rows })
  } catch (err) {
    console.error('Errore API GET pagamenti:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti  (staff) — crea un pagamento singolo
// Body: { userId, alunno_id, scuola_id?, descrizione, importo, scadenza, categoria_id?,
//         tipo?, obbligatorio?, periodo_competenza?, gruppo? }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { alunno_id, descrizione, importo, scadenza } = body

    if (Number(importo) <= 0) {
      return NextResponse.json({ error: 'importo deve essere maggiore di 0' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // L'alunno deve essere nel plesso dello staff (403/404 altrimenti).
    const scopeErr = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scopeErr) return scopeErr

    // scuola_id SEMPRE derivata dall'alunno: lo scuola_id del client viene ignorato.
    const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
    if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    const scuolaId = al.scuola_id

    const record: Record<string, unknown> = {
      alunno_id,
      scuola_id: scuolaId,
      descrizione,
      importo,
      scadenza,
      categoria_id: body.categoria_id ?? null,
      tipo: body.tipo ?? 'singolo',
      obbligatorio: body.obbligatorio ?? true,
      periodo_competenza: body.periodo_competenza ?? null,
      gruppo: body.gruppo ?? null,
      creato_da: user.id,
      stato: 'da_pagare',
    }

    const { data, error } = await supabase.from('pagamenti').insert(record).select(SELECT).single()
    if (error) {
      console.error('Errore POST pagamenti:', error)
      return NextResponse.json({ error: 'Errore nella creazione del pagamento', details: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST pagamenti:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
