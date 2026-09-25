import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, type AppUser } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { getGenitoriDiAlunniEsito } from '@/lib/anagrafiche/legami'
import {
  chiaveVoce,
  dataEventoDaIstante,
  rispostaPermessoNegato,
  statoVoci,
  verificaPermessoVoce,
  type StatoVoce,
  type VocePrimaria,
} from '@/lib/primaria/permesso-voce'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const CATEGORIE = ['disciplinare', 'didattica', 'compiti_non_svolti'] as const
const AMBITI = ['alunno', 'gruppo'] as const

/** I tipi di notifica che una nota mette in coda per i genitori (vedi POST). */
const TIPI_NOTIFICA_NOTA = ['nota', 'nota_firma'] as const

/** Le colonne di una nota che servono a permessi, audit e risposta. */
const COLONNE_NOTA =
  'id, alunno_id, section_id, maestra_id, categoria, testo, richiede_firma, firmata_il, firmata_da, oscurata_ad_altri, nota_gruppo_id, creato_il'

const CODICE_NOTA_NON_TROVATA = 'NOTA_NON_TROVATA'
const CODICE_OPERAZIONE = 'NOTA_OPERAZIONE_NON_RIUSCITA'
const CODICE_LETTURA = 'LETTURA_FALLITA'

interface RigaNota {
  id: string
  alunno_id: string
  section_id: string | null
  maestra_id: string | null
  categoria: string
  testo: string
  richiede_firma: boolean | null
  firmata_il: string | null
  firmata_da: string | null
  oscurata_ad_altri: boolean | null
  nota_gruppo_id: string | null
  creato_il: string | null
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  sectionId: zUuid,
})

// richiedeFirma/oscurataAdAltri/docenteId restano volutamente permissivi
// (z.unknown()): oggi accettano qualunque valore (coercizioni !! e ?? true;
// docenteId validato da risolviValutatore, 422). NB: .optional() è necessario —
// z.unknown() come chiave di z.object è required a runtime.
const postBodySchema = z.object({
  sectionId: zUuid,
  alunnoIds: z.array(zUuid).min(1, 'alunnoIds[] obbligatorio'),
  categoria: z.enum(CATEGORIE, { error: `categoria in ${CATEGORIE.join('/')}` }),
  testo: z.string().min(1, 'testo obbligatorio'),
  richiedeFirma: z.unknown().optional(),
  oscurataAdAltri: z.unknown().optional(),
  docenteId: z.unknown().optional(),
})

// PATCH: si cambia almeno uno fra categoria, testo e richiesta di firma.
// `ambito` è obbligatorio: per una nota di gruppo la UI chiede OGNI volta
// «solo questo alunno / tutti» (spec 2026-09-24), e il server non sceglie al
// posto di chi scrive.
const patchBodySchema = z
  .object({
    id: zUuid,
    categoria: z.enum(CATEGORIE, { error: `categoria in ${CATEGORIE.join('/')}` }).optional(),
    // Niente `.trim()` che TRASFORMA: POST salva il testo così come arriva (spesso
    // con un a capo finale dalla textarea), e un testo rifilato messo a confronto
    // con quello salvato risulterebbe «cambiato» — azzerando la firma del
    // genitore su una nota riaperta e risalvata senza toccarla. Si valida solo
    // che non sia vuoto; il confronto normalizza (vedi `stessoValore`).
    testo: z
      .string()
      .refine((s) => s.trim().length > 0, { message: 'testo obbligatorio' })
      .optional(),
    richiedeFirma: z.boolean().optional(),
    ambito: z.enum(AMBITI, { error: `ambito in ${AMBITI.join('/')}` }),
  })
  .refine((b) => b.categoria !== undefined || b.testo !== undefined || b.richiedeFirma !== undefined, {
    message: 'nessuna modifica indicata (categoria, testo o richiedeFirma)',
  })

