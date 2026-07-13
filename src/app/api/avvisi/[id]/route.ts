import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

interface RouteParams {
    params: Promise<{ id: string }>;
}

const putBodySchema = z.object({
    titolo: z.string().min(1, 'Titolo e contenuto sono obbligatori'),
    contenuto: z.string().min(1, 'Titolo e contenuto sono obbligatori'),
    tipo: z.string().nullish(),
    target_scope: z.string().nullish(),
    target_classes: z.unknown().optional(),
    scadenza: z.string().nullish(),
    attachment_url: z.string().nullish(),
});

// Verifica che l'avviso sia in un plesso dell'attore (tenant). 403 altrimenti.
async function assertAvvisoInScope(
    supabase: Awaited<ReturnType<typeof createAdminClient>>,
    user: { id: string; role: string; scuola_id?: string | null },
    id: string,
): Promise<NextResponse | null> {
    const { data: row } = await supabase.from('avvisi').select('scuola_id').eq('id', id).maybeSingle();
    const plessi = await scuoleDiUtente(supabase, user as never);
    if (!row || !row.scuola_id || !plessi.includes(row.scuola_id as string)) {
        return NextResponse.json({ error: 'Accesso negato: avviso fuori dal tuo plesso' }, { status: 403 });
    }
    return null;
}

// GET /api/avvisi/[id]
// Singolo avviso (deep-link del dettaglio cockpit /admin/avvisi/[id]).
export const GET = withRoute('avvisi/[id]:GET', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const p = parseData(zUuid, rawParams.id);
        if ('response' in p) return p.response;
        const id = p.data;

        const supabase = await createAdminClient();
        const scopeErr = await assertAvvisoInScope(supabase, auth.user, id);
        if (scopeErr) return scopeErr;

        const { data, error } = await supabase
            .from('avvisi')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) {
            logErrore({ operazione: 'avvisi/[id]:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
        if (!data) {
            return NextResponse.json({ error: 'Avviso non trovato' }, { status: 404 });
        }

        // Autore con query separata (nessun FK embed, come la route lista).
        const { data: author } = await supabase
            .from('utenti')
            .select('nome, cognome, ruolo, first_name, last_name, role')
            .eq('id', data.author_id)
            .maybeSingle();

        return NextResponse.json({
            ...data,
            author: author ? {
                first_name: author.first_name || author.nome || '?',
                last_name: author.last_name || author.cognome || '?',
                role: author.role || author.ruolo || 'unknown',
            } : { first_name: '?', last_name: '?', role: 'unknown' },
        });
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// PUT /api/avvisi/[id]
// Body: { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url }
export const PUT = withRoute('avvisi/[id]:PUT', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const p = parseData(zUuid, rawParams.id);
        if ('response' in p) return p.response;
        const id = p.data;

        const b = await parseBody(request, putBodySchema);
        if ('response' in b) return b.response;
        const { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url } = b.data;

        const supabase = await createAdminClient();
        const scopeErr = await assertAvvisoInScope(supabase, auth.user, id);
        if (scopeErr) return scopeErr;

        const { data, error } = await supabase
            .from('avvisi')
            .update({
                titolo,
                contenuto,
                tipo,
                target_scope,
                target_classes,
                scadenza: scadenza || null,
                attachment_url: attachment_url || null,
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: id, azione: 'update', valoreDopo: { id, titolo },
        });

        return NextResponse.json(data);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]:PUT', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// DELETE /api/avvisi/[id]
export const DELETE = withRoute('avvisi/[id]:DELETE', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const p = parseData(zUuid, rawParams.id);
        if ('response' in p) return p.response;
        const id = p.data;
        const supabase = await createAdminClient();
        const scopeErr = await assertAvvisoInScope(supabase, auth.user, id);
        if (scopeErr) return scopeErr;

        const { error } = await supabase
            .from('avvisi')
            .delete()
            .eq('id', id);

        if (error) {
            logErrore({ operazione: 'avvisi/[id]:DELETE', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: id, azione: 'delete',
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]:DELETE', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
