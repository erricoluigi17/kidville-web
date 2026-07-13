import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { parseBody, parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

interface RouteParams {
    params: Promise<{ id: string }>;
}

const postBodySchema = z.object({
    parent_id: zUuid,
    student_id: zUuid,
    risposta: z.unknown().optional(),
});

// GET /api/avvisi/[id]/risposte
// Lista risposte per un avviso specifico (dashboard monitoraggio = staff). Gatato.
export const GET = withRoute('avvisi/[id]/risposte:GET', async (request: Request, { params }: RouteParams) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const rawParams = await params;
        const pId = parseData(zUuid, rawParams.id);
        if ('response' in pId) return pId.response;
        const avvisoId = pId.data;

        const supabase = await createAdminClient();

        const { data, error } = await supabase
            .from('avvisi_risposte')
            .select(`
                id,
                parent_id,
                student_id,
                letto_il,
                risposta,
                risposto_il
            `)
            .eq('avviso_id', avvisoId);

        if (error) {
            logErrore({ operazione: 'avvisi/[id]/risposte:GET', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Arricchisci con nomi
        const enriched = await Promise.all(
            (data ?? []).map(async (r) => {
                const { data: parent } = await supabase
                    .from('utenti')
                    .select('nome, cognome, first_name, last_name')
                    .eq('id', r.parent_id)
                    .maybeSingle();

                const { data: student } = await supabase
                    .from('alunni')
                    .select('nome, cognome')
                    .eq('id', r.student_id)
                    .maybeSingle();

                return {
                    ...r,
                    parent_name: parent ? `${parent.first_name || parent.nome} ${parent.last_name || parent.cognome}` : '?',
                    student_name: student ? `${student.nome} ${student.cognome}` : '?',
                };
            })
        );

        return NextResponse.json(enriched);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]/risposte:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// POST /api/avvisi/[id]/risposte
// Body: { parent_id, student_id, risposta? }
// Registra presa visione o adesione
export const POST = withRoute('avvisi/[id]/risposte:POST', async (request: Request, { params }: RouteParams) => {
    try {
        const rawParams = await params;
        const pId = parseData(zUuid, rawParams.id);
        if ('response' in pId) return pId.response;
        const avvisoId = pId.data;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { parent_id, student_id, risposta } = b.data;

        const supabase = await createAdminClient();
        const now = new Date().toISOString();

        // Controlla se esiste già una risposta per preservare i campi
        const { data: existing } = await supabase
            .from('avvisi_risposte')
            .select('letto_il, risposta, risposto_il')
            .eq('avviso_id', avvisoId)
            .eq('parent_id', parent_id)
            .eq('student_id', student_id)
            .maybeSingle();

        const insertPayload: Record<string, unknown> = {
            avviso_id: avvisoId,
            parent_id,
            student_id,
            letto_il: existing?.letto_il || now,
        };

        if (risposta !== undefined) {
            insertPayload.risposta = risposta;
            insertPayload.risposto_il = now;
        } else if (existing) {
            insertPayload.risposta = existing.risposta;
            insertPayload.risposto_il = existing.risposto_il;
        }

        // Upsert: se la risposta esiste già, aggiorna
        const { data, error } = await supabase
            .from('avvisi_risposte')
            .upsert(insertPayload, {
                onConflict: 'avviso_id,parent_id,student_id',
            })
            .select()
            .single();

        if (error) {
            logErrore({ operazione: 'avvisi/[id]/risposte:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Notifica all'autore dell'avviso (best-effort), solo alla PRIMA presa
        // visione/risposta di questo genitore (le riaperture non ri-notificano).
        // Buffer 60' + debounce per avviso → una notifica riassuntiva, non 30.
        try {
            const primaLettura = !existing;
            const primaRisposta = risposta !== undefined && existing?.risposta == null;
            if (primaLettura || primaRisposta) {
                const { data: avviso } = await supabase
                    .from('avvisi')
                    .select('author_id, titolo, scuola_id')
                    .eq('id', avvisoId)
                    .maybeSingle();
                if (avviso?.author_id && avviso.author_id !== parent_id) {
                    const { data: autore } = await supabase
                        .from('utenti')
                        .select('role, ruolo')
                        .eq('id', avviso.author_id)
                        .maybeSingle();
                    const ruoloAutore = ((autore?.role as string) || (autore?.ruolo as string) || '').toLowerCase();
                    const areaStaff = ['admin', 'coordinator', 'segreteria'].includes(ruoloAutore);
                    await notificaEvento(supabase, {
                        tipo: 'avviso_risposta',
                        scuolaId: (avviso.scuola_id as string | undefined) ?? null,
                        utenteIds: [avviso.author_id as string],
                        titolo: 'Nuove risposte al tuo avviso',
                        corpo: `Ci sono nuove prese visione o adesioni per «${avviso.titolo}».`,
                        link: areaStaff ? `/admin/avvisi/${avvisoId}` : '/teacher/avvisi',
                        entitaTipo: 'avviso',
                        entitaId: avvisoId,
                        bufferMin: 60,
                        debounce: true,
                    });
                }
            }
        } catch (e) {
            // `error` benché la risposta del genitore sia registrata: l'autore dell'avviso non
            // saprà mai che è arrivata una presa visione o un'adesione. La riga di risposta c'è,
            // il suo annuncio no — ed è proprio il conteggio delle adesioni che chi ha pubblicato
            // l'avviso sta aspettando.
            logEvento('notifica', 'error', {
                operazione: 'avvisi/[id]/risposte:POST',
                esito: 'notifica-autore-non-accodata',
            }, e);
        }

        return NextResponse.json(data);
    } catch (error) {
        logErrore({ operazione: 'avvisi/[id]/risposte:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
