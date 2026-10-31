import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, resolveScuolaScrittura, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { requireCrm } from '@/lib/crm/accesso'
import { contattiNormalizzati, normalizzaEmail, normalizzaTelefono } from '@/lib/crm/contatti'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { ANNI_INGRESSO, ESITI_BAMBINO, ORIGINI, type Origine } from '@/lib/crm/tipi'
import { descriviTetto, leggiABlocchi, type QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
import { termineOr } from '@/lib/db/ricerca-postgrest'
import { fineGiornoCivile, inizioGiornoCivile } from '@/lib/format/confini-giorno'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { zBool, zDataYMD, zOpzionale, zPeriodo, zTestoRicerca, zUuid } from '@/lib/validation/common'
import { parseBody, parseQuery } from '@/lib/validation/http'

/**
 * CRM della segreteria · le schede delle famiglie.
 *
 *  · `GET  /api/admin/crm/schede?scuolaId=…` — l'elenco, filtrabile e a pagine di 50;
 *  · `POST /api/admin/crm/schede`            — una famiglia nuova, con i suoi bambini.
 *
 * ── La sede ─────────────────────────────────────────────────────────────────────────────────────
 * In LETTURA si dichiara (`scuolaId`, obbligatoria) e deve stare fra le sedi attive dell'utente: una
 * sede altrui è un 403, non un elenco vuoto. In SCRITTURA la dà `resolveScuolaScrittura`, che risponde
 * 400 quando l'utente ha più sedi e nessuna è indicata: una scheda archiviata nel plesso sbagliato non
 * dà errore e non lascia traccia.
 *
 * ── L'elenco non usa join ───────────────────────────────────────────────────────────────────────
 * Ogni filtro che passa da un'altra tabella (esito, persona, «senza domanda», ricerca sul nome di un
 * bambino) produce un INSIEME di id di scheda, e le schede della sede si intersecano con quegli insiemi
 * qui, in memoria. Mettere gli id in un `.in()` farebbe indirizzi lunghissimi (il limite è
 * `ID_PER_QUERY`), e una `select` con tabelle incorporate non è provabile col client finto dei test.
 * Le letture di un'intera tabella passano da `leggiABlocchi`: `max_rows` vale 1000 e il troncamento
 * di PostgREST è muto — un elenco «completo» che manca di schede è il difetto peggiore di un CRM.
 *
 * Solo le schede della pagina chiesta ricevono poi bambini, prossima visita e prossimo richiamo.
 */

const OPERAZIONE_GET = 'admin/crm/schede:GET'
const OPERAZIONE_POST = 'admin/crm/schede:POST'

const PER_PAGINA = 50

/** L'origine «ai» la scrive solo l'agente automatico: da questa schermata non si sceglie. */
const ORIGINI_MANUALI = ORIGINI.filter((o): o is Exclude<Origine, 'ai'> => o !== 'ai')

const getQuerySchema = z.object({
  scuolaId: zUuid,
  esito: zOpzionale(z.enum(ESITI_BAMBINO)),
  origine: zOpzionale(z.enum(ORIGINI)),
  persona: zOpzionale(zUuid),
  senzaDomanda: zOpzionale(zBool),
  q: zTestoRicerca,
  ...zPeriodo('creata').shape,
  // `dal`/`al` sono i nomi del contratto; `creataDa`/`creataA` quelli che scrive la barra dei filtri.
  dal: zOpzionale(zDataYMD),
  al: zOpzionale(zDataYMD),
  pagina: z.coerce.number().int().min(1).max(100000).default(1),
})

/** Testo libero facoltativo: ripulito ai lati, vuoto = `null`, assente = `undefined`. */
const zTesto = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v))

const bambinoNuovoSchema = z.object({
  nome: z.string().trim().min(1).max(100),
  dataNascita: zOpzionale(zDataYMD),
  annoIngresso: z.enum(ANNI_INGRESSO),
})

const postBodySchema = z.object({
  scuolaId: zOpzionale(zUuid),
  genitoreNome: z.string().trim().min(1).max(120),
  telefono1: zTesto(40),
  telefono2: zTesto(40),
  email1: zTesto(200),
  email2: zTesto(200),
  origine: z.enum(ORIGINI_MANUALI),
  routine: zTesto(2000),
  paura: zTesto(2000),
  desiderio: zTesto(2000),
  bambini: z.array(bambinoNuovoSchema).min(1).max(6),
  forza: z.boolean().optional(),
})

type ErroreDb = { code?: string; message?: string }

