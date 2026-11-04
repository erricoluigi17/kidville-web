import { eseguiRitiroGiornate } from '@/lib/primaria/ritiro-notifiche'
import { getGenitoriDiAlunniEsito } from '@/lib/anagrafiche/legami'
import { applicaRettificaStorica, eRettificaStorica, storicoIndisponibile, type AzioneStorica } from '@/lib/primaria/rettifica-storica'
import { puoCorreggereStorico, politicaNotificaOperazione, oggiRoma } from '@/lib/storici/retroattivita'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunnoInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { renderGiudizioDescrittivo, type Dimensioni } from '@/lib/primaria/giudizio'
import { leggiObiettiviDisponibili, obiettiviDisponibili } from '@/lib/primaria/obiettivi'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { linkVotiGenitore, nomeAlunnoPerNotifica } from '@/lib/primaria/notifica-voti-genitore'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { guastoLetturaAccessoria, rispostaGuastoDb } from '@/lib/db/guasto'
import { colonnaNuovaAssente, logSchemaIndietro, scriviConRipiegoSchema } from '@/lib/db/colonna-assente'
import { assertMateriaDelDocente, materieVisibili, rispostaMateriaNonAssegnata } from '@/lib/auth/materie-docente'
import { dataDiCompetenza, giornoDiRoma, ordinaPerCompetenza } from '@/lib/primaria/periodo'
import { leggiPeriodi, statoQuadrimestre } from '@/lib/primaria/quadrimestre'
import {
  chiaveVoce,
  rispostaPermessoNegato,
  statoVoci,
  verificaPermessoVoce,
  type VocePrimaria,
} from '@/lib/primaria/permesso-voce'
import type { LockTipo } from '@/lib/primaria/timelock'

// Queste valutazioni includono l'annotazione numerica privata del docente: l'endpoint
// è RISERVATO al personale docente/segreteria. Il genitore (role 'genitore') è escluso
// così il suo appunto numerico non gli è mai accessibile via API (PRD §4 e §4.5).

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// alunnoId è di fatto obbligatorio anche oggi (assertAlunnoInScope risponde 400
// se assente); '' su materiaId equivale ad assente (nessun filtro).
const getQuerySchema = z.object({
  alunnoId: zUuid,
  materiaId: zUuid.or(z.literal('')).optional(),
})

// I campi del GIUDIZIO: gli stessi, con la stessa validazione, per la POST e
// per la PATCH (spec 2026-09-24, V1). Alunno, classe, materia, data e autore NON
// stanno qui: identificano la voce, e una modifica non li sposta.
//
// dims e obiettiviIds restano volutamente permissivi (z.unknown()): il codice li
// ispeziona a runtime senza vincoli di forma (dims a forma libera, obiettiviIds
// non-array trattato come []). NB: .optional() è necessario — z.unknown() come
// chiave di z.object è required a runtime.
const campiGiudizio = {
  modalita: z.enum(['dimensioni', 'sintetico'], {
    error: "modalita deve essere 'dimensioni' o 'sintetico'",
  }),
  dims: z.unknown().optional(),
  giudizioSintetico: z.string().nullish(),
  giudizioTesto: z.string().nullish(),
  argomento: z
    .string({ error: "Inserisci l'argomento della valutazione" })
    .refine((s) => s.trim().length > 0, "Inserisci l'argomento della valutazione"),
  // Facoltativa: numero o stringa numerica; range 0-10 e arrotondamento
  // restano validati nell'handler ('' equivale ad assente, come oggi).
  annotazioneNumerica: z.union([z.number(), z.string()]).nullish(),
  obiettiviIds: z.unknown().optional(),
}

// La regola di coerenza fra modalità e dimensioni, condivisa da POST e PATCH.
// Quella sul giudizio sta in `leggiGiudizio`: vale per ENTRAMBE le modalità.
const dimsSeDimensioni = (b: { modalita: string; dims?: unknown }) => b.modalita !== 'dimensioni' || Boolean(b.dims)
const REGOLA_DIMS = { message: 'dimensioni obbligatorie per la modalità dimensioni', path: ['dims'] }

/**
 * Il giudizio sintetico è il VOTO che vede la famiglia (PRD §4 #1): obbligatorio
 * in ENTRAMBE le modalità. «Per dimensioni» AGGIUNGE il testo descrittivo, non
 * lo sostituisce. Fino al 2026-10-04 bastava il testo, e la modalità predefinita
 * era quella: 33 voti di 32 alunni sono arrivati ai genitori senza voto (IV di
 * Giugliano, 01/10: lo stesso testo a quindici bambini, con appunti da 6 a 10).
 * Si controlla nel corpo e non con un `refine`, per dare il codice e il log.
 */
function leggiGiudizio(
  operazione: string,
  modalita: string,
  giudizioSintetico: string | null | undefined,
): { giudizio: string } | { response: NextResponse } {
  const giudizio = giudizioSintetico?.trim()
  if (giudizio) return { giudizio }
  // `warn`: una scheda aperta da prima del rilascio manda ancora «per dimensioni»
  // senza giudizio. Si vuole sapere quante volte succede. (`tipo` = la modalità.)
  logEvento('registro', 'warn', { operazione, esito: 'valutazione-senza-giudizio', tipo: modalita })
  return {
    response: NextResponse.json(
      { error: 'Scegli il giudizio sintetico: è il voto che vede la famiglia.', codice: 'VALUTAZIONE_GIUDIZIO_MANCANTE' },
      { status: 400 },
    ),
  }
}

// docenteId resta permissivo: lo valida risolviValutatore (422).
const postBodySchema = z
  .object({
    alunnoId: zUuid,
    sectionId: zUuid,
    materiaId: zUuid,
    tipoProva: z.string().nullish().default('orale'),
    ...campiGiudizio,
    data: zDataYMD.nullish(), // default dinamico: oggi (calcolato nell'handler)
    docenteId: z.unknown().optional(),
  })
  .refine(dimsSeDimensioni, REGOLA_DIMS)

// PATCH: la voce per `id` più gli stessi campi della POST. Un'eccezione sola,
// voluta: `tipoProva` ASSENTE lascia il tipo com'è, invece di ricadere su
// 'orale' come nella POST — una modifica che non nomina il tipo non deve
// trasformare in silenzio una verifica scritta (15 giorni) in un'orale (2).
const patchBodySchema = z
  .object({
    id: zUuid,
    versioneAttesa: z.number().int().nonnegative().optional(),
    data: zDataYMD.optional(),
    tipoProva: z.string().nullish(),
    ...campiGiudizio,
  })
  .refine(dimsSeDimensioni, REGOLA_DIMS)

const deleteQuerySchema = z.object({ id: zUuid, versioneAttesa: z.coerce.number().int().nonnegative().optional() })

/** Il termine della voce: scritto/pratico = 15 giorni, il resto 2 (valori per sede). */
function lockTipoDaTipo(tipo: string | null | undefined): LockTipo {
  return tipo === 'scritto' || tipo === 'pratico' ? 'scritto_pratico' : 'classe_orale'
}

