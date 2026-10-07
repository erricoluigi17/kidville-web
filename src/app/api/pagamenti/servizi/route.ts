import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione'
import { leggiABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'
import { rispostaServiziNonDisponibili } from '@/lib/pagamenti/generazione-server'
import { STATI_CODA_OCCUPATA } from '@/lib/pagamenti/fatturazione-riga'
import { meseDellaVoce } from '@/lib/pagamenti/selezione-voci'
import {
  attivaNel,
  periodiSovrapposti,
  periodoValido,
  primoDelMese,
  zMese,
  type PeriodoIscrizione,
} from '@/lib/pagamenti/servizi-mensili'

/**
 * ISCRIZIONI AI SERVIZI MENSILI (pomeridiano, doposcuola, pulmino…): chi è iscritto a quale
 * servizio, con quale importo e per quali mesi. Le VOCI le genera `genera-servizi` (e
 * `genera-rette`); qui si governa l'anagrafica delle iscrizioni.
 *
 *  · GET    elenco dei servizi mensili attivi e delle iscrizioni della sede;
 *  · POST   iscrive uno o più bambini (controllo delle sovrapposizioni PRIMA, insert semplice,
 *           `23P01` della EXCLUDE come rete di sicurezza per la gara fra due salvataggi);
 *  · PATCH  cambia importo e/o periodo;
 *  · DELETE elimina l'iscrizione.
 *
 * Mai upsert su `iscrizioni_servizi` (lock `onconflict-arbitro`): solo insert/update/delete.
 *
 * LA SEDE. Quella delle SCRITTURE (`resolveScuolaScrittura`), non `sedeDellaGenerazione`: questa
 * rifiuta la sede di collaudo, e qui gli E2E devono poter leggere la sede fittizia. Ogni
 * lettura e scrittura è filtrata `.eq('scuola_id', sede)`: un id indovinato di un'altra sede
 * risponde 404 e non viene mai toccato.
 *
 * FINE / ELIMINAZIONE IN DUE TEMPI (decisione del titolare). Accorciare o eliminare
 * un'iscrizione lascia, di solito, voci già generate per mesi che non sono più coperti. Cosa
 * farne lo decide la segreteria: senza `voci_future` la route NON scrive niente e risponde 409
 * `VOCI_FUTURE_DA_DECIDERE` con l'elenco (eliminabili / intoccabili); con `'elimina'` cancella
 * SOLO le eliminabili, con `'mantieni'` le lascia.
 *
 * «ELIMINABILE». La cancellazione di una voce singola (`DELETE /api/pagamenti/[id]`) non ha una
 * regola esplicita di «cancellabile»: rifiuta solo la fattura emessa e l'incasso di una
 * transazione di famiglia. Qui il gesto è di massa e silenzioso, quindi la regola è PIÙ
 * STRETTA e dichiarata: una voce è eliminabile solo se è `singolo` (le voci di un servizio
 * nascono tutte così; padre/split hanno rate o quote figlie e non si cancellano in blocco),
 * mai incassata (`importo_pagato = 0`, stato né `pagato` né `parziale`, nessuna riga in
 * `incassi`), mai fatturata (`fattura_aruba_id` nullo, `fattura_stato` nullo o
 * `non_richiesta`, nessuna riga in `fatture_emesse`) e fuori dalla coda fatture attiva. Tutto
 * il resto è «intoccabile» e viene elencato col motivo. La DELETE ripete le condizioni
 * verificabili nel filtro: una voce incassata fra il primo e il secondo tempo non si cancella.
 */

// Schema non ancora migrato (il DB degli E2E in CI non ha la tabella né le colonne):
// 42703 colonna, 42P01/PGRST205 tabella, PGRST204 colonna nella cache dello schema.
const SCHEMA_ASSENTE = new Set(['42703', '42P01', 'PGRST205', 'PGRST204'])
const schemaAssente = (e: unknown): boolean =>
  SCHEMA_ASSENTE.has(String((e as { code?: string } | null)?.code ?? ''))

/** Violazione dell'EXCLUDE sulle sovrapposizioni (gara fra due salvataggi). */
const SOVRAPPOSIZIONE_DB = '23P01'

const TIPI_VOCE = ['singolo', 'split', 'padre'] as const

/** Blocchi per le liste di id nell'URL di PostgREST: 1.000 uuid sforerebbero la lunghezza ammessa. */
const BLOCCO_ID = 100

const zScuolaOpzionale = z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional())

const zImporto = z
  .number()
  .gt(0, 'L’importo deve essere maggiore di zero')
  .max(99999.99, 'Importo troppo alto')
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Al massimo due decimali')

const zVociFuture = z.enum(['elimina', 'mantieni'])

const getQuerySchema = z.object({ scuola_id: zScuolaOpzionale })

