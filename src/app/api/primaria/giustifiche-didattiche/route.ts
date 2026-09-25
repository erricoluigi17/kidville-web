import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { leggiBufferVisibilita } from '@/lib/primaria/visibilita-genitore'
import { MOTIVO_MAX_CARATTERI, motivoNormalizzato } from '@/lib/presenze/limiti-testo'
import {
  chiaveVoce,
  rispostaPermessoNegato,
  statoVoci,
  verificaPermessoVoce,
  type VocePrimaria,
} from '@/lib/primaria/permesso-voce'

/**
 * GLI IMPREPARATI DEL DOCENTE (spec 2026-09-24, «2 Primaria», compito V2).
 *
 *  · TIPO — «impreparato» o «giustificato», lo sceglie il docente e lo cambia con
 *    Modifica. Quello dichiarato dal GENITORE è sempre «giustificato» (lo impone
 *    anche il trigger `trg_giustifiche_didattiche_genitore_giustificato`).
 *  · MOTIVO — testo libero FACOLTATIVO. Fino al 2026-09-25 la pagina del docente
 *    scriveva qui il testo fisso «Impreparato giustificato», cioè l'etichetta del
 *    bottone salvata come dato: non si scrive più (vedi `motivoDelDocente`).
 *  · NOTIFICA AL GENITORE — dopo il buffer della sede (10', la stessa finestra in
 *    cui il genitore comincia a VEDERE la voce: `visibilita-genitore`), e non
 *    parte se nel frattempo l'impreparato viene eliminato (la DELETE la ritira).
 *  · PATCH e DELETE — `permesso-voce`: autore (`creato_da`) o Segreteria e
 *    Direzione, entro il termine sulla `data` (su entrambe le date se cambia),
 *    oltre il termine solo con lo sblocco. Un impreparato del GENITORE lo possono
 *    modificare e togliere anche i docenti della classe (lo stesso permesso che la
 *    GET dichiara con `modificabile`); il suo tipo resta «giustificato».
 */

/** Colonna sconosciuta allo schema: il DB E2E della CI non ha `tipo` (non migrato). */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

const TIPI = ['impreparato', 'giustificato'] as const
type TipoImpreparato = (typeof TIPI)[number]

/** Il tipo della notifica al genitore, e la sua entità (per il ritiro e il riallineamento). */
const TIPO_NOTIFICA = 'impreparato_segnato'
const ENTITA_NOTIFICA = 'impreparato'
/** La notifica ai docenti di una dichiarazione del GENITORE (`parent/giustifiche-didattiche`). */
const ENTITA_NOTIFICA_GENITORE = 'giustifica_didattica'
/** La pagina Voti del genitore: lì compaiono gli impreparati, accanto alle valutazioni. */
const LINK_VOTI_GENITORE = '/parent/primaria/valutazioni'

/**
 * Il testo fisso che la pagina del docente scriveva come «motivo» fino al
 * 2026-09-25. È l'etichetta del bottone, non un motivo: la migrazione
 * 20260924220000 l'ha tolto dalle 7 righe esistenti, e qui non rientra — nemmeno
 * dalla pagina VECCHIA ancora aperta nel browser di un docente dopo il deploy.
 */
const MOTIVO_FISSO_STORICO = 'impreparato giustificato'

const zMotivo = z
  .string()
  .refine((s) => s.trim().length <= MOTIVO_MAX_CARATTERI, `Motivo oltre ${MOTIVO_MAX_CARATTERI} caratteri`)
  .nullable()
  .optional()

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Due forme di GET: (1) la classe in un giorno — `sectionId` + `data`, com'era;
// (2) l'elenco di un alunno per le «Valutazioni recenti» — `sectionId` +
// `alunnoId` (+ `materiaId`: quelli di quella materia più quelli senza materia).
const getQuerySchema = z.object({
  sectionId: zUuid,
  data: z.string().optional(),
  alunnoId: zUuid.optional(),
  materiaId: zUuid.or(z.literal('')).optional(),
})

