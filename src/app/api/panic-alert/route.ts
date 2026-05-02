import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { alunnoId } = body;

        if (!alunnoId) {
            return NextResponse.json({ error: 'alunnoId è obbligatorio' }, { status: 400 });
        }

        const supabase = await createClient();

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 });
        }

        const today = new Date().toISOString().split('T')[0];

        const { error: dbError } = await supabase
            .from('presenze')
            .upsert({
                alunno_id: alunnoId,
                data: today,
                panic_alert: true,
                sync_status: 'synced',
                aggiornato_il: new Date().toISOString()
            }, {
                onConflict: 'alunno_id, data'
            });

        if (dbError) {
            console.error('Errore Database Panic Alert:', dbError);
            return NextResponse.json({ error: 'Errore nel salvataggio del Panic Alert' }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'Panic Alert registrato' });

    } catch (error) {
        console.error('Errore API Panic Alert:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
