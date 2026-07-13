import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { periodoValido } from '@/lib/certificati/stato'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const BUCKET = 'certificati-medici'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il file si valida come presenza/istanza; le date restano stringhe permissive
// (il vincolo dal/al è di dominio: periodoValido, con messaggio dedicato).
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'file è obbligatorio' }),
  student_id: zUuid,
  data_inizio: z.string().nullable(),
  data_fine: z.string().nullable(),
  note: z.string().nullable(),
})

const getQuerySchema = z.object({}) // nessun parametro in ingresso

// POST /api/parent/medical-certificates — caricamento self-service (DL-027).
// multipart: file, student_id, data_inizio, data_fine, note. → stato 'in_validazione'.
export const POST = withRoute('parent/medical-certificates:POST', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const form = await request.formData()
    const parsed = parseData(postFormSchema, {
      file: form.get('file'),
      student_id: form.get('student_id'),
      data_inizio: form.get('data_inizio') ? String(form.get('data_inizio')) : null,
      data_fine: form.get('data_fine') ? String(form.get('data_fine')) : null,
      note: form.get('note') ? String(form.get('note')) : null,
    })
    if ('response' in parsed) return parsed.response
    const { file, student_id: studentId, data_inizio: dataInizio, data_fine: dataFine, note } = parsed.data

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
    logErrore({ operazione: 'parent/medical-certificates:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// GET /api/parent/medical-certificates — elenco certificati dei propri figli.
// Non espone il file_path grezzo (dato sanitario); solo il nome file + stato.
export const GET = withRoute('parent/medical-certificates:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

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
    logErrore({ operazione: 'parent/medical-certificates:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
