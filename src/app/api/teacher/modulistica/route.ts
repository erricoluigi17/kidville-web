import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseData, parseQuery } from '@/lib/validation/http';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// GET: entrambi i filtri sono obbligatori (il vecchio check manuale rifiutava
// anche la stringa vuota → min(1)); nessun vincolo di formato aggiuntivo.
const getQuerySchema = z.object({
  form_id: z.string().min(1, 'form_id è obbligatorio'),
  class_name: z.string().min(1, 'class_name è obbligatorio'),
});

// POST (FormData): valida i campi testuali estratti. Il file è controllato a
// parte come presenza/istanza; dimensione ed estensione restano check dedicati.
const postFormSchema = z.object({
  form_id: z.string().min(1, 'form_id è obbligatorio'),
  student_id: z.string().min(1, 'student_id è obbligatorio'),
});

const ALLOWED_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic']);
const ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
]);

// GET: Semaforo autorizzazioni per una classe e un modulo
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { form_id: formId, class_name: className } = q.data;

    const supabase = await createAdminClient();

    // 1. Carica gli alunni della classe
    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome')
      .eq('classe_sezione', className)
      .order('cognome');

    if (studErr || !students) {
      return NextResponse.json({ error: studErr?.message || 'Errore alunni' }, { status: 500 });
    }

    // 2. Carica le sottomissioni per questo modulo
    const { data: submissions, error: subErr } = await supabase
      .from('forms_submissions')
      .select('*')
      .eq('form_id', formId);

    if (subErr || !submissions) {
      return NextResponse.json({ error: subErr?.message || 'Errore sottomissioni' }, { status: 500 });
    }

    // 3. Costruisci il semaforo (Green/Red)
    const semaforo = students.map(student => {
      const sub = submissions.find(s => s.student_id === student.id);
      return {
        student_id: student.id,
        nome: student.nome,
        cognome: student.cognome,
        status: sub?.is_signed ? 'green' : 'red',
        submission: sub || null
      };
    });

    return NextResponse.json(semaforo);
  } catch (err) {
    console.error('Errore GET /api/teacher/modulistica:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    );
  }
}

// POST: Proxy Upload cartaceo (DL-032) — lo staff carica la SCANSIONE del modulo
// firmato a penna consegnato a scuola. Upload reale + gate + evidenza strutturata.
export async function POST(request: Request) {
  const auth = await requireDocente(request);
  if (auth.response) return auth.response;
  const staff = auth.user;

  try {
    const form = await request.formData();
    const fileEntry = form.get('file');
    const file = fileEntry instanceof File ? fileEntry : null;

    const parsed = parseData(postFormSchema, {
      form_id: form.get('form_id'),
      student_id: form.get('student_id'),
    });
    if ('response' in parsed) return parsed.response;
    const { form_id: formId, student_id: studentId } = parsed.data;

    if (!file) {
      return NextResponse.json({ error: 'Nessun file ricevuto' }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'File troppo grande (max 8MB)' }, { status: 400 });
    }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext) || (file.type && !ALLOWED_MIME.has(file.type))) {
      return NextResponse.json({ error: 'Tipo di file non ammesso (PDF o immagini)' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    // 1. Upload reale della scansione (service-role, bucket privato).
    const safeForm = formId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `cartaceo/${safeForm}/${crypto.randomUUID()}-${safeName}`;
    const arrayBuffer = await file.arrayBuffer();
    const { error: upErr } = await supabase.storage
      .from('form_attachments')
      .upload(path, arrayBuffer, { cacheControl: '3600', upsert: false, contentType: file.type || 'application/octet-stream' });
    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    // 2. Trova il genitore collegato all'alunno (scope legacy classe).
    const { data: legame } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id')
      .eq('alunno_id', studentId)
      .limit(1)
      .maybeSingle();
    const parentId = legame?.genitore_id || null;

    // 3. Evidenza strutturata (NON finge una FES digitale): acquisizione cartacea
    //    validata dallo staff, con tracciamento di chi/quando.
    const now = new Date().toISOString();
    const signatureLog = {
      method: 'PROXY_CARTACEO',
      provider: 'Kidville FEA in-house',
      acquisito_da: staff.id,
      ip: request.headers.get('x-forwarded-for') ?? 'N.D.',
      user_agent: request.headers.get('user-agent') ?? 'N.D.',
      timestamp: now,
      signed_at: now,
      compliance: 'Acquisizione cartacea validata dallo staff',
    };

    const { data, error } = await supabase
      .from('forms_submissions')
      .insert({
        form_id: formId,
        parent_id: parentId,
        student_id: studentId,
        answers: { proxy: true },
        is_signed: true,
        signature_log: signatureLog,
        pdf_path: path,
        origine: 'cartaceo',
      })
      .select('id')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 4. Audit immutabile dell'acquisizione cartacea.
    await logScrittura(supabase, {
      attore: staff,
      entitaTipo: 'modulistica_cartaceo',
      entitaId: data?.id ?? null,
      azione: 'insert',
      scuolaId: staff.scuola_id ?? null,
      valoreDopo: { form_id: formId, student_id: studentId, pdf_path: path },
    });

    return NextResponse.json({ success: true, id: data?.id, path }, { status: 201 });
  } catch (err) {
    console.error('Errore POST /api/teacher/modulistica:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    );
  }
}
