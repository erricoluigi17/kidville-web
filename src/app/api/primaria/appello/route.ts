import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

const DEV_TEACHER = '22222222-2222-2222-2222-222222222222'
const STATI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const

// GET /api/primaria/appello?sectionId=&data=&userId=
// Alunni della classe + stato presenza del giorno.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const data = sp.get('data')
    if (!sectionId || !data) return NextResponse.json({ error: 'sectionId e data obbligatori' }, { status: 400 })
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()
    const [{ data: alunni }, { data: presenze }] = await Promise.all([
      supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome'),
      supabase.from('presenze').select('alunno_id, stato, note_appello').eq('section_id', sectionId).eq('data', data),
    ])

    const statoByAlunno = new Map((presenze ?? []).map((p) => [p.alunno_id, p]))
    const data_ = (alunni ?? []).map((a) => ({
      ...a,
      stato: statoByAlunno.get(a.id)?.stato ?? null,
      note_appello: statoByAlunno.get(a.id)?.note_appello ?? null,
    }))

    return NextResponse.json({ success: true, data: data_ })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/appello?userId=
//   singolo: { sectionId, alunnoId, data, stato, noteAppello? }
//   bulk:    { sectionId, data, records: [{ alunnoId, stato, noteAppello? }] }
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request) ?? DEV_TEACHER
    const body = await request.json()
    const { sectionId, data } = body
    if (!sectionId || !data) return NextResponse.json({ error: 'sectionId e data obbligatori' }, { status: 400 })

    const records: { alunnoId: string; stato: string; noteAppello?: string }[] = Array.isArray(body.records)
      ? body.records
      : [{ alunnoId: body.alunnoId, stato: body.stato, noteAppello: body.noteAppello }]

    for (const r of records) {
      if (!r.alunnoId || !STATI.includes(r.stato as typeof STATI[number])) {
        return NextResponse.json({ error: `Record non valido (stato in ${STATI.join('/')})` }, { status: 400 })
      }
    }

    const supabase = await createAdminClient()
    const rows = records.map((r) => ({
      alunno_id: r.alunnoId,
      section_id: sectionId,
      data,
      stato: r.stato,
      note_appello: r.noteAppello ?? null,
      registrato_da: userId,
    }))

    const { data: saved, error } = await supabase
      .from('presenze')
      .upsert(rows, { onConflict: 'alunno_id,data' })
      .select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data: saved ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
