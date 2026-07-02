import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';

/**
 * GET /api/admin/audit?attoreId=&entitaTipo=&limit=  (staff)
 *
 * Dashboard audit: elenco cronologico immutabile delle scritture
 * (`audit_scritture_docente`), filtrabile per attore e tipo entità. Riusa il log
 * esistente (registro docente + credenziali + anagrafica).
 */
export async function GET(request: Request) {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const { searchParams } = new URL(request.url);
  const attoreId = searchParams.get('attoreId');
  const entitaTipo = searchParams.get('entitaTipo');
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 100) || 100, 1), 500);

  const supabase = await createAdminClient();
  let q = supabase
    .from('audit_scritture_docente')
    .select('id, attore_id, attore_ruolo, scuola_id, section_id, entita_tipo, entita_id, azione, creato_il')
    .order('creato_il', { ascending: false })
    .limit(limit);
  if (attoreId) q = q.eq('attore_id', attoreId);
  if (entitaTipo) q = q.eq('entita_tipo', entitaTipo);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
