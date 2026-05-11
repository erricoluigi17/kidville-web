import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// ============================================================
// GET /api/admin/sections — Lista sezioni con alunni e staff
// Query: ?scuola_id=
// ============================================================
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const scuolaId = searchParams.get('scuola_id');
        const supabase = await createClient();

        let query = supabase
            .from('sections')
            .select('*')
            .order('name', { ascending: true });

        if (scuolaId) query = query.eq('scuola_id', scuolaId);

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data || []);
    } catch (err: any) {
        console.error('Errore GET /api/admin/sections:', err);
        return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
    }
}

// ============================================================
// POST /api/admin/sections — Crea nuova sezione
// Body: { name, school_type, scuola_id }
// ============================================================
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();

        const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111';

        const { name, school_type, scuola_id } = body;
        if (!name) {
            return NextResponse.json({ error: 'Il nome della sezione è obbligatorio' }, { status: 400 });
        }

        const { data, error } = await supabase
            .from('sections')
            .insert({
                name,
                school_type: school_type || 'infanzia',
                scuola_id: scuola_id || SCUOLA_ID_DEFAULT,
            })
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json(data, { status: 201 });
    } catch (err: any) {
        console.error('Errore POST /api/admin/sections:', err);
        return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
    }
}

// ============================================================
// PATCH /api/admin/sections — Aggiorna sezione
// Body: { id, name?, school_type?, scuola_id? }
// ============================================================
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();

        const { id, ...updates } = body;
        if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 });

        const { data, error } = await supabase
            .from('sections')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json(data);
    } catch (err: any) {
        console.error('Errore PATCH /api/admin/sections:', err);
        return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 });
    }
}
