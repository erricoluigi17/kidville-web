import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { requireEnv } from '@/lib/security/require-env';
import { createClient } from '@supabase/supabase-js';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso (id di test hardcoded)

export const GET = withRoute('admin/test-relations:GET', async (request: Request) => {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
    if (missingEnv) return missingEnv;
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL as string,
        process.env.SUPABASE_SERVICE_ROLE_KEY as string
    );
    const { data, error } = await supabase.from('alunni').select(`
        id, cognome, nome,
        student_parents (
            parent_id,
            relation_type,
            parents (*)
        )
    `).eq('id', '553309b3-22db-4ddc-98fb-d1dbfdd841ba');
    return NextResponse.json({ data, error });
});