const postBodySchema = z.object({
  scuola_id: zUuid,
  categoria_id: zUuid,
  alunno_ids: z
    .array(zUuid)
    .min(1, 'Seleziona almeno un bambino')
    .max(LIMITE_ELENCO_ALUNNI, 'Troppi bambini in una volta')
    .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, 'Bambini duplicati'),
  importo_mensile: zImporto,
  dal: zMese,
  al: zMese.nullish(),
})

const patchBodySchema = z
  .object({
    id: zUuid,
    scuola_id: zUuid,
    importo_mensile: zImporto.optional(),
    dal: zMese.optional(),
    al: zMese.nullable().optional(),
    voci_future: zVociFuture.optional(),
  })
  .refine((b) => b.importo_mensile !== undefined || b.dal !== undefined || b.al !== undefined, {
    message: 'Nessuna modifica richiesta',
  })

const deleteQuerySchema = z.object({
  id: zUuid,
  scuola_id: zUuid,
  voci_future: zVociFuture.optional(),
})

// ─── tipi di riga ───────────────────────────────────────────────────────────────────────────

interface Iscrizione {
  id: string
  alunno_id: string
  categoria_id: string
  scuola_id: string
  importo_mensile: number | string
  dal: string
  al: string | null
}

interface Voce {
  id: string
  tipo: string
  importo: number | string | null
  importo_pagato: number | string | null
  stato: string | null
  periodo_competenza: string | null
  scadenza: string | null
  fattura_stato: string | null
  fattura_aruba_id: string | null
  descrizione?: string | null
}

type MotivoIntoccabile = 'rateizzata' | 'pagata' | 'parziale' | 'incassi' | 'fatturata' | 'in_coda'

interface VoceElencata {
  id: string
  periodo: string | null
  importo: number
}

interface Classificazione {
  eliminabili: (VoceElencata & { voce: Voce })[]
  intoccabili: (VoceElencata & { motivo: MotivoIntoccabile })[]
}

// ─── piccoli aiuti ──────────────────────────────────────────────────────────────────────────

// Ogni risposta d'errore scrive il `codice` come LETTERALE nel punto in cui costruisce la
// risposta: il lock `errori-con-codice` non sa leggere un codice passato come variabile.
const letturaFallita = () =>
  NextResponse.json(
    { error: 'Non è stato possibile leggere i servizi mensili: riprova.', codice: 'SERVIZI_LETTURA_FALLITA' },
    { status: 500 },
  )

const scritturaFallita = () =>
  NextResponse.json(
    { error: 'Non è stato possibile salvare: riprova.', codice: 'SERVIZI_SCRITTURA_FALLITA' },
    { status: 500 },
  )

const sovrapposta = (extra: Record<string, unknown> = {}) =>
  NextResponse.json(
    { error: 'Esiste già un’iscrizione che si sovrappone a questo periodo.', codice: 'SERVIZIO_ISCRIZIONE_SOVRAPPOSTA', ...extra },
    { status: 409 },
  )

const periodoNonValido = () =>
  NextResponse.json({ error: 'Il periodo non è valido.', codice: 'SERVIZIO_PERIODO_NON_VALIDO' }, { status: 400 })

const iscrizioneNonTrovata = () =>
  NextResponse.json({ error: 'Iscrizione non trovata.', codice: 'ISCRIZIONE_SERVIZIO_NON_TROVATA' }, { status: 404 })

const num = (v: number | string | null | undefined): number => Number(v ?? 0)

function aBlocchi<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Il periodo dell'iscrizione come lo capiscono le regole pure ('YYYY-MM-01'). */
const periodoDi = (i: Pick<Iscrizione, 'dal' | 'al'>): PeriodoIscrizione => ({
  dal: primoDelMese(i.dal),
  al: i.al ? primoDelMese(i.al) : null,
})

/** Audit best-effort: PostgREST non lancia, l'errore torna nel risultato e si logga. */
async function audit(
  supabase: SupabaseClient,
  operazione: string,
  azione: string,
  utenteId: string,
  recordId: string | null,
  vecchio: unknown,
  nuovo: unknown,
): Promise<void> {
  try {
    const { error } = await supabase.from('registro_modifiche').insert({
      azione,
      tabella_interessata: 'iscrizioni_servizi',
      record_id: recordId,
      vecchio_valore: vecchio ?? null,
      nuovo_valore: nuovo ?? null,
      utente_id: utenteId,
    })
    if (error) logEvento('pagamento', 'error', { operazione, azione, esito: 'audit-non-scritto' }, error)
  } catch (e) {
    logEvento('pagamento', 'error', { operazione, azione, esito: 'audit-non-scritto' }, e)
  }
}

// ─── GET ────────────────────────────────────────────────────────────────────────────────────

