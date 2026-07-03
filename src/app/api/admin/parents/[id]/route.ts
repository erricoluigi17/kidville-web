import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Unico input: il param dinamico [id], usato come uuid su parents.id.

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        // Gap auth segnalato in M3, chiuso in M9: fascicolo completo del
        // genitore (PII + figli + co-genitori) riservato allo staff.
        const auth = await requireStaff(request);
        if (auth.response) return auth.response;

        const { id: rawId } = await context.params;
        const idParsed = parseData(zUuid, rawId);
        if ('response' in idParsed) return idParsed.response;
        const id = idParsed.data;
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
