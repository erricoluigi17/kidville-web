import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' nei query param equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    alunno_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
    classe_sezione: z.string().optional(),
    stato: z.string().optional(), // filtro libero, come prima (nessun enum imposto sul GET)
});

// Stessi valori ammessi del check manuale pre-esistente.
const patchBodySchema = z.object({
    id: zUuid,
    stato: z.enum(['acknowledged', 'fulfilled']),
});

// La tabella `locker_requests` può non esistere in alcuni ambienti (modulo non
// migrato su prod, dove esistono solo `armadietto`/`locker_config`): in quel caso
// si degrada a vuoto invece di rispondere 500.
function tabellaMancante(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    return error.code === '42P01' || /does not exist|schema cache|could not find/i.test(error.message ?? '');
}

// ============================================================
// GET /api/locker/requests
// Query:
//   ?alunno_id=<id>     → richieste per un alunno (genitore)
//   ?classe_sezione=<s> → richieste per tutta la sezione (insegnante)
//   ?stato=pending      → filtra per stato (opzionale)
// ============================================================
export const GET = withRoute('locker/requests:GET', async (request: NextRequest) => {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const { alunno_id: alunnoId, classe_sezione: classeSezione, stato } = q.data;

        const supabase = await createAdminClient();

        if (alunnoId) {
            // Ramo genitore: gate identità (sessione) + legame genitore↔alunno.
            const auth = await requireParentOfStudent(request, alunnoId);
            if (auth.response) return auth.response;

            let query = supabase
                .from('locker_requests')
                .select(`
                    *,
                    locker_catalog (id, nome, icona, unita),
                    alunni (id, nome, cognome)
                `)
                .eq('alunno_id', alunnoId)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) {
                if (tabellaMancante(error)) return NextResponse.json([]);
                return NextResponse.json({ error: error.message }, { status: 500 });
            }
            return NextResponse.json(data);

        } else if (classeSezione) {
            // Ramo docente/staff: gate ruolo + isolamento per plesso.
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            const admin = await createAdminClient();
            const plessi = await scuoleDiUtente(admin, auth.user);
            if (plessi.length === 0) return NextResponse.json([]);

            // Ottieni gli alunni della sezione (solo dei propri plessi)
            const { data: alunni } = await supabase
                .from('alunni')
                .select('id')
                .eq('classe_sezione', classeSezione)
                .eq('stato', 'iscritto')
                .in('scuola_id', plessi);

            if (!alunni || alunni.length === 0) return NextResponse.json([]);
            const ids = alunni.map(a => a.id);

            let query = supabase
                .from('locker_requests')
                .select(`
                    *,
                    locker_catalog (id, nome, icona, unita),
                    alunni (id, nome, cognome)
                `)
                .in('alunno_id', ids)
                .order('creato_il', { ascending: false });

            if (stato) query = query.eq('stato', stato);

            const { data, error } = await query;
            if (error) {
                if (tabellaMancante(error)) return NextResponse.json([]);
                return NextResponse.json({ error: error.message }, { status: 500 });
            }
            return NextResponse.json(data);
        }

        return NextResponse.json(
            { error: 'Parametro alunno_id o classe_sezione richiesto' },
            { status: 400 }
        );
    } catch (err) {
        logErrore({ operazione: 'locker/requests:GET', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});

// ============================================================
// PATCH /api/locker/requests — Genitore "Preso in carico"
// Body: { id, stato: 'acknowledged' | 'fulfilled' }
// ============================================================
export const PATCH = withRoute('locker/requests:PATCH', async (request: NextRequest) => {
    try {
        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, stato } = b.data;

        // M9 — CAMBIO STATO = azione della scuola (presa in carico/evasione): gate
        // ruolo docente/staff. Gating prima del caricamento della riga per non
        // esporre nemmeno l'esistenza dell'id a un anonimo.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const supabase = await createAdminClient();

        // Carica la riga per ricavarne il contesto (alunno → sezione/plesso) e
        // applicare lo scope: un docente non tocca richieste fuori dalla sua sezione.
        const { data: riga, error: rigaErr } = await supabase
            .from('locker_requests')
            .select('id, alunno_id')
            .eq('id', id)
            .maybeSingle();
        if (rigaErr) {
            if (tabellaMancante(rigaErr)) return NextResponse.json({ ok: true, degraded: true });
            return NextResponse.json({ error: rigaErr.message }, { status: 500 });
        }
        if (!riga) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 });

        const scopeErr = await assertAlunnoInScope(supabase, auth.user, riga.alunno_id);
        if (scopeErr) return scopeErr;

        const updates: Record<string, unknown> = { stato };
        if (stato === 'acknowledged') {
            updates.preso_in_carico_il = new Date().toISOString();
        }

        const { data, error } = await supabase
            .from('locker_requests')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            if (tabellaMancante(error)) return NextResponse.json({ ok: true, degraded: true });
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'locker/requests:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
