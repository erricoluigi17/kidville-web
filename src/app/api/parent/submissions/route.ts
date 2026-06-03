import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { persistSignedSubmission } from '@/lib/forms/persist-submission';

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333';

// POST: Sottoscrive e firma un modulo
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { form_id, student_id, answers, is_signed, signature_log, parent_id } = body;

    if (!form_id || !answers) {
      return NextResponse.json({ error: 'form_id e risposte obbligatori' }, { status: 400 });
    }

    const supabase = await createAdminClient();
    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id: parent_id || DEFAULT_PARENT_ID,
      student_id,
      answers,
      is_signed,
      signature_log,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result.submission, { status: 201 });
  } catch (err: any) {
    console.error('Errore POST /api/parent/submissions:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}

// GET: Recupera tutte le sottomissioni per l'archivio genitore
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get('parent_id') || DEFAULT_PARENT_ID;

    const supabase = await createAdminClient();

    const { data, error } = await supabase
      .from('forms_submissions')
      .select(`
        *,
        forms_templates (
          title,
          description
        ),
        alunni (
          nome,
          cognome
        )
      `)
      .eq('parent_id', parentId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
