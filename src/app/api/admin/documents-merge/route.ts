import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const formId = searchParams.get('form_id');
    const className = searchParams.get('class_name');

    if (!formId || !className) {
      return NextResponse.json({ error: 'form_id e class_name sono obbligatori' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    // 1. Carica il template del form
    const { data: template, error: tempErr } = await supabase
      .from('forms_templates')
      .select('*')
      .eq('id', formId)
      .single();

    if (tempErr || !template) {
      return NextResponse.json({ error: 'Template del form non trovato' }, { status: 404 });
    }

    // 2. Carica gli alunni della classe
    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, codice_fiscale')
      .eq('classe_sezione', className);

    if (studErr || !students) {
      return NextResponse.json({ error: 'Errore nel caricamento degli alunni' }, { status: 500 });
    }

    // 3. Carica le sottomissioni per questo form
    const { data: submissions, error: subErr } = await supabase
      .from('forms_submissions')
      .select('*')
      .eq('form_id', formId);

    if (subErr || !submissions) {
      return NextResponse.json({ error: 'Errore nel caricamento delle sottomissioni' }, { status: 500 });
    }

    // 4. Mappa ogni alunno alla propria sottomissione
    const mergedData = students.map(student => {
      const submission = submissions.find(sub => sub.student_id === student.id);
      
      if (submission) {
        return {
          student_id: student.id,
          nome_alunno: student.nome,
          cognome_alunno: student.cognome,
          codice_fiscale_alunno: student.codice_fiscale,
          signed: true,
          submission_id: submission.id,
          answers: submission.answers,
          is_signed: submission.is_signed,
          signature_log: submission.signature_log,
          pdf_path: submission.pdf_path,
          created_at: submission.created_at
        };
      } else {
        return {
          student_id: student.id,
          nome_alunno: student.nome,
          cognome_alunno: student.cognome,
          codice_fiscale_alunno: student.codice_fiscale,
          signed: false
        };
      }
    });

    return NextResponse.json({
      form: {
        id: template.id,
        title: template.title,
        description: template.description,
        fields: template.fields
      },
      class_name: className,
      results: mergedData
    });
  } catch (err: any) {
    console.error('Errore GET /api/admin/documents-merge:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
