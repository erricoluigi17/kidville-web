import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'

// POST /api/primaria/scrutinio/import?userId=
// Caricamento massivo dei giudizi sintetici di uno scrutinio (aperto) via CSV.
// Le righe parse-ate lato client possono identificare alunno e materia per id
// oppure per nome/cognome / nome materia. Valida i giudizi contro la scala.
// body: { scrutinioId, righe: [{ alunnoId?, alunno?, materiaId?, materia?, giudizioSintetico }] }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const { scrutinioId, righe } = await request.json()
    if (!scrutinioId || !Array.isArray(righe)) {
      return NextResponse.json({ error: 'scrutinioId e righe[] obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    const { data: scrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato')
      .eq('id', scrutinioId)
      .single()
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: import non consentito', locked: true }, { status: 423 })

    // Scope sulla sezione dello scrutinio (educator: solo proprie sezioni; staff: plesso).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    // Anagrafiche della sezione per risoluzione per nome.
    const [{ data: alunni }, { data: materie }, { data: sez }] = await Promise.all([
      supabase.from('alunni').select('id, nome, cognome').eq('section_id', scrutinio.section_id),
      supabase.from('materie').select('id, nome, codice').eq('section_id', scrutinio.section_id),
      supabase.from('sections').select('scuola_id').eq('id', scrutinio.section_id).single(),
    ])

    // Scala valida (etichette consentite).
    let scalaSet = new Set<string>()
    if (sez?.scuola_id) {
      const { data: scala } = await supabase.from('giudizi_sintetici_scala').select('etichetta').eq('scuola_id', sez.scuola_id)
      scalaSet = new Set((scala ?? []).map((s) => s.etichetta.toLowerCase()))
    }

    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
    const alunnoById = new Map((alunni ?? []).map((a) => [a.id, a]))
    const alunnoByNome = new Map((alunni ?? []).map((a) => [norm(`${a.cognome} ${a.nome}`), a.id]))
    const materiaById = new Map((materie ?? []).map((m) => [m.id, m]))
    const materiaByNome = new Map((materie ?? []).map((m) => [norm(m.nome), m.id]))
    const materiaByCodice = new Map((materie ?? []).map((m) => [norm(m.codice), m.id]))

    const errori: { riga: number; messaggio: string }[] = []
    const rows: Record<string, unknown>[] = []

    righe.forEach((r: Record<string, unknown>, i: number) => {
      const n = i + 1
      const alunnoId = r.alunnoId && alunnoById.has(String(r.alunnoId))
        ? String(r.alunnoId)
        : alunnoByNome.get(norm(r.alunno))
      if (!alunnoId) { errori.push({ riga: n, messaggio: `Alunno non trovato: ${r.alunno ?? r.alunnoId ?? ''}` }); return }

      const materiaId = r.materiaId && materiaById.has(String(r.materiaId))
        ? String(r.materiaId)
        : materiaByNome.get(norm(r.materia)) ?? materiaByCodice.get(norm(r.materia))
      if (!materiaId) { errori.push({ riga: n, messaggio: `Materia non trovata: ${r.materia ?? r.materiaId ?? ''}` }); return }

      const giudizio = String(r.giudizioSintetico ?? '').trim()
      if (!giudizio) { errori.push({ riga: n, messaggio: 'Giudizio mancante' }); return }
      if (scalaSet.size > 0 && !scalaSet.has(giudizio.toLowerCase())) {
        errori.push({ riga: n, messaggio: `Giudizio non in scala: ${giudizio}` }); return
      }

      rows.push({
        scrutinio_id: scrutinioId,
        alunno_id: alunnoId,
        materia_id: materiaId,
        giudizio_sintetico: giudizio,
        proposto_da: userId,
      })
    })

    let importate = 0
    if (rows.length > 0) {
      const { data, error } = await supabase
        .from('scrutinio_giudizi')
        .upsert(rows, { onConflict: 'scrutinio_id,alunno_id,materia_id' })
        .select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      importate = (data ?? []).length
    }

    return NextResponse.json({ success: true, importate, errori })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
