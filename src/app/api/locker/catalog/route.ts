import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente, requireUser } from '@/lib/auth/require-staff';
import { scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
    scuola_id: zUuid, // obbligatorio (sostituisce il 400 manuale pre-esistente)
});

const postBodySchema = z.object({
    scuola_id: zUuid,
    nome: z.string().min(1),
    icona: z.string().nullish(),         // default '📦' applicato nel codice (?? copre anche null)
    unita: z.string().nullish(),         // default 'pz'
    soglia_gialla: z.number().nullish(), // default 5
    soglia_rossa: z.number().nullish(),  // default 2
});

// ============================================================
// GET /api/locker/catalog — Lista catalogo materiali per sede
// Query: ?scuola_id=<id>
// ============================================================
export const GET = withRoute('locker/catalog:GET', async (request: NextRequest) => {
    try {
        const auth = await requireUser(request);
        if (auth.response) return auth.response;

        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const scuolaId = q.data.scuola_id;

        const supabase = await createClient();

        // Isolamento per tenant: filtra sui plessi accessibili all'utente;
        // usa lo scuola_id del client SOLO per restringere dentro quell'insieme.
        const plessi = await scuoleDiUtente(supabase, auth.user);
        const target = scuolaId && plessi.includes(scuolaId) ? [scuolaId] : plessi;

        const { data, error } = await supabase
            .from('locker_catalog')
            .select('*')
            .in('scuola_id', target)
            .eq('attivo', true)
            .order('ordinamento', { ascending: true });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'locker/catalog:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// POST /api/locker/catalog — Aggiunge materiale al catalogo
// Body: { scuola_id, nome, icona?, unita?, soglia_gialla?, soglia_rossa? }
// ============================================================
export const POST = withRoute('locker/catalog:POST', async (request: NextRequest) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { scuola_id, nome, icona, unita, soglia_gialla, soglia_rossa } = b.data;

        const admin = await createAdminClient();
        // Isolamento per tenant: la scuola_id del catalogo deve essere tra i plessi dell'attore.
        const plessi = await scuoleDiUtente(admin, auth.user);
        if (!plessi.includes(scuola_id)) {
            return NextResponse.json({ error: 'Accesso negato: plesso non consentito' }, { status: 403 });
        }

        const supabase = await createClient();

        const { data, error } = await supabase
            .from('locker_catalog')
            .insert({
                scuola_id,
                nome,
                icona: icona ?? '📦',
                unita: unita ?? 'pz',
                soglia_gialla: soglia_gialla ?? 5,
                soglia_rossa: soglia_rossa ?? 2,
            })
            .select()
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'armadietto_catalogo', entitaId: data?.id ?? null,
            azione: 'insert', scuolaId: scuola_id, valoreDopo: data,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (err) {
        logErrore({ operazione: 'locker/catalog:POST', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
