import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { requireEnv } from '@/lib/security/require-env';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso (id di test hardcoded)

export const GET = withRoute('admin/test-relations:GET', async (request: Request) => {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    // Factory STRUMENTATO, non `createClient` di supabase-js. La route è `sealDangerous` (404 in
    // produzione) e serve solo a ispezionare i legami, ma la regola non ha eccezioni «tanto è di
    // servizio»: un client non strumentato in più è il precedente da cui nasce il settimo. Vedi
    // `__tests__/architecture/supabase-client-strumentato.test.ts`.
    const missingEnv = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (missingEnv) return missingEnv;
    const supabase = await createAdminClient();
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