const contattoObbligatorio = () =>
  NextResponse.json(
    { error: 'Serve almeno un telefono o un’email validi.', codice: 'CONTATTO_OBBLIGATORIO' },
    { status: 422 },
  )

/** Legge TUTTE le righe di una query (a blocchi); un guasto o il tetto diventano la risposta pronta. */
async function leggiTutte<T>(
  operazione: string,
  tipo: string,
  costruisci: () => QueryABlocchi,
): Promise<{ righe: T[] } | { response: NextResponse }> {
  const esito = await leggiABlocchi<T>(costruisci)
  if (esito.ok) return { righe: esito.righe }
  const errore: ErroreDb =
    esito.motivo === 'tetto'
      ? new Error(`${descriviTetto(tipo, esito)}, rifiutata per intero`)
      : (esito.error as ErroreDb)
  return { response: rispostaErroreDb(errore, operazione) }
}

type RigaScheda = { id: string; creata_il: string }
type RigaIdScheda = { scheda_id: string }

export const GET = withRoute('admin/crm/schede:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: OPERAZIONE_GET,
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const { esito, origine, persona, senzaDomanda, q: testo } = q.data
  const dalIso = inizioGiornoCivile(q.data.creataDa ?? q.data.dal ?? '')
  const alIso = fineGiornoCivile(q.data.creataA ?? q.data.al ?? '')

  // 1 · le schede della sede che passano i filtri che stanno sulla scheda stessa
  const base = await leggiTutte<RigaScheda>(OPERAZIONE_GET, 'crm-schede', () => {
    let query = supabase.from('crm_schede').select('id, creata_il').in('scuola_id', scuole)
    if (origine) query = query.eq('origine', origine)
    if (dalIso) query = query.gte('creata_il', dalIso)
    if (alIso) query = query.lte('creata_il', alIso)
    return query
  })
  if ('response' in base) return base.response

  // 2 · i filtri che passano da un'altra tabella: un insieme di id di scheda ciascuno
  const restrizioni: Set<string>[] = []
  const bambiniDellaSede = () => supabase.from('crm_bambini').select('id, scheda_id').in('scuola_id', scuole)
  const idDeiBambini = async (tipo: string, applica: (qb: ReturnType<typeof bambiniDellaSede>) => QueryABlocchi) => {
    const lette = await leggiTutte<RigaIdScheda>(OPERAZIONE_GET, tipo, () => applica(bambiniDellaSede()))
    return 'response' in lette ? lette : { insieme: new Set(lette.righe.map((r) => r.scheda_id)) }
  }

  if (esito) {
    const r = await idDeiBambini('crm-bambini-esito', (qb) => qb.eq('esito', esito))
    if ('response' in r) return r.response
    restrizioni.push(r.insieme)
  }
  if (senzaDomanda === true) {
    const r = await idDeiBambini('crm-bambini-senza-domanda', (qb) => qb.eq('esito', 'iscritto').is('domanda_id', null))
    if ('response' in r) return r.response
    restrizioni.push(r.insieme)
  }
  if (persona) {
    // la visita è assegnata a lei, oppure l'ha svolta lei: due letture, un solo insieme
    const insieme = new Set<string>()
    for (const colonna of ['assegnata_a', 'svolto_da'] as const) {
      const lette = await leggiTutte<RigaIdScheda>(OPERAZIONE_GET, `crm-appuntamenti-${colonna}`, () =>
        supabase.from('crm_appuntamenti').select('id, scheda_id').in('scuola_id', scuole).eq(colonna, persona),
      )
      if ('response' in lette) return lette.response
      for (const r of lette.righe) insieme.add(r.scheda_id)
    }
    restrizioni.push(insieme)
  }
  if (testo) {
    const termine = termineOr(testo)
    const telefono = normalizzaTelefono(testo)
    const email = normalizzaEmail(testo)
    // Un termine fatto di soli metacaratteri (`%,()`) non è una ricerca: non filtra, e non dà errore.
    if (termine !== '' || telefono !== null || email !== null) {
      const trovate = new Set<string>()
      if (termine !== '') {
        const perNome = await leggiTutte<{ id: string }>(OPERAZIONE_GET, 'crm-schede-nome', () =>
          supabase.from('crm_schede').select('id').in('scuola_id', scuole).ilike('genitore_nome', `%${termine}%`),
        )
        if ('response' in perNome) return perNome.response
        for (const r of perNome.righe) trovate.add(r.id)
        const perBambino = await idDeiBambini('crm-bambini-nome', (qb) => qb.ilike('nome', `%${termine}%`))
        if ('response' in perBambino) return perBambino.response
        for (const id of perBambino.insieme) trovate.add(id)
      }
      if (telefono !== null) {
        const perTelefono = await leggiTutte<{ id: string }>(OPERAZIONE_GET, 'crm-schede-telefono', () =>
          supabase.from('crm_schede').select('id').in('scuola_id', scuole).contains('telefoni_norm', [telefono]),
        )
        if ('response' in perTelefono) return perTelefono.response
        for (const r of perTelefono.righe) trovate.add(r.id)
      }
      if (email !== null) {
        const perEmail = await leggiTutte<{ id: string }>(OPERAZIONE_GET, 'crm-schede-email', () =>
          supabase.from('crm_schede').select('id').in('scuola_id', scuole).contains('email_norm', [email]),
        )
        if ('response' in perEmail) return perEmail.response
        for (const r of perEmail.righe) trovate.add(r.id)
      }
      restrizioni.push(trovate)
    }
  }

  // 3 · l'intersezione, dalla più recente, e la pagina chiesta
  const ordinate = base.righe
    .filter((s) => restrizioni.every((r) => r.has(s.id)))
    .sort((a, b) => Date.parse(b.creata_il) - Date.parse(a.creata_il) || (a.id < b.id ? 1 : -1))
  const totale = ordinate.length
  const idPagina = ordinate.slice((q.data.pagina - 1) * PER_PAGINA, q.data.pagina * PER_PAGINA).map((s) => s.id)
  if (idPagina.length === 0) {
    return NextResponse.json({ data: [], totale, pagina: q.data.pagina, perPagina: PER_PAGINA })
  }

  // 4 · il contenuto delle sole schede della pagina (50 id: un solo `.in()`)
  const adesso = new Date().toISOString()
  const [schede, bambini, visite, richiami] = await Promise.all([
    supabase.from('crm_schede').select('id, genitore_nome, origine, creata_il').in('scuola_id', scuole).in('id', idPagina),
    supabase
      .from('crm_bambini')
      .select('id, scheda_id, nome, esito, domanda_id, creata_il')
      .in('scuola_id', scuole)
      .in('scheda_id', idPagina)
      .order('creata_il', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('crm_appuntamenti')
      .select('scheda_id, inizio')
      .in('scuola_id', scuole)
      .in('scheda_id', idPagina)
      .eq('stato', 'in_programma')
      .gte('inizio', adesso),
    supabase
      .from('crm_azioni')
      .select('scheda_id, scadenza')
      .in('scuola_id', scuole)
      .in('scheda_id', idPagina)
      .is('fatta_il', null)
      .is('cancellata_il', null),
  ])
  const guasto = [schede, bambini, visite, richiami].find((r) => r.error)?.error
  if (guasto) return rispostaErroreDb(guasto, OPERAZIONE_GET)

  const prima = (valori: string[]): string | null =>
    valori.length === 0 ? null : valori.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
  const perId = new Map((schede.data ?? []).map((s) => [s.id as string, s]))

  const data = idPagina.flatMap((id) => {
    const s = perId.get(id)
    if (!s) return []
    return [
      {
        id,
        genitore_nome: (s.genitore_nome as string | null) ?? null,
        origine: s.origine as string,
        creata_il: s.creata_il as string,
        bambini: (bambini.data ?? [])
          .filter((b) => b.scheda_id === id)
          .map((b) => ({
            id: b.id as string,
            nome: (b.nome as string | null) ?? null,
            esito: b.esito as string,
            domanda_id: (b.domanda_id as string | null) ?? null,
          })),
        prossima_visita: prima((visite.data ?? []).filter((v) => v.scheda_id === id).map((v) => v.inizio as string)),
        prossima_azione: prima((richiami.data ?? []).filter((z) => z.scheda_id === id).map((z) => z.scadenza as string)),
      },
    ]
  })

  return NextResponse.json({ data, totale, pagina: q.data.pagina, perPagina: PER_PAGINA })
})