/** `lock_tipo` salvato se leggibile, altrimenti dedotto da `tipo` (righe storiche). */
function lockTipoDiRiga(riga: { lock_tipo?: string | null; tipo?: string | null }): LockTipo {
  if (riga.lock_tipo === 'scritto_pratico' || riga.lock_tipo === 'classe_orale') return riga.lock_tipo
  return lockTipoDaTipo(riga.tipo)
}

/**
 * Annotazione numerica privata (facoltativa, scala /10): `null` se assente,
 * il valore arrotondato al centesimo, oppure `undefined` se fuori scala.
 */
function leggiAnnotazione(v: number | string | null | undefined): number | null | undefined {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (Number.isNaN(n) || n < 0 || n > 10) return undefined
  return Math.round(n * 100) / 100
}

/**
 * Gli obiettivi da collegare (DL-015), enforcement CONDIZIONALE: obbligatori solo
 * se la scuola ha configurato obiettivi per quella materia/livello. `null` quando
 * non ce n'è nessuno configurato (fallback su `argomento`).
 *
 * `giaCollegati` (solo PATCH): gli obiettivi che la voce ha GIÀ. Restano validi
 * anche se nel frattempo sono stati disattivati o hanno cambiato livello —
 * altrimenti la valutazione non si modificherebbe più senza staccarli, o il
 * collegamento storico sparirebbe senza che nessuno l'abbia chiesto. Un
 * obiettivo NUOVO deve invece essere fra i disponibili.
 */
function obiettiviDaCollegare(
  disponibili: { id: string }[],
  obiettiviIds: unknown,
  giaCollegati: readonly string[] = [],
): { ok: true; ids: string[] | null } | { ok: false; motivo: 'mancante' | 'non_valido' } {
  if (disponibili.length === 0) return { ok: true, ids: null }
  const richiesti = (Array.isArray(obiettiviIds) ? obiettiviIds.filter(Boolean) : []) as string[]
  if (richiesti.length === 0) return { ok: false, motivo: 'mancante' }
  const validi = new Set([...disponibili.map((o) => o.id), ...giaCollegati])
  if (richiesti.some((id) => !validi.has(id))) return { ok: false, motivo: 'non_valido' }
  return { ok: true, ids: [...new Set(richiesti)] }
}

// ─── Lettura della voce, per PATCH e DELETE ──────────────────────────────────

/**
 * Le colonne della voce: quelle che decidono il permesso (autore, classe, sede,
 * data, tipo) e quelle che finiscono nella fotografia dell'audit. La sede è
 * quella della CLASSE (`sections.scuola_id`): da lì si leggono i termini.
 */
const COLONNE_VOCE = `
  *,
  valutazione_obiettivi(obiettivo_id),
  sections(scuola_id)
`

interface RigaVoce {
  id: string
  alunno_id: string | null
  maestra_id: string | null
  section_id: string | null
  materia_id: string | null
  tipo: string | null
  lock_tipo: string | null
  creato_il: string | null
  data_evento?: string | null
  valutazione_obiettivi?: { obiettivo_id: string }[] | null
  sections?: { scuola_id: string | null } | { scuola_id: string | null }[] | null
  [colonna: string]: unknown
}

function scuolaDellaClasse(riga: { sections?: RigaVoce['sections'] }): string | null {
  const s = Array.isArray(riga.sections) ? riga.sections[0] : riga.sections
  return s?.scuola_id ?? null
}

function obiettiviDellaRiga(riga: RigaVoce): string[] {
  return (riga.valutazione_obiettivi ?? []).map((o) => o.obiettivo_id).filter(Boolean)
}

/** La fotografia per l'audit: la riga senza gli embed, più gli obiettivi collegati. */
function fotografia(riga: RigaVoce): Record<string, unknown> {
  const { sections: _s, valutazione_obiettivi: _vo, ...resto } = riga
  void _s
  void _vo
  return { ...resto, obiettivi_ids: obiettiviDellaRiga(riga) }
}

function vocePrimaria(riga: RigaVoce, nuovaDataEvento?: string): VocePrimaria {
  return {
    tipo: 'valutazione',
    id: riga.id,
    autoreId: riga.maestra_id,
    sectionId: riga.section_id as string,
    scuolaId: scuolaDellaClasse(riga),
    // La data dell'evento è quella della PROVA: `data_evento` se la docente l'ha indicata, altrimenti il
    // giorno di Roma di `creato_il` (le righe nate prima della colonna). Serve al congelamento dello
    // scrutinio chiuso. Il TERMINE invece corre dal giorno del SALVATAGGIO (`giornoSalvataggio`): una
    // prova di tre settimane fa non nasce bloccata, e un voto «datato ieri» non resta aperto per mesi.
    // Una data illeggibile è bloccata (fail-closed).
    dataEvento: dataDiCompetenza(riga),
    giornoSalvataggio: giornoDiRoma(riga.creato_il) || null,
    lockTipo: lockTipoDiRiga(riga),
    nuovaDataEvento,
  }
}

const NON_TROVATA = () =>
  NextResponse.json(
    { error: 'Valutazione non trovata: forse è già stata eliminata. Ricarica la pagina.', codice: 'VALUTAZIONE_NON_TROVATA' },
    { status: 404 },
  )

/** 422: la data della prova è dopo oggi (a Roma). Il rifiuto si logga, con il codice, e viene prima di ogni lettura. */
function rispostaDataFutura(operazione: string): NextResponse {
  logEvento('registro', 'info', { operazione, esito: 'voto-data-futura', error_code: 'DATA_FUTURA' })
  return NextResponse.json({ error: 'La data non può essere nel futuro.', codice: 'DATA_FUTURA' }, { status: 422 })
}

/**
 * 500: periodi o scrutini non letti, quindi non si sa se il quadrimestre della data sia chiuso. Né un via libera
 * né un 423 inventato. La riga di log la scrive già `statoQuadrimestre`.
 */
function rispostaQuadrimestreNonLetto(): NextResponse {
  return NextResponse.json(
    { error: 'Verifica del quadrimestre non riuscita. Riprova.', codice: 'LETTURA_FALLITA' },
    { status: 500 },
  )
}

/**
 * Legge la voce (solo primaria: `modalita` valorizzata) e verifica scope e
 * permesso. Restituisce la riga, oppure la risposta di rifiuto già pronta.
 *
 * Il termine è quello della voce COM'È ADESSO — lo stesso che la GET mostra
 * con `modificabile`/`bloccata` — e corre dal giorno in cui è stata SALVATA, non
 * dalla data della prova. Una PATCH che cambia il tipo della prova non aggiunge
 * un secondo controllo sul tipo nuovo: renderebbe incoerenti GET e PATCH (una
 * scritta di 10 giorni, «modificabile» per la GET, diventerebbe un 423 «chiedi
 * lo sblocco» che la Direzione non potrebbe mai dare, perché per la GET la voce
 * non è bloccata).
 *
 * La data nuova (`nuovaDataEvento`) non conta per il termine: conta per il
 * CONGELAMENTO. Se la data della prova, la vecchia o la nuova, cade in un
 * quadrimestre il cui scrutinio è chiuso per la classe, la docente riceve 423
 * `QUADRIMESTRE_CHIUSO` anche dentro il termine; lo sblocco per voce toglie il
 * congelamento insieme al termine. La materia si controlla PRIMA del permesso:
 * chi è stata tolta da una materia perde anche i voti che vi aveva scritto.
 */
