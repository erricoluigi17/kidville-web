import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunnoInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { renderGiudizioDescrittivo } from '@/lib/primaria/giudizio'
import { obiettiviDisponibili } from '@/lib/primaria/obiettivi'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'

// Queste valutazioni includono l'annotazione numerica privata del docente: l'endpoint
// è RISERVATO al personale docente/segreteria. Il genitore (role 'genitore') è escluso
// così il suo appunto numerico non gli è mai accessibile via API (PRD §4 e §4.5).

// GET /api/primaria/valutazioni?alunnoId=&materiaId=&userId=
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const alunnoId = sp.get('alunnoId')
    const materiaId = sp.get('materiaId')
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

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
    if (alunnoId) query = query.eq('alunno_id', alunnoId)
    if (materiaId) query = query.eq('materia_id', materiaId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/valutazioni?userId=
// body: { alunnoId, sectionId, materiaId, tipoProva, modalita,
//         dims:{autonomia,continuita,tipologia,risorse}, giudizioSintetico,
//         giudizioTesto?, obiettiviIds[], data? }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const {
      alunnoId, sectionId, materiaId, tipoProva = 'orale', modalita,
      dims, giudizioSintetico, giudizioTesto, argomento, data, annotazioneNumerica,
      obiettiviIds,
    } = body

    if (!alunnoId || !sectionId || !materiaId) {
      return NextResponse.json({ error: 'alunnoId, sectionId, materiaId obbligatori' }, { status: 400 })
    }

    // Annotazione numerica privata (facoltativa, scala /10). Solo appunto del docente.
    let annNum: number | null = null
    if (annotazioneNumerica !== undefined && annotazioneNumerica !== null && annotazioneNumerica !== '') {
      const n = Number(annotazioneNumerica)
      if (Number.isNaN(n) || n < 0 || n > 10) {
        return NextResponse.json({ error: "L'annotazione numerica deve essere un valore tra 0 e 10" }, { status: 400 })
      }
      annNum = Math.round(n * 100) / 100
    }
    // Argomento (testo libero) obbligatorio: sostituisce l'obiettivo di apprendimento.
    if (typeof argomento !== 'string' || argomento.trim().length === 0) {
      return NextResponse.json({ error: "Inserisci l'argomento della valutazione" }, { status: 400 })
    }
    if (modalita !== 'dimensioni' && modalita !== 'sintetico') {
      return NextResponse.json({ error: "modalita deve essere 'dimensioni' o 'sintetico'" }, { status: 400 })
    }
    if (modalita === 'dimensioni' && !dims) {
      return NextResponse.json({ error: 'dimensioni obbligatorie per la modalità dimensioni' }, { status: 400 })
    }
    if (modalita === 'sintetico' && !giudizioSintetico) {
      return NextResponse.json({ error: 'giudizio sintetico obbligatorio' }, { status: 400 })
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
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId: body.docenteId, materiaId })
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
    if (modalita === 'dimensioni' && !testo) {
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
        dim_autonomia: modalita === 'dimensioni' ? dims.autonomia : null,
        dim_continuita: modalita === 'dimensioni' ? dims.continuita : null,
        dim_tipologia: modalita === 'dimensioni' ? dims.tipologia : null,
        dim_risorse: modalita === 'dimensioni' ? dims.risorse : null,
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
      if (linkErr) console.error('valutazione_obiettivi insert:', linkErr.message)
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
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