// `data` della POST resta stringa permissiva (il DB accetta anche formati non
// YYYY-MM-DD, come nella route gemella del genitore).
const postBodySchema = z.object({
  sectionId: zUuid,
  alunnoId: zUuid,
  data: z.string().min(1),
  tipo: z.enum(TIPI).optional(),
  motivo: zMotivo,
  materiaId: zUuid.nullable().optional(),
})

const patchBodySchema = z
  .object({
    id: zUuid,
    tipo: z.enum(TIPI).optional(),
    motivo: zMotivo,
    materiaId: zUuid.nullable().optional(),
    data: zDataYMD.optional(),
  })
  .refine(
    (b) => b.tipo !== undefined || b.motivo !== undefined || b.materiaId !== undefined || b.data !== undefined,
    { message: 'Nessun campo da modificare' },
  )

const deleteQuerySchema = z.object({ id: zUuid })

// ─── Pezzi comuni ────────────────────────────────────────────────────────────

/** Il motivo come finisce in tabella: `trim`, vuoto → `null`, il testo fisso storico → `null`. */
function motivoDelDocente(motivo: string | null | undefined): string | null {
  const m = motivoNormalizzato(motivo)
  return m && m.toLowerCase() === MOTIVO_FISSO_STORICO ? null : m
}

/** Il tipo di una riga letta: sul DB non migrato la colonna manca, e vale l'origine. */
function tipoDiRiga(r: { tipo?: unknown; origine?: unknown }): TipoImpreparato {
  if (r.tipo === 'impreparato' || r.tipo === 'giustificato') return r.tipo
  return r.origine === 'genitore' ? 'giustificato' : 'impreparato'
}

function codiceDi(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? ''
}

/** `YYYY-MM-DD` → `GG/MM/AAAA`, senza passare dal locale di sistema. Altro → `null`. */
function dataLeggibile(data: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.slice(0, 10))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null
}

/**
 * Il testo della notifica al genitore. Sul modello di quella delle valutazioni
 * (materia nel titolo), ma SENZA il motivo: è testo libero su un minore, e una
 * notifica push finisce sulla schermata di blocco di un telefono. Né il nome
 * dell'alunno: la notifica arriva al suo genitore, che sa di chi si parla.
 */
function testoNotifica(tipo: TipoImpreparato, materiaNome: string | null, data: string): { titolo: string; corpo: string } {
  const cosa = tipo === 'giustificato' ? 'Impreparato giustificato' : 'Impreparato'
  const titolo = materiaNome ? `${cosa} in ${materiaNome}` : cosa
  const giorno = dataLeggibile(data)
  const corpo = `Il docente ha segnato un ${cosa.toLowerCase()}${giorno ? ` per il ${giorno}` : ''}. Lo trovi nella pagina Voti.`
  return { titolo, corpo }
}

function rispostaNonTrovato(): NextResponse {
  return NextResponse.json(
    { error: 'Questo impreparato non esiste più. Ricarica la pagina.', codice: 'IMPREPARATO_NON_TROVATO' },
    { status: 404 },
  )
}

function rispostaNonSalvato(): NextResponse {
  return NextResponse.json(
    { error: 'Operazione non riuscita. Riprova fra poco.', codice: 'IMPREPARATO_NON_SALVATO' },
    { status: 500 },
  )
}

function rispostaLetturaFallita(): NextResponse {
  return NextResponse.json({ error: 'Lettura non riuscita. Riprova.', codice: 'LETTURA_FALLITA' }, { status: 500 })
}

function rispostaMateriaNonValida(): NextResponse {
  return NextResponse.json(
    { error: 'Materia non valida per questa classe', codice: 'IMPREPARATO_MATERIA_NON_VALIDA' },
    { status: 400 },
  )
}

/**
 * Le colonne della voce per PATCH e DELETE: quelle del permesso (autore, classe,
 * sede, data, origine) e quelle della fotografia per l'audit. La sede è quella
 * della CLASSE (`sections.scuola_id`): da lì si leggono i termini.
 */
