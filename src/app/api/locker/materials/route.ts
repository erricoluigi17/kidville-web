import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

/**
 * GET /api/locker/materials?classe_sezione=Girasoli
 * Ritorna i materiali configurati per la classe.
 * Se la tabella non esiste ancora, ritorna i materiali di default.
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const classeSezione = searchParams.get('classe_sezione') ?? null;

    try {
        const supabase = await createClient();
        let q = supabase
            .from('locker_config')
            .select('*')
            .eq('attivo', true)
            .order('ordine', { ascending: true });

        if (classeSezione) q = q.eq('classe_sezione', classeSezione);

        const { data, error } = await q;

        if (error) {
            // Tabella non ancora creata → ritorna i default
            console.warn('locker_config non trovata, uso default:', error.message);
            return NextResponse.json(MATERIALI_DEFAULT);
        }

        return NextResponse.json(data && data.length > 0 ? data : MATERIALI_DEFAULT);
    } catch {
        return NextResponse.json(MATERIALI_DEFAULT);
    }
}

/**
 * POST /api/locker/materials
 * Crea o aggiorna un materiale nella configurazione.
 * Body: { classe_sezione, nome, icona?, unita?, livello_allerta?, livello_emergenza?, ordine? }
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();

        const payload = {
            classe_sezione:    body.classe_sezione ?? null,
            nome:              body.nome,
            icona:             body.icona ?? '📦',
            unita:             body.unita ?? 'pz',
            livello_allerta:   body.livello_allerta ?? 5,
            livello_emergenza: body.livello_emergenza ?? 2,
            ordine:            body.ordine ?? 99,
            attivo:            body.attivo ?? true,
        };

        let result;
        if (body.id) {
            const { data, error } = await supabase
                .from('locker_config').update(payload).eq('id', body.id).select().single();
            if (error) throw error;
            result = data;
        } else {
            const { data, error } = await supabase
                .from('locker_config').insert(payload).select().single();
            if (error) throw error;
            result = data;
        }

        return NextResponse.json({ success: true, data: result });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * PATCH /api/locker/materials — toggle attivo o aggiorna ordine
 * Body: { id, attivo? | ordine? }
 */
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();
        const { id, ...updates } = body;
        const { data, error } = await supabase
            .from('locker_config').update(updates).eq('id', id).select().single();
        if (error) throw error;
        return NextResponse.json({ success: true, data });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * DELETE /api/locker/materials?id=xxx
 */
export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        if (!id) return NextResponse.json({ error: 'id mancante' }, { status: 400 });

        const supabase = await createClient();
        const { error } = await supabase.from('locker_config').delete().eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── Default fallback ──────────────────────────────────────────────────────────
export const MATERIALI_DEFAULT = [
    { id: 'default-1', nome: 'Pannolini', icona: '🧷', unita: 'pz', livello_allerta: 5, livello_emergenza: 2, ordine: 1, attivo: true },
    { id: 'default-2', nome: 'Salviette', icona: '🧻', unita: 'pz', livello_allerta: 4, livello_emergenza: 2, ordine: 2, attivo: true },
    { id: 'default-3', nome: 'Crema',     icona: '🧴', unita: 'pz', livello_allerta: 3, livello_emergenza: 1, ordine: 3, attivo: true },
    { id: 'default-4', nome: 'Cambio',    icona: '👕', unita: 'pz', livello_allerta: 2, livello_emergenza: 1, ordine: 4, attivo: true },
];
