import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { requireUser } from '@/lib/auth/require-staff'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { dataRomaDi } from '@/lib/primaria/timelock'
import { MOTIVO_MAX_CARATTERI, motivoNormalizzato } from '@/lib/presenze/limiti-testo'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` resta stringa permissiva (oggi il DB accetta anche formati non YYYY-MM-DD);
// `motivo` permissivo: oggi qualunque tipo è accettato (i non-string diventano null).
const postBodySchema = z.object({
  studentId: zUuid,
  data: z.string().min(1),
  motivo: z.unknown().optional(),
  materiaId: zUuid.nullable().optional(),
})

// PATCH e DELETE nascono il 2026-09-25 (spec «sei interventi», punto 2): qui lo
// schema può essere stretto dal primo giorno, perché nessun client lo usa ancora.
// Il gate (`requireUser`) viene PRIMA della lettura del corpo, e la riga si
// cerca già filtrata per autore: `id` nel corpo non apre le righe altrui.
const patchBodySchema = z
  .object({
    id: zUuid,
    data: zDataYMD.optional(),
    materiaId: zUuid.nullable().optional(),
    motivo: z
      .string()
      .refine((s) => s.trim().length <= MOTIVO_MAX_CARATTERI, `Motivo oltre ${MOTIVO_MAX_CARATTERI} caratteri`)
      .nullable()
      .optional(),
  })
  .refine((b) => b.data !== undefined || b.materiaId !== undefined || b.motivo !== undefined, {
    message: 'Nessun campo da modificare',
  })

const deleteQuerySchema = z.object({ id: zUuid })

/** Tipo della notifica che la dichiarazione manda ai docenti, e sua entità. */
const TIPO_NOTIFICA = 'giustifica_ricevuta'
const ENTITA_NOTIFICA = 'giustifica_didattica'

/** Colonna sconosciuta allo schema: il DB E2E della CI non ha `tipo` (non migrato). */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * La pagina dove il docente vede gli impreparati. Fino al 2026-09-25 il link
 * portava a `/appello`, che gli impreparati NON li mostra: il docente apriva la
 * notifica e non trovava niente. Le «Valutazioni recenti» li elencano.
 */
function linkValutazioni(sectionId: string): string {
  return `/teacher/primaria/${sectionId}/valutazioni`
}

/**
 * Il testo della notifica ai docenti. Uno solo per POST e PATCH: quando il
 * genitore sposta la data, la riga nella campanella del docente si riscrive con
 * lo STESSO testo e la data nuova — altrimenti resterebbe per sempre il giorno
 * che non vale più.
 */
function corpoNotifica(nomeAlunno: string, data: string): string {
  return `Il genitore di ${nomeAlunno} ha inviato una giustifica didattica per il ${data}.`
}

function nomeCompleto(a: { nome?: unknown; cognome?: unknown } | null | undefined): string {
  return [a?.nome, a?.cognome].filter((x) => typeof x === 'string' && x !== '').join(' ') || 'un alunno'
}

/** Oggi, in data di ROMA (`YYYY-MM-DD`): il runtime gira in UTC. */
function oggiDiRoma(): string {
  return dataRomaDi(new Date())
}

function rispostaNonTrovata(): NextResponse {
  return NextResponse.json(
    { error: 'Dichiarazione non trovata', codice: 'IMPREPARATO_NON_TROVATO' },
    { status: 404 },
  )
}

function rispostaDataPassata(): NextResponse {
  return NextResponse.json(
    {
      error: 'Si può modificare o annullare solo fino al giorno dichiarato, e non su una data passata.',
      codice: 'IMPREPARATO_DATA_PASSATA',
    },
    { status: 409 },
  )
}

function rispostaNonSalvata(): NextResponse {
  return NextResponse.json({ error: 'Operazione non riuscita', codice: 'IMPREPARATO_NON_SALVATO' }, { status: 500 })
}

function rispostaLetturaFallita(): NextResponse {
  return NextResponse.json({ error: 'Lettura non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
}

/**
 * `alunni(scuola_id)`: la sede per l'audit viene dall'alunno della riga, letta
 * insieme alla riga (la tabella non ha `scuola_id`: è legata all'alunno).
 */
const COLONNE_DICHIARAZIONE = 'id, alunno_id, section_id, materia_id, data, motivo, origine, alunni(scuola_id)'

interface Dichiarazione {
  id: string
  alunno_id: string
  section_id: string
  materia_id: string | null
  data: string
  motivo: string | null
  origine: string
  alunni?: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null
}

function sedeDi(r: Dichiarazione): string | null {
  const a = Array.isArray(r.alunni) ? r.alunni[0] : r.alunni
  return a?.scuola_id ?? null
}

/**
 * La scrittura condizionata non ha toccato NESSUNA riga: perché? Le cause sono
 * due e hanno due risposte diverse. Fra la lettura e la scrittura può essere
 * scoccata la mezzanotte (la riga c'è ancora, ma il giorno è passato: 409), o un
 * docente della classe può averla tolta (la riga non c'è più: 404). Rispondere
 * sempre 409 raccontava al genitore «si può modificare solo fino al giorno
 * dichiarato» su una dichiarazione che non esiste più.
 */
// La rilettura sta DENTRO ciascun handler, dopo il suo gate: qui si decide solo
// la risposta (il lock `isolamento-sede-coverage` vuole le query nel perimetro).
function rispostaSenzaRighe(
  rilettura: { data: unknown; error: unknown },
  id: string,
  operazione: string,
): NextResponse {
  const { data: ancora, error } = rilettura
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'db' }, error)
    return rispostaNonSalvata()
  }
  const codice = ancora ? 'IMPREPARATO_DATA_PASSATA' : 'IMPREPARATO_NON_TROVATO'
  logEvento('registro', 'info', {
    operazione,
    esito: ancora ? 'impreparato-data-passata-in-scrittura' : 'impreparato-sparito-in-scrittura',
    error_code: codice,
    giustifica_id: id,
  })
  return ancora ? rispostaDataPassata() : rispostaNonTrovata()
}

/** Solo metadati per l'audit: il motivo è testo libero su un minore e non ci va. */
function fotografia(r: Pick<Dichiarazione, 'data' | 'materia_id' | 'motivo'>) {
  return { data: r.data, materia_id: r.materia_id, con_motivo: r.motivo !== null && r.motivo !== '' }
}

// POST /api/parent/giustifiche-didattiche?userId=
// body: { studentId, data, motivo?, materiaId? }
// Il genitore dichiara l'alunno impreparato a priori. Solo primaria.
// Il tipo è SEMPRE «giustificato» (spec 2026-09-24): lo scrive la route, e lo
// impone anche il trigger `trg_giustifiche_didattiche_genitore_giustificato`.
export const POST = withRoute('parent/giustifiche-didattiche:POST', async (request: NextRequest) => {
  const operazione = 'parent/giustifiche-didattiche:POST'
  try {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { studentId, data, motivo, materiaId } = b.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const supabase = await createAdminClient()
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, section_id, scuola_id, nome, cognome')
      .eq('id', studentId)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione, stato: 500, evento: 'db' }, alunnoErr)
      return rispostaLetturaFallita()
    }
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez, error: sezErr } = await supabase
        .from('sections')
        .select('school_type')
        .eq('id', alunno.section_id)
        .maybeSingle()
      if (sezErr) {
        logErrore({ operazione, stato: 500, evento: 'db' }, sezErr)
        return rispostaLetturaFallita()
      }
      schoolType = sez?.school_type ?? null
    }
    if (schoolType !== 'primaria') {
      return NextResponse.json({ error: 'Disponibile solo per la scuola primaria' }, { status: 403 })
    }

    const riga = {
      alunno_id: studentId,
      section_id: alunno.section_id,
      materia_id: materiaId ?? null,
      data,
      motivo: motivoNormalizzato(motivo),
      origine: 'genitore',
      creato_da: userId,
    }
    let esito = await supabase
      .from('giustifiche_didattiche')
      .insert({ ...riga, tipo: 'giustificato' })
      .select()
      .single()
    if (esito.error && COLONNA_ASSENTE.has((esito.error as { code?: string }).code ?? '')) {
      // DB non migrato (E2E della CI): la colonna `tipo` non c'è ancora. Si
      // scrive la dichiarazione senza: dove la colonna esiste, il trigger la
      // mette comunque a «giustificato».
      logEvento('registro', 'info', { operazione, esito: 'tipo-non-disponibile-schema' }, esito.error)
      esito = await supabase.from('giustifiche_didattiche').insert(riga).select().single()
    }
    const { data: inserted, error } = esito

    if (error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, error)
      return rispostaNonSalvata()
    }
    const insertedId = (inserted as { id?: string })?.id ?? null

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'impreparato',
      entitaId: insertedId,
      azione: 'insert',
      scuolaId: (alunno.scuola_id as string | null) ?? null,
      sectionId: alunno.section_id as string,
      valorePrima: null,
      valoreDopo: { ...fotografia(riga), origine: 'genitore', tipo: 'giustificato' },
    })

    // Notifica ai docenti della sezione (best-effort): giustifica didattica.
    // Nome e sede vengono dalla lettura dell'alunno qui sopra, già controllata:
    // una seconda lettura senza controllo mandava «un alunno» e sede null in silenzio.
    try {
      const docenti = (await docentiDiSezione(supabase, alunno.section_id as string)).filter((id) => id !== userId)
      await notificaEvento(supabase, {
        tipo: TIPO_NOTIFICA,
        scuolaId: (alunno.scuola_id as string | null) ?? null,
        utenteIds: docenti,
        titolo: 'Giustifica didattica ricevuta',
        corpo: corpoNotifica(nomeCompleto(alunno), data),
        link: linkValutazioni(alunno.section_id as string),
        entitaTipo: ENTITA_NOTIFICA,
        entitaId: insertedId,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione,
        tipo: TIPO_NOTIFICA,
        esito: 'notifica_non_inviata',
      }, e)
    }

    // Il SUCCESSO si logga: «nessuna riga» non distinguerebbe «nessun genitore
    // ha dichiarato» da «la route non è mai arrivata qui».
    logEvento('registro', 'info', {
      operazione,
      esito: 'impreparato-dichiarato',
      alunno_id: studentId,
      giustifica_id: insertedId,
    }, undefined, { distingui: ['alunno_id'] })

    return NextResponse.json({ success: true, data: inserted }, { status: 201 })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaNonSalvata()
  }
})

// PATCH /api/parent/giustifiche-didattiche
// body: { id, data?, materiaId?, motivo? }
// Il genitore corregge la SUA dichiarazione, finché il giorno dichiarato non è
// passato (data di Roma); anche la nuova data non può essere nel passato.
export const PATCH = withRoute('parent/giustifiche-didattiche:PATCH', async (request: NextRequest) => {
  const operazione = 'parent/giustifiche-didattiche:PATCH'
  try {
    const identita = await requireUser(request)
    if (identita.response) return identita.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, data, materiaId, motivo } = b.data

    const supabase = await createAdminClient()
    // La dichiarazione, SOLO se è sua: `origine='genitore'` e `creato_da` = chi
    // chiama, già nel filtro della query — una dichiarazione altrui (o del
    // docente) risponde 404 come una che non esiste, senza dire che c'è. Poi il
    // gate di famiglia sull'alunno della riga: un figlio che non è più suo
    // (legame tolto, alunno ritirato) chiude anche le sue vecchie righe.
    const { data: letta, error: lettaErr } = await supabase
      .from('giustifiche_didattiche')
      .select(COLONNE_DICHIARAZIONE)
      .eq('id', id)
      .eq('origine', 'genitore')
      .eq('creato_da', identita.user.id)
      .maybeSingle()
    if (lettaErr) {
      logErrore({ operazione, stato: 500, evento: 'db' }, lettaErr)
      return rispostaLetturaFallita()
    }
    if (!letta) return rispostaNonTrovata()
    const riga = letta as unknown as Dichiarazione
    const auth = await requireParentOfStudent(request, riga.alunno_id)
    if (auth.response) return auth.response
    const user = auth.user

    const oggi = oggiDiRoma()
    if (riga.data < oggi || (data !== undefined && data < oggi)) {
      logEvento('registro', 'info', {
        operazione,
        esito: 'impreparato-data-passata',
        error_code: 'IMPREPARATO_DATA_PASSATA',
        giustifica_id: riga.id,
      })
      return rispostaDataPassata()
    }

    // La materia deve essere della CLASSE della dichiarazione: un id qualunque
    // legherebbe l'impreparato a una materia di un'altra sezione (o sede).
    if (materiaId) {
      const { data: materia, error: materiaErr } = await supabase
        .from('materie')
        .select('id')
        .eq('id', materiaId)
        .eq('section_id', riga.section_id)
        .maybeSingle()
      if (materiaErr) {
        logErrore({ operazione, stato: 500, evento: 'db' }, materiaErr)
        return rispostaLetturaFallita()
      }
      if (!materia) {
        return NextResponse.json(
          { error: 'Materia non valida per questa classe', codice: 'IMPREPARATO_MATERIA_NON_VALIDA' },
          { status: 400 },
        )
      }
    }

    const patch: Record<string, string | null> = {}
    if (data !== undefined) patch.data = data
    if (materiaId !== undefined) patch.materia_id = materiaId
    if (motivo !== undefined) patch.motivo = motivoNormalizzato(motivo)

    // Le condizioni che hanno deciso, RIPETUTE nella scrittura: fra la lettura e
    // qui può scoccare la mezzanotte, o un docente della classe può averla tolta.
    const { data: scritte, error } = await supabase
      .from('giustifiche_didattiche')
      .update(patch)
      .eq('id', riga.id)
      .eq('origine', 'genitore')
      .eq('creato_da', user.id)
      .gte('data', oggi)
      .select(COLONNE_DICHIARAZIONE)
    if (error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, error)
      return rispostaNonSalvata()
    }
    const dopo = ((scritte ?? []) as unknown as Dichiarazione[])[0]
    if (!dopo) {
      const rilettura = await supabase
        .from('giustifiche_didattiche')
        .select('id')
        .eq('id', riga.id)
        .eq('origine', 'genitore')
        .eq('creato_da', user.id)
        .maybeSingle()
      return rispostaSenzaRighe(rilettura, riga.id, operazione)
    }

    // Data spostata: la riga nella campanella del docente diceva il giorno
    // VECCHIO, anche per la notifica ancora in coda. Si riscrive il corpo di
    // tutte le notifiche di questa dichiarazione (spedite comprese: la campanella
    // le mostra ancora), con lo stesso testo del POST. Nessuna push nuova.
    // Best-effort: un guasto qui non disfa la modifica, ma si registra a `error`.
    if (data !== undefined && dopo.data !== riga.data) {
      const { data: anagrafica, error: anagraficaErr } = await supabase
        .from('alunni')
        .select('nome, cognome')
        .eq('id', riga.alunno_id)
        .maybeSingle()
      if (anagraficaErr) {
        logEvento('notifica', 'error', {
          operazione,
          esito: 'corpo-notifica-non-aggiornato-anagrafica-non-letta',
          tipo: TIPO_NOTIFICA,
          giustifica_id: riga.id,
          alunno_id: riga.alunno_id,
        }, anagraficaErr)
      } else {
        const { error: corpoErr } = await supabase
          .from('notifiche')
          .update({ corpo: corpoNotifica(nomeCompleto(anagrafica), dopo.data) })
          .eq('tipo', TIPO_NOTIFICA)
          .eq('entita_tipo', ENTITA_NOTIFICA)
          .eq('entita_id', riga.id)
        if (corpoErr) {
          logEvento('notifica', 'error', {
            operazione,
            esito: 'corpo-notifica-non-aggiornato',
            tipo: TIPO_NOTIFICA,
            giustifica_id: riga.id,
          }, corpoErr)
        }
      }
    }

    await logScrittura(supabase, {
      attore: user,
      entitaTipo: 'impreparato',
      entitaId: riga.id,
      azione: 'update',
      scuolaId: sedeDi(riga),
      sectionId: riga.section_id,
      valorePrima: fotografia(riga),
      valoreDopo: fotografia(dopo),
    })

    logEvento('registro', 'info', {
      operazione,
      esito: 'impreparato-modificato',
      alunno_id: riga.alunno_id,
      giustifica_id: riga.id,
    }, undefined, { distingui: ['alunno_id'] })

    return NextResponse.json({ success: true, data: { ...dopo, tipo: 'giustificato' } })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaNonSalvata()
  }
})

// DELETE /api/parent/giustifiche-didattiche?id=
// Il genitore annulla la SUA dichiarazione, finché il giorno dichiarato non è
// passato. Si ritira la notifica ai docenti ancora in coda (push non spedita):
// se è già partita, nessuna rettifica — come per l'annullamento dell'appello.
export const DELETE = withRoute('parent/giustifiche-didattiche:DELETE', async (request: NextRequest) => {
  const operazione = 'parent/giustifiche-didattiche:DELETE'
  try {
    const identita = await requireUser(request)
    if (identita.response) return identita.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    // La dichiarazione, SOLO se è sua: `origine='genitore'` e `creato_da` = chi
    // chiama, già nel filtro della query — una dichiarazione altrui (o del
    // docente) risponde 404 come una che non esiste, senza dire che c'è. Poi il
    // gate di famiglia sull'alunno della riga: un figlio che non è più suo
    // (legame tolto, alunno ritirato) chiude anche le sue vecchie righe.
    const { data: letta, error: lettaErr } = await supabase
      .from('giustifiche_didattiche')
      .select(COLONNE_DICHIARAZIONE)
      .eq('id', id)
      .eq('origine', 'genitore')
      .eq('creato_da', identita.user.id)
      .maybeSingle()
    if (lettaErr) {
      logErrore({ operazione, stato: 500, evento: 'db' }, lettaErr)
      return rispostaLetturaFallita()
    }
    if (!letta) return rispostaNonTrovata()
    const riga = letta as unknown as Dichiarazione
    const auth = await requireParentOfStudent(request, riga.alunno_id)
    if (auth.response) return auth.response
    const user = auth.user

    const oggi = oggiDiRoma()
    if (riga.data < oggi) {
      logEvento('registro', 'info', {
        operazione,
        esito: 'impreparato-data-passata',
        error_code: 'IMPREPARATO_DATA_PASSATA',
        giustifica_id: riga.id,
      })
      return rispostaDataPassata()
    }

    const { data: tolte, error } = await supabase
      .from('giustifiche_didattiche')
      .delete()
      .eq('id', riga.id)
      .eq('origine', 'genitore')
      .eq('creato_da', user.id)
      .gte('data', oggi)
      .select('id')
    if (error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, error)
      return rispostaNonSalvata()
    }
    if (((tolte ?? []) as unknown[]).length === 0) {
      const rilettura = await supabase
        .from('giustifiche_didattiche')
        .select('id')
        .eq('id', riga.id)
        .eq('origine', 'genitore')
        .eq('creato_da', user.id)
        .maybeSingle()
      return rispostaSenzaRighe(rilettura, riga.id, operazione)
    }

    // Il ritiro viene DOPO la cancellazione riuscita: ritirare l'avviso e poi
    // non riuscire a cancellare lascerebbe una dichiarazione senza avviso.
    const { data: ritirate, error: ritiroErr } = await supabase
      .from('notifiche')
      .delete()
      .eq('tipo', TIPO_NOTIFICA)
      .eq('entita_tipo', ENTITA_NOTIFICA)
      .eq('entita_id', riga.id)
      .is('push_inviata_il', null)
      .select('id')
    if (ritiroErr) {
      // `error` benché l'annullamento sia riuscito: l'avviso resta in coda e
      // arriverà ai docenti per una dichiarazione che non esiste più.
      logEvento('notifica', 'error', {
        operazione,
        esito: 'ritiro-notifica-fallito',
        tipo: TIPO_NOTIFICA,
        giustifica_id: riga.id,
      }, ritiroErr)
    }

    await logScrittura(supabase, {
      attore: user,
      entitaTipo: 'impreparato',
      entitaId: riga.id,
      azione: 'delete',
      scuolaId: sedeDi(riga),
      sectionId: riga.section_id,
      valorePrima: { ...fotografia(riga), origine: 'genitore', tipo: 'giustificato' },
      valoreDopo: null,
    })

    logEvento('registro', 'info', {
      operazione,
      esito: 'impreparato-annullato',
      alunno_id: riga.alunno_id,
      giustifica_id: riga.id,
      notifiche_ritirate: ritiroErr ? 0 : ((ritirate ?? []) as unknown[]).length,
      avviso_ritirato: !ritiroErr,
    }, undefined, { distingui: ['alunno_id'] })

    return NextResponse.json({ success: true, data: { id: riga.id } })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaNonSalvata()
  }
})
