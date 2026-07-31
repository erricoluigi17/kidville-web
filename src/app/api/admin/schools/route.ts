import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { normalizzaScuola } from '@/lib/scuole/validate'
import { isUtenteCollaudo } from '@/lib/scuole/reali'
import { zAnagraficaSede, normalizzaAnagraficaSede } from '@/lib/scuole/anagrafica'
import {
  checklistSede,
  provisionaCorredoFallback,
  verificaCorredoSede,
} from '@/lib/scuole/corredo-sede'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Multi-Sede CRUD (DL-033). Riservato alla Direzione (admin/coordinator).
// Aggiungi / rinomina / disattiva (soft) + config isolata per sede. Service-role
// + scoping app + audit, coerente col resto del progetto.
//
// D1 — Provisioning reale (multi-sede): `schools` è il tenant REALE (tutte le FK
// scuola_id → schools), `scuole` è il registry anagrafico. Creare la sede solo in
// `scuole` (comportamento storico) la lasciava fantasma, invisibile al
// SedeSelector. Il POST ora provisiona in ENTRAMBI con lo stesso id (RPC
// `provisiona_sede`, o fallback client-side sul DB E2E) e collega gli admin.

const DIREZIONE = ['admin', 'coordinator'] as const

// Esito della RPC `provisiona_sede`. `{}` (né id né error) = RPC non disponibile
// (PGRST202 sul DB E2E non migrato, o client di test senza `.rpc`): il chiamante
// degrada al doppio insert. `{ error }` = errore reale da propagare.
type RpcProvision = { id?: string; error?: { message: string; code?: string } }

// Schema non migrato (DB E2E della CI): tabella/colonna assenti. PostgREST non
// lancia, ritorna `{ error }` — 42P01 relazione inesistente, 42703 colonna
// inesistente (SELECT), PGRST204 colonna assente su INSERT/UPDATE, PGRST205
// tabella fuori dal cache dello schema. Su questi si degrada; su tutto il resto
// si grida.
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

async function provisionaSedeViaRpc(
  supabase: { rpc?: unknown },
  args: { p_nome: string; p_citta: string | null; p_indirizzo: string | null; p_admin_ids: string[] },
): Promise<RpcProvision> {
  // Client di test minimale senza `.rpc`: degrade pulito al doppio insert.
  if (typeof supabase.rpc !== 'function') return {}
  const rpc = supabase.rpc as (fn: string, params: unknown) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>
  const { data, error } = await rpc('provisiona_sede', args)
  // PGRST202 = funzione non trovata (DB E2E non migrato) → degrade, non è un errore.
  if (error) return error.code === 'PGRST202' ? {} : { error }
  return { id: data as string }
}

type ClientAdmin = Awaited<ReturnType<typeof createAdminClient>>

/** Chi agganciare alla sede nuova, o l'errore che impedisce di deciderlo. */
type EsitoAdmin =
  | { ids: string[]; esclusi: number }
  | { error: { message: string; code?: string }; evento: string }

/**
 * Gli admin da collegare alla sede nuova — **senza gli account di collaudo**.
 *
 * Il 2026-07-29, provisionando Kidville Aversa e Kidville Cesa, questo elenco
 * era «tutti gli admin» (`.eq('ruolo','admin')`, nessun altro filtro) e ci è
 * finito dentro anche `admin.e2e@kidville.test`, l'account del seed della CI, la
 * cui password era un letterale committato in un repository PUBBLICO: Direzione
 * a pieno titolo su due plessi veri — anagrafiche di minori, note mediche,
 * pagamenti — e nessun segnale che fosse successo qualcosa.
 *
 * Il predicato è `isUtenteCollaudo` (src/lib/scuole/reali.ts), gemello di
 * `isScuolaE2E`: uno solo per tutto il progetto. Un'euristica locale «sugli id
 * che iniziano per e2e» sarebbe il secondo, e fra sei mesi i due non
 * concorderebbero più.
 *
 * Se una delle letture necessarie a classificare fallisce si RITORNA l'errore (→
 * 500) invece di tirare a indovinare: creare la sede collegando chiunque è
 * esattamente il difetto da cui veniamo, e creare la sede senza collegare
 * nessuno la lascerebbe senza Direzione. Un 500 si ritenta; una sede sbagliata
 * va bonificata a mano sul database.
 */
