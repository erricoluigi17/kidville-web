import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { formaConfronto, resolveScuoleAttive } from '@/lib/auth/scope'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
// I tetti si IMPORTANO, non si riscrivono (vedi `riconciliazione/[id]/componi`).
import {
  MAX_QUANTITA_TICKET,
  MAX_IMPORTO_EURO,
  MAX_RIGHE_PER_ELENCO,
  MAX_RIGHE_TOTALI,
} from '@/lib/pagamenti/conciliazione-registra'

// ─── Transazione unica di famiglia (slice S4 — Contabilità v2) ────────────────
// UN pagamento (bonifico/POS/…) che salda più voci di più figli, ricarica la
// mensa e — con conferma esplicita — accredita l'eccedenza a credito famiglia.
// L'atomicità è dell'RPC SECURITY DEFINER `registra_transazione_contabile(p jsonb)`
// (service-role): la route valida quadratura + eccedenza e delega la scrittura.
//
// ─── DIVISIONE PER SEDE (K4, 2026-09-26) ─────────────────────────────────────
// Decisione del titolare: una famiglia con figli in plessi diversi paga voci di
// più sedi in UNA operazione. Ogni sede ha la propria numerazione di ricevute,
// quindi il documento resta UNO PER SEDE: la route divide l'operazione in una
// transazione per sede e la consegna a `registra_transazioni_per_sede(p jsonb)`,
// che le scrive tutte o nessuna (migrazione 20260926100100).
//
// LA SEDE NON VIENE PIÙ DAL CLIENT. Ogni parte porta la sua, letta dal dato:
//   · voce esistente  → `pagamenti.scuola_id`
//   · voce nuova, voce ticket, ricarica mensa → `alunni.scuola_id`
// e tutte devono stare fra le sedi attive dell'operatore (403 altrimenti).
// Fino a oggi la ricarica mensa finiva nella sede DICHIARATA dal client: il
// saldo ticket di un alunno di Aversa poteva essere incassato su Giugliano.
//
// Con una sede sola il percorso è quello storico, carattere per carattere: stessa
// RPC, stesso payload.

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * «Ha al più due decimali», sul valore e non sulla stringa (stessa misura di
 * `componi`): oltre i due decimali il conto del browser e quello di PostgreSQL
 * divergono di un centesimo sull'importo del ticket.
 */
const dueDecimali = (v: number) =>
  Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6

const zData = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (atteso YYYY-MM-DD)')

const voceSchema = z.object({
  pagamento_id: zUuid,
  importo: z.coerce.number().positive('importo voce deve essere > 0'),
})
const ricaricaSchema = z.object({
  alunno_id: zUuid,
  // importo in EURO (per la quadratura), ticket INTERO (per il saldo mensa).
  importo: z.coerce.number().positive('importo ricarica deve essere > 0'),
  ticket: z.coerce.number().int().positive('ticket ricarica deve essere > 0'),
})
// Stesse forme di `riconciliazione/[id]/componi`: il payload è quello della
// stessa RPC, e la RPC le valida di nuovo prima di scrivere.
const voceNuovaSchema = z.object({
  alunno_id: zUuid,
  categoria_id: zUuid,
  descrizione: z.string().trim().min(1, 'descrizione obbligatoria').max(200),
  importo: z.coerce.number().positive('importo deve essere > 0').max(MAX_IMPORTO_EURO),
  scadenza: zData,
  gruppo: z.string().trim().max(80).nullish(),
})
const voceTicketSchema = z.object({
  alunno_id: zUuid,
  quantita: z.coerce
    .number()
    .int('quantita deve essere un intero')
    .positive('quantita deve essere > 0')
    .max(MAX_QUANTITA_TICKET, 'quantita oltre il massimo consentito'),
  costo_unitario: z.coerce
    .number()
    .positive('costo_unitario deve essere > 0')
    .max(MAX_IMPORTO_EURO)
    .refine(dueDecimali, 'costo_unitario ammette al massimo due decimali'),
  categoria_id: zUuid.nullish(),
  scadenza: zData.nullish(),
  gruppo: z.string().trim().max(80).nullish(),
})

