import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

const postBodySchema = z.object({
    notaId: zUuid,
});

export async function POST(request: Request) {
    try {
        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { notaId } = b.data;

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

        // Recupera l'utente dalla sessione se disponibile
        const sessionClient = await createClient();
        const { data: { user } } = await sessionClient.auth.getUser();
        const userId = user?.id ?? '00000000-0000-0000-0000-000000000002'; // fallback genitore

        // Recuperiamo l'IP per validità legale della firma (semplificata)
        const ip = request.headers.get('x-forwarded-for') || request.headers.get('remote-addr') || 'unknown';

        // Aggiorniamo la nota
        const { error: dbError } = await supabase
            .from('note_disciplinari')
            .update({
                firmata_il: new Date().toISOString(),
                firmata_da: userId
            })
            .eq('id', notaId)
            .eq('richiede_firma', true);

        if (dbError) {
            console.error('Errore firma nota:', dbError);
            return NextResponse.json({ error: 'Errore durante la firma', details: dbError.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'Nota firmata con successo', ip });

    } catch (error) {
        console.error('Errore API Firma Nota:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
