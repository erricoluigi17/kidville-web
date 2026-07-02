import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

// GET /api/diary/checkin?alunno_id=xxx&date=YYYY-MM-DD
// "Entrata" del Diario 0-6 (DL-040): orario di check-in letto dal modulo Presenze
// (read-only, niente evento eventi_diario duplicato). Service-role + lettura
// scoped per alunno/data. (Scoping di proprietà → S13, come il resto del Diario.)
export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const alunnoId = params.get('alunno_id');
    const date = params.get('date') ?? new Date().toISOString().split('T')[0];
    if (!alunnoId) return NextResponse.json({ error: 'alunno_id obbligatorio' }, { status: 400 });

    const admin = await createAdminClient();
    const { data, error } = await admin
        .from('presenze')
        .select('orario_entrata, stato')
        .eq('alunno_id', alunnoId)
        .eq('data', date)
        .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Solo se il bambino risulta presente (presente/ritardo/uscita anticipata) e c'è un orario.
    const presente = ['presente', 'ritardo', 'uscita_anticipata'].includes((data?.stato as string) ?? '');
    return NextResponse.json({
        orario_entrata: presente ? (data?.orario_entrata ?? null) : null,
        stato: data?.stato ?? null,
    });
}