async function adminDaCollegare(supabase: ClientAdmin): Promise<EsitoAdmin> {
  const { data: admins, error: adminsError } = await supabase
    .from('utenti')
    .select('id, scuola_id')
    .eq('ruolo', 'admin')
  if (adminsError) return { error: adminsError, evento: 'db' }

  const candidati = ((admins ?? []) as { id: string | null; scuola_id: string | null }[])
    .filter((a) => Boolean(a.id))
    .map((a) => ({ id: String(a.id), scuola_id: a.scuola_id ?? null }))
  if (candidati.length === 0) return { ids: [], esclusi: 0 }

  // ── Ponte `utenti_scuole`: le sedi in più di ciascun candidato ─────────────
  // Serve per l'admin che non dichiara una sede primaria: senza il ponte le sue
  // sedi sarebbero zero e resterebbe classificato «reale» per assenza di prove.
  const ponte = new Map<string, string[]>()
  const { data: legami, error: ponteError } = await supabase
    .from('utenti_scuole')
    .select('utente_id, scuola_id')
    .in('utente_id', candidati.map((c) => c.id))
  if (ponteError) {
    // DB E2E della CI, non migrato: la tabella (o la colonna) può non esserci.
    // Si degrada alla sola sede primaria — che è comunque il segnale che ha
    // riconosciuto l'account di collaudo in produzione — ma lo si DICE.
    if (!SCHEMA_ASSENTE.has(ponteError.code ?? '')) {
      return { error: ponteError, evento: 'db-utenti-scuole' }
    }
    logEvento(
      'multi_sede',
      'info',
      { operazione: 'admin/schools:POST', esito: 'ponte-utenti-scuole-non-disponibile' },
      ponteError,
    )
  } else {
    for (const r of (legami ?? []) as { utente_id: string | null; scuola_id: string | null }[]) {
      if (!r.utente_id || !r.scuola_id) continue
      const chiave = String(r.utente_id)
      const lista = ponte.get(chiave) ?? []
      lista.push(String(r.scuola_id))
      ponte.set(chiave, lista)
    }
  }

  // ── Nomi delle sedi coinvolte: il secondo indizio di `isScuolaE2E` ─────────
  const sediIds = new Set<string>()
  for (const c of candidati) if (c.scuola_id) sediIds.add(c.scuola_id)
  for (const lista of ponte.values()) for (const s of lista) sediIds.add(s)
  const nomiSedi = new Map<string, string>()
  if (sediIds.size > 0) {
    const { data: sedi, error: sediError } = await supabase
      .from('schools')
      .select('id, nome')
      .in('id', Array.from(sediIds))
    if (sediError) return { error: sediError, evento: 'db-schools' }
    for (const s of (sedi ?? []) as { id: string | null; nome: string | null }[]) {
      if (s.id) nomiSedi.set(String(s.id), s.nome ?? '')
    }
  }

  const ids: string[] = []
  let esclusi = 0
  for (const c of candidati) {
    if (isUtenteCollaudo({ scuola_id: c.scuola_id, sedi: ponte.get(c.id) }, nomiSedi)) {
      esclusi += 1
      continue
    }
    ids.push(c.id)
  }
  if (esclusi > 0) {
    // Solo conteggi: l'identità di chi è stato escluso non serve a nessuno nel
    // log, e sarebbero pur sempre dati di persone.
    logEvento('multi_sede', 'info', {
      operazione: 'admin/schools:POST',
      esito: 'admin-collaudo-esclusi',
      admin_totali: candidati.length,
      admin_esclusi: esclusi,
    })
  }
  return { ids, esclusi }
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

/** Stesse regole del vecchio validaNomeScuola: obbligatorio, ≤120 caratteri dopo trim. */
const zNomeScuola = z
  .string({ error: 'Il nome della sede è obbligatorio' })
  .refine((v) => v.trim().length > 0, 'Il nome della sede è obbligatorio')
  .refine((v) => v.trim().length <= 120, 'Il nome della sede è troppo lungo (max 120 caratteri)')

const postBodySchema = z.object({
  nome: zNomeScuola,
  citta: z.string().nullish(),
  indirizzo: z.string().nullish(),
})

// id come stringa libera e NON zUuid: la tabella scuole è un registry soft-ref
// (id non-uuid nei test/dev); un id sconosciuto continua a dare 404, come prima.
// citta/indirizzo/attiva/config oggi accettano qualunque tipo (String()/!!/pass-through).
const patchBodySchema = z.object({
  id: z.string().min(1, 'id obbligatorio'), // sostituisce il 400 manuale 'id obbligatorio'
  nome: zNomeScuola.optional(),
  citta: z.unknown().optional(),
  indirizzo: z.unknown().optional(),
  attiva: z.unknown().optional(),
  config: z.unknown().optional(),
  // Anagrafica di sede (multi-sede): merge server-side in config.anagrafica,
  // le altre chiavi di config sono preservate.
  anagrafica: zAnagraficaSede.optional(),
})

export const GET = withRoute('admin/schools:GET', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('scuole')
    .select('id, nome, citta, indirizzo, attiva, config, created_at')
    .order('nome', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
})

export const POST = withRoute('admin/schools:POST', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response

  try {
    const scuola = normalizzaScuola(b.data)
    const supabase = await createAdminClient()

    // Admin da collegare alla nuova sede: senza il legame in `utenti_scuole` la
    // sede nasce senza Direzione e resta invisibile nel SedeSelector. **Gli
    // account di collaudo NON entrano in questo elenco** — vedi la testata di
    // `adminDaCollegare`.
    const scelta = await adminDaCollegare(supabase)
    if ('error' in scelta) {
      logErrore({ operazione: 'admin/schools:POST', stato: 500, evento: scelta.evento }, scelta.error)
      return NextResponse.json({ error: scelta.error.message }, { status: 500 })
    }
    const adminIds = scelta.ids

    // Provisioning atomico via RPC: crea in schools E scuole con lo STESSO id e
    // collega gli admin. Sul DB E2E la RPC non è deployata (PGRST202) → fallback.
    let sedeId: string
    let via: 'rpc' | 'fallback'
    const rpc = await provisionaSedeViaRpc(supabase, {
      p_nome: scuola.nome,
      p_citta: scuola.citta,
      p_indirizzo: scuola.indirizzo,
      p_admin_ids: adminIds,
    })
    if (rpc.error) {
      logErrore({ operazione: 'admin/schools:POST', stato: 500, evento: 'rpc' }, rpc.error)
      return NextResponse.json({ error: rpc.error.message }, { status: 500 })
    }

    if (rpc.id) {
      sedeId = rpc.id
      via = 'rpc'
    } else {
      // ── Fallback (RPC assente): doppio insert NON transazionale, stesso id ──
      const newId = crypto.randomUUID()
      const { error: schoolsErr } = await supabase
        .from('schools')
        .insert({ id: newId, nome: scuola.nome, citta: scuola.citta, indirizzo: scuola.indirizzo })
      if (schoolsErr) {
        logErrore({ operazione: 'admin/schools:POST', stato: 500, evento: 'db-fallback-schools' }, schoolsErr)
        return NextResponse.json({ error: schoolsErr.message }, { status: 500 })
      }
      const { error: scuoleErr } = await supabase
        .from('scuole')
        .insert({ id: newId, nome: scuola.nome, citta: scuola.citta, indirizzo: scuola.indirizzo, attiva: true })
      if (scuoleErr) {
        // NON transazionale: la riga schools esiste già → cleanup manuale, e va
        // detto (l'esito del cleanup entra nel log: se fallisce resta un'orfana).
        const { error: cleanupErr } = await supabase.from('schools').delete().eq('id', newId)
        // L'esito del cleanup va nell'`evento` (l'unico slot libero di logErrore):
        // se il cleanup fallisce resta una riga schools orfana da bonificare.
        logErrore(
          { operazione: 'admin/schools:POST', stato: 500, evento: cleanupErr ? 'db-fallback-scuole-cleanup-ko' : 'db-fallback-scuole' },
          scuoleErr,
        )
        if (cleanupErr) {
          logErrore({ operazione: 'admin/schools:POST', stato: 500, evento: 'db-fallback-cleanup' }, cleanupErr)
        }
        return NextResponse.json({ error: scuoleErr.message }, { status: 500 })
      }
      // ── Il corredo minimo della sede nuova ─────────────────────────────────
      // Stesse scritture che fa la RPC `provisiona_corredo_sede`
      // (20260731170000_provisiona_sede_v2.sql), qui replicate per il ramo senza
      // RPC: `admin_settings` (senza cui `loadGradoContext` legge `matrice = {}`
      // e `requireFunzione` risponde 403 su TUTTE le funzioni docente della sede
      // — require-grado.ts:36-44 e :64-86), la scala dei giudizi e il titolario
      // dei protocolli. Un guasto qui NON diventa un 500: la sede è già in
      // schools+scuole e un retry del client ne creerebbe una SECONDA. Si logga
      // (AGENTS.md §4) e la checklist della risposta dice che cosa manca.
      await provisionaCorredoFallback(supabase, newId, 'admin/schools:POST')

      // Collega gli admin (best-effort: la sede esiste comunque).
      for (const aid of adminIds) {
        const { error: linkErr } = await supabase
          .from('utenti_scuole')
          .insert({ utente_id: aid, scuola_id: newId })
        if (linkErr) {
          logEvento('multi_sede', 'warn', { operazione: 'admin/schools:POST', esito: 'link-admin-fallito', sede_id: newId }, linkErr)
        }
      }
      sedeId = newId
      via = 'fallback'
    }

    // ── Che cosa manca ancora, e dove si compila ─────────────────────────────
    // Il corredo si RILEGGE dal database invece di darlo per fatto: sul ramo
    // RPC il chiamante conosce solo l'uuid restituito, e quali pezzi contenga
    // quella funzione lo decide la versione deployata. Una sede che «sembra
    // pronta» è il difetto da cui veniamo (R123): Aversa e Cesa sono nate senza
    // scala dei giudizi, senza titolario e — Cesa — senza una sola disciplina,
    // e nessun punto dell'applicazione lo diceva.
    const fatti = await verificaCorredoSede(supabase, sedeId, 'admin/schools:POST')
    const checklist = checklistSede(fatti)

    // Evento amministrativo critico → logga il SUCCESSO (uuid + conteggi; MAI
    // nomi: l'uuid è auto-descrittivo, i conteggi sono numeri).
    logEvento('multi_sede', 'info', {
      operazione: 'admin/schools:POST',
      esito: via,
      sede_id: sedeId,
      admin_collegati: adminIds.length,
      admin_esclusi: scelta.esclusi,
      corredo_da_fare: checklist.filter((v) => v.stato === 'da_fare').length,
    })

    const data = {
      id: sedeId,
      nome: scuola.nome,
      citta: scuola.citta,
      indirizzo: scuola.indirizzo,
      attiva: true,
      checklist,
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'multi_sede',
      entitaId: sedeId,
      azione: 'insert',
      valoreDopo: scuola,
    })
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/schools:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})