// GET /api/pagamenti/servizi?scuola_id=  (staff)
export const GET = withRoute('pagamenti/servizi:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedeRes = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, q.data.scuola_id)
    if (sedeRes.response) return sedeRes.response
    const sede = sedeRes.scuolaId as string

    const nonDisponibile = (error: unknown) => {
      logEvento('pagamento', 'error', {
        operazione: 'pagamenti/servizi:GET', esito: 'servizi-non-disponibili', scuola_id: sede,
      }, error)
      return NextResponse.json({ success: true, data: { non_disponibile: true } })
    }

    const cat = await supabase
      .from('payment_categories')
      .select('id, nome, slug, scuola_id, importo_mensile_default')
      .eq('mensile', true)
      .eq('attivo', true)
      .or(`scuola_id.is.null,scuola_id.eq.${sede}`)
      .order('nome', { ascending: true })
    if (cat.error) {
      if (schemaAssente(cat.error)) return nonDisponibile(cat.error)
      logEvento('pagamento', 'error', {
        operazione: 'pagamenti/servizi:GET', esito: 'servizi-lettura-fallita', tipo: 'categorie', scuola_id: sede,
      }, cat.error)
      return letturaFallita()
    }

    // I nomi dei bambini servono all'interfaccia e viaggiano SOLO nella risposta: mai nei log.
    const lette = await leggiABlocchi<Record<string, unknown>>(() =>
      supabase
        .from('iscrizioni_servizi')
        .select('id, alunno_id, categoria_id, importo_mensile, dal, al, alunni(nome, cognome, classe_sezione, stato)')
        .eq('scuola_id', sede) as never,
    )
    if (!lette.ok) {
      if (lette.motivo === 'errore' && schemaAssente(lette.error)) return nonDisponibile(lette.error)
      logEvento('pagamento', 'error', {
        operazione: 'pagamenti/servizi:GET', esito: 'servizi-lettura-fallita', tipo: `iscrizioni-${lette.motivo}`,
        scuola_id: sede,
      }, lette.motivo === 'errore' ? lette.error : undefined)
      return letturaFallita()
    }

    const servizi = ((cat.data ?? []) as Record<string, unknown>[]).map((c) => ({
      id: c.id,
      nome: c.nome,
      slug: c.slug ?? null,
      scuola_id: c.scuola_id ?? null,
      importo_mensile_default: c.importo_mensile_default ?? null,
    }))
    const iscrizioni = lette.righe.map((r) => {
      const a = (Array.isArray(r.alunni) ? r.alunni[0] : r.alunni) as Record<string, unknown> | null | undefined
      return {
        id: r.id,
        alunno_id: r.alunno_id,
        categoria_id: r.categoria_id,
        importo_mensile: num(r.importo_mensile as number | string),
        dal: r.dal,
        al: r.al ?? null,
        alunno: {
          nome: a?.nome ?? null,
          cognome: a?.cognome ?? null,
          classe_sezione: a?.classe_sezione ?? null,
          stato: a?.stato ?? null,
        },
      }
    })

    return NextResponse.json({ success: true, data: { servizi, iscrizioni } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/servizi:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'SERVIZI_LETTURA_FALLITA' }, { status: 500 })
  }
})

// ─── POST ───────────────────────────────────────────────────────────────────────────────────

