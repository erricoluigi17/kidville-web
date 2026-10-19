import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { figlieTrattengono } from '@/lib/db/figlie-trattengono'

// ============================================================
// Periodi di scrutinio, per sede.
//
// Fino al 2026-07-31 tutti e quattro gli handler filtravano su
// `.eq('scuola_id', auth.user.scuola_id)`. Fail-closed, quindi non perdeva
// dati — ma con tre plessi la colonna singola non è più «la scuola»: è solo la
// PRIMA sede assegnata all'account. L'unico admin reale, che ha le tre sedi nel
// ponte `utenti_scuole`, non poteva né vedere né creare i periodi di Aversa e
// Cesa; e il POST scriveva comunque nella sede primaria qualunque cosa avesse
// scelto nel SedeSelector — cioè il contrario di «ogni scrittura dichiara la
// sua sede». Letture: `resolveScuoleAttive` (scope vuoto ⇒ nessuna riga).
// Scritture: `resolveScuolaScrittura`, che risponde 400 se la sede è ambigua.
// ============================================================

/** '' equivale ad assente: il cockpit può mandare il parametro ancora vuoto. */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

/**
 * Archiviazione (fase 4 della robustezza, D3-C): un periodo chiuso esce dall'elenco senza che
 * niente di ciò che vi è appeso venga toccato. Sul DB E2E della CI la colonna non c'è: in lettura
 * `42703` (si rilegge senza il filtro: là nessuno ha mai archiviato niente), in scrittura
 * `PGRST204`/`42703` (si risponde 503 e lo si dice).
 */
const CODICI_COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

const getQuerySchema = z.object({
  annoScolastico: z.string().optional(),
  // `si` = anche i periodi archiviati (la segreteria li rivede per ripristinarli).
  archiviati: z.enum(['si']).optional(),
  // Sede dichiarata dal pannello (che è mono-sede: sta dentro `SedeRequired`).
  // È una PREFERENZA, non un'autorizzazione: vale solo se rientra nei plessi in
  // scope, e non allarga mai — vedi l'intersezione nell'handler.
  scuolaId: z.preprocess(vuotoComeAssente, zUuid.optional()),
})

