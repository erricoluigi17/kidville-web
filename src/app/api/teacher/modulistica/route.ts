import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

const DEFAULT_TEACHER_ID = '22222222-2222-2222-2222-222222222222'; // Maestra Anna

// GET: Semaforo autorizzazioni per una classe e un modulo
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const formId = searchParams.get('form_id');
    const className = searchParams.get('class_name');

    if (!formId || !className) {
      return NextResponse.json({ error: 'form_id e class_name sono obbligatori' }, { status: 400 });
    }

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
  } catch (err: any) {
    console.error('Errore GET /api/teacher/modulistica:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// POST: Proxy Upload - l'insegnante inserisce la firma per conto terzi (autorizzazione cartacea)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { form_id, student_id, file_path, teacher_id } = body;

    if (!form_id || !student_id || !file_path) {
      return NextResponse.json({ error: 'form_id, student_id e file_path sono obbligatori' }, { status: 400 });
    }

    const currentTeacherId = teacher_id || DEFAULT_TEACHER_ID;
    const supabase = await createAdminClient();

    // Trova l'utente collegato al genitore per associare la sottomissione
    const { data: legame } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id')
      .eq('alunno_id', student_id)
      .limit(1)
      .maybeSingle();

    const parentId = legame?.genitore_id || null;

    // Finge log di firma cartacea caricata
    const signatureLog = {
      ip: '127.0.0.1 (Scuola Proxy)',
      timestamp: new Date().toISOString(),
      user_agent: 'Kidville Teacher App (Proxy Upload)',
      auth_method: 'Teacher Proxy (Maestra/Staff ID: ' + currentTeacherId + ')',
      notes: 'Caricamento cartaceo scansionato e convalidato dall\'insegnante alla porta.'
    };

    const record = {
      form_id,
      parent_id: parentId,
      student_id,
      answers: { proxy: 'Autorizzato con modulo cartaceo cartaceo consegnato a scuola' },
      is_signed: true,
      signature_log: signatureLog,
      pdf_path: file_path
    };

    const { data, error } = await supabase
      .from('forms_submissions')
      .insert(record)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    console.error('Errore POST /api/teacher/modulistica:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