// POST /api/pagamenti/servizi  (staff) — iscrive uno o più bambini a un servizio
// Body: { scuola_id, categoria_id, alunno_ids, importo_mensile, dal: 'YYYY-MM', al?: 'YYYY-MM' | null }
export const POST = withRoute('pagamenti/servizi:POST', async (request: Request) => {
  const operazione = 'pagamenti/servizi:POST'
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const sedeRes = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, b.data.scuola_id)
    if (sedeRes.response) return sedeRes.response
    const sede = sedeRes.scuolaId as string

    // 1. Periodo coerente.
    const periodo: PeriodoIscrizione = {
      dal: primoDelMese(b.data.dal),
      al: b.data.al ? primoDelMese(b.data.al) : null,
    }
    if (!periodoValido(periodo)) {
      return periodoNonValido()
    }

    // 2. Il servizio: globale o della sede, mensile e attivo.
    const cat = await supabase
      .from('payment_categories')
      .select('id, mensile, attivo, scuola_id')
      .eq('id', b.data.categoria_id)
      .or(`scuola_id.is.null,scuola_id.eq.${sede}`)
      .maybeSingle()
    if (cat.error) {
      if (schemaAssente(cat.error)) {
        logEvento('pagamento', 'error', { operazione, esito: 'servizi-non-disponibili', scuola_id: sede }, cat.error)
        return rispostaServiziNonDisponibili()
      }
      logEvento('pagamento', 'error', {
        operazione, esito: 'servizi-lettura-fallita', tipo: 'categoria', scuola_id: sede,
      }, cat.error)
      return letturaFallita()
    }
    if (!cat.data) return NextResponse.json({ error: 'Servizio non trovato.', codice: 'SERVIZIO_NON_TROVATO' }, { status: 404 })
    const categoria = cat.data as { mensile?: boolean | null; attivo?: boolean | null }
    if (!categoria.mensile || !categoria.attivo) {
      return NextResponse.json({ error: 'Questa causale non è un servizio mensile attivo.', codice: 'SERVIZIO_NON_MENSILE' }, { status: 409 })
    }

    // 3. Tutti i bambini devono essere iscritti ALLA SEDE (a blocchi: l'elenco sta nell'URL).
    const validi = new Set<string>()
    for (const blocco of aBlocchi(b.data.alunno_ids, BLOCCO_ID)) {
      const { data, error } = await supabase
        .from('alunni')
        .select('id')
        .in('id', blocco)
        .eq('scuola_id', sede)
        .eq('stato', 'iscritto')
      if (error) {
        logEvento('pagamento', 'error', {
          operazione, esito: 'servizi-lettura-fallita', tipo: 'alunni', scuola_id: sede,
        }, error)
        return letturaFallita()
      }
      for (const a of (data ?? []) as { id: string }[]) validi.add(String(a.id).toLowerCase())
    }
    const nonValidi = b.data.alunno_ids.filter((id) => !validi.has(id.toLowerCase()))
    if (nonValidi.length > 0) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'iscrizioni-servizio-rifiutate', tipo: 'alunni-non-validi',
        scuola_id: sede, categoria_id: b.data.categoria_id, n: nonValidi.length,
      })
      return NextResponse.json(
        {
          error: 'Alcuni bambini non risultano iscritti a questa sede.',
          codice: 'SERVIZIO_ALUNNI_NON_VALIDI',
          alunno_ids: nonValidi,
        },
        { status: 400 },
      )
    }

    // 4. Sovrapposizioni con le iscrizioni esistenti dello stesso servizio (nessuna scrittura).
    const esistenti = await leggiABlocchi<Iscrizione>(() =>
      supabase
        .from('iscrizioni_servizi')
        .select('id, alunno_id, categoria_id, scuola_id, importo_mensile, dal, al')
        .eq('scuola_id', sede)
        .eq('categoria_id', b.data.categoria_id) as never,
    )
    if (!esistenti.ok) {
      if (esistenti.motivo === 'errore' && schemaAssente(esistenti.error)) {
        logEvento('pagamento', 'error', { operazione, esito: 'servizi-non-disponibili', scuola_id: sede }, esistenti.error)
        return rispostaServiziNonDisponibili()
      }
      logEvento('pagamento', 'error', {
        operazione, esito: 'servizi-lettura-fallita', tipo: `iscrizioni-${esistenti.motivo}`, scuola_id: sede,
      }, esistenti.motivo === 'errore' ? esistenti.error : undefined)
      return letturaFallita()
    }
    const richiesti = new Set(b.data.alunno_ids.map((x) => x.toLowerCase()))
    const inConflitto = new Set<string>()
    for (const e of esistenti.righe) {
      if (richiesti.has(String(e.alunno_id).toLowerCase()) && periodiSovrapposti(periodo, periodoDi(e))) {
        inConflitto.add(e.alunno_id)
      }
    }
    if (inConflitto.size > 0) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'iscrizioni-servizio-rifiutate', tipo: 'sovrapposte',
        scuola_id: sede, categoria_id: b.data.categoria_id, n: inConflitto.size,
      })
      return sovrapposta({ alunno_ids: [...inConflitto] })
    }

    // 5. Insert semplice (mai upsert). La EXCLUDE del database è la rete per la gara fra due salvataggi.
    const righe = b.data.alunno_ids.map((alunnoId) => ({
      alunno_id: alunnoId,
      categoria_id: b.data.categoria_id,
      scuola_id: sede,
      importo_mensile: b.data.importo_mensile,
      dal: periodo.dal,
      al: periodo.al,
      creato_da: auth.user.id,
    }))
    const ins = await supabase.from('iscrizioni_servizi').insert(righe).select('id')
    if (ins.error) {
      if (schemaAssente(ins.error)) {
        logEvento('pagamento', 'error', { operazione, esito: 'servizi-non-disponibili', scuola_id: sede }, ins.error)
        return rispostaServiziNonDisponibili()
      }
      if ((ins.error as { code?: string }).code === SOVRAPPOSIZIONE_DB) {
        logEvento('pagamento', 'warn', {
          operazione, esito: 'iscrizioni-servizio-rifiutate', tipo: 'sovrapposte-gara',
          scuola_id: sede, categoria_id: b.data.categoria_id, n: righe.length,
        }, ins.error)
        return sovrapposta()
      }
      logEvento('pagamento', 'error', {
        operazione, esito: 'iscrizioni-servizio-non-create', scuola_id: sede, categoria_id: b.data.categoria_id, n: righe.length,
      }, ins.error)
      return scritturaFallita()
    }
    const creati = ((ins.data ?? []) as { id: string }[]).map((r) => r.id)

    // 6. Audit + log del successo (mai nomi: uuid e conteggi).
    await audit(supabase, operazione, 'crea_iscrizioni_servizio', auth.user.id, null, null, {
      scuola_id: sede, categoria_id: b.data.categoria_id, importo_mensile: b.data.importo_mensile,
      dal: periodo.dal, al: periodo.al, n: righe.length, alunno_ids: b.data.alunno_ids, iscrizione_ids: creati,
    })
    logEvento('pagamento', 'info', {
      operazione, esito: 'iscrizioni-servizio-create', n: righe.length, categoria_id: b.data.categoria_id, scuola_id: sede,
    })
    return NextResponse.json({ success: true, data: { creati: righe.length, ids: creati } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'SERVIZI_SCRITTURA_FALLITA' }, { status: 500 })
  }
})

