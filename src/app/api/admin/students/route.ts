import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';

// ============================================================
// Anagrafica alunni — gated Segreteria+Direzione (DL-036) + audit
// immutabile su ogni mutazione (DL-037, `logScrittura`/`audit_scritture_docente`).
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id restano stringhe libere (niente zUuid): oggi il codice non impone
// alcun formato e nei test/dati seed circolano id non-UUID.

const postBodySchema = z.object({
    nome: z.string().min(1),
    cognome: z.string().min(1),
    data_nascita: z.string().min(1),
    scuola_id: z.string().nullable().optional(),
    sesso: z.string().nullable().optional(),
    codice_fiscale: z.string().nullable().optional(),
    comune_nascita: z.string().nullable().optional(),
    provincia_nascita: z.string().nullable().optional(),
    indirizzo_residenza: z.string().nullable().optional(),
    comune_residenza: z.string().nullable().optional(),
    cap: z.string().nullable().optional(),
    allergies: z.string().nullable().optional(),
    // non-array tollerato e normalizzato a [] nell'handler, come oggi
    allergeni: z.unknown().optional(),
    is_bes_dsa: z.boolean().nullable().optional(),
    note_bes: z.string().nullable().optional(),
    usa_pannolino: z.boolean().nullable().optional(),
    invoice_holder_type: z.string().nullable().optional(),
    invoice_holder_details: z.unknown().optional(), // jsonb libero
    classe_sezione: z.string().nullable().optional(),
});

const getQuerySchema = z.object({
    scuola_id: z.string().optional(),
    classe_sezione: z.string().optional(),
    stato: z.string().optional(),
    // Clamp identico al comportamento precedente: default 200 (limit) / 0 (offset),
    // range 1..1000; input non numerico → default, mai 400.
    limit: z.preprocess((v) => Math.min(Math.max(Number(v ?? 200) || 200, 1), 1000), z.number()),
    offset: z.preprocess((v) => Math.max(Number(v ?? 0) || 0, 0), z.number()),
});

// PATCH: tre forme (bulk classe_sezione, bulk gruppo mensa, update singolo).
// I valori dei campi aggiornabili restano senza vincoli (z.unknown) come oggi.
// NB zod v4: z.unknown() nudo rende la chiave obbligatoria → sempre .optional().
const patchBodySchema = z.object({
    // bulk: la guardia Array.isArray resta nell'handler (come oggi)
    ids: z.unknown().optional(),
    gruppo_mensa_id: z.unknown().optional(),
    // update singolo
    id: z.string().optional(),
    // allowlist campi aggiornabili (stessa lista di `allowedFields` nell'handler)
    classe_sezione: z.unknown().optional(),
    stato: z.unknown().optional(),
    note_mediche: z.unknown().optional(),
    bes: z.unknown().optional(),
    note_bes: z.unknown().optional(),
    nome: z.unknown().optional(),
    cognome: z.unknown().optional(),
    data_nascita: z.unknown().optional(),
    codice_fiscale: z.unknown().optional(),
    gender: z.unknown().optional(),
    citizenship: z.unknown().optional(),
    birth_nation: z.unknown().optional(),
    birth_province: z.unknown().optional(),
    birth_city: z.unknown().optional(),
    residence_address: z.unknown().optional(),
    residence_city: z.unknown().optional(),
    zip_code: z.unknown().optional(),
    allergies: z.unknown().optional(),
    allergeni: z.unknown().optional(),
    invoice_holder_type: z.unknown().optional(),
    invoice_holder_details: z.unknown().optional(),
    is_bes_dsa: z.unknown().optional(),
    usa_pannolino: z.unknown().optional(),
    section_id: z.unknown().optional(),
    importo_retta_mensile: z.unknown().optional(),
    genitori_separati: z.unknown().optional(),
    retta_split_config: z.unknown().optional(),
    intestatario_fatture: z.unknown().optional(),
});

const deleteBodySchema = z.object({
    id: z.string({ error: 'Campo id obbligatorio' }).min(1, 'Campo id obbligatorio'),
});

// ============================================================
// POST /api/admin/students — Creazione nuovo alunno
// ============================================================
export async function POST(request: NextRequest) {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const body = b.data;

    try {
        const supabase = await createAdminClient();

        const { nome, cognome, data_nascita } = body;

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

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    // Paginazione: limit clampato 1..1000 (default 200) + offset; shape array nudo invariata.
    const { scuola_id: scuolaId, classe_sezione: classeSezione, stato, limit, offset } = q.data;

    try {
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

    const b = await parseBody(request, patchBodySchema);
    if ('response' in b) return b.response;
    const body: Record<string, unknown> = b.data;
    const { ids, id, gruppo_mensa_id: gruppoMensaId } = b.data;

    try {
        const supabase = await createAdminClient();

        // Bulk assign
        if (ids && Array.isArray(ids) && body.classe_sezione) {
            const { data, error } = await supabase
                .from('alunni')
                .update({ classe_sezione: body.classe_sezione })
                .in('id', ids)
                .select();

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            // Audit: una riga per alunno riassegnato (DL-037).
            for (const alunnoId of ids as string[]) {
                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: alunnoId,
                    azione: 'update',
                    valoreDopo: { classe_sezione: body.classe_sezione },
                });
            }
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Bulk assign gruppo mensa (P5.4, DL-050). `gruppo_mensa_id` può essere
        // null per rimuovere gli alunni dal gruppo.
        if (ids && Array.isArray(ids) && gruppoMensaId !== undefined) {
            const { data, error } = await supabase
                .from('alunni')
                .update({ gruppo_mensa_id: gruppoMensaId })
                .in('id', ids)
                .select();
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            for (const alunnoId of ids as string[]) {
                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: alunnoId,
                    azione: 'update',
                    valoreDopo: { gruppo_mensa_id: gruppoMensaId },
                });
            }
            return NextResponse.json({ success: true, updated: data?.length ?? 0, data });
        }

        // Aggiornamento singolo
        if (id) {
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
                const { data: prima } = await supabase.from('alunni').select('*').eq('id', id).maybeSingle();
                if (!prima) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 });

                let { data, error } = await supabase
                    .from('alunni')
                    .update(updates)
                    .eq('id', id)
                    .select()
                    .single();

                if (error && (error as { code?: string }).code === '42703' && /usa_pannolino/.test(error.message)) {
                    delete updates.usa_pannolino;
                    ({ data, error } = await supabase.from('alunni').update(updates).eq('id', id).select().single());
                }

                if (error) throw new Error(error.message);

                await logScrittura(supabase, {
                    attore: auth.user,
                    entitaTipo: 'alunni',
                    entitaId: id,
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

    const b = await parseBody(request, deleteBodySchema);
    if ('response' in b) return b.response;
    const { id } = b.data;

    try {
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
