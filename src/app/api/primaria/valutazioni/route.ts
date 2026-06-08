import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { renderGiudizioDescrittivo } from '@/lib/primaria/giudizio'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'

const DEV_TEACHER = '22222222-2222-2222-2222-222222222222'

// GET /api/primaria/valutazioni?alunnoId=&materiaId=&userId=
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const alunnoId = sp.get('alunnoId')
    const materiaId = sp.get('materiaId')
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()
    let query = supabase
      .from('valutazioni')
      .select(`
        id, alunno_id, materia, materia_id, tipo, modalita, argomento,
        dim_autonomia, dim_continuita, dim_tipologia, dim_risorse,
        giudizio_sintetico, giudizio_testo, pubblicato, creato_il
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
    const userId = getRequestUserId(request) ?? DEV_TEACHER
    const body = await request.json()
    const {
      alunnoId, sectionId, materiaId, tipoProva = 'orale', modalita,
      dims, giudizioSintetico, giudizioTesto, argomento, data,
    } = body

    if (!alunnoId || !sectionId || !materiaId) {
      return NextResponse.json({ error: 'alunnoId, sectionId, materiaId obbligatori' }, { status: 400 })
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

    // Materia (nome per il campo NOT NULL legacy) + scuola.
    const { data: materia } = await supabase
      .from('materie')
      .select('nome, scuola_id, section_id')
      .eq('id', materiaId)
      .single()
    if (!materia) return NextResponse.json({ error: 'Materia non trovata' }, { status: 404 })

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
        maestra_id: userId,
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
        voto_numerico: null, // vietato alla primaria
        lock_tipo: lockTipo,
        pubblicato: false, // buffer notifica (F1.8)
      })
      .select()
      .single()
    if (valErr) return NextResponse.json({ error: valErr.message }, { status: 500 })

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
        link: '/parent/register',
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
