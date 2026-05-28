import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333';

// POST: Sottoscrive e firma un modulo
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { form_id, student_id, answers, is_signed, signature_log, parent_id } = body;

    if (!form_id || !answers) {
      return NextResponse.json({ error: 'form_id e risposte obbligatori' }, { status: 400 });
    }

    const currentParentId = parent_id || DEFAULT_PARENT_ID;
    const supabase = await createAdminClient();

    // 1. Carica il template per verificare i campi e l'auto-aggiornamento anagrafica
    const { data: template, error: tempErr } = await supabase
      .from('forms_templates')
      .select('*')
      .eq('id', form_id)
      .single();

    if (tempErr || !template) {
      return NextResponse.json({ error: 'Form non trovato' }, { status: 404 });
    }

    // 2. Esegui l'auto-aggiornamento dell'anagrafica se i campi sono mappati
    const fields = template.fields || [];
    const studentUpdates: Record<string, any> = {};
    const parentUpdates: Record<string, any> = {};

    for (const field of fields) {
      const answerValue = answers[field.id];
      if (answerValue !== undefined && answerValue !== null && answerValue !== '') {
        const mapping = field.db_mapping; // es: "alunni.note_mediche" o "utenti.cellulare"
        
        if (mapping && typeof mapping === 'string') {
          const [table, column] = mapping.split('.');
          if (table === 'alunni' && student_id) {
            studentUpdates[column] = answerValue;
          } else if (table === 'utenti') {
            parentUpdates[column] = answerValue;
          }
        }
      }
    }

    // Aggiorna alunno
    if (Object.keys(studentUpdates).length > 0 && student_id) {
      // Mappatura nomi colonne se differente
      if (studentUpdates.note_mediche !== undefined) {
        // nel database note_mediche memorizza allergie/consigli
        studentUpdates.note_mediche = studentUpdates.note_mediche;
      }
      const { error: studentErr } = await supabase
        .from('alunni')
        .update(studentUpdates)
        .eq('id', student_id);

      if (studentErr) {
        console.error('Errore aggiornamento automatico alunno:', studentErr.message);
      }
    }

    // Aggiorna genitore (utenti)
    if (Object.keys(parentUpdates).length > 0) {
      const { error: parentErr } = await supabase
        .from('utenti')
        .update(parentUpdates)
        .eq('id', currentParentId);

      if (parentErr) {
        console.error('Errore aggiornamento automatico genitore:', parentErr.message);
      }

      // Aggiorna anche adults per compatibilità (se esiste)
      try {
        const adultsUpdates: Record<string, any> = {};
        if (parentUpdates.nome) adultsUpdates.first_name = parentUpdates.nome;
        if (parentUpdates.cognome) adultsUpdates.last_name = parentUpdates.cognome;
        if (parentUpdates.cellulare) adultsUpdates.phones = [parentUpdates.cellulare];
        
        if (Object.keys(adultsUpdates).length > 0) {
          await supabase.from('adults').update(adultsUpdates).eq('id', currentParentId);
        }
      } catch (err) {
        // skippiamo adults
      }
    }

    // 3. Salva la sottomissione
    // Definiamo un finto path PDF nello storage per simulare l'archiviazione
    const randomName = Math.random().toString(36).substring(2, 10);
    const pdfPath = `signed_forms/${form_id}/${student_id || 'onboarding'}_${randomName}.pdf`;

    const record = {
      form_id,
      parent_id: currentParentId,
      student_id: student_id || null,
      answers,
      is_signed: !!is_signed,
      signature_log: signature_log || null,
      pdf_path: pdfPath
    };

    const { data: submission, error: subErr } = await supabase
      .from('forms_submissions')
      .insert(record)
      .select()
      .single();

    if (subErr) {
      return NextResponse.json({ error: subErr.message }, { status: 500 });
    }

    return NextResponse.json(submission, { status: 201 });
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
