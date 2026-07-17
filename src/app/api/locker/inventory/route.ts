import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zAnnoMese, zDataYMD, zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' nei query param equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v);

const getQuerySchema = z.object({
    alunno_id: z.preprocess(vuotoComeAssente, zUuid.optional()),
    classe_sezione: z.string().optional(),
    month: z.preprocess(vuotoComeAssente, zAnnoMese.optional()),
    material_filter: z.string().optional(),
    mode: z.string().optional(), // 'stock' | 'carico' | altro (altri valori = nessun effetto, come prima)
});

const postBodySchema = z.object({
    alunno_id: zUuid,
    materiale: z.string().min(1),
    // Il check pre-esistente (!quantita) rifiutava anche 0; i negativi restano ammessi.
    quantita: z.number().refine((v) => v !== 0, { message: 'quantita deve essere diversa da zero' }),
    date: zDataYMD.nullish(), // default dinamico (oggi) calcolato nel codice
});

const patchBodySchema = z.object({
    alunno_id: zUuid,
    materiale: z.string().min(1),
    quantita_usata: z.number().refine((v) => v !== 0, { message: 'quantita_usata deve essere diversa da zero' }),
});

function getMonthRange(ym: string) {
    const [y, m] = ym.split('-').map(Number);
    return {
        startOfMonth: new Date(y, m - 1, 1).toISOString().slice(0, 10),
        endOfMonth:   new Date(y, m, 0).toISOString().slice(0, 10),
    };
}

/**
 * GET /api/locker/inventory
 * Params:
 *   alunno_id        → record di un alunno
 *   classe_sezione   → tutti gli alunni della sezione
 *   month            → YYYY-MM, filtra per mese
 *   material_filter  → filtra per materiale
 *   mode=stock       → ritorna stock aggregato (somma carichi - consumi)
 *   mode=carico      → solo record portato=true (consegne genitore)
 */
