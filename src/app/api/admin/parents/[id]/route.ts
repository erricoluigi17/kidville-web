import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await context.params;
        const supabase = await createClient();

        // Recuperiamo il genitore con tutti i figli associati (alunni)
        // e per ogni figlio, recuperiamo tutti i genitori associati (student_parents -> parents)
        const { data, error } = await supabase
            .from('parents')
            .select(`
                *,
                student_parents (
                    relation_type,
                    is_primary,
                    alunni (
                        *,
                        student_parents (
                            relation_type,
                            is_primary,
                            parents (*)
                        )
                    )
                )
            `)
            .eq('id', id)
            .maybeSingle();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
        if (!data) {
            return NextResponse.json({ error: 'Genitore non trovato' }, { status: 404 });
        }

        return NextResponse.json(data);
    } catch (err) {
        console.error(`Errore GET /api/admin/parents/[id]:`, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
