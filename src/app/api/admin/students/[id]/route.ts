import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/security/require-env';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope } from '@/lib/auth/scope';
import { parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// GET /api/admin/students/[id]
// Restituisce il singolo alunno + i suoi genitori + i fratelli (alunni che condividono almeno un genitore)
export const GET = withRoute('admin/students/[id]:GET', async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
) => {
    try {
        // Fascicolo completo dell'alunno (PII + genitori + CF + fratelli): riservato
        // allo staff. Gap del test 360° (esposizione anonima) chiuso qui.
        const auth = await requireStaff(request);
        if (auth.response) return auth.response;

        const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
        if (missingEnv) return missingEnv;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (!supabaseKey) {
            return NextResponse.json(
                { error: 'configurazione mancante: SUPABASE_SERVICE_ROLE_KEY' },
                { status: 503 }
            );
        }
        const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, supabaseKey);

        // Param dinamico: id alunno, usato come uuid nelle query (M3).
        const { id } = await context.params;
        const parsedId = parseData(zUuid, id);
        if ('response' in parsedId) return parsedId.response;
        const studentId = parsedId.data;

        // Isolamento per sede, PRIMA di leggere il fascicolo. Il gate di ruolo
        // c'era (chiuso in M9 l'accesso anonimo), lo scope no: qualunque
        // segreteria, conoscendo l'uuid, otteneva `select *` dell'alunno — codice
        // fiscale e note mediche comprese — più `parents (*)` (CF, numero e
        // percorso del documento d'identità, indirizzo, telefoni) e
        // `delegates (*)` (numero di documento di chi ritira) di un minore di
        // un'altra sede. È l'insieme di PII più ampio esposto da una sola route.
        const fuoriScope = await assertAlunnoInScope(supabaseAdmin, auth.user, studentId);
        if (fuoriScope) return fuoriScope;

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
            .maybeSingle();

        if (studentError || !student) {
            return NextResponse.json({ error: studentError?.message || 'Alunno non trovato' }, { status: 404 });
        }

        // 2. Trova i fratelli: altri alunni che condividono almeno uno dei genitori
        // Raccogliamo gli ID dei genitori di questo alunno
        const parentIds = ((student.student_parents ?? []) as Array<{ parents: { id: string } | null }>)
            .map((sp) => sp.parents?.id)
            .filter(Boolean);

        type SiblingRow = {
            id: string;
            nome: string | null;
            cognome: string | null;
            data_nascita: string | null;
            classe_sezione: string | null;
            stato: string | null;
        };
        let siblings: SiblingRow[] = [];

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
                siblings = (siblingsData as unknown as Array<{ alunni: SiblingRow | null }>)
                    .map((sp) => sp.alunni)
                    .filter((s): s is SiblingRow => {
                        if (!s || seen.has(s.id)) return false;
                        seen.add(s.id);
                        return true;
                    });
            }
        }

        return NextResponse.json({ ...student, siblings });

    } catch (err) {
        logErrore({ operazione: 'admin/students/[id]:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
