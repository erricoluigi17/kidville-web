import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { figlieTrattengono } from '@/lib/db/figlie-trattengono'
import { COLONNE_PERIODO, dateMancantiPerAnno, sovrapposto, type PeriodoScrutinio } from '@/lib/primaria/periodo'
import { ricalcolaPeriodiSede } from '@/lib/primaria/quadrimestre'

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
 * Un campo data lasciato vuoto («») è una data TOLTA (`null`), non una stringa da mandare al database.
 * Ogni data che resta passa da `zDataYMD` (`YYYY-MM-DD`, esistente nel calendario): i controlli sulle
 * date confrontano stringhe, e l'ordine lessicografico vale solo sulla forma canonica — `2027-6-1` sta
 * DOPO `2027-06-30` come testo e PRIMA come giorno, e Postgres l'avrebbe accettata lo stesso.
 */
const dataOVuota = z.preprocess((v) => (v === '' ? null : v), zDataYMD.nullish())

/**
 * Archiviazione (fase 4 della robustezza, D3-C): un periodo chiuso esce dall'elenco senza che
 * niente di ciò che vi è appeso venga toccato. Sul DB E2E della CI la colonna non c'è: in lettura
 * `42703` (si rilegge senza il filtro: là nessuno ha mai archiviato niente), in scrittura
 * `PGRST204`/`42703` (si risponde 503 e lo si dice).
 */
const CODICI_COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * Le date dei periodi decidono a quale quadrimestre appartiene ogni voto (`periodo_id`), quindi quando
 * cambiano il server riassegna i voti della sede (`ricalcolaPeriodiSede`). Un ricalcolo che non riesce
 * NON annulla la scrittura già fatta: la risposta riuscita lo dice, e il motivo è già nel log.
 */
type Ricalcolo = 'fatto' | 'non-necessario' | 'non-riuscito'

async function ricalcola(
  supabase: SupabaseClient,
  scuolaId: string,
  operazione: string,
): Promise<Ricalcolo> {
  return (await ricalcolaPeriodiSede(supabase, scuolaId, operazione)) ? 'fatto' : 'non-riuscito'
}

/** Un periodo copre dei giorni solo con ENTRAMBE le date: con una sola (o nessuna) non c'è nulla da ricalcolare. */
const haEntrambeLeDate = (p: { data_inizio?: string | null; data_fine?: string | null }) => Boolean(p.data_inizio && p.data_fine)

/** Lettura fallita: 500 e NESSUNA scrittura. Mai un 201 o un 409 inventati su un «non so». */
function letturaFallita(operazione: string, evento: string, err: unknown): NextResponse {
  logErrore({ operazione, stato: 500, evento }, err)
  return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
}

/** 404 unico: periodo inesistente OPPURE di un altro plesso, indistinguibili (niente oracolo di esistenza). */
const periodoNonTrovato = () => NextResponse.json({ error: 'Periodo non trovato' }, { status: 404 })

// I rifiuti sulle date: ciascuno scrive il suo `error_code` nel log (info: è un errore di chi compila, non del
// sistema) e porta il codice come LETTERALE, che è ciò che il lock `errori-con-codice` sa leggere.
function rifiutoDateIncomplete(operazione: string, scuolaId: string): NextResponse {
  logEvento('registro', 'info', { operazione, esito: 'periodo-date-incomplete', scuola_id: scuolaId, error_code: 'PERIODO_DATE_INCOMPLETE' })
  return NextResponse.json(
    { error: 'Indica entrambe le date del periodo, oppure nessuna.', codice: 'PERIODO_DATE_INCOMPLETE' },
    { status: 422 },
  )
}

function rifiutoPeriodoRovesciato(operazione: string, scuolaId: string): NextResponse {
  logEvento('registro', 'info', { operazione, esito: 'periodo-rovesciato', scuola_id: scuolaId, error_code: 'PERIODO_ROVESCIATO' })
  return NextResponse.json(
    { error: 'La data di fine viene prima della data di inizio: controlla l’intervallo.', codice: 'PERIODO_ROVESCIATO' },
    { status: 400 },
  )
}

function rifiutoPeriodiSovrapposti(operazione: string, scuolaId: string): NextResponse {
  logEvento('registro', 'info', { operazione, esito: 'periodi-sovrapposti', scuola_id: scuolaId, error_code: 'PERIODI_SOVRAPPOSTI' })
  return NextResponse.json(
    { error: 'Le date si sovrappongono a un altro periodo dello stesso anno scolastico.', codice: 'PERIODI_SOVRAPPOSTI' },
    { status: 422 },
  )
}

