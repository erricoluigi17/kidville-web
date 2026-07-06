import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import {
  ensureStandardEnrollmentModel,
  ENROLLMENT_DEFAULT_SCHEMA,
  STANDARD_ENROLLMENT_MODEL_ID,
} from '@/lib/forms/enrollment-default-schema';

// GET pubblico: schema (campi) del "Modulo d'iscrizione standard", così il
// wizard /iscrizione riflette le modifiche fatte dalla segreteria nel builder.
// Restituisce SOLO lo schema (nessun dato personale). Se il modello non è ancora
// stato creato, lo crea (idempotente) e ritorna il set base.
const getQuerySchema = z.object({}); // nessun parametro in ingresso

export async function GET(request: Request) {
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;
  try {
    const supabase = await createAdminClient();
    await ensureStandardEnrollmentModel(supabase);
    const { data } = await supabase
      .from('form_models')
      .select('schema')
      .eq('id', STANDARD_ENROLLMENT_MODEL_ID)
      .maybeSingle();
    return NextResponse.json({ schema: data?.schema ?? ENROLLMENT_DEFAULT_SCHEMA });
  } catch {
    return NextResponse.json({ schema: ENROLLMENT_DEFAULT_SCHEMA });
  }
}
