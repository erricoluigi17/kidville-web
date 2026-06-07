import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// ============================================================
// Orario: tempo scuola (27/29/40h) → campanelle → griglia settimanale.
// ============================================================

interface CampanellaGen {
  giorno_settimana: number
  ordine: number
  ora_inizio: string
  ora_fine: string
  tipo: 'lezione' | 'intervallo' | 'mensa'
}

function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + mins
  const nh = Math.floor(total / 60) % 24
  const nm = total % 60
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`
}

// Genera la struttura campanelle a partire dal modello tempo scuola.
function generaCampanelle(modello: number, giorni: number): CampanellaGen[] {
  const orePerSettimana = modello
  const oreGiorno = Math.max(1, Math.round(orePerSettimana / giorni))
  const tempoPieno = modello === 40
  const rows: CampanellaGen[] = []

  for (let g = 1; g <= giorni; g++) {
    let ordine = 1
    let cursor = '08:30'
    for (let h = 1; h <= oreGiorno; h++) {
      const fine = addMinutes(cursor, 60)
      rows.push({ giorno_settimana: g, ordine: ordine++, ora_inizio: cursor, ora_fine: fine, tipo: 'lezione' })
      cursor = fine
      // Intervallo dopo la 2ª ora.
      if (h === 2) {
        const fineInt = addMinutes(cursor, 15)
        rows.push({ giorno_settimana: g, ordine: ordine++, ora_inizio: cursor, ora_fine: fineInt, tipo: 'intervallo' })
        cursor = fineInt
      }
      // Mensa a metà giornata nel tempo pieno.
      if (tempoPieno && h === Math.ceil(oreGiorno / 2)) {
        const fineMensa = addMinutes(cursor, 60)
        rows.push({ giorno_settimana: g, ordine: ordine++, ora_inizio: cursor, ora_fine: fineMensa, tipo: 'mensa' })
        cursor = fineMensa
      }
    }
  }
  return rows
}

// GET /api/admin/primaria/orario?sectionId=
export async function GET(request: NextRequest) {
  try {
    const sectionId = new URL(request.url).searchParams.get('sectionId')
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const [{ data: tempoScuola }, { data: campanelle }, { data: orario }] = await Promise.all([
      supabase.from('tempo_scuola').select('*').eq('section_id', sectionId).eq('attivo', true).maybeSingle(),
      supabase.from('campanelle').select('*').eq('section_id', sectionId).order('giorno_settimana').order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('*, materie(nome, codice), utenti(nome, cognome)')
        .eq('section_id', sectionId),
    ])

    return NextResponse.json({
      success: true,
      data: { tempoScuola: tempoScuola ?? null, campanelle: campanelle ?? [], orario: orario ?? [] },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/orario?action=set-tempo|genera-campanelle|set-cell
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const action = new URL(request.url).searchParams.get('action')
    const body = await request.json()
    const supabase = await createAdminClient()
    const sectionId: string | undefined = body.sectionId
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    if (action === 'set-tempo') {
      const modello = Number(body.modello)
      const giorni = Number(body.giorniSettimana ?? 5)
      if (![27, 29, 40].includes(modello)) {
        return NextResponse.json({ error: 'modello deve essere 27, 29 o 40' }, { status: 400 })
      }
      // Disattiva eventuali modelli precedenti e inserisce il nuovo come attivo.
      await supabase.from('tempo_scuola').update({ attivo: false }).eq('section_id', sectionId).eq('attivo', true)
      const { data: tempo, error } = await supabase
        .from('tempo_scuola')
        .insert({ section_id: sectionId, modello, giorni_settimana: giorni, attivo: true })
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      // Rigenera le campanelle (sostituisce le esistenti).
      await rigeneraCampanelle(supabase, sectionId, modello, giorni)
      return NextResponse.json({ success: true, data: tempo }, { status: 201 })
    }

    if (action === 'genera-campanelle') {
      const { data: tempo } = await supabase
        .from('tempo_scuola')
        .select('modello, giorni_settimana')
        .eq('section_id', sectionId)
        .eq('attivo', true)
        .maybeSingle()
      if (!tempo) return NextResponse.json({ error: 'Nessun tempo scuola attivo per la sezione' }, { status: 400 })
      const rows = await rigeneraCampanelle(supabase, sectionId, tempo.modello, tempo.giorni_settimana)
      return NextResponse.json({ success: true, data: rows })
    }

    if (action === 'set-cell') {
      const { giorno, campanellaId, materiaId, docenteId, note } = body
      if (!giorno || !campanellaId) {
        return NextResponse.json({ error: 'giorno e campanellaId obbligatori' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('orario_settimanale')
        .upsert(
          {
            section_id: sectionId,
            giorno_settimana: Number(giorno),
            campanella_id: campanellaId,
            materia_id: materiaId ?? null,
            docente_id: docenteId ?? null,
            note: note ?? null,
          },
          { onConflict: 'section_id,giorno_settimana,campanella_id' }
        )
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data }, { status: 201 })
    }

    return NextResponse.json({ error: 'action non riconosciuta' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function rigeneraCampanelle(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sectionId: string,
  modello: number,
  giorni: number
) {
  // Rimuove le campanelle esistenti (cascade pulisce le celle orario collegate).
  await supabase.from('campanelle').delete().eq('section_id', sectionId)
  const rows = generaCampanelle(modello, giorni).map((c) => ({ ...c, section_id: sectionId }))
  const { data } = await supabase.from('campanelle').insert(rows).select()
  return data ?? []
}
