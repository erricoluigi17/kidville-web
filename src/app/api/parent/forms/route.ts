import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3/M4) ─────────────────────────────────────
// L'identità viene dal gate (requireUser: sessione, o header legacy finché
// ALLOW_HEADER_IDENTITY≠false). Il `parent_id` legacy in query è ignorato:
// nessun fallback demo (M4).
const getQuerySchema = z.object({});

export const GET = withRoute('parent/forms:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const parentId = auth.user.id;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

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
    const result: Array<Record<string, unknown>> = [];

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
  } catch (err) {
    logErrore({ operazione: 'parent/forms:GET', stato: 500 }, err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
})
