import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunnoInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { renderGiudizioDescrittivo, type Dimensioni } from '@/lib/primaria/giudizio'
import { leggiObiettiviDisponibili, obiettiviDisponibili } from '@/lib/primaria/obiettivi'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import {
  chiaveVoce,
  dataEventoDaIstante,
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

// Le due regole di coerenza fra modalità e giudizio, condivise da POST e PATCH.
const dimsSeDimensioni = (b: { modalita: string; dims?: unknown }) => b.modalita !== 'dimensioni' || Boolean(b.dims)
const REGOLA_DIMS = { message: 'dimensioni obbligatorie per la modalità dimensioni', path: ['dims'] }
const sinteticoSeSintetico = (b: { modalita: string; giudizioSintetico?: string | null }) =>
  b.modalita !== 'sintetico' || Boolean(b.giudizioSintetico)
const REGOLA_SINTETICO = { message: 'giudizio sintetico obbligatorio', path: ['giudizioSintetico'] }

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
  .refine(sinteticoSeSintetico, REGOLA_SINTETICO)

// PATCH: la voce per `id` più gli stessi campi della POST. Un'eccezione sola,
// voluta: `tipoProva` ASSENTE lascia il tipo com'è, invece di ricadere su
// 'orale' come nella POST — una modifica che non nomina il tipo non deve
// trasformare in silenzio una verifica scritta (15 giorni) in un'orale (2).
const patchBodySchema = z
  .object({
    id: zUuid,
    tipoProva: z.string().nullish(),
    ...campiGiudizio,
  })
  .refine(dimsSeDimensioni, REGOLA_DIMS)
  .refine(sinteticoSeSintetico, REGOLA_SINTETICO)

const deleteQuerySchema = z.object({ id: zUuid })

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
  id, alunno_id, maestra_id, section_id, materia, materia_id, tipo, modalita, argomento,
  dim_autonomia, dim_continuita, dim_tipologia, dim_risorse,
  giudizio_sintetico, giudizio_testo, annotazione_numerica, lock_tipo, pubblicato, creato_il,
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

function vocePrimaria(riga: RigaVoce): VocePrimaria {
  return {
    tipo: 'valutazione',
    id: riga.id,
    autoreId: riga.maestra_id,
    sectionId: riga.section_id as string,
    scuolaId: scuolaDellaClasse(riga),
    // Convenzione della spec: la data dell'evento di una valutazione è la data
    // di ROMA di `creato_il`. Una data illeggibile è bloccata (fail-closed).
    dataEvento: dataEventoDaIstante(String(riga.creato_il ?? '')),
    lockTipo: lockTipoDiRiga(riga),
  }
}

const NON_TROVATA = () =>
  NextResponse.json(
    { error: 'Valutazione non trovata: forse è già stata eliminata. Ricarica la pagina.', codice: 'VALUTAZIONE_NON_TROVATA' },
    { status: 404 },
  )

/**
 * Legge la voce (solo primaria: `modalita` valorizzata) e verifica scope e
 * permesso. Restituisce la riga, oppure la risposta di rifiuto già pronta.
 *
 * Il termine è quello della voce COM'È ADESSO — lo stesso che la GET mostra
 * con `modificabile`/`bloccata`. Una PATCH che cambia il tipo della prova non
 * aggiunge un secondo controllo sul tipo nuovo: renderebbe incoerenti GET e
 * PATCH (una scritta di 10 giorni, «modificabile» per la GET, diventerebbe un
 * 423 «chiedi lo sblocco» che la Direzione non potrebbe mai dare, perché per la
 * GET la voce non è bloccata). La regola «su entrambe le date» della spec
 * riguarda la DATA, che una valutazione non sposta (è `creato_il`).
 */
async function voceAutorizzata(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: Parameters<typeof verificaPermessoVoce>[1],
  id: string,
  operazione: string,
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

  const permesso = await verificaPermessoVoce(supabase, user, vocePrimaria(riga))
  if (!permesso.ok) return { response: rispostaPermessoNegato(permesso) }
  return { riga }
}

// GET /api/primaria/valutazioni?alunnoId=&materiaId=&userId=
export const GET = withRoute('primaria/valutazioni:GET', async (request: NextRequest) => {
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

    let query = supabase
      .from('valutazioni')
      .select(`
        id, alunno_id, maestra_id, section_id, materia, materia_id, tipo, modalita, argomento,
        dim_autonomia, dim_continuita, dim_tipologia, dim_risorse,
        giudizio_sintetico, giudizio_testo, annotazione_numerica, lock_tipo, pubblicato, creato_il,
        valutazione_obiettivi(obiettivo_id, obiettivi_apprendimento(id, codice, descrizione)),
        sections(scuola_id)
      `)
      .not('modalita', 'is', null) // solo valutazioni in itinere (primaria)
      .order('creato_il', { ascending: false })
      .eq('alunno_id', alunnoId)
    if (materiaId) query = query.eq('materia_id', materiaId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Per ogni voce: `modificabile` (Modifica/Elimina si mostrano) e `bloccata`
    // (oltre il termine senza sblocco: la Direzione vede «Sblocca»). Variante
    // BATCH di permesso-voce: una lettura per sede, non una per voce.
    const righe = (data ?? []) as unknown as RigaVoce[]
    const voci = righe.filter((r) => r.section_id).map((r) => vocePrimaria(r))
    const stato = await statoVoci(supabase, auth.user, voci)
    // Un guasto di lettura dei permessi NON toglie l'elenco: le valutazioni si
    // vedono lo stesso, ma senza bottoni (fail-closed) e con il flag che lo
    // dichiara — mai «bloccata» inventata. Il guasto l'ha già loggato permesso-voce.
    const esiti = stato.ok ? stato.esiti : null
    const elenco = righe.map((r) => {
      const { sections: _s, ...resto } = r
      void _s
      const e = esiti?.get(chiaveVoce('valutazione', r.id))
      return {
        ...resto,
        modificabile: e?.modificabile ?? false,
        bloccata: e?.bloccata ?? false,
        giorniLimite: e?.giorniLimite ?? null,
      }
    })
    return NextResponse.json({ success: true, data: elenco, statoVociDisponibile: stato.ok })
  } catch (err) {
    logErrore({ operazione: 'primaria/valutazioni:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/valutazioni?userId=
// body: { alunnoId, sectionId, materiaId, tipoProva, modalita,
//         dims:{autonomia,continuita,tipologia,risorse}, giudizioSintetico,
//         giudizioTesto?, obiettiviIds[], data? }
export const POST = withRoute('primaria/valutazioni:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const {
      alunnoId, sectionId, materiaId, tipoProva, modalita,
      giudizioSintetico, giudizioTesto, argomento, data, annotazioneNumerica,
    } = b.data
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

    const supabase = await createAdminClient()

    // Scope per tenant/classe (educator: solo sezioni assegnate; staff/segreteria: plesso).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // L'alunno valutato deve appartenere alla sezione asserita (no valutazioni cross-sezione).
    const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
    if (alunnoErr) return alunnoErr

    // Autore della valutazione = docente (vincolo FEA). educator → sé stesso;
    // segreteria → docente titolare della MATERIA indicato in body.docenteId, altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId, materiaId })
    if (vr.response) return vr.response
    const maestraId = vr.valutatoreId

    // Materia (nome per il campo NOT NULL legacy) + scuola + codice (per obiettivi).
    const { data: materia } = await supabase
      .from('materie')
      .select('nome, codice, scuola_id, section_id')
      .eq('id', materiaId)
      .maybeSingle()
    if (!materia) return NextResponse.json({ error: 'Materia non trovata' }, { status: 404 })
    // La materia deve essere del catalogo della sezione asserita: il suo scuola_id
    // pilota timelock, template giudizio e audit — mai da un tenant estraneo.
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

    // Vincolo temporale (scritto/pratico=15gg, orale=2gg). Data evento = data o oggi.
    const eventDate = data ?? new Date().toISOString().slice(0, 10)
    const lockTipo = lockTipoDaTipo(tipoProva)
    const lock = await isOltreScadenza(supabase, materia.scuola_id, eventDate, lockTipo)
    if (lock.locked) {
      return NextResponse.json(
        { error: `Inserimento bloccato: superato il termine di ${lock.giorniLimite} giorni.`, locked: true },
        { status: 423 }
      )
    }

    // Giudizio descrittivo: override del docente o auto-generato dai template.
    let testo = giudizioTesto ?? null
    if (modalita === 'dimensioni' && dims && !testo) {
      testo = await renderGiudizioDescrittivo(supabase, materia.scuola_id, dims)
    }

    const { data: val, error: valErr } = await supabase
      .from('valutazioni')
      .insert({
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
        giudizio_sintetico: modalita === 'sintetico' ? giudizioSintetico : null,
        giudizio_testo: testo,
        voto_numerico: null, // voto ufficiale numerico vietato alla primaria
        annotazione_numerica: annNum, // appunto privato del docente (mai al genitore)
        lock_tipo: lockTipo,
        pubblicato: false, // buffer notifica (F1.8)
      })
      .select()
      .single()
    if (valErr) return NextResponse.json({ error: valErr.message }, { status: 500 })

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

    // Notifica valutazione con buffer (default 10 min). Best-effort.
    try {
      const { data: settings } = await supabase
        .from('admin_settings')
        .select('notif_buffer_valutazioni_min')
        .eq('scuola_id', materia.scuola_id)
        .maybeSingle()
      await enqueueNotifichePerAlunni(supabase, {
        alunnoIds: [alunnoId],
        tipo: 'valutazione',
        titolo: `Nuova valutazione di ${materia.nome}`,
        corpo: giudizioSintetico || testo || undefined,
        link: '/parent/primaria/valutazioni',
        entitaTipo: 'valutazione',
        entitaId: val.id,
        bufferMin: settings?.notif_buffer_valutazioni_min ?? 10,
      })
    } catch { /* non bloccare */ }

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
// SOSTITUISCONO. Permesso: autore (`maestra_id`) o Segreteria/Direzione, entro
// il termine sulla data di Roma di `creato_il`, o con lo sblocco (permesso-voce).
// Nessun avviso al genitore (spec 2026-09-24, «2 Primaria»).
export const PATCH = withRoute('primaria/valutazioni:PATCH', async (request: NextRequest) => {
  const operazione = 'primaria/valutazioni:PATCH'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, modalita, giudizioSintetico, giudizioTesto, argomento, annotazioneNumerica, obiettiviIds } = b.data
    const dims = b.data.dims as Dimensioni | undefined

    const annNum = leggiAnnotazione(annotazioneNumerica)
    if (annNum === undefined) {
      return NextResponse.json(
        { error: "L'annotazione numerica deve essere un valore tra 0 e 10", codice: 'VALUTAZIONE_ANNOTAZIONE_NON_VALIDA' },
        { status: 400 },
      )
    }

    const supabase = await createAdminClient()

    // `tipoProva` assente = il tipo resta quello salvato (vedi patchBodySchema).
    const tipoRichiesto = b.data.tipoProva
    const lettura = await voceAutorizzata(supabase, auth.user, id, operazione)
    if ('response' in lettura) return lettura.response
    const voce = lettura.riga
    const sectionId = voce.section_id as string
    const tipo = tipoRichiesto === undefined ? voce.tipo : tipoRichiesto
    const lockTipo = tipoRichiesto === undefined ? lockTipoDiRiga(voce) : lockTipoDaTipo(tipoRichiesto)

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

    const { data: aggiornate, error: updErr } = await supabase
      .from('valutazioni')
      .update({
        argomento: argomento.trim(),
        tipo,
        modalita,
        dim_autonomia: modalita === 'dimensioni' ? dims?.autonomia ?? null : null,
        dim_continuita: modalita === 'dimensioni' ? dims?.continuita ?? null : null,
        dim_tipologia: modalita === 'dimensioni' ? dims?.tipologia ?? null : null,
        dim_risorse: modalita === 'dimensioni' ? dims?.risorse ?? null : null,
        giudizio_sintetico: modalita === 'sintetico' ? giudizioSintetico : null,
        giudizio_testo: testo,
        annotazione_numerica: annNum,
        lock_tipo: lockTipo,
      })
      .eq('id', id)
      .eq('section_id', sectionId)
      .select()
    if (updErr) {
      logEvento('registro', 'error', { operazione, esito: 'valutazione-non-aggiornata', valutazione_id: id }, updErr)
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
    if (scelta.ids !== null) {
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
    const { error: notifErr } = await supabase
      .from('notifiche')
      .update({ corpo: (modalita === 'sintetico' ? giudizioSintetico : null) || testo || null })
      .eq('entita_tipo', 'valutazione')
      .eq('entita_id', id)
      .is('push_inviata_il', null)
    if (notifErr) {
      logEvento('notifica', 'error', {
        operazione,
        esito: 'notifica-in-coda-non-allineata',
        tipo: 'valutazione',
        valutazione_id: id,
      }, notifErr)
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

    const { data: cancellate, error: delErr } = await supabase
      .from('valutazioni')
      .delete()
      .eq('id', id)
      .eq('section_id', sectionId)
      .select('id')
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
    const { data: ritirate, error: ritiroErr } = await supabase
      .from('notifiche')
      .delete()
      .eq('entita_tipo', 'valutazione')
      .eq('entita_id', id)
      .is('push_inviata_il', null)
      .select('id')
    if (ritiroErr) {
      // `error` benché la cancellazione sia riuscita: la notifica resta in coda e
      // partirà per una valutazione che non esiste più.
      logEvento('notifica', 'error', {
        operazione,
        esito: 'ritiro-notifica-valutazione-fallito',
        tipo: 'valutazione',
        valutazione_id: id,
      }, ritiroErr)
    }
    const nRitirate = ((ritirate ?? []) as unknown[]).length

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
      ritiro_riuscito: !ritiroErr,
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
