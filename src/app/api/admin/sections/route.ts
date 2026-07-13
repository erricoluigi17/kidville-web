import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ============================================================
// Anagrafica sezioni/classi — gated Segreteria+Direzione (DL-036) + audit (DL-037).
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    // Filtro eq su sections.scuola_id: uuid se presente ('' = nessun filtro, come prima).
    scuola_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
});

const postBodySchema = z.object({
    name: z.string().min(1, 'Il nome della sezione è obbligatorio'),
    // Grado scuola validato (niente valori spazzatura); se assente → 'infanzia' nel codice.
    school_type: z.preprocess(vuotoComeAssente, z.enum(['nido', 'infanzia', 'primaria']).nullish()),
    scuola_id: z.preprocess(vuotoComeAssente, zUuid.nullish()), // default sede principale nel codice
});

// Il body (meno id) viene spalmato in update(updates): .loose() preserva le chiavi extra.
// id stringa libera e NON zUuid (nei test circolano id non-uuid): un id sconosciuto
// continua a fallire a DB, come prima.
const patchBodySchema = z.object({
    id: z.string().min(1, 'id è obbligatorio'), // sostituisce il 400 manuale
}).loose();

// ============================================================
// GET /api/admin/sections — Lista sezioni
// ============================================================
export const GET = withRoute('admin/sections:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const scuolaId = q.data.scuola_id;
    try {
        const supabase = await createAdminClient();

        let query = supabase
            .from('sections')
            .select('*')
            .order('name', { ascending: true })
            .in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user));

        if (scuolaId) query = query.eq('scuola_id', scuolaId);

        const { data, error } = await query;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        return NextResponse.json(data || []);
    } catch (err) {
        logErrore({ operazione: 'admin/sections:GET', stato: 500 }, err);
        return NextResponse.json(
            { error: (err instanceof Error && err.message) || 'Errore interno' },
            { status: 500 }
        );
    }
});

// ============================================================
// POST /api/admin/sections — Crea nuova sezione
// ============================================================
export const POST = withRoute('admin/sections:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    try {
        const supabase = await createAdminClient();

        const { name, school_type, scuola_id } = b.data;

        const sw = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id ?? undefined);
        if (sw.response) return sw.response;

        const record = {
            name,
            school_type: school_type || 'infanzia',
            scuola_id: sw.scuolaId,
        };

        const { data, error } = await supabase
            .from('sections')
            .insert(record)
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'sezioni',
            entitaId: data?.id ?? null,
            azione: 'insert',
            scuolaId: record.scuola_id,
            valoreDopo: data,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (err) {
        logErrore({ operazione: 'admin/sections:POST', stato: 500 }, err);
        return NextResponse.json(
            { error: (err instanceof Error && err.message) || 'Errore interno' },
            { status: 500 }
        );
    }
});

// ============================================================
// PATCH /api/admin/sections — Aggiorna sezione
// ============================================================
export const PATCH = withRoute('admin/sections:PATCH', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, patchBodySchema);
    if ('response' in b) return b.response;
    const { id, ...updates } = b.data;
    try {
        const supabase = await createAdminClient();

        // Stato precedente per l'audit.
        const { data: prima } = await supabase.from('sections').select('*').eq('id', id).maybeSingle();

        const { data, error } = await supabase
            .from('sections')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'sezioni',
            entitaId: id,
            azione: 'update',
            scuolaId: (data?.scuola_id as string) ?? null,
            valorePrima: prima ?? null,
            valoreDopo: updates,
        });

        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'admin/sections:PATCH', stato: 500 }, err);
        return NextResponse.json(
            { error: (err instanceof Error && err.message) || 'Errore interno' },
            { status: 500 }
        );
    }
});
