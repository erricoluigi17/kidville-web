import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso

export const GET = withRoute('admin/check-schema:GET', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;
  const supabase = await createAdminClient();

  // Get staff from utenti (adults table not in public schema)
  const { data: staff, error } = await supabase
    .from('utenti')
    .select('id, first_name, last_name, nome, cognome, ruolo, email')
    .in('ruolo', ['maestra', 'educator', 'admin', 'coordinator', 'coordinatore'])
    .order('cognome');

  return NextResponse.json({
    staff: staff?.map(u => ({
      id: u.id,
      first_name: u.first_name || u.nome,
      last_name: u.last_name || u.cognome,
      role: u.ruolo,
      email: u.email
    })),
    staffError: error?.message
  });
});
