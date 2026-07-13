import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import {
  ensureStandardEnrollmentModel,
  ENROLLMENT_DEFAULT_SCHEMA,
  STANDARD_ENROLLMENT_MODEL_ID,
} from '@/lib/forms/enrollment-default-schema';

// POST /api/admin/form-models/reset — "Reimposta" il Modulo d'iscrizione standard
// ai valori di base (ENROLLMENT_DEFAULT_SCHEMA). Consentito SOLO per il modello
// standard; gate staff + audit.
const bodySchema = z.object({ id: z.string().min(1) });

export const POST = withRoute('admin/form-models/reset:POST', async (request: Request) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const b = await parseBody(request, bodySchema);
  if ('response' in b) return b.response;

  if (b.data.id !== STANDARD_ENROLLMENT_MODEL_ID) {
    return NextResponse.json(
      { error: "Reset consentito solo per il modulo d'iscrizione standard" },
      { status: 400 },
    );
  }

  try {
    const supabase = await createAdminClient();
    await ensureStandardEnrollmentModel(supabase);
    const { error } = await supabase
      .from('form_models')
      .update({
        schema: ENROLLMENT_DEFAULT_SCHEMA,
        is_active: true,
        is_enrollment_form: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', STANDARD_ENROLLMENT_MODEL_ID);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'form_model',
      entitaId: STANDARD_ENROLLMENT_MODEL_ID,
      azione: 'update',
      valoreDopo: { reset: true },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    logErrore({ operazione: 'admin/form-models/reset:POST', stato: 500 }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 },
    );
  }
});
