import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const postBodySchema = z.object({
    notaId: zUuid,
});

export const POST = withRoute('notes/sign:POST', async (request: Request) => {
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

        // Notifica al docente autore: firma ricevuta (best-effort).
        try {
            const { data: notaFull } = await supabase
                .from('note_disciplinari')
                .select('maestra_id')
                .eq('id', notaId)
                .maybeSingle();
            const maestraId = notaFull?.maestra_id as string | undefined;
            if (maestraId && maestraId !== userId) {
                const { data: alunno } = await supabase
                    .from('alunni')
                    .select('nome, cognome, scuola_id')
                    .eq('id', nota.alunno_id)
                    .maybeSingle();
                const firmatario = await nomeUtente(supabase, userId);
                await notificaEvento(supabase, {
                    tipo: 'firma_ricevuta',
                    scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
                    utenteIds: [maestraId],
                    titolo: 'Nota firmata dal genitore',
                    corpo: `${firmatario ?? 'Un genitore'} ha firmato la nota di ${[alunno?.nome, alunno?.cognome].filter(Boolean).join(' ') || 'un alunno'}.`,
                    link: '/teacher/diary',
                    entitaTipo: 'nota',
                    entitaId: notaId,
                });
            }
        } catch (e) {
            console.error('Notifica firma nota fallita (non bloccante):', e);
        }

        return NextResponse.json({ success: true, message: 'Nota firmata con successo', ip });

    } catch (error) {
        logErrore({ operazione: 'notes/sign:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
