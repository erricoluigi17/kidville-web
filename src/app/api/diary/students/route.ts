import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// GET /api/diary/students?sezione=Girasoli
export async function GET(request: NextRequest) {
    const sezione = request.nextUrl.searchParams.get('sezione') ?? 'Girasoli';
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('alunni')
        .select('id, nome, cognome, note_mediche, classe_sezione')
        .eq('classe_sezione', sezione)
        .order('cognome');

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}
