import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';

// GET /api/notes?alunnoId=xxx
// Recupera le note disciplinari di un alunno
export async function GET(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const { searchParams } = new URL(request.url);
        const alunnoId = searchParams.get('alunnoId');

        const supabase = await createAdminClient();

        let query = supabase
            .from('note_disciplinari')
            .select(`
                id,
                alunno_id,
                maestra_id,
                categoria,
                testo,
                richiede_firma,
                firmata_il,
                firmata_da,
                creato_il,
                alunni ( nome, cognome, classe_sezione )
            `)
            .order('creato_il', { ascending: false });

        if (alunnoId) {
            query = query.eq('alunno_id', alunnoId);
        }

        const { data, error } = await query;

        if (error) {
            console.error('Errore GET note_disciplinari:', error);
            return NextResponse.json({ error: 'Errore nel recupero delle note', details: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error('Errore API GET Note:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// POST /api/notes
// Body: { alunnoIds: string[], categoria, testo, richiedeFirma }
export async function POST(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const body = await request.json();
        const { alunnoIds, categoria, testo, richiedeFirma } = body;

        if (!alunnoIds || !Array.isArray(alunnoIds) || alunnoIds.length === 0) {
            return NextResponse.json({ error: 'alunnoIds è obbligatorio e non può essere vuoto' }, { status: 400 });
        }

        if (!categoria || !testo) {
            return NextResponse.json({ error: 'categoria e testo sono obbligatori' }, { status: 400 });
        }

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

        // L'autore della nota è l'utente del gate (identità risolta server-side).
        const maestraId = auth.user.id;

        // Crea una nota per ogni alunno selezionato
        const noteRows = alunnoIds.map((alunnoId: string) => ({
            alunno_id: alunnoId,
            maestra_id: maestraId,
            categoria,
            testo,
            richiede_firma: richiedeFirma ?? false,
        }));

        const { data, error: dbError } = await supabase
            .from('note_disciplinari')
            .insert(noteRows)
            .select(`
                id,
                alunno_id,
                maestra_id,
                categoria,
                testo,
                richiede_firma,
                firmata_il,
                creato_il,
                alunni ( nome, cognome, classe_sezione )
            `);

        if (dbError) {
            console.error('Errore INSERT note_disciplinari:', dbError);
            return NextResponse.json({ error: 'Errore nel salvataggio della nota', details: dbError.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data, count: data?.length ?? 0 });

    } catch (error) {
        console.error('Errore API POST Note:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