const deleteQuerySchema = z.object({
  id: zUuid,
  ambito: z.enum(AMBITI, { error: `ambito in ${AMBITI.join('/')}` }),
})

// ─── Risposte d'errore con codice ────────────────────────────────────────────
function notaNonTrovata(): NextResponse {
  return NextResponse.json(
    { error: 'La nota non esiste più.', codice: CODICE_NOTA_NON_TROVATA },
    { status: 404 },
  )
}

function operazioneNonRiuscita(): NextResponse {
  return NextResponse.json(
    { error: 'Operazione sulla nota non riuscita. Riprova.', codice: CODICE_OPERAZIONE },
    { status: 500 },
  )
}

function letturaFallita(): NextResponse {
  return NextResponse.json(
    { error: 'Lettura delle note non riuscita. Riprova.', codice: CODICE_LETTURA },
    { status: 500 },
  )
}

/** La sede della classe: dichiarata nell'audit e usata per i termini (`admin_settings`). */
async function scuolaDellaSezione(
  supabase: SupabaseClient,
  sectionId: string,
  operazione: string,
  /** Lo status che la route risponderà; `null` quando la lettura degrada senza errore (GET). */
  stato: number | null = 500,
): Promise<{ ok: true; scuolaId: string | null } | { ok: false }> {
  const { data, error } = await supabase.from('sections').select('scuola_id').eq('id', sectionId).maybeSingle()
  if (error) {
    logErrore({ operazione, stato: stato ?? undefined, evento: 'db' }, error)
    return { ok: false }
  }
  return { ok: true, scuolaId: ((data as { scuola_id?: string | null } | null)?.scuola_id ?? null) }
}

/** Una nota come VOCE per `permesso-voce`: autore = `maestra_id`, data = data di Roma di `creato_il`. */
function voceDi(n: Pick<RigaNota, 'id' | 'maestra_id' | 'creato_il'>, sectionId: string, scuolaId: string | null): VocePrimaria {
  return {
    tipo: 'nota',
    id: n.id,
    autoreId: n.maestra_id,
    sectionId,
    scuolaId,
    // `creato_il` senza valore non ha una data: la più vecchia possibile, cioè
    // oltre il termine. Si modifica solo con lo sblocco della Direzione, che è
    // il verso giusto in cui sbagliare su un registro con valore legale.
    dataEvento: n.creato_il ? dataEventoDaIstante(n.creato_il) : '1970-01-01',
  }
}

type Bersagli =
  | { response: NextResponse }
  | { nota: RigaNota; bersagli: RigaNota[]; sectionId: string; scuolaId: string | null; gruppo: boolean }

/**
 * Le note su cui agisce una PATCH/DELETE, e il permesso su CIASCUNA.
 *
 *  · `ambito: 'gruppo'` = tutte le note con lo stesso `nota_gruppo_id` NELLA
 *    STESSA CLASSE (quella di cui si è verificato lo scope: una nota di gruppo
 *    nasce sempre in una sola classe, vedi POST). Una nota senza gruppo →
 *    `'gruppo'` equivale ad `'alunno'`.
 *  · Il permesso (autore o staff, termine, sblocchi) deve valere su OGNI nota
 *    del gruppo: basta una bloccata o altrui per negare tutto — mai metà gruppo.
 */
