import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { normalizzaScuola } from '@/lib/scuole/validate'
import { isScuolaE2E, isUtenteCollaudo } from '@/lib/scuole/reali'
import { zAnagraficaSede, normalizzaAnagraficaSede } from '@/lib/scuole/anagrafica'
import {
  checklistSede,
  provisionaCorredoFallback,
  verificaCorredoSede,
} from '@/lib/scuole/corredo-sede'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'

// Multi-Sede CRUD (DL-033). Aggiungi / rinomina / disattiva (soft) + config
// isolata per sede. Service-role + scoping app + audit, coerente col resto del
// progetto. Chi può fare che cosa — e su QUALE sede — è nel blocco qui sotto:
// NON è più «la Direzione» in blocco, come diceva questa riga fino al 2026-07-31.
//
// D1 — Provisioning reale (multi-sede): `schools` è il tenant REALE (tutte le FK
// scuola_id → schools), `scuole` è il registry anagrafico. Creare la sede solo in
// `scuole` (comportamento storico) la lasciava fantasma, invisibile al
// SedeSelector. Il POST ora provisiona in ENTRAMBI con lo stesso id (RPC
// `provisiona_sede`, o fallback client-side sul DB E2E) e collega gli admin.

// ─── Chi può fare che cosa, e su QUALE sede ─────────────────────────────────
//
// Fino al 2026-07-31 questo file aveva una sola lista — `DIREZIONE` — e la
// usava per tutti e tre gli handler. Era un gate di RUOLO senza gate di
// OGGETTO: misurato in collaudo, un `coordinator` di Giugliano riceveva
// **HTTP 200** da `PATCH {"id":"<uuid di un'altra sede>"}` e poteva riscrivere
// nome, città, `config` intera — dentro c'è l'anagrafica fiscale che finisce in
// fattura: PEC, P.IVA, codice meccanografico — e il flag `attiva` di QUALUNQUE
// plesso del deployment. La `GET` elencava tutte le sedi, compresa quella
// fittizia della CI che `/api/iscrizione/sedi` esclude da sempre.
//
// La causa non era una dimenticanza locale: erano DUE modelli di autorizzazione
// incoerenti nello stesso repository. Qui `admin` e `coordinator` erano
// un'unica «Direzione» globale; in `src/lib/auth/scope.ts:58`
// (`if (user.role !== 'admin') return own`) solo l'`admin` è multi-plesso. Fra i
// due vince `scope.ts`, che è il punto in cui il modello è deciso per tutto il
// progetto — quindi:
//
//  · GESTIONE (GET/PATCH) → admin e coordinator, ma **solo sulle sedi che
//    `scuoleDiUtente` restituisce**. Il coordinator ne ha una e resta lì.
//  · CREAZIONE (POST) → **solo admin**. Creare un plesso è un atto societario:
//    provisiona il tenant, ci aggancia la Direzione e fa nascere il corredo.
//    Un utente mono-plesso creerebbe una sede che poi non vedrebbe nemmeno
//    nell'elenco (la GET filtra per `scuoleDiUtente`): il verso in cui si
//    sbaglia è «non può», non «può e poi non se ne accorge nessuno».
const DIREZIONE = ['admin', 'coordinator'] as const
const CREA_SEDE = ['admin'] as const

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

/**
 * Il diniego per SEDE — stessa forma e **stesso messaggio** di
 * `resolveScuolaScrittura` (`scope.ts:188-192`), di proposito: «ho chiesto una
 * sede che non è mia» deve essere un segnale solo, contabile con una query
 * sola. Cambia il campo `azione`, che dice da dove arriva.
 *
 * Nella riga NON entra l'uuid della sede richiesta: come nelle altre
 * `*-fuori-scope` del modulo si registrano solo l'utente, il suo ruolo e
 * QUANTE sedi ha. Chi indaga parte dall'utente, non dal plesso.
 */