// ─── fine / modifica / eliminazione: le voci già generate ───────────────────────────────────

type EsitoClassifica =
  | { ok: true; classificazione: Classificazione }
  | { ok: false; response: NextResponse }

/**
 * Le voci di pagamento colpite dal cambio di periodo: stessa sede, stesso bambino, stesso
 * servizio, tipo singolo/split/padre, il cui mese (`meseDellaVoce`) era coperto dal periodo
 * VECCHIO e non lo è più dal NUOVO (`nuovo = null`: l'iscrizione sparisce, quindi tutte).
 * Poi le divide in eliminabili e intoccabili (vedi la regola in testa al file).
 *
 * Una lettura di sicurezza che fallisce (coda, fatture emesse, incassi) FERMA tutto: nel dubbio
 * non si cancella, e un 500 è meglio di una voce fatturata cancellata.
 */
async function classificaVoci(
  supabase: SupabaseClient,
  operazione: string,
  sede: string,
  iscr: Iscrizione,
  nuovo: PeriodoIscrizione | null,
): Promise<EsitoClassifica> {
  const vecchio = periodoDi(iscr)
  // Il periodo non cambia (modifica del solo importo): nessuna voce esce, niente da leggere.
  if (nuovo && nuovo.dal === vecchio.dal && nuovo.al === vecchio.al) {
    return { ok: true, classificazione: { eliminabili: [], intoccabili: [] } }
  }
  const lette = await leggiABlocchi<Voce>(() =>
    supabase
      .from('pagamenti')
      .select('id, tipo, importo, importo_pagato, stato, periodo_competenza, scadenza, fattura_stato, fattura_aruba_id, descrizione')
      .eq('scuola_id', sede)
      .eq('alunno_id', iscr.alunno_id)
      .eq('categoria_id', iscr.categoria_id)
      .in('tipo', [...TIPI_VOCE]) as never,
  )
  if (!lette.ok) {
    logEvento('pagamento', 'error', {
      operazione, esito: 'servizi-lettura-fallita', tipo: `voci-${lette.motivo}`, scuola_id: sede,
    }, lette.motivo === 'errore' ? lette.error : undefined)
    return { ok: false, response: letturaFallita() }
  }

  const interessate = lette.righe.filter((v) => {
    const mese = meseDellaVoce({ periodo_competenza: v.periodo_competenza, scadenza: v.scadenza })
    if (!mese) return false
    const periodo = `${mese}-01`
    return attivaNel(vecchio, periodo) && (nuovo === null || !attivaNel(nuovo, periodo))
  })
  if (interessate.length === 0) return { ok: true, classificazione: { eliminabili: [], intoccabili: [] } }

  // Letture di sicurezza sui soli candidati (poche decine di id al massimo).
  const candidati = interessate.filter((v) => v.tipo === 'singolo').map((v) => v.id)
  const conFattura = new Set<string>()
  const inCoda = new Set<string>()
  const conIncassi = new Set<string>()
  if (candidati.length > 0) {
    const [emesse, coda, incassi] = await Promise.all([
      supabase.from('fatture_emesse').select('pagamento_id').in('pagamento_id', candidati),
      supabase.from('fatture_coda').select('pagamento_id').in('pagamento_id', candidati).in('stato', [...STATI_CODA_OCCUPATA]),
      supabase.from('incassi').select('pagamento_id').in('pagamento_id', candidati),
    ])
    for (const [tipo, r] of [['fatture_emesse', emesse], ['fatture_coda', coda], ['incassi', incassi]] as const) {
      if (r.error) {
        logEvento('pagamento', 'error', {
          operazione, esito: 'servizi-lettura-fallita', tipo, scuola_id: sede,
        }, r.error)
        return { ok: false, response: letturaFallita() }
      }
    }
    for (const r of (emesse.data ?? []) as { pagamento_id: string }[]) conFattura.add(r.pagamento_id)
    for (const r of (coda.data ?? []) as { pagamento_id: string }[]) inCoda.add(r.pagamento_id)
    for (const r of (incassi.data ?? []) as { pagamento_id: string }[]) conIncassi.add(r.pagamento_id)
  }

  const classificazione: Classificazione = { eliminabili: [], intoccabili: [] }
  for (const v of interessate) {
    const base: VoceElencata = {
      id: v.id,
      periodo: meseDellaVoce({ periodo_competenza: v.periodo_competenza, scadenza: v.scadenza }),
      importo: num(v.importo),
    }
    let motivo: MotivoIntoccabile | null = null
    if (v.tipo !== 'singolo') motivo = 'rateizzata'
    else if (v.stato === 'pagato') motivo = 'pagata'
    else if (v.stato === 'parziale' || num(v.importo_pagato) > 0) motivo = 'parziale'
    else if (conIncassi.has(v.id)) motivo = 'incassi'
    else if (v.fattura_aruba_id || (v.fattura_stato && v.fattura_stato !== 'non_richiesta') || conFattura.has(v.id)) motivo = 'fatturata'
    else if (inCoda.has(v.id)) motivo = 'in_coda'
    if (motivo) classificazione.intoccabili.push({ ...base, motivo })
    else classificazione.eliminabili.push({ ...base, voce: v })
  }
  return { ok: true, classificazione }
}

