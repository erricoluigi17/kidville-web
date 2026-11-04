import { eseguiRitiroGiornate } from '@/lib/primaria/ritiro-notifiche'
import { applicaRettificaStorica, eRettificaStorica, storicoIndisponibile, versioniStoriche } from '@/lib/primaria/rettifica-storica'
import { oggiRoma, puoCorreggereStorico, politicaNotificaOperazione } from '@/lib/storici/retroattivita'
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
import { linkVotiGenitore, nomeAlunnoPerNotifica } from '@/lib/primaria/notifica-voti-genitore'
import { leggiBufferVisibilita } from '@/lib/primaria/visibilita-genitore'
import { logSchemaIndietro, scriviConRipiegoSchema, type RipiegoSchema } from '@/lib/db/colonna-assente'
import { assertMateriaDelDocente, materieVisibili, rispostaMateriaNonAssegnata } from '@/lib/auth/materie-docente'
import { giornoDiRoma } from '@/lib/primaria/periodo'
import { statoQuadrimestre } from '@/lib/primaria/quadrimestre'
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
 *    Direzione. Per quello della docente il termine corre dal giorno del SALVATAGGIO
 *    (`creato_il`), e la voce si CONGELA se la sua data — la vecchia o la nuova —
 *    cade in un quadrimestre con lo scrutinio chiuso: 423 anche dentro il termine,
 *    salvo lo sblocco della Direzione. Quello del GENITORE conserva il suo flusso:
 *    termine sulla `data`, e lo possono modificare e togliere anche i docenti della
 *    classe (lo stesso permesso che la GET dichiara con `modificabile`); il suo tipo
 *    resta «giustificato».
 *  · DATA E QUADRIMESTRE — la `data` mai nel futuro (422), e il quadrimestre che la
 *    contiene decide `periodo_id` e, se il suo scrutinio è chiuso, chi può
 *    inserire: la docente no (423), lo staff sì.
 *  · MATERIE — la docente tocca solo gli impreparati senza materia e quelli delle
 *    materie che ha in QUELLA classe (regola 19), anche se li ha scritti il genitore.
 *    Senza materia (D20) li vede e li tocca tutta la classe. Lo staff vede tutto.
 *  · GET — ogni voce porta `autore` (solo se l'ha scritta una docente), `propria` e
 *    `congelata`; `creato_da` serve al permesso e non esce.
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

// `data` è il giorno dell'impreparato, `YYYY-MM-DD` sul calendario: serve a dire in quale quadrimestre cade e se
// è nel futuro, e una stringa in un'altra forma non cadrebbe in nessun periodo (come la PATCH).
const postBodySchema = z.object({
  sectionId: zUuid,
  alunnoId: zUuid,
  data: zDataYMD,
  tipo: z.enum(TIPI).optional(),
  motivo: zMotivo,
  materiaId: zUuid.nullable().optional(),
})

const patchBodySchema = z
  .object({
    id: zUuid,
    versioneAttesa: z.number().int().nonnegative().optional(),
    tipo: z.enum(TIPI).optional(),
    motivo: zMotivo,
    materiaId: zUuid.nullable().optional(),
    data: zDataYMD.optional(),
  })
  .refine(
    (b) => b.tipo !== undefined || b.motivo !== undefined || b.materiaId !== undefined || b.data !== undefined,
    { message: 'Nessun campo da modificare' },
  )

const deleteQuerySchema = z.object({ id: zUuid, versioneAttesa: z.coerce.number().int().nonnegative().optional() })

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
function testoNotifica(
  tipo: TipoImpreparato,
  materiaNome: string | null,
  data: string,
  nomeAlunno: string | null,
): { titolo: string; corpo: string } {
  const cosa = tipo === 'giustificato' ? 'Impreparato giustificato' : 'Impreparato'
  const base = materiaNome ? `${cosa} in ${materiaNome}` : cosa
  // Il nome del bambino: con due figli il titolo non diceva di chi (2026-09-30).
  const titolo = nomeAlunno ? `${base} · ${nomeAlunno}` : base
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

/** 422: la data dell'impreparato è dopo oggi (a Roma). Il rifiuto si logga, con il codice, e viene prima di ogni lettura. */
function rispostaDataFutura(operazione: string): NextResponse {
  logEvento('registro', 'info', { operazione, esito: 'impreparato-data-futura', error_code: 'DATA_FUTURA' })
  return NextResponse.json({ error: 'La data non può essere nel futuro.', codice: 'DATA_FUTURA' }, { status: 422 })
}

/**
 * Le colonne della voce per PATCH e DELETE: quelle del permesso (autore, classe,
 * sede, data, origine) e quelle della fotografia per l'audit. La sede è quella
 * della CLASSE (`sections.scuola_id`): da lì si leggono i termini.
 */
const COLONNE_VOCE = '*, sections(scuola_id), materie(nome)'
const COLONNE_VOCE_SENZA_TIPO = COLONNE_VOCE.replace(' tipo,', '')

type Embed<T> = T | T[] | null | undefined

/** L'esito di un UPDATE di PATCH: `null` = non c'era niente da scrivere. */
type EsitoScrittura = { data: unknown; error: { code?: string; message: string } | null } | null

interface RigaVoce {
  [campo: string]: unknown
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
    // Il termine di un impreparato della docente corre dal giorno in cui è stato SALVATO (`creato_il`), non dalla sua
    // data: uno di tre settimane fa non nasce bloccato. Quello del genitore resta com'era (`contaDalSalvataggio`).
    giornoSalvataggio: giornoDiRoma(r.creato_il) || null,
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

  // La coppia (classe, materia) della voce deve essere ancora fra quelle assegnate alla docente (regola 19): vale
  // anche per l'impreparato del GENITORE, che solo chi insegna quella materia vede e tocca. Senza materia passa da
  // sé (D20); lo staff passa senza leggere; un guasto della lettura è 500, mai un 403.
  const materiaErr = await assertMateriaDelDocente(supabase, user, riga.section_id, riga.materia_id)
  if (materiaErr) return { response: materiaErr }

  const permesso = await verificaPermessoVoce(supabase, user, vocePrimaria(riga, opz))
  if (!permesso.ok) return { response: rispostaPermessoNegato(permesso) }
  return { riga }
}

// ─── GET ─────────────────────────────────────────────────────────────────────

/** L'autore di un impreparato, come lo vede chi legge l'elenco: lo stesso di un voto. */
interface AutoreImpreparato {
  id: string
  nome: string | null
  cognome: string | null
}

// GET /api/primaria/giustifiche-didattiche?sectionId=&data=&userId=
// GET /api/primaria/giustifiche-didattiche?sectionId=&alunnoId=&materiaId=&userId=
// Elenco degli impreparati, con `tipo`, `origine`, `motivo`, `data` e, per ogni
// voce, `modificabile` / `bloccata` / `giorniLimite` / `congelata` (permesso-voce, variante
// batch), `propria` e `autore`. La docente vede solo quelli senza materia e quelli delle sue
// materie in questa classe; con `materiaId` (il modulo per alunno) una materia non sua è 403.
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

    // Le materie che chi legge può vedere in QUESTA classe (lo staff: tutte, senza leggere niente).
    const visibili = await materieVisibili(supabase, auth.user, sectionId)
    if (!visibili.ok) return visibili.response
    // `materiaId` vuoto vale «nessuna materia», come prima.
    if (materiaId && !visibili.tutte && !visibili.materie.has(materiaId)) {
      logEvento('auth', 'warn', {
        operazione,
        esito: 'materia-non-assegnata',
        materia_id: materiaId,
        error_code: 'MATERIA_NON_ASSEGNATA',
      })
      return rispostaMateriaNonAssegnata()
    }

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
      // UN SOLO `.or()` per query. Quelli di quella materia PIÙ quelli senza materia (spec: «stessa materia più
      // quelli senza materia»): `materiaId` è un uuid validato, ed è già una materia che chi legge può vedere.
      // In ogni altra forma — l'elenco della classe, o una materia indicata senza l'alunno — la docente vede solo
      // i senza materia e quelli delle sue materie (gli id vengono dal database, sono uuid). Lo staff vede tutto.
      if (alunnoId && materiaId) q = q.or(`materia_id.eq.${materiaId},materia_id.is.null`)
      else if (!visibili.tutte) {
        q = visibili.materie.size > 0
          ? q.or(`materia_id.is.null,materia_id.in.(${[...visibili.materie].join(',')})`)
          : q.is('materia_id', null)
      }
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
      creato_il: string | null
      tipo?: unknown
    })[]
    const voci: VocePrimaria[] = righe.map((r) => ({
      tipo: 'impreparato',
      id: r.id,
      autoreId: r.creato_da,
      sectionId,
      scuolaId,
      dataEvento: String(r.data ?? '').slice(0, 10),
      // Lo stesso della PATCH: il termine corre dal salvataggio, e GET e PATCH devono dire la stessa cosa.
      giornoSalvataggio: giornoDiRoma(r.creato_il) || null,
      origine: r.origine,
    }))
    const stato = await statoVoci(supabase, auth.user, voci)
    // Un guasto di lettura dei permessi NON toglie l'elenco: si vede lo stesso, ma
    // senza bottoni (fail-closed), e il flag lo dichiara. Il guasto l'ha già
    // loggato permesso-voce.
    const esiti = stato.ok ? stato.esiti : null
    const versioni = puoCorreggereStorico(auth.user) ? await versioniStoriche(supabase, 'giustifiche_didattiche', righe.map(r => r.id)) : new Map<string, number>()

    // Gli autori: SOLO di chi li ha scritti da docente (quello del genitore non ha un autore da mostrare), con una
    // lettura sola per tutta la lista. Se fallisce l'elenco esce lo stesso, senza nomi. Il NOME non entra nei log:
    // il log dice solo che la lettura è fallita.
    const idAutori = [...new Set(righe.flatMap((r) => (r.origine === 'docente' && r.creato_da ? [r.creato_da] : [])))]
    const autori = new Map<string, AutoreImpreparato>()
    let autoriDisponibili = true
    if (idAutori.length > 0) {
      const { data: utenti, error: autoriErr } = await supabase.from('utenti').select('id, nome, cognome').in('id', idAutori)
      if (autoriErr) {
        autoriDisponibili = false
        logEvento('registro', 'error', { operazione, esito: 'autori-non-letti', n: idAutori.length }, autoriErr)
      } else {
        for (const u of (utenti ?? []) as AutoreImpreparato[]) autori.set(u.id, { id: u.id, nome: u.nome ?? null, cognome: u.cognome ?? null })
      }
    }

    const elenco = righe.map((r) => {
      // `creato_da` serve al permesso, non alla pagina: alla pagina servono `propria` e `autore`.
      const { creato_da: _autore, ...resto } = r
      void _autore
      const e = esiti?.get(chiaveVoce('impreparato', r.id))
      return {
        ...resto,
        storico_versione: versioni.get(r.id),
        tipo: tipoDiRiga(r),
        modificabile: e?.modificabile ?? false,
        bloccata: e?.bloccata ?? false,
        giorniLimite: e?.giorniLimite ?? null,
        congelata: e?.congelata ?? false,
        propria: r.creato_da === auth.user.id,
        autore: (r.origine === 'docente' && r.creato_da && autori.get(r.creato_da)) || null,
      }
    })
    return NextResponse.json({ success: true, data: elenco, statoVociDisponibile: stato.ok, autoriDisponibili })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaLetturaFallita()
  }
})

