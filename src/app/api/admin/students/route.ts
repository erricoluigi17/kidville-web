import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server-client';
import { createClient } from '@supabase/supabase-js';

// ============================================================
// POST /api/admin/students — Creazione nuovo alunno
// Body: { nome, cognome, sesso, data_nascita, comune_nascita, provincia_nascita, ... }
// ============================================================
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createServerClient();

        // Campi obbligatori
        const { nome, cognome, data_nascita } = body;
        if (!nome || !cognome || !data_nascita) {
            return NextResponse.json({ error: 'Nome, cognome e data di nascita sono obbligatori' }, { status: 400 });
        }

        // Mappa i campi del form ai nomi effettivi delle colonne DB
        // scuola_id: usa il valore dal body se presente, altrimenti default della scuola principale
        const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111';

        const record: Record<string, unknown> = {
            scuola_id: body.scuola_id || SCUOLA_ID_DEFAULT,
            nome,
            cognome,
            data_nascita,
            gender: body.sesso || null,
            codice_fiscale: body.codice_fiscale || null,
            birth_city: body.comune_nascita || null,
            birth_province: body.provincia_nascita || null,
            residence_address: body.indirizzo_residenza || null,
            residence_city: body.comune_residenza || null,
            zip_code: body.cap || null,
            allergies: body.allergies || null,
            allergeni: Array.isArray(body.allergeni) ? body.allergeni : [],
            is_bes_dsa: body.is_bes_dsa || false,
            note_mediche: body.note_bes || null,
            invoice_holder_type: body.invoice_holder_type || null,
            invoice_holder_details: body.invoice_holder_details || null,
            stato: 'iscritto',
        };

        const { data, error } = await supabase
            .from('alunni')
            .insert(record)
            .select()
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 201 });
    } catch (err: any) {
        console.error('Errore POST /api/admin/students:', err);
        return NextResponse.json({ error: err.message || 'Errore interno del server' }, { status: 500 });
    }
}

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

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        let query = supabase
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
        const supabase = await createServerClient();

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
            try {
                const updates: Record<string, unknown> = {};
                // Raccogliamo le modifiche
                const allowedFields = ['classe_sezione', 'stato', 'note_mediche', 'bes', 'note_bes', 'nome', 'cognome', 'data_nascita', 'codice_fiscale', 'gender', 'citizenship', 'birth_nation', 'birth_province', 'birth_city', 'residence_address', 'residence_city', 'zip_code', 'allergies', 'allergeni', 'invoice_holder_type', 'invoice_holder_details', 'is_bes_dsa', 'section_id',
                    // Dati economici (modulo Pagamenti)
                    'importo_retta_mensile', 'genitori_separati', 'retta_split_config', 'intestatario_fatture'];
                
                for (const field of allowedFields) {
                    if (body[field] !== undefined) updates[field] = body[field];
                }

                if (Object.keys(updates).length === 0) {
                    return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 });
                }

                const { data, error } = await supabase
                    .from('alunni')
                    .update(updates)
                    .eq('id', body.id)
                    .select()
                    .single();

                if (error) throw new Error(error.message);
                return NextResponse.json(data);
            } catch (err: any) {
                return NextResponse.json({ error: err.message || 'Errore durante il salvataggio alunno' }, { status: 500 });
            }
        }

        return NextResponse.json({ error: 'Specificare id o ids[]' }, { status: 400 });
    } catch (err: any) {
        console.error('Errore PATCH /api/admin/students:', err);
        return NextResponse.json({ error: err.message || 'Errore interno del server' }, { status: 500 });
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

        const supabase = await createServerClient();

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
