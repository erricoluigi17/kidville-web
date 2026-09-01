import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireUser } from '@/lib/auth/require-staff';
import { assertClasseNomeInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default';

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
/**
 * Sezioni dell'utente che portano un dato NOME di classe. È il ponte fra il nome
 * (che il client manda, e che fra sedi NON è univoco) e la sezione vera, che ha
 * la sua `scuola_id`. Vuoto ⇒ nessuna sezione: si nega, non si allarga.
 */
async function sezioniConNome(
    admin: Awaited<ReturnType<typeof createAdminClient>>,
    user: Parameters<typeof assertClasseNomeInScope>[1],
    nome: string,
): Promise<string[]> {
    const plessi = await scuoleDiUtente(admin, user);
    if (plessi.length === 0) return [];
    const { data } = await admin.from('sections').select('id').eq('name', nome).in('scuola_id', plessi);
    return (data ?? []).map((s) => s.id as string);
}

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

        // Isolamento per sede. `locker_config` era l'unica tabella in cui la sede
        // non era deducibile: la classe era un NOME libero, quindi «2 ANNI» era
        // una configurazione SOLA condivisa fra Aversa e Cesa. Dalla migrazione
        // `locker_config_per_sezione` la riga punta alla sezione vera: si filtra
        // su quella, risolta dentro i propri plessi.
        if (classeSezione) {
            const sezioni = await sezioniConNome(admin, auth.user, classeSezione);
            if (sezioni.length === 0) return NextResponse.json([]);
            q = q.in('section_id', sezioni);
        }

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
    } catch (err) {
        // Ripiego di ULTIMA istanza, e fino al 2026-09-01 era MUTO. Qui non arriva
        // l'errore di PostgREST — quello lo intercetta il ramo `if (error)` qui sopra,
        // perché PostgREST non lancia: ritorna `{ error }`. Qui arriva un'ECCEZIONE
        // vera: il client admin che non si costruisce, la risoluzione delle sezioni
        // che esplode. Cose che non capitano «a volte»: capitano a OGNI richiesta.
        //
        // Ed è esattamente ciò che stava succedendo dentro la suite senza che nessuno
        // potesse accorgersene: `__tests__/api/locker-materials-auth.test.ts` credeva
        // di leggere la riga configurata e riceveva i quattro default, perché ogni
        // chiamata passava di qui. Il test era VERDE — asseriva `length > 0`, e i
        // default sono quattro — e questa riga non esisteva. Con «nessun log» non si
        // distingue «tutto ok» da «va in eccezione ogni volta» (AGENTS.md regole 5 e 6).
        //
        // `warn` e non `error`, per la stessa ragione del catch qui sopra: il ripiego è
        // previsto e il chiamante riceve comunque dei materiali validi. Ma `esito`
        // dev'essere DIVERSO da quello del ramo PostgREST: sono due guasti con due
        // correzioni diverse, e chi legge il log deve poterli separare.
        logEvento('db', 'warn', {
            operazione: 'locker/materials:GET',
            esito: 'locker-materials-eccezione-uso-default',
        }, err);
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
            // Anche qui la sezione vera, non solo il nome: la riga deve sapere a
            // quale plesso appartiene.
            const rows = await Promise.all(uniche.map(async (classe) => {
                const sez = await sezioniConNome(admin, auth.user, classe);
                return { ...base, classe_sezione: classe, section_id: sez[0] ?? null };
            }));
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

        // Si valorizza ANCHE `section_id`: `classe_sezione` resta per
        // compatibilità col DB E2E non migrato, ma la chiave vera è la sezione.
        const sezioniPost = body.classe_sezione
            ? await sezioniConNome(admin, auth.user, body.classe_sezione)
            : [];
        const payload = {
            ...base,
            classe_sezione: body.classe_sezione ?? null,
            section_id: sezioniPost[0] ?? null,
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