const COLONNE_VOCE = 'id, alunno_id, section_id, materia_id, data, motivo, tipo, origine, creato_da, creato_il, sections(scuola_id), materie(nome)'
const COLONNE_VOCE_SENZA_TIPO = COLONNE_VOCE.replace(' tipo,', '')

type Embed<T> = T | T[] | null | undefined

interface RigaVoce {
  id: string
  alunno_id: string
  section_id: string | null
  materia_id: string | null
  data: string
  motivo: string | null
  tipo?: string | null
  origine: string
  creato_da: string | null
  creato_il: string | null
  sections?: Embed<{ scuola_id: string | null }>
  materie?: Embed<{ nome: string | null }>
}

function primo<T>(e: Embed<T>): T | null {
  return (Array.isArray(e) ? e[0] : e) ?? null
}

function scuolaDellaClasse(r: RigaVoce): string | null {
  return primo(r.sections)?.scuola_id ?? null
}

function materiaDellaRiga(r: RigaVoce): string | null {
  return primo(r.materie)?.nome ?? null
}

/**
 * La fotografia per l'audit. Il motivo NON c'entra, come nella route del
 * genitore: è testo libero su un minore. Si registra solo se c'era.
 */
function fotografia(r: Pick<RigaVoce, 'data' | 'materia_id' | 'motivo' | 'origine'> & { tipo?: unknown }) {
  return {
    data: r.data,
    materia_id: r.materia_id,
    tipo: tipoDiRiga(r),
    origine: r.origine,
    con_motivo: r.motivo !== null && r.motivo !== '',
  }
}

/** La voce come esce dalla PATCH: senza gli embed e senza `creato_da` (serve al permesso, non alla pagina). */
function vocePerIlClient(r: RigaVoce) {
  const { sections: _s, materie: _m, creato_da: _c, ...resto } = r
  void _s
  void _m
  void _c
  return { ...resto, tipo: tipoDiRiga(r) }
}

/** La voce per `permesso-voce`. La data dell'evento di un impreparato è la sua `data`. */
function vocePrimaria(r: RigaVoce, opz: { nuovaData?: string | null } = {}): VocePrimaria {
  return {
    tipo: 'impreparato',
    id: r.id,
    autoreId: r.creato_da,
    sectionId: r.section_id as string,
    scuolaId: scuolaDellaClasse(r),
    dataEvento: String(r.data ?? '').slice(0, 10),
    nuovaDataEvento: opz.nuovaData ?? null,
    // L'origine della RIGA, come nella GET (`statoVoci`): PATCH, DELETE e il
    // `modificabile` dell'elenco devono dire la stessa cosa.
    origine: r.origine,
  }
}

/** La sede della classe (la tabella non ha `scuola_id`). `undefined` = lettura fallita. */
async function scuolaDiSezione(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sectionId: string,
  operazione: string,
): Promise<string | null | undefined> {
  const { data, error } = await supabase.from('sections').select('scuola_id').eq('id', sectionId).maybeSingle()
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'db' }, error)
    return undefined
  }
  return ((data as { scuola_id?: string | null } | null)?.scuola_id ?? null) as string | null
}

/**
 * La materia, SOLO se è della classe: un id qualunque legherebbe l'impreparato a
 * una materia di un'altra sezione (o sede). `undefined` = lettura fallita.
 */
async function materiaDellaClasse(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  materiaId: string,
  sectionId: string,
  operazione: string,
): Promise<{ nome: string | null } | null | undefined> {
  const { data, error } = await supabase
    .from('materie')
    .select('id, nome')
    .eq('id', materiaId)
    .eq('section_id', sectionId)
    .maybeSingle()
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'db' }, error)
    return undefined
  }
  if (!data) return null
  return { nome: ((data as { nome?: string | null }).nome ?? null) as string | null }
}

