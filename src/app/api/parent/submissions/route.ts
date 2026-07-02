import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { persistSignedSubmission } from '@/lib/forms/persist-submission';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333';

// parent_id opzionale: ogni valore falsy (assente, null, stringa vuota) ricade
// sul genitore demo, come il pre-esistente `parent_id || DEFAULT_PARENT_ID`.
const zParentIdConDefault = z.preprocess(
  (v) => (v ? v : undefined),
  zUuid.default(DEFAULT_PARENT_ID)
);

// student_id opzionale: stringa vuota trattata come assente
// (persistSignedSubmission fa già `student_id || null`).
const zStudentIdOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  zUuid.nullish()
);

const postBodySchema = z.object({
  form_id: zUuid,
  student_id: zStudentIdOpzionale,
  // answers è un pass-through jsonb: oggi è accettato qualsiasi valore truthy.
  answers: z.unknown().refine((v) => !!v, 'form_id e risposte obbligatori'),
  // is_signed è già coercito a boolean (`!!is_signed`) in persistSignedSubmission.
  is_signed: z.coerce.boolean().optional(),
  signature_log: z.unknown().optional(),
  parent_id: zParentIdConDefault,
});

const getQuerySchema = z.object({
  parent_id: zParentIdConDefault,
});

// POST: Sottoscrive e firma un modulo
export async function POST(request: NextRequest) {
  try {
    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const { form_id, student_id, answers, is_signed, signature_log, parent_id } = b.data;

    const supabase = await createAdminClient();
    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id,
      student_id,
      answers: answers as Record<string, unknown>,
      is_signed,
      signature_log,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result.submission, { status: 201 });
  } catch (err) {
    console.error('Errore POST /api/parent/submissions:', err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: Recupera tutte le sottomissioni per l'archivio genitore
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const parentId = q.data.parent_id;

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
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