async function caricaBersagli(
  supabase: SupabaseClient,
  utente: AppUser,
  id: string,
  ambito: (typeof AMBITI)[number],
  operazione: string,
): Promise<Bersagli> {
  const { data: letta, error } = await supabase.from('note_disciplinari').select(COLONNE_NOTA).eq('id', id).maybeSingle()
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'db' }, error)
    return { response: letturaFallita() }
  }
  const nota = letta as RigaNota | null
  // Una nota senza classe non è del registro di primaria: qui non si tocca.
  if (!nota || !nota.section_id) return { response: notaNonTrovata() }
  const sectionId = nota.section_id

  const scopeErr = await assertSezioneInScope(supabase, utente, sectionId)
  if (scopeErr) return { response: scopeErr }

  const sede = await scuolaDellaSezione(supabase, sectionId, operazione)
  if (!sede.ok) return { response: letturaFallita() }

  let bersagli: RigaNota[] = [nota]
  const gruppo = ambito === 'gruppo' && !!nota.nota_gruppo_id
  if (gruppo) {
    const { data: membri, error: errGruppo } = await supabase
      .from('note_disciplinari')
      .select(COLONNE_NOTA)
      .eq('nota_gruppo_id', nota.nota_gruppo_id as string)
      .eq('section_id', sectionId)
    if (errGruppo) {
      logErrore({ operazione, stato: 500, evento: 'db' }, errGruppo)
      return { response: letturaFallita() }
    }
    bersagli = (membri ?? []) as RigaNota[]
    if (bersagli.length === 0) return { response: notaNonTrovata() }
  }

  const voci = bersagli.map((n) => voceDi(n, sectionId, sede.scuolaId))
  const stato = await statoVoci(supabase, utente, voci)
  if (!stato.ok) return { response: rispostaPermessoNegato(stato) }
  // Le voci negate dal lotto si ri-verificano UNA per UNA con la porta singola,
  // che distingue «non sei l'autore» (403) da «oltre il termine» (423) nello
  // stesso ordine per tutte le route. Si ferma alla prima negata.
  for (const v of voci) {
    if (stato.esiti.get(chiaveVoce(v.tipo, v.id))?.modificabile) continue
    const esito = await verificaPermessoVoce(supabase, utente, v)
    if (!esito.ok) return { response: rispostaPermessoNegato(esito) }
  }

  return { nota, bersagli, sectionId, scuolaId: sede.scuolaId, gruppo }
}

/**
 * Ritira le notifiche della nota ancora IN CODA (push non partita) dopo
 * un'eliminazione. Nessuna rettifica per quelle già partite (spec: nessun
 * avviso al genitore quando si modifica o si elimina).
 *
 * La notifica è UNA per genitore e per gruppo (`entita_id` = `nota_gruppo_id`,
 * vedi POST). Se nel gruppo restano altre note, si ritira solo quella dei
 * genitori che non hanno più nessun figlio con una nota viva nel gruppo — un
 * fratello a cui resta la nota tiene l'avviso. Nel dubbio (legami non letti per
 * intero) non si ritira niente: un avviso in più è meglio di uno tolto a chi
 * doveva riceverlo.
 */
async function ritiraNotificheInCoda(
  supabase: SupabaseClient,
  gruppoId: string | null,
  alunniEliminati: string[],
  operazione: string,
): Promise<number> {
  // Le note nate prima di questo intervento non portano `entita_id`: non c'è
  // modo di riconoscerne la notifica senza toccare quelle di altre note.
  if (!gruppoId) return 0
  const campi = { operazione, entita_tipo: 'nota', gruppo_id: gruppoId }

  const { data: restanti, error: errRestanti } = await supabase
    .from('note_disciplinari')
    .select('alunno_id')
    .eq('nota_gruppo_id', gruppoId)
  if (errRestanti) {
    logEvento('notifica', 'error', { ...campi, esito: 'ritiro-notifiche-restanti-non-lette' }, errRestanti)
    return 0
  }
  const alunniRestanti = [...new Set(((restanti ?? []) as { alunno_id: string }[]).map((r) => r.alunno_id))]

  let destinatari: string[] | null = null
  if (alunniRestanti.length > 0) {
    const [eliminati, rimasti] = await Promise.all([
      getGenitoriDiAlunniEsito(supabase, alunniEliminati),
      getGenitoriDiAlunniEsito(supabase, alunniRestanti),
    ])
    if (!eliminati.completo || !rimasti.completo) {
      logEvento('notifica', 'warn', { ...campi, esito: 'ritiro-notifiche-saltato-legami-incompleti' })
      return 0
    }
    const tengono = new Set([...rimasti.perAlunno.values()].flat())
    destinatari = [...new Set([...eliminati.perAlunno.values()].flat())].filter((g) => !tengono.has(g))
    if (destinatari.length === 0) return 0
  }

  let q = supabase
    .from('notifiche')
    .delete()
    .eq('entita_tipo', 'nota')
    .eq('entita_id', gruppoId)
    .in('tipo', [...TIPI_NOTIFICA_NOTA])
    .is('push_inviata_il', null)
  if (destinatari) q = q.in('utente_id', destinatari)
  const { data: ritirate, error } = await q.select('id')
  if (error) {
    // `error`: la nota non c'è più, ma il suo avviso partirà lo stesso.
    logEvento('notifica', 'error', { ...campi, esito: 'ritiro-notifiche-fallito' }, error)
    return 0
  }
  const n = ((ritirate ?? []) as unknown[]).length
  logEvento('notifica', 'info', { ...campi, esito: 'notifiche-nota-ritirate', n })
  return n
}

