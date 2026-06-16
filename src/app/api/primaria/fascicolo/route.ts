import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'

const BUCKET = 'sensitive_documents'
const MAX_SIZE = 15 * 1024 * 1024 // 15MB
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const TIPI = ['diagnosi', 'pei', 'pdp', '104']

// GET /api/primaria/fascicolo?alunnoId=&userId=
// Lista dei documenti del fascicolo (RBAC ristretto + audit).
export async function GET(request: NextRequest) {
  try {
    const alunnoId = new URL(request.url).searchParams.get('alunnoId')
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!alunnoId) return NextResponse.json({ error: 'alunnoId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const access = await puoAccedereFascicolo(supabase, userId, alunnoId)
    if (!access.consentito) {
      return NextResponse.json({ error: 'Accesso al fascicolo non consentito' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from('student_documents')
      .select('id, document_type, descrizione, file_name, expiry_date, created_at, caricato_da')
      .eq('student_id', alunnoId)
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'list', request })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/fascicolo  (multipart: file, alunnoId, documentType, descrizione?, expiryDate?, userId)
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const alunnoId = formData.get('alunnoId') as string | null
    const documentType = (formData.get('documentType') as string | null) ?? 'diagnosi'
    const descrizione = (formData.get('descrizione') as string | null) ?? null
    const expiryDate = (formData.get('expiryDate') as string | null) ?? null
    const userId = (formData.get('userId') as string | null) ?? getRequestUserId(request)

    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!file || !alunnoId) return NextResponse.json({ error: 'file e alunnoId obbligatori' }, { status: 400 })
    if (!TIPI.includes(documentType)) return NextResponse.json({ error: 'documentType non valido' }, { status: 400 })
    if (!ALLOWED.includes(file.type)) return NextResponse.json({ error: 'Formato non ammesso (PDF o immagine)' }, { status: 400 })
    if (file.size > MAX_SIZE) return NextResponse.json({ error: 'File oltre 15MB' }, { status: 400 })

    const supabase = await createAdminClient()
    const access = await puoAccedereFascicolo(supabase, userId, alunnoId)
    if (!access.consentito) {
      return NextResponse.json({ error: 'Caricamento nel fascicolo non consentito' }, { status: 403 })
    }

    // Sezione corrente dell'alunno (per RBAC contitolari futuri).
    const { data: alunno } = await supabase.from('alunni').select('section_id').eq('id', alunnoId).maybeSingle()

    // Bucket privato (no URL pubblico). Lo crea se assente.
    try {
      const { data: buckets } = await supabase.storage.listBuckets()
      if (!buckets?.some((b) => b.name === BUCKET)) {
        await supabase.storage.createBucket(BUCKET, { public: false, allowedMimeTypes: ALLOWED, fileSizeLimit: MAX_SIZE })
      }
    } catch (e) { console.error('bucket fascicolo:', e) }

    const ext = file.name.split('.').pop() || ''
    const path = `${alunnoId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
    const buf = await file.arrayBuffer()
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, Buffer.from(buf), {
      contentType: file.type,
      upsert: true,
    })
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

    const { data, error } = await supabase
      .from('student_documents')
      .insert({
        student_id: alunnoId,
        section_id: alunno?.section_id ?? null,
        document_type: documentType,
        descrizione,
        file_name: file.name,
        storage_path: path,
        file_url: path, // path privato; il download avviene via signed URL
        expiry_date: expiryDate,
        caricato_da: userId,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'upload', documentoId: data.id, request })

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