const postBodySchema = z
  .object({
    pagante_parent_id: zUuid,
    // Facoltativo dal 2026-09-26: le sedi si ricavano dalle voci. Se il client lo
    // manda ancora, deve almeno essere una sede ACCESSIBILE (403 altrimenti), ma
    // non decide più dove finisce niente.
    scuola_id: zUuid.optional(),
    metodo: z.string().min(1, 'metodo obbligatorio'),
    riferimento: z.string().nullish(),
    data_valuta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data valuta non valida (atteso YYYY-MM-DD)').nullish(),
    note: z.string().nullish(),
    importo_totale: z.coerce.number().positive('importo_totale deve essere > 0'),
    // `voci` e `ricariche_mensa` restano SENZA tetto, come prima del 26/09: un
    // pagamento a una sede deve comportarsi come ieri. I tetti di `componi`
    // valgono solo sui due elenchi nuovi, che hanno la sua stessa forma.
    voci: z.array(voceSchema).default([]),
    ricariche_mensa: z.array(ricaricaSchema).default([]),
    voci_nuove: z.array(voceNuovaSchema).max(MAX_RIGHE_PER_ELENCO).default([]),
    voci_ticket: z.array(voceTicketSchema).max(MAX_RIGHE_PER_ELENCO).default([]),
    eccedenza_a_credito: z.coerce.number().min(0, 'eccedenza non può essere negativa').default(0),
    // L'eccedenza non è MAI silenziosa: senza questa conferma un'eccedenza > 0 dà 409.
    conferma_eccedenza: z.enum(['credito_famiglia']).optional(),
    // Con più sedi l'operatore sceglie dove va il credito famiglia (422 se manca).
    sede_eccedenza: zUuid.optional(),
    // Letto SOLO per rifiutarlo con più sedi (422); con una sede si ignora come
    // prima. Non entra mai nel payload della RPC (vedi sotto).
    movimento_id: zUuid.optional(),
  })
  .superRefine((b, ctx) => {
    // Tetto complessivo solo sulle righe NUOVE (le stesse di `componi`).
    const righe = b.voci_nuove.length + b.voci_ticket.length
    if (righe > MAX_RIGHE_TOTALI) {
      ctx.addIssue({ code: 'custom', path: ['voci_nuove'], message: `troppe righe nuove: massimo ${MAX_RIGHE_TOTALI}` })
    }
  })

type Corpo = z.infer<typeof postBodySchema>

const getQuerySchema = z.object({
  parent_id: zUuid.optional(),
})

/** Codici che indicano RPC assente (DB E2E CI non migrato) → 503 pulito. */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
/** Tabella nuova assente → degradazione lettura. */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

const UUID_NULLO = '00000000-0000-0000-0000-000000000000'

// Le risposte d'errore senza `codice` sono un debito congelato (lock
// `errori-con-codice`): i due rifiuti che si ripetono passano da qui, UNA volta.
/** 400 — l'allocato non pareggia il totale (prima o dopo la divisione per sede). */
const quadraturaFallita = (totale: number, allocato: number, eccedenza: number) =>
  NextResponse.json(
    { error: 'Quadratura fallita: l\'allocato non pareggia il totale.', totale, allocato, eccedenza },
    { status: 400 },
  )
/** 500 — la lettura delle sedi di voci o alunni non è riuscita: mai un permesso. */
const verificaNonRiuscita = () =>
  NextResponse.json({ error: 'Verifica delle voci non riuscita' }, { status: 500 })

/** Nomi delle sedi per id. Un guasto qui non blocca niente: il nome è un'etichetta. */
async function nomiSedi(
  supabase: SupabaseClient,
  ids: string[],
  operazione: string,
): Promise<Map<string, string | null>> {
  const mappa = new Map<string, string | null>()
  if (ids.length === 0) return mappa
  const { data, error } = await supabase.from('scuole').select('id, nome').in('id', ids)
  if (error) {
    logEvento('pagamento', 'warn', { operazione, esito: 'nomi-sede-non-letti' }, error)
    return mappa
  }
  for (const s of (data ?? []) as { id: string; nome?: string | null }[]) {
    mappa.set(formaConfronto(s.id), s.nome ?? null)
  }
  return mappa
}

