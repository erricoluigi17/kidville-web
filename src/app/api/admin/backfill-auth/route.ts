import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { sealDangerous } from '@/lib/security/seal';
import { requireEnv } from '@/lib/security/require-env';
import { backfillParentsAuth } from '@/lib/auth/backfill';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postQuerySchema = z.object({
  // Oggi: dryRun attivo SOLO con '1' o 'true' (case-sensitive); qualunque altro
  // valore (o assenza) equivale a false. Trasformazione permissiva, niente zBool.
  dryRun: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  // Sostituisce il 400 manuale su target !== 'parents' (stessa semantica).
  target: z
    .enum(['parents'], {
      error:
        'target non supportato. Solo "parents": lo staff è già auth-backed (usa Rigenera credenziali).',
    })
    .default('parents'),
});

/**
 * POST /api/admin/backfill-auth?target=parents&dryRun=1  (admin only)
 *
 * One-shot idempotente: crea un `auth.users` per ogni `parents` con email e senza
 * `auth_user_id`, deduplicando per email, e scrive `parents.auth_user_id`.
 * Lo staff NON necessita backfill (`utenti.id` è già FK → `auth.users`); per
 * impostare/azzerare una password staff usare "Rigenera credenziali" (S11).
 */
export const POST = withRoute('admin/backfill-auth:POST', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;

  const q = parseQuery(request, postQuerySchema);
  if ('response' in q) return q.response;
  const { dryRun } = q.data;

  const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  if (missingEnv) return missingEnv;
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    const report = await backfillParentsAuth(admin as never, { dryRun });
    return NextResponse.json(report);
  } catch (e) {
    logErrore({ operazione: 'admin/backfill-auth:POST', stato: 500 }, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
});
