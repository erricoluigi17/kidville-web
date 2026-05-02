import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// GET /api/diary/entries?sezione=Girasoli&date=2026-05-03
export async function GET(request: NextRequest) {
    const sezione = request.nextUrl.searchParams.get('sezione') ?? 'Girasoli';
    const date = request.nextUrl.searchParams.get('date') ?? new Date().toISOString().split('T')[0];
    const supabase = await createClient();

    // Prendi gli ID degli alunni della sezione
    const { data: alunni } = await supabase
        .from('alunni')
        .select('id')
        .eq('classe_sezione', sezione);

    if (!alunni || alunni.length === 0) {
        return NextResponse.json([]);
    }

    const ids = alunni.map(a => a.id);
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    const { data, error } = await supabase
        .from('eventi_diario')
        .select('*')
        .in('alunno_id', ids)
        .gte('orario_inizio', startOfDay)
        .lte('orario_inizio', endOfDay)
        .order('orario_inizio', { ascending: false });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}

// POST /api/diary/entries — salva (upsert) eventi diario
// Per ogni alunno+tipo_evento: se già esiste oggi → UPDATE, altrimenti → INSERT
export async function POST(request: NextRequest) {
    const body = await request.json();
    const supabase = await createClient();

    const entries = Array.isArray(body) ? body : [body];
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    const results = [];
    const errors = [];

    for (const entry of entries) {
        // Cerca se esiste già un evento per questo alunno+tipo oggi
        const { data: existing } = await supabase
            .from('eventi_diario')
            .select('id')
            .eq('alunno_id', entry.alunno_id)
            .eq('tipo_evento', entry.tipo_evento)
            .gte('orario_inizio', startOfDay)
            .lte('orario_inizio', endOfDay)
            .order('orario_inizio', { ascending: false })
            .limit(1);

        if (existing && existing.length > 0) {
            // UPDATE
            const { data, error } = await supabase
                .from('eventi_diario')
                .update({
                    dettagli: entry.dettagli ?? null,
                    orario_fine: entry.orario_fine ?? null,
                    nota_libera: entry.nota_libera ?? null,
                })
                .eq('id', existing[0].id)
                .select();

            if (error) errors.push({ alunno_id: entry.alunno_id, error: error.message });
            else if (data) results.push(...data);
        } else {
            // INSERT
            const { data, error } = await supabase
                .from('eventi_diario')
                .insert({
                    alunno_id: entry.alunno_id,
                    maestra_id: entry.maestra_id ?? '22222222-2222-2222-2222-222222222222',
                    tipo_evento: entry.tipo_evento,
                    orario_inizio: entry.orario_inizio ?? new Date().toISOString(),
                    orario_fine: entry.orario_fine ?? null,
                    dettagli: entry.dettagli ?? null,
                    nota_libera: entry.nota_libera ?? null,
                    pubblicato: false,
                })
                .select();

            if (error) errors.push({ alunno_id: entry.alunno_id, error: error.message });
            else if (data) results.push(...data);
        }
    }

    if (errors.length > 0) {
        return NextResponse.json({ saved: results, errors }, { status: 207 });
    }

    return NextResponse.json(results);
}
