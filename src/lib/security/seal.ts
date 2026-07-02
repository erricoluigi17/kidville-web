import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth/require-staff';

/**
 * Sigilla un endpoint pericoloso (seed/wipe/debug/migrazioni applicative):
 *  - in produzione restituisce 404 (l'endpoint "non esiste");
 *  - altrimenti è riservato al ruolo `admin`.
 *
 * Uso:
 *   const sealed = await sealDangerous(request);
 *   if (sealed) return sealed;
 */
export async function sealDangerous(request: Request): Promise<NextResponse | null> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const auth = await requireStaff(request, ['admin']);
  return auth.response ?? null;
}