// GET /api/pagamenti/transazioni?parent_id=  (staff) — registro transazioni.
// Scope di sede come le altre route staff; parent_id opzionale. Ogni riga porta
// `scuola_nome` e `pagante_nome` (nome e cognome del genitore) per le colonne
// Sede e Pagante del registro, ora che le sedi possono essere più d'una.
export const GET = withRoute('pagamenti/transazioni:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)

    let query = supabase
      .from('pagamenti_transazioni')
      .select('id, scuola_id, pagante_parent_id, importo_totale, metodo, riferimento, data_valuta, note, annullata_il, annullo_motivo, creato_il, registrato_da')
      .in('scuola_id', sedi.length ? sedi : [UUID_NULLO])
      .order('creato_il', { ascending: false })
      .limit(200)
    if (q.data.parent_id) query = query.eq('pagante_parent_id', q.data.parent_id)

    const { data, error } = await query
    if (error) {
      // Tabella assente sul DB non migrato: degrada in modo pulito.
      if (TABELLA_ASSENTE.has((error as { code?: string }).code ?? '')) {
        return NextResponse.json({ success: true, data: [], disponibile: false })
      }
      logErrore({ operazione: 'pagamenti/transazioni:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle transazioni', details: error.message }, { status: 500 })
    }

    const righe = (data ?? []) as ({ scuola_id?: string | null; pagante_parent_id?: string | null } & Record<string, unknown>)[]
    const idSedi = [...new Set(righe.map((r) => r.scuola_id).filter((x): x is string => !!x))]
    const idPaganti = [...new Set(righe.map((r) => r.pagante_parent_id).filter((x): x is string => !!x))]

    const [nomi, paganti] = await Promise.all([
      nomiSedi(supabase, idSedi, 'pagamenti/transazioni:GET'),
      (async () => {
        const mappa = new Map<string, string | null>()
        if (idPaganti.length === 0) return mappa
        const { data: par, error: errPar } = await supabase
          .from('parents')
          .select('id, first_name, last_name')
          .in('id', idPaganti)
        // Il registro resta leggibile anche senza il nome: si logga e si degrada.
        if (errPar) {
          logEvento('pagamento', 'warn', { operazione: 'pagamenti/transazioni:GET', esito: 'paganti-non-letti' }, errPar)
          return mappa
        }
        for (const p of (par ?? []) as { id: string; first_name?: string | null; last_name?: string | null }[]) {
          const nome = [p.first_name, p.last_name].filter(Boolean).join(' ')
          mappa.set(p.id, nome || null)
        }
        return mappa
      })(),
    ])

    const arricchite = righe.map((r) => ({
      ...r,
      scuola_nome: r.scuola_id ? nomi.get(formaConfronto(r.scuola_id)) ?? null : null,
      pagante_nome: r.pagante_parent_id ? paganti.get(r.pagante_parent_id) ?? null : null,
    }))
    return NextResponse.json({ success: true, data: arricchite, disponibile: true })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

/** Il payload di `registra_transazione_contabile` per UNA sede. */
interface PayloadSede {
  pagante_parent_id: string
  scuola_id: string
  metodo: string
  riferimento: string | null
  data_valuta: string | null
  note: string | null
  importo_totale: number
  voci: { pagamento_id: string; importo: number }[]
  ricariche_mensa: { alunno_id: string; importo: number; ticket: number }[]
  voci_nuove?: Corpo['voci_nuove']
  voci_ticket?: Corpo['voci_ticket']
  eccedenza_a_credito: number
  registrato_da: string
}

/** Una sede dell'operazione, con le sue parti e i suoi alunni (per le notifiche). */
interface Gruppo {
  scuola_id: string
  voci: PayloadSede['voci']
  ricariche_mensa: PayloadSede['ricariche_mensa']
  voci_nuove: Corpo['voci_nuove']
  voci_ticket: Corpo['voci_ticket']
  alunni: Set<string>
  somma: number
}

interface EsitoRpc {
  transazione_id?: string
  incassi?: number
  ricariche?: number
  eccedenza?: number
  [k: string]: unknown
}

/** Importo di una riga ticket: la stessa espressione della RPC (`round(q × c, 2)`). */
const importoTicket = (t: { quantita: number; costo_unitario: number }) => round2(t.quantita * t.costo_unitario)

// POST /api/pagamenti/transazioni  (staff) — registra una transazione unica,
// divisa per sede quando le voci stanno in plessi diversi.
// Valida la quadratura (Σ parti + eccedenza = totale) e il gate eccedenza (409
// senza conferma), ricava le sedi dal dato, poi delega alla RPC atomica.
export const POST = withRoute('pagamenti/transazioni:POST', async (request: Request) => {
  const OP = 'pagamenti/transazioni:POST'
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const totale = round2(body.importo_totale)
    const sommaVoci = round2(body.voci.reduce((s, v) => s + Number(v.importo), 0))
    const sommaRicariche = round2(body.ricariche_mensa.reduce((s, r) => s + Number(r.importo), 0))
    const sommaNuove = round2(body.voci_nuove.reduce((s, v) => s + Number(v.importo), 0))
    const sommaTicket = round2(body.voci_ticket.reduce((s, t) => s + importoTicket(t), 0))
    const eccedenza = round2(body.eccedenza_a_credito)

    if (body.voci.length + body.ricariche_mensa.length + body.voci_nuove.length + body.voci_ticket.length === 0) {
      return NextResponse.json({ error: 'La transazione deve avere almeno una voce o una ricarica mensa.' }, { status: 400 })
    }

    // Quadratura: il totale dichiarato deve pareggiare l'allocato + l'eccedenza.
    const allocato = round2(sommaVoci + sommaRicariche + sommaNuove + sommaTicket)
    if (round2(allocato + eccedenza) !== totale) return quadraturaFallita(totale, allocato, eccedenza)

    // Eccedenza mai silenziosa: serve la conferma esplicita «credito famiglia».
    if (eccedenza > 0.005 && body.conferma_eccedenza !== 'credito_famiglia') {
      return NextResponse.json(
        { error: 'C\'è un\'eccedenza da confermare come credito famiglia o da riallocare.', eccedenza },
        { status: 409 },
      )
    }

    const supabase = await createAdminClient()

    // Scope di sede: le sedi attive dell'operatore sono il confine di TUTTO.
    const sediAttive = await resolveScuoleAttive(request as NextRequest, supabase, user)
    const attive = new Map(sediAttive.map((s) => [formaConfronto(s), s]))
    if (body.scuola_id && !attive.has(formaConfronto(body.scuola_id))) {
      return rifiutoSede('SEDE_NON_ACCESSIBILE')
    }

    // ── Sede delle voci esistenti: `pagamenti.scuola_id` ─────────────────────
    // LA SEDE DEL CONTENITORE NON BASTA: vanno controllate le VOCI. Fino al
    // 2026-07-31 si validava soltanto `body.scuola_id`, e il collaudo backend
    // incassò davvero una retta di Giugliano su una transazione di Aversa.
    // Dal 2026-09-26 la sede della voce non è più confrontata con quella
    // dichiarata: È la sede della sua transazione. Il confine resta lo scope.
    const idVoci = [...new Set(body.voci.map((v) => v.pagamento_id))]
    const sedeVoce = new Map<string, { sede: string; alunno: string | null }>()
    if (idVoci.length > 0) {
      const { data: pagamentiVoci, error: errVoci } = await supabase
        .from('pagamenti')
        .select('id, scuola_id, alunno_id')
        .in('id', idVoci)
      // PostgREST non lancia: senza questo controllo un errore di lettura
      // diventerebbe «nessuna voce fuori sede», cioè un permesso.
      if (errVoci) {
        logErrore({ operazione: OP, stato: 500, evento: 'db' }, errVoci)
        return verificaNonRiuscita()
      }
      for (const p of (pagamentiVoci ?? []) as { id: string; scuola_id?: string | null; alunno_id?: string | null }[]) {
        const sede = p.scuola_id ? attive.get(formaConfronto(p.scuola_id)) : undefined
        if (sede) sedeVoce.set(formaConfronto(p.id), { sede, alunno: p.alunno_id ?? null })
      }
      const estranee = idVoci.filter((id) => !sedeVoce.has(formaConfronto(id)))
      if (estranee.length > 0) {
        logEvento('pagamento', 'warn', {
          operazione: OP,
          esito: 'voci-fuori-sede',
          tipo: 'voci-fuori-sede',
          n: estranee.length,
        })
        // Nessun id nel corpo: dire QUALI sono confermerebbe l'esistenza di
        // pagamenti di un altro plesso a chi non ha titolo per saperlo.
        return NextResponse.json(
          { error: 'Una o più voci appartengono a un altro plesso' },
          { status: 403 },
        )
      }
    }

    // ── Sede di ricariche, voci nuove e ticket: `alunni.scuola_id` ───────────
    const idAlunni = [...new Set([
      ...body.ricariche_mensa.map((r) => r.alunno_id),
      ...body.voci_nuove.map((v) => v.alunno_id),
      ...body.voci_ticket.map((t) => t.alunno_id),
    ])]
    const sedeAlunno = new Map<string, string>()
    if (idAlunni.length > 0) {
      const { data: alunniRows, error: errAlunni } = await supabase
        .from('alunni')
        .select('id, scuola_id')
        .in('id', idAlunni)
      if (errAlunni) {
        logErrore({ operazione: OP, stato: 500, evento: 'db' }, errAlunni)
        return verificaNonRiuscita()
      }
      for (const a of (alunniRows ?? []) as { id: string; scuola_id?: string | null }[]) {
        const sede = a.scuola_id ? attive.get(formaConfronto(a.scuola_id)) : undefined
        if (sede) sedeAlunno.set(formaConfronto(a.id), sede)
      }
      const estranei = idAlunni.filter((id) => !sedeAlunno.has(formaConfronto(id)))
      if (estranei.length > 0) {
        logEvento('pagamento', 'warn', {
          operazione: OP,
          esito: 'alunni-fuori-sede',
          tipo: 'alunni-fuori-sede',
          n: estranei.length,
        })
        // Stesso rifiuto di una sede dichiarata fuori scope, col suo codice
        // traducibile; nessun id nel corpo.
        return rifiutoSede('SEDE_NON_ACCESSIBILE')
      }
    }

    // ── Divisione: un gruppo per sede, nell'ordine in cui le sedi compaiono ──
    const gruppi = new Map<string, Gruppo>()
    const gruppo = (sede: string): Gruppo => {
      const k = formaConfronto(sede)
      let g = gruppi.get(k)
      if (!g) {
        g = { scuola_id: sede, voci: [], ricariche_mensa: [], voci_nuove: [], voci_ticket: [], alunni: new Set(), somma: 0 }
        gruppi.set(k, g)
      }
      return g
    }
    for (const v of body.voci) {
      const info = sedeVoce.get(formaConfronto(v.pagamento_id))!
      const g = gruppo(info.sede)
      const importo = round2(v.importo)
      g.voci.push({ pagamento_id: v.pagamento_id, importo })
      g.somma += importo
      if (info.alunno) g.alunni.add(info.alunno)
    }
    for (const v of body.voci_nuove) {
      const g = gruppo(sedeAlunno.get(formaConfronto(v.alunno_id))!)
      g.voci_nuove.push(v)
      g.somma += round2(v.importo)
      g.alunni.add(v.alunno_id)
    }
    for (const t of body.voci_ticket) {
      const g = gruppo(sedeAlunno.get(formaConfronto(t.alunno_id))!)
      g.voci_ticket.push(t)
      g.somma += importoTicket(t)
      g.alunni.add(t.alunno_id)
    }
    for (const r of body.ricariche_mensa) {
      // La ricarica va nella sede dell'ALUNNO, mai in quella dichiarata dal client.
      const g = gruppo(sedeAlunno.get(formaConfronto(r.alunno_id))!)
      const importo = round2(r.importo)
      g.ricariche_mensa.push({ alunno_id: r.alunno_id, importo, ticket: r.ticket })
      g.somma += importo
      g.alunni.add(r.alunno_id)
    }
    const elenco = [...gruppi.values()]
    const nSedi = elenco.length

    // ── Movimento bancario: questa rotta non lo lega MAI ─────────────────────
    // Il legame col movimento passa da `riconciliazione/[id]/componi`, che ha i
    // gate che la RPC da sola non ha (`puoConfermare`, fatture vive, importo del
    // bonifico): `movimento_id` non entra in nessun payload.
    // · più sedi → 422 (contratto K4): il movimento è UNO e non si divide;
    // · una sede → comportamento storico: il campo si ignora e il pagamento si
    //   registra come prima (zod lo scartava in silenzio; ora almeno lo si logga).
    if (body.movimento_id) {
      if (nSedi > 1) {
        return NextResponse.json(
          {
            error: 'Un movimento bancario non si divide fra più sedi: registra il pagamento senza movimento, oppure concilialo da Riconciliazione. Nessun pagamento è stato registrato.',
            codice: 'MOVIMENTO_PIU_SEDI',
          },
          { status: 422 },
        )
      }
      logEvento('pagamento', 'info', { operazione: OP, esito: 'movimento-ignorato', sedi: nSedi })
    }

    // ── Eccedenza: su quale sede ──────────────────────────────────────────────
    let sedeEcc: string | null = null
    if (eccedenza > 0.005) {
      if (body.sede_eccedenza) {
        const scelta = gruppi.get(formaConfronto(body.sede_eccedenza))
        if (!scelta) {
          return NextResponse.json(
            { error: 'La sede del credito famiglia deve essere una delle sedi di questo pagamento. Nessun pagamento è stato registrato.', codice: 'SEDE_ECCEDENZA_ESTRANEA' },
            { status: 422 },
          )
        }
        sedeEcc = scelta.scuola_id
      } else if (nSedi > 1) {
        return NextResponse.json(
          { error: 'Il pagamento riguarda più sedi: scegli su quale sede registrare il credito famiglia. Nessun pagamento è stato registrato.', codice: 'SEDE_ECCEDENZA_MANCANTE' },
          { status: 422 },
        )
      } else {
        sedeEcc = elenco[0].scuola_id
      }
    }

    // ── Payload per sede, e la quadratura rifatta su OGNI transazione ────────
    const payloads: PayloadSede[] = elenco.map((g) => {
      const ecc = g.scuola_id === sedeEcc ? eccedenza : 0
      const p: PayloadSede = {
        pagante_parent_id: body.pagante_parent_id,
        scuola_id: g.scuola_id,
        metodo: body.metodo,
        riferimento: body.riferimento ?? null,
        data_valuta: body.data_valuta ?? null,
        note: body.note ?? null,
        importo_totale: round2(g.somma + ecc),
        voci: g.voci,
        ricariche_mensa: g.ricariche_mensa,
        eccedenza_a_credito: ecc,
        registrato_da: user.id,
      }
      // Solo se presenti: con una sede e senza righe nuove il payload resta
      // quello storico, chiave per chiave.
      if (g.voci_nuove.length > 0) p.voci_nuove = g.voci_nuove
      if (g.voci_ticket.length > 0) p.voci_ticket = g.voci_ticket
      return p
    })
    // Le parti sono arrotondate al centesimo una per una: con importi oltre i due
    // decimali la somma delle transazioni può scostarsi dal totale dichiarato. Lo
    // si dice qui invece di lasciarlo scoprire alla RPC con un 500.
    const sommaDivisa = round2(payloads.reduce((s, p) => s + p.importo_totale, 0))
    if (sommaDivisa !== totale) {
      logEvento('pagamento', 'warn', { operazione: OP, esito: 'quadratura-dopo-divisione', sedi: nSedi })
      return quadraturaFallita(totale, round2(sommaDivisa - eccedenza), eccedenza)
    }

    const nomi = await nomiSedi(supabase, elenco.map((g) => g.scuola_id), OP)

    // ── Scrittura: tutto o niente ─────────────────────────────────────────────
    const { data: rpcData, error: rpcErr } = nSedi === 1
      ? await supabase.rpc('registra_transazione_contabile', { p: payloads[0] })
      : await supabase.rpc('registra_transazioni_per_sede', { p: { transazioni: payloads } })
    if (rpcErr) {
      // RPC assente sul DB non migrato: 503 pulito, l'RPC è atomica → nessuna scrittura.
      if (RPC_ASSENTE.has((rpcErr as { code?: string }).code ?? '')) {
        return NextResponse.json({ error: 'Transazione contabile non disponibile su questo ambiente' }, { status: 503 })
      }
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, rpcErr)
      return NextResponse.json({ error: 'Errore nella registrazione della transazione', details: rpcErr.message }, { status: 500 })
    }

    const esiti: EsitoRpc[] = nSedi === 1
      ? [((rpcData ?? {}) as EsitoRpc)]
      : (((rpcData ?? {}) as { transazioni?: EsitoRpc[] }).transazioni ?? [])
    if (esiti.length !== nSedi) {
      // La scrittura è avvenuta (la RPC non ha dato errore): non si risponde 500
      // a un incasso registrato, ma la forma inattesa si registra come errore.
      logEvento('pagamento', 'error', { operazione: OP, esito: 'esito-rpc-inatteso', sedi: nSedi, n: esiti.length })
    }

    const transazioni = elenco.map((g, i) => ({
      transazione_id: esiti[i]?.transazione_id ?? null,
      scuola_id: g.scuola_id,
      scuola_nome: nomi.get(formaConfronto(g.scuola_id)) ?? null,
      importo_totale: payloads[i].importo_totale,
    }))

    // Evento critico → SUCCESSO loggato (conteggi/uuid, MAI note/motivi/PII).
    if (nSedi > 1) {
      // UNA CHIAVE PER TRANSAZIONE (`transazione_1`, `transazione_2`, …), mai una
      // stringa unita da virgole: `redact()` è a lista bianca e lascia in chiaro
      // solo stringhe che SONO per intero un uuid — «uuid1,uuid2» usciva come
      // `[redatto:str/73]`, cioè proprio il dato che questo evento deve dare.
      // Non un array: il tipo `Valore` del logger non lo ammette. Le sedi sono al
      // più tre, le chiavi restano poche.
      const campiDivisa: Record<string, string | number | null> = {
        operazione: OP,
        esito: 'transazione_divisa',
        sedi: nSedi,
      }
      transazioni.forEach((t, i) => { campiDivisa[`transazione_${i + 1}`] = t.transazione_id })
      logEvento('pagamento', 'info', campiDivisa)
    }
    elenco.forEach((g, i) => {
      logEvento('pagamento', 'info', {
        operazione: OP,
        esito: 'transazione_registrata',
        transazione_id: transazioni[i].transazione_id,
        sede_id: g.scuola_id,
        voci: g.voci.length,
        voci_nuove: g.voci_nuove.length,
        voci_ticket: g.voci_ticket.length,
        ricariche: g.ricariche_mensa.length,
        eccedenza: payloads[i].eccedenza_a_credito,
      })
    })

    // Audit, una riga per transazione (il motivo/nota vivono in colonna, non nei log).
    for (const [i, g] of elenco.entries()) {
      const { error: errAudit } = await supabase.from('registro_modifiche').insert({
        azione: 'registra_transazione',
        tabella_interessata: 'pagamenti_transazioni',
        record_id: transazioni[i].transazione_id,
        nuovo_valore: {
          importo_totale: payloads[i].importo_totale,
          voci: g.voci.length,
          voci_nuove: g.voci_nuove.length,
          voci_ticket: g.voci_ticket.length,
          ricariche: g.ricariche_mensa.length,
          eccedenza: payloads[i].eccedenza_a_credito,
          sedi_operazione: nSedi,
        },
        utente_id: user.id,
      })
      if (errAudit) {
        logEvento('pagamento', 'warn', { operazione: OP, esito: 'audit-non-scritto', transazione_id: transazioni[i].transazione_id }, errAudit)
      }
    }

    // Conferma al genitore, UNA per sede (best-effort, debounce collassa le voci).
    for (const [i, g] of elenco.entries()) {
      if (g.alunni.size === 0) continue
      try {
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: g.scuola_id,
          alunnoIds: [...g.alunni],
          titolo: 'Pagamento registrato',
          corpo: 'È stato registrato un pagamento. La ricevuta è disponibile nella sezione Pagamenti.',
          link: '/parent/pagamenti',
          entitaTipo: 'transazione',
          entitaId: transazioni[i].transazione_id,
          debounce: true,
        })
      } catch (e) {
        logEvento('notifica', 'error', {
          operazione: OP,
          tipo: 'pagamento_registrato',
          esito: 'notifica_non_inviata',
        }, e)
      }
    }

    // Revoca automatica della sospensione se lo scaduto famiglia è azzerato (best-effort).
    const alunniIds = [...new Set(elenco.flatMap((g) => [...g.alunni]))]
    try {
      if (alunniIds.length > 0) await verificaRevocaSospensioneMorosita(supabase, alunniIds)
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: OP, esito: 'revoca_non_verificata' }, e)
    }

    // Compatibilità: i campi di sempre sono quelli della PRIMA transazione;
    // `transazioni` c'è sempre, anche con una sede sola.
    return NextResponse.json({ success: true, data: { ...(esiti[0] ?? {}), transazioni } }, { status: 200 })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
