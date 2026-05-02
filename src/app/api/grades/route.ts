import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { alunnoId, materia, tipo, votoNumerico, giudizioTesto } = body;

        if (!alunnoId || !materia || (!votoNumerico && !giudizioTesto)) {
            return NextResponse.json({ error: 'Dati incompleti' }, { status: 400 });
        }

        const supabase = await createClient();

        // Controllo auth
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 });
        }

        // Inseriamo il voto. 'pubblicato' è false di default (nel DB).
        // Il buffer notifica sarà gestito tramite job asincrono su Supabase
        const { data, error: dbError } = await supabase
            .from('valutazioni')
            .insert({
                alunno_id: alunnoId,
                maestra_id: user.id, // Id del docente loggato
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
