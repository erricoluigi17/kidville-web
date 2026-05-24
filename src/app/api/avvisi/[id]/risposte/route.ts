import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

interface RouteParams {
    params: Promise<{ id: string }>;
}

// GET /api/avvisi/[id]/risposte
// Lista risposte per un avviso specifico (dashboard monitoraggio)
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { id: avvisoId } = await params;

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
            console.error('Errore GET risposte:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Arricchisci con nomi
        const enriched = await Promise.all(
            (data ?? []).map(async (r) => {
                const { data: parent } = await supabase
                    .from('utenti')
                    .select('nome, cognome, first_name, last_name')
                    .eq('id', r.parent_id)
                    .single();

                const { data: student } = await supabase
                    .from('alunni')
                    .select('nome, cognome')
                    .eq('id', r.student_id)
                    .single();

                return {
                    ...r,
                    parent_name: parent ? `${parent.first_name || parent.nome} ${parent.last_name || parent.cognome}` : '?',
                    student_name: student ? `${student.nome} ${student.cognome}` : '?',
                };
            })
        );

        return NextResponse.json(enriched);
    } catch (error) {
        console.error('Errore API GET risposte:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/avvisi/[id]/risposte
// Body: { parent_id, student_id, risposta? }
// Registra presa visione o adesione
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { id: avvisoId } = await params;
        const body = await request.json();
        const { parent_id, student_id, risposta } = body;

        if (!parent_id || !student_id) {
            return NextResponse.json(
                { error: 'parent_id e student_id sono obbligatori' },
                { status: 400 }
            );
        }

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

        const insertPayload: any = {
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
            console.error('Errore POST risposte:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data);
    } catch (error) {
        console.error('Errore API POST risposte:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
