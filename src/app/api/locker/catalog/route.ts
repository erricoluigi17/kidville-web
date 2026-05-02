import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// ============================================================
// GET /api/locker/catalog — Lista catalogo materiali per sede
// Query: ?scuola_id=<id>
// ============================================================
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const scuolaId = searchParams.get('scuola_id');

        if (!scuolaId) {
            return NextResponse.json(
                { error: 'Parametro scuola_id obbligatorio' },
                { status: 400 }
            );
        }

        const supabase = await createClient();

        const { data, error } = await supabase
            .from('locker_catalog')
            .select('*')
            .eq('scuola_id', scuolaId)
            .eq('attivo', true)
            .order('ordinamento', { ascending: true });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data);
    } catch (err) {
        console.error('Errore GET /api/locker/catalog:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// POST /api/locker/catalog — Aggiunge materiale al catalogo
// Body: { scuola_id, nome, icona?, unita?, soglia_gialla?, soglia_rossa? }
// ============================================================
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { scuola_id, nome, icona, unita, soglia_gialla, soglia_rossa } = body;

        if (!scuola_id || !nome) {
            return NextResponse.json(
                { error: 'Campi obbligatori: scuola_id, nome' },
                { status: 400 }
            );
        }

        const supabase = await createClient();

        const { data, error } = await supabase
            .from('locker_catalog')
            .insert({
                scuola_id,
                nome,
                icona: icona ?? '📦',
                unita: unita ?? 'pz',
                soglia_gialla: soglia_gialla ?? 5,
                soglia_rossa: soglia_rossa ?? 2,
            })
            .select()
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 201 });
    } catch (err) {
        console.error('Errore POST /api/locker/catalog:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