/**
 * Legge la voce per id e verifica scope e permesso. Restituisce la riga, oppure
 * la risposta di rifiuto già pronta.
 */
async function voceAutorizzata(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: Parameters<typeof verificaPermessoVoce>[1],
  id: string,
  operazione: string,
  opz: { nuovaData?: string | null } = {},
): Promise<{ riga: RigaVoce } | { response: NextResponse }> {
  let letta = await supabase.from('giustifiche_didattiche').select(COLONNE_VOCE).eq('id', id).maybeSingle()
  if (letta.error && COLONNA_ASSENTE.has(codiceDi(letta.error))) {
    // DB non migrato (E2E della CI): la colonna `tipo` non c'è ancora.
    logEvento('registro', 'info', { operazione, esito: 'tipo-non-disponibile-schema' }, letta.error)
    letta = await supabase.from('giustifiche_didattiche').select(COLONNE_VOCE_SENZA_TIPO).eq('id', id).maybeSingle()
  }
  if (letta.error) {
    logEvento('registro', 'error', { operazione, esito: 'impreparato-non-letto', giustifica_id: id }, letta.error)
    return { response: rispostaLetturaFallita() }
  }
  const riga = letta.data as unknown as RigaVoce | null
  // Una riga senza classe non si riconduce a una sede: si rifiuta invece di indovinare.
  if (!riga || !riga.section_id) return { response: rispostaNonTrovato() }

  // Scope PRIMA del permesso: «è Segreteria» non vuol dire «è Segreteria di
  // quella classe» (permesso-voce non guarda la sede).
  const scopeErr = await assertSezioneInScope(supabase, user, riga.section_id)
  if (scopeErr) return { response: scopeErr }

  const permesso = await verificaPermessoVoce(supabase, user, vocePrimaria(riga, opz))
  if (!permesso.ok) return { response: rispostaPermessoNegato(permesso) }
  return { riga }
}

// ─── GET ─────────────────────────────────────────────────────────────────────

// GET /api/primaria/giustifiche-didattiche?sectionId=&data=&userId=
// GET /api/primaria/giustifiche-didattiche?sectionId=&alunnoId=&materiaId=&userId=
// Elenco degli impreparati, con `tipo`, `origine`, `motivo`, `data` e, per ogni
// voce, `modificabile` / `bloccata` / `giorniLimite` (permesso-voce, variante batch).
export const GET = withRoute('primaria/giustifiche-didattiche:GET', async (request: NextRequest) => {
  const operazione = 'primaria/giustifiche-didattiche:GET'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const parsed = parseQuery(request, getQuerySchema)
    if ('response' in parsed) return parsed.response
    const { sectionId, data, alunnoId, materiaId } = parsed.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const scuolaId = await scuolaDiSezione(supabase, sectionId, operazione)
    if (scuolaId === undefined) return rispostaLetturaFallita()

    // Il nome dell'alunno serve solo alla vista del GIORNO (la classe intera); nella
    // forma per alunno chi chiama sa già di chi si tratta.
    const perAlunno = Boolean(alunnoId)
    const base = 'id, alunno_id, materia_id, data, motivo, origine, creato_da, creato_il'
    const colonne = (conTipo: boolean) =>
      `${base}${conTipo ? ', tipo' : ''}${perAlunno ? '' : ', alunni(nome, cognome)'}`
    const leggi = (conTipo: boolean) => {
      let q = supabase
        .from('giustifiche_didattiche')
        .select(colonne(conTipo))
        .eq('section_id', sectionId)
      if (data) q = q.eq('data', data)
      if (alunnoId) q = q.eq('alunno_id', alunnoId)
      // Quelli di quella materia PIÙ quelli senza materia (spec: «stessa materia più
      // quelli senza materia»). `materiaId` è un uuid validato: sicuro nel filtro.
      if (alunnoId && materiaId) q = q.or(`materia_id.eq.${materiaId},materia_id.is.null`)
      return q.order('data', { ascending: false }).order('creato_il', { ascending: false })
    }

    let letti = await leggi(true)
    if (letti.error && COLONNA_ASSENTE.has(codiceDi(letti.error))) {
      logEvento('registro', 'info', { operazione, esito: 'tipo-non-disponibile-schema' }, letti.error)
      letti = await leggi(false)
    }
    if (letti.error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, letti.error)
      return rispostaLetturaFallita()
    }

    const righe = (letti.data ?? []) as unknown as (Record<string, unknown> & {
      id: string
      data: string
      origine: string
      creato_da: string | null
      tipo?: unknown
    })[]
    const voci: VocePrimaria[] = righe.map((r) => ({
      tipo: 'impreparato',
      id: r.id,
      autoreId: r.creato_da,
      sectionId,
      scuolaId,
      dataEvento: String(r.data ?? '').slice(0, 10),
      origine: r.origine,
    }))
    const stato = await statoVoci(supabase, auth.user, voci)
    // Un guasto di lettura dei permessi NON toglie l'elenco: si vede lo stesso, ma
    // senza bottoni (fail-closed), e il flag lo dichiara. Il guasto l'ha già
    // loggato permesso-voce.
    const esiti = stato.ok ? stato.esiti : null
    const elenco = righe.map((r) => {
      // `creato_da` serve al permesso, non alla pagina.
      const { creato_da: _autore, ...resto } = r
      void _autore
      const e = esiti?.get(chiaveVoce('impreparato', r.id))
      return {
        ...resto,
        tipo: tipoDiRiga(r),
        modificabile: e?.modificabile ?? false,
        bloccata: e?.bloccata ?? false,
        giorniLimite: e?.giorniLimite ?? null,
      }
    })
    return NextResponse.json({ success: true, data: elenco, statoVociDisponibile: stato.ok })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaLetturaFallita()
  }
})