/**
 * Una scheda esiste già, nella stessa sede, per uno di questi contatti? Torna la più VECCHIA (è quella a
 * cui la segreteria è abituata), oppure la risposta d'errore pronta. Un'altra sede non conta: una famiglia
 * può aver chiamato due plessi.
 */
async function schedaEsistente(
  supabase: SupabaseClient,
  scuolaId: string,
  norm: { telefoni_norm: string[]; email_norm: string[] },
): Promise<{ id: string | null } | { response: NextResponse }> {
  const candidate: { id: string; creata_il: string }[] = []
  const ricerche: [string, string[]][] = [
    ['telefoni_norm', norm.telefoni_norm],
    ['email_norm', norm.email_norm],
  ]
  for (const [colonna, valori] of ricerche) {
    if (valori.length === 0) continue
    const { data, error } = await supabase
      .from('crm_schede')
      .select('id, creata_il')
      .eq('scuola_id', scuolaId)
      .overlaps(colonna, valori)
      .order('creata_il', { ascending: true })
      .limit(5)
    if (error) return { response: rispostaErroreDb(error, OPERAZIONE_POST) }
    for (const r of data ?? []) candidate.push({ id: r.id as string, creata_il: r.creata_il as string })
  }
  candidate.sort((a, b) => Date.parse(a.creata_il) - Date.parse(b.creata_il))
  return { id: candidate[0]?.id ?? null }
}

