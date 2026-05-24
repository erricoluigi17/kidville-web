import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

interface RouteParams {
    params: Promise<{ id: string }>;
}

// PUT /api/avvisi/[id]
// Body: { titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url }
export async function PUT(request: Request, { params }: RouteParams) {
    try {
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

        return NextResponse.json(data);
    } catch (error) {
        console.error('Errore API PUT avvisi:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// DELETE /api/avvisi/[id]
export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const { id } = await params;
        const supabase = await createAdminClient();

        const { error } = await supabase
            .from('avvisi')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Errore delete avviso:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Errore API DELETE avvisi:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
