import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';

interface RouteParams {
    params: Promise<{ id: string }>;
}

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

// PUT /api/avvisi/[id]
// Body: { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url }
export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const { id } = await params;
        const body = await request.json();
        const { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url } = body;

        if (!titolo || !contenuto) {
            return NextResponse.json(
                { error: 'Titolo e contenuto sono obbligatori' },
                { status: 400 }
            );
        }

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
        const { id } = await params;
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
