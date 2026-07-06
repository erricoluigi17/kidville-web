import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { linkOrCreateParent } from '@/lib/anagrafiche/parents';

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
    nazione_nascita: z.string().nullable().optional(),
    cittadinanza: z.string().nullable().optional(),
    indirizzo_residenza: z.string().nullable().optional(),
    civico: z.string().nullable().optional(),
    comune_residenza: z.string().nullable().optional(),
    provincia_residenza: z.string().nullable().optional(),
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
    // Salvataggio atomico alunno+genitori: array opzionale di payload adulto
    // (stesso shape del form ScrollableAdultForm). Ogni voce viene creata e
    // collegata a questo alunno lato server (niente più genitori "persi").
    parents: z.array(z.unknown()).optional(),
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
    residence_street_number: z.unknown().optional(),
    residence_city: z.unknown().optional(),
    residence_province: z.unknown().optional(),
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

        // scuola_id: risolto dallo scope dell'admin (una sola sede per la scrittura).
        const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id);
        if (sw.response) return sw.response;

        const record: Record<string, unknown> = {
            scuola_id: sw.scuolaId,
            nome,
            cognome,
            data_nascita,
            gender: body.sesso || null,
            citizenship: body.cittadinanza || null,
            birth_nation: body.nazione_nascita || null,
            codice_fiscale: body.codice_fiscale || null,
            birth_city: body.comune_nascita || null,
            birth_province: body.provincia_nascita || null,
            residence_address: body.indirizzo_residenza || null,
            residence_street_number: body.civico || null,
            residence_city: body.comune_residenza || null,
            residence_province: (body.provincia_residenza || '').toUpperCase() || null,
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

        // Resilienza pre-migration: se una colonna non esiste ancora (es. usa_pannolino,
        // residence_province/residence_street_number prima della migrazione 20260767),
        // rimuovila dal record e riprova (Postgres segnala una colonna alla volta).
        let attempts = 0;
        while (error && (error as { code?: string }).code === '42703' && attempts < 5) {
            const col = /column "?([a-z_]+)"? of relation/i.exec(error.message)?.[1];
            if (!col || !(col in record)) break;
            delete record[col];
            ({ data, error } = await supabase.from('alunni').insert(record).select().single());
            attempts++;
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

        // Salvataggio atomico dei genitori collegati (opzionale): ogni voce viene
        // creata e collegata; gli errori per-genitore sono riportati senza
        // compromettere l'alunno già creato.
        const parentsResults: { label: string; ok: boolean; error?: string }[] = [];
        if (Array.isArray(body.parents) && data?.id) {
            for (let i = 0; i < body.parents.length; i++) {
                const p = (body.parents[i] ?? {}) as Record<string, unknown>;
                const label = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || `Genitore ${i + 1}`;
                try {
                    await linkOrCreateParent(supabase, auth.user, { studentId: data.id as string, payload: p });
                    parentsResults.push({ label, ok: true });
                } catch (e) {
                    parentsResults.push({ label, ok: false, error: (e as Error).message });
                }
            }
        }

        return NextResponse.json({ ...data, parents: parentsResults }, { status: 201 });
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
    const { classe_sezione: classeSezione, stato, limit, offset } = q.data;

    try {
        const supabase = await createAdminClient();

        const embedTail = 'student_parents ( relation_type, is_primary, parents (*) ), delegates (*)';
        // Colonne "flat" della lista anagrafica. residence_province/residence_street_number
        // dipendono dalla migrazione 20260767: se il DB non le ha ancora (es. progetto E2E CI,
        // o finestra pre-migrate in un deploy) PostgREST risponde 42703 → le rimuoviamo e
        // riproviamo, esattamente come già fanno POST/PATCH qui sotto.
        let cols = [
            'id', 'scuola_id', 'nome', 'cognome', 'data_nascita', 'codice_fiscale', 'classe_sezione', 'stato',
            'note_mediche', 'consenso_privacy', 'creato_il', 'gender', 'citizenship', 'birth_nation',
            'birth_province', 'birth_city', 'residence_address', 'residence_street_number', 'residence_city',
            'residence_province', 'zip_code', 'allergies',
            'invoice_holder_type', 'invoice_holder_details', 'is_bes_dsa', 'fiscal_code', 'section_id',
            'documento_path', 'importo_retta_mensile', 'genitori_separati', 'retta_split_config',
            'intestatario_fatture', 'allergeni', 'usa_pannolino', 'sospeso', 'sospeso_motivo', 'sospeso_il',
            'sospeso_da', 'anonimizzato_il', 'gruppo_mensa_id', 'numero_domanda_sidi',
        ];
        // Scope multi-sede: solo i plessi attivi (selezione SedeSelector ∩ accessibili).
        const scuole = await resolveScuoleAttive(request, supabase, auth.user);
        const runQuery = () => {
            let query = supabase
                .from('alunni')
                .select(`${cols.join(', ')}, ${embedTail}`)
                .order('cognome', { ascending: true })
                .range(offset, offset + limit - 1)
                .in('scuola_id', scuole);
            if (classeSezione) query = query.eq('classe_sezione', classeSezione);
            if (stato) query = query.eq('stato', stato);
            return query;
        };

        let { data, error } = await runQuery();
        let attempts = 0;
        while (error && (error as { code?: string }).code === '42703' && attempts < 5) {
            const col = /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist/i.exec(error.message)?.[1];
            if (!col || !cols.includes(col)) break;
            cols = cols.filter((c) => c !== col);
            ({ data, error } = await runQuery());
            attempts++;
        }
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
                const allowedFields = ['classe_sezione', 'stato', 'note_mediche', 'bes', 'note_bes', 'nome', 'cognome', 'data_nascita', 'codice_fiscale', 'gender', 'citizenship', 'birth_nation', 'birth_province', 'birth_city', 'residence_address', 'residence_street_number', 'residence_city', 'residence_province', 'zip_code', 'allergies', 'allergeni', 'invoice_holder_type', 'invoice_holder_details', 'is_bes_dsa', 'usa_pannolino', 'section_id',
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

                // Resilienza pre-migration: rimuove le colonne non ancora esistenti e riprova.
                let patchAttempts = 0;
                while (error && (error as { code?: string }).code === '42703' && patchAttempts < 5) {
                    const col = /column "?([a-z_]+)"? of relation/i.exec(error.message)?.[1];
                    if (!col || !(col in updates)) break;
                    delete updates[col];
                    ({ data, error } = await supabase.from('alunni').update(updates).eq('id', id).select().single());
                    patchAttempts++;
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