function sedeFuoriScope(
  user: { id: string; role: string },
  azione: string,
  accessibili: number,
): NextResponse {
  logEvento('auth', 'warn', {
    tipo: 'sede-scrittura-fuori-scope', azione,
    utente: user.id, ruolo: user.role, accessibili,
  })
  return rifiutoSede('SEDE_NON_ACCESSIBILE')
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

  // Le sedi dell'utente, non le sedi del deployment. Scope vuoto = elenco vuoto
  // (fail-closed: `scuoleDiUtente` ritorna `[]` anche quando la lettura del
  // ponte fallisce, e un errore di lettura non è un permesso).
  const plessi = await scuoleDiUtente(supabase, auth.user)
  if (plessi.length === 0) return NextResponse.json([])

  const { data, error } = await supabase
    .from('scuole')
    .select('id, nome, citta, indirizzo, attiva, config, created_at')
    .in('id', plessi)
    .order('nome', { ascending: true })
  if (error) {
    // PostgREST non lancia: senza questa riga il 500 direbbe «è andata male» e
    // non «quale lettura non è riuscita».
    logErrore({ operazione: 'admin/schools:GET', stato: 500, evento: 'db-scuole' }, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // La sede fittizia della CI (`e2e00000-…` / nome «…E2E») non compare a un
  // utente vero: è lo stesso predicato che `/api/iscrizione/sedi` applica al
  // pubblico da sempre, e senza di esso un admin che se la ritrova nel ponte se
  // la vede in elenco fra i plessi veri. Restano invece visibili agli ACCOUNT DI
  // COLLAUDO — riconosciuti da `isUtenteCollaudo`, il predicato gemello — perché
  // per loro quella è l'unica sede che esiste: escluderla svuoterebbe la pagina
  // Multi-sede della CI e trasformerebbe un filtro in un guasto.
  const righe = (data ?? []) as { id: string; nome: string }[]
  const nomiSedi = new Map(righe.map((s) => [String(s.id), s.nome ?? '']))
  const collaudo = isUtenteCollaudo({ scuola_id: auth.user.scuola_id, sedi: plessi }, nomiSedi)
  const visibili = collaudo ? righe : righe.filter((s) => !isScuolaE2E({ id: s.id, nome: s.nome }))
  return NextResponse.json(visibili)
})

export const POST = withRoute('admin/schools:POST', async (request: Request) => {
  const auth = await requireStaff(request, [...CREA_SEDE])
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
      // (20260731123052_provisiona_sede_v2.sql), qui replicate per il ramo senza
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
      // La sede dell'audit è quella APPENA CREATA, non quella di casa di chi
      // l'ha creata — l'unico plesso a cui la sede nuova non appartiene. Vedi la
      // nota estesa sulla stessa riga del PATCH.
      scuolaId: sedeId,
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
    const { data: existing, error: letturaErr } = await supabase
      .from('scuole')
      .select('id, config')
      .eq('id', id)
      .maybeSingle()
    // PostgREST non lancia: senza guardare `error` una lettura FALLITA lasciava
    // `existing` a null e la route rispondeva «Sede non trovata» — cioè
    // affermava qualcosa su un dato che non aveva letto, e il guasto spariva
    // dentro un diniego dall'aria normale.
    if (letturaErr) {
      logErrore({ operazione: 'admin/schools:PATCH', stato: 500, evento: 'db-scuole-lettura' }, letturaErr)
      return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
    }
    if (!existing) return NextResponse.json({ error: 'Sede non trovata' }, { status: 404 })

    // ── Il gate sull'OGGETTO, non solo su chi lo chiede ──────────────────────
    // Va DOPO il 404 di proposito: «questa sede non esiste» e «questa sede non è
    // tua» sono due dinieghi diversi e vanno tenuti distinti — il secondo è un
    // segnale di sicurezza e finisce in un contatore, il primo è un id sbagliato
    // e non deve inquinarlo.
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (!plessi.includes(id)) {
      return sedeFuoriScope(auth.user, 'admin/schools:PATCH', plessi.length)
    }

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

    // ── Propagazione su `schools`, e perché si legge da `data` e non dal corpo ──
    // Best-effort: `scuole` è la fonte anagrafica, ma `schools` è ciò che vede il
    // SedeSelector ed è il ripiego da cui prestampati, prefill e protocolli
    // leggono nome/città/indirizzo quando manca la riga `scuole`.
    //
    // La riga si compone dai valori AUTORITATIVI appena scritti (`data`), non da
    // quelli arrivati nel corpo. `schools.nome` è NOT NULL senza default, e un
    // `upsert` propone comunque un INSERT: Postgres valida i NOT NULL sulla tupla
    // proposta PRIMA di risolvere `ON CONFLICT`. Costruire il payload dal corpo
    // significava quindi mandare `nome` assente ogni volta che il chiamante non
    // lo includeva — cioè SEMPRE, perché Impostazioni → Sede & Intestazione manda
    // `{id, citta, indirizzo, anagrafica}` e il nome non lo mostra nemmeno.
    //
    // Misurato in produzione (`app_log`, 2026-08-15 17:50:41Z, sede Aversa):
    //   23502 «null value in column "nome" of relation "schools"»
    // `scuole` si aggiornava, `schools` restava indietro, e le due tabelle
    // divergevano in silenzio dietro un `warn` che nessuno rileggeva.
    const toccaAnagrafica = nome !== undefined || citta !== undefined || indirizzo !== undefined
    if (toccaAnagrafica) {
      const riga = data as { nome?: string | null; citta?: string | null; indirizzo?: string | null }
      const schoolPatch: Record<string, unknown> = {
        id,
        nome: riga.nome,
        citta: riga.citta ?? null,
        indirizzo: riga.indirizzo ?? null,
      }
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

    // ── L'audit dichiara la sede su cui si è scritto ─────────────────────────
    // `logScrittura` ripiega su `attore.scuola_id` quando il chiamante tace
    // (audit/scrittura.ts:112), e per un `admin` multi-sede quella è la sede DI
    // CASA, non quella appena modificata. Qui si taceva, e le due coincidevano
    // per caso una volta su tre.
    //
    // Misurato in produzione (2026-08-16, `audit_scritture_docente`, entità
    // `multi_sede`): otto righe su dodici attribuivano a Giugliano un
    // salvataggio avvenuto su Aversa o su Cesa — comprese quelle lasciate dai
    // `PATCH` con cui l'anagrafica delle tre sedi è stata compilata dal
    // pannello, cioè proprio le righe che dovevano PROVARE che il percorso
    // applicativo lascia una traccia.
    //
    // Su `multi_sede` l'entità modificata È una sede, quindi «quale plesso» non
    // è un contorno del record: è il record. Un registro immodificabile che
    // nomina il plesso sbagliato è peggio di uno che tace, perché chi rilegge
    // gli crede. È la regola di AGENTS.md — «ogni scrittura dichiara la sua
    // sede» — applicata alla scrittura che ha per oggetto una sede.
    await logScrittura(supabase, {
      attore: auth.user,
      scuolaId: id,
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
