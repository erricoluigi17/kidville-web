import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server-client';

// ============================================================
// GET /api/admin/students — Lista alunni con filtri
// Query: ?scuola_id=, ?classe_sezione=, ?stato=
// ============================================================
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const scuolaId = searchParams.get('scuola_id');
        const classeSezione = searchParams.get('classe_sezione');
        const stato = searchParams.get('stato');

        const supabase = await createClient();

        let query = supabase
            .from('alunni')
            .select('*')
            .order('cognome', { ascending: true });

        if (scuolaId) query = query.eq('scuola_id', scuolaId);
        if (classeSezione) query = query.eq('classe_sezione', classeSezione);
        if (stato) query = query.eq('stato', stato);

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data);
    } catch (err) {
        console.error('Errore GET /api/admin/students:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// PATCH /api/admin/students — Bulk assign o aggiornamento singolo
// Body singolo:  { id, classe_sezione?, stato?, note_mediche?, bes?, note_bes? }
// Body bulk:     { ids: [<id>,...], classe_sezione }
// ============================================================
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createClient();

        // Bulk assign
        if (body.ids && Array.isArray(body.ids) && body.classe_sezione) {
            const { data, error } = await supabase
                .from('alunni')
                .update({ classe_sezione: body.classe_sezione })
                .in('id', body.ids)
                .select();

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Aggiornamento singolo
        if (body.id) {
            const updates: Record<string, unknown> = {};
            if (body.classe_sezione !== undefined) updates.classe_sezione = body.classe_sezione;
            if (body.stato !== undefined) updates.stato = body.stato;
            if (body.note_mediche !== undefined) updates.note_mediche = body.note_mediche;
            if (body.bes !== undefined) updates.bes = body.bes;
            if (body.note_bes !== undefined) updates.note_bes = body.note_bes;
            if (body.nome !== undefined) updates.nome = body.nome;
            if (body.cognome !== undefined) updates.cognome = body.cognome;
            if (body.data_nascita !== undefined) updates.data_nascita = body.data_nascita;
            if (body.codice_fiscale !== undefined) updates.codice_fiscale = body.codice_fiscale;

            if (Object.keys(updates).length === 0) {
                return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 });
            }

            const { data, error } = await supabase
                .from('alunni')
                .update(updates)
                .eq('id', body.id)
                .select()
                .single();

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json(data);
        }

        return NextResponse.json({ error: 'Specificare id o ids[]' }, { status: 400 });
    } catch (err) {
        console.error('Errore PATCH /api/admin/students:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// DELETE /api/admin/students — Hard Delete GDPR
// Body: { id }
// ============================================================
export async function DELETE(request: NextRequest) {
    try {
        const body = await request.json();
        const { id } = body;

        if (!id) {
            return NextResponse.json({ error: 'Campo id obbligatorio' }, { status: 400 });
        }

        const supabase = await createClient();

        // Log audit prima della cancellazione
        const { data: alunno } = await supabase
            .from('alunni')
            .select('*')
            .eq('id', id)
            .single();

        if (!alunno) {
            return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 });
        }

        // Registra nel log modifiche (audit trail GDPR)
        await supabase.from('registro_modifiche').insert({
            azione: 'hard_delete_gdpr',
            tabella_interessata: 'alunni',
            record_id: id,
            vecchio_valore: alunno,
            nuovo_valore: null,
        });

        // Cancellazione a cascata (FK con ON DELETE CASCADE su locker_inventory, daily_routines, ecc.)
        const { error } = await supabase
            .from('alunni')
            .delete()
            .eq('id', id);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json({ success: true, message: 'Alunno eliminato definitivamente (GDPR)' });
    } catch (err) {
        console.error('Errore DELETE /api/admin/students:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
