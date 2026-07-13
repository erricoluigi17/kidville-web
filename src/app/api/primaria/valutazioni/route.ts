import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunnoInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { renderGiudizioDescrittivo, type Dimensioni } from '@/lib/primaria/giudizio'
import { obiettiviDisponibili } from '@/lib/primaria/obiettivi'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

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

// dims, obiettiviIds e docenteId restano volutamente permissivi (z.unknown()):
// oggi il codice li ispeziona a runtime senza vincoli di forma (dims a forma
// libera, obiettiviIds non-array trattato come [], docenteId validato da
// risolviValutatore, 422). NB: .optional() è necessario — z.unknown() come
// chiave di z.object è required a runtime.
const postBodySchema = z
  .object({
    alunnoId: zUuid,
    sectionId: zUuid,
    materiaId: zUuid,
    tipoProva: z.string().nullish().default('orale'),
    modalita: z.enum(['dimensioni', 'sintetico'], {
      error: "modalita deve essere 'dimensioni' o 'sintetico'",
    }),
    dims: z.unknown().optional(),
    giudizioSintetico: z.string().nullish(),
    giudizioTesto: z.string().nullish(),
    argomento: z
      .string({ error: "Inserisci l'argomento della valutazione" })
      .refine((s) => s.trim().length > 0, "Inserisci l'argomento della valutazione"),
    data: zDataYMD.nullish(), // default dinamico: oggi (calcolato nell'handler)
    // Facoltativa: numero o stringa numerica; range 0-10 e arrotondamento
    // restano validati nell'handler ('' equivale ad assente, come oggi).
    annotazioneNumerica: z.union([z.number(), z.string()]).nullish(),
    obiettiviIds: z.unknown().optional(),
    docenteId: z.unknown().optional(),
  })
  .refine((b) => b.modalita !== 'dimensioni' || Boolean(b.dims), {
    message: 'dimensioni obbligatorie per la modalità dimensioni',
    path: ['dims'],
  })
  .refine((b) => b.modalita !== 'sintetico' || Boolean(b.giudizioSintetico), {
    message: 'giudizio sintetico obbligatorio',
    path: ['giudizioSintetico'],
  })

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
        id, alunno_id, materia, materia_id, tipo, modalita, argomento,
        dim_autonomia, dim_continuita, dim_tipologia, dim_risorse,
        giudizio_sintetico, giudizio_testo, annotazione_numerica, pubblicato, creato_il,
        valutazione_obiettivi(obiettivo_id, obiettivi_apprendimento(id, codice, descrizione))
      `)
      .not('modalita', 'is', null) // solo valutazioni in itinere (primaria)
      .order('creato_il', { ascending: false })
      .eq('alunno_id', alunnoId)
    if (materiaId) query = query.eq('materia_id', materiaId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
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
    let annNum: number | null = null
    if (annotazioneNumerica !== undefined && annotazioneNumerica !== null && annotazioneNumerica !== '') {
      const n = Number(annotazioneNumerica)
      if (Number.isNaN(n) || n < 0 || n > 10) {
        return NextResponse.json({ error: "L'annotazione numerica deve essere un valore tra 0 e 10" }, { status: 400 })
      }
      annNum = Math.round(n * 100) / 100
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
    let obiettiviCollegati: string[] = []
    if (disponibili.length > 0) {
      const richiesti = Array.isArray(obiettiviIds) ? obiettiviIds.filter(Boolean) : []
      if (richiesti.length === 0) {
        return NextResponse.json({ error: 'Collega almeno un obiettivo di apprendimento alla valutazione.' }, { status: 400 })
      }
      const validi = new Set(disponibili.map((o) => o.id))
      const fuori = richiesti.filter((id: string) => !validi.has(id))
      if (fuori.length > 0) {
        return NextResponse.json({ error: 'Obiettivo non valido per questa materia/livello.' }, { status: 400 })
      }
      obiettiviCollegati = [...new Set(richiesti)] as string[]
    }

    // Vincolo temporale (scritto/pratico=15gg, orale=2gg). Data evento = data o oggi.
    const eventDate = data ?? new Date().toISOString().slice(0, 10)
    const lockTipo = tipoProva === 'scritto' || tipoProva === 'pratico' ? 'scritto_pratico' : 'classe_orale'
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
