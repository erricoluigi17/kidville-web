import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// form_id è forms_templates.id (PK uuid); class_name è la sezione (testo libero).
const getQuerySchema = z.object({
  form_id: zUuid,
  class_name: z.string().min(1, 'class_name è obbligatorio'),
});

export const GET = withRoute('admin/documents-merge:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { form_id: formId, class_name: className } = q.data;

    const supabase = await createAdminClient();

    // 1. Carica il template del form
    const { data: template, error: tempErr } = await supabase
      .from('forms_templates')
      .select('*')
      .eq('id', formId)
      .maybeSingle();

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
          origine: submission.origine ?? 'online',
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
  } catch (err) {
    logErrore({ operazione: 'admin/documents-merge:GET', stato: 500 }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    );
  }
});