// ─── POST ────────────────────────────────────────────────────────────────────

// POST /api/primaria/giustifiche-didattiche?userId=
// body: { sectionId, alunnoId, data, tipo?, motivo?, materiaId? }
// Il docente segna l'alunno impreparato (tipo predefinito «impreparato»).
export const POST = withRoute('primaria/giustifiche-didattiche:POST', async (request: NextRequest) => {
  const operazione = 'primaria/giustifiche-didattiche:POST'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { sectionId, alunnoId, data, materiaId } = b.data
    const tipo: TipoImpreparato = b.data.tipo ?? 'impreparato'
    const motivo = motivoDelDocente(b.data.motivo)

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
    if (alunnoErr) return alunnoErr

    const scuolaId = await scuolaDiSezione(supabase, sectionId, operazione)
    if (scuolaId === undefined) return rispostaLetturaFallita()

    let materiaNome: string | null = null
    if (materiaId) {
      const materia = await materiaDellaClasse(supabase, materiaId, sectionId, operazione)
      if (materia === undefined) return rispostaLetturaFallita()
      if (materia === null) return rispostaMateriaNonValida()
      materiaNome = materia.nome
    }

    const riga = {
      alunno_id: alunnoId,
      section_id: sectionId,
      materia_id: materiaId ?? null,
      data,
      motivo,
      origine: 'docente',
      creato_da: userId,
    }
    let esito = await supabase
      .from('giustifiche_didattiche')
      .insert({ ...riga, tipo })
      .select()
      .single()
    if (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error))) {
      // DB non migrato (E2E della CI): la colonna `tipo` non c'è ancora, e senza
      // la riga si scrive come prima. In produzione la migrazione c'è.
      logEvento('registro', 'info', { operazione, esito: 'tipo-non-disponibile-schema' }, esito.error)
      esito = await supabase.from('giustifiche_didattiche').insert(riga).select().single()
    }
    if (esito.error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, esito.error)
      return rispostaNonSalvato()
    }
    const inserted = esito.data as Record<string, unknown> & { id: string }
    const salvatoTipo = tipoDiRiga({ tipo: inserted.tipo, origine: 'docente' })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'impreparato',
      entitaId: inserted.id,
      azione: 'insert',
      scuolaId,
      sectionId,
      valorePrima: null,
      valoreDopo: fotografia({ ...riga, tipo: salvatoTipo }),
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user,
      sectionId,
      scuolaId,
      area: 'valutazioni',
      link: `/teacher/primaria/${sectionId}/valutazioni`,
    })

    // Notifica al GENITORE dopo il buffer della sede: la stessa finestra in cui la
    // voce gli diventa visibile. Rispetta l'interruttore per sede
    // (`isNotificaAbilitata`, dentro `enqueueNotifichePerAlunni`). Best-effort:
    // l'impreparato è salvato, un guasto qui non lo disfa.
    let notificaAccodata = false
    try {
      const bufferMin = await leggiBufferVisibilita(supabase, scuolaId, operazione)
      const { titolo, corpo } = testoNotifica(salvatoTipo, materiaNome, data)
      await enqueueNotifichePerAlunni(supabase, {
        alunnoIds: [alunnoId],
        tipo: TIPO_NOTIFICA,
        titolo,
        corpo,
        link: LINK_VOTI_GENITORE,
        entitaTipo: ENTITA_NOTIFICA,
        entitaId: inserted.id,
        bufferMin,
        scuolaId,
      })
      notificaAccodata = true
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione,
        tipo: TIPO_NOTIFICA,
        esito: 'notifica-non-accodata',
        giustifica_id: inserted.id,
      }, e)
    }

    // Il SUCCESSO si logga: una voce nuova sul registro di un minore.
    logEvento('registro', 'info', {
      operazione,
      esito: 'impreparato-segnato',
      giustifica_id: inserted.id,
      alunno_id: alunnoId,
      section_id: sectionId,
      tipo: salvatoTipo,
      con_motivo: motivo !== null,
      notifica_tentata: notificaAccodata,
    }, undefined, { distingui: ['giustifica_id'] })

    return NextResponse.json({ success: true, data: { ...inserted, tipo: salvatoTipo } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaNonSalvato()
  }
})

