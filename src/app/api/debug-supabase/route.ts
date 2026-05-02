import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

export async function GET() {
    const supabase = await createClient();

    // Prova query diretta senza filtri
    const { data: alunni, error: aErr } = await supabase.from('alunni').select('*').limit(5);
    const { data: utenti, error: uErr } = await supabase.from('utenti').select('*').limit(5);
    const { data: schools, error: sErr } = await supabase.from('schools').select('*').limit(5);
    const { data: eventi, error: eErr } = await supabase.from('eventi_diario').select('*').limit(5);

    return NextResponse.json({
        alunni: { count: alunni?.length ?? 0, error: aErr?.message },
        utenti: { count: utenti?.length ?? 0, error: uErr?.message },
        schools: { count: schools?.length ?? 0, error: sErr?.message },
        eventi_diario: { count: eventi?.length ?? 0, error: eErr?.message },
    });
}
