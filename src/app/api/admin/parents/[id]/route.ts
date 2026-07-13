import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseData } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Unico input: il param dinamico [id], usato come uuid su parents.id.

export const GET = withRoute('admin/parents/[id]:GET', async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
) => {
    try {
        // Gap auth segnalato in M3, chiuso in M9: fascicolo completo del
        // genitore (PII + figli + co-genitori) riservato allo staff.
        const auth = await requireStaff(request);
        if (auth.response) return auth.response;

        const { id: rawId } = await context.params;
        const idParsed = parseData(zUuid, rawId);
        if ('response' in idParsed) return idParsed.response;
        const id = idParsed.data;
        // Service-role come tutte le altre route admin (list/PATCH): il gate è
        // applicativo (requireStaff). La tabella `parents` ha RLS abilitata SENZA
        // policy → il client con RLS (createClient) tornava sempre vuoto qui,
        // causando il "campi genitore vuoti alla riapertura".
        const supabase = await createAdminClient();

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
        logErrore({ operazione: 'admin/parents/[id]:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
