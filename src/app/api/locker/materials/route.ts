import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertClasseNomeInScope } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';

/**
 * GET /api/locker/materials?classe_sezione=Girasoli
 * Ritorna i materiali configurati per la classe.
 * Se la tabella non esiste ancora, ritorna i materiali di default.
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const classeSezione = searchParams.get('classe_sezione') ?? null;

    try {
        const admin = await createAdminClient();
        let q = admin
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
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const body = await request.json();
        const admin = await createAdminClient();

        // Scope per plesso (classe risolta per nome dentro i propri plessi).
        if (body.classe_sezione) {
            const scopeErr = await assertClasseNomeInScope(admin, auth.user, body.classe_sezione);
            if (scopeErr) return scopeErr;
        }

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
            const { data, error } = await admin
                .from('locker_config').update(payload).eq('id', body.id).select().single();
            if (error) throw error;
            result = data;
        } else {
            const { data, error } = await admin
                .from('locker_config').insert(payload).select().single();
            if (error) throw error;
            result = data;
        }

        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'armadietto_config', entitaId: result?.id ?? null,
            azione: body.id ? 'update' : 'insert', valoreDopo: result,
        });

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
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const body = await request.json();
        const admin = await createAdminClient();
        const { id, ...updates } = body;

        // Scope: risolve la classe del record (per nome) entro i propri plessi.
        const { data: row } = await admin.from('locker_config').select('classe_sezione').eq('id', id).maybeSingle();
        if (row?.classe_sezione) {
            const scopeErr = await assertClasseNomeInScope(admin, auth.user, row.classe_sezione);
            if (scopeErr) return scopeErr;
        }

        const { data, error } = await admin
            .from('locker_config').update(updates).eq('id', id).select().single();
        if (error) throw error;
        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'armadietto_config', entitaId: id, azione: 'update', valoreDopo: data,
        });
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
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        if (!id) return NextResponse.json({ error: 'id mancante' }, { status: 400 });

        const admin = await createAdminClient();

        const { data: row } = await admin.from('locker_config').select('classe_sezione').eq('id', id).maybeSingle();
        if (row?.classe_sezione) {
            const scopeErr = await assertClasseNomeInScope(admin, auth.user, row.classe_sezione);
            if (scopeErr) return scopeErr;
        }

        const { error } = await admin.from('locker_config').delete().eq('id', id);
        if (error) throw error;
        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'armadietto_config', entitaId: id, azione: 'delete',
        });
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
