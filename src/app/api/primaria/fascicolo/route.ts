import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity, loadAppUser } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const BUCKET = 'sensitive_documents'
const MAX_SIZE = 15 * 1024 * 1024 // 15MB
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const TIPI = ['diagnosi', 'pei', 'pdp', '104'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  alunnoId: zUuid,
  finalita: z.string().optional(),
})

// Campi multipart: il file si valida come istanza (mime/size restano check manuali
// dedicati); documentType default 'diagnosi' come nel comportamento storico.
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'file e alunnoId obbligatori' }),
  alunnoId: zUuid,
  documentType: z.enum(TIPI).default('diagnosi'),
  descrizione: z.string().nullable(),
  expiryDate: z.string().nullable(),
  finalita: z.string().nullable(),
})

// GET /api/primaria/fascicolo?alunnoId=&userId=
// Lista dei documenti del fascicolo (RBAC ristretto + audit).
export async function GET(request: NextRequest) {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, finalita } = q.data

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

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'list', finalita, request })

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
    // Identità dalla richiesta (sessione o header/query legacy), MAI dal formData:
    // il campo multipart 'userId' permetterebbe di impersonare chiunque.
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const parsed = parseData(postFormSchema, {
      file: formData.get('file'),
      alunnoId: formData.get('alunnoId'),
      documentType: formData.get('documentType') ?? undefined,
      descrizione: formData.get('descrizione'),
      expiryDate: formData.get('expiryDate'),
      finalita: formData.get('finalita'),
    })
    if ('response' in parsed) return parsed.response
    const { file, alunnoId, documentType, descrizione, expiryDate, finalita } = parsed.data

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

    await logAccessoFascicolo(supabase, { alunnoId, utenteId: userId, azione: 'upload', documentoId: data.id, finalita, request })

    // Audit unificato delle scritture + notifica al titolare se carica la segreteria.
    const attore = await loadAppUser(userId)
    if (attore) {
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'fascicolo',
        entitaId: data.id,
        azione: 'insert',
        sectionId: alunno?.section_id ?? null,
        valoreDopo: { id: data.id, document_type: documentType, file_name: file.name },
      })
      if (alunno?.section_id) {
        await notificaTitolariScrittura(supabase, { attore, sectionId: alunno.section_id, area: 'fascicolo' })
      }
    }

    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
