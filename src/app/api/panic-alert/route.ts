import { NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { enqueueNotifiche } from '@/lib/push/enqueue';
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche';

// Ruoli che presidiano l'uscita: ricevono il Panic Alert in tempo reale.
const STAFF_PANIC = new Set(['segreteria', 'admin', 'coordinator']);

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

        // Notifica simultanea Segreteria/Direzione + genitori (servizio push P1).
        // Best-effort: un errore di notifica non deve invalidare il Panic Alert salvato.
        try {
            const admin = await createAdminClient();
            const { data: alunno } = await admin.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle();
            const TITOLO = '⚠️ Panic Alert — Ritiro non autorizzato';
            const CORPO = 'Segnalato un tentativo di ritiro non autorizzato. Verificare immediatamente.';

            // Staff del plesso (role o ruolo, schema legacy doppio).
            if (alunno?.scuola_id) {
                const { data: staff } = await admin
                    .from('utenti')
                    .select('id, role, ruolo')
                    .eq('scuola_id', alunno.scuola_id);
                const staffIds = (staff ?? [])
                    .filter((u: { role?: string | null; ruolo?: string | null }) => STAFF_PANIC.has(u.role ?? '') || STAFF_PANIC.has(u.ruolo ?? ''))
                    .map((u: { id: string }) => u.id);
                if (staffIds.length > 0) {
                    await enqueueNotifiche(admin, {
                        utenteIds: staffIds,
                        tipo: 'panic_alert',
                        titolo: TITOLO,
                        corpo: CORPO,
                        entitaTipo: 'presenza',
                        entitaId: alunnoId,
                        bufferMin: 0,
                    });
                }
            }

            // Genitori dell'alunno.
            await enqueueNotifichePerAlunni(admin, {
                alunnoIds: [alunnoId],
                tipo: 'panic_alert',
                titolo: TITOLO,
                corpo: CORPO,
                entitaTipo: 'presenza',
                entitaId: alunnoId,
                bufferMin: 0,
            });
        } catch (notifyErr) {
            console.error('Panic Alert — notifica (non bloccante):', notifyErr);
        }

        return NextResponse.json({ success: true, message: 'Panic Alert registrato' });

    } catch (error) {
        console.error('Errore API Panic Alert:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
