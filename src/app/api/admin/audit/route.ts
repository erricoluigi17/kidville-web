import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

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
 *
 * ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). `scuola_id` era nella proiezione — per
 * MOSTRARLA — e mai nel filtro: la segreteria di un plesso riceveva l'intero
 * registro delle scritture di tutte le sedi (chi ha toccato quale entità, in
 * quale sezione, quando). Erano metadati su minori, ed era l'unico rilievo di
 * questo lotto che perdesse dati già in produzione.
 */
export const GET = withRoute('admin/audit:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const parsed = parseQuery(request, getQuerySchema);
  if ('response' in parsed) return parsed.response;
  const { attoreId, entitaTipo, limit } = parsed.data;

  const supabase = await createAdminClient();
  // Scope vuoto ⇒ elenco vuoto. `.in()` è incondizionato di proposito: un
  // `if (sedi.length > 0)` sarebbe fail-open, cioè l'esatto contrario.
  const sedi = await resolveScuoleAttive(request, supabase, auth.user);
  let q = supabase
    .from('audit_scritture_docente')
    .select('id, attore_id, attore_ruolo, scuola_id, section_id, entita_tipo, entita_id, azione, creato_il')
    .in('scuola_id', sedi)
    .order('creato_il', { ascending: false })
    .limit(limit);
  if (attoreId) q = q.eq('attore_id', attoreId);
  if (entitaTipo) q = q.eq('entita_tipo', entitaTipo);

  const { data, error } = await q;
  if (error) {
    logErrore({ operazione: 'admin/audit:GET', stato: 500, evento: 'db' }, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
});