/** Tipo e titolo dell'avviso di una nota: gli stessi in POST e in PATCH. */
function avvisoNota(richiedeFirma: boolean): { tipo: (typeof TIPI_NOTIFICA_NOTA)[number]; titolo: string } {
  return richiedeFirma
    ? { tipo: 'nota_firma', titolo: 'Nuova nota — richiesta firma' }
    : { tipo: 'nota', titolo: 'Nuova nota' }
}

/** L'anteprima del testo nell'avviso: la stessa in POST e in PATCH. */
function corpoAvviso(testo: string): string {
  return testo.slice(0, 140)
}

/**
 * Allinea l'avviso della nota ancora IN CODA (push non partita) dopo una
 * modifica. Non è un avviso nuovo (la spec non ne vuole): è la stessa notifica,
 * che non deve partire col testo di prima — magari proprio la frase corretta
 * perché sbagliata — né come «richiesta firma» se la firma non si chiede più.
 * Quelle già partite restano com'erano. Stesso principio di valutazioni:PATCH.
 *
 * `alunniModificati` null = tutti gli avvisi del gruppo; altrimenti solo quelli
 * dei genitori di quegli alunni. Nel dubbio (legami non letti per intero) non si
 * tocca niente, con un `warn`: meglio un'anteprima vecchia che il testo di un
 * alunno nell'avviso di un altro.
 */
async function allineaNotificheInCoda(
  supabase: SupabaseClient,
  opts: {
    gruppoId: string | null
    alunniModificati: string[] | null
    testo: string | undefined
    richiedeFirma: boolean | undefined
    operazione: string
  },
): Promise<number> {
  const { gruppoId, alunniModificati, testo, richiedeFirma, operazione } = opts
  // Una modifica della sola categoria non cambia niente dell'avviso; le note
  // nate prima di `entita_id` = gruppo non hanno un avviso riconoscibile.
  if (!gruppoId || (testo === undefined && richiedeFirma === undefined)) return 0
  const campi = { operazione, entita_tipo: 'nota', gruppo_id: gruppoId }

  const valori: { corpo?: string; tipo?: string; titolo?: string } = {}
  if (testo !== undefined) valori.corpo = corpoAvviso(testo)
  if (richiedeFirma !== undefined) Object.assign(valori, avvisoNota(richiedeFirma))

  let destinatari: string[] | null = null
  if (alunniModificati) {
    const legami = await getGenitoriDiAlunniEsito(supabase, alunniModificati)
    if (!legami.completo) {
      logEvento('notifica', 'warn', { ...campi, esito: 'allineamento-notifiche-saltato-legami-incompleti' })
      return 0
    }
    destinatari = [...new Set([...legami.perAlunno.values()].flat())]
    if (destinatari.length === 0) return 0
  }

  let q = supabase
    .from('notifiche')
    .update(valori)
    .eq('entita_tipo', 'nota')
    .eq('entita_id', gruppoId)
    .in('tipo', [...TIPI_NOTIFICA_NOTA])
    .is('push_inviata_il', null)
  if (destinatari) q = q.in('utente_id', destinatari)
  const { data: allineate, error } = await q.select('id')
  if (error) {
    // `error`: la nota è cambiata, ma l'avviso partirà col contenuto di prima.
    logEvento('notifica', 'error', { ...campi, esito: 'notifica-in-coda-non-allineata' }, error)
    return 0
  }
  const n = ((allineate ?? []) as unknown[]).length
  logEvento('notifica', 'info', { ...campi, esito: 'notifiche-nota-allineate', n })
  return n
}

