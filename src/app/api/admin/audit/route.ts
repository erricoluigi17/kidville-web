import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseQuery } from '@/lib/validation/http';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `attoreId`/`entitaTipo`: filtri opzionali, qualunque stringa (contratto storico
// permissivo, niente vincolo uuid; stringa vuota = filtro non applicato, come prima).
// `limit`: clamp storico preservato — default 100, non numerico → 100, range 1-500.
const getQuerySchema = z.object({
  attoreId: z.string().optional(),
  entitaTipo: z.string().optional(),
  limit: z.preprocess((v) => Math.min(Math.max(Number(v ?? 100) || 100, 1), 500), z.number()),
});

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

  const parsed = parseQuery(request, getQuerySchema);
  if ('response' in parsed) return parsed.response;
  const { attoreId, entitaTipo, limit } = parsed.data;

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
