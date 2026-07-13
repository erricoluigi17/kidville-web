import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// GET /api/admin/form-models/[id] — modello completo (incl. schema) per il
// builder in modifica. Gate staff. Sostituisce l'assenza di caricamento: il
// builder ora apre un modello esistente con tutti i suoi campi.
export const GET = withRoute('admin/form-models/[id]:GET', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const { id: rawId } = await context.params;
  const idP = parseData(zUuid, rawId);
  if ('response' in idP) return idP.response;

  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from('form_models')
      .select('*')
      .eq('id', idP.data)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Modello non trovato' }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    logErrore({ operazione: 'admin/form-models/[id]:GET', stato: 500 }, err);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
});
