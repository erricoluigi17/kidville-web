import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami';
import { persistSignedSubmission } from '@/lib/forms/persist-submission';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

// ─── Schemi di validazione input (M3/M4) ─────────────────────────────────────
// L'identità viene dal gate (requireUser): il `parent_id` legacy in query/body
// è ignorato, nessun fallback demo (M4).

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
});

const getQuerySchema = z.object({});

// POST: Sottoscrive e firma un modulo
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const { form_id, student_id, answers, is_signed, signature_log } = b.data;

    const supabase = await createAdminClient();

    // IDOR: un genitore può sottomettere (e auto-aggiornare l'anagrafica) solo su
    // un PROPRIO figlio. student_id assente = onboarding (ammesso).
    if (student_id && auth.user.role === 'genitore' && !(await genitoreHasFiglio(supabase, auth.user.id, student_id))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 });
    }

    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id: auth.user.id,
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
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const parentId = auth.user.id;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

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