export const PATCH = withRoute('admin/schools:PATCH', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, patchBodySchema)
  if ('response' in b) return b.response
  const { id, nome, citta, indirizzo, attiva, config, anagrafica } = b.data

  try {
    const supabase = await createAdminClient()
    const { data: existing } = await supabase
      .from('scuole')
      .select('id, config')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Sede non trovata' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (nome !== undefined) updates.nome = String(nome).trim()
    if (citta !== undefined) updates.citta = citta ? String(citta).trim() : null
    if (indirizzo !== undefined) updates.indirizzo = indirizzo ? String(indirizzo).trim() : null
    if (attiva !== undefined) updates.attiva = !!attiva
    if (config !== undefined) updates.config = config
    if (anagrafica !== undefined) {
      // Merge server-side (pattern Settings Hub): preserva le altre chiavi di
      // config; se nel body arriva anche `config` grezza, l'anagrafica
      // normalizzata vince sulla chiave omonima.
      const base = updates.config ?? existing.config
      const existingConfig = base && typeof base === 'object' ? (base as Record<string, unknown>) : {}
      updates.config = { ...existingConfig, anagrafica: normalizzaAnagraficaSede(anagrafica) }
    }

    const { data, error } = await supabase
      .from('scuole')
      .update(updates)
      .eq('id', id)
      .select('id, nome, citta, indirizzo, attiva, config')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    // Propaga nome/citta/indirizzo anche al tenant `schools` (upsert per coprire
    // eventuali sedi orfane residue). Best-effort: `scuole` è la fonte anagrafica,
    // ma `schools` è ciò che vede il SedeSelector e va tenuto allineato.
    const schoolPatch: Record<string, unknown> = { id }
    if (nome !== undefined) schoolPatch.nome = String(nome).trim()
    if (citta !== undefined) schoolPatch.citta = citta ? String(citta).trim() : null
    if (indirizzo !== undefined) schoolPatch.indirizzo = indirizzo ? String(indirizzo).trim() : null
    if (Object.keys(schoolPatch).length > 1) {
      try {
        const { error: schoolsErr } = await supabase
          .from('schools')
          .upsert(schoolPatch, { onConflict: 'id' })
        // PGRST204/42703 = colonna assente sul DB E2E → degrade silenzioso.
        if (schoolsErr && schoolsErr.code !== 'PGRST204' && schoolsErr.code !== '42703') {
          logEvento('multi_sede', 'warn', { operazione: 'admin/schools:PATCH', esito: 'propagazione-schools-fallita', sede_id: id }, schoolsErr)
        }
      } catch (propErr) {
        // L'aggiornamento su `scuole` è già andato: la propagazione è best-effort,
        // non deve far fallire la richiesta — ma «saltata» va detto (warn).
        logEvento('multi_sede', 'warn', { operazione: 'admin/schools:PATCH', esito: 'propagazione-schools-eccezione', sede_id: id }, propErr)
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'multi_sede',
      entitaId: id,
      azione: 'update',
      valoreDopo: updates,
    })
    return NextResponse.json(data)
  } catch (err) {
    logErrore({ operazione: 'admin/schools:PATCH', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
