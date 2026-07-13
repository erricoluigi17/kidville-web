import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { enqueueNotifiche } from '@/lib/push/enqueue';
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// Ruoli che presidiano l'uscita: ricevono il Panic Alert in tempo reale.
const STAFF_PANIC = new Set(['segreteria', 'admin', 'coordinator']);

const postBodySchema = z.object({
    alunnoId: zUuid,
});

export const POST = withRoute('panic-alert:POST', async (request: Request) => {
    try {
        const supabase = await createClient();

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 });
        }

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunnoId } = b.data;

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
            logErrore({ operazione: 'panic-alert:POST', stato: 500, evento: 'db' }, dbError);
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
                        scuolaId: alunno.scuola_id as string,
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
                scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
            });
        } catch (notifyErr) {
            // `error`, e qui più che altrove: la richiesta risponde 200 perché il Panic Alert è
            // SALVATO, ma l'allarme serve solo se ARRIVA. Se le notifiche non vengono accodate,
            // segreteria e genitori non sanno nulla di un tentativo di ritiro non autorizzato:
            // sul registro risulterà un alert «registrato» che nessuno ha mai ricevuto. È il caso
            // in cui un guasto silenzioso costa di più.
            logEvento('notifica', 'error', {
                operazione: 'panic-alert:POST',
                esito: 'allarme-non-accodato',
                tipo: 'panic_alert',
            }, notifyErr);
        }

        return NextResponse.json({ success: true, message: 'Panic Alert registrato' });

    } catch (error) {
        logErrore({ operazione: 'panic-alert:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
})