/**
 * Il corpo comune di PATCH e DELETE dopo i controlli: decide se chiedere, cancella le voci
 * (se richiesto) e solo poi applica la scrittura sull'iscrizione.
 *
 * ORDINE DELLE SCRITTURE: prima le VOCI, poi l'ISCRIZIONE.
 *  · se la cancellazione delle voci fallisce, l'iscrizione non è stata toccata: la richiesta si
 *    può ripetere identica, e nulla è cambiato;
 *  · se invece si toccasse prima l'iscrizione e poi le voci fallissero, un secondo tentativo
 *    calcolerebbe le voci «interessate» dal periodo GIÀ accorciato e non le troverebbe più:
 *    le voci resterebbero orfane e nessuno verrebbe più a chiedere cosa farne;
 *  · se l'iscrizione fallisce dopo la cancellazione delle voci (rarissimo: gara con un altro
 *    salvataggio), il guasto è dichiarato nel log col conteggio, e il secondo tentativo è
 *    sicuro: le eliminabili non ci sono più, la finestra si ripresenta con le sole intoccabili
 *    (se non ne restano, nulla da chiedere) e l'iscrizione si applica. Il peggio è una voce
 *    mancante che la generazione, idempotente, ricrea.
 */
async function applicaConVoci(
  supabase: SupabaseClient,
  p: {
    operazione: string
    azione: string
    utenteId: string
    sede: string
    iscr: Iscrizione
    nuovo: PeriodoIscrizione | null
    vociFuture: 'elimina' | 'mantieni' | undefined
    /** La scrittura sull'iscrizione: ritorna l'errore, o `null` se riuscita. */
    scrivi: () => Promise<{ error: unknown; trovata: boolean }>
    nuovoValore: Record<string, unknown>
    vecchioValore: Record<string, unknown>
  },
): Promise<NextResponse> {
  const { operazione, sede, iscr } = p
  const cl = await classificaVoci(supabase, operazione, sede, iscr, p.nuovo)
  if (!cl.ok) return cl.response
  const { eliminabili, intoccabili } = cl.classificazione
  const interessate = eliminabili.length + intoccabili.length

  // Primo tempo: voci da decidere e nessuna scelta → NESSUNA scrittura.
  if (interessate > 0 && p.vociFuture === undefined) {
    logEvento('pagamento', 'info', {
      operazione, esito: 'voci-future-da-decidere', scuola_id: sede, iscrizione_id: iscr.id,
      n: eliminabili.length, intoccabili: intoccabili.length,
    })
    return NextResponse.json(
      {
        error: 'Ci sono voci già generate fuori dal nuovo periodo: scegli cosa farne.',
        codice: 'VOCI_FUTURE_DA_DECIDERE',
        data: {
          eliminabili: eliminabili.map(({ id, periodo, importo }) => ({ id, periodo, importo })),
          intoccabili: intoccabili.map(({ id, periodo, importo, motivo }) => ({ id, periodo, importo, motivo })),
        },
      },
      { status: 409 },
    )
  }

  // Secondo tempo: eventuale cancellazione delle sole eliminabili.
  let eliminate = 0
  if (p.vociFuture === 'elimina' && eliminabili.length > 0) {
    const ids = eliminabili.map((v) => v.id)
    // Le condizioni di sicurezza si RIPETONO nel filtro: una voce incassata, fatturata o
    // trasformata fra il primo e il secondo tempo non corrisponde più e non si cancella.
    const del = await supabase
      .from('pagamenti')
      .delete()
      .in('id', ids)
      .eq('scuola_id', sede)
      .eq('tipo', 'singolo')
      .eq('importo_pagato', 0)
      .neq('stato', 'pagato')
      .neq('stato', 'parziale')
      .is('fattura_aruba_id', null)
      .or('fattura_stato.is.null,fattura_stato.eq.non_richiesta')
      .select('id')
    if (del.error) {
      logEvento('pagamento', 'error', {
        operazione, esito: 'voci-servizio-non-eliminate', scuola_id: sede, iscrizione_id: iscr.id, n: ids.length,
      }, del.error)
      return scritturaFallita()
    }
    const cancellate = new Set(((del.data ?? []) as { id: string }[]).map((r) => r.id))
    eliminate = cancellate.size
    if (eliminate > 0) {
      await audit(supabase, operazione, 'elimina_voci_servizio', p.utenteId, iscr.id,
        {
          voci: eliminabili
            .filter((v) => cancellate.has(v.id))
            .map((v) => ({
              id: v.id, periodo: v.periodo, importo: v.importo,
              scadenza: v.voce.scadenza, descrizione: v.voce.descrizione ?? null,
            })),
        },
        { scuola_id: sede, iscrizione_id: iscr.id, voci_eliminate: eliminate },
      )
    }
  }

  // Poi l'iscrizione.
  const esito = await p.scrivi()
  if (esito.error) {
    if (schemaAssente(esito.error)) {
      logEvento('pagamento', 'error', { operazione, esito: 'servizi-non-disponibili', scuola_id: sede }, esito.error)
      return rispostaServiziNonDisponibili()
    }
    if ((esito.error as { code?: string }).code === SOVRAPPOSIZIONE_DB) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'iscrizione-servizio-sovrapposta-gara', scuola_id: sede, iscrizione_id: iscr.id, voci_eliminate: eliminate,
      }, esito.error)
      return sovrapposta()
    }
    logEvento('pagamento', 'error', {
      operazione, esito: 'iscrizione-servizio-non-scritta', scuola_id: sede, iscrizione_id: iscr.id,
      voci_eliminate: eliminate, // se > 0 le voci sono già state cancellate: va detto
    }, esito.error)
    return scritturaFallita()
  }
  if (!esito.trovata) {
    logEvento('pagamento', 'warn', {
      operazione, esito: 'iscrizione-servizio-sparita', scuola_id: sede, iscrizione_id: iscr.id, voci_eliminate: eliminate,
    })
    return iscrizioneNonTrovata()
  }

  const mantenute = eliminabili.length - eliminate
  await audit(supabase, operazione, p.azione, p.utenteId, iscr.id, p.vecchioValore, {
    ...p.nuovoValore, voci_eliminate: eliminate, voci_mantenute: mantenute, intoccabili: intoccabili.length,
  })
  logEvento('pagamento', 'info', {
    operazione, esito: p.azione === 'elimina_iscrizione_servizio' ? 'iscrizione-servizio-eliminata' : 'iscrizione-servizio-aggiornata',
    scuola_id: sede, categoria_id: iscr.categoria_id, iscrizione_id: iscr.id,
    voci_eliminate: eliminate, voci_mantenute: mantenute, intoccabili: intoccabili.length,
  })
  return NextResponse.json({
    success: true,
    data: { voci_eliminate: eliminate, voci_mantenute: mantenute, intoccabili: intoccabili.length },
  })
}

