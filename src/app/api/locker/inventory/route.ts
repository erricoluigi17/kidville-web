import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';

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
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const alunnoId      = searchParams.get('alunno_id');
        const classeSezione = searchParams.get('classe_sezione');
        const month         = searchParams.get('month');
        const matFilter     = searchParams.get('material_filter');
        const mode          = searchParams.get('mode'); // 'stock' | 'carico' | null

        const supabase = await createAdminClient();

        // Ramo docente/staff (per classe): gate ruolo + isolamento per plesso.
        // Il ramo genitore (?alunno_id) resta aperto.
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
    } catch (err: any) {
        console.error('GET /api/locker/inventory:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * POST /api/locker/inventory  → CARICO (genitore porta materiale)
 * Body: { alunno_id, materiale, quantita, date? }
 * Strategia: cerca record per (alunno_id, materiale, date); se esiste aggiorna, altrimenti inserisce.
 * Nessun onConflict → non dipende da UNIQUE constraint.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const supabase = await createAdminClient();
        const { alunno_id, materiale, quantita, date } = body;

        if (!alunno_id || !materiale || !quantita) {
            return NextResponse.json({ error: 'Dati mancanti' }, { status: 400 });
        }
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

        return NextResponse.json({ success: true, data: result });
    } catch (err: any) {
        console.error('POST /api/locker/inventory:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * PATCH /api/locker/inventory → CONSUMO (insegnante usa materiale)
 * Body: { alunno_id, materiale, quantita_usata }
 * Inserisce un record portato=false che riduce lo stock.
 */
export async function PATCH(request: NextRequest) {
    try {
        // CONSUMO = azione docente/staff: gate ruolo + scope + audit.
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const body = await request.json();
        const supabase = await createAdminClient();
        const admin = await createAdminClient();
        const { alunno_id, materiale, quantita_usata } = body;

        if (!alunno_id || !materiale || !quantita_usata) {
            return NextResponse.json({ error: 'Dati mancanti' }, { status: 400 });
        }
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
    } catch (err: any) {
        console.error('PATCH /api/locker/inventory:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
