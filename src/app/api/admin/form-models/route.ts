import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { esitoScopeModello } from '@/lib/forms/scope-modello'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// POST — sostituisce il 400 manuale 'title e schema sono obbligatori'.
// `schema` è il JSON libero del Form Builder: oggi basta che sia truthy.
// I campi con fallback nel codice (`?? false`, confronto === 'joint')
// restano liberi: oggi accettano qualunque valore.
const postBodySchema = z.object({
  title: z.string().min(1, 'title obbligatorio'),
  schema: z.unknown().refine((v) => Boolean(v), 'schema obbligatorio'),
  description: z.unknown().optional(),
  is_active: z.unknown().optional(),
  requires_signature: z.unknown().optional(),
  signature_mode: z.unknown().optional(),
  // Flag «essenziale: sempre firmabile» (salute/sicurezza) — firmabile anche da
  // genitore sospeso. Best-effort: assente sul DB non migrato (PGRST204) → si omette.
  sempre_firmabile: z.unknown().optional(),
  // Sede a cui il modello e' destinato. `null`/assente = vale per TUTTE le sedi
  // (comportamento storico dei 6 modelli gia' esistenti). Il valore e' comunque
  // ri-validato server-side contro le sedi accessibili: sceglierne una altrui
  // dal client non funziona.
  scuola_id: z.string().nullish(),
})

// Colonna nuova assente sul DB E2E CI non migrato.
const COLONNA_NUOVA_ASSENTE = new Set(['PGRST204', '42703'])

// PATCH — ALLOWLIST esplicita, mai `.loose()`.
//
// Fino al 2026-07-31 lo schema era `z.object({ id }).loose()` e l'handler faceva
// `const { id, ...updates }` → `.update({ ...updates })`: OGNI colonna della
// tabella era scrivibile dal client. Comprese `scuola_id` — la chiave di
// tenancy, che PR #60 aveva appena introdotto e che così si poteva ripuntare a
// un altro plesso o azzerare (rendendo globale un modello di sede) —,
// `public_token` (la capability che apre `/m/{token}` senza credenziali),
// `published_at` e `is_enrollment_form` (cioè QUALE modello è il modulo
// d'iscrizione). Quelle quattro non stanno qui dentro di proposito: la sede si
// dichiara alla creazione (POST, già ri-validata contro le sedi accessibili) e
// la pubblicazione ha la sua route dedicata.
// `id` resta stringa libera come il truthy check odierno (nei test circolano id
// non-UUID tipo 'm-1'). NB zod v4: `z.unknown()` nudo rende la chiave
// obbligatoria → sempre `.optional()`.
const patchBodySchema = z.object({
  id: z.string().min(1, 'id obbligatorio'),
  title: z.unknown().optional(),
  description: z.unknown().optional(),
  schema: z.unknown().optional(),
  is_active: z.unknown().optional(),
  requires_signature: z.unknown().optional(),
  signature_mode: z.unknown().optional(),
  sempre_firmabile: z.unknown().optional(),
})