function rifiutoPeriodoConScrutiniChiusi(operazione: string, scuolaId: string): NextResponse {
  logEvento('registro', 'info', { operazione, esito: 'periodo-con-scrutini-chiusi', scuola_id: scuolaId, error_code: 'PERIODO_CON_SCRUTINI_CHIUSI' })
  return NextResponse.json(
    { error: 'Il periodo ha uno scrutinio chiuso: per spostarne le date va prima riaperto.', codice: 'PERIODO_CON_SCRUTINI_CHIUSI' },
    { status: 409 },
  )
}

/**
 * La forma delle date: entrambe o nessuna, e la fine non prima dell'inizio. Si applica alla riga FINALE
 * (per la PATCH, già unita a quella salvata). `null` = niente da rifiutare.
 */
function rifiutoSuLeDate(operazione: string, scuolaId: string, inizio: string | null, fine: string | null): NextResponse | null {
  if (!inizio && !fine) return null
  if (!inizio || !fine) return rifiutoDateIncomplete(operazione, scuolaId)
  if (fine < inizio) return rifiutoPeriodoRovesciato(operazione, scuolaId)
  return null
}

/**
 * Le date toccano un altro periodo della STESSA sede, di QUALUNQUE anno scolastico? Si leggono tutti, `attivo`
 * o no (un periodo archiviato ha le sue date che valgono ancora per i voti di quegli anni), e `sovrapposto`
 * salta sé stesso per id. L'anno NON restringe la ricerca: la copertura di un giorno (`periodoPerData` e la
 * funzione SQL del ricalcolo) sceglie il periodo per sede e date, senza guardare l'anno, quindi un periodo
 * salvato con l'anno sbagliato ruberebbe i voti a un altro. Due anni scolastici non condividono giorni: nessun
 * dato valido viene respinto. Una lettura fallita è 500: «non so se si sovrappone» non diventa un sì né un no.
 */
