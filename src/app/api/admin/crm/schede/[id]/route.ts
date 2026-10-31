import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { contattiNormalizzati } from '@/lib/crm/contatti'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { ORIGINI, type Origine } from '@/lib/crm/tipi'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · la scheda di una famiglia.
 *
 *  · `GET   /api/admin/crm/schede/[id]` — tutto ciò che serve ad aprirla: `{ scheda, bambini,
 *    appuntamenti, azioni_aperte, eventi, eventi_totale }`. Ogni bambino è la sua riga di `crm_bambini`
 *    (`select('*')`: le colonne della quota e `alunno_id` ci sono tutte), più — solo per un BONIFICO già
 *    passato in contabilità — `quota_pagamento_stato`, lo `stato` della voce «Iscrizione» (vedi sotto);
 *  · `PATCH /api/admin/crm/schede/[id]` — contatti, genitore, origine e le tre domande.
 *
 * La sede NON si chiede al client: la dice la scheda stessa, e `assertSchedaInScope` verifica che sia una
 * sede dell'utente (403 se no, 404 se la scheda non c'è). Da lì in poi ogni lettura e ogni scrittura porta
 * `scuola_id` esplicito.
 *
 * ── Le persone ──────────────────────────────────────────────────────────────────────────────────
 * Dove una riga nomina una persona (assegnataria di una visita, responsabile di un richiamo, autore di
 * un evento) la risposta aggiunge accanto all'uuid l'oggetto `{ id, nome, cognome }` (`*_persona`): chi
 * disegna lo storico non deve fare una chiamata per ogni nome. Sono dati del personale, e vanno nella
 * risposta — mai nei log.
 *
 * ── Lo storico è a 500 righe ────────────────────────────────────────────────────────────────────
 * Le più recenti; `eventi_totale` dice quante sono in tutto, perché una scheda che ne ha di più non lo
 * nasconda in silenzio (il tetto di PostgREST, 1000, taglierebbe senza dirlo).
 */

const OPERAZIONE_GET = 'admin/crm/schede/[id]:GET'
const OPERAZIONE_PATCH = 'admin/crm/schede/[id]:PATCH'

const MAX_EVENTI = 500

const ORIGINI_MANUALI = ORIGINI.filter((o): o is Exclude<Origine, 'ai'> => o !== 'ai')

/** Testo libero facoltativo: ripulito ai lati, vuoto = `null` (si svuota), assente = `undefined` (non si tocca). */
const zTesto = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v))

