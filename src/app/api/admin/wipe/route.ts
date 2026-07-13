import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { sealDangerous } from '@/lib/security/seal';
import { requireEnv } from '@/lib/security/require-env';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

const querySchema = z.object({}); // nessun parametro in ingresso

export const POST = withRoute('admin/wipe:POST', async (request: Request) => {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
    if (missingEnv) return missingEnv;
    const q = parseQuery(request, querySchema);
    if ('response' in q) return q.response;
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL as string,
        process.env.SUPABASE_SERVICE_ROLE_KEY as string
    );
    try {
        const tablesToClear = [
            'student_parents', 'legame_genitori_alunni', 'student_adults', 
            'delegates', 'delegati', 'student_documents', 'educator_sections',
            'eventi_diario', 'valutazioni', 'galleria_media', 'armadietto',
            'locker_inventory', 'locker_requests', 'locker_loads',
            'ticket_mensa', 'pagamenti', 'registro_modifiche', 'firme_documenti',
            'daily_routines', 'presenze', 'firme_docenti', 'registro_orario', 'note_disciplinari'
        ];

        for (const table of tablesToClear) {
            try {
                await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
                await supabase.from(table).delete().not('created_at', 'is', null);
            } catch (e) {
                // Errore IGNORABILE per costruzione: la lista è un elenco storico e alcune di
                // queste tabelle non esistono in tutti gli ambienti — un wipe che si fermasse
                // alla prima assente non pulirebbe le successive. Ma «saltata» va detto (AGENTS
                // regola 6: un catch che non logga è un bug), altrimenti una tabella rimasta
                // sporca dopo un wipe "riuscito" sarebbe inspiegabile. `info`: non è un guasto.
                logEvento('db', 'info', {
                    operazione: 'admin/wipe:POST',
                    esito: 'tabella-saltata',
                    tabella: table,
                }, e);
            }
        }

        await supabase.from('alunni').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('parents').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('adults').delete().neq('id', '00000000-0000-0000-0000-000000000000');

        return NextResponse.json({ success: true, message: 'Wipe completed' });
    } catch (err) {
        logErrore({ operazione: 'admin/wipe:POST', stato: 500 }, err);
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 }
        );
    }
});