/**
 * Permesso-voce di ogni nota in elenco e i membri di ogni gruppo, anche oltre
 * le 50 note in elenco: il conteggio e il permesso sul gruppo intero non possono
 * dipendere dal taglio della lista. `null` = qualcosa non si è letto (già a log).
 */
async function statoNoteDellaClasse(
  supabase: SupabaseClient,
  utente: AppUser,
  sectionId: string,
  note: Pick<RigaNota, 'id' | 'maestra_id' | 'creato_il' | 'nota_gruppo_id'>[],
): Promise<{ esito: (id: string) => StatoVoce | undefined; perGruppo: Map<string, string[]> } | null> {
  const operazione = 'primaria/note:GET'
  const sede = await scuolaDellaSezione(supabase, sectionId, operazione, null)
  if (!sede.ok) return null

  const gruppi = [...new Set(note.map((n) => n.nota_gruppo_id).filter((g): g is string => !!g))]
  const membri: Pick<RigaNota, 'id' | 'maestra_id' | 'creato_il' | 'nota_gruppo_id'>[] = []
  if (gruppi.length > 0) {
    const { data: righe, error: errGruppi } = await supabase
      .from('note_disciplinari')
      .select('id, maestra_id, creato_il, nota_gruppo_id')
      .in('nota_gruppo_id', gruppi)
      .eq('section_id', sectionId)
    if (errGruppi) {
      logErrore({ operazione, evento: 'db' }, errGruppi)
      return null
    }
    membri.push(...((righe ?? []) as typeof membri))
  }

  const perId = new Map<string, Pick<RigaNota, 'id' | 'maestra_id' | 'creato_il'>>()
  for (const n of [...note, ...membri]) perId.set(n.id, n)
  const stato = await statoVoci(
    supabase,
    utente,
    [...perId.values()].map((n) => voceDi(n, sectionId, sede.scuolaId)),
  )
  if (!stato.ok) return null

  const perGruppo = new Map<string, string[]>()
  for (const m of membri) {
    const g = m.nota_gruppo_id as string
    const ids = perGruppo.get(g) ?? []
    if (!ids.includes(m.id)) ids.push(m.id)
    perGruppo.set(g, ids)
  }
  return { esito: (id) => stato.esiti.get(chiaveVoce('nota', id)), perGruppo }
}