/** Legge l'iscrizione della SEDE: 404 se non c'è (anche per l'id di un'altra sede). */
async function leggiIscrizione(
  supabase: SupabaseClient,
  operazione: string,
  id: string,
  sede: string,
): Promise<{ iscr: Iscrizione } | { response: NextResponse }> {
  const { data, error } = await supabase
    .from('iscrizioni_servizi')
    .select('id, alunno_id, categoria_id, scuola_id, importo_mensile, dal, al')
    .eq('id', id)
    .eq('scuola_id', sede)
    .maybeSingle()
  if (error) {
    if (schemaAssente(error)) {
      logEvento('pagamento', 'error', { operazione, esito: 'servizi-non-disponibili', scuola_id: sede }, error)
      return { response: rispostaServiziNonDisponibili() }
    }
    logEvento('pagamento', 'error', {
      operazione, esito: 'servizi-lettura-fallita', tipo: 'iscrizione', scuola_id: sede,
    }, error)
    return { response: letturaFallita() }
  }
  if (!data) {
    return { response: iscrizioneNonTrovata() }
  }
  return { iscr: data as Iscrizione }
}

// ─── PATCH ──────────────────────────────────────────────────────────────────────────────────

// PATCH /api/pagamenti/servizi  (staff)
// Body: { id, scuola_id, importo_mensile?, dal?, al? (string | null), voci_future?: 'elimina' | 'mantieni' }
export const PATCH = withRoute('pagamenti/servizi:PATCH', async (request: Request) => {
  const operazione = 'pagamenti/servizi:PATCH'
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const sedeRes = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, b.data.scuola_id)
    if (sedeRes.response) return sedeRes.response
    const sede = sedeRes.scuolaId as string

    const letta = await leggiIscrizione(supabase, operazione, b.data.id, sede)
    if ('response' in letta) return letta.response
    const iscr = letta.iscr

    const nuovo: PeriodoIscrizione = {
      dal: b.data.dal !== undefined ? primoDelMese(b.data.dal) : primoDelMese(iscr.dal),
      al: b.data.al === undefined ? (iscr.al ? primoDelMese(iscr.al) : null) : b.data.al === null ? null : primoDelMese(b.data.al),
    }
    if (!periodoValido(nuovo)) {
      return periodoNonValido()
    }
    const vecchio = periodoDi(iscr)
    const periodoCambiato = nuovo.dal !== vecchio.dal || nuovo.al !== vecchio.al

    // Il nuovo periodo non deve toccare le ALTRE iscrizioni dello stesso bambino allo stesso servizio.
    if (periodoCambiato) {
      const { data: altre, error: errAltre } = await supabase
        .from('iscrizioni_servizi')
        .select('id, dal, al')
        .eq('scuola_id', sede)
        .eq('alunno_id', iscr.alunno_id)
        .eq('categoria_id', iscr.categoria_id)
        .neq('id', iscr.id)
      if (errAltre) {
        logEvento('pagamento', 'error', {
          operazione, esito: 'servizi-lettura-fallita', tipo: 'iscrizioni', scuola_id: sede,
        }, errAltre)
        return letturaFallita()
      }
      if (((altre ?? []) as Iscrizione[]).some((o) => periodiSovrapposti(nuovo, periodoDi(o)))) {
        logEvento('pagamento', 'warn', {
          operazione, esito: 'iscrizioni-servizio-rifiutate', tipo: 'sovrapposte', scuola_id: sede, iscrizione_id: iscr.id,
        })
        return sovrapposta()
      }
    }

    const patch: Record<string, unknown> = {}
    if (b.data.importo_mensile !== undefined) patch.importo_mensile = b.data.importo_mensile
    if (b.data.dal !== undefined) patch.dal = nuovo.dal
    if (b.data.al !== undefined) patch.al = nuovo.al

    return await applicaConVoci(supabase, {
      operazione,
      azione: 'modifica_iscrizione_servizio',
      utenteId: auth.user.id,
      sede,
      iscr,
      // Cambia solo l'importo: nessuna voce esce dal periodo, non c'è nulla da chiedere.
      nuovo: periodoCambiato ? nuovo : vecchio,
      vociFuture: b.data.voci_future,
      scrivi: async () => {
        const r = await supabase
          .from('iscrizioni_servizi')
          .update(patch)
          .eq('id', iscr.id)
          .eq('scuola_id', sede)
          .select('id')
        return { error: r.error, trovata: ((r.data ?? []) as unknown[]).length > 0 }
      },
      vecchioValore: { importo_mensile: num(iscr.importo_mensile), dal: iscr.dal, al: iscr.al },
      nuovoValore: { scuola_id: sede, ...patch },
    })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'SERVIZI_SCRITTURA_FALLITA' }, { status: 500 })
  }
})

