import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { periodoValido } from '@/lib/certificati/stato'

const BUCKET = 'certificati-medici'

// POST /api/parent/medical-certificates — caricamento self-service (DL-027).
// multipart: file, student_id, data_inizio, data_fine, note. → stato 'in_validazione'.
export async function POST(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const form = await request.formData()
    const file = form.get('file')
    const studentId = String(form.get('student_id') ?? '')
    const dataInizio = form.get('data_inizio') ? String(form.get('data_inizio')) : null
    const dataFine = form.get('data_fine') ? String(form.get('data_fine')) : null
    const note = form.get('note') ? String(form.get('note')) : null

    if (!(file instanceof File) || !studentId) {
      return NextResponse.json({ error: 'file e student_id sono obbligatori' }, { status: 400 })
    }
    if (!periodoValido({ data_inizio: dataInizio, data_fine: dataFine })) {
      return NextResponse.json({ error: 'Periodo di copertura non valido (dal/al)' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // scope: il genitore deve essere collegato all'alunno
    const { data: legame } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id')
      .eq('genitore_id', user.id)
      .eq('alunno_id', studentId)
      .maybeSingle()
    if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

    const ext = (file.name.split('.').pop() || 'pdf').toLowerCase()
    const path = `${studentId}/${randomUUID()}.${ext}`
    const buf = Buffer.from(await file.arrayBuffer())
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: file.type || 'application/octet-stream', upsert: false })
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    const { data, error } = await supabase
      .from('certificati_medici')
      .insert({
        alunno_id: studentId,
        file_path: path,
        data_inizio: dataInizio,
        data_fine: dataFine,
        stato: 'in_validazione',
        caricato_da: user.id,
        note,
      })
      .select('id, stato, data_inizio, data_fine')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('Errore POST medical-certificates:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// GET /api/parent/medical-certificates — elenco certificati dei propri figli.
// Non espone il file_path grezzo (dato sanitario); solo il nome file + stato.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const supabase = await createAdminClient()

    const { data: legami } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id')
      .eq('genitore_id', user.id)
    const alunnoIds = ((legami ?? []) as { alunno_id: string }[]).map((l) => l.alunno_id)
    if (alunnoIds.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data } = await supabase
      .from('certificati_medici')
      .select('id, alunno_id, data_inizio, data_fine, stato, note, nota_validazione, creato_il, file_path, alunno:alunni(nome, cognome)')
      .in('alunno_id', alunnoIds)
      .order('creato_il', { ascending: false })

    const out = ((data ?? []) as Record<string, unknown>[]).map((c) => ({
      ...c,
      fileName: typeof c.file_path === 'string' ? c.file_path.split('/').pop() : null,
      file_path: undefined,
    }))
    return NextResponse.json({ success: true, data: out })
  } catch (err) {
    console.error('Errore GET medical-certificates:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