export const GET = withRoute('locker/inventory:GET', async (request: NextRequest) => {
    try {
        const q = parseQuery(request, getQuerySchema);
        if ('response' in q) return q.response;
        const {
            alunno_id: alunnoId,
            classe_sezione: classeSezione,
            month,
            material_filter: matFilter,
            mode,
        } = q.data;

        const supabase = await createAdminClient();

        // Ramo genitore (?alunno_id): gate identità (sessione) + legame genitore↔alunno.
        // Chiude l'IDOR anonimo segnalato dal test 360°. Staff/educator passano.
        if (alunnoId) {
            const auth = await requireParentOfStudent(request, alunnoId);
            if (auth.response) return auth.response;
        }

        // Ramo docente/staff (per classe): gate ruolo + isolamento per plesso.
        let plessiScope: string[] = [];
        if (classeSezione && !alunnoId) {
            const auth = await requireDocente(request);
            if (auth.response) return auth.response;
            const admin = await createAdminClient();
            plessiScope = await scuoleDiUtente(admin, auth.user);
            if (plessiScope.length === 0) return NextResponse.json([]);
        }

        // ── Stock aggregato per singolo alunno ───────────────────────────────
        if (alunnoId && mode === 'stock') {
            const { data, error } = await supabase
                .from('armadietto')
                .select('materiale, quantita, portato')
                .eq('alunno_id', alunnoId);
            if (error) throw error;
            const stockMap: Record<string, number> = {};
            for (const r of data ?? []) {
                stockMap[r.materiale] = (stockMap[r.materiale] ?? 0)
                    + (r.portato ? r.quantita : -r.quantita);
            }
            return NextResponse.json(
                Object.entries(stockMap).map(([materiale, stock]) => ({
                    materiale,
                    stock: Math.max(0, stock),
                }))
            );
        }

        // ── Stock aggregato per intera sezione ───────────────────────────────
        if (classeSezione && mode === 'stock') {
            const { data: alunni, error: errA } = await supabase
                .from('alunni').select('id, nome, cognome')
                .eq('classe_sezione', classeSezione).eq('stato', 'iscritto').in('scuola_id', plessiScope);
            if (errA) throw errA;
            const ids = (alunni ?? []).map(a => a.id);
            const { data: inv, error: errI } = await supabase
                .from('armadietto').select('alunno_id, materiale, quantita, portato')
                .in('alunno_id', ids);
            if (errI) throw errI;
            return NextResponse.json((alunni ?? []).map(a => {
                const rows = (inv ?? []).filter(r => r.alunno_id === a.id);
                const stockMap: Record<string, number> = {};
                for (const r of rows) {
                    stockMap[r.materiale] = (stockMap[r.materiale] ?? 0)
                        + (r.portato ? r.quantita : -r.quantita);
                }
                return {
                    ...a,
                    stocks: Object.entries(stockMap).map(([materiale, stock]) => ({
                        materiale, stock: Math.max(0, stock),
                    })),
                };
            }));
        }

        // ── Vista alunno singolo (mensile o lista consegne) ──────────────────
        if (alunnoId) {
            let q = supabase.from('armadietto').select('*').eq('alunno_id', alunnoId);
            if (mode === 'carico') q = q.eq('portato', true);
            if (month) {
                const { startOfMonth, endOfMonth } = getMonthRange(month);
                q = q.gte('date', startOfMonth).lte('date', endOfMonth);
            }
            if (matFilter) q = q.eq('materiale', matFilter);
            q = q.order('date', { ascending: true });
            const { data, error } = await q;
            if (error) throw error;
            return NextResponse.json(data);
        }

        // ── Vista classe (mensile o lista consegne) ──────────────────────────
        if (classeSezione) {
            const { data: alunni, error: errA } = await supabase
                .from('alunni').select('id, nome, cognome')
                .eq('classe_sezione', classeSezione).eq('stato', 'iscritto').in('scuola_id', plessiScope);
            if (errA) throw errA;
            const ids = (alunni ?? []).map(a => a.id);
            let q = supabase.from('armadietto').select('*').in('alunno_id', ids);
            if (mode === 'carico') q = q.eq('portato', true);
            if (month) {
                const { startOfMonth, endOfMonth } = getMonthRange(month);
                q = q.gte('date', startOfMonth).lte('date', endOfMonth);
            }
            if (matFilter) q = q.eq('materiale', matFilter);
            q = q.order('date', { ascending: true });
            const { data: inv, error: errI } = await q;
            if (errI) throw errI;
            return NextResponse.json((alunni ?? []).map(a => ({
                ...a,
                inventario: (inv ?? []).filter(i => i.alunno_id === a.id),
            })));
        }

        return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Errore interno';
        logErrore({ operazione: 'locker/inventory:GET', stato: 500 }, err);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
});

/**
 * POST /api/locker/inventory  → CARICO (genitore porta materiale)
 * Body: { alunno_id, materiale, quantita, date? }
 * Strategia: cerca record per (alunno_id, materiale, date); se esiste aggiorna, altrimenti inserisce.
 * Nessun onConflict → non dipende da UNIQUE constraint.
 */
export const POST = withRoute('locker/inventory:POST', async (request: NextRequest) => {
    try {
        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const { alunno_id, materiale, quantita, date } = b.data;

        // M9 — CARICO = azione del genitore sul PROPRIO figlio: gate identità
        // (sessione) + legame genitore↔alunno. Staff/educator passano. Chiude
        // l'accettazione anonima di scritture su qualsiasi alunno_id.
        const auth = await requireParentOfStudent(request, alunno_id);
        if (auth.response) return auth.response;

        const supabase = await createAdminClient();

        const targetDate = date ?? new Date().toISOString().slice(0, 10);

        // Cerca record esistente per (alunno, materiale, data, portato=true)
        const { data: existing } = await supabase
            .from('armadietto')
            .select('nome_oggetto, quantita')
            .eq('alunno_id', alunno_id)
            .eq('materiale', materiale)
            .eq('date', targetDate)
            .eq('portato', true)
            .maybeSingle();

        let result;
        if (existing) {
            // Aggiorna quantità esistente (somma)
            const { data, error } = await supabase
                .from('armadietto')
                .update({ quantita: existing.quantita + quantita })
                .eq('alunno_id', alunno_id).eq('materiale', materiale)
                .eq('date', targetDate).eq('portato', true)
                .select().single();
            if (error) throw error;
            result = data;
        } else {
            // Inserisce nuovo record carico
            const { data, error } = await supabase
                .from('armadietto')
                .insert({
                    alunno_id,
                    nome_oggetto:     materiale,
                    materiale,
                    quantita,
                    quantita_residua: quantita,
                    date:             targetDate,
                    portato:          true,
                    livello_allerta:  5,
                    livello_emergenza: 2,
                })
                .select().single();
            if (error) throw error;
            result = data;
        }

        // Audit della scrittura (come la PATCH/CONSUMO accanto): attore, plesso,
        // sezione, valore dopo. Best-effort (logScrittura non lancia mai).
        const { data: al } = await supabase
            .from('alunni').select('section_id, scuola_id').eq('id', alunno_id).maybeSingle();
        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'armadietto', entitaId: result?.id ?? null,
            azione: existing ? 'update' : 'insert',
            scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null, valoreDopo: result,
        });

        return NextResponse.json({ success: true, data: result });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Errore interno';
        logErrore({ operazione: 'locker/inventory:POST', stato: 500 }, err);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
});

/**
 * PATCH /api/locker/inventory → CONSUMO (insegnante usa materiale)
 * Body: { alunno_id, materiale, quantita_usata }
 * Inserisce un record portato=false che riduce lo stock.
 */
export const PATCH = withRoute('locker/inventory:PATCH', async (request: NextRequest) => {
    try {
        // CONSUMO = azione docente/staff: gate ruolo + scope + audit.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const supabase = await createAdminClient();
        const admin = await createAdminClient();
        const { alunno_id, materiale, quantita_usata } = b.data;

        const scopeErr = await assertAlunnoInScope(admin, auth.user, alunno_id);
        if (scopeErr) return scopeErr;
        const today = new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase
            .from('armadietto')
            .insert({
                alunno_id,
                nome_oggetto:     materiale,
                materiale,
                quantita:         quantita_usata,
                quantita_residua: 0,
                date:             today,
                portato:          false, // consumo = portato=false
                livello_allerta:  5,
                livello_emergenza: 2,
            })
            .select().single();

        if (error) throw error;

        const { data: al } = await admin.from('alunni').select('section_id, scuola_id').eq('id', alunno_id).maybeSingle();
        await logScrittura(admin, {
            attore: auth.user, entitaTipo: 'armadietto', entitaId: data.id, azione: 'insert',
            scuolaId: al?.scuola_id ?? null, sectionId: al?.section_id ?? null, valoreDopo: data,
        });

        return NextResponse.json({ success: true, data });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Errore interno';
        logErrore({ operazione: 'locker/inventory:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
});
