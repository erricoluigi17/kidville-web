import { NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';

// GET /api/register/lessons?classeSezione=3A&data=2026-05-13
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const classeSezione = searchParams.get('classeSezione');
        const data = searchParams.get('data');

        if (!classeSezione || !data) {
            return NextResponse.json({ error: 'classeSezione e data sono obbligatori' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        const { data: registroRows, error } = await supabase
            .from('registro_orario')
            .select(`
                id,
                ora_lezione,
                materia,
                argomento,
                compiti,
                data_consegna_compiti,
                media_url,
                firme_docenti (
                    id,
                    maestra_id,
                    tipo_compresenza,
                    firmato_il
                )
            `)
            .eq('classe_sezione', classeSezione)
            .eq('data', data)
            .order('ora_lezione', { ascending: true });

        if (error) {
            console.error('Errore GET registro_orario:', error);
            return NextResponse.json({ error: 'Errore nel recupero delle lezioni', details: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data: registroRows });

    } catch (error) {
        console.error('Errore API GET Lezioni:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/register/lessons
// Body: { classeSezione, scuolaId, data, oraLezione, materia, argomento, compiti, dataConsegnaCompiti }
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { classeSezione, scuolaId, data, oraLezione, materia, argomento, compiti, dataConsegnaCompiti } = body;

        if (!classeSezione || !data || !oraLezione || !materia) {
            return NextResponse.json({ error: 'classeSezione, data, oraLezione e materia sono obbligatori' }, { status: 400 });
        }

        // Admin client per bypassare RLS (stesso pattern delle altre API del progetto)
        const supabase = await createAdminClient();

        // Recupera l'utente dalla sessione se disponibile, altrimenti usa ID fallback per dev
        const sessionClient = await createClient();
        const { data: { user } } = await sessionClient.auth.getUser();
        const maestraId = user?.id ?? '00000000-0000-0000-0000-000000000001';

        // Recupera scuola_id se non fornito (prende il primo disponibile dal DB)
        let finalScuolaId = scuolaId;
        if (!finalScuolaId) {
            const { data: school } = await supabase
                .from('schools')
                .select('id')
                .limit(1)
                .single();
            finalScuolaId = school?.id;
        }

        // UPSERT su registro_orario
        const { data: registroRow, error: registroError } = await supabase
            .from('registro_orario')
            .upsert({
                scuola_id: finalScuolaId,
                classe_sezione: classeSezione,
                data,
                ora_lezione: oraLezione,
                materia,
                argomento: argomento || null,
                compiti: compiti || null,
                data_consegna_compiti: dataConsegnaCompiti || null,
            }, {
                onConflict: 'classe_sezione,data,ora_lezione',
            })
            .select()
            .single();

        if (registroError) {
            console.error('Errore UPSERT registro_orario:', registroError);
            return NextResponse.json({ error: 'Errore nel salvataggio della lezione', details: registroError.message }, { status: 500 });
        }

        // INSERT firma del docente (UPSERT per gestire duplicati)
        const { error: firmaError } = await supabase
            .from('firme_docenti')
            .upsert({
                registro_id: registroRow.id,
                maestra_id: maestraId,
                tipo_compresenza: 'principale',
            }, {
                onConflict: 'registro_id,maestra_id',
            });

        if (firmaError) {
            console.error('Errore INSERT firma_docente:', firmaError);
            // Non blocchiamo il flusso: il registro è già salvato
        }

        return NextResponse.json({ success: true, data: registroRow });

    } catch (error) {
        console.error('Errore API POST Lezioni:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
