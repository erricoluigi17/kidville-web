import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';

// ============================================================
// Anagrafica alunni — gated Segreteria+Direzione (DL-036) + audit
// immutabile su ogni mutazione (DL-037, `logScrittura`/`audit_scritture_docente`).
// ============================================================

// ============================================================
// POST /api/admin/students — Creazione nuovo alunno
// ============================================================
export async function POST(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const body = await request.json();
        const supabase = await createAdminClient();

        // Campi obbligatori
        const { nome, cognome, data_nascita } = body;
        if (!nome || !cognome || !data_nascita) {
            return NextResponse.json({ error: 'Nome, cognome e data di nascita sono obbligatori' }, { status: 400 });
        }

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
            usa_pannolino: body.usa_pannolino ?? false,
            invoice_holder_type: body.invoice_holder_type || null,
            invoice_holder_details: body.invoice_holder_details || null,
            // classe/sezione: il trigger DB sincronizza automaticamente section_id.
            classe_sezione: body.classe_sezione || null,
            stato: 'iscritto',
        };

        let { data, error } = await supabase
            .from('alunni')
            .insert(record)
            .select()
            .single();

        // Resilienza pre-migration: se la colonna usa_pannolino non esiste ancora, riprova senza.
        if (error && (error as { code?: string }).code === '42703' && /usa_pannolino/.test(error.message)) {
            delete record.usa_pannolino;
            ({ data, error } = await supabase.from('alunni').insert(record).select().single());
        }

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: data?.id ?? null,
            azione: 'insert',
            scuolaId: (data?.scuola_id as string) ?? (record.scuola_id as string),
            sectionId: (data?.section_id as string) ?? null,
            valoreDopo: data,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (err) {
        console.error('Errore POST /api/admin/students:', err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// GET /api/admin/students — Lista alunni con filtri
// ============================================================
export async function GET(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const { searchParams } = new URL(request.url);
        const scuolaId = searchParams.get('scuola_id');
        const classeSezione = searchParams.get('classe_sezione');
        const stato = searchParams.get('stato');
        // Paginazione: limit clampato 1..1000 (default 200) + offset; shape array nudo invariata.
        const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 200) || 200, 1), 1000);
        const offset = Math.max(Number(searchParams.get('offset') ?? 0) || 0, 0);

        const supabase = await createAdminClient();

        let query = supabase
            .from('alunni')
            .select(`
                id, scuola_id, nome, cognome, data_nascita, codice_fiscale, classe_sezione, stato,
                note_mediche, consenso_privacy, creato_il, gender, citizenship, birth_nation,
                birth_province, birth_city, residence_address, residence_city, zip_code, allergies,
                invoice_holder_type, invoice_holder_details, is_bes_dsa, fiscal_code, section_id,
                documento_path, importo_retta_mensile, genitori_separati, retta_split_config,
                intestatario_fatture, allergeni, usa_pannolino, sospeso, sospeso_motivo, sospeso_il,
                sospeso_da, anonimizzato_il, gruppo_mensa_id, numero_domanda_sidi,
                student_parents (
                    relation_type,
                    is_primary,
                    parents (*)
                ),
                delegates (*)
            `)
            .order('cognome', { ascending: true })
            .range(offset, offset + limit - 1);

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
// ============================================================
export async function PATCH(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const body = await request.json();
        const supabase = await createAdminClient();

        // Bulk assign
        if (body.ids && Array.isArray(body.ids) && body.classe_sezione) {
            const { data, error } = await supabase
                .from('alunni')
                .update({ classe_sezione: body.classe_sezione })
                .in('id', body.ids)
                .select();

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            // Audit: una riga per alunno riassegnato (DL-037).
            for (const id of body.ids as string[]) {
                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: id,
                    azione: 'update',
                    valoreDopo: { classe_sezione: body.classe_sezione },
                });
            }
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Bulk assign gruppo mensa (P5.4, DL-050). `gruppo_mensa_id` può essere
        // null per rimuovere gli alunni dal gruppo.
        if (body.ids && Array.isArray(body.ids) && body.gruppo_mensa_id !== undefined) {
            const { data, error } = await supabase
                .from('alunni')
                .update({ gruppo_mensa_id: body.gruppo_mensa_id })
                .in('id', body.ids)
                .select();
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            for (const id of body.ids as string[]) {
                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: id,
                    azione: 'update',
                    valoreDopo: { gruppo_mensa_id: body.gruppo_mensa_id },
                });
            }
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Aggiornamento singolo
        if (body.id) {
            try {
                const updates: Record<string, unknown> = {};
                const allowedFields = ['classe_sezione', 'stato', 'note_mediche', 'bes', 'note_bes', 'nome', 'cognome', 'data_nascita', 'codice_fiscale', 'gender', 'citizenship', 'birth_nation', 'birth_province', 'birth_city', 'residence_address', 'residence_city', 'zip_code', 'allergies', 'allergeni', 'invoice_holder_type', 'invoice_holder_details', 'is_bes_dsa', 'usa_pannolino', 'section_id',
                    'importo_retta_mensile', 'genitori_separati', 'retta_split_config', 'intestatario_fatture'];

                for (const field of allowedFields) {
                    if (body[field] !== undefined) updates[field] = body[field];
                }

                if (Object.keys(updates).length === 0) {
                    return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 });
                }

                // Stato precedente per l'audit (valore prima/dopo).
                const { data: prima } = await supabase.from('alunni').select('*').eq('id', body.id).maybeSingle();
                if (!prima) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 });

                let { data, error } = await supabase
                    .from('alunni')
                    .update(updates)
                    .eq('id', body.id)
                    .select()
                    .single();

                if (error && (error as { code?: string }).code === '42703' && /usa_pannolino/.test(error.message)) {
                    delete updates.usa_pannolino;
                    ({ data, error } = await supabase.from('alunni').update(updates).eq('id', body.id).select().single());
                }

                if (error) throw new Error(error.message);

                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: body.id,
                    azione: 'update',
                    scuolaId: (data?.scuola_id as string) ?? null,
                    sectionId: (data?.section_id as string) ?? null,
                    valorePrima: prima ?? null,
                    valoreDopo: updates,
                });

                return NextResponse.json(data);
            } catch (err) {
                return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore durante il salvataggio alunno' }, { status: 500 });
            }
        }

        return NextResponse.json({ error: 'Specificare id o ids[]' }, { status: 400 });
    } catch (err) {
        console.error('Errore PATCH /api/admin/students:', err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno del server' }, { status: 500 });
    }
}

// ============================================================
// DELETE /api/admin/students — Hard Delete GDPR
// ============================================================
export async function DELETE(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;
    try {
        const body = await request.json();
        const { id } = body;

        if (!id) {
            return NextResponse.json({ error: 'Campo id obbligatorio' }, { status: 400 });
        }

        const supabase = await createAdminClient();

        // Stato prima della cancellazione (audit).
        const { data: alunno } = await supabase
            .from('alunni')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (!alunno) {
            return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 });
        }

        // Registro modifiche (audit trail GDPR storico).
        await supabase.from('registro_modifiche').insert({
            azione: 'hard_delete_gdpr',
            tabella_interessata: 'alunni',
            record_id: id,
            vecchio_valore: alunno,
            nuovo_valore: null,
        });

        // Cancellazione a cascata.
        const { error } = await supabase
            .from('alunni')
            .delete()
            .eq('id', id);

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: id,
            azione: 'delete',
            scuolaId: (alunno.scuola_id as string) ?? null,
            sectionId: (alunno.section_id as string) ?? null,
            valorePrima: alunno,
        });

        return NextResponse.json({ success: true, message: 'Alunno eliminato definitivamente (GDPR)' });
    } catch (err) {
        console.error('Errore DELETE /api/admin/students:', err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}