// GET /api/primaria/note?sectionId=&userId=  (vista docente: ultime note della classe)
// Per ogni nota: `modificabile`/`bloccata`/`giorni_limite` (permesso-voce), il
// gruppo (`nota_gruppo_id`), quanti alunni ha (`n_alunni_gruppo`) e se il
// gruppo INTERO si può modificare/eliminare (`gruppo_modificabile`), perché la
// scelta «tutti» vale solo se vale su ogni nota del gruppo.
export const GET = withRoute('primaria/note:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const { data, error } = await supabase
      .from('note_disciplinari')
      .select('id, alunno_id, maestra_id, categoria, testo, richiede_firma, firmata_il, oscurata_ad_altri, nota_gruppo_id, creato_il, alunni(nome, cognome)')
      .eq('section_id', sectionId)
      .order('creato_il', { ascending: false })
      .limit(50)
    if (error) {
      logErrore({ operazione: 'primaria/note:GET', stato: 500, evento: 'db' }, error)
      return letturaFallita()
    }
    const note = (data ?? []) as unknown as (RigaNota & Record<string, unknown>)[]
    if (note.length === 0) return NextResponse.json({ success: true, data: [], statoVociDisponibile: true })

    // Da qui si calcolano solo i BOTTONI. Un guasto di lettura (sede, membri dei
    // gruppi, termini o sblocchi) non toglie l'elenco delle note: si vedono lo
    // stesso, senza Modifica/Elimina (fail-closed) e con il flag
    // `statoVociDisponibile: false` che lo dichiara — mai «bloccata» inventata.
    // Come valutazioni:GET. Ogni guasto è già a log (qui o in permesso-voce).
    const esiti = await statoNoteDellaClasse(supabase, auth.user, sectionId, note)

    const arricchite = note.map((n) => {
      // Senza i membri letti, il gruppo si conta dal solo elenco.
      const ids = n.nota_gruppo_id
        ? esiti?.perGruppo.get(n.nota_gruppo_id) ?? note.filter((m) => m.nota_gruppo_id === n.nota_gruppo_id).map((m) => m.id)
        : [n.id]
      const e = esiti?.esito(n.id)
      return {
        ...n,
        modificabile: e?.modificabile ?? false,
        bloccata: e?.bloccata ?? false,
        giorni_limite: e?.giorniLimite ?? null,
        n_alunni_gruppo: ids.length,
        gruppo_modificabile: !!esiti && ids.every((id) => esiti.esito(id)?.modificabile === true),
      }
    })
    return NextResponse.json({ success: true, data: arricchite, statoVociDisponibile: !!esiti })
  } catch (err) {
    logErrore({ operazione: 'primaria/note:GET', stato: 500 }, err)
    return letturaFallita()
  }
})

// POST /api/primaria/note?userId=
// body: { sectionId, alunnoIds[], categoria, testo, richiedeFirma?, oscurataAdAltri? }
export const POST = withRoute('primaria/note:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { sectionId, alunnoIds, categoria, testo, richiedeFirma, oscurataAdAltri } = b.data
    const docenteId = b.data.docenteId as string | null | undefined

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // Gli alunni destinatari devono appartenere alla sezione asserita (no note cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, alunnoIds, sectionId)
    if (alunniErr) return alunniErr

    // Autore della nota = docente (vincolo FEA). educator → sé stesso; segreteria
    // → docente titolare indicato in body.docenteId (validato), altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId })
    if (vr.response) return vr.response
    const maestraId = vr.valutatoreId

    // Gruppo condiviso per assegnazione massiva (trattamento coerente delle note collettive).
    const notaGruppoId = crypto.randomUUID()

    const rows = alunnoIds.map((aid) => ({
      alunno_id: aid,
      section_id: sectionId,
      maestra_id: maestraId,
      categoria,
      testo,
      richiede_firma: !!richiedeFirma,
      oscurata_ad_altri: oscurataAdAltri ?? true,
      nota_gruppo_id: notaGruppoId,
    }))

    const { data, error } = await supabase.from('note_disciplinari').insert(rows).select()
    if (error) {
      logErrore({ operazione: 'primaria/note:POST', stato: 500, evento: 'db' }, error)
      return operazioneNonRiuscita()
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'nota',
      entitaId: notaGruppoId,
      azione: 'insert',
      sectionId,
      valoreDopo: data ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'note', link: `/teacher/primaria/${sectionId}/note` })

    // Notifica nota (con buffer; richiesta firma se prevista). Best-effort.
    // `entitaId` = il GRUPPO: è ciò che permette a DELETE di ritirare l'avviso
    // ancora in coda di una nota eliminata (la notifica è una per genitore e per
    // gruppo, non una per alunno).
    try {
      await enqueueNotifichePerAlunni(supabase, {
        alunnoIds,
        ...avvisoNota(!!richiedeFirma),
        corpo: corpoAvviso(testo),
        link: '/parent/primaria/note',
        entitaTipo: 'nota',
        entitaId: notaGruppoId,
      })
    } catch (e) {
      // La nota è salvata; è l'avviso ai genitori a non essere partito.
      logEvento('notifica', 'error', {
        operazione: 'primaria/note:POST',
        tipo: richiedeFirma ? 'nota_firma' : 'nota',
        esito: 'notifica-non-accodata',
      }, e)
    }

    return NextResponse.json({ success: true, data: data ?? [] }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'primaria/note:POST', stato: 500 }, err)
    return operazioneNonRiuscita()
  }
})

