import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get('parent_id') || DEFAULT_PARENT_ID;

    const supabase = await createAdminClient();

    // 1. Recupera gli alunni collegati al genitore
    const { data: legami, error: legamiErr } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id')
      .eq('genitore_id', parentId);

    if (legamiErr) {
      return NextResponse.json({ error: legamiErr.message }, { status: 500 });
    }

    if (!legami || legami.length === 0) {
      return NextResponse.json([]);
    }

    const studentIds = legami.map(l => l.alunno_id);

    const { data: students, error: studErr } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione')
      .in('id', studentIds);

    if (studErr || !students) {
      return NextResponse.json({ error: studErr?.message || 'Errore nel caricamento degli alunni' }, { status: 500 });
    }

    // Classi dei figli
    const classes = Array.from(new Set(students.map(s => s.classe_sezione).filter(Boolean)));

    // 2. Recupera i moduli (templates) assegnati a queste classi
    const { data: templates, error: tempErr } = await supabase
      .from('forms_templates')
      .select('*')
      .eq('target_scope', 'class');

    if (tempErr || !templates) {
      return NextResponse.json({ error: tempErr?.message || 'Errore moduli' }, { status: 500 });
    }

    // Filtra i moduli in base alle classi dei figli
    const assignedTemplates = templates.filter(t => {
      const targetClasses = t.target_classes || [];
      return targetClasses.some((c: string) => classes.includes(c));
    });

    // 3. Recupera le sottomissioni già effettuate da questo genitore
    const { data: submissions, error: subErr } = await supabase
      .from('forms_submissions')
      .select('form_id, student_id, is_signed, created_at, pdf_path')
      .eq('parent_id', parentId);

    if (subErr) {
      return NextResponse.json({ error: subErr.message }, { status: 500 });
    }

    // 4. Mappa lo stato di compilazione per ogni combinazione modulo-figlio
    const result: any[] = [];

    for (const temp of assignedTemplates) {
      // Per ogni figlio a cui è destinato il modulo (in base alla sua classe)
      const targetStudents = students.filter(s => temp.target_classes.includes(s.classe_sezione));

      for (const student of targetStudents) {
        const sub = submissions?.find(s => s.form_id === temp.id && s.student_id === student.id);
        
        result.push({
          form_id: temp.id,
          title: temp.title,
          description: temp.description,
          form_type: temp.form_type ?? 'autorizzazione',
          fields: temp.fields,
          expiration_date: temp.expiration_date,
          student: {
            id: student.id,
            nome: student.nome,
            cognome: student.cognome,
            classe_sezione: student.classe_sezione
          },
          status: sub ? 'signed' : (temp.expiration_date && new Date(temp.expiration_date) < new Date() ? 'expired' : 'pending'),
          submission: sub ? {
            is_signed: sub.is_signed,
            created_at: sub.created_at,
            pdf_path: sub.pdf_path
          } : null
        });
      }
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('Errore GET /api/parent/forms:', err);
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
  }
}
