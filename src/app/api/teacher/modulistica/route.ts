import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, assertClasseNomeInScope, resolveScuoleAttive } from '@/lib/auth/scope';
import { getGenitoriDiAlunno } from '@/lib/anagrafiche/legami';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseData, parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

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
export const GET = withRoute('teacher/modulistica:GET', async (request: NextRequest) => {
  try {
    // Gap auth segnalato in M3, chiuso in M9 sul RUOLO (il semaforo espone nomi
    // alunni e stato firme della classe) — NON sullo SCOPE: `requireDocente`
    // ammette anche `educator` e non guarda né sede né sezioni assegnate.
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { form_id: formId, class_name: className } = q.data;

    const supabase = await createAdminClient();

    // 0. SCOPE — prima di qualunque lettura di dati. Due vincoli:
    //    · la classe dev'essere in un plesso dell'utente (con tre sedi «2 ANNI»
    //      esiste sia ad Aversa sia a Cesa: il nome non è più una chiave);
    //    · per l'`educator` dev'essere anche una sezione ASSEGNATA
    //      (utenti_sezioni). Admin/coordinator/segreteria restano fuori dalla
    //      restrizione: per progetto vedono tutte le classi del proprio plesso.
    const scopeErr = await assertClasseNomeInScope(supabase, auth.user, className, {
      soloSezioniAssegnate: true,
    });
    if (scopeErr) return scopeErr;

    // Difesa in profondità: il gate impedisce di NOMINARE una classe altrui, ma
    // senza filtro per sede la `classe_sezione` omonima porterebbe dentro anche
    // i bambini dell'altra sede.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user);

    // 1. Carica gli alunni della classe — ristretti alle sedi consentite
    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome')
      .eq('classe_sezione', className)
      .in('scuola_id', plessi)
      .order('cognome');

    if (studErr || !students) {
      // PostgREST non lancia: senza log, un guasto di lettura resterebbe un 500 muto.
      if (studErr) logErrore({ operazione: 'teacher/modulistica:GET', stato: 500, evento: 'db' }, studErr);
      return NextResponse.json({ error: studErr?.message || 'Errore alunni' }, { status: 500 });
    }

    // 2. Carica le sottomissioni per questo modulo
    const { data: submissions, error: subErr } = await supabase
      .from('forms_submissions')
      .select('*')
      .eq('form_id', formId);

    if (subErr || !submissions) {
      if (subErr) logErrore({ operazione: 'teacher/modulistica:GET', stato: 500, evento: 'db' }, subErr);
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
    logErrore({ operazione: 'teacher/modulistica:GET', stato: 500 }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    );
  }
});

// POST: Proxy Upload cartaceo (DL-032) — lo staff carica la SCANSIONE del modulo
// firmato a penna consegnato a scuola. Upload reale + gate + evidenza strutturata.
export const POST = withRoute('teacher/modulistica:POST', async (request: Request) => {
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

    // 0. SCOPE dell'alunno — prima dell'upload e di qualunque lettura del suo
    //    legame familiare. `requireDocente` verifica il RUOLO: senza questo, un
    //    docente poteva allegare una scansione al fascicolo di un bambino di
    //    un'altra sede (e ricavarne il genitore) indovinandone l'id.
    const scopeErr = await assertAlunnoInScope(supabase, auth.user, studentId);
    if (scopeErr) return scopeErr;

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

    // 2. Trova il genitore collegato all'alunno (scope legacy classe) sull'unione
    //    runtime (`legame_genitori_alunni`) + anagrafica (`student_parents` via
    //    ponte `parents.auth_user_id`): col solo legame runtime il modulo
    //    cartaceo di un bambino importato dal form pubblico veniva archiviato
    //    con `parent_id` nullo — cioè senza il firmatario che rappresenta.
    const genitori = await getGenitoriDiAlunno(supabase, studentId);
    const parentId = genitori[0] ?? null;

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
    logErrore({ operazione: 'teacher/modulistica:POST', stato: 500 }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    );
  }
});
