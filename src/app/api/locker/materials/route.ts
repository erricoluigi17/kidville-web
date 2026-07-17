import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireUser } from '@/lib/auth/require-staff';
import { assertClasseNomeInScope } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    classe_sezione: z.string().optional(),
});

const postBodySchema = z.object({
    id: z.preprocess(vuotoComeAssente, zUuid.nullish()), // presente ⇒ update, assente ⇒ insert
    classe_sezione: z.string().nullish(),
    // Creazione dello stesso materiale su più sezioni in un colpo (multi-select).
    classi_sezioni: z.array(z.string().min(1)).max(100).optional(),
    nome: z.string().nullish(), // il codice attuale non ne impone la presenza (l'assenza fallisce a DB, come prima)
    icona: z.string().nullish(),
    unita: z.string().nullish(),
    livello_allerta: z.number().nullish(),
    livello_emergenza: z.number().nullish(),
    ordine: z.number().nullish(),
    attivo: z.boolean().nullish(),
});

// Il body (meno id) viene spalmato in update(updates): .loose() preserva le chiavi extra.
const patchBodySchema = z.object({
    id: zUuid,
}).loose();

const deleteQuerySchema = z.object({
    id: zUuid, // obbligatorio (sostituisce il 400 manuale 'id mancante')
});

/**
 * GET /api/locker/materials?classe_sezione=Girasoli
 * Ritorna i materiali configurati per la classe.
 * Se la tabella non esiste ancora, ritorna i materiali di default.
 */
export const GET = withRoute('locker/materials:GET', async (request: NextRequest) => {
    // m1 — ferma l'enumerazione anonima della configurazione materiali. Qualsiasi
    // utente autenticato (genitore incluso) continua a leggere.
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const classeSezione = q.data.classe_sezione ?? null;

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
            // Tabella non ancora creata → ritorna i default.
            // `warn` e non `error`: il fallback è PREVISTO (l'ambiente senza `locker_config` è
            // uno stato legittimo) e il risultato è salvo — il chiamante riceve i materiali di
            // default, che è ciò che deve ricevere. Resta un warn, però, e non un info: se la
            // tabella c'è ed è la QUERY a fallire, questa riga è l'unico indizio che l'armadietto
            // sta mostrando i default al posto della configurazione reale della classe.
            logEvento('db', 'warn', {
                operazione: 'locker/materials:GET',
                esito: 'locker-config-non-letta-uso-default',
            }, error);
            return NextResponse.json(MATERIALI_DEFAULT);
        }

        return NextResponse.json(data && data.length > 0 ? data : MATERIALI_DEFAULT);
    } catch {
        return NextResponse.json(MATERIALI_DEFAULT);
    }
});

/**
 * POST /api/locker/materials
 * Crea o aggiorna un materiale nella configurazione.
 * Body: { classe_sezione, nome, icona?, unita?, livello_allerta?, livello_emergenza?, ordine? }
 */
export const POST = withRoute('locker/materials:POST', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const body = b.data;
        const admin = await createAdminClient();

        const base = {
            nome:              body.nome,
            icona:             body.icona ?? '📦',
            unita:             body.unita ?? 'pz',
            livello_allerta:   body.livello_allerta ?? 5,
            livello_emergenza: body.livello_emergenza ?? 2,
            ordine:            body.ordine ?? 99,
            attivo:            body.attivo ?? true,
        };

        // Ramo multi-sezione: crea lo stesso materiale su ogni sezione scelta.
        if (!body.id && body.classi_sezioni && body.classi_sezioni.length > 0) {
            const uniche = [...new Set(body.classi_sezioni)];
            for (const classe of uniche) {
                const scopeErr = await assertClasseNomeInScope(admin, auth.user, classe);
                if (scopeErr) return scopeErr;
            }
            const rows = uniche.map((classe) => ({ ...base, classe_sezione: classe }));
            const { data, error } = await admin.from('locker_config').insert(rows).select();
            if (error) throw error;
            await logScrittura(admin, {
                attore: auth.user, entitaTipo: 'armadietto_config', azione: 'insert',
                valoreDopo: { nome: base.nome, sezioni: uniche },
            });
            return NextResponse.json({ success: true, data, created: data?.length ?? 0 });
        }

        // Scope per plesso (classe risolta per nome dentro i propri plessi).
        if (body.classe_sezione) {
            const scopeErr = await assertClasseNomeInScope(admin, auth.user, body.classe_sezione);
            if (scopeErr) return scopeErr;
        }

        const payload = { ...base, classe_sezione: body.classe_sezione ?? null };

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
    } catch (err) {
        logErrore({ operazione: 'locker/materials:POST', stato: 500 }, err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 });
    }
});

/**
 * PATCH /api/locker/materials — toggle attivo o aggiorna ordine
 * Body: { id, attivo? | ordine? }
 */
export const PATCH = withRoute('locker/materials:PATCH', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const admin = await createAdminClient();
        const { id, ...updates } = b.data;

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
    } catch (err) {
        logErrore({ operazione: 'locker/materials:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 });
    }
});

/**
 * DELETE /api/locker/materials?id=xxx
 */
export const DELETE = withRoute('locker/materials:DELETE', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;
        const q = parseQuery(request, deleteQuerySchema);
        if ('response' in q) return q.response;
        const id = q.data.id;

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
    } catch (err) {
        logErrore({ operazione: 'locker/materials:DELETE', stato: 500 }, err);
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 });
    }
});

// ── Default fallback ──────────────────────────────────────────────────────────
export const MATERIALI_DEFAULT = [
    { id: 'default-1', nome: 'Pannolini', icona: '🧷', unita: 'pz', livello_allerta: 5, livello_emergenza: 2, ordine: 1, attivo: true },
    { id: 'default-2', nome: 'Salviette', icona: '🧻', unita: 'pz', livello_allerta: 4, livello_emergenza: 2, ordine: 2, attivo: true },
    { id: 'default-3', nome: 'Crema',     icona: '🧴', unita: 'pz', livello_allerta: 3, livello_emergenza: 1, ordine: 3, attivo: true },
    { id: 'default-4', nome: 'Cambio',    icona: '👕', unita: 'pz', livello_allerta: 2, livello_emergenza: 1, ordine: 4, attivo: true },
];
