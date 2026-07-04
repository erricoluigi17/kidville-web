import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

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
export async function GET(request: Request, { params }: RouteParams) {
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
            console.error('Errore get avviso:', error);
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
        console.error('Errore API GET avviso:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// PUT /api/avvisi/[id]
// Body: { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url }
export async function PUT(request: Request, { params }: RouteParams) {
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
            console.error('Errore update avviso:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: id, azione: 'update', valoreDopo: { id, titolo },
        });

        return NextResponse.json(data);
    } catch (error) {
        console.error('Errore API PUT avvisi:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// DELETE /api/avvisi/[id]
export async function DELETE(request: Request, { params }: RouteParams) {
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
            console.error('Errore delete avviso:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: id, azione: 'delete',
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Errore API DELETE avvisi:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
