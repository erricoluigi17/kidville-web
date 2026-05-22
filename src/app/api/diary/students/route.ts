import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// GET /api/diary/students?sezione=Girasoli                    → lista classe (tutti)
// GET /api/diary/students?sezione=Girasoli&onlyPresent=true   → solo presenti oggi
// GET /api/diary/students?classeSezione=3A&onlyPresent=true&date=2026-05-17
// GET /api/diary/students?id=uuid                             → singolo alunno
export async function GET(request: NextRequest) {
    const supabase = await createClient();
    const params = request.nextUrl.searchParams;

    const id = params.get('id');
    if (id) {
        const { data, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, note_mediche, classe_sezione')
            .eq('id', id)
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json(data);
    }

    // Supporta sia "sezione" (Girasoli) che "classeSezione" (3A)
    const sezione = params.get('sezione') ?? params.get('classeSezione') ?? 'Girasoli';
    const onlyPresent = params.get('onlyPresent') === 'true';
    const date = params.get('date') ?? new Date().toISOString().split('T')[0];

    const { data: alunni, error } = await supabase
        .from('alunni')
        .select('id, nome, cognome, note_mediche, classe_sezione')
        .eq('classe_sezione', sezione)
        .order('cognome');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Se richiesto, filtra solo gli alunni presenti quel giorno
    if (onlyPresent && alunni && alunni.length > 0) {
        const alunnoIds = alunni.map(a => a.id);

        const { data: presenze, error: prezError } = await supabase
            .from('presenze')
            .select('alunno_id, stato')
            .eq('data', date)
            .in('alunno_id', alunnoIds)
            .in('stato', ['presente', 'ritardo', 'uscita_anticipata']);

        if (prezError) {
            console.error('[/api/diary/students] Errore presenze:', prezError.message);
            // Fallback: restituisci tutti gli alunni se la query presenze fallisce
            return NextResponse.json(alunni);
        }

        const presentIds = new Set((presenze ?? []).map(p => p.alunno_id));
        const filtered = alunni.filter(a => presentIds.has(a.id));
        return NextResponse.json(filtered);
    }

    return NextResponse.json(alunni);
}
