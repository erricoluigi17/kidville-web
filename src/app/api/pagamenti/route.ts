import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive, assertAlunnoInScope } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { residuoEffettivo, statoEffettivo } from '@/lib/pagamenti/aging'
import { getModuleConfig } from '@/lib/settings/module-config'
import { renderCausale, DEFAULT_CAUSALE_TEMPLATE } from '@/lib/pagamenti/causale'
import { meseAnnoDaPeriodo } from '@/lib/pagamenti/periodo'
import { formatEuro } from '@/lib/format/valuta'
import { isoToIt } from '@/lib/format/data'

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
  alunni ( id, nome, cognome, codice_fiscale, classe_sezione, sospeso )
`

// SELECT del GET con le colonne Contabilità v2 (sconto/sconto_motivo). Sul DB
// E2E CI (non migrato) queste colonne non esistono → 42703, gestito con retry
// sul SELECT base (stesso pattern di genera-rette/route.ts).
const SELECT_GET = SELECT.replace(
  'importo, importo_pagato, scadenza, stato,',
  'importo, importo_pagato, sconto, sconto_motivo, scadenza, stato,',
)

// Riga grezza del GET. Il SELECT è passato come `string` (retry con/senza sconto),
// quindi supabase non ne inferisce la forma: la fissiamo qui (index signature per
// i campi non elencati, es. quota_id aggiunto lato genitore).
type PagamentoGetRow = {
  id: string
  alunno_id: string
  scuola_id: string
  importo: number | string
  importo_pagato: number | string | null
  sconto?: number | string | null
  scadenza: string | null
  stato: string
  tipo: string | null
  [k: string]: unknown
}

// GET /api/pagamenti
//   staff  -> tutti i pagamenti (filtri: alunno_id, stato, categoria_id, scuola_id, gruppo, periodo)
//   parent -> solo i pagamenti dei propri figli; per gli split, solo se ha una quota
// Query: ?userId=<id> (modello auth app-level) + filtri opzionali
export const GET = withRoute('pagamenti:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const supabase = await createAdminClient()

    const oggi = new Date().toISOString().slice(0, 10)
    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'

    // Input dei filtri risolti UNA volta (parsing + scoping/legami async), poi la
    // catena di filtri è sincrona e riapplicabile per il retry senza sconto.
    let qData: z.infer<typeof getQuerySchema> | null = null
    let sediAttive: string[] = []
    let figli: string[] | null = null

    if (isStaff) {
      // I filtri sono validati solo nel ramo staff: il ramo genitore li ignora (come oggi).
      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response
      qData = q.data
      // Scoping multi-tenant: limita SEMPRE ai plessi accessibili; lo scuola_id
      // del client serve solo a restringere DENTRO quell'insieme, mai ad allargarlo.
      sediAttive = await resolveScuoleAttive(request, supabase, user)
    } else {
      // genitore: solo i propri figli
      const { data: legami } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
      figli = (legami || []).map((l) => l.alunno_id)
      if (figli.length === 0) return NextResponse.json({ success: true, data: [] })
    }

    // Costruttore della query parametrizzato sul SELECT: il ramo di retry lo
    // richiama con il SELECT base quando il DB non ha le colonne Contabilità v2.
    const costruisci = (select: string) => {
      let query = supabase.from('pagamenti').select(select).order('scadenza', { ascending: false })
      if (isStaff && qData) {
        const { alunno_id: alunnoId, stato, categoria_id: categoriaId, scuola_id: scuolaId, gruppo, periodo } = qData
        query = query.in('scuola_id', sediAttive)
        if (alunnoId) query = query.eq('alunno_id', alunnoId)
        if (stato) query = query.eq('stato', stato)
        if (categoriaId) query = query.eq('categoria_id', categoriaId)
        if (scuolaId && sediAttive.includes(scuolaId)) query = query.eq('scuola_id', scuolaId)
        if (gruppo) query = query.eq('gruppo', gruppo)
        if (periodo) query = query.eq('periodo_competenza', periodo)
        if (qData.scadenza_da) query = query.gte('scadenza', qData.scadenza_da)
        if (qData.scadenza_a) query = query.lte('scadenza', qData.scadenza_a)
        if (qData.fattura_stato) query = query.eq('fattura_stato', qData.fattura_stato)
        if (qData.solo_aperti === 'true') query = query.in('stato', ['da_pagare', 'parziale', 'scaduto'])
      } else if (figli) {
        query = query.in('alunno_id', figli)
        // visibilità ritardata: nasconde i pagamenti non ancora "pubblicati" (es. retta del mese futuro)
        query = query.or(`visibile_dal.is.null,visibile_dal.lte.${oggi}`)
      }
      return query
    }

    let { data, error } = await costruisci(SELECT_GET)
    // DB E2E CI non migrato: sconto/sconto_motivo assenti → 42703, ritenta senza.
    if (error && (error as { code?: string }).code === '42703') {
      const retry = await costruisci(SELECT)
      data = retry.data
      error = retry.error
    }
    if (error) {
      // PostgREST non lancia: il catch qui sotto non scatterebbe mai. La riga di errore
      // (con lo stack e la marca anti-doppione per `withRoute`) va emessa qui.
      logErrore({ operazione: 'pagamenti:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti', details: error.message }, { status: 500 })
    }

    let rows = (data ?? []) as unknown as PagamentoGetRow[]

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

    // Campi derivati (fonte unica aging.ts): stato/residuo calcolati SEMPRE dalle
    // date, così client web e app leggono lo stesso valore del server. `sconto` è
    // assente sui DB non migrati (retry sopra) → residuoEffettivo lo tratta come 0.
    // Il cast ripristina l'index signature di PagamentoGetRow che lo spread perde:
    // sotto si leggono descrizione/periodo_competenza/payment_categories/alunni (→ unknown, poi cast).
    const rowsArricchite = rows.map((r) => ({
      ...r,
      residuo: residuoEffettivo(r),
      stato_effettivo: statoEffettivo(r, oggi),
    })) as (PagamentoGetRow & { residuo: number; stato_effettivo: string })[]

    // Nome sede per la causale consigliata del bonifico (best-effort): risolve
    // scuola_id → nome da `scuole`. Se fallisce, la causale resta senza sede (ha
    // comunque descrizione + nome + CF). Una sola query batch sulle sedi distinte.
    const scuolaIds = [...new Set(rowsArricchite.map((r) => r.scuola_id).filter(Boolean))]
    let nomiSedi: Record<string, string> = {}
    if (scuolaIds.length > 0) {
      const { data: sedi, error: errSedi } = await supabase.from('scuole').select('id, nome').in('id', scuolaIds)
      if (errSedi) logErrore({ operazione: 'pagamenti:GET', evento: 'sedi_nome' }, errSedi)
      else nomiSedi = Object.fromEntries(((sedi ?? []) as { id: string; nome: string | null }[]).map((s) => [s.id, s.nome ?? '']))
    }

    // Modelli di causale per-categoria (per-scuola): un JSONB indicizzato per slug,
    // con eventuale `default`. `getModuleConfig` degrada da solo (config assente o
    // colonna mancante sul DB E2E CI → `{}`, quindi si ricade sul predefinito) e
    // non solleva: qui non serve altro rumore. Una sola lettura per sede distinta.
    const causaliBySede: Record<string, Partial<Record<string, string>>> = {}
    for (const sid of scuolaIds) {
      causaliBySede[sid] = await getModuleConfig<Record<string, string>>(supabase, 'causali_config', sid)
    }

    return NextResponse.json({
      success: true,
      data: rowsArricchite.map((r) => {
        const sede = nomiSedi[r.scuola_id] ?? null
        // Causale consigliata: modello della categoria (per slug) → `default` → predefinito.
        const cfg = causaliBySede[r.scuola_id] ?? {}
        const cat = r.payment_categories as { slug?: string | null } | null | undefined
        const slug = cat?.slug ?? undefined
        const template = (slug ? cfg[slug] : undefined) ?? cfg.default ?? DEFAULT_CAUSALE_TEMPLATE
        const al = r.alunni as { nome?: string | null; cognome?: string | null; codice_fiscale?: string | null } | null | undefined
        const { mese, anno } = meseAnnoDaPeriodo(r.periodo_competenza as string | null)
        const causale_suggerita = renderCausale(template, {
          descrizione: r.descrizione as string | null,
          nome: al?.nome,
          cognome: al?.cognome,
          codiceFiscale: al?.codice_fiscale,
          sede,
          mese,
          anno,
          importo: formatEuro(r.importo),
          scadenza: isoToIt((r.scadenza as string | null) ?? ''),
        })
        return { ...r, scuola_nome: sede, causale_suggerita }
      }),
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti  (staff) — crea un pagamento singolo
// Body: { userId, alunno_id, scuola_id?, descrizione, importo, scadenza, categoria_id?,
//         tipo?, obbligatorio?, periodo_competenza?, gruppo? }
export const POST = withRoute('pagamenti:POST', async (request: Request) => {
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
      logErrore({ operazione: 'pagamenti:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nella creazione del pagamento', details: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
