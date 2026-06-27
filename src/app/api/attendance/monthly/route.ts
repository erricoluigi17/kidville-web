import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';

export interface MonthlyAttendanceRecord {
    student_id: string;
    student_nome: string;
    student_cognome: string;
    section_name: string | null;
    date: string; // YYYY-MM-DD
    stato: 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
    orario_entrata: string | null;
    orario_uscita: string | null;
}

/**
 * GET /api/attendance/monthly?year=2026&month=5&sezione=Girasoli
 *
 * Strategia: due query separate (no join PostgREST) per massima compatibilità
 * con lo schema anche senza FK riconosciuta dalla schema cache.
 */
export async function GET(request: NextRequest) {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const { searchParams } = new URL(request.url);

        const now = new Date();
        const year  = parseInt(searchParams.get('year')  ?? String(now.getFullYear()), 10);
        const month = parseInt(searchParams.get('month') ?? String(now.getMonth() + 1), 10);
        const sezione = searchParams.get('sezione') ?? 'Girasoli';

        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
            return NextResponse.json({ error: 'Parametri year/month non validi.' }, { status: 400 });
        }

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay   = new Date(year, month, 0).getDate();
        const endDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const supabase = await createAdminClient();

        // ── Query 1: alunni della sezione ──────────────────────────────────────
        const { data: alunniData, error: alunniError } = await supabase
            .from('alunni')
            .select('id, nome, cognome, classe_sezione')
            .eq('classe_sezione', sezione);

        if (alunniError) {
            console.error('[/api/attendance/monthly] Errore alunni:', JSON.stringify(alunniError));
            return NextResponse.json(
                { error: 'Errore recupero alunni.', details: alunniError.message },
                { status: 500 }
            );
        }

        if (!alunniData || alunniData.length === 0) {
            return NextResponse.json([], { status: 200, headers: { 'Cache-Control': 'no-store' } });
        }

        const alunniIds = alunniData.map(a => a.id);
        const alunniMap: Record<string, { nome: string; cognome: string; classe_sezione: string | null }> = {};
        alunniData.forEach(a => { alunniMap[a.id] = a; });

        // ── Query 2: presenze del mese per questi alunni ───────────────────────
        const { data: presenzeData, error: presenzeError } = await supabase
            .from('presenze')
            .select('id, alunno_id, data, stato, orario_entrata, orario_uscita')
            .in('alunno_id', alunniIds)
            .gte('data', startDate)
            .lte('data', endDate)
            .order('data', { ascending: true });

        if (presenzeError) {
            console.error('[/api/attendance/monthly] Errore presenze:', JSON.stringify(presenzeError));
            return NextResponse.json(
                { error: 'Errore recupero presenze.', details: presenzeError.message },
                { status: 500 }
            );
        }

        // ── Join manuale ───────────────────────────────────────────────────────
        const records: MonthlyAttendanceRecord[] = (presenzeData ?? []).map(row => {
            const alunno = alunniMap[row.alunno_id];
            return {
                student_id:       row.alunno_id,
                student_nome:     alunno?.nome     ?? '—',
                student_cognome:  alunno?.cognome  ?? '—',
                section_name:     alunno?.classe_sezione ?? null,
                date:             row.data,
                stato:            row.stato as MonthlyAttendanceRecord['stato'],
                orario_entrata:   row.orario_entrata,
                orario_uscita:    row.orario_uscita,
            };
        });

        return NextResponse.json(records, {
            status: 200,
            headers: { 'Cache-Control': 'no-store' },
        });

    } catch (err) {
        console.error('[/api/attendance/monthly] Unexpected:', err);
        return NextResponse.json({ error: 'Errore interno del server.' }, { status: 500 });
    }
}