const postBodySchema = z.object({
  // La sede si DICHIARA: il client la manda, il server la ri-valida contro i
  // plessi accessibili (è solo `preferita`, non un'autorizzazione).
  scuolaId: zUuid.nullish(),
  annoScolastico: z.string().min(1),
  nome: z.string().min(1),
  ordine: z.union([z.number(), z.string()]).nullish(),
  dataInizio: z.string().nullish(),
  dataFine: z.string().nullish(),
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.string().nullish(),
  ordine: z.union([z.number(), z.string()]).nullish(),
  dataInizio: z.string().nullish(),
  dataFine: z.string().nullish(),
  attivo: z.boolean().nullish(),
  // true = archivia (e disattiva), false = ripristina nell'elenco.
  archiviato: z.boolean().nullish(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/admin/primaria/scrutinio-periodi?annoScolastico=&userId=
// Elenca i periodi di scrutinio configurati per la scuola dello staff.
export const GET = withRoute('admin/primaria/scrutinio-periodi:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { annoScolastico: anno, scuolaId, archiviati } = q.data

    const supabase = await createAdminClient()
    // Scope vuoto ⇒ `.in('scuola_id', [])` ⇒ nessuna riga: si NEGA, mai
    // «allora eccoti tutto». Se il pannello dichiara la sua sede, si INTERSECA:
    // una sede non accessibile non allarga l'elenco e non restituisce nemmeno i
    // periodi propri, che sarebbero una risposta a una domanda mai fatta.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    const sedi = scuolaId ? plessi.filter((id) => id === scuolaId) : plessi
    const leggi = (escludiArchiviati: boolean) => {
      let query = supabase
        .from('scrutinio_periodi')
        .select('*')
        .in('scuola_id', sedi)
        .order('ordine')
      if (anno) query = query.eq('anno_scolastico', anno)
      if (escludiArchiviati) query = query.is('archiviato_il', null)
      return query
    }

    let { data, error } = await leggi(archiviati !== 'si')
    if (error && archiviati !== 'si' && CODICI_COLONNA_ASSENTE.has(error.code ?? '')) {
      // DB non migrato: la colonna non c'è, quindi nessun periodo può essere archiviato.
      logEvento('registro', 'info', {
        operazione: 'admin/primaria/scrutinio-periodi:GET', esito: 'archiviazione-non-disponibile-schema', error_code: error.code,
      })
      ;({ data, error } = await leggi(false))
    }
    if (error) {
      logErrore({ operazione: 'admin/primaria/scrutinio-periodi:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/primaria/scrutinio-periodi?userId=
// body: { annoScolastico, nome, ordine?, dataInizio?, dataFine? }
export const POST = withRoute('admin/primaria/scrutinio-periodi:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scuolaId, annoScolastico, nome, ordine, dataInizio, dataFine } = b.data

    const supabase = await createAdminClient()
    const sede = await resolveScuolaScrittura(request, supabase, auth.user, scuolaId)
    if (sede.response) return sede.response
    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .insert({
        scuola_id: sede.scuolaId!,
        anno_scolastico: annoScolastico,
        nome,
        ordine: ordine ?? 0,
        data_inizio: dataInizio ?? null,
        data_fine: dataFine ?? null,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/admin/primaria/scrutinio-periodi?userId=
// body: { id, nome?, ordine?, dataInizio?, dataFine?, attivo? }
export const PATCH = withRoute('admin/primaria/scrutinio-periodi:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, nome, ordine, dataInizio, dataFine, attivo, archiviato } = b.data

    const patch: Record<string, unknown> = {}
    if (nome !== undefined) patch.nome = nome
    if (ordine !== undefined) patch.ordine = ordine
    if (dataInizio !== undefined) patch.data_inizio = dataInizio
    if (dataFine !== undefined) patch.data_fine = dataFine
    if (attivo !== undefined) patch.attivo = attivo
    if (archiviato === true) {
      // Un periodo archiviato non si compila più: si disattiva nella stessa scrittura.
      patch.archiviato_il = new Date().toISOString()
      patch.attivo = false
    } else if (archiviato === false) {
      patch.archiviato_il = null
    }

    const supabase = await createAdminClient()
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .update(patch)
      .eq('id', id)
      .in('scuola_id', plessi)
      .select()
    if (error) {
      if (archiviato != null && CODICI_COLONNA_ASSENTE.has(error.code ?? '')) {
        logEvento('registro', 'warn', {
          operazione: 'admin/primaria/scrutinio-periodi:PATCH', esito: 'archiviazione-non-disponibile-schema', periodo_id: id, error_code: error.code,
        })
        return NextResponse.json(
          { error: 'L’archiviazione dei periodi non è ancora disponibile su questo database.', codice: 'ARCHIVIAZIONE_NON_DISPONIBILE' },
          { status: 503 },
        )
      }
      logErrore({ operazione: 'admin/primaria/scrutinio-periodi:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno', codice: 'SCRITTURA_FALLITA' }, { status: 500 })
    }
    // 0 righe = periodo inesistente OPPURE di un altro plesso: si risponde 404
    // in entrambi i casi, così la risposta non diventa un oracolo di esistenza.
    if (!data || data.length === 0) return NextResponse.json({ error: 'Periodo non trovato' }, { status: 404 })
    if (archiviato != null) {
      // Chi ha tolto (o rimesso) un periodo dall'elenco, e quando: è una scrittura su un
      // contenitore di documenti scolastici, e deve lasciare traccia anche quando riesce.
      logEvento('registro', 'info', {
        operazione: 'admin/primaria/scrutinio-periodi:PATCH',
        esito: archiviato ? 'periodo-archiviato' : 'periodo-ripristinato',
        periodo_id: id,
        utente_id: auth.user.id,
      })
    }
    return NextResponse.json({ success: true, data: data[0] })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

/** 409: il periodo porta scrutini o giudizi, e quelli sono documenti scolastici. */
function rispostaPeriodoConScrutini(periodoId: string, causa: string, err?: unknown): NextResponse {
  logEvento('pagella', 'warn', {
    operazione: 'admin/primaria/scrutinio-periodi:DELETE', esito: 'periodo-con-scrutini', periodo_id: periodoId, tipo: causa,
  }, err)
  return NextResponse.json(
    {
      error: 'Il periodo ha già scrutini: non si può eliminare. Si può archiviare: esce dall’elenco, e scrutini e pagelle restano.',
      codice: 'PERIODO_CON_SCRUTINI',
    },
    { status: 409 },
  )
}

// DELETE /api/admin/primaria/scrutinio-periodi?id=&userId=
export const DELETE = withRoute('admin/primaria/scrutinio-periodi:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)

    // Fase 7 della roadmap di robustezza: un periodo con scrutini (e quindi pagelle,
    // giudizi, comportamento, ricevute) NON si cancella. Prima la cascata portava via
    // l'intero scrutinio di un periodo con un clic, senza conferma né traccia; dalla PR 2
    // la FK è RESTRICT e il database rifiuta comunque. Qui lo si dice prima, dopo aver
    // verificato che il periodo sia di un plesso in scope (un 409 su un periodo altrui
    // direbbe che esiste). I giudizi descrittivi del periodo NON trattengono: sono la
    // tabella dei livelli che la sede configura, non un documento di un alunno, e se ne
    // vanno col periodo come prima.
    const { data: periodo, error: errPeriodo } = await supabase
      .from('scrutinio_periodi')
      .select('id')
      .eq('id', id)
      .in('scuola_id', plessi)
      .maybeSingle()
    if (errPeriodo) {
      logErrore({ operazione: 'admin/primaria/scrutinio-periodi:DELETE', stato: 500, evento: 'db' }, errPeriodo)
      return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    if (!periodo) return NextResponse.json({ error: 'Periodo non trovato' }, { status: 404 })
    const { data: scrutini, error: errScrutini } = await supabase.from('scrutini').select('id').eq('periodo_id', id).limit(1)
    if (errScrutini) {
      logErrore({ operazione: 'admin/primaria/scrutinio-periodi:DELETE', stato: 500, evento: 'guardia_scrutini' }, errScrutini)
      return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    if (scrutini && scrutini.length > 0) return rispostaPeriodoConScrutini(id, 'scrutini')

    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .delete()
      .eq('id', id)
      .in('scuola_id', plessi)
      .select('id')
    if (error) {
      if (figlieTrattengono(error)) return rispostaPeriodoConScrutini(id, 'freno', error)
      logErrore({ operazione: 'admin/primaria/scrutinio-periodi:DELETE', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno', codice: 'ELIMINAZIONE_NON_RIUSCITA' }, { status: 500 })
    }
    if (!data || data.length === 0) return NextResponse.json({ error: 'Periodo non trovato' }, { status: 404 })
    logEvento('registro', 'info', { operazione: 'admin/primaria/scrutinio-periodi:DELETE', esito: 'periodo-eliminato', periodo_id: id })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:DELETE', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
