import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/admin/students/[id]
// Restituisce il singolo alunno + i suoi genitori + i fratelli (alunni che condividono almeno un genitore)
export async function GET(
    _request: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: studentId } = await context.params;

        // 1. Recupera l'alunno con i suoi genitori
        const { data: student, error: studentError } = await supabaseAdmin
            .from('alunni')
            .select(`
                *,
                student_parents (
                    relation_type,
                    is_primary,
                    parents (*)
                ),
                delegates (*)
            `)
            .eq('id', studentId)
            .single();

        if (studentError || !student) {
            return NextResponse.json({ error: studentError?.message || 'Alunno non trovato' }, { status: 404 });
        }

        // 2. Trova i fratelli: altri alunni che condividono almeno uno dei genitori
        // Raccogliamo gli ID dei genitori di questo alunno
        const parentIds = (student.student_parents || [])
            .map((sp: any) => sp.parents?.id)
            .filter(Boolean);

        let siblings: any[] = [];

        if (parentIds.length > 0) {
            // Query: trova tutti gli alunni che hanno almeno uno di questi genitori, escludendo l'alunno corrente
            const { data: siblingsData } = await supabaseAdmin
                .from('student_parents')
                .select(`
                    student_id,
                    alunni (
                        id,
                        nome,
                        cognome,
                        data_nascita,
                        classe_sezione,
                        stato
                    )
                `)
                .in('parent_id', parentIds)
                .neq('student_id', studentId);

            // Deduplication: un alunno potrebbe apparire due volte se condivide entrambi i genitori
            if (siblingsData) {
                const seen = new Set<string>();
                siblings = siblingsData
                    .map((sp: any) => sp.alunni)
                    .filter((s: any) => {
                        if (!s || seen.has(s.id)) return false;
                        seen.add(s.id);
                        return true;
                    });
            }
        }

        return NextResponse.json({ ...student, siblings });

    } catch (err: any) {
        console.error('Errore GET /api/admin/students/[id]:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
