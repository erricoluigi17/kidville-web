import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { titolareDiMateria } from '@/lib/audit/valutatore'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'

// GET /api/primaria/scrutinio?sectionId=&periodoId=&userId=
// Apre (o recupera) lo scrutinio della classe per il periodo. Ritorna alunni,
// materie della sezione, le materie del docente (modificabili), i giudizi
// proposti, il comportamento e la scala dei 6 giudizi ufficiali.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const periodoId = sp.get('periodoId')
    if (!sectionId) {
      return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

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

    // Il periodo deve appartenere alla scuola della sezione asserita: il GET crea
    // la riga scrutini(section, periodo), mai con un periodo di un altro tenant.
    const { data: periodo } = await supabase
      .from('scrutinio_periodi')
      .select('id')
      .eq('id', periodoId)
      .eq('scuola_id', scuolaId)
      .maybeSingle()
    if (!periodo) {
      return NextResponse.json({ error: 'Periodo non valido per questa scuola' }, { status: 403 })
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

    // Materie modificabili: l'educator solo le proprie (contitolarità); staff/segreteria
    // possono intervenire su tutte le materie della sezione (agiscono per l'intera classe).
    const mieMaterieIds = auth.user.role === 'educator'
      ? (mieMaterie ?? []).map((m) => m.materia_id)
      : (materie ?? []).map((m) => m.id)

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
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const { scrutinioId, giudizi } = await request.json()
    if (!scrutinioId || !Array.isArray(giudizi)) {
      return NextResponse.json({ error: 'scrutinioId e giudizi[] obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Scrutinio + sezione (per scope + risoluzione titolare).
    const { data: scr } = await supabase.from('scrutini').select('id, stato, section_id').eq('id', scrutinioId).single()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scr.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: modifiche non consentite', locked: true }, { status: 423 })

    const sectionId = scr.section_id as string
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const valid = giudizi.filter((g) => g && g.alunnoId && g.materiaId)
    if (valid.length === 0) return NextResponse.json({ success: true, data: [] })

    // Alunni e materie dei giudizi devono appartenere alla sezione dello scrutinio.
    const alunniErr = await assertAlunniInSezione(supabase, valid.map((g) => g.alunnoId), sectionId)
    if (alunniErr) return alunniErr
    const materiaIds = [...new Set(valid.map((g) => g.materiaId as string))]
    const { data: materieSez } = await supabase
      .from('materie')
      .select('id')
      .eq('section_id', sectionId)
      .in('id', materiaIds)
    const materieOk = new Set((materieSez ?? []).map((m) => m.id as string))
    if (materiaIds.some((id) => !materieOk.has(id))) {
      return NextResponse.json({ error: 'Materia non appartenente alla sezione' }, { status: 403 })
    }
    // L'educator propone solo per le proprie discipline (contitolarità server-side,
    // stesso criterio di mieMaterieIds nel GET). Staff/segreteria: tutte le materie.
    if (auth.user.role === 'educator') {
      const { data: mie } = await supabase
        .from('utenti_sezioni_materie')
        .select('materia_id')
        .eq('utente_id', auth.user.id)
        .eq('section_id', sectionId)
      const mieSet = new Set((mie ?? []).map((m) => m.materia_id as string))
      if (materiaIds.some((id) => !mieSet.has(id))) {
        return NextResponse.json({ error: 'Materia non assegnata al docente' }, { status: 403 })
      }
    }

    // proposto_da = "vero valutatore" (vincolo FEA): MAI la segreteria.
    //  - educator → sé stesso;
    //  - staff/segreteria → preserva il proponente esistente; per i giudizi nuovi
    //    risolve il docente titolare della materia (null se nessuno). Mai l'attore staff.
    let rows: { scrutinio_id: string; alunno_id: string; materia_id: string; giudizio_sintetico: string | null; proposto_da: string | null }[]
    if (auth.user.role === 'educator') {
      rows = valid.map((g) => ({
        scrutinio_id: scrutinioId,
        alunno_id: g.alunnoId,
        materia_id: g.materiaId,
        giudizio_sintetico: g.giudizioSintetico ?? null,
        proposto_da: auth.user.id,
      }))
    } else {
      const { data: esistenti } = await supabase
        .from('scrutinio_giudizi')
        .select('alunno_id, materia_id, proposto_da')
        .eq('scrutinio_id', scrutinioId)
      const propByKey = new Map<string, string | null>(
        (esistenti ?? []).map((e) => [`${e.alunno_id}:${e.materia_id}`, (e.proposto_da as string | null) ?? null]),
      )
      const titolareCache = new Map<string, string | null>()
      rows = []
      for (const g of valid) {
        const key = `${g.alunnoId}:${g.materiaId}`
        let proposto = propByKey.get(key) ?? null
        if (!proposto) {
          if (!titolareCache.has(g.materiaId)) {
            titolareCache.set(g.materiaId, await titolareDiMateria(supabase, sectionId, g.materiaId))
          }
          proposto = titolareCache.get(g.materiaId) ?? null
        }
        rows.push({
          scrutinio_id: scrutinioId,
          alunno_id: g.alunnoId,
          materia_id: g.materiaId,
          giudizio_sintetico: g.giudizioSintetico ?? null,
          proposto_da: proposto, // mai la segreteria
        })
      }
    }

    const { data, error } = await supabase
      .from('scrutinio_giudizi')
      .upsert(rows, { onConflict: 'scrutinio_id,alunno_id,materia_id' })
      .select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      sectionId,
      valoreDopo: data ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'scrutinio', link: `/teacher/primaria/${sectionId}/scrutinio` })

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
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const { scrutinioId, comportamento } = await request.json()
    if (!scrutinioId || !Array.isArray(comportamento)) {
      return NextResponse.json({ error: 'scrutinioId e comportamento[] obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data: scr } = await supabase.from('scrutini').select('id, stato, section_id').eq('id', scrutinioId).single()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scr.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: modifiche non consentite', locked: true }, { status: 423 })

    const sectionId = scr.section_id as string
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

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

    // Gli alunni devono appartenere alla sezione dello scrutinio (no cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, rows.map((r) => r.alunno_id), sectionId)
    if (alunniErr) return alunniErr

    const { data, error } = await supabase
      .from('scrutinio_comportamento')
      .upsert(rows, { onConflict: 'scrutinio_id,alunno_id' })
      .select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      sectionId,
      valoreDopo: data ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'scrutinio', link: `/teacher/primaria/${sectionId}/scrutinio` })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