async function rifiutoSuSovrapposizione(
  supabase: SupabaseClient,
  operazione: string,
  candidato: { id?: string; scuolaId: string; inizio: string; fine: string },
): Promise<NextResponse | null> {
  const { data, error } = await supabase
    .from('scrutinio_periodi')
    .select(COLONNE_PERIODO)
    .eq('scuola_id', candidato.scuolaId)
  if (error) return letturaFallita(operazione, 'periodi_sovrapposizione', error)
  const altri = (data ?? []) as unknown as PeriodoScrutinio[]
  if (sovrapposto({ id: candidato.id, data_inizio: candidato.inizio, data_fine: candidato.fine }, altri)) {
    return rifiutoPeriodiSovrapposti(operazione, candidato.scuolaId)
  }
  return null
}

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
  dataInizio: dataOVuota,
  dataFine: dataOVuota,
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.string().nullish(),
  ordine: z.union([z.number(), z.string()]).nullish(),
  dataInizio: dataOVuota,
  dataFine: dataOVuota,
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
    // Promemoria per la pagina: per quella sede e quell'anno non c'è nessun periodo attivo, o ne manca una
    // data (e allora nessun voto trova il suo quadrimestre). Si calcola solo se la pagina dichiara sede E
    // anno, e solo se la sede è accessibile: di una sede che non si vede non si dice che «mancano le date».
    const dateMancanti =
      scuolaId && anno && sedi.length > 0
        ? dateMancantiPerAnno((data ?? []) as unknown as PeriodoScrutinio[], anno)
        : null
    return NextResponse.json({ success: true, data: data ?? [], dateMancanti })
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
    const operazione = 'admin/primaria/scrutinio-periodi:POST'
    const inizio = dataInizio ?? null
    const fine = dataFine ?? null

    // Prima di scrivere: date a metà o rovesciate, poi sovrapposizioni con gli altri periodi della sede.
    const rifiutoDate = rifiutoSuLeDate(operazione, sede.scuolaId!, inizio, fine)
    if (rifiutoDate) return rifiutoDate
    if (inizio && fine) {
      const rifiutoSovrapposto = await rifiutoSuSovrapposizione(supabase, operazione, {
        scuolaId: sede.scuolaId!, inizio, fine,
      })
      if (rifiutoSovrapposto) return rifiutoSovrapposto
    }

    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .insert({
        scuola_id: sede.scuolaId!,
        anno_scolastico: annoScolastico,
        nome,
        ordine: ordine ?? 0,
        data_inizio: inizio,
        data_fine: fine,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    logEvento('registro', 'info', {
      operazione, esito: 'periodo-creato', scuola_id: sede.scuolaId!, periodo_id: data?.id ?? null, con_date: Boolean(inizio && fine),
    })
    // Un periodo con le date può coprire voti già scritti: la sede si ricalcola. Senza date non copre niente.
    const ricalcolo: Ricalcolo = inizio && fine ? await ricalcola(supabase, sede.scuolaId!, operazione) : 'non-necessario'
    return NextResponse.json({ success: true, data, ricalcolo }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/admin/primaria/scrutinio-periodi?userId=
// body: { id, nome?, ordine?, dataInizio?, dataFine?, attivo?, archiviato? }
//
// Le date si controllano sulla riga FINALE (quella salvata unita al corpo), non sul solo corpo: togliere la
// data di fine a un periodo che ha anche l'inizio lascia una data sola. Se le date cambiano:
//  · con uno scrutinio chiuso sul periodo → 409 (va prima riaperto);
//  · se toccano un altro periodo della stessa sede (di qualunque anno scolastico) → 422;
//  · a scrittura riuscita i voti della sede si ricalcolano.
// Cambiare solo nome, ordine o stato non sposta niente e non ricalcola.
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
    // Una data svuotata («») è già `null` dallo schema: la data si toglie.
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

    const operazione = 'admin/primaria/scrutinio-periodi:PATCH'
    const supabase = await createAdminClient()
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)

    // La riga com'è adesso, ristretta ai plessi in scope: inesistente e altrui sono la stessa risposta (404).
    const { data: rigaLetta, error: errRiga } = await supabase
      .from('scrutinio_periodi')
      .select(COLONNE_PERIODO)
      .eq('id', id)
      .in('scuola_id', plessi)
      .maybeSingle()
    if (errRiga) return letturaFallita(operazione, 'periodo', errRiga)
    if (!rigaLetta) return periodoNonTrovato()
    const riga = rigaLetta as unknown as PeriodoScrutinio
    const unita = { ...riga, ...patch } as PeriodoScrutinio
    const inizio = unita.data_inizio || null
    const fine = unita.data_fine || null
    const cambiano = inizio !== (riga.data_inizio || null) || fine !== (riga.data_fine || null)

    // Tutti i rifiuti PRIMA della scrittura, e solo se il corpo tocca le date: rinominare, riordinare o
    // archiviare un periodo non può essere bloccato da date che il corpo non nomina.
    if (dataInizio !== undefined || dataFine !== undefined) {
      const rifiutoDate = rifiutoSuLeDate(operazione, riga.scuola_id, inizio, fine)
      if (rifiutoDate) return rifiutoDate
    }
    if (cambiano) {
      const { data: chiusi, error: errChiusi } = await supabase
        .from('scrutini')
        .select('id')
        .eq('periodo_id', id)
        .eq('stato', 'chiuso')
        .limit(1)
      if (errChiusi) return letturaFallita(operazione, 'guardia_scrutini', errChiusi)
      if (chiusi && chiusi.length > 0) return rifiutoPeriodoConScrutiniChiusi(operazione, riga.scuola_id)
      if (inizio && fine) {
        const rifiutoSovrapposto = await rifiutoSuSovrapposizione(supabase, operazione, {
          id, scuolaId: riga.scuola_id, inizio, fine,
        })
        if (rifiutoSovrapposto) return rifiutoSovrapposto
      }
    }

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
    // 0 righe = il periodo è sparito fra la lettura e la scrittura (o non è del plesso): stesso 404.
    if (!data || data.length === 0) return periodoNonTrovato()
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
    let ricalcolo: Ricalcolo = 'non-necessario'
    if (cambiano) {
      logEvento('registro', 'info', { operazione, esito: 'periodo-date-modificate', scuola_id: riga.scuola_id, periodo_id: id })
      ricalcolo = await ricalcola(supabase, riga.scuola_id, operazione)
    }
    return NextResponse.json({ success: true, data: data[0], ricalcolo })
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
    // Si leggono anche sede e date: se il periodo copriva dei giorni, dopo l'eliminazione i voti si ricalcolano.
    const { data: periodo, error: errPeriodo } = await supabase
      .from('scrutinio_periodi')
      .select('id, scuola_id, data_inizio, data_fine')
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
    logEvento('registro', 'info', {
      operazione: 'admin/primaria/scrutinio-periodi:DELETE', esito: 'periodo-eliminato', periodo_id: id, scuola_id: periodo.scuola_id,
    })
    const ricalcolo: Ricalcolo = haEntrambeLeDate(periodo)
      ? await ricalcola(supabase, periodo.scuola_id, 'admin/primaria/scrutinio-periodi:DELETE')
      : 'non-necessario'
    return NextResponse.json({ success: true, ricalcolo })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/scrutinio-periodi:DELETE', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