async function voceAutorizzata(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: Parameters<typeof verificaPermessoVoce>[1],
  id: string,
  operazione: string,
  nuovaDataEvento?: string,
): Promise<{ riga: RigaVoce } | { response: NextResponse }> {
  const { data, error } = await supabase
    .from('valutazioni')
    .select(COLONNE_VOCE)
    .eq('id', id)
    .not('modalita', 'is', null)
    .maybeSingle()
  if (error) {
    logEvento('registro', 'error', { operazione, esito: 'valutazione-non-letta', valutazione_id: id }, error)
    return {
      response: NextResponse.json(
        { error: 'Verifica dei permessi non riuscita. Riprova.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      ),
    }
  }
  const riga = data as unknown as RigaVoce | null
  // Una valutazione senza classe non si può ricondurre a una sede: per la
  // primaria non ne esistono (misurato il 2026-09-25: 0 su 83), e se un giorno
  // ce ne fosse una si rifiuta invece di indovinare.
  if (!riga || !riga.section_id) return { response: NON_TROVATA() }

  // Scope PRIMA del permesso: «è Segreteria» non vuol dire «è Segreteria di
  // quella classe» (permesso-voce non guarda la sede).
  const scopeErr = await assertSezioneInScope(supabase, user, riga.section_id)
  if (scopeErr) return { response: scopeErr }

  // La coppia (classe, materia) della voce deve essere ancora fra quelle assegnate alla docente (D19).
  // Lo staff passa senza leggere; un guasto della lettura è 500, mai un 403.
  const materiaErr = await assertMateriaDelDocente(supabase, user, riga.section_id, riga.materia_id)
  if (materiaErr) return { response: materiaErr }

  const permesso = await verificaPermessoVoce(supabase, user, vocePrimaria(riga, nuovaDataEvento))
  if (!permesso.ok) return { response: rispostaPermessoNegato(permesso) }
  return { riga }
}

/** L'autore di un voto, come lo vede chi legge lo storico di un alunno in una materia. */
interface AutoreVoto {
  id: string
  nome: string | null
  cognome: string | null
}

// GET /api/primaria/valutazioni?alunnoId=&materiaId=&userId=
// Lo STORICO di un alunno: tutti i voti delle materie che chi legge può vedere (le sue in ciascuna classe;
// lo staff le vede tutte), da qualunque autore, ciascuno con l'autore e con `propria`. Ordine: per data della
// prova, poi per salvataggio, dal più recente. `periodi` porta le date dei quadrimestri della sede, perché la
// UI dica a quale appartiene ogni voto senza rifare il calcolo.
export const GET = withRoute('primaria/valutazioni:GET', async (request: NextRequest) => {
  const operazione = 'primaria/valutazioni:GET'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, materiaId } = q.data

    const supabase = await createAdminClient()
    // Scope per alunno (tenant + classe): blocca cross-tenant e, per l'educator,
    // gli alunni fuori dalle proprie sezioni.
    const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId)
    if (scopeErr) return scopeErr

    // Le materie che chi legge può vedere. Senza una classe l'insieme è l'unione delle sue classi: basta,
    // perché `materie.section_id` è NOT NULL e quindi un `materia_id` appartiene a UNA classe sola.
    const visibili = await materieVisibili(supabase, auth.user)
    if (!visibili.ok) return visibili.response
    if (materiaId && !visibili.tutte && !visibili.materie.has(materiaId)) {
      logEvento('auth', 'warn', {
        operazione,
        esito: 'materia-non-assegnata',
        materia_id: materiaId,
        error_code: 'MATERIA_NON_ASSEGNATA',
      })
      return rispostaMateriaNonAssegnata()
    }
    // Una docente senza materie assegnate non vede nessun voto: si risponde senza leggere le valutazioni.
    if (!materiaId && !visibili.tutte && visibili.materie.size === 0) {
      return NextResponse.json({ success: true, data: [], statoVociDisponibile: true, autoriDisponibili: true, periodi: [] })
    }

    let query = supabase
      .from('valutazioni')
      .select(`
        *,
        valutazione_obiettivi(obiettivo_id, obiettivi_apprendimento(id, codice, descrizione)),
        sections(scuola_id)
      `)
      .not('modalita', 'is', null) // solo valutazioni in itinere (primaria)
      .order('creato_il', { ascending: false })
      .eq('alunno_id', alunnoId)
    if (materiaId) query = query.eq('materia_id', materiaId)
    else if (!visibili.tutte) query = query.in('materia_id', [...visibili.materie])

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Per ogni voce: `modificabile` (Modifica/Elimina si mostrano), `bloccata` (oltre il termine senza
    // sblocco: la Direzione vede «Sblocca») e `congelata` (lo scrutinio del suo quadrimestre è chiuso).
    // Variante BATCH di permesso-voce: una lettura per sede, non una per voce.
    const righe = (data ?? []) as unknown as RigaVoce[]
    const voci = righe.filter((r) => r.section_id).map((r) => vocePrimaria(r))
    const stato = await statoVoci(supabase, auth.user, voci)
    // Un guasto di lettura dei permessi NON toglie l'elenco: le valutazioni si
    // vedono lo stesso, ma senza bottoni (fail-closed) e con il flag che lo
    // dichiara — mai «bloccata» inventata. Il guasto l'ha già loggato permesso-voce.
    const esiti = stato.ok ? stato.esiti : null

    // Gli autori: una lettura sola per tutti i voti. Se fallisce l'elenco esce lo stesso, senza nomi.
    // Il NOME non entra nei log: il log dice solo che la lettura è fallita.
    const idAutori = [...new Set(righe.flatMap((r) => (r.maestra_id ? [r.maestra_id] : [])))]
    const autori = new Map<string, AutoreVoto>()
    let autoriDisponibili = true
    if (idAutori.length > 0) {
      const { data: utenti, error: autoriErr } = await supabase.from('utenti').select('id, nome, cognome').in('id', idAutori)
      if (autoriErr) {
        autoriDisponibili = false
        logEvento('registro', 'error', { operazione, esito: 'autori-non-letti', n: idAutori.length }, autoriErr)
      } else {
        for (const u of (utenti ?? []) as AutoreVoto[]) autori.set(u.id, { id: u.id, nome: u.nome ?? null, cognome: u.cognome ?? null })
      }
    }

    // I quadrimestri delle sedi dei voti, solo quelli con entrambe le date (gli altri non coprono niente).
    // Accessori: un guasto lascia l'elenco e dà `periodi: []`.
    const sedi = [...new Set(righe.flatMap((r) => {
      const sede = scuolaDellaClasse(r)
      return sede ? [sede] : []
    }))]
    const lettiPeriodi = await leggiPeriodi(supabase, sedi)
    if (!lettiPeriodi.ok) guastoLetturaAccessoria('registro', operazione, 'periodi-non-letti', lettiPeriodi.error)
    const periodi = lettiPeriodi.ok ? lettiPeriodi.periodi.filter((p) => p.data_inizio && p.data_fine) : []

    const elenco = righe.map((r) => {
      const { sections: _s, ...resto } = r
      void _s
      const e = esiti?.get(chiaveVoce('valutazione', r.id))
      return {
        ...resto,
        modificabile: e?.modificabile ?? false,
        bloccata: e?.bloccata ?? false,
        giorniLimite: e?.giorniLimite ?? null,
        congelata: e?.congelata ?? false,
        propria: r.maestra_id === auth.user.id,
        autore: (r.maestra_id && autori.get(r.maestra_id)) || null,
      }
    })
    return NextResponse.json({
      success: true,
      data: ordinaPerCompetenza(elenco),
      statoVociDisponibile: stato.ok,
      autoriDisponibili,
      periodi,
    })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/valutazioni?userId=
// body: { alunnoId, sectionId, materiaId, tipoProva, modalita,
//         dims:{autonomia,continuita,tipologia,risorse}, giudizioSintetico,
//         giudizioTesto?, obiettiviIds[], data? }
// `data` è il giorno della PROVA (mai nel futuro; senza, oggi a Roma) e si scrive sempre in `data_evento`. Il
// quadrimestre che la contiene decide `periodo_id` e, se il suo scrutinio è chiuso, chi può inserire: la docente
// no (423), lo staff sì, a nome del docente titolare. La docente inserisce solo nelle materie che le sono
// assegnate in quella classe.
export const POST = withRoute('primaria/valutazioni:POST', async (request: NextRequest) => {
  const operazione = 'primaria/valutazioni:POST'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const {
      alunnoId, sectionId, materiaId, tipoProva, modalita,
      giudizioSintetico, giudizioTesto, argomento, data, annotazioneNumerica,
    } = b.data
    const g = leggiGiudizio('primaria/valutazioni:POST', modalita, giudizioSintetico)
    if ('response' in g) return g.response
    const { giudizio } = g
    // Il refine dello schema garantisce dims presente quando modalita === 'dimensioni';
    // il contenuto resta a forma libera (tollerante) come prima della validazione.
    const dims = b.data.dims as Dimensioni | undefined
    const obiettiviIds = b.data.obiettiviIds
    const docenteId = b.data.docenteId as string | null | undefined

    // Annotazione numerica privata (facoltativa, scala /10). Solo appunto del docente.
    const annNum = leggiAnnotazione(annotazioneNumerica)
    if (annNum === undefined) {
      return NextResponse.json(
        { error: "L'annotazione numerica deve essere un valore tra 0 e 10", codice: 'VALUTAZIONE_ANNOTAZIONE_NON_VALIDA' },
        { status: 400 },
      )
    }

    // Il giorno della prova: quello indicato, o oggi. Nel futuro non si valuta: il rifiuto viene PRIMA di
    // qualunque lettura. «Oggi» è il giorno di Roma del server, non quello del telefono.
    const oggi = oggiRoma()
    const eventDate = data ?? oggi
    if (eventDate > oggi) return rispostaDataFutura(operazione)

    const supabase = await createAdminClient()

    // Scope per tenant/classe (educator: solo sezioni assegnate; staff/segreteria: plesso).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // L'alunno valutato deve appartenere alla sezione asserita (no valutazioni cross-sezione).
    const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
    if (alunnoErr) return alunnoErr

    // La docente valuta solo nelle materie che ha in QUESTA classe (la coppia, mai la sola materia). Prima di
    // leggere obiettivi e periodi: chi non ha la materia non deve nemmeno sapere com'è configurata.
    // Lo staff passa senza leggere; un guasto della lettura è 500 LETTURA_FALLITA, mai un 403.
    const materiaDocenteErr = await assertMateriaDelDocente(supabase, auth.user, sectionId, materiaId)
    if (materiaDocenteErr) return materiaDocenteErr

    // Autore della valutazione = docente (vincolo FEA). educator → sé stesso;
    // segreteria → docente titolare della MATERIA indicato in body.docenteId, altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId, materiaId })
    if (vr.response) return vr.response
    const maestraId = vr.valutatoreId

    // Materia (nome per il campo NOT NULL legacy) + scuola + codice (per obiettivi).
    // Un guasto non è «materia non trovata»: il voto non verrebbe salvato e la docente
    // leggerebbe che la materia non esiste.
    const { data: materia, error: errMateria } = await supabase
      .from('materie')
      .select('nome, codice, scuola_id, section_id')
      .eq('id', materiaId)
      .maybeSingle()
    if (errMateria) return rispostaGuastoDb('primaria/valutazioni:POST', 'db:materie', errMateria)
    if (!materia) return NextResponse.json({ error: 'Materia non trovata' }, { status: 404 })
    // La materia deve essere del catalogo della sezione asserita: il suo scuola_id
    // pilota periodi, template giudizio e audit — mai da un tenant estraneo.
    if (materia.section_id !== sectionId) {
      return NextResponse.json({ error: 'Materia non appartenente alla sezione' }, { status: 403 })
    }

    // Collegamento a ≥1 obiettivo di apprendimento (DL-015), enforcement CONDIZIONALE:
    // obbligatorio solo se la scuola ha configurato obiettivi per quella materia/livello
    // (stesso filtro del selettore docente, via obiettiviDisponibili). Altrimenti
    // fallback su `argomento` (sempre obbligatorio) per non bloccare scuole senza curricolo.
    const disponibili = await obiettiviDisponibili(supabase, { codice: materia.codice, scuola_id: materia.scuola_id }, sectionId)
    const scelta = obiettiviDaCollegare(disponibili, obiettiviIds)
    if (!scelta.ok && scelta.motivo === 'mancante') {
      return NextResponse.json(
        { error: 'Collega almeno un obiettivo di apprendimento alla valutazione.', codice: 'VALUTAZIONE_OBIETTIVO_MANCANTE' },
        { status: 400 },
      )
    }
    if (!scelta.ok) {
      return NextResponse.json(
        { error: 'Obiettivo non valido per questa materia/livello.', codice: 'VALUTAZIONE_OBIETTIVO_NON_VALIDO' },
        { status: 400 },
      )
    }
    const obiettiviCollegati = scelta.ids ?? []

    // Il quadrimestre della data della prova. Il termine NON si applica all'inserimento (una prova di tre
    // settimane fa si registra): si applica alla modifica, dal giorno del salvataggio. Si applica invece il
    // congelamento: se lo scrutinio di quel quadrimestre è chiuso per la classe, la docente non inserisce
    // (lo staff sì, a nome del docente titolare). Una lettura fallita non vale né «aperto» né «chiuso»: 500.
    // Periodi assenti o senza date sono configurazione mancante: il voto entra senza periodo (D4).
    const lockTipo = lockTipoDaTipo(tipoProva)
    const quadrimestre = await statoQuadrimestre(supabase, materia.scuola_id, sectionId, eventDate)
    if (!quadrimestre.ok) return rispostaQuadrimestreNonLetto()
    if (quadrimestre.chiuso && !puoCorreggereStorico(auth.user)) {
      logEvento('registro', 'info', {
        operazione,
        esito: 'voto-quadrimestre-chiuso',
        section_id: sectionId,
        error_code: 'QUADRIMESTRE_CHIUSO',
      })
      return NextResponse.json(
        {
          error: 'Lo scrutinio del quadrimestre di questa data è chiuso: per inserire il voto rivolgiti alla segreteria.',
          codice: 'QUADRIMESTRE_CHIUSO',
          locked: true,
        },
        { status: 423 },
      )
    }

    // Giudizio descrittivo: override del docente o auto-generato dai template.
    let testo = giudizioTesto ?? null
    if (modalita === 'dimensioni' && dims && !testo) {
      testo = await renderGiudizioDescrittivo(supabase, materia.scuola_id, dims)
    }

    const riga = {
      alunno_id: alunnoId,
      maestra_id: maestraId,
      section_id: sectionId,
      materia: materia.nome, // legacy NOT NULL
      materia_id: materiaId,
      argomento: argomento.trim(),
      tipo: tipoProva,
      modalita,
      dim_autonomia: modalita === 'dimensioni' ? dims?.autonomia ?? null : null,
      dim_continuita: modalita === 'dimensioni' ? dims?.continuita ?? null : null,
      dim_tipologia: modalita === 'dimensioni' ? dims?.tipologia ?? null : null,
      dim_risorse: modalita === 'dimensioni' ? dims?.risorse ?? null : null,
      giudizio_sintetico: giudizio, // in entrambe le modalità: è il voto visibile
      giudizio_testo: testo,
      voto_numerico: null, // voto ufficiale numerico vietato alla primaria
      annotazione_numerica: annNum, // appunto privato del docente (mai al genitore)
      lock_tipo: lockTipo,
      data_evento: eventDate, // sempre: anche oggi (D11), così lo storico ha una sola regola
      periodo_id: quadrimestre.periodoId,
      pubblicato: false, // buffer notifica (F1.8)
    }
    const inserisci = (campi: Record<string, unknown>) => supabase.from('valutazioni').insert(campi).select().single()

    // DB non migrato (la CI E2E): `periodo_id` può mancare. Si ripete UNA volta senza, e lo si dice al log.
    // Se torna ancora un codice di schema la colonna mancante è `data_evento`: per un voto di oggi si
    // ripete anche senza (com'era prima), per una data diversa si rifiuta, perché scriverlo sarebbe
    // archiviarlo oggi.
    const { periodo_id: _periodo, ...senzaPeriodo } = riga
    void _periodo
    const { data_evento: _dataEvento, ...senzaData } = senzaPeriodo
    void _dataEvento
    const { esito: inserimento, stadio } = await scriviConRipiegoSchema(
      operazione,
      () => inserisci(riga),
      [
        { stadio: 1, scrivi: () => inserisci(senzaPeriodo) },
        // Solo per un voto di OGGI: per una data diversa scrivere senza `data_evento` vorrebbe dire archiviarlo oggi.
        ...(eventDate === oggi ? [{ stadio: 2, scrivi: () => inserisci(senzaData) }] : []),
      ],
    )
    const periodoScritto = stadio === 0 ? quadrimestre.periodoId : null
    const { data: val, error: valErr } = inserimento
    if (valErr) {
      logErrore({ operazione, evento: 'db' }, valErr)
      if (eventDate !== oggi && colonnaNuovaAssente(valErr)) return NextResponse.json({ error: 'Archivio storico non disponibile: aggiornare lo schema.', codice: 'STORICO_NON_DISPONIBILE' }, { status: 503 })
      return NextResponse.json({ error: 'Valutazione non salvata' }, { status: 500 })
    }
    // Il SUCCESSO si logga: senza, «nessun log» non distingue «tutto ok» da «non è partito niente».
    logEvento('registro', 'info', {
      operazione,
      esito: 'valutazione-inserita',
      valutazione_id: val.id,
      section_id: sectionId,
      retrodatata: eventDate < oggi,
      periodo_assegnato: periodoScritto !== null,
    }, undefined, { distingui: ['valutazione_id'] })

    // Righe di collegamento valutazione↔obiettivo (DL-015). Best-effort: l'eventuale
    // errore non annulla la valutazione già creata.
    if (obiettiviCollegati.length > 0) {
      const link = obiettiviCollegati.map((oid) => ({ valutazione_id: val.id, obiettivo_id: oid }))
      const { error: linkErr } = await supabase.from('valutazione_obiettivi').insert(link)
      // La valutazione è salvata, ma il collegamento agli obiettivi (DL-015) è perduto:
      // righe che nessuno riscriverà. `error`, anche se la risposta è 200.
      if (linkErr) {
        logEvento('db', 'error', {
          operazione: 'primaria/valutazioni:POST',
          esito: 'valutazione_obiettivi_non_collegati',
          n: link.length,
        }, linkErr)
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'valutazione',
      entitaId: val.id,
      azione: 'insert',
      scuolaId: materia.scuola_id,
      sectionId,
      valoreDopo: val,
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, scuolaId: materia.scuola_id, area: 'valutazioni', link: `/teacher/primaria/${sectionId}/valutazioni` })

    // Notifica valutazione con buffer (default 10 min). Best-effort: la
    // valutazione è salvata, un guasto qui non la disfa — ma si dice.
    try {
      // Accessoria: senza l'impostazione vale il buffer predefinito (10 minuti).
      const { data: settings, error: errSettings } = await supabase
        .from('admin_settings')
        .select('notif_buffer_valutazioni_min')
        .eq('scuola_id', materia.scuola_id)
        .maybeSingle()
      if (errSettings) guastoLetturaAccessoria('notifica', 'primaria/valutazioni:POST', 'buffer-valutazioni-non-letto', errSettings)
      // Il FIGLIO, nel link e nel titolo: con due figli il tocco apriva i voti
      // di quello selezionato l'ultima volta (vedi `notifica-voti-genitore`).
      const nome = await nomeAlunnoPerNotifica(supabase, alunnoId, 'primaria/valutazioni:POST')
      await enqueueNotifichePerAlunni(supabase, {
        alunnoIds: [alunnoId],
        operazione: politicaNotificaOperazione({ attore: auth.user, giornoCompetenza: eventDate }),
        tipo: 'valutazione',
        titolo: nome ? `Nuova valutazione di ${materia.nome} per ${nome}` : `Nuova valutazione di ${materia.nome}`,
        corpo: giudizio,
        link: linkVotiGenitore(alunnoId),
        entitaTipo: 'valutazione',
        entitaId: val.id,
        bufferMin: settings?.notif_buffer_valutazioni_min ?? 10,
      })
    } catch (e) {
      // Era `catch { /* non bloccare */ }`: una notifica mai accodata non
      // lasciava niente, e il genitore semplicemente non sapeva del voto.
      logEvento('notifica', 'error', {
        operazione: 'primaria/valutazioni:POST',
        esito: 'notifica-valutazione-non-accodata',
        tipo: 'valutazione',
        valutazione_id: val.id,
      }, e)
    }

    return NextResponse.json({ success: true, data: val }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'primaria/valutazioni:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

const NON_SALVATA = () =>
  NextResponse.json(
    { error: 'Valutazione non salvata. Riprova fra poco.', codice: 'VALUTAZIONE_NON_SALVATA' },
    { status: 500 },
  )

// PATCH /api/primaria/valutazioni?userId=
// body: { id, tipoProva?, modalita, dims?, giudizioSintetico?, giudizioTesto?,
//         argomento, annotazioneNumerica?, obiettiviIds? }
// Stessi campi e stessa validazione della POST; gli obiettivi collegati si
// SOSTITUISCONO. Permesso: autore (`maestra_id`) o Segreteria/Direzione, con la
// materia ancora assegnata. Per la docente: entro il termine, che corre dal
// giorno del SALVATAGGIO (`creato_il`), e con la data della prova — la vecchia
// e la nuova — fuori da un quadrimestre chiuso; lo sblocco per voce toglie sia
// il termine sia il congelamento (permesso-voce). `data` sposta la prova (mai nel
// futuro): `periodo_id` si ricalcola sulla data nuova, e con la data invariata
// non si tocca. Nessun avviso al genitore (spec 2026-09-24, «2 Primaria»).
export const PATCH = withRoute('primaria/valutazioni:PATCH', async (request: NextRequest) => {
  const operazione = 'primaria/valutazioni:PATCH'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, modalita, giudizioSintetico, giudizioTesto, argomento, annotazioneNumerica, obiettiviIds } = b.data
    const g = leggiGiudizio(operazione, modalita, giudizioSintetico)
    if ('response' in g) return g.response
    const { giudizio } = g
    const dims = b.data.dims as Dimensioni | undefined

    const annNum = leggiAnnotazione(annotazioneNumerica)
    if (annNum === undefined) {
      return NextResponse.json(
        { error: "L'annotazione numerica deve essere un valore tra 0 e 10", codice: 'VALUTAZIONE_ANNOTAZIONE_NON_VALIDA' },
        { status: 400 },
      )
    }

    // La prova non si sposta nel futuro: il rifiuto viene prima di leggere la voce.
    if (b.data.data !== undefined && b.data.data > oggiRoma()) return rispostaDataFutura(operazione)

    const supabase = await createAdminClient()

    // `tipoProva` assente = il tipo resta quello salvato (vedi patchBodySchema).
    const tipoRichiesto = b.data.tipoProva
    const lettura = await voceAutorizzata(supabase, auth.user, id, operazione, b.data.data)
    if ('response' in lettura) return lettura.response
    const voce = lettura.riga
    const sectionId = voce.section_id as string
    const tipo = tipoRichiesto === undefined ? voce.tipo : tipoRichiesto
    const lockTipo = tipoRichiesto === undefined ? lockTipoDiRiga(voce) : lockTipoDaTipo(tipoRichiesto)

    // Se la prova cambia giorno, il voto passa al quadrimestre della data nuova. Il congelamento per la docente
    // l'ha già deciso `voceAutorizzata` (su entrambe le date); qui si ricalcola solo `periodo_id`, anche per lo
    // staff, che non è fermato dallo scrutinio chiuso. Con la data invariata `periodo_id` non si tocca.
    // Lettura fallita: 500 prima di scrivere qualunque cosa.
    const giornoOriginale = vocePrimaria(voce).dataEvento
    let periodoNuovo: string | null | undefined
    if (b.data.data !== undefined && b.data.data !== giornoOriginale) {
      const quadrimestre = await statoQuadrimestre(supabase, scuolaDellaClasse(voce), sectionId, b.data.data)
      if (!quadrimestre.ok) return rispostaQuadrimestreNonLetto()
      periodoNuovo = quadrimestre.periodoId
    }

    // La materia della voce: codice e sede per obiettivi e template del giudizio.
    const { data: materia, error: materiaErr } = await supabase
      .from('materie')
      .select('nome, codice, scuola_id')
      .eq('id', voce.materia_id as string)
      .maybeSingle()
    if (materiaErr || !materia) {
      logEvento('registro', 'error', {
        operazione,
        esito: materiaErr ? 'materia-non-letta' : 'materia-assente',
        valutazione_id: id,
      }, materiaErr ?? undefined)
      return NON_SALVATA()
    }

    // Qui una lettura fallita NON può valere «nessun obiettivo configurato»:
    // i collegamenti resterebbero com'erano e la risposta sarebbe 200 — la
    // modifica del docente persa in silenzio. Si ferma PRIMA di scrivere.
    const disponibili = await leggiObiettiviDisponibili(
      supabase,
      { codice: materia.codice, scuola_id: materia.scuola_id },
      sectionId,
    )
    if (!disponibili.ok) {
      logEvento('registro', 'error', {
        operazione,
        esito: 'obiettivi-disponibili-non-letti',
        valutazione_id: id,
      }, disponibili.error)
      return NextResponse.json(
        { error: 'Obiettivi di apprendimento non letti: valutazione non salvata. Riprova.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      )
    }
    const primaObiettivi = obiettiviDellaRiga(voce)
    const scelta = obiettiviDaCollegare(disponibili.righe, obiettiviIds, primaObiettivi)
    if (!scelta.ok && scelta.motivo === 'mancante') {
      return NextResponse.json(
        { error: 'Collega almeno un obiettivo di apprendimento alla valutazione.', codice: 'VALUTAZIONE_OBIETTIVO_MANCANTE' },
        { status: 400 },
      )
    }
    if (!scelta.ok) {
      return NextResponse.json(
        { error: 'Obiettivo non valido per questa materia/livello.', codice: 'VALUTAZIONE_OBIETTIVO_NON_VALIDO' },
        { status: 400 },
      )
    }

    // Giudizio descrittivo: override del docente o auto-generato dai template (come la POST).
    let testo = giudizioTesto ?? null
    if (modalita === 'dimensioni' && dims && !testo) {
      testo = await renderGiudizioDescrittivo(supabase, materia.scuola_id, dims)
    }

    const giornoNuovo = b.data.data ?? giornoOriginale
    const politicaModifica = politicaNotificaOperazione({ attore: auth.user, giornoCompetenza: giornoNuovo, giornoOriginale })
    const storica = eRettificaStorica(auth.user, giornoNuovo, giornoOriginale)
    const valori: Record<string, unknown> = {
        argomento: argomento.trim(),
        ...(b.data.data !== undefined ? { data_evento: b.data.data } : {}),
        ...(periodoNuovo !== undefined ? { periodo_id: periodoNuovo } : {}),
        tipo,
        modalita,
        dim_autonomia: modalita === 'dimensioni' ? dims?.autonomia ?? null : null,
        dim_continuita: modalita === 'dimensioni' ? dims?.continuita ?? null : null,
        dim_tipologia: modalita === 'dimensioni' ? dims?.tipologia ?? null : null,
        dim_risorse: modalita === 'dimensioni' ? dims?.risorse ?? null : null,
        giudizio_sintetico: giudizio,
        giudizio_testo: testo,
        annotazione_numerica: annNum,
        lock_tipo: lockTipo,
    }
    let aggiornate: unknown[] | null
    let updErr: { code?: string; message: string } | null = null
    if (storica) {
      if (voce.storico_versione === undefined) return storicoIndisponibile()
      const azioniCon = (campi: Record<string, unknown>): AzioneStorica[] => {
        const azioni: AzioneStorica[] = [{ tabella: 'valutazioni', operazione: 'update', filtro: { id, section_id: sectionId }, valori: campi }]
        if (scelta.ids !== null) {
          azioni.push({ tabella: 'valutazione_obiettivi', operazione: 'delete', filtro: { valutazione_id: id } })
          for (const obiettivo_id of scelta.ids) azioni.push({ tabella: 'valutazione_obiettivi', operazione: 'insert', valori: { valutazione_id: id, obiettivo_id } })
        }
        return azioni
      }
      const rettificaCon = (campi: Record<string, unknown>, ripiegoSchema: boolean) => applicaRettificaStorica(supabase, { attore: auth.user, scuolaId: String(materia.scuola_id), alunnoId: voce.alunno_id, sectionId, modulo: 'valutazioni', giorno: giornoOriginale, attese: [{ tabella: 'valutazioni', filtro: { id, section_id: sectionId }, versione: b.data.versioneAttesa }], azioni: azioniCon(campi), ripiegoSchema })
      // DB non migrato (la CI E2E): la RPC costruisce l'UPDATE dalle chiavi di `valori`, e senza `periodo_id` torna
      // `42703`. Come sull'update semplice: UNA ripetizione senza, con il log `info`; la seconda prova non ha ripiego.
      let rettifica = await rettificaCon(valori, 'periodo_id' in valori)
      if ('response' in rettifica && rettifica.schemaIndietro) {
        logSchemaIndietro(operazione, rettifica.schemaIndietro, 1)
        const { periodo_id: _periodo, ...senzaPeriodo } = valori
        void _periodo
        rettifica = await rettificaCon(senzaPeriodo, false)
      }
      if ('response' in rettifica) return rettifica.response
      aggiornate = rettifica.righe[0]
    } else {
      const aggiorna = (campi: Record<string, unknown>) => supabase.from('valutazioni').update(campi).eq('id', id).eq('section_id', sectionId).select()
      // DB non migrato (la CI E2E): se manca `periodo_id` si ripete UNA volta senza, e lo si dice al log.
      const { periodo_id: _periodo, ...senzaPeriodo } = valori
      void _periodo
      const { esito } = await scriviConRipiegoSchema(
        operazione,
        () => aggiorna(valori),
        'periodo_id' in valori ? [{ stadio: 1, scrivi: () => aggiorna(senzaPeriodo) }] : [],
      )
      aggiornate = esito.data; updErr = esito.error
    }
    if (updErr) {
      logEvento('registro', 'error', { operazione, esito: 'valutazione-non-aggiornata', valutazione_id: id }, updErr)
      if (b.data.data !== undefined && ['42703', 'PGRST204'].includes(updErr.code ?? '')) return NextResponse.json({ error: 'Archivio storico non disponibile.', codice: 'STORICO_NON_DISPONIBILE' }, { status: 503 })
      return NON_SALVATA()
    }
    const val = ((aggiornate ?? []) as Record<string, unknown>[])[0]
    // Nessuna riga: eliminata fra la lettura e la scrittura.
    if (!val) return NON_TROVATA()

    // Obiettivi collegati: si SOSTITUISCONO, toccando solo la differenza. Se la
    // scuola non ha obiettivi configurati per la materia (fallback su
    // `argomento`) il selettore non c'è, e i collegamenti restano come sono.
    //
    // Ordine: PRIMA l'insert dei nuovi, POI il delete dei tolti. Un guasto a
    // metà lascia al massimo obiettivi in PIÙ, mai zero (DL-015: almeno uno), e
    // al nuovo tentativo la differenza si ricalcola da ciò che c'è davvero.
    // Un guasto qui NON salta audit e notifica: la riga `valutazioni` è già
    // riscritta, e la traccia della rettifica va scritta comunque.
    let dopoObiettivi = primaObiettivi
    let obiettiviCambiati = false
    let obiettiviErr: unknown = null
    if (storica && scelta.ids !== null) { dopoObiettivi = scelta.ids; obiettiviCambiati = true }
    if (!storica && scelta.ids !== null) {
      const nuovi = new Set(scelta.ids)
      const vecchi = new Set(primaObiettivi)
      const daTogliere = primaObiettivi.filter((o) => !nuovi.has(o))
      const daAggiungere = scelta.ids.filter((o) => !vecchi.has(o))
      if (daAggiungere.length > 0) {
        const { error: insErr } = await supabase
          .from('valutazione_obiettivi')
          .insert(daAggiungere.map((oid) => ({ valutazione_id: id, obiettivo_id: oid })))
        if (insErr) obiettiviErr = insErr
        else {
          dopoObiettivi = [...primaObiettivi, ...daAggiungere]
          obiettiviCambiati = true
        }
      }
      if (!obiettiviErr && daTogliere.length > 0) {
        const { error: delErr } = await supabase
          .from('valutazione_obiettivi')
          .delete()
          .eq('valutazione_id', id)
          .in('obiettivo_id', daTogliere)
        if (delErr) obiettiviErr = delErr
        else obiettiviCambiati = true
      }
      if (!obiettiviErr) dopoObiettivi = scelta.ids
    }

    // La notifica al genitore ANCORA IN CODA porta nel corpo il giudizio di
    // prima: si allinea al testo nuovo. Non è un avviso nuovo (la spec non ne
    // vuole): è la stessa notifica, che non deve partire con un giudizio che non
    // esiste più. Una notifica già partita resta com'è.
    const legamiNotifica = await getGenitoriDiAlunniEsito(supabase, voce.alunno_id ? [voce.alunno_id] : [])
    if (!legamiNotifica.completo) {
      logEvento('notifica', 'error', { operazione, esito: 'valutazione-destinatari-non-risolti', valutazione_id: id })
    } else {
      const destinatari = [...new Set([...legamiNotifica.perAlunno.values()].flat())]
      if (destinatari.length) {
        const { error: notifErr } = await eseguiRitiroGiornate(() => {
          const notifica = supabase.from('notifiche')
          return (politicaModifica.sopprimiGenitori ? notifica.delete() : notifica.update({ corpo: giudizio }))
            .eq('tipo', 'valutazione').eq('entita_tipo', 'valutazione').eq('entita_id', id).in('utente_id', destinatari)
        }, { giorni: [giornoOriginale], storica: politicaModifica.sopprimiGenitori, operazione })
        if (notifErr) logEvento('notifica', 'error', { operazione, esito: 'notifica-in-coda-non-allineata', tipo: 'valutazione', valutazione_id: id }, notifErr)
      }
    }

    // `valoreDopo` porta gli obiettivi EFFETTIVAMENTE collegati, anche dopo un
    // passo fallito: l'audit dice com'è la riga, non come doveva essere.
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'valutazione',
      entitaId: id,
      azione: 'update',
      scuolaId: scuolaDellaClasse(voce) ?? materia.scuola_id,
      sectionId,
      valorePrima: fotografia(voce),
      valoreDopo: { ...val, obiettivi_ids: dopoObiettivi },
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user,
      sectionId,
      scuolaId: scuolaDellaClasse(voce) ?? materia.scuola_id,
      area: 'valutazioni',
      link: `/teacher/primaria/${sectionId}/valutazioni`,
    })

    if (obiettiviErr) return obiettiviNonAggiornati(operazione, id, obiettiviErr)

    // Il SUCCESSO si logga: una valutazione riscritta è una rettifica del registro.
    logEvento('registro', 'info', {
      operazione,
      esito: 'valutazione-modificata',
      valutazione_id: id,
      section_id: sectionId,
      attore_id: auth.user.id,
      tipo_cambiato: tipo !== voce.tipo,
      obiettivi_cambiati: obiettiviCambiati,
    }, undefined, { distingui: ['valutazione_id'] })

    return NextResponse.json({ success: true, data: { ...val, obiettivi_ids: dopoObiettivi } })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NON_SALVATA()
  }
})

/**
 * La valutazione è già riscritta, i collegamenti agli obiettivi no. Si dice
 * (500 con codice), invece di un 200 che farebbe credere il contrario: la
 * PATCH è idempotente, riprovare completa il lavoro.
 */
function obiettiviNonAggiornati(operazione: string, id: string, err: unknown): NextResponse {
  logEvento('db', 'error', { operazione, esito: 'valutazione_obiettivi_non_sostituiti', valutazione_id: id }, err)
  return NextResponse.json(
    {
      error: 'Valutazione salvata, ma gli obiettivi collegati non sono stati aggiornati. Riprova.',
      codice: 'VALUTAZIONE_OBIETTIVI_NON_AGGIORNATI',
    },
    { status: 500 },
  )
}

// DELETE /api/primaria/valutazioni?id=&userId=
// Cancellazione vera (spec: «Cancellazione vera più una traccia
// logScrittura('delete')»). Le righe `valutazione_obiettivi` vanno via con la FK
// ON DELETE CASCADE. La notifica al genitore ancora in coda si RITIRA; una già
// partita resta, e nessun avviso di rettifica.
export const DELETE = withRoute('primaria/valutazioni:DELETE', async (request: NextRequest) => {
  const operazione = 'primaria/valutazioni:DELETE'
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

    let cancellate: unknown[] | null
    let delErr: unknown = null
    const giorno = vocePrimaria(voce).dataEvento
    if (eRettificaStorica(auth.user, giorno)) {
      if (voce.storico_versione === undefined || !scuolaId) return storicoIndisponibile()
      const rettifica = await applicaRettificaStorica(supabase, { attore: auth.user, scuolaId, alunnoId: voce.alunno_id, sectionId, modulo: 'valutazioni', giorno, attese: [{ tabella: 'valutazioni', filtro: { id, section_id: sectionId }, versione: q.data.versioneAttesa }], azioni: [{ tabella: 'valutazioni', operazione: 'delete', filtro: { id, section_id: sectionId } }] })
      if ('response' in rettifica) return rettifica.response
      cancellate = rettifica.righe[0]
    } else {
      const esito = await supabase.from('valutazioni').delete().eq('id', id).eq('section_id', sectionId).select('id')
      cancellate = esito.data; delErr = esito.error
    }
    if (delErr) {
      logEvento('registro', 'error', { operazione, esito: 'valutazione-non-eliminata', valutazione_id: id }, delErr)
      return NextResponse.json(
        { error: 'Valutazione non eliminata. Riprova fra poco.', codice: 'VALUTAZIONE_NON_ELIMINATA' },
        { status: 500 },
      )
    }
    if (((cancellate ?? []) as unknown[]).length === 0) return NON_TROVATA()

    // Il ritiro viene DOPO la cancellazione riuscita: ritirare l'avviso e poi
    // non riuscire a cancellare lascerebbe una valutazione senza notifica.
    let nRitirate = 0
    let ritiroRiuscito = true
    const legamiNotifica = await getGenitoriDiAlunniEsito(supabase, voce.alunno_id ? [voce.alunno_id] : [])
    if (!legamiNotifica.completo) {
      ritiroRiuscito = false
      logEvento('notifica', 'error', { operazione, esito: 'valutazione-destinatari-non-risolti', valutazione_id: id })
    } else {
      const destinatari = [...new Set([...legamiNotifica.perAlunno.values()].flat())]
      if (destinatari.length) {
        const { data: ritirate, error: ritiroErr } = await eseguiRitiroGiornate(() => supabase.from('notifiche').delete().eq('tipo', 'valutazione')
          .eq('entita_tipo', 'valutazione').eq('entita_id', id).in('utente_id', destinatari).select('id'),
          { giorni: [vocePrimaria(voce).dataEvento], storica: eRettificaStorica(auth.user, vocePrimaria(voce).dataEvento), operazione })
        if (ritiroErr) {
          ritiroRiuscito = false
          logEvento('notifica', 'error', { operazione, esito: 'ritiro-notifica-valutazione-fallito', tipo: 'valutazione', valutazione_id: id }, ritiroErr)
        }
        else nRitirate = (ritirate ?? []).length
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'valutazione',
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
      esito: 'valutazione-eliminata',
      valutazione_id: id,
      section_id: sectionId,
      attore_id: auth.user.id,
      notifiche_ritirate: nRitirate,
      ritiro_riuscito: ritiroRiuscito,
    }, undefined, { distingui: ['valutazione_id'] })

    return NextResponse.json({ success: true, data: { id, notificheRitirate: nRitirate } })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Valutazione non eliminata. Riprova fra poco.', codice: 'VALUTAZIONE_NON_ELIMINATA' },
      { status: 500 },
    )
  }
})
