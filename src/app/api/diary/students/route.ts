import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// GET /api/diary/students?sezione=Girasoli   → lista classe
// GET /api/diary/students?id=uuid            → singolo alunno
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

    const sezione = params.get('sezione') ?? 'Girasoli';
    const { data, error } = await supabase
        .from('alunni')
        .select('id, nome, cognome, note_mediche, classe_sezione')
        .eq('classe_sezione', sezione)
        .order('cognome');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
}