// ─── PATCH ───────────────────────────────────────────────────────────────────

// PATCH /api/primaria/giustifiche-didattiche?userId=
// body: { id, tipo?, motivo?, materiaId?, data? }
// Permesso: autore (`creato_da`) o Segreteria e Direzione — e, per un impreparato
// del GENITORE, anche i docenti della classe — entro il termine su entrambe le
// date se `data` cambia, oppure con lo sblocco. Nessun avviso nuovo
// al genitore (spec: «Nessun avviso al genitore quando si modifica o elimina»):
// si riallinea solo la notifica ANCORA IN CODA, che altrimenti partirebbe col
// tipo, la materia o il giorno di prima.
export const PATCH = withRoute('primaria/giustifiche-didattiche:PATCH', async (request: NextRequest) => {
  const operazione = 'primaria/giustifiche-didattiche:PATCH'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, tipo, motivo, materiaId, data } = b.data

    const supabase = await createAdminClient()
    // Il permesso guarda l'origine della riga, come la DELETE e il `modificabile`
    // della GET: su un impreparato del genitore passano anche i docenti della classe.
    const lettura = await voceAutorizzata(supabase, auth.user, id, operazione, { nuovaData: data ?? null })
    if ('response' in lettura) return lettura.response
    const voce = lettura.riga
    const sectionId = voce.section_id as string
    const scuolaId = scuolaDellaClasse(voce)

    // Quello dichiarato dal genitore è SEMPRE «giustificato»: chiederne un altro
    // è un errore da dire, non da ingoiare (il trigger lo riscriverebbe in silenzio).
    if (voce.origine === 'genitore' && tipo === 'impreparato') {
      return NextResponse.json(
        {
          error: 'L’impreparato dichiarato dal genitore resta sempre «giustificato».',
          codice: 'IMPREPARATO_TIPO_GENITORE',
        },
        { status: 400 },
      )
    }

    let materiaNome = materiaDellaRiga(voce)
    if (materiaId) {
      const materia = await materiaDellaClasse(supabase, materiaId, sectionId, operazione)
      if (materia === undefined) return rispostaLetturaFallita()
      if (materia === null) return rispostaMateriaNonValida()
      materiaNome = materia.nome
    } else if (materiaId === null) {
      materiaNome = null
    }

    const patch: Record<string, string | null> = {}
    if (tipo !== undefined && voce.origine !== 'genitore') patch.tipo = tipo
    if (motivo !== undefined) patch.motivo = motivoDelDocente(motivo)
    if (materiaId !== undefined) patch.materia_id = materiaId
    if (data !== undefined) patch.data = data

    const scrivi = (p: Record<string, string | null>, colonne: string) =>
      supabase
        .from('giustifiche_didattiche')
        .update(p)
        .eq('id', id)
        .eq('section_id', sectionId)
        .select(colonne)
    let scritte = Object.keys(patch).length > 0 ? await scrivi(patch, COLONNE_VOCE) : null
    if (scritte?.error && COLONNA_ASSENTE.has(codiceDi(scritte.error))) {
      // DB non migrato (E2E della CI): senza la colonna `tipo` si scrive il resto.
      logEvento('registro', 'info', { operazione, esito: 'tipo-non-disponibile-schema' }, scritte.error)
      const { tipo: _t, ...senzaTipo } = patch
      void _t
      scritte = Object.keys(senzaTipo).length > 0 ? await scrivi(senzaTipo, COLONNE_VOCE_SENZA_TIPO) : null
    }
    if (scritte?.error) {
      logEvento('registro', 'error', { operazione, esito: 'impreparato-non-aggiornato', giustifica_id: id }, scritte.error)
      return rispostaNonSalvato()
    }
    // `scritte === null`: niente da scrivere (sola `tipo` su un genitore, o su un DB
    // senza la colonna). La voce resta com'è e si restituisce com'è, ma NON è una
    // rettifica del registro: niente audit, niente avviso ai titolari, niente
    // riallineamento della notifica. Solo la traccia che la richiesta è arrivata.
    if (scritte === null) {
      logEvento('registro', 'info', {
        operazione,
        esito: 'impreparato-nessuna-modifica',
        giustifica_id: id,
        section_id: sectionId,
        attore_id: auth.user.id,
      }, undefined, { distingui: ['giustifica_id'] })
      return NextResponse.json({ success: true, data: vocePerIlClient(voce) })
    }
    const dopo = ((scritte.data ?? []) as unknown as RigaVoce[])[0]
    // Nessuna riga: eliminata fra la lettura e la scrittura.
    if (!dopo) return rispostaNonTrovato()
    const tipoDopo = tipoDiRiga(dopo)

    // La notifica al genitore ANCORA IN CODA si allinea a tipo, materia e giorno
    // nuovi. Solo per le voci del docente: quelle del genitore non ne hanno una.
    let notificaAllineata = true
    if (voce.origine === 'docente') {
      const { titolo, corpo } = testoNotifica(tipoDopo, materiaNome, String(dopo.data ?? ''))
      const { error: notifErr } = await supabase
        .from('notifiche')
        .update({ titolo, corpo })
        .eq('tipo', TIPO_NOTIFICA)
        .eq('entita_tipo', ENTITA_NOTIFICA)
        .eq('entita_id', id)
        .is('push_inviata_il', null)
      if (notifErr) {
        notificaAllineata = false
        logEvento('notifica', 'error', {
          operazione,
          esito: 'notifica-in-coda-non-allineata',
          tipo: TIPO_NOTIFICA,
          giustifica_id: id,
        }, notifErr)
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'impreparato',
      entitaId: id,
      azione: 'update',
      scuolaId,
      sectionId,
      valorePrima: fotografia(voce),
      valoreDopo: fotografia(dopo),
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user,
      sectionId,
      scuolaId,
      area: 'valutazioni',
      link: `/teacher/primaria/${sectionId}/valutazioni`,
    })

    // Il SUCCESSO si logga: un impreparato riscritto è una rettifica del registro.
    logEvento('registro', 'info', {
      operazione,
      esito: 'impreparato-modificato',
      giustifica_id: id,
      section_id: sectionId,
      attore_id: auth.user.id,
      tipo: tipoDopo,
      tipo_cambiato: tipoDopo !== tipoDiRiga(voce),
      data_cambiata: String(dopo.data) !== String(voce.data),
      notifica_allineata: notificaAllineata,
    }, undefined, { distingui: ['giustifica_id'] })

    return NextResponse.json({ success: true, data: vocePerIlClient(dopo) })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaNonSalvato()
  }
})