export const POST = withRoute('admin/crm/schede:POST', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const body = await parseBody(request, postBodySchema)
  if ('response' in body) return body.response
  const b = body.data

  const supabase = await createAdminClient()
  const sede = await resolveScuolaScrittura(request, supabase, auth.user, b.scuolaId)
  if (sede.response) return sede.response
  const scuolaId = sede.scuolaId as string

  const norm = contattiNormalizzati({ telefoni: [b.telefono1, b.telefono2], email: [b.email1, b.email2] })
  if (norm.telefoni_norm.length === 0 && norm.email_norm.length === 0) return contattoObbligatorio()

  if (b.forza !== true) {
    const esistente = await schedaEsistente(supabase, scuolaId, norm)
    if ('response' in esistente) return esistente.response
    if (esistente.id) {
      return NextResponse.json(
        {
          error: 'Esiste già una scheda con questo numero di telefono o questa email.',
          codice: 'SCHEDA_ESISTENTE',
          schedaId: esistente.id,
        },
        { status: 409 },
      )
    }
  }

  const { data: creata, error: erroreScheda } = await supabase
    .from('crm_schede')
    .insert({
      scuola_id: scuolaId,
      genitore_nome: b.genitoreNome,
      telefono1: b.telefono1 ?? null,
      telefono2: b.telefono2 ?? null,
      email1: b.email1 ?? null,
      email2: b.email2 ?? null,
      telefoni_norm: norm.telefoni_norm,
      email_norm: norm.email_norm,
      origine: b.origine,
      routine: b.routine ?? null,
      paura: b.paura ?? null,
      desiderio: b.desiderio ?? null,
      creato_da: auth.user.id,
      creato_via: 'segreteria',
    })
    .select('id')
    .single()
  if (erroreScheda || !creata) return rispostaErroreDb(erroreScheda ?? {}, OPERAZIONE_POST)
  const schedaId = creata.id as string

  const { data: figli, error: erroreFigli } = await supabase
    .from('crm_bambini')
    .insert(
      b.bambini.map((f) => ({
        scuola_id: scuolaId,
        scheda_id: schedaId,
        nome: f.nome,
        data_nascita: f.dataNascita ?? null,
        anno_ingresso: f.annoIngresso,
      })),
    )
    .select('id')
  if (erroreFigli || !figli) {
    // Una scheda senza bambini non è una famiglia: non resta lì a sembrare una scheda vuota da compilare.
    const { error: erroreTolta } = await supabase.from('crm_schede').delete().eq('id', schedaId).eq('scuola_id', scuolaId)
    if (erroreTolta) {
      logErrore({ operazione: OPERAZIONE_POST, stato: 500, evento: 'scheda-orfana' }, erroreTolta)
    }
    return rispostaErroreDb(erroreFigli ?? {}, OPERAZIONE_POST)
  }

  // Lo storico è un di più rispetto al gesto: se non si scrive, `registraEvento` lo dice nel log e la
  // scheda resta creata. Nello storico entrano id e conteggi, mai nomi né recapiti.
  const evento = { schedaId, scuolaId, autore: auth.user.id, autoreVia: 'segreteria' } as const
  await registraEvento(supabase, { ...evento, tipo: 'creata', dati: { bambini: b.bambini.length } })
  for (const f of figli) {
    await registraEvento(supabase, { ...evento, tipo: 'bambino_aggiunto', dati: { bambino_id: f.id as string } })
  }

  return NextResponse.json({ id: schedaId }, { status: 201 })
})
