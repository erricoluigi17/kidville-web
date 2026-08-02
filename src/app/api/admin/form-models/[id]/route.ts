import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { esitoScopeModello } from '@/lib/forms/scope-modello';
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

    // La risposta è `select('*')`: schema del modulo, `public_token` (la
    // capability che apre `/m/{token}` senza credenziali) e stato di
    // pubblicazione del modello. PR #60 aveva messo in scope la sola CREAZIONE:
    // questa lettura restava aperta su qualunque plesso.
    // Lettura, non scrittura: i modelli GLOBALI (`scuola_id` NULL) passano —
    // valgono per tutte le sedi ed è la loro definizione. Quelli di un'altra
    // sede rispondono 404.
    const negato = await esitoScopeModello(supabase, auth.user, data, {
      operazione: 'admin/form-models/[id]:GET', perScrittura: false,
    });
    if (negato) return negato;

    return NextResponse.json(data);
  } catch (err) {
    logErrore({ operazione: 'admin/form-models/[id]:GET', stato: 500 }, err);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
});
