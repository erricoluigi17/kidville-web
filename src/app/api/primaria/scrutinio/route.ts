import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

const DEV_TEACHER = '22222222-2222-2222-2222-222222222222'

// GET /api/primaria/scrutinio?sectionId=&periodoId=&userId=
// Apre (o recupera) lo scrutinio della classe per il periodo. Ritorna alunni,
// materie della sezione, le materie del docente (modificabili), i giudizi
// proposti, il comportamento e la scala dei 6 giudizi ufficiali.
export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request) ?? DEV_TEACHER
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const periodoId = sp.get('periodoId')
    if (!sectionId) {
      return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Sezione + scuola (per la scala giudizi).
    const { data: sezione } = await supabase
      .from('sections')
      .select('id, name, school_type, scuola_id')
      .eq('id', sectionId)
      .single()
    const scuolaId = sezione?.scuola_id ?? null

    // Senza periodoId: restituisci la lista dei periodi configurati (per il selettore).
    if (!periodoId) {
      const { data: periodi } = scuolaId
        ? await supabase
            .from('scrutinio_periodi')
            .select('id, nome, anno_scolastico, ordine, attivo')
            .eq('scuola_id', scuolaId)
            .eq('attivo', true)
            .order('ordine')
        : { data: [] as { id: string; nome: string }[] }
      return NextResponse.json({ success: true, data: { periodi: periodi ?? [] } })
    }

    // Scrutinio: crea se non esiste (idempotente via UNIQUE section+periodo).
    let { data: scrutinio } = await supabase
      .from('scrutini')
      .select('*')
      .eq('section_id', sectionId)
      .eq('periodo_id', periodoId)
      .maybeSingle()
    if (!scrutinio) {
      const { data: created, error: cErr } = await supabase
        .from('scrutini')
        .insert({ section_id: sectionId, periodo_id: periodoId })
        .select()
        .single()
      if (cErr) {
        // Race: rileggi.
        const { data: again } = await supabase
          .from('scrutini').select('*').eq('section_id', sectionId).eq('periodo_id', periodoId).single()
        scrutinio = again
      } else {
        scrutinio = created
      }
    }
    if (!scrutinio) return NextResponse.json({ error: 'Impossibile aprire lo scrutinio' }, { status: 500 })

    const [{ data: alunni }, { data: materie }, { data: mieMaterie }, { data: giudizi }, { data: comportamento }, { data: scala }] =
      await Promise.all([
        supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome'),
        supabase.from('materie').select('id, nome, codice, e_civica, ordine').eq('section_id', sectionId).eq('attiva', true).order('ordine'),
        supabase.from('utenti_sezioni_materie').select('materia_id').eq('utente_id', userId).eq('section_id', sectionId),
        supabase.from('scrutinio_giudizi').select('*').eq('scrutinio_id', scrutinio.id),
        supabase.from('scrutinio_comportamento').select('*').eq('scrutinio_id', scrutinio.id),
        scuolaId
          ? supabase.from('giudizi_sintetici_scala').select('etichetta, ordine').eq('scuola_id', scuolaId).eq('attivo', true).order('ordine')
          : Promise.resolve({ data: [] as { etichetta: string; ordine: number }[] }),
      ])

    const mieMaterieIds = (mieMaterie ?? []).map((m) => m.materia_id)

    return NextResponse.json({
      success: true,
      data: {
        scrutinio,
        alunni: alunni ?? [],
        materie: materie ?? [],
        mieMaterieIds,
        giudizi: giudizi ?? [],
        comportamento: comportamento ?? [],
        scala: (scala ?? []).map((g) => g.etichetta),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/scrutinio?userId=
// Proposta giudizi sintetici del docente per le proprie discipline.
// body: { scrutinioId, giudizi: [{ alunnoId, materiaId, giudizioSintetico }] }
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request) ?? DEV_TEACHER
    const { scrutinioId, giudizi } = await request.json()
    if (!scrutinioId || !Array.isArray(giudizi)) {
      return NextResponse.json({ error: 'scrutinioId e giudizi[] obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Scrutinio chiuso → blocca le modifiche.
    const { data: scr } = await supabase.from('scrutini').select('id, stato').eq('id', scrutinioId).single()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scr.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: modifiche non consentite', locked: true }, { status: 423 })

    const rows = giudizi
      .filter((g) => g && g.alunnoId && g.materiaId)
      .map((g) => ({
        scrutinio_id: scrutinioId,
        alunno_id: g.alunnoId,
        materia_id: g.materiaId,
        giudizio_sintetico: g.giudizioSintetico ?? null,
        proposto_da: userId,
      }))
    if (rows.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('scrutinio_giudizi')
      .upsert(rows, { onConflict: 'scrutinio_id,alunno_id,materia_id' })
      .select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/primaria/scrutinio?userId=
// Comportamento + giudizio globale per alunno.
// body: { scrutinioId, comportamento: [{ alunnoId, giudizioTesto?, scalaValore?, giudizioGlobale? }] }
export async function PATCH(request: NextRequest) {
  try {
    const { scrutinioId, comportamento } = await request.json()
    if (!scrutinioId || !Array.isArray(comportamento)) {
      return NextResponse.json({ error: 'scrutinioId e comportamento[] obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data: scr } = await supabase.from('scrutini').select('id, stato').eq('id', scrutinioId).single()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scr.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: modifiche non consentite', locked: true }, { status: 423 })

    const rows = comportamento
      .filter((c) => c && c.alunnoId)
      .map((c) => ({
        scrutinio_id: scrutinioId,
        alunno_id: c.alunnoId,
        giudizio_testo: c.giudizioTesto ?? null,
        scala_valore: c.scalaValore ?? null,
        giudizio_globale: c.giudizioGlobale ?? null,
      }))
    if (rows.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('scrutinio_comportamento')
      .upsert(rows, { onConflict: 'scrutinio_id,alunno_id' })
      .select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