// POST: crea un nuovo modello form (bypassa RLS via service-role)
export const POST = withRoute('admin/form-models:POST', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  try {
    const { title, schema, is_active, requires_signature, description, signature_mode, sempre_firmabile, scuola_id } = b.data

    const supabase = await createAdminClient()

    // La sede scelta nel costruttore vale solo se e' fra quelle accessibili:
    // altrimenti si ricadrebbe su un modello pubblicato su un plesso altrui
    // semplicemente manomettendo il body. `null` resta lecito e significa
    // «tutte le sedi».
    const accessibili = await scuoleDiUtente(supabase, auth.user)
    const sedeModello = typeof scuola_id === 'string' && accessibili.includes(scuola_id)
      ? scuola_id
      : null

    const base = {
      title,
      description: description ?? null,
      schema,
      is_active: is_active ?? false,
      requires_signature: requires_signature ?? false,
      signature_mode: signature_mode === 'joint' ? 'joint' : 'single',
      scuola_id: sedeModello,
    }
    let res = await supabase
      .from('form_models')
      .insert({ ...base, sempre_firmabile: sempre_firmabile === true })
      .select()
      .single()
    // DB non migrato: riprova togliendo le colonne recenti. Prima `sempre_firmabile`,
    // poi anche `scuola_id` — sul DB E2E della CI mancano entrambe, e un solo
    // tentativo lasciava fallire l'insert per la seconda.
    if (res.error && COLONNA_NUOVA_ASSENTE.has(res.error.code ?? '')) {
      res = await supabase.from('form_models').insert(base).select().single()
    }
    if (res.error && COLONNA_NUOVA_ASSENTE.has(res.error.code ?? '')) {
      const { scuola_id: _sede, ...senzaSede } = base
      void _sede
      res = await supabase.from('form_models').insert(senzaSede).select().single()
    }

    if (res.error) {
      return NextResponse.json({ error: res.error.message }, { status: 500 })
    }

    return NextResponse.json(res.data, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/form-models:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})

// PATCH: aggiorna un modello form esistente
export const PATCH = withRoute('admin/form-models:PATCH', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, patchBodySchema)
  if ('response' in b) return b.response
  try {
    const { id, ...campi } = b.data
    // Solo le chiavi realmente presenti nel body: `undefined` finirebbe
    // nell'UPDATE come «azzera la colonna».
    const updates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(campi)) {
      if (v !== undefined) updates[k] = v
    }

    const supabase = await createAdminClient()

    // Gate di tenant sull'OGGETTO scritto: il modello di un'altra sede non è
    // modificabile (404), quello globale solo da chi ha in scope tutte le sedi
    // reali (403). Vedi `@/lib/forms/scope-modello`.
    // `scuola_id` non esiste sul DB E2E della CI (non migrato): la lettura si
    // ripete senza la colonna e la riga arriva SENZA la chiave — il gate applica
    // allora il degrado (lecito solo se non c'è niente da isolare).
    // Due `select()` distinti e non un ternario dentro `select()`: il client
    // Supabase tipizza quella stringa come LETTERALE e su un'unione risponde con
    // un `ParserError` al posto del tipo della riga.
    const caricaModello = async (conSede: boolean) => {
      const res = conSede
        ? await supabase.from('form_models').select('id, scuola_id').eq('id', id).maybeSingle()
        : await supabase.from('form_models').select('id').eq('id', id).maybeSingle()
      return { data: res.data as { id: string; scuola_id?: string | null } | null, error: res.error }
    }
    let caricato = await caricaModello(true)
    if (COLONNA_NUOVA_ASSENTE.has(caricato.error?.code ?? '')) caricato = await caricaModello(false)
    const { data: modello, error: erroreLettura } = caricato
    if (erroreLettura) {
      // PostgREST non lancia: un guasto di lettura non deve diventare «nessun
      // controllo di sede».
      logEvento('modulistica', 'error', {
        operazione: 'admin/form-models:PATCH', esito: 'modello-non-letto',
      }, erroreLettura)
      return NextResponse.json({ error: erroreLettura.message }, { status: 500 })
    }
    const negato = await esitoScopeModello(supabase, auth.user, modello, {
      operazione: 'admin/form-models:PATCH', perScrittura: true,
    })
    if (negato) return negato

    let res = await supabase
      .from('form_models')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    // DB non migrato: se la PATCH portava `sempre_firmabile` e la colonna manca,
    // riprova senza — gli altri campi devono comunque salvarsi.
    if (res.error && COLONNA_NUOVA_ASSENTE.has(res.error.code ?? '') && 'sempre_firmabile' in updates) {
      const rest = { ...updates } as Record<string, unknown>
      delete rest.sempre_firmabile
      res = await supabase
        .from('form_models')
        .update({ ...rest, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single()
    }

    if (res.error) {
      return NextResponse.json({ error: res.error.message }, { status: 500 })
    }

    return NextResponse.json(res.data)
  } catch (err) {
    logErrore({ operazione: 'admin/form-models:PATCH', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
