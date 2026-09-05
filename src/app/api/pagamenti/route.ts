import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "agisceComeGenitore" export is defined on the mock`.
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive, assertAlunnoInScope } from '@/lib/auth/scope'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { residuoEffettivo, statoEffettivo } from '@/lib/pagamenti/aging'
import { getModuleConfig } from '@/lib/settings/module-config'
import { renderCausale, modelloCausale, DEFAULT_CAUSALE_TEMPLATE } from '@/lib/pagamenti/causale'
// Le coordinate del bonifico si compongono in UN posto solo (lo usa anche il
// motore dei solleciti): la pagina e l'email devono dire lo stesso IBAN e lo
// stesso intestatario. Lock: `coordinate-bonifico-un-motore-solo`.
import { coordinateBonificoSede } from '@/lib/pagamenti/coordinate-bonifico'
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

/**
 * Questa risposta non si mette in cache, e da quando porta le coordinate del
 * bonifico la ragione è doppia: dentro ci sono le voci di pagamento dei figli di
 * UNA famiglia (importi, scadenze, nome e codice fiscale del minore dentro la
 * causale) e l'IBAN su cui quella famiglia sta per mandare i soldi. `private`
 * tiene fuori ogni cache condivisa — CDN, proxy — e `no-store` impedisce anche al
 * browser di lasciarne una copia sul disco: su un telefono di famiglia la
 * schermata successiva può guardarla un'altra persona.
 *
 * Sta su TUTTE le uscite del GET, non solo su quella piena: un'intestazione che
 * dipende da quanto c'è nel corpo è una regola che nessuno riesce a ricordare.
 */
const SENZA_CACHE = { 'Cache-Control': 'private, no-store' } as const

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
      // genitore: solo i propri figli. Unione runtime (`legame_genitori_alunni`)
      // + anagrafica (`student_parents` via ponte `parents.auth_user_id`): con la
      // sola tabella runtime i genitori arrivati dall'import iscrizioni vedevano
      // una lista vuota — nessuna retta, nessuna scadenza, nessun sollecito.
      figli = await getFigliDiGenitore(supabase, user.id)
      // `sedi: []` anche qui: la forma della risposta non può dipendere da
      // QUANTO c'è dentro. Senza, la card «Come pagare» riceverebbe `undefined`
      // proprio nel caso in cui non ha niente da mostrare, e il componente
      // andrebbe scritto per due risposte diverse invece che per una.
      if (figli.length === 0) return NextResponse.json({ success: true, data: [], sedi: [] }, { headers: SENZA_CACHE })
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
      return NextResponse.json(
        { error: 'Errore nel recupero dei pagamenti', details: error.message },
        { status: 500, headers: SENZA_CACHE },
      )
    }

    let rows = (data ?? []) as unknown as PagamentoGetRow[]

    // Proiezione lato genitore: nasconde i container rateali (padre); le rate
    // figlie (tipo='rata') restano visibili come voci separate con la propria scadenza.
    // PRESENTAZIONE: è una PROIEZIONE della schermata, non un permesso — nasconde i
    // container rateali e mostra la propria quota. Chi guarda in veste di lavoro
    // deve continuare a vedere il prospetto intero, che è ciò che gli serve per
    // riconciliare: con `eFamiglia` a una docente-genitore verrebbe amputato.
    if (agisceComeGenitore(user)) {
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
    //
    // NB (audit 2026-07-31, segnalato due volte come «fail-open»): il
    // `if (scuolaIds.length > 0)` qui sotto NON è un filtro di tenancy. Gli uuid
    // arrivano dalle righe GIÀ filtrate (`.in('scuola_id', sediAttive)` per lo
    // staff, `.in('alunno_id', figli)` per il genitore) e servono solo a
    // tradurli in un nome; senza il guard il risultato sarebbe identico
    // (`.in('id', [])` ⇒ nessuna riga). Il perimetro è quello sopra, ed è
    // incondizionato — lo blocca `__tests__/api/pagamenti-scope-vuoto.test.ts`.
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
    //
    // Nello stesso giro escono le COORDINATE DEL BONIFICO della sede — IBAN e
    // intestatario — che vivono nella stessa riga di `admin_settings` e servono
    // alla stessa card: la causale dice cosa scrivere, queste due righe dicono
    // dove mandare i soldi e a chi. Le compone `coordinateBonificoSede`, lo
    // stesso motore che riempie il riquadro «Dati per il bonifico» dei
    // solleciti: due letture separate direbbero due IBAN diversi alla stessa
    // famiglia, e la divergenza si scoprirebbe solo a bonifico partito.
    //
    // Il perimetro resta quello delle righe già filtrate: nessuna sede in più.
    //
    // ⚠️ MA NON PER TUTTI I CHIAMANTI. Le coordinate esistono per la card «Come
    // pagare» del genitore. Questa stessa route serve anche il pannello dei
    // pagamenti aperti della segreteria (`?solo_aperti=true`), che riempie una
    // tabella di righe da incassare: lì l'IBAN non lo guarda nessuno, e ogni sede
    // in elenco costerebbe DUE letture in più di `admin_settings` — più le due
    // righe di log che ne conseguono, una al giorno per sede, su un percorso dove
    // non dicono niente a nessuno.
    //
    // La condizione è scritta come «quando NON servono» di proposito: un
    // chiamante non previsto — per esempio una docente che è anche genitore e sta
    // guardando in veste di lavoro — ricade nel comportamento generoso, non nel
    // vuoto. `sedi: []` significa quindi due cose diverse ma innocue per chi
    // legge la risposta — «nessuna sede in elenco» e «non le hai chieste» — e la
    // card sa già mostrare il ripiego in entrambi i casi: la forma della risposta
    // non cambia mai, che è la regola dichiarata al ritorno anticipato più su.
    const soloAperti = isStaff && qData?.solo_aperti === 'true'

    // Le letture di una sede vanno INSIEME: causale e coordinate abitano la
    // stessa riga di `admin_settings` e nessuna delle due dipende dall'altra. In
    // sequenza erano tre round-trip per sede, in fila uno dietro l'altro, su una
    // pagina che il genitore apre spesso.
    const perSede = await Promise.all(
      scuolaIds.map(async (sid) => {
        const [causali, coordinate] = await Promise.all([
          getModuleConfig<Record<string, string>>(supabase, 'causali_config', sid),
          soloAperti ? null : coordinateBonificoSede(supabase, sid, { operazione: 'pagamenti:GET' }),
        ])
        return { sid, causali, coordinate }
      }),
    )

    const causaliBySede: Record<string, Partial<Record<string, string>>> = {}
    const sedi: { id: string; nome: string; iban: string | null; intestatario: string | null }[] = []
    for (const { sid, causali, coordinate } of perSede) {
      causaliBySede[sid] = causali
      if (!coordinate) continue
      sedi.push({
        id: sid,
        nome: nomiSedi[sid] ?? '',
        iban: coordinate.iban,
        intestatario: coordinate.intestatario,
      })
    }

    // QUANTE VOLTE LA CARD È USCITA COL RIPIEGO. Senza questa riga, «l'IBAN manca
    // su due sedi su tre» è una cosa che si scopre solo aprendo l'app con
    // l'account di una famiglia: le righe per-sede del motore dicono CHE manca,
    // questa dice QUANTO pesa sul servito. Solo conteggi — nessun IBAN, nessun
    // nome di sede, nessun uuid di bambino — e `app_log` deduplica per giorno,
    // che è la granularità giusta per una domanda di questo tipo.
    //
    // ⚠️ I CAMPI NON POSSONO CHIAMARSI `sedi_con_iban`: `iban` è una radice
    // segreta di `redact()` e la corrispondenza è per CONTENIMENTO, quindi anche
    // un numero sotto quel nome esce `[redatto]` — la riga sarebbe uscita ogni
    // giorno senza dire l'unica cosa che ha da dire. `coordinate` descrive lo
    // stesso fatto e lascia la difesa sull'IBAN dov'è. Misurato dal test, non
    // dedotto.
    if (sedi.length > 0) {
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti:GET',
        esito: 'coordinate-bonifico',
        sedi_con_coordinate: sedi.filter((s) => s.iban !== null).length,
        sedi_senza_coordinate: sedi.filter((s) => s.iban === null).length,
      })
    }

    return NextResponse.json({
      success: true,
      sedi,
      data: rowsArricchite.map((r) => {
        const sede = nomiSedi[r.scuola_id] ?? null
        // Causale consigliata: modello della categoria (per slug) → `default` → predefinito.
        const cfg = causaliBySede[r.scuola_id] ?? {}
        const cat = r.payment_categories as { slug?: string | null } | null | undefined
        const slug = cat?.slug ?? undefined
        // La regola (categoria → «Predefinito» → modello di fabbrica) sta in
        // `modelloCausale`, un posto solo: la stessa causale la compone anche il
        // motore dei solleciti, e due copie che divergono mandano al genitore due
        // stringhe diverse per lo stesso pagamento.
        const template = modelloCausale(cfg, slug, DEFAULT_CAUSALE_TEMPLATE)
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
    }, { headers: SENZA_CACHE })
  } catch (err) {
    logErrore({ operazione: 'pagamenti:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500, headers: SENZA_CACHE })
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
