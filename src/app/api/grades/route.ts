// ⛔ DEPRECATO — API voti "legacy" (voto_numerico, scala Base/Intermedio/Avanzato),
// NON conforme O.M. 3/2025. Usato solo dal GradesTab legacy (pagina /teacher/register
// ora reindirizza a /teacher/primaria). La valutazione conforme passa da
// /api/primaria/valutazioni e /api/primaria/prospetto. Conservato come storico.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';

// GET /api/grades?alunnoId=xxx&materia=Italiano
// Recupera i voti di un alunno (opzionalmente filtrati per materia)
export async function GET(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const { searchParams } = new URL(request.url);
        const alunnoId = searchParams.get('alunnoId');
        const materia = searchParams.get('materia');

        const supabase = await createAdminClient();

        let query = supabase
            .from('valutazioni')
            .select(`
                id,
                alunno_id,
                materia,
                tipo,
                voto_numerico,
                giudizio_testo,
                pubblicato,
                creato_il,
                alunni ( nome, cognome )
            `)
            .order('creato_il', { ascending: false });

        if (alunnoId) {
            query = query.eq('alunno_id', alunnoId);
        }
        if (materia) {
            query = query.eq('materia', materia);
        }

        const { data, error } = await query;

        if (error) {
            console.error('Errore GET valutazioni:', error);
            return NextResponse.json({ error: 'Errore nel recupero delle valutazioni' }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error('Errore API GET Grades:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const body = await request.json();
        const { alunnoId, materia, tipo, votoNumerico, giudizioTesto } = body;

        if (!alunnoId || !materia || (!votoNumerico && !giudizioTesto)) {
            return NextResponse.json({ error: 'Dati incompleti' }, { status: 400 });
        }

        // Admin client per bypassare RLS
        const supabase = await createAdminClient();

        // L'autore/valutatore è l'utente del gate (identità risolta server-side).
        const maestraId = auth.user.id;

        // Inseriamo il voto. 'pubblicato' è false di default (nel DB).
        // Il buffer notifica sarà gestito tramite job asincrono su Supabase
        const { data, error: dbError } = await supabase
            .from('valutazioni')
            .insert({
                alunno_id: alunnoId,
                maestra_id: maestraId,
                materia,
                tipo,
                voto_numerico: votoNumerico,
                giudizio_testo: giudizioTesto,
                pubblicato: false 
            })
            .select()
            .single();

        if (dbError) {
            console.error('Errore inserimento voto:', dbError);
            return NextResponse.json({ error: 'Errore nel salvataggio della valutazione' }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error('Errore API Grades:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