// ─── DELETE ─────────────────────────────────────────────────────────────────────────────────

// DELETE /api/pagamenti/servizi?id=&scuola_id=&voci_future=  (staff)
export const DELETE = withRoute('pagamenti/servizi:DELETE', async (request: Request) => {
  const operazione = 'pagamenti/servizi:DELETE'
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedeRes = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, q.data.scuola_id)
    if (sedeRes.response) return sedeRes.response
    const sede = sedeRes.scuolaId as string

    const letta = await leggiIscrizione(supabase, operazione, q.data.id, sede)
    if ('response' in letta) return letta.response
    const iscr = letta.iscr

    return await applicaConVoci(supabase, {
      operazione,
      azione: 'elimina_iscrizione_servizio',
      utenteId: auth.user.id,
      sede,
      iscr,
      nuovo: null, // l'iscrizione sparisce: interessate sono TUTTE le voci del suo periodo
      vociFuture: q.data.voci_future,
      scrivi: async () => {
        const r = await supabase
          .from('iscrizioni_servizi')
          .delete()
          .eq('id', iscr.id)
          .eq('scuola_id', sede)
          .select('id')
        return { error: r.error, trovata: ((r.data ?? []) as unknown[]).length > 0 }
      },
      vecchioValore: {
        alunno_id: iscr.alunno_id, categoria_id: iscr.categoria_id, importo_mensile: num(iscr.importo_mensile),
        dal: iscr.dal, al: iscr.al,
      },
      nuovoValore: { scuola_id: sede },
    })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'SERVIZI_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