// ─── DELETE ──────────────────────────────────────────────────────────────────

// DELETE /api/primaria/giustifiche-didattiche?id=&userId=
// Cancellazione vera, con la traccia `logScrittura('delete')`. Permesso:
// autore o Segreteria e Direzione, e per un impreparato del GENITORE anche i
// docenti della classe; entro il termine o con lo sblocco. Si ritira la
// notifica ancora in coda (al genitore, o ai docenti se l'aveva dichiarato il
// genitore); una già partita resta, e nessuna rettifica.
export const DELETE = withRoute('primaria/giustifiche-didattiche:DELETE', async (request: NextRequest) => {
  const operazione = 'primaria/giustifiche-didattiche:DELETE'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const lettura = await voceAutorizzata(supabase, auth.user, id, operazione)
    if ('response' in lettura) return lettura.response
    const voce = lettura.riga
    const sectionId = voce.section_id as string
    const scuolaId = scuolaDellaClasse(voce)

    const { data: tolte, error: delErr } = await supabase
      .from('giustifiche_didattiche')
      .delete()
      .eq('id', id)
      .eq('section_id', sectionId)
      .select('id')
    if (delErr) {
      logEvento('registro', 'error', { operazione, esito: 'impreparato-non-eliminato', giustifica_id: id }, delErr)
      return rispostaNonSalvato()
    }
    if (((tolte ?? []) as unknown[]).length === 0) return rispostaNonTrovato()

    // Il ritiro viene DOPO la cancellazione riuscita: ritirare l'avviso e poi non
    // riuscire a cancellare lascerebbe un impreparato senza notifica.
    const { data: ritirate, error: ritiroErr } = await supabase
      .from('notifiche')
      .delete()
      .in('entita_tipo', [ENTITA_NOTIFICA, ENTITA_NOTIFICA_GENITORE])
      .eq('entita_id', id)
      .is('push_inviata_il', null)
      .select('id')
    if (ritiroErr) {
      // `error` benché la cancellazione sia riuscita: la notifica resta in coda e
      // partirà per un impreparato che non esiste più.
      logEvento('notifica', 'error', {
        operazione,
        esito: 'ritiro-notifica-impreparato-fallito',
        tipo: TIPO_NOTIFICA,
        giustifica_id: id,
      }, ritiroErr)
    }
    const nRitirate = ritiroErr ? 0 : ((ritirate ?? []) as unknown[]).length

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'impreparato',
      entitaId: id,
      azione: 'delete',
      scuolaId,
      sectionId,
      valorePrima: fotografia(voce),
      valoreDopo: null,
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user,
      sectionId,
      scuolaId,
      area: 'valutazioni',
      link: `/teacher/primaria/${sectionId}/valutazioni`,
    })

    logEvento('registro', 'info', {
      operazione,
      esito: 'impreparato-eliminato',
      giustifica_id: id,
      section_id: sectionId,
      attore_id: auth.user.id,
      tipo: tipoDiRiga(voce),
      notifiche_ritirate: nRitirate,
      ritiro_riuscito: !ritiroErr,
    }, undefined, { distingui: ['giustifica_id'] })

    return NextResponse.json({ success: true, data: { id, notificheRitirate: nRitirate } })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaNonSalvato()
  }
})
