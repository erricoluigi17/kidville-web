import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { notaId } = body;

        if (!notaId) {
            return NextResponse.json({ error: 'notaId è obbligatorio' }, { status: 400 });
        }

        const supabase = await createClient();

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 });
        }

        // Recuperiamo l'IP per validità legale della firma (semplificata)
        const ip = request.headers.get('x-forwarded-for') || request.headers.get('remote-addr') || 'unknown';

        // Aggiorniamo la nota
        const { error: dbError } = await supabase
            .from('note_disciplinari')
            .update({
                firmata_il: new Date().toISOString(),
                firmata_da: user.id
            })
            .eq('id', notaId)
            .eq('richiede_firma', true);

        if (dbError) {
            console.error('Errore firma nota:', dbError);
            return NextResponse.json({ error: 'Errore durante la firma' }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'Nota firmata con successo', ip });

    } catch (error) {
        console.error('Errore API Firma Nota:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