const patchBodySchema = z
  .object({
    genitoreNome: z.string().trim().min(1).max(120).optional(),
    telefono1: zTesto(40),
    telefono2: zTesto(40),
    email1: zTesto(200),
    email2: zTesto(200),
    origine: z.enum(ORIGINI_MANUALI).optional(),
    routine: zTesto(2000),
    paura: zTesto(2000),
    desiderio: zTesto(2000),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nessun campo da modificare' })

/** Il campo del corpo → la colonna. L'ORDINE è quello con cui i nomi entrano nello storico. */
const COLONNE = [
  ['genitoreNome', 'genitore_nome'],
  ['telefono1', 'telefono1'],
  ['telefono2', 'telefono2'],
  ['email1', 'email1'],
  ['email2', 'email2'],
  ['origine', 'origine'],
  ['routine', 'routine'],
  ['paura', 'paura'],
  ['desiderio', 'desiderio'],
] as const

const COLONNE_CONTATTO = new Set(['telefono1', 'telefono2', 'email1', 'email2'])

type Persona = { id: string; nome: string; cognome: string }
type ErroreDb = { code?: string; message?: string }

export const GET = withRoute('admin/crm/schede/[id]:GET', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const idP = parseData(zUuid, (await context.params).id)
  if ('response' in idP) return idP.response

  const supabase = await createAdminClient()
  const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
  if ('response' in ambito) return ambito.response
  const { id, scuola_id: scuolaId } = ambito.scheda

  const [scheda, bambini, appuntamenti, azioni, eventi] = await Promise.all([
    supabase.from('crm_schede').select('*').eq('id', id).eq('scuola_id', scuolaId).maybeSingle(),
    supabase
      .from('crm_bambini')
      .select('*')
      .eq('scheda_id', id)
      .eq('scuola_id', scuolaId)
      .order('creata_il', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('crm_appuntamenti')
      .select('*')
      .eq('scheda_id', id)
      .eq('scuola_id', scuolaId)
      .order('inizio', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('crm_azioni')
      .select('*')
      .eq('scheda_id', id)
      .eq('scuola_id', scuolaId)
      .is('fatta_il', null)
      .is('cancellata_il', null)
      .order('scadenza', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('crm_eventi')
      .select('*', { count: 'exact' })
      .eq('scheda_id', id)
      .eq('scuola_id', scuolaId)
      .order('creato_il', { ascending: false })
      .order('id', { ascending: false })
      .limit(MAX_EVENTI),
  ])
  const guasto = [scheda, bambini, appuntamenti, azioni, eventi].find((r) => r.error)?.error
  if (guasto) return rispostaErroreDb(guasto, OPERAZIONE_GET)
  // Esisteva un attimo fa (lo ha detto `assertSchedaInScope`): se ora non c'è, è stata tolta nel frattempo.
  if (!scheda.data) {
    return NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })
  }

  const righeAppuntamenti = appuntamenti.data ?? []
  const righeAzioni = azioni.data ?? []
  const righeEventi = eventi.data ?? []

  // I nomi delle persone nominate: una lettura per blocchi di id, una volta sola.
  const daNominare = new Set<string>()
  for (const a of righeAppuntamenti) {
    if (typeof a.assegnata_a === 'string') daNominare.add(a.assegnata_a)
    if (typeof a.svolto_da === 'string') daNominare.add(a.svolto_da)
  }
  for (const z of righeAzioni) if (typeof z.responsabile === 'string') daNominare.add(z.responsabile)
  for (const e of righeEventi) if (typeof e.autore === 'string') daNominare.add(e.autore)

  // ── Lo stato della voce «Iscrizione» dei bonifici già in contabilità ─────────────────────────────
  // Un bonifico passa in contabilità «da pagare» e lo chiude la banca (spec §5.2): la scheda dice «in attesa del
  // bonifico» finché la voce non è pagata, e per dirlo deve sapere lo `stato`. È l'UNICA lettura della
  // contabilità di questa route, col filtro di sede nella stessa query. Non è essenziale: se fallisce la scheda
  // si apre lo stesso, senza quel dettaglio (la quota si legge «in contabilità»), e il guasto resta nel log.
  const righeBambini = (bambini.data ?? []) as Record<string, unknown>[]
  const vociDaLeggere = righeBambini
    .filter((b) => b.quota_stato === 'in_contabilita' && b.quota_metodo === 'bonifico' && typeof b.quota_pagamento_id === 'string')
    .map((b) => b.quota_pagamento_id as string)
  const statoVoce = new Map<string, string>()
  for (const blocco of aBlocchi(vociDaLeggere, ID_PER_QUERY)) {
    const { data, error } = await supabase.from('pagamenti').select('id, stato').in('id', blocco).eq('scuola_id', scuolaId)
    if (error) {
      logEvento('crm', 'warn', { operazione: OPERAZIONE_GET, esito: 'quota-voce-non-letta', entita_id: id }, error)
      break
    }
    for (const v of data ?? []) {
      if (typeof v.id === 'string' && typeof v.stato === 'string') statoVoce.set(v.id, v.stato)
    }
  }

  const persone = new Map<string, Persona>()
  for (const blocco of aBlocchi([...daNominare], ID_PER_QUERY)) {
    const { data, error } = await supabase.from('utenti').select('id, nome, cognome').in('id', blocco)
    if (error) return rispostaErroreDb(error, OPERAZIONE_GET)
    for (const u of data ?? []) {
      persone.set(u.id as string, {
        id: u.id as string,
        nome: (u.nome as string | null) ?? '',
        cognome: (u.cognome as string | null) ?? '',
      })
    }
  }
  const persona = (v: unknown): Persona | null => (typeof v === 'string' ? (persone.get(v) ?? null) : null)

  return NextResponse.json({
    scheda: scheda.data,
    bambini: righeBambini.map((b) =>
      typeof b.quota_pagamento_id === 'string' && statoVoce.has(b.quota_pagamento_id)
        ? { ...b, quota_pagamento_stato: statoVoce.get(b.quota_pagamento_id) }
        : b,
    ),
    appuntamenti: righeAppuntamenti.map((a) => ({
      ...a,
      assegnata_a_persona: persona(a.assegnata_a),
      svolto_da_persona: persona(a.svolto_da),
    })),
    azioni_aperte: righeAzioni.map((z) => ({ ...z, responsabile_persona: persona(z.responsabile) })),
    eventi: righeEventi.map((e) => ({ ...e, autore_persona: persona(e.autore) })),
    eventi_totale: eventi.count ?? righeEventi.length,
  })
})

export const PATCH = withRoute('admin/crm/schede/[id]:PATCH', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const idP = parseData(zUuid, (await context.params).id)
  if ('response' in idP) return idP.response
  const body = await parseBody(request, patchBodySchema)
  if ('response' in body) return body.response

  const supabase = await createAdminClient()
  const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
  if ('response' in ambito) return ambito.response
  const { id, scuola_id: scuolaId } = ambito.scheda

  const { data: corrente, error: erroreLettura } = await supabase
    .from('crm_schede')
    .select('*')
    .eq('id', id)
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (erroreLettura) return rispostaErroreDb(erroreLettura, OPERAZIONE_PATCH)
  if (!corrente) return NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })

  // Solo ciò che cambia DAVVERO: un salvataggio che non cambia niente non scrive e non lascia storia.
  const patch: Record<string, string | string[] | null> = {}
  const cambiati: string[] = []
  for (const [campo, colonna] of COLONNE) {
    const nuovo = body.data[campo]
    if (nuovo === undefined) continue
    if (nuovo === ((corrente[colonna] as string | null) ?? null)) continue
    patch[colonna] = nuovo
    cambiati.push(colonna)
  }
  if (cambiati.length === 0) return NextResponse.json({ id, modificata: false })

  if (cambiati.some((c) => COLONNE_CONTATTO.has(c))) {
    const dopo = (colonna: 'telefono1' | 'telefono2' | 'email1' | 'email2') =>
      colonna in patch ? (patch[colonna] as string | null) : ((corrente[colonna] as string | null) ?? null)
    const norm = contattiNormalizzati({
      telefoni: [dopo('telefono1'), dopo('telefono2')],
      email: [dopo('email1'), dopo('email2')],
    })
    if (norm.telefoni_norm.length === 0 && norm.email_norm.length === 0) {
      return NextResponse.json(
        { error: 'Serve almeno un telefono o un’email validi.', codice: 'CONTATTO_OBBLIGATORIO' },
        { status: 422 },
      )
    }
    patch.telefoni_norm = norm.telefoni_norm
    patch.email_norm = norm.email_norm
  }

  const { data: scritte, error: erroreScrittura } = await supabase
    .from('crm_schede')
    .update({ ...patch, aggiornata_il: new Date().toISOString() })
    .eq('id', id)
    .eq('scuola_id', scuolaId)
    .select('id')
  if (erroreScrittura) return rispostaErroreDb(erroreScrittura as ErroreDb, OPERAZIONE_PATCH)
  if (!scritte || scritte.length === 0) {
    return NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })
  }

  // Nello storico i soli NOMI dei campi: i valori sono recapiti e parole di famiglie.
  await registraEvento(supabase, {
    schedaId: id,
    scuolaId,
    tipo: 'modificata',
    autore: auth.user.id,
    autoreVia: 'segreteria',
    dati: { campi: cambiati.join(',') },
  })

  return NextResponse.json({ id, modificata: true })
})