// ─── POST ────────────────────────────────────────────────────────────────────

// POST /api/primaria/giustifiche-didattiche?userId=
// body: { sectionId, alunnoId, data, tipo?, motivo?, materiaId? }
// Il docente segna l'alunno impreparato (tipo predefinito «impreparato»). `data` è il giorno dell'impreparato: mai nel
// futuro, e il quadrimestre che la contiene decide `periodo_id` e, se il suo scrutinio è chiuso, chi può inserire (la
// docente no, 423; lo staff sì). La docente inserisce solo nelle materie che ha in quella classe; senza materia, in ogni
// caso.
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

    // Nel futuro non si segna: il rifiuto viene PRIMA di qualunque lettura. «Oggi» è il giorno di Roma del server.
    if (data > oggiRoma()) return rispostaDataFutura(operazione)

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
    if (alunnoErr) return alunnoErr

    // La docente segna solo nelle materie che ha in QUESTA classe (la coppia, mai la sola materia). Senza materia
    // non c'è niente da verificare (D20). Lo staff passa senza leggere; un guasto della lettura è 500, mai un 403.
    const materiaDocenteErr = await assertMateriaDelDocente(supabase, auth.user, sectionId, materiaId ?? null)
    if (materiaDocenteErr) return materiaDocenteErr

    const scuolaId = await scuolaDiSezione(supabase, sectionId, operazione)
    if (scuolaId === undefined) return rispostaLetturaFallita()

    let materiaNome: string | null = null
    if (materiaId) {
      const materia = await materiaDellaClasse(supabase, materiaId, sectionId, operazione)
      if (materia === undefined) return rispostaLetturaFallita()
      if (materia === null) return rispostaMateriaNonValida()
      materiaNome = materia.nome
    }

    // Il quadrimestre della data. Il termine NON si applica all'inserimento (uno di tre settimane fa si segna): si
    // applica alla modifica, dal giorno del salvataggio. Si applica invece il congelamento: se lo scrutinio di quel
    // quadrimestre è chiuso per la classe, la docente non inserisce (lo staff sì). Una lettura fallita non vale né
    // «aperto» né «chiuso»: 500. Periodi assenti o senza date sono configurazione mancante: entra senza periodo (D4).
    const quadrimestre = await statoQuadrimestre(supabase, scuolaId, sectionId, data)
    if (!quadrimestre.ok) return rispostaLetturaFallita()
    if (quadrimestre.chiuso && !puoCorreggereStorico(auth.user)) {
      logEvento('registro', 'info', {
        operazione,
        esito: 'impreparato-quadrimestre-chiuso',
        section_id: sectionId,
        error_code: 'QUADRIMESTRE_CHIUSO',
      })
      return NextResponse.json(
        {
          error: 'Lo scrutinio del quadrimestre di questa data è chiuso: per inserire l’impreparato rivolgiti alla segreteria.',
          codice: 'QUADRIMESTRE_CHIUSO',
          locked: true,
        },
        { status: 423 },
      )
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
    const inserisci = (campi: Record<string, unknown>) =>
      supabase.from('giustifiche_didattiche').insert(campi).select().single()
    // DB non migrato (E2E della CI). A degradare è la colonna NUOVA, una volta: `periodo_id`. Se lo schema risponde
    // ancora, ne manca anche una più vecchia, `tipo` (c'è in produzione da prima, non si butta se non è necessario): ultima
    // ripetizione senza. Ogni stadio si dice al log; se fallisce anche l'ultimo, l'errore è quello di sempre.
    const { esito, stadio } = await scriviConRipiegoSchema(
      operazione,
      () => inserisci({ ...riga, tipo, periodo_id: quadrimestre.periodoId }),
      [
        { stadio: 1, scrivi: () => inserisci({ ...riga, tipo }) },
        { stadio: 2, scrivi: () => inserisci(riga) },
      ],
    )
    const periodoScritto = stadio === 0 ? quadrimestre.periodoId : null
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
      const nome = await nomeAlunnoPerNotifica(supabase, alunnoId, operazione)
      const { titolo, corpo } = testoNotifica(salvatoTipo, materiaNome, data, nome)
      await enqueueNotifichePerAlunni(supabase, {
        alunnoIds: [alunnoId],
        operazione: politicaNotificaOperazione({ attore: auth.user, giornoCompetenza: data }),
        tipo: TIPO_NOTIFICA,
        titolo,
        corpo,
        // La pagina Voti DI QUEL figlio: lì compaiono gli impreparati, accanto alle valutazioni.
        link: linkVotiGenitore(alunnoId),
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
      periodo_assegnato: periodoScritto !== null,
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
// del GENITORE, anche i docenti della classe — con la materia ancora assegnata. Per
// quello della docente: entro il termine, che corre dal giorno del SALVATAGGIO, e con
// la data — la vecchia e la nuova — fuori da un quadrimestre chiuso; lo sblocco per
// voce toglie sia il termine sia il congelamento. Per quello del genitore: entro il
// termine su entrambe le date se `data` cambia, oppure con lo sblocco. `data` non è
// mai nel futuro, e se cambia `periodo_id` si ricalcola sulla data nuova (con la data
// invariata non si tocca). Se cambia la materia, la nuova deve essere una assegnata
// alla docente (senza materia, sempre). Nessun avviso nuovo
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

    // L'impreparato non si sposta nel futuro: il rifiuto viene prima di leggere la voce.
    if (data !== undefined && data > oggiRoma()) return rispostaDataFutura(operazione)

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

    // La materia NUOVA deve essere fra quelle assegnate alla docente in questa classe (la vecchia l'ha già verificata
    // `voceAutorizzata`). Senza materia (`null`) passa da sé (D20). Prima di scrivere, e di leggere altro.
    if (materiaId && materiaId !== voce.materia_id) {
      const materiaNuovaErr = await assertMateriaDelDocente(supabase, auth.user, sectionId, materiaId)
      if (materiaNuovaErr) return materiaNuovaErr
    }

    // Se la data cambia, l'impreparato passa al quadrimestre della data nuova. Il congelamento per la docente l'ha già
    // deciso `voceAutorizzata` (su entrambe le date); qui si ricalcola solo `periodo_id`, anche per lo staff, che non
    // è fermato dallo scrutinio chiuso. Con la data invariata `periodo_id` non si tocca. Lettura fallita: 500 prima di
    // scrivere qualunque cosa.
    let periodoNuovo: string | null | undefined
    if (data !== undefined && data !== vocePrimaria(voce).dataEvento) {
      const quadrimestre = await statoQuadrimestre(supabase, scuolaId, sectionId, data)
      if (!quadrimestre.ok) return rispostaLetturaFallita()
      periodoNuovo = quadrimestre.periodoId
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
    if (periodoNuovo !== undefined) patch.periodo_id = periodoNuovo

    const scrivi = (p: Record<string, string | null>, colonne: string) =>
      supabase
        .from('giustifiche_didattiche')
        .update(p)
        .eq('id', id)
        .eq('section_id', sectionId)
        .select(colonne)
    const storica = eRettificaStorica(auth.user, data ?? voce.data, voce.data)
    let scritte: EsitoScrittura
    if (storica && Object.keys(patch).length > 0) {
      if (voce.storico_versione === undefined || !scuolaId) return storicoIndisponibile()
      const rettificaCon = (valori: Record<string, string | null>, ripiegoSchema: boolean) => applicaRettificaStorica(supabase, { attore: auth.user, scuolaId, alunnoId: voce.alunno_id, sectionId, modulo: 'giustifiche-didattiche', giorno: voce.data, attese: [{ tabella: 'giustifiche_didattiche', filtro: { id, section_id: sectionId }, versione: b.data.versioneAttesa }], azioni: [{ tabella: 'giustifiche_didattiche', operazione: 'update', filtro: { id, section_id: sectionId }, valori }], ripiegoSchema })
      // DB non migrato (la CI E2E): la RPC costruisce l'UPDATE dalle chiavi di `valori`, e senza `periodo_id` torna
      // `42703`. Come sull'update semplice: UNA ripetizione senza, con il log `info`; la seconda prova non ha ripiego.
      let rettifica = await rettificaCon(patch, 'periodo_id' in patch)
      if ('response' in rettifica && rettifica.schemaIndietro) {
        logSchemaIndietro(operazione, rettifica.schemaIndietro, 1)
        const { periodo_id: _periodo, ...senzaPeriodo } = patch
        void _periodo
        rettifica = await rettificaCon(senzaPeriodo, false)
      }
      if ('response' in rettifica) return rettifica.response
      scritte = { data: rettifica.righe[0], error: null }
    } else if (Object.keys(patch).length === 0) scritte = null
    else {
      // DB non migrato (E2E della CI), a due stadi come l'insert della POST. Prima la colonna NUOVA: una ripetizione senza
      // `periodo_id` (se la PATCH lo portava). Se lo schema risponde ancora, manca anche `tipo`: ultima ripetizione senza
      // (il resto si scrive; se non resta niente, la voce resta com'è). Ogni stadio si dice al log.
      const { periodo_id: _periodo, ...senzaPeriodo } = patch
      void _periodo
      const { tipo: _tipo, ...senzaTipo } = senzaPeriodo
      void _tipo
      const ripieghi: RipiegoSchema<EsitoScrittura>[] = []
      if ('periodo_id' in patch) ripieghi.push({ stadio: 1, scrivi: async () => scrivi(senzaPeriodo, COLONNE_VOCE) })
      if ('tipo' in patch) {
        ripieghi.push({
          stadio: 2,
          scrivi: async () => (Object.keys(senzaTipo).length > 0 ? scrivi(senzaTipo, COLONNE_VOCE_SENZA_TIPO) : null),
        })
      }
      scritte = (await scriviConRipiegoSchema(operazione, async () => scrivi(patch, COLONNE_VOCE), ripieghi)).esito
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
      // Il nome si rilegge: la notifica in coda lo porta nel titolo, e riscriverlo senza lo toglierebbe.
      const nome = await nomeAlunnoPerNotifica(supabase, voce.alunno_id, operazione)
      const { titolo, corpo } = testoNotifica(tipoDopo, materiaNome, String(dopo.data ?? ''), nome)
      const { error: notifErr } = await eseguiRitiroGiornate(() => {
        const coda = supabase.from('notifiche')
        return (storica ? coda.delete() : coda.update({ titolo, corpo }))
          .eq('tipo', TIPO_NOTIFICA).eq('entita_tipo', ENTITA_NOTIFICA).eq('entita_id', id)
      }, { giorni: [String(voce.data).slice(0, 10)], storica, operazione })
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

    let tolte: unknown[] | null
    let delErr: unknown = null
    if (eRettificaStorica(auth.user, voce.data)) {
      if (voce.storico_versione === undefined || !scuolaId) return storicoIndisponibile()
      const rettifica = await applicaRettificaStorica(supabase, { attore: auth.user, scuolaId, alunnoId: voce.alunno_id, sectionId, modulo: 'giustifiche-didattiche', giorno: voce.data, attese: [{ tabella: 'giustifiche_didattiche', filtro: { id, section_id: sectionId }, versione: q.data.versioneAttesa }], azioni: [{ tabella: 'giustifiche_didattiche', operazione: 'delete', filtro: { id, section_id: sectionId } }] })
      if ('response' in rettifica) return rettifica.response
      tolte = rettifica.righe[0]
    } else {
      const esito = await supabase.from('giustifiche_didattiche').delete().eq('id', id).eq('section_id', sectionId).select('id')
      tolte = esito.data; delErr = esito.error
    }
    if (delErr) {
      logEvento('registro', 'error', { operazione, esito: 'impreparato-non-eliminato', giustifica_id: id }, delErr)
      return rispostaNonSalvato()
    }
    if (((tolte ?? []) as unknown[]).length === 0) return rispostaNonTrovato()

    // Il ritiro viene DOPO la cancellazione riuscita: ritirare l'avviso e poi non
    // riuscire a cancellare lascerebbe un impreparato senza notifica.
    const { data: ritirate, error: ritiroErr } = await eseguiRitiroGiornate(() => supabase
      .from('notifiche')
      .delete()
      .in('entita_tipo', [ENTITA_NOTIFICA, ENTITA_NOTIFICA_GENITORE])
      .eq('entita_id', id)
      .select('id'), { giorni: [String(voce.data).slice(0, 10)], storica: eRettificaStorica(auth.user, String(voce.data).slice(0, 10)), operazione })
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
