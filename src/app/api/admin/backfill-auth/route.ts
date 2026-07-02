import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sealDangerous } from '@/lib/security/seal';
import { backfillParentsAuth } from '@/lib/auth/backfill';

/**
 * POST /api/admin/backfill-auth?target=parents&dryRun=1  (admin only)
 *
 * One-shot idempotente: crea un `auth.users` per ogni `parents` con email e senza
 * `auth_user_id`, deduplicando per email, e scrive `parents.auth_user_id`.
 * Lo staff NON necessita backfill (`utenti.id` è già FK → `auth.users`); per
 * impostare/azzerare una password staff usare "Rigenera credenziali" (S11).
 */
export async function POST(request: Request) {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1' || url.searchParams.get('dryRun') === 'true';
  const target = url.searchParams.get('target') ?? 'parents';

  if (target !== 'parents') {
    return NextResponse.json(
      { error: 'target non supportato. Solo "parents": lo staff è già auth-backed (usa Rigenera credenziali).' },
      { status: 400 }
    );
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  try {
    const report = await backfillParentsAuth(admin as never, { dryRun });
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
