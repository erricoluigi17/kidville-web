import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope } from '@/lib/auth/scope';
import { enqueueNotifiche } from '@/lib/push/enqueue';
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche';
import { staffScuola } from '@/lib/notifiche/destinatari';
import { parseBody } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
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

        // La sessione c'era, il RUOLO no: qualunque utente autenticato — un
        // genitore compreso — poteva far scattare l'allarme «ritiro non
        // autorizzato» su qualunque bambino, di qualunque sede, bloccandogli
        // l'uscita e allertando segreteria e famiglia. È un pulsante
        // d'emergenza, quindi resta rapidissimo da usare per chi è al cancello:
        // si aggiunge il gate di ruolo e il vincolo di plesso, nient'altro.
        const gate = await requireDocente(request);
        if (gate.response) return gate.response;
        const admin = await createAdminClient();
        const fuoriScope = await assertAlunnoInScope(admin, gate.user, alunnoId);
        if (fuoriScope) return fuoriScope;

        // Giorno civile ITALIANO, non UTC (rilievo T27). Qui il fuso non
        // sposta un conteggio: sposta un ALLARME di ritiro non autorizzato
        // sulla presenza del giorno sbagliato.
        const today = oggiFiscaleISO();

        // LA SEDE È UNA PROPRIETÀ DEL DATO, non del contesto: la presenza di un
        // bambino appartiene al plesso del bambino. Si legge PRIMA della scrittura
        // (serve a entrambe: alla riga di `presenze` e ai destinatari), e il valore
        // non si indovina — `assertAlunnoInScope` qui sopra ha già garantito che
        // l'alunno esiste e che è nel plesso di chi sta chiamando.
        const { data: alunno, error: errAlunno } = await admin
            .from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle();
        const sedeAlunno = (alunno?.scuola_id as string | undefined) ?? null;
        if (!sedeAlunno) {
            // Non blocca il salvataggio (è un pulsante d'emergenza), ma non può tacere:
            // senza sede la riga nasce con la chiave di tenancy vuota e l'allarme non
            // ha un plesso a cui rivolgersi.
            logEvento('notifica', 'error', {
                operazione: 'panic-alert:POST',
                esito: 'sede-non-risolta',
            }, errAlunno ?? undefined);
        }

        const { error: dbError } = await supabase
            .from('presenze')
            .upsert({
                alunno_id: alunnoId,
                data: today,
                panic_alert: true,
                sync_status: 'synced',
                aggiornato_il: new Date().toISOString(),
                ...(sedeAlunno ? { scuola_id: sedeAlunno } : {}),
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
            const TITOLO = '⚠️ Panic Alert — Ritiro non autorizzato';
            const CORPO = 'Segnalato un tentativo di ritiro non autorizzato. Verificare immediatamente.';

            // Staff del plesso. NON `utenti.scuola_id`: l'appartenenza a una sede è
            // l'unione fra quella colonna e il ponte `utenti_scuole` — e nelle sedi
            // aperte il 2026-07-29 nessuno ha ancora quel plesso come primario.
            // Con la query nuda, per un bambino di Aversa o Cesa la lista usciva
            // vuota, `if (staffIds.length > 0)` non scattava e non restava NESSUNA
            // riga: «zero destinatari» non è un'eccezione, quindi il catch qui sotto
            // non lo vedeva. `staffScuola` guarda il ponte e logga da sé.
            if (sedeAlunno) {
                const staffIds = await staffScuola(admin, sedeAlunno, [...STAFF_PANIC]);
                if (staffIds.length > 0) {
                    await enqueueNotifiche(admin, {
                        utenteIds: staffIds,
                        tipo: 'panic_alert',
                        titolo: TITOLO,
                        corpo: CORPO,
                        entitaTipo: 'presenza',
                        entitaId: alunnoId,
                        bufferMin: 0,
                        scuolaId: sedeAlunno,
                    });
                } else {
                    // `error` e non `warn`: su un allarme di sicurezza «non c'è nessuno da
                    // avvisare» è un incidente da riparare subito, non una configurazione
                    // accettabile. I genitori vengono comunque avvisati qui sotto, ed è
                    // esattamente ciò che rendeva il guasto invisibile dall'esterno.
                    logEvento('notifica', 'error', {
                        operazione: 'panic-alert:POST',
                        esito: 'nessun-destinatario-staff',
                        sede_id: sedeAlunno,
                        tipo: 'panic_alert',
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
                scuolaId: sedeAlunno,
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
