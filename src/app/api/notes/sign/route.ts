import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

const postBodySchema = z.object({
    notaId: zUuid,
});

export async function POST(request: Request) {
    try {
        // Gap auth segnalato in M3, chiuso in M9: prima firmava con un
        // FALLBACK DEMO senza sessione. Ora: utente autenticato + legame
        // genitore↔alunno della nota (solo il genitore dell'alunno firma).
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const userId = auth.user.id;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { notaId } = b.data;

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

        const { data: nota } = await supabase
            .from('note_disciplinari')
            .select('id, alunno_id')
            .eq('id', notaId)
            .maybeSingle();
        if (!nota) {
            return NextResponse.json({ error: 'Nota non trovata' }, { status: 404 });
        }

        const { data: legame } = await supabase
            .from('legame_genitori_alunni')
            .select('alunno_id')
            .eq('genitore_id', userId)
            .eq('alunno_id', nota.alunno_id)
            .maybeSingle();
        if (!legame) {
            return NextResponse.json(
                { error: 'Accesso negato: la nota non riguarda i tuoi figli' },
                { status: 403 }
            );
        }

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