// PATCH /api/primaria/note
// body: { id, categoria?, testo?, richiedeFirma?, ambito: 'alunno'|'gruppo' }
// Nota già FIRMATA dal genitore e poi modificata → la firma si AZZERA
// (`firmata_il`/`firmata_da` a null, `nota_ricezioni` cancellate): il genitore
// la rifirma sul testo nuovo. Nessun avviso al genitore.
export const PATCH = withRoute('primaria/note:PATCH', async (request: NextRequest) => {
  const operazione = 'primaria/note:PATCH'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, ambito, categoria, testo, richiedeFirma } = b.data

    const supabase = await createAdminClient()
    const t = await caricaBersagli(supabase, auth.user, id, ambito, operazione)
    if ('response' in t) return t.response

    const patch: Partial<Pick<RigaNota, 'categoria' | 'testo' | 'richiede_firma'>> = {}
    if (categoria !== undefined) patch.categoria = categoria
    if (testo !== undefined) patch.testo = testo
    if (richiedeFirma !== undefined) patch.richiede_firma = richiedeFirma

    // Solo le note che cambiano davvero: rimandare lo stesso testo non deve
    // cancellare la firma di un genitore. Il testo si confronta RIFILATO: spazi
    // o a capo in coda non sono una modifica.
    const stessoValore = (n: RigaNota, k: keyof typeof patch): boolean =>
      k === 'testo' ? String(n.testo ?? '').trim() === String(patch.testo ?? '').trim() : n[k] === patch[k]
    const cambiate = t.bersagli.filter((n) =>
      (Object.keys(patch) as (keyof typeof patch)[]).some((k) => !stessoValore(n, k)),
    )
    if (cambiate.length === 0) {
      logEvento('registro', 'info', { operazione, esito: 'nota-invariata', gruppo: t.gruppo, n: 0 })
      return NextResponse.json({ success: true, data: t.bersagli, modificate: 0, firme_azzerate: 0 })
    }
    const ids = cambiate.map((n) => n.id)
    const firmate = cambiate.filter((n) => n.firmata_il != null).length

    // Le prese visione firmate si riferivano al testo VECCHIO: si cancellano
    // PRIMA di toccare la nota. L'ordine inverso non si ripara: con l'update
    // riuscito e la cancellazione fallita, la firma del genitore resterebbe
    // attaccata al testo NUOVO, e un nuovo tentativo troverebbe il testo già
    // uguale (`nota-invariata`) senza più cancellarla. Così, se si ferma qui, la
    // nota è intatta; se si ferma all'update, al nuovo tentativo la nota risulta
    // ancora «cambiata» e il lavoro si completa.
    const { data: ricezioni, error: errRicezioni } = await supabase
      .from('nota_ricezioni')
      .delete()
      .in('nota_id', ids)
      .select('id')
    if (errRicezioni) {
      logEvento('registro', 'error', {
        operazione,
        esito: 'firme-nota-non-azzerate',
        entita_tipo: 'nota',
        n: ids.length,
      }, errRicezioni)
      return operazioneNonRiuscita()
    }

    const { data: dopo, error } = await supabase
      .from('note_disciplinari')
      .update({ ...patch, firmata_il: null, firmata_da: null })
      .in('id', ids)
      .eq('section_id', t.sectionId)
      .select(COLONNE_NOTA)
    if (error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, error)
      return operazioneNonRiuscita()
    }

    const allineate = await allineaNotificheInCoda(supabase, {
      gruppoId: t.nota.nota_gruppo_id,
      // «tutti» (o nota senza gruppo): ogni avviso del gruppo. «Solo questo
      // alunno» su una nota di gruppo: solo i genitori degli alunni modificati.
      alunniModificati: t.gruppo ? null : [...new Set(cambiate.map((n) => n.alunno_id))],
      testo: patch.testo,
      richiedeFirma: patch.richiede_firma ?? undefined,
      operazione,
    })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'nota',
      entitaId: t.gruppo ? t.nota.nota_gruppo_id : t.nota.id,
      azione: 'update',
      scuolaId: t.scuolaId,
      sectionId: t.sectionId,
      valorePrima: cambiate,
      valoreDopo: dopo ?? [],
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user,
      sectionId: t.sectionId,
      scuolaId: t.scuolaId,
      area: 'note',
      link: `/teacher/primaria/${t.sectionId}/note`,
    })

    logEvento('registro', 'info', {
      operazione,
      esito: 'nota-modificata',
      gruppo: t.gruppo,
      n: ids.length,
      firme_azzerate: firmate,
      ricezioni_cancellate: ((ricezioni ?? []) as unknown[]).length,
      notifiche_allineate: allineate,
    })
    return NextResponse.json({
      success: true,
      data: dopo ?? [],
      modificate: ids.length,
      firme_azzerate: firmate,
    })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return operazioneNonRiuscita()
  }
})

