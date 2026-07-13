import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/auth/require-staff';
import { requireEnv } from '@/lib/security/require-env';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';

// GET /api/admin/credentials-pdf?key=<uuid>-<timestamp>.pdf
// Scarica il PDF credenziali dal bucket privato. Riservato allo staff (il link è
// consegnato nel centro notifiche della segreteria dopo la rigenerazione).
// La regex sulla key impedisce path traversal / lettura arbitraria del bucket.
const getQuerySchema = z.object({
  key: z.string().regex(/^[0-9a-fA-F-]+-\d+\.pdf$/, 'key non valida'),
});

export const GET = withRoute('admin/credentials-pdf:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  if (missingEnv) return missingEnv;
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data, error } = await admin.storage.from('credenziali').download(q.data.key);
  if (error || !data) return NextResponse.json({ error: 'PDF non trovato' }, { status: 404 });

  return new NextResponse(data, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="credenziali-kidville.pdf"',
      'Cache-Control': 'no-store',
    },
  });
});