// DELETE /api/primaria/note?id=&ambito=alunno|gruppo
// Anche una nota firmata si elimina: la firma (`nota_ricezioni`) va via con lei
// (ON DELETE CASCADE). Si ritirano gli avvisi ancora in coda; nessun avviso nuovo.
export const DELETE = withRoute('primaria/note:DELETE', async (request: NextRequest) => {
  const operazione = 'primaria/note:DELETE'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id, ambito } = q.data

    const supabase = await createAdminClient()
    const t = await caricaBersagli(supabase, auth.user, id, ambito, operazione)
    if ('response' in t) return t.response

    const ids = t.bersagli.map((n) => n.id)
    const { data: cancellate, error } = await supabase
      .from('note_disciplinari')
      .delete()
      .in('id', ids)
      .eq('section_id', t.sectionId)
      .select('id, alunno_id')
    if (error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, error)
      return operazioneNonRiuscita()
    }
    const via = (cancellate ?? []) as { id: string; alunno_id: string }[]
    if (via.length === 0) return notaNonTrovata()
    const viaIds = new Set(via.map((r) => r.id))
    const eliminate = t.bersagli.filter((n) => viaIds.has(n.id))
    const firmeRimosse = eliminate.filter((n) => n.firmata_il != null).length

    const ritirate = await ritiraNotificheInCoda(
      supabase,
      t.nota.nota_gruppo_id,
      [...new Set(via.map((r) => r.alunno_id))],
      operazione,
    )

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'nota',
      entitaId: t.gruppo ? t.nota.nota_gruppo_id : t.nota.id,
      azione: 'delete',
      scuolaId: t.scuolaId,
      sectionId: t.sectionId,
      valorePrima: eliminate,
      valoreDopo: null,
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user,
      sectionId: t.sectionId,
      scuolaId: t.scuolaId,
      area: 'note',
      link: `/teacher/primaria/${t.sectionId}/note`,
    })

    logEvento('registro', 'info', {
      operazione,
      esito: 'nota-eliminata',
      gruppo: t.gruppo,
      n: via.length,
      firme_rimosse: firmeRimosse,
      notifiche_ritirate: ritirate,
    })
    return NextResponse.json({ success: true, eliminate: via.length, firme_rimosse: firmeRimosse })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return operazioneNonRiuscita()
  }
})
